import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { id } from '../../dist/app/contracts/src/index.js';
import { resolveRuntimePaths } from '../../dist/app/config/src/index.js';
import { JsonlOrganJournal } from '../../dist/app/adapters/jsonl/src/index.js';
import { JsonlTaskIdentityJournal } from '../../dist/app/adapters/jsonl/src/task-identities.js';
import { JsonlTaskGrantJournal } from '../../dist/app/adapters/jsonl/src/task-grants.js';
import { createJsonlActiveTurnJournal } from '../../dist/app/adapters/jsonl/src/active-turn.js';
import { JsonlOperationCompletionJournal } from '../../dist/app/adapters/jsonl/src/operation-completion.js';
import { ImmutableAssetStore, evidenceReference } from '../../dist/app/adapters/filesystem/src/index.js';
import { MemoryCoordinator } from '../../dist/app/runtime/src/memory/index.js';
import { ActiveTurnContext } from '../../dist/app/runtime/src/context/active-turn-context.js';
import { adoptedChildAdoptionCommitIdV1, adoptedChildDeliveryCommitIdV1, contextViewIdentityV1, projectAdmittedTurnIdentityV1 } from '../../dist/app/runtime/src/context/semantic-history.js';
import { commitSemanticContextViewV1, commitSemanticHistoryPublicationV1 } from '../../dist/app/runtime/src/checkpoints/semantic-history.js';
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js';
import { admitTaskGrantBusiness } from '../../dist/app/runtime/src/admission/task-grant.js';
import { durableContextDigest, produceContextHistory } from '../../dist/app/runtime/src/checkpoints/coordinator.js';
import { prepareCheckpointClosure } from '../../dist/app/runtime/src/checkpoints/closure.js';
import { submitCheckpoint } from '../../dist/app/runtime/src/checkpoints/submission.js';
import { CheckpointSubmissionError } from '../../dist/app/runtime/src/checkpoints/errors.js';
import { conditionalReentryFromRecord, contextCorrectionFromRecord, createJsonlCheckpointJournal, createJsonlCheckpointClosurePort, createJsonlContextHistoryPort, createJsonlSemanticHistoryJournal, exactJournalRecord } from '../../dist/app/app/src/checkpoint-journal.js';
import { createNativeRecoveryAssets } from '../../dist/app/app/src/native-recovery-assets.js';
import { createJsonlOperationControlJournal, readOperationControlFromRecords } from '../../dist/app/app/src/operation-control-journal.js';
import { UiRuntimeService } from '../../dist/app/app/src/ui-runtime/service.js';
import { startUiRuntime } from '../../dist/app/app/src/ui-runtime/index.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../dist/app/app/src/runtime-current-state-journal.js';
import { createUiRuntimeRequestDispatcher } from '../../dist/app/app/src/ui-runtime/server.js';
import { AccessControlService } from '../../dist/app/app/src/ui-runtime/access-control.js';
import { UiRuntimeJournal, uiRuntimeJournalPath, uiRuntimeControlJournalPath, uiRuntimeModeRoot } from '../../dist/app/app/src/ui-runtime/journal.js';
import {
  ConfirmedControlExpectedConflict,
  executeConfirmedTaskCheckpointReentry,
  executeConfirmedTaskContextCorrection,
  readCurrentFromRecords,
} from '../../dist/app/app/src/ui-runtime/reentry-current-facts.js';

// Known old-route defects: current is always undefined and receipt query keys are ignored.
// A wrong recovery target has high correctness impact. One local HTTP consumer costs no model calls.
const fixtureRoot = join(homedir(), '.humanagent/test-fixtures/ux-checkpoint-public-read-20261015');
const organId = id('organ', 'c3-http-organ');
const taskId = id('task', 'c3-http-task');
const taskScope = { organId, taskId };
const cycleId = id('cycle', 'c3-http-cycle');
const scope = { ...taskScope, cycleId };
const otherTaskId = id('task', 'c3-other-task');
const otherTaskScope = { organId, taskId: otherTaskId };
const at = '2026-10-15T02:00:00.000Z';
const owner = 'c3-http-consumer';
const controlWrongRef = 'business-ref:m5-wrong-a';
const controlSimilarRef = 'business-ref:m5-wrong-a2';
const controlAcceptedRef = 'accepted-fact';

async function snapshot(root) {
  const files = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files[child] = (await readFile(child)).toString('base64');
    }
  }
  await visit(root);
  return files;
}

export async function fixture({ cold = false, controlCase = false, principalOwner: requestedPrincipalOwner } = {}) {
  const scope = cold || controlCase
    ? {
        ...taskScope,
        cycleId,
        operationId: id('operation', cold ? 'c3-cold-operation' : 'c3-control-operation'),
      }
    : { ...taskScope, cycleId };
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'http-'));
  const paths = await resolveRuntimePaths({ workspace: process.cwd(), controlRoot: root });
  const accessControl = await AccessControlService.open({ credentialPath: paths.webAccessCredentialPath, create: true });
  const principalOwner = requestedPrincipalOwner ?? (controlCase ? accessControl.readProductPrincipalOwner() : owner);
  const filePath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(paths.checkpointsRoot, 'fake'));
  const journal = new JsonlOrganJournal(filePath);
  const identities = new JsonlTaskIdentityJournal(journal);
  const identitySource = {
    requirementId: 'c3-requirement', inputRevision: 1, draftId: 'c3-draft',
    draftRevisionVersion: 1, draftRevisionHash: 'c3-draft-hash', confirmationRef: 'c3-confirmation',
  };
  await identities.append({ scope: taskScope, source: identitySource });
  await identities.append({ scope: { organId, taskId: id('task', 'c3-other-task') }, source: identitySource });
  const uiJournal = new UiRuntimeJournal(uiRuntimeJournalPath(paths.checkpointsRoot, 'fake'));
  uiJournal.append({ kind: 'task.created', taskId, title: 'C3 read', directive: 'read exact history',
    directiveRevision: 1, createdAt: at, taskCounter: 1 });
  const checkpoints = createJsonlCheckpointJournal({ filePath, journal });
  const contexts = createJsonlContextHistoryPort({ filePath, journal });
  const closures = createJsonlCheckpointClosurePort({ filePath, journal });
  const grants = new JsonlTaskGrantJournal(journal);
  const capability = { actionId: 'checkpoint.save', capabilities: ['provider.execution'], scope: taskScope };
  await grants.grant({ requestId: 'c3-grant', taskId, owner: principalOwner, capability, expectedRevision: 0 });
  const grantReadback = await grants.readTaskGrant(taskId);
  assert.equal(grantReadback.grant?.owner, principalOwner);
  assert.ok(grantReadback.commit);
  const request = { requestRef: 'c3-read-business', taskId, owner: principalOwner, capability,
    inputIdentity: { requestRef: 'c3-read-business', digest: 'c3-http-intent' } };
  const admitted = await admitTaskGrantBusiness({ port: grants, request, principalOwner,
    register: async (authority, registration) => ({ authority, registrationCommitRef:
      await registration.registerBusiness({ ...request, grantRevision: authority.grant.revision }) }) });
  assert.equal(admitted.authority.owner, principalOwner);
  assert.deepEqual(admitted.authority.commit, grantReadback.commit);
  const operationControl = createJsonlOperationControlJournal({ journal });
  const selector = { scope, agentRuntimeId: 'c3-runtime', harnessExecutionEpoch: 4 };
  await operationControl.initializeCoverage({ ...selector, admissionCommitRef: admitted.registrationCommitRef });
  const ref = { checkpointId: id('checkpoint', 'c3-loop'), digest: 'c3-loop-digest' };
  const watermark = { streamId: 'c3-stream', sequence: 0 };
  const activeRefs = controlCase
    ? [controlAcceptedRef, controlWrongRef, controlSimilarRef]
    : [controlAcceptedRef];
  const durableContext = { stablePrefix: ['instructions'], indexRefs: activeRefs, dynamicHead: ['accepted fact'], repairRefs: [] };
  const context = { kind: 'context-history', schemaVersion: 1, scope, agentRuntimeId: selector.agentRuntimeId,
    contextView: { contextViewRef: 'c3-context', executionEpoch: 4, checkpoint: ref,
      contextDigest: 'c3-context-digest', activeRefs, omittedRefs: [] },
    loopCheckpoint: { ...ref, sequence: 1, predecessor: null, executionEpoch: 4,
      eventWatermark: watermark, observationScopeId: 'c3-observation', contextViewRef: 'c3-context' },
    replacement: null, previousContextCommitRef: null, durableContext,
    durableContextDigest: durableContextDigest(durableContext),
    loopControl: { mode: 'observation', transitionSeq: 1, observationScopeId: 'c3-observation', observationScope: null,
      inboxStreamId: watermark.streamId, inboxExecutionEpoch: 4, inboxCheckpoint: ref,
      inboxObservationScopeId: 'c3-observation', inboxWatermark: 0, handledEventIds: [], handledBatchKeys: [],
      deltaExecutionEpoch: 4, deltaCheckpoint: ref, deltaObservationScopeId: 'c3-observation', deltaWatermark: watermark,
      appliedDeltaIds: [], appliedDeltaKeys: [], closedObservationScopeIds: [],
      budgetUsage: { modeTransitions: 1, observationScopes: 1, contextReplacements: 0, deferredEvents: 0 } } };
  const contextCommit = await produceContextHistory(contexts, { record: context, expectedCurrentContextCommitRef: null });
  const contextBody = await contexts.readContextCommit(scope, contextCommit.commitRef);
  assert.ok(contextBody);
  if (controlCase) assert.deepEqual(contextBody.contextView.activeRefs, activeRefs);
  const evidence = (label) => ({ evidenceId: id('evidence', label), kind: 'operation', source: principalOwner,
    locator: `humanagent://c3/${label}`, scope });
  const checkpoint = (seq, previous) => ({ id: id('checkpoint', `c3-checkpoint-${seq}`), scope, cycleId, seq,
    previousCheckpointId: previous?.id ?? null, directiveRevision: seq, executionEpoch: 4,
    outcome: cold ? 'blocked' : 'waiting', summary: `C3 checkpoint ${seq}`, recoveryStateRef: evidence(`recovery-${seq}`),
    evidenceRefs: [evidence(`evidence-${seq}`)], next: { kind: cold ? 'recover' : 'wait', ref: owner } });
  const a = checkpoint(1, null);
  const timeAuthority = { source: 'harness', owner: 'runtime-checkpoint-control-owner', authorityRef: 'c3-clock', sampleCommittedAt: async () => at };
  const turn = { turnId: 'c3-turn', workAssignmentRef: 'c3-assignment', taskRef: taskId, scopeRef: scope,
    cycleRef: cycleId, inputRevision: 1, directiveRevision: 1, executionEpoch: 4, runtimeBindingRef: selector.agentRuntimeId,
    permissionRevision: admitted.authority.permissionRevision, admissionEvidenceRefs: [admitted.registrationCommitRef.commitId],
    currentTurnRef: 'active-turn://c3-turn', recoveryStateRef: 'c3-recovery' };
  const assignment = { assignmentId: turn.workAssignmentRef, taskId, pipelineNodeId: 'c3-node', attempt: 1,
    executionEpoch: 4, inputRevision: 1, objective: 'read checkpoint history', targetRefs: [], expectedOutputRefs: [],
    acceptanceCriteriaDigest: 'c3-acceptance', successCriteria: ['exact read'], failureCriteria: [],
    incompleteCriteria: [], requiredCapabilities: [], mergeGate: 'not-required' };
  const activeTurnJournal = createJsonlActiveTurnJournal({ journal, turnId: turn.turnId });
  const active = await ActiveTurnContext.open({ journal: activeTurnJournal,
    binding: { admittedTurn: turn, assignment, execution: { runtimeId: selector.agentRuntimeId, executionEpoch: 4 }, scope },
    currentTurnRef: turn.currentTurnRef });
  const artifactsRoot = join(paths.artifactsRoot, 'ui-provider-evidence');
  const nativeAssets = createNativeRecoveryAssets({ journalPath: filePath, journal, assetRoot: artifactsRoot,
    completionJournal: new JsonlOperationCompletionJournal({ journal }) });
  const initialInput = await nativeAssets.writeInitialInput({ scope, turnId: turn.turnId, rawInput: 'read exact history' });
  await active.registerInitialInput(initialInput);
  const nativeA = await checkpoints.commitNativeCheckpoint({ ownerId: principalOwner, checkpoint: a, timeAuthority });
  const assets = new ImmutableAssetStore(artifactsRoot);
  const turnIdentity = projectAdmittedTurnIdentityV1(turn);
  // Legal adopted-child producer chain. Two distinct refined deliveries are written to the
  // real store, returned through the real child lifecycle, then adopted by the owner.
  // This runs before capture freezes the active turn; the semantic publication below only
  // cites these durable relationships. Nothing is seeded as a DTO.
  const childInvocationIds = ['c3-child-alpha', 'c3-child-beta'];
  const childTexts = { [childInvocationIds[0]]: 'refined alpha delivery body', [childInvocationIds[1]]: 'refined beta delivery body' };
  const adoptedSources = [];
  let crossSource;
  let crossChild;
  if (!controlCase) {
    for (const [index, invocationId] of childInvocationIds.entries()) {
      const childTurnId = `c3-child-turn-${index}`;
      const reference = await assets.write(`c3-child-${index}`, new TextEncoder().encode(childTexts[invocationId]));
      const refinedDelivery = { ref: evidenceReference(reference, scope, 'operation', `c3-child-body-${index}`), view: { kind: 'utf8-text' } };
      await active.openChildInvocation({ invocationId, childTurnId, checkpointReceiptRef: nativeA.receipt.journalReceiptRef,
        binding: { kind: 'execution', assignment } });
      const returnedDelivery = await active.recordChildReturn({ kind: 'execution', invocationId, refinedDelivery, assignment,
        result: { taskId, pipelineNodeId: assignment.pipelineNodeId, agentId: principalOwner, assignmentId: assignment.assignmentId,
          attempt: assignment.attempt, executionEpoch: assignment.executionEpoch, inputRevision: assignment.inputRevision,
          producedArtifactRefs: [], producedArtifactDigests: [], status: 'succeeded', summary: `refined child ${index}`,
          outputRefs: [], evidenceRefs: [evidence(`child-result-${index}`)], nextAction: 'continue' } });
      await active.recordChildAdoption(invocationId, returnedDelivery);
      adoptedSources.push({ parentTurn: turnIdentity, invocationId, childTurnId, deliverySeq: returnedDelivery.seq,
        adoptionCommitId: adoptedChildAdoptionCommitIdV1(turn.turnId, invocationId),
        deliveryCommitId: adoptedChildDeliveryCommitIdV1(turn.turnId, invocationId), kind: 'execution',
        refinedDelivery, preCallCheckpointRef: nativeA.receipt.journalReceiptRef });
    }
    assert.equal(new Set(adoptedSources.map((child) => child.deliverySeq)).size, 2);
  // Third adopted delivery: real return, adoption and matching source, but its refined
  // asset carries another canonical task scope. The parent assignment and result stay
  // legitimate; only the delivered asset scope crosses to c3-other-task.
    const crossTaskIndex = childInvocationIds.length;
    const crossInvocationId = 'c3-child-cross-task';
    const crossTurnId = `c3-child-turn-${crossTaskIndex}`;
    const crossText = 'refined cross-task delivery body';
    const crossReference = await assets.write(`c3-child-${crossTaskIndex}`, new TextEncoder().encode(crossText));
    const crossRefinedDelivery = { ref: evidenceReference(crossReference, otherTaskScope, 'operation', `c3-child-body-${crossTaskIndex}`), view: { kind: 'utf8-text' } };
    await active.openChildInvocation({ invocationId: crossInvocationId, childTurnId: crossTurnId, checkpointReceiptRef: nativeA.receipt.journalReceiptRef,
      binding: { kind: 'execution', assignment } });
    const crossReturned = await active.recordChildReturn({ kind: 'execution', invocationId: crossInvocationId, refinedDelivery: crossRefinedDelivery, assignment,
      result: { taskId, pipelineNodeId: assignment.pipelineNodeId, agentId: principalOwner, assignmentId: assignment.assignmentId,
        attempt: assignment.attempt, executionEpoch: assignment.executionEpoch, inputRevision: assignment.inputRevision,
        producedArtifactRefs: [], producedArtifactDigests: [], status: 'succeeded', summary: `refined child ${crossTaskIndex}`,
        outputRefs: [], evidenceRefs: [evidence(`child-result-${crossTaskIndex}`)], nextAction: 'continue' } });
    await active.recordChildAdoption(crossInvocationId, crossReturned);
    crossSource = { parentTurn: turnIdentity, invocationId: crossInvocationId, childTurnId: crossTurnId, deliverySeq: crossReturned.seq,
      adoptionCommitId: adoptedChildAdoptionCommitIdV1(turn.turnId, crossInvocationId),
      deliveryCommitId: adoptedChildDeliveryCommitIdV1(turn.turnId, crossInvocationId), kind: 'execution',
      refinedDelivery: crossRefinedDelivery, preCallCheckpointRef: nativeA.receipt.journalReceiptRef };
    crossChild = { invocationId: crossInvocationId, childTurnId: crossTurnId, deliverySeq: crossReturned.seq,
      refinedDelivery: crossRefinedDelivery, text: crossText, preCallCheckpointRef: crossSource.preCallCheckpointRef };
  }
  const captureBody = await active.prepareCapture({ pauseId: 'c3-boundary', frozenAt: at, initialInput,
    checkpointPath: [], completionRefs: [] });
  const capture = await nativeAssets.commitCapturePhase({ turnId: turn.turnId, boundaryId: captureBody.cut.pauseId,
    prepared: { body: captureBody, controlRecordCount: active.controlRecordCount(), producerDrains: [], completionLookups: [],
      recovery: { commitIdentity: 'c3-hold', laterErrorRefs: [], rawTurnRefs: [turn.currentTurnRef], unresolvedOperationRefs: [],
        stages: [], durablePhases: [], durableReceiptRefs: [], recoveryResponsibilityRef: principalOwner } } });
  const preparation = await prepareCheckpointClosure({ checkpoint: a, source: 'harness-control', closureReason: 'empty boundary',
    contextCommitRef: contextCommit.commitRef, contextHistory: contexts, operationSelector: selector,
    operationControl: await operationControl.readControl(selector), permission: { permissionRevision: admitted.authority.permissionRevision,
      grantCommitRef: admitted.authority.commit, revoked: false }, hardBlockers: [], unreturnedCallRefs: [],
    unresolvedOperationRefs: [], closurePort: closures, now: () => new Date(at) });
  await submitCheckpoint({ ownerId: principalOwner, source: 'harness-control', checkpoint: a, previous: null,
    journal: checkpoints, closurePort: closures, preparation, turnRecoveryRef: capture.commitIdentity });
  const semantic = createJsonlSemanticHistoryJournal({ filePath, journal, artifactsRoot,
    activeTurnJournal, rawContent: { read: async ({ content }) => assets.readEvidence(content.ref) }, timeAuthority });
  const semantics = { goal: 'read exact history', actions: 'inspect Journal', result: 'A remains current', nextStep: 'inspect A' };
  const view = await commitSemanticContextViewV1({ port: semantic, accepted: { version: 1,
    admittedTurn: turn, checkpoint: nativeA, acceptance: { ownerId: principalOwner, acceptanceRef: 'c3-semantic-accepted',
      sourceEvidenceRefs: [evidence('semantic-accepted')] }, semantics,
      adoptedChildren: crossSource === undefined ? adoptedSources : [...adoptedSources, crossSource],
    recovery: { recoveryStateRef: turn.recoveryStateRef, recoveryResponsibilityRef: principalOwner, unresolvedOperationRefs: [], laterErrorRefs: [] } } });
  const publication = await commitSemanticHistoryPublicationV1({ port: semantic, ownerId: principalOwner, turn: turnIdentity,
    checkpoint: nativeA, contextView: { identity: await contextViewIdentityV1({ turn: turnIdentity, checkpoint: a }), receipt: view } });
  const b = checkpoint(2, a);
  await checkpoints.commitNativeCheckpoint({ ownerId: principalOwner, checkpoint: b, timeAuthority });
  const recordA = await checkpoints.readCommitted(scope, a.id);
  const recordB = await checkpoints.readCommitted(scope, b.id);
  assert.ok(recordA && recordB);
  if (cold) {
    uiJournal.append({ kind: 'operation.started', taskId, cycleId, operationId: scope.operationId, scope,
      executionEpoch: 4, operationCounter: 1, cycleCounter: 1, startedAt: at, input: 'read exact history' });
    await createJsonlRuntimeTaskCurrentStateJournal({ journal }).commit({
      taskScope: scope, transitionId: 'c3-cold-succeeded', expectedStateCommitRef: null,
      state: {
        task: { id: taskId, organId, title: 'C3 read', directive: 'read exact history',
          directiveRevision: 2, state: 'succeeded', memoryScope: 'task' },
        processing: { entryPhase: 'aligned', nextAction: { kind: 'continue' }, hardBlockers: [],
          recoveryResponsibilityRef: owner, laterErrorRefs: [],
          stages: [{ stageId: 'alignment', state: 'succeeded', evidenceRefs: [] }] },
        retainedDuties: [], sourceCommitRefs: [recordB.commitRef],
      },
    });
  }
  if (controlCase) {
    uiJournal.append({ kind: 'operation.started', taskId, cycleId, operationId: scope.operationId, scope,
      executionEpoch: 4, operationCounter: 1, cycleCounter: 1, startedAt: at, input: 'read exact history' });
    await createJsonlRuntimeTaskCurrentStateJournal({ journal }).commit({
      taskScope: scope, transitionId: 'c3-http-control-current', expectedStateCommitRef: null,
      state: {
        task: { id: taskId, organId, title: 'C3 read', directive: 'read exact history',
          directiveRevision: 2, state: 'waiting', memoryScope: 'task' },
        processing: { entryPhase: 'execution', nextAction: { kind: 'continue' }, hardBlockers: [],
          recoveryResponsibilityRef: principalOwner, laterErrorRefs: [], stages: [] },
        retainedDuties: [], sourceCommitRefs: [recordB.commitRef],
      },
    });
  }
  let effects = 0;
  const forbidden = () => { effects++; throw new Error('read consumer invoked an effect port'); };
  const effectPort = new Proxy({}, { get: () => forbidden });
  const service = new UiRuntimeService({ mode: 'fake', organId,
    binding: { bindingId: 'c3-unused', providerId: 'c3-unused', protocol: 'responses', endpointRef: 'c3-unused',
      modelRef: 'c3-unused', configDigest: 'c3-unused', capabilityDigest: 'c3-unused' },
    port: effectPort, checkpointStoreFor: forbidden, attentionPort: effectPort, closurePort: closures,
    providerState: 'unavailable', explicitBrainInterpreter: effectPort,
    memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: paths.projectKey },
    runtimeComposition: {
      admitExecution: forbidden,
      createExecutionPorts: () => ({
        executeConfirmedTaskContextCorrection: (input) => executeConfirmedTaskContextCorrection({
          ...input, filePath, journal, principalOwner,
        }),
        executeConfirmedTaskCheckpointReentry: (input) => executeConfirmedTaskCheckpointReentry({
          ...input, filePath, journal, principalOwner,
        }),
      }),
    }, journal: uiJournal,
    runtimePaths: paths, projectKey: paths.projectKey,
    projectCatalog: async () => ({ projects: [{ projectKey: paths.projectKey, projectRoot: paths.projectRoot,
      workspaceCwd: paths.workspaceCwd, checkpointsRoot: paths.checkpointsRoot }], failures: [] }),
  });
  const children = adoptedSources.map((source) => ({ invocationId: source.invocationId, childTurnId: source.childTurnId,
    deliverySeq: source.deliverySeq, refinedDelivery: source.refinedDelivery, text: childTexts[source.invocationId] }));
  return { root, paths, service, accessControl, principalOwner, filePath, journal, taskScope, grantReadback, admitted, operationControl,
    checkpoints, contextCommit,
    contextBody, activeRefs, recordA, recordB, semantics, publication, capture, children, crossChild, wrongRef: controlWrongRef,
    similarRef: controlSimilarRef, acceptedRef: controlAcceptedRef, effects: () => effects };
}

function knownCurrent(read) {
  if (read.state !== 'known') throw new Error(`expected known current facts: ${read.reason}`);
  return read;
}

async function verifiedRecords(journal) {
  const verification = await journal.verify();
  if (!verification.valid) throw new Error(verification.error ?? 'fixture Journal is invalid');
  return verification.records;
}

test('confirmed control physical facade commits exact correction and reentry over the real Journal', async () => {
  const f = await fixture({ controlCase: true });
  try {
    const before = await verifiedRecords(f.journal);
    const current = knownCurrent(readCurrentFromRecords(before, f.taskScope));
    assert.deepEqual(current.context.contextView.activeRefs, f.activeRefs);
    assert.ok(current.context.contextView.activeRefs.includes(f.wrongRef));
    assert.ok(current.context.contextView.activeRefs.includes(f.similarRef));

    const correction = await f.service.executeConfirmedTaskContextCorrection({
      taskScope: f.taskScope,
      commandId: 'c3-http-control-correction',
      wrongRefs: [{ taskScope: f.taskScope, ref: f.wrongRef }],
      repairText: 'remove only the confirmed wrong ref',
      confirmationRef: 'confirmation:c3-http-control-correction',
      sourceCheckpointReceipt: f.recordA.commitRef,
      expectedControlReceipt: current.position.controlCommitRef,
    });
    assert.equal(correction.state, 'committed');
    assert.equal(correction.record.previousExecutionEpoch, current.position.executionEpoch);
    assert.equal(correction.record.newExecutionEpoch, current.position.executionEpoch + 1);
    const afterCorrection = await verifiedRecords(f.journal);
    assert.deepEqual(afterCorrection.slice(0, before.length), before);
    assert.equal(afterCorrection.length, before.length + 2);
    const correctionCarrier = contextCorrectionFromRecord(exactJournalRecord(afterCorrection, correction.commitRef));
    assert.ok(correctionCarrier);
    assert.deepEqual(correctionCarrier, correction.record);
    assert.deepEqual(correctionCarrier.correctedContext.contextView.activeRefs, [f.acceptedRef, f.similarRef]);
    assert.deepEqual(correctionCarrier.correctedContext.contextView.omittedRefs, [f.wrongRef]);
    const correctionCoverage = readOperationControlFromRecords(afterCorrection, {
      scope: correction.record.correctedContext.scope,
      agentRuntimeId: correction.record.correctedContext.agentRuntimeId,
      harnessExecutionEpoch: correction.record.newExecutionEpoch,
    });
    assert.equal(correctionCoverage.state, 'complete');
    assert.deepEqual(correctionCoverage.currentControlCommitRef, correction.coverageCommitRef);
    const correctedCurrent = knownCurrent(readCurrentFromRecords(afterCorrection, f.taskScope));
    assert.deepEqual(correctedCurrent.context.contextView.activeRefs, [f.acceptedRef, f.similarRef]);
    assert.equal(correctedCurrent.position.controlCommitRef.commitId, correction.commitRef.commitId);
    assert.equal(correctedCurrent.position.executionEpoch, correction.record.newExecutionEpoch);

    await assert.rejects(
      () => f.service.executeConfirmedTaskContextCorrection({
        taskScope: f.taskScope,
        commandId: 'c3-http-control-stale',
        wrongRefs: [{ taskScope: f.taskScope, ref: f.similarRef }],
        repairText: 'stale correction must not commit',
        confirmationRef: 'confirmation:c3-http-control-stale',
        sourceCheckpointReceipt: f.recordA.commitRef,
        expectedControlReceipt: current.position.controlCommitRef,
      }),
      (error) => {
        assert.ok(error instanceof CheckpointSubmissionError);
        assert.ok(error.cause instanceof ConfirmedControlExpectedConflict);
        assert.equal(error.cause.reason, 'current-control-stale');
        return /context correction current control token is stale/.test(error.message);
      },
    );
    await assert.rejects(
      () => f.service.executeConfirmedTaskContextCorrection({
        taskScope: f.taskScope,
        commandId: 'c3-http-control-correction',
        wrongRefs: [{ taskScope: f.taskScope, ref: f.wrongRef }],
        repairText: 'different confirmed facts must not commit',
        confirmationRef: 'confirmation:c3-http-control-correction',
        sourceCheckpointReceipt: f.recordA.commitRef,
        expectedControlReceipt: current.position.controlCommitRef,
      }),
      /already committed with different confirmed facts/,
    );
    assert.deepEqual(await verifiedRecords(f.journal), afterCorrection);

    const originalVerify = f.journal.verify.bind(f.journal);
    let verifyCalls = 0;
    let injectedFailure;
    f.journal.verify = async () => {
      verifyCalls += 1;
      if (verifyCalls === 2) {
        try {
          await readFile(join(f.root, 'missing-submission-journal.json'), 'utf8');
        } catch (error) {
          injectedFailure = error;
          throw error;
        }
      }
      return originalVerify();
    };
    try {
      await assert.rejects(
        () => f.service.executeConfirmedTaskContextCorrection({
          taskScope: f.taskScope,
          commandId: 'c3-http-control-unknown-physical',
          wrongRefs: [{ taskScope: f.taskScope, ref: f.similarRef }],
          repairText: 'unknown physical failure must remain a submission failure',
          confirmationRef: 'confirmation:c3-http-control-unknown-physical',
          sourceCheckpointReceipt: f.recordA.commitRef,
          expectedControlReceipt: correctedCurrent.position.controlCommitRef,
        }),
        (error) => {
          assert.ok(error instanceof CheckpointSubmissionError);
          assert.equal(error.cause, injectedFailure);
          assert.equal(error.cause?.code, 'ENOENT');
          return true;
        },
      );
    } finally {
      f.journal.verify = originalVerify;
    }
    assert.equal(verifyCalls, 2);
    assert.deepEqual(await verifiedRecords(f.journal), afterCorrection);

    const reentry = await f.service.executeConfirmedTaskCheckpointReentry({
      taskScope: f.taskScope,
      commandId: 'c3-http-control-reentry',
      targetCheckpointCommitRef: f.recordA.commitRef,
      confirmationRef: 'confirmation:c3-http-control-reentry',
      expectedCurrentControlCommitRef: correctedCurrent.position.controlCommitRef,
    });
    assert.equal(reentry.state, 'committed');
    assert.equal(reentry.record.previousExecutionEpoch, correctedCurrent.position.executionEpoch);
    assert.equal(reentry.record.newExecutionEpoch, correctedCurrent.position.executionEpoch + 1);
    const afterReentry = await verifiedRecords(f.journal);
    assert.deepEqual(afterReentry.slice(0, afterCorrection.length), afterCorrection);
    assert.equal(afterReentry.length, afterCorrection.length + 2);
    const reentryCarrier = conditionalReentryFromRecord(exactJournalRecord(afterReentry, reentry.commitRef));
    assert.ok(reentryCarrier);
    assert.deepEqual(reentryCarrier, reentry.record);
    assert.deepEqual(reentryCarrier.sourceCheckpointCommitRef, f.recordA.commitRef);
    const reentryCoverage = readOperationControlFromRecords(afterReentry, {
      scope: reentry.record.restoredContext.scope,
      agentRuntimeId: reentry.record.restoredContext.agentRuntimeId,
      harnessExecutionEpoch: reentry.record.newExecutionEpoch,
    });
    assert.equal(reentryCoverage.state, 'complete');
    assert.deepEqual(reentryCoverage.currentControlCommitRef, reentry.coverageCommitRef);
    const reenteredCurrent = knownCurrent(readCurrentFromRecords(afterReentry, f.taskScope));
    assert.equal(reenteredCurrent.position.checkpointCommitRef.commitId, f.recordA.commitRef.commitId);
    assert.equal(reenteredCurrent.position.controlCommitRef.commitId, reentry.commitRef.commitId);
    assert.equal(reenteredCurrent.position.executionEpoch, reentry.record.newExecutionEpoch);
  } finally {
    await rm(f.root, { recursive: true });
  }
});

test('confirmed control HTTP dispatcher returns real committed receipts for the exact task scope', async () => {
  const f = await fixture({ controlCase: true });
  const challenge = f.accessControl.createPairingChallenge('c3-http-control', 1);
  const session = await f.accessControl.consumePairingCode(challenge.code);
  const cookie = f.accessControl.sessionCookie(session).split(';')[0];
  const verification = await f.accessControl.verifyProductPrincipal(cookie);
  assert.equal(verification.state, 'valid');
  assert.equal(verification.principal.owner, f.principalOwner);
  assert.equal(f.grantReadback.grant.owner, f.principalOwner);
  assert.equal(f.admitted.authority.owner, f.principalOwner);
  const before = await verifiedRecords(f.journal);
  const current = knownCurrent(readCurrentFromRecords(before, f.taskScope));
  assert.deepEqual(current.context.contextView.activeRefs, f.activeRefs);
  assert.ok(current.context.contextView.activeRefs.includes(f.wrongRef));

  const { listener } = createUiRuntimeRequestDispatcher({
    service: f.service,
    accessControl: f.accessControl,
    uiRoot: join(process.cwd(), 'docs/ui'),
    isClosing: () => false,
  });
  const server = createServer(listener);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = async (route, body) => {
      const requestUrl = `${url}${route}?${new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake' })}`;
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const receipt = await response.json();
      console.log(JSON.stringify({ url: requestUrl, status: response.status, body: receipt }));
      return { status: response.status, body: receipt };
    };

    const correction = await post(`/api/tasks/${taskId.value}/control/context-correction`, {
      commandId: 'c3-http-control-http-correction',
      wrongRefs: [f.wrongRef],
      repairText: 'remove only the confirmed wrong ref',
      confirmationRef: 'confirmation:c3-http-control-http-correction',
      sourceCheckpointReceipt: f.recordA.commitRef,
      expectedControlReceipt: current.position.controlCommitRef,
    });
    assert.equal(correction.status, 200,
      `expected a committed correction receipt, got ${correction.status} ${JSON.stringify(correction.body)}`);
    assert.equal(correction.body.state, 'committed');
    assert.ok(correction.body.commitRef);
    assert.ok(correction.body.coverageCommitRef);
    const afterCorrection = await verifiedRecords(f.journal);
    const correctionRecord = contextCorrectionFromRecord(
      exactJournalRecord(afterCorrection, correction.body.commitRef),
    );
    assert.ok(correctionRecord);
    assert.deepEqual(correctionRecord.correctedContext.contextView.activeRefs, [f.acceptedRef, f.similarRef]);
    assert.deepEqual(correctionRecord.correctedContext.contextView.omittedRefs, [f.wrongRef]);
    const correctedCurrent = knownCurrent(readCurrentFromRecords(afterCorrection, f.taskScope));

    const staleCorrection = await post(`/api/tasks/${taskId.value}/control/context-correction`, {
      commandId: 'c3-http-control-http-correction-stale',
      wrongRefs: [f.similarRef],
      repairText: 'stale correction must not commit',
      confirmationRef: 'confirmation:c3-http-control-http-correction-stale',
      sourceCheckpointReceipt: f.recordA.commitRef,
      expectedControlReceipt: current.position.controlCommitRef,
    });
    assert.equal(staleCorrection.status, 409,
      `expected a typed stale conflict, got ${staleCorrection.status} ${JSON.stringify(staleCorrection.body)}`);
    assert.equal(staleCorrection.body.error.code, 'confirmed-control.conflict');
    assert.deepEqual(await verifiedRecords(f.journal), afterCorrection);

    const reentry = await post(`/api/tasks/${taskId.value}/control/checkpoint-reentry`, {
      commandId: 'c3-http-control-http-reentry',
      targetCheckpointCommitRef: f.recordA.commitRef,
      confirmationRef: 'confirmation:c3-http-control-http-reentry',
      expectedCurrentControlCommitRef: correctedCurrent.position.controlCommitRef,
    });
    assert.equal(reentry.status, 200,
      `expected a committed reentry receipt, got ${reentry.status} ${JSON.stringify(reentry.body)}`);
    assert.equal(reentry.body.state, 'committed');
    assert.ok(reentry.body.commitRef);
    assert.ok(reentry.body.coverageCommitRef);
    const afterReentry = await verifiedRecords(f.journal);
    const reentryRecord = conditionalReentryFromRecord(
      exactJournalRecord(afterReentry, reentry.body.commitRef),
    );
    assert.ok(reentryRecord);
    assert.deepEqual(reentryRecord.sourceCheckpointCommitRef, f.recordA.commitRef);

    const staleReentry = await post(`/api/tasks/${taskId.value}/control/checkpoint-reentry`, {
      commandId: 'c3-http-control-http-reentry-stale',
      targetCheckpointCommitRef: f.recordA.commitRef,
      confirmationRef: 'confirmation:c3-http-control-http-reentry-stale',
      expectedCurrentControlCommitRef: correctedCurrent.position.controlCommitRef,
    });
    assert.equal(staleReentry.status, 409,
      `expected a typed stale conflict, got ${staleReentry.status} ${JSON.stringify(staleReentry.body)}`);
    assert.equal(staleReentry.body.error.code, 'confirmed-control.conflict');
    assert.deepEqual(await verifiedRecords(f.journal), afterReentry);

    const reenteredCurrent = knownCurrent(readCurrentFromRecords(afterReentry, f.taskScope));
    const originalVerify = f.journal.verify.bind(f.journal);
    let verifyCalls = 0;
    let injectedFailure;
    f.journal.verify = async () => {
      verifyCalls += 1;
      if (verifyCalls === 2) {
        try {
          await readFile(join(f.root, 'missing-http-submission-journal.json'), 'utf8');
        } catch (error) {
          injectedFailure = error;
          throw error;
        }
      }
      return originalVerify();
    };
    try {
      const unknown = await post(`/api/tasks/${taskId.value}/control/context-correction`, {
        commandId: 'c3-http-control-http-unknown-physical',
        wrongRefs: [f.similarRef],
        repairText: 'unknown physical failure must remain visible',
        confirmationRef: 'confirmation:c3-http-control-http-unknown-physical',
        sourceCheckpointReceipt: f.recordA.commitRef,
        expectedControlReceipt: reenteredCurrent.position.controlCommitRef,
      });
      assert.equal(unknown.status, 500,
        `expected an unknown physical failure, got ${unknown.status} ${JSON.stringify(unknown.body)}`);
      assert.equal(unknown.body.error.code, 'ui-runtime.unexpected');
      assert.equal(unknown.body.error.cause.code, 'ENOENT');
      assert.equal(injectedFailure?.code, 'ENOENT');
    } finally {
      f.journal.verify = originalVerify;
    }
    assert.equal(verifyCalls, 2);
    assert.deepEqual(await verifiedRecords(f.journal), afterReentry);
  } finally {
    server.closeIdleConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(f.root, { recursive: true });
  }
});

// The observed cold-start failure restores a blocked checkpoint instead of the
// newer live owner state. Reuse the legal producer fixture; no Provider call is needed.
test('App cold production entry hydrates canonical live state while checkpoint remains blocked', async () => {
  const f = await fixture({ cold: true });
  console.log(JSON.stringify({ event: 'cold-fixture-start', fixture: f.root, pid: process.pid }));
  let runtime;
  try {
    let effects = 0;
    const forbidden = () => { effects++; throw new Error('cold entry invoked Provider or execution'); };
    const effectPort = new Proxy({}, { get: () => forbidden });
    const accessControl = await AccessControlService.open({ credentialPath: f.paths.webAccessCredentialPath, create: true });
    const before = await snapshot(f.paths.projectRoot);
    runtime = await startUiRuntime({ mode: 'fake', organId,
      binding: { bindingId: 'c3-unused', providerId: 'c3-unused', protocol: 'responses', endpointRef: 'c3-unused',
        modelRef: 'c3-unused', configDigest: 'c3-unused', capabilityDigest: 'c3-unused' },
      port: effectPort, accessControl, checkpointRoot: join(f.paths.checkpointsRoot, 'ui-runtime'),
      evidenceRoot: join(f.paths.artifactsRoot, 'ui-provider-evidence'), uiRoot: join(process.cwd(), 'docs/ui'),
      host: '127.0.0.1', portNumber: 0, explicitBrainInterpreter: effectPort,
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: f.paths.projectKey },
    });
    const dashboard = runtime.service.taskDashboard(taskId);
    assert.equal(dashboard.state, 'succeeded');
    assert.equal(dashboard.checkpoint.outcome, 'blocked');
    assert.equal((await f.checkpoints.readLatest(f.recordB.checkpoint.scope)).checkpoint.outcome, 'blocked');
    assert.equal(effects, 0);
    assert.deepEqual(await snapshot(f.paths.projectRoot), before, 'cold hydrate changed durable project data');
  } finally {
    await runtime?.close();
    await rm(f.root, { recursive: true });
    console.log(JSON.stringify({ event: 'cold-fixture-closed', fixture: f.root, pid: process.pid }));
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) test('production checkpoint GET preserves canonical current and exact viewed receipts without writes', async () => {
  const f = await fixture();
  const accessControl = await AccessControlService.open({ credentialPath: f.paths.webAccessCredentialPath, create: true });
  const challenge = accessControl.createPairingChallenge('c3-http-fixture', 1);
  const session = await accessControl.consumePairingCode(challenge.code);
  const cookie = accessControl.sessionCookie(session).split(';')[0];
  // Use the production dispatcher directly: this read proof has no daemon/credential-watch lifecycle.
  const { listener } = createUiRuntimeRequestDispatcher({ service: f.service, accessControl,
    uiRoot: join(process.cwd(), 'docs/ui'), isClosing: () => false });
  const server = createServer(listener);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(JSON.stringify({ pid: process.pid, url, fixture: f.root, projectKey: f.paths.projectKey, taskScope }));
  try {
    const before = await snapshot(f.paths.projectRoot);
    const position = await f.checkpoints.readExecutionPosition(taskScope);
    const identity = (record) => ({ checkpointId: record.checkpoint.id.value,
      checkpointCommitId: record.commitRef.commitId, checkpointJournalSeq: String(record.commitRef.journalSeq),
      checkpointRecordDigest: record.commitRef.recordDigest });
    async function get(extra = {}, target = taskId.value, authenticated = true) {
      const query = new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', limit: '1', ...extra });
      const requestUrl = `${url}/api/tasks/${target}/checkpoints?${query}`;
      const response = await fetch(requestUrl, { headers: authenticated ? { cookie } : {} });
      const body = await response.json();
      console.log(JSON.stringify({ url: requestUrl, status: response.status, body }));
      return { status: response.status, body };
    }
    const current = await get();
    const paged = await get({ cursor: String(f.recordA.commitRef.journalSeq) });
    const viewed = await get({ ...identity(f.recordA), executionEpoch: '999' });
    const malformed = await get({ checkpointId: f.recordA.checkpoint.id.value, checkpointCommitId: f.recordA.commitRef.commitId });
    const unknown = await get({ ...identity(f.recordA), checkpointRecordDigest: 'sha256:' + '0'.repeat(64) });
    const wrongTask = await get(identity(f.recordA), 'c3-other-task');
    const unauthenticated = await get({}, taskId.value, false);
    const captureAssetStore = new ImmutableAssetStore(join(f.paths.artifactsRoot, 'ui-provider-evidence'));
    const captureBytes = await captureAssetStore.readEvidence(f.capture.capture.ref);
    const captureText = new TextDecoder('utf-8', { fatal: true }).decode(captureBytes);
    const captureBodyUrl = `${url}/api/tasks/${taskId.value}/checkpoints/assets/capture?`
      + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', ...identity(f.recordA) });
    const captureBodyResponse = await fetch(captureBodyUrl, { headers: { cookie } });
    const captureBody = await captureBodyResponse.json();
    console.log(JSON.stringify({ url: captureBodyUrl, status: captureBodyResponse.status, body: captureBody }));
    const materializedChildren = viewed.body.viewed.semantic.adoptedChildren;
    assert.equal(materializedChildren.length, 3, 'history GET must materialize all adopted sources');
    assert.deepEqual(materializedChildren.find((child) => child.invocationId === f.crossChild.invocationId), {
      invocationId: f.crossChild.invocationId, childTurnId: f.crossChild.childTurnId, deliverySeq: f.crossChild.deliverySeq,
      kind: 'execution', refinedDelivery: f.crossChild.refinedDelivery, preCallCheckpointRef: f.crossChild.preCallCheckpointRef,
    });
    // Exact checkpoint A carries the capture; exact checkpoint B has none. B must fail
    // explicitly, so no capture from A can fill it in.
    const captureBodyUrlB = `${url}/api/tasks/${taskId.value}/checkpoints/assets/capture?`
      + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', ...identity(f.recordB) });
    const captureBodyResponseB = await fetch(captureBodyUrlB, { headers: { cookie } });
    const captureBodyB = await captureBodyResponseB.json();
    console.log(JSON.stringify({ url: captureBodyUrlB, status: captureBodyResponseB.status, body: captureBodyB }));
    assert.notEqual(captureBodyResponseB.status, 200);
    assert.ok(!('text' in captureBodyB), 'capture body read for B must not serve a text body');
    const captureBodyWrongTaskUrl = `${url}/api/tasks/${otherTaskId.value}/checkpoints/assets/capture?`
      + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', ...identity(f.recordA) });
    const captureBodyWrongTaskResponse = await fetch(captureBodyWrongTaskUrl, { headers: { cookie } });
    const captureBodyWrongTask = await captureBodyWrongTaskResponse.json();
    console.log(JSON.stringify({ url: captureBodyWrongTaskUrl, status: captureBodyWrongTaskResponse.status, body: captureBodyWrongTask }));
    assert.notEqual(captureBodyWrongTaskResponse.status, 200);
    assert.ok(!('text' in captureBodyWrongTask), 'capture body read for a wrong task must not serve a text body');
    // New capture route input boundary. One representative each: a missing
    // physical receipt, a repeated scope key, and an extra locator query. Each
    // must be rejected before any asset read, carrying no body text.
    const missingReceiptUrl = `${url}/api/tasks/${taskId.value}/checkpoints/assets/capture?`
      + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', checkpointId: f.recordA.checkpoint.id.value });
    const missingReceiptResponse = await fetch(missingReceiptUrl, { headers: { cookie } });
    const missingReceipt = await missingReceiptResponse.json();
    console.log(JSON.stringify({ url: missingReceiptUrl, status: missingReceiptResponse.status, body: missingReceipt }));
    assert.equal(missingReceiptResponse.status, 400);
    assert.equal(missingReceipt.error.code, 'checkpoint-history.viewed-partial');
    assert.ok(!('text' in missingReceipt), 'missing receipt must not return a body text');
    const duplicateModeQuery = new URLSearchParams({ projectKey: f.paths.projectKey, ...identity(f.recordA) });
    duplicateModeQuery.append('mode', 'fake');
    duplicateModeQuery.append('mode', 'fake');
    const duplicateModeUrl = `${url}/api/tasks/${taskId.value}/checkpoints/assets/capture?${duplicateModeQuery}`;
    const duplicateModeResponse = await fetch(duplicateModeUrl, { headers: { cookie } });
    const duplicateMode = await duplicateModeResponse.json();
    console.log(JSON.stringify({ url: duplicateModeUrl, status: duplicateModeResponse.status, body: duplicateMode }));
    assert.equal(duplicateModeResponse.status, 400);
    assert.equal(duplicateMode.error.code, 'checkpoint-asset.query-invalid');
    assert.ok(!('text' in duplicateMode), 'a repeated mode key must not return a body text');
    const extraLocatorUrl = `${url}/api/tasks/${taskId.value}/checkpoints/assets/capture?`
      + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', ...identity(f.recordA),
        locator: f.capture.capture.ref.locator });
    const extraLocatorResponse = await fetch(extraLocatorUrl, { headers: { cookie } });
    const extraLocator = await extraLocatorResponse.json();
    console.log(JSON.stringify({ url: extraLocatorUrl, status: extraLocatorResponse.status, body: extraLocator }));
    assert.equal(extraLocatorResponse.status, 400);
    assert.equal(extraLocator.error.code, 'checkpoint-asset.query-invalid');
    assert.ok(!('text' in extraLocator), 'an extra locator query key must not return a body text');
    // Integrity sensitivity: corrupt the real capture backing bytes in this own
    // fixture once. The same exact body GET must fail explicitly with no text,
    // and restoring the original bytes must make the identical GET succeed.
    const captureFilePath = join(f.paths.artifactsRoot, 'ui-provider-evidence', f.capture.capture.ref.evidenceId.value);
    const originalCaptureBytes = await readFile(captureFilePath);
    assert.deepEqual(new Uint8Array(originalCaptureBytes), captureBytes, 'fixture capture file must back the served bytes');
    let corruptedFailure;
    try {
      const corrupted = Buffer.from(originalCaptureBytes);
      corrupted[0] ^= 0xff;
      await writeFile(captureFilePath, corrupted);
      const corruptedResponse = await fetch(captureBodyUrl, { headers: { cookie } });
      corruptedFailure = await corruptedResponse.json();
      console.log(JSON.stringify({ url: captureBodyUrl, corrupted: true, status: corruptedResponse.status, body: corruptedFailure }));
      assert.notEqual(corruptedResponse.status, 200);
      // The canonical capture cold read detects the digest break before the body
      // read starts, so the failure travels as an unavailable capture, not as a
      // successful read. Either way the request must fail and carry no body.
      assert.equal(corruptedFailure.error.code, 'checkpoint-asset.unavailable');
      assert.ok(corruptedFailure.error.message.includes('digest mismatch'),
        'the corrupted capture must fail with its actual digest failure reason');
      assert.ok(!('text' in corruptedFailure), 'a corrupted capture backing file must not return a body text');
    } finally {
      await writeFile(captureFilePath, originalCaptureBytes);
    }
    assert.deepEqual(new Uint8Array(await readFile(captureFilePath)), new Uint8Array(originalCaptureBytes),
      'capture backing bytes must be restored');
    const restoredResponse = await fetch(captureBodyUrl, { headers: { cookie } });
    const restoredBody = await restoredResponse.json();
    console.log(JSON.stringify({ url: captureBodyUrl, restored: true, status: restoredResponse.status, body: restoredBody }));
    assert.equal(restoredResponse.status, 200);
    assert.equal(restoredBody.text, captureText);
    // Two legal adopted-child bodies from the same committed A, then one unknown triple.
    // The unknown triple must fail explicitly and carry no body text.
    const childBodies = [];
    for (const child of f.children) {
      const childBodyUrl = `${url}/api/tasks/${taskId.value}/checkpoints/assets/adopted-child/`
        + `${child.invocationId}/${child.childTurnId}/${child.deliverySeq}?`
        + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', ...identity(f.recordA) });
      const childResponse = await fetch(childBodyUrl, { headers: { cookie } });
      const childBody = await childResponse.json();
      console.log(JSON.stringify({ url: childBodyUrl, status: childResponse.status, body: childBody }));
      assert.equal(childResponse.status, 200);
      assert.equal(childBody.surface, 'runtime-checkpoint-asset-body');
      assert.deepEqual(childBody.scope, { kind: 'task', projectKey: f.paths.projectKey, mode: 'fake', taskId });
      assert.deepEqual(childBody.checkpoint, viewed.body.viewed.identity);
      assert.deepEqual(childBody.selector, { kind: 'adopted-child', invocationId: child.invocationId,
        childTurnId: child.childTurnId, deliverySeq: child.deliverySeq });
      assert.deepEqual(childBody.asset, child.refinedDelivery);
      assert.equal(childBody.text, child.text);
      childBodies.push(childBody);
    }
    assert.equal(new Set(childBodies.map((body) => body.text)).size, 2, 'adopted child bodies must differ');
    const crossChildUrl = `${url}/api/tasks/${taskId.value}/checkpoints/assets/adopted-child/`
      + `${f.crossChild.invocationId}/${f.crossChild.childTurnId}/${f.crossChild.deliverySeq}?`
      + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', ...identity(f.recordA) });
    const crossChildResponse = await fetch(crossChildUrl, { headers: { cookie } });
    const crossChildBody = await crossChildResponse.json();
    console.log(JSON.stringify({ url: crossChildUrl, status: crossChildResponse.status, body: crossChildBody }));
    assert.equal(crossChildResponse.status, 409);
    assert.equal(crossChildBody.error.code, 'checkpoint-asset.scope-mismatch');
    assert.ok(!('text' in crossChildBody), 'cross-task adopted source must not return body text');
    const unknownChildUrl = `${url}/api/tasks/${taskId.value}/checkpoints/assets/adopted-child/`
      + `c3-child-unknown/c3-child-turn-unknown/999?`
      + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', ...identity(f.recordA) });
    const unknownChildResponse = await fetch(unknownChildUrl, { headers: { cookie } });
    const unknownChildBody = await unknownChildResponse.json();
    console.log(JSON.stringify({ url: unknownChildUrl, status: unknownChildResponse.status, body: unknownChildBody }));
    assert.notEqual(unknownChildResponse.status, 200);
    assert.ok(!('text' in unknownChildBody), 'unknown adopted-child selector must not return a body text');
    assert.ok('error' in unknownChildBody, 'unknown adopted-child selector must return an explicit failure');
    const oversizedChildUrl = `${url}/api/tasks/${taskId.value}/checkpoints/assets/adopted-child/`
      + `${f.children[0].invocationId}/${f.children[0].childTurnId}/9007199254740993?`
      + new URLSearchParams({ projectKey: f.paths.projectKey, mode: 'fake', ...identity(f.recordA) });
    const oversizedChildResponse = await fetch(oversizedChildUrl, { headers: { cookie } });
    const oversizedChildBody = await oversizedChildResponse.json();
    console.log(JSON.stringify({ url: oversizedChildUrl, status: oversizedChildResponse.status, body: oversizedChildBody }));
    assert.equal(oversizedChildResponse.status, 400);
    assert.equal(oversizedChildBody.error.code, 'checkpoint-asset.selector-invalid');
    assert.ok(!('text' in oversizedChildBody), 'invalid adopted-child selector must not return a body text');
    assert.deepEqual(await snapshot(f.paths.projectRoot), before, 'GET changed durable Journal/asset bytes or file set');
    assert.deepEqual(await f.checkpoints.readExecutionPosition(taskScope), position);
    assert.equal(f.effects(), 0);
    console.log(JSON.stringify({ noWrite: true, position, effects: f.effects() }));
    assert.equal(captureBodyResponse.status, 200);
    assert.equal(captureBody.surface, 'runtime-checkpoint-asset-body');
    assert.deepEqual(captureBody.scope, { kind: 'task', projectKey: f.paths.projectKey, mode: 'fake', taskId });
    assert.deepEqual(captureBody.checkpoint, viewed.body.viewed.identity);
    assert.deepEqual(captureBody.selector, { kind: 'capture' });
    assert.deepEqual(captureBody.asset, f.capture.capture);
    assert.equal(captureBody.text, captureText);
    assert.equal(current.status, 200);
    assert.deepEqual({ current: current.body.current?.state, viewed: viewed.body.viewed?.identity?.commitRef,
      malformed: malformed.status, unknown: unknown.status },
    { current: 'known', viewed: f.recordA.commitRef, malformed: 400, unknown: 409 },
    'the public route must honor canonical current and the exact receipt');
    assert.deepEqual(current.body.current.position.checkpointCommitRef, f.recordA.commitRef);
    assert.deepEqual(current.body.current.identity.commitRef, f.recordA.commitRef);
    assert.deepEqual(current.body.current.position.contextCommitRef, f.contextCommit.commitRef);
    assert.equal(paged.status, 200);
    assert.deepEqual(paged.body.current.position.checkpointCommitRef, f.recordA.commitRef);
    assert.deepEqual(paged.body.checkpoints.map((entry) => entry.commitRef), [f.recordB.commitRef]);
    assert.equal(viewed.status, 200);
    assert.deepEqual(viewed.body.viewed.identity.commitRef, f.recordA.commitRef);
    assert.deepEqual(viewed.body.current.position.checkpointCommitRef, f.recordA.commitRef);
    assert.deepEqual(viewed.body.checkpoints, []);
    assert.equal(viewed.body.viewed.context.state, 'known');
    assert.equal(viewed.body.viewed.identity.committedAt, at);
    assert.equal(viewed.body.viewed.semantic.state, 'known');
    assert.deepEqual(viewed.body.viewed.semantic.semantics, f.semantics);
    assert.deepEqual(viewed.body.viewed.semantic.save.historyPublication, f.publication);
    assert.equal(viewed.body.viewed.capture.state, 'known');
    assert.equal(viewed.body.viewed.capture.turnRecoveryRef, f.capture.commitIdentity);
    assert.deepEqual(viewed.body.viewed.capture.capture, f.capture.capture);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'checkpoint-history.viewed-partial');
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.error.code, 'checkpoint-history.viewed-receipt-mismatch');
    assert.equal(wrongTask.status, 409);
    assert.equal(wrongTask.body.error.code, 'checkpoint-history.viewed-receipt-mismatch');
    assert.equal(unauthenticated.status, 401);
  } finally {
    server.closeIdleConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    console.log(JSON.stringify({ closed: true, pid: process.pid, url }));
  }
});
