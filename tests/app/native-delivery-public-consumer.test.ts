import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { ensureControlLayout, loadConfiguration, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { id, validateTaskPlanSnapshot, type AnyProviderExecutionIdentityRef, type ProviderExecutionIdentityRef, type ScopeRef, type AcceptedRawFact, type StandardTurnEndCommand, type WorkAssignment, type RawContentReadPort, type EvidenceRef, type TaskId } from '../../packages/contracts/src/index.js';
import { readStandardTurnDelivery, bindAssignmentDelivery, StandardTurnDeliveryError, type InspectToolCompletionDescriptor, type StandardTurnDeliveryReadInput, type StandardTurnDeliveryReaderPort } from '../../packages/runtime/src/ui-runtime/standard-turn-delivery.js';
import { JsonlTaskGrantJournal } from '../../packages/adapters/jsonl/src/task-grants.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { createJsonlActiveTurnJournal, listTaskActiveTurnBindings } from '../../packages/adapters/jsonl/src/active-turn.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { filesystemProviderEvidenceSink, providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { UiRuntimeJournal, FileCheckpointStore } from '../../packages/app/src/ui-runtime/index.js';
import { createDefaultExecutionComposition, ServiceExecutionCheckpointStore } from '../../packages/app/src/ui-runtime/execution-composition.js';
import { startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import {
  closeAgentProvider,
  prepareAgentProvider,
  prepareExecutionAgentProvider,
  createAgentProviderPort,
} from '../../packages/app/src/agent-driver-composition.js';
import { createRccServeOrchestrationPorts } from '../../packages/app/src/serve-orchestration.js';
import { createServeRuntimeComposition } from '../../packages/app/src/serve-runtime.js';
import { createJsonlEventJournal } from '../../packages/app/src/event-journal.js';
import { createJsonlClosedTurnPlannerCallJournal } from '../../packages/app/src/ui-runtime/planner-call-journal.js';
import { createActiveTurnSegmentJournal } from '../../packages/app/src/native-recovery-assets.js';
import { JsonlOperationCompletionJournal } from '../../packages/adapters/jsonl/src/operation-completion.js';
import type { AgentRole } from '../../packages/config/src/index.js';
import type { EventBusPorts, EventPublisherRegistryPort } from '../../packages/runtime/src/events/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { createPreparedOperationBoundary } from '../../packages/app/src/prepared-operation-boundary.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import { createJsonlRetryCycleJournalPort } from '../../packages/app/src/retry-cycle-journal.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { RuntimeTaskCoordinator, type RuntimeExecutionDriver } from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { TaskIdentityConsumer } from '../../packages/runtime/src/orchestration/task-identity.js';
import type { ActiveTurnJournalRecord } from '../../packages/runtime/src/context/active-turn-journal.js';
import { newActiveTurnId } from '../../packages/runtime/src/admission/admitted-turn.js';
import { STANDARD_TURN_END_TOOL } from '../../packages/app/src/ui-runtime/standard-turn-control.js';
import { ADVERTISED_STANDARD_TURN_END_TOOL } from '../../packages/app/src/ui-runtime/standard-turn-composition.js';
import { createJsonlRuntimeTaskCurrentStateJournal } from '../../packages/app/src/runtime-current-state-journal.js';
import { createJsonlOperationControlJournal } from '../../packages/app/src/operation-control-journal.js';
import { createJsonlContextHistoryPort, createJsonlCheckpointJournal, createJsonlCheckpointClosurePort } from '../../packages/app/src/checkpoint-journal.js';
import { createAppChildCheckpointAdapter } from '../../packages/app/src/ui-runtime/child-checkpoint-adapter.js';
import { ActiveTurnContext, ActiveTurnSegmentContext } from '../../packages/runtime/src/context/active-turn-context.js';
import type { AdmittedTurn, ReviewAssignment, ReviewResult } from '../../packages/contracts/src/index.js';
import { readCheckpointClosurePreparation } from '../../packages/runtime/src/checkpoints/closure.js';
import type { NativeSaveIntent } from '../../packages/runtime/src/checkpoints/native-save-contract.js';

const coldConsumerMode = process.argv.includes('--cold-consumer');

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
const TURN_ONE_GOAL = 'Adopt the independent child result for the first turn';
const TURN_ONE_ACTIONS = 'Call the child, adopt its returned result, and close the first turn';
const TURN_ONE_RESULT = 'The child result is adopted and the first turn is closed';
const TURN_ONE_NEXT = 'Continue with the adopted child conclusion in the second turn';
const TURN_TWO_GOAL = 'Close the second standard turn from the committed first-turn checkpoint';
const TURN_TWO_ACTIONS = 'Consume the first-turn checkpoint and close the second turn';
const TURN_TWO_RESULT = 'The second-turn checkpoint is committed for the third standard turn';
const TURN_TWO_NEXT = 'Continue in the third standard turn and deliver the exact final text body';
const TURN_TWO_DELIVERY = 'Native second-turn delivery body: intermediate progress.';

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
    acceptanceCriteriaDigest: 'criteria', successCriteria: ['native checkpoint readback'], failureCriteria: [], incompleteCriteria: [],
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
    acceptanceCriteriaDigest: worker.acceptanceCriteriaDigest, subjectRefs: ['subject'], subjectDigests: ['subject-digest'],
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
  const assignment: WorkAssignment = { assignmentId: 'assignment', taskId: scope.taskId!, pipelineNodeId: 'node', attempt: 1, executionEpoch: 3, inputRevision: 1, objective: 'deliver read output', targetRefs: [], expectedOutputRefs: [], acceptanceCriteriaDigest: digest, successCriteria: [], failureCriteria: [], incompleteCriteria: [], requiredCapabilities: [], mergeGate: 'not-required' };
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
  assert.deepEqual(binding.producedArtifactDigests, [digest]);
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
    decision = multiTurnAttempt !== undefined && multiTurnAttempt < turnCount ? 'continue' : 'complete';
  } else {
    snapshot = requireRecord(requireRecord(payload.priorPlan, 'the prior plan').snapshot, 'the prior plan snapshot');
    decision = multiTurnAttempt !== undefined && multiTurnAttempt < turnCount ? 'continue' : 'complete';
  }
  const text = JSON.stringify({
    decision,
    snapshot,
    reasonText: decision === 'continue'
      ? 'the first closed turn adopted a child and requires the next standard turn'
      : 'the whole-task plan is aligned to the closed turn',
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
  readonly turnCount?: 2 | 3;
  readonly requiredBearer?: string;
  readonly interruptThirdTurnOnce?: () => Promise<void>;
}): Promise<{ readonly wires: Wire[]; readonly baseUrl: string; overlapped(): boolean;
  completedInReverse(): boolean; interruptedThirdTurn(): boolean; turnThreeHeld(): boolean; close(): Promise<void> }> {
  const wires: Wire[] = [];
  let plannerAttempts = 0;
  let readIssued = false;
  const childAEntered = deferred();
  const childBEntered = deferred();
  const finishChildB = deferred();
  let overlap = false;
  let reversedCompletion = false;
  let thirdTurnInterrupted = false;
  let holdTurnThree = false;
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
      const planner = plannerPayload(body);
      if (planner !== undefined) {
        plannerAttempts += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frame(input.inspect && input.turnCount === undefined && plannerAttempts === 1 ? [
          { type: 'response.created', response: { id: 'planner-refused' } },
          { type: 'response.output_text.done', item_id: 'planner-refused-text', text: '{}' },
          { type: 'response.completed', response: { id: 'planner-refused' } },
        ] : plannerFrames(input.model, planner, input.turnCount === undefined ? undefined : plannerAttempts,
          input.turnCount ?? 2)));
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
      if ((input.child || input.parallelChild) && !(input.turnCount !== undefined && plannerAttempts > 0)) {
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
      } : input.turnCount === 3 && plannerAttempts === 1 ? {
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
      const deliveryText = multiTurn ? (plannerAttempts === 0 ? CHILD_BODY
        : input.turnCount === 3 && plannerAttempts === 1 ? TURN_TWO_DELIVERY : EXACT_BODY) : EXACT_BODY;
      const toolCall = [
        { type: 'response.created', response: { id: 'text-end' } },
        { type: 'response.output_item.added', output_index: 0,
          item: { type: 'function_call', call_id: endCallId, name: 'humanagent_turn_end', arguments: '' } },
        { type: 'response.output_item.done', output_index: 0,
          item: { type: 'function_call', call_id: endCallId, name: 'humanagent_turn_end', arguments: JSON.stringify({
            summary: endSummary,
            ...(inspectThisTurn ? {} : { deliveryText }),
            deliveryRefs,
          }) } },
        { type: 'response.completed', response: { id: 'text-end' } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frame(toolCall));
    })().catch((error: unknown) => {
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
) {
  await mkdir(PERSISTENCE_ROOT, { recursive: true });
  const root = await mkdtemp(join(PERSISTENCE_ROOT, 'text-only-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  if (inspect) await writeFile(join(workspace, 'read-delivery.txt'), EXACT_BODY, 'utf8');
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  const layout = nativeRuntimeLayout(paths);
  await mkdir(layout.modeRoot, { recursive: true });
  const journal = new JsonlOrganJournal(layout.organJournalPath);
  const upstream = await textOnlyResponsesUpstream({ model: 'text.only.model',
    organFilePath: layout.organJournalPath, journal, inspect, child, parallelChild, turnCount,
    ...(interruptThirdTurnOnce === undefined ? {} : { interruptThirdTurnOnce }),
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
  const config = topLevelHttp === undefined ? (child ? original.replace('driverRef = "fake"', providerBlock)
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
  await writeFile(configPath, config, 'utf8');
  const configuration = await loadConfiguration(paths);
  if (topLevelHttp === undefined) {
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

async function startNativeMultiTurnConsumer(
  fixture: Awaited<ReturnType<typeof textOnlyFixture>>,
  turnCount: 2 | 3,
) {
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
  const organId = id('organ', 'humanagent-ui');
  const label = turnCount === 2 ? 'two-turn' : 'three-turn';
  const taskId = id('task', `native-${label}-consumer`);
  const controlFile = join(fixture.root, 'control-session.txt');
  const access = await AccessControlService.open({ credentialPath: fixture.paths.webAccessCredentialPath, create: true });
  const session = await access.consumePairingCode(access.createPairingChallenge(`${label}-lease`, 1).code);
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
  seed.createTask({ taskId, title: `native ${label} task`, directive: `complete the ${label} delivery` });
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

  const processChild = spawn(process.execPath, [cli,
    'run', '--workspace', fixture.workspace, '--control-root', fixture.controlRoot,
    '--plan', 'default', '--session', `native-${label}-run`, '--task', taskId.value,
    '--prompt', `${label} delivery probe`, '--control-session-file', controlFile],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
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
) {
  const started = await startNativeMultiTurnConsumer(fixture, turnCount);
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
      cwd: process.cwd(),
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
    assert.equal(receipt.pid, resumedPid);
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
  const uiRoot = coldConsumerArgument(coldConsumerUiRoot, '--ui-root');
  const { configureBuiltinPromptRoot } = await import('../../packages/app/src/index.js');
  configureBuiltinPromptRoot();
  const paths = await resolveRuntimePaths({ controlRoot, workspace });
  await ensureControlLayout(paths);
  await mkdir(join(paths.journalRoot, 'ui-runtime'), { recursive: true });
  const configuration = await loadConfiguration(paths);
  const modeRoot = join(paths.checkpointsRoot, 'ui-runtime', 'rcc');
  const controlJournalPath = join(modeRoot, 'task-control.jsonl');
  const journal = new JsonlOrganJournal(controlJournalPath);
  const preparedJournal = new UiRuntimeJournal(join(modeRoot, 'ui-runtime-journal.jsonl'));
  const configuredAgentId = configuration.effective.project?.defaultAgent
    ?? configuration.agentRoster[0]!.agentId;
  const configuredAgent = configuration.agentRoster.find((agent) => agent.agentId === configuredAgentId);
  if (configuredAgent === undefined) {
    throw new Error(`no configured agent matches the selected default ${configuredAgentId}`);
  }
  const selected = await prepareAgentProvider({
    roleId: configuredAgent.roleId,
    configuredAgentId: configuredAgent.agentId,
    agentProviderBindings: configuration.agentProviderBindings,
    legacyProvider: configuration.effective.provider,
    evidenceRoot: join(paths.artifactsRoot, 'ui-provider-evidence'),
  });
  const eventJournal = createJsonlEventJournal({ filePath: join(paths.journalRoot, 'ui-runtime', 'events.jsonl') });
  const publishers: EventPublisherRegistryPort = { async resolvePublisher() { return null; } };
  const eventBusPorts: EventBusPorts = {
    journal: eventJournal,
    publishers,
    consumers: { async resolveConsumer() { return null; } },
    externalOperations: eventJournal,
    barrierIntents: eventJournal,
  };
  const prepare = <T extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(
    selection: { readonly roleId: AgentRole; readonly configuredAgentId?: string },
  ) => prepareAgentProvider<T>({
    ...selection,
    agentProviderBindings: configuration.agentProviderBindings,
    legacyProvider: configuration.effective.provider,
    evidenceRoot: join(paths.artifactsRoot, 'ui-provider-evidence'),
  });
  const orchestrationPorts = createRccServeOrchestrationPorts({
    port: selected.port,
    binding: selected.binding,
    prepareAgentProvider: prepare,
    promptSegments: {
      review: (configuration.promptCatalog.review?.segments ?? []).map((segment) => segment.content),
    },
  });
  const serveRuntime = createServeRuntimeComposition({
    maxRuntimes: configuration.effective.execution?.maxConcurrentTasks,
    eventBusPorts,
    feedbackPorts: { journal: eventJournal, publishers },
    feedbackPublisherId: 'native-cold-consumer',
    ...orchestrationPorts,
  });
  const accessControl = await AccessControlService.open({
    credentialPath: paths.webAccessCredentialPath,
    create: false,
  });
  const cookie = (await readFile(cookieFile, 'utf8')).split('\n')[0]!.trim();
  if (cookie.length === 0) throw new Error('cold consumer cookie file is empty');
  const runtime = await startUiRuntime({
    mode: 'rcc',
    maxConcurrentTasks: configuration.effective.execution?.maxConcurrentTasks,
    accessControl,
    organId: id('organ', 'humanagent-ui'),
    binding: selected.binding,
    providerSource: selected.source,
    port: selected.port,
    checkpointRoot: join(paths.checkpointsRoot, 'ui-runtime'),
    interactionRoot: paths.mainRoot,
    evidenceRoot: join(paths.artifactsRoot, 'ui-provider-evidence'),
    projectKey: paths.projectKey,
    workspaceRoot: paths.workspaceCwd,
    uiRoot,
    host: '127.0.0.1',
    portNumber: 0,
    agentRoster: configuration.agentRoster,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: paths.projectKey,
      roleId: configuredAgent.roleId,
    },
    explicitBrainInterpreter: {
      async interpret() {
        throw new Error('cold consumer does not interpret a new explicit Brain input');
      },
    },
    runtimePaths: paths,
    runtimeComposition: {
      createTaskAssembly: serveRuntime.createTaskAssembly,
      prepareAgentProvider: prepare,
      prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({
        roleId: selection.roleId,
        ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
        agentProviderBindings: configuration.agentProviderBindings,
        legacyProvider: configuration.effective.provider,
        createPort: (binding) => createAgentProviderPort(
          binding,
          join(paths.artifactsRoot, 'ui-provider-evidence'),
        ),
      }, owner, lease),
    },
  });
  const taskId = id('task', task);
  let receipt: ColdConsumerReceipt | undefined;
  try {
    const response = await fetch(
      `${runtime.server.url}/api/tasks/${encodeURIComponent(task)}/resume`,
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
      () => runtime.service.taskDashboardWithPlan(taskId),
      (dashboard) => dashboard.state === 'succeeded' && dashboard.publicOutput?.state === 'committed',
      'the resumed task did not reach its committed public outcome',
      60_000,
    );
    assert.equal(taskFinal.operationId, operation);
    const checked = await runtime.service.taskDashboardWithPlan(taskId);
    const publicOutput = checked.publicOutput;
    if (publicOutput === undefined) throw new Error('the resumed task has no public output');
    assert.ok(publicOutput?.commits?.some((commit) => commit.text === EXACT_BODY),
      `the resumed task did not deliver the exact body: ${JSON.stringify(publicOutput)}`);
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
      pid: process.pid,
      parentPid: (process as unknown as { readonly ppid: number }).ppid,
      status: response.status,
      response: responseBody,
      task: {
        state: taskFinal.state,
        output: taskFinal.output,
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
    await runtime.close();
    await closeAgentProvider(selected);
    await serveRuntime.dispose();
    await accessControl.closeCredentialWatch();
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
  readonly fixture: Awaited<ReturnType<typeof textOnlyFixture>>;
}): Promise<{ readonly origin: string; stop(): Promise<void> }> {
  const { fixture } = input;
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
  const child = spawn(process.execPath, [
    cli, 'serve',
    '--control-root', fixture.controlRoot,
    '--workspace', fixture.workspace,
    '--port', '0',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
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
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
      child.kill('SIGTERM');
      await exited;
    },
  };
}

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
    const session = await access.consumePairingCode(access.createPairingChallenge('inspect-lease', 1).code);
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
    const cli = join(process.cwd(), 'dist/app/app/src/cli.js');
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
    const composition = createDefaultExecutionComposition({ principalOwner: caller.principal.owner,
      journal: fixture.journal, filePath: fixture.layout.organJournalPath,
      artifactsRoot: join(fixture.paths.artifactsRoot, 'ui-provider-evidence'), preparedJournal,
      resourceBoundary: createPreparedOperationBoundary(preparedJournal),
      async prepareAgentProvider() { throw new Error('boundary read must not prepare a Provider'); },
      providerOptions: {}, now: () => new Date(),
      currentState: createJsonlRuntimeTaskCurrentStateJournal({ journal: fixture.journal }),
      async publishCurrentTurnState() {}, closedTurnPlannerPool() { throw new Error('Planner remains a separate duty'); },
      taskIdentity: new TaskIdentityConsumer(new JsonlTaskIdentityJournal(fixture.journal)),
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
    const session = await access.consumePairingCode(access.createPairingChallenge('parallel-child-lease', 1).code);
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
      const processChild = spawn(process.execPath, [join(process.cwd(), 'dist/app/app/src/cli.js'),
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

// The observed failure risk is a cold reopen that loses the uncaptured Turn 3
// boundary or replays the accepted C1/C2 effects. Impact: the task cannot
// resume truthfully. Cost: one existing three-turn CLI fixture, one exact seed
// interruption, and one fresh HTTP-resume child.
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
  const cli = join(process.cwd(), 'dist', 'app', 'app', 'src', 'cli.js');
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
    const session = await access.consumePairingCode(access.createPairingChallenge('text-only-lease', 1).code);
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
    const serve = await startServe({ fixture });
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
  const cli = join(process.cwd(), 'dist/app/app/src/cli.js');
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
    const session = await access.consumePairingCode(
      access.createPairingChallenge('default-http-lease', 1).code,
    );
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
