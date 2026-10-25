import { createHash, randomUUID } from 'node:crypto';
import {
  EXPLICIT_BRAIN_MODEL_TOOLS,
  EXPLICIT_BRAIN_TEMPLATE_REF,
  id,
  assertEvidenceRef,
  type BusinessPayload,
  type EvidenceRef,
  type ExecutionRuntimePort,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionTurnIdentity,
  type OrganId,
  type InteractionProviderSettlementReceipt,
  type RawContentReadPort,
  type InteractionHelperAssignmentFields,
  type InteractionHelperResultFields,
  type InteractionDecision,
  type ProviderBinding,
  type ProviderCloseResult,
  type ProviderSettlement,
  type OccurrenceExecutionOwner,
  type RequirementIntent,
  type TaskFlowBinding,
  type TaskFlowKind,
  TASK_FLOW_DEFINITION_VERSION,
  TASK_FLOW_KINDS,
} from '../../contracts/src/index.js';
import { ProviderAgentDriver } from '../../adapters/provider/src/index.js';
import type { ProviderEvidenceSink } from '../../adapters/provider/src/evidence.js';
import { prepareScopeSemanticHistory } from '../../runtime/src/context/interaction-semantic-context.js';
import { loadBuiltinPromptSegments, type AgentPromptSegment } from '../../agent-templates/src/index.js';
import { WorkspaceCodeSearchFunctions } from '../../adapters/operations/src/index.js';
import {
  ExplicitBrainDecisionExecutor,
  ExplicitBrainOperationalToolError,
  ExplicitTurnHelperSession,
  createInteractionParentTurnRawOwner,
  readInteractionProviderSettlement,
  type ExplicitTurnHelperFactory,
  type InteractionHelperJournalPort,
  type InteractionHelperTurnReadPort,
  type InteractionParentFinalTurnOutput,
  type InteractionParentTurnRawJournalPort,
  type InteractionParentOpenedTurnScopeReadPort,
  type InteractionSemanticCheckpointJournalPort,
  type InteractionParentTurnRawOwner,
  createExplicitBrainToolRegistry,
  type ExplicitBrainAgentToolPort,
  type ExplicitBrainOperationalToolPorts,
  type ExplicitBrainRuntimeBinding,
  type ExplicitBrainWorkspaceToolPort,
} from '../../runtime/src/explicit-brain/index.js';
import type { DecisionTracePort } from '../../runtime/src/explicit-brain/attention.js';
import { closeAgentProvider, type AgentProviderComposition } from './agent-driver-composition.js';
import { readSupervisorTerminationReceipts, type SupervisorLease } from './supervisor/supervisor.js';

const CAPABILITY_DIGEST = `sha256:${createHash('sha256').update(EXPLICIT_BRAIN_MODEL_TOOLS.join('|')).digest('hex')}`;

/**
 * The bounded intake call carries only helper dispatch and acceptance. It uses
 * the identity and control-boundary segments of the full `interaction` role. The remaining segments
 * of the same verified template require a nested decision envelope, selected
 * actions, typed tool intents, and a submit-only-after-confirmation path that this
 * intake contract does not accept.
 */
const INTAKE_PROMPT_SEGMENT_REFS = [
  'common/control-boundaries.md',
  'interaction/profiles/explicit-brain/identity.md',
] as const;

function selectIntakePromptSegments(segments: readonly AgentPromptSegment[]): readonly string[] {
  const byRef = new Map(segments.map((segment) => [segment.ref, segment.content]));
  return INTAKE_PROMPT_SEGMENT_REFS.map((ref) => {
    const content = byRef.get(ref);
    if (content === undefined) {
      throw new ExplicitBrainOperationalToolError(
        'unsupported-tool',
        `interaction template is missing the required intake prompt segment: ${ref}`,
      );
    }
    return content;
  });
}

function digestArguments(args: Readonly<Record<string, unknown>>): string {
  const stable = JSON.stringify(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${createHash('sha256').update(stable).digest('hex')}`;
}

export interface ExplicitBrainRuntimeOptions {
  readonly workspaceRoot: string;
  readonly projectKey: string;
  readonly traces: DecisionTracePort;
  readonly agentTargets?: readonly ExplicitBrainAgentTarget[];
  readonly queryAgent?: (input: { readonly agentRef: string; readonly scopeRef: string }) => Promise<unknown>;
  readonly sendAgentMessage?: (input: {
    readonly recipientRef: string;
    readonly messageRef: string;
    readonly messageClass: 'control' | 'data' | 'observation';
  }) => Promise<unknown>;
}

export interface ExplicitBrainAgentTarget {
  readonly agentRef: string;
  readonly scopeRef: string;
  readonly queryable: boolean;
  readonly messageClasses: readonly ('control' | 'data' | 'observation')[];
}

export interface ExplicitBrainRuntime {
  readonly binding: ExplicitBrainRuntimeBinding;
  readonly ports: ExplicitBrainOperationalToolPorts;
  execute(decision: InteractionDecision): Promise<readonly unknown[]>;
}

export interface ExplicitBrainTaskCandidate {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly currentInput: string;
}

export interface ExplicitBrainInterpretationInput {
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly rawInput: string;
  readonly clarifications: readonly {
    readonly question: string;
    readonly answer?: string;
  }[];
  readonly taskCandidates: readonly ExplicitBrainTaskCandidate[];
  /**
   * Conversation project target carried by the input. When present the explicit
   * brain treats this absolute project directory as the project context of the
   * prompt; when absent the conversation targets the serve-bound default
   * workspace, which is the existing behavior.
   */
  readonly workspaceCwd?: string;
  readonly projectKey?: string;
}

export type ExplicitBrainInterpretation =
  | {
      readonly kind: 'requirement';
      readonly normalizedInput: string;
      readonly matchedTaskId?: string;
      readonly knownFacts: readonly string[];
      readonly intent: RequirementIntent;
      readonly taskFlow?: TaskFlowBinding;
      readonly proposal: string;
      readonly structuredProposal: StructuredRequirementProposal;
      readonly decisionRefs: readonly string[];
    }
  | {
      readonly kind: 'status-query';
      readonly normalizedInput: string;
      readonly matchedTaskId?: string;
      readonly knownFacts: readonly string[];
      readonly answer: string;
      readonly decisionRefs: readonly string[];
    }
  | {
      readonly kind: 'answer';
      readonly normalizedInput: string;
      readonly knownFacts: readonly string[];
      readonly answer: string;
      readonly decisionRefs: readonly string[];
    }
  | {
      readonly kind: 'clarification';
      readonly normalizedInput: string;
      readonly knownFacts: readonly string[];
      readonly question: string;
      readonly decisionRefs: readonly string[];
    };

export interface ExplicitBrainInputInterpreter {
  interpret(input: ExplicitBrainInterpretationInput): Promise<ExplicitBrainInterpretation>;
}

const STRUCTURED_REQUIREMENT_PROPOSAL_FIELDS = [
  'blockingGaps',
  'deliverable',
  'deliveryConditions',
  'evidenceRefs',
  'intent',
  'objective',
  'revision',
  'title',
] as const;

interface StructuredRequirementProposal {
  readonly revision: number;
  readonly intent: RequirementIntent;
  readonly title: string;
  readonly objective: string;
  readonly deliverable: string;
  readonly deliveryConditions: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly blockingGaps: readonly string[];
}

function structuredProposalContract(inputRevision: number): string {
  return JSON.stringify({
    revision: inputRevision,
    intent: 'create | append | change',
    title: 'non-empty string',
    objective: 'non-empty string',
    deliverable: 'non-empty string',
    deliveryConditions: ['non-empty string'],
    evidenceRefs: ['string'],
    blockingGaps: ['string'],
  });
}

function interpreterPrompt(input: ExplicitBrainInterpretationInput, promptSegments: readonly string[]): string {
  const projectContext = input.workspaceCwd === undefined || input.projectKey === undefined
    ? []
    : [`# Conversation project directory\nThe conversation targets the project directory ${input.workspaceCwd} (projectKey ${input.projectKey}). Treat that directory as the project context of this input.`];
  return [
    ...promptSegments,
    ...projectContext,
    '# Explicit intake decision output',
    'Return one final JSON object only. You may dispatch_helper for bounded independent work and accept_helper to explicitly adopt a returned result. Do not claim task execution.',
    'dispatch_helper takes selection (roleId and optional configuredAgentId), assignmentFields, inputs, and evidenceRefs. Helpers must return JSON with agentId, producedArtifactRefs, status, summary, outputRefs, evidenceRefs, nextAction, and optional conditionRef/failureRef. Returned does not mean accepted.',
    'accept_helper takes helperCallId, refinedText, acceptanceRef, and evidenceRefs. Refine the actual returned conclusion before accepting it.',
    'The object is flat at the top level. kind must be requirement, status-query, clarification, or answer.',
    'Every variant carries normalizedInput, knownFacts (string array), and decisionRefs (string array) at the top level, plus the fields for its own kind: proposal, taskFlowKind for a semantically clear requirement shape, and the optional matchedTaskId for requirement; answer for status-query and answer; and question for clarification.',
    'Never nest a decision wrapper, and never emit a selected-action, summary, user-input flag, tool-result flag, or tool-intents field.',
    'Never echo the input envelope back as output fields: interactionId, inputRevision, sourceRef, rawInput, clarifications, and taskCandidates are input only.',
    'The committed rawInput is the only request in this turn. taskCandidates and the prior turn checkpoints are reference history: read them only to match a status-query or an append/change target. A candidate status such as created, blocked, stopped, or waiting is never a user request, so never propose continuing, resuming, or finishing candidate tasks unless rawInput itself asks for that.',
    'The whole reply is exactly one decision object and one assistant message. Never emit a second decision object, a second message item, a preface, or a closing note.',
    'Classify by the requested outcome, not by whether intake can execute a requested tool. A concrete request to perform work and deliver a result is a requirement; when it asks for new work, use proposal.intent=create even if taskCandidates is empty.',
    'Do not turn a request to perform read-only work into status-query because it names tools or because intake cannot call them. Preserve the requested work, deliverable, and constraints in normalizedInput and the requirement proposal; execution happens only in the confirmed task flow.',
    'For requirement, proposal.intent must be create, append, or change. append/change require matchedTaskId from taskCandidates.',
    'For requirement, put taskFlowKind at the top level and choose it from semantic task shape only: one-shot for one bounded deliverable, including a deliverable that entails create, read, or return steps regardless of tool-step count; inspection for recurring check-and-report work; long-running for an open-ended goal requiring continued turns. Omit taskFlowKind only when the task shape is genuinely ambiguous, and use the clarification path when that ambiguity blocks a decision.',
    'Submitting the new-task form is already the user confirmation. For proposal.intent=create, do not write a second-confirmation blocker into objective, deliveryConditions, or blockingGaps.',
    'Do not choose a task execution owner, worker, provider, or runtime in the intake decision.',
    'For status-query, answer the question using taskCandidates and use matchedTaskId when one task is selected.',
    'Use answer only for a general question you can answer directly from the current input and provided context, with no execution, exploration, external retrieval, or deliverable. Put the reply in answer; do not carry matchedTaskId, proposal, or intent. A request to perform work, explore, retrieve externally, or deliver a result is a requirement, never an answer.',
    'For clarification, ask one concrete question and do not invent a task match.',
    `Requirement proposal must be exactly this object shape: ${structuredProposalContract(input.inputRevision)}`,
    'Requirement intent exists only at proposal.intent; do not add a top-level intent field. Do not select an owner. Status-query requires answer. Answer requires a non-empty answer. Clarification requires question.',
  ].join('\n\n');
}

function nonEmptyString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', `requirement proposal ${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.trim())) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', `requirement proposal ${field} must be a string array`);
  }
  return value;
}

function parseTaskFlowKind(value: unknown): TaskFlowKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !TASK_FLOW_KINDS.includes(value as TaskFlowKind)) {
    throw new ExplicitBrainOperationalToolError(
      'unsupported-tool',
      'taskFlowKind must be one of one-shot, inspection, or long-running',
    );
  }
  return value as TaskFlowKind;
}

function parseStructuredRequirementProposal(
  value: unknown,
  inputRevision: number,
): StructuredRequirementProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'requirement proposal must be a structured object');
  }
  const record = value as Record<string, unknown>;
  const actualFields = Object.keys(record).sort();
  if (actualFields.length !== STRUCTURED_REQUIREMENT_PROPOSAL_FIELDS.length
    || actualFields.some((field, index) => field !== STRUCTURED_REQUIREMENT_PROPOSAL_FIELDS[index])) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'requirement proposal does not match the structured proposal contract');
  }
  if (record.revision !== inputRevision) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'requirement proposal revision does not match the current input');
  }
  if (record.intent !== 'create' && record.intent !== 'append' && record.intent !== 'change') {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'requirement proposal requires a typed intent');
  }
  return {
    revision: inputRevision,
    intent: record.intent,
    title: nonEmptyString(record, 'title'),
    objective: nonEmptyString(record, 'objective'),
    deliverable: nonEmptyString(record, 'deliverable'),
    deliveryConditions: stringArray(record, 'deliveryConditions'),
    evidenceRefs: stringArray(record, 'evidenceRefs'),
    blockingGaps: stringArray(record, 'blockingGaps'),
  };
}

function renderBusinessProposal(proposal: StructuredRequirementProposal): string {
  const lines = [
    proposal.title,
    `目标：${proposal.objective}`,
    `交付物：${proposal.deliverable}`,
  ];
  if (proposal.deliveryConditions.length > 0) {
    lines.push('交付条件：', ...proposal.deliveryConditions.map((condition) => `- ${condition}`));
  }
  if (proposal.evidenceRefs.length > 0) {
    lines.push('证据：', ...proposal.evidenceRefs.map((reference) => `- ${reference}`));
  }
  if (proposal.blockingGaps.length > 0) {
    lines.push('当前缺口：', ...proposal.blockingGaps.map((gap) => `- ${gap}`));
  }
  return lines.join('\n');
}

/**
 * The complete top-level JSON objects of one terminal output, in order.
 *
 * A Responses batch can carry several complete `assistant-text` items and the
 * raw fold is faithful, so their texts arrive concatenated while every item's
 * own JSON object stays well formed. The intake contract asks for exactly one
 * decision object, so the seam between items has to be found instead of being
 * left to a slice: `{...}{...}` must never be merged, truncated or guessed.
 */
function topLevelJsonObjectSpans(text: string): readonly { readonly start: number; readonly end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      spans.push({ start, end: index + 1 });
      start = -1;
    }
  }
  return spans;
}

function parseInterpreterOutput(output: string, input: ExplicitBrainInterpretationInput): ExplicitBrainInterpretation {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1];
  const scoped = fenced ?? output;
  const spans = topLevelJsonObjectSpans(scoped);
  const objects: Record<string, unknown>[] = [];
  let parseError: string | undefined;
  for (const span of spans) {
    let value: unknown;
    try {
      value = JSON.parse(scoped.slice(span.start, span.end));
    } catch (error) {
      parseError ??= error instanceof Error ? error.message : String(error);
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    objects.push(value as Record<string, unknown>);
  }
  let record: Record<string, unknown> | undefined;
  if (objects.length === 1) {
    // One top-level object is the decision candidate: whether it satisfies the
    // intake contract is the contract check below, not a span count.
    record = objects[0];
  } else if (objects.length > 1) {
    // A model may echo the request envelope it was handed (`interactionId`,
    // `rawInput`, `taskCandidates`, ...) in front of its decision. That echo
    // states no decision kind, so only the objects that state one are
    // decisions, and two decision objects stay ambiguous.
    const decisions = objects.filter((entry) => typeof entry.kind === 'string');
    record = decisions.length === 1 ? decisions[0] : undefined;
    if (record === undefined) {
      throw new ExplicitBrainOperationalToolError(
        'unsupported-tool',
        decisions.length > 1
          ? `interaction agent returned invalid JSON: the terminal output holds ${decisions.length} top-level JSON decision objects, and the intake contract requires exactly one`
          : `interaction agent returned invalid JSON: the terminal output holds ${objects.length} top-level JSON objects and none of them is a decision object`,
      );
    }
  } else {
    throw new ExplicitBrainOperationalToolError(
      'unsupported-tool',
      spans.length === 0
        ? 'interaction agent returned invalid JSON: the terminal output holds no JSON decision object'
        : `interaction agent returned invalid JSON: ${parseError ?? 'the terminal output holds no JSON decision object'}`,
    );
  }
  const kind = record.kind;
  const normalizedInput = record.normalizedInput;
  const knownFacts = record.knownFacts;
  const decisionRefs = record.decisionRefs;
  if ((kind !== 'requirement' && kind !== 'status-query' && kind !== 'clarification' && kind !== 'answer')
    || typeof normalizedInput !== 'string' || !normalizedInput.trim()
    || !Array.isArray(knownFacts) || !knownFacts.every((entry) => typeof entry === 'string')
    || !Array.isArray(decisionRefs) || !decisionRefs.every((entry) => typeof entry === 'string')) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction agent decision does not match the explicit intake contract');
  }
  const common = {
    normalizedInput,
    knownFacts: knownFacts as string[],
    decisionRefs: decisionRefs as string[],
  };
  if (kind === 'clarification') {
    if (typeof record.question !== 'string' || !record.question.trim()) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'clarification decision requires a question');
    }
    return { kind, ...common, question: record.question };
  }
  if (kind === 'answer') {
    if (record.matchedTaskId !== undefined) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'answer decision cannot select a task');
    }
    if (record.intent !== undefined || record.proposal !== undefined) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'answer decision cannot carry a requirement proposal');
    }
    if (typeof record.answer !== 'string' || !record.answer.trim()) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'answer decision requires a non-empty answer');
    }
    return { kind, ...common, answer: record.answer };
  }
  const matchedTaskId = typeof record.matchedTaskId === 'string' && record.matchedTaskId.trim()
    ? record.matchedTaskId
    : undefined;
  if (kind === 'status-query') {
    if (typeof record.answer !== 'string' || !record.answer.trim()) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'status decision requires an answer');
    }
    return { kind, ...common, ...(matchedTaskId === undefined ? {} : { matchedTaskId }), answer: record.answer };
  }
  if (record.intent !== undefined) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'requirement decision cannot duplicate proposal intent');
  }
  const taskFlowKind = parseTaskFlowKind(record.taskFlowKind);
  const proposal = parseStructuredRequirementProposal(record.proposal, input.inputRevision);
  return {
    kind,
    ...common,
    ...(matchedTaskId === undefined ? {} : { matchedTaskId }),
    intent: proposal.intent,
    ...(taskFlowKind === undefined
      ? {}
      : { taskFlow: { kind: taskFlowKind, definitionVersion: TASK_FLOW_DEFINITION_VERSION } }),
    proposal: renderBusinessProposal(proposal),
    structuredProposal: proposal,
  };
}

/**
 * Exact neutral interaction-turn identity comparison. Both the scope history
 * read and the pending-turn read use it so a discharged turn is recognized by
 * the same durable identity the Journal recorded.
 */
function sameInteractionTurn(left: InteractionTurnIdentity, right: InteractionTurnIdentity): boolean {
  return left.organId.scope === right.organId.scope
    && left.organId.value === right.organId.value
    && left.interactionScopeId === right.interactionScopeId
    && left.interactionId === right.interactionId
    && left.inputRevision === right.inputRevision
    && left.turnId === right.turnId;
}

/**
 * The most specific message of a failure chain. An AggregateError keeps the
 * primary failure at `errors[0]`, so a message built from the wrapper alone
 * would report the cleanup detail instead of the cause that started it.
 */
function describeFailure(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof AggregateError && current.errors.length > 0) {
      current = current.errors[0];
      continue;
    }
    break;
  }
  return current instanceof Error ? current.message : String(current);
}

/**
 * The durable reason one failed epoch must keep its recovery lane instead of
 * being closed as failed, or undefined when no dispatched helper blocks it. A
 * dispatched helper already reached the side-effect stage, and a recorded
 * return never proves the effect was not applied, so that turn is not closed
 * as failed.
 */
async function holdsDispatchedHelper(
  journal: InteractionHelperTurnReadPort,
  turn: InteractionTurnIdentity,
): Promise<string | undefined> {
  let durableHelpers: Awaited<ReturnType<InteractionHelperTurnReadPort['readTurnHelpers']>>;
  try {
    durableHelpers = await journal.readTurnHelpers(turn);
  } catch (error) {
    return `the durable helper turn read failed: ${describeFailure(error)}`;
  }
  if (durableHelpers.length === 0) return undefined;
  return `it dispatched helper ${durableHelpers[0]!.identity.helperCallId}`;
}

export function createProviderExplicitBrainInterpreter(input: {
  readonly lease?: SupervisorLease | (() => SupervisorLease | undefined);
  readonly port?: ExecutionRuntimePort<InteractionParentProviderExecutionIdentityRef>;
  readonly organId: OrganId;
  readonly interactionScopeId: string;
  readonly parentJournal: InteractionParentTurnRawJournalPort & InteractionParentOpenedTurnScopeReadPort;
  readonly checkpointJournal: InteractionSemanticCheckpointJournalPort;
  readonly helperJournal: InteractionHelperJournalPort;
  readonly turnHelperJournal?: InteractionHelperTurnReadPort;
  readonly rawEvidence: ProviderEvidenceSink;
  readonly rawContent: RawContentReadPort;
  readonly helperFactory: ExplicitTurnHelperFactory;
  readonly clock: { now(): string };
  readonly binding: ProviderBinding;
  readonly templateRoot: string;
  readonly prepareAgentProvider?: (input: {
    readonly roleId: import('../../config/src/index.js').AgentRole;
    readonly configuredAgentId?: string;
  }) => Promise<AgentProviderComposition<InteractionParentProviderExecutionIdentityRef>>;
  /**
   * Private App callback for the authoritative Provider settlement receipt.
   * The App assembly points it at the existing interaction journal; the
   * interpreter never writes business payload fields with settlement data.
   */
  readonly publishProviderSettlement?: (
    receipt: InteractionProviderSettlementReceipt,
  ) => void | Promise<void>;
}): ExplicitBrainInputInterpreter {
  let promptSegments: Promise<readonly string[]> | undefined;
  const loadPromptSegments = (): Promise<readonly string[]> => {
    if (promptSegments !== undefined) return promptSegments;
    const version = EXPLICIT_BRAIN_TEMPLATE_REF.slice('builtin/interaction@'.length);
    promptSegments = loadBuiltinPromptSegments('interaction', input.templateRoot, version)
      .then((loaded) => selectIntakePromptSegments(loaded.segments));
    return promptSegments;
  };
  const requireColdAnswerSettlement = async (
    finalParentOutput: InteractionParentFinalTurnOutput,
    interpretation: ExplicitBrainInterpretation,
  ): Promise<void> => {
    if (input.publishProviderSettlement === undefined || interpretation.kind !== 'answer') return;
    const committed = await readInteractionProviderSettlement({
      journal: input.parentJournal,
      turn: finalParentOutput.turnInput.fact.turn,
    });
    await input.publishProviderSettlement(committed.fact);
  };
  /**
   * A real terminal output exists but cannot be parsed into any decision.
   * Re-reading the same durable text can never recover the turn, so it is
   * closed by its own honest fact: it never claims an answer, a route, a
   * settlement, a close or an abandonment. The closure is idempotent, so an
   * exact retry reuses the first committed fact instead of re-bricking.
   */
  const closeUnparseableTurn = async (
    target: InteractionParentTurnRawOwner,
    parseError: unknown,
  ): Promise<never> => {
    try {
      await target.closeUnparseableTurn({ failedAt: input.clock.now() });
    } catch (closeError) {
      throw new AggregateError(
        [parseError, closeError],
        'interaction terminal output is unusable and the turn could not be closed',
      );
    }
    throw parseError;
  };
  // Retain the actual live owners only. Scoped Journal reads select every retry.
  let retained: {
    readonly owner: InteractionParentTurnRawOwner;
    readonly helpers: ExplicitTurnHelperSession;
    readonly reconciled: boolean;
    readonly settlement: ProviderSettlement<InteractionParentProviderExecutionIdentityRef> | undefined;
    publishOnRetry: boolean;
    owned: AgentProviderComposition<InteractionParentProviderExecutionIdentityRef> | undefined;
    /**
     * The original physical close receipt, retained across same-process retries
     * so a Journal ack-loss after a real close never triggers a second physical
     * close of the same original owner.
     */
    closed?:
      | {
          readonly composition: AgentProviderComposition<InteractionParentProviderExecutionIdentityRef>;
          readonly receipt: ProviderCloseResult;
        }
      | undefined;
  } | undefined;
  const finish = async (live: NonNullable<typeof retained>, request: ExplicitBrainInterpretationInput) => {
    if (live.owned !== undefined) {
      const receipt = await closeAgentProvider(live.owned, { returnReceipt: true });
      live.closed = { composition: live.owned, receipt };
      live.owned = undefined;
    }
    if (live.closed !== undefined) {
      // Durable, idempotent commit of the real receipt. A retry after a lost
      // acknowledgement reuses the retained receipt instead of closing again.
      await live.owner.recordProviderClose({
        providerBinding: live.closed.composition.binding,
        result: live.closed.receipt,
        closedAt: input.clock.now(),
      });
    }
    const finalParentOutput = live.reconciled
      ? await live.owner.readReconciledTurnOutput()
      : await live.owner.readFinalTurnOutput();
    let interpretation: ExplicitBrainInterpretation;
    try {
      interpretation = parseInterpreterOutput(finalParentOutput.assistantText, request);
    } catch (parseError) {
      // The provider close is already committed here, so the unusable terminal
      // output can be closed by its own honest fact without leaving the turn
      // pending forever.
      return await closeUnparseableTurn(live.owner, parseError);
    }
    if ((live.reconciled || live.publishOnRetry)
      && interpretation.kind === 'answer' && input.publishProviderSettlement !== undefined) {
      if (live.settlement === undefined) {
        throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction agent settled without a provider settlement');
      }
      await input.publishProviderSettlement({
        interactionId: request.interactionId,
        inputRevision: request.inputRevision,
        request: finalParentOutput.terminalRequest.request,
        settlement: live.settlement,
      });
    }
    try {
      const checkpointOutput = live.reconciled
        ? finalParentOutput
        : live.closed === undefined
        ? finalParentOutput
        : await live.owner.readClosedTurnOutput();
      await live.helpers.closeTurnSemanticCheckpoint({ finalParentOutput: checkpointOutput, outcome: interpretation });
    } catch (error) {
      if (interpretation.kind === 'answer' && input.publishProviderSettlement !== undefined) {
        live.publishOnRetry = true;
      }
      throw error;
    }
    retained = undefined;
    return interpretation;
  };
  return {
    async interpret(request) {
      const activeLease = typeof input.lease === 'function' ? input.lease() : input.lease;
      let continuation: {
        readonly fact: NonNullable<Awaited<ReturnType<typeof input.parentJournal.readTurnSnapshot>>['turnInput']>['fact'];
        readonly executionEpoch: number;
        readonly executionOwner: OccurrenceExecutionOwner;
      } | undefined;
      const scopeKey = { organId: input.organId, interactionScopeId: input.interactionScopeId };
      const readPendingTurn = async () => {
        const opened = await input.parentJournal.readScopeOpenedTurns(scopeKey);
        const closed = await input.checkpointJournal.readScopeSemanticCheckpoints(scopeKey);
        const abandoned = await input.parentJournal.readScopeAbandonedTurns(scopeKey);
        const unusable = await input.parentJournal.readScopeParseFailures(scopeKey);
        const failedEpochs = await input.parentJournal.readScopeExecutionFailures(scopeKey);
        return opened.find(({ fact }) => !closed.some(({ checkpoint }) =>
          checkpoint.organId.scope === fact.turn.organId.scope
          && checkpoint.organId.value === fact.turn.organId.value
          && checkpoint.interactionScopeId === fact.turn.interactionScopeId
          && checkpoint.interactionId === fact.turn.interactionId
          && checkpoint.inputRevision === fact.turn.inputRevision
          && checkpoint.turnId === fact.turn.turnId)
          && !abandoned.some(({ fact: abandonedFact }) => sameInteractionTurn(abandonedFact.turn, fact.turn))
          // A turn closed as unparseable is durably closed: its real terminal
          // output exists but yielded no decision, so it is not pending and it
          // must never block the next input.
          && !unusable.some(({ fact: unusableFact }) => sameInteractionTurn(unusableFact.turn, fact.turn))
          // A turn whose epoch failed before any terminal output is closed by
          // its own durable fact: nothing about it can ever be delivered, so it
          // is not pending and it must never block the next input.
          && !failedEpochs.some(({ fact: failedFact }) => sameInteractionTurn(failedFact.turn, fact.turn)));
      };
      /**
       * Discharge one interrupted parent turn that can provably never be
       * recovered. The durable fact is honest: the Provider stream stopped
       * before any terminal output and left no business side effect. Any shape
       * with a possible output, close, settlement, replacement owner, terminal
       * request or unknown tool side effect keeps the existing explicit error.
       */
      const abandonInterruptedTurn = async (
        pendingTurn: NonNullable<Awaited<ReturnType<typeof readPendingTurn>>>,
      ): Promise<void> => {
        const refuse = (detail: string): Error => new Error(
          `unclosed interaction parent turn ${pendingTurn.fact.turn.turnId} requires its exact prior input before new input; ${detail}`,
        );
        if (input.lease !== undefined && activeLease === undefined) {
          throw new Error('interaction parent turn requires active supervisor lease authority');
        }
        const providerBinding = pendingTurn.fact.providerBinding;
        if (providerBinding === undefined) {
          throw refuse('the original committed provider binding is missing');
        }
        if (input.turnHelperJournal === undefined) {
          throw refuse('the durable helper turn read port is unavailable');
        }
        const durableHelpers = await input.turnHelperJournal.readTurnHelpers(pendingTurn.fact.turn);
        for (const entry of durableHelpers) {
          if (entry.readback.dispatchAccepted === null || entry.readback.returned === null) {
            throw refuse(`it holds on unreturned helper ${entry.identity.helperCallId}`);
          }
        }
        if (durableHelpers.length > 0) {
          // A returned helper is not acceptance, and it never proves that no
          // helper side effect happened. Only a turn that never dispatched one
          // stays dischargeable.
          throw refuse(`it dispatched helper ${durableHelpers[0]!.identity.helperCallId}; a dispatched helper side effect cannot be discharged`);
        }
        const owner = createInteractionParentTurnRawOwner({
          turn: pendingTurn.fact.turn,
          execution: pendingTurn.fact.execution,
          scope: pendingTurn.fact.scope,
          initialInput: pendingTurn.fact.initialInput,
          providerBinding,
          priorCheckpoints: pendingTurn.fact.priorCheckpoints,
          journal: input.parentJournal,
          rawContent: input.rawContent,
        });
        // A committed owner reconciliation means the turn already continued
        // into a newer physical epoch, so the recovery owner is the reconciled
        // replacement owner, never the original turn-input owner. The lane is
        // the active epoch's execution failure, not the abandonment lane: an
        // abandonment fact must match the turn-input epoch, and it is that
        // continued epoch (not epoch 1) which actually died.
        const snapshot = await input.parentJournal.readTurnSnapshot(pendingTurn.fact.turn);
        const latestReconciliation = snapshot.ownerReconciliations.at(-1);
        if (latestReconciliation === undefined) {
          const eligibility = await owner.readAbandonmentEligibility();
          if (!eligibility.abandonable) {
            throw refuse(`it cannot be discharged: ${eligibility.heldReason}`);
          }
        } else {
          const eligibility = await owner.readExecutionFailureEligibility();
          if (!eligibility.closable) {
            throw refuse(`it cannot be discharged: ${eligibility.heldReason}`);
          }
        }
        const discharge = async () => {
          if (latestReconciliation === undefined) {
            return owner.abandonInterruptedTurn({
              reason: 'provider-interrupted-without-terminal-output',
              abandonedAt: input.clock.now(),
            });
          }
          return owner.closeFailedEpoch({ failedAt: input.clock.now() });
        };
        if (activeLease === undefined) {
          // No authenticated lifecycle authority is configured, so nothing can
          // prove that the previous execution owner stopped writing. A
          // shape-only discharge would freeze a possibly live request, so hold
          // the turn and keep its recovery responsibility instead of writing an
          // abandonment fact the record shape cannot justify.
          throw refuse('no authenticated supervisor lease authority is configured to prove the previous execution owner stopped');
        }
        // The owner that must be proven stopped is the one currently owning the
        // active epoch: the reconciled replacement owner when a reconciliation
        // is committed, the original turn-input owner otherwise.
        const activeOwner = latestReconciliation?.fact.replacementOwner ?? pendingTurn.fact.executionOwner;
        // Authenticate the active owner, decide, and commit inside one
        // lease-guard critical section. Level 1 refuses a live owner; level 2
        // discharges only with the current lease record's durable termination
        // receipt for that exact owner.
        await activeLease.withCurrentLeaseOwner(async (authenticatedCaller) => {
          // Read the freshest durable record inside the guard: the cached getter
          // could predate a concurrent takeover write.
          const current = await activeLease.refresh();
          if (activeOwner !== undefined
            && authenticatedCaller.daemonLeaseId === activeOwner.daemonLeaseId
            && authenticatedCaller.daemonGeneration === activeOwner.daemonGeneration
            && authenticatedCaller.processStartToken === activeOwner.processStartToken) {
            throw refuse('the committed execution owner is still the current active lease owner; a live Provider stream is not an interrupted crash');
          }
          if (activeOwner === undefined) {
            throw refuse('the committed execution owner has no durable termination receipt; the committed turn input records no execution owner; recovery responsibility is retained');
          }
          const retained = readSupervisorTerminationReceipts(current);
          // A receipt must name the exact owner: the same generation number
          // under a different lease id is a different daemon run and proves
          // nothing about this turn.
          const receipt = retained.find((entry) =>
            entry.previousGeneration === activeOwner.daemonGeneration
            && entry.previousLeaseId === activeOwner.daemonLeaseId
            && entry.termination !== undefined);
          if (receipt === undefined) {
            const generations = retained.map((entry) => entry.previousGeneration);
            const window = generations.length === 0
              ? 'no termination receipt is retained'
              : `retained takeover receipts cover generations ${generations[0]}..${generations[generations.length - 1]}`;
            throw refuse(
              'the committed execution owner has no durable termination receipt; recovery responsibility is retained'
              + ` (committed generation ${activeOwner.daemonGeneration}, current generation ${current.generation}, ${window})`,
            );
          }
          await discharge();
        });
      };
      // The live task list is rebuilt from the current coordinator on every
      // retry, so it can drift from the snapshot committed with the submitted
      // turn. Only that dynamic field may be restored from the committed input;
      // every other read below must then use the recovered request.
      let effectiveRequest = request;
      let pending = await readPendingTurn();
      while (pending !== undefined) {
        const original = await input.rawContent.read({ scope: pending.fact.scope, content: pending.fact.initialInput });
        const committedText = new TextDecoder('utf-8', { fatal: true }).decode(original);
        if (committedText === JSON.stringify(effectiveRequest)) break;
        let committed: unknown;
        try {
          committed = JSON.parse(committedText);
        } catch (error) {
          throw new Error(
            `unclosed interaction parent turn ${pending.fact.turn.turnId} has an unreadable committed input asset: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // A decodable asset that cannot be read as an input object is not
        // evidence that the user's business input changed. Keep the turn and
        // its recovery responsibility instead of discharging it as new input.
        const rootKind = committed === null
          ? 'null'
          : Array.isArray(committed) ? 'array' : typeof committed;
        if (committed === null || typeof committed !== 'object' || Array.isArray(committed)) {
          throw new Error(
            `unclosed interaction parent turn ${pending.fact.turn.turnId} has an invalid committed input asset: root ${rootKind}`,
          );
        }
        const committedRecord = committed as { readonly taskCandidates?: unknown };
        // An explicit non-array taskCandidates has the same meaning: the asset
        // cannot be restored and is not a different user input. A legacy object
        // without that field keeps the existing different-input boundary.
        if (Object.hasOwn(committedRecord, 'taskCandidates') && !Array.isArray(committedRecord.taskCandidates)) {
          const candidatesKind = committedRecord.taskCandidates === null
            ? 'null'
            : typeof committedRecord.taskCandidates;
          throw new Error(
            `unclosed interaction parent turn ${pending.fact.turn.turnId} has an invalid committed input asset: taskCandidates ${candidatesKind}`,
          );
        }
        // Substituting the committed candidates back into the retry must
        // reproduce the committed input byte for byte. That single strict
        // comparison keeps this path to the same interaction/revision with all
        // user business input unchanged; any other difference still reaches
        // the existing different-input boundary.
        const restored = Array.isArray(committedRecord.taskCandidates)
          ? { ...effectiveRequest, taskCandidates: committedRecord.taskCandidates as readonly ExplicitBrainTaskCandidate[] }
          : undefined;
        if (restored !== undefined && JSON.stringify(restored) === committedText) {
          effectiveRequest = restored;
          break;
        }
        await abandonInterruptedTurn(pending);
        pending = await readPendingTurn();
      }
      if (pending !== undefined) {
        if (retained === undefined || retained.owner.turn.turnId !== pending.fact.turn.turnId) {
          if (pending.fact.providerBinding === undefined) {
            throw new Error(`unclosed interaction parent turn ${pending.fact.turn.turnId} cannot recover without the original committed provider binding`);
          }
          if (input.turnHelperJournal === undefined) {
            throw new Error(`unclosed interaction parent turn ${pending.fact.turn.turnId} requires the durable helper turn read port for cold recovery`);
          }
          const coldOwner = createInteractionParentTurnRawOwner({
            turn: pending.fact.turn,
            execution: pending.fact.execution,
            scope: pending.fact.scope,
            initialInput: pending.fact.initialInput,
            providerBinding: pending.fact.providerBinding,
            priorCheckpoints: pending.fact.priorCheckpoints,
            journal: input.parentJournal,
            rawContent: input.rawContent,
          });
          const helpers = new ExplicitTurnHelperSession({
            identity: pending.fact.turn,
            latestTurn: { ...pending.fact.turn, entries: [{ kind: 'user-input', content: pending.fact.initialInput }] },
            journal: input.helperJournal,
            clock: input.clock,
            factory: input.helperFactory,
            checkpointJournal: input.checkpointJournal,
            rawContent: input.rawContent,
            turnHelperJournal: input.turnHelperJournal,
          });
          const snapshot = await input.parentJournal.readTurnSnapshot(pending.fact.turn);
          // A closed turn only delivers its already-settled output when the
          // Runtime owner decides it is a terminal output. A closed failed
          // epoch with zero accepted facts decides `continue` instead, so it
          // falls through to the new physical epoch below rather than being
          // read as a false success.
          if (snapshot.resourceClose !== null
            && (await coldOwner.readReconciliationEligibility()).mode === 'terminal-output') {
            const finalParentOutput = await coldOwner.readClosedTurnOutput();
            let interpretation: ExplicitBrainInterpretation;
            try {
              interpretation = parseInterpreterOutput(finalParentOutput.assistantText, effectiveRequest);
            } catch (parseError) {
              // The closed turn's own durable terminal output is unusable.
              // Re-reading it can never recover; close it so new input works.
              return await closeUnparseableTurn(coldOwner, parseError);
            }
            await requireColdAnswerSettlement(finalParentOutput, interpretation);
            await helpers.closeTurnSemanticCheckpoint({ finalParentOutput, outcome: interpretation });
            return interpretation;
          }
          const durableHelpers = await input.turnHelperJournal.readTurnHelpers(pending.fact.turn);
          for (const entry of durableHelpers) {
            if (entry.readback.dispatchAccepted === null || entry.readback.returned === null) {
              throw new Error(`unclosed interaction parent turn ${pending.fact.turn.turnId} holds on unreturned helper ${entry.identity.helperCallId}`);
            }
          }
          const priorReconciliation = snapshot.ownerReconciliations.at(-1);
          const activeOwner = priorReconciliation?.fact.replacementOwner ?? pending.fact.executionOwner;
          if (activeOwner === undefined) {
            throw new Error(`unclosed interaction parent turn ${pending.fact.turn.turnId} cannot recover without an attested execution owner`);
          }
          if (activeLease === undefined) throw new Error('interaction parent recovery requires active supervisor lease authority');
          const reconciliation = await activeLease.withCurrentLeaseOwner(async (authenticatedCaller, isCommittedReplacement) => {
            if (priorReconciliation !== undefined
              && snapshot.resourceClose === null
              && authenticatedCaller.daemonLeaseId === activeOwner.daemonLeaseId
              && authenticatedCaller.daemonGeneration === activeOwner.daemonGeneration
              && authenticatedCaller.processStartToken === activeOwner.processStartToken) return priorReconciliation;
            return coldOwner.reconcileTurnOwner({
              previousOwner: activeOwner, replacementOwner: authenticatedCaller,
              isCommittedReplacement: await isCommittedReplacement(activeOwner), reconciledAt: input.clock.now(),
            });
          });
          if (reconciliation.fact.mode === 'terminal-output') {
            const finalParentOutput = await coldOwner.readReconciledTurnOutput();
            let interpretation: ExplicitBrainInterpretation;
            try {
              interpretation = parseInterpreterOutput(finalParentOutput.assistantText, effectiveRequest);
            } catch (parseError) {
              return await closeUnparseableTurn(coldOwner, parseError);
            }
            await requireColdAnswerSettlement(finalParentOutput, interpretation);
            await helpers.closeTurnSemanticCheckpoint({ finalParentOutput, outcome: interpretation });
            return interpretation;
          }
          if (input.prepareAgentProvider === undefined) {
            throw new Error('interaction parent continuation requires an owned provider preparer');
          }
          continuation = { fact: pending.fact, executionEpoch: reconciliation.fact.effectiveExecutionEpoch,
            executionOwner: reconciliation.fact.replacementOwner };
        } else {
          await prepareScopeSemanticHistory({ activeTurn: pending.fact.turn, parentJournal: input.parentJournal, checkpointJournal: input.checkpointJournal });
          return finish(retained, effectiveRequest);
        }
      }
      if (input.lease !== undefined && activeLease === undefined) {
        throw new Error('interaction parent turn requires active supervisor lease authority');
      }
      const identity = randomUUID();
      const runtimeId = continuation?.fact.execution.runtimeId ?? `explicit-interpret-${identity}`;
      const executionEpoch = continuation?.executionEpoch ?? 1;
      const turn: InteractionTurnIdentity = continuation?.fact.turn ?? {
        organId: input.organId, interactionScopeId: input.interactionScopeId,
        interactionId: effectiveRequest.interactionId, inputRevision: effectiveRequest.inputRevision, turnId: runtimeId,
      };
      const priorCheckpoints = continuation?.fact.priorCheckpoints
        ?? await prepareScopeSemanticHistory({ activeTurn: turn, parentJournal: input.parentJournal, checkpointJournal: input.checkpointJournal });
      const owned = await input.prepareAgentProvider?.({ roleId: 'interaction' });
      // One selected binding for the whole turn: the raw owner freezes it, and
      // the driver uses the same value. A borrowed provider keeps its existing
      // non-closing ownership; only the original owner records a close fact.
      const turnProviderBinding = owned === undefined ? input.binding : owned.binding;
      let driver: ProviderAgentDriver<InteractionParentProviderExecutionIdentityRef> | undefined;
      let owner: InteractionParentTurnRawOwner | undefined;
      let committedInput = false;
      let submitted = false;
      let settleAttempted = false;
      /**
       * Set only when this exact batch produced a durable terminal output that
       * no decision can be parsed from. Every other failure keeps its own
       * explicit error and its own recovery lane.
       */
      let unparseableOutput = false;
      let interpretation: ExplicitBrainInterpretation;
      let live: NonNullable<typeof retained>;
      try {
        if (continuation !== undefined && (owned === undefined
          || (['bindingId', 'providerId', 'protocol', 'endpointRef', 'modelRef', 'configDigest', 'capabilityDigest'] as const)
            .some((key) => turnProviderBinding[key] !== continuation.fact.providerBinding![key]))) {
          throw new Error('interaction parent continuation requires the original full provider binding on an owned composition');
        }
        const operationId = continuation?.fact.execution.operationId ?? id('operation', `explicit-interpret-${identity}`);
        const execution = { runtimeId, organId: input.organId, operationId, executionEpoch, interactionTurn: turn };
        const scope = continuation?.fact.scope ?? { organId: input.organId, operationId };
        const initialInput = continuation?.fact.initialInput ?? {
          ref: await input.rawEvidence.write({ scope, kind: 'execution', type: 'initial-input', locator: turn.turnId, content: JSON.stringify(effectiveRequest) }),
          view: { kind: 'utf8-text' as const },
        };
        const openOwner = async (executionOwner?: OccurrenceExecutionOwner) => {
          const createdOwner = createInteractionParentTurnRawOwner({
            turn, execution, scope, initialInput, providerBinding: turnProviderBinding,
            ...(executionOwner === undefined ? {} : { executionOwner }),
            journal: input.parentJournal, rawContent: input.rawContent, priorCheckpoints,
            instructions: async () => ({ text: interpreterPrompt(effectiveRequest, await loadPromptSegments()), toolSurface: 'intake-decision' }),
          });
          owner = createdOwner;
          await createdOwner.openTurnInput();
          committedInput = true;
          return createdOwner;
        };
        const createdOwner = continuation !== undefined
          ? await openOwner(continuation.executionOwner)
          : activeLease === undefined ? await openOwner()
            : await activeLease.withCurrentLeaseOwner((authenticatedCaller) => openOwner(authenticatedCaller));
        // A continued turn anchors its first epoch request to the settled
        // parent leaf so the recovered Provider run is not a second root.
        const parentRequest = continuation === undefined
          ? undefined
          : await createdOwner.readContinuationParentRequest();
        const helpers = new ExplicitTurnHelperSession({
          identity: turn, latestTurn: { ...turn, entries: [{ kind: 'user-input', content: initialInput }] },
          journal: input.helperJournal, clock: input.clock, factory: input.helperFactory,
          checkpointJournal: input.checkpointJournal, rawContent: input.rawContent,
          turnHelperJournal: input.turnHelperJournal,
        });
        const port = owned?.port ?? input.port;
        if (port === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction parent provider is not configured');
        driver = new ProviderAgentDriver<InteractionParentProviderExecutionIdentityRef>({
          port,
          binding: turnProviderBinding,
          runtimeId,
          organId: input.organId,
          interactionTurn: turn,
          operationId,
          executionEpoch,
          ...(parentRequest === undefined ? {} : { parentRequest }),
          assignmentId: `explicit-interpret-${identity}`,
          scope,
          inputRefs: [`humanagent://interaction/${effectiveRequest.interactionId}/revision/${effectiveRequest.inputRevision}`],
          ownerId: 'humanagent.runtime.explicit-brain',
          rawEvidence: input.rawEvidence,
          registerRequest: (registration) => createdOwner.registerRequest(registration),
          acceptRawFact: (envelope) => createdOwner.acceptRawFact(envelope),
          requestContext: createdOwner.requestContext,
          tools: [
            { toolId: 'dispatch_helper', description: 'Dispatch independent bounded helper work. Return is not acceptance. Include the required structured helper result contract in the bounded inputs.', inputSchema: {
              type: 'object', properties: {
                selection: { type: 'object', properties: { roleId: { type: 'string' }, configuredAgentId: { type: 'string' } }, required: ['roleId'] },
                assignmentFields: {
                  type: 'object', properties: {
                    objective: { type: 'string' }, targetRefs: { type: 'array', items: { type: 'string' } },
                    expectedOutputRefs: { type: 'array', items: { type: 'string' } },
                    successCriteria: { type: 'array', items: { type: 'string' } },
                    failureCriteria: { type: 'array', items: { type: 'string' } }, incompleteCriteria: { type: 'array', items: { type: 'string' } },
                    requiredCapabilities: { type: 'array', items: { type: 'string' } }, mergeGate: { type: 'string', enum: ['required', 'not-required'] },
                  }, required: ['objective', 'targetRefs', 'expectedOutputRefs', 'successCriteria', 'failureCriteria', 'incompleteCriteria', 'requiredCapabilities', 'mergeGate'],
                },
                inputs: { type: 'object' }, evidenceRefs: { type: 'array', items: { type: 'object' } },
              }, required: ['selection', 'assignmentFields', 'inputs', 'evidenceRefs'],
            } },
            { toolId: 'accept_helper', description: 'Explicitly accept a returned helper with refined text.', inputSchema: { type: 'object', properties: { helperCallId: { type: 'string' }, refinedText: { type: 'string' }, acceptanceRef: { type: 'string' }, evidenceRefs: { type: 'array' } }, required: ['helperCallId', 'refinedText', 'acceptanceRef', 'evidenceRefs'] } },
          ],
          executeTool: {
            async execute({ call }) {
              const args = call.arguments;
              if (!Array.isArray(args.evidenceRefs)) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'helper evidenceRefs must be an array');
              const evidenceRefs = args.evidenceRefs.map((ref) => { const evidence = ref as unknown as EvidenceRef; assertEvidenceRef(evidence); return evidence; });
              let result: unknown;
              if (call.toolId === 'dispatch_helper') {
                const selection = args.selection as { roleId?: unknown; configuredAgentId?: unknown } | undefined;
                if (!selection || typeof selection.roleId !== 'string'
                  || (selection.configuredAgentId !== undefined && typeof selection.configuredAgentId !== 'string')
                  || !args.assignmentFields || !args.inputs || !Array.isArray(args.evidenceRefs)) {
                  throw new ExplicitBrainOperationalToolError('unsupported-tool', 'invalid dispatch_helper arguments');
                }
                const assignmentFields = args.assignmentFields as Record<string, unknown>;
                const objective = nonEmptyString(assignmentFields, 'objective');
                const successCriteria = stringArray(assignmentFields, 'successCriteria');
                result = await helpers.dispatchHelper({
                  selection: { roleId: selection.roleId, ...(selection.configuredAgentId === undefined ? {} : { configuredAgentId: selection.configuredAgentId }) },
                  assignmentFields: args.assignmentFields as unknown as InteractionHelperAssignmentFields,
                  inputs: args.inputs as BusinessPayload,
                  evidenceRefs,
                  checkpointDescription: `Helper dispatch objective: ${objective}. Success criteria: ${successCriteria.join('; ')}. Owner acceptance is pending.`,
                  conclude: ({ events }) => {
                    const raw = events.filter((event) => event.kind === 'provider.output')
                      .map((event) => ('summary' in event ? event.summary : '')).join('');
                    const result = JSON.parse(raw) as InteractionHelperResultFields;
                    // Runtime validates these fields against its assignment. Do
                    // not let returned JSON replace Runtime's helper identity.
                    return {
                      agentId: result.agentId, producedArtifactRefs: result.producedArtifactRefs,
                      ...(result.producedArtifactBodies === undefined ? {} : { producedArtifactBodies: result.producedArtifactBodies }),
                      status: result.status, summary: result.summary, outputRefs: result.outputRefs,
                      evidenceRefs: result.evidenceRefs, nextAction: result.nextAction,
                      ...(result.conditionRef === undefined ? {} : { conditionRef: result.conditionRef }),
                      ...(result.failureRef === undefined ? {} : { failureRef: result.failureRef }),
                    };
                  },
                });
              } else if (call.toolId === 'accept_helper') {
                const helperCallId = nonEmptyString(args, 'helperCallId');
                const refinedText = nonEmptyString(args, 'refinedText');
                const acceptanceRef = nonEmptyString(args, 'acceptanceRef');
                if (!Array.isArray(args.evidenceRefs)) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'accept_helper evidenceRefs must be an array');
                const refinedResult = {
                  ref: await input.rawEvidence.write({ scope, kind: 'execution', type: 'accepted-helper', locator: helperCallId, content: refinedText }),
                  view: { kind: 'utf8-text' as const },
                };
                result = await helpers.acceptHelper({ helperCallId, refinedResult, acceptanceRef,
                  checkpointDescription: refinedText,
                  acceptedBy: 'humanagent.runtime.explicit-brain', evidenceRefs });
              } else {
                throw new ExplicitBrainOperationalToolError('unsupported-tool', `unknown interaction tool ${call.toolId}`);
              }
              return { output: JSON.stringify(result), outputRefs: [], evidenceRefs: [] };
            },
          },
        });
        await driver.start({ ...execution, assignmentId: `explicit-interpret-${identity}` });
        await driver.submit({
          ...execution,
          executionEpoch,
          assignmentId: `explicit-interpret-${identity}`,
          payload: {},
        });
        submitted = true;
        for await (const event of driver.observe({ runtimeId })) {
          if (event.terminalState !== undefined) break;
        }
        settleAttempted = true;
        const closure = await driver.settle({ runtimeId, executionEpoch });
        if (closure.state !== 'succeeded') {
          throw new ExplicitBrainOperationalToolError('unsupported-tool', `interaction agent ended in ${closure.state}`);
        }
        if (continuation === undefined) {
          const finalParentOutput = await createdOwner.readFinalTurnOutput();
          try {
            interpretation = parseInterpreterOutput(finalParentOutput.assistantText, effectiveRequest);
          } catch (parseError) {
            // The terminal output is durable and unusable. Mark the shape so the
            // catch below can close the turn honestly after the provider close,
            // instead of leaving it pending forever.
            unparseableOutput = true;
            throw parseError;
          }
          // Only the simple-answer path carries the authoritative settlement receipt;
          // complex requirement routing keeps its existing behavior.
          if (interpretation.kind === 'answer' && input.publishProviderSettlement !== undefined) {
            const settlement = driver.settlement();
            if (settlement === undefined) {
              throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction agent settled without a provider settlement');
            }
            await input.publishProviderSettlement({
              interactionId: effectiveRequest.interactionId,
              inputRevision: effectiveRequest.inputRevision,
              request: finalParentOutput.terminalRequest.request,
              settlement,
            });
          }
        }
        live = {
          owner: createdOwner,
          helpers,
          owned,
          reconciled: continuation !== undefined,
          settlement: driver.settlement(),
          publishOnRetry: false,
        };
        retained = live;
      } catch (error) {
        let failure = error;
        if (submitted && !settleAttempted && driver !== undefined) {
          settleAttempted = true;
          try {
            await driver.settle({ runtimeId, executionEpoch });
          } catch (settleError) {
            failure = new AggregateError([failure, settleError], 'interaction observation and settlement failed');
          }
        }
        // Every cleanup step below runs even when an earlier one fails. A
        // failed close used to throw away the only chance to record a durable
        // terminal fact, so one broken stream left the whole interaction scope
        // blocked until the daemon restarted.
        const cleanupFailures: unknown[] = [];
        if (owned !== undefined) {
          let receipt: Awaited<ReturnType<typeof closeAgentProvider>> | undefined;
          try {
            receipt = await closeAgentProvider(owned, { returnReceipt: true });
          } catch (closeError) {
            cleanupFailures.push(closeError);
          }
          // Record the real close even without a successful semantic output.
          // The turn input must already be committed; a failed input commit
          // keeps the original error and records no fabricated fact.
          if (receipt !== undefined && owner !== undefined && committedInput) {
            try {
              await owner.recordProviderClose({
                providerBinding: owned.binding,
                result: receipt,
                closedAt: input.clock.now(),
              });
            } catch (recordError) {
              cleanupFailures.push(recordError);
            }
          }
        }
        if (unparseableOutput) {
          if (owner === undefined || !committedInput) {
            throw new Error(
              'interaction terminal output is unusable but the committed turn input is unavailable to close it',
            );
          }
          // The real terminal output exists and no decision can be parsed from
          // it. Close the turn durably so the next input is not blocked; the
          // original explicit parse error stays the primary failure.
          try {
            await owner.closeUnparseableTurn({ failedAt: input.clock.now() });
          } catch (closeError) {
            cleanupFailures.push(closeError);
          }
        } else if (owner !== undefined && committedInput) {
          // This batch failed before any terminal output, and this process owns
          // the stream that died, so it is the only party that can honestly
          // attest that this epoch can never deliver. A shape with its own
          // recovery lane (a deliverable output, the closed-zero-fact
          // continuation, a committed settlement or a tool side effect) keeps
          // that lane instead of being closed here.
          try {
            const eligibility = await owner.readExecutionFailureEligibility();
            if (eligibility.closable) {
              const heldReason = input.turnHelperJournal === undefined
                ? 'the durable helper turn read port is unavailable'
                : await holdsDispatchedHelper(input.turnHelperJournal, owner.turn);
              if (heldReason === undefined) {
                await owner.closeFailedEpoch({ failedAt: input.clock.now() });
              }
            }
          } catch (closeError) {
            cleanupFailures.push(closeError);
          }
        }
        if (cleanupFailures.length > 0) {
          // The primary failure stays first and named in the message: the
          // cleanup detail is additive, never a replacement for the cause.
          throw new AggregateError(
            [failure, ...cleanupFailures],
            `interaction execution failed: ${describeFailure(failure)}`,
          );
        }
        throw failure;
      }
      return finish(live, effectiveRequest);
    },
  };
}

function createWorkspacePort(options: ExplicitBrainRuntimeOptions): ExplicitBrainWorkspaceToolPort {
  const workspaceRef = `workspace:${options.projectKey}`;
  const scopeRef = `scope:${workspaceRef}`;
  const functions = new WorkspaceCodeSearchFunctions({ workspaceRef, workspaceRoot: options.workspaceRoot });
  function authorizeScope(input: { readonly scopeRef: string }): void {
    if (input.scopeRef !== scopeRef) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', `workspace scope is not registered: ${input.scopeRef}`);
    }
  }
  return {
    authorize(input) {
      authorizeScope(input);
    },
    async list(input) {
      authorizeScope(input);
      return functions.findFiles({ workspaceRef, path: input.pathRef ?? '.', maxFiles: 100 });
    },
    async read(input) {
      authorizeScope(input);
      return functions.readFile({ workspaceRef, path: input.pathRef });
    },
    async search(input) {
      authorizeScope(input);
      const files = await functions.findFiles({ workspaceRef, path: '.', maxFiles: 100 });
      const matches: Array<{ readonly path: string; readonly lines: readonly number[] }> = [];
      let exhaustedCandidates = true;
      for (let index = 0; index < files.paths.length; index += 1) {
        const path = files.paths[index];
        const content = await functions.readFile({ workspaceRef, path });
        const lines = content.content.split('\n')
          .map((line, index) => line.includes(input.query) ? index + 1 : undefined)
          .filter((line): line is number => line !== undefined);
        if (lines.length > 0) matches.push({ path, lines });
        if (matches.length >= input.limit) {
          exhaustedCandidates = index === files.paths.length - 1;
          break;
        }
      }
      return { query: input.query, matches, complete: files.complete && exhaustedCandidates };
    },
  };
}

function createAgentPort(options: ExplicitBrainRuntimeOptions): ExplicitBrainAgentToolPort {
  function targetFor(input: { readonly agentRef?: string; readonly scopeRef?: string }): ExplicitBrainAgentTarget {
    const target = options.agentTargets?.find((candidate) => (
      (input.agentRef === undefined || candidate.agentRef === input.agentRef)
      && (input.scopeRef === undefined || candidate.scopeRef === input.scopeRef)
    ));
    if (target === undefined) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent target is not registered for this runtime');
    }
    return target;
  }
  function authorizeQuery(input: { readonly agentRef?: string; readonly scopeRef?: string }): ExplicitBrainAgentTarget {
    const target = targetFor(input);
    if (!target.queryable) throw new ExplicitBrainOperationalToolError('unsupported-tool', `agent query is not authorized: ${target.agentRef}`);
    if (options.queryAgent === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent query port is not configured');
    return target;
  }
  function authorizeMessage(input: { readonly recipientRef: string; readonly messageClass: 'control' | 'data' | 'observation' }): ExplicitBrainAgentTarget {
    const target = targetFor({ agentRef: input.recipientRef });
    if (options.sendAgentMessage === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent communication port is not configured');
    if (!target.messageClasses.includes(input.messageClass)) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', `agent message class is not authorized: ${input.messageClass}`);
    }
    return target;
  }
  return {
    authorizeQuery(input) {
      authorizeQuery(input);
    },
    authorizeMessage(input) {
      authorizeMessage(input);
    },
    async query(input) {
      const queryAgent = options.queryAgent;
      if (queryAgent === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent query port is not configured');
      const target = authorizeQuery(input);
      return queryAgent({ agentRef: target.agentRef, scopeRef: target.scopeRef });
    },
    async message(input) {
      const sendAgentMessage = options.sendAgentMessage;
      if (sendAgentMessage === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent communication port is not configured');
      authorizeMessage(input);
      return sendAgentMessage(input);
    },
  };
}

export function createExplicitBrainRuntime(options: ExplicitBrainRuntimeOptions): ExplicitBrainRuntime {
  const binding: ExplicitBrainRuntimeBinding = {
    runtimeId: `runtime:explicit-brain:${options.projectKey}`,
    agentInstanceId: `agent:explicit-brain:${options.projectKey}`,
    roleId: 'interaction',
    templateRef: EXPLICIT_BRAIN_TEMPLATE_REF,
    interactionScopeId: `runtime:${options.projectKey}`,
    executionEpoch: 1,
    permissionRevision: 'permission:explicit-brain:v1',
    capabilityDigest: CAPABILITY_DIGEST,
    bindingRef: `binding:explicit-brain:${options.projectKey}`,
    scopeRef: `scope:interaction:${options.projectKey}`,
    permissions: ['workspace.read', 'agent.read', 'agent.message'],
    capabilities: ['workspace.list', 'file.read', 'file.search', 'agent.query', 'agent.message'],
  };
  const ports = {
    workspace: createWorkspacePort(options),
    agent: createAgentPort(options),
  } satisfies ExplicitBrainOperationalToolPorts;
  const executor = new ExplicitBrainDecisionExecutor<unknown>({
    registry: createExplicitBrainToolRegistry(CAPABILITY_DIGEST),
    binding,
    operationalPorts: ports,
    traces: options.traces,
    handler: {
      async execute() {
        throw new ExplicitBrainOperationalToolError('unsupported-tool', 'explicit brain tool is not connected to a runtime owner');
      },
    },
    context: {
      scopeRef: binding.scopeRef,
      runtimeBindingRef: binding.bindingRef,
      ownerRef: 'humanagent.runtime.explicit-brain',
      createdAt: new Date().toISOString(),
      inputDigest: 'sha256:runtime-explicit-brain',
      argumentsRef: (intent) => `arguments:${intent.toolIntentId}`,
    },
    currentEpoch: binding.executionEpoch,
    currentPermissionRevision: binding.permissionRevision,
    argumentsDigest: digestArguments,
  });
  return {
    binding,
    ports,
    execute: async (decision) => (await executor.execute(decision)).map((result) => result.result),
  };
}
