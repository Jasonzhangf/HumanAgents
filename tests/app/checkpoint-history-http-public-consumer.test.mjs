import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
import { createJsonlCheckpointJournal, createJsonlCheckpointClosurePort, createJsonlContextHistoryPort, createJsonlSemanticHistoryJournal } from '../../dist/app/app/src/checkpoint-journal.js';
import { createNativeRecoveryAssets } from '../../dist/app/app/src/native-recovery-assets.js';
import { createJsonlOperationControlJournal } from '../../dist/app/app/src/operation-control-journal.js';
import { UiRuntimeService } from '../../dist/app/app/src/ui-runtime/service.js';
import { startUiRuntime } from '../../dist/app/app/src/ui-runtime/index.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../dist/app/app/src/runtime-current-state-journal.js';
import { createUiRuntimeRequestDispatcher } from '../../dist/app/app/src/ui-runtime/server.js';
import { AccessControlService } from '../../dist/app/app/src/ui-runtime/access-control.js';
import { UiRuntimeJournal, uiRuntimeJournalPath, uiRuntimeControlJournalPath, uiRuntimeModeRoot } from '../../dist/app/app/src/ui-runtime/journal.js';

// Known old-route defects: current is always undefined and receipt query keys are ignored.
// A wrong recovery target has high correctness impact. One local HTTP consumer costs no model calls.
const fixtureRoot = join(homedir(), '.humanagent/test-fixtures/ux-checkpoint-public-read-20261015');
const organId = id('organ', 'c3-http-organ');
const taskId = id('task', 'c3-http-task');
const taskScope = { organId, taskId };
const cycleId = id('cycle', 'c3-http-cycle');
const scope = { ...taskScope, cycleId };
const at = '2026-10-15T02:00:00.000Z';
const owner = 'c3-http-consumer';

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

export async function fixture({ cold = false } = {}) {
  const scope = cold ? { ...taskScope, cycleId, operationId: id('operation', 'c3-cold-operation') } : { ...taskScope, cycleId };
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'http-'));
  const paths = await resolveRuntimePaths({ workspace: process.cwd(), controlRoot: root });
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
  await grants.grant({ requestId: 'c3-grant', taskId, owner, capability, expectedRevision: 0 });
  const request = { requestRef: 'c3-read-business', taskId, owner, capability,
    inputIdentity: { requestRef: 'c3-read-business', digest: 'c3-http-intent' } };
  const admitted = await admitTaskGrantBusiness({ port: grants, request, principalOwner: owner,
    register: async (authority, registration) => ({ authority, registrationCommitRef:
      await registration.registerBusiness({ ...request, grantRevision: authority.grant.revision }) }) });
  const control = createJsonlOperationControlJournal({ journal });
  const selector = { scope, agentRuntimeId: 'c3-runtime', harnessExecutionEpoch: 4 };
  await control.initializeCoverage({ ...selector, admissionCommitRef: admitted.registrationCommitRef });
  const ref = { checkpointId: id('checkpoint', 'c3-loop'), digest: 'c3-loop-digest' };
  const watermark = { streamId: 'c3-stream', sequence: 0 };
  const durableContext = { stablePrefix: ['instructions'], indexRefs: [], dynamicHead: ['accepted fact'], repairRefs: [] };
  const context = { kind: 'context-history', schemaVersion: 1, scope, agentRuntimeId: selector.agentRuntimeId,
    contextView: { contextViewRef: 'c3-context', executionEpoch: 4, checkpoint: ref,
      contextDigest: 'c3-context-digest', activeRefs: ['accepted-fact'], omittedRefs: [] },
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
  const evidence = (label) => ({ evidenceId: id('evidence', label), kind: 'operation', source: owner,
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
  const nativeA = await checkpoints.commitNativeCheckpoint({ ownerId: owner, checkpoint: a, timeAuthority });
  const assets = new ImmutableAssetStore(artifactsRoot);
  const turnIdentity = projectAdmittedTurnIdentityV1(turn);
  // Legal adopted-child producer chain. Two distinct refined deliveries are written to the
  // real store, returned through the real child lifecycle, then adopted by the owner.
  // This runs before capture freezes the active turn; the semantic publication below only
  // cites these durable relationships. Nothing is seeded as a DTO.
  const childInvocationIds = ['c3-child-alpha', 'c3-child-beta'];
  const childTexts = { [childInvocationIds[0]]: 'refined alpha delivery body', [childInvocationIds[1]]: 'refined beta delivery body' };
  const adoptedSources = [];
  for (const [index, invocationId] of childInvocationIds.entries()) {
    const childTurnId = `c3-child-turn-${index}`;
    const reference = await assets.write(`c3-child-${index}`, new TextEncoder().encode(childTexts[invocationId]));
    const refinedDelivery = { ref: evidenceReference(reference, scope, 'operation', `c3-child-body-${index}`), view: { kind: 'utf8-text' } };
    await active.openChildInvocation({ invocationId, childTurnId, checkpointReceiptRef: nativeA.receipt.journalReceiptRef,
      binding: { kind: 'execution', assignment } });
    const returnedDelivery = await active.recordChildReturn({ kind: 'execution', invocationId, refinedDelivery, assignment,
      result: { taskId, pipelineNodeId: assignment.pipelineNodeId, agentId: owner, assignmentId: assignment.assignmentId,
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
  const captureBody = await active.prepareCapture({ pauseId: 'c3-boundary', frozenAt: at, initialInput,
    checkpointPath: [], completionRefs: [] });
  const capture = await nativeAssets.commitCapturePhase({ turnId: turn.turnId, boundaryId: captureBody.cut.pauseId,
    prepared: { body: captureBody, controlRecordCount: active.controlRecordCount(), producerDrains: [], completionLookups: [],
      recovery: { commitIdentity: 'c3-hold', laterErrorRefs: [], rawTurnRefs: [turn.currentTurnRef], unresolvedOperationRefs: [],
        stages: [], durablePhases: [], durableReceiptRefs: [], recoveryResponsibilityRef: owner } } });
  const preparation = await prepareCheckpointClosure({ checkpoint: a, source: 'harness-control', closureReason: 'empty boundary',
    contextCommitRef: contextCommit.commitRef, contextHistory: contexts, operationSelector: selector,
    operationControl: await control.readControl(selector), permission: { permissionRevision: admitted.authority.permissionRevision,
      grantCommitRef: admitted.authority.commit, revoked: false }, hardBlockers: [], unreturnedCallRefs: [],
    unresolvedOperationRefs: [], closurePort: closures, now: () => new Date(at) });
  await submitCheckpoint({ ownerId: owner, source: 'harness-control', checkpoint: a, previous: null,
    journal: checkpoints, closurePort: closures, preparation, turnRecoveryRef: capture.commitIdentity });
  const semantic = createJsonlSemanticHistoryJournal({ filePath, journal, artifactsRoot,
    activeTurnJournal, rawContent: { read: async ({ content }) => assets.readEvidence(content.ref) }, timeAuthority });
  const semantics = { goal: 'read exact history', actions: 'inspect Journal', result: 'A remains current', nextStep: 'inspect A' };
  const view = await commitSemanticContextViewV1({ port: semantic, accepted: { version: 1,
    admittedTurn: turn, checkpoint: nativeA, acceptance: { ownerId: owner, acceptanceRef: 'c3-semantic-accepted',
      sourceEvidenceRefs: [evidence('semantic-accepted')] }, semantics, adoptedChildren: adoptedSources,
    recovery: { recoveryStateRef: turn.recoveryStateRef, recoveryResponsibilityRef: owner, unresolvedOperationRefs: [], laterErrorRefs: [] } } });
  const publication = await commitSemanticHistoryPublicationV1({ port: semantic, ownerId: owner, turn: turnIdentity,
    checkpoint: nativeA, contextView: { identity: await contextViewIdentityV1({ turn: turnIdentity, checkpoint: a }), receipt: view } });
  const b = checkpoint(2, a);
  await checkpoints.commitNativeCheckpoint({ ownerId: owner, checkpoint: b, timeAuthority });
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
  let effects = 0;
  const forbidden = () => { effects++; throw new Error('read consumer invoked an effect port'); };
  const effectPort = new Proxy({}, { get: () => forbidden });
  const service = new UiRuntimeService({ mode: 'fake', organId,
    binding: { bindingId: 'c3-unused', providerId: 'c3-unused', protocol: 'responses', endpointRef: 'c3-unused',
      modelRef: 'c3-unused', configDigest: 'c3-unused', capabilityDigest: 'c3-unused' },
    port: effectPort, checkpointStoreFor: forbidden, attentionPort: effectPort, closurePort: closures,
    providerState: 'unavailable', explicitBrainInterpreter: effectPort,
    memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: paths.projectKey },
    runtimeComposition: { admitExecution: forbidden }, journal: uiJournal,
    runtimePaths: paths, projectKey: paths.projectKey,
    projectCatalog: async () => ({ projects: [{ projectKey: paths.projectKey, projectRoot: paths.projectRoot,
      workspaceCwd: paths.workspaceCwd, checkpointsRoot: paths.checkpointsRoot }], failures: [] }),
  });
  const children = adoptedSources.map((source) => ({ invocationId: source.invocationId, childTurnId: source.childTurnId,
    deliverySeq: source.deliverySeq, refinedDelivery: source.refinedDelivery, text: childTexts[source.invocationId] }));
  return { root, paths, service, checkpoints, contextCommit, recordA, recordB, semantics, publication, capture, children,
    effects: () => effects };
}

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
