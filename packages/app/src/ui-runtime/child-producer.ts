import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  id,
  REVIEW_KIND_WHITELIST,
  REVIEW_STATUS_WHITELIST,
  REVIEW_SEVERITY_WHITELIST,
  type AcceptedChildDelivery,
  type AgentEvent,
  type ActiveTurnProviderExecutionIdentityRef,
  type BusinessPayload,
  type ChildCallBinding,
  type ChildInvocationRecord,
  type EvidenceRef,
  type OperationId,
  type OperationResult,
  type ProviderExecutionIdentityRef,
  type ProviderSettlement,
  type ProviderToolDefinition,
  type RawAsset,
  type ReviewAssignment,
  type ReviewKind,
  type ReviewOutput,
  type ReviewResult,
  type ReviewFinding,
  type ReviewSeverity,
  type ReviewStatus,
  type ScopeRef,
  type ProviderTerminalState,
  type ProviderProducerDrainResult,
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
  TaskRuntimeIncarnation,
} from '../../../runtime/src/orchestration/types.js';
import type { OrchestrationManager } from '../../../runtime/src/orchestration/manager.js';
import {
  acceptanceCriteriaContent,
  digestOf,
  assertReviewMaterial,
  resolveReviewMaterial,
  type ReviewMaterial,
} from '../../../runtime/src/orchestration/review-material.js';
import { createReviewAssignments } from '../../../runtime/src/review/index.js';
import type { CommittedCheckpointRecord } from '../../../runtime/src/checkpoints/ports.js';
import type { RefinedDeliveryStore } from '../../../runtime/src/ui-runtime/coordinator.js';
import type { ActiveTurnContext, ActiveTurnSegmentContext } from '../../../runtime/src/context/active-turn-context.js';
import { ProviderAgentDriver } from '../../../adapters/provider/src/index.js';
import type { ProviderToolExecutionResult } from '../../../adapters/provider/src/index.js';
import type { ProviderToolExecutionPort } from '../../../adapters/provider/src/index.js';
import type { ProviderAgentDriverOptions } from '../../../adapters/provider/src/agent-driver.js';
import { closeAgentProvider, type AgentProviderComposition } from '../agent-driver-composition.js';
import type { AgentRole } from '../../../config/src/index.js';
import type { ToolOperationAdmissionReceipt } from './execution-admission.js';
import type { StandardTurnEndOwnerPort } from './standard-turn-control.js';
import { createStandardTurnEndExecutor } from './standard-turn-control.js';
import {
  ADVERTISED_STANDARD_TURN_END_TOOL,
  createStandardTurnEndWireExecutor,
  isStandardTurnEndCall,
} from './standard-turn-composition.js';
import type { StandardTurnEndCommand } from '../../../contracts/src/standard-turn-end.js';

const OWNER = 'humanagent.app.child-producer';

const MAX_PURPOSE = 2000;
const MAX_INSTRUCTIONS = 8000;
const MAX_CRITERIA_ITEMS = 8;
const MAX_CRITERIA_ITEM = 500;
const MAX_TARGET_REF = 256;
const MAX_INVOCATION_REF = 256;
const MAX_REFINED_CHARS = 8000;
const MAX_CHILD_REQUESTS = 8;
/** The delivery body must support a real result well past the refined summary bound. */
const MAX_DELIVERY_CHARS = 2_000_000;

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
 * The real semantic delivery action of one independent child. It writes the
 * complete business body as an immutable asset and reads the exact bytes back.
 * It never sets a completion flag and never ends the turn; the standard end
 * action owns that, separately.
 *
 * The model owns only the business content: the delivery body, the review
 * judgment and findings, and which of this child's own accepted evidence refs
 * support the body. Kind, scope, invocation, assignment, criteria/subject
 * digests, Provider identity and the asset target are bound by this module.
 */
export const APP_CHILD_DELIVER_TOOL: ProviderToolDefinition = {
  toolId: 'humanagent_child_deliver',
  description: [
    'Deliver one child result for the bounded assignment you received.',
    'Put the complete final body in "body", and the evidenceId or locator of each piece of your own accepted evidence that supports it in "evidenceRefs".',
    'For a review also state the business "judgment" (passed, failed or inconclusive) and the concrete findings.',
    'The delivery must stand on its own: no summary, ref or digest substitutes for the body. This action records the delivery only; ending this turn is a separate action.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['body'],
    properties: {
      body: { type: 'string', minLength: 1 },
      judgment: { type: 'string', enum: ['passed', 'failed', 'inconclusive'] },
      findings: {
        type: 'array',
        maxItems: MAX_CRITERIA_ITEMS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['detail', 'evidenceRefs'],
          properties: {
            detail: { type: 'string', minLength: 1 },
            severity: { type: 'string', enum: [...REVIEW_SEVERITY_WHITELIST] },
            locationRef: { type: 'string', minLength: 1, maxLength: MAX_TARGET_REF },
            evidenceRefs: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1, maxLength: MAX_TARGET_REF },
            },
          },
        },
      },
      evidenceRefs: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1, maxLength: MAX_TARGET_REF },
      },
    },
  },
};

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
  readonly bodyAssets: ChildBodyAssetPort;
  readonly bindChildRun: BindChildRunPort;
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
  readonly bodyAssets: ChildBodyAssetPort;
  readonly bindChildRun: BindChildRunPort;
  readonly prepareAgentProvider: (selection: {
    readonly roleId: AgentRole;
    readonly configuredAgentId: string;
  }) => Promise<AgentProviderComposition>;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Native child ABI (accepted creator plan §4). Frozen type seam for the
// independent child binder; admission wiring and body assets land in later
// implementation steps.
// ---------------------------------------------------------------------------

export type ChildDriverNativePorts = Required<
  Pick<
    ProviderAgentDriverOptions,
    'rawEvidence' | 'acceptRawFact' | 'registerRequest' | 'requestContext'
  >
>;

export type ChildCreatorRequest =
  | { readonly kind: 'execution'; readonly input: ExecutionAgentInput }
  | { readonly kind: 'review'; readonly input: ReviewAgentInput };

/**
 * Narrow control-lifecycle seam for one real child run. The existing child run
 * composition owns the typed Gateway append; the producer only calls it at the
 * real admission, submit and settlement points. It never exposes the Gateway or
 * journal to a model tool, and it never invents control facts.
 */
export interface ChildControlLifecyclePort {
  /** Commit the child registration after real business admission, before any effect. */
  accept(): Promise<void>;
  /** Commit the running state from the actual submit receipt. */
  running(input: { readonly evidenceRefs: readonly EvidenceRef[] }): Promise<void>;
  /** Commit the terminal state from the actual drain/settle/close outcome. */
  settle(input: {
    readonly status: 'succeeded' | 'failed' | 'cancelled' | 'blocked';
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly result?: OperationResult;
  }): Promise<void>;
}

export interface BoundChildRun {
  readonly native: ChildDriverNativePorts;
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly toolExecution: ProviderToolExecutionPort;
  readonly maxToolRounds?: number;
  readonly standardEndOwner: StandardTurnEndOwnerPort;
  readonly control: ChildControlLifecyclePort;
}

export type BindChildRunPort = (input: {
  readonly call: RegisteredParentChildCall;
  readonly operation: ToolOperationAdmissionReceipt;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly scope: ScopeRef;
  readonly request: ChildCreatorRequest;
}) => Promise<BoundChildRun>;

export interface ChildBodyAssetPort {
  target(input: {
    readonly scope: ScopeRef;
    readonly invocationId: string;
    readonly kind: 'execution' | 'review';
  }): string;
  write(input: {
    readonly scope: ScopeRef;
    readonly invocationId: string;
    readonly kind: 'execution' | 'review';
    readonly body: string;
  }): Promise<RawAsset>;
  read(asset: RawAsset): Promise<Uint8Array>;
}

/**
 * One delivery the child itself produced. The body is the complete business
 * result; the reference is the immutable asset that actually holds it.
 */
export interface ChildDeliveryRecord {
  readonly kind: 'execution' | 'review';
  readonly invocationId: string;
  readonly body: string;
  readonly asset: RawAsset;
  readonly digest: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly judgment?: ReviewStatus;
  readonly findings: readonly ReviewFinding[];
}

/** What one independent child run can honestly end as. */
export type ChildRunOutcome =
  | { readonly state: 'delivered'; readonly events: readonly AgentEvent[] }
  | { readonly state: 'incomplete'; readonly events: readonly AgentEvent[]; readonly reason: string }
  | { readonly state: 'preserved'; readonly events: readonly AgentEvent[]; readonly reason: string }
  | { readonly state: 'failed'; readonly events: readonly AgentEvent[]; readonly reason: string };

/**
 * Mutable holder the creator installs into a run. The delivery tool records the
 * real delivery here; the standard-end owner records the accepted control
 * command. Neither the model nor a caller can fill either one from outside, so
 * a candidate can only exist when this child actually did both.
 */
interface ChildRunState {
  delivery?: ChildDeliveryRecord;
  acceptedCommand?: StandardTurnEndCommand;
  driver?: ProviderAgentDriver;
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

/**
 * Only the evidence this child actually accepted. A lifecycle summary is not
 * evidence and an empty set stays empty: no locator is invented so a
 * non-delivery can read as delivered.
 */
function acceptedEvidenceRefs(
  events: readonly AgentEvent[],
  settlement: ProviderSettlement | undefined,
): readonly EvidenceRef[] {
  const refs = [
    ...events.flatMap((event) => event.evidenceRefs),
    ...(settlement?.evidenceRefs ?? []),
  ];
  const seen = new Set<string>();
  const unique: EvidenceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.evidenceId.value)) continue;
    seen.add(ref.evidenceId.value);
    unique.push(ref);
  }
  return unique;
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
 * The real independent child run. It drives one child driver bound to the
 * child's own native raw/registration/request-context ports, its own tool
 * definitions and executor, and its own standard-end owner. It inherits no
 * parent hook, transcript, tool surface or lifecycle callback.
 *
 * The loop covers the whole observation of every request, so tool execution,
 * the tool follow-up request and request-level bookkeeping all complete. A
 * normal request terminal with no accepted standard end continues this same
 * child turn. An EOF, an unknown terminal, an error or a cancellation is kept as
 * its own outcome and is never replayed here.
 *
 * Nothing in this function marks the business done. A candidate exists only
 * after the caller has closed production, drained the real producer and settled.
 */
async function runIndependentChild(input: {
  readonly composition: AgentProviderComposition;
  readonly run: BoundChildRun;
  readonly state: ChildRunState;
  readonly collect: (event: AgentEvent) => void;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly operationId: OperationId;
  readonly assignmentId: string;
  readonly scope: ScopeRef;
  readonly inputRefs: readonly string[];
  readonly payload: BusinessPayload;
  readonly signal: AbortSignal;
  readonly maxRequests: number;
  readonly now?: () => Date;
}): Promise<ChildRunOutcome> {
  const runtimeId = input.incarnation.runtimeId;
  const taskId = input.incarnation.taskId;
  const executionEpoch = input.incarnation.executionEpoch;
  const events: AgentEvent[] = [];
  let terminalState: ProviderTerminalState | undefined;
  let terminalError: string | undefined;
  let requests = 0;
  const driver = new ProviderAgentDriver({
    port: input.composition.port,
    binding: input.composition.binding,
    runtimeId,
    taskId,
    operationId: input.operationId,
    executionEpoch,
    assignmentId: input.assignmentId,
    scope: input.scope,
    inputRefs: [...input.inputRefs],
    ownerId: OWNER,
    ...input.run.native,
    tools: input.run.toolDefinitions,
    executeTool: input.run.toolExecution,
    ...(input.run.maxToolRounds === undefined ? {} : { maxToolRounds: input.run.maxToolRounds }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  input.state.driver = driver;
  try {
    await driver.start({
      runtimeId,
      taskId,
      executionEpoch,
      assignmentId: input.assignmentId,
      organId: input.scope.organId,
      ...(input.scope.cycleId === undefined ? {} : { cycleId: input.scope.cycleId }),
      operationId: input.operationId,
    });
    const submitted = await driver.submit({
      taskId,
      executionEpoch,
      assignmentId: input.assignmentId,
      payload: input.payload,
    });
    await input.run.control.running({ evidenceRefs: submitted.evidenceRefs });
    requests = 1;
    while (true) {
      input.signal.throwIfAborted();
      terminalState = undefined;
      terminalError = undefined;
      for await (const event of driver.observe({ runtimeId })) {
        events.push(event);
        input.collect(event);
        if (event.providerEvent.kind === 'error') {
          terminalState = 'failed';
          terminalError = event.providerEvent.error?.message ?? 'the child provider emitted an error event';
        }
        if (event.terminalState !== undefined) terminalState = event.terminalState;
      }
      if (terminalState === 'succeeded') {
        if (input.state.acceptedCommand !== undefined) {
          return { state: 'delivered', events };
        }
        if (requests >= input.maxRequests) {
          return {
            state: 'incomplete',
            events,
            reason: `the child turn produced no legal delivery after ${requests} requests`,
          };
        }
        await driver.continueCurrentTurn({
          instructions: { text: reorientationInstructions(input.scope) },
        });
        requests += 1;
        continue;
      }
      if (terminalState === 'failed') {
        return { state: 'failed', events, reason: terminalError ?? 'the child request failed' };
      }
      return {
        state: 'preserved',
        events,
        reason: `the child request ended ${terminalState ?? 'without a terminal'}; recovery responsibility is retained and nothing is replayed`,
      };
    }
  } catch (error) {
    const preserved = isAbort(error) || input.signal.aborted;
    try {
      await driver.settle({ runtimeId, executionEpoch });
    } catch (settleError) {
      throw new AggregateError(
        [error, settleError],
        'independent child call failed and its own settlement also failed',
      );
    }
    if (preserved) {
      return {
        state: 'preserved',
        events,
        reason: 'the child call was cancelled; recovery responsibility is retained and nothing is replayed',
      };
    }
    return { state: 'failed', events, reason: error instanceof Error ? error.message : String(error) };
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Transient orientation for this child turn only. It enters this one request
 * and is never written back to canonical context or carried to a new turn.
 */
function reorientationInstructions(scope: ScopeRef): string {
  void scope;
  return [
    'This child turn is still open and no delivery has been accepted yet.',
    'Do the bounded work with the tools you were given, then record the complete result with the delivery tool.',
    'A summary, a reference or a digest is not a delivery: the delivery body must be the complete final result on its own.',
    'Only after a legal delivery is recorded, end this turn with the standard end action.',
  ].join(' ');
}

function executionPrompt(assignment: WorkAssignment): string {
  return [
    'You are one independent HumanAgent child execution for a single bounded assignment.',
    'You receive only the bounded instructions and criteria below. Do not assume any parent transcript.',
    `Objective: ${assignment.objective}`,
    `Success criteria: ${assignment.successCriteria.join('; ')}`,
    ...(assignment.failureCriteria.length === 0 ? [] : [`Failure criteria: ${assignment.failureCriteria.join('; ')}`]),
    ...(assignment.incompleteCriteria.length === 0 ? [] : [`Incomplete criteria: ${assignment.incompleteCriteria.join('; ')}`]),
    'Use the tools you were given for the real work, then record the complete result with the delivery tool, and end this turn with the standard end action.',
  ].join('\n');
}

function reviewPrompt(assignment: ReviewAssignment, material: ReviewMaterial): string {
  return [
    'You are one independent HumanAgent child reviewer for a single bounded review.',
    'Evaluate the acceptance criteria against each subject body. A subject body is the artifact under review; a summary, ref or digest is never a substitute for it.',
    `Review kind: ${assignment.reviewKind}`,
    `Acceptance criteria: ${material.acceptanceCriteria}`,
    ...material.subjects.map((subject, index) => `Subject ${index + 1} (${subject.ref}):\n${subject.body}`),
    'Record the complete review text as the delivery body, the business judgment, and each concrete finding together with the evidence that supports it.',
  ].join('\n');
}


/**
 * The owner-bound delivery tool. It resolves the model's evidence selectors
 * against the evidence this child actually accepted, writes the complete body
 * immutably, reads the exact bytes back, and only then records the delivery.
 * A selector that does not resolve to this child's own accepted evidence
 * rejects; no fallback locator is constructed.
 */
function createChildDeliveryExecutor(input: {
  readonly kind: 'execution' | 'review';
  readonly state: ChildRunState;
  readonly invocationId: string;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly scope: ScopeRef;
  readonly bodyAssets: ChildBodyAssetPort;
  readonly acceptedEvidence: () => readonly EvidenceRef[];
}): ProviderToolExecutionPort {
  return {
    async execute(request): Promise<ProviderToolExecutionResult> {
      if (request.execution.runtimeId !== input.incarnation.runtimeId
        || request.execution.executionEpoch !== input.incarnation.executionEpoch
        || request.execution.taskId.value !== input.incarnation.taskId.value) {
        throw new Error('child delivery must be executed by this child provider request');
      }
      const args = request.call.arguments;
      const body = readBoundedString(args.body, 'child delivery body', MAX_DELIVERY_CHARS, true);
      if (body.trim() === '') throw new Error('child delivery body must not be blank');
      const selectors = readBoundedStringArray(
        args.evidenceRefs, 'child delivery evidenceRefs', MAX_CRITERIA_ITEMS, MAX_TARGET_REF, false,
      );
      const judgment = input.kind === 'review' ? readReviewJudgment(args.judgment) : undefined;
      if (input.kind === 'execution' && (args.judgment !== undefined || args.findings !== undefined)) {
        throw new Error('an execution delivery carries no review judgment or findings');
      }
      const candidateFindings = input.kind === 'review' ? parseReviewFindingSelectors(args.findings) : [];
      const byReference = new Map<string, EvidenceRef>();
      for (const ref of input.acceptedEvidence()) {
        byReference.set(ref.evidenceId.value, ref);
        byReference.set(ref.locator, ref);
      }
      const resolve = (selector: string): EvidenceRef => {
        const match = byReference.get(selector);
        if (match === undefined) {
          throw new Error(`child delivery evidence ${selector} is not accepted evidence of this child`);
        }
        return match;
      };
      const evidenceRefs = selectors.map(resolve);
      const findings = candidateFindings.map((finding) => ({
        findingId: `child-finding:${sha256Hex(`${finding.detail}\n${finding.locationRef}\n${finding.evidenceRefs.join('\n')}`)}`,
        severity: finding.severity,
        locationRef: finding.locationRef,
        problem: finding.detail,
        expected: finding.detail,
        evidenceRefs: finding.evidenceRefs.map(resolve),
      }));
      const asset = await input.bodyAssets.write({
        scope: input.scope,
        invocationId: input.invocationId,
        kind: input.kind,
        body,
      });
      const readBack = new TextDecoder().decode(await input.bodyAssets.read(asset));
      if (readBack !== body) throw new Error('child delivery asset readback does not match the written body');
      const digest = digestOf(body);
      if (asset.ref.digest !== undefined && asset.ref.digest !== digest) {
        throw new Error('child delivery asset digest does not match the written body');
      }
      input.state.delivery = {
        kind: input.kind,
        invocationId: input.invocationId,
        body,
        asset,
        digest,
        evidenceRefs,
        ...(judgment === undefined ? {} : { judgment }),
        findings,
      };
      return {
        output: JSON.stringify({
          owner: OWNER,
          state: 'delivered',
          kind: input.kind,
          digest,
          bytes: body.length,
          ...(judgment === undefined ? {} : { judgment }),
          findings: findings.length,
        }),
        outputRefs: [asset.ref.locator],
        outputRef: asset.ref.locator,
        outputDigest: digest,
        evidenceRefs: [asset.ref, ...evidenceRefs, ...findings.flatMap((finding) => finding.evidenceRefs)],
        status: 'succeeded',
        executorRoute: APP_CHILD_DELIVER_TOOL.toolId,
      };
    },
  };
}

interface ReviewFindingSelectors {
  readonly detail: string;
  readonly severity: ReviewSeverity;
  readonly locationRef: string;
  readonly evidenceRefs: readonly string[];
}

function readReviewJudgment(value: unknown): ReviewStatus {
  if (typeof value !== 'string' || !REVIEW_STATUS_WHITELIST.includes(value as ReviewStatus)) {
    throw new Error('child review delivery judgment must be passed, failed or inconclusive');
  }
  return value as ReviewStatus;
}

function parseReviewFindingSelectors(value: unknown): readonly ReviewFindingSelectors[] {
  if (value === undefined || value === null) {
    throw new Error('a review delivery must state its concrete findings');
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('a review delivery must state its concrete findings');
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`child review delivery finding ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    const detail = readBoundedString(candidate.detail, `finding ${index} detail`, MAX_DELIVERY_CHARS, true);
    const severityRaw = readBoundedString(candidate.severity, `finding ${index} severity`, 32, false);
    if (!REVIEW_SEVERITY_WHITELIST.includes(severityRaw as ReviewSeverity)) {
      throw new Error(`finding ${index} severity must be a registered review severity`);
    }
    const locationRef = readBoundedString(candidate.locationRef, `finding ${index} locationRef`, MAX_TARGET_REF, false);
    return {
      detail,
      severity: severityRaw as ReviewSeverity,
      locationRef: locationRef === '' ? `finding:${index}` : locationRef,
      evidenceRefs: readBoundedStringArray(
        candidate.evidenceRefs, `finding ${index} evidenceRefs`, MAX_CRITERIA_ITEMS, MAX_TARGET_REF, true,
      ),
    };
  });
}

/**
 * A bounded summary of the real body, never the body itself. The complete body
 * stays in the immutable asset and is what every consumer reads back.
 */
function boundedSummary(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') throw new Error('a child delivery body must not be empty');
  return trimmed.length <= MAX_REFINED_CHARS ? trimmed : `${trimmed.slice(0, MAX_REFINED_CHARS)}...`;
}

function executionResult(input: {
  readonly delivery: ChildDeliveryRecord;
  readonly assignment: WorkAssignment;
  readonly agentId: string;
  readonly events: readonly AgentEvent[];
}): WorkResult {
  return {
    taskId: input.assignment.taskId,
    pipelineNodeId: input.assignment.pipelineNodeId,
    agentId: input.agentId,
    assignmentId: input.assignment.assignmentId,
    attempt: input.assignment.attempt,
    executionEpoch: input.assignment.executionEpoch,
    inputRevision: input.assignment.inputRevision,
    summary: boundedSummary(input.delivery.body),
    evidenceRefs: [...input.delivery.evidenceRefs, ...acceptedEvidenceRefs(input.events, undefined)],
    nextAction: 'review',
    producedArtifactRefs: [input.delivery.asset.ref.locator],
    producedArtifactDigests: [input.delivery.digest],
    producedArtifactBodies: [input.delivery.body],
    status: 'succeeded',
    // The declared business target is what the assignment promised. The
    // produced artifact is the immutable asset the child actually wrote.
    outputRefs: [...input.assignment.expectedOutputRefs],
  };
}

function reviewResult(input: {
  readonly delivery: ChildDeliveryRecord;
  readonly assignment: ReviewAssignment;
  readonly agentId: string;
  readonly events: readonly AgentEvent[];
}): ReviewResult {
  if (input.delivery.judgment === undefined) {
    throw new Error('a review delivery must carry its business judgment');
  }
  return {
    resultId: `review-result:${input.agentId}:${input.assignment.assignmentId}`,
    assignmentId: input.assignment.assignmentId,
    taskId: input.assignment.taskId,
    workerAgentId: input.assignment.workerAgentId,
    reviewKind: input.assignment.reviewKind,
    attempt: input.assignment.attempt,
    executionEpoch: input.assignment.executionEpoch,
    inputRevision: input.assignment.inputRevision,
    acceptanceCriteriaDigest: input.assignment.acceptanceCriteriaDigest,
    subjectRefs: [...input.assignment.subjectRefs],
    subjectDigests: [...input.assignment.subjectDigests],
    status: input.delivery.judgment,
    findings: input.delivery.findings,
    evidenceRefs: [...input.delivery.evidenceRefs, ...acceptedEvidenceRefs(input.events, undefined)],
  };
}

/**
 * A real run is only resolved after the caller has closed production, drained
 * the real producer and settled. `blocked` keeps the primary issue visible;
 * `returned` carries the real result.
 */
type RunResolvedOutcome =
  | { readonly state: 'returned'; readonly result: WorkResult | ReviewAgentDelivery }
  | { readonly state: 'blocked'; readonly reason: string };

/**
 * The success gate. Every one of these must hold:
 *
 * 1. the child turn ended normally with an accepted standard end action,
 * 2. that action cites this child's real delivery,
 * 3. the complete body is physically readable back and still matches,
 * 4. the Provider settlement really succeeded,
 * 5. the producer was drained and the composition closed.
 *
 * A Provider finish, a settlement state, a declared target ref or a delivery
 * without an accepted standard end never produces a candidate.
 */
async function resolveRunOutcome(input: {
  readonly kind: 'execution' | 'review';
  readonly state: ChildRunState;
  readonly outcome: ChildRunOutcome;
  readonly assignment: WorkAssignment;
  readonly reviewAssignment?: ReviewAssignment;
  readonly agentId: string;
  readonly bodyAssets: ChildBodyAssetPort;
  readonly settlement: ProviderSettlement | undefined;
  readonly drained: boolean;
  readonly closed: boolean;
  readonly now?: () => Date;
}): Promise<RunResolvedOutcome> {
  const blocked = (reason: string): RunResolvedOutcome => ({ state: 'blocked', reason });
  if (input.outcome.state !== 'delivered') return blocked(input.outcome.reason);
  const command = input.state.acceptedCommand;
  if (command === undefined) return blocked('the child turn has no accepted standard end action');
  const delivery = input.state.delivery;
  if (delivery === undefined) return blocked('the child turn produced no delivery');
  const cited = new Set(command.deliveryRefs);
  if (!cited.has(delivery.asset.ref.locator) && !cited.has(delivery.asset.ref.evidenceId.value)) {
    return blocked('the accepted standard end does not cite this child delivery');
  }
  if (!command.resolvedEvidenceRefs.some((ref) => ref.evidenceId.value === delivery.asset.ref.evidenceId.value)) {
    return blocked('the accepted standard end did not resolve this child delivery asset');
  }
  if (input.settlement === undefined) return blocked('the child exposed no Provider settlement');
  if (input.settlement.state !== 'succeeded') {
    return blocked(`the child Provider settlement was ${input.settlement.state}`);
  }
  if (!input.drained) return blocked('the child producer was not drained');
  if (!input.closed) return blocked('the child Provider composition was not closed');
  const readBack = new TextDecoder().decode(await input.bodyAssets.read(delivery.asset));
  if (readBack !== delivery.body) return blocked('the delivered body does not read back exactly');
  if (digestOf(readBack) !== delivery.digest) return blocked('the delivered body digest drifted');
  if (delivery.digest !== digestOf(delivery.body)) return blocked('the delivered body digest does not match its asset');
  if (input.kind === 'execution') {
    return {
      state: 'returned',
      result: executionResult({
        delivery,
        assignment: input.assignment,
        agentId: input.agentId,
        events: input.outcome.events,
      }),
    };
  }
  if (input.reviewAssignment === undefined) return blocked('a review resolution needs its real assignment');
  return {
    state: 'returned',
    result: {
      result: reviewResult({
        delivery,
        assignment: input.reviewAssignment,
        agentId: input.agentId,
        events: input.outcome.events,
      }),
      // The complete review body travels with the durable return; it is never
      // replaced by the status or the findings alone.
      output: {
        text: delivery.body,
        artifactRef: delivery.asset.ref.locator,
        artifactDigest: delivery.digest,
      },
      completedAt: (input.now?.() ?? new Date()).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Configured independent creators
// ---------------------------------------------------------------------------

function createCompositionCloser(): { hold(composition: AgentProviderComposition): void; close(): Promise<boolean> } {
  let pending: AgentProviderComposition | undefined;
  let closed = false;
  return {
    hold(composition) { pending = composition; closed = false; },
    async close() {
      const current = pending;
      pending = undefined;
      if (current === undefined) return true;
      if (closed) return true;
      closed = true;
      // closeAgentProvider throws when the close is not complete, so a
      // resolved close is a real closed composition.
      await closeAgentProvider(current);
      return true;
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
 * Assembles the child's own tool surface: the delivery action and the standard
 * end action on top of the admitted tools the binder resolved for this child.
 * Neither action completes the business; each one records what it really did.
 */
function childToolSurface(input: {
  readonly run: BoundChildRun;
  readonly state: ChildRunState;
  readonly invocationId: string;
  readonly kind: 'execution' | 'review';
  readonly scope: ScopeRef;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly bodyAssets: ChildBodyAssetPort;
  readonly acceptedEvidence: () => readonly EvidenceRef[];
}): {
  readonly toolDefinitions: readonly ProviderToolDefinition[];
  readonly toolExecution: ProviderToolExecutionPort;
} {
  const endExecutor = createStandardTurnEndWireExecutor(
    input.run.standardEndOwner,
    createStandardTurnEndExecutor({
      owner: input.run.standardEndOwner,
      // The route only records the accepted typed control event. It never
      // settles, drains or builds a result here.
      route: (command: StandardTurnEndCommand) => { input.state.acceptedCommand = command; },
    }),
  );
  const delivery = createChildDeliveryExecutor({
    kind: input.kind,
    state: input.state,
    invocationId: input.invocationId,
    incarnation: input.incarnation,
    scope: input.scope,
    bodyAssets: input.bodyAssets,
    acceptedEvidence: input.acceptedEvidence,
  });
  const existingToolIds = new Set(input.run.toolDefinitions.map((tool) => tool.toolId));
  const additions = [APP_CHILD_DELIVER_TOOL, ADVERTISED_STANDARD_TURN_END_TOOL]
    .filter((tool) => !existingToolIds.has(tool.toolId));
  return {
    toolDefinitions: [...input.run.toolDefinitions, ...additions],
    toolExecution: {
      async execute(request) {
        if (request.call.toolId === APP_CHILD_DELIVER_TOOL.toolId) return delivery.execute(request);
        if (isStandardTurnEndCall(request.call.toolId)) return endExecutor.execute(request);
        return input.run.toolExecution.execute(request);
      },
    },
  };
}

interface ConfiguredChildRunInput {
  readonly input: ConfiguredChildAgentInput;
  readonly composition: AgentProviderComposition;
  readonly closer: { close(): Promise<boolean> };
  readonly state: ChildRunState;
  readonly run: BoundChildRun;
  readonly kind: 'execution' | 'review';
  readonly scope: ScopeRef;
  readonly operationId: OperationId;
  readonly incarnation: TaskRuntimeIncarnation;
  readonly assignmentId: string;
  readonly assignment: WorkAssignment;
  readonly reviewAssignment?: ReviewAssignment;
  readonly agentId: string;
  readonly inputRefs: readonly string[];
  readonly prompt: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
}

/**
 * The one place an independent child actually runs. It binds the child's own
 * run, drives the whole multi-request loop, and only then closes production,
 * drains the real producer, settles and resolves the candidate. Nothing marks
 * completion before that point.
 */
async function runConfiguredChild(input: ConfiguredChildRunInput): Promise<RunResolvedOutcome> {
  const events: AgentEvent[] = [];
  const acceptedEvidence = (): readonly EvidenceRef[] => acceptedEvidenceRefs(events, undefined);
  const surface = childToolSurface({
    run: input.run,
    state: input.state,
    invocationId: input.invocationId,
    kind: input.kind,
    scope: input.scope,
    incarnation: input.incarnation,
    bodyAssets: input.input.bodyAssets,
    acceptedEvidence,
  });
  // Real child business admission already happened before this creator ran.
  // Commit the child's own control registration before any Provider effect.
  try {
    await input.run.control.accept();
  } catch (error) {
    let closeError: unknown;
    try { await input.closer.close(); } catch (caught) { closeError = caught; }
    if (closeError !== undefined) {
      throw new AggregateError(
        [error, closeError],
        'child control admission failed and its composition did not close',
      );
    }
    return { state: 'blocked', reason: `child control admission failed: ${errorMessage(error)}` };
  }
  const outcome = await runIndependentChild({
    composition: input.composition,
    run: { ...input.run, ...surface },
    state: input.state,
    collect: (event) => events.push(event),
    incarnation: input.incarnation,
    operationId: input.operationId,
    assignmentId: input.assignmentId,
    scope: input.scope,
    inputRefs: [...input.inputRefs],
    payload: { prompt: input.prompt },
    signal: input.signal,
    maxRequests: MAX_CHILD_REQUESTS,
    ...(input.input.now === undefined ? {} : { now: input.input.now }),
  });
  const driver = input.state.driver;
  if (driver === undefined) return { state: 'blocked', reason: 'the child run never created its own driver' };
  // The accepted control event is acted on here, outside any tool executor, so
  // no executor ever waits for its own drain.
  let drained = false;
  let settlement: ProviderSettlement | undefined;
  let closed = false;
  try {
    if (outcome.state === 'delivered') {
      await driver.closeProductionAndDrain({
        execution: {
          runtimeId: input.incarnation.runtimeId,
          executionEpoch: input.incarnation.executionEpoch,
        },
        boundaryId: `child-close:${input.operationId.value}`,
      });
      drained = true;
    }
    await driver.settle({ runtimeId: input.incarnation.runtimeId, executionEpoch: input.incarnation.executionEpoch });
    settlement = driver.settlement();
  } finally {
    closed = await input.closer.close();
  }
  const resolved = await resolveRunOutcome({
    kind: input.kind,
    state: input.state,
    outcome,
    assignment: input.assignment,
    ...(input.reviewAssignment === undefined ? {} : { reviewAssignment: input.reviewAssignment }),
    agentId: input.agentId,
    bodyAssets: input.input.bodyAssets,
    settlement,
    drained,
    closed,
    ...(input.input.now === undefined ? {} : { now: input.input.now }),
  });
  // The control successor is derived from the actual controller facts, not
  // from model text or business payload. A failed append must not release the
  // refined result as success.
  const status: 'succeeded' | 'failed' | 'cancelled' | 'blocked' = resolved.state === 'returned'
    ? 'succeeded'
    : outcome.state === 'failed' || settlement?.state === 'failed' ? 'failed'
    : settlement?.state === 'cancelled' || settlement?.state === 'stopped' ? 'cancelled'
    : 'blocked';
  const terminalEvidence = [
    ...(settlement?.evidenceRefs ?? []),
    ...(input.state.acceptedCommand?.resolvedEvidenceRefs ?? []),
  ];
  const result: OperationResult | undefined = status === 'succeeded' && terminalEvidence.length > 0
    ? {
        operationId: input.operationId,
        status: 'succeeded',
        evidenceRefs: terminalEvidence,
        verifier: {
          name: 'humanagent.child-run-composition',
          version: '1',
          decision: 'accepted child standard end, provider settlement, producer drain, composition close and body readback verified',
        },
        completedAt: (input.input.now?.() ?? new Date()).toISOString(),
      }
    : undefined;
  try {
    await input.run.control.settle({
      status,
      evidenceRefs: terminalEvidence,
      ...(result === undefined ? {} : { result }),
    });
  } catch (error) {
    return { state: 'blocked', reason: `child control settlement failed: ${errorMessage(error)}` };
  }
  return resolved;
}

/**
 * Configured execution creator. `createInstance` synchronously returns the real
 * incarnation handle and performs no Provider request; `execute` binds this
 * child's own run and runs the real delivery loop.
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
      const closer = createCompositionCloser();
      return {
        incarnation: create.incarnation,
        async release() { await closer.close(); },
        async dispose() { await closer.close(); },
        async execute(execution: ExecutionAgentInput): Promise<WorkResult> {
          const composition = await prepare();
          closer.hold(composition);
          const operationId = childOperationId(input.call.invocationId);
          const scope: ScopeRef = { ...execution.scope, operationId };
          const run = await input.bindChildRun({
            call: input.call,
            operation: input.operation,
            incarnation: create.incarnation,
            scope,
            request: { kind: 'execution', input: execution },
          });
          const resolved = await runConfiguredChild({
            input,
            composition,
            closer,
            state: {},
            run,
            kind: 'execution',
            scope,
            operationId,
            incarnation: create.incarnation,
            assignmentId: create.incarnation.assignmentId,
            assignment: execution.assignment,
            agentId: execution.agentId,
            invocationId: input.call.invocationId,
            inputRefs: [...execution.assignment.targetRefs, `child:${input.call.invocationId}`],
            prompt: executionPrompt(execution.assignment),
            signal: execution.signal ?? new AbortController().signal,
          });
          if (resolved.state === 'blocked') {
            return {
              taskId: execution.assignment.taskId,
              pipelineNodeId: execution.assignment.pipelineNodeId,
              agentId: execution.agentId,
              assignmentId: execution.assignment.assignmentId,
              attempt: execution.assignment.attempt,
              executionEpoch: execution.assignment.executionEpoch,
              inputRevision: execution.assignment.inputRevision,
              summary: boundedSummary(resolved.reason),
              evidenceRefs: [],
              nextAction: 'attention',
              producedArtifactRefs: [],
              producedArtifactDigests: [],
              status: 'failed',
              outputRefs: [],
              failureRef: `child:${execution.assignment.assignmentId}:no-delivery`,
            };
          }
          return resolved.result as WorkResult;
        },
      };
    },
    async execute() {
      throw new Error('configured child execution must run through its acquired instance handle');
    },
  };
}

/**
 * Configured review creator. It reads the real, complete subject bodies and
 * criteria, runs on the selected independent context and model, and requires
 * the same legal delivery and standard end before any review result exists.
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
      const closer = createCompositionCloser();
      return {
        incarnation: create.incarnation,
        async release() { await closer.close(); },
        async dispose() { await closer.close(); },
        async review(review: ReviewAgentInput): Promise<ReviewAgentDelivery> {
          const composition = await prepare();
          closer.hold(composition);
          const operationId = childOperationId(input.call.invocationId);
          const scope: ScopeRef = { ...review.scope, operationId };
          const run = await input.bindChildRun({
            call: input.call,
            operation: input.operation,
            incarnation: create.incarnation,
            scope,
            request: { kind: 'review', input: review },
          });
          const resolved = await runConfiguredChild({
            input,
            composition,
            closer,
            state: {},
            run,
            kind: 'review',
            scope,
            operationId,
            incarnation: create.incarnation,
            assignmentId: create.incarnation.assignmentId,
            assignment: review.workerAssignment,
            reviewAssignment: review.reviewAssignment,
            agentId: create.incarnation.agentInstanceId,
            invocationId: input.call.invocationId,
            inputRefs: [...review.reviewAssignment.subjectRefs, `child:${input.call.invocationId}`],
            prompt: reviewPrompt(review.reviewAssignment, assertReviewMaterial(review.reviewMaterial)),
            signal: review.signal ?? new AbortController().signal,
          });
          if (resolved.state === 'blocked') {
            return {
              result: {
                resultId: `review-result:${create.incarnation.agentInstanceId}:blocked`,
                assignmentId: review.reviewAssignment.assignmentId,
                taskId: review.reviewAssignment.taskId,
                workerAgentId: review.reviewAssignment.workerAgentId,
                reviewKind: review.reviewAssignment.reviewKind,
                attempt: review.reviewAssignment.attempt,
                executionEpoch: review.reviewAssignment.executionEpoch,
                inputRevision: review.reviewAssignment.inputRevision,
                acceptanceCriteriaDigest: review.reviewAssignment.acceptanceCriteriaDigest,
                subjectRefs: [...review.reviewAssignment.subjectRefs],
                subjectDigests: [...review.reviewAssignment.subjectDigests],
                status: 'inconclusive',
                findings: [],
                evidenceRefs: [],
              },
              output: { text: boundedSummary(resolved.reason), artifactRef: null, artifactDigest: null },
              completedAt: (input.now?.() ?? new Date()).toISOString(),
            };
          }
          return resolved.result as ReviewAgentDelivery;
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
        // The complete review body survives as its own durable asset; the
        // evidence locator and digest point at it. A cold read resolves the
        // full review, never only the status and findings.
        artifactRefs: input.result.evidenceRefs.map((ref) => ({
          evidenceId: ref.evidenceId.value,
          locator: ref.locator,
          ...(ref.digest === undefined ? {} : { digest: ref.digest }),
        })),
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
  readonly bodyAssetTarget: string;
}): WorkAssignment {
  const assignmentId = `child-${input.childOperationId.value}`;
  // The model's declared target stays a business requirement in the dispatch.
  // The physical artifact ref is the real immutable asset target bound below,
  // so a declared target alone never reads as a produced artifact.
  const objective = `${input.request.instructions}\nBusiness target: ${input.request.target}`;
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
    targetRefs: [input.bodyAssetTarget],
    expectedOutputRefs: [input.bodyAssetTarget],
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

  function boundedEvidence(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
    return refs;
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
        evidenceRefs: boundedEvidence(delivery.result.evidenceRefs),
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
      evidenceRefs: boundedEvidence(delivery.result.evidenceRefs),
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
        evidenceRefs: boundedEvidence(result.result.evidenceRefs),
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
        evidenceRefs: boundedEvidence(result.delivery.result.evidenceRefs),
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
      evidenceRefs: boundedEvidence(issue.evidenceRefs),
      status: 'blocked',
    };
  }

  async function resolveReviewSource(
    subjectInvocationId: string,
    scope: ScopeRef,
  ): Promise<{ readonly worker: WorkAssignment; readonly result: WorkResult; readonly bodies: readonly string[] }> {
    const delivery = findDelivery(parent, subjectInvocationId);
    if (!delivery || delivery.kind !== 'execution') {
      throw new Error(`review subject invocation ${subjectInvocationId} has no retained execution delivery`);
    }
    // The subject under review is the delivery's own immutable asset, read back
    // from the filesystem. A carried copy is accepted only when it still hashes
    // to the persisted digest; otherwise the durable asset is the authority.
    const digests = delivery.result.producedArtifactDigests;
    const bodies = await Promise.all(delivery.result.producedArtifactRefs.map(async (locator, index) => {
      const digest = digests[index];
      const carried = delivery.result.producedArtifactBodies?.[index];
      if (carried !== undefined && digest !== undefined && digestOf(carried) === digest) return carried;
      const bytes = await input.bodyAssets.read(rawAssetFromLocator(locator, scope, digest));
      const body = new TextDecoder().decode(bytes);
      if (digest !== undefined && digestOf(body) !== digest) {
        throw new Error(`review subject ${locator} does not read back to its recorded digest`);
      }
      return body;
    }));
    return { worker: delivery.assignment, result: delivery.result, bodies };
  }

  /** Rebuilds the immutable asset descriptor for a durable child delivery locator. */
  function rawAssetFromLocator(locator: string, scope: ScopeRef, digest?: string): RawAsset {
    const assetId = locator.split('/').filter(Boolean).at(-1) ?? locator;
    return {
      ref: {
        evidenceId: id('evidence', assetId),
        kind: 'execution',
        source: OWNER,
        locator,
        ...(digest === undefined ? {} : { digest }),
        scope,
      },
      view: { kind: 'utf8-text' },
    };
  }

  /**
   * The one authoritative subject body: the immutable asset the execution child
   * actually wrote. The producer reads it through the child body asset port.
   */
  async function readSubjectBody(
    source: { readonly worker: WorkAssignment; readonly result: WorkResult; readonly bodies: readonly string[] },
    index: number,
  ): Promise<string> {
    const carried = source.bodies[index];
    if (carried !== undefined && carried !== '') return carried;
    throw new Error('review subject body is not readable from its durable asset');
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
          const source = await resolveReviewSource(parsed.kind === 'review' ? parsed.subjectInvocationId : '', request.scope);
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
          bodyAssetTarget: input.bodyAssets.target({
            scope: request.scope,
            invocationId,
            kind: 'execution',
          }),
        });
        const executionAgent = createConfiguredExecutionAgent({
          call,
          operation: receipt,
          selected,
          bodyAssets: input.bodyAssets,
          bindChildRun: input.bindChildRun,
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

      const source = await resolveReviewSource(parsed.subjectInvocationId, request.scope);
      // The reviewer must see the complete subject body. The authoritative copy
      // is the execution delivery's own immutable asset, read back here; a
      // body that cannot be read rejects instead of degrading into a
      // digest-only review.
      const subjects = await Promise.all(source.worker.targetRefs.map(async (ref, index) => ({
        ref,
        body: await readSubjectBody(source, index),
      })));
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
        bodyAssets: input.bodyAssets,
        bindChildRun: input.bindChildRun,
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
