import { join } from 'node:path';
import {
  checkpointCommitId,
  completeCheckpoint,
  executeStopControl,
  recallCheckpoint,
  type AttentionPort,
  type CheckpointCommitPort,
  type CheckpointJournalPort,
  type RecalledCheckpoint,
  type StopControlResult,
} from '../../runtime/src/index.js';
import {
  id,
  type AgentEvent,
  type AgentDriver,
  type AgentOutput,
  type Checkpoint,
  type CycleId,
  type EvidenceRef,
  type OperationId,
  type OrganId,
  type ScopeRef,
  type TaskId,
} from '../../contracts/src/index.js';
import type { AgentConfig, LoadedConfiguration, RuntimePaths } from '../../config/src/index.js';
import { composeAgentDriver, ensureDshSettings, resolveDshHome, type ComposedAgentDriver } from './agent-driver-composition.js';
import { openAgentExecution, type AgentExecutionSession, type AgentExecutionReceipt } from './agent-execution.js';
import { createJsonlAttentionPort } from './attention-journal.js';
import {
  checkpointEvidenceDigest,
  checkpointEvidenceLocator,
  createJsonlCheckpointJournal,
} from './checkpoint-journal.js';
import { AppLifecycleError } from './errors.js';
import { writeRunManifest } from './run-manifest.js';
import { createMemoryAnalysisRequestedEvent, type MemoryAnalysisTrigger } from '../../runtime/src/memory/index.js';

const OWNER = 'humanagent.app.run-operation';

export interface OpenAgentOperationInput {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly workspace: string;
  readonly sessionId: string;
  readonly plan: string;
  readonly prompt: string;
  readonly runtimeId?: string;
  readonly taskId?: TaskId;
  readonly operationId?: OperationId;
  readonly executionEpoch?: number;
  readonly directiveRevision?: number;
  readonly agent?: AgentConfig;
  /**
   * Test/integration seam: an already-composed driver. Production callers omit
   * it so the app composes the configured driver itself; no fallback exists.
   */
  readonly composed?: ComposedAgentDriver;
  /**
   * Recovery starts a fresh checkpoint chain for the new operation/epoch while
   * keeping the recovered checkpoint as evidence. A cross-operation resume is
   * not the same chain, so it must not claim a predecessor link.
   */
  readonly newChain?: boolean;
  readonly memoryBoundaryPublisher?: MemoryBoundaryPublisher;
}

export interface MemoryBoundaryPublishInput {
  readonly event: ReturnType<typeof createMemoryAnalysisRequestedEvent>;
  readonly checkpoint: Checkpoint;
  readonly recordDigest: string;
}

export interface MemoryBoundaryPublisher {
  publish(input: MemoryBoundaryPublishInput): Promise<void>;
}

export interface RunAgentOperationResult {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly checkpoint: Checkpoint;
  readonly receipt: AgentExecutionReceipt;
}

export interface AgentOperationSnapshot {
  readonly runtimeId: string;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly scope: ScopeRef;
  readonly cycleId: CycleId;
  readonly directiveRevision: number;
  readonly state: string;
  readonly checkpoint?: Checkpoint;
}

interface PreparedOperation {
  readonly agent: AgentConfig;
  readonly paths: RuntimePaths;
  readonly sessionId: string;
  readonly prompt: string;
  readonly runtimeId: string;
  readonly executionEpoch: number;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly cycleId: CycleId;
  readonly directiveRevision: number;
  readonly scope: ScopeRef;
  readonly journal: CheckpointJournalPort;
  readonly previous: RecalledCheckpoint | null;
  readonly recoveryStateRef: EvidenceRef;
  readonly execution: AgentExecutionSession;
  readonly driver: AgentDriver;
  readonly attentionPort: AttentionPort;
  readonly memoryBoundaryPublisher?: MemoryBoundaryPublisher;
}

function assemblePrompt(input: OpenAgentOperationInput, agent: AgentConfig): { prompt: string; promptRef?: string } {
  const loaded = input.configuration.promptCatalog[agent.roleId];
  if (!loaded) {
    throw new AppLifecycleError(
      'template-invalid',
      `prompt catalog is missing for configured agent role: ${agent.roleId}`,
      'repair the locked builtin prompt assets and reload configuration',
      OWNER,
    );
  }
  const systemPrompt = loaded.segments.map((segment) => segment.content).join('\n\n');
  return {
    prompt: `${systemPrompt}\n\n# Task input\n\n${input.prompt}`,
    promptRef: `humanagent://template/${agent.roleId}/${loaded.contentDigest}`,
  };
}

function selectAgent(input: OpenAgentOperationInput): AgentConfig {
  if (input.agent) return input.agent;
  const defaultAgentId = input.configuration.effective.project?.defaultAgent;
  const selected = defaultAgentId
    ? input.configuration.agentRoster.find((agent) => agent.agentId === defaultAgentId)
    : input.configuration.agentRoster[0];
  if (!selected) {
    throw new AppLifecycleError(
      'agent-not-configured',
      'no agent is available for execution',
      'configure an agent in the user config before running a task',
      OWNER,
    );
  }
  return selected;
}

function scopeFor(input: {
  readonly agent: AgentConfig;
  readonly taskId: TaskId;
  readonly operationId: OperationId;
  readonly cycleId: CycleId;
}): ScopeRef {
  const organId: OrganId = id('organ', `agent-${input.agent.agentId}`);
  return {
    organId,
    taskId: input.taskId,
    cycleId: input.cycleId,
    operationId: input.operationId,
  };
}

function operationIdFor(input: OpenAgentOperationInput, runtimeId: string, executionEpoch: number): OperationId {
  if (input.operationId) return input.operationId;
  return id('operation', `runtime-${runtimeId}-epoch-${executionEpoch}`);
}

export function checkpointJournal(paths: RuntimePaths): CheckpointJournalPort {
  return createJsonlCheckpointJournal({ filePath: join(paths.journalRoot, 'checkpoints.jsonl') });
}

export async function prepareAgentOperation(input: OpenAgentOperationInput): Promise<PreparedOperation> {
  const agent = selectAgent(input);
  const runtimeId = input.runtimeId ?? `runtime-${input.sessionId}`;
  const executionEpoch = input.executionEpoch ?? 1;
  const taskId = input.taskId ?? id('task', input.sessionId);
  const operationId = operationIdFor(input, runtimeId, executionEpoch);
  const cycleId = id('cycle', `${input.sessionId}-cycle-${executionEpoch}`);
  const directiveRevision = input.directiveRevision ?? 1;
  const composed = input.composed ?? composeAgentDriver({
    agent,
    paths: input.paths,
    ...(input.configuration.effective.execution?.dsh === undefined ? {} : { dsh: input.configuration.effective.execution.dsh }),
    runtimeId,
    workspace: input.workspace,
  });
  const dshSettings = input.configuration.effective.execution?.dsh;
  if (agent.driverRef === 'dsh' && dshSettings) {
    // The DSH home owns provider routes, so HumanAgent must place the one
    // configured route before the runtime boots. Conflicts fail loudly.
    await ensureDshSettings(resolveDshHome({ paths: input.paths, configuredHome: dshSettings.home }), dshSettings);
  }
  const scope = scopeFor({
    agent,
    taskId,
    operationId,
    cycleId,
  });
  const journal = checkpointJournal(input.paths);
  const assembled = assemblePrompt(input, agent);
  const recalled = await recallCheckpoint(journal, { ownerId: OWNER, scope });
  const previous = input.newChain ? null : recalled;
  const recoveryStateRef: EvidenceRef = {
    evidenceId: id('evidence', `recovery-${input.sessionId}-${executionEpoch}`),
    kind: 'operation',
    source: OWNER,
    locator: `humanagent://session/${input.sessionId}/epoch/${executionEpoch}`,
    scope,
  };
  const execution = openAgentExecution({
    driver: composed.driver,
    request: {
      runtimeId,
      taskId,
      assignmentId: `${input.sessionId}-assignment`,
      organId: scope.organId,
      ...(scope.cycleId ? { cycleId: scope.cycleId } : {}),
      operationId,
      executionEpoch,
      ownerRef: OWNER,
      input: { prompt: assembled.prompt },
      inputRefs: [
        `humanagent://session/${input.sessionId}/input/${directiveRevision}`,
        ...(assembled.promptRef === undefined ? [] : [assembled.promptRef]),
      ],
      waitConditionRef: `humanagent://session/${input.sessionId}/condition`,
      recoveryRef: recoveryStateRef.locator,
    },
  });
  return {
    agent,
    paths: input.paths,
    sessionId: input.sessionId,
    prompt: assembled.prompt,
    runtimeId,
    executionEpoch,
    taskId,
    operationId,
    cycleId,
    directiveRevision,
    scope,
    journal,
    previous,
    recoveryStateRef,
    execution,
    driver: composed.driver,
    attentionPort: createJsonlAttentionPort({ paths: input.paths }),
    ...(input.memoryBoundaryPublisher === undefined ? {} : { memoryBoundaryPublisher: input.memoryBoundaryPublisher }),
  };
}

export class AgentOperationController {
  private started = false;
  private submitted = false;
  private settled = false;
  private committedCheckpoint?: Checkpoint;
  private lastOutput?: AgentOutput;
  private stoppedCheckpoint?: Checkpoint;

  constructor(private readonly prepared: PreparedOperation) {}

  snapshot(): AgentOperationSnapshot {
    const runtime = this.prepared.execution.runtime.snapshot();
    return {
      runtimeId: this.prepared.runtimeId,
      taskId: this.prepared.taskId,
      operationId: this.prepared.operationId,
      executionEpoch: this.prepared.executionEpoch,
      scope: this.prepared.scope,
      cycleId: this.prepared.cycleId,
      directiveRevision: this.prepared.directiveRevision,
      state: runtime.state,
      ...(this.stoppedCheckpoint ? { checkpoint: structuredClone(this.stoppedCheckpoint) } : {}),
    };
  }

  async start(): Promise<void> {
    if (this.started) throw new AppLifecycleError('agent-operation-started', 'agent operation is already started', 'reuse the active operation handle', OWNER);
    const handle = await this.prepared.execution.runtime.start();
    if (handle.runtimeId !== this.prepared.runtimeId || handle.executionEpoch !== this.prepared.executionEpoch) {
      throw new AppLifecycleError('agent-handle-mismatch', 'agent driver returned a handle for another runtime or epoch', 'reject the adapter response and restart from the owning runtime', OWNER);
    }
    this.started = true;
  }

  async submit(): Promise<AgentOutput> {
    if (!this.started) throw new AppLifecycleError('agent-operation-not-started', 'agent operation has not started', 'start the operation before submitting input', OWNER);
    if (this.submitted) throw new AppLifecycleError('agent-operation-submitted', 'agent operation input was already submitted', 'observe the active operation instead of resubmitting', OWNER);
    const output = await this.prepared.execution.submit({ prompt: this.prepared.prompt });
    if (output.payload?.status === 'failed') {
      const locator = output.evidenceRefs[0]?.locator ?? `humanagent://session/${this.prepared.sessionId}/prompt-rejected`;
      throw new AppLifecycleError(
        'agent-prompt-rejected',
        `agent prompt was rejected; evidence=${locator}`,
        'inspect the adapter evidence and retry after correcting the provider or prompt',
        OWNER,
      );
    }
    this.submitted = true;
    this.lastOutput = output;
    return output;
  }

  async releaseExecution(): Promise<void> {
    if (this.settled) return;
    await this.prepared.execution.settle();
  }

  observe(): AsyncIterable<AgentEvent> {
    return this.prepared.execution.observe();
  }

  async runToCompletion(): Promise<AgentExecutionReceipt> {
    if (!this.submitted || !this.lastOutput) {
      throw new AppLifecycleError('agent-operation-not-submitted', 'agent operation has no submitted input', 'submit input before observing the operation', OWNER);
    }
    const observedKinds: string[] = [];
    const outputRefs: string[] = [];
    for await (const event of this.prepared.execution.observe()) {
      observedKinds.push(event.kind);
      for (const ref of event.evidenceRefs) {
        if (ref.kind === 'tool') outputRefs.push(ref.locator);
      }
      if (event.kind === 'terminal') break;
    }
    const closure = await this.prepared.execution.settle();
    this.settled = true;
    return {
      runtimeId: this.prepared.runtimeId,
      taskId: this.prepared.taskId,
      operationId: this.prepared.operationId,
      executionEpoch: this.prepared.executionEpoch,
      output: this.lastOutput,
      scope: this.prepared.execution.scope,
      evidenceRefs: closure.evidenceRefs.length > 0 ? closure.evidenceRefs : this.lastOutput.evidenceRefs,
      closure,
      observedKinds,
      outputRefs,
    };
  }

  async stop(reason = 'humanagent stop'): Promise<StopControlResult> {
    const previousCheckpoint = this.prepared.previous?.checkpoint ?? null;
    const checkpointPort: CheckpointCommitPort = {
      commit: async (checkpoint) => {
        const receipt = await this.prepared.journal.append({
          ownerId: OWNER,
          commitId: checkpointCommitId(checkpoint),
          checkpoint,
        });
        return { checkpointId: receipt.checkpointId, committed: true as const };
      },
    };
    const result = await executeStopControl({
      command: {
        source: 'control',
        command: 'steer.request-stop',
        actorKind: 'human-operator',
        hasStopPermission: true,
        organId: this.prepared.scope.organId,
        taskId: this.prepared.taskId,
        executionEpoch: this.prepared.executionEpoch,
        currentState: this.prepared.execution.runtime.snapshot().state,
        runtimeId: this.prepared.runtimeId,
      },
      driver: this.prepared.driver,
      checkpointPort,
      attentionPort: this.prepared.attentionPort,
      currentOrganId: this.prepared.scope.organId,
      currentTaskId: this.prepared.taskId,
      currentEpoch: this.prepared.executionEpoch,
      operationId: this.prepared.operationId,
      scope: this.prepared.scope,
      cycleId: this.prepared.cycleId,
      ownerId: OWNER,
      previousCheckpoint,
      checkpointSeq: (previousCheckpoint?.seq ?? 0) + 1,
      directiveRevision: this.prepared.directiveRevision,
      stopReason: reason,
      recoveryStateRef: this.prepared.recoveryStateRef,
      runtime: this.prepared.execution.runtime,
    });
    if (result.state === 'stopped') {
      this.stoppedCheckpoint = result.checkpoint;
      this.settled = true;
      await this.writeManifest();
    }
    return result;
  }

  async complete(): Promise<RunAgentOperationResult> {
    if (this.stoppedCheckpoint) {
      throw new AppLifecycleError('agent-operation-stopped', 'agent operation was stopped; ordinary completion is not valid', 'resume from the stopped checkpoint or start a new operation', OWNER);
    }
    const receipt = await this.runToCompletion();
    const checkpoint = await this.commitOutcome(receipt, receipt.closure.state);
    return this.result(checkpoint, receipt);
  }

  async fail(error: unknown): Promise<RunAgentOperationResult> {
    if (this.committedCheckpoint) {
      throw new AppLifecycleError(
        'agent-operation-post-commit-recovery-required',
        `checkpoint ${this.committedCheckpoint.id.value} is committed; failure occurred after checkpoint commit`,
        'recover the committed checkpoint and reconcile the memory boundary before retrying',
        OWNER,
        error,
      );
    }
    if (this.settled) throw new AppLifecycleError('agent-operation-settled', 'agent operation already settled', 'read the committed checkpoint instead', OWNER);
    this.settled = true;
    const message = error instanceof Error ? error.message : String(error);
    const failureRef: EvidenceRef = {
      evidenceId: id('evidence', `failure-${this.prepared.sessionId}-${this.prepared.executionEpoch}`),
      kind: 'operation',
      source: OWNER,
      locator: `humanagent://session/${this.prepared.sessionId}/failure/${encodeURIComponent(message).slice(0, 96)}`,
      scope: this.prepared.scope,
    };
    const receipt: AgentExecutionReceipt = {
      runtimeId: this.prepared.runtimeId,
      taskId: this.prepared.taskId,
      operationId: this.prepared.operationId,
      executionEpoch: this.prepared.executionEpoch,
      output: {
        taskId: this.prepared.taskId,
        executionEpoch: this.prepared.executionEpoch,
        assignmentId: `${this.prepared.sessionId}-assignment`,
        payload: { outcome: 'failed', message },
        outputRefs: [],
        evidenceRefs: [failureRef],
      },
      scope: this.prepared.scope,
      evidenceRefs: [failureRef],
      closure: { state: 'failed', evidenceRefs: [failureRef], ownerRef: OWNER },
      observedKinds: [],
      outputRefs: [],
    };
    const checkpoint = await this.commitOutcome(receipt, 'failed');
    return this.result(checkpoint, receipt);
  }

  async commitOutcome(receipt: AgentExecutionReceipt, outcome: Checkpoint['outcome']): Promise<Checkpoint> {
    const evidenceRefs = receipt.evidenceRefs.length > 0 ? receipt.evidenceRefs : [this.prepared.recoveryStateRef];
    const next = outcome === 'succeeded'
      ? { kind: 'continue' as const, ref: `humanagent://session/${this.prepared.sessionId}/next` }
      : outcome === 'waiting'
        ? { kind: 'wait' as const, ref: `humanagent://session/${this.prepared.sessionId}/condition` }
        : outcome === 'stopped'
          ? { kind: 'stop' as const, ref: 'humanagent stop' }
          : { kind: 'recover' as const, ref: this.prepared.recoveryStateRef.locator };
    const checkpoint: Checkpoint = {
      id: id('checkpoint', `${this.prepared.sessionId}-${this.prepared.executionEpoch}-${(this.prepared.previous?.checkpoint.seq ?? 0) + 1}`),
      scope: this.prepared.scope,
      cycleId: this.prepared.cycleId,
      seq: (this.prepared.previous?.checkpoint.seq ?? 0) + 1,
      previousCheckpointId: this.prepared.previous?.checkpoint.id ?? null,
      directiveRevision: this.prepared.directiveRevision,
      executionEpoch: this.prepared.executionEpoch,
      outcome,
      summary: `agent operation ${outcome}`,
      recoveryStateRef: this.prepared.recoveryStateRef,
      evidenceRefs,
      next,
    };
    const completed = await completeCheckpoint(this.prepared.journal, {
      ownerId: OWNER,
      context: { scope: this.prepared.scope, cycleId: this.prepared.cycleId, executionEpoch: this.prepared.executionEpoch, directiveRevision: this.prepared.directiveRevision },
      previous: this.prepared.previous?.checkpoint ?? null,
      checkpoint,
    });
    this.committedCheckpoint = completed.checkpoint;
    await this.writeManifest();
    if (this.prepared.memoryBoundaryPublisher) {
      const trigger = memoryTrigger(outcome);
      if (trigger) {
        const event = createMemoryAnalysisRequestedEvent({
          messageId: `checkpoint-${completed.checkpoint.id.value}`,
          streamId: `memory-boundaries:${this.prepared.taskId.value}`,
          scope: this.prepared.scope,
          occurredAt: new Date().toISOString(),
          summary: `checkpoint ${outcome} for task ${this.prepared.taskId.value}`,
          evidenceRefs: [{
            evidenceId: id('evidence', `checkpoint-${completed.checkpoint.id.value}`),
            kind: 'operation',
            source: OWNER,
            locator: checkpointEvidenceLocator(completed.checkpoint),
            digest: checkpointEvidenceDigest(completed.checkpoint),
            scope: this.prepared.scope,
          }],
          executionEpoch: this.prepared.executionEpoch,
          trigger,
          requestedKind: trigger === 'rewind' ? 'procedural' : 'semantic',
          candidateCategory: trigger === 'rewind' ? 'project-experience' : 'project-fact',
          sessionRef: this.prepared.sessionId,
        });
        const recordDigest = completed.receipt.recordDigest;
        if (!recordDigest) {
          throw new AppLifecycleError(
            'agent-operation-post-commit-recovery-required',
            `checkpoint ${completed.checkpoint.id.value} is committed without a journal record digest`,
            'reconcile the committed checkpoint record before publishing the memory boundary',
            OWNER,
          );
        }
        await this.prepared.memoryBoundaryPublisher.publish({
          event,
          checkpoint: completed.checkpoint,
          recordDigest,
        });
      }
    }
    return completed.checkpoint;
  }

  private async writeManifest(): Promise<void> {
    await writeRunManifest(this.prepared.paths, {
      schemaVersion: 1,
      sessionId: this.prepared.sessionId,
      agentId: this.prepared.agent.agentId,
      driverRef: this.prepared.agent.driverRef,
      runtimeId: this.prepared.runtimeId,
      taskId: this.prepared.taskId,
      operationId: this.prepared.operationId,
      executionEpoch: this.prepared.executionEpoch,
      directiveRevision: this.prepared.directiveRevision,
      cycleId: this.prepared.cycleId,
      scope: this.prepared.scope,
    });
  }

  private result(checkpoint: Checkpoint, receipt: AgentExecutionReceipt): RunAgentOperationResult {
    return {
      runtimeId: this.prepared.runtimeId,
      taskId: this.prepared.taskId,
      operationId: this.prepared.operationId,
      executionEpoch: this.prepared.executionEpoch,
      scope: this.prepared.scope,
      checkpoint,
      receipt,
    };
  }
}

function memoryTrigger(outcome: Checkpoint['outcome']): MemoryAnalysisTrigger | null {
  if (outcome === 'succeeded') return 'completion';
  if (outcome === 'failed' || outcome === 'waiting' || outcome === 'blocked' || outcome === 'unknown') return 'blocked';
  return null;
}

export async function openAgentOperation(input: OpenAgentOperationInput): Promise<AgentOperationController> {
  return new AgentOperationController(await prepareAgentOperation(input));
}
