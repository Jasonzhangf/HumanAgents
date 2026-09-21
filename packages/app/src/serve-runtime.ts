import { id, type Task } from '../../contracts/src/index.js';
import type {
  AgentIoClock,
  AgentIoRequestControl,
  AgentIoRequestData,
  AgentIoRestartBudgetStore,
} from '../../runtime/src/agent-io/types.js';
import {
  AgentIoRequestCoordinator,
  createMemoryRestartBudgetStore,
} from '../../runtime/src/agent-io/index.js';
import type { AgentIoEvent } from '../../runtime/src/agent-io/events.js';
import type {
  EventBusPorts,
  EventPublisherRegistryPort,
  TrustedEventPublisher,
} from '../../runtime/src/events/index.js';
import { HarnessNodeRuntime } from '../../runtime/src/nodes/node-runtime.js';
import { createDefaultNodeStrategyRegistry } from '../../runtime/src/nodes/node-strategies.js';
import {
  AgentRuntimePoolManager,
  type ExecutionAgentPort,
  type MergeCoordinatorPort,
  type OrchestrationRuntimeFactoryPort,
  type ReviewAgentPort,
} from '../../runtime/src/orchestration/index.js';
import type {
  CheckpointJournalPort,
  FeedbackHubPorts,
} from '../../runtime/src/index.js';
import { createM3Assembly, type M3Assembly } from './m3-assembly.js';
import { AppLifecycleError } from './errors.js';

const OWNER = 'humanagent.app.serve-runtime';

const unboundExecutionAgent: ExecutionAgentPort = {
  async execute(): Promise<never> {
    throw new AppLifecycleError(
      'serve.m3.execution-agent.missing',
      'M3 orchestration has no execution agent bound for this task assembly',
      'bind an execution agent before dispatching an orchestration assignment',
      OWNER,
    );
  },
};

export interface ServeAgentIoOwner {
  readonly ownerId: 'humanagent.runtime.agent-io';
  readonly budgetStore: AgentIoRestartBudgetStore;
  createRequest(input: {
    readonly control: AgentIoRequestControl;
    readonly lockedBinding: AgentIoRequestControl['binding'];
    readonly data: AgentIoRequestData;
    readonly clock: AgentIoClock;
    readonly onEvent: (event: AgentIoEvent) => void | Promise<void>;
  }): Promise<AgentIoRequestCoordinator>;
}

export interface ServeEventBusOwner {
  readonly ownerId: 'humanagent.runtime.events';
  readonly ports: EventBusPorts;
  readonly publishers: EventPublisherRegistryPort;
}

export interface ServeRuntimeComposition {
  readonly ownerId: typeof OWNER;
  readonly nodeRuntime: HarnessNodeRuntime;
  readonly agentIo: ServeAgentIoOwner;
  readonly eventBus: ServeEventBusOwner;
  readonly runtimePool: AgentRuntimePoolManager;
  createTaskAssembly(input: {
    readonly task: Task;
    readonly scope: Parameters<typeof createM3Assembly>[0]['scope'];
    readonly checkpointJournal: CheckpointJournalPort;
    readonly executionAgent?: ExecutionAgentPort;
    readonly maxAttempts?: number;
  }): M3Assembly;
  dispose(): Promise<void>;
}

export interface ServeRuntimeCompositionInput {
  readonly eventBusPorts: EventBusPorts;
  readonly feedbackPorts: FeedbackHubPorts;
  readonly feedbackPublisherId: string;
  readonly executionAgent?: ExecutionAgentPort;
  readonly reviewAgent?: ReviewAgentPort;
  readonly mergeCoordinator?: MergeCoordinatorPort;
  readonly maxRuntimes?: number;
  readonly now?: () => Date;
}

function runtimeFactory(nodeRuntime: HarnessNodeRuntime): OrchestrationRuntimeFactoryPort {
  return {
    async start(request) {
      if (nodeRuntime.strategies.refs().length === 0) {
        throw new AppLifecycleError(
          'serve.node-runtime.strategies-missing',
          'serve node runtime has no orchestration strategies',
          'compose the default node strategy registry before starting M3',
          OWNER,
        );
      }
      return {
        runtimeId: request.runtimeId,
        generation: request.generation,
        capabilities: [...request.requiredCapabilities],
      };
    },
    async dispose() {},
  };
}

function assertEventBusPorts(ports: EventBusPorts): void {
  if (
    ports.journal === undefined
    || ports.publishers === undefined
    || ports.consumers === undefined
    || ports.externalOperations === undefined
    || ports.barrierIntents === undefined
  ) {
    throw new AppLifecycleError(
      'serve.event-bus.ports-missing',
      'serve EventBus composition requires journal, publisher, consumer, external-operation, and barrier-intent owners',
      'compose the durable EventBus ports before starting serve',
      OWNER,
    );
  }
}

function feedbackPublisher(input: ServeRuntimeCompositionInput): EventPublisherRegistryPort {
  const publisher: TrustedEventPublisher = {
    publisherId: input.feedbackPublisherId,
    kind: 'harness',
    ownerId: OWNER,
    scope: { organId: id('organ', 'humanagent-ui') },
    allowedClasses: ['control', 'data', 'observation'],
    capabilities: ['orchestration.feedback', 'event.publish.control', 'event.publish.data'],
  };
  return {
    async resolvePublisher(publisherId) {
      if (publisherId === publisher.publisherId) return publisher;
      return input.feedbackPorts.publishers.resolvePublisher(publisherId);
    },
  };
}

export function createServeRuntimeComposition(
  input: ServeRuntimeCompositionInput,
): ServeRuntimeComposition {
  assertEventBusPorts(input.eventBusPorts);
  const nodeRuntime = new HarnessNodeRuntime(createDefaultNodeStrategyRegistry());
  const runtimePool = new AgentRuntimePoolManager({
    maxRuntimes: input.maxRuntimes ?? 4,
    factory: runtimeFactory(nodeRuntime),
    ownerId: OWNER,
    initialRuntimes: [],
  });
  const budgetStore = createMemoryRestartBudgetStore();
  const agentIo: ServeAgentIoOwner = {
    ownerId: 'humanagent.runtime.agent-io',
    budgetStore,
    createRequest: (request) => AgentIoRequestCoordinator.create({
      control: request.control,
      lockedBinding: request.lockedBinding,
      data: request.data,
      clock: request.clock,
      budgetStore,
      onEvent: request.onEvent,
    }),
  };
  const eventBus: ServeEventBusOwner = {
    ownerId: 'humanagent.runtime.events',
    ports: input.eventBusPorts,
    publishers: input.eventBusPorts.publishers,
  };
  return {
    ownerId: OWNER,
    nodeRuntime,
    agentIo,
    eventBus,
    runtimePool,
    createTaskAssembly({ task, scope, checkpointJournal, executionAgent, maxAttempts }) {
      if (!input.reviewAgent || !input.mergeCoordinator) {
        throw new AppLifecycleError(
          'serve.m3.ports-missing',
          `M3 task ${task.id.value} cannot be composed without review and merge ports`,
          'bind the M3 review and merge owners before creating task-scoped orchestration',
          OWNER,
        );
      }
      return createM3Assembly({
        ownerId: OWNER,
        task,
        scope,
        runtimePool,
        executionAgent: executionAgent ?? input.executionAgent ?? unboundExecutionAgent,
        reviewAgent: input.reviewAgent,
        mergeCoordinator: input.mergeCoordinator,
        feedbackPorts: {
          journal: input.feedbackPorts.journal,
          publishers: feedbackPublisher(input),
        },
        feedbackPublisherId: input.feedbackPublisherId,
        checkpointJournal,
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    },
    async dispose() {
      await runtimePool.dispose();
    },
  };
}

export function serveRuntimeOwnerId(): typeof OWNER {
  return OWNER;
}
