import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { id } from '../../dist/app/contracts/src/index.js'
import {
  FakeReplayExecutionRuntimePort,
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../dist/app/app/src/ui-runtime/index.js'
import { createUiRuntimeRequestDispatcher } from '../../dist/app/app/src/ui-runtime/server.js'
import { AccessControlService } from '../../dist/app/app/src/ui-runtime/access-control.js'
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

async function readMainTopicHttp(root, service) {
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'access.json'),
    create: true,
  })
  const challenge = await accessControl.issuePairingChallenge()
  const session = await accessControl.consumePairingCode(challenge.code)
  const cookie = accessControl.sessionCookie(session).split(';')[0]
  const dispatcher = createUiRuntimeRequestDispatcher({
    service, accessControl, productRoot: root, uiRoot: join(process.cwd(), 'docs/ui'),
    isClosing: () => false,
  })
  const server = createServer((request, response) => dispatcher.listener(request, response))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    const response = await fetch(`${origin}/api/main-topic`, { headers: { cookie, origin } })
    assert.equal(response.status, 200)
    return response.json()
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await accessControl.closeCredentialWatch()
  }
}

test('main-topic reuses one scoped snapshot and projects first-response facts without token text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'main-topic-read-facts-'))
  try {
    const service = openService(root)
    const task = service.createTask({ title: '公开读取', directive: '读取状态' })
    const read = service.taskSnapshotWithParentExecution.bind(service)
    let reads = 0
    service.taskSnapshotWithParentExecution = async (taskId) => {
      reads++
      const snapshot = await read(taskId)
      const base = { taskId, operationId: 'actual-operation', executionEpoch: 2, state: 'running', evidenceRefs: [], requestId: 'same-request', turnId: 'same-turn' }
      return { ...snapshot, events: [
        ...snapshot.events,
        ...[1, 2, 3].map((seq) => ({ ...base, eventId: `output-${seq}`, seq: 100 + seq, kind: 'provider.output', summary: `PRIVATE-TOKEN-${seq}`, occurredAt: `2026-11-22T10:00:0${seq}.000Z` })),
      ] }
    }
    const topic = await service.readMainTopic()
    assert.equal(reads, 1, 'dashboard/status/tools must reuse the same scoped snapshot')
    const facts = topic.turns.find((turn) => turn.taskId?.value === task.taskId.value)?.statusFacts
    const first = facts.events.filter((event) => event.kind === 'provider.output')
    assert.equal(first.length, 1)
    assert.equal(first[0].occurredAt, '2026-11-22T10:00:01.000Z')
    assert.equal(first[0].operationId, 'actual-operation')
    assert.equal(JSON.stringify(topic).includes('PRIVATE-TOKEN'), false)
    service.taskSnapshotWithParentExecution = async () => { throw new Error('controlled snapshot failure') }
    const unavailable = await service.readMainTopic()
    assert.equal(unavailable.tasks[0].detailReadError.message, 'controlled snapshot failure')
    assert.equal(unavailable.tasks[0].state, topic.tasks[0].state)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('main-topic closes only an exact successful cold checkpoint and keeps publication separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'main-topic-cold-checkpoint-'))
  try {
    const service = openService(root)
    const organId = id('organ', `${projectKey}-organ`)
    const taskSnapshots = service.coordinator.taskSnapshots.bind(service.coordinator)
    const taskSnapshot = service.coordinator.taskSnapshot.bind(service.coordinator)

    async function readColdTask(title, checkpointOutcome, checkpointEpoch, snapshotEpoch) {
      service.coordinator.taskSnapshots = taskSnapshots
      service.coordinator.taskSnapshot = taskSnapshot
      const created = service.createTask({ title, directive: 'read an isolated cold execution' })
      const cycleId = id('cycle', `ui-cycle-${title}`)
      const operationId = id('operation', `scheduled-operation-${title}`)
      const scope = { organId, taskId: created.taskId, cycleId }
      const checkpoint = {
        id: id('checkpoint', `checkpoint-${title}`), scope, cycleId, seq: 1,
        previousCheckpointId: null, directiveRevision: 1, executionEpoch: checkpointEpoch,
        outcome: checkpointOutcome, summary: checkpointOutcome === 'succeeded' ? 'execution succeeded' : 'real blocker',
        recoveryStateRef: {
          evidenceId: id('evidence', `recovery-${title}`), kind: 'operation',
          source: 'cold-checkpoint-readback', locator: `test://recovery/${title}`, scope,
        },
        evidenceRefs: [],
        next: { kind: 'continue', ref: `test://${title}/next` },
      }
      const checkpointPath = join(root, 'checkpoints', `${created.taskId.value}-${cycleId.value}.jsonl`)
      await mkdir(dirname(checkpointPath), { recursive: true })
      await new FileCheckpointStore(checkpointPath).commit(checkpoint)

      const prior = taskSnapshot(created.taskId)
      const checkpointEvent = {
        eventId: `${operationId.value}-checkpoint`, seq: 1, occurredAt: '2026-10-08T00:53:23.851Z',
        taskId: created.taskId, operationId: operationId.value, executionEpoch: checkpointEpoch,
        kind: 'checkpoint.committed', state: checkpointOutcome, summary: checkpoint.summary, evidenceRefs: [],
      }
      const cold = {
        ...prior, state: 'blocked', currentState: '进程已重启或缺少终态 checkpoint',
        nextStep: '确认 Provider 资源已释放后再发起新执行', operationId: operationId.value,
        executionEpoch: snapshotEpoch, cycleId: cycleId.value, events: [checkpointEvent], recentEvents: [checkpointEvent],
        ...(checkpointOutcome === 'blocked' ? { error: {
          code: 'test.real-blocker', ownerId: 'test.resource-owner', message: 'resource is still blocked',
          nextAction: 'release the declared resource', retryable: false,
        } } : {}),
      }
      service.coordinator.taskSnapshots = () => [cold]
      service.coordinator.taskSnapshot = () => cold
      return { taskId: created.taskId, topic: await service.readMainTopic(), dashboard: await service.taskDashboardWithPlan(created.taskId) }
    }

    const exact = await readColdTask('exact-success', 'succeeded', 1, 1)
    assert.equal(exact.topic.tasks.find((task) => task.taskId.value === exact.taskId.value).state, 'succeeded')
    assert.equal(exact.dashboard.state, 'succeeded')
    assert.equal(exact.dashboard.checkpoint?.checkpointId, 'checkpoint-exact-success')
    assert.equal(exact.dashboard.output, '')
    assert.equal(exact.topic.turns.filter((turn) => turn.kind === 'result' && turn.taskId?.value === exact.taskId.value).length, 0)
    const httpTopic = await readMainTopicHttp(root, service)
    assert.equal(httpTopic.tasks.find((task) => task.taskId.value === exact.taskId.value).state, 'succeeded')
    assert.equal(httpTopic.turns.filter((turn) => turn.kind === 'result' && turn.taskId?.value === exact.taskId.value).length, 0)

    const wrongEpoch = await readColdTask('wrong-epoch', 'succeeded', 2, 1)
    assert.equal(wrongEpoch.topic.tasks.find((task) => task.taskId.value === wrongEpoch.taskId.value).state, 'blocked')
    assert.equal(wrongEpoch.dashboard.checkpoint, undefined)

    const realBlocker = await readColdTask('real-blocker', 'blocked', 1, 1)
    assert.equal(realBlocker.topic.tasks.find((task) => task.taskId.value === realBlocker.taskId.value).state, 'blocked')
    assert.equal(realBlocker.dashboard.state, 'blocked')
    assert.equal(realBlocker.dashboard.checkpoint?.outcome, 'blocked')
    assert.equal(realBlocker.dashboard.error?.ownerId, 'test.resource-owner')
    assert.equal(realBlocker.dashboard.nextStep, 'release the declared resource')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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

    // Each Task is an independent read boundary. A detail read cannot erase
    // the other conversation or the already durable question/answer pair.
    const readSnapshot = fresh.taskSnapshotWithParentExecution.bind(fresh)
    const readPublication = fresh.authoritativePublicOutputForTask.bind(fresh)
    for (const boundary of ['snapshot', 'publication']) {
      fresh.taskSnapshotWithParentExecution = async (taskId) => {
        if (boundary === 'snapshot' && taskId.value === task.taskId.value) throw new Error('controlled snapshot failure')
        return readSnapshot(taskId)
      }
      fresh.authoritativePublicOutputForTask = async (taskId) => {
        if (boundary === 'publication' && taskId.value === task.taskId.value) throw new Error('controlled publication failure')
        return readPublication(taskId)
      }
      const isolated = await fresh.readMainTopic()
      assert.deepEqual(isolated.turns.filter((turn) => turn.taskId?.value === secondTask.taskId.value),
        after.turns.filter((turn) => turn.taskId?.value === secondTask.taskId.value))
      const affected = isolated.tasks.find((row) => row.taskId.value === task.taskId.value)
      assert.equal(affected.state, after.tasks.find((row) => row.taskId.value === task.taskId.value).state)
      assert.equal(affected.detailReadError.message, `controlled ${boundary} failure`)
      assert.equal(isolated.turns.find((turn) => turn.turnId === `input-answer:${request.requestId}`).text, '含税价')
      assert.equal(isolated.turns.find((turn) => turn.turnId === `input-request:${request.requestId}`).text, '按含税价还是未税价比较？')
      assert.ok(isolated.turns.some((turn) => turn.taskId?.value === task.taskId.value
        && turn.detailReadError?.message === `controlled ${boundary} failure`))
      if (process.env.TOPIC_ISOLATION_EVIDENCE) {
        await mkdir(process.env.TOPIC_ISOLATION_EVIDENCE, { recursive: true })
        await writeFile(join(process.env.TOPIC_ISOLATION_EVIDENCE, `${boundary}.json`), JSON.stringify({ before: after, after: isolated }, null, 2))
      }
    }
    fresh.snapshotsWithIdentitySource = async () => { throw new Error('controlled global identity failure') }
    await assert.rejects(fresh.readMainTopic(), /controlled global identity failure/)

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

test('a local detail failure retains both open questions for the real page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'main-topic-local-read-'))
  try {
    const service = openService(root)
    const tasks = ['甲消息：比较报价', '乙消息：核对规格'].map((title) => service.createTask({ title, directive: title }))
    for (const [index, task] of tasks.entries()) service.coordinator.openTaskInputRequest({
      taskId: task.taskId, question: index === 0 ? '按含税价还是未税价比较？' : '是否要求同规格？',
      schemaRef: 'humanagent://input/text/v1', reason: '等待口径', impact: '等待回答',
      turnId: `local-turn-${index}`, operationId: id('operation', `local-operation-${index}`), executionEpoch: 1,
    })
    const before = await service.readMainTopic()
    const read = service.taskSnapshotWithParentExecution.bind(service)
    service.taskSnapshotWithParentExecution = async (taskId) => {
      if (taskId.value === tasks[0].taskId.value) throw new Error('CONTROLLED_SNAPSHOT_READ: detail storage unavailable')
      return read(taskId)
    }
    const after = await service.readMainTopic()
    assert.deepEqual(after.turns.filter((turn) => turn.taskId?.value === tasks[1].taskId.value),
      before.turns.filter((turn) => turn.taskId?.value === tasks[1].taskId.value))
    for (const task of tasks) assert.deepEqual(
      after.turns.find((turn) => turn.taskId?.value === task.taskId.value && turn.kind === 'input-request'),
      before.turns.find((turn) => turn.taskId?.value === task.taskId.value && turn.kind === 'input-request'))
    if (process.env.TOPIC_ISOLATION_EVIDENCE) {
      await mkdir(process.env.TOPIC_ISOLATION_EVIDENCE, { recursive: true })
      await writeFile(join(process.env.TOPIC_ISOLATION_EVIDENCE, 'page-projections.json'), JSON.stringify({ before, after }, null, 2))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
