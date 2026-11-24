import assert from 'node:assert/strict';
import test from 'node:test';
import { id, type ActiveTurnBinding, type ChildInvocationRecord, type EvidenceRef, type ProviderRawFact } from '../../packages/contracts/src/index.js';
import {
  childToolEventRecords,
  childToolSources,
  type ChildToolReadSource,
} from '../../packages/app/src/ui-runtime/child-tool-read.js';

// Failure risk: a child operation can share task, epoch, and even a callId with
// another operation. Probability: confirmed by the child.call assignment shape.
// Impact: the public reader pairs a result with the wrong child identity.
// Cost: one typed fixture; no journal or process is started.
test('child tool reads bind facts to the exact committed child turn', () => {
  const taskId = id('task', 'task');
  const operationId = id('operation', 'child-operation');
  const assignmentId = 'child-assignment';
  const runtimeId = 'child-runtime';
  const invocationId = 'invocation:child:test';
  const childTurnId = 'active-turn-child-operation';
  const scope = { organId: id('organ', 'organ'), taskId, cycleId: id('cycle', 'cycle'), operationId };
  const incarnation = {
    taskId, runtimeId, generation: 1, agentInstanceId: 'child-agent', roleId: 'execution',
    assignmentId, executionEpoch: 1,
  };
  const invocation = {
    invocationId, childTurnId: invocationId, checkpointReceiptRef: 'checkpoint', binding: {
      assignment: { taskId, assignmentId, executionEpoch: 1, inputRefs: [], expectedOutputRefs: [], ownerId: 'owner' },
    }, incarnation,
  } as unknown as ChildInvocationRecord;
  const rawRef: EvidenceRef = { evidenceId: id('evidence', 'args'), kind: 'execution', source: 'test', locator: 'asset://args', scope };
  const outputRef: EvidenceRef = { evidenceId: id('evidence', 'output'), kind: 'execution', source: 'test', locator: 'asset://output', scope };
  const callFact = {
    kind: 'tool-call', call: { toolId: 'file.read', callId: 'same-call', continuationRef: 'continuation' },
    arguments: { path: 'marker.txt' }, rawArguments: { ref: rawRef },
  } as unknown as ProviderRawFact;
  const resultFact = {
    kind: 'tool-result', callId: 'same-call', continuationRef: 'continuation',
    result: {
      toolId: 'file.read', status: 'succeeded', outputRefs: [], evidenceRefs: [],
      outputRef: 'asset://provider-tool/output/marker', outputDigest: 'sha256:output', executionFact: {
        taskId, operationId, executionEpoch: 1, runtimeId, assignmentId,
      },
    }, rawOutput: { ref: outputRef },
  } as unknown as ProviderRawFact;
  const entry = (seq: number, fact: ProviderRawFact) => ({
    seq,
    envelope: { request: { requestId: 'request', turnId: childTurnId, parentRequestId: 'parent' }, fact },
  }) as any;
  const turn = (operation: string, facts: readonly ProviderRawFact[]): ChildToolReadSource => ({
    binding: {
      admittedTurn: { turnId: childTurnId, taskRef: taskId, workAssignmentRef: assignmentId, executionEpoch: 1 },
      assignment: { taskId, assignmentId, executionEpoch: 1 },
      execution: { runtimeId, executionEpoch: 1 },
      scope: { ...scope, operationId: id('operation', operation) },
    } as ActiveTurnBinding,
    records: [
      { kind: 'accepted-fact', entry: entry(1, callFact) },
      { kind: 'accepted-fact', entry: entry(2, resultFact) },
      ...facts.map((fact, index) => ({ kind: 'accepted-fact', entry: entry(10 + index, fact) } as any)),
    ],
  });
  const decoy = turn('decoy', [callFact]);
  const decoyTurn = {
    ...decoy,
    binding: {
      ...decoy.binding,
      admittedTurn: { ...decoy.binding.admittedTurn, turnId: 'another-child-turn', workAssignmentRef: 'decoy-assignment' },
      assignment: { ...decoy.binding.assignment, assignmentId: 'decoy-assignment' },
    },
  };

  const selected = childToolSources(
    [
      { kind: 'child-invocation', record: invocation },
      { kind: 'child-invocation', record: { ...invocation, adoptedResultSeq: 3 } },
    ],
    [turn('child-operation', []), decoyTurn],
    taskId.value,
  );
  assert.deepEqual(selected.map(({ turn: source }) => source.binding.scope.operationId?.value), [operationId.value]);
  const events = childToolEventRecords(selected);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.operationId === operationId.value));
  assert.equal(events[0]?.callId, 'same-call');
  assert.equal(events[1]?.callId, 'same-call');
  assert.equal(events[1]?.outputRef, 'asset://provider-tool/output/marker');
});
