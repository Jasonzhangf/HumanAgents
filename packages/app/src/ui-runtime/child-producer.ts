import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  id,
  REVIEW_KIND_WHITELIST,
  type AcceptedChildDelivery,
  type AgentEvent,
  type ActiveTurnProviderExecutionIdentityRef,
  type BusinessPayload,
  type ChildCallBinding,
  type ChildInvocationRecord,
  type EvidenceRef,
  type OperationId,
  type ProviderExecutionIdentityRef,
  type ProviderSettlement,
  type ProviderToolDefinition,
  type RawAsset,
  type ReviewAssignment,
  type ReviewKind,
  type ReviewOutput,
  type ReviewResult,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../../contracts/src/index.js';
import type { ExecutionRuntimePort, ProviderBinding, ProviderToolCall } from '../../../contracts/src/index.js';
import type {
  ChildCallAdoptionInput,
  ChildCallPort,
  ChildCallPrepareInput,
  ChildCallReturnInput,
  ChildCallReviewCheckpointInput,
  ChildCallReviewCheckpointReceipt,
  ExecutionAgentInput,
  ExecutionAgentPort,
  IndependentChildCallInput,
  IndependentChildCallResult,
  PreparedChildCall,
  RegisteredParentChildCall,
  ReviewAgentDelivery,
  ReviewAgentInput,
  ReviewAgentPort,
} from '../../../runtime/src/orchestration/types.js';
import type { OrchestrationManager } from '../../../runtime/src/orchestration/manager.js';
import {
  acceptanceCriteriaContent,
  digestOf,
  resolveReviewMaterial,
  type ReviewMaterial,
} from '../../../runtime/src/orchestration/review-material.js';
import { createReviewAssignments } from '../../../runtime/src/review/index.js';
import type { CommittedCheckpointRecord } from '../../../runtime/src/checkpoints/ports.js';
import type { RefinedDeliveryStore } from '../../../runtime/src/ui-runtime/coordinator.js';
import type { ActiveTurnContext, ActiveTurnSegmentContext } from '../../../runtime/src/context/active-turn-context.js';
import { ProviderAgentDriver } from '../../../adapters/provider/src/index.js';
import type { ProviderToolExecutionPort, ProviderToolExecutionResult } from '../../../adapters/provider/src/index.js';
import { closeAgentProvider, type AgentProviderComposition } from '../agent-driver-composition.js';
import type { AgentRole } from '../../../config/src/index.js';
import type { ToolOperationAdmissionReceipt } from './execution-admission.js';

const OWNER = 'humanagent.app.child-producer';

const MAX_PURPOSE = 2000;
const MAX_INSTRUCTIONS = 8000;
const MAX_CRITERIA_ITEMS = 8;
const MAX_CRITERIA_ITEM = 500;
const MAX_TARGET_REF = 256;
const MAX_INVOCATION_REF = 256;
const MAX_REFINED_CHARS = 8000;

export const APP_CHILD_CALL_TOOL: ProviderToolDefinition = {
  toolId: 'child.call',
  description: [
    'Dispatch one genuine independent child call in this same task.',
    'Select exactly one configured roster agent by agentId.',
    'Use kind "execution" for bounded work that produces one refined result, or kind "review" to review one previously returned execution result by its invocationId and a registered reviewKind.',
    'The parent chooses every role; no fixed order is imposed and repeated choices are allowed.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['purpose', 'agentId', 'kind'],
    properties: {
      purpose: { type: 'string', minLength: 1, maxLength: MAX_PURPOSE },
      agentId: { type: 'string', minLength: 1, maxLength: 128 },
      kind: { type: 'string', enum: ['execution', 'review'] },
      instructions: { type: 'string', minLength: 1, maxLength: MAX_INSTRUCTIONS },
      successCriteria: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CRITERIA_ITEMS,
        items: { type: 'string', minLength: 1, maxLength: MAX_CRITERIA_ITEM },
      },
      failureCriteria: {
        type: 'array',
        maxItems: MAX_CRITERIA_ITEMS,
        items: { type: 'string', minLength: 1, maxLength: MAX_CRITERIA_ITEM },
      },
      incompleteCriteria: {
        type: 'array',
        maxItems: MAX_CRITERIA_ITEMS,
        items: { type: 'string', minLength: 1, maxLength: MAX_CRITERIA_ITEM },
      },
      target: { type: 'string', minLength: 1, maxLength: MAX_TARGET_REF },
      reviewKind: { type: 'string', enum: [...REVIEW_KIND_WHITELIST] },
      subjectInvocationId: { type: 'string', minLength: 1, maxLength: MAX_INVOCATION_REF },
    },
  },
};

export const APP_CHILD_ADOPT_TOOL: ProviderToolDefinition = {
  toolId: 'child.adopt',
  description: [
    'Select one previously returned child delivery, by its invocationId, for adopted semantic context.',
    'The owner reads the retained assignment and refined asset; the model cannot submit replacement delivery bytes or its own adoption sequence.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['invocationId'],
    properties: { invocationId: { type: 'string', minLength: 1, maxLength: MAX_INVOCATION_REF } },
  },
};

export const APP_CHILD_NOT_SELECT_TOOL: ProviderToolDefinition = {
  toolId: 'child.not_select',
  description: [
    'Make the terminal decision not to select one previously returned child delivery, by its invocationId.',
    'The returned delivery stays immutable evidence; this records only the selection decision.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['invocationId'],
    properties: { invocationId: { type: 'string', minLength: 1, maxLength: MAX_INVOCATION_REF } },
  },
};

export const APP_CHILD_TOOLS: readonly ProviderToolDefinition[] = [
  APP_CHILD_CALL_TOOL,
  APP_CHILD_ADOPT_TOOL,
  APP_CHILD_NOT_SELECT_TOOL,
];

/**
 * Physical checkpoint owner for one genuine child call. The pre-call checkpoint
 * anchors recovery before the child runs; the post-review checkpoint is distinct
 * and is committed only after the durable review return. Both return the
 * canonical committed record, never a fabricated receipt or a bare ref.
 */
export interface AppChildCheckpointPort {
  pre(input: {
    readonly call: RegisteredParentChildCall;
    readonly selected: ChildCallPrepareInput;
    readonly worker: WorkAssignment;
  }): Promise<CommittedCheckpointRecord>;
  post(input: {
    readonly call: RegisteredParentChildCall;
    readonly returned: ChildCallReviewCheckpointInput;
    readonly worker: WorkAssignment;
  }): Promise<CommittedCheckpointRecord>;
}

/**
 * Real Task-grant child operation admission. The App admission executor owner
 * implements it over the existing gateway, authority, coverage and completion
 * owners; this module never bypasses the admitted executor and never mints
 * authority itself. The returned receipt supplies the registered business
 * commit ref for the accepted parent tool call.
 */
export interface AppChildOperationAdmissionInput {
  readonly invocationId: string;
  readonly childOperationId: OperationId;
  readonly kind: 'execution' | 'review';
  readonly selected: { readonly agentId: string; readonly roleId: AgentRole };
  readonly parentExecution: ProviderExecutionIdentityRef;
  readonly scope: ScopeRef;
  readonly providerRequestId: string;
  readonly toolCallId: string;
}

export type AppChildOperationAdmissionPort = (
  input: AppChildOperationAdmissionInput,
) => Promise<ToolOperationAdmissionReceipt>;

export interface AppChildProducerInput {
  readonly manager: Pick<OrchestrationManager, 'callChild'>;
  readonly parent: ActiveTurnContext | ActiveTurnSegmentContext;
  readonly parentAssignment: WorkAssignment;
  readonly checkpoints: AppChildCheckpointPort;
  readonly refinedDeliveryStore: RefinedDeliveryStore;
  readonly prepareAgentProvider: (selection: {
    readonly roleId: AgentRole;
    readonly configuredAgentId: string;
  }) => Promise<AgentProviderComposition>;
  readonly roster: readonly { readonly agentId: string; readonly roleId: AgentRole }[];
  readonly admitChildOperation: AppChildOperationAdmissionPort;
  readonly now?: () => Date;
}

export interface ConfiguredChildAgentInput {
  readonly call: RegisteredParentChildCall;
  readonly operation: ToolOperationAdmissionReceipt;
  readonly selected: { readonly agentId: string; readonly roleId: AgentRole };
  readonly prepareAgentProvider: (selection: {
    readonly roleId: AgentRole;
    readonly configuredAgentId: string;
  }) => Promise<AgentProviderComposition>;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Owner-derived child invocation key. It binds the actual parent turn, the
 * typed parent execution identity and the accepted Provider request/tool call.
 * A retry of the same accepted call reuses it; a different call never collides.
 */
function childInvocationKey(input: {
  readonly turnId: string;
  readonly parentExecution: ProviderExecutionIdentityRef;
  readonly providerRequestId: string;
  readonly toolCallId: string;
}): string {
  return canonicalJsonStringify({
    turnId: input.turnId,
    parentExecution: {
      runtimeId: input.parentExecution.runtimeId,
      taskId: input.parentExecution.taskId.value,
      operationId: input.parentExecution.operationId.value,
      executionEpoch: input.parentExecution.executionEpoch,
    },
    providerRequestId: input.providerRequestId,
    toolCallId: input.toolCallId,
  });
}

export function appChildInvocationId(input: {
  readonly turnId: string;
  readonly parentExecution: ProviderExecutionIdentityRef;
  readonly providerRequestId: string;
  readonly toolCallId: string;
}): string {
  return `invocation:child:${sha256Hex(childInvocationKey(input))}`;
}

function childOperationId(invocationId: string): OperationId {
  return id('operation', `child-${sha256Hex(invocationId)}`);
}

// ---------------------------------------------------------------------------
// Tool argument parsing (bounded)
// ---------------------------------------------------------------------------

type ExecutionCallRequest = {
  readonly kind: 'execution';
  readonly purpose: string;
  readonly agentId: string;
  readonly instructions: string;
  readonly successCriteria: readonly string[];
  readonly failureCriteria: readonly string[];
  readonly incompleteCriteria: readonly string[];
  readonly target: string;
};

type ReviewCallRequest = {
  readonly kind: 'review';
  readonly purpose: string;
  readonly agentId: string;
  readonly reviewKind: ReviewKind;
  readonly subjectInvocationId: string;
};

type ChildCallRequest = ExecutionCallRequest | ReviewCallRequest;

function readBoundedString(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`child call ${label} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`child call ${label} must be a string`);
  if (value.length > max) throw new Error(`child call ${label} exceeds its ${max} character bound`);
  if (required && value.trim() === '') throw new Error(`child call ${label} is required`);
  return value;
}

function readBoundedStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItem: number,
  required: boolean,
): readonly string[] {
  if (value === undefined || value === null) {
    if (required) throw new Error(`child call ${label} is required`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`child call ${label} must be an array`);
  if (value.length > maxItems) throw new Error(`child call ${label} exceeds its ${maxItems} item bound`);
  if (required && value.length === 0) throw new Error(`child call ${label} is required`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new Error(`child call ${label} item must be a non-empty string`);
    if (entry.length > maxItem) throw new Error(`child call ${label} item exceeds its ${maxItem} character bound`);
    return entry;
  });
}

function parseChildCallRequest(args: BusinessPayload): ChildCallRequest {
  const purpose = readBoundedString(args.purpose, 'purpose', MAX_PURPOSE, true);
  const agentId = readBoundedString(args.agentId, 'agentId', 128, true);
  if (args.kind === 'execution') {
    return {
      kind: 'execution',
      purpose,
      agentId,
      instructions: readBoundedString(args.instructions, 'instructions', MAX_INSTRUCTIONS, true),
      successCriteria: readBoundedStringArray(args.successCriteria, 'successCriteria', MAX_CRITERIA_ITEMS, MAX_CRITERIA_ITEM, true),
      failureCriteria: readBoundedStringArray(args.failureCriteria, 'failureCriteria', MAX_CRITERIA_ITEMS, MAX_CRITERIA_ITEM, false),
      incompleteCriteria: readBoundedStringArray(args.incompleteCriteria, 'incompleteCriteria', MAX_CRITERIA_ITEMS, MAX_CRITERIA_ITEM, false),
      target: readBoundedString(args.target, 'target', MAX_TARGET_REF, true),
    };
  }
  if (args.kind === 'review') {
    const reviewKind = args.reviewKind;
    if (typeof reviewKind !== 'string' || !REVIEW_KIND_WHITELIST.includes(reviewKind as ReviewKind)) {
      throw new Error('child call reviewKind must be a registered review kind');
    }
    return {
      kind: 'review',
      purpose,
      agentId,
      reviewKind: reviewKind as ReviewKind,
      subjectInvocationId: readBoundedString(args.subjectInvocationId, 'subjectInvocationId', MAX_INVOCATION_REF, true),
    };
  }
  throw new Error('child call kind must be execution or review');
}

function readInvocationSelector(args: BusinessPayload): string {
  return readBoundedString(args.invocationId, 'invocationId', MAX_INVOCATION_REF, true);
}

function selectRosterEntry(
  roster: readonly { readonly agentId: string; readonly roleId: AgentRole }[],
  agentId: string,
): { readonly agentId: string; readonly roleId: AgentRole } {
  const entry = roster.find((candidate) => candidate.agentId === agentId);
  if (!entry) throw new Error(`selected child agentId ${agentId} is not in the configured roster`);
  return entry;
}

// ---------------------------------------------------------------------------
// Independent Provider run
// ---------------------------------------------------------------------------

function outputText(events: readonly AgentEvent[]): string {
  return events.map((event) => event.summary ?? '').join('').trim();
}

function uniqueEvidence(
  events: readonly AgentEvent[],
  settlement: ProviderSettlement,
  scope: ScopeRef,
): readonly EvidenceRef[] {
  const refs = [...events.flatMap((event) => event.evidenceRefs), ...settlement.evidenceRefs];
  const seen = new Set<string>();
  const unique: EvidenceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.evidenceId.value)) continue;
    seen.add(ref.evidenceId.value);
    unique.push(ref);
  }
  return unique.length > 0 ? unique : [scopedEvidence(scope, 'child-provider-settlement')];
}

function scopedEvidence(scope: ScopeRef, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `child-${label.replace(/[^A-Za-z0-9._-]/g, '-')}`),
    kind: 'execution',
    source: OWNER,
    locator: `child/${label}`,
    scope,
  };
}

/**
 * Runs one real, independent Provider request on the selected composition. The
 * driver is bound to the real pool incarnation and the admitted child operation;
 * it inherits neither the parent request-context hook nor the parent raw sink,
 * transcript, tool surface or lifecycle callback.
 */
async function runIndependentChildModel(input: {
  readonly port: ExecutionRuntimePort;
  readonly binding: ProviderBinding;
  readonly runtimeId: string;
  readonly taskId: WorkAssignment['taskId'];
  readonly operationId: OperationId;
  readonly executionEpoch: number;
  readonly assignmentId: string;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly payload: BusinessPayload;
  readonly now?: () => Date;
}): Promise<{ readonly events: readonly AgentEvent[]; readonly settlement: ProviderSettlement }> {
  const driver = new ProviderAgentDriver({
    port: input.port,
    binding: input.binding,
    runtimeId: input.runtimeId,
    taskId: input.taskId,
    operationId: input.operationId,
    executionEpoch: input.executionEpoch,
    assignmentId: input.assignmentId,
    scope: input.scope,
    inputRefs: [...input.inputRefs],
    ownerId: OWNER,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const events: AgentEvent[] = [];
  let started = false;
  try {
    await driver.start({
      runtimeId: input.runtimeId,
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      organId: input.scope.organId,
      ...(input.scope.cycleId === undefined ? {} : { cycleId: input.scope.cycleId }),
      operationId: input.operationId,
    });
    started = true;
    await driver.submit({
      taskId: input.taskId,
      executionEpoch: input.executionEpoch,
      assignmentId: input.assignmentId,
      payload: input.payload,
    });
    for await (const event of driver.observe({ runtimeId: input.runtimeId })) {
      events.push(event);
      if (event.terminalState !== undefined) break;
    }
  } catch (error) {
    if (started) {
      try {
        await driver.settle({ runtimeId: input.runtimeId, executionEpoch: input.executionEpoch });
      } catch (settleError) {
        throw new AggregateError(
          [error, settleError],
          'independent child call failed and its own settlement also failed',
        );
      }
    }
    throw error;
  }
  await driver.settle({ runtimeId: input.runtimeId, executionEpoch: input.executionEpoch });
  const settlement = driver.settlement();
  if (!settlement) throw new Error('independent child call exposed no Provider settlement');
  return { events, settlement };
}

function executionPrompt(assignment: WorkAssignment): string {
  return [
    'You are one independent HumanAgent child execution for a single bounded assignment.',
    'You receive only the bounded instructions and criteria below. Do not assume any parent transcript.',
    `Objective: ${assignment.objective}`,
    `Success criteria: ${assignment.successCriteria.join('; ')}`,
    ...(assignment.failureCriteria.length === 0 ? [] : [`Failure criteria: ${assignment.failureCriteria.join('; ')}`]),
    ...(assignment.incompleteCriteria.length === 0 ? [] : [`Incomplete criteria: ${assignment.incompleteCriteria.join('; ')}`]),
    `Produce exactly the single refined result named by: ${assignment.targetRefs.join(', ')}`,
    'Reply with the refined result body only.',
  ].join('\n');
}

function reviewPrompt(assignment: ReviewAssignment, material: ReviewMaterial): string {
  return [
    'You are one independent HumanAgent child reviewer for a single bounded review.',
    'Evaluate the acceptance criteria against each subject body. A subject body is the artifact under review; a summary, ref or digest is never a substitute for it.',
    `Review kind: ${assignment.reviewKind}`,
    `Acceptance criteria: ${material.acceptanceCriteria}`,
    ...material.subjects.map((subject, index) => `Subject ${index + 1} (${subject.ref}):\n${subject.body}`),
    'End on the final line with exactly HUMANAGENT_REVIEW: passed, failed, or inconclusive',
  ].join('\n');
}

function reviewStatus(text: string, settlement: ProviderSettlement): ReviewResult['status'] {
  if (settlement.state !== 'succeeded') return 'inconclusive';
  const markers = [...text.matchAll(/HUMANAGENT_REVIEW\s*:\s*(passed|failed|inconclusive)/gi)]
    .map((match) => (match[1] ?? '').toLowerCase());
  const last = markers.at(-1);
  return last === 'passed' || last === 'failed' || last === 'inconclusive' ? last : 'inconclusive';
}

function buildExecutionResult(input: {
  readonly assignment: WorkAssignment;
  readonly agentId: string;
  readonly text: string;
  readonly events: readonly AgentEvent[];
  readonly settlement: ProviderSettlement;
  readonly scope: ScopeRef;
}): WorkResult {
  const succeeded = input.settlement.state === 'succeeded';
  const evidenceRefs = uniqueEvidence(input.events, input.settlement, input.scope);
  const target = input.assignment.targetRefs[0];
  if (target === undefined) throw new Error('child execution assignment declares no target ref');
  const body = input.text.slice(0, MAX_REFINED_CHARS);
  const summary = succeeded
    ? (input.text.trim().slice(0, MAX_REFINED_CHARS) || 'independent child execution succeeded')
    : `independent child execution ${input.settlement.state}`;
  const base = {
    taskId: input.assignment.taskId,
    pipelineNodeId: input.assignment.pipelineNodeId,
    agentId: input.agentId,
    assignmentId: input.assignment.assignmentId,
    attempt: input.assignment.attempt,
    executionEpoch: input.assignment.executionEpoch,
    inputRevision: input.assignment.inputRevision,
    summary,
    evidenceRefs,
    nextAction: succeeded ? ('review' as const) : ('attention' as const),
  };
  if (succeeded) {
    return {
      ...base,
      producedArtifactRefs: [target],
      producedArtifactDigests: [digestOf(body)],
      producedArtifactBodies: [body],
      status: 'succeeded',
      outputRefs: [target],
    };
  }
  const status: WorkResult['status'] = input.settlement.state === 'cancelled' ? 'cancelled' : 'failed';
  return {
    ...base,
    producedArtifactRefs: [],
    producedArtifactDigests: [],
    status,
    outputRefs: [],
    ...(status === 'failed' ? { failureRef: `child:${input.assignment.assignmentId}:failure` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Configured independent creators
// ---------------------------------------------------------------------------

function createCompositionCloser(): { hold(composition: AgentProviderComposition): void; close(): Promise<void> } {
  let pending: AgentProviderComposition | undefined;
  let closed = false;
  return {
    hold(composition) { pending = composition; closed = false; },
    async close() {
      const current = pending;
      pending = undefined;
      if (current === undefined || closed) return;
      closed = true;
      await closeAgentProvider(current);
    },
  };
}

function assertAdmittedOperation(input: ConfiguredChildAgentInput): void {
  const admitted = input.operation.businessRegistrationCommitRef;
  const registered = input.call.businessRegistrationCommitRef;
  if (admitted.commitId !== registered.commitId
    || admitted.journalSeq !== registered.journalSeq
    || admitted.recordDigest !== registered.recordDigest) {
    throw new Error('configured child creator requires the admitted business registration for this exact registered call');
  }
}

/**
 * Configured execution creator. `createInstance` synchronously returns the real
 * incarnation handle and performs no Provider request; `execute` prepares the
 * exact selected Provider and constructs the fresh independent driver.
 */
export function createConfiguredExecutionAgent(input: ConfiguredChildAgentInput): ExecutionAgentPort {
  const prepare = async (): Promise<AgentProviderComposition> => input.prepareAgentProvider({
    roleId: input.selected.roleId,
    configuredAgentId: input.selected.agentId,
  });
  return {
    roleId: input.selected.roleId,
    createInstance(create) {
      assertAdmittedOperation(input);
      const composition = createCompositionCloser();
      return {
        incarnation: create.incarnation,
        async release() { await composition.close(); },
        async dispose() { await composition.close(); },
        async execute(execution: ExecutionAgentInput): Promise<WorkResult> {
          const selected = await prepare();
          composition.hold(selected);
          try {
            const operationId = childOperationId(input.call.invocationId);
            const scope: ScopeRef = { ...execution.scope, operationId };
            const { events, settlement } = await runIndependentChildModel({
              port: selected.port,
              binding: selected.binding,
              runtimeId: create.incarnation.runtimeId,
              taskId: create.incarnation.taskId,
              operationId,
              executionEpoch: create.incarnation.executionEpoch,
              assignmentId: create.incarnation.assignmentId,
              scope,
              inputRefs: [...execution.assignment.targetRefs, `child:${input.call.invocationId}`],
              payload: { prompt: executionPrompt(execution.assignment) },
              ...(input.now === undefined ? {} : { now: input.now }),
            });
            return buildExecutionResult({
              assignment: execution.assignment,
              agentId: execution.agentId,
              text: outputText(events),
              events,
              settlement,
              scope,
            });
          } finally {
            await composition.close();
          }
        },
      };
    },
    async execute() {
      throw new Error('configured child execution must run through its acquired instance handle');
    },
  };
}

/**
 * Configured review creator. `createInstance` synchronously returns the real
 * incarnation handle and performs no Provider request; `review` prepares the
 * exact selected Provider and constructs the fresh independent driver.
 */
export function createConfiguredReviewAgent(input: ConfiguredChildAgentInput): ReviewAgentPort {
  const prepare = async (): Promise<AgentProviderComposition> => input.prepareAgentProvider({
    roleId: input.selected.roleId,
    configuredAgentId: input.selected.agentId,
  });
  return {
    roleId: input.selected.roleId,
    createInstance(create) {
      assertAdmittedOperation(input);
      const composition = createCompositionCloser();
      return {
        incarnation: create.incarnation,
        async release() { await composition.close(); },
        async dispose() { await composition.close(); },
        async review(review: ReviewAgentInput): Promise<ReviewAgentDelivery> {
          const selected = await prepare();
          composition.hold(selected);
          try {
            const operationId = childOperationId(input.call.invocationId);
            const scope: ScopeRef = { ...review.scope, operationId };
            const { events, settlement } = await runIndependentChildModel({
              port: selected.port,
              binding: selected.binding,
              runtimeId: create.incarnation.runtimeId,
              taskId: create.incarnation.taskId,
              operationId,
              executionEpoch: create.incarnation.executionEpoch,
              assignmentId: create.incarnation.assignmentId,
              scope,
              inputRefs: [...review.reviewAssignment.subjectRefs, `child:${input.call.invocationId}`],
              payload: { prompt: reviewPrompt(review.reviewAssignment, review.reviewMaterial) },
              ...(input.now === undefined ? {} : { now: input.now }),
            });
            const text = outputText(events);
            const assignment = review.reviewAssignment;
            const result: ReviewResult = {
              resultId: `review-result:${create.incarnation.agentInstanceId}`,
              assignmentId: assignment.assignmentId,
              taskId: assignment.taskId,
              workerAgentId: assignment.workerAgentId,
              reviewKind: assignment.reviewKind,
              attempt: assignment.attempt,
              executionEpoch: assignment.executionEpoch,
              inputRevision: assignment.inputRevision,
              acceptanceCriteriaDigest: assignment.acceptanceCriteriaDigest,
              subjectRefs: [...assignment.subjectRefs],
              subjectDigests: [...assignment.subjectDigests],
              status: reviewStatus(text, settlement),
              findings: [],
              evidenceRefs: uniqueEvidence(events, settlement, scope),
            };
            const output: ReviewOutput = {
              text: text.slice(0, MAX_REFINED_CHARS),
              artifactRef: null,
              artifactDigest: null,
            };
            return { result, output, completedAt: (input.now?.() ?? new Date()).toISOString() };
          } finally {
            await composition.close();
          }
        },
      };
    },
    async review() {
      throw new Error('configured child review must run through its acquired instance handle');
    },
  };
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

/**
 * Structural view over the two Runtime active-turn owners. Both expose the same
 * typed child mutation surface; the producer never reimplements it.
 */
type ParentChildReturnInput = {
  readonly invocationId: string;
  readonly refinedDelivery: RawAsset;
} & (
  | { readonly kind: 'execution'; readonly assignment: WorkAssignment; readonly result: WorkResult }
  | { readonly kind: 'review'; readonly assignment: ReviewAssignment; readonly result: ReviewResult }
);

interface AppChildParent {
  scope(): ScopeRef;
  executionIdentity(): ActiveTurnProviderExecutionIdentityRef;
  runProducer<T>(produce: () => T | Promise<T>): Promise<T>;
  assertProductionOpen(): void;
  openChildInvocation(input: {
    readonly invocationId: string;
    readonly childTurnId: string;
    readonly checkpointReceiptRef: string;
    readonly binding: ChildCallBinding;
  }): Promise<ChildInvocationRecord>;
  recordChildReturn(input: ParentChildReturnInput): Promise<AcceptedChildDelivery>;
  recordChildAdoption(invocationId: string, delivery: AcceptedChildDelivery): Promise<void>;
  recordChildNonSelection(invocationId: string): Promise<void>;
  recordReviewCheckpoint(invocationId: string, checkpointReceiptRef: string): Promise<void>;
  entries(): readonly (AcceptedChildDelivery | { readonly envelope: unknown })[];
  childInvocations(): readonly ChildInvocationRecord[];
}

function parentTurnId(parent: ActiveTurnContext | ActiveTurnSegmentContext): string {
  if ('admittedTurn' in parent) return parent.admittedTurn.turnId;
  return parent.segmentOpened.businessTurnRef.businessTurnId;
}

function findDelivery(parent: AppChildParent, invocationId: string): AcceptedChildDelivery | undefined {
  return parent.entries().find(
    (entry): entry is AcceptedChildDelivery => !('envelope' in entry) && entry.invocationId === invocationId,
  );
}

function encodeRefinedPayload(input: ChildCallReturnInput): Uint8Array {
  const payload = input.kind === 'execution'
    ? {
        assignmentId: input.result.assignmentId,
        attempt: input.result.attempt,
        executionEpoch: input.result.executionEpoch,
        status: input.result.status,
        summary: input.result.summary,
        producedArtifactBodies: input.result.producedArtifactBodies ?? [],
      }
    : {
        resultId: input.result.resultId,
        assignmentId: input.result.assignmentId,
        taskId: input.result.taskId,
        workerAgentId: input.result.workerAgentId,
        reviewKind: input.result.reviewKind,
        attempt: input.result.attempt,
        executionEpoch: input.result.executionEpoch,
        inputRevision: input.result.inputRevision,
        acceptanceCriteriaDigest: input.result.acceptanceCriteriaDigest,
        subjectRefs: input.result.subjectRefs,
        subjectDigests: input.result.subjectDigests,
        status: input.result.status,
        findings: input.result.findings,
        evidenceRefs: input.result.evidenceRefs,
      };
  return new TextEncoder().encode(JSON.stringify(payload));
}

function buildExecutionAssignment(input: {
  readonly request: ExecutionCallRequest;
  readonly childOperationId: OperationId;
  readonly taskId: WorkAssignment['taskId'];
  readonly inputRevision: number;
  readonly executionEpoch: number;
  readonly requiredCapabilities: readonly string[];
}): WorkAssignment {
  const assignmentId = `child-${input.childOperationId.value}`;
  const objective = input.request.instructions;
  const criteria = {
    objective,
    successCriteria: [...input.request.successCriteria],
    failureCriteria: [...input.request.failureCriteria],
    incompleteCriteria: [...input.request.incompleteCriteria],
  };
  return {
    assignmentId,
    taskId: input.taskId,
    pipelineNodeId: 'child.execution',
    attempt: 1,
    executionEpoch: input.executionEpoch,
    inputRevision: input.inputRevision,
    objective,
    targetRefs: [input.request.target],
    expectedOutputRefs: [input.request.target],
    acceptanceCriteriaDigest: digestOf(acceptanceCriteriaContent(criteria)),
    successCriteria: criteria.successCriteria,
    failureCriteria: criteria.failureCriteria,
    incompleteCriteria: criteria.incompleteCriteria,
    requiredCapabilities: [...input.requiredCapabilities],
    mergeGate: 'not-required',
  };
}

/**
 * The advertised child tool producer. It routes `call`, `adopt` and `not_select`
 * through the existing manager and the real parent context. Each genuine call is
 * wrapped in the parent `runProducer` and anchored by the physical pre-call
 * checkpoint before any Provider request; a review return is associated with a
 * durable post-review checkpoint before the tool can succeed.
 */
export function createAppChildProducer(input: AppChildProducerInput): ProviderToolExecutionPort {
  const parent = input.parent as unknown as AppChildParent;
  const turnId = parentTurnId(input.parent);
  const parentExecutionEpoch = parent.executionIdentity().executionEpoch;
  const roster = input.roster;

  function makeChildCallPort(call: RegisteredParentChildCall, worker: WorkAssignment): ChildCallPort {
    return {
      async prepare(prepareInput: ChildCallPrepareInput): Promise<PreparedChildCall> {
        parent.assertProductionOpen();
        const committed = await input.checkpoints.pre({ call, selected: prepareInput, worker });
        const checkpointReceiptRef = committed.checkpoint.id.value;
        await parent.openChildInvocation({
          invocationId: prepareInput.invocationId,
          childTurnId: prepareInput.invocationId,
          checkpointReceiptRef,
          binding: prepareInput.kind === 'execution'
            ? { kind: 'execution', assignment: prepareInput.assignment }
            : { kind: 'review', assignment: prepareInput.assignment },
        });
        return { invocationId: prepareInput.invocationId, checkpointReceiptRef };
      },
      async recordReturn(returnInput: ChildCallReturnInput): Promise<void> {
        if (findDelivery(parent, returnInput.invocationId) === undefined) {
          const refinedDelivery: RawAsset = await input.refinedDeliveryStore.store({
            scope: returnInput.scope,
            invocationId: returnInput.invocationId,
            bytes: encodeRefinedPayload(returnInput),
          });
          if (returnInput.kind === 'execution') {
            await parent.recordChildReturn({
              kind: 'execution',
              invocationId: returnInput.invocationId,
              refinedDelivery,
              assignment: returnInput.assignment,
              result: returnInput.result,
            });
          } else {
            await parent.recordChildReturn({
              kind: 'review',
              invocationId: returnInput.invocationId,
              refinedDelivery,
              assignment: returnInput.assignment,
              result: returnInput.result,
            });
          }
        }
        if (returnInput.kind === 'review') {
          const invocation = parent.childInvocations().find((record) => record.invocationId === returnInput.invocationId);
          if (invocation?.postReviewCheckpointRef === undefined) {
            const committed = await input.checkpoints.post({
              call,
              returned: {
                kind: 'review',
                invocationId: returnInput.invocationId,
                assignment: returnInput.assignment,
                result: returnInput.result,
                scope: returnInput.scope,
              },
              worker,
            });
            await parent.recordReviewCheckpoint(returnInput.invocationId, committed.checkpoint.id.value);
          }
        }
      },
      async recordAdoption(adoption: ChildCallAdoptionInput): Promise<void> {
        parent.assertProductionOpen();
        const delivery = findDelivery(parent, adoption.invocationId);
        if (!delivery || delivery.kind !== adoption.kind) {
          throw new Error(`child invocation ${adoption.invocationId} has no durable ${adoption.kind} delivery to adopt`);
        }
        await parent.recordChildAdoption(adoption.invocationId, delivery);
      },
      async recordReviewCheckpoint(checkpoint: ChildCallReviewCheckpointInput): Promise<ChildCallReviewCheckpointReceipt> {
        const committed = await input.checkpoints.post({ call, returned: checkpoint, worker });
        await parent.recordReviewCheckpoint(checkpoint.invocationId, committed.checkpoint.id.value);
        return { checkpointReceiptRef: committed.checkpoint.id.value };
      },
    };
  }

  function boundedEvidence(scope: ScopeRef, label: string, refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
    return refs.length > 0 ? refs : [scopedEvidence(scope, label)];
  }

  function returnResult(delivery: AcceptedChildDelivery, scope: ScopeRef): ProviderToolExecutionResult {
    if (delivery.kind === 'execution') {
      return {
        output: JSON.stringify({
          state: 'returned',
          kind: 'execution',
          invocationId: delivery.invocationId,
          status: delivery.result.status,
          summary: delivery.result.summary.slice(0, MAX_REFINED_CHARS),
          outputRefs: [...delivery.result.outputRefs],
        }),
        outputRefs: [...delivery.result.outputRefs],
        evidenceRefs: boundedEvidence(scope, 'child-return', delivery.result.evidenceRefs),
        status: 'succeeded',
      };
    }
    return {
      output: JSON.stringify({
        state: 'returned',
        kind: 'review',
        invocationId: delivery.invocationId,
        status: delivery.result.status,
        findings: delivery.result.findings.length,
      }),
      outputRefs: [`child:${delivery.invocationId}`],
      evidenceRefs: boundedEvidence(scope, 'child-review-return', delivery.result.evidenceRefs),
      status: 'succeeded',
    };
  }

  function callResult(
    result: IndependentChildCallResult,
    scope: ScopeRef,
  ): ProviderToolExecutionResult {
    if (result.state === 'returned' && result.kind === 'execution') {
      return {
        output: JSON.stringify({
          state: 'returned',
          kind: 'execution',
          invocationId: result.invocationId,
          incarnation: result.incarnation,
          status: result.result.status,
          summary: result.result.summary.slice(0, MAX_REFINED_CHARS),
          outputRefs: [...result.result.outputRefs],
        }),
        outputRefs: [...result.result.outputRefs],
        evidenceRefs: boundedEvidence(scope, 'child-return', result.result.evidenceRefs),
        status: 'succeeded',
      };
    }
    if (result.state === 'returned' && result.kind === 'review') {
      return {
        output: JSON.stringify({
          state: 'returned',
          kind: 'review',
          invocationId: result.invocationId,
          incarnation: result.incarnation,
          status: result.delivery.result.status,
          findings: result.delivery.result.findings.length,
        }),
        outputRefs: [`child:${result.invocationId}`],
        evidenceRefs: boundedEvidence(scope, 'child-review-return', result.delivery.result.evidenceRefs),
        status: 'succeeded',
      };
    }
    const issue = (result as Extract<IndependentChildCallResult, { readonly state: 'waiting' | 'blocked' }>).issue;
    return {
      output: JSON.stringify({
        state: result.state,
        invocationId: result.invocationId,
        reason: issue.reason,
        nextAction: issue.nextAction,
      }),
      outputRefs: [],
      evidenceRefs: boundedEvidence(scope, 'child-held', issue.evidenceRefs),
      status: 'blocked',
    };
  }

  async function resolveReviewSource(
    subjectInvocationId: string,
  ): Promise<{ readonly worker: WorkAssignment; readonly result: WorkResult }> {
    const delivery = findDelivery(parent, subjectInvocationId);
    if (!delivery || delivery.kind !== 'execution') {
      throw new Error(`review subject invocation ${subjectInvocationId} has no retained execution delivery`);
    }
    return { worker: delivery.assignment, result: delivery.result };
  }

  async function dispatchCall(request: Parameters<ProviderToolExecutionPort['execute']>[0]): Promise<ProviderToolExecutionResult> {
    if (request.requestId === undefined || request.requestId.trim() === '') {
      throw new Error('child call requires the accepted Provider requestId');
    }
    const parsed = parseChildCallRequest(request.call.arguments);
    const selected = selectRosterEntry(roster, parsed.agentId);
    const invocationId = appChildInvocationId({
      turnId,
      parentExecution: request.execution,
      providerRequestId: request.requestId,
      toolCallId: request.call.callId,
    });
    const operationId = childOperationId(invocationId);
    const receipt = await input.admitChildOperation({
      invocationId,
      childOperationId: operationId,
      kind: parsed.kind,
      selected: { agentId: selected.agentId, roleId: selected.roleId },
      parentExecution: request.execution,
      scope: request.scope,
      providerRequestId: request.requestId,
      toolCallId: request.call.callId,
    });
    const call: RegisteredParentChildCall = {
      invocationId,
      parentExecution: request.execution,
      providerRequestId: request.requestId,
      toolCallId: request.call.callId,
      businessRegistrationCommitRef: receipt.businessRegistrationCommitRef,
    };
    const prepareProvider = (selection: { readonly roleId: AgentRole; readonly configuredAgentId: string }) =>
      input.prepareAgentProvider(selection);

    return parent.runProducer(async (): Promise<ProviderToolExecutionResult> => {
      const existing = parent.childInvocations().find((record) => record.invocationId === invocationId);
      if (existing) {
        const delivery = findDelivery(parent, invocationId);
        if (!delivery) {
          // The pre-call anchor exists with no durable return: the external child
          // outcome is unknown. Retain it; never replay automatically.
          return {
            output: JSON.stringify({ state: 'blocked', invocationId, reason: 'child outcome unknown; recovery retained' }),
            outputRefs: [],
            evidenceRefs: [scopedEvidence(request.scope, 'child-unknown-held')],
            status: 'blocked',
          };
        }
        if (delivery.kind === 'review' && existing.postReviewCheckpointRef === undefined) {
          const source = await resolveReviewSource(parsed.kind === 'review' ? parsed.subjectInvocationId : '');
          await input.checkpoints.post({
            call,
            returned: {
              kind: 'review',
              invocationId,
              assignment: delivery.assignment,
              result: delivery.result,
              scope: request.scope,
            },
            worker: source.worker,
          }).then((committed) => parent.recordReviewCheckpoint(invocationId, committed.checkpoint.id.value));
        }
        return returnResult(delivery, request.scope);
      }

      if (parsed.kind === 'execution') {
        const assignment = buildExecutionAssignment({
          request: parsed,
          childOperationId: operationId,
          taskId: input.parentAssignment.taskId,
          inputRevision: input.parentAssignment.inputRevision,
          executionEpoch: parentExecutionEpoch,
          requiredCapabilities: input.parentAssignment.requiredCapabilities,
        });
        const executionAgent = createConfiguredExecutionAgent({
          call,
          operation: receipt,
          selected,
          prepareAgentProvider: prepareProvider,
          ...(input.now === undefined ? {} : { now: input.now }),
        });
        const result = await input.manager.callChild({
          kind: 'execution',
          call,
          agentId: selected.agentId,
          scope: request.scope,
          childCallPort: makeChildCallPort(call, assignment),
          signal: request.signal,
          assignment,
          executionAgent,
        });
        return callResult(result, request.scope);
      }

      const source = await resolveReviewSource(parsed.subjectInvocationId);
      const subjects = source.worker.targetRefs.map((ref, index) => ({
        ref,
        body: source.result.producedArtifactBodies?.[index] ?? '',
      }));
      const reviewMaterial = resolveReviewMaterial({
        workerAssignment: source.worker,
        workerResult: source.result,
        subjects,
      });
      const reviewAssignment = createReviewAssignments({
        workerAssignment: source.worker,
        workerResult: source.result,
        reviewKinds: [parsed.reviewKind],
        subjectRefs: source.worker.targetRefs,
        subjectDigests: source.result.producedArtifactDigests,
      })[0];
      if (reviewAssignment === undefined) throw new Error('review assignment could not be constructed');
      const reviewAgent = createConfiguredReviewAgent({
        call,
        operation: receipt,
        selected,
        prepareAgentProvider: prepareProvider,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      const result = await input.manager.callChild({
        kind: 'review',
        call,
        agentId: selected.agentId,
        scope: request.scope,
        childCallPort: makeChildCallPort(call, source.worker),
        signal: request.signal,
        input: {
          reviewAssignment,
          workerAssignment: source.worker,
          workerResult: source.result,
          reviewMaterial,
          scope: request.scope,
          signal: request.signal,
        },
        reviewAgent,
      });
      return callResult(result, request.scope);
    });
  }

  async function dispatchAdopt(request: Parameters<ProviderToolExecutionPort['execute']>[0]): Promise<ProviderToolExecutionResult> {
    const invocationId = readInvocationSelector(request.call.arguments);
    return parent.runProducer(async (): Promise<ProviderToolExecutionResult> => {
      const delivery = findDelivery(parent, invocationId);
      if (!delivery) throw new Error(`child invocation ${invocationId} has no durable delivery to adopt`);
      parent.assertProductionOpen();
      await parent.recordChildAdoption(invocationId, delivery);
      return {
        output: JSON.stringify({ state: 'adopted', invocationId, kind: delivery.kind }),
        outputRefs: [],
        evidenceRefs: [scopedEvidence(request.scope, `child-adopted-${delivery.kind}`)],
        status: 'succeeded',
      };
    });
  }

  async function dispatchNotSelect(request: Parameters<ProviderToolExecutionPort['execute']>[0]): Promise<ProviderToolExecutionResult> {
    const invocationId = readInvocationSelector(request.call.arguments);
    return parent.runProducer(async (): Promise<ProviderToolExecutionResult> => {
      parent.assertProductionOpen();
      await parent.recordChildNonSelection(invocationId);
      return {
        output: JSON.stringify({ state: 'not-selected', invocationId }),
        outputRefs: [],
        evidenceRefs: [scopedEvidence(request.scope, 'child-not-selected')],
        status: 'succeeded',
      };
    });
  }

  return {
    async execute(request: Parameters<ProviderToolExecutionPort['execute']>[0]): Promise<ProviderToolExecutionResult> {
      const toolId: ProviderToolCall['toolId'] = request.call.toolId;
      if (toolId === APP_CHILD_CALL_TOOL.toolId) return dispatchCall(request);
      if (toolId === APP_CHILD_ADOPT_TOOL.toolId) return dispatchAdopt(request);
      if (toolId === APP_CHILD_NOT_SELECT_TOOL.toolId) return dispatchNotSelect(request);
      throw new Error(`child producer cannot route unknown tool ${toolId}`);
    },
  };
}

// Re-exported for consumers that must bind the same child operation identity.
export { childOperationId as appChildOperationId };
