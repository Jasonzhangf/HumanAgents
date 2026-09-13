import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { closeRuntime, openRuntime, resumeRuntime } from '../../packages/app/src/index.js';
import { SessionStore } from '../../packages/app/src/session-store.js';

test('CLI config failures preserve structured owner and next action evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-cli-error-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await writeFile(join(controlRoot, 'config.toml'), 'misspelled = true\n', 'utf8');
  assert.throws(() => execFileSync(process.execPath, [join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'), 'doctor', '--workspace', workspace, '--control-root', controlRoot], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
    const parsed = JSON.parse(error.stderr);
    assert.equal(parsed.error.code, 'config-invalid');
    assert.equal(parsed.error.ownerId, 'config-loader');
    assert.equal(typeof parsed.error.nextAction, 'string');
    return true;
  });
});

test('CLI host failures remain structured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-cli-host-error-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  assert.throws(() => execFileSync(process.execPath, [join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js'), 'unknown', '--workspace', workspace], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
    const parsed = JSON.parse(error.stderr);
    assert.equal(parsed.error.code, 'host-error');
    assert.equal(parsed.error.ownerId, 'host');
    assert.equal(typeof parsed.error.nextAction, 'string');
    return true;
  });
});

test('session lifecycle is persisted below control root and keeps agent cwd separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const created = await store.create({ sessionId: 'session-1', plan: 'default' });
  assert.equal(created.state, 'created');
  assert.equal(created.path.startsWith(paths.controlRoot), true);
  assert.equal(paths.agentCwd, paths.controlRoot);
  const ready = await store.append('session-1', { type: 'session.state', state: 'ready' });
  assert.equal(ready.state, 'ready');
  const closed = await store.close('session-1', 'checkpoint:1');
  assert.equal(closed.state, 'stopped');
  assert.equal((await store.open('session-1')).state, 'stopped');
});

test('session writes are lock-bound and serialized per session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-session-write-lock-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-write-lock');
  await store.create({ sessionId: 'session-write-lock', plan: 'default' }, lock);
  const [ready, running] = await Promise.all([
    store.append('session-write-lock', { type: 'session.state', state: 'ready' }, lock),
    store.append('session-write-lock', { type: 'session.state', state: 'running' }, lock),
  ]);
  assert.equal(ready.records.length, 2);
  assert.equal(running.records.length, 3);
  assert.deepEqual(running.records.map((record) => record.seq), [1, 2, 3]);
  const contender = new SessionStore(paths);
  await assert.rejects(() => contender.append('session-write-lock', { type: 'session.state', state: 'stopping' }), /already owned/);
  await lock.release();
});

test('incomplete trailing session line is visible and never treated as a committed record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-tail-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-tail', plan: 'default' });
  await appendFile(join(paths.sessionsRoot, 'session-tail.jsonl'), '{"schemaVersion":1,"sessionId":"session-tail"', 'utf8');
  const opened = await store.open('session-tail');
  assert.equal(opened.recoverableTail, true);
  assert.equal(opened.state, 'created');
  assert.equal(opened.records.length, 1);
});

test('appending after a recoverable tail truncates only the uncommitted tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-recover-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-recover', plan: 'default' });
  await appendFile(join(paths.sessionsRoot, 'session-recover.jsonl'), '{"uncommitted":', 'utf8');
  const recovered = await store.append('session-recover', { type: 'session.state', state: 'ready' });
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.recoverableTail, false);
  assert.equal(recovered.records.length, 2);
});

test('a complete final JSON record without a newline is committed and preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-no-newline-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-no-newline', plan: 'default' });
  const sessionPath = join(paths.sessionsRoot, 'session-no-newline.jsonl');
  const content = await readFile(sessionPath, 'utf8');
  await writeFile(sessionPath, content.slice(0, -1), 'utf8');
  const opened = await store.open('session-no-newline');
  assert.equal(opened.recoverableTail, false);
  assert.equal(opened.records.length, 1);
  const ready = await store.append('session-no-newline', { type: 'session.state', state: 'ready' });
  assert.equal(ready.records.length, 2);
  assert.equal((await store.open('session-no-newline')).records.length, 2);
});

test('session path never uses workspace persistence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-path-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  assert.equal(paths.sessionsRoot.startsWith(paths.controlRoot), true);
  assert.equal(paths.sessionsRoot.startsWith(workspace), false);
});

test('session lock is atomic and remains below control root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-lock');
  assert.equal(lock.path.startsWith(paths.controlRoot), true);
  await assert.rejects(() => store.acquire('session-lock'), /already owned/);
  await lock.release();
  const second = await store.acquire('session-lock');
  await second.release();
});

test('session lock rejects path traversal ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-id-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await assert.rejects(() => store.acquire('../escape'), /invalid session id/);
});

test('closeRuntime releases its lock after the stopped record is committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-close-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const handle = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: 'session-close' });
  const closed = await closeRuntime(handle, 'checkpoint:close');
  assert.equal(closed.state, 'stopped');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  const store = new SessionStore(paths);
  const lock = await store.acquire('session-close');
  await lock.release();
});

test('resumeRuntime reopens an existing non-terminal session without creating a second session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-resume-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const handle = await openRuntime({ controlRoot, workspace, plan: 'default', sessionId: 'session-resume' });
  await handle.lock.release();
  const resumed = await resumeRuntime({ controlRoot, workspace, sessionId: 'session-resume' });
  assert.equal(resumed.session.state, 'ready');
  await resumed.lock.release();
});

test('session open rejects semantically invalid committed history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-corrupt-history-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-corrupt-history', plan: 'default' });
  const path = join(paths.sessionsRoot, 'session-corrupt-history.jsonl');
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...record, state: 'bogus' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-corrupt-history'), /session record is missing required fields/);
});

test('session history must begin with a created record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-first-record-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);

  await store.create({ sessionId: 'session-first-state', plan: 'default' });
  const firstStatePath = join(paths.sessionsRoot, 'session-first-state.jsonl');
  const firstState = JSON.parse(await readFile(firstStatePath, 'utf8')) as Record<string, unknown>;
  await writeFile(firstStatePath, JSON.stringify({ ...firstState, type: 'session.state', state: 'ready' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-first-state'), /must begin with session.created/);

  await store.create({ sessionId: 'session-first-failed', plan: 'default' });
  const firstFailedPath = join(paths.sessionsRoot, 'session-first-failed.jsonl');
  const firstFailed = JSON.parse(await readFile(firstFailedPath, 'utf8')) as Record<string, unknown>;
  await writeFile(firstFailedPath, JSON.stringify({ ...firstFailed, type: 'session.failed', state: 'failed' }) + '\n', 'utf8');
  await assert.rejects(() => store.open('session-first-failed'), /must begin with session.created/);
});

test('session append enforces lifecycle transitions and terminal record types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-transition-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  await store.create({ sessionId: 'session-transition', plan: 'default' });
  await assert.rejects(() => store.append('session-transition', { type: 'session.state', state: 'stopped' }), /terminal state requires/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.state', state: 'running' }), /invalid session transition/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.closed', state: 'ready' }), /must commit stopped/);
  await assert.rejects(() => store.append('session-transition', { type: 'session.closed', state: 'stopped' }), /cannot close session/);
  const ready = await store.append('session-transition', { type: 'session.state', state: 'ready' });
  assert.equal(ready.state, 'ready');
});

test('an old lock handle cannot remove a replacement owner lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-app-lock-owner-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const store = new SessionStore(paths);
  const first = await store.acquire('session-replaced');
  await rm(first.path, { recursive: true, force: true });
  const second = await store.acquire('session-replaced');
  await assert.rejects(() => first.release(), /owned by another runtime/);
  await second.release();
});
