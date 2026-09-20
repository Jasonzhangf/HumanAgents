import { join } from 'node:path';
import {
  commitReentry,
  checkpointCommitId,
  recallCheckpoint,
  type RecalledCheckpoint,
} from '../../runtime/src/index.js';
import {
  type AgentClosure,
  type AgentSemanticEvent,
  type Checkpoint,
  type CheckpointId,
  type ScopeRef,
  type TaskId,
} from '../../contracts/src/index.js';
import type { LoadedConfiguration, RuntimePaths } from '../../config/src/index.js';
import {
  checkpointJournal,
  openAgentOperation,
  type OpenAgentOperationInput,
  type RunAgentOperationResult,
} from './agent-operation.js';
import {
  createCheckpointReentryAdmissionPort,
  createJsonlCheckpointClosurePort,
} from './checkpoint-journal.js';
import { AppLifecycleError } from './errors.js';
import { projectExecutionSemanticEvents } from './fake-execution.js';

const OWNER = 'humanagent.app.run-operation';

export interface RunAgentOperationInput extends OpenAgentOperationInput {}
export type { RunAgentOperationResult } from './agent-operation.js';

export interface AgentOperationResult extends RunAgentOperationResult {
  readonly driverRef: 'fake' | 'dsh';
  readonly semanticEvents: readonly AgentSemanticEvent[];
}

function selectedAgentDriverRef(input: OpenAgentOperationInput): 'fake' | 'dsh' {
  if (input.agent) return input.agent.driverRef;
  const defaultAgentId = input.configuration.effective.project?.defaultAgent;
  const selected = defaultAgentId
    ? input.configuration.agentRoster.find((agent) => agent.agentId === defaultAgentId)
    : input.configuration.agentRoster[0];
  if (!selected) {
    throw new AppLifecycleError(
      'run-operation.agent-unconfigured',
      'no agent is configured to run the requested operation',
      'configure at least one agent in config.toml',
      OWNER,
    );
  }
  return selected.driverRef;
}

function withSemanticReceipt(
  result: RunAgentOperationResult,
  input: OpenAgentOperationInput,
  options: {
    readonly failure?: { readonly message: string; readonly closure?: AgentClosure };
    readonly executionAdmitted?: boolean;
  } = {},
): AgentOperationResult {
  return {
    ...result,
    driverRef: selectedAgentDriverRef(input),
    semanticEvents: projectExecutionSemanticEvents({
      observedEvents: result.receipt.observedEvents,
      checkpoint: result.checkpoint,
      providerClose: result.receipt.providerClose,
      executionAdmitted: options.executionAdmitted ?? false,
      ...(options.failure === undefined ? {} : { failure: options.failure }),
    }),
  };
}

/**
 * Runs one real HumanAgent operation: the app owns Task / Operation / execution
 * epoch / checkpoint, and the adapter only supplies execution. The checkpoint
 * is written from the actual settle evidence; DSH session logs never become
 * HumanAgent state.
 */
export async function runAgentOperation(input: RunAgentOperationInput): Promise<AgentOperationResult> {
  const controller = await openAgentOperation(input);
  let executionAdmitted = false;
  try {
    await controller.start();
    await controller.submit();
    executionAdmitted = true;
    return withSemanticReceipt(await controller.complete(), input, { executionAdmitted });
  } catch (error) {
    let closeFailure: unknown;
    try {
      await controller.releaseExecution();
    } catch {
      // Preserve the original execution failure; releasing the runtime is a
      // cleanup best-effort and must never mask why the operation failed.
    }
    try {
      await controller.closeExecution();
    } catch (failure) {
      closeFailure = failure;
    }
    try {
      const result = await controller.fail(error);
      if (closeFailure !== undefined) {
        throw new AppLifecycleError(
          'agent-operation-recovery-required',
          `${error instanceof Error ? error.message : String(error)}; provider close failed: ${closeFailure instanceof Error ? closeFailure.message : String(closeFailure)}`,
          'reconcile provider close before retrying the failed operation',
          OWNER,
          { originalError: error, closeFailure, result },
        );
      }
      return withSemanticReceipt(result, input, {
        failure: {
          message: error instanceof Error ? error.message : String(error),
          closure: result.receipt.closure,
        },
        executionAdmitted,
      });
    } catch (failure) {
      if (failure instanceof AppLifecycleError && failure.code === 'agent-operation-post-commit-recovery-required') {
        throw failure;
      }
      if (failure instanceof AppLifecycleError && failure.code === 'agent-operation-recovery-required') {
        throw failure;
      }
      throw error;
    }
  }
}

export interface ResumeAgentOperationInput {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly workspace: string;
  readonly sessionId: string;
  readonly plan: string;
  readonly prompt: string;
  readonly taskId: TaskId;
  readonly cycleId: { readonly scope: 'cycle'; readonly value: string };
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly directiveRevision: number;
  readonly agentId: string;
  readonly driverRef: 'fake' | 'dsh';
}

export interface ResumeAgentOperationResult {
  readonly recovered: RecalledCheckpoint | null;
  readonly execution?: RunAgentOperationResult;
  readonly reentry?: Awaited<ReturnType<typeof commitReentry>>;
  readonly waitingReason?: string;
}

/**
 * Recovery uses the HumanAgent checkpoint as truth and starts a fresh DSH
 * session. DSH cannot reopen a persisted session, so recovery never pretends
 * the old session resumed.
 */
export async function resumeAgentOperation(input: ResumeAgentOperationInput): Promise<ResumeAgentOperationResult> {
  const journal = checkpointJournal(input.paths);
  const recovered = await recallCheckpoint(journal, { ownerId: OWNER, scope: input.scope });
  if (!recovered) {
    return { recovered: null as never, waitingReason: `no checkpoint exists for ${input.sessionId}` };
  }
  const checkpoint = recovered.checkpoint;
  if (checkpoint.outcome === 'succeeded') {
    return { recovered, waitingReason: `checkpoint is terminal: ${checkpoint.outcome}` };
  }
  if (checkpoint.outcome === 'stopped' || checkpoint.outcome === 'cancelled') {
    return { recovered, waitingReason: `checkpoint is terminal: ${checkpoint.outcome}` };
  }
  const agent = input.configuration.agentRoster.find((candidate) => candidate.agentId === input.agentId);
  if (!agent) {
    throw new AppLifecycleError(
      'run-manifest-agent-missing',
      `run manifest references agent ${input.agentId} but it is no longer configured`,
      'restore the original agent configuration before resuming this session',
      OWNER,
    );
  }
  if (agent.driverRef !== input.driverRef) {
    throw new AppLifecycleError(
      'run-manifest-driver-mismatch',
      `run manifest requires driver ${input.driverRef} but agent ${input.agentId} now uses ${agent.driverRef}`,
      'restore the original agent/driver configuration before resuming this session',
      OWNER,
    );
  }
  const nextEpoch = Math.max(checkpoint.executionEpoch, input.executionEpoch) + 1;
  const checkpointFile = join(input.paths.journalRoot, 'checkpoints.jsonl');
  const closurePort = createJsonlCheckpointClosurePort({ filePath: checkpointFile });
  const recoveryAdmission = createCheckpointReentryAdmissionPort({
    admitRecovery: async () => {
      const closure = await closurePort.read(`checkpoint-closure:${checkpointCommitId(checkpoint)}`);
      if (!closure || !('closureKind' in closure) || closure.closureKind !== 'checkpoint') {
        return false;
      }
      if (closure.reentry.allowed) return true;
      return checkpoint.outcome === 'failed' && (closure.reentry.blockedBy?.length ?? 0) === 0;
    },
  });
  const reentry = await commitReentry({
    ownerId: OWNER,
    closureId: `reentry:${input.sessionId}:${checkpoint.executionEpoch}:${nextEpoch}`,
    checkpoint,
    source: 'recovery',
    previousExecutionEpoch: checkpoint.executionEpoch,
    newExecutionEpoch: nextEpoch,
    nextAction: { kind: 'continue', ref: `humanagent://session/${input.sessionId}/epoch/${nextEpoch}` },
    journal,
    closurePort,
    admissionPort: recoveryAdmission,
  });
  const execution = await runAgentOperation({
    paths: input.paths,
    configuration: input.configuration,
    workspace: input.workspace,
    sessionId: input.sessionId,
    plan: input.plan,
    prompt: input.prompt,
    taskId: input.taskId,
    executionEpoch: nextEpoch,
    directiveRevision: input.directiveRevision,
    agent,
    // A cross-operation resume is a new checkpoint chain; the recovered
    // checkpoint is the recovery evidence, not a predecessor link.
    newChain: true,
  });
  return { recovered, execution, reentry };
}

export function checkpointIdFor(checkpoint: Checkpoint): CheckpointId {
  return checkpoint.id;
}
