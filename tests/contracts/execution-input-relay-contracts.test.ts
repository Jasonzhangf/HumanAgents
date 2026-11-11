import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  id,
  validateProductPendingDecision,
  validateStandardTurnEndPayload,
  type ProductPendingDecision,
  type ProductTargetRef,
  type StandardTurnEndPayload,
  type TaskId,
} from '@humanagent/contracts';

const organId = id('organ', 'relay-contract-organ');
const taskId = id('task', 'relay-contract-task');

function taskScope() {
  return {
    kind: 'task' as const,
    projectKey: 'relay-contract-project',
    mode: 'fake' as const,
    taskId,
  };
}

function target(): Extract<ProductTargetRef, { readonly kind: 'interaction' }> {
  return { kind: 'interaction', taskRef: taskId, scope: taskScope() };
}

test('input-required is a typed standard-turn outcome with the exact question schema reason and impact', () => {
  const payload = {
    outcome: 'input-required',
    summary: {
      goal: 'Finish the task',
      actions: ['Detect the missing fact'],
      result: { status: 'partial', text: '需要补充部署目标。' },
      nextStep: '等待用户回答后继续同一任务',
    },
    inputRequest: {
      question: '请补充部署目标。',
      schemaRef: 'humanagent://input/text/v1',
      reason: '任务缺少目标环境，无法形成可验证交付。',
      impact: '当前执行停止并等待用户回答。',
    },
    deliveryRefs: [],
  } as unknown as StandardTurnEndPayload;

  assert.doesNotThrow(() => validateStandardTurnEndPayload(payload));

  assert.throws(
    () => validateStandardTurnEndPayload({
      ...payload,
      inputRequest: { ...payload.inputRequest!, question: ' ' },
    }),
    ContractError,
  );
  assert.throws(
    () => validateStandardTurnEndPayload({
      ...payload,
      outcome: 'completed',
    }),
    ContractError,
  );
});

test('task input requests expose the formal answer action and exact revision', () => {
  type InputDecision = Extract<ProductPendingDecision, { readonly kind: 'task-input-request' }>;
  const decision = {
    kind: 'task-input-request',
    target: target(),
    request: {
      requestId: 'input-request-relay-contract',
      taskId,
      schemaRef: 'humanagent://input/text/v1',
      reason: '任务缺少目标环境。',
      impact: '当前执行等待用户回答。',
      question: '请补充部署目标。',
      turnId: 'turn-relay-contract',
      operationId: id('operation', 'execution-relay-contract'),
      executionEpoch: 1,
      expectedRevision: 0,
    },
    question: '请补充部署目标。',
    actions: ['answer'],
    state: 'waiting',
    recoveryOwner: 'humanagent.runtime',
  } as unknown as InputDecision;

  assert.doesNotThrow(() => validateProductPendingDecision(decision));
  assert.throws(
    () => validateProductPendingDecision({
      ...decision,
      request: { ...decision.request, expectedRevision: -1 },
    }),
    ContractError,
  );
});
