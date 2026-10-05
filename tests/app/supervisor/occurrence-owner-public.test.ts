import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, resolveRuntimePaths, type RuntimePaths } from '../../../packages/config/src/index.js';
import {
  acquireDaemonLease,
  readDaemonLease,
  type SupervisorLeaseRecord,
} from '../../../packages/app/src/supervisor/index.js';
import type {
  OccurrenceExecutionOwner,
  OccurrenceTaskBinding,
} from '../../../packages/contracts/src/index.js';

const configModule = new URL('../../../packages/config/src/index.js', import.meta.url).href;
const supervisorModule = new URL('../../../packages/app/src/supervisor/index.js', import.meta.url).href;

interface Fixture {
  readonly root: string;
  readonly paths: RuntimePaths;
  cleanup(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-occurrence-owner-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  return {
    root,
    paths,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    },
  };
}

function occurrenceBinding(overrides: Partial<OccurrenceTaskBinding> = {}): OccurrenceTaskBinding {
  const subscriptionId = 'subscription-owner-test';
  const scheduleRevision = 1;
  const occurrenceOrdinal = 1;
  return {
    occurrenceId: `${subscriptionId}::${scheduleRevision}::${occurrenceOrdinal}`,
    subscriptionId,
    scheduleRevision,
    occurrenceOrdinal,
    taskId: { scope: 'task', value: 'task-owner-test' },
    operationId: { scope: 'operation', value: 'operation-owner-test' },
    executionEpoch: 1,
    inputArtifactDigest: 'sha256:owner-test',
    ...overrides,
  };
}

function ownerFromRecord(record: SupervisorLeaseRecord): OccurrenceExecutionOwner {
  return {
    daemonLeaseId: record.leaseId,
    daemonGeneration: record.generation,
    processStartToken: record.processStartToken,
  };
}

function childPathsScript(paths: RuntimePaths): string {
  return `
    import { resolveRuntimePaths } from ${JSON.stringify(configModule)};
    const paths = await resolveRuntimePaths({
      controlRoot: ${JSON.stringify(paths.controlRoot)},
      workspace: ${JSON.stringify(paths.workspaceCwd)},
    });
  `;
}

async function runChild(script: string): Promise<{ readonly pid: number | undefined; readonly code: number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk); });
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { pid: child.pid, ...result, stdout, stderr };
}

function startChild(script: string): { readonly child: ReturnType<typeof spawn>; readonly line: Promise<string> } {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk); });
  const line = new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (chunk: unknown) => {
      stdout += String(chunk);
      const newline = stdout.indexOf('\n');
      if (newline >= 0) resolve(stdout.slice(0, newline));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`child exited before ready: ${code}; stderr=${stderr}`)));
  });
  return { child, line };
}

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForExit(child).catch(() => undefined);
}

test('genuine acquired lease authorizes an occurrence mutation visible on disk', async () => {
  const fx = await fixture();
  const lease = await acquireDaemonLease(fx.paths, { ownerId: 'occurrence-owner-test' });
  const binding = occurrenceBinding();
  const outputPath = join(fx.root, 'authorized-owner.json');
  try {
    const result = await lease.withCurrentDaemonOwner(binding, async (authenticatedCaller, isCommittedReplacement) => {
      assert.deepEqual(authenticatedCaller, ownerFromRecord(lease.record));
      assert.equal(await isCommittedReplacement(authenticatedCaller), false);
      await writeFile(outputPath, JSON.stringify(authenticatedCaller) + '\n', 'utf8');
      return 'authorized';
    });

    assert.equal(result, 'authorized');
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), ownerFromRecord(lease.record));
  } finally {
    await lease.release().catch(() => undefined);
    await fx.cleanup();
  }
});

test('another OS process cannot turn copied readable fields or caller-defined assertActive into authority', async () => {
  const fx = await fixture();
  const lease = await acquireDaemonLease(fx.paths, { ownerId: 'occurrence-owner-A' });
  const markerPath = join(fx.root, 'durable-marker.txt');
  await writeFile(markerPath, 'unchanged\n', 'utf8');
  try {
    const script = `
      ${childPathsScript(fx.paths)}
      import { acquireDaemonLease, readDaemonLease } from ${JSON.stringify(supervisorModule)};
      const copied = await readDaemonLease(paths);
      let assertActiveCalls = 0;
      const fake = {
        record: copied,
        async assertActive() {
          assertActiveCalls += 1;
        },
        async withCurrentDaemonOwner(_binding, operation) {
          await this.assertActive();
          return operation({
            daemonLeaseId: copied.leaseId,
            daemonGeneration: copied.generation,
            processStartToken: copied.processStartToken,
          }, async () => false);
        },
      };
      const fakeAuthorized = await fake.withCurrentDaemonOwner({}, async () => 'fake-authorized');
      let rejection = null;
      try {
        const acquired = await acquireDaemonLease(paths);
        await acquired.release();
      } catch (error) {
        rejection = error?.code ?? error?.message;
      }
      console.log(JSON.stringify({
        rejection,
        assertActiveCalls,
        fakeAuthorized,
        hasCopiedFields: copied !== undefined,
      }));
    `;
    const result = await runChild(script);
    console.log(JSON.stringify({ event: 'copied-fields-child', pid: result.pid, root: fx.root }));
    assert.equal(result.code, 0, result.stderr);
    const observed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(observed.rejection, 'daemon-lease-owned');
    assert.equal(observed.assertActiveCalls, 1);
    assert.equal(observed.fakeAuthorized, 'fake-authorized');
    assert.equal(observed.hasCopiedFields, true);
    assert.equal(await readFile(markerPath, 'utf8'), 'unchanged\n');
  } finally {
    await lease.release().catch(() => undefined);
    await fx.cleanup();
  }
});

test('real child crash and supported takeover produce committed replacement while preserving A', async () => {
  const fx = await fixture();
  const childScript = `
    ${childPathsScript(fx.paths)}
    import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
    const lease = await acquireDaemonLease(paths, { ownerId: 'occurrence-owner-A' });
    console.log(JSON.stringify({
      pid: process.pid,
      owner: {
        daemonLeaseId: lease.record.leaseId,
        daemonGeneration: lease.record.generation,
        processStartToken: lease.record.processStartToken,
      },
    }));
  `;
  const child = await runChild(childScript);
  console.log(JSON.stringify({ event: 'crashed-child', pid: child.pid, root: fx.root }));
  assert.equal(child.code, 0, child.stderr);
  const ownerA = (JSON.parse(child.stdout.trim()) as { readonly owner: OccurrenceExecutionOwner }).owner;
  const binding = occurrenceBinding();
  const outputPath = join(fx.root, 'replacement-owner.json');
  const replacement = await acquireDaemonLease(fx.paths, {
    ownerId: 'occurrence-owner-B',
    takeover: { reason: 'child process exited without releasing the occurrence owner lease' },
  });
  try {
    assert.equal(replacement.record.generation, ownerA.daemonGeneration + 1);
    assert.equal(replacement.record.takeover?.previousLeaseId, ownerA.daemonLeaseId);
    const observed = await replacement.withCurrentDaemonOwner(binding, async (authenticatedCaller, isCommittedReplacement) => {
      assert.deepEqual(authenticatedCaller, ownerFromRecord(replacement.record));
      assert.equal(await isCommittedReplacement(ownerA), true);
      const receipt = {
        ownerA,
        authenticatedCaller,
        previousLeaseId: replacement.record.takeover?.previousLeaseId,
      };
      await writeFile(outputPath, JSON.stringify(receipt) + '\n', 'utf8');
      return receipt;
    });

    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), observed);
    assert.deepEqual(observed.ownerA, ownerA);
    assert.equal(observed.previousLeaseId, ownerA.daemonLeaseId);
  } finally {
    await replacement.release().catch(() => undefined);
    await fx.cleanup();
  }
});

test('live stale A after supported replacement cannot mutate even after copying B fields', async () => {
  const fx = await fixture();
  const binding = occurrenceBinding();
  const attemptPath = join(fx.root, 'attempt-stale-a');
  const resultPath = join(fx.root, 'stale-a-result.json');
  const outputPath = join(fx.root, 'stale-a-output.json');
  const childScript = `
    ${childPathsScript(fx.paths)}
    import { existsSync } from 'node:fs';
    import { readFile, writeFile } from 'node:fs/promises';
    import { acquireDaemonLease, readDaemonLease } from ${JSON.stringify(supervisorModule)};
    const lease = await acquireDaemonLease(paths, { ownerId: 'occurrence-owner-A' });
    console.log(JSON.stringify({
      pid: process.pid,
      owner: {
        daemonLeaseId: lease.record.leaseId,
        daemonGeneration: lease.record.generation,
        processStartToken: lease.record.processStartToken,
      },
    }));
    while (!existsSync(${JSON.stringify(attemptPath)})) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const current = await readDaemonLease(paths);
    Object.assign(lease.record, {
      leaseId: current.leaseId,
      generation: current.generation,
      processStartToken: current.processStartToken,
    });
    let code = null;
    try {
      await lease.withCurrentDaemonOwner(${JSON.stringify(binding)}, async () => {
        await writeFile(${JSON.stringify(outputPath)}, 'unauthorized\\n', 'utf8');
      });
    } catch (error) {
      code = error?.code ?? error?.message;
    }
    await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({
      code,
      copiedRecordLeaseId: lease.record.leaseId,
      copiedLeaseId: current.leaseId,
    }) + '\\n', 'utf8');
  `;
  const child = startChild(childScript);
  let replacement: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
  try {
    const line = JSON.parse(await child.line) as { readonly pid: number; readonly owner: OccurrenceExecutionOwner };
    console.log(JSON.stringify({ event: 'stale-a-child', pid: child.child.pid, root: fx.root }));
    assert.ok(line.pid > 0);
    replacement = await acquireDaemonLease(fx.paths, {
      ownerId: 'occurrence-owner-B',
      takeover: {
        reason: 'supported takeover while stale A is still alive',
        allowed: () => true,
      },
    });
    await writeFile(attemptPath, 'attempt\n', 'utf8');
    await waitForExit(child.child);
    const observed = JSON.parse(await readFile(resultPath, 'utf8')) as Record<string, unknown>;
    assert.equal(observed.code, 'daemon-lease-stale');
    assert.equal(observed.copiedRecordLeaseId, replacement.record.leaseId);
    assert.equal(observed.copiedLeaseId, replacement.record.leaseId);
    assert.equal(existsSync(outputPath), false);
  } finally {
    await stopChild(child.child);
    await replacement?.release().catch(() => undefined);
    await fx.cleanup();
  }
});

test('delayed async callback holds the guard until settlement and blocks process takeover', async () => {
  const fx = await fixture();
  const lease = await acquireDaemonLease(fx.paths, { ownerId: 'occurrence-owner-A' });
  const binding = occurrenceBinding();
  const enteredPath = join(fx.root, 'callback-entered');
  const releasePath = join(fx.root, 'callback-release');
  const outputPath = join(fx.root, 'callback-output');
  try {
    const mutation = lease.withCurrentDaemonOwner(binding, async () => {
      await writeFile(enteredPath, 'entered\n', 'utf8');
      while (!existsSync(releasePath)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await writeFile(outputPath, 'settled\n', 'utf8');
      return 'settled';
    });
    await waitForFile(enteredPath);

    const takeoverScript = `
      ${childPathsScript(fx.paths)}
      import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
      let code = null;
      try {
        const replacement = await acquireDaemonLease(paths, {
          takeover: { reason: 'interleave with delayed callback', allowed: () => true },
        });
        await replacement.release();
      } catch (error) {
        code = error?.code ?? error?.message;
      }
      console.log(JSON.stringify({ code }));
    `;
    const takeover = await runChild(takeoverScript);
    console.log(JSON.stringify({ event: 'takeover-attempt-child', pid: takeover.pid, root: fx.root }));
    assert.equal(takeover.code, 0, takeover.stderr);
    assert.equal((JSON.parse(takeover.stdout.trim()) as { readonly code: string }).code, 'daemon-lease-transition-in-progress');
    assert.equal(existsSync(outputPath), false);

    await writeFile(releasePath, 'release\n', 'utf8');
    assert.equal(await mutation, 'settled');
    assert.equal(await readFile(outputPath, 'utf8'), 'settled\n');
    await lease.release();

    const next = await acquireDaemonLease(fx.paths, { ownerId: 'occurrence-owner-after-settlement' });
    await next.release();
  } finally {
    await lease.release().catch(() => undefined);
    await fx.cleanup();
  }
});

test('invalid binding, callback failure, and disposed handle fail explicitly and release guard', async () => {
  const fx = await fixture();
  const lease = await acquireDaemonLease(fx.paths, { ownerId: 'occurrence-owner-test' });
  const binding = occurrenceBinding();
  const markerPath = join(fx.root, 'guard-reacquired.txt');
  try {
    let invalidCallbackRan = false;
    await assert.rejects(
      () => lease.withCurrentDaemonOwner(
        { ...binding, occurrenceId: 'not-the-binding-identity' },
        async () => {
          invalidCallbackRan = true;
          await writeFile(markerPath, 'invalid\n', 'utf8');
        },
      ),
      (error: any) => {
        assert.equal(error.code, 'daemon-lease-owner-binding-invalid');
        assert.ok(error.cause);
        return true;
      },
    );
    assert.equal(invalidCallbackRan, false);
    assert.equal(existsSync(markerPath), false);

    const originalError = new Error('original callback failure');
    await assert.rejects(
      () => lease.withCurrentDaemonOwner(binding, async () => {
        throw originalError;
      }),
      (error: any) => error === originalError,
    );

    const recovered = await lease.withCurrentDaemonOwner(binding, async () => {
      await writeFile(markerPath, 'recovered\n', 'utf8');
      return 'recovered';
    });
    assert.equal(recovered, 'recovered');
    assert.equal(await readFile(markerPath, 'utf8'), 'recovered\n');

    await lease.release();
    let disposedCallbackRan = false;
    await assert.rejects(
      () => lease.withCurrentDaemonOwner(binding, async () => {
        disposedCallbackRan = true;
        await writeFile(markerPath, 'disposed\n', 'utf8');
      }),
      (error: any) => {
        assert.equal(error.code, 'daemon-lease-disposed');
        return true;
      },
    );
    assert.equal(disposedCallbackRan, false);
    assert.equal(await readFile(markerPath, 'utf8'), 'recovered\n');
  } finally {
    await lease.release().catch(() => undefined);
    await fx.cleanup();
  }
});
