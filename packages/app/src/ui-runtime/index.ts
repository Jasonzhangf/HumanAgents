import { join } from 'node:path';
import type { ProviderTransportSource } from '../../../adapters/provider/src/index.js';
import type {
  Attention,
  AnyProviderExecutionIdentityRef,
  InteractionParentProviderExecutionIdentityRef,
  ProviderExecutionIdentityRef,
  CycleId,
  ExecutionRuntimePort,
  OrganId,
  ProviderBinding,
  ProviderReadiness,
  ScopeRef,
  TaskId,
  TasklessProviderExecutionIdentityRef,
} from '../../../contracts/src/index.js';
import type { AgentProviderComposition } from '../agent-driver-composition.js';
import { closeAgentProvider } from '../agent-driver-composition.js';
import { AGENT_ROLES } from '../../../config/src/index.js';
import { ProviderAgentDriver } from '../../../adapters/provider/src/index.js';
import { providerRawContentReader } from '../../../adapters/provider/src/evidence.js';
import { JsonlInteractionHelperJournal } from '../../../adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../../adapters/jsonl/src/interaction-parent-turn-journal.js';
import type { AgentRole } from '../../../config/src/index.js';
import type { AttentionPort } from '../../../runtime/src/control/attention.js';
import type { RetryCycleConfigSet } from '../../../runtime/src/orchestration/index.js';
import {
  AnthropicProviderCodec,
  OpenAIChatProviderCodec,
  ProviderAdapter,
  ResponsesProviderCodec,
  V3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
} from '../../../adapters/provider/src/index.js';
import { ImmutableAssetStore } from '../../../adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../../adapters/jsonl/src/index.js';
import { listTaskActiveTurnBindings } from '../../../adapters/jsonl/src/active-turn.js';
import { JsonlTaskIdentityJournal } from '../../../adapters/jsonl/src/task-identities.js';
import { JsonlTaskGrantJournal } from '../../../adapters/jsonl/src/task-grants.js';
import { createJsonlI2JournalPort } from '../i2-journal.js';
import { SubscriptionControlPort } from '../../../runtime/src/subscriptions/index.js';
import type { WebSearchBackendConfig } from '../../../config/src/index.js';
import type { ConfiguredProjectCatalog, RuntimePaths } from '../../../config/src/index.js';
import { resetUiDisplayPreference } from '../../../config/src/index.js';
import { FileCheckpointStore, UiRuntimeJournal, uiRuntimeControlJournalPath } from './journal.js';
import { UiRuntimeApiError } from './errors.js';
import { bindUiDisplayPreferenceResource } from './display-preferences.js';
import { createFakeExecutionPort } from '../fake-execution.js';
import {
  UiRuntimeService,
  type PublicOutputCheckpointStore,
  type UiRuntimeMemoryComposition,
  type UiRuntimeServiceOptions,
} from './service.js';
import {
  ServiceExecutionCheckpointStore,
  createDefaultExecutionComposition,
  createServiceExecutionAdmission,
} from './execution-composition.js';
import type {
  PreparedExecutionStop,
  PreparedExecutionStopPreparationLease,
} from './prepared-execution-stop.js';
import { createPreparedOperationBoundary } from '../prepared-operation-boundary.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../runtime-current-state-journal.js';
import { createJsonlRetryCycleJournalPort, retryCycleJournalFilePath } from '../retry-cycle-journal.js';
import type { RuntimeExecutionAllocation } from '../../../runtime/src/ui-runtime/coordinator.js';
import { startUiRuntimeServer, type UiRuntimeServer } from './server.js';
import {
  UiTaskGrantControl,
  TASK_EXECUTION_ACTION_ID,
  TASK_EXECUTION_CAPABILITY,
} from './task-control.js';
import type { DaemonRestartReceipt } from '../supervisor/restart-client.js';
import type { SupervisorLease } from '../supervisor/index.js';
import { OccurrenceConsumerRouter } from './occurrence-router.js';
import type { OccurrenceDispatchPort } from './occurrence-consumer.js';
import { TaskIdentityConsumer } from '../../../runtime/src/orchestration/task-identity.js';
import { UiRuntimeScheduler } from './scheduler.js';
import { AccessControlService } from './access-control.js';
import {
  createProviderExplicitBrainInterpreter,
  type ExplicitBrainAgentTarget,
  type ExplicitBrainInputInterpreter,
} from '../explicit-brain-runtime.js';
import { AppLifecycleError } from '../errors.js';
import {
  createResponsesFileToolExecutor,
  RESPONSES_BASH_TOOL,
  RESPONSES_CREATE_GOAL_TOOL,
  RESPONSES_FILE_EDIT_TOOL,
  RESPONSES_FILE_LIST_TOOL,
  RESPONSES_FILE_READ_TOOL,
  RESPONSES_FILE_SEARCH_TOOL,
  RESPONSES_FILE_WRITE_TOOL,
  RESPONSES_GET_GOAL_TOOL,
  RESPONSES_PRESENT_TOOL,
  RESPONSES_TODO_WRITE_TOOL,
  RESPONSES_UPDATE_GOAL_TOOL,
  RESPONSES_WEB_SEARCH_TOOL,
} from '../provider-tool-execution.js';

export interface RccModeConfig {
  readonly binding: ProviderBinding;
  readonly routeRef: string;
  readonly baseUrl: string;
  readonly maxTokens?: number;
}

export interface UiRuntimeLaunchOptions {
  readonly mode: 'fake' | 'rcc';
  readonly maxConcurrentTasks?: number;
  readonly accessControl?: AccessControlService;
  readonly organId: OrganId;
  readonly binding: ProviderBinding;
  readonly port: ExecutionRuntimePort;
  /** Validated source for this exact binding and port; omission retains legacy RCC. */
  readonly providerSource?: ProviderTransportSource;
  readonly checkpointRoot: string;
  readonly interactionRoot?: string;
  readonly evidenceRoot: string;
  readonly uiRoot: string;
  readonly providerState?: string;
  readonly host?: string;
  readonly portNumber?: number;
  readonly projectKey?: string;
  readonly workspaceRoot?: string;
  /**
   * Canonical Config-owned paths for the serve-bound project. Injected by the
   * entry that owns configuration so the read model never recomputes identity.
   */
  readonly runtimePaths?: RuntimePaths;
  /**
   * Config-owned resolver for every declared project in the current control
   * root. Absent keeps cross-project reads explicitly unavailable.
   */
  readonly projectCatalog?: () => Promise<ConfiguredProjectCatalog>;
  /**
   * Control-plane binding for the external web-search backend. It is injected by
   * the entry that owns configuration, so the runtime assembly never hardcodes a
   * provider route; without it the web.search tool is not wired at all.
   */
  readonly webSearchProviderConfig?: WebSearchBackendConfig;
  readonly providerRetryConfig?: {
    readonly config: RetryCycleConfigSet;
    readonly journalRoot: string;
  };
  readonly explicitBrainAgentQuery?: (input: { readonly agentRef: string; readonly scopeRef: string }) => Promise<unknown>;
  readonly explicitBrainAgentMessage?: (input: {
    readonly recipientRef: string;
    readonly messageRef: string;
    readonly messageClass: 'control' | 'data' | 'observation';
  }) => Promise<unknown>;
  readonly explicitBrainAgentTargets?: readonly ExplicitBrainAgentTarget[];
  readonly explicitBrainInterpreter?: ExplicitBrainInputInterpreter;
  readonly explicitBrainTemplateRoot?: string;
  /**
   * Taskless Provider preparation for the explicit Brain helper. The helper
   * runs outside any Task, so its execution identity is the taskless variant
   * and the serving entry - the owner of configuration - prepares the same
   * composition it already selects for every other role.
   */
  readonly explicitBrainHelperProviderPreparer?: (selection: {
    readonly roleId: AgentRole;
    readonly configuredAgentId?: string;
  }) => Promise<AgentProviderComposition<TasklessProviderExecutionIdentityRef>>;
  /**
   * Override for the Task identity owner. Production always assembles the real
   * `TaskIdentityConsumer` over the runtime control Organ Journal; this option
   * only lets a consumer inject a wrapper that still delegates to that same
   * physical journal, so a fault can be observed at the real adapter boundary.
   */
  readonly taskIdentity?: TaskIdentityConsumer;
  readonly agentRoster?: readonly { readonly agentId: string; readonly roleId: AgentRole }[];
  readonly memory: UiRuntimeMemoryComposition;
  readonly runtimeComposition?: Omit<NonNullable<UiRuntimeServiceOptions['runtimeComposition']>, 'prepareAgentProvider'> & {
    readonly prepareAgentProvider?: <TIdentity extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(selection: {
      readonly roleId: AgentRole;
      readonly configuredAgentId?: string;
    }) => Promise<AgentProviderComposition<TIdentity>>;
    /**
     * Task-scoped Provider preparation that hands the selected composition's
     * custody to the prepared-stop owner under one preparation lease. A native
     * launch requires it so the public stop path owns the real Task custody;
     * the neutral preparer above stays for taskless parent/helper and Planner.
     */
    readonly prepareTaskAgentProvider?: (
      selection: { readonly roleId: AgentRole; readonly configuredAgentId?: string },
      owner: PreparedExecutionStop,
      lease: PreparedExecutionStopPreparationLease,
    ) => Promise<AgentProviderComposition>;
  };
  readonly i2CurrentPosition?: import('./i2-history.js').I2CurrentPositionPort;
  readonly restart?: (input: {
    readonly leaseId: string;
    readonly generation: number;
  }) => DaemonRestartReceipt;
  readonly identity?: () => {
    readonly leaseId: string;
    readonly generation: number;
    readonly pid: number;
    readonly processStartToken: string;
  };
  /**
   * The live supervisor lease that authorizes scheduled occurrence execution.
   * The object form is the direct handoff. The resolver form exists because the
   * `ui-runtime` supervisor stage starts before `runSupervisorStartup` returns,
   * so the production entry can only read the lease lazily - exactly like the
   * existing `identity` option. Nothing resolved means the patrol fails closed
   * with a typed reason; this runtime never fabricates a lease.
   */
  readonly lease?: SupervisorLease | (() => SupervisorLease | undefined);
  /**
   * Patrol interval for persisted execution plans. The default matches the
   * runtime's own due-time grace, so a due slot is claimed before it is late.
   */
  readonly schedulerIntervalMs?: number;
  /**
   * Injectable clock for the patrol. It is the same clock the service uses, so a
   * test can drive due times without wall-clock sleeps.
   */
  readonly now?: () => Date;
}

function providerStateFromReadiness(readiness: ProviderReadiness): string {
  return readiness.state;
}

function providerErrorFromReadiness(readiness: ProviderReadiness): {
  readonly code: string;
  readonly ownerId: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextAction: string;
} | undefined {
  if (readiness.state === 'ready') return undefined;
  const failure = readiness.failure;
  if (failure) {
    return {
      code: failure.code,
      ownerId: failure.ownerId,
      message: failure.message,
      retryable: failure.retryable === 'retryable',
      nextAction: failure.nextAction
        ? `${failure.nextAction.kind}${failure.nextAction.ref ? `:${failure.nextAction.ref}` : ''}`
        : 'inspect provider readiness',
    };
  }
  return {
    code: `provider.readiness.${readiness.state}`,
    ownerId: readiness.ownerId ?? 'humanagent.provider-adapter',
    message: `provider readiness is ${readiness.state}`,
    retryable: readiness.state === 'degraded' || readiness.state === 'unknown',
    nextAction: readiness.nextAction
      ? `${readiness.nextAction.kind}${readiness.nextAction.ref ? `:${readiness.nextAction.ref}` : ''}`
      : 'inspect provider readiness',
  };
}

/**
 * Upper bound on provider tool rounds per execution. A real long-horizon task
 * legitimately inspects, writes and verifies, so the bound must leave room for
 * that while still terminating a runaway round loop.
 */
const PROVIDER_TOOL_ROUND_LIMIT = 32;

/**
 * The declared native Provider tool set. The same definitions drive both the
 * service tool surface and the native execution composition, so the launch
 * never assembles a second, content-identical registry.
 */
const NATIVE_PROVIDER_TOOLS = [
  RESPONSES_FILE_READ_TOOL,
  RESPONSES_FILE_LIST_TOOL,
  RESPONSES_FILE_SEARCH_TOOL,
  RESPONSES_FILE_WRITE_TOOL,
  RESPONSES_FILE_EDIT_TOOL,
  RESPONSES_BASH_TOOL,
  RESPONSES_TODO_WRITE_TOOL,
  RESPONSES_GET_GOAL_TOOL,
  RESPONSES_CREATE_GOAL_TOOL,
  RESPONSES_UPDATE_GOAL_TOOL,
  RESPONSES_PRESENT_TOOL,
  RESPONSES_WEB_SEARCH_TOOL,
] as const;

export function buildRccExecutionPort(config: RccModeConfig, evidenceRoot: string): ExecutionRuntimePort {
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot));
  const transport = new V3ProviderHttpTransport({ binding: config.binding, baseUrl: config.baseUrl, evidence });
  const codec = config.binding.protocol === 'anthropic'
    ? new AnthropicProviderCodec(config.maxTokens ?? 4096)
    : config.binding.protocol === 'openai'
      ? new OpenAIChatProviderCodec()
      : new ResponsesProviderCodec();
  return new ProviderAdapter({ binding: config.binding, routeRef: config.routeRef, codec, transport, evidence });
}

export function buildFakeExecutionPort(binding: ProviderBinding, stepDelayMs?: number): ExecutionRuntimePort {
  return createFakeExecutionPort(binding, stepDelayMs);
}

class InMemoryAttentionPort implements AttentionPort {
  readonly published: Attention[] = [];
  readonly resolved: Attention[] = [];

  async publish(input: Attention): Promise<{ readonly attentionId: string; readonly delivered: true }> {
    this.published.push(structuredClone(input));
    return { attentionId: input.attentionId, delivered: true };
  }

  async resolve(input: Attention): Promise<{ readonly attentionId: string; readonly delivered: true }> {
    this.resolved.push(structuredClone(input));
    return { attentionId: input.attentionId, delivered: true };
  }
}

export interface UiRuntime {
  readonly service: UiRuntimeService;
  readonly server: UiRuntimeServer;
  /**
   * The due-time patrol. It is absent when the runtime was started without a
   * supervisor lease; in that case no execution plan may run.
   */
  readonly scheduler?: UiRuntimeScheduler;
  close(): Promise<void>;
}

export async function startUiRuntime(options: UiRuntimeLaunchOptions): Promise<UiRuntime> {
  if (!options.accessControl) {
    throw new AppLifecycleError(
      'ui-runtime.access-control.missing',
      'UI runtime startup requires an access-control service',
      'initialize web access control before starting the UI runtime',
      'humanagent.app.ui-runtime',
    );
  }
  const readiness = options.mode === 'rcc' ? await options.port.probe(options.binding) : undefined;
  const providerState = readiness ? providerStateFromReadiness(readiness) : options.providerState ?? 'ready';
  const providerError = readiness ? providerErrorFromReadiness(readiness) : undefined;
  const attentionPort = new InMemoryAttentionPort();
  const modeRoot = join(options.checkpointRoot, options.mode);
  const canonicalJournalPath = uiRuntimeControlJournalPath(modeRoot);
  const taskControlJournalPath = uiRuntimeControlJournalPath(modeRoot);
  const taskControlJournal = new JsonlOrganJournal(taskControlJournalPath);
  const canonicalCheckpoints = new FileCheckpointStore(canonicalJournalPath);
  const canonicalCurrentState = createJsonlRuntimeTaskCurrentStateJournal({
    journal: taskControlJournal,
  });
  const hydrateReadFor: NonNullable<NonNullable<UiRuntimeServiceOptions['runtimeComposition']>['hydrateReadFor']> =
    options.runtimeComposition?.hydrateReadFor ?? (async () => ({
        checkpoint: {
          verify: (requestedScope) => canonicalCheckpoints.verify(requestedScope),
          readLatest: (requestedScope) => canonicalCheckpoints.readLatest(requestedScope),
          readCommitted: (requestedScope, checkpointId) => canonicalCheckpoints.readCommitted(requestedScope, checkpointId),
          readExecutionPosition: (requestedScope) => canonicalCheckpoints.readExecutionPosition(requestedScope),
          readNativeCheckpoint: (requested) => canonicalCheckpoints.readNativeCheckpoint(requested),
        },
        currentState: { read: (requestedScope) => canonicalCurrentState.read(requestedScope) },
        hasCommittedActiveTurn: async (selector) => {
          const bindings = await listTaskActiveTurnBindings({
            journal: taskControlJournal,
            scope: { organId: options.organId, taskId: selector.taskId },
          });
          return bindings.some((entry) => entry.binding.scope.operationId?.value === selector.operationId.value
            && entry.binding.execution.executionEpoch === selector.executionEpoch);
        },
      }));
  const journal = new UiRuntimeJournal(join(modeRoot, 'ui-runtime-journal.jsonl'));
  const subscriptionJournalPath = join(modeRoot, 'subscriptions.jsonl');
  const clock = options.now;
  const resolveLease: () => SupervisorLease | undefined = typeof options.lease === 'function'
    ? options.lease
    : options.lease === undefined
      ? () => undefined
      : () => options.lease as SupervisorLease;
  let service: UiRuntimeService | undefined;
  // The occurrence consumer is constructed with the port, but its dispatch port
  // can only be the service, which is constructed with the port. The indirection
  // is resolved before any dispatch can run: the scheduler starts after the
  // service exists and the port only dispatches through a claimed occurrence.
  const occurrenceDispatch: OccurrenceDispatchPort = {
    async dispatch(input) {
      if (service === undefined) {
        throw new AppLifecycleError(
          'ui-runtime.scheduler.not-ready',
          'scheduled occurrence dispatch ran before the UI runtime service was constructed',
          'restart the runtime through the supervisor-owned serve entry',
          'humanagent.app.ui-runtime',
        );
      }
      return service.executeScheduledOccurrence(input);
    },
  };
  const occurrenceRouter = new OccurrenceConsumerRouter({
    organId: options.organId,
    root: join(modeRoot, 'occurrence-consumer'),
    lease: resolveLease,
    dispatch: occurrenceDispatch,
    ...(clock === undefined ? {} : { now: () => clock().toISOString() }),
  });
  const subscriptionControl = new SubscriptionControlPort(
    new JsonlOrganJournal(subscriptionJournalPath),
    { organId: options.organId },
    subscriptionJournalPath,
    occurrenceRouter,
  );
  const interactionJournal = options.interactionRoot
    ? new UiRuntimeJournal(join(options.interactionRoot, 'sessions', 'explicit-brain.jsonl'))
    : undefined;
  // I2 product history is committed through the same task-control Organ Journal the runtime already
  // owns, so the read layer reuses that authority instead of introducing a second store.
  const explicitBrainInterpreter = options.explicitBrainInterpreter ?? (() => {
    const templateRoot = options.explicitBrainTemplateRoot?.trim();
    if (!templateRoot) {
      throw new AppLifecycleError('explicit-brain-prompt-unavailable', 'builtin interaction prompt root is not configured',
        'configure the locked builtin template root before starting the UI runtime', 'humanagent.app.ui-runtime');
    }
    const rawEvidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(options.evidenceRoot));
    const helperJournal = new JsonlInteractionHelperJournal(taskControlJournal);
    return createProviderExplicitBrainInterpreter({
      lease: resolveLease,
      binding: options.binding, templateRoot, organId: options.organId,
      interactionScopeId: `runtime:${options.projectKey ?? options.organId.value}`,
      parentJournal: new JsonlInteractionParentTurnJournal(taskControlJournal),
      helperJournal,
      turnHelperJournal: helperJournal,
      checkpointJournal: helperJournal,
      rawEvidence, rawContent: providerRawContentReader(rawEvidence),
      clock: { now: () => (clock?.() ?? new Date()).toISOString() },
      prepareAgentProvider: async (selection) => {
        const prepare = options.runtimeComposition?.prepareAgentProvider;
        if (!prepare) throw new AppLifecycleError('explicit-brain-provider-unavailable', 'neutral interaction parent provider preparation is not configured',
          'inject the configured provider preparer', 'humanagent.app.ui-runtime');
        return prepare<InteractionParentProviderExecutionIdentityRef>(selection);
      },
      helperFactory: async ({ selection, assignment, execution }) => {
        const roleId = AGENT_ROLES.find((role) => role === selection.roleId);
        if (!roleId || !options.explicitBrainHelperProviderPreparer) {
          throw new AppLifecycleError('explicit-brain-helper-unavailable', 'selected helper role or provider preparation is unavailable',
            'select a configured helper role', 'humanagent.app.ui-runtime');
        }
        const owned = await options.explicitBrainHelperProviderPreparer({ ...selection, roleId });
        return {
          binding: owned.binding,
          driver: new ProviderAgentDriver<TasklessProviderExecutionIdentityRef>({
            port: owned.port, binding: owned.binding, ...execution, organId: assignment.organId,
            helper: assignment, assignmentId: assignment.assignmentId,
            scope: { organId: assignment.organId, operationId: execution.operationId },
            inputRefs: [], ownerId: 'humanagent.runtime.explicit-brain.helper',
          }),
          close: () => closeAgentProvider(owned),
        };
      },
    });
  })();
  // The Task identity owner commits onto that same control Organ Journal the
  // runtime already owns, so a producer and a cold reader resolve one authority
  // instead of a second identity store.
  const taskIdentity = options.taskIdentity
    ?? new TaskIdentityConsumer(new JsonlTaskIdentityJournal(taskControlJournal));
  // The real native checkpoint owner commits onto the control Organ Journal this
  // runtime already owns. Public output and checkpoints share that same physical
  // store, so the producer and the reader resolve one authority, not two files.
  const checkpointStoreFor = (_taskId: TaskId, _cycleId: CycleId): PublicOutputCheckpointStore =>
    new ServiceExecutionCheckpointStore(taskControlJournalPath, taskControlJournal, clock ?? (() => new Date()));
  const i2Journal = createJsonlI2JournalPort({ filePath: taskControlJournalPath, journal: taskControlJournal });
  const providerToolExecutor = options.mode === 'rcc'
    && options.binding.protocol === 'responses'
    && options.workspaceRoot !== undefined
    && options.projectKey !== undefined
    ? (() => {
        const built = createResponsesFileToolExecutor({
          workspaceRoot: options.workspaceRoot,
          projectKey: options.projectKey,
          artifactRoot: join(options.evidenceRoot, 'provider-tools'),
          ...(options.webSearchProviderConfig === undefined ? {} : { webSearchProviderConfig: options.webSearchProviderConfig }),
        });
        return { executor: built.executor, toolOutputs: built.toolOutputs };
      })()
    : undefined;
  const runtimeIdentity = options.accessControl.readRuntimeProductIdentity();
  const principalOwner = runtimeIdentity.owner;
  const resourceBoundary = createPreparedOperationBoundary(journal);
  const currentState = createJsonlRuntimeTaskCurrentStateJournal({ journal: taskControlJournal });
  const executionNow = clock ?? (() => new Date());
  // The native launch assembly binds the same physical owners the service and
  // the HTTP read already use: the control Organ Journal, the prepared
  // UI-runtime journal, and the canonical checkpoint store. It is built once,
  // before the coordinator; its callbacks only delegate to that coordinator.
  const nativeToolScope = options.workspaceRoot === undefined || options.projectKey === undefined
    ? undefined
    : {
        workspaceRoot: options.workspaceRoot,
        projectKey: options.projectKey,
        artifactRoot: join(options.evidenceRoot, 'provider-tools'),
        tools: NATIVE_PROVIDER_TOOLS,
        ...(options.webSearchProviderConfig === undefined ? {} : { webSearchProviderConfig: options.webSearchProviderConfig }),
      };
  const fakeAdmission = options.mode === 'fake'
    ? createServiceExecutionAdmission({
        journal: taskControlJournal,
        preparedJournal: journal,
        principalOwner,
        resourceBoundary,
        now: executionNow,
      })
    : undefined;
  const prepareAgentProvider = options.runtimeComposition?.prepareAgentProvider;
  const prepareTaskAgentProvider = options.runtimeComposition?.prepareTaskAgentProvider;
  // Fake mode keeps its fixture driver and still uses the real admission path.
  // Every non-fake launch is configured native and requires the actual preparer.
  const configuredNativeLaunch = options.mode !== 'fake';
  if (configuredNativeLaunch && prepareAgentProvider === undefined) {
    throw new AppLifecycleError(
      'ui-runtime.native-preparer-missing',
      'the configured rcc launch requires the actual native Provider preparer',
      'assemble the configured Provider preparation before starting the UI runtime',
      'humanagent.app.ui-runtime',
    );
  }
  // The neutral preparer alone leaves the fresh Task custody gap open. A native
  // launch without the Task-scoped custody preparer cannot bind the public stop
  // owner, so it fails explicitly instead of silently keeping the gap.
  if (configuredNativeLaunch && prepareTaskAgentProvider === undefined) {
    throw new AppLifecycleError(
      'ui-runtime.task-preparer-missing',
      'the configured rcc launch requires the Task-scoped Provider preparer that transfers preparation custody to the stop owner',
      'inject the prepared-stop custody preparer before starting the UI runtime',
      'humanagent.app.ui-runtime',
    );
  }
  const launchComposition: UiRuntimeServiceOptions['runtimeComposition'] = {
    ...(options.runtimeComposition?.createTaskAssembly === undefined ? {} : {
      createTaskAssembly: options.runtimeComposition.createTaskAssembly,
    }),
    ...(configuredNativeLaunch ? {
      createExecutionPorts: (coordinator) => {
        const composition = createDefaultExecutionComposition({
          principalOwner,
          journal: taskControlJournal,
          filePath: taskControlJournalPath,
          artifactsRoot: options.evidenceRoot,
          preparedJournal: journal,
          resourceBoundary,
          prepareAgentProvider: prepareAgentProvider!,
          ...(options.agentRoster === undefined ? {} : { agentRoster: options.agentRoster }),
          prepareTaskAgentProvider: prepareTaskAgentProvider!,
          providerOptions: {
            onRequestLifecycle: (event) => coordinator.recordProviderRequestIdentity(event),
          },
          ...(nativeToolScope === undefined ? {} : { providerToolScope: nativeToolScope }),
          now: executionNow,
          currentState,
          publishCurrentTurnState: (taskId) => coordinator.publishCurrentTurnState(taskId),
          closedTurnPlannerPool: (taskId) => coordinator.closedTurnPlannerPool(taskId),
          taskIdentity,
          i2Journal,
          ...(options.runtimePaths === undefined ? {} : {
            retryJournal: createJsonlRetryCycleJournalPort({
              filePath: retryCycleJournalFilePath({ journalRoot: join(options.runtimePaths.journalRoot, 'ui-runtime') }),
            }),
          }),
        });
        return {
          admitExecution: composition.admitExecution,
          createDriver: composition.createExecutionDriver,
          preparedExecutionStop: composition.preparedExecutionStop,
          inspectionStop: composition.inspectionStop,
          coldExecution: {
            readColdExecutionSource: composition.readColdExecutionSource,
            admitSegment: composition.admitSegment,
            readIncarnationBinding: composition.readIncarnationBinding,
            recoverOriginalTurn: composition.recoverOriginalTurn,
            createResumedExecutionDriver: composition.createResumedExecutionDriver,
          },
          currentStatePort: currentState,
          currentStateFacts: composition.currentStateFacts,
          resolveColdExecutionResumeRequest: composition.resolveColdExecutionResumeRequest,
          executeConfirmedTaskContextCorrection: composition.executeConfirmedTaskContextCorrection,
          executeConfirmedTaskCheckpointReentry: composition.executeConfirmedTaskCheckpointReentry,
        };
      },
    } : fakeAdmission === undefined ? {} : {
      admitExecution: async (allocation: RuntimeExecutionAllocation) => {
        await fakeAdmission.admitExecution(allocation);
      },
    }),
  };
  const runtimeService = new UiRuntimeService({
    mode: options.mode,
    maxConcurrentTasks: options.maxConcurrentTasks,
    organId: options.organId,
    binding: options.binding,
    port: options.port,
    checkpointStoreFor,
    i2History: {
      journal: i2Journal,
      ...(options.i2CurrentPosition === undefined ? {} : { currentPosition: options.i2CurrentPosition }),
    },
    attentionPort,
    providerState,
    providerError,
    ...(readiness === undefined ? {} : { providerReadiness: readiness }),
    // A configured native launch binds the real task-scoped grant journal, so
    // confirmation only confirms intent and execution waits for a real grant.
    ...(configuredNativeLaunch ? { taskGrantPort: new JsonlTaskGrantJournal(taskControlJournal) } : {}),
    ...(options.providerSource === undefined ? {} : { providerSource: options.providerSource }),
    journal,
    closurePort: interactionJournal ?? journal,
    ...(options.projectKey ? { projectKey: options.projectKey } : {}),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.providerRetryConfig === undefined ? {} : { providerRetryConfig: options.providerRetryConfig }),
    ...(providerToolExecutor === undefined ? {} : {
      providerTools: [...NATIVE_PROVIDER_TOOLS],
      providerToolExecutor: providerToolExecutor.executor,
      toolOutputStore: providerToolExecutor.toolOutputs,
      providerToolRoundLimit: PROVIDER_TOOL_ROUND_LIMIT,
    }),
    ...(options.explicitBrainAgentQuery === undefined ? {} : { explicitBrainAgentQuery: options.explicitBrainAgentQuery }),
    ...(options.explicitBrainAgentMessage === undefined ? {} : { explicitBrainAgentMessage: options.explicitBrainAgentMessage }),
    ...(options.explicitBrainAgentTargets === undefined ? {} : { explicitBrainAgentTargets: options.explicitBrainAgentTargets }),
    explicitBrainInterpreter,
    ...(interactionJournal === undefined ? {} : { interactionJournal }),
    memory: options.memory,
    ...(options.runtimePaths === undefined ? {} : { runtimePaths: options.runtimePaths }),
    ...(options.projectCatalog === undefined ? {} : { projectCatalog: options.projectCatalog }),
    subscriptionControl,
    taskIdentity,
    runtimeComposition: { ...launchComposition, hydrateReadFor },
    ...(clock === undefined ? {} : { now: clock }),
  });
  service = runtimeService;
  await runtimeService.hydrate();
  if (options.memory.reconcileTaskScope !== undefined) {
    for (const identity of await new JsonlTaskIdentityJournal(taskControlJournal).replay()) {
      await options.memory.reconcileTaskScope({ taskScope: identity.scope });
    }
  }
  runtimeService.startImplicitConsumer();
  // The patrol is only armed when a supervisor lease is configured. Without the
  // option the runtime must not run scheduled plans at all, and the status
  // surface reports that typed reason instead of pretending to be idle.
  const scheduler = options.lease === undefined
    ? undefined
    : new UiRuntimeScheduler({
        port: subscriptionControl,
        lease: resolveLease,
        runningTaskCount: () => runtimeService.listTasks().running.length,
        ...(clock === undefined ? {} : { now: clock }),
        ...(options.schedulerIntervalMs === undefined ? {} : { intervalMs: options.schedulerIntervalMs }),
      });
  scheduler?.start();
  // One Config-backed display-preference resource per server assembly. It is
  // only bound when the entry assembled the canonical Config paths; without
  // them the route reports a typed unavailable instead of a default success.
  const displayPreference = options.runtimePaths === undefined
    ? undefined
    : bindUiDisplayPreferenceResource(options.runtimePaths, resetUiDisplayPreference);
  // Task-scoped grant control is the single execution authority for a real
  // Task. It reuses the same control Organ Journal, declared capability, clock
  // and standard stop path the rest of this assembly already owns; the server
  // supplies the verified product principal on every HTTP control request.
  const taskControl = new UiTaskGrantControl({
    journal: taskControlJournal,
    organId: options.organId,
    capability: { actionId: TASK_EXECUTION_ACTION_ID, capabilities: [TASK_EXECUTION_CAPABILITY] },
    now: executionNow,
    taskScope: (taskId) => {
      // The service is the existence authority: an unknown task throws here
      // before any grant fact is written.
      const detail = runtimeService.taskDetail(taskId);
      return { organId: options.organId, taskId: detail.taskId };
    },
    stopTask: (taskId) => runtimeService.stop(taskId),
  });
  const server = await startUiRuntimeServer({
    service: runtimeService,
    accessControl: options.accessControl,
    uiRoot: options.uiRoot,
    host: options.host,
    port: options.portNumber,
    taskControl,
    ...(displayPreference === undefined ? {} : { displayPreference }),
    ...(options.restart === undefined ? {} : { restart: options.restart }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    schedulerStatus: async () => scheduler === undefined
      ? {
          state: 'blocked',
          reason: {
            code: 'scheduler.lease.unavailable',
            ownerId: 'humanagent.app.scheduled-occurrence-patrol',
            message: 'the runtime was started without a supervisor lease, so no execution plan may be patrolled',
            nextAction: 'start the runtime through the supervisor-owned serve entry',
          },
        }
      : scheduler.status(),
  });
  return {
    service: runtimeService,
    server,
    ...(scheduler === undefined ? {} : { scheduler }),
    async close() {
      await scheduler?.stop();
      await runtimeService.quiesceImplicitConsumption();
      let serverCloseFailure: unknown;
      try {
        await server.close();
      } catch (error) {
        serverCloseFailure = error;
      }
      // The task list reports a settling execution as active until its terminal
      // checkpoint is committed, but `stop` may only be requested while the
      // execution still offers it. Selecting the stop targets from that
      // eligibility keeps shutdown from asking an already settled execution to
      // stop and reporting it as running.
      const stopEligible = (taskId: TaskId): boolean =>
        runtimeService.taskDashboard(taskId).allowedActions.includes('stop');
      const active = runtimeService.listTasks().running.filter(
        (task) => task.requirementAdmission !== 'queued' && stopEligible(task.taskId),
      );
      const stopped = await Promise.allSettled(
        active.map(async (task) => {
          try {
            await runtimeService.stop(task.taskId);
          } catch (error) {
            // A task can settle between the running snapshot and stop admission.
            // Its execution then owns the terminal checkpoint and no longer
            // offers a stop, so this is a completed stop, not a shutdown
            // failure; all other stop errors remain explicit.
            if (error instanceof UiRuntimeApiError && error.code === 'task.not.running' && !stopEligible(task.taskId)) return;
            throw error;
          }
        }),
      );
      const failures: unknown[] = [];
      if (serverCloseFailure !== undefined) failures.push(serverCloseFailure);
      for (const result of stopped) {
        if (result.status === 'rejected') failures.push(result.reason);
      }

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'UI runtime close failed while settling active executions');
      }
    },
  };
}

export { UiRuntimeApiError } from './errors.js';
export { MemoryBoundExecutionDriver, MemoryContextCapture, UiRuntimeService } from './service.js';
export type { TaskCheckpointStore, UiRuntimeMemoryComposition } from './service.js';
export type { ServiceCheckpointReentryRequest, ServiceContextCorrectionRequest } from './execution-composition.js';
export { FileCheckpointStore, UiRuntimeJournal, uiRuntimeControlJournalPath } from './journal.js';
export { FakeReplayExecutionRuntimePort } from './fake-port.js';
export { UiRuntimeScheduler } from './scheduler.js';
export type {
  UiRuntimeSchedulerIssue,
  UiRuntimeSchedulerOptions,
  UiRuntimeSchedulerPlanProjection,
  UiRuntimeSchedulerStatusProjection,
} from './scheduler.js';
export { OccurrenceConsumerRouter } from './occurrence-router.js';
export type { UiRuntimeServer } from './server.js';
