import { ensureControlLayout, loadConfiguration, resolveRuntimePaths, type LoadedConfiguration, type RuntimePaths } from '../../config/src/index.js';
import { AppLifecycleError } from './errors.js';
import { bindExecutionRuntime, type RuntimeExecutionBinding } from './execution.js';
import { SessionStore, type SessionLock, type SessionSnapshot } from './session-store.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configureBuiltinPromptRoot(): void {
  if (process.env.HUMANAGENT_TEMPLATE_ROOT) return;
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleRoot, '../../agent-templates/templates'),
    join(moduleRoot, '../../../../../packages/agent-templates/templates'),
  ];
  const templateRoot = candidates.find((candidate) => existsSync(join(candidate, 'builtin', 'prompt-registry.json')));
  if (templateRoot) process.env.HUMANAGENT_TEMPLATE_ROOT = templateRoot;
}

configureBuiltinPromptRoot();

export interface RuntimeHandle {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly session: SessionSnapshot;
  readonly lock: SessionLock;
  readonly execution?: RuntimeExecutionBinding;
}

export async function openRuntime(input: { readonly workspace: string; readonly controlRoot?: string; readonly plan: string; readonly sessionId: string; readonly execution?: RuntimeExecutionBinding }): Promise<RuntimeHandle> {
  configureBuiltinPromptRoot();
  const paths = await resolveRuntimePaths({ workspace: input.workspace, controlRoot: input.controlRoot });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  if (!configuration.agentRoster.length) throw new AppLifecycleError('agent-roster-empty', 'no agent is configured', 'add at least one agent to config.toml', 'config-loader');
  const execution = input.execution ? bindExecutionRuntime(input.execution) : undefined;
  const store = new SessionStore(paths);
  const lock = await store.acquire(input.sessionId);
  try {
    const created = await store.create({ sessionId: input.sessionId, plan: input.plan }, lock);
    const ready = await store.append(input.sessionId, { type: 'session.state', state: 'ready' }, lock);
    return { paths, configuration, lock, session: ready.records.length > created.records.length ? ready : created, execution };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

export async function resumeRuntime(input: { readonly workspace: string; readonly controlRoot?: string; readonly sessionId: string; readonly execution?: RuntimeExecutionBinding }): Promise<RuntimeHandle> {
  configureBuiltinPromptRoot();
  const paths = await resolveRuntimePaths({ workspace: input.workspace, controlRoot: input.controlRoot });
  await ensureControlLayout(paths);
  const configuration = await loadConfiguration(paths);
  if (!configuration.agentRoster.length) throw new AppLifecycleError('agent-roster-empty', 'no agent is configured', 'add at least one agent to config.toml', 'config-loader');
  const execution = input.execution ? bindExecutionRuntime(input.execution) : undefined;
  const store = new SessionStore(paths);
  const lock = await store.acquire(input.sessionId);
  try {
    const session = await store.open(input.sessionId);
    if (session.state === 'stopped' || session.state === 'failed') {
      throw new AppLifecycleError('session-terminal', 'cannot resume a terminal session', 'start a new session or resume from its checkpoint', 'session-store');
    }
    return { paths, configuration, lock, session, execution };
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

export async function settleSessionOutcome(
  handle: RuntimeHandle,
  outcome: 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'cancelled' | 'stopped' | 'unknown',
  checkpointRef: string,
): Promise<SessionSnapshot['state'] | 'recoverable'> {
  if (outcome === 'failed' || outcome === 'unknown') {
    const failed = await new SessionStore(handle.paths).append(handle.session.sessionId, {
      type: 'session.failed',
      state: 'failed',
      checkpointRef,
      errorCode: outcome === 'failed' ? 'agent-operation-failed' : 'agent-operation-unknown',
      nextAction: 'resume from the failed checkpoint or start a new operation',
    }, handle.lock);
    await handle.lock.release();
    return failed.state;
  }
  if (outcome === 'succeeded' || outcome === 'cancelled' || outcome === 'stopped') {
    return (await closeRuntime(handle, checkpointRef)).state;
  }
  await handle.lock.release();
  return 'recoverable';
}

export { AppLifecycleError } from './errors.js';
export { bindExecutionRuntime, probeExecutionRuntime } from './execution.js';
export type { RuntimeExecutionBinding } from './execution.js';
export { executeAgentOperation, openAgentExecution } from './agent-execution.js';
export type { AgentExecutionReceipt, AgentExecutionRequest, AgentExecutionSession } from './agent-execution.js';
export {
  assertDshSourceMatchesLock,
  composeAgentDriver,
  ensureDshSettings,
  resolveDshHome,
  verifyDshPatches,
} from './agent-driver-composition.js';
export type { ComposedAgentDriver, DshCompositionInput } from './agent-driver-composition.js';
export { openAgentOperation, prepareAgentOperation, AgentOperationController } from './agent-operation.js';
export type { AgentOperationSnapshot, OpenAgentOperationInput } from './agent-operation.js';
export { createJsonlCheckpointJournal } from './checkpoint-journal.js';
export { createM3Assembly } from './m3-assembly.js';
export type { M3Assembly, M3AssemblyOptions } from './m3-assembly.js';
export { checkpointIdFor, resumeAgentOperation, runAgentOperation } from './run-operation.js';
export type {
  ResumeAgentOperationInput,
  ResumeAgentOperationResult,
  RunAgentOperationInput,
  RunAgentOperationResult,
} from './run-operation.js';
export { readRunManifest, writeRunManifest } from './run-manifest.js';
export type { RunManifest } from './run-manifest.js';
export {
  composeMemory,
  composeRuntimeMemory,
  createProjectSourceUpdateOwner,
} from './memory-composition.js';
export type {
  MemoryComposition,
  MemoryCompositionInput,
  MemoryEvidenceSnapshot,
  MemoryEvidenceSourcePort,
  MemoryProjectPatchReader,
  RuntimeMemoryCompositionInput,
} from './memory-composition.js';
export { SessionStore } from './session-store.js';
export type { SessionLock, SessionRecord, SessionSnapshot, SessionState } from './session-store.js';

export {
  CordisHost,
  CordisHostError,
  FIXED_HARNESS_KERNEL_PLUGIN_ID,
  HarnessPluginRegistry,
  assertHarnessPluginManifest,
  assertPluginManifestMatches,
  createCordisHost,
  fixedHarnessKernelPlugin,
  loadCordisHost,
  readCordisHostManifest,
} from './cordis-host.js';
export type {
  CordisExtensionPlugin,
  CordisHostManifest,
  CordisHostPhase,
  CordisHostSnapshot,
  CordisHostState,
  CordisReadinessReport,
} from './cordis-host.js';

export {
  buildFakeExecutionPort,
  buildRccExecutionPort,
  startUiRuntime,
  UiRuntimeApiError,
  UiRuntimeService,
} from './ui-runtime/index.js';
export type { UiRuntimeMemoryComposition } from './ui-runtime/index.js';
export type { RccModeConfig, UiRuntime, UiRuntimeLaunchOptions } from './ui-runtime/index.js';
