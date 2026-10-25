import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, resolveRuntimePaths, type RuntimePaths } from '../../../packages/config/src/index.js';
import { SessionStore } from '../../../packages/app/src/session-store.js';
import { AppLifecycleError } from '../../../packages/app/src/errors.js';
import {
  acquireDaemonLease,
  assertDaemonLeaseIdentity,
  daemonLeasePath,
  isDaemonLeaseHandoffCommitted,
  readDaemonLease,
  recordDaemonRestartFailure,
  recordDaemonRestartTransition,
  runSupervisorStartup,
  runSupervisorServeStartup,
  startDaemonCodeHandoff,
} from '../../../packages/app/src/supervisor/index.js';
import { AccessControlService } from '../../../packages/app/src/ui-runtime/access-control.js';

async function fixture(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-supervisor-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await AccessControlService.open({ credentialPath: paths.webAccessCredentialPath, create: true });
  return paths;
}

function serveStartup(paths: RuntimePaths) {
  return {
    launcherPath: '/fixture/candidate/bin/humanagent.mjs',
    cwd: paths.workspaceCwd,
    args: ['--control-root', paths.controlRoot, '--workspace', paths.workspaceCwd, '--provider', 'fake', '--port', '0'],
    source: {
      entryPath: '/fixture/candidate/runtime/app/src/cli.js',
      packageVersion: '0.1.31',
    },
  };
}

test('daemon lease is unique and generation advances after release', async () => {
  const paths = await fixture();
  const lease = await acquireDaemonLease(paths);
  assert.equal(lease.record.generation, 1);
  assert.equal(lease.record.ownerId, 'supervisor');

  await assert.rejects(() => acquireDaemonLease(paths), (error: any) => {
    assert.equal(error.code, 'daemon-lease-owned');
    assert.equal(error.ownerId, 'supervisor');
    assert.equal(typeof error.nextAction, 'string');
    return true;
  });

  await lease.release();
  const second = await acquireDaemonLease(paths, { ownerId: 'host-test' });
  assert.equal(second.record.generation, 2);
  assert.equal(second.record.ownerId, 'host-test');
  await second.release();
});

// Failure basis: an old pending turn can still reference its cleanly disposed
// owner after arbitrarily many daemon generations. A fixed 64-record window or
// an acquire path that drops disposedAt locks that scope again. Cost: local
// lease writes only, no Provider or spawned processes.
test('daemon lease preserves referenced clean disposal beyond 64 generations', async () => {
  const paths = await fixture();
  let lease = await acquireDaemonLease(paths);
  const first = lease.record;
  try {
    for (let n = 0; n < 66; n += 1) {
      await lease.release();
      lease = await acquireDaemonLease(paths);
    }
    const record = await readDaemonLease(paths);
    const proof = record?.terminations?.find((entry) => entry.previousLeaseId === first.leaseId
      && entry.previousGeneration === first.generation);
    assert.equal(proof?.termination, 'graceful');
    assert.equal(record?.terminations?.length, 66);
  } finally {
    await lease.release();
    await rm(dirname(paths.controlRoot), { recursive: true });
  }
});

// Failure basis: installed leases predate terminations, so upgrade must carry
// the already-issued takeover unchanged. This small persisted fixture catches
// loss on both stop-configured and ordinary acquisition without a real daemon.
test('daemon lease carries legacy takeover proof through each disposed acquisition path', async () => {
  for (const stop of [false, true]) {
    const paths = await fixture();
    let lease = await acquireDaemonLease(paths);
    try {
      const closed = await lease.release();
      const legacy = { previousLeaseId: 'legacy-terminated-owner', previousGeneration: 1,
        termination: 'already-dead' as const, reason: 'verified legacy takeover',
        detectedAt: '2026-10-24T00:00:00.000Z' };
      await writeFile(daemonLeasePath(paths), JSON.stringify({ ...closed, generation: 2, takeover: legacy }));
      lease = await acquireDaemonLease(paths, stop ? { takeover: { reason: 'upgrade', stop: {} } } : {});
      const proofs = (await readDaemonLease(paths))?.terminations;
      assert.deepEqual(proofs?.find((entry) => entry.previousLeaseId === legacy.previousLeaseId), legacy);
      assert.equal(proofs?.find((entry) => entry.previousLeaseId === closed.leaseId)?.termination, 'graceful');
    } finally {
      await lease.release();
      await rm(dirname(paths.controlRoot), { recursive: true });
    }
  }
});

test('daemon lease identity requires a live process before an HTTP identity check', async () => {
  const paths = await fixture();
  const lease = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve' });
  const record = await readDaemonLease(paths);
  if (!record) throw new Error('expected a daemon lease record');
  await assert.rejects(
    () => assertDaemonLeaseIdentity(paths, { ...record, pid: 999999999 }),
    (error: any) => {
      assert.equal(error.code, 'daemon-takeover.identity-mismatch');
      assert.match(error.message, /no longer running/);
      return true;
    },
  );
  await lease.release();
});

test('code handoff preserves the first replacement spawn failure', async () => {
  const paths = await fixture();
  const startup = {
    launcherPath: '/definitely/missing/humanagent.mjs',
    cwd: '/definitely/missing/workspace',
    args: ['--workspace', paths.workspaceCwd, '--control-root', paths.controlRoot, '--provider', 'fake', '--port', '0'],
    source: {
      entryPath: '/definitely/missing/cli.js',
      packageVersion: '0.1.29',
    },
  };
  const lease = await acquireDaemonLease(paths, {
    ownerId: 'humanagent.app.serve',
    startup,
  });
  const handoff = startDaemonCodeHandoff(paths, {
    expected: lease.record,
    startup,
    timeoutMs: 1_000,
  });
  await assert.rejects(() => handoff.completion, (error: any) => {
    assert.equal(error.code, 'daemon-restart.spawn-failed');
    return true;
  });
  const persisted = await readDaemonLease(paths);
  assert.equal(persisted?.restart?.failure?.errorCode, 'daemon-restart.spawn-failed');
  await lease.release();
});

interface FakeServeLauncher {
  readonly launcherPath: string;
  readonly pidFile: string;
  readonly startedFile: string;
  readonly gateFile: string;
}

/**
 * A replacement serve stand-in. It records the new lease in two steps the real
 * serve path also uses: commit the replacement generation first, publish
 * readiness later. The test releases the gate, so readiness timing is a test
 * decision instead of a machine-speed accident.
 */
async function writeFakeServeLauncher(root: string): Promise<FakeServeLauncher> {
  const launcherPath = join(root, 'fake-serve.mjs');
  const launcher: FakeServeLauncher = {
    launcherPath,
    pidFile: join(root, 'fake-serve.pid'),
    startedFile: join(root, 'fake-serve.started'),
    gateFile: join(root, 'fake-serve.gate'),
  };
  await writeFile(launcherPath, `
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const requestId = flag('--restart-request');
const leasePath = flag('--fixture-lease');
const mode = flag('--fixture-mode') ?? 'ready';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await writeFile(${JSON.stringify(launcher.pidFile)}, String(process.pid));
if (mode === 'exit') process.exit(0);

let current;
for (let attempt = 0; attempt < 4_000; attempt += 1) {
  try {
    current = JSON.parse(await readFile(leasePath, 'utf8'));
    if (current.restart?.requestId === requestId) break;
  } catch {}
  await sleep(5);
}
if (current?.restart?.requestId !== requestId) process.exit(2);
await writeFile(${JSON.stringify(launcher.startedFile)}, String(process.pid));
if (mode === 'never') {
  setInterval(() => {}, 1_000);
} else if (mode === 'commit') {
  const leaseId = randomUUID();
  const processStartToken = 'node:fake-' + randomUUID();
  const generation = current.generation + 1;
  const writeLease = async (record) => {
    const tempPath = leasePath + '.tmp-fake';
    await writeFile(tempPath, JSON.stringify(record) + '\\n', 'utf8');
    await rename(tempPath, leasePath);
  };
  const committed = { ...current, leaseId, generation, pid: process.pid, processStartToken };
  delete committed.readyAt;
  await writeLease(committed);
  setInterval(() => {}, 1_000);
} else {
  const leaseId = randomUUID();
  const processStartToken = 'node:fake-' + randomUUID();
  const generation = current.generation + 1;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/api/runtime/identity') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ leaseId, generation, pid: process.pid, processStartToken }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') process.exit(3);
  const writeLease = async (record) => {
    const tempPath = leasePath + '.tmp-fake';
    await writeFile(tempPath, JSON.stringify(record) + '\\n', 'utf8');
    await rename(tempPath, leasePath);
  };
  const committed = { ...current, leaseId, generation, pid: process.pid, processStartToken,
    controlEndpoint: { host: '127.0.0.1', port: address.port } };
  delete committed.readyAt;
  await writeLease(committed);
  for (;;) {
    try {
      await readFile(${JSON.stringify(launcher.gateFile)});
      break;
    } catch {}
    await sleep(5);
  }
  const latest = JSON.parse(await readFile(leasePath, 'utf8'));
  await writeLease({ ...latest, leaseId, generation, pid: process.pid, processStartToken,
    controlEndpoint: { host: '127.0.0.1', port: address.port },
    readyAt: new Date().toISOString(),
    restart: { ...latest.restart, completedAt: new Date().toISOString() } });
  setInterval(() => {}, 1_000);
}
`.trimStart(), 'utf8');
  return launcher;
}

function fakeServeStartup(
  paths: RuntimePaths,
  launcher: FakeServeLauncher,
  mode: 'ready' | 'exit' | 'never' | 'commit' = 'ready',
) {
  return {
    launcherPath: launcher.launcherPath,
    cwd: paths.workspaceCwd,
    args: [
      '--control-root', paths.controlRoot,
      '--workspace', paths.workspaceCwd,
      '--fixture-lease', daemonLeasePath(paths),
      '--fixture-mode', mode,
    ],
    source: {
      entryPath: launcher.launcherPath,
      packageVersion: '0.1.40',
    },
  };
}

async function waitForReplacementLease(paths: RuntimePaths, generation: number): Promise<void> {
  for (let attempt = 0; attempt < 4_000; attempt += 1) {
    const lease = await readDaemonLease(paths);
    if (lease !== undefined && lease.generation >= generation) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`replacement lease generation ${generation} was not published`);
}

async function stopFakeServe(launcher: FakeServeLauncher): Promise<void> {
  const pid = Number(await readFile(launcher.pidFile, 'utf8').catch(() => ''));
  if (!Number.isSafeInteger(pid) || pid < 1 || !processIsAliveForTest(pid)) return;
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (!processIsAliveForTest(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fake replacement ${pid} did not exit after SIGTERM`);
}

// Failure basis: production daemon restart 0.1.0041 (requestId
// b2d81e08-291c-4012-addc-660747abcfb1) needed about 65 s from replacement spawn
// to readiness, so the old 30 s bound declared a successful replacement failed
// and left `restart.failure` beside `restart.completedAt`. The caller clock is
// mocked, so this case needs no real minute-long wait.
test('code handoff keeps a replacement that becomes ready after the old 30s bound', async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const paths = await fixture();
  let launcher: FakeServeLauncher | undefined;
  try {
    launcher = await writeFakeServeLauncher(dirname(paths.controlRoot));
    const startup = fakeServeStartup(paths, launcher);
    const owner = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve', startup });
    const handoff = startDaemonCodeHandoff(paths, { expected: owner.record, startup });
    await waitForReplacementLease(paths, owner.record.generation + 1);
    const committed = await readDaemonLease(paths);
    assert.equal(committed?.restart?.requestId, handoff.receipt.requestId);
    assert.equal(committed?.restart?.completedAt, undefined, 'the replacement must still be starting here');

    offset = 65_000;
    await writeFile(launcher.gateFile, 'ready');
    const completion = await handoff.completion;

    assert.equal(completion.current.generation, owner.record.generation + 1);
    const persisted = await readDaemonLease(paths);
    assert.equal(typeof persisted?.restart?.completedAt, 'string');
    assert.equal(persisted?.restart?.failure, undefined, 'a slow success must not publish a failure');
  } finally {
    Date.now = realNow;
    if (launcher !== undefined) await stopFakeServe(launcher).catch(() => undefined);
    await rm(dirname(paths.controlRoot), { recursive: true, force: true });
  }
});

// Failure basis: raising the bound must not hide a replacement that commits the
// new lease and then never publishes readiness. Cost: one fake child that dies
// only on SIGTERM.
test('code handoff still fails explicitly when a committed replacement never becomes ready', async () => {
  const paths = await fixture();
  let launcher: FakeServeLauncher | undefined;
  try {
    launcher = await writeFakeServeLauncher(dirname(paths.controlRoot));
    const startup = fakeServeStartup(paths, launcher, 'commit');
    const owner = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve', startup });
    const handoff = startDaemonCodeHandoff(paths, {
      expected: owner.record,
      startup,
      timeoutMs: 400,
    });
    await assert.rejects(() => handoff.completion, (error: any) => {
      assert.equal(error.code, 'daemon-restart.ready-timeout');
      return true;
    });
    const persisted = await readDaemonLease(paths);
    assert.equal(persisted?.generation, owner.record.generation + 1);
    assert.equal(persisted?.restart?.failure?.errorCode, 'daemon-restart.ready-timeout');
    assert.equal(persisted?.restart?.completedAt, undefined, 'a failed handoff must not also complete');
  } finally {
    if (launcher !== undefined) await stopFakeServe(launcher).catch(() => undefined);
    await rm(dirname(paths.controlRoot), { recursive: true, force: true });
  }
});

// Failure basis: raising the bound must not hide a replacement that never
// publishes readiness. Cost: one fake child that only stays alive.
test('code handoff still fails explicitly when the replacement never publishes readiness', async () => {
  const paths = await fixture();
  let launcher: FakeServeLauncher | undefined;
  try {
    launcher = await writeFakeServeLauncher(dirname(paths.controlRoot));
    const startup = fakeServeStartup(paths, launcher, 'never');
    const owner = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve', startup });
    const handoff = startDaemonCodeHandoff(paths, {
      expected: owner.record,
      startup,
      timeoutMs: 400,
    });
    await assert.rejects(() => handoff.completion, (error: any) => {
      assert.equal(error.code, 'daemon-restart.ready-timeout');
      return true;
    });
    const persisted = await readDaemonLease(paths);
    assert.equal(persisted?.restart?.failure?.errorCode, 'daemon-restart.ready-timeout');
    assert.equal(persisted?.restart?.completedAt, undefined, 'a failed handoff must not also complete');
  } finally {
    if (launcher !== undefined) await stopFakeServe(launcher).catch(() => undefined);
    await rm(dirname(paths.controlRoot), { recursive: true, force: true });
  }
});

test('code handoff treats an early replacement exit as an explicit failure', async () => {
  const paths = await fixture();
  let launcher: FakeServeLauncher | undefined;
  try {
    launcher = await writeFakeServeLauncher(dirname(paths.controlRoot));
    const startup = fakeServeStartup(paths, launcher, 'exit');
    const owner = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve', startup });
    const handoff = startDaemonCodeHandoff(paths, {
      expected: owner.record,
      startup,
      timeoutMs: 2_000,
    });
    await assert.rejects(() => handoff.completion, (error: any) => {
      assert.equal(error.code, 'daemon-restart.child-exited');
      return true;
    });
    const persisted = await readDaemonLease(paths);
    assert.equal(persisted?.restart?.failure?.errorCode, 'daemon-restart.child-exited');
    assert.equal(persisted?.restart?.completedAt, undefined);
  } finally {
    if (launcher !== undefined) await stopFakeServe(launcher).catch(() => undefined);
    await rm(dirname(paths.controlRoot), { recursive: true, force: true });
  }
});

// Failure basis: a caller-side timeout may be recorded while the replacement is
// still starting. The replacement's later readiness is the real outcome, so the
// lease must carry completedAt without the stale failure beside it.
test('a ready replacement resolves a recorded timeout instead of coexisting with it', async () => {
  const paths = await fixture();
  const startup = serveStartup(paths);
  const owner = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve', startup });
  try {
    const transition = {
      requestId: 'restart-request-slow-success',
      requestedAt: new Date().toISOString(),
      previousLeaseId: owner.record.leaseId,
      previousGeneration: owner.record.generation,
      previousProcessStartToken: owner.record.processStartToken,
      targetEntryPath: startup.source.entryPath,
    };
    await recordDaemonRestartTransition(paths, {
      leaseId: owner.record.leaseId,
      generation: owner.record.generation,
      processStartToken: owner.record.processStartToken,
    }, transition);
    await recordDaemonRestartFailure(paths, transition.requestId, {
      errorCode: 'daemon-restart.ready-timeout',
      ownerId: 'humanagent.app.serve',
      nextAction: 'inspect the replacement serve startup output and the daemon lease before retrying',
      message: 'replacement serve did not become ready',
      occurredAt: new Date().toISOString(),
    });

    const ready = await owner.markReady();
    assert.equal(typeof ready.restart?.completedAt, 'string');
    assert.equal(ready.restart?.failure, undefined, 'readiness must replace the caller timeout');
    const persisted = await readDaemonLease(paths);
    assert.equal(typeof persisted?.restart?.completedAt, 'string');
    assert.equal(persisted?.restart?.failure, undefined);
  } finally {
    await owner.release();
  }
});

// Failure basis: a completed transition is final. A late caller-side timeout
// must not add a second, contradictory outcome to the same marker.
test('a completed restart transition refuses a later timeout failure', async () => {
  const paths = await fixture();
  const startup = serveStartup(paths);
  const owner = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve', startup });
  try {
    const transition = {
      requestId: 'restart-request-late-failure',
      requestedAt: new Date().toISOString(),
      previousLeaseId: owner.record.leaseId,
      previousGeneration: owner.record.generation,
      previousProcessStartToken: owner.record.processStartToken,
      targetEntryPath: startup.source.entryPath,
    };
    await recordDaemonRestartTransition(paths, {
      leaseId: owner.record.leaseId,
      generation: owner.record.generation,
      processStartToken: owner.record.processStartToken,
    }, transition);
    await owner.markReady();
    await recordDaemonRestartFailure(paths, transition.requestId, {
      errorCode: 'daemon-restart.ready-timeout',
      ownerId: 'humanagent.app.serve',
      nextAction: 'inspect the replacement serve startup output and the daemon lease before retrying',
      message: 'replacement serve did not become ready',
      occurredAt: new Date().toISOString(),
    });

    const persisted = await readDaemonLease(paths);
    assert.equal(typeof persisted?.restart?.completedAt, 'string');
    assert.equal(persisted?.restart?.failure, undefined, 'a completed transition is final');
  } finally {
    await owner.release();
  }
});

test('missing readiness is not availability and marked ready is still leased', async () => {
  const paths = await fixture();
  const beforeReady = await acquireDaemonLease(paths);
  await assert.rejects(() => acquireDaemonLease(paths), (error: any) => {
    assert.equal(error.code, 'daemon-lease-owned');
    return true;
  });
  await beforeReady.markReady();
  assert.ok(beforeReady.record.readyAt);
  await assert.rejects(() => acquireDaemonLease(paths), (error: any) => {
    assert.equal(error.code, 'daemon-lease-owned');
    return true;
  });
  await beforeReady.release();
});

test('crash takeover fences the old lease and permits a new generation', async () => {
  const paths = await fixture();
  const first = await acquireDaemonLease(paths);
  const firstLeaseId = first.record.leaseId;
  const raw = JSON.parse(await readFile(daemonLeasePath(paths), 'utf8')) as Record<string, unknown>;
  await writeFile(daemonLeasePath(paths), JSON.stringify({ ...raw, pid: 999999999 }) + '\n', 'utf8');

  const second = await acquireDaemonLease(paths, { takeover: { reason: 'crashed pid stopped responding' } });
  assert.equal(second.record.generation, 2);
  assert.equal(second.record.takeover?.previousGeneration, 1);
  assert.equal(second.record.takeover?.previousLeaseId, first.record.leaseId);

  await assert.rejects(() => first.refresh(), (error: any) => {
    assert.equal(error.code, 'daemon-lease-stale');
    return true;
  });
  assert.equal(first.record.leaseId, firstLeaseId);
  await assert.rejects(() => first.markReady(), (error: any) => {
    assert.equal(error.code, 'daemon-lease-stale');
    return true;
  });
  await assert.rejects(() => first.release(), (error: any) => {
    assert.equal(error.code, 'daemon-lease-stale');
    return true;
  });
  await second.release();
  await assert.rejects(() => second.refresh(), (error: any) => {
    assert.equal(error.code, 'daemon-lease-disposed');
    return true;
  });
});

test('stale acquire guard is replaced by an explicit crash takeover', async () => {
  const paths = await fixture();
  const guardPath = `${daemonLeasePath(paths)}.acquire`;
  await mkdir(join(paths.projectRoot, 'daemon'), { recursive: true });
  await mkdir(guardPath);
  await writeFile(join(guardPath, 'owner.json'), JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() }) + '\n', 'utf8');

  const lease = await acquireDaemonLease(paths, { takeover: { reason: 'crashed during lease transition' } });
  assert.equal(lease.record.generation, 1);
  await lease.release();
});

test('startup dispose releases staged resources in reverse order', async () => {
  const paths = await fixture();
  const events: string[] = [];
  const startup = await runSupervisorStartup(paths, [
    {
      name: 'plugin-a',
      ownerId: 'plugin-a',
      start: async () => { events.push('start:a'); },
      dispose: async () => { events.push('dispose:a'); },
    },
    {
      name: 'plugin-b',
      ownerId: 'plugin-b',
      start: async () => { events.push('start:b'); },
      dispose: async () => { events.push('dispose:b'); },
    },
  ]);

  assert.deepEqual(events, ['start:a', 'start:b']);
  assert.ok(startup.readyAt);
  const receipt = await startup.dispose();
  assert.deepEqual(receipt.disposedStages, ['plugin-b', 'plugin-a']);
  assert.ok(receipt.lease.disposedAt);
  assert.deepEqual(events, ['start:a', 'start:b', 'dispose:b', 'dispose:a']);

  const next = await acquireDaemonLease(paths);
  assert.equal(next.record.generation, 2);
  await next.release();
});

test('restart reuses the active owner lease and restarts stages without takeover', async () => {
  const paths = await fixture();
  const events: string[] = [];
  const startup = await runSupervisorStartup(paths, [
    {
      name: 'stage-a',
      ownerId: 'owner-a',
      start: async () => { events.push('start:a'); },
      dispose: async () => { events.push('dispose:a'); },
    },
    {
      name: 'stage-b',
      ownerId: 'owner-b',
      start: async () => { events.push('start:b'); },
      dispose: async () => { events.push('dispose:b'); },
    },
  ], { lease: { ownerId: 'humanagent.app.serve' } });
  const leaseId = startup.lease.record.leaseId;
  const generation = startup.lease.record.generation;

  await startup.lease.setControlEndpoint({ host: '127.0.0.1', port: 10086 });
  const restarted = await startup.restart();

  assert.equal(restarted.leaseId, leaseId);
  assert.equal(restarted.generation, generation);
  assert.deepEqual(events, [
    'start:a', 'start:b',
    'dispose:b', 'dispose:a',
    'start:a', 'start:b',
  ]);
  const lease = await readDaemonLease(paths);
  assert.equal(lease?.leaseId, leaseId);
  assert.equal(lease?.generation, generation);
  assert.deepEqual(lease?.controlEndpoint, { host: '127.0.0.1', port: 10086 });
  assert.equal(lease?.disposedAt, undefined);
  await startup.dispose();
});

test('restart transition crosses the disposed lease and completes only on the new ready owner', async () => {
  const paths = await fixture();
  const startup = {
    launcherPath: '/fixture/candidate/bin/humanagent.mjs',
    cwd: '/fixture/workspace',
    args: ['--provider', 'fake', '--port', '0'],
    source: {
      entryPath: '/fixture/candidate/runtime/app/src/cli.js',
      packageVersion: '0.1.31',
    },
  };
  const first = await acquireDaemonLease(paths, {
    ownerId: 'humanagent.app.serve',
    startup,
  });
  const transition = {
    requestId: 'restart-request-1',
    requestedAt: new Date().toISOString(),
    previousLeaseId: first.record.leaseId,
    previousGeneration: first.record.generation,
    previousProcessStartToken: first.record.processStartToken,
    targetEntryPath: startup.source.entryPath,
  };
  const requested = await recordDaemonRestartTransition(paths, {
    leaseId: first.record.leaseId,
    generation: first.record.generation,
    processStartToken: first.record.processStartToken,
  }, transition);
  assert.equal(requested.restart?.requestId, transition.requestId);

  const closed = await first.release();
  assert.equal(closed.restart?.requestId, transition.requestId);
  const replacement = await acquireDaemonLease(paths, {
    ownerId: 'humanagent.app.serve',
    startup,
  });
  assert.equal(replacement.record.generation, first.record.generation + 1);
  assert.equal(replacement.record.restart?.requestId, transition.requestId);
  assert.equal(replacement.record.restart?.completedAt, undefined);
  const ready = await replacement.markReady();
  assert.ok(ready.restart?.completedAt);
  await replacement.release();
});

test('serve launch continues a ready live owner without acquiring or preparing', async () => {
  const paths = await fixture();
  const startup = serveStartup(paths);
  const origin = await runSupervisorServeStartup(paths, async () => [
    {
      name: 'fixture-serve',
      ownerId: 'humanagent.app.serve',
      start: async () => {},
    },
  ], { startup });
  assert.equal(origin.status, 'started');
  if (origin.status !== 'started') return;
  await origin.startup.lease.setControlEndpoint({ host: '127.0.0.1', port: 45123 });
  const original = origin.startup.lease.record;
  assert.ok(original.readyAt);
  assert.deepEqual(original.controlEndpoint, { host: '127.0.0.1', port: 45123 });

  let prepared = 0;
  const continued = await runSupervisorServeStartup(paths, async () => {
    prepared += 1;
    return [];
  }, { startup });
  assert.equal(continued.status, 'already-running');
  if (continued.status !== 'already-running') return;
  assert.equal(prepared, 0);
  assert.equal(continued.lease.leaseId, original.leaseId);
  assert.equal(continued.lease.generation, original.generation);
  assert.equal(continued.lease.pid, original.pid);
  assert.equal(continued.lease.processStartToken, original.processStartToken);
  assert.deepEqual(continued.lease.controlEndpoint, original.controlEndpoint);
  assert.equal(continued.lease.disposedAt, undefined);

  const persisted = await readDaemonLease(paths);
  assert.equal(persisted?.leaseId, original.leaseId);
  assert.equal(persisted?.generation, original.generation);
  assert.equal(persisted?.disposedAt, undefined);
  await origin.startup.dispose();
});

test('concurrent serve launches run the lazy factory once and reject the other as not ready', async () => {
  const paths = await fixture();
  const startup = serveStartup(paths);
  let prepared = 0;
  let enteredFactory!: () => void;
  const factoryEntered = new Promise<void>((resolve) => {
    enteredFactory = resolve;
  });
  let releaseFactory!: () => void;
  const factoryGate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  const createStages = async () => {
    prepared += 1;
    enteredFactory();
    await factoryGate;
    return [
      {
        name: 'fixture-serve',
        ownerId: 'humanagent.app.serve',
        start: async () => {},
      },
    ];
  };

  const first = runSupervisorServeStartup(paths, createStages, { startup });
  const second = runSupervisorServeStartup(paths, createStages, { startup });
  const settled = Promise.allSettled([first, second]);
  await factoryEntered;
  assert.equal(prepared, 1);
  releaseFactory();
  const outcomes = await settled;
  const started = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<typeof first>> => (
    outcome.status === 'fulfilled' && outcome.value.status === 'started'
  ));
  const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  assert.equal(started.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(prepared, 1);
  const otherCode = (rejected[0]!.reason as AppLifecycleError).code;
  assert.ok(
    otherCode === 'daemon-serve.not-ready' || otherCode === 'daemon-lease-transition-in-progress',
    otherCode,
  );
  const startedLease = started[0]!.value;
  if (startedLease.status === 'started') await startedLease.startup.dispose();
});

test('serve launch refuses a pending restart and rejects stale restart markers before preparation', async () => {
  const paths = await fixture();
  const startup = serveStartup(paths);
  const owner = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve', startup });
  await owner.markReady();
  await owner.setControlEndpoint({ host: '127.0.0.1', port: 45124 });
  const transition = {
    requestId: 'restart-request-active',
    requestedAt: new Date().toISOString(),
    previousLeaseId: owner.record.leaseId,
    previousGeneration: owner.record.generation,
    previousProcessStartToken: owner.record.processStartToken,
    targetEntryPath: startup.source.entryPath,
  };
  await recordDaemonRestartTransition(paths, {
    leaseId: owner.record.leaseId,
    generation: owner.record.generation,
    processStartToken: owner.record.processStartToken,
  }, transition);

  let prepared = 0;
  const createStages = async () => {
    prepared += 1;
    return [];
  };

  await assert.rejects(() => runSupervisorServeStartup(paths, createStages, { startup }), (error: any) => {
    assert.equal(error.code, 'daemon-serve.restart-in-progress');
    return true;
  });
  assert.equal(prepared, 0);

  await assert.rejects(() => runSupervisorServeStartup(paths, createStages, {
    startup,
    restartRequest: 'restart-request-stale',
  }), (error: any) => {
    assert.equal(error.code, 'daemon-restart.request-mismatch');
    return true;
  });
  assert.equal(prepared, 0);

  await assert.rejects(() => runSupervisorServeStartup(paths, createStages, {
    startup: {
      ...startup,
      source: { ...startup.source, entryPath: '/fixture/candidate/other-entry.js' },
    },
    restartRequest: transition.requestId,
  }), (error: any) => {
    assert.equal(error.code, 'daemon-restart.target-mismatch');
    return true;
  });
  assert.equal(prepared, 0);

  const persisted = await readDaemonLease(paths);
  assert.equal(persisted?.leaseId, owner.record.leaseId);
  assert.equal(persisted?.generation, owner.record.generation);
  assert.equal(persisted?.disposedAt, undefined);
  assert.equal(persisted?.restart?.requestId, transition.requestId);
  await owner.release();
});

test('serve restart marker replaces a disposed pending owner and completes the transition', async () => {
  const paths = await fixture();
  const startup = serveStartup(paths);
  const owner = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve', startup });
  await owner.markReady();
  await owner.setControlEndpoint({ host: '127.0.0.1', port: 45125 });
  const transition = {
    requestId: 'restart-request-disposed',
    requestedAt: new Date().toISOString(),
    previousLeaseId: owner.record.leaseId,
    previousGeneration: owner.record.generation,
    previousProcessStartToken: owner.record.processStartToken,
    targetEntryPath: startup.source.entryPath,
  };
  await recordDaemonRestartTransition(paths, {
    leaseId: owner.record.leaseId,
    generation: owner.record.generation,
    processStartToken: owner.record.processStartToken,
  }, transition);
  await owner.release();

  let prepared = 0;
  const replacement = await runSupervisorServeStartup(paths, async () => {
    prepared += 1;
    return [
      {
        name: 'fixture-serve',
        ownerId: 'humanagent.app.serve',
        start: async () => {},
      },
    ];
  }, { startup, restartRequest: transition.requestId });
  assert.equal(replacement.status, 'started');
  if (replacement.status !== 'started') return;
  assert.equal(prepared, 1);
  assert.equal(replacement.startup.lease.record.generation, owner.record.generation + 1);
  assert.equal(replacement.startup.lease.record.restart?.requestId, transition.requestId);
  assert.ok(replacement.startup.lease.record.restart?.completedAt);
  assert.equal(replacement.startup.lease.record.terminations?.find((entry) =>
    entry.previousLeaseId === owner.record.leaseId)?.termination, 'graceful');
  await replacement.startup.dispose();
});

test('serve restart marker stops a live owner after the request fence and commits the replacement', async () => {
  const paths = await fixture();
  const startup = serveStartup(paths);
  const child = await startLeaseChild(paths, 'exit-on-term', 'humanagent.app.serve');
  try {
    const childLease = await readDaemonLease(paths);
    if (childLease === undefined) throw new Error('expected the child daemon lease');
    const transition = {
      requestId: 'restart-request-live',
      requestedAt: new Date().toISOString(),
      previousLeaseId: childLease.leaseId,
      previousGeneration: childLease.generation,
      previousProcessStartToken: childLease.processStartToken,
      targetEntryPath: startup.source.entryPath,
    };
    await recordDaemonRestartTransition(paths, {
      leaseId: childLease.leaseId,
      generation: childLease.generation,
      processStartToken: childLease.processStartToken,
    }, transition);

    let prepared = 0;
    const replacement = await runSupervisorServeStartup(paths, async () => {
      prepared += 1;
      return [
        {
          name: 'fixture-serve',
          ownerId: 'humanagent.app.serve',
          start: async () => {},
        },
      ];
    }, {
      startup,
      restartRequest: transition.requestId,
      restartStop: { gracefulTimeoutMs: 1_000, pollIntervalMs: 10 },
    });
    assert.equal(replacement.status, 'started');
    if (replacement.status !== 'started') return;
    assert.equal(prepared, 1);
    assert.equal(replacement.startup.lease.record.generation, childLease.generation + 1);
    assert.equal(replacement.startup.lease.record.takeover?.previousLeaseId, childLease.leaseId);
    assert.equal(replacement.startup.lease.record.takeover?.termination, 'graceful');
    assert.equal(replacement.startup.lease.record.restart?.requestId, transition.requestId);
    assert.ok(replacement.startup.lease.record.restart?.completedAt);
    assert.equal(processIsAliveForTest(child.pid), false);
    await replacement.startup.dispose();
  } finally {
    await child.stop();
  }
});

test('dispose cleanup failure is durable in the lease and the caller receipt', async () => {
  const paths = await fixture();
  const startup = await runSupervisorStartup(paths, [
    {
      name: 'stage-a',
      ownerId: 'owner-a',
      start: async () => {},
      dispose: async () => { throw new Error('listener close failed'); },
    },
  ]);
  const receipt = await startup.dispose();
  assert.equal(receipt.cleanupFailure?.ownerId, 'owner-a');
  assert.match(receipt.cleanupFailure?.message ?? '', /listener close failed/);
  assert.equal(receipt.lease.failure?.errorCode, 'supervisor-dispose.cleanup-failed');
  await assert.rejects(
    () => acquireDaemonLease(paths),
    (error: any) => error.code === 'daemon-takeover.previous-close-unverified',
  );
  await assert.rejects(
    () => acquireDaemonLease(paths, { takeover: { reason: 'retry after failed cleanup', stop: {} } }),
    (error: any) => error.code === 'daemon-takeover.previous-close-unverified',
  );
  assert.equal((await readDaemonLease(paths))?.leaseId, receipt.lease.leaseId);
});

test('startup dispose remains retryable when lease release fails', async () => {
  const paths = await fixture();
  const startup = await runSupervisorStartup(paths, []);
  const originalRelease = startup.lease.release.bind(startup.lease);
  let releaseCalls = 0;
  Object.defineProperty(startup.lease, 'release', {
    value: async (...args: Parameters<typeof originalRelease>) => {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error('lease store unavailable');
      return originalRelease(...args);
    },
  });

  await assert.rejects(() => startup.dispose(), /lease store unavailable/);
  const receipt = await startup.dispose();
  assert.equal(releaseCalls, 2);
  assert.ok(receipt.lease.disposedAt);
});

test('startup dispose does not infer a lease handoff without a newer durable owner', async () => {
  const paths = await fixture();
  const startup = await runSupervisorStartup(paths, []);
  Object.defineProperty(startup.lease, 'release', {
    value: async () => {
      throw new AppLifecycleError(
        'daemon-lease-transition-in-progress',
        'another daemon lease transition is already in progress',
        'wait for the daemon lease transition to finish',
      );
    },
  });

  await assert.rejects(() => startup.dispose(), (error: any) => {
    assert.equal(error.code, 'daemon-lease-transition-in-progress');
    return true;
  });
});

test('lease transition is not a handoff receipt until the newer live lease is durable', async () => {
  const paths = await fixture();
  const first = await acquireDaemonLease(paths, { ownerId: 'humanagent.app.serve' });
  const previous = first.record;

  assert.equal(await isDaemonLeaseHandoffCommitted(paths, previous), false);
  const current = JSON.parse(await readFile(daemonLeasePath(paths), 'utf8')) as Record<string, unknown>;
  await writeFile(daemonLeasePath(paths), JSON.stringify({
    ...current,
    leaseId: 'replacement-lease',
    generation: previous.generation + 1,
    processStartToken: 'node:replacement',
    pid: process.pid,
    disposedAt: undefined,
  }) + '\n', 'utf8');

  assert.equal(await isDaemonLeaseHandoffCommitted(paths, previous), true);
});

test('partial startup failure cleans up reverse and keeps owner/next-action failure receipt', async () => {
  const paths = await fixture();
  const events: string[] = [];
  let caught: any;
  try {
    await runSupervisorStartup(paths, [
      {
        name: 'stage-a',
        ownerId: 'owner-a',
        start: async () => { events.push('start:a'); },
        dispose: async () => { events.push('dispose:a'); },
      },
      {
        name: 'stage-b',
        ownerId: 'owner-b',
        start: async () => { events.push('start:b'); },
        dispose: async () => { events.push('dispose:b'); },
      },
      {
        name: 'stage-c',
        ownerId: 'owner-c',
        nextAction: 'fix dependency c and retry',
        start: async () => {
          events.push('start:c');
          throw new Error('c unavailable');
        },
        dispose: async () => { events.push('dispose:c'); },
      },
    ]);
  } catch (error) {
    caught = error;
  }

  assert.ok(caught);
  assert.equal(caught.code, 'supervisor-startup-failed');
  assert.equal(caught.ownerId, 'owner-c');
  assert.equal(caught.nextAction, 'fix dependency c and retry');
  assert.deepEqual(caught.supervisorFailure.startedStages, ['stage-a', 'stage-b', 'stage-c']);
  assert.deepEqual(caught.supervisorFailure.disposedStages, ['stage-c', 'stage-b', 'stage-a']);
  assert.deepEqual(events, ['start:a', 'start:b', 'start:c', 'dispose:c', 'dispose:b', 'dispose:a']);

  const lease = await readDaemonLease(paths);
  assert.ok(lease?.disposedAt);
  assert.equal(lease?.failure?.ownerId, 'owner-c');
  assert.equal(lease?.failure?.errorCode, 'supervisor-startup-failed');
  assert.equal(lease?.failure?.nextAction, 'fix dependency c and retry');
});

test('session lock accepts a supervisor fence and rejects a mismatched fence handle', async () => {
  const paths = await fixture();
  const store = new SessionStore(paths);
  const lease = await acquireDaemonLease(paths);
  const fence = { leaseId: lease.record.leaseId, generation: lease.record.generation };
  const lock = await store.acquire('session-fenced', fence);
  await store.create({ sessionId: 'session-fenced', plan: 'default' }, lock);

  const ownerPath = join(lock.path, 'owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>;
  await writeFile(ownerPath, JSON.stringify({ ...owner, fence: { leaseId: 'other-lease', generation: 99 } }) + '\n', 'utf8');

  await assert.rejects(() => store.append('session-fenced', { type: 'session.state', state: 'ready' }, lock), (error: any) => {
    assert.equal(error.code, 'session-lock-fence-mismatch');
    return true;
  });

  await lock.release();
  await lease.release();
});
test('session lock fences writes against the active daemon lease and stale lock takeover', async () => {
  const paths = await fixture();
  const store = new SessionStore(paths);
  const firstLease = await acquireDaemonLease(paths);
  const firstFence = { leaseId: firstLease.record.leaseId, generation: firstLease.record.generation };
  const firstLock = await store.acquire('session-active-fence', firstFence);
  await store.create({ sessionId: 'session-active-fence', plan: 'default' }, firstLock);

  await firstLease.release();
  const secondLease = await acquireDaemonLease(paths);
  const secondFence = { leaseId: secondLease.record.leaseId, generation: secondLease.record.generation };

  await assert.rejects(() => store.append('session-active-fence', { type: 'session.state', state: 'ready' }, firstLock), (error: any) => {
    assert.equal(error.code, 'session-lock-fence-mismatch');
    return true;
  });

  const secondLock = await store.acquire('session-active-fence', secondFence);
  await assert.rejects(() => firstLock.release(), /owned by another runtime/);
  const ready = await store.append('session-active-fence', { type: 'session.state', state: 'ready' }, secondLock);
  assert.equal(ready.state, 'ready');

  await secondLock.release();
  await secondLease.release();
});

test('fenced session append holds the daemon transition guard through its durable write', async () => {
  const paths = await fixture();
  const store = new SessionStore(paths);
  const lease = await acquireDaemonLease(paths);
  const fence = { leaseId: lease.record.leaseId, generation: lease.record.generation };
  const lock = await store.acquire('session-race', fence);
  await store.create({ sessionId: 'session-race', plan: 'default' }, lock);

  const originalOpen = store.open.bind(store);
  let enteredWrite!: () => void;
  let releaseWrite!: () => void;
  const writeEntered = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let firstOpen = true;
  (store as unknown as { open: typeof store.open }).open = async (sessionId: string) => {
    if (firstOpen) {
      firstOpen = false;
      enteredWrite();
      await writeBlocked;
    }
    return originalOpen(sessionId);
  };

  const append = store.append('session-race', { type: 'session.state', state: 'ready' }, lock);
  await writeEntered;
  await assert.rejects(() => acquireDaemonLease(paths, {
    takeover: { reason: 'append must finish before takeover', allowed: () => true },
  }), (error: any) => {
    assert.equal(error.code, 'daemon-lease-transition-in-progress');
    return true;
  });
  releaseWrite();
  const ready = await append;
  assert.equal(ready.state, 'ready');
  const session = await store.open('session-race');
  assert.equal(session.records.length, 2);
  await lock.release();
  await lease.release();
});

test('real child-process crash leaves a stale owner that cannot commit after takeover', async () => {
  const paths = await fixture();
  const configModule = new URL('../../../packages/config/src/index.js', import.meta.url).href;
  const sessionStoreModule = new URL('../../../packages/app/src/session-store.js', import.meta.url).href;
  const supervisorModule = new URL('../../../packages/app/src/supervisor/index.js', import.meta.url).href;
  const sessionId = 'session-child-crash';
  const script = `
    import { resolveRuntimePaths } from ${JSON.stringify(configModule)};
    import { SessionStore } from ${JSON.stringify(sessionStoreModule)};
    import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
    const paths = await resolveRuntimePaths({ controlRoot: ${JSON.stringify(paths.controlRoot)}, workspace: ${JSON.stringify(paths.workspaceCwd)} });
    const lease = await acquireDaemonLease(paths);
    const store = new SessionStore(paths);
    const lock = await store.acquire(${JSON.stringify(sessionId)}, { leaseId: lease.record.leaseId, generation: lease.record.generation });
    await store.create({ sessionId: ${JSON.stringify(sessionId)}, plan: 'default' }, lock);
    console.log(JSON.stringify({ pid: process.pid, leaseId: lease.record.leaseId, generation: lease.record.generation, lockPath: lock.path, lockToken: lock.lockToken }));
  `;
  const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  })) as { readonly pid: number; readonly leaseId: string; readonly generation: number; readonly lockPath: string; readonly lockToken: string };

  const crashed = await readDaemonLease(paths);
  assert.equal(crashed?.pid, child.pid);
  assert.equal(crashed?.leaseId, child.leaseId);
  await assert.rejects(() => acquireDaemonLease(paths), (error: any) => {
    assert.equal(error.code, 'daemon-lease-owned');
    return true;
  });

  const takeover = await acquireDaemonLease(paths, { takeover: { reason: 'child process exited without releasing lease' } });
  assert.equal(takeover.record.takeover?.previousLeaseId, child.leaseId);

  const staleLock = {
    path: child.lockPath,
    sessionId,
    lockToken: child.lockToken,
    fence: { leaseId: child.leaseId, generation: child.generation },
    release: async () => {},
  };
  await assert.rejects(() => new SessionStore(paths).append(sessionId, { type: 'session.state', state: 'ready' }, staleLock), (error: any) => {
    assert.equal(error.code, 'session-lock-fence-mismatch');
    return true;
  });
  assert.equal((await new SessionStore(paths).open(sessionId)).records.length, 1);

  const freshLock = await new SessionStore(paths).acquire(sessionId, {
    leaseId: takeover.record.leaseId,
    generation: takeover.record.generation,
  });
  const ready = await new SessionStore(paths).append(sessionId, { type: 'session.state', state: 'ready' }, freshLock);
  assert.equal(ready.state, 'ready');
  await freshLock.release();
  await takeover.release();
});

test('startup owner crash recovery accepts an already-dead unclosed lease', async () => {
  const paths = await fixture();
  const configModule = new URL('../../../packages/config/src/index.js', import.meta.url).href;
  const supervisorModule = new URL('../../../packages/app/src/supervisor/index.js', import.meta.url).href;
  const script = `
    import { resolveRuntimePaths } from ${JSON.stringify(configModule)};
    import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
    const paths = await resolveRuntimePaths({ controlRoot: ${JSON.stringify(paths.controlRoot)}, workspace: ${JSON.stringify(paths.workspaceCwd)} });
    const lease = await acquireDaemonLease(paths, {
      ownerId: 'humanagent.app.serve',
      startup: {
        launcherPath: process.execPath,
        cwd: ${JSON.stringify(paths.workspaceCwd)},
        args: [],
        source: { entryPath: process.execPath, packageVersion: '0.0.0-test' },
      },
    });
    console.log(JSON.stringify({ pid: process.pid, leaseId: lease.record.leaseId }));
  `;
  const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  })) as { readonly pid: number; readonly leaseId: string };

  const crashed = await readDaemonLease(paths);
  assert.equal(crashed?.leaseId, child.leaseId);
  assert.equal(crashed?.pid, child.pid);
  assert.ok(crashed?.startup);
  assert.ok(!processIsAliveForTest(child.pid));
  assert.equal(crashed?.disposedAt, undefined);

  const previousFailure = {
    phase: 'startup',
    ownerId: 'humanagent.app.serve',
    errorCode: 'fixture-unresolved-failure',
    nextAction: 'inspect unresolved owner responsibility',
    message: 'original owner failure',
    occurredAt: new Date().toISOString(),
  };
  await writeFile(daemonLeasePath(paths), JSON.stringify({ ...crashed, failure: previousFailure }) + '\n', 'utf8');

  const takeover = await acquireDaemonLease(paths, {
    ownerId: 'humanagent.app.serve',
    takeover: {
      reason: 'startup owner exited without publishing disposal',
      stop: { gracefulTimeoutMs: 1_000, pollIntervalMs: 10 },
    },
  });
  assert.equal(takeover.record.generation, 2);
  assert.equal(takeover.record.takeover?.previousLeaseId, child.leaseId);
  assert.equal(takeover.record.takeover?.termination, 'already-dead');
  assert.deepEqual(takeover.record.takeover?.previousFailure, previousFailure);
  assert.equal(takeover.record.disposedAt, undefined);
  await takeover.release();
});

async function startLeaseChild(
  paths: RuntimePaths,
  behavior: 'exit-on-term' | 'delay-term',
  ownerId = 'supervisor',
): Promise<{ readonly pid: number; readonly leaseId: string; readonly stop: () => Promise<void> }> {
  const supervisorModule = new URL('../../../packages/app/src/supervisor/index.js', import.meta.url).href;
  const script = `
    import { createServer } from 'node:http';
    import { resolveRuntimePaths } from ${JSON.stringify(new URL('../../../packages/config/src/index.js', import.meta.url).href)};
    import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
    const paths = await resolveRuntimePaths({ controlRoot: ${JSON.stringify(paths.controlRoot)}, workspace: ${JSON.stringify(paths.workspaceCwd)} });
    const lease = await acquireDaemonLease(paths, { ownerId: ${JSON.stringify(ownerId)} });
    const identityServer = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/api/runtime/identity') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        leaseId: lease.record.leaseId,
        generation: lease.record.generation,
        pid: lease.record.pid,
        processStartToken: lease.record.processStartToken,
      }));
    });
    await new Promise((resolve, reject) => {
      identityServer.once('error', reject);
      identityServer.listen(0, '127.0.0.1', resolve);
    });
    const address = identityServer.address();
    if (!address || typeof address === 'string') throw new Error('identity server did not bind');
    await lease.setControlEndpoint({ host: '127.0.0.1', port: address.port });
    console.log(JSON.stringify({ pid: process.pid, leaseId: lease.record.leaseId }));
    process.on('SIGTERM', ${behavior === 'exit-on-term' ? '() => process.exit(0)' : '() => setTimeout(() => process.exit(0), 150)'});
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const line = await new Promise<string>((resolve, reject) => {
    let output = '';
      child.stdout.on('data', (chunk: unknown) => {
      output += String(chunk);
      const newline = output.indexOf('\n');
      if (newline >= 0) resolve(output.slice(0, newline));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`lease child exited before ready: ${code}`)));
  });
  const receipt = JSON.parse(line) as { readonly pid: number; readonly leaseId: string };
  return {
    ...receipt,
    stop: async () => {
      if (!processIsAliveForTest(receipt.pid)) return;
      process.kill(receipt.pid, 'SIGTERM');
      const deadline = Date.now() + 2_000;
      while (processIsAliveForTest(receipt.pid)) {
        if (Date.now() >= deadline) throw new Error(`lease child ${receipt.pid} did not exit after SIGTERM`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

test('hm startup gracefully takes over a live daemon and records the new generation', async () => {
  const paths = await fixture();
  const child = await startLeaseChild(paths, 'exit-on-term');
  try {
    const startup = await runSupervisorStartup(paths, [], {
      lease: {
        ownerId: 'humanagent.app.serve',
        takeover: { reason: 'new hm serve process takes over the previous daemon', stop: { gracefulTimeoutMs: 500 } },
      },
    });
    assert.equal(startup.lease.record.generation, 2);
    assert.equal(startup.lease.record.takeover?.previousLeaseId, child.leaseId);
    assert.equal(startup.lease.record.takeover?.termination, 'graceful');
    assert.equal(startup.lease.record.takeover?.gracefulStopError, undefined);
    await startup.dispose();
  } finally {
    await child.stop();
  }
});

test('hm startup fails explicitly when a daemon does not exit after SIGTERM', async () => {
  const paths = await fixture();
  const child = await startLeaseChild(paths, 'delay-term');
  try {
    await assert.rejects(
      () => runSupervisorStartup(paths, [], {
        lease: {
          ownerId: 'humanagent.app.serve',
          takeover: { reason: 'new hm serve process waits for term timeout', stop: { gracefulTimeoutMs: 30, pollIntervalMs: 5 } },
        },
      }),
      (error: any) => error.code === 'daemon-takeover.failed' && /did not exit after SIGTERM/u.test(error.message),
    );
    assert.equal(processIsAliveForTest(child.pid), true);
  } finally {
    await child.stop();
  }
});

test('hm startup does not publish a replacement lease when graceful signaling is denied', async () => {
  const paths = await fixture();
  const child = await startLeaseChild(paths, 'delay-term');
  const processWithKill = process as unknown as {
    kill: (pid: number, signal: number | string) => void;
  };
  const originalKill = processWithKill.kill;
  processWithKill.kill = (pid, signal) => {
    if (pid === child.pid && signal === 'SIGTERM') {
      const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      throw error;
    }
    return originalKill(pid, signal);
  };
  try {
    await assert.rejects(
      () => runSupervisorStartup(paths, [], {
        lease: {
          ownerId: 'humanagent.app.serve',
          takeover: { reason: 'signal permission failure', stop: { gracefulTimeoutMs: 30, pollIntervalMs: 5 } },
        },
      }),
      (error: any) => error.code === 'daemon-takeover.failed',
    );
    const lease = await readDaemonLease(paths);
    assert.equal(lease?.leaseId, child.leaseId);
    assert.equal(lease?.disposedAt, undefined);
  } finally {
    processWithKill.kill = originalKill;
    await child.stop();
  }
});

test('hm startup refuses to signal a live PID whose process identity was reused', async () => {
  const paths = await fixture();
  const child = await startLeaseChild(paths, 'delay-term');
  try {
    const leasePath = daemonLeasePath(paths);
    const raw = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...raw, processStartToken: 'node:reused-pid' }) + '\n', 'utf8');
    await assert.rejects(
      () => runSupervisorStartup(paths, [], {
        lease: {
          ownerId: 'humanagent.app.serve',
          takeover: { reason: 'reject reused pid', stop: { gracefulTimeoutMs: 30, pollIntervalMs: 5 } },
        },
      }),
      (error: any) => error.code === 'daemon-takeover.identity-mismatch',
    );
    assert.equal(processIsAliveForTest(child.pid), true);
  } finally {
    await child.stop();
  }
});

test('lease validation rejects process-group PID values before takeover can signal', async () => {
  for (const pid of [0, -1]) {
    const paths = await fixture();
    await acquireDaemonLease(paths);
    const raw = JSON.parse(await readFile(daemonLeasePath(paths), 'utf8')) as Record<string, unknown>;
    await writeFile(daemonLeasePath(paths), JSON.stringify({ ...raw, pid }) + '\n', 'utf8');
    await assert.rejects(
      () => acquireDaemonLease(paths, {
        takeover: {
          reason: 'reject process-group pid',
          stop: { gracefulTimeoutMs: 1, pollIntervalMs: 1 },
        },
      }),
      (error: any) => error.code === 'daemon-lease-corrupt',
    );
  }
});

function processIsAliveForTest(pid: number): boolean {
  try {
    (process as unknown as { kill(pid: number, signal: 0): void }).kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}
