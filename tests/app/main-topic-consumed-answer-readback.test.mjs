import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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

const projectKey = 'main-topic-consumed-answer-project'

function openService(root) {
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'))
  const binding = {
    bindingId: `${projectKey}-binding`,
    providerId: `${projectKey}-provider`,
    protocol: 'responses',
    endpointRef: `fake://${projectKey}`,
    modelRef: 'fake',
    configDigest: `sha256:${projectKey}-config`,
    capabilityDigest: `sha256:${projectKey}-capability`,
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

test('an execution-composition question and its exact answer survive a fresh client read once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'main-topic-consumed-answer-'))
  try {
    await mkdir(root, { recursive: true })
    const service = openService(root)
    const task = service.createTask({ title: '比价任务', directive: '比较两份报价' })
    // The production execution-composition port calls the coordinator directly
    // (service.ts createExecutionPorts and ui-runtime/index.ts). Driving that
    // same entry proves the real open path; the service facade is not used.
    const request = service.coordinator.openTaskInputRequest({
      taskId: task.taskId,
      question: '按含税价还是未税价比较？',
      schemaRef: 'humanagent://input/text/v1',
      reason: '缺少比价口径。',
      impact: '原任务等待用户选择。',
      options: ['含税价', '未税价'],
      turnId: 'main-topic-turn-1',
      operationId: id('operation', 'main-topic-operation-1'),
      executionEpoch: 1,
    })
    await service.answerTaskInputRequest({
      taskId: task.taskId,
      requestId: request.requestId,
      answer: '含税价',
      expectedRevision: request.expectedRevision,
    })

    // A second answer stays refused; the consumed request cannot be answered twice.
    await assert.rejects(
      () => service.answerTaskInputRequest({
        taskId: task.taskId,
        requestId: request.requestId,
        answer: '未税价',
        expectedRevision: request.expectedRevision,
      }),
      (error) => error?.code === 'task-input-request.not-found',
    )

    const secondTask = service.createTask({ title: '核对规格', directive: '核对两份报价规格' })
    const secondRequest = service.coordinator.openTaskInputRequest({
      taskId: secondTask.taskId,
      question: '是否要求同规格？',
      schemaRef: 'humanagent://input/text/v1',
      reason: '缺少规格口径。',
      impact: '原任务等待用户确认。',
      turnId: 'main-topic-turn-2',
      operationId: id('operation', 'main-topic-operation-2'),
      executionEpoch: 1,
    })
    await service.answerTaskInputRequest({
      taskId: secondTask.taskId,
      requestId: secondRequest.requestId,
      answer: '同规格的报价',
      expectedRevision: secondRequest.expectedRevision,
    })

    const deadline = Date.now() + 5000
    while (![task.taskId, secondTask.taskId].every((taskId) =>
      ['succeeded', 'failed', 'blocked', 'cancelled', 'stopped'].includes(service.taskDashboard(taskId).state))
      && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const before = await service.readMainTopic()
    const questionTurns = before.turns.filter((turn) => turn.turnId === `input-request:${request.requestId}`)
    const answerTurns = before.turns.filter((turn) => turn.turnId === `input-answer:${request.requestId}`)
    assert.equal(questionTurns.length, 1)
    assert.equal(answerTurns.length, 1)
    assert.equal(questionTurns[0].text, '按含税价还是未税价比较？')
    assert.equal(answerTurns[0].role, 'user')
    assert.equal(answerTurns[0].text, '含税价')
    assert.equal(answerTurns[0].quote, '按含税价还是未税价比较？')
    assert.ok(before.turns.indexOf(questionTurns[0]) < before.turns.indexOf(answerTurns[0]))
    const secondQuestions = before.turns.filter((turn) => turn.turnId === `input-request:${secondRequest.requestId}`)
    const secondAnswers = before.turns.filter((turn) => turn.turnId === `input-answer:${secondRequest.requestId}`)
    assert.equal(secondQuestions.length, 1)
    assert.equal(secondAnswers.length, 1)
    assert.equal(secondQuestions[0].text, '是否要求同规格？')
    assert.equal(secondAnswers[0].text, '同规格的报价')
    assert.ok(before.turns.indexOf(secondQuestions[0]) < before.turns.indexOf(secondAnswers[0]))

    // A brand-new service over the same control root has no browser state and no
    // in-memory request: the read must come back from the Journal only.
    const fresh = openService(root)
    await fresh.hydrate()
    const after = await fresh.readMainTopic()
    const freshQuestions = after.turns.filter((turn) => turn.turnId === `input-request:${request.requestId}`)
    const freshAnswers = after.turns.filter((turn) => turn.turnId === `input-answer:${request.requestId}`)
    assert.equal(freshQuestions.length, 1)
    assert.equal(freshAnswers.length, 1)
    assert.equal(freshQuestions[0].text, '按含税价还是未税价比较？')
    assert.equal(freshAnswers[0].text, '含税价')
    assert.equal(freshAnswers[0].quote, '按含税价还是未税价比较？')
    const freshSecondQuestions = after.turns.filter((turn) => turn.turnId === `input-request:${secondRequest.requestId}`)
    const freshSecondAnswers = after.turns.filter((turn) => turn.turnId === `input-answer:${secondRequest.requestId}`)
    assert.equal(freshSecondQuestions.length, 1)
    assert.equal(freshSecondAnswers.length, 1)
    assert.equal(freshSecondQuestions[0].text, '是否要求同规格？')
    assert.equal(freshSecondAnswers[0].text, '同规格的报价')
    assert.equal(after.openInputRequest, undefined)

    // Exactly one durable consumed record exists for this request.
    const journalText = await readFile(join(root, 'ui-runtime-journal.jsonl'), 'utf8')
    const consumedRecords = journalText.split('\n').filter((line) => line.includes('"task.input-answered"'))
    assert.equal(consumedRecords.length, 2)
    assert.ok(consumedRecords.some((line) => line.includes('含税价')))
    assert.ok(consumedRecords.some((line) => line.includes('同规格的报价')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
