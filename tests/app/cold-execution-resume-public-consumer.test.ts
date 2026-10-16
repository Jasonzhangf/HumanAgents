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
  type AcceptedRawFact,
  type ContextHistoryRecord,
  type EvidenceRef,
  type FileWriteEffect,
  type OperationId,
  type PreparedRecoveryCapture,
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
import {
  createJsonlActiveTurnJournal,
  decodeActiveTurnRecords,
} from '../../packages/adapters/jsonl/src/active-turn.js';
import type { ActiveTurnJournalRecord } from '../../packages/runtime/src/context/active-turn-journal.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { ImmutableAssetStore, evidenceReference } from '../../packages/adapters/filesystem/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
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
import { UiRuntimeJournal, FileCheckpointStore } from '../../packages/app/src/ui-runtime/journal.js';
import {
  createJsonlCheckpointJournal,
  createJsonlCheckpointClosurePort,
  createJsonlContextHistoryPort,
  contextHistoryFromRecord,
} from '../../packages/app/src/checkpoint-journal.js';
import { createNativeRecoveryAssets, createActiveTurnSegmentJournal } from '../../packages/app/src/native-recovery-assets.js';
import { createJsonlOperationControlJournal } from '../../packages/app/src/operation-control-journal.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { createJsonlRetryCycleJournalPort } from '../../packages/app/src/retry-cycle-journal.js';
import { readCurrentFromRecords } from '../../packages/app/src/ui-runtime/reentry-current-facts.js';
import { createDefaultExecutionComposition, createServiceExecutionAdmission, ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { UiRuntimeService, FakeReplayExecutionRuntimePort } from '../../packages/app/src/ui-runtime/index.js';
import { createUiRuntimeRequestDispatcher } from '../../packages/app/src/ui-runtime/server.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import type { UiRuntimeServiceOptions } from '../../packages/app/src/ui-runtime/service.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/index.js';
import { ExplicitIntake, MemoryCoordinator, RequirementInbox, type AttentionPort } from '../../packages/runtime/src/index.js';
import { ConfirmationLedger, RequirementSubmissionOwner } from '../../packages/runtime/src/explicit-brain/router.js';
import { createJsonlNativeSaveProgressPort } from '../../packages/adapters/jsonl/src/native-save-progress.js';
import {
  NATIVE_SAVE_PHASES,
  isNativeSegmentSaveIntentV2,
  type NativeSaveProgress,
} from '../../packages/runtime/src/checkpoints/native-save-contract.js';
import { prepareAgentProvider, type AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';
import type { ExplicitBrainInputInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import { AppLifecycleError } from '../../packages/app/src/errors.js';
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
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'i1-initial-source-20261016');
const EVIDENCE_ROOT = process.env.HUMANAGENT_TEST_EVIDENCE_ROOT ?? PERSISTENCE_ROOT;
const at = '2026-10-14T00:00:00.000Z';
const organId = id('organ', 'cold-resume-organ');
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

/**
 * The only process boundary the test owns: a seed child commits the accepted
 * cold fixture, a fresh resume child reopens the same durable owners and calls
 * the public `resumeExecution` selector. No allocation, capture, lease or other
 * in-memory control object ever crosses this boundary; the child receives only
 * the fixture root and the original Task ID and reads every other fact from the
 * committed Journal and immutable assets.
 */
interface ColdProcessReceipt {
  readonly phase: 'seed' | 'resume';
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
    acceptanceCriteriaDigest: digestOf(acceptanceCriteriaContent(criteria)),
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
async function reopenColdFixture(root: string, taskIdValue: string): Promise<ColdFixture> {
  const preparedPath = join(root, 'prepared.jsonl');
  const journalPath = join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'assets');
  const retryPath = join(root, 'retry.jsonl');
  const journal = new JsonlOrganJournal(journalPath);
  const records = (await journal.verify()).records;
  const preparedJournal = new UiRuntimeJournal(preparedPath);
  const prepared = preparedJournal.replay()
    .filter((record) => record.kind === 'operation.prepared')
    .filter((record) => record.allocation.taskId.value === taskIdValue);
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
    && record.payload?.['type'] === 'recovery-assets.phase' && record.payload?.['version'] === 1);
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
    assignment, taskScope: allocation.scope, businessTurnId, predecessor,
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
function resumeProviderPreparer(fixture: ColdFixture, upstreamBaseUrl: string, model: string) {
  const httpProvider: ProviderConfig = { source: 'http', provider: 'http', binding: 'cold-resume-binding',
    protocol: 'responses', model, route: 'cold-resume-route', baseUrl: upstreamBaseUrl };
  const entries: EffectiveAgentProviderBinding[] = [
    { agentId: 'cold-resume-agent', roleId: 'execution', source: 'agent', provider: httpProvider },
    // The post-close Planner selects the real configured `orchestration` role.
    // The same provider/model/route is reused; Planner independence comes from
    // the fresh pool incarnation and its own Provider driver, not a new model.
    { agentId: 'cold-resume-planner', roleId: 'orchestration', source: 'agent', provider: httpProvider }];
  return async (selection: { readonly roleId: 'execution' | 'orchestration' | 'interaction' | 'review' | 'memory';
    readonly configuredAgentId?: string }): Promise<AgentProviderComposition> =>
    prepareAgentProvider({ roleId: selection.roleId,
      ...(selection.configuredAgentId === undefined ? {} : { configuredAgentId: selection.configuredAgentId }),
      agentProviderBindings: entries, legacyProvider: httpProvider, evidenceRoot: fixture.artifactsRoot });
}

function resumeTaskAssembly(
  fixture: ColdFixture,
  assemblies: ResumeAssembly[],
): NonNullable<UiRuntimeServiceOptions['runtimeComposition']>['createTaskAssembly'] {
  return ({ scope, executionAgent, maxAttempts }) => {
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
  };
}

function createResumeComposition(
  fixture: ColdFixture,
  upstreamBaseUrl: string,
  model: string,
  callbacks: ResumeCompositionCallbacks,
) {
  const currentState = createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal });
  const composition = createDefaultExecutionComposition({
    principalOwner: fixture.allocation.ownerId,
    journal: fixture.journal,
    filePath: fixture.journalPath,
    artifactsRoot: fixture.artifactsRoot,
    preparedJournal: fixture.preparedJournal,
    resourceBoundary: createPreparedOperationBoundary(fixture.preparedJournal),
    prepareAgentProvider: resumeProviderPreparer(fixture, upstreamBaseUrl, model),
    providerOptions: {},
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

function buildResumeRuntime(fixture: ColdFixture, upstreamBaseUrl: string, model: string) {
  const now = () => new Date(at);
  let coordinator: RuntimeTaskCoordinator;
  const assemblies: ResumeAssembly[] = [];
  const { composition, currentState } = createResumeComposition(fixture, upstreamBaseUrl, model, {
    publishCurrentTurnState: (taskId) => coordinator.publishCurrentTurnState(taskId),
    closedTurnPlannerPool: (taskId) => coordinator.closedTurnPlannerPool(taskId),
  });
  coordinator = new RuntimeTaskCoordinator({
    organId,
    checkpointStoreFor: () => new ServiceExecutionCheckpointStore(fixture.journalPath, fixture.journal, () => new Date(at)),
    attentionPort: attentionPort(),
    journal: fixture.preparedJournal,
    now,
    currentStatePort: currentState,
    currentStateFacts: composition.currentStateFacts,
    admitExecution: composition.admitExecution,
    createDriver: composition.createExecutionDriver,
    createTaskAssembly: resumeTaskAssembly(fixture, assemblies),
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
) {
  const assemblies: ResumeAssembly[] = [];
  let selectorCalls = 0;
  const service = new UiRuntimeService({
    mode: 'rcc',
    organId,
    binding: serviceBinding,
    port: new FakeReplayExecutionRuntimePort({ binding: serviceBinding, stepDelayMs: 1 }),
    checkpointStoreFor: () => new ServiceExecutionCheckpointStore(fixture.journalPath, fixture.journal, () => new Date(at)),
    attentionPort: attentionPort(),
    providerState: 'ready',
    journal: fixture.preparedJournal,
    closurePort: fixture.preparedJournal,
    memory: testMemory('project-cold-resume-http'),
    explicitBrainInterpreter: unusedExplicitBrainInterpreter,
    runtimeComposition: {
      createTaskAssembly: resumeTaskAssembly(fixture, assemblies),
      createExecutionPorts: (callbacks) => {
        const { composition, currentState } = createResumeComposition(fixture, upstreamBaseUrl, model, callbacks);
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
        };
      },
    },
  });
  const accessControl = await AccessControlService.open({
    credentialPath: join(fixture.root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = accessControl.createPairingChallenge('cold-resume-http', 1);
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0]!;
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
    selectorCallCount: () => selectorCalls,
    close: async () => {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await accessControl.closeCredentialWatch().catch(() => undefined);
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
  const http = await upstream(model, fixture.acceptedEvidenceLocator);
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
  const provider = await upstream('cold-resume.model', fixture.acceptedEvidenceLocator);
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
    await app?.close();
    await provider.close();
    await mkdir(EVIDENCE_ROOT, { recursive: true });
    await writeFile(join(EVIDENCE_ROOT, `http-${fixture.root.split('/').at(-1)}-wires.json`),
      JSON.stringify(provider.wires, null, 2), 'utf8');
  }
}

function registerPublicConsumers(): void {
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
}

if (processMode === 'seed' || processMode === 'resume') {
  await (processMode === 'seed' ? runSeedProcess() : runResumeProcess());
} else {
  registerPublicConsumers();
}
