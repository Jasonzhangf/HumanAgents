import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  id,
  type AcceptedExecutionChildDelivery,
  type ActiveTurnBinding,
  type AdmittedTurn,
  type Checkpoint,
  type CheckpointReceiptRelationshipV1,
  type CheckpointTimeAuthority,
  type ChildInvocationRecord,
  type EvidenceRef,
  type RawAsset,
  type ScopeRef,
  type WorkAssignment,
  type WorkResult,
} from '../../packages/contracts/src/index.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { createJsonlCheckpointJournal, createJsonlSemanticHistoryJournal } from '../../packages/app/src/checkpoint-journal.js';
import { FileActiveTurnJournal } from '../../packages/app/src/ui-runtime/journal.js';
import {
  adoptedChildAdoptionCommitIdV1,
  adoptedChildDeliveryCommitIdV1,
  projectAdmittedTurnIdentityV1,
  type AcceptedSemanticViewInputV1,
  type AdoptedChildSourceV1,
  type CommittedSemanticCheckpointV1,
  type SemanticContextViewIdentityV1,
} from '../../packages/runtime/src/context/semantic-history.js';
import {
  commitSemanticContextViewV1,
  commitSemanticHistoryPublicationV1,
  readCommittedSemanticCheckpointV1,
} from '../../packages/runtime/src/checkpoints/semantic-history.js';

const organId = id('organ', 'semantic-history-organ');
const taskId = id('task', 'semantic-history-task');
const cycleId = id('cycle', 'semantic-history-cycle');
const scope: ScopeRef = { organId, taskId, cycleId };
const runtimeId = 'semantic-history-runtime';
const turnId = 'semantic-history-turn';
const invocationId = 'semantic-history-invocation';
const childTurnId = 'semantic-history-child-turn';
const preCallCheckpointRef = 'humanagent://checkpoint/v2/semantic-history-pre-call';
const deliverySeq = 2;

function evidence(label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `semantic-history-${label}`),
    kind: 'operation',
    source: 'semantic-history-public-consumer',
    locator: `records/${label}`,
    scope,
  };
}

function admittedTurn(): AdmittedTurn {
  return {
    turnId,
    workAssignmentRef: 'semantic-history-assignment',
    taskRef: taskId,
    scopeRef: scope,
    cycleRef: cycleId,
    inputRevision: 1,
    directiveRevision: 1,
    executionEpoch: 4,
    runtimeBindingRef: runtimeId,
    permissionRevision: 'permission-r1',
    admissionEvidenceRefs: ['semantic-history-admission'],
    currentTurnRef: 'semantic-history-active-turn',
    recoveryStateRef: 'semantic-history-recovery-state',
  };
}

const assignment: WorkAssignment = {
  assignmentId: 'semantic-history-assignment',
  taskId,
  pipelineNodeId: 'semantic-history-node',
  attempt: 1,
  executionEpoch: 4,
  inputRevision: 1,
  objective: 'materialize the refined child delivery',
  targetRefs: [],
  expectedOutputRefs: [],
  acceptanceCriteriaDigest: 'sha256:semantic-history-acceptance',
  successCriteria: ['refined delivery is accepted'],
  failureCriteria: [],
  incompleteCriteria: [],
  requiredCapabilities: [],
  mergeGate: 'not-required',
};

const workResult: WorkResult = {
  taskId,
  pipelineNodeId: 'semantic-history-node',
  agentId: 'semantic-history-agent',
  assignmentId: 'semantic-history-assignment',
  attempt: 1,
  executionEpoch: 4,
  inputRevision: 1,
  producedArtifactRefs: [],
  producedArtifactDigests: [],
  status: 'succeeded',
  summary: 'refined child result',
  outputRefs: [],
  evidenceRefs: [evidence('child-result')],
  nextAction: 'continue',
};

function checkpoint(seq: number, previousCheckpointId: Checkpoint['previousCheckpointId'], summary: string): Checkpoint {
  return {
    id: id('checkpoint', `semantic-history-${seq}`),
    scope,
    cycleId,
    seq,
    previousCheckpointId,
    directiveRevision: 1,
    executionEpoch: 4,
    outcome: 'succeeded',
    summary,
    recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [evidence(`completion-${seq}`)],
    next: { kind: 'continue', ref: `next-${seq}` },
  };
}

function authority(owner: string, value: string): CheckpointTimeAuthority {
  return {
    source: 'harness',
    owner: 'runtime-checkpoint-control-owner',
    authorityRef: owner,
    sampleCommittedAt: async () => value,
  };
}

/**
 * Every durable artifact must live under `~/.humanagent`. `HUMANAGENT_TEST_ROOT`
 * exists only so a sandboxed worker can exercise this same consumer locally; the
 * formal default stays the `~/.humanagent` root.
 */
const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? join(homedir(), '.humanagent', 'test-fixtures');

function fixtureRoot(): string {
  return join(PERSISTENCE_ROOT, `semantic-history-hpj-r3-${process.pid}`);
}

async function seedActiveTurn(filePath: string, refinedDelivery: RawAsset): Promise<void> {
  const journal = new FileActiveTurnJournal(filePath);
  const binding: ActiveTurnBinding = {
    admittedTurn: admittedTurn(),
    assignment,
    execution: { runtimeId, executionEpoch: 4 },
    scope,
  };
  const invocation: ChildInvocationRecord = {
    invocationId,
    childTurnId,
    checkpointReceiptRef: preCallCheckpointRef,
    binding: { kind: 'execution', assignment },
  };
  const adopted: ChildInvocationRecord = { ...invocation, adoptedResultSeq: deliverySeq };
  const delivery: AcceptedExecutionChildDelivery = {
    kind: 'execution',
    seq: deliverySeq,
    invocationId,
    refinedDelivery,
    assignment,
    result: workResult,
  };
  await journal.append({ commitId: `active-turn:${turnId}:binding`, record: { kind: 'binding-opened', binding, currentTurnRef: binding.admittedTurn.currentTurnRef } });
  await journal.append({ commitId: `active-turn:${turnId}:invocation`, record: { kind: 'child-invocation', record: invocation } });
  await journal.append({ commitId: `active-turn:${turnId}:delivery`, record: { kind: 'child-delivery', entry: delivery } });
  await journal.append({ commitId: adoptedChildAdoptionCommitIdV1(turnId, invocationId), record: { kind: 'child-invocation', record: adopted } });
}

function acceptedView(
  turn: AdmittedTurn,
  relationship: CheckpointReceiptRelationshipV1,
  source: AdoptedChildSourceV1,
  semantics: { goal: string; actions: string; result: string; nextStep: string },
  acceptanceRef: string,
): AcceptedSemanticViewInputV1 {
  return {
    version: 1,
    admittedTurn: turn,
    checkpoint: relationship,
    acceptance: { ownerId: 'runtime-semantic-history-owner', acceptanceRef, sourceEvidenceRefs: [evidence(acceptanceRef)] },
    semantics,
    adoptedChildren: [source],
    recovery: {
      recoveryStateRef: turn.recoveryStateRef,
      recoveryResponsibilityRef: 'runtime-recovery-owner',
      unresolvedOperationRefs: [],
      laterErrorRefs: [],
    },
  };
}

const coldReadCode = [
  "const [appUrl, semanticUrl, journalUrl, filesystemUrl, payloadJson] = process.argv.slice(1);",
  "const { createJsonlSemanticHistoryJournal } = await import(appUrl);",
  "const { readCommittedSemanticCheckpointV1 } = await import(semanticUrl);",
  "const { FileActiveTurnJournal } = await import(journalUrl);",
  "const { ImmutableAssetStore } = await import(filesystemUrl);",
  "const payload = JSON.parse(payloadJson);",
  "const refined = new ImmutableAssetStore(payload.refinedRoot);",
  "const port = createJsonlSemanticHistoryJournal({",
  "  filePath: payload.filePath,",
  "  artifactsRoot: payload.artifactsRoot,",
  "  activeTurnJournal: new FileActiveTurnJournal(payload.activeTurnFile),",
  "  rawContent: { read: async ({ content }) => refined.readEvidence(content.ref) },",
  "  timeAuthority: { source: 'harness', owner: 'runtime-checkpoint-control-owner', authorityRef: 'cold-read', sampleCommittedAt: () => { throw new Error('cold read must not sample time'); } },",
  "});",
  "const result = await readCommittedSemanticCheckpointV1({ port, lookup: payload.lookup });",
  "process.stdout.write(JSON.stringify(result));",
].join('\n');

async function coldRead(input: {
  readonly filePath: string;
  readonly artifactsRoot: string;
  readonly refinedRoot: string;
  readonly activeTurnFile: string;
  readonly lookup: unknown;
}): Promise<CommittedSemanticCheckpointV1 | null> {
  const urls = [
    new URL('../../packages/app/src/checkpoint-journal.js', import.meta.url).href,
    new URL('../../packages/runtime/src/checkpoints/semantic-history.js', import.meta.url).href,
    new URL('../../packages/app/src/ui-runtime/journal.js', import.meta.url).href,
    new URL('../../packages/adapters/filesystem/src/index.js', import.meta.url).href,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', coldReadCode, ...urls, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `semantic cold reader exited with ${code ?? 'unknown status'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as CommittedSemanticCheckpointV1 | null);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('semantic history commits two durable phases and a fresh process exact-reads A rather than B', async () => {
  const root = fixtureRoot();
  const filePath = join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'artifacts');
  const refinedRoot = join(root, 'refined');
  const activeTurnFile = join(root, 'active-turn.jsonl');
  try {
    await mkdir(root, { recursive: true });
    const refinedStore = new ImmutableAssetStore(refinedRoot);
    const refinedBytes = new TextEncoder().encode('refined child delivery A');
    const refinedReference = await refinedStore.write('semantic-history-refined-a', refinedBytes);
    const refinedDelivery: RawAsset = {
      ref: { evidenceId: id('evidence', 'semantic-history-refined-a'), kind: 'operation', source: 'semantic-history-public-consumer', locator: refinedReference.locator, digest: refinedReference.digest, scope },
      view: { kind: 'utf8-text' },
    };
    await seedActiveTurn(activeTurnFile, refinedDelivery);

    const checkpoints = createJsonlCheckpointJournal({ filePath });
    const first = checkpoint(1, null, 'checkpoint A summary');
    const relationshipA = await checkpoints.commitNativeCheckpoint({
      ownerId: 'runtime-checkpoint-owner',
      checkpoint: first,
      timeAuthority: authority('semantic-history-checkpoint-a', '2026-10-12T05:00:00.000Z'),
    });
    const second = checkpoint(2, first.id, 'checkpoint B summary');
    const relationshipB = await checkpoints.commitNativeCheckpoint({
      ownerId: 'runtime-checkpoint-owner',
      checkpoint: second,
      timeAuthority: authority('semantic-history-checkpoint-b', '2026-10-12T05:10:00.000Z'),
    });

    const source: AdoptedChildSourceV1 = {
      parentTurn: projectAdmittedTurnIdentityV1(admittedTurn()),
      invocationId,
      childTurnId,
      deliverySeq,
      adoptionCommitId: adoptedChildAdoptionCommitIdV1(turnId, invocationId),
      deliveryCommitId: adoptedChildDeliveryCommitIdV1(turnId, invocationId),
      kind: 'execution',
      refinedDelivery,
      preCallCheckpointRef,
    };
    const turn = admittedTurn();
    const samples = { count: 0 };
    const port = createJsonlSemanticHistoryJournal({
      filePath,
      artifactsRoot,
      activeTurnJournal: new FileActiveTurnJournal(activeTurnFile),
      rawContent: { read: async ({ content }) => refinedStore.readEvidence(content.ref) },
      timeAuthority: {
        source: 'harness',
        owner: 'runtime-checkpoint-control-owner',
        authorityRef: 'semantic-history-phase',
        sampleCommittedAt: async () => {
          samples.count += 1;
          return `2026-10-12T05:2${samples.count}:00.000Z`;
        },
      },
    });

    const acceptedA = acceptedView(turn, relationshipA, source, { goal: 'goal A', actions: 'actions A', result: 'result A', nextStep: 'next step A' }, 'acceptance-a');
    const viewA = await commitSemanticContextViewV1({ port, accepted: acceptedA });
    const publicationA = await commitSemanticHistoryPublicationV1({
      port,
      ownerId: 'runtime-semantic-history-owner',
      turn: projectAdmittedTurnIdentityV1(turn),
      checkpoint: relationshipA,
      contextView: { identity: viewA.commitIdentity as SemanticContextViewIdentityV1, receipt: viewA },
    });
    const acceptedB = acceptedView(turn, relationshipB, source, { goal: 'goal B', actions: 'actions B', result: 'result B', nextStep: 'next step B' }, 'acceptance-b');
    const viewB = await commitSemanticContextViewV1({ port, accepted: acceptedB });
    const publicationB = await commitSemanticHistoryPublicationV1({
      port,
      ownerId: 'runtime-semantic-history-owner',
      turn: projectAdmittedTurnIdentityV1(turn),
      checkpoint: relationshipB,
      contextView: { identity: viewB.commitIdentity as SemanticContextViewIdentityV1, receipt: viewB },
    });

    assert.equal(viewA.journalSeq === publicationA.journalSeq, false);
    assert.equal(viewA.journalReceiptRef === publicationA.journalReceiptRef, false);
    assert.equal(viewA.journalSeq === relationshipA.checkpointSeq, false);
    assert.equal(publicationA.journalSeq === relationshipB.journalSeq, false);
    assert.match(viewA.recordDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(publicationA.commitIdentity.startsWith('history-publication:v1:'), true);
    assert.equal(viewA.commitIdentity.startsWith('context-view:v1:'), true);

    const lookupA = {
      scope,
      checkpoint: { id: first.id, scope: first.scope },
      publicationReceiptRef: publicationA.journalReceiptRef,
    };
    const readA = await readCommittedSemanticCheckpointV1({ port, lookup: lookupA });
    assert.equal(readA?.semantics.goal, 'goal A');
    assert.equal(readA?.turn.turnId, turnId);
    assert.equal(readA?.description, 'checkpoint A summary');
    assert.equal(readA?.save.checkpoint.checkpoint.id.value, first.id.value);
    assert.equal(readA?.save.contextView.journalSeq, viewA.journalSeq);
    assert.equal(readA?.save.historyPublication.journalSeq, publicationA.journalSeq);
    assert.equal(readA?.time, relationshipA.envelope.committedAt);
    assert.equal(readA?.adoptedChildren.length, 1);

    const cold = await coldRead({ filePath, artifactsRoot, refinedRoot, activeTurnFile, lookup: lookupA });
    assert.equal(cold?.semantics.goal, 'goal A');
    assert.equal(cold?.semantics.result, 'result A');
    assert.equal(cold?.description, 'checkpoint A summary');
    assert.equal(cold?.save.checkpoint.checkpoint.id.value, first.id.value);
    assert.equal(cold?.save.contextView.journalReceiptRef, viewA.journalReceiptRef);
    assert.equal(cold?.save.historyPublication.journalReceiptRef, publicationA.journalReceiptRef);
    assert.equal(cold?.semantics.goal === 'goal B', false);

    const wrongDigest = `${publicationA.journalReceiptRef.slice(0, -1)}${publicationA.journalReceiptRef.endsWith('0') ? '1' : '0'}`;
    assert.equal(await port.readCommittedSemanticCheckpoint({ ...lookupA, publicationReceiptRef: wrongDigest }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a view-only prefix commits a context view with no committed history', async () => {
  const root = fixtureRoot();
  const filePath = join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'artifacts');
  const refinedRoot = join(root, 'refined');
  const activeTurnFile = join(root, 'active-turn.jsonl');
  try {
    await mkdir(root, { recursive: true });
    const refinedStore = new ImmutableAssetStore(refinedRoot);
    const refinedBytes = new TextEncoder().encode('refined child delivery prefix');
    const refinedReference = await refinedStore.write('semantic-history-refined-prefix', refinedBytes);
    const refinedDelivery: RawAsset = {
      ref: { evidenceId: id('evidence', 'semantic-history-refined-prefix'), kind: 'operation', source: 'semantic-history-public-consumer', locator: refinedReference.locator, digest: refinedReference.digest, scope },
      view: { kind: 'utf8-text' },
    };
    await seedActiveTurn(activeTurnFile, refinedDelivery);

    const first = checkpoint(1, null, 'checkpoint prefix summary');
    const relationship = await createJsonlCheckpointJournal({ filePath }).commitNativeCheckpoint({
      ownerId: 'runtime-checkpoint-owner',
      checkpoint: first,
      timeAuthority: authority('semantic-history-checkpoint-prefix', '2026-10-12T06:00:00.000Z'),
    });
    const source: AdoptedChildSourceV1 = {
      parentTurn: projectAdmittedTurnIdentityV1(admittedTurn()),
      invocationId,
      childTurnId,
      deliverySeq,
      adoptionCommitId: adoptedChildAdoptionCommitIdV1(turnId, invocationId),
      deliveryCommitId: adoptedChildDeliveryCommitIdV1(turnId, invocationId),
      kind: 'execution',
      refinedDelivery,
      preCallCheckpointRef,
    };
    const port = createJsonlSemanticHistoryJournal({
      filePath,
      artifactsRoot,
      activeTurnJournal: new FileActiveTurnJournal(activeTurnFile),
      rawContent: { read: async ({ content }) => refinedStore.readEvidence(content.ref) },
      timeAuthority: authority('semantic-history-phase-prefix', '2026-10-12T06:01:00.000Z'),
    });
    const view = await commitSemanticContextViewV1({
      port,
      accepted: acceptedView(admittedTurn(), relationship, source, { goal: 'prefix goal', actions: 'prefix actions', result: 'prefix result', nextStep: 'prefix next' }, 'acceptance-prefix'),
    });

    const exact = await port.readContextView({ scope, contextViewReceiptRef: view.journalReceiptRef });
    assert.equal(exact?.identity, view.commitIdentity);
    assert.equal(exact?.semanticAsset.digest.startsWith('sha256:'), true);

    const { JsonlOrganJournal } = await import('../../packages/adapters/jsonl/src/index.js');
    const records = await new JsonlOrganJournal(filePath).replay();
    assert.equal(records.filter((record) => record.payload?.['kind'] === 'native-semantic-context-view').length, 1);
    assert.equal(records.filter((record) => record.payload?.['kind'] === 'native-semantic-history-publication').length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('idempotent retry reuses the first durable time and a different intent is rejected', async () => {
  const root = fixtureRoot();
  const filePath = join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'artifacts');
  const refinedRoot = join(root, 'refined');
  const activeTurnFile = join(root, 'active-turn.jsonl');
  try {
    await mkdir(root, { recursive: true });
    const refinedStore = new ImmutableAssetStore(refinedRoot);
    const refinedReference = await refinedStore.write('semantic-history-refined-idempotent', new TextEncoder().encode('refined child delivery idempotent'));
    const refinedDelivery: RawAsset = {
      ref: { evidenceId: id('evidence', 'semantic-history-refined-idempotent'), kind: 'operation', source: 'semantic-history-public-consumer', locator: refinedReference.locator, digest: refinedReference.digest, scope },
      view: { kind: 'utf8-text' },
    };
    await seedActiveTurn(activeTurnFile, refinedDelivery);

    const first = checkpoint(1, null, 'checkpoint idempotent summary');
    const relationship = await createJsonlCheckpointJournal({ filePath }).commitNativeCheckpoint({
      ownerId: 'runtime-checkpoint-owner',
      checkpoint: first,
      timeAuthority: authority('semantic-history-checkpoint-idempotent', '2026-10-12T07:00:00.000Z'),
    });
    const source: AdoptedChildSourceV1 = {
      parentTurn: projectAdmittedTurnIdentityV1(admittedTurn()),
      invocationId,
      childTurnId,
      deliverySeq,
      adoptionCommitId: adoptedChildAdoptionCommitIdV1(turnId, invocationId),
      deliveryCommitId: adoptedChildDeliveryCommitIdV1(turnId, invocationId),
      kind: 'execution',
      refinedDelivery,
      preCallCheckpointRef,
    };
    const samples = { count: 0 };
    const port = createJsonlSemanticHistoryJournal({
      filePath,
      artifactsRoot,
      activeTurnJournal: new FileActiveTurnJournal(activeTurnFile),
      rawContent: { read: async ({ content }) => refinedStore.readEvidence(content.ref) },
      timeAuthority: {
        source: 'harness',
        owner: 'runtime-checkpoint-control-owner',
        authorityRef: 'semantic-history-phase-idempotent',
        sampleCommittedAt: async () => {
          samples.count += 1;
          return `2026-10-12T07:1${samples.count}:00.000Z`;
        },
      },
    });
    const accepted = acceptedView(admittedTurn(), relationship, source, { goal: 'idempotent goal', actions: 'idempotent actions', result: 'idempotent result', nextStep: 'idempotent next' }, 'acceptance-idempotent');

    const firstCommit = await commitSemanticContextViewV1({ port, accepted });
    const retry = await commitSemanticContextViewV1({ port, accepted });
    assert.deepEqual(retry, firstCommit);
    assert.equal(samples.count, 1);

    await assert.rejects(
      () => commitSemanticContextViewV1({
        port,
        accepted: acceptedView(admittedTurn(), relationship, source, { goal: 'conflicting goal', actions: 'idempotent actions', result: 'idempotent result', nextStep: 'idempotent next' }, 'acceptance-idempotent'),
      }),
      /different intent/,
    );
    const { JsonlOrganJournal } = await import('../../packages/adapters/jsonl/src/index.js');
    const records = await new JsonlOrganJournal(filePath).replay();
    assert.equal(records.filter((record) => record.payload?.['kind'] === 'native-semantic-context-view').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exact cold read fails visibly on a corrupted journal instead of returning a fallback', async () => {
  const root = fixtureRoot();
  const filePath = join(root, 'organ.jsonl');
  const artifactsRoot = join(root, 'artifacts');
  const refinedRoot = join(root, 'refined');
  const activeTurnFile = join(root, 'active-turn.jsonl');
  try {
    await mkdir(root, { recursive: true });
    const refinedStore = new ImmutableAssetStore(refinedRoot);
    const refinedReference = await refinedStore.write('semantic-history-refined-corrupt', new TextEncoder().encode('refined child delivery corrupt'));
    const refinedDelivery: RawAsset = {
      ref: { evidenceId: id('evidence', 'semantic-history-refined-corrupt'), kind: 'operation', source: 'semantic-history-public-consumer', locator: refinedReference.locator, digest: refinedReference.digest, scope },
      view: { kind: 'utf8-text' },
    };
    await seedActiveTurn(activeTurnFile, refinedDelivery);

    const first = checkpoint(1, null, 'checkpoint corrupt summary');
    const relationship = await createJsonlCheckpointJournal({ filePath }).commitNativeCheckpoint({
      ownerId: 'runtime-checkpoint-owner',
      checkpoint: first,
      timeAuthority: authority('semantic-history-checkpoint-corrupt', '2026-10-12T08:00:00.000Z'),
    });
    const source: AdoptedChildSourceV1 = {
      parentTurn: projectAdmittedTurnIdentityV1(admittedTurn()),
      invocationId,
      childTurnId,
      deliverySeq,
      adoptionCommitId: adoptedChildAdoptionCommitIdV1(turnId, invocationId),
      deliveryCommitId: adoptedChildDeliveryCommitIdV1(turnId, invocationId),
      kind: 'execution',
      refinedDelivery,
      preCallCheckpointRef,
    };
    const port = createJsonlSemanticHistoryJournal({
      filePath,
      artifactsRoot,
      activeTurnJournal: new FileActiveTurnJournal(activeTurnFile),
      rawContent: { read: async ({ content }) => refinedStore.readEvidence(content.ref) },
      timeAuthority: authority('semantic-history-phase-corrupt', '2026-10-12T08:01:00.000Z'),
    });
    const view = await commitSemanticContextViewV1({
      port,
      accepted: acceptedView(admittedTurn(), relationship, source, { goal: 'corrupt goal', actions: 'corrupt actions', result: 'corrupt result', nextStep: 'corrupt next' }, 'acceptance-corrupt'),
    });
    const publication = await commitSemanticHistoryPublicationV1({
      port,
      ownerId: 'runtime-semantic-history-owner',
      turn: projectAdmittedTurnIdentityV1(admittedTurn()),
      checkpoint: relationship,
      contextView: { identity: view.commitIdentity as SemanticContextViewIdentityV1, receipt: view },
    });
    const lookup = { scope, checkpoint: { id: first.id, scope: first.scope }, publicationReceiptRef: publication.journalReceiptRef };

    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    const target = lines.findIndex((line) => JSON.parse(line).commitId === publication.commitIdentity);
    assert.equal(target === -1, false);
    const corrupted = JSON.parse(lines[target]!) as Record<string, unknown>;
    corrupted['payload'] = { kind: 'native-semantic-history-publication', version: 1, identity: 'history-publication:v1:corrupted' };
    lines[target] = JSON.stringify(corrupted);
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');

    await assert.rejects(
      () => readCommittedSemanticCheckpointV1({ port, lookup }),
      /semantic-history-journal-corrupt|journal record digest mismatch|semantic history/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
