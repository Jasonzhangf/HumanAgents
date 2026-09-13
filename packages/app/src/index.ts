import { ensureControlLayout, loadConfiguration, resolveRuntimePaths, type LoadedConfiguration, type RuntimePaths } from '../../config/src/index.js';
import { AppLifecycleError } from './errors.js';
import { SessionStore, type SessionLock, type SessionSnapshot } from './session-store.js';

export interface RuntimeHandle {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly session: SessionSnapshot;
  readonly lock: SessionLock;
}

export async function openRuntime(input: { readonly workspace: string; readonly controlRoot?: string; readonly plan: string; readonly sessionId: string }): Promise<RuntimeHandle> {
  const paths = await resolveRuntimePaths({ workspace: input.workspace, controlRoot: input.controlRoot });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  if (!configuration.agentRoster.length) throw new AppLifecycleError('agent-roster-empty', 'no agent is configured', 'add at least one agent to config.toml', 'config-loader');
  const store = new SessionStore(paths);
  const lock = await store.acquire(input.sessionId);
  try {
    const created = await store.create({ sessionId: input.sessionId, plan: input.plan }, lock);
    const ready = await store.append(input.sessionId, { type: 'session.state', state: 'ready' }, lock);
    return { paths, configuration, lock, session: ready.records.length > created.records.length ? ready : created };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export async function resumeRuntime(input: { readonly workspace: string; readonly controlRoot?: string; readonly sessionId: string }): Promise<RuntimeHandle> {
  const paths = await resolveRuntimePaths({ workspace: input.workspace, controlRoot: input.controlRoot });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  if (!configuration.agentRoster.length) throw new AppLifecycleError('agent-roster-empty', 'no agent is configured', 'add at least one agent to config.toml', 'config-loader');
  const store = new SessionStore(paths);
  const lock = await store.acquire(input.sessionId);
  try {
    const session = await store.open(input.sessionId);
    if (session.state === 'stopped' || session.state === 'failed') {
      throw new AppLifecycleError('session-terminal', 'cannot resume a terminal session', 'start a new session or resume from its checkpoint', 'session-store');
    }
    return { paths, configuration, lock, session };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export async function closeRuntime(handle: RuntimeHandle, checkpointRef?: string): Promise<SessionSnapshot> {
  try {
    const closed = await new SessionStore(handle.paths).close(handle.session.sessionId, checkpointRef, handle.lock);
    await handle.lock.release();
    return closed;
  } catch (error) {
    try { await handle.lock.release(); } catch { /* preserve the lifecycle failure */ }
    throw error;
  }
}

export { AppLifecycleError } from './errors.js';
export { SessionStore } from './session-store.js';
export type { SessionLock, SessionRecord, SessionSnapshot, SessionState } from './session-store.js';
