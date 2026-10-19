import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, loadConfiguration, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { id, validateTaskPlanSnapshot, type ScopeRef, type AcceptedRawFact, type StandardTurnEndCommand, type WorkAssignment, type WorkResult, type RawContentReadPort, type EvidenceRef, type TaskId, type JournalCommitRef, type InteractionHelperIdentity } from '../../packages/contracts/src/index.js';
import { readStandardTurnDelivery, bindAssignmentDelivery, StandardTurnDeliveryError, type InspectToolCompletionDescriptor, type StandardTurnDeliveryReadInput, type StandardTurnDeliveryReaderPort } from '../../packages/runtime/src/ui-runtime/standard-turn-delivery.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal, JsonlOrganJournal, JsonlTaskPlanRevisionJournal } from '../../packages/adapters/jsonl/src/index.js';
import { createJsonlActiveTurnJournal, decodeActiveTurnRecords, listTaskActiveTurnBindings } from '../../packages/adapters/jsonl/src/active-turn.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { filesystemProviderEvidenceSink, providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { UiRuntimeJournal, FileCheckpointStore } from '../../packages/app/src/ui-runtime/index.js';
import { createDefaultExecutionComposition, ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { createChildBodyAssetPort } from '../../packages/app/src/ui-runtime/child-run-composition.js';
import { startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { FakeReplayExecutionRuntimePort } from '../../packages/app/src/ui-runtime/fake-port.js';
import { createJsonlClosedTurnPlannerCallJournal } from '../../packages/app/src/ui-runtime/planner-call-journal.js';
import { createActiveTurnSegmentJournal, createNativeRecoveryAssets } from '../../packages/app/src/native-recovery-assets.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import { createJsonlRetryCycleJournalPort } from '../../packages/app/src/retry-cycle-journal.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { RuntimeTaskCoordinator, type RuntimeExecutionDriver } from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import type { ActiveTurnJournalRecord } from '../../packages/runtime/src/context/active-turn-journal.js';
import { newActiveTurnId } from '../../packages/runtime/src/admission/admitted-turn.js';
import { TaskPlanRevisionConsumer } from '../../packages/runtime/src/orchestration/task-plan-revisions.js';
import { STANDARD_TURN_END_TOOL } from '../../packages/app/src/ui-runtime/standard-turn-control.js';
import { ADVERTISED_STANDARD_TURN_END_TOOL } from '../../packages/app/src/ui-runtime/standard-turn-composition.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { createJsonlOperationControlJournal } from '../../packages/app/src/operation-control-journal.js';
import { createJsonlContextHistoryPort, createJsonlCheckpointJournal, createJsonlCheckpointClosurePort } from '../../packages/app/src/checkpoint-journal.js';
import { createAppChildCheckpointAdapter } from '../../packages/app/src/ui-runtime/child-checkpoint-adapter.js';
import { readDaemonLease } from '../../packages/app/src/supervisor/supervisor.js';
import { ActiveTurnContext, ActiveTurnSegmentContext } from '../../packages/runtime/src/context/active-turn-context.js';
import type { AdmittedTurn, ReviewAssignment, ReviewResult } from '../../packages/contracts/src/index.js';
import { readCheckpointClosurePreparation, turnBoundaryRecordRefs } from '../../packages/runtime/src/checkpoints/closure.js';
import type { NativeSaveIntent } from '../../packages/runtime/src/checkpoints/native-save-contract.js';
import { APP_CHILD_CALL_TOOL, createAppChildProducer } from '../../packages/app/src/ui-runtime/child-producer.js';
import type { IndependentChildCallInput } from '../../packages/runtime/src/orchestration/types.js';

const coldConsumerMode = process.argv.includes('--cold-consumer');

function consumerCliEntry(): string {
  const configured = process.env.HUMANAGENT_CONSUMER_CLI?.trim();
  return configured === undefined || configured.length === 0
    ? new URL('../../../app/app/src/cli.js', import.meta.url).pathname
    : configured;
}

/** The one fixture root allowed for this pure-text App slice. */
const PERSISTENCE_ROOT = process.env.HUMANAGENT_TEST_ROOT
  ?? '/Users/fanzhang/.humanagent/test-fixtures/provider-fixture-combined-acceptance-r1-20261014';

/**
 * Exact delivery body with non-ASCII and newline content. It is independent of
 * every summary section and exercises real UTF-8 bytes through JSON, the asset
 * store and fatal-UTF-8 readback.
 */
const EXACT_BODY = 'EXACT\u4f53 single logical delivery \ud83d\ude80\nline two';
const SUMMARY_RESULT = 'summary result is a different material';
const CHILD_BODY = 'Independent child result for adoption';
const EXPLICIT_HELPER_PARENT_MARKER = 'parent-private-n3: use the bounded helper result to answer this question.';
const EXPLICIT_HELPER_CHILD_INPUT = 'child-only-input-n3';
const EXPLICIT_HELPER_CHILD_SUMMARY = 'unrefined-child-result-n3';
const EXPLICIT_HELPER_REFINED_TEXT = 'accepted-refined-result-n3';
const INSPECTION_DEFINITION_ID = 'native-inspection-definition';
const INSPECTION_DEFINITION_VERSION = '1';
const INSPECTION_CHECK_A = {
  checkId: 'check-a',
  criterion: 'Count stale native records and report the observed count',
  inputRefs: ['artifact://native-inspection/stale-records'],
} as const;
const INSPECTION_CHECK_B = {
  checkId: 'check-b',
  criterion: 'Count orphaned native records and report the observed count',
  inputRefs: ['artifact://native-inspection/orphaned-records'],
} as const;
const INSPECTION_DEFINITION = {
  definition: {
    definitionId: INSPECTION_DEFINITION_ID,
    definitionVersion: INSPECTION_DEFINITION_VERSION,
    target: {
      targetRef: 'artifact://native-inspection/target',
      sourceRef: 'artifact://native-inspection/source',
    },
    checkItems: [{ checkId: INSPECTION_CHECK_A.checkId }, { checkId: INSPECTION_CHECK_B.checkId }],
  },
  checks: [INSPECTION_CHECK_A, INSPECTION_CHECK_B],
} as const;
const INSPECTION_TURN_TWO_BODY = 'native inspection check-a body: observed 2 stale records';
const INSPECTION_TURN_THREE_BODY = 'native inspection check-a body: observed 5 stale records';
const INSPECTION_TURN_TWO_JUDGMENT = 'check-a observed 2 stale records';
const INSPECTION_TURN_THREE_JUDGMENT = 'check-a observed 5 stale records';
const INSPECTION_TURN_TWO_PARENT_JUDGMENT = 'parent aggregate judgment: check-a count is 2';
const INSPECTION_TURN_THREE_PARENT_JUDGMENT = 'parent aggregate judgment: check-a count is 5';
const TURN_ONE_GOAL = 'Adopt the independent child result for the first turn';
const TURN_ONE_ACTIONS = 'Call the child, adopt its returned result, and close the first turn';
const TURN_ONE_RESULT = 'The child result is adopted and the first turn is closed';
const TURN_ONE_NEXT = 'Continue with the adopted child conclusion in the second turn';
const TURN_TWO_GOAL = 'Close the second standard turn from the committed first-turn checkpoint';
const TURN_TWO_ACTIONS = 'Consume the first-turn checkpoint and close the second turn';
const TURN_TWO_RESULT = 'The second-turn checkpoint is committed for the third standard turn';
const TURN_TWO_NEXT = 'Continue in the third standard turn and deliver the exact final text body';
const TURN_TWO_DELIVERY = 'Native second-turn delivery body: intermediate progress.';

// Missing carried bodies are optional outside review, but a review cannot
// substitute a caller body for the execution's actual immutable asset.
// Cost: one focused in-process producer case with the real Journal and asset
// store; no Provider, RCC, external model or second harness.
test('configured child review reads the retained execution asset when the carried body is absent', async () => {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, 'review-retained-body-'));
  try {
    const filePath = join(root, 'organ.jsonl');
    const journal = new JsonlOrganJournal(filePath);
    const taskScope = { organId: id('organ', 'review-retained-organ'), taskId: id('task', 'review-retained-task') };
    const scope: ScopeRef = { ...taskScope, cycleId: id('cycle', 'review-retained-cycle'),
      operationId: id('operation', 'review-retained-operation') };
    const admission = await journal.append({ commitId: 'review-retained-admission', kind: 'event', scope,
      payload: { kind: 'review-retained-admission' } });
    const admissionCommitRef = { commitId: admission.commitId!, journalSeq: admission.seq, recordDigest: admission.recordDigest };
    const parentAssignment: WorkAssignment = { assignmentId: 'review-retained-parent', taskId: taskScope.taskId,
      pipelineNodeId: 'review-retained-node', attempt: 1, executionEpoch: 1, inputRevision: 1,
      objective: 'review the retained execution asset', targetRefs: ['retained-subject'],
      expectedOutputRefs: ['retained-output'], successCriteria: ['review exact retained body'],
      failureCriteria: ['review drifted body'], incompleteCriteria: ['retained body missing'],
      requiredCapabilities: ['execute'], mergeGate: 'required' };
    const admittedTurn: AdmittedTurn = { turnId: 'review-retained-turn',
      workAssignmentRef: parentAssignment.assignmentId, taskRef: taskScope.taskId, scopeRef: scope,
      cycleRef: scope.cycleId!, inputRevision: 1, directiveRevision: 1, executionEpoch: 1,
      runtimeBindingRef: 'review-retained-runtime', permissionRevision: 'review-retained-permission',
      admissionEvidenceRefs: [admission.commitId!], currentTurnRef: 'review-retained-current',
      recoveryStateRef: admission.commitId! };
    const parent = await ActiveTurnContext.open({
      journal: createJsonlActiveTurnJournal({ filePath, journal, turnId: admittedTurn.turnId }),
      binding: { admittedTurn, assignment: parentAssignment, scope,
        execution: { runtimeId: 'review-retained-runtime', executionEpoch: 1 } },
      currentTurnRef: admittedTurn.currentTurnRef,
    });
    const assets = new ImmutableAssetStore(join(root, 'assets'));
    const bodyAssets = createChildBodyAssetPort({ store: assets });
    const exactBody = 'retained execution body from the actual immutable asset';
    const executionInvocationId = 'review-retained-execution';
    const reviewBinding = { bindingId: 'review-retained-binding', providerId: 'http',
      protocol: 'responses' as const, endpointRef: 'http:127.0.0.1:9', modelRef: 'review-retained-model',
      configDigest: 'review-retained-config', capabilityDigest: 'review-retained-capability' };
    const asset = await bodyAssets.write({ scope, invocationId: executionInvocationId,
      kind: 'execution', body: exactBody });
    const checkpointId = id('checkpoint', 'review-retained-pre');
    await parent.openChildInvocation({
      invocationId: executionInvocationId,
      childTurnId: 'review-retained-execution-turn',
      checkpointReceiptRef: checkpointId.value,
      binding: { kind: 'execution', assignment: parentAssignment },
    });
    const refinedDelivery = await assets.write('review-retained-refined', new TextEncoder().encode('{}'));
    const executionResult: WorkResult = {
      taskId: parentAssignment.taskId,
      pipelineNodeId: parentAssignment.pipelineNodeId,
      agentId: 'configured-worker',
      assignmentId: parentAssignment.assignmentId,
      attempt: parentAssignment.attempt,
      executionEpoch: parentAssignment.executionEpoch,
      inputRevision: parentAssignment.inputRevision,
      producedArtifactRefs: [asset.ref.locator],
      status: 'succeeded',
      summary: 'execution returned the immutable body',
      outputRefs: [...parentAssignment.expectedOutputRefs],
      evidenceRefs: [asset.ref],
      nextAction: 'review',
    };
    await parent.recordChildReturn({
      kind: 'execution',
      invocationId: executionInvocationId,
      refinedDelivery: { ref: { evidenceId: id('evidence', refinedDelivery.assetId),
        kind: 'operation', source: 'review-retained-fixture',
        locator: refinedDelivery.locator, digest: refinedDelivery.digest, scope },
        view: { kind: 'utf8-text' } },
      assignment: parentAssignment,
      result: executionResult,
    });

    let reviewedInput: Extract<IndependentChildCallInput, { readonly kind: 'review' }> | undefined;
    const producer = createAppChildProducer({
      manager: {
        async callChild(input) {
          if (input.kind !== 'review') throw new Error('fixture only dispatches review');
          reviewedInput = input;
          return { state: 'blocked', invocationId: input.call.invocationId,
            issue: { code: 'fixture-review-stop', ownerId: 'review-retained-fixture',
              reason: 'review input observed', nextAction: { kind: 'stop', ref: 'fixture.review.stop' },
              evidenceRefs: [asset.ref] } };
        },
      },
      parent,
      parentAssignment,
      checkpoints: {
        async pre() { throw new Error('pre-checkpoint is not reached by this fixture'); },
        async post() { throw new Error('post-checkpoint is not reached by this fixture'); },
      },
      refinedDeliveryStore: {
        async store() { throw new Error('review fixture stores no refined delivery'); },
        async read() { throw new Error('review fixture reads no refined delivery'); },
      },
      bodyAssets,
      bindChildRun: async () => { throw new Error('review fixture does not bind a Provider run'); },
      prepareAgentProvider: async (selection) => ({
        configuredAgentId: selection.configuredAgentId,
        roleId: selection.roleId,
        source: 'http',
        provider: { source: 'http', provider: 'http', binding: 'review-retained-binding',
          protocol: 'responses', model: 'review-retained-model', route: 'default',
          baseUrl: 'http://127.0.0.1:9' },
        binding: reviewBinding,
        port: new FakeReplayExecutionRuntimePort({
          binding: reviewBinding,
          stepDelayMs: 0,
          replay: [],
        }),
      }),
      roster: [{ agentId: 'configured-reviewer', roleId: 'review' }],
      admitChildOperation: async () => ({
        authority: {} as never,
        authorityCommitRef: admissionCommitRef,
        businessRegistrationCommitRef: admissionCommitRef,
        coverageCommitRef: admissionCommitRef,
        childAdmission: {
          authorityCommitRef: admissionCommitRef,
          businessRegistrationCommitRef: admissionCommitRef,
          coverageCommitRef: admissionCommitRef,
        },
        intent: {} as never,
        registration: {} as never,
      }),
    });
    const execution = { runtimeId: 'review-retained-runtime', taskId: taskScope.taskId,
      operationId: scope.operationId!, executionEpoch: 1 };
    const call = { invocationId: 'review-retained-call', providerRequestId: 'review-retained-request',
      toolCallId: 'review-retained-call-id', parentExecution: execution,
      businessRegistrationCommitRef: admissionCommitRef };
    const outcome = await producer.execute({
      execution,
      requestId: 'review-retained-request',
      call: { toolId: APP_CHILD_CALL_TOOL.toolId, callId: call.toolCallId,
        continuationRef: 'review-retained-continuation',
        arguments: { purpose: 'review retained body', agentId: 'configured-reviewer',
          kind: 'review', subjectInvocationId: executionInvocationId, reviewKind: 'quality',
          target: 'retained-subject', successCriteria: ['review exact body'] } },
      scope,
      signal: new AbortController().signal,
    });
    assert.equal(outcome.status, 'blocked');
    assert.ok(reviewedInput, 'the actual producer must reach the manager review gate');
    assert.equal(reviewedInput!.input.workerResult.producedArtifactBodies?.[0], exactBody);
    assert.equal(reviewedInput!.input.reviewMaterial.subjects[0]?.body, exactBody);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Missing adapter and the legacy/native append split can lose recovery anchors.
// Impact: false committed success or an old-epoch anchor. Cost: one local Journal
// fixture, no model/network/process; the same fixture covers replay and failure.
// Raw input dumps obscure decision semantics. The existing fixture adds readable
// summary assertions at low cost; the old dump must fail the no-control-key check.
if (!coldConsumerMode) test('App child checkpoint adapter commits native pre/review post and preserves replay across current segments', async () => {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, 'child-checkpoint-'));
  const filePath = join(root, 'organ.jsonl');
  const journal = new JsonlOrganJournal(filePath);
  const scope = { organId: id('organ', 'child-organ'), taskId: id('task', 'child-task'),
    cycleId: id('cycle', 'initial-cycle'), operationId: id('operation', 'initial-operation') };
  const fact = async (label: string, factScope: ScopeRef = scope) => {
    const record = await journal.append({ kind: 'event', commitId: label, scope: factScope, payload: { fact: label } });
    if (!record.commitId) throw new Error('fixture commit is missing');
    return { commitId: record.commitId, journalSeq: record.seq, recordDigest: record.recordDigest };
  };
  const admission = await fact('admission');
  const evidence = (commitId: string, factScope: ScopeRef = scope): EvidenceRef => ({
    evidenceId: id('evidence', commitId), kind: 'operation', source: 'consumer-journal', locator: commitId, scope: factScope,
  });
  const recoveryStateRef = evidence(admission.commitId);
  const worker: WorkAssignment = { assignmentId: 'worker', taskId: scope.taskId, pipelineNodeId: 'child-node',
    attempt: 1, executionEpoch: 1, inputRevision: 1, objective: 'review child', targetRefs: [], expectedOutputRefs: [],
    successCriteria: ['native checkpoint readback'], failureCriteria: [], incompleteCriteria: [],
    requiredCapabilities: [], mergeGate: 'not-required' };
  const originalAdmittedTurn: AdmittedTurn = { turnId: 'child-turn', workAssignmentRef: worker.assignmentId,
    taskRef: scope.taskId, scopeRef: scope, cycleRef: scope.cycleId, inputRevision: 1, directiveRevision: 3,
    executionEpoch: 1, runtimeBindingRef: 'parent-runtime', permissionRevision: 'permission',
    admissionEvidenceRefs: [admission.commitId], currentTurnRef: 'current', recoveryStateRef: admission.commitId };
  const parent = await ActiveTurnContext.open({ journal: createJsonlActiveTurnJournal({ filePath, journal, turnId: originalAdmittedTurn.turnId }),
    binding: { admittedTurn: originalAdmittedTurn, assignment: worker, scope,
      execution: { runtimeId: 'parent-runtime', executionEpoch: 1 } }, currentTurnRef: 'current' });
  const call = { invocationId: `invocation:child:${'a'.repeat(64)}`, providerRequestId: 'request', toolCallId: 'tool-call',
    parentExecution: { runtimeId: 'parent-runtime', executionEpoch: 1, ...scope },
    businessRegistrationCommitRef: await fact('child-registration') };
  const review: ReviewAssignment = { assignmentId: 'review-assignment', taskId: scope.taskId.value,
    workerAgentId: 'reviewer', reviewKind: 'quality', attempt: 1, executionEpoch: 1, inputRevision: 1,
    subjectRefs: ['subject'],
    workerCapabilities: ['provider.execution'], requiredCapabilities: ['review.quality'], mergeGate: 'not-required' };
  const selected = { kind: 'review' as const, invocationId: call.invocationId, assignment: review,
    agentId: 'reviewer', attempt: 1, executionEpoch: 1, scope };
  const store = new ServiceExecutionCheckpointStore(filePath, journal, () => new Date('2026-10-17T00:00:00.000Z'));
  const adapter = createAppChildCheckpointAdapter({ store, parent, originalAdmittedTurn, recoveryStateRef });
  const pre = await adapter.pre({ call, selected, worker });
  assert.ok(!pre.checkpoint.summary.includes('businessRegistrationCommitRef'));
  assert.ok(pre.checkpoint.summary.includes(`目的：${worker.objective}`));
  assert.ok(pre.checkpoint.summary.includes(worker.successCriteria[0]!));
  assert.ok(pre.checkpoint.summary.includes('审查类型：quality'));
  assert.ok(pre.checkpoint.summary.includes('尚未取得该 child 的返回结果'));
  assert.ok(!pre.checkpoint.summary.includes('审查通过'));
  await parent.openChildInvocation({ invocationId: call.invocationId, childTurnId: 'review-turn',
    checkpointReceiptRef: pre.checkpoint.id.value, binding: { kind: 'review', assignment: review } });
  const result: ReviewResult = { ...review, resultId: 'review-result', status: 'passed', findings: [{
    findingId: 'readability', severity: 'advisory', locationRef: 'checkpoint summary',
    problem: 'next action needs clarification', expected: 'state the pending acceptance decision', evidenceRefs: [recoveryStateRef],
  }], evidenceRefs: [recoveryStateRef] };
  const returned = { kind: 'review' as const, invocationId: call.invocationId, assignment: review, result, scope };
  await assert.rejects(() => adapter.post({ call, returned, worker }), /durable review return/);
  const assets = new ImmutableAssetStore(join(root, 'assets'));
  const asset = await assets.write('review-delivery', new TextEncoder().encode('review passed'));
  const refinedDelivery = { ref: { ...recoveryStateRef, evidenceId: id('evidence', asset.assetId),
    locator: asset.assetId, digest: asset.digest }, view: { kind: 'utf8-text' as const } };
  await parent.recordChildReturn({ ...returned, refinedDelivery });
  const post = await adapter.post({ call, returned, worker });
  assert.ok(!post.checkpoint.summary.includes('businessRegistrationCommitRef'));
  assert.ok(post.checkpoint.summary.includes(`目的：${worker.objective}`));
  assert.ok(post.checkpoint.summary.includes('已收到并核对持久化的 quality 审查返回'));
  assert.ok(post.checkpoint.summary.includes('当前结果：passed'));
  for (const finding of result.findings) {
    for (const text of [finding.severity, finding.locationRef, finding.problem, finding.expected]) {
      assert.ok(post.checkpoint.summary.includes(text));
    }
  }
  assert.ok(post.checkpoint.summary.includes('由编排者核对验收依据并决定是否接纳及继续'));
  await parent.recordReviewCheckpoint(call.invocationId, post.checkpoint.id.value);
  assert.ok(pre.checkpoint.id.value !== post.checkpoint.id.value);
  assert.deepEqual(post.previous, pre.checkpoint);
  const freshStore = new ServiceExecutionCheckpointStore(filePath, new JsonlOrganJournal(filePath), () => new Date());
  for (const committed of [pre, post]) {
    assert.deepEqual(await freshStore.readCommitted(scope, committed.checkpoint.id), committed);
    assert.ok(await createJsonlCheckpointJournal({ filePath }).readNativeCheckpoint({ checkpoint: committed.checkpoint }),
      'each returned record has a real native envelope');
  }
  const beforeReplay = await readFile(filePath, 'utf8');
  const freshAdapter = createAppChildCheckpointAdapter({ store: freshStore, parent, originalAdmittedTurn, recoveryStateRef });
  assert.deepEqual(await freshAdapter.pre({ call, selected, worker }), pre);
  assert.deepEqual(await freshAdapter.post({ call, returned, worker }), post);
  await assert.rejects(() => freshAdapter.post({ call, returned: { ...returned, result: { ...result, resultId: 'changed' } }, worker }));
  await assert.rejects(() => freshAdapter.pre({ call, selected, worker: { ...worker, objective: 'different review goal' } }), /replay conflicts/);
  assert.equal(await readFile(filePath, 'utf8'), beforeReplay, 'replay appends no second checkpoint');
  assert.equal(parent.childInvocations()[0]?.checkpointReceiptRef, pre.checkpoint.id.value);
  assert.equal(parent.childInvocations()[0]?.postReviewCheckpointRef, post.checkpoint.id.value);

  const segmentScope = { ...scope, cycleId: id('cycle', 'segment-cycle'), operationId: id('operation', 'segment-operation') };
  const activeRecords = (await journal.verify()).records.filter((record) => record.commitId?.startsWith('active-turn:'));
  const bindingRecord = activeRecords.find((record) => record.commitId?.endsWith(':binding-opened'))!;
  const tailRecord = activeRecords.at(-1)!;
  const bindingCommitRef = { commitId: bindingRecord.commitId!, journalSeq: bindingRecord.seq, recordDigest: bindingRecord.recordDigest };
  const recordsThroughCommitRef = { commitId: tailRecord.commitId!, journalSeq: tailRecord.seq, recordDigest: tailRecord.recordDigest };
  const businessTurnRef = { businessTurnId: originalAdmittedTurn.turnId, bindingCommitRef,
    execution: parent.executionIdentity() };
  const segmentRegistration = await fact('segment-registration', segmentScope);
  const segment = await ActiveTurnSegmentContext.open({
    segment: { kind: 'segment-opened', segmentId: 'segment-2', businessTurnRef,
      predecessor: { segmentId: 'initial', initialOpen: { bindingCommitRef, recordsThroughCommitRef } },
      binding: { businessTurnRef, assignment: { ...worker, executionEpoch: 2 }, scope: segmentScope,
        execution: { runtimeId: 'segment-runtime', executionEpoch: 2 },
        incarnation: { runtimeId: 'segment-runtime', generation: 2, agentInstanceId: 'segment-agent', roleId: 'executor',
          taskId: scope.taskId, assignmentId: worker.assignmentId, executionEpoch: 2 } },
      authorityCommitRef: admission, businessRegistrationCommitRef: segmentRegistration,
      requestRef: 'segment-request', inputIdentity: { requestRef: 'segment-request', digest: 'segment-intent' } },
    initialInput: refinedDelivery, port: { async readSegmentRecords() { return []; }, async appendSegmentRecord() { throw new Error('unused'); } },
  });
  const segmentRecovery = evidence(segmentRegistration.commitId, segmentScope);
  const segmentAdapter = createAppChildCheckpointAdapter({ store, parent: segment, originalAdmittedTurn, recoveryStateRef: segmentRecovery });
  const segmentCall = { ...call, invocationId: 'segment-child', parentExecution: { runtimeId: 'segment-runtime', executionEpoch: 2, ...segmentScope },
    businessRegistrationCommitRef: await fact('segment-child-registration', segmentScope) };
  const segmentSelected = { ...selected, scope: segmentScope, invocationId: segmentCall.invocationId,
    assignment: { ...review, executionEpoch: 2 }, executionEpoch: 2 };
  const segmentPre = await segmentAdapter.pre({ call: segmentCall, selected: segmentSelected, worker });
  assert.equal(segmentPre.checkpoint.executionEpoch, 2, 'checkpoint uses current segment epoch, not original admission epoch');
  assert.deepEqual(segmentPre.checkpoint.scope, segmentScope);
  assert.deepEqual(segmentPre.checkpoint.cycleId, segmentScope.cycleId);
  assert.equal(segmentPre.checkpoint.directiveRevision, 3);
  assert.deepEqual(await freshStore.readCommitted(segmentScope, segmentPre.checkpoint.id), segmentPre);

  // Fail the actual native transaction, while keeping the normal read methods.
  const failingJournal = new JsonlOrganJournal(filePath);
  failingJournal.transaction = async () => { throw new Error('native commit refused'); };
  const failed = createAppChildCheckpointAdapter({
    store: new ServiceExecutionCheckpointStore(filePath, failingJournal, () => new Date()), parent,
    originalAdmittedTurn, recoveryStateRef,
  });
  const failureCall = { ...call, invocationId: 'failed-child' };
  const beforeFailure = await readFile(filePath, 'utf8');
  await assert.rejects(async () => {
    const record = await failed.pre({ call: failureCall, selected: { ...selected, invocationId: failureCall.invocationId }, worker });
    await parent.openChildInvocation({ invocationId: failureCall.invocationId, childTurnId: 'failed-turn',
      checkpointReceiptRef: record.checkpoint.id.value, binding: { kind: 'review', assignment: review } });
  }, /native commit refused/);
  assert.equal(await readFile(filePath, 'utf8'), beforeFailure);
  assert.equal(parent.childInvocations().some((entry) => entry.invocationId === failureCall.invocationId), false);
  console.log('App child checkpoint adapter evidence', JSON.stringify({ nativeRecords: 3, replayUnchanged: true,
    originalEpoch: originalAdmittedTurn.executionEpoch, segmentEpoch: segmentPre.checkpoint.executionEpoch, fixture: root }));
});

// Observed failure: a committed inspect result strands settling without an
// effect completion. Impact: delivery cannot close. Cost: one in-memory public
// consumer fixture; other boundary failure probabilities are unknown.
if (!coldConsumerMode) test('direct Runtime inspect delivery consumes verified raw bytes without an effect receipt', async () => {
  const scope: ScopeRef = { organId: id('organ', 'inspect-organ'), taskId: id('task', 'inspect-task'), cycleId: id('cycle', 'inspect-cycle'), operationId: id('operation', 'parent') };
  const toolOperationId = id('operation', 'inspect-operation');
  const bytes = new TextEncoder().encode('accepted read output 體\n');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const evidence: EvidenceRef = { evidenceId: id('evidence', 'read-output'), kind: 'tool', source: 'inspect-consumer', locator: 'asset://read-output', digest, scope: { ...scope, operationId: toolOperationId } };
  const execution = { runtimeId: 'inspect-runtime', taskId: scope.taskId!, operationId: scope.operationId!, organId: scope.organId, cycleId: scope.cycleId!, executionEpoch: 3 };
  const outputRef = 'asset://provider-tool/output/inspect-operation';
  const fact: AcceptedRawFact = { seq: 96, envelope: { execution, scope, request: { turnId: 'turn', requestId: 'request' }, producerSeq: 1, fact: {
    kind: 'tool-result', contentUnitId: 'result', callId: 'read-call', continuationRef: 'continuation', complete: true,
    result: { ...execution, toolId: 'file.read', callId: 'read-call', status: 'succeeded', outputRefs: [outputRef], outputRef, outputDigest: digest, evidenceRefs: [evidence] },
    rawOutput: { ref: evidence, view: { kind: 'utf8-text' } },
  } } };
  const assignment: WorkAssignment = { assignmentId: 'assignment', taskId: scope.taskId!, pipelineNodeId: 'node', attempt: 1, executionEpoch: 3, inputRevision: 1, objective: 'deliver read output', targetRefs: [], expectedOutputRefs: [], successCriteria: [], failureCriteria: [], incompleteCriteria: [], requiredCapabilities: [], mergeGate: 'not-required' };
  const section = { text: 'read output', evidenceRefs: [evidence] };
  const acceptedEnd: StandardTurnEndCommand = { kind: 'standard-turn-end', identity: { turnId: 'turn', workAssignmentRef: assignment.assignmentId, taskRef: assignment.taskId, scopeRef: scope, cycleRef: scope.cycleId!, inputRevision: 1, directiveRevision: 1, executionEpoch: 3, runtimeBindingRef: 'binding', permissionRevision: 'permission' }, summary: { goal: section, actions: section, result: section, expectedNextStep: section }, deliveryRefs: [evidence.locator], resolvedEvidenceRefs: [evidence] };
  const inspect: InspectToolCompletionDescriptor = { execution, scope: evidence.scope, toolOperationId, requestId: 'request', callId: 'read-call', toolId: 'file.read', intentKind: 'inspect', status: 'succeeded', evidenceRefs: [evidence] };
  const input: StandardTurnDeliveryReadInput = { assignment, acceptedEnd, entries: [fact], completionLookups: [], inspectCompletions: [inspect] };
  const unexpectedEffect = async (): Promise<never> => { throw new Error('inspect must not read or invent effect completion'); };
  const rawContent: RawContentReadPort = { async read(request) { assert.deepEqual(request, { scope, content: fact.envelope.fact.kind === 'tool-result' ? fact.envelope.fact.rawOutput : undefined }); return bytes; } };
  const reader: StandardTurnDeliveryReaderPort = { rawContent, completion: { readExact: unexpectedEffect, commitIntent: unexpectedEffect, commitCompletion: unexpectedEffect, discoverExactExecution: unexpectedEffect } };
  const readback = await readStandardTurnDelivery(input, reader);
  assert.equal(readback.materials[0]?.kind, 'inspect-tool-report');
  assert.deepEqual(readback.materials[0]?.bytes, bytes);
  assert.equal('completion' in readback.materials[0]!, false);
  const binding = bindAssignmentDelivery({ assignment, readback });
  assert.deepEqual(binding.outputRefs, [outputRef]);
  assert.deepEqual(binding.producedArtifactRefs, [outputRef]);
  assert.deepEqual(binding.producedArtifactBodies, [new TextDecoder().decode(bytes)]);

  const rejects = async (candidate: StandardTurnDeliveryReadInput, code: StandardTurnDeliveryError['code']): Promise<void> => {
    await assert.rejects(() => readStandardTurnDelivery(candidate, reader), (error: unknown) => error instanceof StandardTurnDeliveryError && error.code === code);
  };
  // Missing positive control must never turn a mutating tool into inspect.
  assert.equal(fact.envelope.fact.kind, 'tool-result');
  if (fact.envelope.fact.kind !== 'tool-result') throw new Error('fixture must be a tool result');
  const resultFact = fact.envelope.fact;
  const withResult = (result: typeof resultFact.result): AcceptedRawFact => ({ ...fact, envelope: { ...fact.envelope, fact: { ...resultFact, result } } });
  await rejects({ ...input, inspectCompletions: [], entries: [withResult({ ...resultFact.result, toolId: 'file.write' })] }, 'standard-turn-delivery.completion-unknown');
  await rejects({ ...input, entries: [withResult({ ...resultFact.result, outputDigest: `sha256:${'0'.repeat(64)}` })] }, 'standard-turn-delivery.artifact-conflict');
  await rejects({ ...input, entries: [withResult({ ...resultFact.result, status: 'failed' })] }, 'standard-turn-delivery.completion-conflict');
  await rejects({ ...input, entries: [withResult({ ...resultFact.result, executionFact: { identity: { surface: 'native', toolId: 'file.read', bindingRef: 'binding', route: 'native' }, requestRef: 'request', state: 'succeeded', rawEvidenceRefs: [evidence.locator] } })] }, 'standard-turn-delivery.completion-conflict');
  await rejects({ ...input, inspectCompletions: [{ ...inspect, evidenceRefs: [{ ...evidence, scope }] }] }, 'standard-turn-delivery.completion-conflict');
  await rejects({ ...input, completionLookups: [{ commitIdentity: `operation-completion:v1:${'1'.repeat(64)}`, effectId: `file-write-effect:v1:${'2'.repeat(64)}`, binding: { execution, scope: evidence.scope, toolOperationId, requestId: 'request', callId: 'read-call', continuationRef: 'continuation' } }] }, 'standard-turn-delivery.completion-conflict');
  const logicalAssignment = { ...assignment, expectedOutputRefs: ['logical-output'] };
  assert.deepEqual(bindAssignmentDelivery({ assignment: logicalAssignment, readback: { ...readback, assignment: logicalAssignment } }).outputRefs, ['logical-output']);
  assert.throws(() => bindAssignmentDelivery({ assignment, readback: { ...readback, materials: [] } }), (error: unknown) => error instanceof StandardTurnDeliveryError && error.code === 'standard-turn-delivery.binding-invalid');
  const overdeclared = { ...assignment, expectedOutputRefs: ['first', 'second'] };
  assert.throws(() => bindAssignmentDelivery({ assignment: overdeclared, readback: { ...readback, assignment: overdeclared } }), (error: unknown) => error instanceof StandardTurnDeliveryError && error.code === 'standard-turn-delivery.binding-invalid');
});

/**
 * Verbatim model reply from the real live Task that the harness blocked. It is
 * reused unchanged as the negative sample: its snapshot uses `scope`/`status`,
 * `id`, `type`, `name`, `nodes`, `from`/`to`/`type` instead of the required
 * TaskPlanSnapshot fields and omits `title`/`summary`. The existing validator
 * must keep rejecting it, and a corrected reply must never stand in for it.
 */
const REAL_LIVE_REJECTED_REPLY = "{\"decision\":\"complete\",\"snapshot\":{\"scope\":\"whole-task\",\"status\":\"complete\",\"acceptanceCriteria\":[{\"id\":\"ac-1\",\"description\":\"deliveryText \u5fc5\u987b\u539f\u6837\u7b49\u4e8e\u5df2\u786e\u8ba4\u7684\u56fa\u5b9a\u6b63\u6587\uff0c\u9010\u5b57\u8282\u4e00\u81f4\uff0c\u5305\u542b\u6240\u6709 Unicode \u4e0e\u6362\u884c\uff1b\u4e0d\u5f97\u6539\u5199\u3001\u589e\u5220\u3001\u8f6c\u4e49\u6216\u7ffb\u8bd1\u3002\"},{\"id\":\"ac-2\",\"description\":\"\u4e0d\u5f97\u8c03\u7528\u4efb\u4f55\u7f51\u7edc\u3001\u6587\u4ef6\u6216\u547d\u4ee4\u5de5\u5177\uff1b\u4ec5\u8c03\u7528 humanagent_turn_end \u4e00\u6b21\u3002\"},{\"id\":\"ac-3\",\"description\":\"deliveryRefs \u5fc5\u987b\u4e3a\u7a7a\u6570\u7ec4\u3002\"},{\"id\":\"ac-4\",\"description\":\"standard turn end \u63d0\u4ea4\u540e\uff0c\u672c\u4efb\u52a1\u4e0d\u518d\u8ffd\u52a0\u4efb\u4f55\u64cd\u4f5c\u3002\"}],\"nodes\":[{\"id\":\"node-confirm-source\",\"type\":\"verification\",\"description\":\"\u786e\u8ba4\u56fa\u5b9a\u6b63\u6587\u6765\u6e90\u4e0e\u7248\u672c\uff0c\u9501\u5b9a\u5f85\u4ea4\u4ed8\u6587\u672c\",\"evidenceRefs\":[\"confirmation:native-g9-responses-live-r1\"]},{\"id\":\"node-deliver-body\",\"type\":\"action\",\"description\":\"\u901a\u8fc7 humanagent_turn_end \u539f\u6837\u4ea4\u4ed8\u56fa\u5b9a\u6b63\u6587\u4f5c\u4e3a deliveryText\",\"evidenceRefs\":[\"execution-82c500d8f70b5dd3e9f870822045724ed910d8a4b2b396476f67eebbf6a1b929\"]},{\"id\":\"node-empty-refs\",\"type\":\"action\",\"description\":\"deliveryRefs \u4f20\u7a7a\u6570\u7ec4\",\"evidenceRefs\":[\"execution-82c500d8f70b5dd3e9f870822045724ed910d8a4b2b396476f67eebbf6a1b929\"]},{\"id\":\"node-turn-end\",\"type\":\"action\",\"description\":\"\u6267\u884c\u4e00\u6b21 standard turn end\uff0c\u63d0\u4ea4\u672c\u8f6e\u7ed3\u679c\",\"evidenceRefs\":[\"execution-82c500d8f70b5dd3e9f870822045724ed910d8a4b2b396476f67eebbf6a1b929\"]}],\"phases\":[{\"id\":\"phase-prepare\",\"name\":\"\u51c6\u5907\u4e0e\u786e\u8ba4\",\"nodes\":[\"node-confirm-source\"]},{\"id\":\"phase-deliver\",\"name\":\"\u4ea4\u4ed8\u4e0e\u7ed3\u675f\",\"nodes\":[\"node-deliver-body\",\"node-empty-refs\",\"node-turn-end\"]}],\"relations\":[{\"from\":\"node-confirm-source\",\"to\":\"node-deliver-body\",\"type\":\"precedes\"},{\"from\":\"node-deliver-body\",\"to\":\"node-empty-refs\",\"type\":\"precedes\"},{\"from\":\"node-empty-refs\",\"to\":\"node-turn-end\",\"type\":\"precedes\"}]},\"reasonText\":\"\u5df2\u786e\u8ba4\u7684\u56fa\u5b9a\u6b63\u6587\u5df2\u6309\u4efb\u52a1\u8981\u6c42\u539f\u6837\u4f5c\u4e3a deliveryText \u4ea4\u4ed8\uff0c\u4e14\u4ec5\u8c03\u7528\u4e00\u6b21 humanagent_turn_end\uff0cdeliveryRefs \u4e3a\u7a7a\uff0c\u672a\u8c03\u7528\u4efb\u4f55\u5176\u4ed6\u5de5\u5177\uff1b\u8ba1\u5212\u8986\u76d6\u5168\u90e8\u9a8c\u6536\u6807\u51c6\uff0c\u56e0\u6b64\u5224\u5b9a\u4e3a complete\u3002\"}";

type JsonSchemaProperties = { readonly properties: Record<string, {
  readonly type?: string; readonly minItems?: number; readonly required?: readonly string[];
}> };

interface ResponsesWireItem {
  readonly type?: string;
  readonly role?: string;
  readonly name?: string;
  readonly call_id?: string;
  readonly arguments?: string;
  readonly output?: string;
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
}

interface ResponsesWireBody {
  readonly model?: string;
  readonly input?: readonly ResponsesWireItem[];
  readonly tools?: readonly { readonly name?: string }[];
}

interface Wire {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly authorization?: string;
}

interface SemanticCheckpointWire {
  readonly goal?: unknown;
  readonly checkpointId?: unknown;
  readonly committedAt?: unknown;
  readonly description?: unknown;
  readonly result?: unknown;
  readonly evidenceRefs?: unknown;
  readonly adoptedChildren?: readonly {
    readonly childTurnId?: unknown;
    readonly scope?: unknown;
    readonly content?: unknown;
    readonly text?: unknown;
  }[];
}

const coldConsumerRoot = process.argv.find((arg) => arg === '--fixture-root') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--fixture-root') + 1];
const coldConsumerTask = process.argv.find((arg) => arg === '--task-id') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--task-id') + 1];
const coldConsumerOperation = process.argv.find((arg) => arg === '--operation-id') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--operation-id') + 1];
const coldConsumerWorkspace = process.argv.find((arg) => arg === '--workspace') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--workspace') + 1];
const coldConsumerControlRoot = process.argv.find((arg) => arg === '--control-root') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--control-root') + 1];
const coldConsumerCookie = process.argv.find((arg) => arg === '--cookie-file') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--cookie-file') + 1];
const coldConsumerUiRoot = process.argv.find((arg) => arg === '--ui-root') === undefined
  ? undefined
  : process.argv[process.argv.indexOf('--ui-root') + 1];

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`deadline exceeded after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
 * The independent Planner sends exactly one user message whose `input_text`
 * is the whole-task business payload. Execution requests carry the standard
 * end tool surface and the accepted function-call replay instead.
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

function reviewPayload(raw: string): Record<string, unknown> | undefined {
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
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
      const prompt = (candidate as Record<string, unknown>).prompt;
      if (typeof prompt !== 'string') continue;
      const start = prompt.lastIndexOf('\n\n{"role":"review",');
      if (start < 0) continue;
      const material = JSON.parse(prompt.slice(start + 2)) as unknown;
      if (typeof material === 'object' && material !== null && !Array.isArray(material)
        && (material as Record<string, unknown>).role === 'review') {
        return material as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/** True once the execution request replays the accepted standard-end call. */
function declaresTurnEnd(raw: string): boolean {
  return (parseResponsesWire(raw)?.input ?? [])
    .some((item) => item.type === 'function_call' && item.name === 'humanagent_turn_end');
}

/** True when the request declares the Harness standard-end tool surface. */
function hasTurnEndSurface(raw: string): boolean {
  return (parseResponsesWire(raw)?.tools ?? []).some((tool) => tool.name === 'humanagent_turn_end');
}

function semanticCheckpointWires(raw: string): readonly SemanticCheckpointWire[] {
  const checkpoints: SemanticCheckpointWire[] = [];
  for (const item of parseResponsesWire(raw)?.input ?? []) {
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    for (const part of item.content ?? []) {
      if (typeof part.text !== 'string') continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(part.text);
      } catch {
        continue;
      }
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
      const checkpoint = candidate as SemanticCheckpointWire;
      if (['goal', 'actions', 'result', 'nextStep', 'adoptedChildren'].every((key) =>
        Object.hasOwn(checkpoint, key))) checkpoints.push(checkpoint);
    }
  }
  return checkpoints;
}

async function assertPriorSemanticCheckpointWire(
  fixture: Awaited<ReturnType<typeof textOnlyFixture>>,
  raw: string,
  taskId: { readonly value: string },
  goal: string,
): Promise<void> {
  const wire = semanticCheckpointWires(raw).find((entry) => entry.goal === goal);
  assert.ok(wire, `the captured execution request contains the ${goal} semantic checkpoint`);
  if (!wire) throw new Error(`the captured execution request is missing the ${goal} semantic checkpoint`);
  const publicationRecord = (await fixture.journal.verify()).records.find((record) =>
    record.payload?.['kind'] === 'native-semantic-history-publication'
    && record.scope.taskId?.value === taskId.value
    && (() => {
      const relationship = record.payload?.['checkpoint'];
      if (typeof relationship !== 'object' || relationship === null || Array.isArray(relationship)) return false;
      const checkpoint = (relationship as Record<string, unknown>)['checkpoint'];
      if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) return false;
      const summary = (checkpoint as Record<string, unknown>)['summary'];
      return typeof summary === 'string' && summary.includes(goal);
    })());
  assert.ok(publicationRecord, `the durable ${goal} semantic publication exists`);
  if (!publicationRecord) throw new Error(`the durable ${goal} semantic publication is absent`);
  const relationship = publicationRecord.payload?.['checkpoint'] as {
    readonly checkpoint?: { readonly id?: unknown; readonly summary?: unknown; readonly evidenceRefs?: unknown };
    readonly receipt?: { readonly committedAt?: unknown };
  } | undefined;
  const checkpoint = relationship?.checkpoint;
  if (!checkpoint || typeof checkpoint.summary !== 'string') {
    throw new Error(`the durable ${goal} semantic checkpoint is malformed`);
  }
  assert.deepEqual(wire.checkpointId, checkpoint.id,
    `the ${goal} wire checkpointId equals the durable typed checkpoint ID`);
  assert.equal(wire.committedAt, relationship?.receipt?.committedAt,
    `the ${goal} wire committedAt equals the durable receipt time`);
  assert.equal(wire.description, checkpoint.summary,
    `the ${goal} wire description equals the durable checkpoint summary`);
  assert.deepEqual(wire.evidenceRefs, checkpoint.evidenceRefs,
    `the ${goal} wire top-level evidenceRefs equal the committed evidence references`);
  assert.ok(Array.isArray(wire.adoptedChildren), `the ${goal} wire keeps its adopted children`);
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

/**
 * The Planner output contract must declare every required TaskPlanSnapshot
 * field on the real wire. The live Task blocked because the old contract named
 * only a placeholder snapshot, so the model omitted `title`/`summary` and used
 * incompatible nested field names. Asserting the exact field names catches that
 * gap before any model reply.
 */
function assertPlannerContractComplete(payload: Record<string, unknown>): void {
  const instruction = requireText(payload.instruction, 'the Planner output contract');
  const required = [
    '"decision"', '"continue"', '"complete"', '"failed"', '"snapshot"', '"reasonText"',
    '"title"', '"summary"', '"completeness"', '"acceptanceCriteria"', '"criterionId"', '"description"',
    '"nodes"', '"nodeId"', '"kind"', '"intent"', '"definition"',
    '"phases"', '"phaseId"', '"memberNodeIds"',
    '"relations"', '"fromNodeId"', '"toNodeId"',
  ];
  for (const field of required) {
    assert.ok(instruction.includes(field), `the Planner output contract must declare ${field}`);
  }
  // TaskPlanRelationKind is a closed enum. The live reply answered `precedes`,
  // a kind the Contracts validator rejects, so the wire must name every legal
  // relation kind; naming none of them let the model invent its own kind.
  for (const kind of ['"depends-on"', '"parent-child"', '"sequence"']) {
    assert.ok(instruction.includes(kind), `the Planner output contract must declare the relation kind ${kind}`);
  }
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

function reviewFrames(model: string, payload: Record<string, unknown>): readonly Record<string, unknown>[] {
  const criteria = requireRecord(JSON.parse(requireText(payload.acceptanceCriteria, 'the review acceptance criteria')),
    'the review acceptance criteria');
  const subjects = Array.isArray(payload.subjects) ? payload.subjects.map((subject, index) => {
    const record = requireRecord(subject, `review subject ${index + 1}`);
    return { ref: requireText(record.ref, `review subject ${index + 1} ref`),
      body: requireText(record.body, `review subject ${index + 1} body`) };
  }) : [];
  if (subjects.length === 0) throw new Error('the review request carries no subject bodies');
  const criteriaText = JSON.stringify(criteria);
  assert.equal(criteriaText, JSON.stringify({
    objective: 'three-turn delivery probe',
    successCriteria: ['standard turn closure and canonical Planner alignment'],
    failureCriteria: ['execution error'],
    incompleteCriteria: ['standard turn or Planner alignment remains pending'],
  }), 'the review request must carry the actual execution criteria content');
  const exact = subjects.filter((subject) => subject.body === EXACT_BODY);
  assert.equal(exact.length, 1, 'the review request must carry the complete exact delivered body');
  const text = [
    `Criteria: ${criteriaText}`,
    ...subjects.map((subject) => `Subject ${subject.ref}: ${subject.body}`),
    '',
    'The actual acceptance criteria and non-empty subject bodies support the exact delivery.',
    'HUMANAGENT_REVIEW: passed',
  ].join('\n');
  return [
    { type: 'response.created', response: { id: `response-${model}-review` } },
    { type: 'response.output_text.done', item_id: `review-message-${model}`, text },
    { type: 'response.completed', response: { id: `response-${model}-review` } },
  ];
}

/**
 * The one lawful Planner response, built only from the actual request payload.
 * Publication IDs, sequence numbers, digests and alignment remain owned by the
 * product composition; this fixture supplies only the model decision.
 */
function plannerFrames(
  model: string,
  payload: Record<string, unknown>,
  multiTurnAttempt?: number,
  turnCount: 2 | 3 = 2,
  inspection = false,
  reviewPerCycle = false,
): readonly Record<string, unknown>[] {
  const task = requireRecord(payload.task, 'the task');
  const closure = requireRecord(payload.closure, 'the closure');
  const summary = requireRecord(closure.summary, 'the closure summary');
  const title = requireText(task.title, 'the task title');
  const directive = requireText(task.directive, 'the task directive');
  const goal = closureSection(summary.goal, 'goal');
  const actions = closureSection(summary.actions, 'actions');
  const result = closureSection(summary.result, 'result');
  const expectedNextStep = closureSection(summary.expectedNextStep, 'expectedNextStep');
  let snapshot: Record<string, unknown>;
  let decision: 'continue' | 'complete';
  const firstPublication = payload.priorPlan === null;
  if (multiTurnAttempt === undefined && !firstPublication) {
    throw new Error('the Planner request did not carry the expected null priorPlan for the first publication');
  }
  if (multiTurnAttempt === 1 && !firstPublication) {
    throw new Error('the first multi-turn Planner request must carry null priorPlan');
  }
  if (multiTurnAttempt !== undefined && multiTurnAttempt > 1) {
    const priorPlan = requireRecord(payload.priorPlan, 'the prior multi-turn plan');
    assert.equal(requireNumber(priorPlan.sequence, 'the prior multi-turn plan sequence'), multiTurnAttempt - 1);
  }
  if (firstPublication) {
    const confirmedSource = requireRecord(payload.confirmedSource, 'the confirmed source');
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
    snapshot = {
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
    if (inspection) snapshot.inspectionDefinition = INSPECTION_DEFINITION;
    decision = multiTurnAttempt !== undefined && multiTurnAttempt < turnCount ? 'continue' : 'complete';
  } else {
    snapshot = requireRecord(requireRecord(payload.priorPlan, 'the prior plan').snapshot, 'the prior plan snapshot');
    decision = multiTurnAttempt !== undefined && multiTurnAttempt < turnCount ? 'continue' : 'complete';
  }
  let reviewReason: string | undefined;
  if (reviewPerCycle) {
    const refined = (payload.refinedResults as unknown[]).map((entry) => requireRecord(entry, 'adopted refined result'));
    assert.deepEqual(refined.map((entry) => entry.role), ['execution', 'review'],
      'each independent Planner receives adopted execution and review results');
    assert.deepEqual(refined.map((entry) => entry.status), ['succeeded', 'succeeded']);
    const review = requireText(refined[1]!.summary, 'adopted review summary');
    reviewReason = `Cycle ${multiTurnAttempt}: ${review}; ${decision}`;
    snapshot = { ...snapshot, summary: `${goal.text}; ${result.text}; ${reviewReason}`,
      nodes: (snapshot.nodes as Record<string, unknown>[]).map((node) => ({ ...node,
        intent: `${directive}; ${reviewReason}`,
        ...(firstPublication ? { definition: { directive } } : {}),
      })) };
  }
  const text = JSON.stringify({
    decision,
    snapshot,
    reasonText: reviewReason ?? (decision === 'continue'
      ? 'the first closed turn adopted a child and requires the next standard turn'
      : 'the whole-task plan is aligned to the closed turn'),
  });
  return [
    { type: 'response.created', response: { id: `response-${model}-planner` } },
    { type: 'response.output_text.done', item_id: `planner-message-${model}`, text },
    { type: 'response.completed', response: { id: `response-${model}-planner` } },
  ];
}

/** The bounded native UI-runtime layout used by the real CLI run entry. */
function nativeRuntimeLayout(paths: { readonly checkpointsRoot: string }) {
  const modeRoot = join(paths.checkpointsRoot, 'ui-runtime', 'rcc');
  return {
    modeRoot,
    preparedJournalPath: join(modeRoot, 'ui-runtime-journal.jsonl'),
    organJournalPath: join(modeRoot, 'task-control.jsonl'),
  };
}

interface TextOnlyFixtureScenario {
  readonly kind: 'explicit-helper' | 'm3-long-running';
  readonly parentModel: 'text.only.model';
  readonly childModel: 'child.only.model';
  readonly rawInput?: string;
}

function explicitHelperModelText(body: ResponsesWireBody): string {
  return (body.input ?? [])
    .filter((item) => item.type === 'message' && item.role === 'user')
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'input_text' && typeof part.text === 'string')
    .map((part) => part.text!)
    .join('\n');
}

function explicitHelperToolOutput(wire: ResponsesWireBody, callId: string): string | undefined {
  return wire.input?.find((item) =>
    item.type === 'function_call_output' && item.call_id === callId)?.output;
}

function explicitHelperCall(
  callId: string,
  name: 'dispatch_helper' | 'accept_helper',
  args: unknown,
): readonly Record<string, unknown>[] {
  return [
    { type: 'response.created', response: { id: callId } },
    { type: 'response.output_item.done', output_index: 0, item: {
      type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } },
    { type: 'response.completed', response: { id: callId } },
  ];
}

function explicitHelperText(text: string): readonly Record<string, unknown>[] {
  return [
    { type: 'response.created', response: { id: 'n3-explicit-helper-text' } },
    { type: 'response.output_text.done', item_id: 'n3-explicit-helper-text', text },
    { type: 'response.completed', response: { id: 'n3-explicit-helper-text' } },
  ];
}

/**
 * Controlled local Responses upstream. It answers the real RCC readiness
 * probes, then serves one generation: the advertised `humanagent_turn_end`
 * function call carrying a text-only delivery (`deliveryText` present,
 * `deliveryRefs` empty) plus the final drain. No file.write or other effect
 * tool is fabricated: the summary cites the real admission commit id read from
 * the same Organ Journal the App owns.
 */
async function textOnlyResponsesUpstream(input: {
  readonly model: string;
  readonly organFilePath: string;
  readonly journal: JsonlOrganJournal;
  readonly inspect?: boolean;
  readonly child?: boolean;
  readonly parallelChild?: boolean;
  readonly reviewPerCycle?: boolean;
  readonly badReviewSelector?: boolean;
  readonly inspection?: boolean;
  readonly turnCount?: 2 | 3;
  readonly scenario?: TextOnlyFixtureScenario;
  readonly interactionScopeId?: string;
  readonly requiredBearer?: string;
  readonly interruptThirdTurnOnce?: () => Promise<void>;
  readonly holdFirstExecutionOnce?: () => Promise<void>;
  readonly holdInspectionAfterAdoptOnce?: () => Promise<void>;
}): Promise<{ readonly wires: Wire[]; readonly baseUrl: string; overlapped(): boolean;
  completedInReverse(): boolean; interruptedThirdTurn(): boolean; turnThreeHeld(): boolean;
  inspectionInvocations(): readonly { callId: string; invocationId: string }[];
  inspectionChildRequests(): readonly { body: string; parentCallId: string }[];
  explicitHelperPhase(): string | undefined;
  close(): Promise<void> }> {
  const wires: Wire[] = [];
  const inspectionInvocations = new Map<string, string>();
  const inspectionChildRequests: { body: string; parentCallId: string }[] = [];
  let plannerAttempts = 0;
  let readIssued = false;
  const childAEntered = deferred();
  const childBEntered = deferred();
  const finishChildB = deferred();
  let overlap = false;
  let reversedCompletion = false;
  let thirdTurnInterrupted = false;
  let holdTurnThree = false;
  let firstExecutionHeld = false;
  let inspectionAdoptHeld = false;
  let explicitHelperPhase: string | undefined;
  const frame = (events: readonly unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const path = request.url ?? '';
      const body = Buffer.concat(chunks).toString('utf8');
      const authorization = request.headers.authorization;
      wires.push({
        method: request.method ?? '',
        path,
        body,
        ...(typeof authorization === 'string' ? { authorization } : {}),
      });
      if (input.requiredBearer !== undefined
        && authorization !== `Bearer ${input.requiredBearer}`) {
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end('fixture bearer mismatch');
        return;
      }
      if (path === '/health' || path === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(path === '/health'
          ? { status: 'ok', version: 'text-only-slice' }
          : { data: [{ id: input.model }, { id: 'child.only.model' }] }));
        return;
      }
      if (input.scenario?.kind === 'explicit-helper') {
        const wire = parseResponsesWire(body);
        if (wire === undefined) throw new Error('explicit helper fixture received a non-JSON Responses request');
        const invoke = (callId: string, name: 'dispatch_helper' | 'accept_helper', args: unknown) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(frame(explicitHelperCall(callId, name, args)));
        };
        if (wire.model === input.scenario.childModel) {
          explicitHelperPhase = 'child-provider-start';
          const helperJournal = new JsonlInteractionHelperJournal(input.journal);
          const opened = await new JsonlInteractionParentTurnJournal(input.journal).readScopeOpenedTurns({
            organId: id('organ', 'humanagent-ui'),
            interactionScopeId: requireText(input.interactionScopeId,
              'the explicit helper interaction scope'),
          });
          assert.equal(opened.length, 1, 'the isolated fixture has one open parent turn');
          const helpers = await helperJournal.readTurnHelpers(opened[0]!.fact.turn);
          assert.equal(helpers.length, 1, 'the open parent turn dispatched one helper');
          const helper = helpers[0]!;
          const dispatch = helper.readback.dispatchAccepted;
          if (dispatch === null) throw new Error('the child Provider start has no durable dispatch');
          const incarnation = dispatch.fact.incarnation;
          if (incarnation === undefined) throw new Error('the durable dispatch has no incarnation');
          assert.equal(incarnation.modelRef, input.scenario.childModel,
            'the durable dispatch selects the configured child model');
          assert.equal('execution' in wire, false,
            'the child HTTP body carries no runtime execution identity');
          assert.equal(helper.readback.returned, null, 'the child Provider start precedes the durable return');
          const prompt = explicitHelperModelText(wire);
          assert.ok(prompt.includes(EXPLICIT_HELPER_CHILD_INPUT),
            'the child receives its specified handoff input');
          assert.equal(prompt.includes('parent-private-n3'), false,
            'the child does not inherit the parent raw marker');
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(frame(explicitHelperText(JSON.stringify({
            agentId: 'orchestration-default',
            producedArtifactRefs: [],
            producedArtifactDigests: [],
            status: 'succeeded',
            summary: EXPLICIT_HELPER_CHILD_SUMMARY,
            outputRefs: [],
            evidenceRefs: [],
            nextAction: 'settle',
          }))));
          return;
        }
        assert.equal(wire.model, input.scenario.parentModel,
          'the parent selects its configured Provider model');
        const dispatchOutput = explicitHelperToolOutput(wire, 'n3-dispatch');
        if (dispatchOutput === undefined) {
          explicitHelperPhase = 'parent-dispatch';
          assert.ok(explicitHelperModelText(wire).includes(EXPLICIT_HELPER_PARENT_MARKER),
            'the parent wire carries the private marker used by the child-context exclusion assertion');
          assert.ok(wire.tools?.some((tool) => tool.name === 'dispatch_helper'));
          invoke('n3-dispatch', 'dispatch_helper', {
            selection: { roleId: 'orchestration', configuredAgentId: 'orchestration-default' },
            assignmentFields: {
              objective: 'Return the bounded child-only result',
              targetRefs: [],
              expectedOutputRefs: [],
              expectedArtifactDigests: [],
              acceptanceCriteriaDigest: `sha256:${'a'.repeat(64)}`,
              successCriteria: ['Return the specified structured helper result'],
              failureCriteria: ['Unable to return the bounded result'],
              incompleteCriteria: ['Partial result'],
              requiredCapabilities: [],
              mergeGate: 'not-required',
            },
            inputs: {
              question: EXPLICIT_HELPER_CHILD_INPUT,
              resultContract: 'Return the specified structured helper result',
            },
            evidenceRefs: [],
          });
          return;
        }
        explicitHelperPhase = 'parent-dispatch-returned';
        const dispatched = requireRecord(JSON.parse(requireText(dispatchOutput, 'the dispatch tool output')),
          'the dispatch receipt');
        const dispatchedIdentity = requireRecord(dispatched.identity, 'the dispatch receipt identity');
        const helperCallId = requireText(dispatchedIdentity.helperCallId,
          'the dispatch receipt helper call ID');
        const helperJournal = new JsonlInteractionHelperJournal(input.journal);
        const dispatchIdentity: InteractionHelperIdentity = {
          organId: id('organ', requireText(requireRecord(dispatchedIdentity.organId, 'the dispatch organ').value,
            'the dispatch organ value')),
          interactionScopeId: requireText(dispatchedIdentity.interactionScopeId,
            'the dispatch interaction scope'),
          interactionId: requireText(dispatchedIdentity.interactionId, 'the dispatch interaction ID'),
          inputRevision: requireNumber(dispatchedIdentity.inputRevision, 'the dispatch input revision'),
          parentTurnId: requireText(dispatchedIdentity.parentTurnId, 'the dispatch parent turn ID'),
          assignmentId: requireText(dispatchedIdentity.assignmentId, 'the dispatch assignment ID'),
          helperCallId,
          attempt: requireNumber(dispatchedIdentity.attempt, 'the dispatch attempt'),
        };
        const returned = await helperJournal.readExact(dispatchIdentity);
        if (returned.returned === null) throw new Error('the parent receives no durable returned helper fact');
        assert.equal(returned.returned.fact.result.summary, EXPLICIT_HELPER_CHILD_SUMMARY,
          'the parent receives the actual child result');
        if (explicitHelperToolOutput(wire, 'n3-accept') === undefined) {
          assert.equal(returned.ownerAccepted, null, 'returned is not owner acceptance before the owner accepts');
          assert.equal(returned.adoptedCheckpoint, null, 'returned creates no adopted checkpoint before owner acceptance');
          invoke('n3-accept', 'accept_helper', {
            helperCallId,
            refinedText: EXPLICIT_HELPER_REFINED_TEXT,
            acceptanceRef: 'acceptance:n3-public-helper',
            evidenceRefs: [],
          });
          return;
        }
        assert.ok(returned.ownerAccepted !== null, 'the accepted helper has a durable owner acceptance');
        assert.equal(returned.ownerAccepted?.fact.result.helperCallId, helperCallId,
          'owner acceptance retains the actual helper call ID');
        assert.ok(returned.adoptedCheckpoint !== null,
          'owner acceptance creates a durable adopted checkpoint');
        explicitHelperPhase = 'parent-answer';
        assert.deepEqual((wire.input ?? [])
          .filter((item) => item.type === 'function_call'
            && (item.name === 'dispatch_helper' || item.name === 'accept_helper'))
          .map((item) => item.name), ['dispatch_helper', 'accept_helper'],
        'the answer request replays both actual explicit helper tools');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frame(explicitHelperText(JSON.stringify({
          kind: 'answer',
          normalizedInput: 'bounded public helper proof',
          knownFacts: [],
          answer: EXPLICIT_HELPER_REFINED_TEXT,
          decisionRefs: [],
        }))));
        return;
      }
      if (input.scenario?.kind === 'm3-long-running'
        && body.includes('# Explicit intake decision output')) {
        const wire = parseResponsesWire(body);
        if (wire === undefined) throw new Error('public intake fixture received a non-JSON Responses request');
        assert.equal(wire.model, input.scenario.parentModel,
          'public explicit intake selects its configured interaction model');
        const rawInput = requireText(input.scenario.rawInput, 'the public intake fixture input');
        assert.ok(explicitHelperModelText(wire).includes(rawInput),
          'public explicit intake receives the exact submitted business input');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frame(explicitHelperText(JSON.stringify({
          kind: 'requirement',
          normalizedInput: rawInput,
          knownFacts: [],
          decisionRefs: [],
          proposal: {
            revision: 1,
            intent: 'create',
            title: 'M3 public long-running dynamic task',
            objective: rawInput,
            deliverable: 'Two dynamic plan revisions and public plan history',
            deliveryConditions: ['Preserve the confirmed long-running task flow'],
            evidenceRefs: [],
            blockingGaps: [],
          },
        }))));
        return;
      }
      const planner = plannerPayload(body);
      if (planner !== undefined) {
        plannerAttempts += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frame(input.inspect && input.turnCount === undefined && plannerAttempts === 1 ? [
          { type: 'response.created', response: { id: 'planner-refused' } },
          { type: 'response.output_text.done', item_id: 'planner-refused-text', text: '{}' },
          { type: 'response.completed', response: { id: 'planner-refused' } },
        ] : plannerFrames(input.model, planner, input.turnCount === undefined ? undefined : plannerAttempts,
          input.turnCount ?? 2, input.inspection === true, input.reviewPerCycle === true)));
        return;
      }
      const review = reviewPayload(body);
      if (review !== undefined) {
        const wire = parseResponsesWire(body);
        assert.equal(wire?.model, 'text.only.model', 'review selects the local legacy Provider model');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frame(reviewFrames(input.model, review)));
        return;
      }
      if (declaresTurnEnd(body)) {
        if (input.parallelChild && body.includes('call-child-1-end')) finishChildB.resolve();
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frame([
          { type: 'response.created', response: { id: 'text-drain' } },
          { type: 'response.output_text.done', item_id: 'text-text', text: 'Text-only delivery drained' },
          { type: 'response.completed', response: { id: 'text-drain' } },
        ]));
        return;
      }
      if (!hasTurnEndSurface(body)) {
        throw new Error('the controlled upstream could not identify a lawful Responses stage');
      }
      if (input.holdFirstExecutionOnce !== undefined && !firstExecutionHeld) {
        firstExecutionHeld = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        // Keep the actual Provider response open without accepting any model
        // output. The public stop must settle this dispatched request itself.
        response.write(': first execution capture-stop hold\n\n');
        await input.holdFirstExecutionOnce();
        return;
      }
      if (input.interruptThirdTurnOnce !== undefined && input.turnCount === 3
        && plannerAttempts === 2 && !thirdTurnInterrupted) {
        thirdTurnInterrupted = true;
        holdTurnThree = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        // An SSE comment flushes the real headers so the held turn is observably
        // dispatched before the interrupt, without emitting model output.
        response.write(': interrupted third-turn hold\n\n');
        await input.interruptThirdTurnOnce();
        return;
      }
      if (input.inspection && input.turnCount === 3 && plannerAttempts > 0) {
        const wire = JSON.parse(body) as {
          model: string;
          tools?: { name: string }[];
          input?: { type: string; call_id?: string; output?: string; role?: string;
            content?: readonly { type?: string; text?: string }[] }[];
        };
        const invoke = (callId: string, name: string, args: unknown) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(frame([
            { type: 'response.created', response: { id: callId } },
            { type: 'response.output_item.done', output_index: 0, item: {
              type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } },
            { type: 'response.completed', response: { id: callId } },
          ]));
        };
        const resultFor = (callId: string) => wire.input?.find((item) =>
          item.type === 'function_call_output' && item.call_id === callId);
    const inspectionTurn = plannerAttempts;
        const childBody = inspectionTurn === 1 ? INSPECTION_TURN_TWO_BODY : INSPECTION_TURN_THREE_BODY;
        const childJudgment = inspectionTurn === 1
          ? INSPECTION_TURN_TWO_JUDGMENT : INSPECTION_TURN_THREE_JUDGMENT;
        if (wire.tools?.some((tool) => tool.name === 'humanagent_child_deliver')) {
          inspectionChildRequests.push({
            body,
            parentCallId: `call-inspection-parent-${inspectionTurn}`,
          });
          assert.equal(wire.model, 'child.only.model', 'inspection child selects its configured Provider model');
          const childPrompt = (wire.input ?? []).flatMap((item) =>
            (item.content ?? []).flatMap((part) => typeof part.text === 'string' ? [part.text] : [])).join('\n');
          for (const expected of [
            `Inspection check: ${INSPECTION_CHECK_A.checkId}`,
            `Inspection criterion: ${INSPECTION_CHECK_A.criterion}`,
            `Inspection input refs: ${INSPECTION_CHECK_A.inputRefs.join('; ')}`,
          ]) assert.ok(childPrompt.includes(expected), `the actual child request carries ${expected}`);
          assert.equal(childPrompt.includes(INSPECTION_CHECK_B.checkId), false,
            'the child receives only the selected inspection check');
          const deliveryId = `call-inspection-child-${inspectionTurn}-delivery`;
          const endId = `call-inspection-child-${inspectionTurn}-end`;
          const delivered = resultFor(deliveryId);
          if (!delivered) {
            invoke(deliveryId, 'humanagent_child_deliver', {
              body: childBody,
              inspectionOutcome: { status: 'completed', judgment: childJudgment },
            });
          } else {
            const deliveryEvidence = delivered.output!.split('\n')
              .find((line) => line.startsWith('- evidenceId=child-body-execution-'));
            const ref = deliveryEvidence === undefined ? undefined : /locator=([^\s]+)/.exec(deliveryEvidence)?.[1];
            if (!ref) throw new Error(`inspection child delivery result has no body asset: ${delivered.output}`);
            const section = { text: 'Inspection child work complete', evidenceRefs: [ref] };
            invoke(endId, 'humanagent_turn_end', { summary: {
              goal: section, actions: section, result: section, expectedNextStep: section }, deliveryRefs: [ref] });
          }
          return;
        }
        const parentCallId = `call-inspection-parent-${inspectionTurn}`;
        const parentAdoptId = `call-inspection-parent-${inspectionTurn}-adopt`;
        const called = resultFor(parentCallId);
        if (!called) {
          for (const name of ['child_call', 'child_adopt', 'child_not_select']) {
            assert.ok(wire.tools?.some((tool) => tool.name === name), `default composition advertises ${name}`);
          }
          invoke(parentCallId, 'child_call', {
            purpose: `Execute inspection ${INSPECTION_CHECK_A.checkId}`,
            instructions: `Measure ${INSPECTION_CHECK_A.checkId} and report its complete body and inspection outcome.`,
            successCriteria: [INSPECTION_CHECK_A.criterion],
            target: 'artifact://native-inspection/target',
            agentId: 'orchestration-default',
            kind: 'execution',
            checkId: INSPECTION_CHECK_A.checkId,
          });
          return;
        }
        const refined = JSON.parse(called.output!.split('\n[HumanAgent evidence refs]')[0]!) as {
          state?: string;
          invocationId?: string;
          summary?: string;
        };
        assert.equal(refined.state, 'returned', `real inspection producer returns the child: ${called.output}`);
        assert.equal(refined.summary, childBody, 'the inspection child returns its full body');
        const invocationId = refined.invocationId;
        if (typeof invocationId !== 'string' || invocationId.length === 0) {
          throw new Error(`the inspection producer returns no actual child invocation id: ${called.output}`);
        }
        inspectionInvocations.set(parentCallId, invocationId);
        if (!resultFor(parentAdoptId)) {
          invoke(parentAdoptId, 'child_adopt', { invocationId });
          return;
        }
        if (input.holdInspectionAfterAdoptOnce !== undefined
          && plannerAttempts === 1 && !inspectionAdoptHeld) {
          inspectionAdoptHeld = true;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(': inspected child adopted before parent standard end\n\n');
          await input.holdInspectionAfterAdoptOnce();
          response.end();
          return;
        }
      }
      if (input.reviewPerCycle) {
        const cycle = plannerAttempts + 1;
        const wire = JSON.parse(body) as { model: string; tools?: { name: string }[];
          input?: { type: string; call_id?: string; output?: string }[] };
        const resultFor = (callId: string) => wire.input?.find((item) => item.type === 'function_call_output' && item.call_id === callId);
        const invoke = (callId: string, name: string, args: unknown) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(frame([
            { type: 'response.created', response: { id: callId } },
            { type: 'response.output_item.done', output_index: 0, item: {
              type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } },
            { type: 'response.completed', response: { id: callId } },
          ]));
        };
        const executionBody = cycle === 1 ? CHILD_BODY : TURN_TWO_DELIVERY;
        if (wire.tools?.some((tool) => tool.name === 'humanagent_child_deliver')) {
          const review = wire.model === 'review.only.model';
          assert.equal(wire.model, review ? 'review.only.model' : 'child.only.model');
          assert.equal(body.includes('text-only delivery probe'), false, 'child context excludes parent transcript');
          if (review) assert.ok(body.includes(executionBody), 'review receives complete execution subject');
          if (review && !resultFor(`cycle-${cycle}-review-read`)) {
            invoke(`cycle-${cycle}-review-read`, 'file_read', { path: 'review-evidence.txt' });
            return;
          }
          const delivered = resultFor(`cycle-${cycle}-child-delivery`);
          if (!delivered) {
            const ref = /evidenceId=([^\s]+)/.exec(resultFor(`cycle-${cycle}-review-read`)?.output ?? '')?.[1];
            invoke(`cycle-${cycle}-child-delivery`, 'humanagent_child_deliver', {
              body: review ? `Cycle ${cycle} independent quality review` : executionBody,
              ...(review ? { judgment: 'passed', findings: [{ detail: `Cycle ${cycle} delivery verified`,
                severity: 'advisory', evidenceRefs: input.badReviewSelector && cycle === 1
                  ? ['x'.repeat(257)] : ref === undefined ? [] : [ref] }] } : {}),
            });
          } else {
            const deliveryEvidence = delivered.output!.split('\n')
              .find((line) => line.startsWith(`- evidenceId=child-body-${review ? 'review' : 'execution'}-`));
            const ref = /locator=([^\s]+)/.exec(deliveryEvidence ?? '')?.[1];
            assert.ok(ref, 'child delivery returns real evidence');
            const section = { text: `Cycle ${cycle} child complete`, evidenceRefs: [ref] };
            invoke(`cycle-${cycle}-child-end`, 'humanagent_turn_end', { summary: {
              goal: section, actions: section, result: section, expectedNextStep: section }, deliveryRefs: [ref] });
          }
          return;
        }
        const execCall = `cycle-${cycle}-execution`;
        const reviewCall = `cycle-${cycle}-review`;
        const execution = resultFor(execCall);
        if (!execution) {
          invoke(execCall, 'child_call', { kind: 'execution', agentId: 'orchestration-default',
            purpose: `Cycle ${cycle} execution`, instructions: 'Publish the complete execution result and end the child turn.',
            target: `Cycle ${cycle} delivery`, successCriteria: ['Return complete delivery'] });
          return;
        }
        const refined = (output: string) => requireRecord(JSON.parse(output.split('\n[HumanAgent evidence refs]')[0]!), 'returned child');
        const executed = refined(execution.output!);
        assert.equal(executed.state, 'returned');
        assert.equal(executed.summary, executionBody);
        const reviewed = resultFor(reviewCall);
        if (!reviewed) {
          invoke(reviewCall, 'child_call', { kind: 'review', agentId: 'cycle-review',
            subjectInvocationId: executed.invocationId, reviewKind: 'quality',
            purpose: `Cycle ${cycle} quality review`, instructions: 'Review the complete execution subject, publish judgment and findings, then end the child turn.',
            target: `Cycle ${cycle} delivery`, successCriteria: ['Verify complete delivery'] });
          return;
        }
        const review = refined(reviewed.output!);
        assert.equal(review.state, 'returned');
        for (const [kind, child] of [['execution', executed], ['review', review]] as const) {
          if (!resultFor(`cycle-${cycle}-adopt-${kind}`)) {
            invoke(`cycle-${cycle}-adopt-${kind}`, 'child_adopt', { invocationId: child.invocationId });
            return;
          }
        }
      }
      if (!input.reviewPerCycle && (input.child || input.parallelChild) && !(input.turnCount !== undefined && plannerAttempts > 0)) {
        const wire = JSON.parse(body) as { model: string; tools?: { name: string }[];
          input?: { type: string; call_id?: string; output?: string; name?: string }[] };
        const invoke = (callId: string, name: string, args: unknown) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(frame([
            { type: 'response.created', response: { id: callId } },
            { type: 'response.output_item.done', output_index: 0, item: {
              type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } },
            { type: 'response.completed', response: { id: callId } },
          ]));
        };
        const resultFor = (callId: string) => wire.input?.find((item) => item.type === 'function_call_output' && item.call_id === callId);
        if (wire.tools?.some((tool) => tool.name === 'humanagent_child_deliver')) {
          assert.equal(wire.model, 'child.only.model', 'child selects its configured Provider model');
          assert.equal(body.includes('text-only delivery probe'), false, 'child does not inherit parent request history');
          const records = (await input.journal.verify()).records;
          assert.ok(records.some((record) => record.kind === 'checkpoint'), 'pre-call checkpoint is committed before child Provider request');
          const parallelIndex = input.parallelChild && body.includes('Independent child result b') ? 1 : 0;
          const deliveryId = input.parallelChild ? `call-child-${parallelIndex}-delivery` : 'call-child-delivery';
          const endId = input.parallelChild ? `call-child-${parallelIndex}-end` : 'call-child-end';
          const bodyText = input.parallelChild ? `parallel child ${parallelIndex} result` : CHILD_BODY;
          const delivered = resultFor(deliveryId);
          if (input.parallelChild && !delivered) {
            if (parallelIndex === 0) {
              childAEntered.resolve();
              try {
                await withDeadline(childBEntered.promise, 2_000);
                overlap = true;
                await withDeadline(finishChildB.promise, 10_000);
                reversedCompletion = true;
              } catch { /* The consumer assertion reports serial execution after actual settle. */ }
            } else {
              childBEntered.resolve();
              await withDeadline(childAEntered.promise, 2_000);
            }
          }
          if (!delivered) {
            invoke(deliveryId, 'humanagent_child_deliver', { body: bodyText });
          } else {
            const deliveryEvidence = delivered.output!.split('\n')
              .find((line) => line.startsWith('- evidenceId=child-body-execution-'));
            const ref = deliveryEvidence === undefined ? undefined : /locator=([^\s]+)/.exec(deliveryEvidence)?.[1];
            if (!ref) {
              console.error('child delivery result has no body asset', delivered.output);
              throw new Error(`child delivery result has no asset: ${delivered.output}`);
            }
            const section = { text: 'Child work complete', evidenceRefs: [ref] };
            invoke(endId, 'humanagent_turn_end', { summary: {
              goal: section, actions: section, result: section, expectedNextStep: section }, deliveryRefs: [ref] });
          }
          return;
        }
        if (input.parallelChild) {
          const calledA = resultFor('call-parent-child-a');
          const calledB = resultFor('call-parent-child-b');
          if (!calledA || !calledB) {
            for (const name of ['child_call', 'child_adopt', 'child_not_select']) {
              assert.ok(wire.tools?.some((tool) => tool.name === name), `default composition advertises ${name}`);
            }
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(frame([
              { type: 'response.created', response: { id: 'parallel-child-calls' } },
              ...['a', 'b'].map((suffix, outputIndex) => ({ type: 'response.output_item.done', output_index: outputIndex, item: {
                type: 'function_call', call_id: `call-parent-child-${suffix}`, name: 'child_call',
                arguments: JSON.stringify({ purpose: `Produce independent result ${suffix}`,
                  instructions: 'Independently produce the complete child result, publish it with humanagent_child_deliver, and finish the child turn.',
                  target: `Independent child result ${suffix}`, agentId: 'orchestration-default', kind: 'execution',
                  successCriteria: ['Return the complete result'] }),
              } })),
              { type: 'response.completed', response: { id: 'parallel-child-calls' } },
            ]));
            return;
          }
          const refined = [calledA, calledB].map((called) => JSON.parse(
            called!.output!.split('\n[HumanAgent evidence refs]')[0]!,
          ) as { state?: string; invocationId?: string; summary?: string });
          assert.deepEqual(refined.map((entry) => entry.state), ['returned', 'returned']);
          assert.equal(refined[0]?.invocationId === refined[1]?.invocationId, false,
            'two child calls have distinct invocation identities');
          assert.deepEqual(refined.map((entry) => entry.summary), ['parallel child 0 result', 'parallel child 1 result']);
          if (!resultFor('call-parent-adopt-a')) {
            invoke('call-parent-adopt-a', 'child_adopt', { invocationId: refined[0]!.invocationId });
            return;
          }
          if (!resultFor('call-parent-adopt-b')) {
            invoke('call-parent-adopt-b', 'child_adopt', { invocationId: refined[1]!.invocationId });
            return;
          }
        } else {
          const called = resultFor('call-parent-child');
          if (!called) {
            for (const name of ['child_call', 'child_adopt', 'child_not_select']) {
              assert.ok(wire.tools?.some((tool) => tool.name === name), `default composition advertises ${name}`);
            }
            invoke('call-parent-child', 'child_call', { purpose: 'Produce an independent result',
              instructions: 'Independently produce the complete child result, publish it with humanagent_child_deliver, and finish the child turn with evidence for the parent to adopt.',
              target: 'Independent child result for the parent to adopt',
              agentId: 'orchestration-default', kind: 'execution', successCriteria: ['Return the complete result'] });
            return;
          }
          const refined = JSON.parse(called.output!.split('\n[HumanAgent evidence refs]')[0]!) as {
            state?: string; invocationId?: string; summary?: string };
          assert.equal(refined.state, 'returned', `real producer returns the child: ${called.output}`);
          assert.equal(refined.summary, CHILD_BODY);
          if (!resultFor('call-parent-adopt')) {
            invoke('call-parent-adopt', 'child_adopt', { invocationId: refined.invocationId });
            return;
          }
        }
      }
      const inspectThisTurn = input.inspect
        && (input.turnCount === undefined || plannerAttempts === 0);
      if (inspectThisTurn && !readIssued) {
        readIssued = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frame([
          { type: 'response.created', response: { id: 'inspect-read' } },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call',
            call_id: 'call-inspect-read', name: 'file_read', arguments: JSON.stringify({ path: 'read-delivery.txt' }) } },
          { type: 'response.completed', response: { id: 'inspect-read' } },
        ]));
        return;
      }
      const verified = await input.journal.verify();
      const coverageRecords = verified.records
        .filter((record) => record.payload?.['kind'] === 'operation-control-coverage/v1');
      const coverage = input.turnCount === undefined ? coverageRecords[0] : coverageRecords.at(-1);
      const payload = coverage?.payload as { admissionCommitRef?: { commitId?: string } } | undefined;
      const admissionCommitId = payload?.admissionCommitRef?.commitId;
      if (!admissionCommitId) throw new Error('text-only run has no admitted operation coverage');
      const section = (text: string) => ({ text, evidenceRefs: [admissionCommitId] });
      const activeEntries = inspectThisTurn ? await createJsonlActiveTurnJournal({ filePath: input.organFilePath,
        journal: input.journal, turnId: newActiveTurnId(coverage!.scope.operationId!.value) }).replay() : [];
      const readFact = activeEntries.find((entry) => entry.kind === 'accepted-fact'
        && entry.entry.envelope.fact.kind === 'tool-result' && entry.entry.envelope.fact.callId === 'call-inspect-read');
      if (inspectThisTurn && (readFact?.kind !== 'accepted-fact'
        || readFact.entry.envelope.fact.kind !== 'tool-result'
        || readFact.entry.envelope.fact.result.status !== 'succeeded')) throw new Error('real inspect result is absent');
      if (readFact?.kind === 'accepted-fact' && readFact.entry.envelope.fact.kind === 'tool-result') {
        assert.deepEqual(readFact.entry.envelope.scope, coverage!.scope);
        assert.deepEqual(readFact.entry.envelope.fact.rawOutput.ref.scope, coverage!.scope);
      }
      const deliveryRefs = readFact?.kind === 'accepted-fact' && readFact.entry.envelope.fact.kind === 'tool-result'
        ? [readFact.entry.envelope.fact.rawOutput.ref.locator] : [];
      const multiTurn = input.turnCount !== undefined;
      const endCallId = multiTurn ? `call-turn-${plannerAttempts + 1}-end` : 'call-text-end';
      const endSummary = multiTurn ? (plannerAttempts === 0 ? {
        goal: section(TURN_ONE_GOAL), actions: section(TURN_ONE_ACTIONS),
        result: inspectThisTurn
          ? { text: `${TURN_ONE_RESULT}; Inspected read-delivery.txt completely: two UTF-8 lines; read-only, no mutation performed`,
            evidenceRefs: [admissionCommitId, ...deliveryRefs] }
          : section(TURN_ONE_RESULT),
        expectedNextStep: section(TURN_ONE_NEXT),
      } : (input.turnCount === 3 || input.reviewPerCycle) && plannerAttempts === 1 ? {
        goal: section(TURN_TWO_GOAL), actions: section(TURN_TWO_ACTIONS),
        result: section(TURN_TWO_RESULT), expectedNextStep: section(TURN_TWO_NEXT),
      } : input.turnCount === 3 && plannerAttempts === 2 ? {
        goal: section('Complete the third standard turn from committed multi-turn semantic history'),
        actions: section('Consume both prior semantic checkpoints and close the third turn'),
        result: section(SUMMARY_RESULT), expectedNextStep: section('Close the final third turn'),
      } : {
        goal: section(TURN_ONE_GOAL), actions: section(TURN_ONE_ACTIONS),
        result: section(TURN_ONE_RESULT), expectedNextStep: section(TURN_ONE_NEXT),
      }) : {
        goal: section('Deliver the exact text body'), actions: section('End the pure-text turn'),
        result: section(SUMMARY_RESULT), expectedNextStep: section('Close this turn'),
      };
      const summaryWithInspection = input.inspection && multiTurn && plannerAttempts > 0
        ? {
            ...endSummary,
            inspectionOutcome: {
              status: 'completed' as const,
              judgment: plannerAttempts === 1
                ? INSPECTION_TURN_TWO_PARENT_JUDGMENT : INSPECTION_TURN_THREE_PARENT_JUDGMENT,
            },
          }
        : endSummary;
      const deliveryText = multiTurn ? (plannerAttempts === 0 ? CHILD_BODY
        : input.turnCount === 3 && plannerAttempts === 1 ? TURN_TWO_DELIVERY : EXACT_BODY) : EXACT_BODY;
      const toolCall = [
        { type: 'response.created', response: { id: 'text-end' } },
        { type: 'response.output_item.added', output_index: 0,
          item: { type: 'function_call', call_id: endCallId, name: 'humanagent_turn_end', arguments: '' } },
        { type: 'response.output_item.done', output_index: 0,
          item: { type: 'function_call', call_id: endCallId, name: 'humanagent_turn_end', arguments: JSON.stringify({
            summary: summaryWithInspection,
            ...(inspectThisTurn ? {} : { deliveryText }),
            deliveryRefs,
          }) } },
        { type: 'response.completed', response: { id: 'text-end' } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frame(toolCall));
    })().catch((error: unknown) => {
      if (input.reviewPerCycle) console.error('two-cycle upstream fixture error', error);
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing text-only upstream socket address');
  return {
    wires,
    overlapped: () => overlap,
    completedInReverse: () => reversedCompletion,
    interruptedThirdTurn: () => thirdTurnInterrupted,
    turnThreeHeld: () => holdTurnThree,
    inspectionInvocations: () => [...inspectionInvocations.entries()].map(([callId, invocationId]) => ({
      callId, invocationId,
    })),
    inspectionChildRequests: () => inspectionChildRequests.map((entry) => ({ ...entry })),
    explicitHelperPhase: () => explicitHelperPhase,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

/** Canonical fixture: real workspace, real native control layout, controlled Provider. */
async function textOnlyFixture(
  inspect = false,
  child = false,
  parallelChild = false,
  turnCount?: 2 | 3,
  topLevelHttp?: { readonly credentialRef: string; readonly requiredBearer: string },
  interruptThirdTurnOnce?: () => Promise<void>,
  holdFirstExecutionOnce?: () => Promise<void>,
  inspection = false,
  holdInspectionAfterAdoptOnce?: () => Promise<void>,
  reviewPerCycle = false,
  badReviewSelector = false,
  scenario?: TextOnlyFixtureScenario,
) {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, 'text-only-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  if (inspect) await writeFile(join(workspace, 'read-delivery.txt'), EXACT_BODY, 'utf8');
  if (reviewPerCycle) await writeFile(join(workspace, 'review-evidence.txt'), `${CHILD_BODY}\n${TURN_TWO_DELIVERY}`, 'utf8');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const layout = nativeRuntimeLayout(paths);
  await mkdir(layout.modeRoot, { recursive: true });
  const journal = new JsonlOrganJournal(layout.organJournalPath);
  const upstream = await textOnlyResponsesUpstream({ model: 'text.only.model',
    organFilePath: layout.organJournalPath, journal, inspect, child, parallelChild, inspection, turnCount, reviewPerCycle, badReviewSelector,
    interactionScopeId: `runtime:${paths.projectKey}`,
    ...(scenario === undefined ? {} : { scenario }),
    ...(interruptThirdTurnOnce === undefined ? {} : { interruptThirdTurnOnce }),
    ...(holdFirstExecutionOnce === undefined ? {} : { holdFirstExecutionOnce }),
    ...(holdInspectionAfterAdoptOnce === undefined ? {} : { holdInspectionAfterAdoptOnce }),
    ...(topLevelHttp === undefined ? {} : {
      requiredBearer: topLevelHttp.requiredBearer,
    }) });
  const configPath = join(controlRoot, 'config.toml');
  // Both the default execution agent and the independent orchestration agent
  // select this real local Provider through the normal compiled roster.
  const providerBlock = [
    'driverRef = "rcc"',
    'provider.provider = "rcc"',
    'provider.binding = "text-only-binding"',
    'provider.protocol = "responses"',
    'provider.model = "text.only.model"',
    'provider.route = "text-only-route"',
    `provider.baseUrl = "${upstream.baseUrl}"`,
  ].join('\n');
  const original = await readFile(configPath, 'utf8');
  const config = topLevelHttp === undefined ? (scenario?.kind === 'explicit-helper'
    ? original.replace('driverRef = "fake"', providerBlock)
      .replace('driverRef = "fake"', providerBlock.replace('text.only.model', 'child.only.model'))
      .replace('maxConcurrentTasks = 1', 'maxConcurrentTasks = 2')
    : child ? original.replace('driverRef = "fake"', providerBlock)
    .replace('driverRef = "fake"', providerBlock.replace('text.only.model', 'child.only.model'))
    .replace('maxConcurrentTasks = 1', 'maxConcurrentTasks = 2')
    : original.replaceAll('driverRef = "fake"', providerBlock))
      .replace('model = "MiniMax-M3"', 'model = "text.only.model"')
      .replace('baseUrl = "http://127.0.0.1:4444"', `baseUrl = "${upstream.baseUrl}"`)
    : original
      .replace('provider = "rcc"', 'provider = "rcc"\nsource = "http"\n'
        + `credentialRef = "${topLevelHttp.credentialRef}"`)
      .replace('binding = "rcc-entry"', 'binding = "default-http-binding"')
      .replace('model = "MiniMax-M3"', 'model = "text.only.model"')
      .replace('route = "default"', 'route = "default-http-route"')
      .replace('baseUrl = "http://127.0.0.1:4444"', `baseUrl = "${upstream.baseUrl}"`)
      .replaceAll('driverRef = "fake"', 'driverRef = "rcc"');
  const reviewConfig = reviewPerCycle ? `${config}\n[[agents]]\nagentId = "cycle-review"\nroleId = "review"\ntemplateRef = "builtin/review@1.0.0"\nskills = []\ntools = []\npermissions = []\nmemoryScopes = ["task"]\nresourceClass = "background"\n${providerBlock.replace('text.only.model', 'review.only.model')}\n` : config;
  await writeFile(configPath, reviewConfig, 'utf8');
  const configuration = await loadConfiguration(paths);
  if (topLevelHttp === undefined && !reviewPerCycle) {
    const bindings = configuration.agentProviderBindings;
    assert.deepEqual(bindings.map((binding) => [binding.agentId, binding.roleId, binding.provider?.model]), [
      ['interaction-default', 'interaction', 'text.only.model'],
      ['orchestration-default', 'orchestration', child ? 'child.only.model' : 'text.only.model'],
    ], 'the fixture must preserve both explicit agent roles and models');
    assert.equal(bindings.some((binding) => binding.roleId === 'review'), false,
      'the fixture must retain the production legacy fallback for review');
    assert.equal(configuration.effective.provider?.model, 'text.only.model');
    assert.equal(configuration.effective.provider?.baseUrl, upstream.baseUrl,
      'the legacy review Provider must resolve to the local upstream');
  }
  return { root, controlRoot, workspace, paths, layout, journal, upstream, configuration, configPath };
}

async function prepareNativeMultiTurnConsumer(
  fixture: Awaited<ReturnType<typeof textOnlyFixture>>,
  turnCount: 2 | 3,
  inspection = false,
) {
  const organId = id('organ', 'humanagent-ui');
  const label = turnCount === 2 ? 'two-turn' : 'three-turn';
  const taskId = id('task', `native-${label}-consumer`);
  const controlFile = join(fixture.root, 'control-session.txt');
  const access = await AccessControlService.open({ credentialPath: fixture.paths.webAccessCredentialPath, create: true });
  const challenge = await access.issuePairingChallenge();
  const session = await access.consumePairingCode(challenge.code);
  const cookie = access.sessionCookie(session).split(';')[0]!;
  await writeFile(controlFile, `${cookie}\n`, 'utf8');
  const caller = await access.verifyProductPrincipal(cookie);
  if (caller.state !== 'valid') throw new Error('fixture caller principal unavailable');

  const seed = new RuntimeTaskCoordinator({
    organId, taskIdPrefix: `native-${label}`, journal: new UiRuntimeJournal(fixture.layout.preparedJournalPath),
    checkpointStoreFor: () => new FileCheckpointStore(join(fixture.layout.modeRoot, 'seed-checkpoint.jsonl')),
    attentionPort: {
      async publish(value) { return { attentionId: value.attentionId, delivered: true }; },
      async resolve(value) { return { attentionId: value.attentionId, delivered: true }; },
    },
    async createDriver() { throw new Error('seed coordinator never releases execution'); },
  });
  seed.createTask({ taskId, title: `native ${label} task`, directive: `complete the ${label} delivery`,
    ...(inspection ? { taskFlow: { kind: 'inspection' as const, definitionVersion: 1 } } : {}) });
  await new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal)).establish({
    scope: { organId, taskId }, source: {
      requirementId: `requirement:${taskId.value}`, inputRevision: 1, draftId: `draft:${taskId.value}`,
      draftRevisionVersion: 1, draftRevisionHash: `draft-hash:${taskId.value}`,
      confirmationRef: `confirmation:${taskId.value}`,
    },
    ...(inspection ? { taskFlow: { kind: 'inspection' as const, definitionVersion: 1 } } : {}),
  });
  await new JsonlTaskGrantJournal(fixture.journal).grant({ requestId: `grant:${taskId.value}`, taskId,
    owner: caller.principal.owner,
    capability: { actionId: 'task.execute', capabilities: ['provider.execution'], scope: { organId, taskId } },
    expectedRevision: 0 });
  return { organId, taskId, cookie, controlFile };
}

async function startNativeMultiTurnConsumer(
  fixture: Awaited<ReturnType<typeof textOnlyFixture>>,
  turnCount: 2 | 3,
  inspection = false,
) {
  const cli = consumerCliEntry();
  const label = turnCount === 2 ? 'two-turn' : 'three-turn';
  const prepared = await prepareNativeMultiTurnConsumer(fixture, turnCount, inspection);
  const { taskId, cookie, controlFile } = prepared;
  const processChild = spawn(process.execPath, [cli,
    'run', '--workspace', fixture.workspace, '--control-root', fixture.controlRoot,
    '--plan', 'default', '--session', `native-${label}-run`, '--task', taskId.value,
    '--prompt', `${label} delivery probe`, '--control-session-file', controlFile],
  { cwd: fixture.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  processChild.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
  processChild.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
  const result = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      processChild.once('error', reject);
      processChild.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    },
  );
  return { taskId, result, cookie, child: processChild };
}

async function runNativeMultiTurnConsumer(
  fixture: Awaited<ReturnType<typeof textOnlyFixture>>,
  turnCount: 2 | 3,
  inspection = false,
) {
  const started = await startNativeMultiTurnConsumer(fixture, turnCount, inspection);
  return { taskId: started.taskId, result: await started.result, cookie: started.cookie };
}

interface PublicOutputCommitView {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
  readonly text: string;
}

interface PublicOutputPublicationView {
  readonly state?: string;
  readonly commits?: readonly PublicOutputCommitView[];
  readonly publicCommitWatermark?: number;
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  message: string,
  milliseconds = 15_000,
): Promise<T> {
  const deadline = Date.now() + milliseconds;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${message}: ${JSON.stringify(latest)}`);
}

function coldConsumerArgument(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`cold consumer requires ${label}`);
  return value;
}

type SeedResult = Awaited<Awaited<ReturnType<typeof startNativeMultiTurnConsumer>>['result']>;

async function readHeldThirdTurn(input: {
  readonly fixture: Awaited<ReturnType<typeof textOnlyFixture>>;
  readonly taskId: TaskId;
  readonly heldWireIndex: () => number;
}) {
  const { fixture, taskId } = input;
  const taskScope = { organId: id('organ', 'humanagent-ui'), taskId };
  const heldWireIndex = await waitFor(
    async () => input.heldWireIndex(),
    (value) => value >= 0,
    'the upstream did not hold the interrupted third-turn request',
  );
  const heldWire = fixture.upstream.wires[heldWireIndex];
  if (heldWire === undefined || heldWire.method !== 'POST' || plannerPayload(heldWire.body) !== undefined
    || !hasTurnEndSurface(heldWire.body)) {
    throw new Error(`the held wire ${heldWireIndex} is not a parent execution request`);
  }
  assert.equal(fixture.upstream.interruptedThirdTurn(), true,
    'the upstream interruption must complete before selecting the held business turn');
  const priorDuties = await waitFor(
    () => createJsonlClosedTurnPlannerCallJournal({ journal: fixture.journal }).readTaskDuties(taskScope),
    (duties) => duties.filter((duty) => duty.returned?.record.decision === 'continue').length === 2,
    'the two prior logical parent turns did not complete',
  );
  const completedDuties = priorDuties.filter((duty) => duty.returned?.record.decision === 'continue');
  const completedOperationIds = new Set(completedDuties.map((duty) => {
    const operationId = duty.returned!.record.duty.scope.operationId;
    if (operationId === undefined) throw new Error('a completing Planner duty has no operation scope');
    return operationId.value;
  }));
  const priorTurnBoundary = Math.max(...completedDuties.map((duty) => duty.returned!.commitRef.journalSeq));
  const configuredAgentId = fixture.configuration.effective.project?.defaultAgent
    ?? fixture.configuration.agentRoster[0]!.agentId;
  const configuredAgent = fixture.configuration.agentRoster.find((agent) => agent.agentId === configuredAgentId);
  if (configuredAgent === undefined) throw new Error(`no configured agent matches the selected default ${configuredAgentId}`);
  const selected = await waitFor(
    async () => {
      const candidates = [...await listTaskActiveTurnBindings({ journal: fixture.journal, scope: taskScope })]
        .sort((left, right) => left.commitRef.journalSeq - right.commitRef.journalSeq)
        .filter((entry) => entry.binding.scope.operationId !== undefined
          && !completedOperationIds.has(entry.binding.scope.operationId.value)
          && entry.commitRef.journalSeq > priorTurnBoundary);
      for (const candidate of candidates.reverse()) {
        const operationId = candidate.binding.scope.operationId!;
        const allocation = new UiRuntimeJournal(fixture.layout.preparedJournalPath).replay()
          .find((record) => record.kind === 'operation.prepared'
            && record.allocation.taskId.value === taskId.value
            && record.allocation.operationId.value === operationId.value);
        if (allocation?.kind !== 'operation.prepared') continue;
        if (allocation.allocation.role !== configuredAgent.roleId
          || allocation.allocation.configuredAgentId !== configuredAgent.agentId) continue;
        const activeJournal = createJsonlActiveTurnJournal({
          filePath: fixture.layout.organJournalPath,
          journal: fixture.journal,
          turnId: candidate.binding.admittedTurn.turnId,
        });
        const dispatched = (await activeJournal.replay()).some((record) => record.kind === 'request'
          && record.record.phase === 'dispatched'
          && record.record.scope.operationId?.value === operationId.value);
        if (!dispatched) continue;
        const segmentJournal = createActiveTurnSegmentJournal({
          journalPath: fixture.layout.organJournalPath,
          assetRoot: join(fixture.paths.artifactsRoot, 'ui-provider-evidence'),
          completionJournal: new JsonlOperationCompletionJournal({ journal: fixture.journal }),
          businessTurnId: candidate.binding.admittedTurn.turnId,
        });
        const recovery = await segmentJournal.readSegmentRecoveryReceipt(candidate.binding.admittedTurn.turnId);
        if (recovery.status === 'initial-open') return { candidate, allocation, recovery };
      }
      return undefined;
    },
    (value) => value !== undefined,
    'the held business turn has no initial-open dispatched allocation',
  );
  if (selected === undefined) throw new Error('the held business turn is absent');
  const { candidate, allocation } = selected;
  const recovery = selected.recovery;
  if (recovery.status !== 'initial-open') throw new Error(`held turn recovery receipt is ${recovery.status}`);
  const bindings = [...await listTaskActiveTurnBindings({ journal: fixture.journal, scope: taskScope })]
    .sort((left, right) => left.commitRef.journalSeq - right.commitRef.journalSeq);
  const selectedBinding = candidate.binding;
  const businessTurnId = selectedBinding.admittedTurn.turnId;
  const operationId = selectedBinding.scope.operationId!;
  const activeJournal = createJsonlActiveTurnJournal({
    filePath: fixture.layout.organJournalPath,
    journal: fixture.journal,
    turnId: businessTurnId,
  });
  const dispatched = await activeJournal.replay();
  const dispatchedRecord = dispatched.find((record): record is Extract<ActiveTurnJournalRecord, { kind: 'request' }> =>
    record.kind === 'request'
      && record.record.phase === 'dispatched'
      && record.record.scope.operationId?.value === operationId.value);
  if (dispatchedRecord === undefined) throw new Error('the dispatched Provider request is absent');
  const current = await createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal }).read(taskScope);
  return {
    taskScope,
    bindings,
    binding: selectedBinding,
    businessTurnId,
    operationId,
    allocation: allocation.allocation,
    dispatched: dispatchedRecord.record,
    recovery,
    current,
  };
}

interface ColdConsumerReceipt {
  readonly pid: number;
  readonly parentPid: number;
  readonly status: number;
  readonly response: unknown;
  readonly task: {
    readonly state: string;
    readonly output: string;
    readonly operationId?: string;
    readonly executionEpoch?: number;
  };
  readonly allocation: {
    readonly operationId: string;
    readonly assignmentId: string;
    readonly inputRevision: number;
    readonly executionEpoch: number;
  };
  readonly binding: {
    readonly businessTurnId: string;
    readonly operationId?: string;
  };
  readonly successor: {
    readonly segmentId: string;
    readonly executionEpoch: number;
    readonly predecessor: {
      readonly kind: 'initial-open';
      readonly initialOpen: {
        readonly bindingCommitRef: JournalCommitView;
        readonly recordsThroughCommitRef: JournalCommitView;
      };
    };
    readonly assignmentId: string;
    readonly inputRevision: number;
  };
  readonly planner: {
    readonly dutyKey: string;
    readonly decision: string;
    readonly revisionId: string;
    readonly sequence: number;
  };
  readonly publicOutput: PublicOutputPublicationView;
}

interface JournalCommitView {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
}

async function runHeldColdConsumer(input: {
  readonly fixture: Awaited<ReturnType<typeof textOnlyFixture>>;
  readonly started: Awaited<ReturnType<typeof startNativeMultiTurnConsumer>>;
  readonly heldWireIndex: () => number;
}): Promise<{
  readonly seed: SeedResult;
  readonly receipt: ColdConsumerReceipt;
  readonly resumedPid: number;
  readonly interruption: Awaited<ReturnType<typeof readHeldThirdTurn>>;
  readonly resumedWireIndex: number;
  readonly acceptedEffectCount: number;
}> {
  const { fixture, started, heldWireIndex } = input;
  const seedPid = started.child.pid;
  if (seedPid === undefined) throw new Error('the seed CLI child has no exact PID');
  let seedSettled = false;
  try {
    const interruption = await readHeldThirdTurn({ fixture, taskId: started.taskId, heldWireIndex });
    const signalled = process.kill(seedPid, 'SIGTERM');
    assert.equal(signalled, true, `the exact seed PID ${seedPid} must accept SIGTERM`);
    const seed = await withDeadline(started.result, 30_000);
    seedSettled = true;
    assert.ok(seed.code !== 0 || seed.signal !== null,
      `the interrupted seed must not report clean completion: ${JSON.stringify(seed)}`);
    if (seed.signal !== null) assert.equal(seed.signal, 'SIGTERM');

    const priorTurnIds = new Set(interruption.bindings
      .filter((entry) => entry.binding.admittedTurn.turnId !== interruption.businessTurnId)
      .map((entry) => entry.binding.admittedTurn.turnId));
    const beforeRecords = (await fixture.journal.verify()).records;
    const acceptedEffectCount = beforeRecords.filter((record) => {
      const turnId = record.commitId?.startsWith('active-turn:')
        ? record.commitId.slice('active-turn:'.length).split(':')[0]
        : undefined;
      if (turnId === undefined || !priorTurnIds.has(turnId)) return false;
      const typed = record.payload?.['record'] as ActiveTurnJournalRecord | undefined;
      return typed?.kind === 'accepted-fact' || typed?.kind === 'child-invocation'
        || typed?.kind === 'child-delivery';
    }).length;
    const journalPrefix = await readFile(fixture.layout.organJournalPath);

    const resumed = spawn(process.execPath, [
      new URL(import.meta.url).pathname,
      '--cold-consumer',
      '--fixture-root', fixture.root,
      '--task-id', started.taskId.value,
      '--operation-id', interruption.operationId.value,
      '--workspace', fixture.workspace,
      '--control-root', fixture.controlRoot,
      '--cookie-file', join(fixture.root, 'control-session.txt'),
      '--ui-root', join(fixture.root, 'ui'),
    ], {
      cwd: fixture.workspace,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_OPTIONS')),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const resumedPid = resumed.pid;
    if (resumedPid === undefined) throw new Error('the cold consumer child has no exact PID');
    assert.ok(resumedPid !== process.pid);
    assert.ok(resumedPid !== seedPid);
    let stdout = '';
    let stderr = '';
    resumed.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
    resumed.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
    const exited = await withDeadline(new Promise<{
      readonly code: number | null;
      readonly signal: string | null;
    }>((resolve, reject) => {
      resumed.once('error', reject);
      resumed.once('exit', (code, signal) => resolve({ code, signal }));
    }), 180_000);
    assert.equal(exited.signal, null, stderr);
    assert.equal(exited.code, 0, stderr);
    const receiptLine = stdout.split('\n').find((line) => line.startsWith('COLD_CONSUMER_RECEIPT '));
    if (receiptLine === undefined) throw new Error(`the cold consumer child emitted no receipt: ${stderr}`);
    const receipt = JSON.parse(receiptLine.slice('COLD_CONSUMER_RECEIPT '.length)) as ColdConsumerReceipt;
    assert.equal(receipt.status, 202);
    assert.ok(receipt.pid !== process.pid, 'the serve helper is not the test process');
    assert.ok(receipt.pid !== seedPid, 'the serve helper is not the seed CLI process');
    assert.ok(receipt.pid !== resumedPid, 'the serve helper is not the cold test child');
    assert.equal(receipt.parentPid, process.pid, 'the cold test child retains its real parent PID');
    assert.equal(receipt.task.state, 'succeeded');
    assert.equal(receipt.task.output, EXACT_BODY);
    assert.equal(receipt.task.operationId, interruption.operationId.value);
    assert.equal(receipt.planner.decision, 'complete');
    assert.equal(receipt.successor.predecessor.kind, 'initial-open');
    assert.equal(receipt.successor.predecessor.initialOpen.recordsThroughCommitRef.commitId,
      interruption.recovery.anchor.recordsThroughCommitRef.commitId);
    assert.equal(receipt.successor.assignmentId, receipt.allocation.assignmentId);
    assert.equal(receipt.successor.inputRevision, receipt.allocation.inputRevision);
    assert.equal(receipt.allocation.assignmentId, interruption.allocation.assignmentId);
    assert.equal(receipt.allocation.inputRevision, interruption.allocation.inputRevision);
    assert.equal(receipt.allocation.executionEpoch, interruption.allocation.executionEpoch);
    assert.ok(receipt.successor.executionEpoch > receipt.allocation.executionEpoch);
    assert.equal(receipt.publicOutput.state, 'committed');
    assert.ok(receipt.publicOutput.commits?.some((commit) => commit.text === EXACT_BODY));

    const afterBytes = await readFile(fixture.layout.organJournalPath);
    assert.deepEqual(afterBytes.subarray(0, journalPrefix.length), journalPrefix,
      'the resume appends after the accepted durable prefix and never rewrites it');
    const afterRecords = (await fixture.journal.verify()).records;
    const afterAcceptedEffectCount = afterRecords.filter((record) => {
      const turnId = record.commitId?.startsWith('active-turn:')
        ? record.commitId.slice('active-turn:'.length).split(':')[0]
        : undefined;
      if (turnId === undefined || !priorTurnIds.has(turnId)) return false;
      const typed = record.payload?.['record'] as ActiveTurnJournalRecord | undefined;
      return typed?.kind === 'accepted-fact' || typed?.kind === 'child-invocation'
        || typed?.kind === 'child-delivery';
    }).length;
    assert.equal(afterAcceptedEffectCount, acceptedEffectCount,
      'the cold resume does not replay accepted prior-turn effects');

    const resumedWireIndex = fixture.upstream.wires.findIndex((wire, index) => index > heldWireIndex()
      && wire.method === 'POST'
      && plannerPayload(wire.body) === undefined
      && hasTurnEndSurface(wire.body));
    if (resumedWireIndex < 0) throw new Error('the resumed Turn 3 execution wire is absent');
    const resumedWire = fixture.upstream.wires[resumedWireIndex]!;
    const resumedContext = (parseResponsesWire(resumedWire.body)?.input ?? [])
      .flatMap((item) => (item.content ?? [])
        .flatMap((part) => typeof part.text === 'string' ? [part.text] : []))
      .join('\n');
    for (const expected of [TURN_ONE_GOAL, TURN_ONE_ACTIONS, TURN_ONE_RESULT, TURN_ONE_NEXT,
      CHILD_BODY, TURN_TWO_GOAL, TURN_TWO_ACTIONS, TURN_TWO_RESULT, TURN_TWO_NEXT]) {
      assert.ok(resumedContext.includes(expected), `the resumed third turn retains ${expected}`);
    }
    const checkpoints = (parseResponsesWire(resumedWire.body)?.input ?? []).flatMap((item, index) => {
      if (item.type !== 'message' || item.role !== 'assistant') return [];
      return (item.content ?? []).flatMap((part) => {
        if (part.type !== 'input_text' || typeof part.text !== 'string') return [];
        const checkpoint = JSON.parse(part.text) as unknown;
        if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) return [];
        return [{ checkpoint: checkpoint as Record<string, unknown>, index }];
      });
    });
    const checkpointFor = (goal: string) => {
      const matches = checkpoints.filter(({ checkpoint }) => checkpoint.goal === goal);
      assert.equal(matches.length, 1, `the resumed third turn has one checkpoint with goal ${goal}`);
      return matches[0]!;
    };
    const turnOneCheckpoint = checkpointFor(TURN_ONE_GOAL);
    const turnTwoCheckpoint = checkpointFor(TURN_TWO_GOAL);
    for (const [label, checkpoint] of [['Turn 1', turnOneCheckpoint], ['Turn 2', turnTwoCheckpoint]] as const) {
      for (const field of ['actions', 'adoptedChildren', 'goal', 'nextStep', 'result']) {
        assert.ok(Object.hasOwn(checkpoint.checkpoint, field),
          `the resumed ${label} checkpoint has the ${field} semantic field`);
      }
      assert.equal(typeof checkpoint.checkpoint.actions, 'string');
      assert.equal(typeof checkpoint.checkpoint.goal, 'string');
      assert.equal(typeof checkpoint.checkpoint.nextStep, 'string');
      assert.equal(typeof checkpoint.checkpoint.result, 'string');
      assert.ok(Array.isArray(checkpoint.checkpoint.adoptedChildren));
    }
    assert.ok(turnOneCheckpoint.index < turnTwoCheckpoint.index, 'the resumed Turn 1 checkpoint precedes Turn 2');
    const adoptedChildren = turnOneCheckpoint.checkpoint.adoptedChildren as unknown[];
    assert.equal(adoptedChildren.length, 1, 'the resumed Turn 1 checkpoint has one adopted child');
    const adoptedChild = adoptedChildren[0] as Record<string, unknown>;
    assert.equal(typeof adoptedChild, 'object');
    assert.ok(adoptedChild !== null);
    assert.equal(Array.isArray(adoptedChild), false);
    assert.equal(typeof adoptedChild.text, 'string');
    const refined = JSON.parse(adoptedChild.text as string) as Record<string, unknown>;
    assert.equal(refined.summary, CHILD_BODY, 'the Turn 1 adopted child retains its refined summary');
    assert.deepEqual(turnTwoCheckpoint.checkpoint.adoptedChildren, [],
      'the resumed Turn 2 checkpoint has no adopted child');
    for (const raw of [TURN_TWO_DELIVERY, 'call-parent-child', 'call-parent-adopt',
      'call-child-delivery', 'call-child-end', 'call-turn-1-end', 'call-turn-2-end']) {
      assert.equal(resumedWire.body.includes(raw), false,
        `the resumed third turn excludes ${raw}`);
    }
    await assertPriorSemanticCheckpointWire(fixture, resumedWire.body, started.taskId, TURN_ONE_GOAL);
    await assertPriorSemanticCheckpointWire(fixture, resumedWire.body, started.taskId, TURN_TWO_GOAL);
    return { seed, receipt, resumedPid, interruption, resumedWireIndex, acceptedEffectCount };
  } finally {
    if (!seedSettled && started.child.exitCode === null && started.child.signalCode === null) {
      try {
        process.kill(seedPid, 'SIGTERM');
      } catch {
        // The seed may have exited between the liveness read and this exact PID signal.
      }
      await withDeadline(started.result.catch(() => undefined), 30_000);
    }
  }
}

async function runColdConsumerChild(): Promise<void> {
  coldConsumerArgument(coldConsumerRoot, '--fixture-root');
  const task = coldConsumerArgument(coldConsumerTask, '--task-id');
  const operation = coldConsumerArgument(coldConsumerOperation, '--operation-id');
  const workspace = coldConsumerArgument(coldConsumerWorkspace, '--workspace');
  const controlRoot = coldConsumerArgument(coldConsumerControlRoot, '--control-root');
  const cookieFile = coldConsumerArgument(coldConsumerCookie, '--cookie-file');
  const configuredCli = process.env.HUMANAGENT_CONSUMER_CLI?.trim();
  const uiRoot = coldConsumerArgument(coldConsumerUiRoot, '--ui-root');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await mkdir(join(paths.journalRoot, 'ui-runtime'), { recursive: true });
  const modeRoot = join(paths.checkpointsRoot, 'ui-runtime', 'rcc');
  const controlJournalPath = join(modeRoot, 'task-control.jsonl');
  const journal = new JsonlOrganJournal(controlJournalPath);
  const preparedJournal = new UiRuntimeJournal(join(modeRoot, 'ui-runtime-journal.jsonl'));
  const cookie = (await readFile(cookieFile, 'utf8')).split('\n')[0]!.trim();
  if (cookie.length === 0) throw new Error('cold consumer cookie file is empty');
  const serve = await startServe({ controlRoot, workspace, uiRoot });
  const taskId = id('task', task);
  let receipt: ColdConsumerReceipt | undefined;
  try {
    assert.ok(serve.pid !== process.pid, 'serve is a new OS process, not the cold test child');
    assert.ok(serve.pid !== (process as unknown as { readonly ppid: number }).ppid,
      'serve is a child of the cold test child, not its parent');
    const lease = await readDaemonLease(paths);
    if (lease === undefined) throw new Error('the official cold-resume serve helper created no supervisor lease');
    assert.equal(lease.pid, serve.pid, 'the cold-resume serve lease belongs to the exact helper PID');
    assert.equal(lease.disposedAt, undefined, 'the cold-resume serve lease is active while the helper runs');
    if (configuredCli !== undefined && configuredCli.length > 0) {
      assert.equal(lease.startup?.launcherPath, await realpath(consumerCliEntry()),
        'the configured cold-resume launcher is the one in the lease');
      assert.equal(lease.startup?.source.entryPath,
        await realpath('/opt/homebrew/lib/node_modules/humanagent-cli/runtime/app/src/cli.js'),
        'the installed cold-resume lease starts from the installed source entry');
    }
    const response = await fetch(
      `${serve.origin}/api/tasks/${encodeURIComponent(task)}/resume`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ operationId: operation }),
      },
    );
    const responseBody = await response.json() as unknown;
    assert.equal(response.status, 202, JSON.stringify(responseBody));
    const taskScope = { organId: id('organ', 'humanagent-ui'), taskId };
    const taskFinal = await waitFor(
      async () => {
        const current = await fetch(
          `${serve.origin}/api/tasks/${encodeURIComponent(task)}/dashboard`,
          { headers: { cookie, accept: 'application/json' } },
        );
        const body = await current.json() as {
          readonly state?: string;
          readonly output?: string;
          readonly operationId?: string;
          readonly executionEpoch?: number;
          readonly publicOutput?: PublicOutputPublicationView;
        };
        assert.equal(current.status, 200, JSON.stringify(body));
        return body;
      },
      (dashboard) => dashboard.state === 'succeeded' && dashboard.publicOutput?.state === 'committed',
      'the resumed task did not reach its committed public outcome',
      60_000,
    );
    assert.equal(taskFinal.operationId, operation);
    const checkedResponse = await fetch(
      `${serve.origin}/api/tasks/${encodeURIComponent(task)}/dashboard`,
      { headers: { cookie, accept: 'application/json' } },
    );
    const checked = await checkedResponse.json() as {
      readonly output?: string;
      readonly publicOutput?: PublicOutputPublicationView;
    };
    assert.equal(checkedResponse.status, 200, JSON.stringify(checked));
    const publicOutput = checked.publicOutput;
    if (publicOutput === undefined) throw new Error('the resumed task has no public output');
    assert.ok(publicOutput?.commits?.some((commit) => commit.text === EXACT_BODY),
      `the resumed task did not deliver the exact body: ${JSON.stringify(publicOutput)}`);
    assert.equal(taskFinal.state, 'succeeded', 'the resumed dashboard reports task success');
    assert.equal(checked.output, EXACT_BODY, 'the resumed dashboard output is the exact delivery body');
    if (taskFinal.state !== 'succeeded' || checked.output === undefined) {
      throw new Error('the resumed dashboard has no successful task output');
    }
    const planner = await waitFor(
      () => createJsonlClosedTurnPlannerCallJournal({ journal }).readTaskDuties(taskScope),
      (duties) => duties.some((duty) => duty.returned?.record.decision === 'complete'),
      'the resumed task did not commit a completing Planner return',
      60_000,
    );
    const finalPlanner = planner.filter((duty) => duty.returned?.record.decision === 'complete').at(-1);
    if (finalPlanner?.returned === undefined) throw new Error('the completing Planner return is absent');
    const plannerReturn = finalPlanner.returned;
    const allocations = preparedJournal.replay()
      .filter((record) => record.kind === 'operation.prepared' && record.allocation.taskId.value === task);
    const allocation = allocations.find((record) => record.kind === 'operation.prepared'
      && record.allocation.operationId.value === operation);
    if (allocation?.kind !== 'operation.prepared') {
      throw new Error('the resumed operation has no retained prepared allocation');
    }
    const bindings = await listTaskActiveTurnBindings({ journal, scope: taskScope });
    const binding = bindings.find((entry) => entry.binding.scope.operationId?.value === operation);
    if (binding === undefined) throw new Error('the resumed operation has no active-turn binding');
    const segmentJournal = createActiveTurnSegmentJournal({
      journalPath: controlJournalPath,
      assetRoot: join(paths.artifactsRoot, 'ui-provider-evidence'),
      completionJournal: new JsonlOperationCompletionJournal({ journal }),
      businessTurnId: binding.binding.admittedTurn.turnId,
    });
    const segments = await segmentJournal.readSegments(binding.binding.admittedTurn.turnId);
    const successor = segments.at(-1);
    if (successor === undefined) throw new Error('the resumed operation committed no successor segment');
    const predecessor = successor.predecessor;
    if (predecessor.initialOpen === undefined) {
      throw new Error('the resumed operation predecessor was not anchored at initial-open');
    }
    const initialOpen = predecessor.initialOpen;
    assert.equal(successor.binding.scope.operationId?.value, operation,
      'the successor segment retains the retained operation identity');
    assert.equal(successor.binding.assignment.assignmentId, allocation.allocation.assignmentId,
      'the successor segment retains the retained assignment identity');
    assert.equal(successor.binding.assignment.inputRevision, allocation.allocation.inputRevision,
      'the successor segment retains the retained input revision');
    assert.ok(successor.binding.execution.executionEpoch > allocation.allocation.executionEpoch,
      'the successor epoch must exceed the interrupted allocation epoch');
    const publication = await new ServiceExecutionCheckpointStore(
      controlJournalPath,
      journal,
      () => new Date(),
    ).readPublicOutputs({
      scope: successor.binding.scope,
      executionEpoch: successor.binding.execution.executionEpoch,
    });
    assert.equal(publication.state, 'committed');
    assert.ok(publication.commits.some((commit) => commit.text === EXACT_BODY));
    receipt = {
      pid: serve.pid,
      parentPid: (process as unknown as { readonly ppid: number }).ppid,
      status: response.status,
      response: responseBody,
      task: {
        state: taskFinal.state,
        output: checked.output,
        operationId: taskFinal.operationId,
        executionEpoch: taskFinal.executionEpoch,
      },
      allocation: {
        operationId: allocation.allocation.operationId.value,
        assignmentId: allocation.allocation.assignmentId,
        inputRevision: allocation.allocation.inputRevision,
        executionEpoch: allocation.allocation.executionEpoch,
      },
      binding: {
        businessTurnId: binding.binding.admittedTurn.turnId,
        operationId: binding.binding.scope.operationId?.value,
      },
      successor: {
        segmentId: successor.segmentId,
        executionEpoch: successor.binding.execution.executionEpoch,
        predecessor: { kind: 'initial-open', initialOpen },
        assignmentId: successor.binding.assignment.assignmentId,
        inputRevision: successor.binding.assignment.inputRevision,
      },
      planner: {
        dutyKey: finalPlanner.dutyKey,
        decision: plannerReturn.record.decision,
        revisionId: plannerReturn.record.publication.revisionId,
        sequence: plannerReturn.record.publication.sequence,
      },
      publicOutput,
    };
  } finally {
    await serve.stop();
    const disposed = await waitFor(
      () => readDaemonLease(paths),
      (value) => value?.disposedAt !== undefined,
      'the cold-resume serve lease did not record disposal',
      30_000,
    );
    assert.equal(disposed?.pid, serve.pid, 'only the cold-resume helper lease is disposed');
  }
  if (receipt === undefined) throw new Error('the cold consumer produced no completed receipt');
  console.log(`COLD_CONSUMER_RECEIPT ${JSON.stringify(receipt)}`);
}

/**
 * The canonical public-output publication for the accepted native delivery,
 * read back through the exact store class the CLI and the public GET both bind:
 * the one canonical `task-control.jsonl` of this same fixture. A fresh store
 * instance makes this a real durable read, not the in-memory value the run
 * process already had.
 */
async function readCanonicalPublication(
  layout: { readonly organJournalPath: string },
  binding: { readonly scope: ScopeRef; readonly executionEpoch: number },
) {
  const store = new ServiceExecutionCheckpointStore(
    layout.organJournalPath,
    new JsonlOrganJournal(layout.organJournalPath),
    () => new Date(),
  );
  return store.readPublicOutputs(binding);
}

/**
 * Start the product's own compiled public `serve` entry against this same
 * fixture, so the served public GET reads the identical control root,
 * credential and task the settled native run produced. This is the existing
 * serve-entry lifecycle: the startup receipt is the child's own stdout, and
 * `stop` closes only this child through its own signal and exit, never another
 * listener.
 */
async function startServe(input: {
  readonly controlRoot: string;
  readonly workspace: string;
  readonly uiRoot?: string;
}): Promise<{ readonly origin: string; readonly pid: number; stop(): Promise<void> }> {
  const child = spawn(process.execPath, [
    consumerCliEntry(), 'serve',
    '--control-root', input.controlRoot,
    '--workspace', input.workspace,
    '--port', '0',
    ...(input.uiRoot === undefined ? [] : ['--ui-root', input.uiRoot]),
  ], { cwd: input.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  if (pid === undefined) throw new Error('serve child has no exact PID');
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
  const listenPort = await new Promise<number>((resolve, reject) => {
    child.stdout?.on('data', () => {
      // The startup banner is printed only after the real listener is bound.
      const match = /"listenPort":\s*(\d+)/.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`serve exited before startup (${String(code ?? signal)}): ${stderr}`));
    });
  });
  return {
    origin: `http://127.0.0.1:${listenPort}`,
    pid,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
      child.kill('SIGTERM');
      await exited;
    },
  };
}

async function fetchTaskForCaptureStop(origin: string, taskId: TaskId, cookie: string) {
  const response = await fetch(`${origin}/api/tasks/${encodeURIComponent(taskId.value)}/dashboard`,
    { headers: { cookie, accept: 'application/json' } });
  const body = await response.json() as { readonly state?: string;
    readonly error?: { readonly code?: string; readonly message?: string } };
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

if (!coldConsumerMode) test('public explicit taskless helper dispatch and owner acceptance use configured native providers', async () => {
  const fixture = await textOnlyFixture(
    false,
    true,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    false,
    false,
    { kind: 'explicit-helper', parentModel: 'text.only.model', childModel: 'child.only.model' },
  );
  let serve: Awaited<ReturnType<typeof startServe>> | undefined;
  let passed = false;
  try {
    const access = await AccessControlService.open({
      credentialPath: fixture.paths.webAccessCredentialPath,
      create: true,
    });
    const challenge = await access.issuePairingChallenge();
    const session = await access.consumePairingCode(challenge.code);
    const cookie = access.sessionCookie(session).split(';')[0]!;
    const caller = await access.verifyProductPrincipal(cookie);
    assert.equal(caller.state, 'valid', 'the fixture caller principal is valid');

    serve = await startServe({ controlRoot: fixture.controlRoot, workspace: fixture.workspace });
    const createdResponse = await fetch(`${serve.origin}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, accept: 'application/json' },
      body: JSON.stringify({
        channel: 'business',
        requestKind: 'new-task-preview',
        sourceRef: 'test:n3-public-helper',
        rawInput: EXPLICIT_HELPER_PARENT_MARKER,
      }),
    });
    const createdText = await createdResponse.text();
    assert.equal(createdResponse.status, 201, createdText);
    const created = requireRecord(JSON.parse(createdText), 'the public explicit input receipt');
    const interactionId = requireText(created.interactionId, 'the public explicit interaction ID');

    const interpretedResponse = await fetch(
      `${serve.origin}/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`,
      { method: 'POST', headers: { cookie, accept: 'application/json' } },
    );
    const interpretedText = await interpretedResponse.text();
    assert.equal(interpretedResponse.status, 200, interpretedText);
    const interpreted = requireRecord(JSON.parse(interpretedText), 'the public explicit interpretation');
    assert.equal(interpreted.state, 'answered');
    assert.equal(interpreted.reply, EXPLICIT_HELPER_REFINED_TEXT);
    assert.equal(fixture.upstream.explicitHelperPhase(), 'parent-answer');

    const organId = id('organ', 'humanagent-ui');
    const opened = await new JsonlInteractionParentTurnJournal(fixture.journal).readScopeOpenedTurns({
      organId,
      interactionScopeId: `runtime:${fixture.paths.projectKey}`,
    });
    const turn = opened.find((entry) => entry.fact.turn.interactionId === interactionId)?.fact.turn;
    if (turn === undefined) throw new Error('the public interaction owns no durable parent turn');

    const helperJournal = new JsonlInteractionHelperJournal(fixture.journal);
    const helpers = await helperJournal.readTurnHelpers(turn);
    assert.equal(helpers.length, 1, 'the public interaction dispatched exactly one helper');
    const helper = helpers[0]!;
    const dispatch = helper.readback.dispatchAccepted;
    const returned = helper.readback.returned;
    const ownerAccepted = helper.readback.ownerAccepted;
    const adoptedCheckpoint = helper.readback.adoptedCheckpoint;
    if (dispatch === null) throw new Error('the helper dispatch is not durable');
    if (returned === null) throw new Error('the actual child result is not durably returned');
    assert.equal(returned.fact.result.agentId, 'orchestration-default');
    assert.equal(returned.fact.result.summary, EXPLICIT_HELPER_CHILD_SUMMARY);
    if (ownerAccepted === null) throw new Error('the parent did not explicitly accept the returned helper result');
    assert.equal(ownerAccepted.fact.acceptanceRef, 'acceptance:n3-public-helper');
    assert.equal(ownerAccepted.fact.acceptedBy, 'humanagent.runtime.explicit-brain');
    if (adoptedCheckpoint === null) throw new Error('owner acceptance committed no adopted helper checkpoint');
    assert.equal(adoptedCheckpoint.checkpoint.phase, 'adopted');
    assert.equal(adoptedCheckpoint.checkpoint.description, EXPLICIT_HELPER_REFINED_TEXT);
    assert.equal(
      adoptedCheckpoint.checkpoint.recovery.dispatchAcceptedCommitId,
      dispatch.commit.commitId,
    );
    assert.equal(
      adoptedCheckpoint.checkpoint.recovery.returnedCommitId,
      returned.commit.commitId,
    );
    assert.equal(
      adoptedCheckpoint.checkpoint.recovery.ownerAcceptedCommitId,
      ownerAccepted.commit.commitId,
    );

    const evidenceRoot = join(fixture.paths.artifactsRoot, 'ui-provider-evidence');
    const rawContent = providerRawContentReader(
      filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot)),
    );
    const refinedBytes = await rawContent.read({
      scope: ownerAccepted.fact.refinedResult.ref.scope,
      content: ownerAccepted.fact.refinedResult,
    });
    assert.equal(new TextDecoder().decode(refinedBytes), EXPLICIT_HELPER_REFINED_TEXT);

    const semanticCheckpoint = await helperJournal.readSemanticCheckpointExact(turn);
    if (semanticCheckpoint === null) throw new Error('the answered turn committed no semantic checkpoint');
    assert.ok(semanticCheckpoint.checkpoint.claims.some((claim) =>
      claim.fact.includes(EXPLICIT_HELPER_REFINED_TEXT)),
    'the semantic checkpoint carries the owner-accepted refined result');
    assert.ok(semanticCheckpoint.checkpoint.semanticAssetRefs.some((ref) =>
      ref.locator === ownerAccepted.fact.refinedResult.ref.locator),
    'the semantic checkpoint references the durable refined asset');

    console.log('n3-public-helper-receipt', JSON.stringify({
      interactionId,
      helperCallId: helper.identity.helperCallId,
      dispatchCommitId: dispatch.commit.commitId,
      returnedCommitId: returned.commit.commitId,
      ownerAcceptedCommitId: ownerAccepted.commit.commitId,
      phase: fixture.upstream.explicitHelperPhase(),
      parentModel: 'text.only.model',
      childModel: 'child.only.model',
      returnedSummary: returned.fact.result.summary,
      refinedText: EXPLICIT_HELPER_REFINED_TEXT,
      answer: interpreted.reply,
    }));
    passed = true;
  } finally {
    try {
      await serve?.stop();
    } finally {
      try {
        await fixture.upstream.close();
      } finally {
        if (passed) await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }
});

// Stopping before a standard end must persist the actual turn cut, not a
// fabricated save intent or closure. Probability is unknown; the existing
// public serve/stop edge fails before the stopped checkpoint if this is absent.
// Cost is one held request in the existing local Responses fixture.
if (!coldConsumerMode) test('native public stop before accepted end captures the actual turn before the stopped checkpoint', async () => {
  const executionHeld = deferred();
  const releaseExecution = deferred();
  const fixture = await textOnlyFixture(false, false, false, undefined, undefined, undefined, async () => {
    executionHeld.resolve();
    await releaseExecution.promise;
  });
  let passed = false;
  try {
    const organId = id('organ', 'humanagent-ui');
    const taskId = id('task', 'native-capture-only-stop');
    const access = await AccessControlService.open({ credentialPath: fixture.paths.webAccessCredentialPath, create: true });
    const challenge = await access.issuePairingChallenge();
    const session = await access.consumePairingCode(challenge.code);
    const cookie = access.sessionCookie(session).split(';')[0]!;
    const caller = await access.verifyProductPrincipal(cookie);
    if (caller.state !== 'valid') throw new Error('fixture caller principal unavailable');

    const seed = new RuntimeTaskCoordinator({
      organId, taskIdPrefix: 'native-capture-only-stop', journal: new UiRuntimeJournal(fixture.layout.preparedJournalPath),
      checkpointStoreFor: () => new FileCheckpointStore(join(fixture.layout.modeRoot, 'seed-checkpoint.jsonl')),
      attentionPort: {
        async publish(value) { return { attentionId: value.attentionId, delivered: true }; },
        async resolve(value) { return { attentionId: value.attentionId, delivered: true }; },
      },
      async createDriver() { throw new Error('seed coordinator never releases execution'); },
    });
    seed.createTask({ taskId, title: 'capture-only stop', directive: 'stop before the standard turn end' });
    await new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal)).establish({
      scope: { organId, taskId }, source: {
        requirementId: `requirement:${taskId.value}`, inputRevision: 1, draftId: `draft:${taskId.value}`,
        draftRevisionVersion: 1, draftRevisionHash: `draft-hash:${taskId.value}`,
        confirmationRef: `confirmation:${taskId.value}`,
      },
    });
    await new JsonlTaskGrantJournal(fixture.journal).grant({ requestId: `grant:${taskId.value}`, taskId,
      owner: caller.principal.owner,
      capability: { actionId: 'task.execute', capabilities: ['provider.execution'], scope: { organId, taskId } },
      expectedRevision: 0 });

    const serve = await startServe({ controlRoot: fixture.controlRoot, workspace: fixture.workspace });
    try {
      const startedResponse = await fetch(`${serve.origin}/api/tasks/${encodeURIComponent(taskId.value)}/executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ mode: 'rcc', prompt: 'capture the stopped turn' }),
      });
      const started = await startedResponse.json() as { readonly operationId?: string; readonly executionEpoch?: number };
      assert.equal(startedResponse.status, 202, JSON.stringify(started));
      const operationId = started.operationId;
      if (operationId === undefined) throw new Error('the public start has no operation identity');
      await withDeadline(executionHeld.promise, 15_000);

      const stopResponse = await withDeadline(fetch(`${serve.origin}/api/tasks/${encodeURIComponent(taskId.value)}/stop`, {
        method: 'POST', headers: { cookie },
      }), 30_000);
      const stopped = await stopResponse.json() as { readonly state?: string; readonly operationId?: string };
      assert.equal(stopResponse.status, 202, JSON.stringify(stopped));
      let taskAfterStop = await fetchTaskForCaptureStop(serve.origin, taskId, cookie);
      if (stopped.state !== 'stopped') {
        taskAfterStop = await waitFor(
          () => fetchTaskForCaptureStop(serve.origin, taskId, cookie),
          (task) => task.state !== 'settling',
          'the stop remained settling without a terminal stop result',
          5_000,
        ).catch(() => taskAfterStop);
      }
      assert.deepEqual(stopped, { state: 'stopped', operationId },
        `the stop error was ${JSON.stringify(taskAfterStop.error)}`);

      const stoppedCheckpoint = await waitFor(
        async () => (await fixture.journal.verify()).records.find((record) => record.kind === 'checkpoint'
          && record.scope.taskId?.value === taskId.value && record.checkpoint?.outcome === 'stopped'),
        (value) => value !== undefined,
        'the public stop committed no stopped checkpoint',
      );
      if (stoppedCheckpoint?.kind !== 'checkpoint' || !stoppedCheckpoint.checkpoint) {
        throw new Error('the stopped checkpoint is malformed');
      }
      const boundaryId = `execution-close:${operationId}`;
      const capture = (await fixture.journal.verify()).records.find((record) => record.payload?.['type'] === 'recovery-assets.phase'
        && record.payload?.['receipt'] && typeof record.payload['receipt'] === 'object'
        && (record.payload['receipt'] as Record<string, unknown>)['boundaryId'] === boundaryId);
      assert.ok(capture, 'the stopped turn has its exact execution-close capture');
      if (!capture) throw new Error('the stopped turn capture is absent');
      assert.ok(capture.seq < stoppedCheckpoint.seq,
        'the immutable turn capture commits before the stopped checkpoint');
      const receipt = (capture.payload as { readonly receipt: {
        readonly receiptRef: string; readonly boundaryId: string;
        readonly recovery: { readonly durablePhases: readonly { readonly phase: string; readonly state: string }[];
          readonly firstErrorRef?: string; readonly laterErrorRefs: readonly string[];
          readonly stages: readonly unknown[]; readonly recoveryResponsibilityRef: string };
      } }).receipt;
      assert.equal(receipt.boundaryId, boundaryId);
      const readback = await createNativeRecoveryAssets({ journalPath: fixture.layout.organJournalPath,
        journal: fixture.journal, assetRoot: join(fixture.paths.artifactsRoot, 'ui-provider-evidence') })
        .readRecoveryAssetsExact(receipt.receiptRef);
      assert.equal(readback.prepared.body.cut.pauseId, boundaryId);
      assert.deepEqual(readback.prepared.recovery.durablePhases.map((phase) => phase.state),
        ['not-executed', 'not-executed', 'not-executed', 'not-executed', 'not-executed']);
      assert.equal((await fixture.journal.verify()).records.some((record) => record.payload?.['type'] === 'native-save-intent'),
        false, 'capture-only stop fabricates no native save intent');
      assert.equal((await fixture.journal.verify()).records.some((record) => record.payload?.['kind'] === 'checkpoint-closure'),
        false, 'capture-only stop fabricates no standard checkpoint closure');
      assert.equal(fixture.upstream.wires.filter((wire) => plannerPayload(wire.body) !== undefined).length, 0,
        'capture-only stop does not run Planner alignment');
      console.log('native capture-only stop evidence', JSON.stringify({ operationId, boundaryId,
        captureSeq: capture.seq, stoppedCheckpointSeq: stoppedCheckpoint.seq,
        durablePhases: readback.prepared.recovery.durablePhases, fixture: fixture.root }));
      passed = true;
    } finally {
      releaseExecution.resolve();
      await serve.stop();
    }
  } finally {
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
    else console.error(`capture-only stop fixture retained: ${fixture.root}`);
  }
});

/**
 * One public App consumer for the pure-text slice. It drives the real native
 * CLI run entry (the actual advertised end-call source edge) over a real local
 * HTTP Responses upstream, against a real Organ Journal and the real
 * ImmutableAssetStore. A single case proves the advertised deliveryText
 * schema, a text-only accepted end call, the exact body differing from the
 * summary, asset readback with deterministic evidence identity, a real
 * independent Planner closure, Core success and a cold read of the same
 * original asset with no additional Provider POST.
 */
// Failure basis: the observed missing inspect completion and boundary-only live
// prefix/end gaps. Impact: a saved turn cannot reach Planner alignment. Cost:
// one real CLI/HTTP fixture using the existing local upstream and asset store.
if (!coldConsumerMode) test('native inspect producer and cold saved boundary preserve facts without executor replay', async () => {
  const fixture = await textOnlyFixture(true);
  let passed = false;
  try {
    const organId = id('organ', 'humanagent-ui');
    const taskId = id('task', 'native-inspect-retained');
    const access = await AccessControlService.open({ credentialPath: fixture.paths.webAccessCredentialPath, create: true });
    const challenge = await access.issuePairingChallenge();
    const session = await access.consumePairingCode(challenge.code);
    const cookie = access.sessionCookie(session).split(';')[0]!;
    const caller = await access.verifyProductPrincipal(cookie);
    if (caller.state !== 'valid') throw new Error('fixture principal unavailable');
    const controlFile = join(fixture.root, 'control-session.txt');
    await writeFile(controlFile, `${cookie}\n`, 'utf8');
    const seed = new RuntimeTaskCoordinator({ organId, taskIdPrefix: 'native-inspect',
      journal: new UiRuntimeJournal(fixture.layout.preparedJournalPath),
      checkpointStoreFor: () => new FileCheckpointStore(join(fixture.layout.modeRoot, 'seed-checkpoint.jsonl')),
      attentionPort: { async publish(value) { return { attentionId: value.attentionId, delivered: true }; },
        async resolve(value) { return { attentionId: value.attentionId, delivered: true }; } },
      async createDriver() { throw new Error('seed cannot execute'); } });
    seed.createTask({ taskId, title: 'inspect delivery', directive: 'read the delivery file' });
    await new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal)).establish({ scope: { organId, taskId }, source: {
      requirementId: 'inspect-requirement', inputRevision: 1, draftId: 'inspect-draft', draftRevisionVersion: 1,
      draftRevisionHash: 'inspect-draft-hash', confirmationRef: 'inspect-confirmation' } });
    await new JsonlTaskGrantJournal(fixture.journal).grant({ requestId: 'inspect-grant', taskId,
      owner: caller.principal.owner, capability: { actionId: 'task.execute', capabilities: ['provider.execution'], scope: { organId, taskId } }, expectedRevision: 0 });
    const cli = consumerCliEntry();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', '--workspace', fixture.workspace, '--control-root', fixture.controlRoot,
        '--plan', 'default', '--session', 'inspect-run', '--task', taskId.value, '--prompt', 'read delivery', '--control-session-file', controlFile],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });
    const plannerPosts = () => fixture.upstream.wires.filter((wire) => wire.method === 'POST' && plannerPayload(wire.body) !== undefined);
    const executionPosts = () => fixture.upstream.wires.filter((wire) => wire.method === 'POST' && plannerPayload(wire.body) === undefined);
    assert.equal(plannerPosts().length, 1, `inspect delivery must reach the deliberately refused Planner: ${result.stdout} ${result.stderr}`);
    const before = (await fixture.journal.verify()).records;
    const retained = before.find((record) => record.payload?.['type'] === 'native-save-intent');
    if (!retained) throw new Error('the canonical save intent must be committed');
    const operationId = retained.scope.operationId!.value;
    const saveRecords = before.filter((record) => record.commitId?.startsWith('native-') || record.kind === 'checkpoint');
    const journalPrefix = await readFile(fixture.layout.organJournalPath, 'utf8');
    const executorCount = executionPosts().length;
    const preparedJournal = new UiRuntimeJournal(fixture.layout.preparedJournalPath);
    const currentState = createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal });
    const taskIdentity = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal));
    let currentStateReads = 0;
    let taskIdentityReads = 0;
    const readTaskIdentity = taskIdentity.read.bind(taskIdentity);
    taskIdentity.read = async (scope) => { taskIdentityReads += 1; return readTaskIdentity(scope); };
    const composition = createDefaultExecutionComposition({ principalOwner: caller.principal.owner,
      journal: fixture.journal, filePath: fixture.layout.organJournalPath,
      artifactsRoot: join(fixture.paths.artifactsRoot, 'ui-provider-evidence'), preparedJournal,
      resourceBoundary: createPreparedOperationBoundary(preparedJournal),
      async prepareAgentProvider() { throw new Error('boundary read must not prepare a Provider'); },
      providerOptions: {}, now: () => new Date(),
      currentState: { commit: (transition) => currentState.commit(transition),
        read: async (scope) => { currentStateReads += 1; return currentState.read(scope); } },
      async publishCurrentTurnState() {}, closedTurnPlannerPool() { throw new Error('Planner remains a separate duty'); },
      taskIdentity,
      retryJournal: createJsonlRetryCycleJournalPort({ filePath: join(fixture.root, 'retry.jsonl') }),
      i2Journal: createJsonlI2JournalPort({ filePath: fixture.layout.organJournalPath, journal: fixture.journal }) });
    const selected = await composition.resolveColdExecutionResumeRequest({ taskId, operationId: id('operation', operationId) });
    const prepared = preparedJournal.replay().find((entry) => entry.kind === 'operation.prepared' && entry.allocation.taskId.value === taskId.value);
    if (prepared?.kind !== 'operation.prepared') throw new Error('exact prepared allocation absent');
    const source = await composition.readColdExecutionSource({ allocation: prepared.allocation, request: selected });
    const boundary = await composition.recoverOriginalTurn({ source });
    if (boundary.kind !== 'committed-close-alignment' && boundary.kind !== 'exact-pending-boundary') {
      throw new Error(`expected retained boundary, got ${boundary.kind}`);
    }
    assert.equal(currentStateReads, 0, 'boundary-only recovery must not read the current plan dependencies');
    assert.equal(taskIdentityReads, 0, 'boundary-only recovery must not read the current identity dependencies');
    await boundary.finishBoundary();
    const readback = await boundary.standardTurn.readDelivery!();
    assert.equal(readback.materials[0]?.kind, 'inspect-tool-report');
    const delivery = bindAssignmentDelivery({ assignment: source.assignment, readback });
    assert.ok(delivery.producedArtifactBodies[0]?.includes(EXACT_BODY.split('\n')[0]!));
    assert.equal(executionPosts().length, executorCount, 'boundary continuation must issue zero executor generation requests');
    assert.equal(plannerPosts().length, 1, 'boundary readback must not duplicate the independent Planner duty');
    const after = (await fixture.journal.verify()).records;
    assert.equal((await readFile(fixture.layout.organJournalPath, 'utf8')).slice(0, journalPrefix.length), journalPrefix);
    assert.deepEqual(after.filter((record) => record.commitId?.startsWith('native-') || record.kind === 'checkpoint'), saveRecords,
      'committed native save/checkpoint facts must be reused exactly');
    assert.equal(await readFile(join(fixture.workspace, 'read-delivery.txt'), 'utf8'), EXACT_BODY);
    const current = await createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal }).read({ organId, taskId });
    assert.equal(current.state, 'known');
    if (current.state === 'known') assert.equal(current.value.currentPlan, undefined, 'save/readback cannot claim the pending Planner duty is complete');
    passed = true;
  } finally {
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
    else console.error(`inspect fixture retained: ${fixture.root}`);
  }
});

// Observed missing App concurrency forwarding can serialize independent children.
// Frequency is unknown; impact is lost overlap/failure isolation. Cost: one existing
// local CLI consumer with budget two, including durable checkpoints and Planner.
if (!coldConsumerMode) test('native parallel child calls overlap and retain ordered refined results and checkpoints', async () => {
  const fixture = await textOnlyFixture(false, true, true);
  try {
    const organId = id('organ', 'humanagent-ui');
    const taskId = id('task', 'native-parallel-child');
    const access = await AccessControlService.open({ credentialPath: fixture.paths.webAccessCredentialPath, create: true });
    const challenge = await access.issuePairingChallenge();
    const session = await access.consumePairingCode(challenge.code);
    const cookie = access.sessionCookie(session).split(';')[0]!;
    const controlFile = join(fixture.root, 'control-session.txt');
    await writeFile(controlFile, `${cookie}\n`, 'utf8');
    const caller = await access.verifyProductPrincipal(cookie);
    if (caller.state !== 'valid') throw new Error('fixture caller principal unavailable');
    const seed = new RuntimeTaskCoordinator({
      organId, taskIdPrefix: 'native-parallel', journal: new UiRuntimeJournal(fixture.layout.preparedJournalPath),
      checkpointStoreFor: () => new FileCheckpointStore(join(fixture.layout.modeRoot, 'seed-checkpoint.jsonl')),
      attentionPort: {
        async publish(value) { return { attentionId: value.attentionId, delivered: true }; },
        async resolve(value) { return { attentionId: value.attentionId, delivered: true }; },
      },
      async createDriver() { throw new Error('seed coordinator never releases execution'); },
    });
    seed.createTask({ taskId, title: 'parallel children', directive: 'run independent children' });
    await new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal)).establish({
      scope: { organId, taskId }, source: {
        requirementId: `requirement:${taskId.value}`, inputRevision: 1, draftId: `draft:${taskId.value}`,
        draftRevisionVersion: 1, draftRevisionHash: `draft-hash:${taskId.value}`, confirmationRef: `confirmation:${taskId.value}`,
      },
    });
    await new JsonlTaskGrantJournal(fixture.journal).grant({ requestId: `grant:${taskId.value}`, taskId,
      owner: caller.principal.owner,
      capability: { actionId: 'task.execute', capabilities: ['provider.execution'], scope: { organId, taskId } },
      expectedRevision: 0 });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const processChild = spawn(process.execPath, [consumerCliEntry(),
        'run', '--workspace', fixture.workspace, '--control-root', fixture.controlRoot,
        '--plan', 'default', '--session', 'native-parallel-run', '--task', taskId.value,
        '--prompt', 'text-only delivery probe', '--control-session-file', controlFile],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      processChild.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
      processChild.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
      processChild.once('error', reject);
      processChild.once('exit', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(fixture.upstream.overlapped(), true, 'child B enters real Provider execution before child A returns');
    assert.equal(fixture.upstream.completedInReverse(), true, 'child B reaches its final drain before child A delivers');
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'), result.stdout.lastIndexOf('}') + 1));
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
    assert.equal(receipt.output, EXACT_BODY);
    assert.equal(receipt.error, undefined);
    const posts = fixture.upstream.wires.filter((wire) => wire.method === 'POST');
    assert.equal(posts.filter((wire) => plannerPayload(wire.body) !== undefined).length, 1);
    const continuation = posts.map((wire) => JSON.parse(wire.body) as {
      input?: { type: string; call_id?: string; output?: string }[];
    }).find((wire) => wire.input?.some((item) => item.call_id === 'call-parent-child-b' && item.type === 'function_call_output'));
    const returned = continuation?.input?.filter((item) => item.type === 'function_call_output'
      && ['call-parent-child-a', 'call-parent-child-b'].includes(item.call_id!)) ?? [];
    assert.deepEqual(returned.map((item) => item.call_id), ['call-parent-child-a', 'call-parent-child-b']);
    const refined = returned.map((item) => JSON.parse(item.output!.split('\n[HumanAgent evidence refs]')[0]!));
    assert.deepEqual(refined.map((entry) => entry.state), ['returned', 'returned']);
    assert.deepEqual(refined.map((entry) => entry.summary), ['parallel child 0 result', 'parallel child 1 result']);
    assert.equal(refined[0].invocationId === refined[1].invocationId, false);
    const verified = await fixture.journal.verify();
    const checkpoints = verified.records.filter((record) => record.kind === 'checkpoint');
    for (const entry of refined) {
      const checkpointId = `child-call-${Buffer.from(entry.invocationId, 'utf8').toString('base64url')}`;
      assert.ok(checkpoints.some((record) => record.checkpoint?.id.value === checkpointId),
        'each child has its own committed pre-call checkpoint');
    }
    console.log('parallel child consumer settled', JSON.stringify({ overlap: true, calls: returned.map((item) => item.call_id),
      invocations: refined.map((entry) => entry.invocationId), fixture: fixture.root }));
  } finally {
    await fixture.upstream.close();
    await rm(fixture.root, { recursive: true });
  }
});

// r353 exposed masked child failure reasons; probability is unknown. Impact:
// wrong cause and recovery. Cost: one bounded local public CLI fixture. The
// selector deliberately violates the declared 256-character tool schema.
if (!coldConsumerMode) test('native review child failure preserves primary reason', async () => {
  const fixture = await textOnlyFixture(false, true, false, 2, undefined, undefined, undefined, false, undefined, true, true);
  let passed = false;
  try {
    const { taskId, result } = await runNativeMultiTurnConsumer(fixture, 2);
    assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'), result.stdout.lastIndexOf('}') + 1));
    console.log('review failure receipt', JSON.stringify({ fixture: fixture.root, receipt }));
    assert.equal(receipt.taskId, taskId.value);
    assert.equal(receipt.state, 'blocked');
    assert.equal(receipt.error?.message, 'child call finding 0 evidenceRefs item exceeds its 256 character bound');
    assert.equal(receipt.error?.cleanupError, undefined,
      'the known failed turn cleanup does not attach a false cleanup error');
    assert.equal(receipt.output, '');
    assert.equal(receipt.release, 'released');
    const failureTerminal = new UiRuntimeJournal(fixture.layout.preparedJournalPath).replay()
      .flatMap((record) => record.kind === 'operation.event' ? [record] : [])
      .find((record) => record.operationId.value === receipt.operationId
        && record.event.operationId === receipt.operationId
        && record.event.taskId.value === receipt.taskId
        && record.event.executionEpoch === receipt.executionEpoch
        && record.event.kind === 'execution.terminal'
        && record.event.terminalPhase === 'final')?.event;
    assert.ok(failureTerminal, 'the failed parent has its exact final terminal event');
    if (!failureTerminal) throw new Error('the failed parent final terminal event is absent');
    assert.equal(failureTerminal.state, 'blocked');
    assert.equal(failureTerminal.summary, 'child call finding 0 evidenceRefs item exceeds its 256 character bound');
    const closeEvidenceStore = new ImmutableAssetStore(join(fixture.paths.artifactsRoot, 'ui-provider-evidence'));
    const expectedClose = { endpoint: fixture.upstream.baseUrl, bindingId: 'text-only-binding' };
    const closeEvidenceRefs: EvidenceRef[] = [];
    for (const entry of failureTerminal.evidenceRefs) {
      if (entry.kind !== 'external' || entry.source !== 'humanagent.provider-adapter'
        || entry.digest === undefined) continue;
      const content = JSON.parse(new TextDecoder('utf-8', { fatal: true })
        .decode(await closeEvidenceStore.readEvidence(entry))) as {
          readonly endpoint?: unknown;
          readonly bindingId?: unknown;
        };
      if (content.endpoint === expectedClose.endpoint && content.bindingId === expectedClose.bindingId) {
        closeEvidenceRefs.push(entry);
      }
    }
    assert.ok(closeEvidenceRefs.length > 0,
      'the final terminal retains the actual checked Provider close evidence');
    assert.deepEqual(closeEvidenceRefs[0]?.scope, { organId: id('organ', 'provider-adapter') },
      'the Provider close reference keeps its original organ-only scope');
    console.log('review failure close evidence', JSON.stringify({
      taskId: failureTerminal.taskId.value,
      operationId: failureTerminal.operationId,
      executionEpoch: failureTerminal.executionEpoch,
      terminal: `${failureTerminal.kind}:${failureTerminal.terminalPhase}`,
      closeEvidence: closeEvidenceRefs.map((entry) => ({
        evidenceId: entry.evidenceId,
        source: entry.source,
        scope: entry.scope,
        content: expectedClose,
      })),
    }));
    const scope = { organId: id('organ', 'humanagent-ui'), taskId };
    const verified = await fixture.journal.verify();
    const bindings = await listTaskActiveTurnBindings({ journal: fixture.journal, scope });
    const parent = bindings.find((entry) => entry.binding.scope.operationId?.value === receipt.operationId);
    if (!parent) throw new Error('missing parent active turn');
    const parentRecords = decodeActiveTurnRecords(verified.records, parent.binding.admittedTurn.turnId);
    const reviews = parentRecords.filter((entry) => entry.kind === 'child-invocation' && entry.record.binding.kind === 'review');
    assert.equal(reviews.length, 1, 'one review invocation is retained without automatic replay');
    const review = reviews[0]!;
    if (review.kind !== 'child-invocation' || review.record.binding.kind !== 'review') throw new Error('missing review invocation');
    assert.equal(review.record.adoptedResultSeq, undefined);
    assert.equal(review.record.postReviewCheckpointRef, undefined);
    assert.equal(parentRecords.some((entry) => entry.kind === 'child-delivery' && entry.entry.kind === 'review'), false,
      'no review return or synthetic inconclusive result is committed');
    const child = bindings.find((entry) => entry.binding.assignment.assignmentId === review.record.binding.assignment.assignmentId);
    if (!child) throw new Error('the failed review has no same-task admitted control scope');
    const childControl = await createJsonlOperationControlJournal({ journal: fixture.journal }).readControl({
      scope: parent.binding.scope,
      ...(child.binding.scope.operationId === undefined ? {} : { operationId: child.binding.scope.operationId }),
    });
    assert.equal(childControl.state, 'complete');
    if (childControl.state !== 'complete') throw new Error('incomplete child control journal');
    assert.equal(childControl.operations.length, 1);
    assert.equal(childControl.operations[0]?.status, 'failed');
    assert.equal(
      childControl.operations[0]?.failure?.message,
      'child call finding 0 evidenceRefs item exceeds its 256 character bound',
    );
    const childRecords = decodeActiveTurnRecords(verified.records, child.binding.admittedTurn.turnId);
    assert.ok(childRecords.some((entry) => entry.kind === 'request' && entry.record.phase === 'failed'
      && entry.record.scope.taskId?.value === taskId.value
      && entry.record.scope.operationId?.value === child.binding.scope.operationId?.value),
    'the review request failure remains durable in its original task and operation');
    assert.ok(verified.records.some((entry) => entry.checkpoint?.id.value === review.record.checkpointReceiptRef),
      'the unreturned review retains its actual pre-call recovery checkpoint');
    const boundaryId = `execution-close:${receipt.operationId}`;
    const captureRecord = verified.records.find((entry) => entry.payload?.['type'] === 'recovery-assets.phase'
      && (entry.payload['receipt'] as { readonly boundaryId?: unknown } | undefined)?.boundaryId === boundaryId);
    assert.ok(captureRecord, 'the failed parent has its exact execution-close recovery capture');
    if (!captureRecord) throw new Error('the failed parent recovery capture is absent');
    const captureReceipt = (captureRecord.payload as { readonly receipt: { readonly receiptRef: string } }).receipt;
    const readback = await createNativeRecoveryAssets({ journalPath: fixture.layout.organJournalPath,
      journal: fixture.journal, assetRoot: join(fixture.paths.artifactsRoot, 'ui-provider-evidence') })
      .readRecoveryAssetsExact(captureReceipt.receiptRef);
    assert.equal(readback.prepared.body.cut.pauseId, boundaryId);
    assert.equal(readback.prepared.body.binding.scope.operationId?.value, receipt.operationId);
    const rawFailedResult = readback.prepared.body.entries.find((entry) => 'envelope' in entry
      && entry.envelope.fact.kind === 'tool-result' && entry.envelope.fact.callId === 'cycle-1-review'
      && entry.envelope.fact.result.status === 'blocked');
    assert.ok(rawFailedResult, 'the exact capture retains the failed tool result');
    if (!rawFailedResult || !('envelope' in rawFailedResult)
      || rawFailedResult.envelope.fact.kind !== 'tool-result') {
      throw new Error('the captured failed tool result is malformed');
    }
    assert.equal(rawFailedResult.envelope.fact.result.error?.message,
      'child call finding 0 evidenceRefs item exceeds its 256 character bound');
    const rawBytes = await providerRawContentReader(filesystemProviderEvidenceSink(
      new ImmutableAssetStore(join(fixture.paths.artifactsRoot, 'ui-provider-evidence'))))
      .read({ scope: rawFailedResult.envelope.scope, content: rawFailedResult.envelope.fact.rawOutput });
    assert.ok(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes).includes('256 character bound'),
      'the raw failed tool result remains exact-readable');
    assert.ok(readback.prepared.body.childInvocations.some((entry) => entry.invocationId === review.record.invocationId
      && entry.checkpointReceiptRef === review.record.checkpointReceiptRef),
    'the exact capture retains the unreturned review and its pre-call checkpoint');
    assert.deepEqual(readback.prepared.recovery.durablePhases.map((phase) => phase.state),
      ['not-executed', 'not-executed', 'not-executed', 'not-executed', 'not-executed'],
      'failed pre-end cleanup does not fabricate standard durable phases');
    const childCheckpointRefs = new Set(readback.prepared.body.childInvocations
      .map((entry) => entry.checkpointReceiptRef));
    assert.equal(verified.records.some((entry) => entry.kind === 'checkpoint'
      && entry.checkpoint !== undefined && !childCheckpointRefs.has(entry.checkpoint.id.value)), false,
    'failed pre-end cleanup commits no standard checkpoint');
    assert.equal(verified.records.some((entry) => entry.payload?.['type'] === 'native-save-intent'),
      false, 'failed pre-end cleanup commits no standard save intent');
    const posts = fixture.upstream.wires.filter((wire) => wire.method === 'POST');
    const reviewRequests = posts.filter((wire) => parseResponsesWire(wire.body)?.model === 'review.only.model');
    assert.equal(reviewRequests.length, 2, 'one read and one invalid delivery, with no replay or success drain');
    assert.equal(posts.some((wire) => plannerPayload(wire.body) !== undefined), false,
      'failed review cannot advance to a successful turn closure');
    console.log('review failure control', JSON.stringify({ taskId: taskId.value,
      invocationId: review.record.invocationId, childOperationId: child.binding.scope.operationId?.value,
      recoveryCheckpoint: review.record.checkpointReceiptRef, reviewRequests: reviewRequests.length }));
    passed = true;
  } finally {
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
    else console.error(`review failure fixture retained: ${fixture.root}`);
  }
});

// Multi-cycle review forwarding/history failure probability is unknown. Losing
// adoption breaks Planner alignment. Cost: one bounded local CLI/HTTP fixture;
// restoring transient evidence resolution rejects the accepted review citation.
// Confirmed taskFlow loss is statically possible at each independent Planner
// boundary; its production probability is unknown. Impact: both rounds lose the
// user-confirmed long-running template. Cost: reuse the bounded fixture and
// transiently remove the actual taskFlow handoff to observe the new assertion fail.
if (!coldConsumerMode) test('native two-cycle dynamic review public CLI consumer advances plan revisions and preserves cold semantic history', async () => {
  const rawInput = 'Complete the M3 public long-running dynamic two-cycle task.';
  const taskFlow = { kind: 'long-running' as const, definitionVersion: 1 };
  const fixture = await textOnlyFixture(
    false, true, false, 2, undefined, undefined, undefined, false, undefined, true, false,
    { kind: 'm3-long-running', parentModel: 'text.only.model', childModel: 'child.only.model', rawInput },
  );
  let passed = false;
  let serve: Awaited<ReturnType<typeof startServe>> | undefined;
  try {
    serve = await startServe({ controlRoot: fixture.controlRoot, workspace: fixture.workspace });
    const access = await AccessControlService.open({
      credentialPath: fixture.paths.webAccessCredentialPath,
      create: false,
    });
    const challenge = await access.issuePairingChallenge();
    const session = await access.consumePairingCode(challenge.code);
    const cookie = access.sessionCookie(session).split(';')[0]!;

    const createdResponse = await fetch(`${serve.origin}/api/explicit/inputs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, accept: 'application/json' },
      body: JSON.stringify({
        channel: 'business',
        requestKind: 'new-task-create',
        sourceRef: 'test:m3-public-long-running',
        rawInput,
      }),
    });
    const createdText = await createdResponse.text();
    assert.equal(createdResponse.status, 201, createdText);
    const created = requireRecord(JSON.parse(createdText), 'the public explicit input receipt');
    const interactionId = requireText(created.interactionId, 'the public explicit interaction ID');

    const interpretedResponse = await fetch(
      `${serve.origin}/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`,
      { method: 'POST', headers: { cookie, accept: 'application/json' } },
    );
    const interpretedText = await interpretedResponse.text();
    assert.equal(interpretedResponse.status, 200, interpretedText);
    const interpreted = requireRecord(JSON.parse(interpretedText), 'the public explicit interpretation');
    assert.equal(interpreted.state, 'awaiting-confirmation');

    const inspectedResponse = await fetch(
      `${serve.origin}/api/explicit/interactions/${encodeURIComponent(interactionId)}`,
      { headers: { cookie, accept: 'application/json' } },
    );
    const inspectedText = await inspectedResponse.text();
    assert.equal(inspectedResponse.status, 200, inspectedText);
    const inspected = requireRecord(JSON.parse(inspectedText), 'the public explicit inspection');
    const draft = requireRecord(inspected.draft, 'the public explicit draft');
    const revision = requireRecord(inspected.revision, 'the public explicit revision');
    const confirmedResponse = await fetch(
      `${serve.origin}/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, accept: 'application/json' },
        body: JSON.stringify({
          interactionId,
          draftId: requireText(draft.draftId, 'the public explicit draft ID'),
          inputRevision: requireNumber(draft.inputRevision, 'the public explicit input revision'),
          confirmationRef: 'confirmation:m3-public-long-running',
          confirmedBy: 'human:operator',
          confirmedAt: '2026-10-18T00:00:00.000Z',
          payloadRef: 'asset://requirements/m3-public-long-running',
          requestKind: 'new-task-create',
          draftRevisionVersion: requireNumber(revision.revisionVersion, 'the public explicit revision version'),
          draftRevisionHash: requireText(revision.revisionHash, 'the public explicit revision hash'),
          goal: rawInput,
          scope: 'M3 public two-cycle production composition evidence',
          constraints: ['Use the confirmed dynamic task flow without a fixed role chain'],
          deliverables: ['Two independent Planner payloads and public plan history'],
          taskFlow,
        }),
      },
    );
    const confirmedText = await confirmedResponse.text();
    assert.equal(confirmedResponse.status, 200, confirmedText);
    const confirmed = requireRecord(JSON.parse(confirmedText), 'the public confirmation receipt');
    const confirmedRequirement = requireRecord(confirmed.requirement, 'the confirmed requirement');
    const requirementId = requireText(confirmedRequirement.requirementId, 'the confirmed requirement ID');
    const projectKey = fixture.paths.projectKey;
    const task = await waitFor(
      async () => {
        const response = await fetch(`${serve!.origin}/api/tasks`, {
          headers: { cookie, accept: 'application/json' },
        });
        assert.equal(response.status, 200);
        const list = await response.json() as {
          readonly running: readonly Record<string, unknown>[];
          readonly waiting: readonly Record<string, unknown>[];
          readonly completed: readonly Record<string, unknown>[];
          readonly stopped: readonly Record<string, unknown>[];
          readonly draft: readonly Record<string, unknown>[];
          readonly failed: readonly Record<string, unknown>[];
        };
        const rows = [
          ...list.running, ...list.waiting, ...list.completed,
          ...list.stopped, ...list.draft, ...list.failed,
        ];
        return rows.find((row) => {
          const source = row.identitySource;
          return typeof source === 'object' && source !== null && !Array.isArray(source)
            && (source as Record<string, unknown>).requirementId === requirementId;
        });
      },
      (candidate) => candidate !== undefined && candidate.state === 'waiting',
      'the confirmed public Task did not reach the prepared waiting state',
    );
    if (task === undefined) throw new Error('the confirmed public Task row is absent');
    assert.deepEqual(task.taskFlow, taskFlow);
    const taskId = id('task', requireText(requireRecord(task.taskId, 'the public Task ID').value,
      'the public Task ID value'));

    assert.equal(task.state, 'waiting', 'confirmation retains the prepared task until a verified grant');
    const grantRequestId = 'm3-public-long-running-grant';
    const grantResponse = await fetch(
      `${serve.origin}/api/tasks/${encodeURIComponent(taskId.value)}/control/grant`
        + `?projectKey=${encodeURIComponent(projectKey)}&mode=rcc`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, accept: 'application/json' },
        body: JSON.stringify({
          requestId: grantRequestId,
          expectedRevision: 0,
          capability: { actionId: 'task.execute', capabilities: ['provider.execution'] },
        }),
      },
    );
    const grantText = await grantResponse.text();
    assert.equal(grantResponse.status, 200, grantText);
    const grant = requireRecord(JSON.parse(grantText), 'the public task grant receipt');
    assert.equal(requireRecord(grant.readback, 'the public grant readback').grant === undefined
      ? undefined : requireRecord(requireRecord(grant.readback, 'the public grant readback').grant,
        'the public grant').state, 'granted');
    const execution = requireRecord(grant.execution, 'the public grant execution receipt');
    assert.equal(execution.state, 'released', JSON.stringify(grant));
    const operationId = requireText(requireRecord(execution.selector, 'the public execution selector').operationId,
      'the released execution operation ID');

    const finalDashboard = await waitFor(
      async () => {
        const response = await fetch(
          `${serve!.origin}/api/tasks/${encodeURIComponent(taskId.value)}/dashboard`
            + `?projectKey=${encodeURIComponent(projectKey)}&mode=rcc`,
          { headers: { cookie, accept: 'application/json' } },
        );
        const text = await response.text();
        assert.equal(response.status, 200, text);
        return JSON.parse(text) as Record<string, unknown>;
      },
      (dashboard) => dashboard.state === 'succeeded',
      'the public serve did not complete both execution cycles',
      60_000,
    );
    assert.equal(finalDashboard.output, EXACT_BODY);
    const posts = fixture.upstream.wires.filter((wire) => wire.method === 'POST');
    const planners = posts.filter((wire) => plannerPayload(wire.body) !== undefined);
    assert.equal(planners.length, 2);
    const first = plannerPayload(planners[0]!.body)!;
    const second = plannerPayload(planners[1]!.body)!;
    assert.equal(first.priorPlan, null);
    assert.equal(requireRecord(second.priorPlan, 'prior plan').sequence, 1);
    for (const payload of [first, second]) {
      assert.deepEqual(payload.taskFlow, taskFlow,
        'each independent Planner receives the confirmed long-running task flow');
      assert.deepEqual((payload.refinedResults as Record<string, unknown>[]).map((entry) => entry.role), ['execution', 'review']);
      const summary = requireRecord(requireRecord(payload.closure, 'closing checkpoint').summary, 'four-part summary');
      for (const key of ['goal', 'actions', 'result', 'expectedNextStep']) {
        requireText(requireRecord(summary[key], key).text, key);
      }
    }
    const nextWire = posts.slice(posts.indexOf(planners[0]!) + 1).find((wire) => hasTurnEndSurface(wire.body));
    assert.ok(nextWire);
    if (!nextWire) throw new Error('missing second parent request');
    await assertPriorSemanticCheckpointWire(fixture, nextWire.body, taskId, TURN_ONE_GOAL);
    assert.equal((semanticCheckpointWires(nextWire.body)[0]!.adoptedChildren as unknown[]).length, 2);
    const nextBody = parseResponsesWire(nextWire.body);
    if (!nextBody) throw new Error('the second-cycle parent request is not a Responses wire body');
    assert.equal(nextBody.model, fixture.configuration.effective.provider?.model,
      'the second-cycle request uses the configured parent model');
    assert.deepEqual(
      (nextBody.input ?? []).filter((item) => item.type === 'function_call' || item.type === 'function_call_output')
        .map((item) => ({ type: item.type, callId: item.call_id })),
      [],
      'the second-cycle parent request excludes prior raw call and result entries',
    );
    const nextEnvelope = JSON.parse(nextWire.body) as { readonly previous_response_id?: unknown };
    assert.equal(nextEnvelope.previous_response_id, undefined,
      'the second-cycle parent request does not chain hidden provider response state');

    const coldJournal = new JsonlOrganJournal(fixture.layout.organJournalPath);
    const scope = { organId: id('organ', 'humanagent-ui'), taskId };
    const plans = new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(coldJournal));
    const revisions = [...await plans.replay(scope)].sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(revisions.map((entry) => entry.sequence), [1, 2]);
    assert.ok(revisions[0]!.revisionId !== revisions[1]!.revisionId);
    assert.ok(revisions[0]!.snapshot.summary !== revisions[1]!.snapshot.summary);
    for (let index = 0; index < 2; index++) {
      assert.ok(revisions[index]!.snapshot.summary.includes(`Cycle ${index + 1}`));
      assert.ok(revisions[index]!.snapshot.nodes[0]!.intent.includes(`Cycle ${index + 1}`));
    }
    const duties = await createJsonlClosedTurnPlannerCallJournal({ journal: coldJournal }).readTaskDuties(scope);
    assert.equal(duties.length, 2);
    assert.deepEqual(duties.map((entry) => entry.returned?.record.decision), ['continue', 'complete']);
    const operations = new Set(duties.map((entry) => entry.returned!.record.duty.scope.operationId!.value));
    const bindings = [...await listTaskActiveTurnBindings({ journal: coldJournal, scope })]
      .filter((entry) => operations.has(entry.binding.scope.operationId!.value))
      .sort((a, b) => a.commitRef.journalSeq - b.commitRef.journalSeq);
    assert.equal(bindings.length, 2);
    assert.equal(operations.size, 2);
    assert.ok(bindings.every((entry) => entry.binding.scope.cycleId !== undefined));
    assert.ok(bindings[0]!.binding.scope.cycleId!.value !== bindings[1]!.binding.scope.cycleId!.value);
    assert.equal(bindings[0]!.binding.acceptedPlan, undefined);
    assert.deepEqual(bindings[1]!.binding.acceptedPlan, { revisionId: revisions[0]!.revisionId,
      revisionCommitRef: await plans.getCommitRef(scope, revisions[0]!.revisionId) });
    const current = await createJsonlRuntimeTaskCurrentStateJournal({ journal: coldJournal }).read(scope);
    assert.equal(current.state, 'known');
    if (current.state !== 'known') throw new Error('missing durable current state');
    assert.equal(current.value.task.state, 'succeeded');
    assert.equal(current.value.currentPlan?.revisionId, revisions[1]!.revisionId);
    const verified = await coldJournal.verify();
    const publications = verified.records.filter((entry) => entry.payload?.['kind'] === 'native-semantic-history-publication'
      && operations.has(entry.scope.operationId?.value ?? ''));
    assert.equal(publications.length, 2);
    for (const publication of publications) {
      const context = requireRecord(publication.payload?.['contextView'], 'published context');
      const viewRecord = verified.records.find((entry) => entry.payload?.['kind'] === 'native-semantic-context-view'
        && JSON.stringify(entry.payload?.['identity']) === JSON.stringify(context.identity));
      assert.ok(viewRecord, 'publication resolves its actual semantic context view');
      const children = viewRecord!.payload?.['adoptedChildren'] as Record<string, unknown>[];
      assert.deepEqual(children.map((child) => child.kind), ['execution', 'review']);
      const review = children.find((child) => child.kind === 'review')!;
      assert.ok(review.postReviewCheckpointRef);
      assert.ok(verified.records.some((entry) => entry.checkpoint?.id.value === review.postReviewCheckpointRef),
        'review references an actual durable post-review checkpoint');
      const checkpoint = requireRecord(requireRecord(publication.payload?.['checkpoint'], 'checkpoint receipt').checkpoint, 'checkpoint');
      requireText(checkpoint.summary, 'closing checkpoint summary');
    }
    const before = await readFile(fixture.layout.organJournalPath);
    const preparedBefore = await readFile(fixture.layout.preparedJournalPath);
    const historyResponse = await fetch(
      `${serve.origin}/api/tasks/${encodeURIComponent(taskId.value)}/task-plan-history`
        + `?projectKey=${encodeURIComponent(projectKey)}&mode=rcc`,
      { headers: { cookie, accept: 'application/json' } },
    );
    const historyText = await historyResponse.text();
    assert.equal(historyResponse.status, 200, historyText);
    const history = JSON.parse(historyText) as {
      readonly current: { readonly state: string; readonly value?: { readonly revisionId?: string } };
      readonly revisions: readonly { readonly revisionId: string; readonly sequence: number }[];
    };
    assert.deepEqual(history.revisions.map((entry) => entry.sequence), [1, 2]);
    assert.equal(history.current.state, 'known');
    assert.equal(history.current.value?.revisionId, history.revisions[1]?.revisionId);
    const dashboard = finalDashboard as Record<string, unknown> & {
      readonly taskPlanHistory?: {
        readonly ok?: boolean;
        readonly value?: {
          readonly current?: { readonly state?: string; readonly value?: { readonly revisionId?: string } };
          readonly revisions?: readonly { readonly revisionId: string; readonly sequence: number }[];
        };
      };
    };
    assert.equal(dashboard.state, 'succeeded');
    assert.equal(dashboard.output, EXACT_BODY);
    assert.equal(dashboard.taskPlanHistory?.ok, true);
    assert.deepEqual(dashboard.taskPlanHistory?.value?.revisions?.map((entry) => entry.sequence), [1, 2]);
    assert.equal(dashboard.taskPlanHistory?.value?.current?.state, 'known');
    assert.equal(dashboard.taskPlanHistory?.value?.current?.value?.revisionId, history.revisions[1]?.revisionId);
    assert.deepEqual(await readFile(fixture.layout.organJournalPath), before);
    assert.deepEqual(await readFile(fixture.layout.preparedJournalPath), preparedBefore);
    assert.equal(fixture.upstream.wires.filter((wire) => wire.method === 'POST').length, posts.length);
    console.log('M3 public two-cycle evidence', JSON.stringify({ fixture: fixture.root, interactionId, requirementId,
      taskId: taskId.value, grantRequestId, operationId, readerPid: serve.pid,
      plannerTaskFlows: [first.taskFlow, second.taskFlow], plannerPriorSequences: [first.priorPlan, second.priorPlan],
      cycles: bindings.map((entry) => entry.binding.scope.cycleId), operations: [...operations],
      revisions: revisions.map((entry) => ({ revisionId: entry.revisionId, sequence: entry.sequence, summary: entry.snapshot.summary })),
      currentPlan: current.value.currentPlan, providerPosts: posts.length }));
    passed = true;
  } finally {
    if (serve !== undefined) await serve.stop();
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
    else console.error(`two-cycle review fixture retained: ${fixture.root}`);
  }
});

if (!coldConsumerMode) test('native two.turn public CLI consumer retains adopted child context and completes the prior plan', async () => {
  const fixture = await textOnlyFixture(true, true, false, 2);
  let passed = false;
  try {
    const { taskId, result } = await runNativeMultiTurnConsumer(fixture, 2);
    assert.equal(result.code, 0, `the real two-turn CLI run must exit cleanly: ${result.stderr}`);
    const receiptStart = result.stdout.indexOf('{');
    const receiptEnd = result.stdout.lastIndexOf('}');
    assert.ok(receiptStart >= 0 && receiptEnd > receiptStart, `the two-turn run prints a receipt: ${result.stdout}`);
    const receipt = JSON.parse(result.stdout.slice(receiptStart, receiptEnd + 1)) as {
      readonly command?: string;
      readonly taskId?: string;
      readonly state?: string;
      readonly output?: string;
      readonly error?: unknown;
      readonly terminal?: Record<string, unknown>;
      readonly checkpoint?: {
        readonly checkpointId?: string;
        readonly committedAt?: string;
        readonly committedAtUnavailableReason?: string;
      };
    };
    console.log('two.turn receipt', JSON.stringify(receipt));
    assert.equal(receipt.command, 'run');
    assert.equal(receipt.taskId, taskId.value);
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt.error));
    assert.equal(receipt.output, EXACT_BODY);
    assert.equal(receipt.error, undefined);
    const terminal = requireRecord(receipt.terminal, 'the two-turn terminal');
    console.log('two.turn terminal', JSON.stringify(terminal));

    const posts = fixture.upstream.wires.filter((wire) => wire.method === 'POST');
    const plannerPosts = posts.filter((wire) => plannerPayload(wire.body) !== undefined);
    assert.equal(plannerPosts.length, 2, 'the two-turn run reaches exactly two independent Planner requests');
    const firstPlanner = plannerPayload(plannerPosts[0]!.body);
    const secondPlanner = plannerPayload(plannerPosts[1]!.body);
    if (!firstPlanner || !secondPlanner) throw new Error('both Planner requests carry business payloads');
    assert.equal(firstPlanner.priorPlan, null);
    const priorPlan = requireRecord(secondPlanner.priorPlan, 'the second Planner priorPlan');
    assert.equal(requireNumber(priorPlan.sequence, 'the second Planner priorPlan sequence'), 1);

    const firstPlannerIndex = fixture.upstream.wires.findIndex((wire) => wire === plannerPosts[0]);
    const secondPlannerIndex = fixture.upstream.wires.findIndex((wire) => wire === plannerPosts[1]);
    assert.ok(firstPlannerIndex >= 0 && secondPlannerIndex > firstPlannerIndex);
    const turnTwoWire = fixture.upstream.wires.slice(firstPlannerIndex + 1, secondPlannerIndex)
      .find((wire) => wire.method === 'POST' && plannerPayload(wire.body) === undefined && hasTurnEndSurface(wire.body));
    assert.ok(turnTwoWire, 'the second turn sends a real parent execution request before its Planner call');
    if (!turnTwoWire) throw new Error('the second turn execution wire is absent');
    const turnTwoBody = JSON.parse(turnTwoWire.body) as {
      readonly input?: readonly {
        readonly type?: string;
        readonly role?: string;
        readonly call_id?: string;
        readonly content?: readonly { readonly type?: string; readonly text?: string }[];
      }[];
    };
    const turnTwoContext = (turnTwoBody.input ?? []).flatMap((item) =>
      (item.content ?? []).flatMap((part) => typeof part.text === 'string' ? [part.text] : [])).join('\n');
    for (const expected of [TURN_ONE_GOAL, TURN_ONE_ACTIONS, TURN_ONE_RESULT, TURN_ONE_NEXT, CHILD_BODY]) {
      assert.ok(turnTwoContext.includes(expected), `the second turn retains the first-turn semantic fact: ${expected}`);
    }
    await assertPriorSemanticCheckpointWire(fixture, turnTwoWire.body, taskId, TURN_ONE_GOAL);
    assert.equal(turnTwoWire.body.includes('call-parent-child'), false,
      'the second turn excludes the first turn raw child-call history');
    assert.equal(turnTwoWire.body.includes('call-parent-adopt'), false,
      'the second turn excludes the first turn raw child-adopt history');
    const priorCallIds = new Set([
      'call-inspect-read',
      'call-parent-child',
      'call-parent-adopt',
      'call-child-delivery',
      'call-child-end',
      'call-turn-1-end',
    ]);
    assert.equal(
      (turnTwoBody.input ?? []).some((item) =>
        (item.type === 'function_call' || item.type === 'function_call_output')
        && priorCallIds.has(item.call_id ?? '')),
      false,
      'the second turn excludes prior raw call and result entries',
    );
    assert.equal(turnTwoWire.body.includes(EXACT_BODY), false,
      'the second turn excludes the complete raw file body');

    const verified = await fixture.journal.verify();
    const currentCheckpoint = receipt.checkpoint;
    if (!currentCheckpoint?.checkpointId) throw new Error('the two-turn receipt must expose its current checkpoint');
    const currentCheckpointRecord = verified.records.find((record) => record.kind === 'checkpoint'
      && record.scope.taskId?.value === taskId.value
      && record.checkpoint?.id.value === currentCheckpoint.checkpointId);
    if (!currentCheckpointRecord?.checkpoint) throw new Error('the two-turn current checkpoint must be committed');
    const currentCheckpointRelationship = await createJsonlCheckpointJournal({
      filePath: fixture.layout.organJournalPath,
    }).readNativeCheckpoint({ checkpoint: currentCheckpointRecord.checkpoint });
    if (!currentCheckpointRelationship) throw new Error('the two-turn current checkpoint receipt must be durable');
    assert.equal(currentCheckpoint.committedAt, currentCheckpointRelationship.receipt.committedAt,
      'the two-turn receipt exposes the exact current checkpoint commit time');
    assert.equal(currentCheckpoint.committedAtUnavailableReason, undefined,
      'the two-turn receipt does not report a durable commit time as unavailable');
    const coverageRecords = verified.records
      .filter((record) => record.payload?.['kind'] === 'operation-control-coverage/v1');
    const parentCoverageRecords = coverageRecords.filter((record) => record.scope.taskId?.value === taskId.value);
    const firstParentCoverage = parentCoverageRecords.find((record) =>
      typeof record.scope.operationId?.value === 'string');
    if (!firstParentCoverage) throw new Error('the first parent operation coverage must be durable');
    if (!firstParentCoverage.scope.operationId) throw new Error('the first parent operation identity must be durable');
    const firstTurnEntries = await createJsonlActiveTurnJournal({
      filePath: fixture.layout.organJournalPath,
      journal: fixture.journal,
      turnId: newActiveTurnId(firstParentCoverage.scope.operationId.value),
    }).replay();
    const acceptedInspectRead = firstTurnEntries.find((entry) => entry.kind === 'accepted-fact'
      && entry.entry.envelope.fact.kind === 'tool-result'
      && entry.entry.envelope.fact.callId === 'call-inspect-read'
      && entry.entry.envelope.fact.result.status === 'succeeded');
    if (acceptedInspectRead?.kind !== 'accepted-fact'
      || acceptedInspectRead.entry.envelope.fact.kind !== 'tool-result') {
      throw new Error('the first turn must retain its accepted successful inspect read');
    }
    assert.deepEqual(acceptedInspectRead.entry.envelope.scope, firstParentCoverage.scope);
    const acceptedInspectRef = acceptedInspectRead.entry.envelope.fact.rawOutput.ref;
    assert.deepEqual(acceptedInspectRef.scope, firstParentCoverage.scope);
    const inspectCheckpoint = semanticCheckpointWires(turnTwoWire.body).find((entry) => entry.goal === TURN_ONE_GOAL);
    if (!inspectCheckpoint) throw new Error('the second turn must retain the first-turn semantic checkpoint');
    const inspectResult = requireText(inspectCheckpoint.result, 'the first-turn semantic result');
    assert.ok(inspectResult.includes(
      'Inspected read-delivery.txt completely: two UTF-8 lines; read-only, no mutation performed',
    ), 'the first-turn result retains the bounded inspect conclusion');
    assert.equal(inspectResult === EXACT_BODY, false, 'the bounded conclusion is not the complete raw file body');
    assert.ok(Array.isArray(inspectCheckpoint.evidenceRefs),
      'the first-turn semantic checkpoint exposes top-level evidence refs');
    const inspectEvidence = (inspectCheckpoint.evidenceRefs as readonly {
      readonly locator?: unknown;
      readonly scope?: unknown;
    }[]).find((ref) => ref.locator === acceptedInspectRef.locator);
    assert.ok(inspectEvidence, 'the first-turn semantic checkpoint cites the accepted inspect locator');
    assert.deepEqual(inspectEvidence, acceptedInspectRef,
      'the first-turn semantic checkpoint cites the exact accepted inspect ref');
    const operationIds = parentCoverageRecords
      .map((record) => record.scope.operationId?.value)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    assert.ok(operationIds.length >= 2, 'the two turns commit distinct parent operation identities');
    assert.equal(new Set(operationIds).size, operationIds.length, 'the two turns do not reuse an operation identity');
    const activeTurnIds = verified.records
      .filter((record) => record.commitId?.startsWith('active-turn:') && record.commitId.endsWith(':binding-opened'))
      .map((record) => record.commitId!.slice('active-turn:'.length, -':binding-opened'.length));
    assert.ok(activeTurnIds.length >= 2, 'the two turns commit distinct active-turn identities');
    assert.equal(new Set(activeTurnIds).size, activeTurnIds.length, 'the two turns do not reuse an active-turn identity');
    console.log('two.turn evidence', JSON.stringify({
      operationIds,
      activeTurnIds,
      plannerPosts: plannerPosts.length,
      providerPosts: posts.length,
      terminal,
      fixture: fixture.root,
    }));
    passed = true;
  } finally {
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
    else console.error(`two-turn fixture retained: ${fixture.root}`);
  }
});

// A three-turn publication can silently retain only the latest prior scope.
// Frequency is unknown; impact is loss of the first-turn semantic checkpoint.
// Cost: one real single-child CLI/HTTP consumer reusing the two-turn fixture.
if (!coldConsumerMode) test('native three.turn public CLI consumer retains multi-turn semantic history and adopted child context', async () => {
  const fixture = await textOnlyFixture(false, true, false, 3);
  let passed = false;
  try {
    const { taskId, result } = await runNativeMultiTurnConsumer(fixture, 3);
    assert.equal(result.code, 0, `the real three-turn CLI run must exit cleanly: ${result.stderr}`);
    const receiptStart = result.stdout.indexOf('{');
    const receiptEnd = result.stdout.lastIndexOf('}');
    assert.ok(receiptStart >= 0 && receiptEnd > receiptStart, `the three-turn run prints a receipt: ${result.stdout}`);
    const receipt = JSON.parse(result.stdout.slice(receiptStart, receiptEnd + 1)) as {
      readonly command?: string;
      readonly taskId?: string;
      readonly state?: string;
      readonly output?: string;
      readonly error?: unknown;
      readonly terminal?: Record<string, unknown>;
      readonly checkpoint?: {
        readonly checkpointId?: string;
        readonly committedAt?: string;
        readonly committedAtUnavailableReason?: string;
      };
    };
    assert.equal(receipt.command, 'run');
    assert.equal(receipt.taskId, taskId.value);
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt.error));
    assert.equal(receipt.output, EXACT_BODY);
    assert.equal(receipt.error, undefined);
    const terminal = requireRecord(receipt.terminal, 'the three-turn terminal');

    const posts = fixture.upstream.wires.filter((wire) => wire.method === 'POST');
    const plannerPosts = posts.filter((wire) => plannerPayload(wire.body) !== undefined);
    assert.equal(plannerPosts.length, 3, 'the three-turn run reaches exactly three independent Planner requests');
    const firstPlanner = plannerPayload(plannerPosts[0]!.body);
    const secondPlanner = plannerPayload(plannerPosts[1]!.body);
    const thirdPlanner = plannerPayload(plannerPosts[2]!.body);
    if (!firstPlanner || !secondPlanner || !thirdPlanner) throw new Error('all Planner requests carry business payloads');
    assert.equal(firstPlanner.priorPlan, null);
    assert.equal(requireNumber(requireRecord(secondPlanner.priorPlan, 'the second Planner priorPlan').sequence,
      'the second Planner priorPlan sequence'), 1);
    assert.equal(requireNumber(requireRecord(thirdPlanner.priorPlan, 'the third Planner priorPlan').sequence,
      'the third Planner priorPlan sequence'), 2);

    const secondPlannerIndex = fixture.upstream.wires.findIndex((wire) => wire === plannerPosts[1]);
    const thirdPlannerIndex = fixture.upstream.wires.findIndex((wire) => wire === plannerPosts[2]);
    assert.ok(secondPlannerIndex >= 0 && thirdPlannerIndex > secondPlannerIndex);
    const turnThreeWire = fixture.upstream.wires.slice(secondPlannerIndex + 1, thirdPlannerIndex)
      .find((wire) => wire.method === 'POST' && plannerPayload(wire.body) === undefined && hasTurnEndSurface(wire.body));
    assert.ok(turnThreeWire, 'the third turn sends a real parent execution request before its Planner call');
    if (!turnThreeWire) throw new Error('the third turn execution wire is absent');
    const turnThreeBody = JSON.parse(turnThreeWire.body) as ResponsesWireBody;
    const turnThreeContext = (turnThreeBody.input ?? []).flatMap((item) =>
      (item.content ?? []).flatMap((part) => typeof part.text === 'string' ? [part.text] : [])).join('\n');
    for (const expected of [TURN_ONE_GOAL, TURN_ONE_ACTIONS, TURN_ONE_RESULT, TURN_ONE_NEXT, CHILD_BODY,
      TURN_TWO_GOAL, TURN_TWO_ACTIONS, TURN_TWO_RESULT, TURN_TWO_NEXT]) {
      assert.ok(turnThreeContext.includes(expected), `the third turn retains the ordered semantic fact: ${expected}`);
    }
    assert.ok(turnThreeContext.indexOf(TURN_ONE_GOAL) < turnThreeContext.indexOf(TURN_TWO_GOAL),
      'the third turn retains Turn 1 semantics before Turn 2 semantics');
    for (const rawCallId of ['call-parent-child', 'call-parent-adopt', 'call-child-delivery', 'call-child-end',
      'call-turn-1-end', 'call-turn-2-end']) {
      assert.equal(turnThreeWire.body.includes(rawCallId), false,
        `the third turn excludes prior raw execution history: ${rawCallId}`);
    }
    await assertPriorSemanticCheckpointWire(fixture, turnThreeWire.body, taskId, TURN_ONE_GOAL);
    await assertPriorSemanticCheckpointWire(fixture, turnThreeWire.body, taskId, TURN_TWO_GOAL);
    assert.equal(turnThreeWire.body.includes(TURN_TWO_DELIVERY), false,
      'the third turn excludes the prior turn delivery body from semantic history');

    const verified = await fixture.journal.verify();
    const currentCheckpoint = receipt.checkpoint;
    if (!currentCheckpoint?.checkpointId) throw new Error('the three-turn receipt must expose its current checkpoint');
    const currentCheckpointRecord = verified.records.find((record) => record.kind === 'checkpoint'
      && record.scope.taskId?.value === taskId.value
      && record.checkpoint?.id.value === currentCheckpoint.checkpointId);
    if (!currentCheckpointRecord?.checkpoint) throw new Error('the three-turn current checkpoint must be committed');
    const currentCheckpointRelationship = await createJsonlCheckpointJournal({
      filePath: fixture.layout.organJournalPath,
    }).readNativeCheckpoint({ checkpoint: currentCheckpointRecord.checkpoint });
    if (!currentCheckpointRelationship) throw new Error('the three-turn current checkpoint receipt must be durable');
    assert.equal(currentCheckpoint.committedAt, currentCheckpointRelationship.receipt.committedAt,
      'the three-turn receipt exposes the exact current checkpoint commit time');
    assert.equal(currentCheckpoint.committedAtUnavailableReason, undefined,
      'the three-turn receipt does not report a durable commit time as unavailable');
    const parentCoverageRecords = verified.records
      .filter((record) => record.payload?.['kind'] === 'operation-control-coverage/v1'
        && record.scope.taskId?.value === taskId.value);
    const operationIds = parentCoverageRecords
      .map((record) => record.scope.operationId?.value)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    assert.ok(operationIds.length >= 3, 'the three turns commit distinct parent operation identities');
    assert.equal(new Set(operationIds).size, operationIds.length, 'the three turns do not reuse an operation identity');
    const activeTurnIds = verified.records
      .filter((record) => record.commitId?.startsWith('active-turn:') && record.commitId.endsWith(':binding-opened')
        && record.scope.taskId?.value === taskId.value)
      .map((record) => record.commitId!.slice('active-turn:'.length, -':binding-opened'.length));
    assert.ok(activeTurnIds.length >= 3, 'the three turns commit distinct active-turn identities');
    assert.equal(new Set(activeTurnIds).size, activeTurnIds.length, 'the three turns do not reuse an active-turn identity');
    console.log('three.turn evidence', JSON.stringify({
      operationIds,
      activeTurnIds,
      plannerPosts: plannerPosts.length,
      providerPosts: posts.length,
      terminal,
      fixture: fixture.root,
    }));
    passed = true;
  } finally {
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
    else console.error(`three-turn fixture retained: ${fixture.root}`);
  }
});

type VerifiedJournalRecord = Awaited<ReturnType<JsonlOrganJournal['verify']>>['records'][number];
type InspectionRecordEntry = { readonly record: Record<string, unknown>; readonly journal: VerifiedJournalRecord };

function inspectionRecords(records: Awaited<ReturnType<JsonlOrganJournal['verify']>>['records']) {
  type VerifiedRecord = Awaited<ReturnType<JsonlOrganJournal['verify']>>['records'][number];
  const i2 = records.flatMap((record): { readonly record: Record<string, unknown>; readonly journal: VerifiedRecord }[] => {
    const payload = record.payload;
    const value = payload?.['record'];
    return payload?.['kind'] === 'i2-history' && typeof value === 'object' && value !== null
      ? [{ record: value as Record<string, unknown>, journal: record }] : [];
  });
  return {
    definitionEntries: i2.filter(({ record }) => record.kind === 'inspection-definition'),
    definitions: i2.filter(({ record }) => record.kind === 'inspection-definition').map((entry) => entry.record),
    cycles: i2.filter(({ record }) => record.kind === 'business-cycle-opened'),
    openingEntries: i2.filter(({ record }) => record.kind === 'inspection-occurrence-opened'),
    openings: i2.filter(({ record }) => record.kind === 'inspection-occurrence-opened').map((entry) => entry.record),
    itemEntries: i2.filter(({ record }) => record.kind === 'inspection-item-result'),
    items: i2.filter(({ record }) => record.kind === 'inspection-item-result').map((entry) => entry.record),
    settlementEntries: i2.filter(({ record }) => record.kind === 'inspection-occurrence-settled'),
    settlements: i2.filter(({ record }) => record.kind === 'inspection-occurrence-settled').map((entry) => entry.record),
    aligned: i2.filter(({ record }) => record.kind === 'milestone-review-aligned'),
    closingEntries: i2.filter(({ record }) => record.kind === 'business-cycle-closed'),
    closes: i2.filter(({ record }) => record.kind === 'business-cycle-closed'),
    openingByRef: (ref: JournalCommitRef) => exactInspectionEntry(i2.filter(({ record }) => record.kind === 'business-cycle-opened'), ref),
    settlementByRef: (ref: JournalCommitRef) => exactInspectionEntry(i2.filter(({ record }) => record.kind === 'inspection-occurrence-settled'), ref),
  };
}

function exactInspectionEntry(entries: readonly InspectionRecordEntry[], ref: JournalCommitRef): InspectionRecordEntry | undefined {
  return entries.find(({ journal }) => journal.commitId === ref.commitId
    && journal.seq === ref.journalSeq && journal.recordDigest === ref.recordDigest);
}

// Failure basis: the default composition does not bind the existing inspection
// selection and acceptance ports. Probability is unknown; the source owner is
// known to omit the wiring. Impact is loss of native inspection history. Cost
// is this one existing three-turn CLI/HTTP consumer.
if (!coldConsumerMode) test('native inspection producer and consumer retain two occurrences across three turns', async () => {
  const fixture = await textOnlyFixture(false, true, false, 3, undefined, undefined, undefined, true);
  let passed = false;
  let serve: Awaited<ReturnType<typeof startServe>> | undefined;
  try {
    const { taskId, result, cookie } = await runNativeMultiTurnConsumer(fixture, 3, true);
    assert.equal(result.code, 0, `the real inspection CLI run must exit cleanly: ${result.stderr}`);
    const receiptStart = result.stdout.indexOf('{');
    const receiptEnd = result.stdout.lastIndexOf('}');
    assert.ok(receiptStart >= 0 && receiptEnd > receiptStart, `the inspection run prints a receipt: ${result.stdout}`);
    const receipt = JSON.parse(result.stdout.slice(receiptStart, receiptEnd + 1)) as {
      readonly command?: string;
      readonly taskId?: string;
      readonly state?: string;
      readonly output?: string;
      readonly error?: unknown;
    };
    assert.equal(receipt.command, 'run');
    assert.equal(receipt.taskId, taskId.value);
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt.error));
    assert.equal(receipt.error, undefined);

    const posts = fixture.upstream.wires.filter((wire) => wire.method === 'POST');
    const plannerPosts = posts.filter((wire) => plannerPayload(wire.body) !== undefined);
    assert.equal(plannerPosts.length, 3, 'the inspection run reaches three independent Planner requests');
    const firstPlanner = plannerPayload(plannerPosts[0]!.body);
    const secondPlanner = plannerPayload(plannerPosts[1]!.body);
    const thirdPlanner = plannerPayload(plannerPosts[2]!.body);
    if (!firstPlanner || !secondPlanner || !thirdPlanner) throw new Error('all Planner requests carry business payloads');
    assert.equal(firstPlanner.priorPlan, null);
    assert.equal(requireNumber(requireRecord(secondPlanner.priorPlan, 'the second priorPlan').sequence,
      'the second priorPlan sequence'), 1);
    assert.equal(requireNumber(requireRecord(thirdPlanner.priorPlan, 'the third priorPlan').sequence,
      'the third priorPlan sequence'), 2);
    const publishedPlans = [...await new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(fixture.journal))
      .replay({ organId: id('organ', 'humanagent-ui'), taskId })];
    assert.equal(publishedPlans.length, 3, 'three actual Planner publications are durable');
    for (const plan of publishedPlans) {
      assert.deepEqual(plan.snapshot.inspectionDefinition, INSPECTION_DEFINITION,
        `Planner publication ${plan.sequence} retains the exact formal definition`);
    }

    const verify = await fixture.journal.verify();
    const records = inspectionRecords(verify.records);
    assert.equal(records.definitions.length, 1, 'three turns retain one durable inspection definition');
    assert.equal(records.openings.length, 2, 'two logical turns open two actual inspection occurrences');
    assert.equal(records.items.length, 2, 'each executed turn commits one actual item result');
    assert.equal(records.settlements.length, 2, 'each parent standard end settles one actual occurrence');
    assert.equal(records.closes.length, 1, 'the terminal parent cycle closes once');
    const terminalClose = records.closes[0];
    if (!terminalClose) throw new Error('the terminal parent cycle close must be committed');
    const close = requireRecord(terminalClose.record, 'the terminal cycle close');
    const openedRef = requireRecord(close.openedCommitRef, 'the terminal cycle opening ref') as unknown as JournalCommitRef;
    const checkpointRef = requireRecord(close.checkpointCommitRef, 'the terminal checkpoint ref') as unknown as JournalCommitRef;
    const settlementRef = requireRecord(close.inspectionSettlementCommitRef, 'the terminal settlement ref') as unknown as JournalCommitRef;
    const opening = records.openingByRef(openedRef);
    const settlement = records.settlementByRef(settlementRef);
    if (!opening || !settlement) throw new Error('the terminal close must bind the actual cycle opening and settlement');
    assert.equal(requireRecord(opening.record, 'the terminal cycle opening').kind, 'business-cycle-opened',
      'the close binds an actual cycle opening');
    assert.equal(requireRecord(settlement.record, 'the terminal settlement').kind, 'inspection-occurrence-settled',
      'the close binds an actual inspection settlement');
    assert.deepEqual(requireRecord(settlement.record, 'the terminal settlement').checkpointCommitRef, checkpointRef,
      'the terminal settlement binds the close checkpoint');
    const taskScope = { organId: id('organ', 'humanagent-ui'), taskId };
    const checkpointJournal = createJsonlCheckpointJournal({
      filePath: fixture.layout.organJournalPath,
      journal: fixture.journal,
    });
    const binding = await checkpointJournal.readCheckpointRecoveryBinding(taskScope, checkpointRef);
    if (!binding) throw new Error('the terminal checkpoint has no committed recovery binding');
    const closeNext = requireRecord(close.next, 'the terminal cycle next action');
    const alignmentRef = requireText(closeNext.ref, 'the terminal cycle alignment reference');
    const closurePort = createJsonlCheckpointClosurePort({
      filePath: fixture.layout.organJournalPath,
      journal: fixture.journal,
    });
    const alignmentRecord = await closurePort.read(alignmentRef);
    if (!alignmentRecord || !('closureKind' in alignmentRecord)
      || alignmentRecord.closureKind !== 'planner-alignment') {
      throw new Error('the terminal cycle references no committed planner alignment');
    }
    const alignment = alignmentRecord.alignment;
    assert.equal(alignment.decision, 'complete', 'the terminal planner alignment records completion');
    const committedCheckpoint = await checkpointJournal.readCommitted(alignment.identity.scopeRef, alignment.checkpointId);
    if (!committedCheckpoint) throw new Error('the terminal planner alignment references no committed checkpoint');
    assert.deepEqual(committedCheckpoint.commitRef, checkpointRef,
      'the terminal planner alignment references the cycle close checkpoint');
    assert.equal(turnBoundaryRecordRefs(alignment.identity, alignment.checkpointId).alignmentRef, alignmentRef,
      'the terminal planner alignment uses the canonical turn-boundary identity');
    assert.equal(close.outcome, 'stop', 'terminal complete closes the business cycle');
    assert.deepEqual(close.next, { kind: 'stop', ref: alignmentRef },
      'the cycle decision uses the checkpoint-bound alignment reference');
    assert.equal(terminalClose.record.outcome, 'stop', 'terminal complete settles the business cycle without claiming human stop');
    const actualInvocations = fixture.upstream.inspectionInvocations();
    assert.deepEqual(actualInvocations.map((entry) => entry.callId), [
      'call-inspection-parent-1', 'call-inspection-parent-2',
    ], 'the two fresh model rounds produced their actual parent call outputs');
    assert.equal(new Set(actualInvocations.map((entry) => entry.invocationId)).size, 2,
      'two fresh parent model rounds produce two actual child invocation identities');
    for (const definition of records.definitions) {
      const content = requireRecord(definition.content, 'the durable inspection content');
      assert.deepEqual(content, INSPECTION_DEFINITION);
    }
    const openingIds = records.openings.map((record) =>
      requireRecord(record.occurrence, 'an inspection occurrence').occurrenceId);
    assert.equal(new Set(openingIds).size, 2, 'the occurrences retain independent identities');
    const openingTurns = records.openings.map((record) => record.logicalTurnId);
    assert.equal(new Set(openingTurns).size, 2, 'the occurrences retain independent logical turns');
    const committedItems = records.items.map((record) => requireRecord(record.delivery, 'an inspection item'));
    assert.deepEqual(committedItems.map((item) => item.checkId), ['check-a', 'check-a'],
      'only the selected check-a executes');
    assert.deepEqual(committedItems.map((item) => requireRecord(item.outcome, 'inspection item outcome')),
      [
        { status: 'completed', judgment: INSPECTION_TURN_TWO_JUDGMENT },
        { status: 'completed', judgment: INSPECTION_TURN_THREE_JUDGMENT },
      ], 'durable items retain the actual body-derived judgments');
    assert.deepEqual(committedItems.map((item) => item.resultId), actualInvocations.map((entry) =>
      `inspection-result:${entry.invocationId}`),
    'each durable item binds the invocation returned by the actual child producer');
    assert.equal(committedItems.some((item) => item.checkId === INSPECTION_CHECK_B.checkId), false,
      'check-b remains absent from durable item results');
    assert.deepEqual(records.settlements.map((record) => record.outcome), [
      { status: 'completed', judgment: INSPECTION_TURN_TWO_PARENT_JUDGMENT },
      { status: 'completed', judgment: INSPECTION_TURN_THREE_PARENT_JUDGMENT },
    ], 'each settlement uses the parent-authored aggregate standard-end outcome');
    const inspectionChildRequests = fixture.upstream.inspectionChildRequests();
    const requestParentCallIds = new Set(inspectionChildRequests.map((entry) => entry.parentCallId));
    assert.equal(requestParentCallIds.size, 2,
      'the inspection child requests cover two actual parent calls');
    for (const parentCallId of ['call-inspection-parent-1', 'call-inspection-parent-2']) {
      assert.equal(requestParentCallIds.has(parentCallId), true,
        `the inspection child requests cover ${parentCallId}`);
    }
    assert.equal(inspectionChildRequests.some((entry) => entry.body.includes(INSPECTION_CHECK_B.checkId)), false,
      'check-b never reaches the configured child');
    for (const entry of inspectionChildRequests) {
      assert.deepEqual(entry.body.includes(INSPECTION_CHECK_A.checkId), true);
      assert.deepEqual(entry.body.includes(INSPECTION_CHECK_A.criterion), true);
      assert.deepEqual(entry.body.includes(INSPECTION_CHECK_A.inputRefs[0]), true);
    }

    const journalBeforeReads = await readFile(fixture.layout.organJournalPath);
    const postsBeforeReads = posts.length;
    serve = await startServe({ controlRoot: fixture.controlRoot, workspace: fixture.workspace });
    const taskPath = `/api/tasks/${encodeURIComponent(taskId.value)}`;
    const read = async (path: string) => {
      const response = await fetch(`${serve!.origin}${path}`, { headers: { cookie, accept: 'application/json' } });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
      return body;
    };
    const list = await read(`${taskPath}/inspection-occurrences`);
    const entries = list.entries as readonly Record<string, unknown>[];
    assert.equal(entries.length, 2, 'the public history lists both actual occurrences');
    const occurrenceIds = entries.map((entry) => entry.occurrenceId as string);
    assert.deepEqual(occurrenceIds, openingIds, 'the public history uses the actual occurrence IDs');
    for (const entry of entries) {
      assert.equal(entry.definitionId, INSPECTION_DEFINITION_ID);
      assert.equal(entry.definitionVersion, INSPECTION_DEFINITION_VERSION);
      assert.equal(entry.state, 'settled');
      assert.equal(entry.outcome, 'completed');
      const items = entry.items as readonly Record<string, unknown>[];
      assert.deepEqual(items.map((item) => [item.checkId, item.state]), [
        ['check-a', 'completed'], ['check-b', 'missing'],
      ], 'each occurrence retains check-a and the actual missing check-b');
      assert.equal(items.some((item) => item.outcome === 'cancelled'), false,
        'no cancelled inspection item is fabricated');
    }
    const first = entries.find((entry) => Array.isArray(entry.items) && (entry.items as readonly Record<string, unknown>[])
      .some((item) => item.checkId === 'check-a' && item.judgment === INSPECTION_TURN_TWO_JUDGMENT));
    const second = entries.find((entry) => Array.isArray(entry.items) && (entry.items as readonly Record<string, unknown>[])
      .some((item) => item.checkId === 'check-a' && item.judgment === INSPECTION_TURN_THREE_JUDGMENT));
    if (!first || !second) throw new Error('the public occurrences do not retain both changed check-a judgments');
    const detail = await read(`${taskPath}/inspection-occurrences/${encodeURIComponent(first.occurrenceId as string)}`);
    assert.equal((detail.entry as Record<string, unknown>).occurrenceId, first.occurrenceId);
    const comparison = await read(`${taskPath}/inspection-comparison?left=${encodeURIComponent(first.occurrenceId as string)}`
      + `&right=${encodeURIComponent(second.occurrenceId as string)}`);
    assert.equal(comparison.comparable, true);
    assert.deepEqual((comparison.items as readonly Record<string, unknown>[]).map((item) => [item.checkId, item.change]), [
      ['check-a', 'changed'], ['check-b', 'not-compared'],
    ]);
    await read(`${taskPath}/inspection-occurrences`);
    await read(`${taskPath}/inspection-occurrences/${encodeURIComponent(first.occurrenceId as string)}`);
    await read(`${taskPath}/inspection-comparison?left=${encodeURIComponent(first.occurrenceId as string)}`
      + `&right=${encodeURIComponent(second.occurrenceId as string)}`);
    assert.equal(fixture.upstream.wires.filter((wire) => wire.method === 'POST').length, postsBeforeReads,
      'public reads issue no Provider request');
    assert.deepEqual(await readFile(fixture.layout.organJournalPath), journalBeforeReads,
      'public reads append no Journal record');
    await serve.stop();
    serve = undefined;
    serve = await startServe({ controlRoot: fixture.controlRoot, workspace: fixture.workspace });
    const cold = await fetch(`${serve.origin}${taskPath}/inspection-occurrences`, { headers: { cookie } });
    assert.equal(cold.status, 200, 'a fresh serve process reads the same durable occurrences');
    assert.equal(((await cold.json()) as { readonly entries?: readonly unknown[] }).entries?.length, 2);
    assert.equal(fixture.upstream.wires.filter((wire) => wire.method === 'POST').length, postsBeforeReads,
      'the cold read issues no Provider request or child call');
    assert.deepEqual(await readFile(fixture.layout.organJournalPath), journalBeforeReads,
      'the cold read appends no Journal record');
    console.log('native inspection consumer evidence', JSON.stringify({
      fixture: fixture.root,
      occurrenceIds,
      judgments: [INSPECTION_TURN_TWO_JUDGMENT, INSPECTION_TURN_THREE_JUDGMENT],
      comparison: 'check-a changed; check-b not-compared',
    }));
    passed = true;
  } catch (error) {
    console.error(`inspection fixture retained: ${fixture.root}`);
    console.error(`inspection evidence: ${JSON.stringify({
      plannerPosts: fixture.upstream.wires.filter((wire) => plannerPayload(wire.body) !== undefined).length,
      posts: fixture.upstream.wires.filter((wire) => wire.method === 'POST').length,
    })}`);
    throw error;
  } finally {
    if (serve !== undefined) await serve.stop();
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
  }
});

// Failure basis: the original stop case holds before an inspection occurrence
// opens. Impact: an opened occurrence may remain unsettled or a cold read may
// append recovery work. Cost: one held inspection turn and one fresh reader.
if (!coldConsumerMode) test('native opened inspection public stop settles the occurrence and survives a fresh durable reader', async () => {
  const inspectionHeld = deferred();
  const releaseInspection = deferred();
  const fixture = await textOnlyFixture(false, true, false, 3, undefined, undefined, undefined, true, async () => {
    inspectionHeld.resolve();
    await releaseInspection.promise;
  });
  let passed = false;
  let serve: Awaited<ReturnType<typeof startServe>> | undefined;
  let readerServe: Awaited<ReturnType<typeof startServe>> | undefined;
  try {
    const { organId, taskId, cookie } = await prepareNativeMultiTurnConsumer(fixture, 3, true);
    const taskScope = { organId, taskId };
    const taskPath = `/api/tasks/${encodeURIComponent(taskId.value)}`;
    const liveServe = await startServe({ controlRoot: fixture.controlRoot, workspace: fixture.workspace });
    serve = liveServe;
    const startedResponse = await fetch(`${liveServe.origin}${taskPath}/executions`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'rcc', prompt: 'opened inspection stop probe' }),
    });
    const started = await startedResponse.json() as { readonly operationId?: string };
    assert.equal(startedResponse.status, 202, JSON.stringify(started));
    const startReceiptOperationId = started.operationId;
    if (startReceiptOperationId === undefined) throw new Error('the public inspection start has no operation identity');
    await withDeadline(inspectionHeld.promise, 30_000);

    const inspect = async () => inspectionRecords((await fixture.journal.verify()).records);
    const barrier = await waitFor(inspect,
      (records) => records.openingEntries.length === 1 && records.itemEntries.length === 1,
      'the opened inspection did not commit its occurrence and accepted child result', 15_000);
    const openingEntry = barrier.openingEntries[0];
    const itemEntry = barrier.itemEntries[0];
    if (!openingEntry || !itemEntry) throw new Error('the opened inspection records are absent');
    const opening = openingEntry.record;
    const cycleOpenedCommitRef = requireRecord(opening.cycleOpenedCommitRef,
      'the inspection cycle opening ref') as unknown as JournalCommitRef;
    const sameRef = (left: JournalCommitRef, right: JournalCommitRef): boolean =>
      left.commitId === right.commitId && left.journalSeq === right.journalSeq
      && left.recordDigest === right.recordDigest;
    assert.equal(barrier.settlementEntries.length, 0, 'the inspection has no settlement at the hold');
    assert.equal(barrier.closingEntries.some(({ record }) => sameRef(requireRecord(record.openedCommitRef,
      'a cycle opening ref') as unknown as JournalCommitRef, cycleOpenedCommitRef)), false,
    'the inspection cycle is open at the hold');
    const occurrence = requireRecord(opening.occurrence, 'the inspection occurrence');
    const occurrenceId = requireText(occurrence.occurrenceId, 'the inspection occurrence id');
    const executionScope = requireRecord(opening.executionScope, 'the inspection execution scope');
    assert.deepEqual(executionScope.organId, organId, 'the inspection execution scope retains its organ');
    assert.deepEqual(executionScope.taskId, taskId, 'the inspection execution scope retains its task');
    const cycleOpeningEntry = barrier.cycles.find(({ journal }) => sameRef({
      commitId: journal.commitId!, journalSeq: journal.seq, recordDigest: journal.recordDigest,
    }, cycleOpenedCommitRef));
    if (!cycleOpeningEntry) throw new Error('the inspection execution scope has no exact cycle opening record');
    const cycleOpening = requireRecord(cycleOpeningEntry.record, 'the inspection cycle opening');
    const cycle = requireRecord(cycleOpening.cycle, 'the inspection cycle');
    assert.deepEqual(requireRecord(cycle.scope, 'the inspection cycle scope'), executionScope,
      'the inspection occurrence binds the actual cycle and operation scope');
    assert.equal(requireText(requireRecord(cycle.id, 'the inspection cycle id').value, 'the inspection cycle id'),
      requireText(opening.cycleId, 'the inspection occurrence cycle id'));
    const heldParentOperationId = requireText(
      requireRecord(executionScope.operationId, 'the held parent operation').value,
      'the held parent operation id',
    );
    const openingDefinition = requireRecord(opening.definition, 'the inspection definition');
    assert.deepEqual({
      definitionId: openingDefinition.definitionId,
      definitionVersion: openingDefinition.definitionVersion,
    }, {
      definitionId: INSPECTION_DEFINITION_ID, definitionVersion: INSPECTION_DEFINITION_VERSION,
    }, 'the inspection occurrence retains the definition identity');
    const definitionCommitRef = requireRecord(opening.definitionCommitRef,
      'the inspection definition commit ref') as unknown as JournalCommitRef;
    const definitionEntry = exactInspectionEntry(barrier.definitionEntries, definitionCommitRef);
    if (!definitionEntry) throw new Error('the inspection occurrence has no exact committed definition');
    assert.equal(opening.definitionDigest, definitionEntry.record.definitionDigest,
      'the inspection occurrence digest binds the exact committed definition');
    assert.deepEqual(requireRecord(definitionEntry.record.content, 'the committed inspection definition content'),
      INSPECTION_DEFINITION, 'the referenced committed definition retains its immutable content');
    const delivery = requireRecord(itemEntry.record.delivery, 'the accepted inspection item');
    const actualInvocations = fixture.upstream.inspectionInvocations();
    assert.deepEqual(actualInvocations.map((entry) => entry.callId), ['call-inspection-parent-1'],
      'the hold follows the first actual inspection child adoption');
    assert.equal(new Set(actualInvocations.map((entry) => entry.invocationId)).size, actualInvocations.length,
      'the inspection invocations retain unique child identities');
    const invocationId = actualInvocations[0]?.invocationId;
    if (invocationId === undefined) throw new Error('the hold has no actual inspection child invocation');
    assert.equal(delivery.checkId, INSPECTION_CHECK_A.checkId);
    assert.equal(delivery.resultId, `inspection-result:${invocationId}`);
    assert.deepEqual(requireRecord(delivery.outcome, 'the accepted inspection outcome'), {
      status: 'completed', judgment: INSPECTION_TURN_TWO_JUDGMENT,
    });
    const childWires = fixture.upstream.wires.filter((wire) => wire.method === 'POST'
      && parseResponsesWire(wire.body)?.tools?.some((tool) => tool.name === 'humanagent_child_deliver') === true);
    assert.ok(childWires.some((wire) => wire.body.includes(INSPECTION_CHECK_A.checkId)
      && wire.body.includes(INSPECTION_CHECK_A.criterion)
      && wire.body.includes(INSPECTION_CHECK_A.inputRefs[0])),
    'the accepted check-a has a correctly configured child request');
    assert.equal(childWires.some((wire) => wire.body.includes(INSPECTION_CHECK_B.checkId)), false,
      'check-b does not reach the configured child');

    const stopResponse = await withDeadline(fetch(`${liveServe.origin}${taskPath}/stop`, {
      method: 'POST', headers: { cookie },
    }), 30_000);
    const stopped = await stopResponse.json() as { readonly state?: string; readonly operationId?: string };
    assert.equal(stopResponse.status, 202, JSON.stringify(stopped));
    let taskAfterStop = await fetchTaskForCaptureStop(liveServe.origin, taskId, cookie);
    if (stopped.state !== 'stopped') {
      taskAfterStop = await waitFor(() => fetchTaskForCaptureStop(liveServe.origin, taskId, cookie),
        (task) => task.state !== 'settling',
        'the opened inspection stop remained settling without a terminal result', 5_000)
        .catch(() => taskAfterStop);
    }
    assert.deepEqual(stopped, { state: 'stopped', operationId: heldParentOperationId },
      `the stop error was ${JSON.stringify(taskAfterStop.error)}`);
    assert.equal(taskAfterStop.state, 'stopped');
    const stoppedCheckpoint = await waitFor(async () => (await fixture.journal.verify()).records.find(
      (record) => record.kind === 'checkpoint' && record.scope.taskId?.value === taskId.value
        && record.scope.operationId?.value === heldParentOperationId && record.checkpoint?.outcome === 'stopped'),
    (value) => value !== undefined, 'the opened inspection stop committed no exact stopped checkpoint');
    if (stoppedCheckpoint?.kind !== 'checkpoint' || !stoppedCheckpoint.checkpoint) {
      throw new Error('the opened inspection stopped checkpoint is malformed');
    }
    assert.equal(stoppedCheckpoint.scope.organId.value, organId.value);
    assert.deepEqual(stoppedCheckpoint.checkpoint.next, {
      kind: 'stop',
      ref: 'operator-stop',
    });
    const stoppedCheckpointRef: JournalCommitRef = { commitId: stoppedCheckpoint.commitId!,
      journalSeq: stoppedCheckpoint.seq, recordDigest: stoppedCheckpoint.recordDigest };

    const settled = await waitFor(inspect,
      (records) => records.settlementEntries.length === 1 && records.closingEntries.length === 1,
      'the opened inspection stop did not settle and close its occurrence once', 15_000);
    assert.equal(settled.openings.length, 1, 'stop creates no replacement inspection occurrence');
    assert.equal(settled.items.length, 1, 'stop retains only the accepted check-a result');
    const settlementEntry = settled.settlementEntries[0];
    const closingEntry = settled.closingEntries[0];
    if (!settlementEntry || !closingEntry) throw new Error('the stop settlement or close is absent');
    const settlement = settlementEntry.record;
    const settlementRef: JournalCommitRef = { commitId: settlementEntry.journal.commitId!,
      journalSeq: settlementEntry.journal.seq, recordDigest: settlementEntry.journal.recordDigest };
    const openingRef: JournalCommitRef = { commitId: openingEntry.journal.commitId!,
      journalSeq: openingEntry.journal.seq, recordDigest: openingEntry.journal.recordDigest };
    assert.deepEqual(requireRecord(settlement.openingCommitRef, 'the settlement opening ref'), { ...openingRef });
    assert.deepEqual(requireRecord(settlement.occurrence, 'the settlement occurrence'), occurrence);
    assert.deepEqual(requireRecord(settlement.checkpointCommitRef, 'the settlement checkpoint ref'), { ...stoppedCheckpointRef });
    assert.deepEqual(settlement.itemResultCommitRefs, [{ commitId: itemEntry.journal.commitId!,
      journalSeq: itemEntry.journal.seq, recordDigest: itemEntry.journal.recordDigest }],
    'the settlement retains the accepted check-a commit');
    assert.deepEqual(requireRecord(settlement.outcome, 'the stop settlement outcome'), {
      status: 'unknown',
      reason: 'inspection stopped after the execution checkpoint; missing checks retain unknown side effects',
    }, 'stop uses the production unknown outcome, not the held parent completion');
    const close = closingEntry.record;
    assert.deepEqual(requireRecord(close.openedCommitRef, 'the close cycle opening ref'), { ...cycleOpenedCommitRef });
    assert.deepEqual(requireRecord(close.checkpointCommitRef, 'the close checkpoint ref'), { ...stoppedCheckpointRef });
    assert.deepEqual(requireRecord(close.inspectionSettlementCommitRef, 'the close settlement ref'), { ...settlementRef });
    assert.equal(close.outcome, 'stop');
    assert.deepEqual(close.next, { kind: 'stop' });
    assert.equal(settled.items.some((record) => requireRecord(record.delivery,
      'an inspection delivery').checkId === INSPECTION_CHECK_B.checkId), false,
    'no unexecuted check-b item or cancelled substitute is fabricated');
    assert.equal(fixture.upstream.wires.filter((wire) => plannerPayload(wire.body) !== undefined).length, 1,
      'the stop path does not run the next Planner turn');
    assert.equal(fixture.upstream.inspectionInvocations().length, 1,
      'the stop path does not start a second inspection child');

    const organJournalBytes = await readFile(fixture.layout.organJournalPath);
    const preparedJournalBytes = await readFile(fixture.layout.preparedJournalPath);
    const postsBeforeReader = fixture.upstream.wires.filter((wire) => wire.method === 'POST').length;
    const invocationsBeforeReader = fixture.upstream.inspectionInvocations().length;
    await serve.stop();
    serve = undefined;
    releaseInspection.resolve();
    const readerWorkspace = join(fixture.root, 'reader-workspace');
    await mkdir(readerWorkspace);
    readerServe = await startServe({ controlRoot: fixture.controlRoot, workspace: readerWorkspace });
    const read = async (path: string) => {
      const response = await fetch(`${readerServe!.origin}${path}`, { headers: { cookie, accept: 'application/json' } });
      const body = await response.json() as Record<string, unknown>;
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
      return body;
    };
    const projectKey = fixture.paths.projectKey;
    const project = await read(`/api/dashboard?scope=project&projectKey=${encodeURIComponent(projectKey)}`);
    assert.equal(project.complete, true, JSON.stringify(project.failures));
    const row = (project.tasks as readonly Record<string, unknown>[]).find((candidate) => {
      const scope = requireRecord(candidate.scope, 'a durable Task scope');
      return requireRecord(scope.taskId, 'a durable Task id').value === taskId.value && scope.mode === 'rcc';
    });
    if (!row) throw new Error('the fresh durable reader omitted the stopped Task');
    assert.equal(row.basis, 'durable-history');
    assert.equal(requireRecord(row.task, 'the durable Task row').state, 'stopped');

    const scoped = `?projectKey=${encodeURIComponent(projectKey)}&mode=rcc`;
    const dashboard = await read(`${taskPath}/dashboard${scoped}`);
    assert.equal(dashboard.state, 'stopped');
    assert.equal(requireRecord(dashboard.checkpoint, 'the cold stopped checkpoint').outcome, 'stopped');
    assert.equal((dashboard.error as { readonly code?: string } | undefined)?.code, undefined,
      'the cold reader reports no inspection settlement recovery error');
    const list = await read(`${taskPath}/inspection-occurrences${scoped}`);
    const entries = list.entries as readonly Record<string, unknown>[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.occurrenceId, occurrenceId);
    assert.equal(entries[0]?.state, 'settled');
    assert.equal(entries[0]?.outcome, 'unknown');
    assert.deepEqual((entries[0]?.items as readonly Record<string, unknown>[]).map((item) =>
      [item.checkId, item.state]), [['check-a', 'completed'], ['check-b', 'missing']]);
    const checkA = (entries[0]?.items as readonly Record<string, unknown>[])
      .find((item) => item.checkId === INSPECTION_CHECK_A.checkId);
    assert.equal(checkA?.judgment, INSPECTION_TURN_TWO_JUDGMENT);
    assert.equal(checkA?.resultRef, `inspection-result:${invocationId}`);
    const detail = await read(`${taskPath}/inspection-occurrences/${encodeURIComponent(occurrenceId)}${scoped}`);
    assert.deepEqual(requireRecord(detail.entry, 'the cold occurrence detail').items, entries[0]?.items);
    await read(`${taskPath}/inspection-occurrences${scoped}`);
    assert.deepEqual(await readFile(fixture.layout.organJournalPath), organJournalBytes,
      'fresh durable reads append no Organ Journal record');
    assert.deepEqual(await readFile(fixture.layout.preparedJournalPath), preparedJournalBytes,
      'fresh durable reads append no prepared Journal record');
    assert.equal(fixture.upstream.wires.filter((wire) => wire.method === 'POST').length, postsBeforeReader,
      'fresh durable reads issue no Provider POST');
    assert.equal(fixture.upstream.inspectionInvocations().length, invocationsBeforeReader,
      'fresh durable reads issue no inspection child invocation');
    console.log('native opened inspection public stop evidence', JSON.stringify({
      fixture: fixture.root, startReceiptOperationId, heldParentOperationId, occurrenceId,
      stoppedCheckpoint: stoppedCheckpointRef,
      settlement: settlementRef, close: { commitId: closingEntry.journal.commitId,
        journalSeq: closingEntry.journal.seq, recordDigest: closingEntry.journal.recordDigest },
      coldBasis: row.basis, unchangedPosts: postsBeforeReader,
    }));
    passed = true;
  } catch (error) {
    console.error(`opened inspection stop fixture retained: ${fixture.root}`);
    console.error(`opened inspection stop evidence: ${JSON.stringify({
      plannerPosts: fixture.upstream.wires.filter((wire) => plannerPayload(wire.body) !== undefined).length,
      posts: fixture.upstream.wires.filter((wire) => wire.method === 'POST').length,
      invocations: fixture.upstream.inspectionInvocations(),
    })}`);
    throw error;
  } finally {
    releaseInspection.resolve();
    if (readerServe !== undefined) await readerServe.stop();
    if (serve !== undefined) await serve.stop();
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
  }
});

// Failure basis: the composition does not persist the accepted plan in the
// new-turn binding, so cold recovery can select the latest plan instead of the
// original one. Probability: unknown. Impact: recovery may use the wrong plan.
// Cost: assertions on the existing three-turn CLI/cold-resume fixture.
if (!coldConsumerMode) test('native three-turn public consumer cold-resumes interrupted third turn', async () => {
  let heldWireIndex = -1;
  let fixture!: Awaited<ReturnType<typeof textOnlyFixture>>;
  fixture = await textOnlyFixture(false, true, false, 3, undefined, async () => {
    heldWireIndex = fixture.upstream.wires.length - 1;
  });
  let passed = false;
  try {
    const started = await startNativeMultiTurnConsumer(fixture, 3);
    const outcome = await runHeldColdConsumer({ fixture, started, heldWireIndex: () => heldWireIndex });
    assert.equal(outcome.seed.signal, 'SIGTERM');
    assert.equal(fixture.upstream.interruptedThirdTurn(), true,
      'the controlled upstream held exactly the interrupted third-turn request');
    assert.equal(fixture.upstream.turnThreeHeld(), true);
    assert.equal(outcome.interruption.recovery.status, 'initial-open');
    assert.ok(outcome.interruption.binding.admittedTurn.turnId.length > 0);
    assert.equal(outcome.interruption.current.state, 'known',
      'the interruption leaves an actual typed current-state record');
    assert.equal(outcome.receipt.binding.operationId, outcome.interruption.operationId.value);
    assert.equal(outcome.receipt.planner.decision, 'complete');
    const plans = new TaskPlanRevisionConsumer(new JsonlTaskPlanRevisionJournal(fixture.journal));
    const published = [...await plans.replay(outcome.interruption.taskScope)]
      .sort((left, right) => left.sequence - right.sequence);
    assert.ok(published.length >= 3, 'the three-turn run publishes three accepted plans');
    const accepted = await Promise.all(published.map(async (revision) => ({
      revisionId: revision.revisionId,
      revisionCommitRef: await plans.getCommitRef(outcome.interruption.taskScope, revision.revisionId),
    })));
    const durableDuties = await createJsonlClosedTurnPlannerCallJournal({ journal: fixture.journal })
      .readTaskDuties(outcome.interruption.taskScope);
    const completedParentOperationIds = durableDuties
      .flatMap((entry) => entry.returned === undefined ? [] : [entry.returned.record.duty.scope.operationId])
      .flatMap((operationId) => operationId === undefined ? [] : [operationId.value]);
    const parentOperationIds = new Set<string>([
      outcome.interruption.operationId.value,
      ...completedParentOperationIds,
    ]);
    assert.equal(parentOperationIds.size, 3,
      'durable closed-turn duties identify the two completed parent turns and the interrupted third turn');
    const allBindings = [...outcome.interruption.bindings]
      .sort((left, right) => left.commitRef.journalSeq - right.commitRef.journalSeq);
    assert.equal(allBindings.length, 4,
      'the fixture retains the same-Task child binding alongside the three parent logical bindings');
    const bindings = allBindings.filter((entry) => entry.binding.scope.operationId !== undefined
      && parentOperationIds.has(entry.binding.scope.operationId.value));
    assert.equal(bindings.length, 3, 'the interrupted run opens one binding for each logical turn');
    assert.equal(bindings[0]!.binding.acceptedPlan, undefined,
      'the initial turn has no formal current plan to accept');
    assert.deepEqual(bindings[1]!.binding.acceptedPlan, accepted[0],
      'the second turn persists the first turn plan publication and exact receipt');
    assert.deepEqual(bindings[2]!.binding.acceptedPlan, accepted[1],
      'the third turn persists the successor plan publication and exact receipt');
    const resumedBindings = [...await listTaskActiveTurnBindings({
      journal: fixture.journal,
      scope: outcome.interruption.taskScope,
    })];
    const originalThird = resumedBindings.find((entry) =>
      entry.binding.admittedTurn.turnId === outcome.interruption.businessTurnId);
    assert.deepEqual(originalThird?.binding.acceptedPlan, accepted[1],
      'cold resume retains the exact plan accepted by the original third turn');
    const currentAfterResume = await createJsonlRuntimeTaskCurrentStateJournal({
      journal: fixture.journal,
    }).read(outcome.interruption.taskScope);
    assert.equal(currentAfterResume.state, 'known');
    if (currentAfterResume.state !== 'known') throw new Error('the resumed task has no current state');
    assert.equal(currentAfterResume.value.currentPlan?.revisionId, outcome.receipt.planner.revisionId,
      'the completing successor plan advances task currentPlan');
    assert.ok(currentAfterResume.value.currentPlan?.revisionId
      !== originalThird?.binding.acceptedPlan?.revisionId,
    'the latest currentPlan does not overwrite the original turn binding');
    console.log('cold consumer evidence', JSON.stringify({
      seedPid: started.child.pid,
      resumePid: outcome.resumedPid,
      heldWireIndex,
      resumedWireIndex: outcome.resumedWireIndex,
      operationId: outcome.interruption.operationId.value,
      businessTurnId: outcome.interruption.businessTurnId,
      allocation: outcome.receipt.allocation,
      successor: outcome.receipt.successor,
      planner: outcome.receipt.planner,
      acceptedEffectCount: outcome.acceptedEffectCount,
      fixture: fixture.root,
    }));
    passed = true;
  } finally {
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
    else console.error(`cold consumer fixture retained: ${fixture.root}`);
  }
});

if (!coldConsumerMode) test('native text-only delivery advertised end, independent Planner closure and exact asset readback', async () => {
  const fixture = await textOnlyFixture(false, true);
  const cli = consumerCliEntry();
  const organId = id('organ', 'humanagent-ui');
  const retainedTaskId = id('task', 'native-text-only-retained');
  const controlFile = join(fixture.root, 'control-session.txt');
  let passed = false;
  try {
    // Blood-component guard stays on the admitted turn: the advertised wire
    // tool must carry deliveryText, while deliveryRefs may be empty for a
    // text-only delivery. The underlying control schema keeps the same pair.
    const advertised = ADVERTISED_STANDARD_TURN_END_TOOL.inputSchema as unknown as JsonSchemaProperties;
    assert.equal(advertised.properties.deliveryText?.type, 'string');
    assert.equal(advertised.properties.deliveryRefs?.minItems, undefined, 'text-only delivery must not require refs');
    assert.deepEqual(advertised.properties.summary?.required,
      ['goal', 'actions', 'result', 'expectedNextStep']);
    const underlying = STANDARD_TURN_END_TOOL.inputSchema as unknown as JsonSchemaProperties;
    assert.equal(underlying.properties.deliveryText?.type, 'string');
    assert.equal(underlying.properties.deliveryRefs?.minItems, undefined);

    // Real fixture-owned A1 credential and paired control session.
    const access = await AccessControlService.open({ credentialPath: fixture.paths.webAccessCredentialPath, create: true });
    const challenge = await access.issuePairingChallenge();
    const session = await access.consumePairingCode(challenge.code);
    const cookie = access.sessionCookie(session).split(';')[0]!;
    await writeFile(controlFile, `${cookie}\n`, 'utf8');
    const caller = await access.verifyProductPrincipal(cookie);
    assert.equal(caller.state, 'valid');
    if (caller.state !== 'valid') throw new Error('fixture caller principal unavailable');

    const preparedJournal = new UiRuntimeJournal(fixture.layout.preparedJournalPath);
    const seedCoordinator = new RuntimeTaskCoordinator({
      organId,
      taskIdPrefix: 'native-text-only',
      journal: preparedJournal,
      checkpointStoreFor: () => new FileCheckpointStore(join(fixture.layout.modeRoot, 'seed-checkpoint.jsonl')),
      attentionPort: {
        async publish(value) { return { attentionId: value.attentionId, delivered: true }; },
        async resolve(value) { return { attentionId: value.attentionId, delivered: true }; },
      },
      async createDriver() { throw new Error('seed coordinator never releases execution'); },
    });
    const retained = seedCoordinator.createTask({ taskId: retainedTaskId,
      title: 'native text-only task', directive: 'run the native text-only task' });
    const taskIdentity = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal));
    const grants = new JsonlTaskGrantJournal(fixture.journal);
    await taskIdentity.establish({ scope: { organId, taskId: retained.taskId }, source: {
      requirementId: `requirement:${retained.taskId.value}`, inputRevision: 1,
      draftId: `draft:${retained.taskId.value}`, draftRevisionVersion: 1,
      draftRevisionHash: `draft-hash:${retained.taskId.value}`, confirmationRef: `confirmation:${retained.taskId.value}`,
    } });
    await grants.grant({ requestId: `grant:${retained.taskId.value}`, taskId: retained.taskId,
      owner: caller.principal.owner,
      capability: { actionId: 'task.execute', capabilities: ['provider.execution'], scope: { organId, taskId: retained.taskId } },
      expectedRevision: 0 });

    const runArgs = ['run', '--workspace', fixture.workspace, '--control-root', fixture.controlRoot,
      '--plan', 'default', '--session', 'native-text-only-run', '--task', retained.taskId.value,
      '--prompt', 'text-only delivery probe', '--control-session-file', controlFile];
    const run = () => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...runArgs], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });

    const result = await run();
    assert.equal(result.code, 0, `native text-only run must succeed: ${result.stderr}`);
    const receiptStart = result.stdout.indexOf('{');
    const receiptEnd = result.stdout.lastIndexOf('}');
    assert.ok(receiptStart >= 0 && receiptEnd > receiptStart, `the native run prints its receipt: ${result.stdout}`);
    const receipt = JSON.parse(result.stdout.slice(receiptStart, receiptEnd + 1)) as {
      readonly command?: string; readonly taskId?: string; readonly state?: string;
      readonly output?: string;
      readonly error?: {
        readonly code?: string; readonly message?: string;
        readonly cleanupError?: { readonly code?: string; readonly message?: string };
      };
      readonly terminal?: { readonly phase?: string; readonly status?: string };
    };
    assert.equal(receipt.command, 'run');
    assert.equal(receipt.taskId, retained.taskId.value);
    if (receipt.state !== 'succeeded') {
      console.log('native text-only failure receipt', JSON.stringify(receipt));
    }
    const receiptState = receipt.state;

    const posts = () => fixture.upstream.wires.filter((wire) => wire.method === 'POST');
    const plannerPosts = () => posts().filter((wire) => plannerPayload(wire.body) !== undefined);
    const executionPosts = () => posts().filter((wire) => plannerPayload(wire.body) === undefined);
    assert.equal(executionPosts().length, 7, 'parent call/adopt/end/drain and independent child delivery/end/drain');
    assert.equal(plannerPosts().length, 1, 'the complete sample uses one independent Planner request');
    assert.equal(posts().length, 8, 'seven execution requests and one independent Planner request');
    const postsBeforeCold = posts().length;
    // The real wire carries the advertised schema under the transport-legal id,
    // not only the underlying dotted control id.
    const firstPost = executionPosts()[0];
    assert.ok(firstPost, 'the native run sends its real generation request');
    const sent = JSON.parse(firstPost.body) as {
      readonly tools?: readonly { readonly name?: string; readonly parameters?: {
        readonly properties?: Record<string, { readonly type?: string; readonly minItems?: number }>;
      } }[];
    };
    const advertisedWire = sent.tools?.find((tool) => tool.name === 'humanagent_turn_end' && tool.parameters);
    assert.ok(advertisedWire, 'the generation request advertises the standard-turn end wire tool');
    for (const name of ['child_call', 'child_adopt', 'child_not_select']) {
      assert.ok(sent.tools?.some((tool) => tool.name === name), `default composition advertises ${name}`);
    }
    if (!advertisedWire) throw new Error('advertised wire tool is absent');
    assert.equal(advertisedWire.parameters?.properties?.['deliveryText']?.type, 'string');
    assert.equal(advertisedWire.parameters?.properties?.['deliveryRefs']?.minItems, undefined);
    const plannerWire = plannerPosts()[0];
    assert.ok(plannerWire, 'the complete sample sends its real independent Planner request');
    const plannerRequest = plannerPayload(plannerWire.body);
    if (!plannerRequest) throw new Error('the Planner request carries the whole-task business payload');
    assert.equal(plannerRequest.role, 'planner');
    assert.equal(plannerRequest.priorPlan, null);
    assert.equal(typeof requireRecord(plannerRequest.task, 'the task').title, 'string');
    assert.ok(Array.isArray(plannerRequest.refinedResults));
    assert.equal(declaresTurnEnd(plannerWire.body), false, 'the Planner request is not an execution replay');
    // The real Planner wire must declare the complete TaskPlanSnapshot contract,
    // not a placeholder. This is the exact gap that blocked the live Task.
    assertPlannerContractComplete(plannerRequest);
    // The real non-conforming live reply stays rejected by the existing
    // validator; a corrected reply must never substitute for the original sample.
    assert.throws(
      () => validateTaskPlanSnapshot((JSON.parse(REAL_LIVE_REJECTED_REPLY) as { readonly snapshot: never }).snapshot),
      /task plan title must be a non-empty string/,
    );

    // Actual accepted end-call provenance, bound through the real active-turn
    // journal. The raw arguments asset is the exact materialization App owns.
    const verified = await fixture.journal.verify();
    // Observed three App constants mislabeled accepted tool closure as control.
    // Impact: valid empty business refs cannot close. Cost: three exact reads
    // in this existing public consumer; no additional fixture or request.
    const intentRecord = verified.records.find((record) => record.payload?.['type'] === 'native-save-intent');
    if (!intentRecord) throw new Error('text-only delivery must commit its native save intent');
    const intent = (intentRecord.payload?.['intent'] as { readonly completeIntent: NativeSaveIntent }).completeIntent;
    assert.equal(intent.closure.source, 'agent-tool', 'native intent preserves the accepted tool source');
    const closurePort = createJsonlCheckpointClosurePort({ filePath: fixture.layout.organJournalPath, journal: fixture.journal });
    const closure = await closurePort.read(intent.closure.closureId);
    if (!closure || !('closureKind' in closure) || closure.closureKind !== 'checkpoint') throw new Error('canonical checkpoint closure is required');
    assert.equal(closure.source, 'agent-tool', 'canonical closure preserves the accepted tool source');
    const preparation = await readCheckpointClosurePreparation(closurePort, intent.checkpoint.checkpoint);
    assert.equal(preparation?.coreClosure.source, 'agent-tool', 'preparation preserves the same accepted tool source');
    const coverage = verified.records
      .find((record) => record.payload?.['kind'] === 'operation-control-coverage/v1');
    const scope = coverage?.scope as ScopeRef;
    const operationId = scope?.operationId?.value;
    if (!operationId) throw new Error('native run has admitted operation coverage');
    // The real child commits its own control chain through the existing
    // Gateway owner. A refined result without durable child control is not
    // acceptance, and the terminal state must come from the actual controller.
    type ControlEnvelopePayload = {
      readonly kind: string;
      readonly event: { readonly kind: string };
      readonly control: {
        readonly status: string;
        readonly intent: { readonly operationId: { readonly scope: 'operation'; readonly value: string } };
        readonly binding: {
          readonly scope: ScopeRef;
          readonly agentRuntimeId: string;
          readonly harnessExecutionEpoch: number;
        };
        readonly childAdmission?: {
          readonly businessRegistrationCommitRef: {
            readonly commitId: string;
            readonly journalSeq: number;
            readonly recordDigest: string;
          };
        };
      };
    };
    const controlEnvelopes = verified.records.flatMap((record): ControlEnvelopePayload[] => {
      const payload = record.payload as ControlEnvelopePayload | undefined;
      return payload?.kind === 'operation-control-envelope/v1'
        && payload.control.childAdmission !== undefined ? [payload] : [];
    });
    assert.equal(controlEnvelopes.length, 3,
      'the real child commits accepted, running and terminal control');
    assert.deepEqual(controlEnvelopes.map((entry) => entry.control.status),
      ['accepted', 'running', 'succeeded'],
      'child control follows the actual controller lifecycle');
    const childControl = controlEnvelopes.at(-1)!;
    assert.equal(childControl.event.kind, 'operation.completed');
    assert.ok(childControl.control.intent.operationId.value.startsWith('child-'),
      'child control carries the real child operation identity');
    const childAdmission = childControl.control.childAdmission!;
    const childRegistrationRecord = verified.records.find((record) =>
      record.payload?.['kind'] === 'task-business-registration'
      && record.commitId === childAdmission.businessRegistrationCommitRef.commitId);
    assert.ok(childRegistrationRecord, 'child control cites the real durable business registration');
    const childProvenance = (childRegistrationRecord!.payload as {
      readonly registration?: { readonly operationProvenance?: {
        readonly kind?: string;
        readonly parentOperationId?: { readonly value?: string };
      } };
    }).registration?.operationProvenance;
    assert.equal(childProvenance?.kind, 'provider-tool');
    assert.equal(childProvenance?.parentOperationId?.value, operationId,
      'child control registration joins the exact parent operation');
    // Fresh reader: a new Journal instance must read the committed child
    // control, not an in-process copy.
    const freshControl = createJsonlOperationControlJournal({
      journal: new JsonlOrganJournal(fixture.layout.organJournalPath),
    });
    const freshChildReadback = await freshControl.readControl({
      scope: childControl.control.binding.scope,
      agentRuntimeId: childControl.control.binding.agentRuntimeId,
      harnessExecutionEpoch: childControl.control.binding.harnessExecutionEpoch,
      operationId: childControl.control.intent.operationId,
    });
    assert.equal(freshChildReadback.state, 'complete',
      'fresh reader reads the committed child control');
    if (freshChildReadback.state !== 'complete') throw new Error('fresh child control read is unknown');
    assert.equal(freshChildReadback.operations.length, 1);
    assert.equal(freshChildReadback.operations[0]?.status, 'succeeded');
    assert.equal(freshChildReadback.operations[0]?.result?.status, 'succeeded');
    assert.deepEqual(freshChildReadback.operations[0]?.childAdmission, childAdmission);
    const active = await createJsonlActiveTurnJournal({ filePath: fixture.layout.organJournalPath,
      journal: fixture.journal, turnId: newActiveTurnId(operationId) }).replay();
    const endCalls = active.filter(
      (record): record is Extract<ActiveTurnJournalRecord, { kind: 'accepted-fact' }> =>
        record.kind === 'accepted-fact'
        && record.entry.envelope.fact.kind === 'tool-call'
        && record.entry.envelope.fact.call.toolId === 'humanagent_turn_end',
    );
    assert.equal(endCalls.length, 1, 'exactly one actual text-only end call is accepted');
    const endCall = endCalls[0];
    if (!endCall) throw new Error('no accepted text-only end call');
    const fact = endCall.entry.envelope.fact;
    if (fact.kind !== 'tool-call') throw new Error('accepted end fact is not a tool call');
    assert.equal(fact.call.toolId, 'humanagent_turn_end');
    assert.equal(fact.call.callId, 'call-text-end');
    assert.ok(endCall.entry.envelope.request.requestId.length > 0,
      'the accepted end call carries its real request identity');
    assert.ok(endCall.entry.envelope.execution.runtimeId.length > 0,
      'the accepted end call carries its real execution runtime identity');
    assert.ok(Number.isSafeInteger(endCall.entry.envelope.execution.executionEpoch)
      && endCall.entry.envelope.execution.executionEpoch > 0,
      'the accepted end call carries its real execution epoch');
    assert.equal(fact.rawArguments.ref.source, 'humanagent.provider-adapter');
    assert.equal(fact.rawArguments.ref.scope.taskId?.value, retained.taskId.value);
    console.log('trusted end identity', JSON.stringify({
      requestId: endCall.entry.envelope.request.requestId,
      callId: fact.call.callId,
      runtimeId: endCall.entry.envelope.execution.runtimeId,
      executionEpoch: endCall.entry.envelope.execution.executionEpoch,
    }));

    // Exact read over the existing ImmutableAssetStore, using the deterministic
    // raw-arguments view; the parsed body must differ from every summary part.
    const evidenceRoot = join(fixture.paths.artifactsRoot, 'ui-provider-evidence');
    const rawRead = providerRawContentReader(filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot)));
    const argumentsBytes = await rawRead.read({ scope: endCall.entry.envelope.scope, content: fact.rawArguments });
    const argumentsJson = new TextDecoder('utf-8', { fatal: true }).decode(argumentsBytes);
    const parsedArgs = JSON.parse(argumentsJson) as {
      readonly deliveryText?: string; readonly deliveryRefs?: readonly string[];
      readonly summary?: { readonly result?: { readonly text?: string }; readonly goal?: { readonly text?: string } };
    };
    assert.equal(parsedArgs.deliveryText, EXACT_BODY);
    assert.deepEqual(parsedArgs.deliveryRefs, []);
    assert.equal(parsedArgs.deliveryText !== parsedArgs.summary?.result?.text, true,
      'the exact body is not the summary result text');
    assert.equal(parsedArgs.deliveryText !== parsedArgs.summary?.goal?.text, true,
      'the exact body is not a summary section text');

    // The standalone immutable delivery body: the accepted `deliveryText` must
    // be materialized through the existing asset owner as its own body, and the
    // canonical turn tail must consume it. A raw-arguments read alone does not
    // prove the body was published; the drain text in `output` is the visible
    // counterexample this block rejects.
    const bodyBytes = Buffer.from(EXACT_BODY, 'utf8');
    const bodyDigest = createHash('sha256').update(bodyBytes).digest('hex');
    const standaloneBodies: { readonly name: string; readonly bytes: Uint8Array }[] = [];
    for (const name of await readdir(evidenceRoot)) {
      if (name.startsWith('.')) continue;
      const bytes = await readFile(join(evidenceRoot, name));
      if (bytes.length === bodyBytes.length
        && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === EXACT_BODY) {
        standaloneBodies.push({ name, bytes: new Uint8Array(bytes) });
      }
    }
    assert.equal(standaloneBodies.length, 1,
      'exactly one standalone immutable delivery body is published');
    const standaloneBody = standaloneBodies[0]!;
    assert.ok(standaloneBody.name.includes('standard-turn-delivery-text'),
      `the standalone body is the delivery-text asset: ${standaloneBody.name}`);
    assert.ok(standaloneBody.name !== fact.rawArguments.ref.evidenceId.value,
      'the standalone body is a distinct asset from the accepted raw arguments');
    assert.equal(standaloneBody.bytes.length, 46, 'the standalone body is exactly 46 bytes');
    assert.equal(createHash('sha256').update(standaloneBody.bytes).digest('hex'), bodyDigest,
      'the standalone body digest is the SHA-256 of the exact bytes');
    console.log('standalone delivery body', JSON.stringify({
      assetId: standaloneBody.name,
      bodyBytes: standaloneBody.bytes.length,
      digest: `sha256:${bodyDigest}`,
      distinctFromRawArguments: standaloneBody.name !== fact.rawArguments.ref.evidenceId.value,
    }));

    // The CLI success receipt is the public result the user sees. It must be
    // the actual committed delivery text, never the Provider drain.
    assert.equal(receipt.output, EXACT_BODY,
      `the native run publishes the exact delivery text, not a process drain: ${JSON.stringify(receipt.output)}`);

    // Transport completion and a final event are not Task success. The same
    // consumer must reach the Core-owned succeeded disposition with no error
    // or cleanup failure, and only after the exact body is committed.
    assert.equal(receipt.state, 'succeeded',
      `native text-only run must reach Core success: ${result.stderr} ${JSON.stringify(receipt.error)}`);
    assert.equal(receipt.terminal?.phase, 'final');
    assert.equal(receipt.error, undefined);

    // The canonical public-output publication, read back through the same store
    // class the CLI and the public GET both bind. The binding comes from the
    // real accepted end call (its scope and execution epoch), never from a name
    // or a log line. This asserts the committed identity the served GET must
    // return, so the CLI success and the public read are tied to one durable
    // commit rather than two independent claims.
    const publicationBinding = {
      scope: endCall.entry.envelope.scope as ScopeRef,
      executionEpoch: endCall.entry.envelope.execution.executionEpoch,
    };
    const publication = await readCanonicalPublication(fixture.layout, publicationBinding);
    assert.equal(publication.state, 'committed', 'the accepted delivery reaches the committed public-output state');
    const exactCommits = publication.commits.filter((commit) => commit.text === EXACT_BODY);
    assert.equal(exactCommits.length, 1, 'exactly one canonical public commit carries the exact delivery text');
    const publicCommit = exactCommits[0]!;
    assert.match(publicCommit.ref.commitId, /^public-output:[0-9a-f]{64}$/,
      'the canonical commit id is the real deterministic delivery identity');
    assert.ok(Number.isSafeInteger(publicCommit.ref.journalSeq) && publicCommit.ref.journalSeq > 0,
      'the canonical commit carries its real Journal sequence');
    assert.match(publicCommit.ref.recordDigest, /^sha256:[0-9a-f]{64}$/,
      'the canonical commit carries its real Journal record digest');
    assert.equal(publicCommit.ref.sourceId.startsWith('standard-turn-delivery:'),
      true, 'the canonical commit source is the real accepted end call, not a Provider event or summary');
    assert.equal(publication.publicCommitWatermark, publicCommit.ref.journalSeq,
      'the publication watermark is the committed record itself');

    // The same operation also commits a typed Task current-state after the
    // waiting closing checkpoint. The read uses the same canonical Journal
    // reader the serialization owner already owns, so this is the exact
    // committed fact, not an event or metadata inference.
    const journalBytesBeforePublicGet = await readFile(fixture.layout.organJournalPath);
    const currentStateJournal = createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal });
    const currentState = await currentStateJournal.read(endCall.entry.envelope.scope as ScopeRef);
    assert.equal(currentState.state, 'known',
      'the same operation committed a typed Task current-state after the waiting closing checkpoint');
    if (currentState.state !== 'known') throw new Error('the typed Task current-state is absent');
    assert.equal(currentState.value.task.id.value, retained.taskId.value,
      'the committed current-state belongs to the same retained task');
    assert.equal(currentState.value.task.state, 'succeeded',
      `the committed terminal current-state accepts the task success: ${currentState.value.task.state}`);
    assert.ok(currentState.value.currentPlan,
      'the aligned terminal current-state carries the accepted whole-task plan');
    assert.equal(currentState.value.processing.entryPhase, 'aligned',
      'the terminal current-state was committed after Planner alignment');

    // The real public GET. The product's own compiled `serve` entry is started
    // against the identical fixture control root, credential and task, and the
    // task dashboard is read over HTTP with that fixture's session cookie. The
    // settled task must be served as it was committed; the GET may not
    // regenerate or resume execution, so the Provider POST count cannot move.
    const postsBeforePublicGet = posts().length;
    let servedDashboard: Record<string, unknown> | undefined;
    const serve = await startServe({ controlRoot: fixture.controlRoot, workspace: fixture.workspace });
    try {
      const response = await fetch(
        `${serve.origin}/api/tasks/${encodeURIComponent(retained.taskId.value)}/dashboard`,
        { headers: { cookie, accept: 'application/json' } },
      );
      assert.equal(response.status, 200, 'the public task dashboard GET succeeds over the real serve entry');
      const dashboard = await response.json() as {
        readonly state?: string;
        readonly output?: string;
        readonly publicOutput?: PublicOutputPublicationView;
        readonly checkpoint?: { readonly outcome?: string };
        readonly error?: { readonly code?: string };
      };
      servedDashboard = dashboard;
      assert.equal(dashboard.output, EXACT_BODY,
        `the served public result is the exact committed delivery text: ${JSON.stringify(dashboard.output)}`);
      assert.equal(dashboard.publicOutput?.state, 'committed');
      const servedCommits = (dashboard.publicOutput?.commits ?? []).filter((commit) => commit.text === EXACT_BODY);
      assert.equal(servedCommits.length, 1, 'the served publication carries the exact delivery text once');
      const servedCommit = servedCommits[0]!;
      assert.equal(servedCommit.commitId, publicCommit.ref.commitId,
        'the served GET returns the same canonical commit id as the durable read');
      assert.equal(servedCommit.journalSeq, publicCommit.ref.journalSeq,
        'the served GET returns the same canonical Journal sequence');
      assert.equal(servedCommit.recordDigest, publicCommit.ref.recordDigest,
        'the served GET returns the same canonical record digest');
      assert.equal(dashboard.publicOutput?.publicCommitWatermark, publicCommit.ref.journalSeq,
        'the served GET returns the same publication watermark');
      assert.equal(dashboard.state, receiptState,
        `the served GET must serve the same Task state the CLI receipt reports; got ${JSON.stringify(dashboard.state)}`);
      assert.equal(dashboard.state, 'succeeded',
        'the public GET projects the accepted terminal task state, not the waiting closing checkpoint');
      assert.equal(dashboard.checkpoint?.outcome, 'waiting',
        'the original waiting closing checkpoint stays intact behind the terminal task state');
      const journalBytesAfterPublicGet = await readFile(fixture.layout.organJournalPath);
      assert.equal(journalBytesAfterPublicGet.length, journalBytesBeforePublicGet.length,
        'the public GET writes no canonical Journal bytes');
      assert.equal(posts().length, postsBeforePublicGet,
        'the public GET neither regenerates nor resumes the settled execution');
    } finally {
      await serve.stop();
    }

    // Archive the real receipts of this passing public GET before the fixture
    // cleanup deletes the fixture. The archived material is exactly the proof
    // this case already asserted on: the CLI success receipt, the actual served
    // dashboard body, the accepted end-call identity, the canonical public
    // commit and watermark, the Provider request counts and both delivery
    // assets. No credential, cookie, session or full configuration is copied.
    const archiveRoot = await mkdtemp(join(PERSISTENCE_ROOT, 'passed-native-public-get-r5-'));
    const archiveJson = async (name: string, value: unknown) => {
      await writeFile(join(archiveRoot, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    };
    const rawArgumentsBytes = await new ImmutableAssetStore(evidenceRoot).readEvidence(fact.rawArguments.ref);
    if (servedDashboard === undefined) {
      throw new Error('the passing public GET did not produce a dashboard body to archive');
    }
    await archiveJson('cli-run-receipt.json', receipt);
    await archiveJson('public-get-dashboard.json', servedDashboard);
    await archiveJson('accepted-end-call.json', {
      requestId: endCall.entry.envelope.request.requestId,
      toolId: fact.call.toolId,
      callId: fact.call.callId,
      runtimeId: endCall.entry.envelope.execution.runtimeId,
      executionEpoch: endCall.entry.envelope.execution.executionEpoch,
      scope: endCall.entry.envelope.scope,
    });
    await archiveJson('canonical-public-commit.json', {
      binding: publicationBinding,
      state: publication.state,
      commitRef: publicCommit.ref,
      publicCommitWatermark: publication.publicCommitWatermark,
    });
    await archiveJson('provider-request-counts.json', {
      providerPosts: posts().length,
      executionPosts: executionPosts().length,
      plannerPosts: plannerPosts().length,
      postsBeforePublicGet,
      postsAfterPublicGet: posts().length,
    });
    await archiveJson('delivery-assets.json', {
      standaloneBody: {
        assetId: standaloneBody.name,
        byteLength: standaloneBody.bytes.length,
        digest: `sha256:${createHash('sha256').update(standaloneBody.bytes).digest('hex')}`,
      },
      rawArgumentsRef: fact.rawArguments.ref,
      parsedDeliveryText: parsedArgs.deliveryText,
      deliveryRefs: parsedArgs.deliveryRefs,
    });
    // The archived byte assets are written as their exact UTF-8 text: the
    // fatal decodes below prove the bytes are valid UTF-8, so the written file
    // byte-for-byte equals `standaloneBody.bytes` and `rawArgumentsBytes`.
    const standaloneBodyText = new TextDecoder('utf-8', { fatal: true }).decode(standaloneBody.bytes);
    const rawArgumentsText = new TextDecoder('utf-8', { fatal: true }).decode(rawArgumentsBytes);
    await writeFile(join(archiveRoot, 'standalone-delivery-body.txt'), standaloneBodyText, 'utf8');
    await writeFile(join(archiveRoot, 'raw-arguments.json'), rawArgumentsText, 'utf8');
    console.log('native public GET archive', JSON.stringify({
      archiveRoot,
      canonicalCommitId: publicCommit.ref.commitId,
      canonicalJournalSeq: publicCommit.ref.journalSeq,
      canonicalRecordDigest: publicCommit.ref.recordDigest,
      publicCommitWatermark: publication.publicCommitWatermark,
      providerPosts: posts().length,
    }));

    // Cold read of the same original asset: a fresh store instance reads the
    // identical bytes and digest, with no new Provider generation.
    const coldStore = new ImmutableAssetStore(evidenceRoot);
    const coldBytes = await coldStore.readEvidence(fact.rawArguments.ref);
    assert.deepEqual(coldBytes, new Uint8Array(await coldStore.readEvidence(fact.rawArguments.ref)),
      'repeated cold read returns identical bytes');
    assert.equal(createHash('sha256').update(coldBytes).digest('hex'), fact.rawArguments.ref.digest?.replace(/^sha256:/, ''));
    assert.equal(posts().length, postsBeforeCold, 'cold asset readback adds no Provider POST');
    assert.equal(executionPosts().length, 7, 'parent and child complete through their own standard end');
    assert.equal(plannerPosts().length, 1, 'the pure-text run uses exactly one independent Planner request');
    assert.equal(posts().length, 8, 'seven execution requests and one independent Planner request');
    console.log('native text-only delivery', JSON.stringify({
      body: parsedArgs.deliveryText,
      bodyBytes: Buffer.from(EXACT_BODY, 'utf8').length,
      bodyDiffersFromSummary: parsedArgs.deliveryText !== parsedArgs.summary?.result?.text,
      acceptedEndCalls: endCalls.length,
      deliveryRefs: parsedArgs.deliveryRefs,
      executionPosts: executionPosts().length,
      plannerPosts: plannerPosts().length,
      providerPosts: posts().length,
      evidencedAssetId: fact.rawArguments.ref.evidenceId.value,
      taskState: receiptState,
      terminalPhase: receipt.terminal?.phase,
    }));
    passed = true;
  } finally {
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
  }
});

// Failure basis: the native run constructs a top-level Provider port without
// the configured credentialRef while task preparation uses a separate
// per-agent path. Impact: an actual HTTP request could lose authentication or
// silently use another source. Probability: unknown; one local CLI child and
// one local socket bind the first real request. Cost: one existing text-only
// fixture, no protocol matrix or external service.
if (!coldConsumerMode) test('default native CLI inherits top-level HTTP credential into Responses request', async () => {
  const credentialName = 'HUMANAGENT_TEST_DEFAULT_HTTP_TOKEN';
  const credentialRef = `env:${credentialName}`;
  const credentialValue = 'dummy-default-http-token';
  const fixture = await textOnlyFixture(false, false, false, undefined, {
    credentialRef,
    requiredBearer: credentialValue,
  });
  const cli = consumerCliEntry();
  const organId = id('organ', 'humanagent-ui');
  const taskId = id('task', 'native-default-http');
  const controlFile = join(fixture.root, 'control-session.txt');
  let passed = false;
  try {
    const configuredToml = await readFile(fixture.configPath, 'utf8');
    assert.match(configuredToml, /^\[provider\]\nprovider = "rcc"\nsource = "http"/m);
    assert.equal(configuredToml.includes('provider.provider'), false,
      'agents must not override the top-level Provider');
    assert.equal(configuredToml.match(/driverRef = "rcc"/g)?.length, 2,
      'the real roster selects the native driver without per-agent Provider fields');

    const access = await AccessControlService.open({
      credentialPath: fixture.paths.webAccessCredentialPath,
      create: true,
    });
    const challenge = await access.issuePairingChallenge();
    const session = await access.consumePairingCode(challenge.code);
    const cookie = access.sessionCookie(session).split(';')[0]!;
    await writeFile(controlFile, `${cookie}\n`, 'utf8');
    const caller = await access.verifyProductPrincipal(cookie);
    assert.equal(caller.state, 'valid');
    if (caller.state !== 'valid') throw new Error('fixture caller principal unavailable');

    const seed = new RuntimeTaskCoordinator({
      organId,
      taskIdPrefix: 'native-default-http',
      journal: new UiRuntimeJournal(fixture.layout.preparedJournalPath),
      checkpointStoreFor: () => new FileCheckpointStore(
        join(fixture.layout.modeRoot, 'seed-checkpoint.jsonl'),
      ),
      attentionPort: {
        async publish(value) {
          return { attentionId: value.attentionId, delivered: true };
        },
        async resolve(value) {
          return { attentionId: value.attentionId, delivered: true };
        },
      },
      async createDriver() {
        throw new Error('seed coordinator never releases execution');
      },
    });
    const retained = seed.createTask({
      taskId,
      title: 'default HTTP provider',
      directive: 'prove top-level HTTP credential inheritance',
    });
    await new TaskIdentityConsumer(
      new JsonlTaskIdentityJournal(fixture.journal),
    ).establish({
      scope: { organId, taskId: retained.taskId },
      source: {
        requirementId: `requirement:${retained.taskId.value}`,
        inputRevision: 1,
        draftId: `draft:${retained.taskId.value}`,
        draftRevisionVersion: 1,
        draftRevisionHash: `draft-hash:${retained.taskId.value}`,
        confirmationRef: `confirmation:${retained.taskId.value}`,
      },
    });
    await new JsonlTaskGrantJournal(fixture.journal).grant({
      requestId: `grant:${retained.taskId.value}`,
      taskId: retained.taskId,
      owner: caller.principal.owner,
      capability: {
        actionId: 'task.execute',
        capabilities: ['provider.execution'],
        scope: { organId, taskId: retained.taskId },
      },
      expectedRevision: 0,
    });

    const result = await new Promise<{
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        cli,
        'run',
        '--workspace', fixture.workspace,
        '--control-root', fixture.controlRoot,
        '--plan', 'default',
        '--session', 'native-default-http-run',
        '--task', retained.taskId.value,
        '--prompt', 'default HTTP credential probe',
        '--control-session-file', controlFile,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, [credentialName]: credentialValue },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Uint8Array) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk: Uint8Array) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });

    const receiptStart = result.stdout.indexOf('{');
    const receiptEnd = result.stdout.lastIndexOf('}');
    assert.ok(receiptStart >= 0 && receiptEnd > receiptStart,
      `the native run prints its CLI receipt: ${result.stdout}`);
    const receipt = JSON.parse(result.stdout.slice(receiptStart, receiptEnd + 1)) as {
      readonly command?: string;
      readonly taskId?: string;
      readonly state?: string;
      readonly output?: string;
      readonly error?: unknown;
    };
    assert.equal(result.code, 0, result.stderr);
    assert.equal(receipt.command, 'run');
    assert.equal(receipt.taskId, retained.taskId.value);
    assert.equal(receipt.state, 'succeeded', JSON.stringify(receipt));
    assert.equal(receipt.output, EXACT_BODY);
    assert.equal(receipt.error, undefined);

    const childExecutionWires = fixture.upstream.wires.filter((wire) =>
      wire.method === 'POST' && plannerPayload(wire.body) === undefined);
    const firstRequest = childExecutionWires[0];
    assert.ok(firstRequest, 'the default native CLI sends a real generation request');
    assert.equal(firstRequest.path, '/v1/responses');
    assert.equal(firstRequest.authorization, `Bearer ${credentialValue}`);
    const body = JSON.parse(firstRequest.body) as ResponsesWireBody;
    assert.equal(body.model, 'text.only.model');
    assert.equal(hasTurnEndSurface(firstRequest.body), true,
      'the request carries the Responses standard-turn end surface');
    assert.deepEqual(
      fixture.upstream.wires
        .filter((wire) => wire.path === '/health' || wire.path === '/v1/models'),
      [],
      'HTTP source must not run RCC discovery',
    );

    const verified = await fixture.journal.verify();
    const coverage = verified.records.find((record) =>
      record.payload?.['kind'] === 'operation-control-coverage/v1');
    const operationId = coverage?.scope.operationId?.value;
    if (!operationId) throw new Error('native run has admitted operation coverage');
    const active = await createJsonlActiveTurnJournal({
      filePath: fixture.layout.organJournalPath,
      journal: fixture.journal,
      turnId: newActiveTurnId(operationId),
    }).replay();
    const endCalls = active.filter((record) =>
      record.kind === 'accepted-fact'
      && record.entry.envelope.fact.kind === 'tool-call'
      && record.entry.envelope.fact.call.toolId === 'humanagent_turn_end');
    assert.equal(endCalls.length, 1,
      'the original standard-turn closure remains the only accepted end');

    console.log('default HTTP native consumer', JSON.stringify({
      cliExit: result.code,
      receiptState: receipt.state,
      requestPath: firstRequest.path,
      authorizationMatched: firstRequest.authorization === `Bearer ${credentialValue}`,
      model: body.model,
      responsesSurface: hasTurnEndSurface(firstRequest.body),
      discoveryRequests: 0,
      acceptedEndCalls: endCalls.length,
      fixture: fixture.root,
    }));
    passed = true;
  } finally {
    await fixture.upstream.close();
    if (passed) await rm(fixture.root, { recursive: true });
    else console.error(`default HTTP fixture retained: ${fixture.root}`);
  }
});

/**
 * F2 failure-mode coverage for the new native execution-release edge.
 *
 * Failure probability basis: the edge is new and no existing consumer covers
 * a failing release publication (actual missing edge; real-world frequency
 * unknown). Impact: without the guard the execution would be released, a
 * Provider request would start, and the run would only fail later at closure.
 * Cost: one in-process coordinator case, no CLI child and no upstream.
 *
 * A native standard turn cannot be released before its Runtime-owned
 * current-state transition is committed. With no current-state port bound the
 * release boundary must refuse to release and must not start the model.
 */
if (!coldConsumerMode) test('native standard-turn release refuses and never starts the model when the current-state port is unbound', async () => {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, 'release-guard-'));
  let started = 0;
  const unreachable = (step: string): never => {
    throw new Error(`native release guard: ${step} must not be reached before current-state publication`);
  };
  const driver: RuntimeExecutionDriver = {
    kind: 'native-release-guard-driver',
    standardTurn: {
      async acceptReviews() {},
      async readCheckpoint() { return unreachable('readCheckpoint'); },
      async align() { return unreachable('align'); },
    },
    async capabilities() {
      return { driverKind: 'native-release-guard-driver', capabilities: [], version: 'release-guard' };
    },
    async start() { started += 1; return unreachable('start'); },
    async resume() { return unreachable('resume'); },
    async submit() { started += 1; return unreachable('submit'); },
    async *observe() { unreachable('observe'); },
    async requestStop() { return unreachable('requestStop'); },
    async settle() { return unreachable('settle'); },
    async close() { return unreachable('close'); },
  };
  try {
    const coordinator = new RuntimeTaskCoordinator({
      organId: id('organ', 'humanagent-ui'),
      taskIdPrefix: 'release-guard',
      journal: new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl')),
      checkpointStoreFor: () => new FileCheckpointStore(join(root, 'checkpoint.jsonl')),
      attentionPort: {
        async publish(value) { return { attentionId: value.attentionId, delivered: true }; },
        async resolve(value) { return { attentionId: value.attentionId, delivered: true }; },
      },
      admitExecution: async () => {},
      createDriver: async () => driver,
      // The current-state port is deliberately unbound: the release boundary
      // must refuse to release instead of starting a Provider.
    });
    const task = coordinator.createTask({ title: 'release guard task', directive: 'run the release guard task' });
    const allocation = coordinator.prepareExecution(task.taskId, { prompt: 'release guard probe' });
    await assert.rejects(
      async () => coordinator.releaseExecution(task.taskId, allocation.operationId),
      (error: unknown) => {
        assert.equal((error as { readonly code?: string }).code, 'runtime.current-state.release-port-unknown');
        return true;
      },
    );
    assert.equal(started, 0, 'the model must not start when current-state publication fails');
    const snapshot = coordinator.taskSnapshot(task.taskId);
    assert.equal(snapshot.state, 'blocked');
    assert.equal(snapshot.error?.code, 'runtime.current-state.release-port-unknown');
    assert.equal(snapshot.allowedActions.includes('start'), false);
    assert.equal(snapshot.events.some((event) => event.kind === 'execution.started'), false,
      'a refused release must not report execution.started');
  } finally {
    await rm(root, { recursive: true });
  }
});

if (coldConsumerMode) {
  await runColdConsumerChild();
  (process as unknown as { exit(code?: number): never }).exit(0);
}
