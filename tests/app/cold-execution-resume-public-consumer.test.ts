import assert from 'node:assert/strict';
import { spawn, type ChildProcessLike as ChildProcess } from 'node:child_process';
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
  isStandardTurnEndToolId,
  type AcceptedRawFact,
  type AgentInput,
  type ContextHistoryRecord,
  type EvidenceRef,
  type FileWriteCompletionFact,
  type FileWriteEffect,
  type FileWriteEffectIntent,
  type OperationId,
  type PreparedRecoveryCapture,
  type PublishedTaskPlanRevision,
  type ProviderBinding,
  type RecoveryHoldFacts,
  type ScopeRef,
  type TaskId,
  type WorkAssignment,
} from '../../packages/contracts/src/index.js';
import type {
  ActiveTurnInitialOpenAnchor,
  ActiveTurnInitialSegmentSource,
  ActiveTurnSegmentPredecessorRef,
} from '../../packages/contracts/src/active-turn-segments.js';
import type { JournalCommitRef } from '../../packages/contracts/src/i2-history.js';
import type { TaskRuntimeIncarnation } from '../../packages/contracts/src/framework.js';
import { JsonlOrganJournal, type JournalRecord } from '../../packages/adapters/jsonl/src/index.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import {
  createJsonlActiveTurnJournal,
  decodeActiveTurnRecords,
} from '../../packages/adapters/jsonl/src/active-turn.js';
import type { ActiveTurnJournalRecord } from '../../packages/runtime/src/context/active-turn-journal.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { ImmutableAssetStore, evidenceReference } from '../../packages/adapters/filesystem/src/index.js';
import { DeterministicMemoryBackend, RootedMemoryPersistence } from '../../packages/adapters/memory/src/index.js';
import { produceAdmittedTurn } from '../../packages/runtime/src/admission/admitted-turn.js';
import { ActiveTurnContext } from '../../packages/runtime/src/context/active-turn-context.js';
import { ActiveTurnSegmentContext } from '../../packages/runtime/src/context/active-turn-context.js';
import { resumeActiveTurnSegment } from '../../packages/runtime/src/context/active-turn-segments.js';
import { durableContextDigest, produceContextHistory } from '../../packages/runtime/src/checkpoints/coordinator.js';
import { prepareCheckpointClosure } from '../../packages/runtime/src/checkpoints/closure.js';
import { submitCheckpoint } from '../../packages/runtime/src/checkpoints/submission.js';
import {
  projectDurableTaskInventory,
  RuntimeTaskCoordinator,
  type RuntimeExecutionAllocation,
  type RuntimeExecutionRelease,
} from '../../packages/runtime/src/ui-runtime/coordinator.js';
import type { RuntimeColdExecutionResumeRequest } from '../../packages/runtime/src/ui-runtime/cold-execution-resume.js';
import type { ClosedTurnPlannerCallRecord } from '../../packages/runtime/src/orchestration/closed-turn-planner-call.js';
import { UiRuntimeJournal, FileCheckpointStore } from '../../packages/app/src/ui-runtime/journal.js';
import {
  createJsonlCheckpointJournal,
  createJsonlCheckpointClosurePort,
  createJsonlContextHistoryPort,
  closureFromRecord,
  contextHistoryFromRecord,
} from '../../packages/app/src/checkpoint-journal.js';
import { readOperationControlFromRecords } from '../../packages/app/src/operation-control-journal.js';
import { createNativeRecoveryAssets, createActiveTurnSegmentJournal } from '../../packages/app/src/native-recovery-assets.js';
import { createJsonlOperationControlJournal } from '../../packages/app/src/operation-control-journal.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { createJsonlRetryCycleJournalPort } from '../../packages/app/src/retry-cycle-journal.js';
import { readCurrentFromRecords } from '../../packages/app/src/ui-runtime/reentry-current-facts.js';
import { createDefaultExecutionComposition, createServiceExecutionAdmission, ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import {
  RESPONSES_FILE_WRITE_TOOL,
} from '../../packages/app/src/provider-tool-execution.js';
import type { ProviderToolDefinition } from '../../packages/contracts/src/index.js';
import { UiRuntimeService, FakeReplayExecutionRuntimePort, startUiRuntime, uiRuntimeControlJournalPath } from '../../packages/app/src/ui-runtime/index.js';
import { composeUiMemoryHooks, memoryDriverFactory } from '../../packages/app/src/cli.js';
import { composeMemoryRuntime, createJournalCheckpointEvidencePort } from '../../packages/app/src/memory-runtime.js';
import { resolveRuntimePaths, ensureControlLayout, loadConfiguration } from '../../packages/config/src/index.js';
import { createJsonlAttentionPort, readJsonlAttentions } from '../../packages/app/src/attention-journal.js';
import { createUiRuntimeRequestDispatcher } from '../../packages/app/src/ui-runtime/server.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import type { UiRuntimeServiceOptions } from '../../packages/app/src/ui-runtime/service.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import { JsonlTaskIdentityJournal, JsonlTaskPlanRevisionJournal } from '../../packages/adapters/jsonl/src/index.js';
import { TaskPlanRevisionConsumer, readCurrentTaskPlan } from '../../packages/runtime/src/orchestration/task-plan-revisions.js';
import { ExplicitIntake, MemoryCoordinator, RequirementInbox, type AttentionPort } from '../../packages/runtime/src/index.js';
import { ConfirmationLedger, RequirementSubmissionOwner } from '../../packages/runtime/src/explicit-brain/router.js';
import { createJsonlNativeSaveProgressPort } from '../../packages/adapters/jsonl/src/native-save-progress.js';
import {
  NATIVE_SAVE_PHASES,
  isNativeSegmentSaveIntentV2,
  type NativeSaveProgress,
} from '../../packages/runtime/src/checkpoints/native-save-contract.js';
import { prepareAgentProvider, prepareExecutionAgentProvider, createAgentProviderPort, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import type { ExplicitBrainInputInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import { AppLifecycleError } from '../../packages/app/src/errors.js';
import type { ProviderConfig, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import {
  AgentRuntimePoolManager,
  OrchestrationManager,
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
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'i1-initial-source-20261016');
const EVIDENCE_ROOT = process.env.HUMANAGENT_TEST_EVIDENCE_ROOT ?? PERSISTENCE_ROOT;
const at = '2026-10-14T00:00:00.000Z';
const organId = id('organ', 'cold-resume-organ');
const c3aWrongRef = 'wrong-business-ref';
const c3aAcceptedRef = 'accepted-prefix';
const c3aOmittedRef = 'older-view';
const c3aContextSeed = {
  activeRefs: [c3aAcceptedRef, c3aWrongRef],
  omittedRefs: [c3aOmittedRef],
} as const;
const processMode = process.argv.find((arg) => arg.startsWith('--cold-process='))?.split('=', 2)[1];
const processKind = process.argv.find((arg) => arg.startsWith('--fixture-kind='))?.split('=', 2)[1] ?? 'captured';
const processRoot = process.argv.find((arg) => arg === '--fixture-root') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--fixture-root') + 1];
const processTask = process.argv.find((arg) => arg === '--task-id') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--task-id') + 1];
/** The ambient frozen surface does not declare ppid; read it through one typed cast. */
const processPpid = (process as unknown as { readonly ppid: number }).ppid;

const serviceBinding: ProviderBinding = {
  bindingId: 'cold-resume-service-binding',
  providerId: 'http',
  protocol: 'responses',
  endpointRef: 'cold-resume-route',
  modelRef: 'cold-resume.model',
  configDigest: 'sha256:cold-resume-service-config',
  capabilityDigest: 'sha256:cold-resume-service-capability',
};

const unusedExplicitBrainInterpreter: ExplicitBrainInputInterpreter = {
  async interpret() {
    throw new Error('explicit brain interpretation is not configured for this consumer');
  },
};

interface ResumeAssembly {
  readonly orchestration: OrchestrationManager;
  readonly runtimePool: AgentRuntimePoolManager;
}

interface ResumeRuntimeOptions {
  readonly beforeProvider?: (roleId: string) => void;
  readonly onExecutionInstance?: () => void;
  readonly omitAssemblyFactory?: boolean;
  readonly maxToolRounds?: number;
  readonly providerToolScope?: {
    readonly workspaceRoot: string;
    readonly projectKey: string;
    readonly artifactRoot: string;
    readonly tools: readonly ProviderToolDefinition[];
  };
}

type ColdResumeSelector = (input: {
  readonly taskId: TaskId;
  readonly operationId: OperationId;
}) => Promise<RuntimeColdExecutionResumeRequest>;

type ResumeCompositionCallbacks = Pick<
  Parameters<typeof createDefaultExecutionComposition>[0],
  'publishCurrentTurnState' | 'closedTurnPlannerPool'
>;

function attentionPort(): AttentionPort {
  return {
    async publish(attention) {
      return { attentionId: attention.attentionId, delivered: true };
    },
    async resolve(attention) {
      return { attentionId: attention.attentionId, delivered: true };
    },
  };
}

function testMemory(projectKey: string) {
  return {
    coordinator: new MemoryCoordinator(),
    backend: new DeterministicMemoryBackend(),
    projectKey,
    roleId: 'execution',
  };
}

function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function evidence(scope: ScopeRef, label: string): EvidenceRef {
  return { evidenceId: id('evidence', label), kind: 'operation', source: 'cold-resume-consumer',
    locator: `humanagent://cold-resume/${label}`, scope };
}

function contextRecord(
  scope: ScopeRef,
  runtime: string,
  epoch: number,
  activeRefs: readonly string[] = ['accepted-prefix'],
  omittedRefs: readonly string[] = ['older-view'],
): ContextHistoryRecord {
  const ref = { checkpointId: id('checkpoint', `loop-${epoch}`), digest: `loop-digest-${epoch}` };
  const watermark = { streamId: 'cold-resume-stream', sequence: 0 };
  const observationScopeId = `observation-${epoch}`;
  const durableContext = { stablePrefix: ['original instructions'], indexRefs: ['original index'],
    dynamicHead: ['accepted reasoning', 'accepted tool result'], repairRefs: ['retained duty'] };
  return { kind: 'context-history', schemaVersion: 1, scope, agentRuntimeId: runtime,
    contextView: { contextViewRef: `context-${epoch}`, executionEpoch: epoch, checkpoint: ref,
      contextDigest: `refs-${epoch}`, activeRefs, omittedRefs },
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
  readonly useNextDelivery: () => void;
  readonly baseUrl: string;
  readonly wires: { readonly path: string; readonly body: string }[];
  readonly errors: {
    readonly path: string;
    readonly body: string;
    readonly name: string;
    readonly message: string;
    readonly stack: string | undefined;
    readonly cause: string | undefined;
    readonly errors: string | undefined;
    readonly status: number;
  }[];
  readonly close: () => Promise<void>;
}

/**
 * The only process boundary the test owns: a seed child commits the accepted
 * cold fixture, a fresh resume child reopens the same durable owners and calls
 * the public `resumeExecution` selector. No allocation, capture, lease or other
 * in-memory control object ever crosses this boundary; the child receives only
 * the fixture root and the original Task ID and reads every other fact from the
 * committed Journal and immutable assets.
 */
interface ColdProcessReceipt {
  readonly phase: 'seed' | 'resume' | 'c3a-seed' | 'c3a-next';
  readonly pid: number;
  readonly ppid: number;
  readonly root: string;
  readonly taskId: string;
  readonly archiveRoot?: string;
  readonly fixtureKind?: 'captured' | 'interrupted' | 'initial-open';
}

function emitReceipt(receipt: ColdProcessReceipt): void {
  (process as unknown as { readonly stdout: { readonly write: (text: string) => void } })
    .stdout.write(`${JSON.stringify({ coldProcessReceipt: receipt })}\n`);
}

/** Spawns one child with only the persistent fixture config, never parent test args. */
function spawnColdProcess(args: readonly string[]): ChildProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NODE_OPTIONS;
  env.HUMANAGENT_TEST_ROOT = PERSISTENCE_ROOT;
  env.TMPDIR = PERSISTENCE_ROOT;
  return spawn(process.execPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

interface ColdProcessRun {
  readonly receipt: ColdProcessReceipt;
  readonly stdout: string;
  readonly stderr: string;
  readonly close: { readonly code: number | null; readonly signal: string | null };
}

/** Waits for natural child close, then decodes the JSON receipt from stdout. */
async function collectColdProcess(child: ChildProcess): Promise<ColdProcessRun> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: string) => stderrChunks.push(chunk));
  const close = await new Promise<{ readonly code: number | null; readonly signal: string | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code: unknown, signal: unknown) => resolve({
        code: typeof code === 'number' ? code : null,
        signal: typeof signal === 'string' ? signal : null,
      }));
    });
  const stdout = stdoutChunks.join('');
  const stderr = stderrChunks.join('');
  const receiptLine = stdout.split('\n').find((line) => line.includes('"coldProcessReceipt"'));
  if (receiptLine === undefined) {
    throw new Error(`cold process emitted no receipt; exit ${String(close.code)} signal ${String(close.signal)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return { receipt: (JSON.parse(receiptLine) as { readonly coldProcessReceipt: ColdProcessReceipt }).coldProcessReceipt,
    stdout, stderr, close };
}

async function runSeedProcess(): Promise<void> {
  const fixture = processKind === 'initial-open'
    ? await buildInitialOpenColdFixture('seed-initial-open')
    : await buildColdFixture('resume-endpoint');
  emitReceipt({ phase: 'seed', pid: process.pid, ppid: processPpid,
    root: fixture.root, taskId: fixture.taskId.value, fixtureKind: processKind as 'captured' | 'interrupted' | 'initial-open' });
}

async function runResumeProcess(): Promise<void> {
  if (processRoot === undefined || processTask === undefined) {
    throw new Error('the resume child requires --fixture-root and --task-id');
  }
  const fixture = await reopenColdFixture(processRoot, processTask);
  let archiveRoot: string;
  if (processKind === 'initial-open') {
    archiveRoot = await runHttpResumeAssertions(fixture, 'initial-open', true);
  } else {
    archiveRoot = await runResumeAssertions(fixture, 'cold-resume.model');
  }
  emitReceipt({ phase: 'resume', pid: process.pid, ppid: processPpid,
    root: processRoot, taskId: processTask, archiveRoot, fixtureKind: processKind as 'captured' | 'interrupted' | 'initial-open' });
}

/** One real Responses HTTP request, decoded only as far as its cold-resume stage. */
interface ResponsesWireItem {
  readonly output?: string;
  readonly type?: string;
  readonly call_id?: string;
  readonly arguments?: string;
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

/**
 * The request after an accepted turn-end carries that exact call followed by
 * its function output. A fresh execution request has the turn-end tool surface
 * but no completed turn-end call in its input.
 */
function isPostStandardEndContinuation(raw: string): boolean {
  const input = parseResponsesWire(raw)?.input ?? [];
  let callIndex = -1;
  let call: ResponsesWireItem | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index]!;
    if (item.type !== 'function_call') continue;
    callIndex = index;
    call = item;
  }
  if (call?.name !== 'humanagent_turn_end') return false;
  const output = input.slice(callIndex + 1).find((item) =>
    item.type === 'function_call_output' && item.call_id === call.call_id);
  if (output?.output === undefined) return false;
  const result = JSON.parse(output.output.split('\n[HumanAgent evidence refs]')[0]!) as {
    readonly kind?: string; readonly accepted?: boolean };
  if (result.kind !== 'standard-turn-end' || result.accepted !== true) {
    throw new Error(`standard end rejected: ${output.output}`);
  }
  return true;
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

async function readFixturePriorPlan(
  fixture: Pick<ColdFixture, 'journal' | 'taskScope'>,
): Promise<PublishedTaskPlanRevision | null> {
  const taskScope = { organId: fixture.taskScope.organId, taskId: fixture.taskScope.taskId };
  const identity = await new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal))
    .read(taskScope);
  if (identity === undefined) throw new Error('the fixture Task must have a confirmed identity');
  const state = await createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal })
    .read(taskScope);
  assert.equal(state.state, 'known', 'the fixture Task current state must be known');
  if (state.state !== 'known') throw new Error('the fixture Task current state is unknown');
  const plans = new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(fixture.journal));
  if (!state.value.currentPlan) {
    assert.deepEqual(await plans.list(taskScope), [],
      'an unselected current plan is lawful only before the first publication');
    return null;
  }
  return (await readCurrentTaskPlan({ plans, identity, currentPlan: state.value.currentPlan })).revision;
}

/**
 * The lawful Planner response for this publication, built from the actual
 * request payload. The owner still derives the publication, sequence, digests
 * and alignment from the committed facts; this text carries only the
 * whole-task plan decision the Planner is asked for.
 */
function plannerFrames(
  model: string,
  payload: Record<string, unknown>,
  expectedPriorPlan: PublishedTaskPlanRevision | null,
): readonly Record<string, unknown>[] {
  const task = requireRecord(payload.task, 'the task');
  const closure = requireRecord(payload.closure, 'the closure');
  const summary = requireRecord(closure.summary, 'the closure summary');
  const title = requireText(task.title, 'the task title');
  const directive = requireText(task.directive, 'the task directive');
  if (expectedPriorPlan === null) {
    assert.equal(payload.priorPlan, null, 'the first publication must carry an explicit null priorPlan');
  } else {
    assert.deepEqual(task.organId, expectedPriorPlan.scope.organId);
    assert.deepEqual(task.taskId, expectedPriorPlan.scope.taskId);
    assert.deepEqual(payload.priorPlan, {
      revisionId: expectedPriorPlan.revisionId,
      sequence: expectedPriorPlan.sequence,
      contentDigest: expectedPriorPlan.contentDigest,
      snapshot: expectedPriorPlan.snapshot,
    }, 'the Planner prior must equal the exact durable selected Task plan');
  }
  const confirmedSource = expectedPriorPlan === null
    ? requireRecord(payload.confirmedSource, 'the confirmed source')
    : { ...expectedPriorPlan.source };
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
    reasonText: 'whole-task plan aligned to the original directive and the confirmed closed turn',
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
function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type CommittedEffectFact =
  | { readonly kind: 'operation-effect-intent'; readonly fact: FileWriteEffectIntent }
  | { readonly kind: 'operation-completion'; readonly fact: FileWriteCompletionFact };

/** Reads the two typed completion envelopes by their committed payload keys. */
function committedEffectFacts(records: readonly JournalRecord[]): readonly CommittedEffectFact[] {
  const facts: CommittedEffectFact[] = [];
  for (const record of records) {
    const payload = record.payload;
    if (payload?.kind === 'operation-effect-intent' && isObject(payload.intent)) {
      facts.push({ kind: payload.kind, fact: payload.intent as unknown as FileWriteEffectIntent });
    } else if (payload?.kind === 'operation-completion' && isObject(payload.completion)) {
      facts.push({ kind: payload.kind, fact: payload.completion as unknown as FileWriteCompletionFact });
    }
  }
  return facts;
}

async function upstream(
  model: string,
  deliveryRef: string,
  fixture: Pick<ColdFixture, 'journal' | 'taskScope'>,
  deliveryText?: string,
  summaryText?: { readonly original: Readonly<Record<'goal' | 'actions' | 'result' | 'expectedNextStep', string>>;
    readonly next: Readonly<Record<'goal' | 'actions' | 'result' | 'expectedNextStep', string>> },
  executionFrames?: (body: string) => readonly unknown[] | undefined,
): Promise<Upstream> {
  const wires: { path: string; body: string }[] = [];
  const errors: Upstream['errors'] = [];
  let nextDelivery = false;
  let endCallCount = 0;
  const section = (text: string) => ({ text, evidenceRefs: nextDelivery ? [] : [deliveryRef] });
  const turnEndFrames = () => {
    const callId = `cold-resume-end-${++endCallCount}`;
    return [
      { type: 'response.created', response: { id: `response-${model}` } },
      { type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', call_id: callId, name: 'humanagent_turn_end', arguments: '' } },
      { type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', call_id: callId, name: 'humanagent_turn_end',
          arguments: JSON.stringify({ summary: {
            goal: section(summaryText?.[nextDelivery ? 'next' : 'original'].goal ?? (nextDelivery ? 'complete the next execution' : 'resume the original business turn')),
            actions: section(summaryText?.[nextDelivery ? 'next' : 'original'].actions ?? (nextDelivery ? 'used the corrected forward context' : 'retained the confirmed effect')),
            result: section(summaryText?.[nextDelivery ? 'next' : 'original'].result ?? (nextDelivery ? 'delivered the next execution result' : 'C3A prior-v2 resumed semantic marker')),
            expectedNextStep: section(summaryText?.[nextDelivery ? 'next' : 'original'].expectedNextStep ?? 'planner aligns the exact current plan') },
            deliveryRefs: nextDelivery ? [] : [deliveryRef],
            ...(nextDelivery ? { deliveryText: 'Next execution completed from the corrected forward context.' }
              : deliveryText === undefined ? {} : { deliveryText }) }) } },
      { type: 'response.completed', response: { id: `response-${model}` } },
    ];
  };
  const server = createServer((request, response) => {
    let requestPath = request.url ?? '';
    let requestBody = '';
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requestBody = Buffer.concat(chunks).toString('utf8');
      wires.push({ path: requestPath, body: requestBody });
      const body = requestBody;
      const payload = plannerPayload(body);
      if (payload !== undefined) {
        const expectedPriorPlan = await readFixturePriorPlan(fixture);
        const task = requireRecord(payload.task, 'the task');
        assert.deepEqual(task.organId, fixture.taskScope.organId);
        assert.deepEqual(task.taskId, fixture.taskScope.taskId);
        if (expectedPriorPlan === null) {
          const identity = await new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal))
            .read(fixture.taskScope);
          if (identity === undefined) throw new Error('the first Planner source requires the confirmed Task identity');
          const { evidenceRefs, ...source } = requireRecord(payload.confirmedSource, 'the confirmed source');
          assert.deepEqual(source, identity.source, 'the first Planner source must match the confirmed Task identity');
          assert.deepEqual(evidenceLocators(evidenceRefs), [identity.journalCommitRef]);
        }
        const frames = plannerFrames(model, payload, expectedPriorPlan);
        const serialized = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(serialized);
        return;
      }
      if (isPostStandardEndContinuation(body)) {
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
      response.end((executionFrames?.(body) ?? turnEndFrames()).map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })().catch((error: unknown) => {
      const record = error as { cause?: unknown; errors?: unknown };
      const describe = (value: unknown): string => value instanceof Error
        ? (value.stack ?? `${value.name}: ${value.message}`)
        : safeStringify(value);
      errors.push({
        path: requestPath,
        body: requestBody,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        cause: error instanceof Error ? describe(record.cause) : undefined,
        errors: error instanceof Error ? describe(record.errors) : undefined,
        status: 500,
      });
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
    useNextDelivery: () => { nextDelivery = true; },
    baseUrl: `http://127.0.0.1:${address.port}`,
    wires,
    errors,
    close: async () => {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

interface ColdFixture {
  readonly principalOwner?: string;
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
  /** The exact original v1 recovery receipt; present for the captured base. */
  readonly originalV1ReceiptRef?: string;
  readonly effect: FileWriteEffect;
  readonly effectPath: string;
  readonly output: string;
  /** Exact locator of the confirmed effect evidence the model may cite as delivery. */
  readonly acceptedEvidenceLocator: string;
  /** Exact committed epoch-1 context record; the legal predecessor for a v2 context. */
  readonly contextCommitRef: JournalCommitRef;
  readonly journal: JsonlOrganJournal;
  readonly preparedJournal: UiRuntimeJournal;
  readonly completion: JsonlOperationCompletionJournal;
  readonly native: ReturnType<typeof createNativeRecoveryAssets>;
  readonly segmentJournal: ReturnType<typeof createActiveTurnSegmentJournal>;
  readonly taskId: TaskId;
  readonly initialOpenAnchor?: ActiveTurnInitialOpenAnchor;
  readonly fixtureKind?: 'captured' | 'interrupted' | 'initial-open';
  readonly pendingRequestId?: string;
}

interface InterruptedColdFixture extends ColdFixture {
  readonly interruptedSegmentId: string;
  readonly interruptedRequestId: string;
  readonly interruptedPredecessor: ActiveTurnSegmentPredecessorRef;
}

/**
 * ONE physical uncaptured initial-turn fixture:
 * A legal initial turn that opened and appended records (binding, initial-input,
 * root context, completed effect, pending request, and runtime-task-current-state)
 * but ZERO checkpoints, ZERO checkpoint closures, ZERO recovery-assets.phase
 * commits, and ZERO segment-opened records.
 */
async function buildInitialOpenColdFixture(name: string): Promise<ColdFixture> {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, `${name}-`));
  const preparedPath = join(root, 'prepared.jsonl');
  const journalPath = join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'assets');
  const retryPath = join(root, 'retry.jsonl');

  const preparedJournal = new UiRuntimeJournal(preparedPath);
  const seed = new RuntimeTaskCoordinator({
    organId,
    journal: preparedJournal,
    createDriver: async () => { throw new Error('the fixture must not start a driver'); },
    checkpointStoreFor: () => new FileCheckpointStore(join(root, 'unused-checkpoints.jsonl')),
    attentionPort: {
      async publish(attention) { return { attentionId: attention.attentionId, delivered: true }; },
      async resolve(attention) { return { attentionId: attention.attentionId, delivered: true }; },
    },
  });
  const task = seed.createTask({ title: 'cold resume initial open', directive: 'original directive' });
  const prompt = 'original canonical input\n保持输入';
  const taskScope = { organId, taskId: task.taskId };
  const journal = new JsonlOrganJournal(journalPath);

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
  const confirmationRef = 'cold-resume-confirmation-initial';
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
  const assignment: WorkAssignment = {
    assignmentId: allocation.assignmentId,
    taskId,
    pipelineNodeId: 'cold-resume-node',
    attempt: 1,
    executionEpoch: allocation.executionEpoch,
    inputRevision: allocation.inputRevision,
    ...criteria,
    targetRefs: ['original-target'],
    expectedOutputRefs: ['original-output'],
    requiredCapabilities: ['provider.execution'],
    mergeGate: 'not-required',
  };
  const businessTurnId = 'original-business-turn';
  const grants = new JsonlTaskGrantJournal(journal);
  const capability = { actionId: 'task.execute', capabilities: ['provider.execution'], scope: taskScope };
  const grant = await grants.grant({
    requestId: 'cold-resume-grant-initial',
    taskId,
    owner: allocation.ownerId,
    capability,
    expectedRevision: 0,
  });

  const admission = createServiceExecutionAdmission({
    journal,
    preparedJournal,
    principalOwner: allocation.ownerId,
    resourceBoundary: createPreparedOperationBoundary(preparedJournal),
    now: () => new Date(at),
  });
  const admissionReceipt = await admission.admitExecution(allocation);
  const admittedTurn = produceAdmittedTurn({
    runtime: {
      runtimeId: allocation.runtimeId,
      executionEpoch: allocation.executionEpoch,
      ownerRef: allocation.ownerId,
      permissionRevision: String(grant.grant!.revision),
    },
    taskId,
    scope,
    assignment,
    directiveRevision: allocation.directiveRevision,
    turnId: businessTurnId,
    currentTurnRef: `active-turn://${businessTurnId}`,
    admissionEvidence: [evidence(scope, 'admission')],
    recoveryStateRef: evidence(scope, 'recovery'),
  });
  const binding = {
    admittedTurn,
    assignment,
    execution: {
      runtimeId: admissionReceipt.binding.agentRuntimeId,
      executionEpoch: admissionReceipt.binding.harnessExecutionEpoch,
    },
    scope,
  };
  const active = await ActiveTurnContext.open({
    journal: createJsonlActiveTurnJournal({ filePath: journalPath, turnId: businessTurnId }),
    binding,
    currentTurnRef: admittedTurn.currentTurnRef,
  });
  const completion = new JsonlOperationCompletionJournal({ journal });
  const native = createNativeRecoveryAssets({ journalPath, journal, assetRoot: artifactsRoot, completionJournal: completion });
  const initialInput = await native.writeInitialInput({ scope, turnId: businessTurnId, rawInput: prompt });
  await active.registerInitialInput(initialInput);

  // Commit root context-history record
  const history = createJsonlContextHistoryPort({ filePath: journalPath, journal });
  const sourceContext = contextRecord(scope, allocation.runtimeId, allocation.executionEpoch);
  const sourceContextCommit = (await produceContextHistory(history, {
    record: sourceContext,
    expectedCurrentContextCommitRef: null,
  })).commitRef;

  // Real completed file effect under original identity
  const requestId = 'accepted-tool-request';
  await active.registerRequest({ request: { turnId: businessTurnId, requestId }, scope, phase: 'dispatching' });
  await active.registerRequest({ request: { turnId: businessTurnId, requestId }, scope, phase: 'dispatched' });
  const toolOperationId = id('operation', 'accepted-tool-operation');
  const execution = { ...binding.execution, organId, taskId, operationId, cycleId: scope.cycleId! };
  const effectBinding = {
    execution,
    scope: { ...scope, operationId: toolOperationId },
    toolOperationId,
    requestId,
    callId: 'accepted-call',
    continuationRef: 'accepted-continuation',
  };
  const output = 'accepted output bytes';
  const effect: FileWriteEffect = {
    kind: 'file.write',
    effectId: await fileWriteEffectId(effectBinding),
    workspaceRef: root,
    relativePath: 'accepted-output.txt',
    inputDigest: digest(output),
    expectedContentDigest: digest(output),
  };
  const callArguments = { path: effect.relativePath, content: output };
  const rawArguments = {
    ref: evidenceReference(
      await new ImmutableAssetStore(artifactsRoot).write('accepted-call-arguments', new TextEncoder().encode(JSON.stringify(callArguments))),
      scope,
      'operation',
    ),
    view: { kind: 'utf8-text' as const },
  };
  await active.acceptRawFact({
    execution: binding.execution,
    scope,
    request: { turnId: businessTurnId, requestId },
    producerSeq: 1,
    fact: {
      kind: 'tool-call',
      contentUnitId: 'accepted-call-args-unit',
      call: { callId: effectBinding.callId, toolId: 'file.write', arguments: callArguments, continuationRef: effectBinding.continuationRef },
      rawArguments,
      complete: true,
    },
  });
  await completion.commitIntent({ kind: 'operation-effect-intent', version: 1, binding: effectBinding, effect });
  await writeFile(join(root, effect.relativePath), output, 'utf8');
  assert.equal(digest(await readFile(join(root, effect.relativePath), 'utf8')), effect.expectedContentDigest);
  await completion.commitCompletion({
    kind: 'operation-completion',
    version: 1,
    binding: effectBinding,
    effect,
    confirmation: { ownerId: allocation.ownerId, method: 'file-readback-digest', observedContentDigest: digest(output) },
    result: {
      operationId: toolOperationId,
      status: 'succeeded',
      outputRef: 'artifact://accepted-output',
      outputDigest: digest(output),
      evidenceRefs: [evidence(scope, 'accepted-output')],
      verifier: { name: 'file-readback', version: '1', decision: 'accepted' },
      completedAt: at,
    },
  });
  const rawOutput = {
    ref: evidenceReference(
      await new ImmutableAssetStore(artifactsRoot).write('accepted-output-raw', new TextEncoder().encode(output)),
      scope,
      'operation',
    ),
    view: { kind: 'utf8-text' as const },
  };
  await active.acceptRawFact({
    execution: binding.execution,
    scope,
    request: { turnId: businessTurnId, requestId },
    producerSeq: 2,
    fact: {
      kind: 'tool-result',
      contentUnitId: 'accepted-result-unit',
      callId: effectBinding.callId,
      continuationRef: effectBinding.continuationRef,
      complete: true,
      rawOutput,
      result: {
        ...execution,
        toolId: 'file.write',
        callId: effectBinding.callId,
        status: 'succeeded',
        outputRefs: ['artifact://accepted-output'],
        evidenceRefs: [evidence(scope, 'accepted-output')],
      },
    },
  });
  await active.registerRequest({ request: { turnId: businessTurnId, requestId }, scope, phase: 'settled' });

  // Seed pending request ending in waiting
  const pendingRequestId = 'pending-initial-request';
  await active.registerRequest({ request: { turnId: businessTurnId, requestId: pendingRequestId }, scope, phase: 'dispatching' });
  await active.registerRequest({ request: { turnId: businessTurnId, requestId: pendingRequestId }, scope, phase: 'dispatched' });
  await active.registerRequest({ request: { turnId: businessTurnId, requestId: pendingRequestId }, scope, phase: 'waiting' });

  // Commit RuntimeTaskCurrentState in entryPhase: 'open', nextAction: { kind: 'continue' }
  await createJsonlRuntimeTaskCurrentStateJournal({ journal }).commit({
    transitionId: 'current-state',
    taskScope,
    expectedStateCommitRef: null,
    state: {
      task: {
        id: taskId,
        organId,
        title: task.title,
        directive: task.directive,
        directiveRevision: allocation.directiveRevision,
        state: 'running',
        memoryScope: 'task',
      },
      processing: {
        entryPhase: 'open',
        nextAction: { kind: 'continue' },
        hardBlockers: [],
        recoveryResponsibilityRef: 'original-recovery-owner',
        laterErrorRefs: [],
        stages: [],
      },
      retainedDuties: [{ operationRef: operationId.value, owner: allocation.ownerId }],
      sourceCommitRefs: [],
    },
  });

  await journal.verify();
  const segmentJournal = createActiveTurnSegmentJournal({ journalPath, assetRoot: artifactsRoot, completionJournal: completion, businessTurnId });
  const anchor = await segmentJournal.readInitialOpenAnchor();
  if (anchor === null) throw new Error('failed to read initial open anchor from segment journal');
  await segmentJournal.readInitialOpenExact({ businessTurnId, anchor });
  const predecessor: ActiveTurnSegmentPredecessorRef = { segmentId: businessTurnId, initialOpen: anchor };

  return {
    root,
    preparedPath,
    journalPath,
    artifactsRoot,
    retryPath,
    allocation,
    assignment,
    taskScope,
    businessTurnId,
    predecessor,
    effect,
    effectPath: join(root, effect.relativePath),
    output,
    journal,
    acceptedEvidenceLocator: evidence(scope, 'accepted-output').locator,
    contextCommitRef: sourceContextCommit,
    preparedJournal: new UiRuntimeJournal(preparedPath),
    completion,
    native,
    segmentJournal,
    taskId,
    initialOpenAnchor: anchor,
    fixtureKind: 'initial-open',
    pendingRequestId,
  };
}

/**
 * ONE physical fixture: a real original turn with a confirmed file/tool effect,
 * its original assignment/input/capture, and the exact committed predecessor.
 * Every durable record is written through the real owner.
 */
async function buildColdFixture(name: string,
  expectedOutputRefs: readonly string[] = ['original-output'],
  targetRefs: readonly string[] = ['original-target'],
  failInitialRelease = false,
  outstandingRequestId?: string,
  contextSeed?: {
    readonly activeRefs: readonly string[];
    readonly omittedRefs: readonly string[];
  }, source?: { readonly assetId: string; readonly text: string }): Promise<ColdFixture> {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, `${name}-`));
  const preparedPath = name.startsWith('c3a-') ? join(root, 'rcc', 'ui-runtime-journal.jsonl') : join(root, 'prepared.jsonl');
  const journalPath = name.startsWith('c3a-') ? uiRuntimeControlJournalPath(join(root, 'rcc')) : join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'assets');
  const retryPath = name.startsWith('c3a-') ? join((await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: root })).journalRoot, 'ui-runtime', 'retry-cycle.jsonl') : join(root, 'retry.jsonl');
  if (name.startsWith('c3a-')) await writeFile(join(root, 'AGENTS.md'), '# C3a project memory\n', 'utf8');

  const preparedJournal = new UiRuntimeJournal(preparedPath);
  const seed = new RuntimeTaskCoordinator({ organId, journal: preparedJournal,
    ...(failInitialRelease ? { admitExecution: async () => {} } : {}),
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
  if (failInitialRelease) {
    // Exercise the public release boundary. The real coordinator persists the
    // driver construction failure; no error or Journal event is fabricated.
    await assert.rejects(() => seed.releaseExecution(task.taskId, allocation.operationId),
      /the fixture must not start a driver/);
    assert.equal(seed.taskSnapshot(task.taskId).state, 'blocked');
    assert.equal(seed.taskSnapshot(task.taskId).error?.code, 'runtime.execution.failure');
  }
  const { scope, taskId, operationId } = allocation;
  const criteria = {
    objective: 'retain full assignment',
    successCriteria: ['source exact'],
    failureCriteria: ['wrong source'],
    incompleteCriteria: ['missing context'],
  };
  const assignment: WorkAssignment = { assignmentId: allocation.assignmentId, taskId,
    pipelineNodeId: 'cold-resume-node', attempt: 1, executionEpoch: allocation.executionEpoch,
    inputRevision: allocation.inputRevision, ...criteria, targetRefs,
    expectedOutputRefs,
    requiredCapabilities: ['provider.execution'], mergeGate: 'not-required' };
  const businessTurnId = 'original-business-turn';
  const grants = new JsonlTaskGrantJournal(journal);
  const capability = { actionId: 'task.execute', capabilities: ['provider.execution'], scope: taskScope };
  const fixtureAccess = name.startsWith('c3a-') ? await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'), create: true }) : undefined;
  const principalOwner = fixtureAccess?.readProductPrincipalOwner() ?? allocation.ownerId;
  await fixtureAccess?.closeCredentialWatch();
  const grant = await grants.grant({ requestId: 'cold-resume-grant', taskId, owner: principalOwner,
    capability, expectedRevision: 0 });
  // Establish the original parent operation-control binding through the real
  // admission owner. The public resume path reads this exact durable binding
  // (coverage plus the parent control envelope), so the fixture must not write
  // only coverage by hand.
  const admission = createServiceExecutionAdmission({ journal, preparedJournal,
    principalOwner, resourceBoundary: createPreparedOperationBoundary(preparedJournal),
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
  // A legal initial seed for a genuinely unsettled turn: one admitted request
  // whose latest verified phase is still outstanding. It carries no accepted
  // facts, so its producer drain sequence is zero.
  if (outstandingRequestId !== undefined) {
    await active.registerRequest({ request: { turnId: businessTurnId, requestId: outstandingRequestId },
      scope, phase: 'dispatching' });
    await active.registerRequest({ request: { turnId: businessTurnId, requestId: outstandingRequestId },
      scope, phase: 'dispatched' });
  }
  const body = await active.prepareCapture({ pauseId: 'original-boundary', frozenAt: at, initialInput,
    checkpointPath: [], completionRefs: [{ requestId, producerSeq: 2, effectRef: acceptedCompletion.commitIdentity }] });
  const lookups = await completion.discoverExactExecution({ execution });
  const recovery: RecoveryHoldFacts = { commitIdentity: 'recovery-hold:original', laterErrorRefs: [],
    rawTurnRefs: [admittedTurn.currentTurnRef], unresolvedOperationRefs: [], stages: [], durablePhases: [],
    durableReceiptRefs: [], recoveryResponsibilityRef: 'original-recovery-owner' };
  const prepared: PreparedRecoveryCapture = { body, controlRecordCount: active.controlRecordCount(),
    producerDrains: [{ execution: binding.execution, boundaryId: body.cut.pauseId,
      requests: [
        { request: { turnId: businessTurnId, requestId }, lastProducerSeq: 2 },
        ...(outstandingRequestId === undefined ? [] : [{
          request: { turnId: businessTurnId, requestId: outstandingRequestId }, lastProducerSeq: 0,
        }]),
      ] }],
    completionLookups: lookups, recovery };
  const v1Receipt = await native.commitCapturePhase({ turnId: businessTurnId, boundaryId: body.cut.pauseId, prepared });

  const checkpoints = createJsonlCheckpointJournal({ filePath: journalPath, journal });
  const closures = createJsonlCheckpointClosurePort({ filePath: journalPath, journal });
  const history = createJsonlContextHistoryPort({ filePath: journalPath, journal });
  const sourceContext = contextRecord(scope, allocation.runtimeId, allocation.executionEpoch,
    contextSeed?.activeRefs, contextSeed?.omittedRefs);
  const sourceContextCommit = (await produceContextHistory(history, { record: sourceContext,
    expectedCurrentContextCommitRef: null })).commitRef;
  const sourceEvidence = source === undefined ? undefined : evidenceReference(
    await new ImmutableAssetStore(artifactsRoot).write(source.assetId, new TextEncoder().encode(source.text)),
    scope, 'operation', 'provider-p2b-source-material');
  const checkpoint = { id: id('checkpoint', 'original-checkpoint'), scope, cycleId: scope.cycleId!, seq: 1,
    previousCheckpointId: null, directiveRevision: allocation.directiveRevision, executionEpoch: allocation.executionEpoch,
    outcome: 'waiting' as const, summary: source?.text ?? 'retain source', recoveryStateRef: evidence(scope, 'checkpoint-recovery'),
    evidenceRefs: [evidence(scope, 'checkpoint'), ...(sourceEvidence ? [sourceEvidence] : [])], next: { kind: 'wait' as const, ref: 'original-recovery-owner' } };
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

  return { root, preparedPath, journalPath, artifactsRoot, retryPath, allocation, assignment, taskScope, principalOwner,
    businessTurnId, predecessor, originalV1ReceiptRef: v1Receipt.commitIdentity,
    effect, effectPath: join(root, effect.relativePath), output, journal,
    acceptedEvidenceLocator: evidence(scope, 'accepted-output').locator,
    contextCommitRef: sourceContextCommit,
    preparedJournal: new UiRuntimeJournal(preparedPath), completion, native, segmentJournal, taskId };
}

/**
 * Reopens the exact fixture handles a fresh process needs, using only the
 * committed fixture root and the original Task ID. The single `operation.prepared`
 * record is the allocation owner; the v1 recovery receipt is discovered from the
 * committed Journal, never passed across the process boundary and never re-created.
 */
async function reopenColdFixture(root: string, taskIdValue: string, c3aPaths = processMode?.startsWith('c3a-')): Promise<ColdFixture> {
  const preparedPath = c3aPaths ? join(root, 'rcc', 'ui-runtime-journal.jsonl') : join(root, 'prepared.jsonl');
  const journalPath = c3aPaths ? uiRuntimeControlJournalPath(join(root, 'rcc')) : join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'assets');
  const retryPath = c3aPaths ? join((await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: root })).journalRoot, 'ui-runtime', 'retry-cycle.jsonl') : join(root, 'retry.jsonl');
  const journal = new JsonlOrganJournal(journalPath);
  const records = (await journal.verify()).records;
  const preparedJournal = new UiRuntimeJournal(preparedPath);
  const prepared = preparedJournal.replay()
    .filter((record) => record.kind === 'operation.prepared')
    .filter((record) => record.allocation.taskId.value === taskIdValue && record.allocation.executionEpoch === 1);
  if (prepared.length !== 1) {
    throw new Error('the committed fixture has no retained prepared allocation');
  }
  const allocation = prepared[0]!.kind === 'operation.prepared' ? prepared[0]!.allocation : undefined;
  if (allocation === undefined) throw new Error('the retained prepared allocation is not readable');
  const completion = new JsonlOperationCompletionJournal({ journal });
  const native = createNativeRecoveryAssets({ journalPath, journal, assetRoot: artifactsRoot, completionJournal: completion });
  // The v1 recovery receipt is the committed predecessor selector for a captured turn.
  // An uncaptured initial turn carries zero v1 recovery receipts.
  const v1Receipts = records.filter((record) => record.kind === 'event'
    && record.payload?.['type'] === 'recovery-assets.phase' && record.payload?.['version'] === 1
    && record.scope.operationId?.value === allocation.operationId.value);
  if (v1Receipts.length > 1) {
    throw new Error('the committed fixture carries multiple v1 recovery receipts');
  }

  let businessTurnId: string;
  let predecessor: ActiveTurnSegmentPredecessorRef;
  let assignment: WorkAssignment;
  let effect: FileWriteEffect | undefined;
  let acceptedEvidenceLocator: string | undefined;
  let output: string;
  let initialOpenAnchor: ActiveTurnInitialOpenAnchor | undefined;
  let fixtureKind: 'captured' | 'initial-open' = 'captured';

  let segmentJournal: ReturnType<typeof createActiveTurnSegmentJournal>;

  if (v1Receipts.length === 1) {
    const receipt = (v1Receipts[0]!.payload as { readonly receipt: { readonly turnId?: unknown } }).receipt;
    businessTurnId = receipt?.turnId as string;
    if (typeof businessTurnId !== 'string' || businessTurnId.length === 0) {
      throw new Error('the committed v1 recovery receipt does not name the original business turn');
    }
    predecessor = {
      segmentId: businessTurnId, recoveryAssetsReceiptRef: v1Receipts[0]!.commitId!,
    };
    segmentJournal = createActiveTurnSegmentJournal({ journalPath, assetRoot: artifactsRoot,
      completionJournal: completion, businessTurnId });
    const initial = await segmentJournal.readInitialSegmentSource(businessTurnId);
    if (initial === null || initial.kind !== 'captured') throw new Error('the committed fixture does not carry the original v1 capture');
    assignment = initial.body.binding.assignment;
    if (assignment.taskId.value !== taskIdValue) {
      throw new Error('the committed original assignment does not carry the requested Task ID');
    }
    const original = await native.readRecoveryAssetsExact(predecessor.recoveryAssetsReceiptRef);
    for (const lookup of original.prepared.completionLookups) {
      const readback = await completion.readExact(lookup);
      if (readback.state !== 'confirmed') throw new Error('the committed effect completion is not confirmed');
      effect = readback.receipt.fact.effect;
      acceptedEvidenceLocator = readback.receipt.fact.result.evidenceRefs[0]?.locator;
    }
    if (effect === undefined || acceptedEvidenceLocator === undefined) {
      throw new Error('the committed fixture does not carry the confirmed effect');
    }
    const rawOutputs = decodeActiveTurnRecords(records, businessTurnId)
      .flatMap((record) => record.kind === 'accepted-fact'
        ? [record.entry.envelope.fact.kind === 'tool-result' ? record.entry.envelope.fact.rawOutput : undefined] : []);
    const rawOutput = rawOutputs.find((candidate) => candidate !== undefined);
    if (rawOutput === undefined) throw new Error('the committed fixture does not carry the confirmed raw output asset');
    output = new TextDecoder('utf-8', { fatal: true })
      .decode(await new ImmutableAssetStore(artifactsRoot).readEvidence(rawOutput.ref));
    if (digest(output) !== effect.expectedContentDigest) {
      throw new Error('the committed raw output asset does not match the confirmed effect digest');
    }
  } else {
    fixtureKind = 'initial-open';
    const bindingOpened = records.find((record) => record.commitId?.startsWith('active-turn:')
      && record.commitId.endsWith(':binding-opened'));
    if (!bindingOpened || bindingOpened.commitId === undefined) {
      throw new Error('the committed fixture carries no active-turn binding-opened record');
    }
    businessTurnId = bindingOpened.commitId.split(':')[1]!;
    segmentJournal = createActiveTurnSegmentJournal({ journalPath, assetRoot: artifactsRoot,
      completionJournal: completion, businessTurnId });
    initialOpenAnchor = (await segmentJournal.readInitialOpenAnchor()) ?? undefined;
    if (initialOpenAnchor === undefined) {
      throw new Error('the committed initial-open fixture has no readable initial-open anchor');
    }
    await segmentJournal.readInitialOpenExact({ businessTurnId, anchor: initialOpenAnchor });
    predecessor = {
      segmentId: businessTurnId,
      initialOpen: initialOpenAnchor,
    };
    const activeRecords = decodeActiveTurnRecords(records, businessTurnId);
    const bindingRecord = activeRecords.find(
      (r): r is Extract<ActiveTurnJournalRecord, { readonly kind: 'binding-opened' }> => r.kind === 'binding-opened',
    );
    if (!bindingRecord) {
      throw new Error('the committed fixture active turn binding is not decodable');
    }
    assignment = bindingRecord.binding.assignment;
    if (assignment.taskId.value !== taskIdValue) {
      throw new Error('the committed original assignment does not carry the requested Task ID');
    }
    const completionRecords = records.filter((r) => r.kind === 'event' && r.payload?.['completion'] !== undefined);
    for (const record of completionRecords) {
      const comp = (record.payload as { readonly completion?: { readonly effect?: FileWriteEffect; readonly result?: { readonly evidenceRefs?: readonly EvidenceRef[] } } }).completion;
      if (comp?.effect && comp.result?.evidenceRefs?.[0]?.locator) {
        effect = comp.effect;
        acceptedEvidenceLocator = comp.result.evidenceRefs[0].locator;
        break;
      }
    }
    if (effect === undefined || acceptedEvidenceLocator === undefined) {
      throw new Error('the committed initial-open fixture does not carry the confirmed effect');
    }
    const rawOutputs = activeRecords
      .flatMap((record) => record.kind === 'accepted-fact'
        ? [record.entry.envelope.fact.kind === 'tool-result' ? record.entry.envelope.fact.rawOutput : undefined] : []);
    const rawOutput = rawOutputs.find((candidate) => candidate !== undefined);
    if (rawOutput !== undefined) {
      output = new TextDecoder('utf-8', { fatal: true })
        .decode(await new ImmutableAssetStore(artifactsRoot).readEvidence(rawOutput.ref));
    } else {
      output = await readFile(join(root, effect.relativePath), 'utf8');
    }
    if (digest(output) !== effect.expectedContentDigest) {
      throw new Error('the committed raw output asset does not match the confirmed effect digest');
    }
  }
  const epochOneContext = [...records].reverse().find((record) => {
    const context = contextHistoryFromRecord(record);
    return context?.agentRuntimeId === allocation.runtimeId
      && context.loopCheckpoint.executionEpoch === allocation.executionEpoch;
  });
  if (epochOneContext?.commitId === undefined) {
    throw new Error('the committed fixture does not carry the original epoch-1 context');
  }
  const contextCommitRef: JournalCommitRef = {
    commitId: epochOneContext.commitId,
    journalSeq: epochOneContext.seq,
    recordDigest: epochOneContext.recordDigest,
  };
  return {
    root, preparedPath, journalPath, artifactsRoot, retryPath, allocation,
    assignment, taskScope: { organId: allocation.scope.organId, taskId: allocation.taskId }, businessTurnId, predecessor,
    ...(v1Receipts[0]?.commitId ? { originalV1ReceiptRef: v1Receipts[0].commitId } : {}),
    effect,
    effectPath: join(root, effect.relativePath), output, journal, acceptedEvidenceLocator,
    contextCommitRef, preparedJournal, completion, native, segmentJournal, taskId: allocation.taskId,
    initialOpenAnchor, fixtureKind,
  };
}

/**
 * The real production owners. `createDefaultExecutionComposition` binds the five
 * cold producer ports; the coordinator owns the actual assembly/pool/lifecycle
 * transfer and exposes the public `resumeExecution` selector.
 */
function resumeProviderPreparer(fixture: ColdFixture, upstreamBaseUrl: string, model: string,
  options: ResumeRuntimeOptions = {}) {
  const httpProvider: ProviderConfig = { source: 'http', provider: 'http', binding: 'cold-resume-binding',
    protocol: 'responses', model, route: 'cold-resume-route', baseUrl: upstreamBaseUrl };
  const entries: EffectiveAgentProviderBinding[] = [
    { agentId: 'cold-resume-agent', roleId: 'execution', source: 'agent', provider: httpProvider },
    // The post-close Planner selects the real configured `orchestration` role.
    // The same provider/model/route is reused; Planner independence comes from
    // the fresh pool incarnation and its own Provider driver, not a new model.
    { agentId: 'cold-resume-planner', roleId: 'orchestration', source: 'agent', provider: httpProvider }];
  return async (selection: { readonly roleId: 'execution' | 'orchestration' | 'interaction' | 'review' | 'memory';
    readonly configuredAgentId?: string }): Promise<AgentProviderComposition> => {
    options.beforeProvider?.(selection.roleId);
    return prepareAgentProvider({ roleId: selection.roleId,
      ...(selection.configuredAgentId === undefined ? {} : { configuredAgentId: selection.configuredAgentId }),
      agentProviderBindings: entries, legacyProvider: httpProvider, evidenceRoot: fixture.artifactsRoot });
  };
}

function resumeTaskAssembly(
  fixture: ColdFixture,
  assemblies: ResumeAssembly[],
  options: ResumeRuntimeOptions = {},
): NonNullable<UiRuntimeServiceOptions['runtimeComposition']>['createTaskAssembly'] {
  return ({ scope, executionAgent, maxAttempts }) => {
    const pool = new AgentRuntimePoolManager({ maxRuntimes: 4, ownerId: fixture.allocation.ownerId,
      factory: { async start(request) { return { runtimeId: request.runtimeId, generation: request.generation,
        capabilities: [...request.requiredCapabilities] }; }, async dispose() {} } });
    const orchestration = new OrchestrationManager({ ownerId: fixture.allocation.ownerId, runtimePool: pool,
      ...(executionAgent === undefined ? {} : { executionAgent: options.onExecutionInstance === undefined ? executionAgent : {
        ...executionAgent,
        createInstance(input: Parameters<typeof executionAgent.createInstance>[0]) {
          options.onExecutionInstance?.();
          return executionAgent.createInstance(input);
        },
      } }),
      reviewAgent: passingReviewAgent(scope), mergeCoordinator: mergeCoordinator(scope),
      maxAttempts: maxAttempts ?? 1 });
    const assembly = { orchestration, runtimePool: pool };
    assemblies.push(assembly);
    return assembly;
  };
}

function createResumeComposition(
  fixture: ColdFixture,
  upstreamBaseUrl: string,
  model: string,
  callbacks: ResumeCompositionCallbacks,
  options: ResumeRuntimeOptions = {},
) {
  const currentState = createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal });
  const composition = createDefaultExecutionComposition({
    principalOwner: fixture.principalOwner ?? fixture.allocation.ownerId,
    journal: fixture.journal,
    filePath: fixture.journalPath,
    artifactsRoot: fixture.artifactsRoot,
    preparedJournal: fixture.preparedJournal,
    resourceBoundary: createPreparedOperationBoundary(fixture.preparedJournal),
    prepareAgentProvider: resumeProviderPreparer(fixture, upstreamBaseUrl, model, options),
    providerOptions: options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds },
    ...(options.providerToolScope === undefined ? {} : { providerToolScope: options.providerToolScope }),
    now: () => new Date(at),
    currentState,
    publishCurrentTurnState: callbacks.publishCurrentTurnState,
    closedTurnPlannerPool: callbacks.closedTurnPlannerPool,
    taskIdentity: new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal)),
    i2Journal: createJsonlI2JournalPort({ filePath: fixture.journalPath, journal: fixture.journal }),
    retryJournal: createJsonlRetryCycleJournalPort({ filePath: fixture.retryPath }),
  });
  return { composition, currentState };
}

function buildResumeRuntime(fixture: ColdFixture, upstreamBaseUrl: string, model: string,
  options: ResumeRuntimeOptions = {}) {
  const now = () => new Date(at);
  let coordinator: RuntimeTaskCoordinator;
  const assemblies: ResumeAssembly[] = [];
  const { composition, currentState } = createResumeComposition(fixture, upstreamBaseUrl, model, {
    publishCurrentTurnState: (taskId) => coordinator.publishCurrentTurnState(taskId),
    closedTurnPlannerPool: (taskId) => coordinator.closedTurnPlannerPool(taskId),
  }, options);
  coordinator = new RuntimeTaskCoordinator({
    organId,
    checkpointStoreFor: () => new ServiceExecutionCheckpointStore(fixture.journalPath, fixture.journal, () => new Date(at)),
    publicOutputStoreFor: () => new ServiceExecutionCheckpointStore(fixture.journalPath, fixture.journal, now),
    attentionPort: attentionPort(),
    journal: fixture.preparedJournal,
    now,
    currentStatePort: currentState,
    currentStateFacts: composition.currentStateFacts,
    admitExecution: composition.admitExecution,
    createDriver: composition.createExecutionDriver,
    ...(options.omitAssemblyFactory ? {} : { createTaskAssembly: resumeTaskAssembly(fixture, assemblies, options) }),
    // The cold producer is the only new coordinator binding. The coordinator
    // owns the matching ColdExecutionLifecycleBinding internally.
    coldExecution: composition,
  });
  return { coordinator, composition, assemblies };
}

/**
 * Controlled fixture selector. This is the frozen production callback shape,
 * but the production composition binding that derives the same fact from the
 * canonical source owner remains pending. The selector reads only the real
 * committed segment chain and its exact recovery receipt.
 */
function controlledColdResumeSelector(fixture: ColdFixture): ColdResumeSelector {
  return async ({ taskId, operationId }) => {
    if (taskId.value !== fixture.taskId.value || operationId.value !== fixture.allocation.operationId.value) {
      throw new AppLifecycleError(
        'cold-execution.source-unavailable',
        'controlled selector received a task or operation outside the persisted fixture',
        'retain the recovery responsibility and resolve the exact physical owner source before resuming',
        'humanagent.app.cold-execution-source',
      );
    }
    const segments = await fixture.segmentJournal.readSegments(fixture.businessTurnId);
    const tailId = segments.at(-1)?.segmentId ?? fixture.businessTurnId;
    const receipt = await fixture.segmentJournal.readSegmentRecoveryReceipt(tailId);
    if (receipt.status === 'failed' || receipt.status === 'unknown') {
      if (receipt.status === 'unknown' && tailId === fixture.businessTurnId && fixture.initialOpenAnchor) {
        return {
          businessTurnId: fixture.businessTurnId,
          predecessor: { segmentId: tailId, initialOpen: fixture.initialOpenAnchor },
        };
      }
      throw new AppLifecycleError(
        'cold-execution.source-unavailable',
        receipt.reason,
        'retain the recovery responsibility and resolve the exact physical owner source before resuming',
        'humanagent.app.cold-execution-source',
      );
    }
    return {
      businessTurnId: fixture.businessTurnId,
      predecessor: receipt.status === 'exact'
        ? { segmentId: tailId, recoveryAssetsReceiptRef: receipt.recoveryAssetsReceiptRef }
        : receipt.status === 'interrupted'
          ? { segmentId: tailId, interrupted: receipt.anchor }
          : { segmentId: tailId, initialOpen: receipt.anchor },
    };
  };
}

/**
 * Actual in-process HTTP listener plus the actual UiRuntimeService route. The
 * only controlled edge is the canonical selector callback above.
 */
async function buildResumeService(
  fixture: ColdFixture,
  upstreamBaseUrl: string,
  model: string,
  selector: ColdResumeSelector | undefined,
  useCompositionSelector = false,
  productionMemory = false,
  memoryFault?: { publication: boolean; diagnostics: boolean; consume?: boolean },
  realMemory?: { readonly configToml: string; readonly calls: unknown[]; readonly beforeSubmit?: (input: AgentInput) => void },
  runtimeOptions: ResumeRuntimeOptions = {},
) {
  const assemblies: ResumeAssembly[] = [];
  let selectorCalls = 0;
  const paths = productionMemory ? await resolveRuntimePaths({ controlRoot: join(fixture.root, 'control'), workspace: fixture.root }) : undefined;
  if (paths) await ensureControlLayout(paths);
  if (paths && realMemory) await writeFile(join(paths.controlRoot, 'config.toml'), realMemory.configToml, 'utf8');
  const configuration = paths ? await loadConfiguration(paths) : undefined;
  const factory = paths && realMemory ? memoryDriverFactory({
    paths, configuration: configuration!, workspace: paths.workspaceCwd,
    prepareAgentProvider: (selection) => prepareAgentProvider({ ...selection,
      agentProviderBindings: configuration!.agentProviderBindings,
      legacyProvider: configuration!.effective.provider, evidenceRoot: fixture.artifactsRoot }),
  }) : undefined;
  if (realMemory) assert.ok(factory, 'the owned configuration must select a Memory driver');
  const driverFor: typeof factory = factory && realMemory ? async (request) => {
    const prepared = await factory(request);
    assert.ok('driver' in prepared, 'the provider factory must own release');
    if (!('driver' in prepared)) throw new Error('missing prepared Memory provider');
    const driver = prepared.driver;
    const calls = realMemory.calls;
    return { driver: {
      kind: driver.kind,
      capabilities: () => driver.capabilities(),
      resume: (input) => driver.resume(input),
      requestStop: (input) => driver.requestStop(input),
      start: async (input) => { const result = await driver.start(input); calls.push({ kind: 'start', input, result }); return result; },
      submit: async (input) => { realMemory.beforeSubmit?.(input); calls.push({ kind: 'request', input }); const result = await driver.submit(input); calls.push({ kind: 'output', result }); return result; },
      observe: async function* (input) {
        for await (const event of driver.observe(input)) { calls.push({ kind: 'event', event }); yield event; }
      },
      settle: async (input) => { const result = await driver.settle(input); calls.push({ kind: 'settle', input, result }); return result; },
    }, release: async () => { await prepared.release(); calls.push({ kind: 'release', request }); } };
  } : undefined;
  const memoryRuntime = paths ? await composeMemoryRuntime({
    paths, configuration: configuration!, workspaceCwd: paths.workspaceCwd,
    ...(driverFor === undefined ? {} : { driverFor }),
    sessionsRoot: paths.sessionsRoot, runNotesRoot: paths.runNotesRoot,
    auditPromptRoot: join(paths.controlRoot, 'memory-audit'), auditPromptRef: 'project-memory-audit', autoUpdate: realMemory ? false : true,
    checkpointEvidence: createJournalCheckpointEvidencePort({ filePath: fixture.journalPath }),
    binding: { bindingRef: 'memory:c3a', projectKey: paths.projectKey, executionEpoch: 1,
      scope: { namespace: 'project', projectKey: paths.projectKey, organId },
      interactionScopeId: `runtime:${paths.projectKey}`, mainAgentId: 'c3a-main',
      actor: { actorId: 'memory-agent', roleId: 'memory', permissions: ['memory.read', 'memory.propose'], projectKey: paths.projectKey } },
  }) : undefined;
  const memoryAnalyses: Array<Awaited<ReturnType<NonNullable<typeof memoryRuntime>['composition']['admission']['admit']>>> = [];
  if (memoryRuntime) {
    const admit = memoryRuntime.composition.admission.admit.bind(memoryRuntime.composition.admission);
    memoryRuntime.composition.admission.admit = async (input) => {
      const result = await admit(input);
      memoryAnalyses.push(result);
      return result;
    };
  }
  if (memoryRuntime && memoryFault) {
    const publishGroup = memoryRuntime.boundaryPublisher.publishRewindGroup.bind(memoryRuntime.boundaryPublisher);
    memoryRuntime.boundaryPublisher.publishRewindGroup = async (input) => {
      if (memoryFault.publication) throw new AppLifecycleError('memory-test-publication-failed',
        'original Memory storage rejection', 'restore Memory publication', 'c3a-memory-storage', new Error('original storage cause'));
      return publishGroup(input);
    };
    const consume = memoryRuntime.consume;
    (memoryRuntime as { consume: typeof consume }).consume = async (input) => {
      if (memoryFault.consume) throw new AppLifecycleError('memory-test-consume-failed',
        'original Memory consumer failure', 'restore Memory consumer', 'c3a-memory-storage', new Error('original consumer cause'));
      return consume(input);
    };
  }
  const attentionPath = join(paths?.journalRoot ?? fixture.root, 'memory-attention.jsonl');
  const memoryHooks = memoryRuntime && paths ? composeUiMemoryHooks({ memory: memoryRuntime,
    checkpointJournalPath: fixture.journalPath, attentionPort: createJsonlAttentionPort({ paths, filePath: attentionPath }),
    readAttentions: async () => {
      if (memoryFault?.diagnostics) throw new Error('original diagnostic storage rejection');
      return readJsonlAttentions({ filePath: attentionPath });
    } }) : undefined;
  const serviceOptions: UiRuntimeServiceOptions = {
    mode: 'rcc',
    organId,
    binding: serviceBinding,
    port: new FakeReplayExecutionRuntimePort({ binding: serviceBinding, stepDelayMs: 1 }),
    checkpointStoreFor: () => new ServiceExecutionCheckpointStore(fixture.journalPath, fixture.journal, () => new Date(at)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    journal: fixture.preparedJournal,
    closurePort: fixture.preparedJournal,
    memory: memoryRuntime ? { ...memoryRuntime.composition, projectKey: paths!.projectKey, ...memoryHooks } : testMemory('project-cold-resume-http'),
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    runtimeComposition: {
      createTaskAssembly: resumeTaskAssembly(fixture, assemblies, runtimeOptions),
      createExecutionPorts: (callbacks) => {
        const { composition, currentState } = createResumeComposition(fixture, upstreamBaseUrl, model, callbacks, runtimeOptions);
        const resolvedSelector = useCompositionSelector
          ? composition.resolveColdExecutionResumeRequest
          : selector;
        return {
          admitExecution: composition.admitExecution,
          createDriver: composition.createExecutionDriver,
          coldExecution: {
            readColdExecutionSource: composition.readColdExecutionSource,
            admitSegment: composition.admitSegment,
            readIncarnationBinding: composition.readIncarnationBinding,
            recoverOriginalTurn: composition.recoverOriginalTurn,
            createResumedExecutionDriver: composition.createResumedExecutionDriver,
          },
          currentStatePort: currentState,
          currentStateFacts: composition.currentStateFacts,
          ...(resolvedSelector === undefined ? {} : {
            resolveColdExecutionResumeRequest: async (input: { readonly taskId: TaskId; readonly operationId: OperationId }) => {
              selectorCalls += 1;
              return await resolvedSelector(input);
            },
          }),
          executeConfirmedTaskContextCorrection: composition.executeConfirmedTaskContextCorrection,
          executeConfirmedTaskCheckpointReentry: composition.executeConfirmedTaskCheckpointReentry,
        };
      },
    },
  };
  const accessControl = await AccessControlService.open({
    credentialPath: join(fixture.root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = accessControl.createPairingChallenge('cold-resume-http', 1);
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
  const launchProvider: ProviderConfig = { source: 'http', provider: 'http', binding: 'cold-resume-binding',
    protocol: 'responses', model, route: 'cold-resume-route', baseUrl: upstreamBaseUrl };
  const launchBindings: EffectiveAgentProviderBinding[] = [
    { agentId: 'cold-resume-agent', roleId: 'execution', source: 'agent', provider: launchProvider },
    { agentId: 'cold-resume-planner', roleId: 'orchestration', source: 'agent', provider: launchProvider },
  ];
  const launched = productionMemory ? await startUiRuntime({
    mode: 'rcc', organId, binding: serviceBinding, port: serviceOptions.port,
    checkpointRoot: fixture.root, evidenceRoot: fixture.artifactsRoot, uiRoot: join(fixture.root, 'ui'),
    portNumber: 0, host: '127.0.0.1', accessControl, memory: serviceOptions.memory,
    runtimePaths: paths,
    explicitBrainInterpreter: unusedExplicitBrainInterpreter, runtimeComposition: {
      createTaskAssembly: serviceOptions.runtimeComposition!.createTaskAssembly,
      prepareAgentProvider: (selection) => prepareAgentProvider({ roleId: selection.roleId,
        agentProviderBindings: launchBindings, legacyProvider: launchProvider, evidenceRoot: fixture.artifactsRoot }),
      prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({ roleId: selection.roleId,
        agentProviderBindings: launchBindings, legacyProvider: launchProvider,
        createPort: (selected) => createAgentProviderPort(selected, fixture.artifactsRoot) }, owner, lease),
    },
    now: () => new Date(at),
  }) : undefined;
  const service = launched?.service ?? new UiRuntimeService(serviceOptions);
  const dispatcher = createUiRuntimeRequestDispatcher({
    service,
    accessControl,
    uiRoot: join(fixture.root, 'ui'),
    isClosing: () => false,
  });
  const server = createServer(dispatcher.listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('cold-resume HTTP fixture did not bind a socket');
  return {
    service,
    accessControl,
    server,
    url: `http://127.0.0.1:${address.port}`,
    cookie,
    assemblies,
    memoryRuntime,
    memoryAnalyses,
    memoryHooks,
    attentionPath,
    selectorCallCount: () => selectorCalls,
    close: async () => {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await accessControl.closeCredentialWatch().catch(() => undefined);
      await launched?.close();
      for (const assembly of assemblies) await assembly.runtimePool.dispose();
    },
  };
}

async function postResume(
  url: string,
  cookie: string,
  taskId: string,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${url}/api/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as unknown };
}

/**
 * Extends the same legal fixture through the real segment APIs: one opened v2
 * segment with accepted requests, a matching epoch-2 context and coverage, and
 * deliberately no v2 capture. This is the accepted F13 interrupted-v2 state,
 * not a reader-only classification.
 */
async function buildInterruptedColdFixture(name: string): Promise<InterruptedColdFixture> {
  const fixture = await buildColdFixture(name);
  const currentState = createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal });
  const admissionComposition = createDefaultExecutionComposition({
    principalOwner: fixture.allocation.ownerId,
    journal: fixture.journal,
    filePath: fixture.journalPath,
    artifactsRoot: fixture.artifactsRoot,
    preparedJournal: fixture.preparedJournal,
    resourceBoundary: createPreparedOperationBoundary(fixture.preparedJournal),
    prepareAgentProvider: async () => {
      throw new Error('the interrupted fixture admission path must not prepare a Provider');
    },
    providerOptions: {},
    now: () => new Date(at),
    currentState,
    publishCurrentTurnState: async () => undefined,
    closedTurnPlannerPool: () => {
      throw new Error('the interrupted fixture admission path must not read the planner pool');
    },
    taskIdentity: new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal)),
    i2Journal: createJsonlI2JournalPort({ filePath: fixture.journalPath, journal: fixture.journal }),
    retryJournal: createJsonlRetryCycleJournalPort({ filePath: fixture.retryPath }),
  });
  const initial = await fixture.segmentJournal.readInitialSegmentSource(fixture.businessTurnId);
  if (initial === null || initial.kind !== 'captured') {
    throw new Error('the interrupted fixture has no original v1 capture');
  }
  const segmentId = 'interrupted-v2';
  const requestId = 'interrupted-v2-request';
  const incarnation: TaskRuntimeIncarnation = {
    runtimeId: fixture.allocation.runtimeId,
    generation: 2,
    agentInstanceId: 'cold-resume-agent-2',
    roleId: 'execution',
    taskId: fixture.taskId,
    assignmentId: fixture.assignment.assignmentId,
    executionEpoch: 2,
  };
  const resumed = await resumeActiveTurnSegment({
    businessTurnId: fixture.businessTurnId,
    segmentId,
    assignment: fixture.assignment,
    scope: initial.body.binding.scope,
    incarnation,
    ports: { read: fixture.segmentJournal, append: fixture.segmentJournal },
    admit: admissionComposition.admitSegment,
  });
  if (resumed.status !== 'resumed') {
    throw new Error(`the interrupted fixture could not open v2: ${resumed.status}`);
  }
  const segment = await ActiveTurnSegmentContext.open({
    segment: resumed.segment,
    initialInput: initial.body.initialInput,
    port: fixture.segmentJournal,
  });
  await segment.registerRequest({
    request: { turnId: fixture.businessTurnId, requestId },
    scope: initial.body.binding.scope,
    phase: 'dispatching',
  });
  await segment.registerRequest({
    request: { turnId: fixture.businessTurnId, requestId },
    scope: initial.body.binding.scope,
    phase: 'dispatched',
  });
  const history = createJsonlContextHistoryPort({ filePath: fixture.journalPath, journal: fixture.journal });
  const epochOne = await history.readContextCommit(initial.body.binding.scope, fixture.contextCommitRef);
  const epochTwoBase = contextRecord(initial.body.binding.scope, fixture.allocation.runtimeId, 2);
  const epochTwo: ContextHistoryRecord = {
    ...epochTwoBase,
    previousContextCommitRef: fixture.contextCommitRef,
    loopCheckpoint: {
      ...epochTwoBase.loopCheckpoint,
      predecessor: {
        checkpointId: epochOne.loopCheckpoint.checkpointId,
        digest: epochOne.loopCheckpoint.digest,
      },
    },
  };
  await produceContextHistory(history, { record: epochTwo, expectedCurrentContextCommitRef: fixture.contextCommitRef });
  await createJsonlOperationControlJournal({ journal: fixture.journal }).initializeCoverage({
    scope: initial.body.binding.scope,
    agentRuntimeId: fixture.allocation.runtimeId,
    harnessExecutionEpoch: 2,
    admissionCommitRef: resumed.segment.businessRegistrationCommitRef,
  });
  const receipt = await fixture.segmentJournal.readSegmentRecoveryReceipt(segmentId);
  if (receipt.status !== 'interrupted') {
    throw new Error(`the interrupted fixture v2 did not classify as interrupted: ${receipt.status}`);
  }
  return {
    ...fixture,
    interruptedSegmentId: segmentId,
    interruptedRequestId: requestId,
    interruptedPredecessor: { segmentId, interrupted: receipt.anchor },
  };
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
      subjectRefs: [...input.reviewAssignment.subjectRefs],
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

function knownCurrent(records: readonly JournalRecord[], taskScope: ScopeRef) {
  const current = readCurrentFromRecords(records, taskScope);
  if (current.state !== 'known') throw new Error(current.reason);
  return current;
}

function wireText(body: string): readonly string[] {
  return (parseResponsesWire(body)?.input ?? []).flatMap((item) =>
    (item.content ?? []).flatMap((part) => part.type === 'input_text' && typeof part.text === 'string'
      ? [part.text] : []));
}

async function waitForTaskTerminal(
  service: UiRuntimeService,
  taskId: TaskId,
  fixture: ColdFixture,
  operationId: OperationId,
  afterEventId?: string,
): Promise<{ readonly state: string; readonly currentState: string }> {
  let subscription: ReturnType<UiRuntimeService['subscribeReplay']> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onEvent: Parameters<UiRuntimeService['subscribeReplay']>[2] = (event) => {
        if (event.kind !== 'execution.terminal' || event.terminalPhase !== 'final') return;
        try {
          // Live events follow append; immediate replay must prove the same
          // durable fact before this fixture can close or remove its root.
          assert.ok(fixture.preparedJournal.replay().some((record) => record.kind === 'operation.event'
            && record.operationId.value === operationId.value
            && record.event.eventId === event.eventId
            && record.event.kind === 'execution.terminal' && record.event.terminalPhase === 'final'),
          'the next execution final terminal must be persisted before cleanup');
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      subscription = service.subscribeReplay(operationId, afterEventId, onEvent);
      subscription.replay.forEach(onEvent);
    });
  } finally {
    subscription?.unsubscribe();
  }
  const projection = service.listTasks();
  const rows = [...projection.running, ...projection.waiting, ...projection.completed,
    ...projection.stopped, ...projection.failed, ...projection.draft];
  const row = rows.find((candidate) => candidate.taskId.value === taskId.value);
  if (row === undefined) throw new Error('the completed execution must retain its task projection');
  return { state: row.state, currentState: row.currentState };
}

async function archiveC3aReceipts(
  fixture: ColdFixture,
  http: Upstream,
  receipt: Readonly<Record<string, unknown>>,
): Promise<string> {
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const archiveRoot = await mkdtemp(join(EVIDENCE_ROOT, 'c3a-next-turn-'));
  await writeFile(join(archiveRoot, 'upstream-wires.json'), JSON.stringify(http.wires, null, 2), 'utf8');
  await writeFile(join(archiveRoot, 'upstream-errors.json'), JSON.stringify(http.errors, null, 2), 'utf8');
  await writeFile(join(archiveRoot, 'organ-journal.jsonl'), await readFile(fixture.journalPath, 'utf8'), 'utf8');
  await writeFile(join(archiveRoot, 'prepared.jsonl'), await readFile(fixture.preparedPath, 'utf8'), 'utf8');
  await writeFile(join(archiveRoot, 'receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');
  return archiveRoot;
}

async function assertRealMemoryAudit(
  fixture: ColdFixture,
  app: { readonly memoryAnalyses: Awaited<ReturnType<typeof buildResumeService>>['memoryAnalyses'];
    readonly memoryRuntime?: Pick<NonNullable<Awaited<ReturnType<typeof buildResumeService>>['memoryRuntime']>, 'reviewState'> },
  calls: readonly unknown[],
) {
  const paths = await resolveRuntimePaths({ controlRoot: join(fixture.root, 'control'), workspace: fixture.root });
  const filePath = join(paths.journalRoot, 'events.jsonl');
  const cold = createJsonlEventJournal({ filePath });
  const records = (await new JsonlOrganJournal(filePath).verify()).records;
  const snapshot = await new RootedMemoryPersistence({ project: join(paths.memoryRoot, 'project'),
    global: paths.globalMemoryRoot }).load();
  const boundaries = await cold.readEvents({ streamId: `memory-boundaries:task:${fixture.taskId.value}`,
    afterSequence: 0, limit: 100 });
  const feedback = await cold.readEvents({ streamId: `memory-feedback:${fixture.taskId.value}`,
    afterSequence: 0, limit: 100 });
  const observed = calls as Array<{ kind: string; input?: AgentInput & { runtimeId?: string; operationId?: OperationId };
    result?: { state?: string }; request?: { operationId?: OperationId };
    event?: { kind: string; runtimeId?: string; terminalState?: string } }>;
  const requests = observed.filter((call) => call.kind === 'request');
  assert.equal(requests.length, boundaries.length);
  assert.equal(feedback.length, requests.length);
  const review = await app.memoryRuntime!.reviewState();
  assert.equal(review.analysis.mode, 'model');
  assert.equal(review.analysis.state, 'succeeded');
  assert.equal(review.autoUpdate, false);
  const receipts = [];
  const operations = [];
  for (const boundary of boundaries) {
    const consumerKey = `memory-binding:${fixture.taskId.value}`;
    const operationRef = `memory-analysis:${consumerKey}:${boundary.messageId}`;
    const receipt = await cold.readReceipt({ consumerKey, messageId: boundary.messageId });
    assert.equal(receipt?.disposition, 'applied');
    receipts.push(receipt);
    const operation = await cold.readExternalOperation({ consumerKey, messageId: boundary.messageId, operationRef });
    // The normal task consumer commits atomically in the Journal. Only the
    // external-barrier path has a separate external-operation record.
    if (operation) assert.ok(operation.state === 'settled' || operation.state === 'reconciled');
    operations.push(operation);
    const sourceRefs = boundary.evidenceRefs.map((ref) => ref.locator);
    const request = requests.find((call) => canonicalJsonStringify(call.input?.payload['sourceRefs'])
      === canonicalJsonStringify(sourceRefs))?.input;
    assert.ok(request, 'the boundary must bind its own actual provider request');
    if (!request) throw new Error('missing operation request');
    const analysisId = request.assignmentId.slice('memory-analysis:'.length);
    assert.ok(receipt?.effectRefs.includes(`memory-analysis-request:${analysisId}`));
    assert.ok(receipt?.effectRefs.includes(`memory-analysis:${analysisId}`));
    const actual = app.memoryAnalyses.find((analysis) => analysis.status === 'ready'
      && analysis.value.result?.curation.operationId.value === analysisId);
    assert.ok(actual?.status === 'ready' && actual.value.result, JSON.stringify(app.memoryAnalyses));
    if (actual?.status !== 'ready' || !actual.value.result) throw new Error('missing actual curation');
    const curation = actual.value.result.curation;
    const persisted = feedback.find((event) => event.payload?.['analysisRef'] === analysisId);
    assert.ok(persisted, 'a fresh JSONL reader must recover the actual curation');
    if (!persisted?.payload) throw new Error('missing durable feedback payload');
    assert.equal(persisted.payload['outcome'], curation.outcome);
    assert.equal(persisted.payload['explanation'], curation.explanation);
    assert.ok(curation.explanation.trim().length > 0);
    assert.deepEqual(persisted.payload['sourceRefs'], [...curation.sourceRefs]);
    const payload = request.payload as { sourceRefs: string[]; analysisInputs: unknown };
    assert.deepEqual(curation.sourceRefs, payload.sourceRefs);
    assert.deepEqual(payload.analysisInputs, boundary.payload?.['analysisInputs']);
    assert.ok(curation.nextAction.length > 0);
    assert.ok(observed.some((call) => call.kind === 'event'
      && call.event?.runtimeId === request.assignmentId
      && (call.event.kind === 'terminal' || call.event.kind.endsWith('.terminal'))
      && call.event.terminalState === 'succeeded'), 'each request needs its own successful terminal');
    assert.ok(observed.some((call) => call.kind === 'settle'
      && call.input?.runtimeId === request.assignmentId && call.result?.state === 'succeeded'));
    assert.ok(observed.some((call) => call.kind === 'release' && call.request?.operationId?.value === analysisId));
    if (curation.outcome === 'candidate') {
      const candidate = review.candidates.find((entry) => entry.candidateId === curation.candidateId);
      assert.ok(candidate);
      if (!candidate) throw new Error('missing durable candidate');
      assert.equal(candidate.state, 'candidate');
      assert.equal(candidate.namespace, 'project');
      assert.equal(candidate.projectKey, paths.projectKey);
      assert.equal(candidate.taskId, fixture.taskId.value);
      assert.deepEqual(candidate.sourceRefs, [curation.sourceRefs[0]]);
      assert.ok(curation.sourceRefs.every((ref) => candidate.evidenceRefs.includes(ref)));
      assert.ok(candidate.evidenceRefs.length > 0);
      const durable = snapshot?.candidates.find((entry) => entry.candidateId === candidate.candidateId);
      assert.ok(durable, 'a fresh persistence owner must recover the candidate');
      if (!durable) throw new Error('candidate was not persisted');
      assert.equal(durable.state, 'candidate');
      assert.equal(durable.submission.projectKey, paths.projectKey);
      assert.equal(durable.submission.taskId?.value, fixture.taskId.value);
      assert.equal(durable.submission.operationId?.value, analysisId);
      assert.deepEqual(durable.submission.evidenceRefs, candidate.evidenceRefs);
    }
  }
  assert.equal(observed.filter((call) => call.kind === 'start').length, requests.length);
  assert.equal(observed.filter((call) => call.kind === 'release').length, requests.length);
  assert.equal(await readFile(join(fixture.root, 'AGENTS.md'), 'utf8'), '# C3a project memory\n');
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  await writeFile(join(EVIDENCE_ROOT, `memory-events-${fixture.taskId.value}.jsonl`), await readFile(filePath, 'utf8'), 'utf8');
  return { boundaries, feedback, receipts, operations, snapshot, records };
}

/**
 * Runs the accepted confirmed-control sequence and starts one real next
 * execution. All targets are exact committed checkpoint receipts. The current
 * Task goal/directive and retained duties are compared across the controls;
 * no Task state is restored from the rewind target.
 */
async function runC3aControlChain(
  service: UiRuntimeService,
  fixture: ColdFixture,
  http: Upstream,
): Promise<{
  readonly correction: Awaited<ReturnType<UiRuntimeService['executeConfirmedTaskContextCorrection']>>;
  readonly rewind: Awaited<ReturnType<UiRuntimeService['executeConfirmedTaskCheckpointReentry']>>;
  readonly forward: Awaited<ReturnType<UiRuntimeService['executeConfirmedTaskCheckpointReentry']>>;
  readonly controlFloor: number;
  readonly resumedPositionEpoch: number;
}> {
  const taskScope: ScopeRef = { organId, taskId: fixture.taskId };
  const checkpoints = createJsonlCheckpointJournal({ filePath: fixture.journalPath, journal: fixture.journal });
  const originalPosition = await checkpoints.readExecutionPosition(taskScope);
  if (originalPosition === null) throw new Error('the fixture has no original execution position');
  const release = await service.resumeExecution(fixture.taskId, { operationId: fixture.allocation.operationId });
  assert.equal(release.state, 'released');
  const resumedPosition = await checkpoints.readExecutionPosition(taskScope);
  if (resumedPosition === null) throw new Error('the standard tail has no committed execution position');
  assert.equal(resumedPosition.executionEpoch, originalPosition.executionEpoch + 1);

  const currentAfterResume = knownCurrent((await fixture.journal.verify()).records, taskScope);
  assert.ok(currentAfterResume.context.contextView.activeRefs.includes(c3aWrongRef));
  assert.ok(currentAfterResume.context.contextView.activeRefs.includes(c3aAcceptedRef));

  const correctionTaskScope = { organId: taskScope.organId, taskId: fixture.taskId };
  const correction = await service.executeConfirmedTaskContextCorrection({
    taskScope,
    commandId: 'c3a-hot-correction',
    wrongRefs: [{ taskScope: correctionTaskScope, ref: c3aWrongRef }],
    repairText: 'remove the confirmed wrong business ref and retain the accepted conclusion',
    confirmationRef: 'c3a-hot-correction-confirmation',
  });
  assert.equal(correction.record.newExecutionEpoch, resumedPosition.executionEpoch + 1);
  assert.deepEqual(correction.record.currentTask, currentAfterResume.task);
  assert.deepEqual(correction.record.retainedDuties, currentAfterResume.retainedDuties);
  assert.ok(!correction.record.correctedContext.contextView.activeRefs.includes(c3aWrongRef));
  assert.ok(correction.record.correctedContext.contextView.activeRefs.includes(c3aAcceptedRef));
  assert.ok(correction.record.correctedContext.contextView.omittedRefs.includes(c3aWrongRef));

  const rewind = await service.executeConfirmedTaskCheckpointReentry({
    taskScope,
    commandId: 'c3a-hot-rewind',
    targetCheckpointCommitRef: originalPosition.checkpointCommitRef,
    confirmationRef: 'c3a-hot-rewind-confirmation',
  });
  assert.equal(rewind.record.newExecutionEpoch, correction.record.newExecutionEpoch + 1);
  assert.deepEqual(rewind.record.currentTask, currentAfterResume.task);
  assert.deepEqual(rewind.record.retainedDuties, currentAfterResume.retainedDuties);
  assert.ok(!rewind.record.restoredContext.contextView.activeRefs.includes(c3aWrongRef));
  assert.ok(rewind.record.restoredContext.contextView.activeRefs.includes(c3aAcceptedRef));

  const forward = await service.executeConfirmedTaskCheckpointReentry({
    taskScope,
    commandId: 'c3a-hot-forward',
    targetCheckpointCommitRef: resumedPosition.checkpointCommitRef,
    confirmationRef: 'c3a-hot-forward-confirmation',
  });
  assert.equal(forward.record.newExecutionEpoch, rewind.record.newExecutionEpoch + 1);
  assert.deepEqual(forward.record.currentTask, currentAfterResume.task);
  assert.deepEqual(forward.record.retainedDuties, currentAfterResume.retainedDuties);
  assert.deepEqual(forward.record.restoredContext.contextView.activeRefs,
    correction.record.correctedContext.contextView.activeRefs);
  assert.ok(forward.record.restoredContext.contextView.omittedRefs.includes(c3aWrongRef));
  assert.ok(forward.record.restoredContext.contextView.omittedRefs.includes(c3aOmittedRef));

  const floorPosition = await checkpoints.readExecutionPosition(taskScope);
  assert.equal(floorPosition?.executionEpoch, forward.record.newExecutionEpoch);
  return { correction, rewind, forward, controlFloor: forward.record.newExecutionEpoch,
    resumedPositionEpoch: resumedPosition.executionEpoch };
}

async function runC3aHotChain(service: UiRuntimeService, fixture: ColdFixture, http: Upstream) {
  const controls = await runC3aControlChain(service, fixture, http);
  const next = await runNextExecutionAssertions(service, fixture, http, controls.controlFloor,
    controls.forward.record.restoredContext);
  return { ...controls, next };
}

async function c3aMemoryEvidence(app: Awaited<ReturnType<typeof buildResumeService>>, fixture: ColdFixture,
  requireNewAnalysis = true) {
  const memory = app.memoryRuntime!;
  const events = await memory.journal.readEvents({ streamId: `memory-boundaries:task:${fixture.taskId.value}`, afterSequence: 0, limit: 100 });
  const groups = events.filter((event) => event.messageId.startsWith('rewind-group-'));
  assert.equal(groups.length, 1, 'production hook must publish one actual committed group');
  const group = groups[0]!;
  assert.deepEqual(group.scope, { organId, taskId: fixture.taskId }, 'the group must publish one common Task scope');
  assert.equal(group.scope.cycleId, undefined, 'the group scope must not pin a committed cycle');
  assert.equal(group.scope.operationId, undefined, 'the group scope must not pin a committed operation');
  const originalScope = fixture.allocation.scope;
  assert.ok(group.evidenceRefs.some((evidence) =>
    canonicalJsonStringify(evidence.scope) === canonicalJsonStringify(originalScope)),
  'the group must retain the original checkpoint execution scope');
  const primary = group.evidenceRefs.find((evidence) =>
    evidence.evidenceId.value.startsWith('rewind-group-primary-checkpoint-'));
  if (primary === undefined) throw new Error('the group must retain its recovery checkpoint evidence');
  const receiptSeq = Number(/checkpoint-receipt\/(\d+)\//.exec(primary.locator)?.[1]);
  const recoveryRecord = (await fixture.journal.verify()).records
    .find((record) => record.kind === 'checkpoint' && record.seq === receiptSeq);
  if (recoveryRecord?.checkpoint === undefined) throw new Error('the recovery evidence must bind one committed receipt');
  assert.deepEqual(primary.scope, recoveryRecord.checkpoint.scope, 'the recovery evidence must keep its own execution scope');
  assert.ok(primary.scope.cycleId !== undefined && primary.scope.operationId !== undefined,
    'the recovery evidence must keep its committed cycle and operation');
  const receipts = await Promise.all(groups.map((event) => memory.journal.readReceipt({
    consumerKey: `memory-binding:${fixture.taskId.value}`, messageId: event.messageId })));
  assert.ok(receipts.every((receipt) => receipt?.disposition === 'applied'), JSON.stringify(receipts));
  const payload = groups[0]!.payload as { readonly analysisInputs?: { readonly corrections: readonly unknown[]; readonly rewindChains: readonly unknown[] } };
  assert.equal(payload.analysisInputs?.corrections.length, 3, JSON.stringify(payload));
  assert.equal(payload.analysisInputs?.rewindChains.length, 3, JSON.stringify(payload));
  if (requireNewAnalysis) {
    assert.ok(app.memoryAnalyses.some((outcome) => outcome.status === 'ready'
      && outcome.value.result?.curation !== undefined), JSON.stringify(app.memoryAnalyses));
  }
  const review = await app.memoryHooks!.reviewState!();
  assert.equal(review.analysis.mode, 'deterministic');
  assert.equal(review.autoUpdate, true);
  assert.ok(review.candidates.every((candidate) => candidate.state === 'candidate'));
  assert.equal(await readFile(join(fixture.root, 'AGENTS.md'), 'utf8'), '# C3a project memory\n', 'Memory must not automatically apply candidates');
  return { events, receipts, review, analyses: app.memoryAnalyses };
}

async function c3aHttpMemorySummary(app: Awaited<ReturnType<typeof buildResumeService>>) {
  const response = await fetch(`${app.url}/api/memory/summary`, { headers: { cookie: app.cookie } });
  assert.equal(response.status, 200);
  return await response.json() as { readonly data: { readonly state: string; readonly detail?: string }; readonly summary: string };
}

async function runC3aProcess(): Promise<void> {
  const seeding = processMode === 'c3a-seed';
  if (!seeding && (processRoot === undefined || processTask === undefined)) {
    throw new Error('the C3a next child requires the durable root and task');
  }
  const fixture = seeding
    ? await buildColdFixture('c3a-fresh', ['original-output'], ['original-target'], false, undefined, c3aContextSeed)
    : await reopenColdFixture(processRoot!, processTask!);
  const http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture);
  let app: Awaited<ReturnType<typeof buildResumeService>> | undefined;
  let archiveRoot: string | undefined;
  try {
    app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined, true, true,
      seeding ? { publication: true, diagnostics: false } : undefined);
    if (seeding) {
      const controls = await runC3aControlChain(app.service, fixture, http);
      const recovery = await runNextExecutionAssertions(app.service, fixture, http, controls.controlFloor, controls.forward.record.restoredContext);
      const missing = await app.memoryRuntime!.journal.readEvents({ streamId: `memory-boundaries:task:${fixture.taskId.value}`, afterSequence: 0, limit: 100 });
      assert.equal(missing.filter((event) => event.messageId.startsWith('rewind-group-')).length, 0);
      const summary = await c3aHttpMemorySummary(app);
      assert.equal(summary.data.state, 'degraded');
      assert.match(summary.data.detail!, /memory-test-publication-failed.*original Memory storage rejection/);
      archiveRoot = await archiveC3aReceipts(fixture, http, { mode: processMode, pid: process.pid,
        controlFloor: controls.controlFloor, resumedPositionEpoch: controls.resumedPositionEpoch,
        correction: controls.correction.record, rewind: controls.rewind.record, forward: controls.forward.record, recovery, summary,
        attentions: await readJsonlAttentions({ filePath: app.attentionPath }) });
    } else {
      const startupSummary = await c3aHttpMemorySummary(app);
      const startupAttentions = await readJsonlAttentions({ filePath: app.attentionPath });
      const startupEvents = await app.memoryRuntime!.journal.readEvents({ streamId: `memory-boundaries:task:${fixture.taskId.value}`, afterSequence: 0, limit: 100 });
      const effectsBeforeReopen = effectRecordCount((await fixture.journal.verify()).records, fixture.effect.effectId);
      await app.close();
      app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined, true, true);
      const reopenedEvents = await app.memoryRuntime!.journal.readEvents({ streamId: `memory-boundaries:task:${fixture.taskId.value}`, afterSequence: 0, limit: 100 });
      assert.deepEqual(reopenedEvents, startupEvents);
      assert.deepEqual(await readJsonlAttentions({ filePath: app.attentionPath }), startupAttentions);
      assert.equal(app.memoryAnalyses.length, 0, 'startup must not repeat applied analysis');
      assert.equal(effectRecordCount((await fixture.journal.verify()).records, fixture.effect.effectId), effectsBeforeReopen);
      const records = (await fixture.journal.verify()).records;
      const taskScope: ScopeRef = { organId, taskId: fixture.taskId };
      const position = await createJsonlCheckpointJournal({ filePath: fixture.journalPath, journal: fixture.journal })
        .readExecutionPosition(taskScope);
      assert.equal(position?.executionEpoch, 6, 'fresh hydrate must read the actual recovered execution floor');
      const current = knownCurrent(records, taskScope);
      assert.ok(current.context.contextView.activeRefs.includes(c3aAcceptedRef));
      assert.ok(!current.context.contextView.activeRefs.includes(c3aWrongRef));
      assert.ok(current.context.contextView.omittedRefs.includes(c3aWrongRef));
      assert.ok(current.context.contextView.omittedRefs.includes(c3aOmittedRef));
      assert.equal(http.wires.length, 0, 'hydrate must not send a Provider request');
      const next = await runNextExecutionAssertions(app.service, fixture, http, position!.executionEpoch, current.context,
        'delivered the next execution result');
      archiveRoot = await archiveC3aReceipts(fixture, http, { mode: processMode, pid: process.pid,
        controlFloor: position!.executionEpoch, currentTask: current.task, retainedDuties: current.retainedDuties,
        activeRefs: current.context.contextView.activeRefs, omittedRefs: current.context.contextView.omittedRefs, next,
        startupEvents, reopenedEvents, startupSummary, startupAttentions, summary: await c3aHttpMemorySummary(app) });
      await c3aMemoryEvidence(app, fixture, false);
      assert.ok(startupAttentions.some((attention) => attention.state === 'resolved' && attention.message.includes('memory-test-publication-failed')));
    }
  } catch (error) {
    await archiveC3aReceipts(fixture, http, { mode: processMode, pid: process.pid,
      root: fixture.root, failure: String(error) });
    throw error;
  } finally {
    try {
      if (app !== undefined) await app.close();
    } finally {
      await http.close();
    }
  }
  emitReceipt({ phase: seeding ? 'c3a-seed' : 'c3a-next', pid: process.pid, ppid: processPpid,
    root: fixture.root, taskId: fixture.taskId.value, archiveRoot });
}

/**
 * Starts the next execution only after the caller has established the durable
 * control floor. The assertions bind the new root context, request, closure and
 * parent control envelope to the actual allocation returned by startExecution.
 */
async function runNextExecutionAssertions(
  service: UiRuntimeService,
  fixture: ColdFixture,
  http: Upstream,
  expectedFloor: number,
  expectedContext: ContextHistoryRecord,
  expectedCheckpointSemantic = 'C3A prior-v2 resumed semantic marker',
  contextRefs = { accepted: c3aAcceptedRef, wrong: c3aWrongRef },
): Promise<{
  readonly operationId: string;
  readonly executionEpoch: number;
  readonly rootCommitId: string;
  readonly requestId: string;
  readonly closureCommitId: string;
  readonly parentControlCommitId: string;
  readonly plannerStage: 'returned';
  readonly publicationText: string;
}> {
  const taskScope: ScopeRef = { organId, taskId: fixture.taskId };
  const checkpoints = createJsonlCheckpointJournal({ filePath: fixture.journalPath, journal: fixture.journal });
  const before = await checkpoints.readExecutionPosition(taskScope);
  assert.equal(before?.executionEpoch, expectedFloor, 'the next start must see the committed control floor');
  const beforeRecords = (await fixture.journal.verify()).records;
  const preExistingRequestIds = new Set(beforeRecords.flatMap((record) => {
    if (record.kind !== 'event' || record.payload?.['type'] !== 'active-turn.record') return [];
    const activeRecord = record.payload['record'] as {
      readonly kind?: string;
      readonly record?: { readonly request?: { readonly requestId?: string } };
    } | undefined;
    return activeRecord?.kind === 'request' && activeRecord.record?.request?.requestId !== undefined
      ? [activeRecord.record.request.requestId]
      : [];
  }));
  const wireOffset = http.wires.length;
  const effectBefore = await readFile(fixture.effectPath, 'utf8');
  const effectsBefore = effectRecordCount((await fixture.journal.verify()).records, fixture.effect.effectId);
  http.useNextDelivery();
  const started = await service.startExecution(fixture.taskId, { prompt: 'next turn input' });
  assert.ok(started.operationId.value !== fixture.allocation.operationId.value,
    'the next execution must allocate a new operation');
  assert.equal(started.executionEpoch, expectedFloor + 1,
    'the new allocation must be strictly above the last committed control floor');
  const terminal = await waitForTaskTerminal(service, fixture.taskId, fixture, started.operationId);
  assert.equal(terminal.state, 'succeeded', `the next execution must close successfully: ${terminal.currentState}`);

  const prepared = fixture.preparedJournal.replay().find((record) =>
    record.kind === 'operation.prepared' && record.allocation.operationId.value === started.operationId.value);
  if (prepared?.kind !== 'operation.prepared') throw new Error('the next allocation is not durable in prepared.jsonl');
  const allocation = prepared.allocation;
  assert.equal(allocation.executionEpoch, started.executionEpoch);
  const records = (await fixture.journal.verify()).records;

  const bindingRecord = records.flatMap((record) => {
    if (record.kind !== 'event' || record.payload?.['type'] !== 'active-turn.record') return [];
    const value = record.payload['record'] as { readonly kind?: string;
      readonly binding?: { readonly scope?: ScopeRef; readonly admittedTurn?: { readonly turnId?: string } } } | undefined;
    if (value?.kind !== 'binding-opened' || value.binding?.scope?.operationId?.value !== started.operationId.value) return [];
    return value.binding.admittedTurn?.turnId === undefined ? [] : [{
      turnId: value.binding.admittedTurn.turnId,
      scope: value.binding.scope,
    }];
  });
  assert.equal(bindingRecord.length, 1, 'the next execution must own exactly one admitted turn binding');
  const nextTurnId = bindingRecord[0]!.turnId;
  const activeRecords = decodeActiveTurnRecords(records, nextTurnId);
  const requestRecords = activeRecords.filter((record) => record.kind === 'request');
  assert.ok(requestRecords.length > 0, 'the next execution must commit a real admitted request');
  const registeredRequestIds = [...new Set(requestRecords.map((record) =>
    record.kind === 'request' ? record.record.request.requestId : ''))];
  const rootRequests = requestRecords.filter((record) =>
    record.kind === 'request' && record.record.request.parentRequestId === undefined);
  assert.equal(rootRequests.length > 0, true, 'the next execution must commit a real admitted root request');
  const rootRequestIds = [...new Set(rootRequests.map((record) =>
    record.kind === 'request' ? record.record.request.requestId : ''))];
  assert.equal(rootRequestIds.length, 1, 'the next execution must commit exactly one root request');
  const requestId = rootRequestIds[0]!;
  const nextProviderTurnId = rootRequests[0]!.record.request.turnId;
  assert.ok(requestRecords.every((record) => record.record.request.turnId === nextProviderTurnId),
    'the root and continuations must belong to the same Provider turn');
  assert.ok(!preExistingRequestIds.has(requestId), 'the next root request must be new in this fixture');
  const childRequests = requestRecords.filter((record) =>
    record.kind === 'request' && record.record.request.parentRequestId !== undefined);
  assert.ok(childRequests.every((record) =>
    record.kind === 'request'
    && record.record.request.parentRequestId === requestId
    && record.record.parentRequestId === requestId),
  'the next execution must only carry direct continuations of the root request');
  const childRequestIds = [...new Set(childRequests.map((record) =>
    record.kind === 'request' ? record.record.request.requestId : ''))];
  assert.ok(!childRequestIds.includes(requestId), 'a continuation must not reuse the root request id');
  assert.equal(registeredRequestIds.length, rootRequestIds.length + childRequestIds.length,
    'the next execution must carry the root and its direct continuations only');
  assert.ok(!childRequestIds.some((id) => preExistingRequestIds.has(id)),
    'the next continuations must be new in this fixture');
  const expectedPhases = ['dispatching', 'dispatched'] as const;
  for (const phaseRequestId of [requestId, ...childRequestIds]) {
    const phases = requestRecords.flatMap((record) =>
      record.kind === 'request' && record.record.request.requestId === phaseRequestId
        ? [record.record.phase]
        : []);
    assert.deepEqual(phases.slice(0, 2), [...expectedPhases],
      `request ${phaseRequestId} must dispatch in order`);
    assert.equal(phases.at(-1), 'settled', `request ${phaseRequestId} must reach its settled phase`);
    assert.ok(!phases.includes('failed') && !phases.includes('cancelled'),
      `request ${phaseRequestId} must not fail or cancel`);
  }

  const turnEndResults = activeRecords.flatMap((record) =>
    record.kind === 'accepted-fact'
      && record.entry.envelope.request.requestId === requestId
      && record.entry.envelope.fact.kind === 'tool-result'
      ? [record.entry.envelope.fact]
      : []);
  const turnEndToolCalls = activeRecords.flatMap((record) =>
    record.kind === 'accepted-fact'
      && record.entry.envelope.request.requestId === requestId
      && record.entry.envelope.fact.kind === 'tool-call'
      ? [record.entry.envelope.fact]
      : []);
  assert.equal(turnEndToolCalls.length, 1, 'the root request must produce exactly one tool call');
  assert.equal(turnEndToolCalls[0]!.call.toolId, 'humanagent_turn_end');
  assert.equal(turnEndResults.length, 1, 'the root tool call must produce exactly one tool result');
  assert.equal(turnEndResults[0]!.callId, turnEndToolCalls[0]!.call.callId);
  assert.equal(turnEndResults[0]!.result.status, 'succeeded',
    'the standard turn end tool result must be accepted');
  const acceptedEntries = activeRecords.flatMap((record) =>
    record.kind === 'accepted-fact' ? [record.entry] : []);
  const journalSeqs = new Map<string, readonly number[]>();
  const settledSeqs = new Map<string, number>();
  for (const record of records) {
    if (record.kind !== 'event' || record.payload?.['type'] !== 'active-turn.record') continue;
    if (!record.commitId?.startsWith(`active-turn:${nextTurnId}:`)) continue;
    const value = record.payload['record'] as ActiveTurnJournalRecord | undefined;
    if (value?.kind === 'accepted-fact') {
      const request = value.entry.envelope.request;
      if (request.turnId !== nextProviderTurnId || !registeredRequestIds.includes(request.requestId)) continue;
      const requestIdOfRecord = request.requestId;
      journalSeqs.set(requestIdOfRecord, [...(journalSeqs.get(requestIdOfRecord) ?? []), record.seq]);
    } else if (value?.kind === 'request' && value.record.phase === 'settled') {
      const request = value.record.request;
      if (request.turnId !== nextProviderTurnId || !registeredRequestIds.includes(request.requestId)) continue;
      settledSeqs.set(request.requestId, record.seq);
    }
  }
  const childSeqs = childRequestIds.flatMap((id) => [...(journalSeqs.get(id) ?? [])]);
  assert.ok(childSeqs.length > 0, 'the continuation must produce accepted wire facts');
  for (const childRequestId of childRequestIds) {
    assert.ok(Math.min(...(journalSeqs.get(childRequestId)!)) > settledSeqs.get(requestId)!,
      'the continuation must start after the root request settles');
  }
  assert.ok(acceptedEntries.every((entry) =>
    entry.envelope.request.turnId === nextProviderTurnId
    && entry.envelope.execution.runtimeId === allocation.runtimeId
    && entry.envelope.execution.executionEpoch === allocation.executionEpoch
    && entry.envelope.scope.operationId?.value === started.operationId.value
    && (entry.envelope.request.requestId === requestId
      || childRequestIds.includes(entry.envelope.request.requestId))),
  'accepted wire facts must stay in the new execution identity and registered request ids');

  const rootCandidates = records.flatMap((record) => {
    const context = contextHistoryFromRecord(record);
    if (context === null || record.commitId === undefined) return [];
    if (context.scope.operationId?.value !== started.operationId.value
      || context.agentRuntimeId !== allocation.runtimeId
      || context.contextView.executionEpoch !== started.executionEpoch
      || context.previousContextCommitRef !== null) return [];
    return [{
      context,
      commitRef: { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest },
    }];
  });
  assert.equal(rootCandidates.length, 1, 'the next execution must install one new root context');
  const root = rootCandidates[0]!;
  assert.deepEqual(root.context.scope, allocation.scope);
  assert.deepEqual(root.context.contextView.activeRefs, expectedContext.contextView.activeRefs);
  assert.deepEqual(root.context.contextView.omittedRefs, expectedContext.contextView.omittedRefs);
  assert.deepEqual(root.context.durableContext, expectedContext.durableContext);
  assert.equal(root.context.durableContextDigest, expectedContext.durableContextDigest);
  assert.ok(root.context.contextView.activeRefs.includes(contextRefs.accepted));
  assert.ok(!root.context.contextView.activeRefs.includes(contextRefs.wrong));
  assert.ok(root.context.contextView.omittedRefs.includes(contextRefs.wrong));

  const nextWires = http.wires.slice(wireOffset);
  const executionWires = nextWires.filter((wire) => plannerPayload(wire.body) === undefined
    && hasTurnEndSurface(wire.body) && !isPostStandardEndContinuation(wire.body));
  assert.equal(executionWires.length, 1, 'the next execution must issue one real execution request');
  const executionText = wireText(executionWires[0]!.body);
  assert.ok(executionText.some((text) => text.includes('next turn input')));
  assert.ok(['accepted reasoning', 'accepted tool result', 'retained duty']
    .every((semantic) => executionText.some((text) => text.includes(semantic))),
  'the actual next wire must retain the accepted context semantics and duty');
  assert.ok(executionText.some((text) => text.includes(expectedCheckpointSemantic)),
    'the actual next wire must consume the resumed v2 checkpoint semantics');
  assert.ok(!executionText.some((text) => text.includes(contextRefs.wrong)),
    'the corrected wrong ref must not return as active reasoning');

  const closureCandidate = records.flatMap((record) => {
    const closure = closureFromRecord(record);
    if (closure === null || !('closureKind' in closure) || closure.closureKind !== 'checkpoint') return [];
    if (closure.recoveryBinding?.contextCommitRef.commitId !== root.commitRef.commitId
      || record.scope.operationId?.value !== started.operationId.value
      || record.commitId === undefined) return [];
    return [{
      closure,
      commitRef: { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest },
    }];
  });
  assert.equal(closureCandidate.length, 1, 'the next standard closure must bind its own root context');
  const closure = closureCandidate[0]!;
  assert.equal(closure.closure.recoveryBinding?.coreClosure.executionEpoch, started.executionEpoch,
    'the next closure must carry the new allocation epoch');

  const control = readOperationControlFromRecords(records, {
    scope: allocation.scope,
    agentRuntimeId: allocation.runtimeId,
    harnessExecutionEpoch: allocation.executionEpoch,
  });
  assert.equal(control.state, 'complete', control.state === 'complete' ? undefined : control.reason);
  if (control.state !== 'complete') throw new Error(control.reason);
  const parent = control.operations.find((operation) =>
    operation.intent.operationId.value === started.operationId.value);
  if (parent === undefined) throw new Error('the next allocation has no parent operation-control record');
  assert.equal(parent.binding.harnessExecutionEpoch, started.executionEpoch);
  const parentRecord = records.find((record) =>
    record.payload?.['kind'] === 'operation-control-envelope/v1'
    && (record.payload['event'] as { readonly eventId?: string } | undefined)?.eventId
      === `parent-admitted:${started.operationId.value}`);
  if (parentRecord === undefined) throw new Error('the next allocation has no parent admission envelope');
  const parentEvent = parentRecord.payload!['event'] as { readonly executionEpoch?: number };
  const parentControl = parentRecord.payload!['control'] as { readonly executionEpoch?: number };
  assert.equal(parentEvent.executionEpoch, started.executionEpoch);
  assert.equal(parentControl.executionEpoch, started.executionEpoch);

  const progress = latestNativeSaveProgress(records);
  assert.ok(progress, 'the next execution must commit native-save progress');
  assert.equal(progress!.key.checkpoint.scope.operationId?.value, started.operationId.value);
  assert.equal(progress!.key.turn.turnId, nextTurnId);
  assert.deepEqual(progress!.phases.filter((phase) => phase.state === 'committed')
    .map((phase) => phase.phase).sort(), [...NATIVE_SAVE_PHASES].sort());

  const duties = records.filter((record) => record.payload?.type === 'closed-turn-planner-call')
    .map((record) => record.payload!.record as ClosedTurnPlannerCallRecord)
    .filter((record) => record.duty.checkpointId.value === progress!.key.checkpoint.id.value);
  assert.deepEqual(duties.map((record) => record.stage), ['prepared', 'invoked', 'returned'],
    'the new standard closure must reach its own independent Planner return');
  assert.ok(duties.every((record) => record.duty.scope.operationId?.value === started.operationId.value));
  const publication = await new ServiceExecutionCheckpointStore(fixture.journalPath, fixture.journal,
    () => new Date(at)).readPublicOutputs({ scope: allocation.scope, executionEpoch: started.executionEpoch });
  assert.equal(publication.state, 'committed');
  assert.equal(publication.commits.length, 1);
  const publicationText = publication.commits[0]!.text;
  assert.equal(publicationText, 'Next execution completed from the corrected forward context.');
  assert.equal(await readFile(fixture.effectPath, 'utf8'), effectBefore);
  assert.equal(effectRecordCount(records, fixture.effect.effectId), effectsBefore,
    'starting the next execution must not replay the confirmed effect');

  const after = await checkpoints.readExecutionPosition(taskScope);
  assert.equal(after?.executionEpoch, started.executionEpoch);
  return {
    operationId: started.operationId.value,
    executionEpoch: started.executionEpoch,
    rootCommitId: root.commitRef.commitId,
    requestId,
    closureCommitId: closure.commitRef.commitId,
    parentControlCommitId: parentRecord.commitId!,
    plannerStage: 'returned',
    publicationText,
  };
}

/**
 * The full cold-resume assertion surface, shared by the in-process consumer
 * case and by the fresh resume child. Only the resume child runs it for the
 * process-boundary acceptance; the parent then verifies the child's receipt.
 */
async function runResumeAssertions(fixture: ColdFixture, model: string): Promise<string> {
  const journalBytesBefore = await readFile(fixture.journalPath, 'utf8');
  const recordsBefore = (await fixture.journal.verify()).records;
  const effectRecordsBefore = effectRecordCount(recordsBefore, fixture.effect.effectId);
  const priorSegments = await fixture.segmentJournal.readSegments(fixture.businessTurnId);
  const selected = await controlledColdResumeSelector(fixture)({
    taskId: fixture.taskId, operationId: fixture.allocation.operationId,
  });
  const http = await upstream(model, fixture.acceptedEvidenceLocator, fixture);
  let assemblies: ReturnType<typeof buildResumeRuntime>['assemblies'] = [];
  let succeeded = false;
  try {
    const runtime = buildResumeRuntime(fixture, http.baseUrl, model);
    const { coordinator, composition } = runtime;
    assemblies = runtime.assemblies;
    const release: RuntimeExecutionRelease = await coordinator.resumeExecution(
      fixture.taskId, fixture.allocation.operationId,
      selected);
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
    if (fixture.originalV1ReceiptRef === undefined) {
      throw new Error('the captured resume fixture must retain its original v1 receipt reference');
    }
    const readback = await fixture.native.readRecoveryAssetsExact(fixture.originalV1ReceiptRef);
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
    assert.equal(segments.length, priorSegments.length + 1, 'a generation-ready resume opens exactly one new execution segment');
    const resumed = segments.at(-1)!;
    const successorEpoch = Math.max(fixture.allocation.executionEpoch,
      ...priorSegments.map((segment) => segment.binding.execution.executionEpoch)) + 1;
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
    assert.deepEqual(resumed.predecessor, selected.predecessor,
      'the resumed segment links the exact captured or interrupted predecessor');

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
    await mkdir(EVIDENCE_ROOT, { recursive: true });
    const archiveRoot = await mkdtemp(join(EVIDENCE_ROOT, 'passed-receipts-'));
    try {
      await writeFile(join(archiveRoot, 'upstream-wires.json'), JSON.stringify(http.wires, null, 2), 'utf8');
      await writeFile(join(archiveRoot, 'organ-journal.jsonl'), await readFile(fixture.journalPath, 'utf8'), 'utf8');
      console.log(`cold-resume passed receipt archive: ${archiveRoot}`);
    } catch (error) {
      await rm(archiveRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    succeeded = true;
    return archiveRoot;
  } finally {
    await http.close();
    for (const assembly of assemblies) await assembly.runtimePool.dispose();
    if (!succeeded) {
      await writeFile(join(EVIDENCE_ROOT, `failed-${fixture.root.split('/').at(-1)}-wires.json`), JSON.stringify(http.wires, null, 2), 'utf8')
        .catch(() => undefined);
      console.error(`cold-resume fixture retained for evidence at ${fixture.root}`);
    }
  }
}

/** Same persisted fixture, real service, HTTP dispatcher and Runtime; no method substitution. */
async function runHttpResumeAssertions(
  fixture: ColdFixture,
  mode: boolean | 'initial-open',
  useCompositionSelector = false,
): Promise<string> {
  const interrupted = mode === true;
  const initialOpen = mode === 'initial-open';
  const provider = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture);
  const prefix = await readFile(fixture.journalPath, 'utf8');
  const before = (await fixture.journal.verify()).records;
  const priorSegments = await fixture.segmentJournal.readSegments(fixture.businessTurnId);
  const selector = controlledColdResumeSelector(fixture);
  const selected = await selector({ taskId: fixture.taskId, operationId: fixture.allocation.operationId });
  let app: Awaited<ReturnType<typeof buildResumeService>> | undefined;
  let succeeded = false;
  try {
    if (!initialOpen) {
      app = await buildResumeService(fixture, provider.baseUrl, 'cold-resume.model', undefined);
      const refused = await postResume(app.url, app.cookie, fixture.taskId.value,
        { operationId: fixture.allocation.operationId.value });
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal(requireRecord(requireRecord(refused.body, 'refusal').error, 'typed refusal').code,
        'cold-execution.selector-unbound');
      assert.equal(provider.wires.length, 0, 'unbound resume must not start a Provider');
      assert.equal(await readFile(fixture.journalPath, 'utf8'), prefix,
        'refusal preserves all durable recovery responsibility');
      assert.equal(await readFile(fixture.effectPath, 'utf8'), fixture.output);
      await app.close();
      app = undefined;
    }

    app = await buildResumeService(
      fixture,
      provider.baseUrl,
      'cold-resume.model',
      useCompositionSelector ? undefined : selector,
      useCompositionSelector,
    );
    const invalid = await postResume(app.url, app.cookie, fixture.taskId.value,
      { operationId: fixture.allocation.operationId.value, prompt: 'injected input' });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
    assert.equal(app.selectorCallCount(), 0, 'invalid body must not reach the source selector');
    assert.equal(provider.wires.length, 0);
    const response = await postResume(app.url, app.cookie, fixture.taskId.value,
      { operationId: fixture.allocation.operationId.value });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const receipt = requireRecord(response.body, 'release receipt');
    assert.equal(receipt.state, 'released');
    assert.equal(receipt.taskId, fixture.taskId.value);
    assert.equal(receipt.operationId, fixture.allocation.operationId.value);
    assert.equal(receipt.businessTurnId, fixture.businessTurnId);
    assert.equal(app.selectorCallCount(), 1);
    assert.ok(provider.wires.length > 0, 'real resumed driver must reach the controlled HTTP Provider');
    const after = (await fixture.journal.verify()).records;
    assert.equal((await readFile(fixture.journalPath, 'utf8')).slice(0, prefix.length), prefix);
    assert.equal(effectRecordCount(before, fixture.effect.effectId), 2);
    assert.equal(effectRecordCount(after, fixture.effect.effectId), 2);
    assert.equal(await readFile(fixture.effectPath, 'utf8'), fixture.output);

    // Initial input registered exactly once across the business turn
    const initialInputRecords = after.filter((r) =>
      r.commitId?.startsWith(`active-turn:${fixture.businessTurnId}:`) && r.commitId.endsWith(':initial-input'));
    assert.equal(initialInputRecords.length, 1, 'initial input must be registered exactly once across the business turn');

    const segments = await fixture.segmentJournal.readSegments(fixture.businessTurnId);
    assert.equal(segments.length, priorSegments.length + 1);
    const successor = segments.at(-1)!;
    assert.deepEqual(successor.predecessor, selected.predecessor);
    assert.equal(successor.binding.businessTurnRef.businessTurnId, fixture.businessTurnId);
    assert.equal(successor.binding.scope.operationId?.value, fixture.allocation.operationId.value);
    assert.equal(successor.binding.assignment.taskId.value, fixture.taskId.value);
    const successorEpoch = interrupted ? 3 : 2;
    assert.equal(successor.binding.execution.executionEpoch, successorEpoch);
    if (interrupted) {
      if (selected.predecessor.interrupted === undefined) throw new Error('expected the real interrupted anchor');
      const retained = await fixture.segmentJournal.readSegmentInterruptedExact({
        businessTurnId: fixture.businessTurnId,
        predecessor: selected.predecessor,
      });
      assert.ok(retained.prefix.obligations.some((duty) => duty.kind === 'request'
        && duty.requestId === 'interrupted-v2-request' && duty.phase === 'dispatched'),
      'the original interrupted request remains pending under its original segment');
    }
    if (initialOpen && fixture.pendingRequestId) {
      const decodedTurnRecords = decodeActiveTurnRecords(after, fixture.businessTurnId);
      const pendingRequestRecord = decodedTurnRecords.find(
        (r) => r.kind === 'request' && r.record.request.requestId === fixture.pendingRequestId,
      );
      assert.ok(pendingRequestRecord !== undefined, 'the original pending request responsibility must be preserved');
    }
    console.log(JSON.stringify({ publicResume: initialOpen ? 'initial-open' : interrupted ? 'interrupted-v2' : 'v1', ...receipt,
      completedEffectRecords: 2, prefixPreserved: true }));
    const successorEpochVal = interrupted ? 3 : 2;
    assert.equal(receipt.executionEpoch, successorEpochVal,
      'the public release receipt must expose the actual successor epoch');

    // Reopen the same durable owners without issuing another resume. The fresh
    // hydrate and the independent inventory must both read the actual physical
    // epoch committed by the standard-end checkpoint.
    await app.close();
    app = undefined;
    const reopened = buildResumeRuntime(fixture, provider.baseUrl, 'cold-resume.model');
    await reopened.coordinator.hydrate();
    const hydrated = reopened.coordinator.taskSnapshot(fixture.taskId);
    assert.equal(hydrated.operationId, fixture.allocation.operationId.value,
      'fresh hydrate must preserve the original operation identity');
    assert.equal(hydrated.executionEpoch, successorEpochVal,
      'fresh hydrate must read the actual successor epoch');

    const inventory = await projectDurableTaskInventory({
      records: fixture.preparedJournal.replay(),
      checkpointFor: () => new ServiceExecutionCheckpointStore(fixture.journalPath, fixture.journal, () => new Date(at)),
    });
    assert.deepEqual(inventory.failures, []);
    const durable = inventory.entries.find((entry) => entry.snapshot.taskId.value === fixture.taskId.value);
    if (durable === undefined) throw new Error('durable inventory must contain the resumed task');
    assert.equal(durable.snapshot.operationId, fixture.allocation.operationId.value,
      'durable inventory must preserve the original operation identity');
    assert.equal(durable.snapshot.executionEpoch, successorEpochVal,
      'durable inventory must read the actual successor epoch');
    assert.equal(durable.durableState, 'checkpoint');

    await mkdir(EVIDENCE_ROOT, { recursive: true });
    const archiveRoot = await mkdtemp(join(EVIDENCE_ROOT, 'passed-http-receipts-'));
    try {
      await writeFile(join(archiveRoot, 'upstream-wires.json'), JSON.stringify(provider.wires, null, 2), 'utf8');
      await writeFile(join(archiveRoot, 'organ-journal.jsonl'), await readFile(fixture.journalPath, 'utf8'), 'utf8');
    } catch (error) {
      await rm(archiveRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    succeeded = true;
    return archiveRoot;
  } finally {
    try {
      await app?.close();
    } finally {
      await provider.close();
    }
    await mkdir(EVIDENCE_ROOT, { recursive: true });
    await writeFile(join(EVIDENCE_ROOT, `http-${fixture.root.split('/').at(-1)}-wires.json`),
      JSON.stringify(provider.wires, null, 2), 'utf8');
  }
}

function registerPublicConsumers(): void {
  // Observed live 409 task.assembly.missing strands an already saved turn.
  // Cost: one existing fixture, one preparation run and one boundary resume.
  // Observed source-conflict: allocation epoch 1 differs from closing epoch 2.
  // Impact: accepted text is rejected or lost on refresh. Cost: strengthen this
  // same case with real Journal publication/readback and one fresh hydrate.
  test('public cold boundary resume creates the real Planner assembly without acquiring an executor or replaying saved work', async () => {
    const fixture = await buildColdFixture('boundary-planner-assembly', ['original-output'],
      ['original-target', 'original-delivery-text-target'], true);
    assert.deepEqual(fixture.assignment.expectedOutputRefs, ['original-output']);
    assert.deepEqual(fixture.assignment.targetRefs, ['original-target', 'original-delivery-text-target']);
    const deliveryText = '已恢复原任务。确认的文件与副作用保持不变。\n最终业务结果：冷恢复交付完成。';
    const http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture, deliveryText);
    const owned: ResumeAssembly[] = [];
    let succeeded = false;
    try {
      const stopBeforePlanner = new Error('boundary fixture: refuse orchestration provider before Planner duty');
      const preparation = buildResumeRuntime(fixture, http.baseUrl, 'cold-resume.model', {
        beforeProvider(roleId) { if (roleId === 'orchestration') throw stopBeforePlanner; },
      });
      const preparationRequest = await preparation.composition.resolveColdExecutionResumeRequest({ taskId: fixture.taskId,
        operationId: fixture.allocation.operationId });
      try {
        await assert.rejects(() => preparation.coordinator.resumeExecution(fixture.taskId, fixture.allocation.operationId,
          preparationRequest), (error: unknown) => error === stopBeforePlanner);
      } finally {
        // The factory is called during resume, after construction.
        owned.push(...preparation.assemblies);
      }
      for (const assembly of preparation.assemblies) await assembly.runtimePool.dispose();

      const pending = buildResumeRuntime(fixture, http.baseUrl, 'cold-resume.model');
      await pending.coordinator.hydrate();
      assert.equal(pending.coordinator.taskSnapshot(fixture.taskId).error?.code, 'runtime.execution.failure',
        'a closed checkpoint without accepted alignment does not resolve the current error');
      const pendingInventory = await projectDurableTaskInventory({
        records: fixture.preparedJournal.replay(),
        checkpointFor: () => new ServiceExecutionCheckpointStore(fixture.journalPath, fixture.journal, () => new Date(at)),
        currentStateFor: () => createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal }),
      });
      assert.deepEqual(pendingInventory.failures, []);
      assert.equal(pendingInventory.entries.find((entry) => entry.snapshot.taskId.value === fixture.taskId.value)
        ?.snapshot.error?.code, 'runtime.execution.failure', 'inventory retains the unaligned error too');

      const beforeBytes = await readFile(fixture.journalPath, 'utf8');
      const beforeRecords = (await fixture.journal.verify()).records;
      assert.equal(beforeRecords.filter((record) => record.payload?.type === 'closed-turn-planner-call').length, 0,
        'preparation must stop before any prepared or invoked Planner duty');
      const beforeProgress = latestNativeSaveProgress(beforeRecords);
      assert.ok(beforeProgress);
      assert.deepEqual(beforeProgress!.phases.filter((phase) => phase.state === 'committed').map((phase) => phase.phase).sort(),
        [...NATIVE_SAVE_PHASES].sort());
      const beforeSegments = await fixture.segmentJournal.readSegments(fixture.businessTurnId);
      assert.equal(fixture.allocation.executionEpoch, 1);
      const closingSegment = beforeSegments.at(-1)!;
      assert.equal(closingSegment.binding.execution.executionEpoch, 2);
      assert.deepEqual(closingSegment.binding.assignment, fixture.assignment);
      assert.equal(closingSegment.binding.scope.operationId?.value, fixture.allocation.operationId.value);
      assert.equal(closingSegment.binding.businessTurnRef.businessTurnId, fixture.businessTurnId);
      const acceptedEnds = (await fixture.segmentJournal.readSegmentRecords({
        businessTurnId: fixture.businessTurnId,
        segmentId: closingSegment.segmentId,
      }))
        .flatMap((record) => record.kind === 'accepted-fact'
          && record.entry.envelope.fact.kind === 'tool-call'
          && isStandardTurnEndToolId(record.entry.envelope.fact.call.toolId) ? [record.entry] : []);
      assert.equal(acceptedEnds.length, 1);
      assert.equal(acceptedEnds[0]!.envelope.execution.executionEpoch, 2);
      assert.deepEqual(acceptedEnds[0]!.envelope.scope, closingSegment.binding.scope);
      const closingCheckpoint = await new ServiceExecutionCheckpointStore(fixture.journalPath,
        fixture.journal, () => new Date(at)).readLatest(closingSegment.binding.scope);
      assert.equal(closingCheckpoint?.checkpoint.executionEpoch, 2);
      assert.equal(closingCheckpoint?.checkpoint.scope.operationId?.value, fixture.allocation.operationId.value);
      const beforeFile = await readFile(fixture.effectPath, 'utf8');
      assert.equal(beforeFile, fixture.output);
      const beforeEffects = effectRecordCount(beforeRecords, fixture.effect.effectId);
      const savedRecords = (records: readonly JournalRecord[]) => records.filter((record) =>
        record.kind === 'checkpoint' || record.payload?.kind === 'checkpoint-closure'
          && (record.payload.closure as { closureKind?: string })?.closureKind !== 'planner-alignment'
          || record.payload?.progress !== undefined);
      const wireOffset = http.wires.length;
      const selectedRoles: string[] = [];
      let executorInstances = 0;
      const runtime = buildResumeRuntime(fixture, http.baseUrl, 'cold-resume.model', {
        beforeProvider(roleId) { selectedRoles.push(roleId); },
        onExecutionInstance() { executorInstances += 1; },
      });
      assert.equal(runtime.assemblies.length, 0, 'the cold coordinator starts without a live assembly');
      const beforeTaskIds = runtime.coordinator.taskSnapshots().map((task) => task.taskId.value);
      const selected = await runtime.composition.resolveColdExecutionResumeRequest({ taskId: fixture.taskId,
        operationId: fixture.allocation.operationId });
      const source = await runtime.composition.readColdExecutionSource({ allocation: fixture.allocation, request: selected });
      const boundary = await runtime.composition.recoverOriginalTurn({ source });
      assert.equal(boundary.kind, 'committed-close-alignment');
      if (boundary.kind === 'committed-close-alignment') {
        assert.equal(boundary.stage, 'closure-committed-alignment-absent');
      }

      try {
        const release = await runtime.coordinator.resumeExecution(fixture.taskId, fixture.allocation.operationId, selected);
        assert.equal(release.state, 'released');
      } finally {
        owned.push(...runtime.assemblies);
      }
      assert.equal(runtime.assemblies.length, 1, 'the real factory supplies the Planner pool once');
      assert.equal(executorInstances, 0, 'boundary resume must not acquire a new executor instance');
      assert.deepEqual(selectedRoles, ['orchestration'], 'only the independent Planner selects a Provider');
      const wires = http.wires.slice(wireOffset);
      assert.equal(wires.length, 1, 'exactly one independent Planner POST and no executor generation');
      assert.ok(plannerPayload(wires[0]!.body));
      assert.deepEqual(await fixture.segmentJournal.readSegments(fixture.businessTurnId), beforeSegments,
        'boundary resume preserves all physical segments and epochs');
      assert.equal(await readFile(fixture.effectPath, 'utf8'), beforeFile);
      assert.equal(digest(await readFile(fixture.effectPath, 'utf8')), digest(fixture.output));
      assert.ok((await readFile(fixture.journalPath, 'utf8')).startsWith(beforeBytes));
      const afterRecords = (await fixture.journal.verify()).records;
      assert.equal(effectRecordCount(afterRecords, fixture.effect.effectId), beforeEffects);
      assert.deepEqual(savedRecords(afterRecords), savedRecords(beforeRecords),
        'native progress, original checkpoints and closures must not be recommitted');
      const duties = afterRecords.filter((record) => record.payload?.type === 'closed-turn-planner-call')
        .map((record) => record.payload!.record as ClosedTurnPlannerCallRecord);
      assert.deepEqual(duties.map((duty) => duty.stage), ['prepared', 'invoked', 'returned']);
      const returned = duties[2]!;
      assert.equal(returned.stage, 'returned');
      if (returned.stage === 'returned') assert.equal(returned.decision, 'complete');
      assert.ok(duties.every((duty) => duty.duty.taskId.value === fixture.taskId.value
        && duty.duty.closureRef === duties[0]!.duty.closureRef
        && duty.duty.checkpointId.value === beforeProgress!.key.checkpoint.id.value));
      const aligned = await runtime.composition.recoverOriginalTurn({ source: await runtime.composition.readColdExecutionSource({
        allocation: fixture.allocation, request: selected }) });
      assert.equal(aligned.kind, 'committed-close-alignment');
      if (aligned.kind === 'committed-close-alignment') assert.equal(aligned.stage, 'alignment-committed');
      const facts = await createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal })
        .read({ organId, taskId: fixture.taskId });
      assert.equal(facts.state, 'known');
      if (facts.state === 'known') assert.ok(facts.value.currentPlan, 'published plan must read back');
      assert.equal(runtime.coordinator.taskSnapshot(fixture.taskId).currentState, '已完成');
      assert.deepEqual(runtime.coordinator.taskSnapshots().map((task) => task.taskId.value), beforeTaskIds);
      assert.equal(runtime.coordinator.taskSnapshot(fixture.taskId).executionEpoch,
        beforeSegments.at(-1)!.binding.execution.executionEpoch);
      const completed = runtime.coordinator.taskSnapshot(fixture.taskId);
      assert.equal(completed.error, undefined, 'accepted alignment clears the hot current error');
      assert.equal(completed.operationId, fixture.allocation.operationId.value);
      assert.equal(completed.output, deliveryText);
      const publicStore = new ServiceExecutionCheckpointStore(fixture.journalPath,
        new JsonlOrganJournal(fixture.journalPath), () => new Date(at));
      const publication = await publicStore.readPublicOutputs({ scope: closingSegment.binding.scope, executionEpoch: 2 });
      assert.equal(publication.state, 'committed');
      assert.equal(publication.commits.length, 1);
      assert.equal(publication.commits[0]!.text, deliveryText);
      assert.equal(publication.commits[0]!.ref.binding.executionEpoch, 2);
      assert.deepEqual(completed.publicOutput, publication);
      const oldPublication = await publicStore.readPublicOutputs({ scope: closingSegment.binding.scope, executionEpoch: 1 });
      assert.deepEqual(oldPublication.commits, [], 'allocation epoch cannot impersonate the closing publication');
      const refreshed = buildResumeRuntime(fixture, http.baseUrl, 'cold-resume.model');
      await refreshed.coordinator.hydrate();
      const hydrated = refreshed.coordinator.taskSnapshot(fixture.taskId);
      assert.equal(hydrated.taskId.value, fixture.taskId.value);
      assert.equal(hydrated.operationId, fixture.allocation.operationId.value);
      assert.equal(hydrated.executionEpoch, 2);
      assert.equal(hydrated.state, 'succeeded');
      assert.deepEqual(hydrated.publicOutput, publication, 'fresh hydration must retain the exact text and commit');
      const inventory = await projectDurableTaskInventory({
        records: fixture.preparedJournal.replay(),
        checkpointFor: () => publicStore,
        currentStateFor: () => createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal }),
      });
      assert.deepEqual(inventory.failures, []);
      const durable = inventory.entries.find((entry) => entry.snapshot.taskId.value === fixture.taskId.value);
      if (!durable) throw new Error('durable inventory must contain the recovered task');
      assert.equal(durable.snapshot.state, hydrated.state);
      assert.equal(durable.snapshot.executionEpoch, hydrated.executionEpoch);
      assert.deepEqual([hydrated.error, durable.snapshot.error], [undefined, undefined],
        'fresh hydrate and durable inventory must revoke the resolved execution error');
      assert.ok(fixture.preparedJournal.replay().some((record) => record.kind === 'operation.event'
        && record.error?.code === 'runtime.execution.failure'), 'the historical failure remains readable');
      assert.equal(refreshed.assemblies.length, 0, 'refresh does not acquire an assembly');
      const unbound = buildResumeRuntime(fixture, http.baseUrl, 'cold-resume.model', { omitAssemblyFactory: true });
      await assert.rejects(() => unbound.coordinator.resumeExecution(fixture.taskId, fixture.allocation.operationId, selected),
        (error: unknown) => (error as { code?: string }).code === 'orchestration.unavailable');
      assert.equal(http.wires.length, wireOffset + 1, 'missing factory must not invoke any Provider');
      const receipt = { boundaryAssembly: 1, executorInstances, plannerPosts: wires.length,
        originalSegments: beforeSegments.length, effectRecords: beforeEffects, fileDigest: digest(beforeFile),
        allocationEpoch: fixture.allocation.executionEpoch, closingEpoch: hydrated.executionEpoch,
        publicCommit: publication.commits[0]!.ref, deliveryDigest: digest(deliveryText),
        hydratedPublicOutput: hydrated.publicOutput };
      await mkdir(EVIDENCE_ROOT, { recursive: true });
      const archiveRoot = await mkdtemp(join(EVIDENCE_ROOT, 'passed-boundary-receipts-'));
      await writeFile(join(archiveRoot, 'receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');
      await writeFile(join(archiveRoot, 'upstream-wires.json'), JSON.stringify(wires, null, 2), 'utf8');
      await writeFile(join(archiveRoot, 'organ-journal.jsonl'), await readFile(fixture.journalPath, 'utf8'), 'utf8');
      console.log(`cold-boundary passed receipt archive: ${archiveRoot}`);
      succeeded = true;
    } finally {
      await http.close();
      for (const assembly of new Set(owned)) await assembly.runtimePool.dispose();
      if (succeeded) await rm(fixture.root, { recursive: true, force: true });
      else console.error(`boundary Planner fixture retained for evidence at ${fixture.root}`);
    }
  });

  test('HTTP resume releases the retained v1 turn and rejects extra body and unbound selector', async () => {
    await runHttpResumeAssertions(await buildColdFixture('http-v1'), false);
  });

  test('HTTP resume continues an opened unsaved v2 predecessor with its pending request', async () => {
    await runHttpResumeAssertions(await buildInterruptedColdFixture('http-interrupted-v2'), true);
  });

  test('public resumeExecution preserves business identity and reaches the standard-end endpoint without replaying the confirmed effect', async () => {
    const moduleUrl = import.meta.url;
    const compiledPath = moduleUrl.startsWith('file://') ? decodeURIComponent(moduleUrl.slice('file://'.length)) : moduleUrl;
    const seed = spawnColdProcess([compiledPath, '--cold-process=seed']);
    const seedRun = await collectColdProcess(seed);
    assert.equal(seedRun.close.code, 0, 'the seed child must exit normally');
    assert.equal(seedRun.close.signal, null, 'the seed child must not be signaled');
    assert.equal(seed.pid, seedRun.receipt.pid, 'the seed receipt PID must be the actual ChildProcess pid');
    assert.ok(seed.pid !== process.pid, 'the seed must run in an independent child process');

    // The resume process starts only after the seed child has closed.
    const root = seedRun.receipt.root;
    const taskId = seedRun.receipt.taskId;
    const resume = spawnColdProcess([compiledPath, '--cold-process=resume', '--fixture-root', root, '--task-id', taskId]);
    const resumeRun = await collectColdProcess(resume);
    assert.equal(resumeRun.close.code, 0, 'the resume child must exit normally');
    assert.equal(resumeRun.close.signal, null, 'the resume child must not be signaled');
    assert.equal(resume.pid, resumeRun.receipt.pid, 'the resume receipt PID must be the actual ChildProcess pid');
    assert.ok(resume.pid !== process.pid, 'the resume must run in an independent child process');
    assert.ok(resume.pid !== seed.pid, 'the resume must run in a second independent child process');

    // The resume child archived the upstream wires and the exact Organ Journal;
    // the parent adds the process lifecycle evidence to the same archive.
    const archiveRoot = resumeRun.receipt.archiveRoot;
    assert.ok(archiveRoot !== undefined, 'the resume child must publish the passed receipt archive');
    await writeFile(join(archiveRoot!, 'process-evidence.json'), JSON.stringify({
      parentPid: process.pid,
      seed: { pid: seed.pid, receiptPid: seedRun.receipt.pid, ppid: seedRun.receipt.ppid,
        code: seedRun.close.code, signal: seedRun.close.signal },
      resume: { pid: resume.pid, receiptPid: resumeRun.receipt.pid, ppid: resumeRun.receipt.ppid,
        code: resumeRun.close.code, signal: resumeRun.close.signal },
      ordering: { seedClosedBeforeResumeSpawned: true },
    }, null, 2), 'utf8');
    await writeFile(join(archiveRoot!, 'seed-child.log'), seedRun.stdout, 'utf8');
    await writeFile(join(archiveRoot!, 'resume-child.log'), resumeRun.stdout, 'utf8');
    if (seedRun.stderr.length > 0) await writeFile(join(archiveRoot!, 'seed-child.stderr.log'), seedRun.stderr, 'utf8');
    if (resumeRun.stderr.length > 0) await writeFile(join(archiveRoot!, 'resume-child.stderr.log'), resumeRun.stderr, 'utf8');
    await rm(root, { recursive: true, force: true });
  });

  // Failure likelihood: observed driver guard, recovery unknown. Impact: a
  // budget slice can strand a business turn or replay an accepted file effect.
  // Cost: two public resumes with the existing physical Journal and HTTP helper.
  test('actual tool.round-limit public resume consumer', async () => {
    const fixture = await buildColdFixture('actual-tool-round-limit');
    const acceptedPath = join(fixture.root, 'round-one.txt');
    const rejectedPath = join(fixture.root, 'round-two.txt');
    let recovering = false;
    let toolCalls = 0;
    const http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture,
      undefined, undefined, () => {
        if (recovering) return undefined;
        const ordinal = ++toolCalls;
        assert.ok(ordinal <= 2, 'the configured budget must stop before a third Provider request');
        const call = { type: 'function_call', call_id: `budget-write-${ordinal}`, name: 'file.write',
          arguments: JSON.stringify({ file_path: ordinal === 1 ? acceptedPath : rejectedPath,
            content: ordinal === 1 ? 'accepted once' : 'must not execute' }) };
        return [
          { type: 'response.created', response: { id: `budget-response-${ordinal}` } },
          { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
          { type: 'response.output_item.done', output_index: 0, item: call },
          { type: 'response.completed', response: { id: `budget-response-${ordinal}` } },
        ];
      });
    const providerProjectKey = 'project-cold-resume-http';
    const providerWorkspaceRef = `workspace:${providerProjectKey}`;
    const options: ResumeRuntimeOptions = { maxToolRounds: 1, providerToolScope: {
      workspaceRoot: fixture.root, projectKey: providerProjectKey,
      artifactRoot: fixture.artifactsRoot, tools: [RESPONSES_FILE_WRITE_TOOL],
    } };
    let app: Awaited<ReturnType<typeof buildResumeService>> | undefined;
    let succeeded = false;
    try {
      app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined,
        true, false, undefined, undefined, options);
      let budgetError: unknown;
      try {
        await app.service.resumeExecution(fixture.taskId, { operationId: fixture.allocation.operationId });
      } catch (error) { budgetError = error; }
      const beforeRecords = (await fixture.journal.verify()).records;
      const budgetCode = budgetError instanceof Error
        ? (budgetError as Error & { readonly code?: unknown }).code : undefined;
      const budgetMessage = budgetError instanceof Error ? budgetError.message : undefined;
      const acceptedContent = await readFile(acceptedPath, 'utf8');
      const rejectedFile = await readFile(rejectedPath, 'utf8').then(
        (content) => ({ state: 'present' as const, content }),
        (error: unknown) => ({ state: 'error' as const, code: (error as { readonly code?: string }).code }),
      );
      const failureEvidence = safeStringify({ error: budgetError instanceof Error
        ? { name: budgetError.name, code: budgetCode, message: budgetMessage } : budgetError,
        files: { accepted: acceptedContent, rejected: rejectedFile }, wires: http.wires,
        prepared: fixture.preparedJournal.replay() });
      await writeFile(join(EVIDENCE_ROOT, 'tool-round-limit-first-failure.json'), failureEvidence, 'utf8');
      assert.equal(budgetCode, 'orchestration.dispatch.failed',
        'the public wrapper must expose the orchestration dispatch boundary');
      assert.equal(budgetMessage, 'provider tool round limit was exceeded',
        'the public wrapper must preserve the exact guard message');
      assert.equal(toolCalls, 2);
      assert.equal(acceptedContent, 'accepted once');
      assert.deepEqual(rejectedFile, { state: 'error', code: 'ENOENT' });
      const segmentsBefore = await fixture.segmentJournal.readSegments(fixture.businessTurnId);
      const actualBefore = segmentsBefore.at(-1)!;
      const effectFactsBefore = committedEffectFacts(beforeRecords);
      const acceptedFactsBefore = effectFactsBefore.filter(({ fact }) =>
        fact.binding.execution.taskId.value === fixture.taskId.value
        && fact.binding.execution.operationId.value === fixture.allocation.operationId.value
        && fact.binding.callId === 'budget-write-1'
        && fact.effect.workspaceRef === providerWorkspaceRef && fact.effect.relativePath === 'round-one.txt');
      assert.equal(acceptedFactsBefore.length, 2, 'the accepted write must have one intent and one completion');
      assert.deepEqual(acceptedFactsBefore.map(({ kind }) => kind).sort(), ['operation-completion', 'operation-effect-intent']);
      const acceptedIntent = acceptedFactsBefore.find(({ kind }) => kind === 'operation-effect-intent')!.fact;
      const acceptedCompletion = acceptedFactsBefore.find(({ kind }) => kind === 'operation-completion')!.fact;
      assert.equal(acceptedCompletion.effect.effectId, acceptedIntent.effect.effectId,
        'completion must retain the accepted intent effect identity');
      assert.deepEqual(acceptedCompletion.binding, acceptedIntent.binding,
        'completion must retain the accepted intent binding');
      assert.equal(acceptedIntent.binding.execution.taskId.value, fixture.taskId.value);
      assert.equal(acceptedIntent.binding.execution.operationId.value, fixture.allocation.operationId.value);
      assert.equal(acceptedIntent.binding.execution.executionEpoch, actualBefore.binding.execution.executionEpoch);
      const wireBefore = parseResponsesWire(http.wires.at(-1)!.body)!;
      const inputsBefore = wireBefore.input ?? [];
      const callOneBefore = inputsBefore.filter((item) => item.type === 'function_call' && item.call_id === 'budget-write-1');
      const callOneOutputsBefore = inputsBefore.filter((item) =>
        item.type === 'function_call_output' && item.call_id === 'budget-write-1');
      const callOneOutputContent = callOneOutputsBefore[0]?.output;
      assert.equal(inputsBefore.filter((item) => item.type === 'function_call' && item.call_id === 'budget-write-1').length, 1);
      assert.equal(inputsBefore.filter((item) => item.type === 'function_call_output' && item.call_id === 'budget-write-1').length, 1);
      assert.deepEqual(callOneBefore[0]?.arguments, JSON.stringify({ file_path: acceptedPath, content: 'accepted once' }),
        'the matched call must carry the accepted write arguments');
      assert.deepEqual(typeof callOneOutputContent === 'string'
        ? JSON.parse(callOneOutputContent.split('\n[HumanAgent evidence refs]')[0]!) : callOneOutputContent,
        { path: 'round-one.txt', operation: 'create', before: null, after: 'accepted once' },
        'the matched result must carry the actual first write readback');
      await app.close();
      app = undefined;
      recovering = true;
      const wireOffset = http.wires.length;
      app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined,
        true, false, undefined, undefined, options);
      const subscription = app.service.subscribeReplay(fixture.allocation.operationId, undefined, () => {});
      const lastEventId = subscription.replay.at(-1)?.eventId;
      subscription.unsubscribe();
      const release = await app.service.resumeExecution(fixture.taskId, { operationId: fixture.allocation.operationId });
      assert.equal(release.taskId, fixture.taskId.value);
      assert.equal(release.operationId, fixture.allocation.operationId.value);
      assert.equal(release.businessTurnId, fixture.businessTurnId);
      const terminal = await waitForTaskTerminal(app.service, fixture.taskId, fixture,
        fixture.allocation.operationId, lastEventId);
      assert.equal(terminal.state, 'succeeded', `the successor execution must close successfully: ${terminal.currentState}`);
      const segmentsAfter = await fixture.segmentJournal.readSegments(fixture.businessTurnId);
      const successor = segmentsAfter.at(-1)!;
      assert.ok(successor.binding.execution.executionEpoch > actualBefore.binding.execution.executionEpoch);
      assert.ok(segmentsAfter.length > segmentsBefore.length);
      const successorEpoch = successor.binding.execution.executionEpoch;
      assert.equal(successor.binding.scope.operationId?.value, fixture.allocation.operationId.value,
        'the successor segment must retain the resumed operation identity');
      assert.equal(successor.binding.businessTurnRef.businessTurnId, fixture.businessTurnId,
        'the successor segment must retain the original business turn');
      const successorRecords = await fixture.segmentJournal.readSegmentRecords({
        businessTurnId: fixture.businessTurnId,
        segmentId: successor.segmentId,
      });
      const acceptedEnds = successorRecords.flatMap((record) =>
        record.kind === 'accepted-fact'
          && record.entry.envelope.fact.kind === 'tool-call'
          && isStandardTurnEndToolId(record.entry.envelope.fact.call.toolId) ? [record.entry] : []);
      assert.equal(acceptedEnds.length, 1,
        'the successor segment must contain exactly one accepted standard-end call');
      assert.equal(acceptedEnds[0]!.envelope.execution.executionEpoch, successorEpoch,
        'the accepted standard end must carry the successor execution epoch');
      assert.deepEqual(acceptedEnds[0]!.envelope.scope, successor.binding.scope,
        'the accepted standard end must bind the successor segment scope');
      const afterRecords = (await fixture.journal.verify()).records;
      const effectFactsAfter = committedEffectFacts(afterRecords);
      assert.deepEqual(effectFactsAfter, effectFactsBefore, 'the accepted file effect must not be replayed');
      assert.equal(await readFile(acceptedPath, 'utf8'), 'accepted once');
      await assert.rejects(() => readFile(rejectedPath, 'utf8'), (error: unknown) =>
        (error as { code?: string }).code === 'ENOENT');
      const resumedInput = parseResponsesWire(http.wires[wireOffset]!.body)?.input ?? [];
      assert.ok(resumedInput.some((item) => item.type === 'function_call' && item.call_id === 'budget-write-2'));
      const rejectedOutputs = resumedInput.filter((item) => item.type === 'function_call_output'
        && item.call_id === 'budget-write-2');
      const rejectedOutputContent = rejectedOutputs[0]?.output;
      assert.equal(rejectedOutputs.length, 1, 'the rejected call must acquire exactly one durable result');
      assert.deepEqual(typeof rejectedOutputContent === 'string'
        ? JSON.parse(rejectedOutputContent.split('\n[HumanAgent evidence refs]')[0]!) : rejectedOutputContent,
        {
          status: 'failed',
          code: 'tool.round-limit',
          executed: false,
          toolId: 'file.write',
          callId: 'budget-write-2',
          message: 'provider tool round limit was exceeded',
        },
        'the rejected call must carry a truthful non-executed failure result');
      assert.equal(resumedInput.some((item) => item.type === 'function_call' && item.call_id === 'budget-write-1'),
        true, 'the accepted call must remain in the resumed context');
      assert.equal(resumedInput.some((item) => item.type === 'function_call_output'
        && item.call_id === 'budget-write-1'), true, 'the accepted result must remain in the resumed context');
      const progress = latestNativeSaveProgress(afterRecords);
      assert.ok(progress, 'the successor turn must commit durable native-save progress');
      if (progress) {
        assert.ok('version' in progress.key && progress.key.version === 2,
          'the successor native save must use a version-2 segment key');
        if ('version' in progress.key && progress.key.version === 2) {
          assert.equal(progress.key.segment.segmentId, successor.segmentId,
            'the native save key must bind the actual successor segment');
          assert.equal(progress.key.turn.turnId, fixture.businessTurnId,
            'the native save key must bind the original business turn');
        }
        assert.equal(progress.key.checkpoint.scope.operationId?.value, fixture.allocation.operationId.value,
          'the native save checkpoint must retain the resumed operation identity');
        assert.deepEqual(progress.phases.filter((phase) => phase.state === 'committed')
          .map((phase) => phase.phase).sort(), [...NATIVE_SAVE_PHASES].sort(),
        'every one of the five native save phases must commit for the successor turn');
        const intentRead = await createJsonlNativeSaveProgressPort({ journal: fixture.journal })
          .readIntentExact?.(progress.key);
        assert.equal(intentRead?.state, 'found',
          'the successor native save must retain its exact immutable intent');
        if (intentRead?.state === 'found' && isNativeSegmentSaveIntentV2(intentRead.intent)) {
          assert.equal(intentRead.intent.key.segment.segmentId, successor.segmentId,
            'the native save intent must bind the actual successor segment');
          assert.equal(intentRead.intent.source.opened.segmentId, successor.segmentId,
            'the native save source must be the actual opened successor segment');
          assert.equal(intentRead.intent.source.opened.businessTurnRef.businessTurnId, fixture.businessTurnId,
            'the native save source must bind the original business turn');
          const semantics = intentRead.intent.contextView.semantics;
          for (const part of [semantics.goal, semantics.actions, semantics.result, semantics.nextStep]) {
            assert.ok(typeof part === 'string' && part.length > 0,
              'the four-part turn summary must carry every section from the successor standard end');
          }
        }
        const nativeReceipt = await createJsonlCheckpointJournal({
          filePath: fixture.journalPath,
          journal: fixture.journal,
        }).readNativeCheckpoint({ checkpoint: progress.key.checkpoint });
        assert.ok(nativeReceipt, 'the successor checkpoint must have a native commit envelope');
        if (nativeReceipt) {
          assert.equal(nativeReceipt.receipt.committedAt, at,
            'the successor checkpoint time must come from the real owner clock');
        }

        const closureCandidates = afterRecords.flatMap((record) => {
          const closure = closureFromRecord(record);
          if (closure === null || !('closureKind' in closure) || closure.closureKind !== 'checkpoint') return [];
          if (record.scope.operationId?.value !== fixture.allocation.operationId.value
            || closure.recoveryBinding?.coreClosure.executionEpoch !== successorEpoch
            || record.commitId === undefined) return [];
          return [{
            closure,
            commitRef: { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest },
          }];
        });
        assert.equal(closureCandidates.length, 1,
          'the successor standard end must commit exactly one checkpoint closure');
        const successorClosure = closureCandidates[0]!;
        const recoveryBinding = successorClosure.closure.recoveryBinding;
        assert.ok(recoveryBinding, 'the successor closure must bind its recovery context');
        if (recoveryBinding) {
          assert.equal(recoveryBinding.coreClosure.executionEpoch, successorEpoch,
            'the successor closure must carry the successor execution epoch');
          const contextRecord = afterRecords.find((record) =>
            record.commitId === recoveryBinding.contextCommitRef.commitId);
          assert.ok(contextRecord, 'the successor closure must reference a committed context record');
          if (contextRecord) {
            const successorContext = contextHistoryFromRecord(contextRecord);
            assert.ok(successorContext, 'the successor closure context must decode through the real owner');
            if (successorContext) {
              assert.equal(successorContext.contextView.executionEpoch, successorEpoch,
                'the successor context must carry the successor execution epoch');
              assert.equal(successorContext.scope.operationId?.value, fixture.allocation.operationId.value,
                'the successor context must retain the resumed operation identity');
            }
          }
        }

        const duties = afterRecords.filter((record) =>
          record.payload?.type === 'closed-turn-planner-call')
          .map((record) => record.payload!.record as ClosedTurnPlannerCallRecord)
          .filter((record) => record.duty.checkpointId.value === progress.key.checkpoint.id.value);
        assert.deepEqual(duties.map((record) => record.stage), ['prepared', 'invoked', 'returned'],
          'the successor closure must reach its own independent Planner return');
        assert.ok(duties.every((record) =>
          record.duty.taskId.value === fixture.taskId.value
          && record.duty.scope.operationId?.value === fixture.allocation.operationId.value
          && record.duty.closureRef === duties[0]!.duty.closureRef),
        'the Planner duty must retain the successor task, operation and closure');
        const returned = duties[2]!;
        assert.equal(returned.stage, 'returned');
        if (returned.stage === 'returned') assert.equal(returned.decision, 'complete');

        const alignmentRecords = afterRecords.flatMap((record) => {
          const closure = closureFromRecord(record);
          if (closure === null || !('closureKind' in closure) || closure.closureKind !== 'planner-alignment') return [];
          if (record.scope.operationId?.value !== fixture.allocation.operationId.value
            || closure.alignment.checkpointId.value !== progress.key.checkpoint.id.value) return [];
          return [closure];
        });
        assert.equal(alignmentRecords.length, 1,
          'the successor Planner return must commit exactly one alignment');
        const alignment = alignmentRecords[0]!;
        assert.equal(alignment.alignment.decision, 'complete');
        assert.equal(alignment.alignment.closureRef, duties[0]!.duty.closureRef,
          'the successor alignment must bind the successor Planner closure');

        const currentState = await createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal })
          .read(fixture.taskScope);
        assert.equal(currentState.state, 'known',
          currentState.state === 'unknown' ? currentState.reason : 'the successor must publish current state');
        if (currentState.state === 'known') {
          assert.equal(currentState.value.task.id.value, fixture.taskId.value,
            'the successor current state must retain the current task identity');
          assert.ok(currentState.value.currentPlan,
            'the successor Planner must publish an authoritative current plan');
        }
        const currentPlan = await readFixturePriorPlan(fixture);
        assert.ok(currentPlan, 'the successor current plan must read back through its exact publication');
        if (currentPlan) {
          assert.equal(currentPlan.revisionId, alignment.alignment.planRevisionId,
            'the successor alignment must bind the authoritative current plan');
          assert.equal(currentPlan.sequence, alignment.alignment.planRevisionSequence);
          assert.equal(currentPlan.contentDigest, alignment.alignment.planContentDigest);
        }
      }

      const projection = app.service.listTasks();
      const completed = [...projection.completed].find((row) =>
        row.taskId.value === fixture.taskId.value);
      assert.ok(completed, 'the successor must publish a completed task projection');
      if (completed) {
        assert.equal(completed.state, 'succeeded');
        assert.equal(completed.currentState, '已完成');
      }
      succeeded = true;
    } finally {
      await writeFile(join(EVIDENCE_ROOT, 'tool-round-limit-wires.json'), JSON.stringify(http.wires, null, 2), 'utf8');
      await writeFile(join(EVIDENCE_ROOT, 'tool-round-limit-fixture.json'), JSON.stringify({ root: fixture.root, succeeded }), 'utf8');
      if (app) await app.close();
      await http.close();
      if (succeeded) await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('public resumeExecution holds with zero generation and zero effects when the current grant denies the resumed incarnation', async () => {
  const fixture = await buildColdFixture('resume-grant-denied');
  const http = await upstream('cold-resume-denied.model', fixture.acceptedEvidenceLocator, fixture);
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
      await writeFile(join(EVIDENCE_ROOT, `failed-${fixture.root.split('/').at(-1)}-wires.json`), JSON.stringify(http.wires, null, 2), 'utf8')
        .catch(() => undefined);
      console.error(`cold-resume fixture retained for evidence at ${fixture.root}`);
    }
  }
});

  test('fresh-process HTTP resume continues an uncaptured initial open turn using canonical composition selector without replaying confirmed effects', async () => {
    const moduleUrl = import.meta.url;
    const compiledPath = moduleUrl.startsWith('file://') ? decodeURIComponent(moduleUrl.slice('file://'.length)) : moduleUrl;
    const seed = spawnColdProcess([compiledPath, '--cold-process=seed', '--fixture-kind=initial-open']);
    const seedRun = await collectColdProcess(seed);
    assert.equal(seedRun.close.code, 0, 'the seed child must exit normally');
    assert.equal(seedRun.close.signal, null, 'the seed child must not be signaled');
    assert.equal(seed.pid, seedRun.receipt.pid, 'the seed receipt PID must be the actual ChildProcess pid');
    assert.ok(seed.pid !== process.pid, 'the seed must run in an independent child process');

    // The resume process starts only after the seed child has closed.
    const root = seedRun.receipt.root;
    const taskId = seedRun.receipt.taskId;
    const resume = spawnColdProcess([compiledPath, '--cold-process=resume', '--fixture-kind=initial-open', '--fixture-root', root, '--task-id', taskId]);
    const resumeRun = await collectColdProcess(resume);
    assert.equal(resumeRun.close.code, 0, 'the resume child must exit normally');
    assert.equal(resumeRun.close.signal, null, 'the resume child must not be signaled');
    assert.equal(resume.pid, resumeRun.receipt.pid, 'the resume receipt PID must be the actual ChildProcess pid');
    assert.ok(resume.pid !== process.pid, 'the resume must run in an independent child process');
    assert.ok(resume.pid !== seed.pid, 'the resume must run in a second independent child process');

    const archiveRoot = resumeRun.receipt.archiveRoot;
    assert.ok(archiveRoot !== undefined, 'the resume child must publish the passed receipt archive');
    await writeFile(join(archiveRoot!, 'process-evidence.json'), JSON.stringify({
      parentPid: process.pid,
      seed: { pid: seed.pid, receiptPid: seedRun.receipt.pid, ppid: seedRun.receipt.ppid,
        code: seedRun.close.code, signal: seedRun.close.signal },
      resume: { pid: resume.pid, receiptPid: resumeRun.receipt.pid, ppid: resumeRun.receipt.ppid,
        code: resumeRun.close.code, signal: resumeRun.close.signal },
      ordering: { seedClosedBeforeResumeSpawned: true },
      fixtureKind: 'initial-open',
    }, null, 2), 'utf8');
    await writeFile(join(archiveRoot!, 'seed-child.log'), seedRun.stdout, 'utf8');
    await writeFile(join(archiveRoot!, 'resume-child.log'), resumeRun.stdout, 'utf8');
    if (seedRun.stderr.length > 0) await writeFile(join(archiveRoot!, 'seed-child.stderr.log'), seedRun.stderr, 'utf8');
    if (resumeRun.stderr.length > 0) await writeFile(join(archiveRoot!, 'resume-child.stderr.log'), resumeRun.stderr, 'utf8');
    await rm(root, { recursive: true, force: true });
  });

  // C3a target behavior. After a committed confirmed control the next fresh turn
  // must allocate strictly above the committed epoch floor, seed from the active
  // context and bind its own turn context receipt. Failure mode: the next turn
  // keeps the old epoch/context receipt. Probability: unknown. Impact: the
  // request is rejected or the closure binds the predecessor context. Cost: the
  // existing fixture, provider wire capture and one scoped start.
  //
  // Observed at candidate base: the bound Service confirmed-control facade
  // reaches the real C1 owner. This rejection case seeds one genuinely
  // outstanding request (dispatched with no terminal phase), so the settled
  // current-incarnation guard still refuses real unsettled work. The retained
  // prepared operation then refuses a plain restart with 'task.busy'. The test
  // records these exact facts and does not loosen either guard.
  test('C3a confirmed-control facade is bound and the existing guards refuse an unsettled prepared fixture', async () => {
    const fixture = await buildColdFixture('c3a-control-blocked', ['original-output'], ['original-target'], false,
      'c3a-control-pending-request');
    const http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture);
    let app: Awaited<ReturnType<typeof buildResumeService>> | undefined;
    let succeeded = false;
    try {
      app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined, true);
      const journalBefore = await readFile(fixture.journalPath, 'utf8');
      const unsettled = readCurrentFromRecords((await fixture.journal.verify()).records,
        { organId, taskId: fixture.taskId });
      assert.equal(unsettled.state, 'known');
      if (unsettled.state !== 'known') throw new Error(unsettled.reason);
      assert.ok(unsettled.unresolvedDisplacedRefs.includes('c3a-control-pending-request'),
        'the rejection case must carry a genuinely outstanding request');
      const checkpoints = createJsonlCheckpointJournal({ filePath: fixture.journalPath, journal: fixture.journal });
      const positionBefore = await checkpoints.readExecutionPosition({ organId, taskId: fixture.taskId });
      assert.equal(positionBefore?.executionEpoch, fixture.allocation.executionEpoch);
      // The Service facade is bound and forwards to the real C1 owner; the owner
      // refuses the unsettled current incarnation without appending anything.
      await assert.rejects(
        () => app!.service.executeConfirmedTaskContextCorrection({
          taskScope: { organId, taskId: fixture.taskId },
          commandId: 'c3a-control-blocked',
          wrongRefs: [{ taskScope: { organId, taskId: fixture.taskId }, ref: 'accepted-prefix' }],
          repairText: 'drop the superseded prefix',
          confirmationRef: 'c3a-control-blocked-confirmation',
        }),
        /confirmed transition requires a settled current incarnation with no unresolved displaced work/,
      );
      assert.equal(await readFile(fixture.journalPath, 'utf8'), journalBefore,
        'a refused confirmed control must append no durable record');
      const positionAfter = await checkpoints.readExecutionPosition({ organId, taskId: fixture.taskId });
      assert.equal(positionAfter?.executionEpoch, positionBefore?.executionEpoch,
        'a refused control must not advance the canonical execution position');
      // The retained prepared operation is not silently restarted as a new turn.
      await assert.rejects(
        () => app!.service.startExecution(fixture.taskId, { prompt: 'next turn input' }),
        (error: unknown) => (error as { readonly code?: string }).code === 'task.busy',
      );
      assert.equal(http.wires.length, 0, 'a refused control and start must issue no provider request');
      succeeded = true;
    } finally {
      try {
        if (app !== undefined) await app.close();
      } finally {
        await http.close();
      }
      if (succeeded) await rm(fixture.root, { recursive: true, force: true });
      else console.error(`c3a blocked fixture retained for evidence at ${fixture.root}`);
    }
  });

  // C3a live floor. The Coordinator must advance its in-memory task execution
  // epoch to the committed confirmed-control epoch and never lower it. Failure
  // mode: a repeated or stale receipt lowers the floor. Probability: unknown.
  // Impact: the next fresh allocation lands at or below a committed control.
  // Cost: the existing fixture and three public Coordinator calls.
  test('C3a Coordinator advances the live execution-epoch floor monotonically', async () => {
    const fixture = await buildColdFixture('c3a-floor');
    const runtime = buildResumeRuntime(fixture, 'http://127.0.0.1:1', 'cold-resume.model');
    const { coordinator } = runtime;
    try {
      const before = coordinator.taskSnapshot(fixture.taskId).executionEpoch;
      assert.equal(before, fixture.allocation.executionEpoch);
      coordinator.synchronizeCommittedExecutionEpoch(fixture.taskId, 5);
      assert.equal(coordinator.taskSnapshot(fixture.taskId).executionEpoch, 5,
        'the committed confirmed-control epoch becomes the live floor');
      // A stale or repeated receipt never lowers the floor.
      coordinator.synchronizeCommittedExecutionEpoch(fixture.taskId, 3);
      coordinator.synchronizeCommittedExecutionEpoch(fixture.taskId, 5);
      assert.equal(coordinator.taskSnapshot(fixture.taskId).executionEpoch, 5,
        'the live execution-epoch floor is monotonic');
    } finally {
      for (const assembly of runtime.assemblies) await assembly.runtimePool.dispose();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  // C3a settled. The original execution must be closed by the real standard
  // tail before a confirmed correction may read the request as settled. Failure
  // mode: an early dispatching/dispatched phase keeps the later settled phase
  // invisible and the guard refuses a lawfully closed incarnation. Probability
  // UNKNOWN. Impact: the N2 confirmed-control chain is unreachable even after a
  // real standard closure. Cost: one existing fixture, one public resume and
  // one public correction.
  test('C3a settled execution reaches a lawful confirmed correction after the real standard tail', async () => {
    const fixture = await buildColdFixture('c3a-settled');
    const http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture);
    let app: Awaited<ReturnType<typeof buildResumeService>> | undefined;
    let succeeded = false;
    try {
      app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined, true);
      const taskScope: ScopeRef = { organId, taskId: fixture.taskId };
      const checkpoints = createJsonlCheckpointJournal({ filePath: fixture.journalPath, journal: fixture.journal });
      const positionBefore = await checkpoints.readExecutionPosition(taskScope);
      assert.equal(positionBefore?.executionEpoch, fixture.allocation.executionEpoch,
        'the fixture starts on the displaced execution epoch');

      // The real public resume awaits the standard tail: closure, Planner
      // alignment and the standard advance, not only the provider dispatch.
      const release = await app.service.resumeExecution(fixture.taskId, {
        operationId: fixture.allocation.operationId,
      });
      assert.equal(release.state, 'released');
      assert.ok(http.wires.length > 0, 'the resumed execution must reach the controlled Provider');

      const records = (await fixture.journal.verify()).records;
      const positionAfter = await checkpoints.readExecutionPosition(taskScope);
      assert.ok(positionAfter !== null, 'the standard tail must commit a canonical execution position');
      assert.equal(positionAfter!.executionEpoch, fixture.allocation.executionEpoch + 1,
        'the standard tail advances the canonical position above the displaced epoch');

      // The original request has an early dispatching/dispatched sequence and a
      // later settled phase. The latest verified phase must win.
      const requestPhases: string[] = [];
      for (const record of decodeActiveTurnRecords(records, fixture.businessTurnId)) {
        if (record.kind !== 'request') continue;
        if (record.record.request.requestId !== 'accepted-tool-request') continue;
        requestPhases.push(record.record.phase);
      }
      assert.deepEqual(requestPhases, ['dispatching', 'dispatched', 'settled'],
        'the fixture records the full request lifecycle before resume');

      const current = readCurrentFromRecords(records, taskScope);
      assert.equal(current.state, 'known');
      if (current.state !== 'known') throw new Error(current.reason);
      assert.ok(!current.unresolvedDisplacedRefs.includes('accepted-tool-request'),
        'a settled request must not remain an unresolved displaced obligation');

      // The public confirmed correction resolves the authoritative current
      // facts, grant and operation control itself. The caller supplies only the
      // confirmed business intent.
      const receipt = await app.service.executeConfirmedTaskContextCorrection({
        taskScope,
        commandId: 'c3a-settled-correction',
        wrongRefs: [{ taskScope: { organId, taskId: fixture.taskId }, ref: 'accepted-prefix' }],
        repairText: 'drop the superseded prefix after the standard tail settled the original turn',
        confirmationRef: 'c3a-settled-confirmation',
      });
      assert.equal(receipt.record.newExecutionEpoch, positionAfter!.executionEpoch + 1,
        'the confirmed correction advances the canonical position');
      assert.ok(!receipt.record.correctedContext.contextView.activeRefs.includes('accepted-prefix'),
        'the confirmed correction removes the wrong active ref');
      assert.ok(receipt.record.correctedContext.contextView.omittedRefs.includes('accepted-prefix'),
        'the confirmed correction retains the wrong ref as omitted');
      const positionCorrected = await checkpoints.readExecutionPosition(taskScope);
      assert.equal(positionCorrected?.executionEpoch, receipt.record.newExecutionEpoch,
        'the committed correction is durable at its new execution epoch');
      console.log(JSON.stringify({
        c3aSettled: {
          release,
          providerWires: http.wires.length,
          requestPhases,
          positionBeforeEpoch: positionBefore?.executionEpoch,
          positionAfterEpoch: positionAfter?.executionEpoch,
          unresolvedBeforeCorrection: current.unresolvedDisplacedRefs,
          correctionCommitId: receipt.commitRef.commitId,
          correctionExecutionEpoch: receipt.record.newExecutionEpoch,
          expectedGrantCommitId: receipt.record.expectedGrantCommitRef.commitId,
          expectedOperationControlCommitId: receipt.record.expectedOperationControlCommitRef.commitId,
          expectedControlCommitId: receipt.record.basis.expectedControlReceipt.commitId,
          expectedContextCommitId: receipt.record.basis.expectedContextReceipt.commitId,
          sourceCheckpointCommitId: receipt.record.basis.sourceCheckpointReceipt.commitId,
          coverageCommitId: receipt.coverageCommitRef.commitId,
          correctedActiveRefs: receipt.record.correctedContext.contextView.activeRefs,
          correctedOmittedRefs: receipt.record.correctedContext.contextView.omittedRefs,
          positionCorrectedEpoch: positionCorrected?.executionEpoch,
        },
      }));
      succeeded = true;
    } finally {
      try {
        if (app !== undefined) await app.close();
      } finally {
        await http.close();
      }
      if (succeeded) await rm(fixture.root, { recursive: true, force: true });
      else console.error(`c3a settled fixture retained for evidence at ${fixture.root}`);
    }
  });

  // Same failure impact as hot, plus cold loss of the committed control floor
  // or lineage. Cost: two sequential child processes over one durable fixture.
  test('C3a fresh process hydrates the confirmed-control floor and closes the next execution', async () => {
    const compiledPath = new URL(import.meta.url).pathname;
    const seed = spawnColdProcess([compiledPath, '--cold-process=c3a-seed']);
    const seeded = await collectColdProcess(seed);
    assert.equal(seeded.close.code, 0, seeded.stderr);
    assert.equal(seeded.close.signal, null);
    assert.equal(seed.pid, seeded.receipt.pid);
    assert.ok(seed.pid !== process.pid);
    // collectColdProcess resolves only after natural close. No control object
    // crosses the boundary; the new PID derives floor and lineage from owners.
    const next = spawnColdProcess([compiledPath, '--cold-process=c3a-next',
      '--fixture-root', seeded.receipt.root, '--task-id', seeded.receipt.taskId]);
    const resumed = await collectColdProcess(next);
    assert.equal(resumed.close.code, 0, resumed.stderr);
    assert.equal(resumed.close.signal, null);
    assert.equal(next.pid, resumed.receipt.pid);
    assert.ok(next.pid !== seed.pid && next.pid !== process.pid);
    assert.equal(resumed.receipt.root, seeded.receipt.root);
    assert.equal(resumed.receipt.taskId, seeded.receipt.taskId);
    const receipt = { seed: { ...seeded.receipt, ...seeded.close },
      next: { ...resumed.receipt, ...resumed.close }, seedClosedBeforeNextSpawned: true };
    await writeFile(join(EVIDENCE_ROOT, 'c3a-process-boundary.json'), JSON.stringify(receipt, null, 2), 'utf8');
    await writeFile(join(EVIDENCE_ROOT, 'c3a-seed-child.log'), seeded.stdout, 'utf8');
    await writeFile(join(EVIDENCE_ROOT, 'c3a-next-child.log'), resumed.stdout, 'utf8');
    console.log(JSON.stringify({ c3aFresh: receipt }));
    await rm(seeded.receipt.root, { recursive: true, force: true });
  });

  // C3a hot. One live Service must carry the real standard tail through
  // Known failure: production composition without driverFor silently uses deterministic
  // analysis. One opt-in consumer case detects that false proof; existing scope tests apply.
  if (process.env.HUMANAGENT_REAL_MEMORY_PROOF === '1') test('C3a production Memory hook audits real-model curation from a confirmed-control boundary', async () => {
    const fixture = await buildColdFixture('c3a-real-memory', ['original-output'], ['original-target'],
      false, undefined, c3aContextSeed);
    const http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture);
    let app: Awaited<ReturnType<typeof buildResumeService>> | undefined;
    let succeeded = false;
    const calls: unknown[] = [];
    const configToml = [
      'schemaVersion = 1',
      '[[agents]]',
      'agentId = "memory-real-proof"',
      'roleId = "memory"',
      'templateRef = "builtin/memory@1.0.0"',
      'driverRef = "rcc"',
      'skills = ["history-search", "novelty-review", "recurrence-review"]',
      'tools = ["memory.search", "memory.ask", "task.history", "session.history"]',
      'permissions = ["task.read", "memory.read", "memory.propose"]',
      'memoryScopes = ["task", "organ"]',
      'resourceClass = "background"',
      'provider.provider = "rcc"',
      'provider.binding = "memory-real-proof"',
      'provider.protocol = "responses"',
      'provider.model = "goaichat.deepseek-v4.1-flash"',
      'provider.route = "default"',
      'provider.baseUrl = "http://127.0.0.1:4444"',
      '',
    ].join('\n');
    try {
      app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined, true, true,
        undefined, { configToml, calls });
      const chain = await runC3aHotChain(app.service, fixture, http);
      const review = await app.memoryRuntime!.reviewState();
      const events = await app.memoryRuntime!.journal.readEvents({
        streamId: `memory-boundaries:task:${fixture.taskId.value}`, afterSequence: 0, limit: 100 });
      await archiveC3aReceipts(fixture, http, { mode: 'real-memory', chain, review, events, calls, analyses: app.memoryAnalyses });
      assert.equal(review.analysis.mode, 'model');
      assert.equal(review.analysis.state, 'succeeded');
      assert.equal(review.autoUpdate, false);
      await assertRealMemoryAudit(fixture, app, calls);
      assert.ok(review.candidates.every((candidate) => candidate.state === 'candidate'));
      assert.ok(review.candidates.every((candidate) => candidate.namespace === 'project'
        && candidate.taskId === fixture.taskId.value && candidate.evidenceRefs.length > 0));
      assert.ok(calls.some((call) => (call as { kind: string }).kind === 'release'));
      const observed = calls as Array<{ kind: string; result?: { state?: string }; event?: { kind: string; terminalState?: string } }>;
      assert.ok(observed.some((call) => call.kind === 'event'
        && (call.event?.kind === 'terminal' || call.event?.kind.endsWith('.terminal'))
        && call.event.terminalState === 'succeeded'), 'the Memory driver must observe an actual successful terminal');
      assert.ok(observed.some((call) => call.kind === 'settle' && call.result?.state === 'succeeded'));
      assert.equal(observed.filter((call) => call.kind === 'release').length,
        observed.filter((call) => call.kind === 'start').length);
      assert.ok(app.memoryAnalyses.some((outcome) => outcome.status === 'ready'
        && outcome.value.result?.curation !== undefined), JSON.stringify(app.memoryAnalyses));
      assert.equal(await readFile(join(fixture.root, 'AGENTS.md'), 'utf8'), '# C3a project memory\n');
      succeeded = true;
    } catch (error) {
      await archiveC3aReceipts(fixture, http, { mode: 'real-memory', root: fixture.root,
        failure: String(error), calls, analyses: app?.memoryAnalyses,
        review: await app?.memoryRuntime?.reviewState() });
      throw error;
    } finally {
      try { await app?.close(); } finally { await http.close(); }
      if (succeeded) await rm(fixture.root, { recursive: true, force: true });
      else console.error(`c3a real Memory fixture retained for evidence at ${fixture.root}`);
    }
  });

  // Failure basis: the old control fixture contains only placeholder experience.
  // Impact: false positive proof or repeated paid analysis. Probability unknown.
  // Cost: one imported real correction, one cold startup, at most one submit.
  if (process.env.HUMANAGENT_REAL_MEMORY_P2B_PROOF === '1') test('C3a P2-b material reaches one startup Memory analysis', async () => {
    const origin = '/Volumes/Intel/playground/humanagent/.worker-runs/native-reasoning-d0-20261012/provider-stop-submit-technical-r8-20261017';
    const documents = await Promise.all(['red.log', 'green.log', 'notes.md', 'result.md'].map(async (name) =>
      `Origin: ${origin}/${name}\n${await readFile(join(origin, name), 'utf8')}`));
    const wrongProposition = '通用 continuation rejection 只保留外层 code/message 已足以保留原拒绝的结构化分类';
    const oldLine = "this.error('tool.continuation.rejected', submitted.error?.message ?? 'provider rejected the tool continuation', 'submit', 'runtime')";
    const newLine = "this.error('tool.continuation.rejected', submitted.error?.message ?? 'provider rejected the tool continuation', 'submit', 'runtime', submitted.error)";
    const limits = '这是公开 Provider consumer 发现的源码错误，不是生产线上故障。生产频率未知；未证明远端副作用；typed receipt 对象 identity 未单独断言；未进行生产安装或真实网络证明。';
    const repairText = `否定命题：${wrongProposition}。621f4014 在 packages/adapters/provider/src/agent-driver.ts 的通用 continuation 拒绝包装中，将 submitted.error 作为 this.error 第五个 cause 参数传递。原代码 ${oldLine}；修复 ${newLine}。原 r8 RED assert.ok(stoppedError) 失败；同入口 GREEN 1 passed、0 failed。适用范围仅此通用拒绝包装。恢复条件：使用已修复的 cause 传递路径；独立 submit/socket 异常仍按原路径抛出；drain、stopped settle、raw 保留及 close 责任继续成立，取消请求不等于停止完成。${limits}\n${documents.join('\n\n')}`;
    const material = `HumanAgent P2-b 真实纠正材料。被否定命题为本 fixture 明确提出的源码判断，不声称历史 agent 逐字说过。\n${repairText}`;
    const wrongRef = 'p2b-wrong-continuation-classification';
    const acceptedRef = 'p2b-621f4014-source-material';
    const fixture = await buildColdFixture('c3a-p2b-memory-source', ['original-output'], ['original-target'],
      false, undefined, { activeRefs: [acceptedRef, wrongRef], omittedRefs: [] },
      { assetId: 'provider-p2b-correction-material', text: material });
    const summary = { goal: '导入并保留已有 P2-b 纠正材料', actions: material,
      result: '已保留原 r8 RED/GREEN 与 cause 修复材料，本轮未重新修复或验证 Provider',
      expectedNextStep: '按正常收口保留纠正依据和恢复责任' };
    let http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture, undefined,
      { original: summary, next: summary });
    let httpClosed = false;
    let app: Awaited<ReturnType<typeof buildResumeService>> | undefined;
    let succeeded = false;
    let actualSubmits = 0;
    const calls: unknown[] = [];
    try {
      app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined, true, false);
      assert.equal((await app.service.resumeExecution(fixture.taskId,
        { operationId: fixture.allocation.operationId })).state, 'released');
      const correction = await app.service.executeConfirmedTaskContextCorrection({ taskScope: fixture.taskScope,
        commandId: 'p2b-memory-source-correction', wrongRefs: [{ taskScope: { organId, taskId: fixture.taskId }, ref: wrongRef }],
        repairText, confirmationRef: 'p2b-memory-source-fixture-confirmation' });
      const recovery = await runNextExecutionAssertions(app.service, fixture, http,
        correction.record.newExecutionEpoch, correction.record.correctedContext, summary.result,
        { accepted: acceptedRef, wrong: wrongRef });
      await app.close(); app = undefined;
      await http.close();
      httpClosed = true;
      const reopened = await reopenColdFixture(fixture.root, fixture.taskId.value, true);
      const committedRecords = (await reopened.journal.verify()).records;
      http = await upstream('cold-resume.model', reopened.acceptedEvidenceLocator, reopened);
      httpClosed = false;
      const configToml = ['schemaVersion = 1', '[[agents]]', 'agentId = "memory-real-proof"',
        'roleId = "memory"', 'templateRef = "builtin/memory@1.0.0"', 'driverRef = "rcc"',
        'skills = ["history-search", "novelty-review", "recurrence-review"]',
        'tools = ["memory.search", "memory.ask", "task.history", "session.history"]',
        'permissions = ["task.read", "memory.read", "memory.propose"]', 'memoryScopes = ["task", "organ"]',
        'resourceClass = "background"', 'provider.provider = "rcc"', 'provider.binding = "memory-real-proof"',
        'provider.protocol = "responses"', 'provider.model = "goaichat.deepseek-v4.1-flash"',
        'provider.route = "default"', 'provider.baseUrl = "http://127.0.0.1:4444"', ''].join('\n');
      app = await buildResumeService(reopened, http.baseUrl, 'cold-resume.model', undefined, true, true,
        undefined, { configToml, calls, beforeSubmit(input) {
          assert.equal(actualSubmits, 0, 'a second actual Memory submit is forbidden');
          assert.deepEqual(input.taskId, fixture.taskId);
          assert.match(input.assignmentId, /^memory-analysis:/);
          const payload = input.payload as { projectKey: string; scope: { projectKey: string }; sources: Array<{ text: string; sourceRef: string }>;
            sourceRefs: string[]; analysisInputs: { corrections: unknown[]; rewindChains: unknown[]; actualPathRefs: string[]; declaredPathRefs: string[] } };
          assert.equal(payload.projectKey, payload.scope.projectKey);
          assert.ok(payload.projectKey.length > 0);
          const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
            : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
          const sourceTexts = payload.sources.flatMap((source) => {
            try { return [source.text, ...strings(JSON.parse(source.text))]; }
            catch (error) { if (error instanceof SyntaxError) return [source.text]; throw error; }
          });
          assert.ok(sourceTexts.some((text) => text.includes(material)), 'committed checkpoint/closure must retain complete material');
          assert.ok(sourceTexts.some((text) => text.includes(repairText)), 'correction must retain complete repair text');
          assert.equal(payload.analysisInputs.corrections.length, 1);
          assert.equal(payload.analysisInputs.rewindChains.length, 1);
          const chain = payload.analysisInputs.rewindChains[0] as { recoveryCheckpointRef: string; reentryFactRef: string };
          const recoverySeq = Number(/^humanagent:\/\/checkpoint-receipt\/(\d+)\//.exec(chain.recoveryCheckpointRef)?.[1]);
          const recoveryRecord = committedRecords.find((record) => record.seq === recoverySeq);
          assert.equal(recoveryRecord?.checkpoint?.scope.operationId?.value, recovery.operationId);
          assert.ok(payload.sources.some((source) => source.sourceRef === chain.reentryFactRef
            && strings(JSON.parse(source.text)).some((text) => text.includes(repairText))));
          assert.ok(payload.analysisInputs.actualPathRefs.length > 0);
          assert.ok(payload.analysisInputs.declaredPathRefs.length > 0);
          assert.ok(payload.analysisInputs.actualPathRefs.every((ref) => !payload.analysisInputs.declaredPathRefs.includes(ref)));
          for (const text of [wrongProposition, 'assert.ok(stoppedError)', oldLine, newLine, limits,
            '# pass 1', '# fail 0', 'submit.stopped', 'evidenceRefs', 'ownerId', 'nextAction', ...documents]) {
            assert.ok(sourceTexts.some((source) => source.includes(text)), `missing source material: ${text.slice(0, 100)}`);
          }
          assert.ok(payload.sources.every((source) => payload.sourceRefs.includes(source.sourceRef)));
          assert.equal(/请生成 candidate|本次应当通过候选验收/.test(material), false);
          actualSubmits++;
        } });
      assert.equal(actualSubmits, 1);
      const audit = await assertRealMemoryAudit(reopened, app, calls);
      const review = await app.memoryRuntime!.reviewState();
      const positive = review.candidates.length > 0;
      await archiveC3aReceipts(reopened, http, { mode: 'p2b-positive', actualSubmits, positive,
        correction, recovery, calls, analyses: app.memoryAnalyses, review, audit });
      console.log(JSON.stringify({ p2bMemory: { actualSubmits, positive, root: fixture.root, review, audit } }));
      assert.ok(positive, 'actual audit is preserved; positive-candidate capability remains UNVERIFIED without a candidate');
      succeeded = true;
    } catch (error) {
      await archiveC3aReceipts(fixture, http, { mode: 'p2b-positive', actualSubmits,
        failure: String(error), calls, analyses: app?.memoryAnalyses, review: await app?.memoryRuntime?.reviewState() });
      throw error;
    } finally {
      try { await app?.close(); } finally { if (!httpClosed) await http.close(); }
      if (succeeded) await rm(fixture.root, { recursive: true, force: true });
      else console.error(`P2-b Memory fixture retained at ${fixture.root}; actual submits=${actualSubmits}`);
    }
  });

  // Correction, exact-target rewind and forward, then close the next execution.
  // Failure: reusing the predecessor closure or resurrecting the corrected ref.
  // Probability UNKNOWN; impact: lost reorientation; cost: controlled Provider/fixture.
  test('C3a hot confirmed-control chain starts and closes the next execution with the corrected context', async () => {
    const fixture = await buildColdFixture('c3a-hot', ['original-output'], ['original-target'],
      false, undefined, c3aContextSeed);
    const http = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator, fixture);
    let app: Awaited<ReturnType<typeof buildResumeService>> | undefined;
    let succeeded = false;
    const memoryFault = { publication: false, diagnostics: false, consume: false };
    try {
      app = await buildResumeService(fixture, http.baseUrl, 'cold-resume.model', undefined, true, true, memoryFault);
      const chain = await runC3aHotChain(app.service, fixture, http);
      const beforeFaultSummary = await c3aHttpMemorySummary(app);
      memoryFault.consume = true;
      memoryFault.diagnostics = true;
      const current = knownCurrent((await fixture.journal.verify()).records, { organId, taskId: fixture.taskId });
      const unaffected = await runNextExecutionAssertions(app.service, fixture, http, chain.next.executionEpoch, current.context,
        'delivered the next execution result');
      const faultSummary = await c3aHttpMemorySummary(app);
      assert.equal(faultSummary.data.state, 'degraded');
      assert.match(faultSummary.data.detail!, /memory-test-consume-failed/);
      assert.match(faultSummary.data.detail!, /original consumer cause/);
      assert.match(faultSummary.data.detail!, /original diagnostic storage rejection/);
      assert.match(faultSummary.data.detail!, /canonical task Journal/);
      const faultState = await app.memoryHooks!.reviewState!();
      assert.ok(faultState.boundaryError?.cause instanceof AggregateError);
      memoryFault.consume = false;
      memoryFault.diagnostics = false;
      const actualReview = await app.memoryRuntime!.reviewState();
      assert.equal(actualReview.analysis.mode, 'deterministic');
      assert.equal(actualReview.autoUpdate, true);
      assert.ok(actualReview.candidates.length > 0);
      assert.ok(actualReview.candidates.every((candidate) => candidate.state === 'candidate'));
      assert.equal(await readFile(join(fixture.root, 'AGENTS.md'), 'utf8'), '# C3a project memory\n');
      const receipt = {
        mode: 'hot',
        pid: process.pid,
        controlFloor: chain.controlFloor,
        resumedPositionEpoch: chain.resumedPositionEpoch,
        correction: {
          commitId: chain.correction.commitRef.commitId,
          newExecutionEpoch: chain.correction.record.newExecutionEpoch,
          targetCheckpointCommitId: chain.correction.record.basis.sourceCheckpointReceipt.commitId,
          activeRefs: chain.correction.record.correctedContext.contextView.activeRefs,
          omittedRefs: chain.correction.record.correctedContext.contextView.omittedRefs,
        },
        rewind: {
          commitId: chain.rewind.commitRef.commitId,
          newExecutionEpoch: chain.rewind.record.newExecutionEpoch,
          targetCheckpointCommitId: chain.rewind.record.sourceCheckpointCommitRef.commitId,
          activeRefs: chain.rewind.record.restoredContext.contextView.activeRefs,
        },
        forward: {
          commitId: chain.forward.commitRef.commitId,
          newExecutionEpoch: chain.forward.record.newExecutionEpoch,
          targetCheckpointCommitId: chain.forward.record.sourceCheckpointCommitRef.commitId,
          activeRefs: chain.forward.record.restoredContext.contextView.activeRefs,
          omittedRefs: chain.forward.record.restoredContext.contextView.omittedRefs,
          durableContext: chain.forward.record.restoredContext.durableContext,
        },
        next: chain.next,
        unaffected,
        beforeFaultSummary,
        faultSummary,
        boundaryError: faultState.boundaryError?.message,
        actualReview,
        attentions: await readJsonlAttentions({ filePath: app.attentionPath }),
      };
      const archiveRoot = await archiveC3aReceipts(fixture, http, receipt);
      console.log(JSON.stringify({ c3aHot: { ...receipt, archiveRoot } }));
      await c3aMemoryEvidence(app, fixture);
      succeeded = true;
    } catch (error) {
      await archiveC3aReceipts(fixture, http, { mode: 'hot', pid: process.pid,
        root: fixture.root, failure: String(error) });
      throw error;
    } finally {
      try {
        if (app !== undefined) await app.close();
      } finally {
        await http.close();
      }
      if (succeeded) await rm(fixture.root, { recursive: true, force: true });
      else console.error(`c3a hot fixture retained for evidence at ${fixture.root}`);
    }
  });
}

if (processMode === 'p2b-audit') {
  // Recheck a retained actual run without constructing any Provider or app.
  // This mode cannot submit, reconcile, publish a boundary or write a Journal.
  const receiptPath = process.env.HUMANAGENT_MEMORY_RECEIPT;
  if (!receiptPath || !processRoot || !processTask) throw new Error('offline audit requires the actual receipt and fixture');
  const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as {
    actualSubmits: number; calls: unknown[];
    analyses: Awaited<ReturnType<typeof buildResumeService>>['memoryAnalyses'];
    review: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof buildResumeService>>['memoryRuntime']>['reviewState']>>;
  };
  assert.equal(saved.actualSubmits, 1);
  const fixture = await reopenColdFixture(processRoot, processTask, true);
  const audit = await assertRealMemoryAudit(fixture, { memoryAnalyses: saved.analyses,
    memoryRuntime: { reviewState: async () => saved.review } }, saved.calls);
  assert.ok(audit.snapshot?.candidates.some((candidate) => candidate.state === 'candidate'));
  await writeFile(join(EVIDENCE_ROOT, 'p2b-offline-audit.json'), JSON.stringify({
    actualSubmits: saved.actualSubmits, positive: true, receiptPath, fixtureRoot: processRoot, audit,
  }, null, 2), 'utf8');
  console.log(JSON.stringify({ actualSubmits: saved.actualSubmits, positive: true, offlineAudit: 'passed', fixtureRoot: processRoot }));
} else if (processMode === 'c3a-seed' || processMode === 'c3a-next') {
  await runC3aProcess();
} else if (processMode === 'seed' || processMode === 'resume') {
  await (processMode === 'seed' ? runSeedProcess() : runResumeProcess());
} else {
  registerPublicConsumers();
}
