import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  type Checkpoint,
  type EvidenceRef,
  type FileWriteEffect,
  type FileWriteEffectIntent,
  type PreparedRecoveryCapture,
  type RawAsset,
  type RawFactEnvelope,
  type RecoveryHoldFacts,
  type ScopeRef,
  type WorkAssignment,
} from '../../packages/contracts/src/index.js';
import { JournalCommitConflictError, JournalIntegrityError, JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlActiveTurnJournal, createJsonlActiveTurnJournal } from '../../packages/adapters/jsonl/src/active-turn.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import {
  AssetIntegrityError,
  ImmutableAssetStore,
  evidenceReference,
} from '../../packages/adapters/filesystem/src/index.js';
import { activeTurnCommitId } from '../../packages/runtime/src/context/active-turn-journal.js';
import { produceAdmittedTurn, type RuntimeBindingSnapshot } from '../../packages/runtime/src/admission/admitted-turn.js';
import {
  createNativeRecoveryAssets,
  recoveryAssetsReceiptRef,
  recoveryCaptureAssetId,
  type NativeRecoveryAssetsReadback,
} from '../../packages/app/src/native-recovery-assets.js';

/**
 * The project requires every durable artifact to live under `~/.humanagent`.
 * `HUMANAGENT_TEST_ROOT` only exists so a sandboxed worker can still exercise
 * the same consumer locally; the formal default is the `~/.humanagent` root.
 */
const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures', 'provider-recovery-journal-r1-20261013');

const organId = id('organ', 'j1-recovery-organ');

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

async function sha256Digest(value: string): Promise<`sha256:${string}`> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

function evidence(label: string, scope: ScopeRef, digest?: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `j1-${label}`),
    kind: 'operation',
    source: 'j1-recovery-test',
    locator: `test://j1/${label}`,
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
  const taskId = id('task', `j1-task-${turnId}`);
  const scope: ScopeRef = {
    organId,
    taskId,
    cycleId: id('cycle', `j1-cycle-${turnId}`),
    operationId: id('operation', `j1-operation-${turnId}`),
  };
  const runtime: RuntimeBindingSnapshot = {
    runtimeId: 'j1-runtime-0',
    executionEpoch: 1,
    ownerRef: 'j1-owner',
    permissionRevision: 'j1-permission-revision',
  };
  const assignment: WorkAssignment = {
    assignmentId: `j1-assignment-${turnId}`,
    taskId,
    pipelineNodeId: 'j1-node',
    attempt: 1,
    executionEpoch: runtime.executionEpoch,
    inputRevision: 1,
    objective: 'exercise recovery-assets cold read',
    targetRefs: [`operation://${turnId}/output`],
    expectedOutputRefs: [`operation://${turnId}/output`],
    acceptanceCriteriaDigest: 'sha256:j1-acceptance',
    successCriteria: ['recovery assets are committed'],
    failureCriteria: ['recovery assets are missing'],
    incompleteCriteria: ['recovery assets are unverified'],
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

function effectBinding(value: Identity, turnId: string) {
  const toolOperationId = id('operation', `j1-tool-${turnId}`);
  return {
    execution: {
      runtimeId: value.runtime.runtimeId,
      taskId: value.taskId,
      operationId: value.scope.operationId!,
      organId: value.scope.organId,
      cycleId: value.scope.cycleId!,
      executionEpoch: value.runtime.executionEpoch,
    },
    scope: {
      organId: value.scope.organId,
      taskId: value.taskId,
      cycleId: value.scope.cycleId!,
      operationId: toolOperationId,
    },
    toolOperationId,
    requestId: `j1-request-${turnId}`,
    callId: `j1-call-${turnId}`,
    continuationRef: `j1-continuation-${turnId}`,
  };
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
  readonly completionRefs?: ActiveTurnCaptureBody['completionRefs'];
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
    completionRefs: input.completionRefs ?? [],
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
    stages: [
      {
        stageId: 'recovery-assets',
        state: 'succeeded',
        value: { turnId: input.binding.admittedTurn.turnId },
        evidenceRefs: [],
      },
    ],
    durablePhases: [],
    durableReceiptRefs: [],
    recoveryResponsibilityRef: `recovery://j1/${input.binding.admittedTurn.turnId}`,
  };
}

test('J1 codec persists and replays the initial-input record and phase-suffixed request commits', async () => {
  await withFixture('codec', async ({ journalPath, assetRoot }) => {
    const turnId = 'turn-codec-1';
    const value = identity(turnId);
    const assets = new ImmutableAssetStore(assetRoot);
    const initialInput = await assets.write('initial-input-codec-1', new TextEncoder().encode('原始输入'));
    const initialInputRef: RawAsset = {
      ref: evidenceReference(initialInput, value.scope, 'operation', 'j1-test.initial-input'),
      view: { kind: 'utf8-text' },
    };
    const journal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'binding-opened'),
      record: { kind: 'binding-opened', binding: value.binding, currentTurnRef: value.binding.admittedTurn.currentTurnRef },
    });
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'initial-input'),
      record: { kind: 'initial-input', content: initialInputRef },
    });
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'request:request-codec-1:dispatching'),
      record: {
        kind: 'request',
        record: {
          request: { turnId: 'provider-turn-codec-1', requestId: 'request-codec-1' },
          scope: value.scope,
          phase: 'dispatching',
        },
      },
    });
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'request:request-codec-1:dispatched'),
      record: {
        kind: 'request',
        record: {
          request: { turnId: 'provider-turn-codec-1', requestId: 'request-codec-1' },
          scope: value.scope,
          phase: 'dispatched',
        },
      },
    });
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'fact:request-codec-1:1'),
      record: { kind: 'accepted-fact', entry: acceptedFact({ binding: value.binding, requestId: 'request-codec-1', producerSeq: 1, seq: 1 }) },
    });

    const records = await journal.replay();
    assert.deepEqual(records.map((record) => record.kind), [
      'binding-opened', 'initial-input', 'request', 'request', 'accepted-fact',
    ]);
    const inputRecord = records[1]!;
    if (inputRecord.kind !== 'initial-input') throw new Error('initial-input record is required');
    assert.deepEqual(inputRecord.content, initialInputRef);
    const phases = records
      .filter((record): record is Extract<typeof record, { kind: 'request' }> => record.kind === 'request')
      .map((record) => record.record.phase);
    assert.deepEqual(phases, ['dispatching', 'dispatched']);

    const verification = await new JsonlOrganJournal(journalPath).verify();
    assert.equal(verification.valid, true);
    assert.equal(verification.records.length, 5);
    assert.ok(verification.records.every((record) => record.commitId !== undefined && record.recordDigest.length > 0));

    // A phase-aware request id and an initial-input id are both idempotent by
    // commitId and conflict on different content.
    await assert.rejects(
      () => journal.append({
        commitId: activeTurnCommitId(turnId, 'initial-input'),
        record: { kind: 'initial-input', content: { ...initialInputRef, view: { kind: 'arguments' } } },
      }),
      (error: unknown) => error instanceof JournalCommitConflictError,
    );
    await assert.rejects(
      () => journal.append({
        commitId: activeTurnCommitId(turnId, 'request:request-codec-1:dispatched'),
        record: {
          kind: 'request',
          record: {
            request: { turnId: 'provider-turn-codec-1', requestId: 'request-codec-1' },
            scope: value.scope,
            phase: 'failed',
          },
        },
      }),
      (error: unknown) => error instanceof JournalIntegrityError,
    );

    // The same phase commit id with different content is a conflict.
    await assert.rejects(
      () => journal.append({
        commitId: activeTurnCommitId(turnId, 'request:request-codec-1:dispatched'),
        record: {
          kind: 'request',
          record: {
            request: { turnId: 'provider-turn-codec-1', requestId: 'request-codec-1', parentRequestId: 'request-other' },
            parentRequestId: 'request-other',
            scope: value.scope,
            phase: 'dispatched',
          },
        },
      }),
      (error: unknown) => error instanceof JournalCommitConflictError,
    );
    assert.equal((await journal.replay()).length, 5);
  });
});

test('J1 codec rejects a phase commit id that does not match its request record', async () => {
  await withFixture('codec-phase-mismatch', async ({ journalPath }) => {
    const turnId = 'turn-codec-2';
    const value = identity(turnId);
    const journal = createJsonlActiveTurnJournal({ filePath: journalPath, turnId });
    await journal.append({
      commitId: activeTurnCommitId(turnId, 'binding-opened'),
      record: { kind: 'binding-opened', binding: value.binding, currentTurnRef: value.binding.admittedTurn.currentTurnRef },
    });
    await assert.rejects(
      () => journal.append({
        commitId: activeTurnCommitId(turnId, 'request:request-codec-2:settled'),
        record: {
          kind: 'request',
          record: {
            request: { turnId: 'provider-turn-codec-2', requestId: 'request-codec-2' },
            scope: value.scope,
            phase: 'dispatching',
          },
        },
      }),
      (error: unknown) => error instanceof JournalIntegrityError,
    );

    await appendFile(journalPath, 'not-json\n', 'utf8');
    await assert.rejects(
      () => new JsonlActiveTurnJournal({ filePath: journalPath, turnId }).replay(),
      (error: unknown) => error instanceof JournalIntegrityError,
    );
  });
});

test('J1 active-turn codec leaves foreign Journal owners alone and isolates the bound turn', async () => {
  await withFixture('shared-chain', async ({ journalPath, assetRoot, completionJournalPath }) => {
    const turnA = 'turn-shared-A';
    const valueA = identity(turnA);
    const journalA = createJsonlActiveTurnJournal({ filePath: journalPath, turnId: turnA });
    await journalA.append({
      commitId: activeTurnCommitId(turnA, 'binding-opened'),
      record: { kind: 'binding-opened', binding: valueA.binding, currentTurnRef: valueA.binding.admittedTurn.currentTurnRef },
    });
    await journalA.append({
      commitId: activeTurnCommitId(turnA, 'initial-input'),
      record: { kind: 'initial-input', content: { ref: evidence('shared-turn-a-input', valueA.scope), view: { kind: 'utf8-text' } } },
    });
    await journalA.append({
      commitId: activeTurnCommitId(turnA, 'request:request-shared-A:dispatching'),
      record: {
        kind: 'request',
        record: {
          request: { turnId: 'provider-turn-shared-A', requestId: 'request-shared-A' },
          scope: valueA.scope,
          phase: 'dispatching',
        },
      },
    });

    // Real foreign owners write to the same authoritative Organ Journal file.
    const effectValue = effectBinding(valueA, turnA);
    const effect: FileWriteEffect = {
      kind: 'file.write',
      effectId: await fileWriteEffectId(effectValue),
      workspaceRef: 'workspace:j1',
      relativePath: 'j1/shared.txt',
      inputDigest: await sha256Digest('input'),
      expectedContentDigest: await sha256Digest('content'),
    };
    await new JsonlOperationCompletionJournal(journalPath).commitIntent({
      kind: 'operation-effect-intent',
      version: 1,
      binding: effectValue,
      effect,
    });
    const assets = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const initialInput = await assets.writeInitialInput({ scope: valueA.scope, turnId: turnA, rawInput: 'shared chain input' });
    await assets.commitCapturePhase({
      turnId: turnA,
      boundaryId: 'boundary-shared-A',
      prepared: {
        body: captureBody({
          binding: valueA.binding,
          initialInput,
          pauseId: 'boundary-shared-A',
          frozenAt: '2026-10-12T00:00:00.000Z',
          requests: [],
          entries: [],
        }),
        controlRecordCount: 0,
        producerDrains: [],
        completionLookups: [],
        recovery: recoveryFacts({ binding: valueA.binding, unresolvedOperationRefs: [] }),
      },
    });
    const checkpoint: Checkpoint = {
      id: id('checkpoint', 'shared-chain-checkpoint-A'),
      scope: valueA.scope,
      cycleId: valueA.scope.cycleId!,
      seq: 1,
      previousCheckpointId: null,
      directiveRevision: 1,
      executionEpoch: 1,
      outcome: 'succeeded',
      summary: 'foreign owner checkpoint in the shared chain',
      recoveryStateRef: evidence('shared-recovery-A', valueA.scope),
      evidenceRefs: [evidence('shared-checkpoint-A', valueA.scope)],
      next: { kind: 'continue' },
    };
    await new JsonlOrganJournal(journalPath).append({
      commitId: 'checkpoint:shared-A:1',
      kind: 'checkpoint',
      scope: valueA.scope,
      checkpoint,
    });

    // The bound turn reads its own records; the foreign owners are not rejected.
    assert.deepEqual((await journalA.replay()).map((record) => record.kind), ['binding-opened', 'initial-input', 'request']);

    // A second independent admitted turn shares the same file.
    const turnB = 'turn-shared-B';
    const valueB = identity(turnB);
    const journalB = createJsonlActiveTurnJournal({ filePath: journalPath, turnId: turnB });
    await journalB.append({
      commitId: activeTurnCommitId(turnB, 'binding-opened'),
      record: { kind: 'binding-opened', binding: valueB.binding, currentTurnRef: valueB.binding.admittedTurn.currentTurnRef },
    });
    await journalB.append({
      commitId: activeTurnCommitId(turnB, 'initial-input'),
      record: { kind: 'initial-input', content: { ref: evidence('shared-turn-b-input', valueB.scope), view: { kind: 'utf8-text' } } },
    });

    assert.deepEqual((await journalB.replay()).map((record) => record.kind), ['binding-opened', 'initial-input']);
    assert.deepEqual((await journalA.replay()).map((record) => record.kind), ['binding-opened', 'initial-input', 'request']);

    // Wrong-turn appends are rejected on identity, not silently accepted.
    await assert.rejects(
      () => journalA.append({
        commitId: activeTurnCommitId(turnB, 'binding-opened'),
        record: { kind: 'binding-opened', binding: valueB.binding, currentTurnRef: valueB.binding.admittedTurn.currentTurnRef },
      }),
      (error: unknown) => error instanceof JournalIntegrityError,
    );
    await assert.rejects(
      () => journalA.append({
        commitId: activeTurnCommitId(turnA, 'initial-input'),
        record: { kind: 'initial-input', content: { ref: evidence('shared-turn-b-other-input', valueB.scope), view: { kind: 'utf8-text' } } },
      }),
      (error: unknown) => error instanceof JournalIntegrityError
        && /does not match its active turn binding/.test((error as Error).message),
    );

    // The shared chain stays valid, and the foreign owners keep their records.
    const verification = await new JsonlOrganJournal(journalPath).verify();
    assert.equal(verification.valid, true);
    assert.ok(verification.records.some((record) => record.kind === 'checkpoint'));
    assert.ok(verification.records.some((record) => record.payload?.type === 'recovery-assets.phase'));
    assert.ok(verification.records.some((record) => record.payload?.kind === 'operation-effect-intent'));
    assert.equal(verification.records.filter((record) => record.payload?.type === 'active-turn.record').length, 5);
  });
});

const COLD_READ_SCRIPT = `
const { pathToFileURL } = await import('node:url');
const [appModulePath, assetModulePath, journalPath, assetRoot, completionJournalPath, receiptRef] = process.argv.slice(1);
const { createNativeRecoveryAssets } = await import(pathToFileURL(appModulePath).href);
const { ImmutableAssetStore } = await import(pathToFileURL(assetModulePath).href);
const assets = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
const readback = await assets.readRecoveryAssetsExact(receiptRef);
const initialInputBytes = await new ImmutableAssetStore(assetRoot).readEvidence(readback.prepared.body.initialInput.ref);
process.stdout.write(JSON.stringify({
  receiptRef: readback.receipt.commitIdentity,
  turnId: readback.prepared.body.binding.admittedTurn.turnId,
  frozenAt: readback.prepared.body.cut.frozenAt,
  captureDigest: readback.receipt.capture.ref.digest,
  initialInputText: new TextDecoder().decode(initialInputBytes),
  completionStates: readback.completions.map((entry) => entry.readback.state),
  producerDrainBoundary: readback.prepared.producerDrains[0]?.boundaryId ?? null,
  recoveryResponsibilityRef: readback.prepared.recovery.recoveryResponsibilityRef,
}));
`;

function runColdRead(input: {
  readonly journalPath: string;
  readonly assetRoot: string;
  readonly completionJournalPath: string;
  readonly receiptRef: string;
}): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const appModulePath = join(process.cwd(), 'dist', 'tests', 'packages', 'app', 'src', 'native-recovery-assets.js');
  const assetModulePath = join(process.cwd(), 'dist', 'tests', 'packages', 'adapters', 'filesystem', 'src', 'index.js');
  const args = [
    '--input-type=module',
    '--eval',
    COLD_READ_SCRIPT,
    appModulePath,
    assetModulePath,
    input.journalPath,
    input.assetRoot,
    input.completionJournalPath,
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

test('J1 writes exact initial-input bytes, discovers intents without completion, and cold-reads the committed capture', async () => {
  await withFixture('cold-read', async ({ journalPath, assetRoot, completionJournalPath }) => {
    const turnId = 'turn-cold-1';
    const value = identity(turnId);
    const assets = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const rawInput = '  keep surrounding whitespace \n世界 \t ';
    const initialInput = await assets.writeInitialInput({ scope: value.scope, turnId, rawInput });
    assert.deepEqual(
      await new ImmutableAssetStore(assetRoot).readEvidence(initialInput.ref),
      new TextEncoder().encode(rawInput),
      'initial input must keep the exact submitted bytes without trim',
    );

    const effectValue = effectBinding(value, turnId);
    const effect: FileWriteEffect = {
      kind: 'file.write',
      effectId: await fileWriteEffectId(effectValue),
      workspaceRef: 'workspace:j1',
      relativePath: 'j1/output.txt',
      inputDigest: await sha256Digest('input'),
      expectedContentDigest: await sha256Digest('content'),
    };
    const intent: FileWriteEffectIntent = {
      kind: 'operation-effect-intent',
      version: 1,
      binding: effectValue,
      effect,
    };
    const completionJournal = new JsonlOperationCompletionJournal(completionJournalPath);
    await completionJournal.commitIntent(intent);

    const discovered = await completionJournal.discoverExactExecution({ execution: effectValue.execution });
    assert.equal(discovered.length, 1);
    const lookup = discovered[0]!;
    assert.equal(lookup.commitIdentity, await completionCommitIdentity(effectValue, effect.effectId));
    assert.deepEqual(await completionJournal.readExact(lookup), {
      state: 'unknown',
      intent,
      nextAction: 'reconcile',
      replayAllowed: false,
    }, 'an intent without a completion must stay discoverable and reconcile-only');

    const requestId = effectValue.requestId;
    const body = captureBody({
      binding: value.binding,
      initialInput,
      pauseId: 'boundary-cold-1',
      frozenAt: '2026-10-12T00:00:00.000Z',
      requests: [{
        request: { turnId, requestId },
        scope: value.scope,
        phase: 'dispatched',
      }],
      entries: [acceptedFact({ binding: value.binding, requestId, producerSeq: 1, seq: 1 })],
      completionRefs: [{ requestId, producerSeq: 1, effectRef: lookup.commitIdentity }],
    });
    const prepared: PreparedRecoveryCapture = {
      body,
      controlRecordCount: 3,
      producerDrains: [{
        execution: value.binding.execution,
        boundaryId: 'boundary-cold-1',
        requests: [{ request: { turnId, requestId }, lastProducerSeq: 1 }],
      }],
      completionLookups: discovered,
      recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [lookup.commitIdentity] }),
    };
    const receipt = await assets.commitCapturePhase({
      turnId,
      boundaryId: 'boundary-cold-1',
      prepared,
    });
    assert.ok(receipt.commitIdentity.startsWith('recovery-assets:v1:'));
    assert.equal(receipt.journalReceiptRef, receipt.commitIdentity);
    assert.equal(receipt.turnId, turnId);
    assert.equal(receipt.boundaryId, 'boundary-cold-1');
    assert.equal(receipt.capture.ref.digest?.startsWith('sha256:'), true);

    const readback: NativeRecoveryAssetsReadback = await assets.readRecoveryAssetsExact(receipt.commitIdentity);
    assert.deepEqual(readback.prepared.body, body, 'cold read must return the exact frozen capture body');
    assert.deepEqual(readback.prepared.producerDrains, prepared.producerDrains, 'cold read must preserve the actual producer drains');
    assert.deepEqual(readback.prepared.recovery, prepared.recovery, 'cold read must preserve the recovery hold facts');
    assert.equal(readback.prepared.controlRecordCount, 3);
    assert.equal(readback.completions.length, 1);
    assert.equal(readback.completions[0]!.readback.state, 'unknown');

    const child = await runColdRead({
      journalPath,
      assetRoot,
      completionJournalPath,
      receiptRef: receipt.commitIdentity,
    });
    assert.equal(child.code, 0, `fresh process exited ${String(child.code)}; stderr=${child.stderr.slice(-500)}`);
    const parsed = JSON.parse(child.stdout.trim()) as {
      readonly receiptRef: string;
      readonly turnId: string;
      readonly frozenAt: string;
      readonly captureDigest: string;
      readonly initialInputText: string;
      readonly completionStates: readonly string[];
      readonly producerDrainBoundary: string | null;
      readonly recoveryResponsibilityRef: string;
    };
    assert.equal(parsed.receiptRef, receipt.commitIdentity);
    assert.equal(parsed.turnId, turnId);
    assert.equal(parsed.frozenAt, body.cut.frozenAt);
    assert.equal(parsed.captureDigest, receipt.capture.ref.digest);
    assert.equal(parsed.initialInputText, rawInput, 'the fresh process must read the exact initial-input bytes');
    assert.deepEqual(parsed.completionStates, ['unknown']);
    assert.equal(parsed.producerDrainBoundary, 'boundary-cold-1');
    assert.equal(parsed.recoveryResponsibilityRef, prepared.recovery.recoveryResponsibilityRef);
  });
});

test('J1 does not treat an asset write as a phase commit and never falls back to the latest receipt', async () => {
  await withFixture('phase-boundary', async ({ journalPath, assetRoot, completionJournalPath }) => {
    const turnId = 'turn-boundary-1';
    const value = identity(turnId);
    const assets = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const initialInput = await assets.writeInitialInput({ scope: value.scope, turnId, rawInput: 'phase boundary input' });
    const body = captureBody({
      binding: value.binding,
      initialInput,
      pauseId: 'boundary-1',
      frozenAt: '2026-10-12T00:00:00.000Z',
      requests: [],
      entries: [],
    });
    const prepared: PreparedRecoveryCapture = {
      body,
      controlRecordCount: 0,
      producerDrains: [],
      completionLookups: [],
      recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [] }),
    };

    // Write the immutable capture asset directly, then stop before the phase
    // commit. The asset exists, but it is not a committed recovery-assets phase.
    const store = new ImmutableAssetStore(assetRoot);
    const captureBytes = new TextEncoder().encode(canonicalJsonStringify(body));
    const reference = await store.write(recoveryCaptureAssetId(turnId, 'boundary-1'), captureBytes);
    const captureRef = evidenceReference(reference, value.scope, 'operation', 'j1-test.capture');
    const uncommittedReceiptRef = recoveryAssetsReceiptRef({
      turnId,
      boundaryId: 'boundary-1',
      cut: body.cut,
      captureDigest: captureRef.digest!,
      controlRecordCount: 0,
    });
    assert.deepEqual(await store.read(reference), captureBytes, 'the immutable asset must exist before the phase commit');
    await assert.rejects(
      () => assets.readRecoveryAssetsExact(uncommittedReceiptRef),
      /recovery-assets receipt is not committed/,
    );

    const firstReceipt = await assets.commitCapturePhase({ turnId, boundaryId: 'boundary-1', prepared });
    const secondTurnId = 'turn-boundary-2';
    const secondValue = identity(secondTurnId);
    const secondInput = await assets.writeInitialInput({ scope: secondValue.scope, turnId: secondTurnId, rawInput: 'later input' });
    const secondBody = captureBody({
      binding: secondValue.binding,
      initialInput: secondInput,
      pauseId: 'boundary-2',
      frozenAt: '2026-10-12T00:00:01.000Z',
      requests: [],
      entries: [],
    });
    await assets.commitCapturePhase({
      turnId: secondTurnId,
      boundaryId: 'boundary-2',
      prepared: {
        body: secondBody,
        controlRecordCount: 0,
        producerDrains: [],
        completionLookups: [],
        recovery: recoveryFacts({ binding: secondValue.binding, unresolvedOperationRefs: [] }),
      },
    });

    const reread = await assets.readRecoveryAssetsExact(firstReceipt.commitIdentity);
    assert.equal(reread.prepared.body.cut.pauseId, 'boundary-1');
    assert.equal(reread.prepared.body.cut.frozenAt, '2026-10-12T00:00:00.000Z');
    assert.equal(reread.prepared.body.binding.admittedTurn.turnId, turnId);
  });
});

test('J1 surfaces capture asset and journal integrity errors on cold read', async () => {
  await withFixture('integrity', async ({ journalPath, assetRoot, completionJournalPath }) => {
    const turnId = 'turn-integrity-1';
    const value = identity(turnId);
    const assets = createNativeRecoveryAssets({ journalPath, assetRoot, completionJournalPath });
    const initialInput = await assets.writeInitialInput({ scope: value.scope, turnId, rawInput: 'integrity input' });
    const receipt = await assets.commitCapturePhase({
      turnId,
      boundaryId: 'boundary-integrity-1',
      prepared: {
        body: captureBody({
          binding: value.binding,
          initialInput,
          pauseId: 'boundary-integrity-1',
          frozenAt: '2026-10-12T00:00:00.000Z',
          requests: [],
          entries: [],
        }),
        controlRecordCount: 0,
        producerDrains: [],
        completionLookups: [],
        recovery: recoveryFacts({ binding: value.binding, unresolvedOperationRefs: [] }),
      },
    });
    await writeFile(join(assetRoot, receipt.capture.ref.evidenceId.value), 'corrupted', 'utf8');
    await assert.rejects(
      () => assets.readRecoveryAssetsExact(receipt.commitIdentity),
      (error: unknown) => error instanceof AssetIntegrityError,
    );

    await withFixture('journal-corruption', async (other) => {
      const otherTurnId = 'turn-integrity-2';
      const otherValue = identity(otherTurnId);
      const otherAssets = createNativeRecoveryAssets({
        journalPath: other.journalPath,
        assetRoot: other.assetRoot,
        completionJournalPath: other.completionJournalPath,
      });
      const otherInput = await otherAssets.writeInitialInput({ scope: otherValue.scope, turnId: otherTurnId, rawInput: 'other input' });
      const otherReceipt = await otherAssets.commitCapturePhase({
        turnId: otherTurnId,
        boundaryId: 'boundary-integrity-2',
        prepared: {
          body: captureBody({
            binding: otherValue.binding,
            initialInput: otherInput,
            pauseId: 'boundary-integrity-2',
            frozenAt: '2026-10-12T00:00:00.000Z',
            requests: [],
            entries: [],
          }),
          controlRecordCount: 0,
          producerDrains: [],
          completionLookups: [],
          recovery: recoveryFacts({ binding: otherValue.binding, unresolvedOperationRefs: [] }),
        },
      });
      await appendFile(other.journalPath, 'not-json\n', 'utf8');
      await assert.rejects(
        () => otherAssets.readRecoveryAssetsExact(otherReceipt.commitIdentity),
        (error: unknown) => error instanceof JournalIntegrityError,
      );
    });
  });
});
