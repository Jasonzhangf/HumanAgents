import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  canonicalJsonStringify,
  fileWriteEffectId,
  id,
  type AcceptedRawFact,
  type ContextHistoryRecord,
  type EvidenceRef,
  type FileWriteEffect,
  type PreparedRecoveryCapture,
  type RecoveryHoldFacts,
  type ScopeRef,
  type TaskId,
  type WorkAssignment,
} from '../../packages/contracts/src/index.js';
import type { ActiveTurnSegmentPredecessorRef } from '../../packages/contracts/src/active-turn-segments.js';
import { JsonlOrganJournal, type JournalRecord } from '../../packages/adapters/jsonl/src/index.js';
import { createJsonlActiveTurnJournal } from '../../packages/adapters/jsonl/src/active-turn.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { ImmutableAssetStore, evidenceReference } from '../../packages/adapters/filesystem/src/index.js';
import { produceAdmittedTurn } from '../../packages/runtime/src/admission/admitted-turn.js';
import { ActiveTurnContext } from '../../packages/runtime/src/context/active-turn-context.js';
import { durableContextDigest, produceContextHistory } from '../../packages/runtime/src/checkpoints/coordinator.js';
import { prepareCheckpointClosure } from '../../packages/runtime/src/checkpoints/closure.js';
import { submitCheckpoint } from '../../packages/runtime/src/checkpoints/submission.js';
import {
  RuntimeTaskCoordinator,
  type RuntimeExecutionAllocation,
  type RuntimeExecutionRelease,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { UiRuntimeJournal, FileCheckpointStore } from '../../packages/app/src/ui-runtime/journal.js';
import {
  createJsonlCheckpointJournal,
  createJsonlCheckpointClosurePort,
  createJsonlContextHistoryPort,
} from '../../packages/app/src/checkpoint-journal.js';
import { createNativeRecoveryAssets, createActiveTurnSegmentJournal } from '../../packages/app/src/native-recovery-assets.js';
import { createJsonlOperationControlJournal } from '../../packages/app/src/operation-control-journal.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { createJsonlRetryCycleJournalPort } from '../../packages/app/src/retry-cycle-journal.js';
import { readCurrentFromRecords } from '../../packages/app/src/ui-runtime/reentry-current-facts.js';
import { createDefaultExecutionComposition, createServiceExecutionAdmission } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/index.js';
import { ExplicitIntake, RequirementInbox } from '../../packages/runtime/src/index.js';
import { ConfirmationLedger, RequirementSubmissionOwner } from '../../packages/runtime/src/explicit-brain/router.js';
import { createJsonlNativeSaveProgressPort } from '../../packages/adapters/jsonl/src/native-save-progress.js';
import {
  NATIVE_SAVE_PHASES,
  isNativeSegmentSaveIntentV2,
  type NativeSaveProgress,
} from '../../packages/runtime/src/checkpoints/native-save-contract.js';
import { prepareAgentProvider, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import type { ProviderConfig, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import {
  AgentRuntimePoolManager,
  OrchestrationManager,
  acceptanceCriteriaContent,
  digestOf,
  type MergeCoordinatorPort,
  type ReviewAgentPort,
} from '../../packages/runtime/src/orchestration/index.js';

/**
 * One real public cold-resume consumer.
 *
 * Failure basis: the accepted cold module classifies the original durable turn
 * before any acquisition, but no public consumer proves the coordinator
 * `resumeExecution` selector reaches the real standard-end endpoint, preserves
 * the original business identity, and never replays the confirmed effect.
 * Probability UNKNOWN. Impact is a wrong incarnation, a lost judgment, a
 * duplicated side effect or a false complete. Cost is one physical fixture.
 *
 * The fixture below is the accepted cold-source fixture (one original turn with
 * a confirmed file/tool effect). It is rebuilt against the real production
 * composition, the real M3 assembly/pool, the same Organ Journal and the same
 * native/segment/completion owners. The controlled HTTP upstream is exercised
 * through the real provider driver; the first model request is not the endpoint.
 */

const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-d-cold-consumer-r1-20261014');
const at = '2026-10-14T00:00:00.000Z';
const organId = id('organ', 'cold-resume-organ');

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function evidence(scope: ScopeRef, label: string): EvidenceRef {
  return { evidenceId: id('evidence', label), kind: 'operation', source: 'cold-resume-consumer',
    locator: `humanagent://cold-resume/${label}`, scope };
}

function contextRecord(scope: ScopeRef, runtime: string, epoch: number): ContextHistoryRecord {
  const ref = { checkpointId: id('checkpoint', `loop-${epoch}`), digest: `loop-digest-${epoch}` };
  const watermark = { streamId: 'cold-resume-stream', sequence: 0 };
  const observationScopeId = `observation-${epoch}`;
  const durableContext = { stablePrefix: ['original instructions'], indexRefs: ['original index'],
    dynamicHead: ['accepted reasoning', 'accepted tool result'], repairRefs: ['retained duty'] };
  return { kind: 'context-history', schemaVersion: 1, scope, agentRuntimeId: runtime,
    contextView: { contextViewRef: `context-${epoch}`, executionEpoch: epoch, checkpoint: ref,
      contextDigest: `refs-${epoch}`, activeRefs: ['accepted-prefix'], omittedRefs: ['older-view'] },
    loopCheckpoint: { ...ref, sequence: epoch, predecessor: null, executionEpoch: epoch,
      eventWatermark: watermark, observationScopeId, contextViewRef: `context-${epoch}` },
    replacement: null, previousContextCommitRef: null, durableContext,
    durableContextDigest: durableContextDigest(durableContext),
    loopControl: { mode: 'observation', transitionSeq: 1, observationScopeId, observationScope: null,
      inboxStreamId: watermark.streamId, inboxExecutionEpoch: epoch, inboxCheckpoint: ref,
      inboxObservationScopeId: observationScopeId, inboxWatermark: 0, handledEventIds: ['handled-event'],
      handledBatchKeys: ['handled-batch'], deltaExecutionEpoch: epoch, deltaCheckpoint: ref,
      deltaObservationScopeId: observationScopeId, deltaWatermark: watermark,
      appliedDeltaIds: ['applied-delta'], appliedDeltaKeys: ['applied-key'], closedObservationScopeIds: [],
      budgetUsage: { modeTransitions: 1, observationScopes: 1, contextReplacements: 0, deferredEvents: 0 } } };
}

interface Upstream {
  readonly baseUrl: string;
  readonly wires: { readonly path: string; readonly body: string }[];
  readonly close: () => Promise<void>;
}

/** One real Responses HTTP request, decoded only as far as its cold-resume stage. */
interface ResponsesWireItem {
  readonly type?: string;
  readonly role?: string;
  readonly name?: string;
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
}
interface ResponsesWireBody {
  readonly input?: readonly ResponsesWireItem[];
  readonly tools?: readonly { readonly name?: string }[];
}

function parseResponsesWire(raw: string): ResponsesWireBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  return parsed as ResponsesWireBody;
}

/**
 * The Planner business payload the driver actually encoded, if this request is
 * the independent Planner call. The Planner sends exactly one user message
 * whose `input_text` is the JSON business payload (see `turn-planner.ts`
 * `plannerRequestPayload`); the recovered execution sends typed context units
 * and its tool history instead. The stage is read from the request body, never
 * from a request ordinal or a model string.
 */
function plannerPayload(raw: string): Record<string, unknown> | undefined {
  for (const item of parseResponsesWire(raw)?.input ?? []) {
    if (item.type !== 'message' || item.role !== 'user') continue;
    for (const part of item.content ?? []) {
      if (part.type !== 'input_text' || typeof part.text !== 'string') continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(part.text);
      } catch {
        continue;
      }
      if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).role === 'planner') {
        return candidate as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/** True once the recovered execution request replays the accepted standard-end call. */
function declaresTurnEnd(raw: string): boolean {
  return (parseResponsesWire(raw)?.input ?? [])
    .some((item) => item.type === 'function_call' && item.name === 'humanagent_turn_end');
}

/** True when the request declares the Harness standard-end tool surface (the recovered execution). */
function hasTurnEndSurface(raw: string): boolean {
  return (parseResponsesWire(raw)?.tools ?? []).some((tool) => tool.name === 'humanagent_turn_end');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`the Planner request is missing ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`the Planner request is missing ${label}`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`the Planner request is missing ${label}`);
  }
  return value;
}

function evidenceLocators(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const locators: string[] = [];
  for (const ref of value) {
    const locator = (ref as { readonly locator?: unknown } | null)?.locator;
    if (typeof locator === 'string' && locator.length > 0) locators.push(locator);
  }
  return locators;
}

function closureSection(value: unknown, label: string): { readonly text: string; readonly locators: readonly string[] } {
  const section = requireRecord(value, `the closure ${label}`);
  return { text: requireText(section.text, `the closure ${label} text`), locators: evidenceLocators(section.evidenceRefs) };
}

/**
 * The first (and only) lawful Planner response, built only from the actual
 * request payload. The owner still derives the publication, sequence, digests
 * and alignment from the committed facts; this text carries only the
 * whole-task plan decision the Planner is asked for.
 */
function plannerFrames(model: string, payload: Record<string, unknown>): readonly Record<string, unknown>[] {
  const task = requireRecord(payload.task, 'the task');
  const closure = requireRecord(payload.closure, 'the closure');
  const summary = requireRecord(closure.summary, 'the closure summary');
  const title = requireText(task.title, 'the task title');
  const directive = requireText(task.directive, 'the task directive');
  if (payload.priorPlan !== null) {
    throw new Error('the Planner request did not carry the expected null priorPlan for the first publication');
  }
  const confirmedSource = requireRecord(payload.confirmedSource, 'the confirmed source');
  const goal = closureSection(summary.goal, 'goal');
  const actions = closureSection(summary.actions, 'actions');
  const result = closureSection(summary.result, 'result');
  const expectedNextStep = closureSection(summary.expectedNextStep, 'expectedNextStep');
  const source = {
    requirementId: requireText(confirmedSource.requirementId, 'the confirmed requirement id'),
    inputRevision: requireNumber(confirmedSource.inputRevision, 'the confirmed input revision'),
    draftId: requireText(confirmedSource.draftId, 'the confirmed draft id'),
    draftRevisionVersion: requireNumber(confirmedSource.draftRevisionVersion, 'the confirmed draft revision version'),
    draftRevisionHash: requireText(confirmedSource.draftRevisionHash, 'the confirmed draft revision hash'),
    confirmationRef: requireText(confirmedSource.confirmationRef, 'the confirmed confirmation reference'),
    evidenceLocators: evidenceLocators(confirmedSource.evidenceRefs),
  };
  const refinedResults = (Array.isArray(payload.refinedResults) ? payload.refinedResults : []).map((entry) => {
    const record = requireRecord(entry, 'a refined result');
    return {
      role: requireText(record.role, 'a refined result role'),
      assignmentId: requireText(record.assignmentId, 'a refined result assignment id'),
      status: requireText(record.status, 'a refined result status'),
      evidenceLocators: evidenceLocators(record.evidenceRefs),
    };
  });
  const snapshot = {
    title,
    summary: `Whole-task plan for "${title}": the directive is "${directive}". The closed turn records the goal "${goal.text}", the actions "${actions.text}", the result "${result.text}", and the expected next step "${expectedNextStep.text}".`,
    completeness: { scope: 'whole-task', status: 'complete' },
    acceptanceCriteria: [{
      criterionId: 'original-directive-satisfied',
      description: `Satisfy the original directive "${directive}" and preserve the confirmed effect cited by the closed turn.`,
    }],
    nodes: [{
      nodeId: 'whole-task',
      kind: 'task',
      title,
      intent: directive,
      definition: {
        directive,
        goal: goal.text,
        actions: actions.text,
        result: result.text,
        expectedNextStep: expectedNextStep.text,
        confirmedSource: source,
        refinedResults,
        evidenceLocators: [...new Set([
          ...goal.locators, ...actions.locators, ...result.locators, ...expectedNextStep.locators,
          ...source.evidenceLocators, ...refinedResults.flatMap((refined) => refined.evidenceLocators),
        ])],
      },
    }],
    phases: [],
    relations: [],
  };
  const text = JSON.stringify({
    decision: 'complete',
    snapshot,
    reasonText: 'first whole-task plan aligned to the original directive and the confirmed closed turn',
  });
  return [
    { type: 'response.created', response: { id: `response-${model}-planner` } },
    { type: 'response.output_text.done', item_id: `planner-message-${model}`, text },
    { type: 'response.completed', response: { id: `response-${model}-planner` } },
  ];
}

/**
 * Controlled HTTP provider upstream. The real provider driver reaches it.
 *
 * The response is chosen from the actual Responses request body, not from a
 * request ordinal: the independent Planner call receives the lawful whole-task
 * plan JSON, the recovered execution receives the real bound standard-turn end
 * action (`humanagent_turn_end`) whose four-part summary and delivery cite the
 * already confirmed effect's exact evidence, and the post-end drain replays the
 * accepted end result as a transport-only text answer. A transport-only text
 * answer is never a standard end, and an unrecognized request fails closed.
 */
async function upstream(model: string, deliveryRef: string): Promise<Upstream> {
  const wires: { path: string; body: string }[] = [];
  const section = (text: string) => ({ text, evidenceRefs: [deliveryRef] });
  const frames = [
    { type: 'response.created', response: { id: `response-${model}` } },
    { type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', call_id: 'cold-resume-end', name: 'humanagent_turn_end', arguments: '' } },
    { type: 'response.output_item.done', output_index: 0,
      item: { type: 'function_call', call_id: 'cold-resume-end', name: 'humanagent_turn_end',
        arguments: JSON.stringify({ summary: {
          goal: section('resume the original business turn'), actions: section('retained the confirmed effect'),
          result: section('standard end accepted on the resumed incarnation'),
          expectedNextStep: section('planner aligns the exact current plan') },
          deliveryRefs: [deliveryRef] }) } },
    { type: 'response.completed', response: { id: `response-${model}` } },
  ];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const path = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      wires.push({ path, body });
      const payload = plannerPayload(body);
      if (payload !== undefined) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(plannerFrames(model, payload).map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
        return;
      }
      if (declaresTurnEnd(body)) {
        const drain = [
          { type: 'response.created', response: { id: `response-${model}-drain` } },
          { type: 'response.output_text.done', item_id: 'message-final', text: `drained-${model}` },
          { type: 'response.completed', response: { id: `response-${model}-drain` } },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(drain.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
        return;
      }
      if (!hasTurnEndSurface(body)) {
        throw new Error('the controlled upstream could not identify a lawful cold-resume Responses stage');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing socket address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    wires,
    close: async () => {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

interface ColdFixture {
  readonly root: string;
  readonly preparedPath: string;
  readonly journalPath: string;
  readonly artifactsRoot: string;
  readonly retryPath: string;
  readonly allocation: RuntimeExecutionAllocation;
  readonly assignment: WorkAssignment;
  readonly taskScope: ScopeRef;
  readonly businessTurnId: string;
  readonly predecessor: ActiveTurnSegmentPredecessorRef;
  readonly effect: FileWriteEffect;
  readonly effectPath: string;
  readonly output: string;
  /** Exact locator of the confirmed effect evidence the model may cite as delivery. */
  readonly acceptedEvidenceLocator: string;
  readonly journal: JsonlOrganJournal;
  readonly preparedJournal: UiRuntimeJournal;
  readonly completion: JsonlOperationCompletionJournal;
  readonly native: ReturnType<typeof createNativeRecoveryAssets>;
  readonly segmentJournal: ReturnType<typeof createActiveTurnSegmentJournal>;
  readonly taskId: TaskId;
}

/**
 * ONE physical fixture: a real original turn with a confirmed file/tool effect,
 * its original assignment/input/capture, and the exact committed predecessor.
 * Every durable record is written through the real owner.
 */
async function buildColdFixture(name: string): Promise<ColdFixture> {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, `${name}-`));
  const preparedPath = join(root, 'prepared.jsonl');
  const journalPath = join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'assets');
  const retryPath = join(root, 'retry.jsonl');

  const preparedJournal = new UiRuntimeJournal(preparedPath);
  const seed = new RuntimeTaskCoordinator({ organId, journal: preparedJournal,
    createDriver: async () => { throw new Error('the fixture must not start a driver'); },
    checkpointStoreFor: () => new FileCheckpointStore(join(root, 'unused-checkpoints.jsonl')),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    } });
  const task = seed.createTask({ title: 'cold resume', directive: 'original directive' });
  const prompt = 'original canonical input\n保持输入';
  const taskScope = { organId, taskId: task.taskId };
  const journal = new JsonlOrganJournal(journalPath);
  // Establish the original Task's confirmed identity before the first
  // prepareExecution. It is produced through the real typed creation chain:
  // ExplicitIntake -> confirmDraftRevision -> ConfirmationLedger -> the
  // RequirementSubmissionOwner final submit. The identity record is written by
  // the real TaskIdentityConsumer into the same Organ Journal the cold resume
  // reads. No identity is derived from taskId, snapshot, logs or metadata.
  const explicitIntake = new ExplicitIntake();
  const confirmationLedger = new ConfirmationLedger();
  const requirementSubmissions = new RequirementSubmissionOwner(
    confirmationLedger,
    new RequirementInbox(),
    { async submit(envelope) { return { requirementId: envelope.requirementId }; } },
  );
  const interactionId = await explicitIntake.receive({
    sourceRef: 'cold-resume-consumer',
    rawInput: prompt,
    channel: 'business',
    requestKind: 'new-task-create',
    occurredAt: at,
  }, 1);
  await explicitIntake.beginMatching(interactionId);
  await explicitIntake.recordMatch(interactionId, {
    normalizedInput: prompt,
    matchedTasks: [{ taskId: task.taskId, relation: 'current', status: 'created' }],
    knownFacts: [],
  });
  await explicitIntake.propose(interactionId, {
    proposedIntent: 'create',
    proposal: 'original directive',
  });
  await explicitIntake.createDraft(interactionId, {
    goal: 'original directive',
    scope: prompt,
    normalizedInput: prompt,
    proposedIntent: 'create',
    proposal: 'original directive',
  });
  const draftRevision = explicitIntake.currentDraftRevision(interactionId);
  if (draftRevision === undefined) {
    throw new Error('the fixture must own a typed draft revision before confirmation');
  }
  const confirmationRef = 'cold-resume-confirmation';
  const payloadRef = `draft-payload:${draftRevision.draftId}`;
  confirmationLedger.registerRevision({
    interactionId,
    draftId: draftRevision.draftId,
    inputRevision: draftRevision.inputRevision,
    draftRevisionVersion: draftRevision.revisionVersion,
    draftRevisionHash: draftRevision.revisionHash,
    normalizedInput: draftRevision.normalizedInput,
    intent: draftRevision.proposedIntent,
    payloadRef,
    requestKind: 'new-task-create',
  });
  const draftConfirmation = await explicitIntake.confirmDraftRevision({
    interactionId,
    draftId: draftRevision.draftId,
    draftRevisionVersion: draftRevision.revisionVersion,
    draftRevisionHash: draftRevision.revisionHash,
    confirmationRef,
    confirmedBy: 'cold-resume-owner',
    confirmedAt: at,
    payloadRef,
  });
  confirmationLedger.confirmRevision(draftConfirmation);
  const submitted = await requirementSubmissions.submitFinal({
    interactionId,
    draftId: draftRevision.draftId,
    inputRevision: draftRevision.inputRevision,
    draftRevisionVersion: draftRevision.revisionVersion,
    draftRevisionHash: draftRevision.revisionHash,
    confirmationRef,
    idempotencyKey: `cold-resume-final:${draftRevision.draftId}`,
    requestKind: 'new-task-create',
  });
  const authorized = submitted.requirement;
  await new TaskIdentityConsumer(new JsonlTaskIdentityJournal(journal)).establish({
    scope: taskScope,
    source: {
      requirementId: authorized.requirementId,
      inputRevision: authorized.inputRevision,
      draftId: authorized.draftId,
      draftRevisionVersion: authorized.draftRevisionVersion,
      draftRevisionHash: authorized.draftRevisionHash,
      confirmationRef: authorized.confirmationRef,
    },
  });
  const allocation = seed.prepareExecution(task.taskId, { prompt, configuredAgentId: 'cold-resume-agent' });
  const { scope, taskId, operationId } = allocation;
  const criteria = {
    objective: 'retain full assignment',
    successCriteria: ['source exact'],
    failureCriteria: ['wrong source'],
    incompleteCriteria: ['missing context'],
  };
  const assignment: WorkAssignment = { assignmentId: allocation.assignmentId, taskId,
    pipelineNodeId: 'cold-resume-node', attempt: 1, executionEpoch: allocation.executionEpoch,
    inputRevision: allocation.inputRevision, ...criteria, targetRefs: ['original-target'],
    expectedOutputRefs: ['original-output'],
    acceptanceCriteriaDigest: digestOf(acceptanceCriteriaContent(criteria)),
    requiredCapabilities: ['provider.execution'], mergeGate: 'not-required' };
  const businessTurnId = 'original-business-turn';
  const grants = new JsonlTaskGrantJournal(journal);
  const capability = { actionId: 'task.execute', capabilities: ['provider.execution'], scope: taskScope };
  const grant = await grants.grant({ requestId: 'cold-resume-grant', taskId, owner: allocation.ownerId,
    capability, expectedRevision: 0 });
  // Establish the original parent operation-control binding through the real
  // admission owner. The public resume path reads this exact durable binding
  // (coverage plus the parent control envelope), so the fixture must not write
  // only coverage by hand.
  const admission = createServiceExecutionAdmission({ journal, preparedJournal,
    principalOwner: allocation.ownerId, resourceBoundary: createPreparedOperationBoundary(preparedJournal),
    now: () => new Date(at) });
  const admissionReceipt = await admission.admitExecution(allocation);
  const control = createJsonlOperationControlJournal({ journal });
  const admittedTurn = produceAdmittedTurn({ runtime: { runtimeId: allocation.runtimeId,
    executionEpoch: allocation.executionEpoch, ownerRef: allocation.ownerId, permissionRevision: String(grant.grant!.revision) },
    taskId, scope, assignment, directiveRevision: allocation.directiveRevision, turnId: businessTurnId,
    currentTurnRef: `active-turn://${businessTurnId}`, admissionEvidence: [evidence(scope, 'admission')],
    recoveryStateRef: evidence(scope, 'recovery') });
  const binding = { admittedTurn, assignment, execution: { runtimeId: admissionReceipt.binding.agentRuntimeId,
    executionEpoch: admissionReceipt.binding.harnessExecutionEpoch }, scope };
  const active = await ActiveTurnContext.open({ journal: createJsonlActiveTurnJournal({ filePath: journalPath, turnId: businessTurnId }),
    binding, currentTurnRef: admittedTurn.currentTurnRef });
  const completion = new JsonlOperationCompletionJournal({ journal });
  const native = createNativeRecoveryAssets({ journalPath, journal, assetRoot: artifactsRoot, completionJournal: completion });
  const initialInput = await native.writeInitialInput({ scope, turnId: businessTurnId, rawInput: prompt });
  await active.registerInitialInput(initialInput);
  const requestId = 'accepted-tool-request';
  await active.registerRequest({ request: { turnId: businessTurnId, requestId }, scope, phase: 'dispatching' });
  await active.registerRequest({ request: { turnId: businessTurnId, requestId }, scope, phase: 'dispatched' });
  const toolOperationId = id('operation', 'accepted-tool-operation');
  const execution = { ...binding.execution, organId, taskId, operationId, cycleId: scope.cycleId! };
  const effectBinding = { execution, scope: { ...scope, operationId: toolOperationId }, toolOperationId,
    requestId, callId: 'accepted-call', continuationRef: 'accepted-continuation' };
  const output = 'accepted output bytes';
  const effect: FileWriteEffect = { kind: 'file.write', effectId: await fileWriteEffectId(effectBinding),
    workspaceRef: root, relativePath: 'accepted-output.txt', inputDigest: digest(output), expectedContentDigest: digest(output) };
  // The provider emitted this exact file.write call before the operation ran.
  // The captured call fact is what pairs the confirmed tool result in the fold,
  // and its business arguments plus raw asset are built from this real effect
  // invocation (the written relative path and its actual bytes), never a placeholder.
  const callArguments = { path: effect.relativePath, content: output };
  const rawArguments = { ref: evidenceReference(await new ImmutableAssetStore(artifactsRoot).write('accepted-call-arguments',
    new TextEncoder().encode(JSON.stringify(callArguments))), scope, 'operation'), view: { kind: 'utf8-text' as const } };
  await active.acceptRawFact({ execution: binding.execution, scope,
    request: { turnId: businessTurnId, requestId }, producerSeq: 1,
    fact: { kind: 'tool-call', contentUnitId: 'accepted-call-args-unit',
      call: { callId: effectBinding.callId, toolId: 'file.write', arguments: callArguments,
        continuationRef: effectBinding.continuationRef },
      rawArguments, complete: true } });
  await completion.commitIntent({ kind: 'operation-effect-intent', version: 1, binding: effectBinding, effect });
  await writeFile(join(root, effect.relativePath), output, 'utf8');
  assert.equal(digest(await readFile(join(root, effect.relativePath), 'utf8')), effect.expectedContentDigest);
  const acceptedCompletion = await completion.commitCompletion({ kind: 'operation-completion', version: 1,
    binding: effectBinding, effect, confirmation: { ownerId: allocation.ownerId, method: 'file-readback-digest',
      observedContentDigest: digest(output) },
    result: { operationId: toolOperationId, status: 'succeeded', outputRef: 'artifact://accepted-output',
      outputDigest: digest(output), evidenceRefs: [evidence(scope, 'accepted-output')],
      verifier: { name: 'file-readback', version: '1', decision: 'accepted' }, completedAt: at } });
  const rawOutput = { ref: evidenceReference(await new ImmutableAssetStore(artifactsRoot).write('accepted-output-raw',
    new TextEncoder().encode(output)), scope, 'operation'), view: { kind: 'utf8-text' as const } };
  const accepted: AcceptedRawFact = await active.acceptRawFact({ execution: binding.execution, scope,
    request: { turnId: businessTurnId, requestId }, producerSeq: 2,
    fact: { kind: 'tool-result', contentUnitId: 'accepted-result-unit', callId: effectBinding.callId,
      continuationRef: effectBinding.continuationRef, complete: true, rawOutput,
      result: { ...execution, toolId: 'file.write', callId: effectBinding.callId, status: 'succeeded',
        outputRefs: ['artifact://accepted-output'], evidenceRefs: [evidence(scope, 'accepted-output')] } } });
  await active.registerRequest({ request: { turnId: businessTurnId, requestId }, scope, phase: 'settled' });
  const body = await active.prepareCapture({ pauseId: 'original-boundary', frozenAt: at, initialInput,
    checkpointPath: [], completionRefs: [{ requestId, producerSeq: 2, effectRef: acceptedCompletion.commitIdentity }] });
  const lookups = await completion.discoverExactExecution({ execution });
  const recovery: RecoveryHoldFacts = { commitIdentity: 'recovery-hold:original', laterErrorRefs: [],
    rawTurnRefs: [admittedTurn.currentTurnRef], unresolvedOperationRefs: [], stages: [], durablePhases: [],
    durableReceiptRefs: [], recoveryResponsibilityRef: 'original-recovery-owner' };
  const prepared: PreparedRecoveryCapture = { body, controlRecordCount: active.controlRecordCount(),
    producerDrains: [{ execution: binding.execution, boundaryId: body.cut.pauseId,
      requests: [{ request: { turnId: businessTurnId, requestId }, lastProducerSeq: 2 }] }],
    completionLookups: lookups, recovery };
  const v1Receipt = await native.commitCapturePhase({ turnId: businessTurnId, boundaryId: body.cut.pauseId, prepared });

  const checkpoints = createJsonlCheckpointJournal({ filePath: journalPath, journal });
  const closures = createJsonlCheckpointClosurePort({ filePath: journalPath, journal });
  const history = createJsonlContextHistoryPort({ filePath: journalPath, journal });
  const sourceContext = contextRecord(scope, allocation.runtimeId, allocation.executionEpoch);
  const sourceContextCommit = (await produceContextHistory(history, { record: sourceContext,
    expectedCurrentContextCommitRef: null })).commitRef;
  const checkpoint = { id: id('checkpoint', 'original-checkpoint'), scope, cycleId: scope.cycleId!, seq: 1,
    previousCheckpointId: null, directiveRevision: allocation.directiveRevision, executionEpoch: allocation.executionEpoch,
    outcome: 'waiting' as const, summary: 'retain source', recoveryStateRef: evidence(scope, 'checkpoint-recovery'),
    evidenceRefs: [evidence(scope, 'checkpoint')], next: { kind: 'wait' as const, ref: 'original-recovery-owner' } };
  const selector = { scope, agentRuntimeId: allocation.runtimeId, harnessExecutionEpoch: allocation.executionEpoch };
  const preparation = await prepareCheckpointClosure({ checkpoint, source: 'harness-control', closureReason: 'source proof',
    contextCommitRef: sourceContextCommit, contextHistory: history, operationSelector: selector,
    operationControl: await control.readControl(selector), permission: { permissionRevision: String(grant.grant!.revision),
      grantCommitRef: grant.commit!, revoked: false }, hardBlockers: [], unreturnedCallRefs: [], unresolvedOperationRefs: [],
    closurePort: closures, now: () => new Date(at) });
  await submitCheckpoint({ ownerId: allocation.ownerId, source: 'harness-control', checkpoint, previous: null,
    journal: checkpoints, closurePort: closures, preparation });
  await createJsonlRuntimeTaskCurrentStateJournal({ journal }).commit({ transitionId: 'current-state', taskScope,
    expectedStateCommitRef: null, state: { task: { id: taskId, organId, title: task.title, directive: task.directive,
      directiveRevision: allocation.directiveRevision, state: 'running', memoryScope: 'task' },
      processing: { entryPhase: 'executing', nextAction: checkpoint.next, hardBlockers: [],
        recoveryResponsibilityRef: 'original-recovery-owner', laterErrorRefs: [], stages: [] },
      retainedDuties: [{ operationRef: operationId.value, owner: allocation.ownerId }], sourceCommitRefs: [] } });

  const segmentJournal = createActiveTurnSegmentJournal({ journalPath, assetRoot: artifactsRoot,
    completionJournal: completion, businessTurnId });
  const predecessor: ActiveTurnSegmentPredecessorRef = { segmentId: businessTurnId, recoveryAssetsReceiptRef: v1Receipt.commitIdentity };

  return { root, preparedPath, journalPath, artifactsRoot, retryPath, allocation, assignment, taskScope,
    businessTurnId, predecessor, effect, effectPath: join(root, effect.relativePath), output, journal,
    acceptedEvidenceLocator: evidence(scope, 'accepted-output').locator,
    preparedJournal: new UiRuntimeJournal(preparedPath), completion, native, segmentJournal, taskId };
}

/**
 * The real production owners. `createDefaultExecutionComposition` binds the five
 * cold producer ports; the coordinator owns the actual assembly/pool/lifecycle
 * transfer and exposes the public `resumeExecution` selector.
 */
function buildResumeRuntime(fixture: ColdFixture, upstreamBaseUrl: string, model: string) {
  const now = () => new Date(at);
  const principal = { owner: fixture.allocation.ownerId,
    session: { sessionId: 'cold-resume-session', sessionGeneration: 1, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER } };
  const currentState = createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal });
  const httpProvider: ProviderConfig = { source: 'http', provider: 'http', binding: 'cold-resume-binding',
    protocol: 'responses', model, route: 'cold-resume-route', baseUrl: upstreamBaseUrl };
  const entries: EffectiveAgentProviderBinding[] = [
    { agentId: 'cold-resume-agent', roleId: 'execution', source: 'agent', provider: httpProvider },
    // The post-close Planner selects the real configured `orchestration` role.
    // The same provider/model/route is reused; Planner independence comes from
    // the fresh pool incarnation and its own Provider driver, not a new model.
    { agentId: 'cold-resume-planner', roleId: 'orchestration', source: 'agent', provider: httpProvider }];
  const prepare = async (selection: { readonly roleId: 'execution' | 'orchestration' | 'interaction' | 'review' | 'memory';
    readonly configuredAgentId?: string }): Promise<AgentProviderComposition> =>
    prepareAgentProvider({ roleId: selection.roleId,
      ...(selection.configuredAgentId === undefined ? {} : { configuredAgentId: selection.configuredAgentId }),
      agentProviderBindings: entries, legacyProvider: httpProvider, evidenceRoot: fixture.artifactsRoot });

  let coordinator: RuntimeTaskCoordinator;
  const assemblies: { readonly orchestration: OrchestrationManager;
    readonly runtimePool: AgentRuntimePoolManager }[] = [];
  const composition = createDefaultExecutionComposition({
    principalOwner: principal.owner,
    journal: fixture.journal,
    filePath: fixture.journalPath,
    artifactsRoot: fixture.artifactsRoot,
    preparedJournal: fixture.preparedJournal,
    resourceBoundary: createPreparedOperationBoundary(fixture.preparedJournal),
    prepareAgentProvider: prepare,
    providerOptions: {},
    now,
    currentState,
    publishCurrentTurnState: (taskId) => coordinator.publishCurrentTurnState(taskId),
    closedTurnPlannerPool: (taskId) => coordinator.closedTurnPlannerPool(taskId),
    taskIdentity: new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal)),
    i2Journal: createJsonlI2JournalPort({ filePath: fixture.journalPath, journal: fixture.journal }),
    retryJournal: createJsonlRetryCycleJournalPort({ filePath: fixture.retryPath }),
  });
  coordinator = new RuntimeTaskCoordinator({
    organId,
    checkpointStoreFor: () => new FileCheckpointStore(join(fixture.root, 'checkpoints.jsonl')),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
    journal: fixture.preparedJournal,
    now,
    currentStatePort: currentState,
    currentStateFacts: composition.currentStateFacts,
    admitExecution: composition.admitExecution,
    createDriver: composition.createExecutionDriver,
    createTaskAssembly: ({ scope, checkpointJournal, executionAgent, maxAttempts }) => {
      const pool = new AgentRuntimePoolManager({ maxRuntimes: 4, ownerId: fixture.allocation.ownerId,
        factory: { async start(request) { return { runtimeId: request.runtimeId, generation: request.generation,
          capabilities: [...request.requiredCapabilities] }; }, async dispose() {} } });
      const orchestration = new OrchestrationManager({ ownerId: fixture.allocation.ownerId, runtimePool: pool,
        ...(executionAgent === undefined ? {} : { executionAgent }),
        reviewAgent: passingReviewAgent(scope), mergeCoordinator: mergeCoordinator(scope),
        maxAttempts: maxAttempts ?? 1 });
      const assembly = { orchestration, runtimePool: pool };
      assemblies.push(assembly);
      return assembly;
    },
    // The cold producer is the only new coordinator binding. The coordinator
    // owns the matching ColdExecutionLifecycleBinding internally.
    coldExecution: composition,
  });
  return { coordinator, composition, assemblies };
}

function passingReviewAgent(scope: ScopeRef): ReviewAgentPort {
  return {
    roleId: 'cold-resume-review',
    createInstance(create) {
      return { incarnation: create.incarnation, async review(input) { return { result: reviewResult(input), output: { text: 'reviewed', artifactRef: null, artifactDigest: null }, completedAt: at }; }, async dispose() {} };
    },
    async review(input) { return reviewResult(input); },
  };
  function reviewResult(input: Parameters<ReviewAgentPort['review']>[0]) {
    return { resultId: `review-${input.reviewAssignment.assignmentId}`,
      assignmentId: input.reviewAssignment.assignmentId, taskId: input.reviewAssignment.taskId,
      workerAgentId: input.reviewAssignment.workerAgentId, reviewKind: input.reviewAssignment.reviewKind,
      attempt: input.reviewAssignment.attempt, executionEpoch: input.reviewAssignment.executionEpoch,
      inputRevision: input.reviewAssignment.inputRevision,
      acceptanceCriteriaDigest: input.reviewAssignment.acceptanceCriteriaDigest,
      subjectRefs: [...input.reviewAssignment.subjectRefs], subjectDigests: [...input.reviewAssignment.subjectDigests],
      status: 'passed' as const, findings: [], evidenceRefs: [evidence(scope, 'review')] };
  }
}

function mergeCoordinator(scope: ScopeRef): MergeCoordinatorPort {
  return { async merge(request) {
    return { status: 'merged', evidenceRefs: [...request.workerResult.evidenceRefs,
      ...request.reviewResults.flatMap((review) => review.evidenceRefs), evidence(scope, 'merge')] };
  } };
}

/** The latest durable native-save progress record, decoded through the real codec envelope. */
function latestNativeSaveProgress(records: readonly JournalRecord[]): NativeSaveProgress | undefined {
  let found: NativeSaveProgress | undefined;
  for (const record of records) {
    const envelope = record.payload?.['progress'] as { readonly progress?: NativeSaveProgress } | undefined;
    if (envelope?.progress !== undefined) found = envelope.progress;
  }
  return found;
}

/** Committed operation intent/completion records that name the exact confirmed effect. */
function effectRecordCount(records: readonly JournalRecord[], effectId: string): number {
  let count = 0;
  for (const record of records) {
    const payload = record.payload;
    if (payload === undefined) continue;
    const candidate = (payload['intent'] ?? payload['completion']) as
      | { readonly effect?: { readonly effectId?: string } }
      | undefined;
    if (candidate?.effect?.effectId === effectId) count += 1;
  }
  return count;
}

test('public resumeExecution preserves business identity and reaches the standard-end endpoint without replaying the confirmed effect', async () => {
  const fixture = await buildColdFixture('resume-endpoint');
  const journalBytesBefore = await readFile(fixture.journalPath, 'utf8');
  const recordsBefore = (await fixture.journal.verify()).records;
  const effectRecordsBefore = effectRecordCount(recordsBefore, fixture.effect.effectId);
  const http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator);
  let assemblies: ReturnType<typeof buildResumeRuntime>['assemblies'] = [];
  let succeeded = false;
  try {
    const runtime = buildResumeRuntime(fixture, http.baseUrl, 'cold-resume.model');
    const { coordinator, composition } = runtime;
    assemblies = runtime.assemblies;
    const release: RuntimeExecutionRelease = await coordinator.resumeExecution(
      fixture.taskId, fixture.allocation.operationId,
      { businessTurnId: fixture.businessTurnId, predecessor: fixture.predecessor });
    assert.equal(release.state, 'released', 'the public endpoint must reach an owned lease release');

    // Original business identity is preserved; the physical binding is new.
    const task = coordinator.taskSnapshot(fixture.taskId);
    assert.equal(task.taskId.value, fixture.taskId.value);
    assert.equal(task.directive, 'original directive');

    // The resumed generation really made a model request through the real driver.
    assert.ok(http.wires.length >= 1, 'the resumed incarnation must issue a real provider request');
    assert.ok(http.wires.every((wire) => JSON.parse(wire.body).model === 'cold-resume.model'),
      'every resumed request must carry the selected provider model');

    // The accepted effect is retained exactly; resume never replays it.
    const readback = await fixture.native.readRecoveryAssetsExact(fixture.predecessor.recoveryAssetsReceiptRef);
    assert.equal(readback.receipt.turnId, fixture.businessTurnId);
    assert.equal(await readFile(fixture.effectPath, 'utf8'), fixture.output,
      'the confirmed effect bytes remain intact and are not rewritten');

    // The Journal is append-only: the exact original prefix survives the resume,
    // so a same-bytes replay that rewrote or re-committed the confirmed effect
    // would break the prefix and the effect-record count below.
    const afterBytes = await readFile(fixture.journalPath, 'utf8');
    assert.equal(afterBytes.slice(0, journalBytesBefore.length), journalBytesBefore,
      'the original Journal prefix must stay byte-identical across the resume');
    const afterRecords = (await fixture.journal.verify()).records;
    assert.equal(effectRecordCount(afterRecords, fixture.effect.effectId), effectRecordsBefore,
      'the resume must not add any operation intent/completion for the confirmed effect');

    // A real new physical incarnation/epoch was opened while the business
    // identity, assignment, allocation and input stay the original ones.
    const segments = await fixture.segmentJournal.readSegments(fixture.businessTurnId);
    assert.equal(segments.length, 1, 'a generation-ready resume opens exactly one new execution segment');
    const resumed = segments[0]!;
    const successorEpoch = fixture.allocation.executionEpoch + 1;
    assert.ok(resumed.segmentId !== fixture.businessTurnId, 'the resumed segment is a new physical incarnation');
    assert.equal(resumed.binding.execution.executionEpoch, successorEpoch,
      'the resumed incarnation advances past the single original epoch floor');
    assert.equal(resumed.binding.incarnation.executionEpoch, resumed.binding.execution.executionEpoch,
      'the segment incarnation and execution share the successor epoch');
    assert.equal(resumed.binding.assignment.assignmentId, fixture.assignment.assignmentId,
      'the original assignment identity is preserved');
    assert.equal(resumed.binding.assignment.taskId.value, fixture.taskId.value, 'the original task identity is preserved');
    assert.equal(resumed.binding.assignment.inputRevision, fixture.assignment.inputRevision,
      'the original input revision is preserved');
    assert.equal(resumed.binding.businessTurnRef.businessTurnId, fixture.businessTurnId,
      'the original business turn is preserved');
    assert.equal(resumed.binding.scope.operationId?.value, fixture.allocation.operationId.value,
      'the original operation identity is preserved');
    assert.equal(resumed.predecessor.segmentId, fixture.businessTurnId,
      'the resumed segment continues the original business turn');
    assert.equal(resumed.predecessor.recoveryAssetsReceiptRef, fixture.predecessor.recoveryAssetsReceiptRef,
      'the resumed segment links the exact original v1 receipt');

    // The canonical physical position/context carry the successor epoch, not the
    // old one, and keep the four-part durable summary with its real digest.
    const currentAfter = readCurrentFromRecords(afterRecords, fixture.taskScope);
    assert.equal(currentAfter.state, 'known',
      currentAfter.state === 'unknown' ? currentAfter.reason : 'canonical current facts must be known');
    if (currentAfter.state === 'known') {
      assert.equal(currentAfter.position.executionEpoch, successorEpoch,
        'the canonical physical checkpoint position must carry the successor epoch');
      assert.equal(currentAfter.context.loopCheckpoint.executionEpoch, successorEpoch,
        'the canonical resumed context must carry the successor epoch');
      const durable = currentAfter.context.durableContext;
      assert.ok(durable.stablePrefix.length > 0 && durable.indexRefs.length > 0
        && durable.dynamicHead.length > 0 && durable.repairRefs.length > 0,
        'the canonical context keeps the four-part durable summary');
      assert.equal(currentAfter.context.durableContextDigest, durableContextDigest(durable),
        'the canonical context summary digest must match its own body');
    }

    // Real standard end -> physically bound checkpoint -> native save phases ->
    // the same post-close Planner, all read from the durable owner records.
    const progress = latestNativeSaveProgress(afterRecords);
    assert.ok(progress, 'the resumed turn must commit a durable native-save progress record');
    if (progress) {
      // The durable native-save key must bind the actual successor segment and
      // the original business turn, not the retired v1 original segment.
      assert.ok('version' in progress.key && progress.key.version === 2,
        'the resumed native save must use a version-2 segment key');
      if ('version' in progress.key && progress.key.version === 2) {
        assert.equal(progress.key.segment.segmentId, resumed.segmentId,
          'the native save key must bind the actual successor segment');
        assert.equal(progress.key.turn.turnId, fixture.businessTurnId,
          'the native save key must bind the original business turn');
      }
      const committed = progress.phases.filter((phase) => phase.state === 'committed').map((phase) => phase.phase);
      assert.deepEqual([...committed].sort(), [...NATIVE_SAVE_PHASES].sort(),
        'every one of the five native save phases must commit for the resumed turn');
      const intentRead = await createJsonlNativeSaveProgressPort({ journal: fixture.journal })
        .readIntentExact?.(progress.key);
      assert.equal(intentRead?.state, 'found', 'the resumed native save must retain its exact immutable intent');
      if (intentRead?.state === 'found') {
        assert.ok(isNativeSegmentSaveIntentV2(intentRead.intent),
          'the retained native save intent must be a version-2 segment intent');
        if (isNativeSegmentSaveIntentV2(intentRead.intent)) {
          assert.equal(intentRead.intent.key.segment.segmentId, resumed.segmentId,
            'the native save intent must bind the actual successor segment');
          assert.equal(intentRead.intent.source.opened.segmentId, resumed.segmentId,
            'the native save source must be the actual opened successor segment');
          assert.equal(intentRead.intent.source.opened.businessTurnRef.businessTurnId, fixture.businessTurnId,
            'the native save source must bind the original business turn');
          const semantics = intentRead.intent.contextView.semantics;
          for (const part of [semantics.goal, semantics.actions, semantics.result, semantics.nextStep]) {
            assert.ok(typeof part === 'string' && part.length > 0,
              'the four-part turn summary must carry every section from the real standard end');
          }
        }
      }
      // The canonical physical checkpoint carries a real owner-sampled time.
      const nativeReceipt = await createJsonlCheckpointJournal({ filePath: fixture.journalPath, journal: fixture.journal })
        .readNativeCheckpoint({ checkpoint: progress.key.checkpoint });
      assert.ok(nativeReceipt, 'the resumed canonical checkpoint must have a native commit envelope');
      if (nativeReceipt) {
        assert.equal(nativeReceipt.receipt.committedAt, at,
          'the checkpoint time must come from the real owner clock, not a fabricated instant');
      }
    }

    // The post-close Planner publishes an exact current plan that reads back.
    const currentState = await createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal })
      .read(fixture.taskScope);
    assert.equal(currentState.state, 'known', 'the post-close Planner must publish an authoritative current state');
    if (currentState.state === 'known') {
      assert.ok(currentState.value.currentPlan, 'the post-close Planner must publish an exact current plan');
      const facts = await composition.currentStateFacts.read({ taskId: fixture.taskId, scope: fixture.taskScope });
      assert.equal(facts.state, 'known',
        facts.state === 'unknown' ? facts.reason : 'the composition current-state facts must be known, not empty');
      if (facts.state === 'known') {
        assert.ok(facts.value.currentPlan !== undefined,
          'the composition must read back the exact published current plan');
        assert.equal(canonicalJsonStringify(currentState.value.currentPlan), canonicalJsonStringify(facts.value.currentPlan),
          'the current plan readback must match the owner publication exactly');
      }
    }

    // Disposition: the owned lease/driver is released after the standard-end lifecycle.
    assert.ok(assemblies.length >= 1, 'the resume must run through the real assembly factory');
    for (const assembly of assemblies) {
      assert.ok(assembly.runtimePool.inspect().runtimes.every((runtime) => runtime.lease === undefined),
        'every resumed runtime must release its lease when the standard-end lifecycle completes');
    }

    // Retain the already-asserted Planner wire and canonical owner records as
    // passed evidence. The archive is a new directory outside the runtime
    // fixture, so the existing success cleanup still removes the fixture. The
    // exact Organ Journal copy already carries the committed Task identity,
    // checkpoint, closure, native-save progress, Planner duty, plan
    // publication, alignment and current-plan references asserted above.
    const archiveRoot = await mkdtemp(join(PERSISTENCE_ROOT, 'passed-receipts-'));
    try {
      await writeFile(join(archiveRoot, 'upstream-wires.json'), JSON.stringify(http.wires, null, 2), 'utf8');
      await writeFile(join(archiveRoot, 'organ-journal.jsonl'), await readFile(fixture.journalPath, 'utf8'), 'utf8');
      console.log(`cold-resume passed receipt archive: ${archiveRoot}`);
    } catch (error) {
      await rm(archiveRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    succeeded = true;
  } finally {
    await http.close();
    for (const assembly of assemblies) await assembly.runtimePool.dispose();
    if (succeeded) {
      await rm(fixture.root, { recursive: true, force: true });
    } else {
      await writeFile(join(fixture.root, 'upstream-wires.json'), JSON.stringify(http.wires, null, 2), 'utf8')
        .catch(() => undefined);
      console.error(`cold-resume fixture retained for evidence at ${fixture.root}`);
    }
  }
});

test('public resumeExecution holds with zero generation and zero effects when the current grant denies the resumed incarnation', async () => {
  const fixture = await buildColdFixture('resume-grant-denied');
  const http = await upstream('cold-resume-denied.model', fixture.acceptedEvidenceLocator);
  let assemblies: ReturnType<typeof buildResumeRuntime>['assemblies'] = [];
  let succeeded = false;
  try {
    const runtime = buildResumeRuntime(fixture, http.baseUrl, 'cold-resume-denied.model');
    const { coordinator } = runtime;
    assemblies = runtime.assemblies;
    // Revoke the current grant: the real owner must refuse the resumed incarnation.
    const grants = new JsonlTaskGrantJournal(fixture.journal);
    await grants.revoke({ requestId: 'cold-resume-revoke', taskId: fixture.taskId,
      owner: fixture.allocation.ownerId, expectedRevision: 1 });
    // The revoke itself is a legitimate durable append, so the baseline is taken
    // after it: the assertion below measures only the denied resume.
    const journalBeforeResume = await readFile(fixture.journalPath, 'utf8');
    await assert.rejects(() => coordinator.resumeExecution(fixture.taskId, fixture.allocation.operationId,
      { businessTurnId: fixture.businessTurnId, predecessor: fixture.predecessor }));
    assert.equal(http.wires.length, 0, 'a denied resume must not issue a model request');
    assert.equal(await readFile(fixture.effectPath, 'utf8'), fixture.output,
      'a denied resume must not replay the confirmed effect');
    // A denied resume issues no generation and commits no successor incarnation.
    assert.equal((await fixture.segmentJournal.readSegments(fixture.businessTurnId)).length, 0,
      'a denied resume must open no successor segment');
    assert.equal(await readFile(fixture.journalPath, 'utf8'), journalBeforeResume,
      'a denied resume must not append any durable generation or effect record');
    succeeded = true;
  } finally {
    await http.close();
    for (const assembly of assemblies) await assembly.runtimePool.dispose();
    if (succeeded) {
      await rm(fixture.root, { recursive: true, force: true });
    } else {
      await writeFile(join(fixture.root, 'upstream-wires.json'), JSON.stringify(http.wires, null, 2), 'utf8')
        .catch(() => undefined);
      console.error(`cold-resume fixture retained for evidence at ${fixture.root}`);
    }
  }
});
