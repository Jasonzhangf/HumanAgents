import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkpointCommitIdentityV2,
  checkpointIntentDigestV1,
  checkpointRefV2,
  id,
  scopeDigest,
  type AdmittedTurn,
  type Checkpoint,
  type CheckpointReceiptRelationshipV1,
  type CheckpointTimeAuthorityMetadata,
  type EvidenceRef,
  type JournalCommitRef,
  type RawAsset,
  type ScopeRef,
  type TaskRuntimeIncarnation,
  type WorkAssignment,
} from '../../../packages/contracts/src/index.js';
import type {
  NativeSegmentSaveSourceV2,
  OriginalBusinessTurnRef,
  ResumedTurnSegmentOpened,
} from '../../../packages/contracts/src/active-turn-segments.js';
import {
  adoptedChildAdoptionCommitIdV1,
  adoptedChildDeliveryCommitIdV1,
  assertSegmentCheckpointRelationshipV2,
  buildSemanticContextViewBodyV2,
  buildSemanticContextViewBodyV1,
  buildSemanticHistoryPublicationBodyV2,
  buildSemanticHistoryPublicationBodyV1,
  contextViewIdentityV1,
  contextViewIntentDigestV2,
  contextViewIntentDigestV1,
  historyPublicationIdentityV1,
  historyPublicationIntentDigestV2,
  historyPublicationIntentDigestV1,
  projectAdmittedTurnIdentityV1,
  projectCommittedSemanticCheckpointV2,
  projectCommittedSemanticCheckpointV1,
  projectSemanticAssetBodyV1,
  SemanticHistoryError,
  semanticAssetDigestV1,
  semanticAssetIdV1,
  validateAcceptedSemanticViewInputV1,
  validateAcceptedSemanticViewInputV2,
  validateSemanticContextViewBody,
  validateSemanticContextViewBodyV1,
  validateSemanticContextViewBodyV2,
  validateSemanticHistoryExactLookupV1,
  validateSemanticHistoryPublicationBody,
  validateSemanticHistoryPublicationBodyV1,
  validateSemanticHistoryPublicationBodyV2,
  validateSemanticPhaseReceiptV1,
  type AcceptedSemanticViewInputV2,
  type AcceptedSemanticViewInputV1,
  type AdoptedChildSourceV1,
  type AdoptedChildSourceV2,
  type SemanticPhaseReceiptV1,
} from '../../../packages/runtime/src/context/semantic-history.js';
import { commitSemanticContextViewV2 } from '../../../packages/runtime/src/checkpoints/semantic-history.js';
import type { SemanticHistoryPersistencePort } from '../../../packages/runtime/src/checkpoints/ports.js';

const scope: ScopeRef = {
  organId: id('organ', 'organ-1'),
  taskId: id('task', 'task-1'),
  cycleId: id('cycle', 'cycle-1'),
  operationId: id('operation', 'operation-1'),
};

const timeAuthority: CheckpointTimeAuthorityMetadata = {
  source: 'harness',
  owner: 'runtime-checkpoint-control-owner',
  authorityRef: 'clock-1',
};

const committedAt = '2026-10-13T00:00:00Z';

function evidence(value: string, refScope: ScopeRef = scope): EvidenceRef {
  return {
    evidenceId: id('evidence', value),
    kind: 'execution',
    source: 'test-fixture',
    locator: `humanagent://fixture/${value}`,
    digest: `sha256:${'c'.repeat(64)}`,
    scope: refScope,
  };
}

function admittedTurn(overrides: Partial<AdmittedTurn> = {}): AdmittedTurn {
  return {
    turnId: 'turn-1',
    workAssignmentRef: 'assignment-1',
    taskRef: scope.taskId!,
    scopeRef: scope,
    cycleRef: scope.cycleId!,
    inputRevision: 1,
    directiveRevision: 2,
    executionEpoch: 3,
    runtimeBindingRef: 'runtime-1',
    permissionRevision: 'permission-1',
    admissionEvidenceRefs: ['admission-evidence-1'],
    currentTurnRef: 'turn-ref-1',
    recoveryStateRef: 'recovery-state-1',
    ...overrides,
  };
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  const checkpointScope = overrides.scope ?? scope;
  return {
    id: id('checkpoint', 'checkpoint-1'),
    scope: checkpointScope,
    cycleId: overrides.cycleId ?? checkpointScope.cycleId!,
    seq: 1,
    previousCheckpointId: null,
    directiveRevision: 2,
    executionEpoch: 3,
    outcome: 'waiting',
    summary: 'Goal: freeze the semantic view. Actions: projected four fields. Result: contract defined. Next step: commit exact records. External impact: none. Recovery owner: runtime.',
    recoveryStateRef: evidence('recovery-state-1', checkpointScope),
    evidenceRefs: [],
    next: { kind: 'continue' },
    ...overrides,
  };
}

async function checkpointRelationship(
  value: Checkpoint,
  journalSeq = 7,
  recordDigest: `sha256:${string}` = `sha256:${'a'.repeat(64)}`,
): Promise<CheckpointReceiptRelationshipV1> {
  const identity = await checkpointCommitIdentityV2({ checkpoint: value });
  const envelope = {
    version: 1 as const,
    identity,
    committedAt,
    timeAuthority,
    intentDigest: await checkpointIntentDigestV1({ checkpoint: value, timeAuthority }),
  };
  const scopeHash = await scopeDigest(value.scope);
  return {
    checkpoint: value,
    envelope,
    receipt: {
      commitIdentity: identity,
      checkpointRef: checkpointRefV2(identity),
      journalReceiptRef: `humanagent://journal-record/v1/${scopeHash}/${journalSeq}/${recordDigest.slice('sha256:'.length)}`,
      committedAt,
      timeAuthority,
    },
    checkpointSeq: value.seq,
    journalSeq,
    recordDigest,
  };
}

function refinedDelivery(value: string): RawAsset {
  return { ref: evidence(value), view: { kind: 'utf8-text' } };
}

function adoptedChild(overrides: Partial<AdoptedChildSourceV1> = {}): AdoptedChildSourceV1 {
  const parentTurn = projectAdmittedTurnIdentityV1(admittedTurn());
  const invocationId = 'invocation-1';
  return {
    parentTurn,
    invocationId,
    childTurnId: 'child-turn-1',
    deliverySeq: 4,
    adoptionCommitId: adoptedChildAdoptionCommitIdV1(parentTurn.turnId, invocationId),
    deliveryCommitId: adoptedChildDeliveryCommitIdV1(parentTurn.turnId, invocationId),
    kind: 'review',
    refinedDelivery: refinedDelivery('refined-child-1'),
    preCallCheckpointRef: 'humanagent://checkpoint/v2/pre-call',
    postReviewCheckpointRef: 'humanagent://checkpoint/v2/post-review',
    ...overrides,
  };
}

async function acceptedInput(
  relationship: CheckpointReceiptRelationshipV1,
  children: readonly AdoptedChildSourceV1[] = [],
): Promise<AcceptedSemanticViewInputV1> {
  return {
    version: 1,
    admittedTurn: admittedTurn(),
    checkpoint: relationship,
    acceptance: {
      ownerId: 'runtime-context-owner',
      acceptanceRef: 'acceptance-1',
      sourceEvidenceRefs: [evidence('source-1')],
    },
    semantics: {
      goal: 'Freeze the semantic-history contract.',
      actions: 'Projected the four fields and bound the original turn.',
      result: 'The contract is defined but not durably published.',
      nextStep: 'Commit the exact view and publication records.',
    },
    adoptedChildren: children,
    recovery: {
      recoveryStateRef: 'recovery-state-1',
      recoveryResponsibilityRef: 'recovery-owner-1',
      unresolvedOperationRefs: ['operation-1'],
      laterErrorRefs: [],
    },
  };
}

const segmentAssignment: WorkAssignment = {
  assignmentId: 'assignment-1',
  taskId: scope.taskId!,
  pipelineNodeId: 'node-1',
  attempt: 1,
  executionEpoch: 3,
  inputRevision: 1,
  objective: 'continue the original business turn',
  targetRefs: [],
  expectedOutputRefs: [],
  successCriteria: ['segment work is accepted'],
  failureCriteria: [],
  incompleteCriteria: [],
  requiredCapabilities: [],
  mergeGate: 'not-required',
};

const segmentIncarnation: TaskRuntimeIncarnation = {
  runtimeId: 'runtime-2',
  generation: 2,
  agentInstanceId: 'agent-2',
  roleId: 'execution',
  taskId: scope.taskId!,
  assignmentId: 'assignment-1',
  executionEpoch: 4,
};

const bindingCommitRef: JournalCommitRef = {
  commitId: 'active-turn:turn-1:binding',
  journalSeq: 1,
  recordDigest: `sha256:${'1'.repeat(64)}`,
};

const openedCommitRef: JournalCommitRef = {
  commitId: 'active-turn-segment:segment-1:segment-opened',
  journalSeq: 2,
  recordDigest: `sha256:${'2'.repeat(64)}`,
};

function originalBusinessTurnRef(): OriginalBusinessTurnRef {
  return {
    businessTurnId: 'turn-1',
    bindingCommitRef,
    execution: { runtimeId: 'runtime-1', executionEpoch: 3 },
  };
}

function resumedSegmentOpened(overrides: Partial<ResumedTurnSegmentOpened> = {}): ResumedTurnSegmentOpened {
  const businessTurnRef = originalBusinessTurnRef();
  return {
    kind: 'segment-opened',
    segmentId: 'segment-1',
    businessTurnRef,
    predecessor: {
      segmentId: 'turn-1',
      recoveryAssetsReceiptRef: 'humanagent://recovery-assets/v2/predecessor',
    },
    binding: {
      businessTurnRef,
      assignment: segmentAssignment,
      execution: { runtimeId: 'runtime-2', executionEpoch: 4 },
      incarnation: segmentIncarnation,
      scope,
    },
    authorityCommitRef: { commitId: 'authority:segment-1', journalSeq: 3, recordDigest: `sha256:${'3'.repeat(64)}` },
    businessRegistrationCommitRef: { commitId: 'registration:segment-1', journalSeq: 4, recordDigest: `sha256:${'4'.repeat(64)}` },
    requestRef: 'segment-request-1',
    inputIdentity: { requestRef: 'segment-request-1', digest: `sha256:${'5'.repeat(64)}` },
    ...overrides,
  };
}

function segmentSource(overrides: Partial<NativeSegmentSaveSourceV2> = {}): NativeSegmentSaveSourceV2 {
  return {
    originalAdmittedTurn: admittedTurn(),
    originalBusinessTurnRef: originalBusinessTurnRef(),
    opened: resumedSegmentOpened(),
    openedCommitRef,
    ...overrides,
  };
}

async function segmentCheckpointRelationship(
  journalSeq = 8,
  recordDigest: `sha256:${string}` = `sha256:${'b'.repeat(64)}`,
): Promise<CheckpointReceiptRelationshipV1> {
  const value = checkpoint({
    id: id('checkpoint', 'checkpoint-segment-1'),
    seq: 2,
    previousCheckpointId: id('checkpoint', 'checkpoint-1'),
    executionEpoch: 4,
  });
  return await checkpointRelationship(value, journalSeq, recordDigest);
}

function adoptedChildV2(overrides: Partial<AdoptedChildSourceV2> = {}): AdoptedChildSourceV2 {
  return {
    ...adoptedChild(),
    segmentId: 'segment-1',
    ...overrides,
  };
}

async function acceptedInputV2(
  relationship: CheckpointReceiptRelationshipV1,
  children: readonly AdoptedChildSourceV2[] = [],
): Promise<AcceptedSemanticViewInputV2> {
  return {
    version: 2,
    segment: segmentSource(),
    checkpoint: relationship,
    acceptance: {
      ownerId: 'runtime-context-owner',
      acceptanceRef: 'acceptance-segment-1',
      sourceEvidenceRefs: [evidence('segment-source-1')],
    },
    semantics: {
      goal: 'Continue the resumed segment.',
      actions: 'Bound the current segment checkpoint.',
      result: 'The v2 accepted input is defined.',
      nextStep: 'Commit the exact v2 view and publication records.',
    },
    adoptedChildren: children,
    recovery: {
      recoveryStateRef: 'segment-recovery-state-1',
      recoveryResponsibilityRef: 'segment-recovery-owner-1',
      unresolvedOperationRefs: ['segment-operation-1'],
      laterErrorRefs: [],
    },
  };
}

async function phaseReceipt(
  phase: 'context-view' | 'history-publication',
  commitIdentity: string,
  journalSeq: number,
  recordDigest: `sha256:${string}`,
): Promise<SemanticPhaseReceiptV1> {
  const scopeHash = await scopeDigest(scope);
  return {
    phase,
    commitIdentity,
    journalReceiptRef: `humanagent://journal-record/v1/${scopeHash}/${journalSeq}/${recordDigest.slice('sha256:'.length)}`,
    journalSeq,
    recordDigest,
    committedAt,
    timeAuthority,
  };
}

async function rejectsCode(action: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SemanticHistoryError, `expected SemanticHistoryError, received ${String(caught)}`);
  assert.equal(caught.code, code);
}

function throwsCode(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SemanticHistoryError, `expected SemanticHistoryError, received ${String(caught)}`);
  assert.equal(caught.code, code);
}

test('phase identities are deterministic, namespace-separated, and keyed by turn plus checkpoint', async () => {
  const first = await checkpointRelationship(checkpoint());
  const secondCheckpoint = checkpoint({
    id: id('checkpoint', 'checkpoint-2'),
    seq: 2,
    previousCheckpointId: id('checkpoint', 'checkpoint-1'),
  });
  const second = await checkpointRelationship(secondCheckpoint, 8, `sha256:${'b'.repeat(64)}`);
  const turn = projectAdmittedTurnIdentityV1(admittedTurn());

  const viewA = await contextViewIdentityV1({ turn, checkpoint: first.checkpoint });
  const viewARepeat = await contextViewIdentityV1({ turn, checkpoint: first.checkpoint });
  const viewB = await contextViewIdentityV1({ turn, checkpoint: second.checkpoint });
  const publicationA = await historyPublicationIdentityV1({ turn, checkpoint: first.checkpoint });
  const publicationB = await historyPublicationIdentityV1({ turn, checkpoint: second.checkpoint });

  assert.equal(viewA, viewARepeat);
  assert.notEqual(viewA, viewB);
  assert.notEqual(publicationA, publicationB);
  assert.equal(viewA.slice('context-view:v1:'.length), publicationA.slice('history-publication:v1:'.length));
});

test('accepted input validates exact turn and checkpoint relationship', async () => {
  const relationship = await checkpointRelationship(checkpoint());
  const accepted = await acceptedInput(relationship, [adoptedChild()]);
  await validateAcceptedSemanticViewInputV1(accepted);

  const mismatchedEpoch = checkpoint({ executionEpoch: 4 });
  const mismatchedEpochRelationship = await checkpointRelationship(mismatchedEpoch);
  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1({
      ...accepted,
      checkpoint: mismatchedEpochRelationship,
    }),
    'semantic-history.relationship.epoch-mismatch',
  );

  const mismatchedDirective = checkpoint({ directiveRevision: 5 });
  const mismatchedDirectiveRelationship = await checkpointRelationship(mismatchedDirective);
  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1({
      ...accepted,
      checkpoint: mismatchedDirectiveRelationship,
    }),
    'semantic-history.relationship.directive-mismatch',
  );

  const otherCycle = id('cycle', 'cycle-2');
  const mismatchedScope: ScopeRef = { ...scope, cycleId: otherCycle };
  const mismatchedCycle = checkpoint({
    scope: mismatchedScope,
    cycleId: otherCycle,
  });
  const mismatchedCycleRelationship = await checkpointRelationship(mismatchedCycle);
  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1({
      ...accepted,
      checkpoint: mismatchedCycleRelationship,
    }),
    'semantic-history.relationship.scope-mismatch',
  );

  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1({
      ...accepted,
      recovery: { ...accepted.recovery, recoveryStateRef: 'other-recovery-state' },
    }),
    'semantic-history.recovery.state-mismatch',
  );
});

test('view intent is stable for the same facts and changes with accepted facts', async () => {
  const relationship = await checkpointRelationship(checkpoint());
  const turn = projectAdmittedTurnIdentityV1(admittedTurn());
  const semantics = {
    goal: 'g',
    actions: 'a',
    result: 'r',
    nextStep: 'n',
  };
  const semanticDigest = await semanticAssetDigestV1(semantics);
  const semanticAsset = {
    assetId: semanticAssetIdV1(semanticDigest),
    digest: semanticDigest,
    locator: 'humanagent://asset/semantic-view-v1',
    size: 42,
  };
  const acceptance = {
    ownerId: 'runtime-context-owner',
    acceptanceRef: 'acceptance-1',
    sourceEvidenceRefs: [evidence('source-1')],
  };
  const recovery = {
    recoveryStateRef: 'recovery-state-1',
    recoveryResponsibilityRef: 'recovery-owner-1',
    unresolvedOperationRefs: ['operation-1'],
    laterErrorRefs: [],
  };
  const intent = await contextViewIntentDigestV1({
    turn,
    checkpoint: relationship,
    acceptance,
    semanticAsset,
    adoptedChildren: [],
    evidenceRefs: acceptance.sourceEvidenceRefs,
    recovery,
  });
  const repeat = await contextViewIntentDigestV1({
    turn,
    checkpoint: relationship,
    acceptance,
    semanticAsset,
    adoptedChildren: [],
    evidenceRefs: acceptance.sourceEvidenceRefs,
    recovery,
  });
  assert.equal(intent, repeat);

  const changedAcceptance = { ...acceptance, acceptanceRef: 'acceptance-2' };
  const changed = await contextViewIntentDigestV1({
    turn,
    checkpoint: relationship,
    acceptance: changedAcceptance,
    semanticAsset,
    adoptedChildren: [],
    evidenceRefs: changedAcceptance.sourceEvidenceRefs,
    recovery,
  });
  assert.notEqual(intent, changed);
});

test('adoption selector rejects unbound, wrong-parent, and review-checkpoint drift', async () => {
  const relationship = await checkpointRelationship(checkpoint());
  const child = adoptedChild();
  await validateAcceptedSemanticViewInputV1(await acceptedInput(relationship, [child]));
  const wrongCommit = await acceptedInput(relationship, [{
    ...child,
    adoptionCommitId: 'active-turn:turn-1:adopted:other',
  }]);
  const otherParent = projectAdmittedTurnIdentityV1(admittedTurn({ turnId: 'turn-2' }));
  const wrongParent = await acceptedInput(relationship, [{
    ...child,
    parentTurn: otherParent,
    adoptionCommitId: adoptedChildAdoptionCommitIdV1(otherParent.turnId, child.invocationId),
    deliveryCommitId: adoptedChildDeliveryCommitIdV1(otherParent.turnId, child.invocationId),
  }]);
  const postReviewEqualsPreCall = await acceptedInput(relationship, [{
    ...child,
    postReviewCheckpointRef: child.preCallCheckpointRef,
  }]);
  const postReviewOnExecution = await acceptedInput(relationship, [{
    ...child,
    kind: 'execution',
    postReviewCheckpointRef: 'humanagent://checkpoint/v2/post-review',
  }]);

  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1(wrongCommit),
    'semantic-history.adoption.commit-mismatch',
  );

  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1(wrongParent),
    'semantic-history.adoption.parent-mismatch',
  );

  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1(postReviewEqualsPreCall),
    'semantic-history.adoption.post-review-equals-pre-call',
  );

  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1(postReviewOnExecution),
    'semantic-history.adoption.post-review-on-execution',
  );
});

test('semantic asset projection carries only the four fields and rejects whole-object spread', async () => {
  const semantics = {
    goal: 'g',
    actions: 'a',
    result: 'r',
    nextStep: 'n',
  };
  const body = projectSemanticAssetBodyV1(semantics);
  assert.deepEqual(body, { version: 1, semantics });
  assert.deepEqual(Object.keys(body), ['version', 'semantics']);
  assert.deepEqual(Object.keys(body.semantics), ['goal', 'actions', 'result', 'nextStep']);
  const digest = await semanticAssetDigestV1(semantics);
  assert.equal(digest, await semanticAssetDigestV1(semantics));
  assert.notEqual(digest, await semanticAssetDigestV1({ ...semantics, nextStep: 'changed' }));
  assert.equal(semanticAssetIdV1(digest).startsWith('semantic-view-v1-'), true);

  throwsCode(
    () => projectSemanticAssetBodyV1({ ...semantics, OLD_RAW: 'must not leak' } as never),
    'semantic-history.input.invalid',
  );
});

test('context-view body validates exact identity and intent and rejects extra business fields', async () => {
  const relationship = await checkpointRelationship(checkpoint());
  const accepted = await acceptedInput(relationship, [adoptedChild()]);
  const semantics = accepted.semantics;
  const semanticDigest = await semanticAssetDigestV1(semantics);
  const semanticAsset = {
    assetId: semanticAssetIdV1(semanticDigest),
    digest: semanticDigest,
    locator: 'humanagent://asset/semantic-view-v1',
    size: 100,
  };
  const body = await buildSemanticContextViewBodyV1({
    accepted,
    semanticAsset,
    committedAt,
    timeAuthority,
  });
  await validateSemanticContextViewBodyV1(body);

  await rejectsCode(
    () => validateSemanticContextViewBodyV1({ ...body, OLD_RAW: 'must not leak' }),
    'semantic-history.input.invalid',
  );
  await rejectsCode(
    () => validateSemanticContextViewBodyV1({
      ...body,
      identity: body.identity.replace('context-view:v1:', 'context-view:v1:0'),
    }),
    'semantic-history.body.identity-mismatch',
  );
  await rejectsCode(
    () => validateSemanticContextViewBodyV1({
      ...body,
      intentDigest: `sha256:${'f'.repeat(64)}`,
    }),
    'semantic-history.body.intent-mismatch',
  );
});

test('history publication body binds the exact context-view receipt', async () => {
  const relationship = await checkpointRelationship(checkpoint());
  const turn = projectAdmittedTurnIdentityV1(admittedTurn());
  const viewIdentity = await contextViewIdentityV1({ turn, checkpoint: relationship.checkpoint });
  const viewReceipt = await phaseReceipt('context-view', viewIdentity, 11, `sha256:${'d'.repeat(64)}`);
  const publicationBody = await buildSemanticHistoryPublicationBodyV1({
    turn,
    checkpoint: relationship,
    contextView: { identity: viewIdentity, receipt: viewReceipt },
    committedAt,
    timeAuthority,
  });
  await validateSemanticHistoryPublicationBodyV1(publicationBody);

  const wrongReceipt = { ...viewReceipt, phase: 'history-publication' as const };
  await rejectsCode(
    () => buildSemanticHistoryPublicationBodyV1({
      turn,
      checkpoint: relationship,
      contextView: { identity: viewIdentity, receipt: wrongReceipt },
      committedAt,
      timeAuthority,
    }),
    'semantic-history.phase.mismatch',
  );
});

test('committed projection reuses summary and envelope time and keeps phase receipts distinct', async () => {
  const relationship = await checkpointRelationship(checkpoint());
  const turn = projectAdmittedTurnIdentityV1(admittedTurn());
  const viewIdentity = await contextViewIdentityV1({ turn, checkpoint: relationship.checkpoint });
  const publicationIdentity = await historyPublicationIdentityV1({ turn, checkpoint: relationship.checkpoint });
  const viewReceipt = await phaseReceipt('context-view', viewIdentity, 11, `sha256:${'d'.repeat(64)}`);
  const publicationReceipt = await phaseReceipt('history-publication', publicationIdentity, 12, `sha256:${'e'.repeat(64)}`);
  const accepted = await acceptedInput(relationship, [adoptedChild()]);

  const committed = await projectCommittedSemanticCheckpointV1({
    turn,
    checkpoint: relationship,
    contextView: viewReceipt,
    historyPublication: publicationReceipt,
    semantics: accepted.semantics,
    evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
    adoptedChildren: accepted.adoptedChildren,
    recovery: accepted.recovery,
  });
  assert.equal(committed.description, relationship.checkpoint.summary);
  assert.equal(committed.time, relationship.envelope.committedAt);
  assert.equal(committed.nativeCommitIdentity, relationship.envelope.identity);
  assert.notEqual(committed.save.contextView.journalReceiptRef, committed.save.historyPublication.journalReceiptRef);
  assert.deepEqual(committed.semantics, accepted.semantics);

  await rejectsCode(
    () => projectCommittedSemanticCheckpointV1({
      turn,
      checkpoint: relationship,
      contextView: viewReceipt,
      historyPublication: {
        ...publicationReceipt,
        journalSeq: viewReceipt.journalSeq,
        journalReceiptRef: viewReceipt.journalReceiptRef,
        recordDigest: viewReceipt.recordDigest,
      },
      semantics: accepted.semantics,
      evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
      adoptedChildren: accepted.adoptedChildren,
      recovery: accepted.recovery,
    }),
    'semantic-history.phase.shared-receipt',
  );
});

test('phase receipt and exact lookup validation reject wrong scope, sequence, digest, and receipt grammar', async () => {
  const turn = projectAdmittedTurnIdentityV1(admittedTurn());
  const relationship = await checkpointRelationship(checkpoint());
  const viewIdentity = await contextViewIdentityV1({ turn, checkpoint: relationship.checkpoint });
  const receipt = await phaseReceipt('context-view', viewIdentity, 11, `sha256:${'d'.repeat(64)}`);
  await validateSemanticPhaseReceiptV1(receipt, { phase: 'context-view', identity: viewIdentity, scope });

  await rejectsCode(
    () => validateSemanticPhaseReceiptV1({ ...receipt, journalSeq: 99 }, { phase: 'context-view', identity: viewIdentity, scope }),
    'semantic-history.phase.receipt-mismatch',
  );
  await rejectsCode(
    () => validateSemanticPhaseReceiptV1({ ...receipt, recordDigest: `sha256:${'f'.repeat(64)}` }, { phase: 'context-view', identity: viewIdentity, scope }),
    'semantic-history.phase.receipt-mismatch',
  );
  await rejectsCode(
    () => validateSemanticPhaseReceiptV1(receipt, { phase: 'history-publication', identity: viewIdentity, scope }),
    'semantic-history.phase.mismatch',
  );

  validateSemanticHistoryExactLookupV1({
    scope,
    checkpoint: { id: relationship.checkpoint.id, scope: relationship.checkpoint.scope },
    publicationReceiptRef: receipt.journalReceiptRef,
  });
  throwsCode(
    () => validateSemanticHistoryExactLookupV1({
      scope,
      checkpoint: { id: relationship.checkpoint.id, scope: relationship.checkpoint.scope },
      publicationReceiptRef: 'humanagent://journal-record/v1/not-a-receipt',
    }),
    'semantic-history.lookup.receipt-invalid',
  );
});

test('v2 accepted input binds the current segment epoch and separates recovery from the original admission', async () => {
  const relationship = await segmentCheckpointRelationship();
  const accepted = await acceptedInputV2(relationship, [adoptedChildV2()]);
  await validateAcceptedSemanticViewInputV2(accepted);

  // The v2 branch never rewrites the original immutable admission bytes.
  assert.deepEqual(accepted.segment.originalAdmittedTurn, admittedTurn());
  assert.deepEqual(
    projectAdmittedTurnIdentityV1(accepted.segment.originalAdmittedTurn),
    projectAdmittedTurnIdentityV1(admittedTurn()),
  );

  // The v1 gate still rejects the E2 checkpoint against the E1 admission.
  const v1Accepted = await acceptedInput(relationship, []);
  await rejectsCode(
    () => validateAcceptedSemanticViewInputV1(v1Accepted),
    'semantic-history.relationship.epoch-mismatch',
  );

  // A checkpoint at the original epoch is not a current-segment checkpoint.
  const originalEpochCheckpoint = await checkpointRelationship(checkpoint({
    id: id('checkpoint', 'checkpoint-segment-original-epoch'),
    seq: 2,
    previousCheckpointId: id('checkpoint', 'checkpoint-1'),
    executionEpoch: 3,
  }));
  await rejectsCode(
    () => validateAcceptedSemanticViewInputV2({ ...accepted, checkpoint: originalEpochCheckpoint }),
    'semantic-history.relationship.epoch-mismatch',
  );

  // A foreign segment scope is rejected before any phase write.
  const foreignScope: ScopeRef = { ...scope, cycleId: id('cycle', 'cycle-2') };
  const foreignOpened = resumedSegmentOpened({
    binding: { ...resumedSegmentOpened().binding, scope: foreignScope },
  });
  await rejectsCode(
    () => validateAcceptedSemanticViewInputV2({
      ...accepted,
      segment: segmentSource({ opened: foreignOpened }),
    }),
    'semantic-history.segment.scope-mismatch',
  );

  // A child adopted in a different segment is rejected by the exact selector.
  await rejectsCode(
    () => validateAcceptedSemanticViewInputV2({
      ...accepted,
      adoptedChildren: [adoptedChildV2({ segmentId: 'segment-2' })],
    }),
    'semantic-history.adoption.segment-mismatch',
  );

  // The current recovery facts are read from the segment source, not the admission.
  assert.notEqual(accepted.recovery.recoveryStateRef, accepted.segment.originalAdmittedTurn.recoveryStateRef);
});

test('v2 view body uses the v2 domain, binds the segment source, and is rejected by the v1 decoder', async () => {
  const relationship = await segmentCheckpointRelationship();
  const accepted = await acceptedInputV2(relationship, [adoptedChildV2()]);
  const semanticDigest = await semanticAssetDigestV1(accepted.semantics);
  const semanticAsset = {
    assetId: semanticAssetIdV1(semanticDigest),
    digest: semanticDigest,
    locator: 'humanagent://asset/semantic-view-v2',
    size: 128,
  };
  const body = await buildSemanticContextViewBodyV2({ accepted, semanticAsset, committedAt, timeAuthority });
  assert.equal(body.version, 2);
  assert.deepEqual(body.segment, accepted.segment);
  await validateSemanticContextViewBodyV2(body);
  await validateSemanticContextViewBody(body);

  const turn = projectAdmittedTurnIdentityV1(accepted.segment.originalAdmittedTurn);
  assert.equal(body.identity, await contextViewIdentityV1({ turn, checkpoint: relationship.checkpoint }));

  await rejectsCode(() => validateSemanticContextViewBodyV1(body), 'semantic-history.input.invalid');

  const intent = await contextViewIntentDigestV2({
    segment: accepted.segment,
    checkpoint: relationship,
    acceptance: accepted.acceptance,
    semanticAsset,
    adoptedChildren: accepted.adoptedChildren,
    evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
    recovery: accepted.recovery,
  });
  const repeat = await contextViewIntentDigestV2({
    segment: accepted.segment,
    checkpoint: relationship,
    acceptance: accepted.acceptance,
    semanticAsset,
    adoptedChildren: accepted.adoptedChildren,
    evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
    recovery: accepted.recovery,
  });
  assert.equal(intent, repeat);
  const changedSource = await contextViewIntentDigestV2({
    segment: segmentSource({ openedCommitRef: { ...openedCommitRef, journalSeq: 9 } }),
    checkpoint: relationship,
    acceptance: accepted.acceptance,
    semanticAsset,
    adoptedChildren: accepted.adoptedChildren,
    evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
    recovery: accepted.recovery,
  });
  assert.notEqual(intent, changedSource);

  // A v1 body must not be accepted by the v2 decoder.
  const v1Relationship = await checkpointRelationship(checkpoint());
  const v1Accepted = await acceptedInput(v1Relationship, []);
  const v1Body = await buildSemanticContextViewBodyV1({ accepted: v1Accepted, semanticAsset, committedAt, timeAuthority });
  await rejectsCode(() => validateSemanticContextViewBodyV2(v1Body), 'semantic-history.input.invalid');
});

test('v2 publication body binds the exact context-view receipt and the segment source', async () => {
  const relationship = await segmentCheckpointRelationship();
  const accepted = await acceptedInputV2(relationship, []);
  const turn = projectAdmittedTurnIdentityV1(accepted.segment.originalAdmittedTurn);
  const viewIdentity = await contextViewIdentityV1({ turn, checkpoint: relationship.checkpoint });
  const viewReceipt = await phaseReceipt('context-view', viewIdentity, 11, `sha256:${'d'.repeat(64)}`);
  const publication = await buildSemanticHistoryPublicationBodyV2({
    turn,
    segment: accepted.segment,
    checkpoint: relationship,
    contextView: { identity: viewIdentity, receipt: viewReceipt },
    committedAt,
    timeAuthority,
  });
  assert.equal(publication.version, 2);
  await validateSemanticHistoryPublicationBodyV2(publication);
  await validateSemanticHistoryPublicationBody(publication);
  await rejectsCode(() => validateSemanticHistoryPublicationBodyV1(publication), 'semantic-history.input.invalid');

  const wrongReceipt = { ...viewReceipt, phase: 'history-publication' as const };
  await rejectsCode(
    () => buildSemanticHistoryPublicationBodyV2({
      turn,
      segment: accepted.segment,
      checkpoint: relationship,
      contextView: { identity: viewIdentity, receipt: wrongReceipt },
      committedAt,
      timeAuthority,
    }),
    'semantic-history.phase.mismatch',
  );
});

test('v2 committed projection carries the segment source and keeps phase receipts distinct', async () => {
  const relationship = await segmentCheckpointRelationship();
  const accepted = await acceptedInputV2(relationship, [adoptedChildV2()]);
  const turn = projectAdmittedTurnIdentityV1(accepted.segment.originalAdmittedTurn);
  const viewIdentity = await contextViewIdentityV1({ turn, checkpoint: relationship.checkpoint });
  const publicationIdentity = await historyPublicationIdentityV1({ turn, checkpoint: relationship.checkpoint });
  const viewReceipt = await phaseReceipt('context-view', viewIdentity, 11, `sha256:${'d'.repeat(64)}`);
  const publicationReceipt = await phaseReceipt('history-publication', publicationIdentity, 12, `sha256:${'e'.repeat(64)}`);
  const committed = await projectCommittedSemanticCheckpointV2({
    turn,
    segment: accepted.segment,
    checkpoint: relationship,
    contextView: viewReceipt,
    historyPublication: publicationReceipt,
    semantics: accepted.semantics,
    evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
    adoptedChildren: accepted.adoptedChildren,
    recovery: accepted.recovery,
  });
  assert.equal(committed.version, 2);
  assert.deepEqual(committed.segment, accepted.segment);
  assert.equal(committed.description, relationship.checkpoint.summary);
  assert.equal(committed.time, relationship.envelope.committedAt);
  assert.notEqual(committed.save.contextView.journalReceiptRef, committed.save.historyPublication.journalReceiptRef);

  await rejectsCode(
    () => projectCommittedSemanticCheckpointV2({
      turn,
      segment: accepted.segment,
      checkpoint: relationship,
      contextView: viewReceipt,
      historyPublication: {
        ...publicationReceipt,
        journalSeq: viewReceipt.journalSeq,
        journalReceiptRef: viewReceipt.journalReceiptRef,
        recordDigest: viewReceipt.recordDigest,
      },
      semantics: accepted.semantics,
      evidenceRefs: accepted.acceptance.sourceEvidenceRefs,
      adoptedChildren: accepted.adoptedChildren,
      recovery: accepted.recovery,
    }),
    'semantic-history.phase.shared-receipt',
  );
});

test('v2 commit consumer accepts the E1 admission with an E2 segment checkpoint and rejects missing or wrong sources', async () => {
  const relationship = await segmentCheckpointRelationship();
  const accepted = await acceptedInputV2(relationship, [adoptedChildV2()]);
  const turn = projectAdmittedTurnIdentityV1(accepted.segment.originalAdmittedTurn);
  const viewIdentity = await contextViewIdentityV1({ turn, checkpoint: relationship.checkpoint });
  const receipt = await phaseReceipt('context-view', viewIdentity, 11, `sha256:${'d'.repeat(64)}`);
  let captured: AcceptedSemanticViewInputV2 | undefined;
  const port: SemanticHistoryPersistencePort = {
    commitContextView: async () => { throw new Error('v1 commit must not run'); },
    commitContextViewV2: async (input) => { captured = input.accepted; return receipt; },
    commitHistoryPublication: async () => { throw new Error('v1 commit must not run'); },
    readContextView: async () => null,
    readCommittedSemanticCheckpoint: async () => null,
  };
  const committed = await commitSemanticContextViewV2({ port, accepted });
  assert.equal(committed.journalReceiptRef, receipt.journalReceiptRef);
  assert.deepEqual(captured, accepted);
  assert.deepEqual(captured!.segment.originalAdmittedTurn, admittedTurn());

  const originalEpochCheckpoint = await checkpointRelationship(checkpoint({
    id: id('checkpoint', 'checkpoint-segment-original-epoch'),
    seq: 2,
    previousCheckpointId: id('checkpoint', 'checkpoint-1'),
    executionEpoch: 3,
  }));
  await rejectsCode(
    () => commitSemanticContextViewV2({ port, accepted: { ...accepted, checkpoint: originalEpochCheckpoint } }),
    'semantic-history.relationship.epoch-mismatch',
  );

  const missingV2Port: SemanticHistoryPersistencePort = {
    commitContextView: async () => receipt,
    commitHistoryPublication: async () => receipt,
    readContextView: async () => null,
    readCommittedSemanticCheckpoint: async () => null,
  };
  await rejectsCode(
    () => commitSemanticContextViewV2({ port: missingV2Port, accepted }),
    'semantic-history.port.v2-unavailable',
  );
});
