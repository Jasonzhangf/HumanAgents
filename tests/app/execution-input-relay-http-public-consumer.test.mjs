import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { id } from '../../dist/app/contracts/src/index.js'
import { AccessControlService } from '../../dist/app/app/src/ui-runtime/access-control.js'
import { createUiRuntimeRequestDispatcher } from '../../dist/app/app/src/ui-runtime/server.js'
import {
  FakeReplayExecutionRuntimePort,
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../dist/app/app/src/ui-runtime/index.js'
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js'
import { MemoryCoordinator } from '../../dist/app/runtime/src/index.js'

function dispatch(listener, { method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    request.method = method
    request.url = url
    request.headers = headers
    const chunks = []
    const response = {
      status: undefined,
      writableEnded: false,
      writeHead(status) {
        this.status = status
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk))
        return true
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        this.writableEnded = true
        resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') })
      },
    }
    try {
      listener(request, response)
    } catch (error) {
      reject(error)
    }
  })
}

test('public task input answer route returns a typed not-found receipt for an unknown request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-input-relay-http-'))
  try {
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'))
    const organId = id('organ', 'relay-http-organ')
    const binding = {
      bindingId: 'relay-http-binding',
      providerId: 'relay-http-provider',
      protocol: 'responses',
      endpointRef: 'fake://relay-http',
      modelRef: 'fake',
      configDigest: 'sha256:relay-http-config',
      capabilityDigest: 'sha256:relay-http-capability',
    }
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      projectKey: 'relay-http-project',
      binding,
      port: new FakeReplayExecutionRuntimePort({ binding }),
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
        projectKey: 'relay-http-project',
        roleId: 'execution',
      },
      explicitBrainInterpreter: { async interpret() { throw new Error('unused') } },
    })
    const task = service.createTask({ title: 'relay http task', directive: 'need input' })
    const accessControl = await AccessControlService.open({
      credentialPath: join(root, 'security', 'web-access.json'),
      create: true,
    })
    const challenge = await accessControl.issuePairingChallenge()
    const session = await accessControl.consumePairingCode(challenge.code)
    const cookie = accessControl.sessionCookie(session).split(';')[0]
    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: root,
      uiRoot: join(process.cwd(), 'docs', 'ui'),
    })
    const path = `/api/tasks/${encodeURIComponent(task.taskId.value)}/input-requests/missing-request/answer`
      + '?projectKey=relay-http-project&mode=fake'
    const response = await dispatch(listener, {
      method: 'POST',
      url: path,
      headers: { cookie, origin: 'http://runtime.test', 'content-type': 'application/json' },
      body: { answer: 'production', expectedRevision: 0 },
    })
    assert.equal(response.status, 404)
    assert.equal(JSON.parse(response.text).error?.code, 'task-input-request.not-found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('task input answer continues the same task with a new execution cycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-input-relay-continuation-'))
  try {
    const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'))
    const organId = id('organ', 'relay-continuation-organ')
    const binding = {
      bindingId: 'relay-continuation-binding',
      providerId: 'relay-continuation-provider',
      protocol: 'responses',
      endpointRef: 'fake://relay-continuation',
      modelRef: 'fake',
      configDigest: 'sha256:relay-continuation-config',
      capabilityDigest: 'sha256:relay-continuation-capability',
    }
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      projectKey: 'relay-continuation-project',
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
        projectKey: 'relay-continuation-project',
        roleId: 'execution',
      },
      runtimeComposition: { admitExecution: async () => {} },
      explicitBrainInterpreter: { async interpret() { throw new Error('unused') } },
    })
    const task = service.createTask({ title: 'continuation task', directive: 'continue this task' })
    const request = await service.openTaskInputRequest({
      taskId: task.taskId,
      question: '请补充部署目标。',
      schemaRef: 'humanagent://input/text/v1',
      reason: '缺少部署目标。',
      impact: '当前执行等待用户回答。',
      turnId: 'continuation-turn-1',
      operationId: 'operation-continuation-1',
      executionEpoch: 1,
      expectedRevision: 0,
    })
    const receipt = await service.answerTaskInputRequest({
      taskId: task.taskId,
      requestId: request.requestId,
      answer: '生产环境',
      expectedRevision: request.expectedRevision,
    })
    assert.equal(receipt.taskId.value, task.taskId.value)
    assert.equal(receipt.inputRevision, 1)
    assert.equal(receipt.continuation.executionEpoch, 2)
    const snapshot = service.taskDashboard(task.taskId)
    assert.ok(['running', 'settling', 'succeeded', 'failed', 'blocked', 'cancelled', 'stopped'].includes(snapshot.state))
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
