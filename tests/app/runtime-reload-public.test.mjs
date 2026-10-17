import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const oldEntry = process.env.HUMANAGENT_RELOAD_OLD_ENTRY;
const newEntry = process.env.HUMANAGENT_RELOAD_NEW_ENTRY;
const fixtureRoot = process.env.HUMANAGENT_RELOAD_FIXTURE_ROOT;
const available = Boolean(oldEntry && newEntry && fixtureRoot);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPgid(pid) {
  const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  return Number.parseInt(out.trim(), 10);
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

function runProcess(entry, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function packageRuntimeRoot(entry) {
  const resolved = await realpath(entry);
  if (basename(dirname(resolved)) === 'bin') return join(dirname(resolved), '..', 'runtime');
  return join(dirname(resolved), '..', '..', '..');
}

async function loadRuntimeModule(runtimeRoot, relativePath) {
  return import(pathToFileURL(join(runtimeRoot, relativePath)).href);
}

async function runtimePaths(runtimeRoot, workspace, controlRoot) {
  const { resolveRuntimePaths } = await loadRuntimeModule(runtimeRoot, 'config/src/index.js');
  return resolveRuntimePaths({ workspace, controlRoot });
}

async function readLease(runtimeRoot, workspace, controlRoot) {
  const paths = await runtimePaths(runtimeRoot, workspace, controlRoot);
  const path = join(paths.projectRoot, 'daemon', 'lease.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readIdentity(runtimeRoot, workspace, controlRoot, lease) {
  const paths = await runtimePaths(runtimeRoot, workspace, controlRoot);
  const { deriveSupervisorToken } = await loadRuntimeModule(runtimeRoot, 'app/src/ui-runtime/access-control.js');
  const token = await deriveSupervisorToken(paths.webAccessCredentialPath, lease.leaseId, lease.generation);
  const host = lease.controlEndpoint.host === '::1' ? '[::1]' : lease.controlEndpoint.host;
  const response = await fetch(`http://${host}:${lease.controlEndpoint.port}/api/runtime/identity`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`identity request failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitForIdentity(runtimeRoot, workspace, controlRoot, predicate, timeoutMs) {
  return waitFor(async () => {
    const lease = await readLease(runtimeRoot, workspace, controlRoot);
    if (
      !lease
      || lease.ownerId !== 'humanagent.app.serve'
      || lease.disposedAt
      || !lease.readyAt
      || !lease.controlEndpoint
      || !predicate(lease)
    ) return undefined;
    const identity = await readIdentity(runtimeRoot, workspace, controlRoot, lease);
    return { lease, identity };
  }, timeoutMs, 'serve identity');
}

async function pair(runtimeRoot, entry, workspace, controlRoot, env) {
  const result = await runProcess(entry, [
    'pair',
    '--workspace', workspace,
    '--control-root', controlRoot,
  ], workspace, env);
  if (result.code !== 0) throw new Error(`pair exited ${result.code}: ${result.stderr}`);
  const receipt = JSON.parse(result.stdout);
  const paths = await runtimePaths(runtimeRoot, workspace, controlRoot);
  const lease = await readLease(runtimeRoot, workspace, controlRoot);
  const host = lease.controlEndpoint.host === '::1' ? '[::1]' : lease.controlEndpoint.host;
  const origin = `http://${host}:${lease.controlEndpoint.port}`;
  const response = await fetch(`${origin}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ code: receipt.code }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`pair login failed ${response.status}: ${body}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('pair login returned no session cookie');
  return {
    origin,
    async request(path, init = {}) {
      const headers = new Headers(init.headers ?? {});
      headers.set('cookie', cookie);
      if (String(init.method ?? 'GET').toUpperCase() !== 'GET') headers.set('origin', origin);
      return fetch(`${origin}${path}`, { ...init, headers });
    },
  };
}

async function createAndSettleTask(auth) {
  const created = await auth.request('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'runtime reload continuity',
      directive: 'keep the settled fake task across the restart',
    }),
  });
  assert.equal(created.status, 201);
  const task = await created.json();
  const taskId = task.taskId.value;
  const grant = await auth.request(`/api/tasks/${encodeURIComponent(taskId)}/control/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: `runtime-reload-public-grant:${taskId}`,
      expectedRevision: 0,
      capability: {
        actionId: 'task.execute',
        capabilities: ['provider.execution'],
      },
    }),
  });
  const grantBody = await grant.text();
  assert.equal(grant.status, 200, grantBody);
  const started = await auth.request(`/api/tasks/${encodeURIComponent(taskId)}/executions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'fake', prompt: 'settle before the code handoff' }),
  });
  const startedBody = await started.text();
  assert.equal(started.status, 202, startedBody);
  const settled = await waitFor(async () => {
    const response = await auth.request(`/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
    if (!response.ok) return undefined;
    const dashboard = await response.json();
    return dashboard.state === 'running' ? undefined : dashboard;
  }, 20_000, 'fake task settlement');
  assert.equal(typeof settled.output, 'string');
  return taskId;
}

async function stopPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await waitFor(() => !isProcessAlive(pid), 15_000, `process ${pid} exit`);
}

test('official restart loads the selected new package through one graceful handoff', {
  skip: !available,
  timeout: 90_000,
}, async () => {
  const workspace = join(fixtureRoot, 'r2-public', 'workspace');
  const controlRoot = join(fixtureRoot, 'r2-public', 'control');
  await rm(join(fixtureRoot, 'r2-public'), { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(controlRoot, { recursive: true });
  const oldRuntimeRoot = await packageRuntimeRoot(oldEntry);
  const newRuntimeRoot = await packageRuntimeRoot(newEntry);
  const env = { ...process.env, HOME: fixtureRoot };
  let oldChild;
  let oldStdout = '';
  let oldStderr = '';
  let newPid;
  try {
    oldChild = spawn(process.execPath, [
      oldEntry,
      'serve',
      '--workspace', workspace,
      '--control-root', controlRoot,
      '--provider', 'fake',
      '--port', '0',
    ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    oldChild.stdout.setEncoding('utf8');
    oldChild.stderr.setEncoding('utf8');
    oldChild.stdout.on('data', (chunk) => { oldStdout += chunk; });
    oldChild.stderr.on('data', (chunk) => { oldStderr += chunk; });

    const old = await waitForIdentity(oldRuntimeRoot, workspace, controlRoot, () => true, 20_000);
    const auth = await pair(oldRuntimeRoot, oldEntry, workspace, controlRoot, env);
    const taskId = await createAndSettleTask(auth);

    const restart = await runProcess(newEntry, [
      'restart',
      '--workspace', workspace,
      '--control-root', controlRoot,
      '--provider', 'fake',
      '--port', '0',
    ], workspace, env);
    assert.equal(restart.code, 0, `${restart.stderr}\n${restart.stdout}`);
    const completion = JSON.parse(restart.stdout);
    assert.equal(completion.current.generation, old.lease.generation + 1);
    assert.notEqual(completion.current.pid, old.lease.pid);
    assert.notEqual(completion.current.processStartToken, old.lease.processStartToken);
    assert.equal(completion.previous.leaseId, old.lease.leaseId);
    assert.match(completion.source.entryPath, /runtime\/app\/src\/cli\.js$/);
    assert.equal('entryDigest' in completion.source, false);

    const oldExit = await waitFor(() => oldChild.exitCode !== null || oldChild.signalCode !== null, 10_000, 'old owner exit');
    assert.equal(oldExit, true);
    const replacement = await waitForIdentity(
      newRuntimeRoot,
      workspace,
      controlRoot,
      (lease) => lease.generation > old.lease.generation && lease.pid !== old.lease.pid,
      20_000,
    );
    assert.equal(replacement.identity.leaseId, completion.current.leaseId);
    assert.equal('entryDigest' in replacement.lease.startup.source, false);
    assert.equal('targetEntryDigest' in replacement.lease.restart, false);
    newPid = replacement.lease.pid;
    assert.equal(
      readPgid(newPid),
      newPid,
      `replacement ${newPid} must lead its own process group so caller teardown cannot reap it`,
    );

    const newAuth = await pair(newRuntimeRoot, newEntry, workspace, controlRoot, env);
    const dashboardResponse = await newAuth.request(`/api/tasks/${encodeURIComponent(taskId)}/dashboard`);
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(typeof dashboard.output, 'string');

    await writeFile(join(fixtureRoot, 'r2-public', 'restart.stdout.log'), restart.stdout, 'utf8');
    await writeFile(join(fixtureRoot, 'r2-public', 'restart.stderr.log'), restart.stderr, 'utf8');
  } finally {
    await stopPid(newPid);
    if (oldChild && oldChild.exitCode === null && oldChild.signalCode === null) {
      const exited = new Promise((resolve) => oldChild.once('exit', resolve));
      oldChild.kill('SIGTERM');
      await exited;
    }
    await writeFile(join(fixtureRoot, 'r2-public', 'serve-old.stdout.log'), oldStdout, 'utf8').catch(() => undefined);
    await writeFile(join(fixtureRoot, 'r2-public', 'serve-old.stderr.log'), oldStderr, 'utf8').catch(() => undefined);
  }
});
