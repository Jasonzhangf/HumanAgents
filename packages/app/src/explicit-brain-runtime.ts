import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  EXPLICIT_BRAIN_MODEL_TOOLS,
  EXPLICIT_BRAIN_TEMPLATE_REF,
  id,
  type ExecutionRuntimePort,
  type EvidenceRef,
  type InteractionParentProviderExecutionIdentityRef,
  type InteractionTurnIdentity,
  type OrganId,
  type InteractionProviderSettlementReceipt,
  type RawContentReadPort,
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
  type ProviderToolDefinition,
  STANDARD_TURN_END_WIRE_TOOL_ID,
  type ExplicitTurnEndAcceptedResult,
  type ExplicitTurnEndRequestRelation,
  type ExplicitTurnPartialResult,
} from '../../contracts/src/index.js';
import {
  ProviderAgentDriver,
  type ProviderAgentEvent,
  type ProviderToolExecutionResult,
} from '../../adapters/provider/src/index.js';
import { BudgetedProviderObservations, DEFAULT_UI_EXECUTION_EVENT_BUDGET } from '../../runtime/src/ui-runtime/execution-budget.js';
import { RuntimeTaskControlError } from '../../runtime/src/ui-runtime/coordinator.js';
import { AppLifecycleError } from './errors.js';
import { UiRuntimeApiError } from './ui-runtime/errors.js';
import type { AgentIoEventBudget } from '../../runtime/src/agent-io/types.js';
import type { ProviderEvidenceSink } from '../../adapters/provider/src/evidence.js';
import { prepareScopeSemanticHistory } from '../../runtime/src/context/interaction-semantic-context.js';
import {
  createFilePromptSource,
  loadBuiltinPromptSegments,
  loadRegisteredSkills,
  loadSelectedSkillContent,
  managementRoleForAgent,
  MANAGEMENT_PROMPT_REFS,
  type ManagementRole,
  renderSkillDirectory,
  type AgentPromptSegment,
  type RegisteredSkill,
} from '../../agent-templates/src/index.js';
import { WorkspaceCodeSearchFunctions } from '../../adapters/operations/src/index.js';
import {
  ExplicitBrainDecisionExecutor,
  ExplicitBrainOperationalToolError,
  ExplicitBrainTerminalOutputError,
  ExplicitTurnHelperSession,
  createInteractionParentTurnRawOwner,
  readInteractionProviderSettlement,
  publishInteractionProviderSettlement,
  type ExplicitTurnHelperFactory,
  type InteractionHelperJournalPort,
  type InteractionHelperTurnReadPort,
  type InteractionParentFinalTurnOutput,
  type InteractionParentTurnRawJournalPort,
  type InteractionParentOpenedTurnScopeReadPort,
  type InteractionSemanticCheckpointJournalPort,
  type ExplicitTurnInterpretedOutcome,
  type InteractionParentTurnRawOwner,
  createExplicitBrainToolRegistry,
  type ExplicitBrainAgentToolPort,
  type ExplicitBrainOperationalToolPorts,
  type ExplicitBrainRuntimeBinding,
  type ExplicitBrainWorkspaceToolPort,
} from '../../runtime/src/explicit-brain/index.js';
import type { DecisionTracePort } from '../../runtime/src/explicit-brain/attention.js';
import {
  beginExplicitEndAttempt,
  submitExplicitTurnEnd,
  readExplicitEndOutcome,
  type ExplicitEndSubmission,
} from '../../runtime/src/explicit-brain/explicit-turn-end.js';
import type { ExplicitInteractionStepInput } from '../../runtime/src/intake/explicit-intake.js';
import { closeAgentProvider, type AgentProviderComposition } from './agent-driver-composition.js';
import { readSupervisorTerminationReceipts, type SupervisorLease } from './supervisor/supervisor.js';

const CAPABILITY_DIGEST = `sha256:${createHash('sha256').update(EXPLICIT_BRAIN_MODEL_TOOLS.join('|')).digest('hex')}`;

// Keep the role invariant before tools, selected Skills and the current scope.
const INTAKE_PROMPT_SEGMENT_REFS = [
  'common/control-boundaries.md',
  'interaction/profiles/explicit-brain/identity.md',
  'interaction/profiles/explicit-brain/mission.md',
  'interaction/profiles/explicit-brain/boundaries.md',
  'interaction/profiles/explicit-brain/input-output.md',
  'interaction/profiles/explicit-brain/failure.md',
] as const;

const INTAKE_SKILL_REFS = {
  'task-intake': 'interaction/skills/task-intake/SKILL.md',
  'task-follow-through': 'interaction/skills/task-follow-through/SKILL.md',
  'project-management': 'interaction/skills/project-management/SKILL.md',
  'agent-addressing': 'interaction/skills/agent-addressing/SKILL.md',
  'agent-communication': 'interaction/skills/agent-communication/SKILL.md',
} as const;
type IntakeSkillId = keyof typeof INTAKE_SKILL_REFS;
const INTAKE_SKILL_IDS = Object.keys(INTAKE_SKILL_REFS) as readonly IntakeSkillId[];

const SKILL_SELECTION_TOOL: ProviderToolDefinition = {
  toolId: 'interaction.select_skills',
  description: 'Select registered standard Skills whose guidance is needed for the current request.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['skillIds'],
    properties: {
      skillIds: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { type: 'string', enum: [...INTAKE_SKILL_IDS] },
      },
    },
  },
};

const NONEMPTY_STRING_SCHEMA = { type: 'string', minLength: 1 };
const TASK_TITLE_MAX_CHARACTERS = 50;
const TASK_TITLE_SCHEMA = {
  type: 'string',
  minLength: 1,
  description: 'Short business title, at most 50 characters; the runtime truncates longer values. No paths, internal identifiers or the full request text.',
};

/**
 * Normalize a model-authored task title at the explicit interpretation
 * boundary. Collapse whitespace, then cap at 50 Unicode code points. The full
 * request text stays in normalizedInput/objective and is never truncated.
 */
export function normalizeTaskTitle(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  if (!collapsed) {
    throw new ExplicitBrainOperationalToolError(
      'unsupported-tool',
      'requirement proposal title must be a non-empty string',
    );
  }
  return Array.from(collapsed).slice(0, TASK_TITLE_MAX_CHARACTERS).join('');
}

const TASK_RESULT_READ_TOOL: ProviderToolDefinition = {
  toolId: 'task.read_result',
  description: 'Read an existing task public result in the host-authorized project using only taskId. No filesystem access or new execution. Ambiguous execution requires clarification; unavailable or partial publication is not a completed result.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'],
    properties: { taskId: NONEMPTY_STRING_SCHEMA } },
};
const STRING_LIST_SCHEMA = { type: 'array', items: NONEMPTY_STRING_SCHEMA, uniqueItems: true };
const PROJECT_SNAPSHOT_TOOL: ProviderToolDefinition = {
  toolId: 'project.snapshot',
  description: 'Read the authorized project roster, member boards, runtime status and latest session activity. Omit members for the full roster, or pass exact member references. Missing observations do not establish availability.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { members: { ...STRING_LIST_SCHEMA, minItems: 1 } } },
};
const EXPLICIT_END_TOOL: ProviderToolDefinition = {
  toolId: STANDARD_TURN_END_WIRE_TOOL_ID,
  description: 'Finish explicit intake with a validated simple decision or a complex requirement and semantic capsule. This does not execute a task.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['kind', 'decision', 'checkpointRecord'],
    properties: {
      kind: { type: 'string', enum: ['simple', 'complex'] },
      checkpointRecord: {
        type: 'object', additionalProperties: false, required: ['index'],
        properties: {
          index: {
            type: 'object', additionalProperties: false, required: ['action', 'result'],
            properties: { action: NONEMPTY_STRING_SCHEMA, result: NONEMPTY_STRING_SCHEMA },
          },
        },
      },
      decision: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'normalizedInput', 'knownFacts', 'decisionRefs'],
        properties: {
          kind: { type: 'string', enum: ['answer', 'status-query', 'clarification', 'requirement'] },
          normalizedInput: NONEMPTY_STRING_SCHEMA, knownFacts: STRING_LIST_SCHEMA, decisionRefs: STRING_LIST_SCHEMA,
          answer: NONEMPTY_STRING_SCHEMA, question: NONEMPTY_STRING_SCHEMA, options: STRING_LIST_SCHEMA,
          matchedTaskId: NONEMPTY_STRING_SCHEMA,
          requestRelation: {
            oneOf: [
              { type: 'object', additionalProperties: false, required: ['kind'],
                properties: { kind: { type: 'string', const: 'new' } } },
              { type: 'object', additionalProperties: false, required: ['kind', 'candidateId'],
                properties: { kind: { type: 'string', const: 'continue' }, candidateId: NONEMPTY_STRING_SCHEMA,
                  action: { type: 'string', const: 'resume-dispatch' } } },
            ],
          },
          taskFlow: {
            type: 'object', additionalProperties: false, required: ['kind', 'definitionVersion'],
            properties: { kind: { type: 'string', enum: [...TASK_FLOW_KINDS] }, definitionVersion: { type: 'integer', const: TASK_FLOW_DEFINITION_VERSION } },
          },
          proposal: {
            type: 'object', additionalProperties: false,
            required: ['revision', 'intent', 'title', 'objective', 'deliverable', 'deliveryConditions', 'evidenceRefs', 'blockingGaps'],
            properties: {
              revision: { type: 'integer', minimum: 0 }, intent: { type: 'string', enum: ['create', 'append', 'change'] },
              title: TASK_TITLE_SCHEMA, objective: NONEMPTY_STRING_SCHEMA, deliverable: NONEMPTY_STRING_SCHEMA,
              deliveryConditions: STRING_LIST_SCHEMA, evidenceRefs: STRING_LIST_SCHEMA, blockingGaps: STRING_LIST_SCHEMA,
            },
          },
        },
      },
      capsule: {
        type: 'object', additionalProperties: false, required: ['summary', 'goal', 'process', 'findings', 'nextStep'],
        properties: {
          summary: NONEMPTY_STRING_SCHEMA, goal: NONEMPTY_STRING_SCHEMA, process: STRING_LIST_SCHEMA,
          findings: STRING_LIST_SCHEMA, nextStep: NONEMPTY_STRING_SCHEMA, detailRefs: STRING_LIST_SCHEMA,
        },
      },
    },
  },
};

const REGISTERED_TOOL_SURFACE = [
  '# Registered tools',
  'Use the current advertised schemas. Select all applicable standard Skill IDs together with interaction.select_skills when guidance is needed. This only loads guidance.',
  'When present, task.read_result accepts only taskId. Use it to read the exact existing task, its published result and its recovery condition. A read does not grant continuation or write authority.',
  'A project Manager may use the advertised project.snapshot to read current project facts under the project-management Skill. The confirmed task flow owns dispatch and business execution.',
].join('\n');

const INTAKE_OUTPUT_PROTOCOL = [
  '# Explicit end-tool protocol',
  'This is one intake decision, not one turn of task execution. Produce exactly one decision object for the current input and claim no task execution.',
  'For a simple question you can answer from the supplied context, call humanagent_turn_end with kind=simple and your structured decision.',
  'For a request that needs registered Skill guidance, call interaction.select_skills once with every relevant registered Skill ID. The tool only loads prompt guidance; it does not perform project, agent, or communication operations.',
  'After any Skill result, call humanagent_turn_end with one decision. Do not dispatch helpers or execute business work. Text alone cannot finish this turn.',
  'The end arguments contain kind=simple or complex, a decision object, and checkpointRecord.index with one-sentence action and result. decision.kind must be requirement, status-query, clarification, or answer. A requirement uses complex and must include capsule with summary, goal, process (string array), findings (string array), nextStep and optional detailRefs. All other decisions use simple with no capsule; the answer is its detail.',
  'Inside decision, always include kind, normalizedInput, knownFacts (string array), and decisionRefs (string array). Add proposal, optional taskFlow and matchedTaskId for requirement; answer for status-query and answer; or question and optional options (string array) for clarification. Proposal fields belong only inside proposal.',
  'For a requirement, proposal.title is a short business title of at most 50 characters. Do not include paths, internal identifiers, or the whole request text; the full request remains in normalizedInput and objective.',
  'A new independent deliverable in the current project keeps the current main Topic and uses create. If the request needs another Topic or Project, or crosses the current project scope, ask for clarification, preserve the original interaction, task and Topic, and do not claim either new scope exists.',
  'Put the complete decision under decision in the end tool arguments. Do not put control state, selected actions, tool intents or user-input flags in it.',
  'Never echo the input envelope back as output fields: interactionId, inputRevision, sourceRef, rawInput, clarifications, taskCandidates, and requestCandidates are input only.',
  'When requestCandidates is supplied, select decision.requestRelation: {"kind":"new"} for an independent request, or {"kind":"continue","candidateId":"exact supplied candidateId"} for a continuation. Add action="resume-dispatch" only when the user explicitly asks to submit the exact unchanged pending create draft of that candidate; do not use it for a historical mention, a changed scope/goal, or a mere status question. These are bounded same-scope host candidates; candidateKind=previous identifies the preceding request and candidateKind=historical identifies an older request. Select by the current user meaning and candidate state, summary and open questions. Do not infer a continuation from equal text or always select the preceding request. If the intended target is ambiguous, ask a clarification without selecting a continuation.',
  'For an explicit request to submit an unchanged original pending draft, return decision.kind=answer with a neutral answer and requestRelation {"kind":"continue","candidateId":"exact supplied candidateId","action":"resume-dispatch"}. Do not include proposal, intent or matchedTaskId. The host submits the saved draft; never restate its content as a new proposal.',
  'A repeated complete request after the old task has settled is a new execution when the user asks for the work again: choose requestRelation.kind=new and proposal.intent=create. An explicit request to continue delivery of the original open request must select that exact original candidate, even when it is historical and a newer request intervened. Request relation does not replace existing task matching: append/change still require matchedTaskId from taskCandidates.',
  'Request relation selects only an opaque candidate reference. Never set actual target revision, scope, lease, epoch, grants or permissions. The host resolves the target and validates current authority. proposal.revision is only the supplied current inputRevision, never a target task revision.',
  'The committed rawInput is the only request in this turn. Use relevant prior checkpoints to answer follow-up questions and carry forward confirmed facts, constraints, and corrections. Use taskCandidates to identify a status-query or an explicitly requested change. A historical task status alone does not authorize new work.',
  'Submit one end decision. If its validation fails, repair the arguments in this same turn. The third valid attempt is accepted normally; three failed attempts produce a recoverable partial. Do not repeat business work.',
  'Classify by the requested outcome, not by whether intake can execute a requested tool. A concrete request to perform work and deliver a result is a requirement; when it asks for new work, use proposal.intent=create even if taskCandidates is empty.',
  'If rawInput is addressed to an execution runtime but still states a concrete deliverable, preserve that deliverable as a requirement. Do not ask the user to decide whether the interaction entry should execute the runtime mechanics; it does not.',
  'Do not turn a request to perform read-only work into status-query because it names tools or because intake cannot call them. Preserve the requested work, deliverable, and constraints in normalizedInput and the requirement proposal; execution happens only in the confirmed task flow.',
  'For requirement, proposal.intent must be create, append, or change. append/change require matchedTaskId from taskCandidates.',
  `If supplied, decision.taskFlow.definitionVersion is the JSON integer ${TASK_FLOW_DEFINITION_VERSION} (never a quoted string). Choose taskFlow.kind from semantic task shape only: one-shot for one bounded deliverable; inspection for recurring check-and-report work; long-running for an open-ended goal. Omit taskFlow only when genuinely ambiguous, and clarify when that blocks a decision.`,
  'Simple end example: {"kind":"simple","decision":{"kind":"answer","normalizedInput":"hello","knownFacts":[],"decisionRefs":[],"answer":"Hello."},"checkpointRecord":{"index":{"action":"answered the question","result":"answered"}}}',
].join('\n\n');

function selectIntakePromptSegments(segments: readonly AgentPromptSegment[], management?: ManagementRole): readonly string[] {
  const byRef = new Map(segments.map((segment) => [segment.ref, segment.content]));
  const [control, identity, ...role] = INTAKE_PROMPT_SEGMENT_REFS;
  const refs = [control, identity, ...(management === undefined ? [] : [MANAGEMENT_PROMPT_REFS[management]]), ...role];
  return refs.map((ref) => {
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

/**
 * A terminal batch holds more than one candidate decision object and none of
 * them satisfies the intake contract. A single valid candidate is selected by
 * priority before this error is raised, so this private identity marks only the
 * genuinely undecidable batch: it lets the interpreter recognize that exact
 * shape for its one re-answer allowance without matching error text, and it
 * keeps every other parse failure on its existing non-retryable lane.
 */
class MultipleIntakeDecisionsError extends ExplicitBrainTerminalOutputError {
  readonly decisionCount: number;

  constructor(interactionId: string, decisionCount: number, cause?: unknown, evidenceRefs?: readonly EvidenceRef[]) {
    super(
      interactionId,
      `interaction agent returned invalid JSON: the terminal output holds ${decisionCount} top-level JSON decision objects, and the intake contract requires exactly one`,
      cause,
      evidenceRefs,
    );
    this.name = 'MultipleIntakeDecisionsError';
    this.decisionCount = decisionCount;
  }
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

export interface ExplicitBrainRequestCandidate {
  readonly candidateId: string;
  readonly candidateKind: 'previous' | 'historical';
  readonly interactionId: string;
  readonly requestNumber?: number;
  readonly state: string;
  readonly summary: string;
  readonly taskId?: string;
  readonly openClarification?: { readonly question: string; readonly options?: readonly string[] };
  readonly openTaskInputRequest?: {
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly question: string;
    readonly options?: readonly string[];
  };
}

export interface ExplicitBrainInterpretationInput {
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly rawInput: string;
  readonly clarifications: readonly {
    readonly question: string;
    readonly options?: readonly string[];
    readonly answer?: string;
  }[];
  readonly taskCandidates: readonly ExplicitBrainTaskCandidate[];
  /** Bounded same-scope candidates supplied by the service, frozen with this turn. */
  readonly requestCandidates?: readonly ExplicitBrainRequestCandidate[];
  /** Host-bound service read authority. Never serialized into business input. */
  readonly readTaskResult?: (taskId: string) => Promise<unknown>;
  readonly readProjectSnapshot?: (members?: readonly string[]) => Promise<unknown>;
  /**
   * Conversation project target carried by the input. When present the explicit
   * brain treats this absolute project directory as the project context of the
   * prompt; when absent the conversation targets the serve-bound default
   * workspace, which is the existing behavior.
   */
  readonly workspaceCwd?: string;
  readonly projectKey?: string;
  /**
   * Optional live-step sink. The host records each real lifecycle step for the
   * owning interaction; the interpreter never synthesizes a step just to make
   * progress look alive.
   */
  readonly onStep?: (step: ExplicitInteractionStepInput) => void;
  readonly resumePartialRef?: string;
}

export type ExplicitBrainInterpretation = { readonly requestRelation?: ExplicitTurnEndRequestRelation } & (
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
      readonly options?: readonly string[];
      readonly decisionRefs: readonly string[];
    });

export interface ExplicitBrainInputInterpreter {
  interpret(input: ExplicitBrainInterpretationInput): Promise<ExplicitBrainInterpretation | ExplicitTurnPartialResult>;
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
    title: 'non-empty business string, at most 50 characters',
    objective: 'non-empty string',
    deliverable: 'non-empty string',
    deliveryConditions: ['non-empty string'],
    evidenceRefs: ['string'],
    blockingGaps: ['string'],
  });
}

function interpreterPrompt(
  input: ExplicitBrainInterpretationInput,
  promptSegments: readonly string[],
  skillDirectory: string,
  selectedSkills: readonly { readonly id: IntakeSkillId; readonly content: string }[],
): string {
  const projectContext = input.workspaceCwd === undefined || input.projectKey === undefined
    ? []
    : [`# Conversation project directory\nThe conversation targets the project directory ${input.workspaceCwd} (projectKey ${input.projectKey}). Treat that directory as the project context of this input.`];
  return [
    ...promptSegments,
    REGISTERED_TOOL_SURFACE,
    INTAKE_OUTPUT_PROTOCOL,
    skillDirectory,
    ...selectedSkills.map((skill) => `# Selected Skill: ${skill.id}\n\n${skill.content}`),
    ...projectContext,
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
    title: normalizeTaskTitle(nonEmptyString(record, 'title')),
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

/** Exported for focused contract tests of the explicit-intake reply parser. */
export function parseInterpreterOutput(
  output: string,
  input: ExplicitBrainInterpretationInput,
  evidenceRefs: readonly EvidenceRef[] = [],
): ExplicitBrainInterpretation {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1];
  const scoped = fenced ?? output;
  const spans = topLevelJsonObjectSpans(scoped);
  const objects: Record<string, unknown>[] = [];
  let parseError: string | undefined;
  let parseFailure: unknown;
  for (const span of spans) {
    let value: unknown;
    try {
      value = JSON.parse(scoped.slice(span.start, span.end));
    } catch (error) {
      parseError ??= error instanceof Error ? error.message : String(error);
      parseFailure ??= error;
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    objects.push(value as Record<string, unknown>);
  }
  if (objects.length === 0) {
    throw new ExplicitBrainTerminalOutputError(
      input.interactionId,
      spans.length === 0
        ? 'interaction agent returned invalid JSON: the terminal output holds no JSON decision object'
        : `interaction agent returned invalid JSON: ${parseError ?? 'the terminal output holds no JSON decision object'}`,
      parseFailure,
      evidenceRefs,
    );
  }
  if (objects.length === 1) {
    // One top-level object is the decision candidate: whether it satisfies the
    // intake contract is the contract check, not a span count.
    try {
      return parseDecisionRecord(unwrapDecisionEnvelope(objects[0]!), input);
    } catch (error) {
      throw new ExplicitBrainTerminalOutputError(
        input.interactionId,
        `interaction agent returned a single JSON decision object that fails the explicit intake contract: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
        evidenceRefs,
      );
    }
  }
  // A model may echo the request envelope it was handed (`interactionId`,
  // `rawInput`, `taskCandidates`, ...) in front of its decision. That echo
  // states no decision kind, so only the objects that state one are decisions.
  const decisions = objects.filter((entry) => typeof entry.kind === 'string');
  if (decisions.length === 0) {
    throw new ExplicitBrainTerminalOutputError(
      input.interactionId,
      `interaction agent returned invalid JSON: the terminal output holds ${objects.length} top-level JSON objects and none of them is a decision object`,
      undefined,
      evidenceRefs,
    );
  }
  // Validate every candidate first, then select by priority. An invalid
  // candidate is simply not selected; a single format wobble must not turn a
  // completed tool execution into a blocked intake. Only when no candidate is
  // valid does the bounded re-answer path run, exactly once.
  const valid: ExplicitBrainInterpretation[] = [];
  let candidateFailure: unknown;
  for (const candidate of decisions) {
    try {
      valid.push(parseDecisionRecord(candidate, input));
    } catch (error) {
      // Not a valid decision; a later candidate may still be valid.
      candidateFailure ??= error;
    }
  }
  if (valid.length === 0) {
    throw new MultipleIntakeDecisionsError(input.interactionId, decisions.length, candidateFailure, evidenceRefs);
  }
  valid.sort((left, right) => intakeDecisionPriority(left.kind) - intakeDecisionPriority(right.kind));
  return valid[0]!;
}

/**
 * A model can answer with the one complete decision it chose nested under a
 * single `decision` key instead of flat at the top level. Read that decision
 * when it is the whole answer; a nested object that only restates `kind` still
 * fails the existing intake-contract check exactly as before, and an outer
 * object that already states its own `kind` is returned unchanged.
 */
function unwrapDecisionEnvelope(record: Record<string, unknown>): Record<string, unknown> {
  if (typeof record.kind === 'string') return record;
  const wrapped = record.decision;
  if (wrapped === null || typeof wrapped !== 'object' || Array.isArray(wrapped)) return record;
  return wrapped as Record<string, unknown>;
}

/** Intake decision priority: a real task decision outranks a clarification or a report. */
function intakeDecisionPriority(kind: ExplicitBrainInterpretation['kind']): number {
  switch (kind) {
    case 'requirement': return 0;
    case 'clarification': return 1;
    case 'status-query': return 2;
    case 'answer': return 3;
  }
}

function parseDecisionRecord(record: Record<string, unknown>, input: ExplicitBrainInterpretationInput): ExplicitBrainInterpretation {
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
    ...parseRequestRelation(record.requestRelation),
  };
  if (kind === 'clarification') {
    if (typeof record.question !== 'string' || !record.question.trim()) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'clarification decision requires a question');
    }
    if (record.options !== undefined
      && (!Array.isArray(record.options) || record.options.some((entry) => typeof entry !== 'string' || !entry.trim()))) {
      throw new ExplicitBrainOperationalToolError(
        'unsupported-tool',
        'clarification decision options must be an array of non-empty strings',
      );
    }
    const options = record.options === undefined ? undefined : (record.options as string[]).map((entry) => entry.trim());
    return {
      kind,
      ...common,
      question: record.question,
      ...(options !== undefined && options.length > 0 ? { options } : {}),
    };
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
  const taskDocument = renderBusinessProposal(proposal);
  return {
    kind,
    ...common,
    normalizedInput: [taskDocument, '需求详情：', common.normalizedInput].join('\n'),
    ...(matchedTaskId === undefined ? {} : { matchedTaskId }),
    intent: proposal.intent,
    ...(taskFlowKind === undefined
      ? {}
      : { taskFlow: { kind: taskFlowKind, definitionVersion: TASK_FLOW_DEFINITION_VERSION } }),
    proposal: taskDocument,
    structuredProposal: proposal,
  };
}

function parseRequestRelation(value: unknown): { readonly requestRelation?: ExplicitTurnEndRequestRelation } {
  if (value === undefined) return {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const relation = value as Record<string, unknown>;
    if (relation.kind === 'new' && Object.keys(relation).length === 1) {
      return { requestRelation: { kind: 'new' } };
    }
    const keys = Object.keys(relation);
    if (relation.kind === 'continue'
      && keys.every((key) => key === 'kind' || key === 'candidateId' || key === 'action')
      && typeof relation.candidateId === 'string' && relation.candidateId.trim()
      && (relation.action === undefined || relation.action === 'resume-dispatch')) {
      return { requestRelation: { kind: 'continue', candidateId: relation.candidateId,
        ...(relation.action === undefined ? {} : { action: 'resume-dispatch' as const }) } };
    }
  }
  throw new ExplicitBrainOperationalToolError('unsupported-tool', 'request relation requires new or continue with only an exact candidateId');
}

/** New calls consume only the runtime's accepted structured decision. The
 * terminal text parser above remains exclusively for pre-protocol Journal reads.
 */
function interpretationFromAcceptedEnd(
  accepted: ExplicitTurnEndAcceptedResult,
  _input: ExplicitBrainInterpretationInput,
): ExplicitBrainInterpretation {
  const decision = accepted.decision;
  if (decision.kind !== 'requirement') return decision;
  const proposal = { ...decision.proposal, title: normalizeTaskTitle(decision.proposal.title) };
  const taskDocument = renderBusinessProposal(proposal);
  return {
    ...decision,
    normalizedInput: [taskDocument, '需求详情：', decision.normalizedInput].join('\n'),
    intent: proposal.intent,
    proposal: taskDocument,
    structuredProposal: proposal,
  };
}

function semanticOutcomeFromAcceptedEnd(accepted: ExplicitTurnEndAcceptedResult): ExplicitTurnInterpretedOutcome {
  if (accepted.decision.kind !== 'requirement') return accepted.decision;
  const { proposal, taskFlow: _taskFlow, ...decision } = accepted.decision;
  return { ...decision, structuredProposal: proposal };
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
  readonly executionBudget?: Partial<AgentIoEventBudget>;
  readonly maxTransientRetries?: number;
  readonly transientRetryDelaysMs?: readonly number[];
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
  readonly agentRoster?: readonly Pick<import('../../config/src/index.js').AgentConfig, 'agentId' | 'roleId' | 'managementRole'>[];
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
  const loadPromptSegments = (configuredAgentId?: string): Promise<readonly string[]> => {
    const agent = input.agentRoster?.find(entry => entry.agentId === configuredAgentId && entry.roleId === 'interaction');
    const version = EXPLICIT_BRAIN_TEMPLATE_REF.slice('builtin/interaction@'.length);
    return loadBuiltinPromptSegments('interaction', input.templateRoot, version)
      .then((loaded) => selectIntakePromptSegments(loaded.segments, agent && managementRoleForAgent(agent)));
  };
  const loadSkillCatalog = async (): Promise<readonly RegisteredSkill[]> => {
    const source = createFilePromptSource(join(input.templateRoot, 'builtin'));
    const skills = await loadRegisteredSkills(source, Object.values(INTAKE_SKILL_REFS));
    for (const skill of skills) {
      if (!INTAKE_SKILL_IDS.includes(skill.id as IntakeSkillId)) {
        throw new ExplicitBrainOperationalToolError('unsupported-tool', `unregistered standard Skill id: ${skill.id}`);
      }
    }
    return skills;
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
      if (parseError instanceof ExplicitBrainTerminalOutputError) parseError.markClosed();
    } catch (closeError) {
      throw new AggregateError(
        [parseError, closeError],
        'interaction terminal output is unusable and the turn could not be closed',
      );
    }
    throw parseError;
  };
  // Retain the actual live owners only. Scoped Journal reads select every retry.
  type RetainedProviderTurn = {
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
  };
  const retained = new Map<string, RetainedProviderTurn>();
  const requestKey = (request: Pick<ExplicitBrainInterpretationInput, 'interactionId' | 'inputRevision'>) =>
    `${request.interactionId}\u0000${request.inputRevision}`;
  const finish = async (live: RetainedProviderTurn, request: ExplicitBrainInterpretationInput) => {
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
    const endResult = await readExplicitEndOutcome({ journal: input.parentJournal, turn: live.owner.turn });
    if (endResult?.kind === 'partial') {
      retained.delete(requestKey(request));
      return endResult;
    }
    const finalParentOutput = live.reconciled
      ? await live.owner.readReconciledTurnOutput()
      : await live.owner.readFinalTurnOutput();
    let interpretation: ExplicitBrainInterpretation;
    try {
      if (finalParentOutput.turnInput.fact.endProtocol !== undefined && endResult?.kind !== 'accepted') {
        throw new Error('explicit end protocol requires its durable accepted decision');
      }
      interpretation = endResult?.kind === 'accepted'
        ? interpretationFromAcceptedEnd(endResult, request)
        : parseInterpreterOutput(
        finalParentOutput.assistantText,
        request,
        finalParentOutput.assistantContentRefs,
      );
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
      await live.helpers.closeTurnSemanticCheckpoint({ finalParentOutput: checkpointOutput,
        // Only a prepared composition belongs to this interpreter. A borrowed
        // port still proves request drain and settlement, never physical close.
        providerOwnership: live.closed === undefined ? 'borrowed' : 'owned',
        outcome: endResult?.kind === 'accepted' ? semanticOutcomeFromAcceptedEnd(endResult) : interpretation,
        ...(endResult?.kind === 'accepted' ? { acceptedEnd: endResult } : {}) });
    } catch (error) {
      if (interpretation.kind === 'answer' && input.publishProviderSettlement !== undefined) {
        live.publishOnRetry = true;
      }
      throw error;
    }
    request.onStep?.({ kind: 'turn.completed', summary: '显式整理回合已完成', turnId: live.owner.turn.turnId });
    retained.delete(requestKey(request));
    return interpretation;
  };
  /**
   * One bounded interpretation attempt. It returns either the accepted
   * interpretation or, on a freshly rejected multiple-decision batch that has
   * been honestly closed, a private re-answer handoff. The public `interpret`
   * is the only caller that may consume that handoff and start the single
   * replacement generation.
   */
  type ReanswerNeeded = { readonly kind: 'reanswer-needed'; readonly request: ExplicitBrainInterpretationInput };
  type InterpretAttempt = { readonly allowReanswer: boolean; readonly repair: boolean };
  const interpretOnce = async (
    request: ExplicitBrainInterpretationInput,
    attempt: InterpretAttempt,
  ): Promise<ExplicitBrainInterpretation | ExplicitTurnPartialResult | ReanswerNeeded> => {
      const activeLease = typeof input.lease === 'function' ? input.lease() : input.lease;
      let continuation: {
        readonly fact: NonNullable<Awaited<ReturnType<typeof input.parentJournal.readTurnSnapshot>>['turnInput']>['fact'];
        readonly executionEpoch: number;
        readonly executionOwner: OccurrenceExecutionOwner;
        readonly acceptedEnd?: import('../../contracts/src/index.js').ExplicitTurnEndAcceptedResult;
        readonly partialDrain?: ExplicitTurnPartialResult;
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
        // One durable snapshot decides the lane. A committed owner
        // reconciliation means the turn already continued into a newer
        // physical epoch, so the recovery lane is that epoch's execution
        // failure; abandonment is reserved for the unreconciled turn input.
        const laneOf = async (snapshot: Awaited<ReturnType<typeof input.parentJournal.readTurnSnapshot>>) => {
          const reconciliation = snapshot.ownerReconciliations.at(-1);
          if (reconciliation === undefined) {
            const eligibility = await owner.readAbandonmentEligibility();
            return { reconciliation, heldReason: eligibility.abandonable ? undefined : eligibility.heldReason };
          }
          const eligibility = await owner.readExecutionFailureEligibility();
          return { reconciliation, heldReason: eligibility.closable ? undefined : eligibility.heldReason };
        };
        if (activeLease === undefined) {
          // No authenticated lifecycle authority is configured, so nothing can
          // prove that the previous execution owner stopped writing. A
          // shape-only discharge would freeze a possibly live request, so hold
          // the turn and keep its recovery responsibility instead of writing an
          // abandonment fact the record shape cannot justify. A shape that
          // holds on its own still reports its own reason first: a closed turn,
          // an unknown tool effect or a cancelled request is not a missing
          // authority.
          const shape = await laneOf(await input.parentJournal.readTurnSnapshot(pendingTurn.fact.turn));
          if (shape.heldReason !== undefined) throw refuse(`it cannot be discharged: ${shape.heldReason}`);
          throw refuse('no authenticated supervisor lease authority is configured to prove the previous execution owner stopped');
        }
        // Authenticate the active owner, decide the lane and commit inside one
        // lease-guard critical section. Every durable read happens after the
        // guard is held: a snapshot cached before it can already name an owner
        // another request replaced, and closing that newer epoch as failed
        // would terminate a live stream.
        await activeLease.withCurrentLeaseOwner(async (authenticatedCaller) => {
          // Read the freshest durable record inside the guard: the cached getter
          // could predate a concurrent takeover write.
          const current = await activeLease.refresh();
          const snapshot = await input.parentJournal.readTurnSnapshot(pendingTurn.fact.turn);
          const lane = await laneOf(snapshot);
          const latestReconciliation = lane.reconciliation;
          const activeOwner = latestReconciliation?.fact.replacementOwner
            ?? snapshot.turnInput?.fact.executionOwner;
          if (lane.heldReason !== undefined) throw refuse(`it cannot be discharged: ${lane.heldReason}`);
          // Level 1 refuses a live owner; level 2 discharges only with the
          // current lease record's durable termination receipt for that exact,
          // freshly read owner.
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
          if (latestReconciliation === undefined) {
            await owner.abandonInterruptedTurn({
              reason: 'provider-interrupted-without-terminal-output',
              abandonedAt: input.clock.now(),
            });
            return;
          }
          // The closure is bound to the exact epoch and owner authenticated in
          // this guard, so a newer reconciliation is never closed instead.
          await owner.closeFailedEpoch({
            failedAt: input.clock.now(),
            authenticated: {
              executionEpoch: latestReconciliation.fact.effectiveExecutionEpoch,
              executionOwner: latestReconciliation.fact.replacementOwner,
            },
          });
        });
      };
      // The live task list is rebuilt from the current coordinator on every
      // retry, so it can drift from the snapshot committed with the submitted
      // turn. Only the candidate snapshots may be restored from the committed input;
      // every other read below must then use the recovered request.
      let effectiveRequest = request;
      let pending = await readPendingTurn();
      while (pending !== undefined) {
        const original = await input.rawContent.read({ scope: pending.fact.scope, content: pending.fact.initialInput });
        const committedText = new TextDecoder('utf-8', { fatal: true }).decode(original);
        if (committedText === JSON.stringify({ ...effectiveRequest, resumePartialRef: undefined })) break;
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
        const committedRecord = committed as { readonly taskCandidates?: unknown; readonly requestCandidates?: unknown };
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
        if (Object.hasOwn(committedRecord, 'requestCandidates') && !Array.isArray(committedRecord.requestCandidates)) {
          throw new Error(`unclosed interaction parent turn ${pending.fact.turn.turnId} has an invalid committed input asset: requestCandidates must be an array`);
        }
        // Substituting the committed candidates back into the retry must
        // reproduce the committed input byte for byte. That single strict
        // comparison keeps this path to the same interaction/revision with all
        // user business input unchanged; any other difference still reaches
        // the existing different-input boundary.
        const restored = Array.isArray(committedRecord.taskCandidates)
          ? { ...effectiveRequest, taskCandidates: committedRecord.taskCandidates as readonly ExplicitBrainTaskCandidate[],
            requestCandidates: committedRecord.requestCandidates as readonly ExplicitBrainRequestCandidate[] | undefined }
          : undefined;
        if (restored !== undefined && JSON.stringify({ ...restored, resumePartialRef: undefined }) === committedText) {
          effectiveRequest = restored;
          break;
        }
        await abandonInterruptedTurn(pending);
        pending = await readPendingTurn();
      }
      if (pending !== undefined) {
        const retainedTurn = retained.get(requestKey(effectiveRequest));
        if (retainedTurn === undefined || !sameInteractionTurn(retainedTurn.owner.turn, pending.fact.turn)) {
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
            endJournal: input.parentJournal,
          });
          const snapshot = await input.parentJournal.readTurnSnapshot(pending.fact.turn);
          const durableEnd = await readExplicitEndOutcome({ journal: input.parentJournal, turn: pending.fact.turn });
          if (durableEnd?.kind === 'partial' && effectiveRequest.resumePartialRef === undefined) return durableEnd;
          if (durableEnd?.kind === 'partial' && effectiveRequest.resumePartialRef !== durableEnd.partialRef) {
            throw new Error('resume requires the current partial recovery reference');
          }
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
              if (pending.fact.endProtocol !== undefined && durableEnd?.kind !== 'accepted') {
                throw new Error('explicit end recovery requires its durable accepted decision');
              }
              interpretation = durableEnd?.kind === 'accepted' ? interpretationFromAcceptedEnd(durableEnd, effectiveRequest) : parseInterpreterOutput(
                finalParentOutput.assistantText,
                effectiveRequest,
                finalParentOutput.assistantContentRefs,
              );
            } catch (parseError) {
              // The closed turn's own durable terminal output is unusable.
              // Re-reading it can never recover; close it so new input works.
              return await closeUnparseableTurn(coldOwner, parseError);
            }
            await requireColdAnswerSettlement(finalParentOutput, interpretation);
            await helpers.closeTurnSemanticCheckpoint({ finalParentOutput,
              outcome: durableEnd?.kind === 'accepted' ? semanticOutcomeFromAcceptedEnd(durableEnd) : interpretation,
              ...(durableEnd?.kind === 'accepted' ? { acceptedEnd: durableEnd } : {}) });
            effectiveRequest.onStep?.({ kind: 'turn.completed', summary: '显式整理回合已完成', turnId: pending.fact.turn.turnId });
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
              if (pending.fact.endProtocol !== undefined && durableEnd?.kind !== 'accepted') {
                throw new Error('explicit end recovery requires its durable accepted decision');
              }
              interpretation = durableEnd?.kind === 'accepted' ? interpretationFromAcceptedEnd(durableEnd, effectiveRequest) : parseInterpreterOutput(
                finalParentOutput.assistantText,
                effectiveRequest,
                finalParentOutput.assistantContentRefs,
              );
            } catch (parseError) {
              return await closeUnparseableTurn(coldOwner, parseError);
            }
            await requireColdAnswerSettlement(finalParentOutput, interpretation);
            await helpers.closeTurnSemanticCheckpoint({ finalParentOutput,
              outcome: durableEnd?.kind === 'accepted' ? semanticOutcomeFromAcceptedEnd(durableEnd) : interpretation,
              ...(durableEnd?.kind === 'accepted' ? { acceptedEnd: durableEnd } : {}) });
            effectiveRequest.onStep?.({ kind: 'turn.completed', summary: '显式整理回合已完成', turnId: pending.fact.turn.turnId });
            return interpretation;
          }
          if (input.prepareAgentProvider === undefined) {
            throw new Error('interaction parent continuation requires an owned provider preparer');
          }
          continuation = { fact: pending.fact, executionEpoch: reconciliation.fact.effectiveExecutionEpoch,
            executionOwner: reconciliation.fact.replacementOwner,
            ...(durableEnd?.kind === 'partial' && !snapshot.providerSettlements.some(entry =>
              entry.fact.settlement.executionEpoch === (priorReconciliation?.fact.effectiveExecutionEpoch ?? pending.fact.execution.executionEpoch)
              && entry.fact.settlement.state === 'succeeded') ? { partialDrain: durableEnd } : {}),
            ...(durableEnd?.kind === 'accepted' ? { acceptedEnd: durableEnd } : {}) };
        } else {
          return finish(retainedTurn, effectiveRequest);
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
        ?? await prepareScopeSemanticHistory({ activeTurn: turn, parentJournal: input.parentJournal,
          checkpointJournal: input.checkpointJournal, ignoreUnclosedTurns: true });
      const owned = await input.prepareAgentProvider?.({ roleId: 'interaction' });
      const configuredAgent = input.agentRoster?.find(agent => agent.agentId === owned?.configuredAgentId);
      const readProjectSnapshot = configuredAgent !== undefined && managementRoleForAgent(configuredAgent) === 'project-lead'
        ? request.readProjectSnapshot : undefined;
      // One selected binding for the whole turn: the raw owner freezes it, and
      // the driver uses the same value. A borrowed provider keeps its existing
      // non-closing ownership; only the original owner records a close fact.
      const turnProviderBinding = owned === undefined ? input.binding : owned.binding;
      let driver: ProviderAgentDriver<InteractionParentProviderExecutionIdentityRef> | undefined;
      let owner: InteractionParentTurnRawOwner | undefined;
      // The exact execution owner this batch opened its epoch under. A close of
      // this batch's own epoch is bound to it, never to a newer reconciliation.
      let openedExecutionOwner: OccurrenceExecutionOwner | null = null;
      let committedInput = false;
      let observationDrained = false;
      let settleAttempted = false;
      let observations: BudgetedProviderObservations<ProviderAgentEvent<InteractionParentProviderExecutionIdentityRef>> | undefined;
      let responseReasoningStepEmitted = false;
      let responseStreamingStepEmitted = false;
      const operationId = continuation?.fact.execution.operationId ?? id('operation', `explicit-interpret-${identity}`);
      const execution = { runtimeId, organId: input.organId, operationId, executionEpoch, interactionTurn: turn };
      /**
       * Set only when this exact batch produced a durable terminal output that
       * no decision can be parsed from. Every other failure keeps its own
       * explicit error and its own recovery lane.
       */
      let unparseableOutput = false;
      let unparseableOutputFailure: unknown;
      /**
       * True only when the freshly executed batch above is unparseable because
       * it carried more than one complete decision object. This is the one
       * ambiguous shape the public `interpret` may re-answer once.
       */
      let freshMultipleIntakeDecisions = false;
      let endResult: ExplicitEndSubmission | undefined = continuation?.acceptedEnd ?? continuation?.partialDrain;
      const hasEndConclusion = () => endResult?.kind === 'accepted' || endResult?.kind === 'partial';
      let selectedSkillIds: readonly IntakeSkillId[] = [];
      const toolDetails = new Map<string, NonNullable<import('../../contracts/src/index.js').ExplicitInteractionToolActivity['detail']>>();
      let live: RetainedProviderTurn;
      try {
        if (continuation !== undefined && (owned === undefined
          || (['bindingId', 'providerId', 'protocol', 'endpointRef', 'modelRef', 'configDigest', 'capabilityDigest'] as const)
            .some((key) => turnProviderBinding[key] !== continuation.fact.providerBinding![key]))) {
          throw new Error('interaction parent continuation requires the original full provider binding on an owned composition');
        }
        const scope = continuation?.fact.scope ?? { organId: input.organId, operationId };
        const initialInput = continuation?.fact.initialInput ?? {
          ref: await input.rawEvidence.write({ scope, kind: 'execution', type: 'initial-input', locator: turn.turnId, content: JSON.stringify(effectiveRequest) }),
          view: { kind: 'utf8-text' as const },
        };
        const openOwner = async (executionOwner?: OccurrenceExecutionOwner) => {
          const createdOwner = createInteractionParentTurnRawOwner({
            turn, execution, scope, initialInput, providerBinding: turnProviderBinding,
            ...(continuation === undefined || continuation.fact.endProtocol === 'explicit-end-v1'
              ? { endProtocol: 'explicit-end-v1' as const } : {}),
            ...(executionOwner === undefined ? {} : { executionOwner }),
            journal: input.parentJournal, rawContent: input.rawContent, priorCheckpoints,
            instructions: async (hookInput) => {
              if (continuation?.acceptedEnd !== undefined || continuation?.partialDrain !== undefined) {
                return { text: 'The end outcome and all tool results are already committed. Consume the committed results and finish this transport request. Do not repeat tools or business work.' };
              }
              const [promptSegments, catalog] = await Promise.all([
                loadPromptSegments(owned?.configuredAgentId),
                loadSkillCatalog(),
              ]);
              const source = createFilePromptSource(join(input.templateRoot, 'builtin'));
              const selectedSkills = hookInput.phase === 'initial' ? [] : await Promise.all(
                selectedSkillIds.map(async (skillId) => ({
                  id: skillId,
                  content: await loadSelectedSkillContent(source, catalog.find((skill) => skill.id === skillId)!),
                })),
              );
              if (continuation !== undefined && continuation.fact.endProtocol !== 'explicit-end-v1') {
                return { text: [...promptSegments, renderSkillDirectory(catalog), ...selectedSkills.map(skill => skill.content),
                  'Resume the existing intake turn. Return one decision object in the assistant response using kind, normalizedInput, knownFacts and decisionRefs. Include the answer, clarification question or requirement proposal appropriate to its kind.',
                  structuredProposalContract(effectiveRequest.inputRevision)].join('\n\n'), toolSurface: 'intake-decision' };
              }
              const text = interpreterPrompt(
                effectiveRequest,
                promptSegments,
                renderSkillDirectory(catalog),
                selectedSkills,
              );
              if (!attempt.repair) return { text, toolSurface: 'intake-decision' };
              return {
                text: `${text}\n\nThe preceding generation contained multiple decisions. Submit one corrected decision for the committed input through the end tool.`,
                toolSurface: 'intake-decision',
              };
            },
          });
          owner = createdOwner;
          openedExecutionOwner = executionOwner ?? null;
          await createdOwner.openTurnInput();
          committedInput = true;
          return createdOwner;
        };
        const createdOwner = continuation !== undefined
          ? await openOwner(continuation.executionOwner)
          : activeLease === undefined ? await openOwner()
            : await activeLease.withCurrentLeaseOwner((authenticatedCaller) => openOwner(authenticatedCaller));
        const useEndProtocol = continuation === undefined || continuation.fact.endProtocol === 'explicit-end-v1';
        const endAttempt = !useEndProtocol || continuation?.acceptedEnd !== undefined || continuation?.partialDrain !== undefined ? undefined : await beginExplicitEndAttempt({
          journal: input.parentJournal, turn, execution,
          ...(effectiveRequest.resumePartialRef === undefined ? {} : { resumePartialRef: effectiveRequest.resumePartialRef }),
        });
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
          endJournal: input.parentJournal,
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
          onRequestLifecycle: (event) => {
            observations?.noteLifecycle(event);
            if (event.phase === 'dispatching' || event.phase === 'dispatched') {
              responseReasoningStepEmitted = false;
              responseStreamingStepEmitted = false;
            }
            if (event.phase === 'dispatching') {
              request.onStep?.({
                kind: 'request.dispatching',
                summary: '正在请求模型整理任务',
                turnId: event.turnId,
                requestId: event.requestId,
              });
            } else if (event.phase === 'dispatched') {
              request.onStep?.({
                kind: 'request.dispatched',
                summary: '模型请求已发出',
                turnId: event.turnId,
                requestId: event.requestId,
              });
            } else if (event.phase === 'settled') {
              request.onStep?.({
                kind: 'request.settled',
                summary: '模型请求已完成',
                turnId: event.turnId,
                requestId: event.requestId,
              });
            }
          },
          ...(continuation?.acceptedEnd !== undefined || continuation?.partialDrain !== undefined ? {} : { tools: [SKILL_SELECTION_TOOL, ...(useEndProtocol ? [EXPLICIT_END_TOOL] : []),
            ...(request.readTaskResult === undefined ? [] : [TASK_RESULT_READ_TOOL]),
            ...(readProjectSnapshot === undefined ? [] : [PROJECT_SNAPSHOT_TOOL])] }),
          ...(!useEndProtocol ? {} : {
            onMalformedToolCallResult: async ({ requestId, call }) => {
              if (endAttempt === undefined || call.toolId !== EXPLICIT_END_TOOL.toolId || hasEndConclusion()) return;
              endResult = await submitExplicitTurnEnd({ journal: input.parentJournal, attempt: endAttempt,
                requestId, callId: call.callId, arguments: call.arguments });
            },
            // The HTTP transport consumes paired results before settlement.
            // Its drain text never becomes an intake decision.
            completeRequest: async ({ tools }) => {
              if (!hasEndConclusion()) return 'continue';
              return tools.length === 0 ? 'complete' : 'drain';
            },
          }),
          executeTool: {
            async execute({ call, requestId }): Promise<ProviderToolExecutionResult> {
              if (hasEndConclusion()) {
                const code = 'explicit.end.already-concluded';
                const message = 'The current turn already has its conclusion.';
                return { output: JSON.stringify({ status: 'failed', code, message, callId: call.callId }),
                  outputRefs: [], evidenceRefs: [], status: 'failed',
                  error: { errorId: `${code}:${call.callId}`, code, message, category: 'validation', phase: 'tool',
                    ownerId: 'humanagent.app', retryable: 'retryable', attention: 'foreground', evidenceRefs: [],
                    nextAction: { kind: 'continue', ref: EXPLICIT_END_TOOL.toolId } } };
              }
              const key = JSON.stringify([requestId, call.callId]);
              if (call.toolId === PROJECT_SNAPSHOT_TOOL.toolId && readProjectSnapshot !== undefined) {
                const nextAction = { kind: 'continue', ref: PROJECT_SNAPSHOT_TOOL.toolId } as const;
                const rejected = (code: string, message: string): ProviderToolExecutionResult => ({
                  output: JSON.stringify({ status: 'failed', code, callId: call.callId, toolId: call.toolId,
                    message, recoverable: true, nextAction }),
                  outputRefs: [], evidenceRefs: [], status: 'failed',
                  error: { errorId: `${code}:${call.callId}`, code, message, category: 'validation',
                    phase: 'tool', ownerId: 'humanagent.app', retryable: 'retryable', attention: 'foreground',
                    evidenceRefs: [], nextAction },
                });
                const args = call.arguments;
                const invalid = () => rejected('project.snapshot.invalid-arguments',
                  'Pass an empty object for all members or only a non-empty list of unique member references');
                if (args === null || typeof args !== 'object' || Array.isArray(args)
                  || Object.keys(args).some(key => key !== 'members')) return invalid();
                const members = 'members' in args ? args.members : undefined;
                if (members !== undefined && (!Array.isArray(members) || members.length === 0
                  || !members.every((ref): ref is string => typeof ref === 'string' && ref.trim().length > 0)
                  || new Set(members).size !== members.length)) return invalid();
                try {
                  return { output: JSON.stringify(await readProjectSnapshot(members)),
                    outputRefs: [], evidenceRefs: [], status: 'succeeded' };
                } catch (error) {
                  if (error instanceof UiRuntimeApiError && error.code === 'project.snapshot.member-unavailable') {
                    return rejected(error.code, error.message);
                  }
                  throw error;
                }
              }
              if (call.toolId === TASK_RESULT_READ_TOOL.toolId && request.readTaskResult !== undefined) {
                const args = call.arguments;
                const rejected = (code: string, message: string): ProviderToolExecutionResult => ({
                  output: JSON.stringify({ status: 'failed', code, callId: call.callId, toolId: call.toolId, message, recoverable: true }),
                  outputRefs: [], evidenceRefs: [], status: 'failed',
                  error: { errorId: `${code}:${call.callId}`, code, message, category: 'validation', phase: 'tool',
                    ownerId: 'humanagent.app', retryable: 'retryable', attention: 'foreground', evidenceRefs: [],
                    nextAction: { kind: 'continue', ref: call.toolId } },
                });
                if (args === null || typeof args !== 'object' || Array.isArray(args)
                  || Object.keys(args).length !== 1 || !('taskId' in args)
                  || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
                  return rejected(`${call.toolId}.invalid-arguments`, `${call.toolId} requires only a non-empty taskId`);
                }
                try {
                  const value = await request.readTaskResult(args.taskId);
                  if (value !== null && typeof value === 'object') {
                    const result = value as Record<string, unknown>;
                    const { blocker, resultAvailable } = result;
                    const failure = blocker !== null && typeof blocker === 'object' ? blocker as Record<string, unknown> : undefined;
                    toolDetails.set(key, { kind: 'task-result',
                      ...(typeof result.title === 'string' && result.title !== args.taskId ? { title: result.title.slice(0, 160) } : {}),
                      ...(typeof result.status === 'string' ? { taskState: result.status } : {}),
                      ...(typeof result.publicationState === 'string' ? { publicationState: result.publicationState } : {}),
                      ...(typeof resultAvailable === 'boolean' ? { resultAvailable } : {}),
                      ...(typeof failure?.code === 'string' && typeof failure.reason === 'string' && typeof failure.nextStep === 'string' ? {
                        blocker: { code: failure.code, reason: failure.reason, nextStep: failure.nextStep },
                      } : {}),
                    });
                  }
                  return { output: JSON.stringify(value),
                    outputRefs: [], evidenceRefs: [], status: 'succeeded' };
                } catch (error) {
                  if (error instanceof RuntimeTaskControlError && error.code === 'task.not.found') {
                    return rejected(`${call.toolId}.task-not-found`, 'No such task in the current host scope; select an available taskId or ask for clarification');
                  }
                  if (error instanceof UiRuntimeApiError
                    && error.code === 'explicit-brain.task-outside-serve-scope') {
                    return rejected(error.code,
                      'Task result is outside this conversation project; select a task in the current project or ask for clarification');
                  }
                  throw error;
                }
              }
              if (call.toolId === EXPLICIT_END_TOOL.toolId) {
                if (endAttempt === undefined) throw new Error('legacy explicit turn has no end attempt');
                if (requestId === undefined) throw new Error('explicit end requires its registered provider request');
                endResult = await submitExplicitTurnEnd({
                  journal: input.parentJournal, attempt: endAttempt, requestId,
                  callId: call.callId, arguments: call.arguments,
                });
                if (endResult.kind === 'accepted') {
                  const decision = endResult.decision;
                  toolDetails.set(key, decision.kind === 'requirement'
                    ? { kind: 'decision', decision: decision.proposal.intent, title: decision.proposal.title.slice(0, 160) }
                    : { kind: 'decision', decision: decision.kind });
                } else if (endResult.kind === 'partial') {
                  toolDetails.set(key, { kind: 'decision', decision: 'partial' });
                }
                return { output: JSON.stringify(endResult), outputRefs: [], evidenceRefs: [],
                  status: endResult.kind === 'rejected' ? 'failed' : 'succeeded' };
              }
              if (call.toolId === SKILL_SELECTION_TOOL.toolId) {
                const args = call.arguments as { readonly skillIds?: unknown };
                if (!Array.isArray(args.skillIds)
                  || args.skillIds.length === 0
                  || !args.skillIds.every((skillId): skillId is IntakeSkillId =>
                    typeof skillId === 'string' && INTAKE_SKILL_IDS.includes(skillId as IntakeSkillId))
                  || new Set(args.skillIds).size !== args.skillIds.length) {
                  throw new ExplicitBrainOperationalToolError(
                    'unsupported-tool',
                    'Skill selection must contain unique registered stable IDs',
                  );
                }
                selectedSkillIds = args.skillIds;
                toolDetails.set(key, { kind: 'skills', skills: selectedSkillIds });
                return {
                  output: JSON.stringify({ selectedSkillIds }),
                  outputRefs: [],
                  evidenceRefs: [],
                  status: 'succeeded',
                };
              }
              throw new ExplicitBrainOperationalToolError(
                'unsupported-tool',
                `explicit interpreter has no executable tool ${call.toolId}`,
              );
            },
          },
        });
        observations = new BudgetedProviderObservations(
          driver.observe({ runtimeId })[Symbol.asyncIterator](),
          { ...DEFAULT_UI_EXECUTION_EVENT_BUDGET, ...input.executionBudget },
          () => new Date(input.clock.now()).getTime(),
        );
        await driver.start({ ...execution, assignmentId: `explicit-interpret-${identity}` });
        await driver.submit({
          ...execution,
          executionEpoch,
          assignmentId: `explicit-interpret-${identity}`,
          payload: {},
        });
        while (true) {
          const exhausted = observations.exhausted();
          if (exhausted !== undefined) throw new Error(`interaction request budget exhausted: ${exhausted}`);
          const step = await observations.next();
          if (step.kind === 'deadline') continue;
          if (step.step.done) { observationDrained = true; break; }
          const providerEvent = step.step.value.providerEvent;
          observations.note(providerEvent);
          if (providerEvent.kind === 'tool') {
            const result = providerEvent.toolResult;
            const call = result ?? providerEvent.toolCall;
            const kind = call?.toolId === SKILL_SELECTION_TOOL.toolId ? 'select-skills'
              : call?.toolId === TASK_RESULT_READ_TOOL.toolId ? 'read-task-result'
              : call?.toolId === PROJECT_SNAPSHOT_TOOL.toolId ? 'project-snapshot'
              : call?.toolId === EXPLICIT_END_TOOL.toolId ? 'submit-turn' : undefined;
            if (kind !== undefined && call !== undefined) {
              const key = JSON.stringify([providerEvent.requestId, call.callId]);
              const detail = result === undefined ? undefined : toolDetails.get(key);
              if (detail !== undefined) toolDetails.delete(key);
              request.onStep?.({
                kind: result === undefined ? 'tool.started' : 'tool.finished',
                summary: result === undefined ? '内置工具已调用' : '内置工具已返回',
                ...(providerEvent.turnId === undefined ? {} : { turnId: providerEvent.turnId }),
                ...(providerEvent.requestId === undefined ? {} : { requestId: providerEvent.requestId }),
                tool: {
                  kind,
                  callId: call.callId,
                  ...(result === undefined ? {} : { status: result.status }),
                  ...(result?.error === undefined ? {} : { errorCode: result.error.code }),
                  ...(detail === undefined ? {} : { detail }),
                },
              });
            }
          }
          if (!responseReasoningStepEmitted && providerEvent.kind === 'model') {
            responseReasoningStepEmitted = true;
            request.onStep?.({
              kind: 'response.reasoning',
              summary: '模型正在思考',
              ...(providerEvent.turnId === undefined ? {} : { turnId: providerEvent.turnId }),
              ...(providerEvent.requestId === undefined ? {} : { requestId: providerEvent.requestId }),
            });
          }
          if (!responseStreamingStepEmitted && providerEvent.kind === 'output') {
            responseStreamingStepEmitted = true;
            request.onStep?.({
              kind: 'response.streaming',
              summary: '模型正在输出',
              ...(providerEvent.turnId === undefined ? {} : { turnId: providerEvent.turnId }),
              ...(providerEvent.requestId === undefined ? {} : { requestId: providerEvent.requestId }),
            });
          }
        }
        settleAttempted = true;
        const closure = await driver.settle({ runtimeId, executionEpoch });
        if (closure.state !== 'succeeded') {
          const settlementErr = driver.settlement()?.error;
          if (settlementErr !== undefined) {
            const nextAction = typeof settlementErr.nextAction === 'string'
              ? settlementErr.nextAction
              : `${settlementErr.nextAction.kind}${settlementErr.nextAction.ref ? `:${settlementErr.nextAction.ref}` : ''}`;
            throw new AppLifecycleError(
              settlementErr.code,
              settlementErr.message,
              nextAction,
              settlementErr.ownerId,
            );
          }
          throw new ExplicitBrainOperationalToolError('unsupported-tool', `interaction agent ended in ${closure.state}`);
        }
        const settledEnd = endResult as ExplicitEndSubmission | undefined;
        if (settledEnd?.kind === 'accepted' || settledEnd?.kind === 'partial') {
          const finalParentOutput = await createdOwner.readFinalTurnOutput();
          // Both accepted and partial require real settlement for recovery.
          {
            const settlement = driver.settlement();
            if (settlement === undefined) {
              throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction agent settled without a provider settlement');
            }
            const receipt: InteractionProviderSettlementReceipt = {
              interactionId: effectiveRequest.interactionId,
              inputRevision: effectiveRequest.inputRevision,
              request: finalParentOutput.terminalRequest.request,
              settlement,
            };
            await publishInteractionProviderSettlement({ journal: input.parentJournal, receipt });
            if (settledEnd.kind === 'accepted' && settledEnd.decision.kind === 'answer') await input.publishProviderSettlement?.(receipt);
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
        retained.set(requestKey(effectiveRequest), live);
      } catch (error) {
        let failure: unknown = error;
        const cleanupFailures: unknown[] = [];
        // Only this local driver can own this execution. In particular, submit
        // can throw after start acquired a resource but before returning to us.
        let executionReleased = driver?.hasAcquiredExecution() !== true;
        const priorSettlement = driver?.settlement();
        if (observationDrained && priorSettlement !== undefined
          && priorSettlement.state !== 'waiting' && priorSettlement.state !== 'unknown'
          && priorSettlement.resourceRelease.state === 'released') executionReleased = true;
        if (driver?.hasAcquiredExecution() && !executionReleased && !settleAttempted) {
          let stopped = false;
          let stopRejected = false;
          let stopError: unknown;
          try {
            const receipt = await driver.requestStop(execution);
            stopped = receipt.requested;
            stopRejected = !stopped;
          } catch (error) {
            stopError = error;
          }
          let drained = false;
          // Never queue iterator.return ahead of the abort that releases its
          // pending next. Budget wrapper close is not producer drain evidence.
          if (stopped) {
            try {
              await driver.closeProductionAndDrain({ execution, boundaryId: `explicit-failure-${identity}` });
              drained = true;
            } catch (drainError) {
              cleanupFailures.push(drainError);
            }
          }
          try {
            // A previous waiting/unknown or failed settle predates this stop.
            // Read the real post-stop settlement before deciding release.
            await driver.settle({ runtimeId, executionEpoch });
            const settlement = driver.settlement();
            const released = settlement !== undefined
              && settlement.state !== 'waiting' && settlement.state !== 'unknown'
              && settlement.resourceRelease.state === 'released';
            // A rejected stop can mean the provider already reached its own
            // terminal. The real post-stop settlement, not the stop receipt,
            // decides whether this execution is released.
            executionReleased = released && (stopped ? drained : true);
            if (stopError !== undefined) cleanupFailures.push(stopError);
            if (!executionReleased) {
              if (stopRejected) cleanupFailures.push(new Error('interaction provider stop was rejected'));
              cleanupFailures.push(new Error('interaction execution stop/drain/settlement is incomplete'));
            }
          } catch (settleError) {
            failure = new AggregateError(
              [failure, settleError, ...(stopError === undefined ? [] : [stopError])],
              'interaction observation and settlement failed',
            );
          }
        }
        // Attempt physical close even after a cleanup failure, but record only
        // its real receipt and retain recovery until all release evidence exists.
        let compositionClosed = owned === undefined;
        // A REAL owned close receipt was recorded in this batch. A borrowed
        // provider never reaches the owned branch, so this stays false and no
        // close is attested. Only a physically owned composition that closed
        // with a resolved receipt counts as evidence for the one-time re-answer,
        // which the accepted contract ties to an owned close receipt.
        // `compositionClosed` stays the "no open owned composition remains"
        // fact used by the failed-epoch close; it starts true for a borrowed
        // port because there is nothing this process owns to leave open.
        let closedWithReceipt = false;
        if (owned !== undefined) {
          let receipt: Awaited<ReturnType<typeof closeAgentProvider>> | undefined;
          try {
            receipt = await closeAgentProvider(owned, { returnReceipt: true });
            compositionClosed = true;
            // A resolved close is `state: 'closed'` or it threw; the throw path
            // keeps `compositionClosed`/`closedWithReceipt` false and records a
            // cleanup failure instead of a fabricated success.
            closedWithReceipt = true;
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
            if (unparseableOutputFailure instanceof ExplicitBrainTerminalOutputError) {
              unparseableOutputFailure.markClosed();
            }
          } catch (closeError) {
            cleanupFailures.push(closeError);
          }
        } else if (owner !== undefined && committedInput && executionReleased && compositionClosed) {
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
                await owner.closeFailedEpoch({
                  failedAt: input.clock.now(),
                  authenticated: {
                    executionEpoch,
                    executionOwner: openedExecutionOwner,
                  },
                });
              }
            }
          } catch (closeError) {
            cleanupFailures.push(closeError);
          }
        }
        // One replacement generation is allowed only after a freshly executed
        // batch produced two complete decisions and was fully closed: real
        // settle, real close receipt, durable parse-failure, no dispatched
        // helper. The turn is durably rejected, so re-answering the same
        // committed input cannot replay a side effect. The re-answer check runs
        // before the AggregateError below so that a fresh replacement
        // generation is not blocked by non-critical cleanup failures such as a
        // lost journal acknowledgement after a real provider close.
        if (attempt.allowReanswer && unparseableOutput && freshMultipleIntakeDecisions
          && owner !== undefined && committedInput && closedWithReceipt
          && observationDrained && settleAttempted) {
          const heldReason = input.turnHelperJournal === undefined
            ? 'the durable helper turn read port is unavailable'
            : await holdsDispatchedHelper(input.turnHelperJournal, owner.turn);
          if (heldReason === undefined) {
            return { kind: 'reanswer-needed', request: effectiveRequest };
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
      } finally {
        await observations?.close();
      }
      return finish(live, effectiveRequest);
  };
  // This interpreter is composed once for the interaction scope. Claim it
  // before any asynchronous Journal reads so two fresh inputs cannot both
  // see an empty scope and open concurrent parent turns.
  let performingTurn = false;
  const maxTransientRetries = Math.max(0, input.maxTransientRetries ?? DEFAULT_EXPLICIT_MAX_TRANSIENT_RETRIES);
  const transientRetryDelaysMs = input.transientRetryDelaysMs ?? DEFAULT_EXPLICIT_RETRY_DELAYS_MS;
  const runWithTransientRccRetry = async (
    runRequest: ExplicitBrainInterpretationInput,
    attemptCfg: InterpretAttempt,
  ): Promise<ExplicitBrainInterpretation | ExplicitTurnPartialResult | ReanswerNeeded> => {
    for (let retryAttempt = 0; ; retryAttempt += 1) {
      try {
        return await interpretOnce(runRequest, attemptCfg);
      } catch (cause) {
        if (input.binding.providerId !== 'rcc'
          || retryAttempt >= maxTransientRetries
          || !isRetryableExplicitRccFailure(cause)) {
          throw cause;
        }
        const delayMs = transientRetryDelaysMs[Math.min(retryAttempt, transientRetryDelaysMs.length - 1)] ?? 0;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  };
  return {
    async interpret(request) {
      if (performingTurn) {
        throw new AppLifecycleError(
          'explicit-brain.interaction-scope-busy',
          '此会话正在处理上一条消息。',
          '上一轮处理结束后继续此消息。',
          'humanagent.runtime.explicit-brain',
        );
      }
      performingTurn = true;
      try {
        const first = await runWithTransientRccRetry(request, { allowReanswer: true, repair: false });
        if (first.kind !== 'reanswer-needed') return first;
        // Only the already-closed first batch may be replaced for this input.
        const replacement = await runWithTransientRccRetry(first.request, { allowReanswer: false, repair: true });
        if (replacement.kind === 'reanswer-needed') {
          throw new ExplicitBrainOperationalToolError(
            'unsupported-tool',
            'interaction replacement generation requested a second re-answer',
          );
        }
        return replacement;
      } finally {
        performingTurn = false;
      }
    },
  };
}

const DEFAULT_EXPLICIT_MAX_TRANSIENT_RETRIES = 10;
const DEFAULT_EXPLICIT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

function isExplicitAllAccountsExhausted429(message: string): boolean {
  return /所有候选账号对模型.*均已限额或禁用/.test(message);
}

function extractExplicitFailure(cause: unknown): {
  readonly code: string;
  readonly message: string;
  readonly category?: string;
  readonly retryable?: string;
} | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return extractExplicitFailure(cause.errors[0]);
  }
  if ('providerError' in cause) {
    const err = (cause as { readonly providerError?: { readonly code?: unknown; readonly message?: unknown; readonly category?: unknown; readonly retryable?: unknown } }).providerError;
    if (err && typeof err.code === 'string' && typeof err.message === 'string') {
      return {
        code: err.code,
        message: err.message,
        ...(typeof err.category === 'string' ? { category: err.category } : {}),
        ...(typeof err.retryable === 'string' ? { retryable: err.retryable } : {}),
      };
    }
  }
  if (cause instanceof AppLifecycleError) {
    return { code: cause.code, message: cause.message };
  }
  return undefined;
}

function isRetryableExplicitRccFailure(cause: unknown): boolean {
  const detail = extractExplicitFailure(cause);
  if (!detail) return false;
  if (isExplicitAllAccountsExhausted429(detail.message)) return false;
  if (/interaction request budget exhausted|explicit-brain\.|unsupported-tool|runtime\.|provider\.production\.closed/.test(`${detail.code} ${detail.message}`)) {
    return false;
  }
  if (detail.category === 'timeout' || detail.code === 'transport.empty.body') return true;
  if (detail.category === 'transport') return detail.retryable === 'retryable';
  if (/^http\.5\d\d$/.test(detail.code) || detail.code === 'http.429') return true;
  if (detail.code === 'unknown_parameter' || detail.code === 'server_error' || detail.code === 'rate_limit_exceeded'
    || detail.code === 'upstream_error' || detail.code === 'provider.failed') {
    return true;
  }
  return /rate_limit|server_error|upstream_error|overloaded|unavailable|暂时不可用|请稍后重试|too_many_requests|too many requests/i
    .test(`${detail.code} ${detail.message}`);
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
