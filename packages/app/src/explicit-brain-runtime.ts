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
import type { SupervisorLease } from './supervisor/supervisor.js';

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

function parseInterpreterOutput(output: string, input: ExplicitBrainInterpretationInput): ExplicitBrainInterpretation {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1];
  const candidate = fenced ?? output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    throw new ExplicitBrainOperationalToolError(
      'unsupported-tool',
      `interaction agent returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object') {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction agent returned a non-object decision');
  }
  const record = value as Record<string, unknown>;
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
    const interpretation = parseInterpreterOutput(finalParentOutput.assistantText, request);
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
      const opened = await input.parentJournal.readScopeOpenedTurns(scopeKey);
      const closed = await input.checkpointJournal.readScopeSemanticCheckpoints(scopeKey);
      const pending = opened.find(({ fact }) => !closed.some(({ checkpoint }) =>
        checkpoint.organId.scope === fact.turn.organId.scope
        && checkpoint.organId.value === fact.turn.organId.value
        && checkpoint.interactionScopeId === fact.turn.interactionScopeId
        && checkpoint.interactionId === fact.turn.interactionId
        && checkpoint.inputRevision === fact.turn.inputRevision
        && checkpoint.turnId === fact.turn.turnId));
      if (pending !== undefined) {
        const original = await input.rawContent.read({ scope: pending.fact.scope, content: pending.fact.initialInput });
        if (new TextDecoder('utf-8', { fatal: true }).decode(original) !== JSON.stringify(request)) {
          throw new Error(`unclosed interaction parent turn ${pending.fact.turn.turnId} requires its exact prior input before new input`);
        }
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
            const interpretation = parseInterpreterOutput(finalParentOutput.assistantText, request);
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
            const interpretation = parseInterpreterOutput(finalParentOutput.assistantText, request);
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
          return finish(retained, request);
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
        interactionId: request.interactionId, inputRevision: request.inputRevision, turnId: runtimeId,
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
          ref: await input.rawEvidence.write({ scope, kind: 'execution', type: 'initial-input', locator: turn.turnId, content: JSON.stringify(request) }),
          view: { kind: 'utf8-text' as const },
        };
        const openOwner = async (executionOwner?: OccurrenceExecutionOwner) => {
          const createdOwner = createInteractionParentTurnRawOwner({
            turn, execution, scope, initialInput, providerBinding: turnProviderBinding,
            ...(executionOwner === undefined ? {} : { executionOwner }),
            journal: input.parentJournal, rawContent: input.rawContent, priorCheckpoints,
            instructions: async () => ({ text: interpreterPrompt(request, await loadPromptSegments()) }),
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
          inputRefs: [`humanagent://interaction/${request.interactionId}/revision/${request.inputRevision}`],
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
          interpretation = parseInterpreterOutput(finalParentOutput.assistantText, request);
          // Only the simple-answer path carries the authoritative settlement receipt;
          // complex requirement routing keeps its existing behavior.
          if (interpretation.kind === 'answer' && input.publishProviderSettlement !== undefined) {
            const settlement = driver.settlement();
            if (settlement === undefined) {
              throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction agent settled without a provider settlement');
            }
            await input.publishProviderSettlement({
              interactionId: request.interactionId,
              inputRevision: request.inputRevision,
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
        if (owned !== undefined) {
          try {
            const receipt = await closeAgentProvider(owned, { returnReceipt: true });
            // Record the real close even without a successful semantic output.
            // The turn input must already be committed; a failed input commit
            // keeps the original error and records no fabricated fact.
            if (owner !== undefined && committedInput) {
              await owner.recordProviderClose({
                providerBinding: owned.binding,
                result: receipt,
                closedAt: input.clock.now(),
              });
            }
          } catch (closeError) {
            throw new AggregateError([failure, closeError], 'interaction execution and provider close failed');
          }
        }
        throw failure;
      }
      return finish(live, request);
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
