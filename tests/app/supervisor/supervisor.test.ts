import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, resolveRuntimePaths, type RuntimePaths } from '../../../packages/config/src/index.js';
import { SessionStore } from '../../../packages/app/src/session-store.js';
import { AppLifecycleError } from '../../../packages/app/src/errors.js';
import {
  acquireDaemonLease,
  daemonLeasePath,
  isDaemonLeaseHandoffCommitted,
  readDaemonLease,
  runSupervisorStartup,
} from '../../../packages/app/src/supervisor/index.js';

async function fixture(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-supervisor-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  return paths;
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

async function startLeaseChild(paths: RuntimePaths, behavior: 'exit-on-term' | 'ignore-term'): Promise<{ readonly pid: number; readonly leaseId: string }> {
  const supervisorModule = new URL('../../../packages/app/src/supervisor/index.js', import.meta.url).href;
  const script = `
    import { createServer } from 'node:http';
    import { resolveRuntimePaths } from ${JSON.stringify(new URL('../../../packages/config/src/index.js', import.meta.url).href)};
    import { acquireDaemonLease } from ${JSON.stringify(supervisorModule)};
    const paths = await resolveRuntimePaths({ controlRoot: ${JSON.stringify(paths.controlRoot)}, workspace: ${JSON.stringify(paths.workspaceCwd)} });
    const lease = await acquireDaemonLease(paths);
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
    process.on('SIGTERM', ${behavior === 'exit-on-term' ? '() => process.exit(0)' : '() => {}'});
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
  return JSON.parse(line) as { readonly pid: number; readonly leaseId: string };
}

test('hm startup gracefully takes over a live daemon and records the new generation', async () => {
  const paths = await fixture();
  const child = await startLeaseChild(paths, 'exit-on-term');
  try {
    const startup = await runSupervisorStartup(paths, [], {
      lease: {
        ownerId: 'humanagent.app.serve',
        takeover: { reason: 'new hm serve process takes over the previous daemon', stop: { gracefulTimeoutMs: 500, forceTimeoutMs: 500 } },
      },
    });
    assert.equal(startup.lease.record.generation, 2);
    assert.equal(startup.lease.record.takeover?.previousLeaseId, child.leaseId);
    assert.equal(startup.lease.record.takeover?.termination, 'graceful');
    assert.equal(startup.lease.record.takeover?.gracefulStopError, undefined);
    await startup.dispose();
  } finally {
    if (processIsAliveForTest(child.pid)) killForTest(child.pid, 'SIGKILL');
  }
});

test('hm startup force-stops a daemon that ignores graceful stop', async () => {
  const paths = await fixture();
  const child = await startLeaseChild(paths, 'ignore-term');
  try {
    const startup = await runSupervisorStartup(paths, [], {
      lease: {
        ownerId: 'humanagent.app.serve',
        takeover: { reason: 'new hm serve process takes over an unresponsive daemon', stop: { gracefulTimeoutMs: 30, forceTimeoutMs: 500, pollIntervalMs: 5 } },
      },
    });
    assert.equal(startup.lease.record.generation, 2);
    assert.equal(startup.lease.record.takeover?.previousLeaseId, child.leaseId);
    assert.equal(startup.lease.record.takeover?.termination, 'forced');
    await startup.dispose();
  } finally {
    if (processIsAliveForTest(child.pid)) killForTest(child.pid, 'SIGKILL');
  }
});

test('hm startup does not publish a replacement lease when graceful signaling is denied', async () => {
  const paths = await fixture();
  const child = await startLeaseChild(paths, 'ignore-term');
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
          takeover: { reason: 'signal permission failure', stop: { gracefulTimeoutMs: 30, forceTimeoutMs: 30, pollIntervalMs: 5 } },
        },
      }),
      (error: any) => error.code === 'daemon-takeover.failed',
    );
    const lease = await readDaemonLease(paths);
    assert.equal(lease?.leaseId, child.leaseId);
    assert.equal(lease?.disposedAt, undefined);
  } finally {
    processWithKill.kill = originalKill;
    if (processIsAliveForTest(child.pid)) killForTest(child.pid, 'SIGKILL');
  }
});

test('hm startup refuses to signal a live PID whose process identity was reused', async () => {
  const paths = await fixture();
  const child = await startLeaseChild(paths, 'ignore-term');
  try {
    const leasePath = daemonLeasePath(paths);
    const raw = JSON.parse(await readFile(leasePath, 'utf8')) as Record<string, unknown>;
    await writeFile(leasePath, JSON.stringify({ ...raw, processStartToken: 'node:reused-pid' }) + '\n', 'utf8');
    await assert.rejects(
      () => runSupervisorStartup(paths, [], {
        lease: {
          ownerId: 'humanagent.app.serve',
          takeover: { reason: 'reject reused pid', stop: { gracefulTimeoutMs: 30, forceTimeoutMs: 30, pollIntervalMs: 5 } },
        },
      }),
      (error: any) => error.code === 'daemon-takeover.identity-mismatch',
    );
    assert.equal(processIsAliveForTest(child.pid), true);
  } finally {
    if (processIsAliveForTest(child.pid)) killForTest(child.pid, 'SIGKILL');
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
          stop: { gracefulTimeoutMs: 1, forceTimeoutMs: 1, pollIntervalMs: 1 },
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

function killForTest(pid: number, signal: 'SIGKILL'): void {
  (process as unknown as { kill(pid: number, signal: 'SIGKILL'): void }).kill(pid, signal);
}
