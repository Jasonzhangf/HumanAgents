import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { id } from '../../dist/app/contracts/src/index.js'
import {
  FakeReplayExecutionRuntimePort,
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../dist/app/app/src/ui-runtime/index.js'
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js'
import { MemoryCoordinator } from '../../dist/app/runtime/src/index.js'

function openService(root, projectKey) {
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'))
  const binding = {
    bindingId: `${projectKey}-binding`,
    providerId: `${projectKey}-provider`,
    protocol: 'responses',
    endpointRef: `fake://${projectKey}`,
    modelRef: 'fake',
    configDigest: 'sha256:relay-negative-config',
    capabilityDigest: 'sha256:relay-negative-capability',
  }
  return new UiRuntimeService({
    mode: 'fake',
    organId: id('organ', `${projectKey}-organ`),
    projectKey,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
    journal,
    closurePort: journal,
    providerState: 'ready',
    checkpointStoreFor: (taskId, cycleId) =>
      new FileCheckpointStore(join(root, 'checkpoints', `${taskId.value}-${cycleId.value}.jsonl`)),
    attentionPort: {
      async publish(input) { return { attentionId: input.attentionId, delivered: true } },
      async resolve(input) { return { attentionId: input.attentionId, delivered: true } },
    },
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey,
      roleId: 'execution',
    },
      runtimeComposition: { admitExecution: async () => {} },
    explicitBrainInterpreter: { async interpret() { throw new Error('unused') } },
  })
}

async function openRequest(service, taskId) {
  return await service.openTaskInputRequest({
    taskId,
    question: '请补充部署目标。',
    schemaRef: 'humanagent://input/text/v1',
    reason: '缺少部署目标。',
    impact: '当前执行等待用户回答。',
    turnId: 'negative-turn-1',
    operationId: 'operation-negative-1',
    executionEpoch: 1,
  })
}

test('a stale or foreign answer never continues a task and never creates a new one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-input-relay-negative-'))
  try {
    await mkdir(root, { recursive: true })
    const service = openService(root, 'relay-negative-project')
    const task = service.createTask({ title: 'negative task', directive: 'need input' })
    const other = service.createTask({ title: 'other task', directive: 'unrelated' })
    const request = await openRequest(service, task.taskId)

    // The waiting task is visible with the exact question and one answer action.
    const decision = await service.productPendingDecision({ projectKey: 'relay-negative-project', mode: 'fake' })
    assert.equal(decision?.kind, 'task-input-request')
    assert.deepEqual(decision.actions, ['answer'])
    assert.equal(decision.state, 'waiting')
    assert.equal(decision.request.requestId, request.requestId)

    // Stale revision: refused, no continuation, request stays open.
    await assert.rejects(
      () => service.answerTaskInputRequest({
        taskId: task.taskId,
        requestId: request.requestId,
        answer: '生产环境',
        expectedRevision: request.expectedRevision + 1,
      }),
      (error) => error?.code === 'task-input-request.stale-revision',
    )
    assert.equal(service.taskDashboard(task.taskId).state, 'waiting')
    assert.equal((await service.productPendingDecision({ projectKey: 'relay-negative-project', mode: 'fake' }))?.request.requestId, request.requestId)

    // Foreign task: refused, the other task has no request and gains no execution.
    await assert.rejects(
      () => service.answerTaskInputRequest({
        taskId: other.taskId,
        requestId: request.requestId,
        answer: '生产环境',
        expectedRevision: request.expectedRevision,
      }),
      (error) => error?.code === 'task-input-request.not-found',
    )
    assert.equal(service.taskDashboard(other.taskId).state, 'created')

    // The task count never grows through the relay.
    assert.equal(service.listTasks().counts.total, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a consumed request cannot be answered twice and there is no silent waiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-input-relay-idempotent-'))
  try {
    await mkdir(root, { recursive: true })
    const service = openService(root, 'relay-idempotent-project')
    const task = service.createTask({ title: 'idempotent task', directive: 'need input' })
    const request = await openRequest(service, task.taskId)

    const receipt = await service.answerTaskInputRequest({
      taskId: task.taskId,
      requestId: request.requestId,
      answer: '生产环境',
      expectedRevision: request.expectedRevision,
    })
    assert.equal(receipt.inputRevision, request.expectedRevision)
    assert.equal(receipt.continuation.executionEpoch, request.executionEpoch + 1)
    assert.ok(['running', 'settling', 'succeeded', 'failed', 'blocked', 'cancelled', 'stopped'].includes(service.taskDashboard(task.taskId).state))

    // The request is consumed exactly once: a second answer cannot start a
    // second continuation.
    await assert.rejects(
      () => service.answerTaskInputRequest({
        taskId: task.taskId,
        requestId: request.requestId,
        answer: '生产环境',
        expectedRevision: request.expectedRevision,
      }),
      (error) => error?.code === 'task-input-request.not-found',
    )
    assert.equal(service.listTasks().counts.total, 1)
    const deadline = Date.now() + 5000
    while (!['succeeded', 'failed', 'blocked', 'cancelled', 'stopped'].includes(service.taskDashboard(task.taskId).state)
      && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(['succeeded', 'failed', 'blocked', 'cancelled', 'stopped'].includes(service.taskDashboard(task.taskId).state))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
