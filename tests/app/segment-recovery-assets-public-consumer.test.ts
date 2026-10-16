import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  canonicalJsonStringify,
  completionCommitIdentity,
  fileWriteEffectId,
  id,
  type AcceptedRawFact,
  type ActiveTurnBinding,
  type ActiveTurnCaptureBody,
  type CompletionReadInput,
  type EvidenceRef,
  type FileWriteEffect,
  type FileWriteEffectIntent,
  type PreparedRecoveryCapture,
  type RawAsset,
  type RawContentReadPort,
  type RawFactEnvelope,
  type RecoveryHoldFacts,
  type ScopeRef,
  type WorkAssignment,
} from '../../packages/contracts/src/index.js';
import {
  activeTurnSegmentCommitId,
  type ActiveTurnSegmentCaptureV2,
  type ActiveTurnSegmentOpenIntent,
  type PreparedActiveTurnSegmentCaptureV2,
} from '../../packages/contracts/src/active-turn-segments.js';
import type { JournalCommitRef } from '../../packages/contracts/src/i2-history.js';
import type { TaskRuntimeIncarnation } from '../../packages/contracts/src/framework.js';
import type {
  CheckpointControlBusinessRequest,
  CheckpointControlCapabilityRef,
} from '../../packages/contracts/src/checkpoint-controls.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { activeTurnCommitId } from '../../packages/runtime/src/context/active-turn-journal.js';
import { createJsonlActiveTurnJournal } from '../../packages/adapters/jsonl/src/active-turn.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import type { TaskGrantAuthority, TaskGrantRegistrationPort } from '../../packages/runtime/src/admission/task-grant.js';
import { produceAdmittedTurn, type RuntimeBindingSnapshot } from '../../packages/runtime/src/admission/admitted-turn.js';
import { resumeActiveTurnSegment, type ActiveTurnSegmentAdmission } from '../../packages/runtime/src/context/active-turn-segments.js';
import {
  createActiveTurnSegmentJournal,
  createNativeRecoveryAssets,
  segmentCaptureAssetId,
} from '../../packages/app/src/native-recovery-assets.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { ActiveTurnSegmentContext } from '../../packages/runtime/src/context/active-turn-context.js';
import type { ActiveTurnProductionObligationRef } from '../../packages/runtime/src/context/active-turn-live-prefix.js';
import { readResumedSegmentSemanticTurnContext } from '../../packages/runtime/src/context/semantic-turn-context-reader.js';

/**
 * Project rule: durable artifacts live under `~/.humanagent`. This variable is
 * only a sandbox development seam; the formal default stays the canonical root.
 */
const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-segment-journal-v2-r1-20261013');

const organId = id('organ', 'j1-segment-organ');

interface Fixture {
  readonly root: string;
  readonly journalPath: string;
  readonly assetRoot: string;
  readonly completionJournalPath: string;
}

async function withFixture(name: string, fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, `${name}-`));
  try {
    await fn({
      root,
      journalPath: join(root, 'organ.jsonl'),
      assetRoot: join(root, 'assets'),
      completionJournalPath: join(root, 'operation-completion.jsonl'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function evidence(label: string, scope: ScopeRef, digest?: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `j1-segment-${label}`),
    kind: 'operation',
    source: 'j1-segment-test',
    locator: `test://j1-segment/${label}`,
    ...(digest === undefined ? {} : { digest }),
    scope,
  };
}

interface Identity {
  readonly taskId: ReturnType<typeof id<'task'>>;
  readonly scope: ScopeRef;
  readonly runtime: RuntimeBindingSnapshot;
  readonly assignment: WorkAssignment;
  readonly binding: ActiveTurnBinding;
}

function identity(turnId: string): Identity {
  const taskId = id('task', `j1-segment-task-${turnId}`);
  const scope: ScopeRef = {
    organId,
    taskId,
    cycleId: id('cycle', `j1-segment-cycle-${turnId}`),
    operationId: id('operation', `j1-segment-operation-${turnId}`),
  };
  const runtime: RuntimeBindingSnapshot = {
    runtimeId: 'j1-segment-runtime',
    executionEpoch: 1,
    ownerRef: 'j1-segment-owner',
    permissionRevision: 'j1-segment-permission',
  };
  const assignment: WorkAssignment = {
    assignmentId: `j1-segment-assignment-${turnId}`,
    taskId,
    pipelineNodeId: 'j1-segment-node',
    attempt: 1,
    executionEpoch: runtime.executionEpoch,
    inputRevision: 1,
    objective: 'exercise resumed segment cold recovery',
    targetRefs: [`operation://${turnId}/output`],
    expectedOutputRefs: [`operation://${turnId}/output`],
    acceptanceCriteriaDigest: 'sha256:j1-segment-acceptance',
    successCriteria: ['segment recovery assets are committed'],
    failureCriteria: ['segment recovery assets are missing'],
    incompleteCriteria: ['segment recovery assets are unverified'],
    requiredCapabilities: ['provider.execution'],
    mergeGate: 'not-required',
  };
  const admittedTurn = produceAdmittedTurn({
    runtime,
    taskId,
    scope,
    assignment,
    directiveRevision: 1,
    turnId,
    currentTurnRef: `active-turn://${turnId}`,
    admissionEvidence: [evidence('admission', scope)],
    recoveryStateRef: evidence('recovery', scope),
  });
  const binding: ActiveTurnBinding = {
    admittedTurn,
    assignment,
    execution: { runtimeId: runtime.runtimeId, executionEpoch: runtime.executionEpoch },
    scope,
  };
  return { taskId, scope, runtime, assignment, binding };
}

function rawEnvelope(input: {
  readonly binding: ActiveTurnBinding;
  readonly requestId: string;
  readonly producerSeq: number;
}): RawFactEnvelope {
  return {
    execution: input.binding.execution,
    scope: input.binding.scope,
    request: { turnId: input.binding.admittedTurn.turnId, requestId: input.requestId },
    producerSeq: input.producerSeq,
    fact: { kind: 'request-complete', terminal: 'completed' },
  };
}

function acceptedFact(input: {
  readonly binding: ActiveTurnBinding;
  readonly requestId: string;
  readonly producerSeq: number;
  readonly seq: number;
}): AcceptedRawFact {
  return { seq: input.seq, envelope: rawEnvelope(input) };
}

function captureBody(input: {
  readonly binding: ActiveTurnBinding;
  readonly initialInput: RawAsset;
  readonly pauseId: string;
  readonly frozenAt: string;
  readonly requests: ActiveTurnCaptureBody['requests'];
  readonly entries: ActiveTurnCaptureBody['entries'];
}): ActiveTurnCaptureBody {
  const lastSeq = input.entries.length === 0 ? 0 : input.entries[input.entries.length - 1]!.seq;
  return {
    version: 1,
    binding: input.binding,
    initialInput: input.initialInput,
    entries: input.entries,
    requests: input.requests,
    childInvocations: [],
    checkpointPath: [],
    cut: {
      pauseId: input.pauseId,
      lastSeq,
      producersDrained: true,
      frozenAt: input.frozenAt,
    },
    completionRefs: [],
  };
}

function recoveryFacts(input: {
  readonly binding: ActiveTurnBinding;
  readonly unresolvedOperationRefs: readonly string[];
}): RecoveryHoldFacts {
  return {
    commitIdentity: `recovery-hold:v1:${input.binding.admittedTurn.turnId}`,
    laterErrorRefs: [],
    rawTurnRefs: [`active-turn://${input.binding.admittedTurn.turnId}`],
    unresolvedOperationRefs: [...input.unresolvedOperationRefs],
    stages: [{
      stageId: 'recovery-assets',
      state: 'succeeded',
      value: { turnId: input.binding.admittedTurn.turnId },
      evidenceRefs: [],
    }],
    durablePhases: [],
    durableReceiptRefs: [],
    recoveryResponsibilityRef: `recovery://j1-segment/${input.binding.admittedTurn.turnId}`,
  };
}

function incarnationFor(executionEpoch: number, assignment: WorkAssignment): TaskRuntimeIncarnation {
  return {
    runtimeId: 'j1-segment-runtime',
    generation: executionEpoch,
    agentInstanceId: `j1-segment-agent-${executionEpoch}`,
    roleId: 'role-executor',
    taskId: assignment.taskId,
    assignmentId: assignment.assignmentId,
    executionEpoch,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function effectBinding(value: Identity, turnId: string, executionEpoch: number) {
  const toolOperationId = id('operation', `j1-segment-tool-${turnId}`);
  return {
    execution: {
      runtimeId: value.runtime.runtimeId,
      taskId: value.taskId,
      operationId: value.scope.operationId!,
      organId: value.scope.organId,
      cycleId: value.scope.cycleId!,
      executionEpoch,
    },
    scope: {
      organId: value.scope.organId,
      taskId: value.taskId,
      cycleId: value.scope.cycleId!,
      operationId: toolOperationId,
    },
    toolOperationId,
    requestId: `j1-segment-request-${turnId}`,
    callId: `j1-segment-call-${turnId}`,
    continuationRef: `j1-segment-continuation-${turnId}`,
  };
}

async function committedLookup(input: {
  readonly value: Identity;
  readonly turnId: string;
  readonly executionEpoch: number;
  readonly completionJournalPath: string;
}): Promise<CompletionReadInput> {
  const effectValue = effectBinding(input.value, input.turnId, input.executionEpoch);
  const effect: FileWriteEffect = {
    kind: 'file.write',
    effectId: await fileWriteEffectId(effectValue),
    workspaceRef: 'workspace:j1-segment',
    relativePath: `j1-segment/${input.turnId}.txt`,
    inputDigest: `sha256:${'a'.repeat(64)}`,
    expectedContentDigest: `sha256:${'b'.repeat(64)}`,
  };
  const intent: FileWriteEffectIntent = {
    kind: 'operation-effect-intent',
    version: 1,
    binding: effectValue,
    effect,
  };
  const journal = new JsonlOperationCompletionJournal(input.completionJournalPath);
  await journal.commitIntent(intent);
  const discovered = await journal.discoverExactExecution({ execution: effectValue.execution });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]!.commitIdentity, await completionCommitIdentity(effectValue, effect.effectId));
  return discovered[0]!;
}

/**
 * A real TG1 admission: it derives the stable `requestRef` and the full-intent
 * digest, registers the exact reservation through the held transaction, and
 * returns the real grant and registration commits. It never fabricates a commit.
 */
function segmentAdmission(input: {
  readonly taskId: Identity['taskId'];
  readonly scope: ScopeRef;
  readonly grantJournal: JsonlTaskGrantJournal;
}): (intent: ActiveTurnSegmentOpenIntent) => Promise<ActiveTurnSegmentAdmission> {
  return async (intent: ActiveTurnSegmentOpenIntent): Promise<ActiveTurnSegmentAdmission> => {
    const requestRef = `segment-open:${intent.businessTurnRef.businessTurnId}:${intent.segmentId}`;
    const digest = `sha256:${await sha256Hex(canonicalJsonStringify(intent))}`;
    const request: CheckpointControlBusinessRequest = {
      requestRef,
      taskId: input.taskId,
      owner: 'j1-segment-owner',
      capability: {
        actionId: 'checkpoint.save',
        capabilities: ['provider.execution'],
        scope: input.scope,
      },
      inputIdentity: { requestRef, digest },
    };
    try {
      const registrationCommit = await input.grantJournal.withAuthorizedNewBusiness(
        request,
        async (authority: TaskGrantAuthority, registration: TaskGrantRegistrationPort) =>
          await registration.registerBusiness({
            requestRef,
            taskId: request.taskId,
            owner: request.owner,
            capability: request.capability,
            inputIdentity: request.inputIdentity,
            grantRevision: authority.grant.revision,
          }),
      );
      const authorityCommitRef = (await input.grantJournal.readTaskGrant(request.taskId)).commit;
      if (authorityCommitRef === null) throw new Error('grant readback is missing its commit');
      return {
        authorized: true,
        authorityCommitRef,
        businessRegistrationCommitRef: registrationCommit,
        requestRef,
        inputIdentity: request.inputIdentity,
      };
    } catch (error) {
      return { authorized: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
}

const COLD_SEGMENT_READ_SCRIPT = `
const { pathToFileURL } = await import('node:url');
const [appModulePath, journalPath, assetRoot, completionJournalPath, businessTurnId, segmentId, receiptRef] = process.argv.slice(1);
const { createActiveTurnSegmentJournal } = await import(pathToFileURL(appModulePath).href);
const port = createActiveTurnSegmentJournal({ journalPath, assetRoot, completionJournalPath, businessTurnId });
const readback = await port.readSegmentCaptureExact({ businessTurnId, segmentId, recoveryAssetsReceiptRef: receiptRef });
process.stdout.write(JSON.stringify({
  receiptRef: readback.receipt.commitIdentity,
  segmentId: readback.prepared.body.segmentId,
  businessTurnId: readback.prepared.body.businessTurnRef.businessTurnId,
  predecessorSegmentId: readback.prepared.body.predecessor.segmentId,
  predecessorReceiptRef: readback.prepared.body.predecessor.recoveryAssetsReceiptRef,
  pauseId: readback.prepared.body.cut.pauseId,
  controlRecordCount: readback.prepared.controlRecordCount,
  completionStates: readback.completions.map((entry) => entry.readback.state),
  drainBoundary: readback.prepared.producerDrains[0]?.boundaryId ?? null,
  recoveryResponsibilityRef: readback.prepared.recovery.recoveryResponsibilityRef,
}));
`;

function runColdSegmentRead(input: {
  readonly journalPath: string;
  readonly assetRoot: string;
  readonly completionJournalPath: string;
  readonly businessTurnId: string;
  readonly segmentId: string;
  readonly receiptRef: string;
}): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const appModulePath = join(process.cwd(), 'dist', 'tests', 'packages', 'app', 'src', 'native-recovery-assets.js');
  const args = [
    '--input-type=module',
    '--eval',
    COLD_SEGMENT_READ_SCRIPT,
    appModulePath,
    input.journalPath,
    input.assetRoot,
    input.completionJournalPath,
    input.businessTurnId,
    input.segmentId,
    input.receiptRef,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('J1 v2 backing: original v1 capture, real TG1 reservation to S1/S2, fresh cold reentry, and zero-effect rejects', async () => {
  await withFixture('segment-chain', async ({ journalPath, assetRoot, completionJournalPath }) => {
    const turnId = 'business-turn-segment-1';
    const value = identity(turnId);
    const rawInput = 'original raw input \u4e16\u754c \t stays exact';

    // Original admitted turn: real binding + initial input + v1 capture.
    const initialNative = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const initialInput = await initialNative.writeInitialInput({ scope: value.scope, turnId, rawInput });
    const initialJournal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
    await initialJournal.append({
      commitId: activeTurnCommitId(turnId, 'binding-opened'),
      record: { kind: 'binding-opened', binding: value.binding, currentTurnRef: value.binding.admittedTurn.currentTurnRef },
    });
    await initialJournal.append({
      commitId: activeTurnCommitId(turnId, 'initial-input'),
      record: { kind: 'initial-input', content: initialInput },
    });

    const requestId = `j1-segment-request-${turnId}`;
    const body = captureBody({
      binding: value.binding,
      initialInput,
      pauseId: `boundary-original-${turnId}`,
      frozenAt: '2026-10-13T00:00:00.000Z',
      requests: [{ request: { turnId, requestId }, scope: value.scope, phase: 'dispatched' }],
      entries: [acceptedFact({ binding: value.binding, requestId, producerSeq: 1, seq: 1 })],
    });
    const originalPrepared: PreparedRecoveryCapture = {
      body,
      controlRecordCount: 3,
      producerDrains: [{
        execution: value.binding.execution,
        boundaryId: `boundary-original-${turnId}`,
        requests: [{ request: { turnId, requestId }, lastProducerSeq: 1 }],
      }],
      completionLookups: [],
      recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [] }),
    };
    const originalV1Receipt = await initialNative.commitCapturePhase({
      turnId,
      boundaryId: `boundary-original-${turnId}`,
      prepared: originalPrepared,
    });
    const journalBytesBeforeSegments = await readFile(journalPath, 'utf8');

    // Exact read of the original v1 capture: real binding record seq/digest/commitId.
    const port = createActiveTurnSegmentJournal({ journalPath, assetRoot, completionJournalPath, businessTurnId: turnId });
    const initial = await port.readInitialSegmentCapture(turnId);
    if (initial === null) throw new Error('the original v1 capture must be readable');
    assert.equal(initial.bindingCommitRef.commitId, `active-turn:${turnId}:binding-opened`);
    assert.deepEqual(initial.body, body);
    const bindingRecord = (await new JsonlOrganJournal(journalPath).replay())
      .find((record) => record.commitId === `active-turn:${turnId}:binding-opened`);
    if (bindingRecord === undefined) throw new Error('the binding-opened record must be committed');
    assert.equal(initial.bindingCommitRef.journalSeq, bindingRecord.seq, 'binding commit seq comes from the actual Journal record');
    assert.equal(initial.bindingCommitRef.recordDigest, bindingRecord.recordDigest, 'binding commit digest comes from the actual Journal record');
    assert.equal((await port.readSegments(turnId)).length, 0);

    // Real TG1 grant; the reservation for each segment is a real held-transaction registration.
    const grantJournal = new JsonlTaskGrantJournal(new JsonlOrganJournal(journalPath));
    const capability: CheckpointControlCapabilityRef = {
      actionId: 'checkpoint.save',
      capabilities: ['provider.execution'],
      scope: value.scope,
    };
    const granted = await grantJournal.grant({
      requestId: `grant-${turnId}-1`,
      taskId: value.taskId,
      owner: 'j1-segment-owner',
      capability,
      expectedRevision: 0,
    });
    assert.equal(granted.grant?.state, 'granted');
    const admit = segmentAdmission({ taskId: value.taskId, scope: value.scope, grantJournal });

    // S1: real reservation -> segment-opened, predecessor is the derived initial segment.
    const segmentId1 = 'segment-s1';
    const s1 = await resumeActiveTurnSegment({
      businessTurnId: turnId,
      segmentId: segmentId1,
      assignment: value.assignment,
      scope: value.scope,
      incarnation: incarnationFor(2, value.assignment),
      ports: { read: port, append: port },
      admit,
    });
    assert.equal(s1.status, 'resumed');
    if (s1.status !== 'resumed') return;
    assert.equal(s1.segment.predecessor.segmentId, turnId);
    assert.equal(s1.segment.predecessor.recoveryAssetsReceiptRef, originalV1Receipt.commitIdentity, 'S1 links the real v1 receipt, not the binding commit');
    assert.ok(
      s1.segment.authorityCommitRef.commitId !== s1.segment.businessRegistrationCommitRef.commitId,
      'grant and registration commits are distinct',
    );
    assert.equal(s1.segment.binding.execution.executionEpoch, 2);
    assert.equal(s1.segment.binding.incarnation.agentInstanceId, 'j1-segment-agent-2');
    assert.equal(s1.appendReceipt.commitId, activeTurnSegmentCommitId(segmentId1, 'segment-opened'));

    // Save S1 with the real segment body, drains, completion lookup and asset.
    const s1Lookup = await committedLookup({ value, turnId, executionEpoch: 2, completionJournalPath });
    const s1Entry = acceptedFact({
      binding: { ...value.binding, execution: s1.segment.binding.execution },
      requestId,
      producerSeq: 2,
      seq: 1,
    });
    const s1Body: ActiveTurnSegmentCaptureV2 = {
      version: 2,
      segmentId: segmentId1,
      businessTurnRef: s1.segment.businessTurnRef,
      binding: s1.segment.binding,
      initialInput,
      entries: [s1Entry],
      requests: [{ request: { turnId, requestId }, scope: value.scope, phase: 'dispatched' }],
      childInvocations: [],
      cut: { pauseId: `boundary-s1-${turnId}`, lastSeq: 1, producersDrained: true, frozenAt: '2026-10-13T00:01:00.000Z' },
      predecessor: s1.segment.predecessor,
    };
    const s1Prepared: PreparedActiveTurnSegmentCaptureV2 = {
      body: s1Body,
      controlRecordCount: 4,
      producerDrains: [{
        execution: s1.segment.binding.execution,
        boundaryId: `boundary-s1-${turnId}`,
        requests: [{ request: { turnId, requestId }, lastProducerSeq: 2 }],
      }],
      completionLookups: [s1Lookup],
      recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [s1Lookup.commitIdentity] }),
    };
    const s1Receipt = await initialNative.writeSegmentCapturePhase({
      businessTurnId: turnId,
      segmentId: segmentId1,
      boundaryId: `boundary-s1-${turnId}`,
      prepared: s1Prepared,
    });
    assert.ok(s1Receipt.commitIdentity.startsWith('recovery-assets:v2:'));
    assert.equal(s1Receipt.businessTurnId, turnId);
    assert.equal(s1Receipt.segmentId, segmentId1);
    assert.equal(s1Receipt.boundaryId, `boundary-s1-${turnId}`);
    assert.equal(s1Receipt.capture.ref.digest?.startsWith('sha256:'), true);

    // Fresh process exact cold read of S1 (real asset + real completion lookup).
    const cold = await runColdSegmentRead({
      journalPath,
      assetRoot,
      completionJournalPath,
      businessTurnId: turnId,
      segmentId: segmentId1,
      receiptRef: s1Receipt.commitIdentity,
    });
    assert.equal(cold.code, 0, `fresh segment cold read exited ${String(cold.code)}; stderr=${cold.stderr.slice(-600)}`);
    const parsed = JSON.parse(cold.stdout.trim()) as {
      readonly receiptRef: string;
      readonly segmentId: string;
      readonly businessTurnId: string;
      readonly predecessorSegmentId: string;
      readonly predecessorReceiptRef: string;
      readonly pauseId: string;
      readonly controlRecordCount: number;
      readonly completionStates: readonly string[];
      readonly drainBoundary: string | null;
      readonly recoveryResponsibilityRef: string;
    };
    assert.equal(parsed.receiptRef, s1Receipt.commitIdentity);
    assert.equal(parsed.segmentId, segmentId1);
    assert.equal(parsed.businessTurnId, turnId);
    assert.equal(parsed.predecessorSegmentId, turnId);
    assert.equal(parsed.predecessorReceiptRef, originalV1Receipt.commitIdentity);
    assert.equal(parsed.pauseId, `boundary-s1-${turnId}`);
    assert.equal(parsed.controlRecordCount, 4);
    assert.deepEqual(parsed.completionStates, ['unknown'], 'an intent without a completion stays reconcile-only');
    assert.equal(parsed.drainBoundary, `boundary-s1-${turnId}`);
    assert.equal(parsed.recoveryResponsibilityRef, s1Prepared.recovery.recoveryResponsibilityRef);

    // S2 resumes S1 through the real v2 predecessor receipt.
    const segmentId2 = 'segment-s2';
    const s2 = await resumeActiveTurnSegment({
      businessTurnId: turnId,
      segmentId: segmentId2,
      assignment: value.assignment,
      scope: value.scope,
      incarnation: incarnationFor(3, value.assignment),
      ports: { read: port, append: port },
      admit,
    });
    assert.equal(s2.status, 'resumed');
    if (s2.status !== 'resumed') return;
    assert.equal(s2.segment.predecessor.segmentId, segmentId1);
    assert.equal(s2.segment.predecessor.recoveryAssetsReceiptRef, s1Receipt.commitIdentity, 'S2 links the real S1 v2 receipt');
    assert.equal(s2.segment.binding.execution.executionEpoch, 3);
    assert.deepEqual((await port.readSegments(turnId)).map((segment) => segment.segmentId), [segmentId1, segmentId2]);

    // Wrong reservation: a real registration commit bound to a different
    // requestRef/digest must not open the segment and must write nothing.
    const bytesBeforeRejects = await readFile(journalPath, 'utf8');
    await assert.rejects(
      () => port.appendSegmentOpened({
        commitId: activeTurnSegmentCommitId('segment-foreign', 'segment-opened'),
        record: {
          ...s1.segment,
          segmentId: 'segment-foreign',
          predecessor: { segmentId: segmentId2, recoveryAssetsReceiptRef: s1Receipt.commitIdentity },
          requestRef: 'segment-open:foreign:other',
          inputIdentity: { requestRef: 'segment-open:foreign:other', digest: `sha256:${'e'.repeat(64)}` },
          businessRegistrationCommitRef: s1.segment.businessRegistrationCommitRef,
        },
      }),
      /registration requestRef does not match the segment intent/,
    );
    assert.equal(await readFile(journalPath, 'utf8'), bytesBeforeRejects, 'a wrong reservation writes nothing');

    // Foreign segment: a receipt for S1 must not cold-read as another segment.
    await assert.rejects(
      () => port.readSegmentCaptureExact({
        businessTurnId: turnId,
        segmentId: 'segment-foreign',
        recoveryAssetsReceiptRef: s1Receipt.commitIdentity,
      }),
      /segment capture receipt does not match the requested business turn and segment/,
    );

    // Unknown selector: an uncommitted receipt keeps the recovery obligation.
    await assert.rejects(
      () => port.readSegmentCaptureExact({
        businessTurnId: turnId,
        segmentId: segmentId1,
        recoveryAssetsReceiptRef: 'recovery-assets:v2:0000000000000000000000000000000000000000000000000000000000000000',
      }),
      /segment recovery-assets receipt is not committed/,
    );

    // Invalid drain: a v2 save whose drain epoch does not belong to the segment
    // rejects with zero effects.
    await assert.rejects(
      () => initialNative.writeSegmentCapturePhase({
        businessTurnId: turnId,
        segmentId: segmentId2,
        boundaryId: `boundary-s2-${turnId}`,
        prepared: {
          ...s1Prepared,
          body: {
            ...s1Body,
            segmentId: segmentId2,
            cut: { ...s1Body.cut, pauseId: `boundary-s2-${turnId}` },
            predecessor: { segmentId: segmentId1, recoveryAssetsReceiptRef: s1Receipt.commitIdentity },
          },
          producerDrains: [{
            execution: { runtimeId: 'j1-segment-runtime', executionEpoch: 99 },
            boundaryId: `boundary-s2-${turnId}`,
            requests: [{ request: { turnId, requestId }, lastProducerSeq: 2 }],
          }],
        },
      }),
      /does not belong to this segment boundary and execution/,
    );

    // The original v1 records and the v1 receipt bytes are unchanged.
    const finalBytes = await readFile(journalPath, 'utf8');
    assert.equal(finalBytes.slice(0, journalBytesBeforeSegments.length), journalBytesBeforeSegments, 'the original v1 journal prefix is byte-stable');
    const rereadOriginal = await initialNative.readRecoveryAssetsExact(originalV1Receipt.commitIdentity);
    assert.deepEqual(rereadOriginal.prepared.body, body, 'the original v1 capture is unchanged');
  });
});

test('J1 v2 backing: an opened-but-unsaved predecessor resumes from its exact anchor and keeps the pending obligation', async () => {
  await withFixture('segment-interrupted', async ({ journalPath, assetRoot, completionJournalPath }) => {
    const turnId = 'business-turn-interrupted-1';
    const value = identity(turnId);
    const rawInput = 'interrupted raw input \u4e16\u754c';
    const native = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const initialInput = await native.writeInitialInput({ scope: value.scope, turnId, rawInput });
    const initialJournal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
    await initialJournal.append({ commitId: activeTurnCommitId(turnId, 'binding-opened'),
      record: { kind: 'binding-opened', binding: value.binding, currentTurnRef: value.binding.admittedTurn.currentTurnRef } });
    await initialJournal.append({ commitId: activeTurnCommitId(turnId, 'initial-input'), record: { kind: 'initial-input', content: initialInput } });
    const requestId = `j1-segment-request-${turnId}`;
    const body = captureBody({ binding: value.binding, initialInput, pauseId: `boundary-original-${turnId}`,
      frozenAt: '2026-10-13T00:00:00.000Z',
      requests: [{ request: { turnId, requestId }, scope: value.scope, phase: 'dispatched' }],
      entries: [acceptedFact({ binding: value.binding, requestId, producerSeq: 1, seq: 1 })] });
    await native.commitCapturePhase({ turnId, boundaryId: `boundary-original-${turnId}`,
      prepared: { body, controlRecordCount: 3,
        producerDrains: [{ execution: value.binding.execution, boundaryId: `boundary-original-${turnId}`,
          requests: [{ request: { turnId, requestId }, lastProducerSeq: 1 }] }],
        completionLookups: [], recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [] }) } });
    const grantJournal = new JsonlTaskGrantJournal(new JsonlOrganJournal(journalPath));
    await grantJournal.grant({ requestId: `grant-${turnId}-1`, taskId: value.taskId, owner: 'j1-segment-owner',
      capability: { actionId: 'checkpoint.save', capabilities: ['provider.execution'], scope: value.scope }, expectedRevision: 0 });
    const admit = segmentAdmission({ taskId: value.taskId, scope: value.scope, grantJournal });
    const port = createActiveTurnSegmentJournal({ journalPath, assetRoot, completionJournalPath, businessTurnId: turnId });

    // S1 opens against the real v1 receipt and appends one pending dispatch
    // record. It never commits a v2 recovery receipt, so the segment stays open.
    const s1 = await resumeActiveTurnSegment({ businessTurnId: turnId, segmentId: 'segment-s1',
      assignment: value.assignment, scope: value.scope, incarnation: incarnationFor(2, value.assignment),
      ports: { read: port, append: port }, admit });
    assert.equal(s1.status, 'resumed');
    if (s1.status !== 'resumed') return;
    const pendingCommit = activeTurnSegmentCommitId('segment-s1', `request:${requestId}:dispatching`);
    await port.appendSegmentRecord({ businessTurnId: turnId, segmentId: 'segment-s1', commitId: pendingCommit,
      record: { kind: 'request', record: { request: { turnId, requestId }, scope: value.scope, phase: 'dispatching' } } });

    // Strict absence: no v2 receipt exists, so S1 classifies as interrupted at
    // its real opened commit and last committed record, not as a saved capture.
    const classified = await port.readSegmentRecoveryReceipt('segment-s1');
    assert.equal(classified.status, 'interrupted');
    if (classified.status !== 'interrupted') return;
    const records = await new JsonlOrganJournal(journalPath).replay();
    const openedRecord = records.find((record) => record.commitId === activeTurnSegmentCommitId('segment-s1', 'segment-opened'));
    const pendingRecord = records.find((record) => record.commitId === pendingCommit);
    if (openedRecord === undefined || pendingRecord === undefined) throw new Error('S1 records must be committed');
    assert.equal(classified.anchor.openedCommitRef.commitId, openedRecord.commitId);
    assert.equal(classified.anchor.openedCommitRef.journalSeq, openedRecord.seq);
    assert.equal(classified.anchor.recordsThroughCommitRef.commitId, pendingRecord.commitId);

    // S2 resumes S1 through the exact interrupted anchor, not a receipt.
    const s2 = await resumeActiveTurnSegment({ businessTurnId: turnId, segmentId: 'segment-s2',
      assignment: value.assignment, scope: value.scope, incarnation: incarnationFor(3, value.assignment),
      ports: { read: port, append: port }, admit });
    assert.equal(s2.status, 'resumed');
    if (s2.status !== 'resumed') return;
    assert.equal(s2.segment.predecessor.segmentId, 'segment-s1');
    assert.equal(s2.segment.binding.execution.executionEpoch, 3);
    assert.deepEqual(s2.segment.predecessor.interrupted, classified.anchor,
      'S2 links the real interrupted anchor rather than a fabricated receipt');
    assert.deepEqual((await port.readSegments(turnId)).map((segment) => segment.segmentId), ['segment-s1', 'segment-s2']);

    // A retired predecessor accepts no new record; the successor epoch never
    // re-opens or re-issues the pending dispatch.
    await assert.rejects(() => port.appendSegmentRecord({ businessTurnId: turnId, segmentId: 'segment-s1',
      commitId: activeTurnSegmentCommitId('segment-s1', 'request:late:dispatching'),
      record: { kind: 'request', record: { request: { turnId, requestId: 'late' }, scope: value.scope, phase: 'dispatching' } } }),
      /fenced/);

    // A stale anchor that does not name the committed record tail rejects.
    await assert.rejects(() => port.readSegmentInterruptedExact({ businessTurnId: turnId,
      predecessor: { segmentId: 'segment-s1', interrupted: { openedCommitRef: classified.anchor.openedCommitRef,
        recordsThroughCommitRef: classified.anchor.openedCommitRef } } }),
      /anchor does not match/);

    // The reader folds the original v1, the interrupted S1 and the live S2, and
    // keeps S1's pending request as a segment-scoped obligation.
    const rawContent: RawContentReadPort = { async read({ content }) {
      return await new ImmutableAssetStore(assetRoot).readEvidence(content.ref);
    } };
    const live = await (await ActiveTurnSegmentContext.open({ port, segment: s2.segment, initialInput })).readLivePrefix();
    const resolved = await readResumedSegmentSemanticTurnContext({
      history: { async readCommittedSemanticCheckpoint() { return null; } },
      priorCompletedTurns: [],
      segment: { chain: { businessTurnRef: s2.segment.businessTurnRef, initial: body, segments: [s1.segment, s2.segment] },
        exactReads: port, live: { prefix: live, rawContent } },
      runtimeId: value.runtime.runtimeId, scope: value.scope, assignment: value.assignment,
    });
    const pending = resolved.obligations.filter(
      (obligation): obligation is Extract<ActiveTurnProductionObligationRef, { readonly kind: 'request' }> =>
        obligation.kind === 'request');
    assert.equal(pending.length, 1, 'the interrupted segment keeps exactly one pending request');
    assert.equal(pending[0]?.requestId, requestId);
    assert.equal(pending[0]?.segmentId, 'segment-s1', 'the obligation keeps its originating segment');
    assert.equal(live.obligations.length, 0, 'the successor live prefix owes nothing of its own');
  });
});

test('J1 v2 backing: a partial v2 phase never classifies as interrupted', async () => {
  await withFixture('segment-partial-receipt', async ({ journalPath, assetRoot, completionJournalPath }) => {
    const turnId = 'business-turn-partial-1';
    const value = identity(turnId);
    const native = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const initialInput = await native.writeInitialInput({ scope: value.scope, turnId, rawInput: 'partial raw input' });
    const initialJournal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
    await initialJournal.append({ commitId: activeTurnCommitId(turnId, 'binding-opened'),
      record: { kind: 'binding-opened', binding: value.binding, currentTurnRef: value.binding.admittedTurn.currentTurnRef } });
    await initialJournal.append({ commitId: activeTurnCommitId(turnId, 'initial-input'), record: { kind: 'initial-input', content: initialInput } });
    const body = captureBody({ binding: value.binding, initialInput, pauseId: `boundary-original-${turnId}`,
      frozenAt: '2026-10-13T00:00:00.000Z', requests: [], entries: [] });
    await native.commitCapturePhase({ turnId, boundaryId: `boundary-original-${turnId}`,
      prepared: { body, controlRecordCount: 2, producerDrains: [], completionLookups: [],
        recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [] }) } });
    const grantJournal = new JsonlTaskGrantJournal(new JsonlOrganJournal(journalPath));
    await grantJournal.grant({ requestId: `grant-${turnId}-1`, taskId: value.taskId, owner: 'j1-segment-owner',
      capability: { actionId: 'checkpoint.save', capabilities: ['provider.execution'], scope: value.scope }, expectedRevision: 0 });
    const admit = segmentAdmission({ taskId: value.taskId, scope: value.scope, grantJournal });
    const port = createActiveTurnSegmentJournal({ journalPath, assetRoot, completionJournalPath, businessTurnId: turnId });
    const s1 = await resumeActiveTurnSegment({ businessTurnId: turnId, segmentId: 'segment-s1',
      assignment: value.assignment, scope: value.scope, incarnation: incarnationFor(2, value.assignment),
      ports: { read: port, append: port }, admit });
    assert.equal(s1.status, 'resumed');
    if (s1.status !== 'resumed') return;

    // A v2 phase record in this business turn that names no readable segment
    // cannot be attributed, so it fails instead of classifying S1 as unsaved.
    await new JsonlOrganJournal(journalPath).append({ commitId: 'recovery-assets:v2:partial', kind: 'event', scope: value.scope,
      payload: { type: 'recovery-assets.phase', version: 2,
        receipt: { receiptRef: 'recovery-assets:v2:partial', businessTurnId: turnId } } });
    await assert.rejects(() => port.readSegmentRecoveryReceipt('segment-s1'),
      /names no readable segment|readable receipt payload/);
  });
});

test('J1 v2 backing: a valid receipt whose capture asset is gone is exact, never interrupted', async () => {
  await withFixture('segment-missing-asset', async ({ journalPath, assetRoot, completionJournalPath }) => {
    const turnId = 'business-turn-missing-asset-1';
    const value = identity(turnId);
    const native = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const initialInput = await native.writeInitialInput({ scope: value.scope, turnId, rawInput: 'missing asset raw input' });
    const initialJournal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
    await initialJournal.append({ commitId: activeTurnCommitId(turnId, 'binding-opened'),
      record: { kind: 'binding-opened', binding: value.binding, currentTurnRef: value.binding.admittedTurn.currentTurnRef } });
    await initialJournal.append({ commitId: activeTurnCommitId(turnId, 'initial-input'), record: { kind: 'initial-input', content: initialInput } });
    const body = captureBody({ binding: value.binding, initialInput, pauseId: `boundary-original-${turnId}`,
      frozenAt: '2026-10-13T00:00:00.000Z', requests: [], entries: [] });
    await native.commitCapturePhase({ turnId, boundaryId: `boundary-original-${turnId}`,
      prepared: { body, controlRecordCount: 2, producerDrains: [], completionLookups: [],
        recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [] }) } });
    const grantJournal = new JsonlTaskGrantJournal(new JsonlOrganJournal(journalPath));
    await grantJournal.grant({ requestId: `grant-${turnId}-1`, taskId: value.taskId, owner: 'j1-segment-owner',
      capability: { actionId: 'checkpoint.save', capabilities: ['provider.execution'], scope: value.scope }, expectedRevision: 0 });
    const admit = segmentAdmission({ taskId: value.taskId, scope: value.scope, grantJournal });
    const port = createActiveTurnSegmentJournal({ journalPath, assetRoot, completionJournalPath, businessTurnId: turnId });
    const s1 = await resumeActiveTurnSegment({ businessTurnId: turnId, segmentId: 'segment-s1',
      assignment: value.assignment, scope: value.scope, incarnation: incarnationFor(2, value.assignment),
      ports: { read: port, append: port }, admit });
    assert.equal(s1.status, 'resumed');
    if (s1.status !== 'resumed') return;

    const boundaryId = `boundary-s1-${turnId}`;
    const s1Body: ActiveTurnSegmentCaptureV2 = { version: 2, segmentId: 'segment-s1',
      businessTurnRef: s1.segment.businessTurnRef, binding: s1.segment.binding, initialInput,
      entries: [], requests: [], childInvocations: [],
      cut: { pauseId: boundaryId, lastSeq: 0, producersDrained: true, frozenAt: '2026-10-13T00:01:00.000Z' },
      predecessor: s1.segment.predecessor };
    const s1Receipt = await native.writeSegmentCapturePhase({ businessTurnId: turnId, segmentId: 'segment-s1', boundaryId,
      prepared: { body: s1Body, controlRecordCount: 4, producerDrains: [], completionLookups: [],
        recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [] }) } });
    await rm(join(assetRoot, segmentCaptureAssetId(turnId, 'segment-s1', boundaryId)), { force: true });

    // The receipt exists, so the segment is exact; the exact asset read then
    // fails closed instead of downgrading to the interrupted branch.
    const classified = await port.readSegmentRecoveryReceipt('segment-s1');
    assert.equal(classified.status, 'exact');
    if (classified.status !== 'exact') return;
    assert.equal(classified.recoveryAssetsReceiptRef, s1Receipt.commitIdentity);
    await assert.rejects(() => port.readSegmentCaptureExact({ businessTurnId: turnId, segmentId: 'segment-s1',
      recoveryAssetsReceiptRef: classified.recoveryAssetsReceiptRef }), /ENOENT|no such file/);
  });
});
