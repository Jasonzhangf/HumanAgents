import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { id } from '../../dist/app/contracts/src/index.js'
import { ensureControlLayout, resolveRuntimePaths } from '../../dist/app/config/src/index.js'
import {
  FakeReplayExecutionRuntimePort,
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
  uiRuntimeControlJournalPath,
} from '../../dist/app/app/src/ui-runtime/index.js'
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js'
import { JsonlOrganJournal, JsonlTaskIdentityJournal } from '../../dist/app/adapters/jsonl/src/index.js'
import { MemoryCoordinator } from '../../dist/app/runtime/src/index.js'
import { TaskIdentityConsumer } from '../../dist/app/runtime/src/orchestration/task-identity.js'
import { SubscriptionControlPort } from '../../dist/app/runtime/src/subscriptions/index.js'

const organId = id('organ', 'execution-input-relay-continuation')

async function openService(root) {
  const workspaceDir = join(root, 'workspace-project')
  await mkdir(workspaceDir, { recursive: true })
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: workspaceDir })
  await ensureControlLayout(paths)
  const projectKey = paths.projectKey
  const checkpointRoot = join(root, 'checkpoints')
  const controlJournal = new JsonlOrganJournal(uiRuntimeControlJournalPath(join(checkpointRoot, 'fake')))
  const identities = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(controlJournal))
  const subscriptionPath = join(checkpointRoot, 'fake', 'subscriptions.jsonl')
  const subscriptions = new SubscriptionControlPort(
    new JsonlOrganJournal(subscriptionPath), { organId }, subscriptionPath,
  )
  const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'))
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
    projectKey,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1 }),
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
    taskIdentity: identities,
    subscriptionControl: subscriptions,
  })
  return { service, identities, subscriptions, projectKey }
}

test('a user-facing parent surfaces and continues its child occurrence input request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-input-relay-continuation-'))
  try {
    const { service, identities, subscriptions, projectKey } = await openService(root)
    const directive = 'read the file, pause for the user decision, then continue the same task'
    const parent = service.createTask({ title: 'confirmed complex request', directive })
    const child = service.createTask({ title: 'planned child execution', directive })
    const requirementId = 'requirement-relay-continuation'
    await identities.establish({
      scope: { organId, taskId: parent.taskId },
      source: {
        requirementId,
        inputRevision: 1,
        draftId: 'draft-relay-continuation',
        draftRevisionVersion: 1,
        draftRevisionHash: 'hash-relay-continuation',
        confirmationRef: 'confirm-relay-continuation',
      },
      title: parent.title,
    })
    await identities.establish({
      scope: { organId, taskId: child.taskId },
      source: {
        requirementId: `${requirementId}-child`,
        inputRevision: 1,
        draftId: 'draft-relay-continuation-child',
        draftRevisionVersion: 1,
        draftRevisionHash: 'hash-relay-continuation-child',
        confirmationRef: 'confirm-relay-continuation-child',
      },
      title: child.title,
    })
    const subscriptionId = `subscription:${requirementId}`
    const dueAt = '2026-11-12T00:00:00.000Z'
    const schedule = await subscriptions.create({
      subscriptionId,
      goalId: requirementId,
      scheduleRevision: 1,
      state: 'active',
      busyPolicy: 'skip',
      currentOccurrenceOrdinal: 0,
    }, {
      policyId: 'policy-relay-continuation',
      policyRevision: 1,
      timezone: 'UTC',
      canonicalInstant: dueAt,
      dstMode: 'wall',
      dstMissedPolicy: 'shift-forward',
      dstAmbiguousPolicy: 'earlier-offset',
      latePolicy: 'run-once',
      busyPolicy: 'skip',
      executionMode: 'once',
      dueAt,
    }, subscriptionId)
    await subscriptions.schedule({
      occurrence: {
        subscriptionId,
        scheduleRevision: schedule.subscription.scheduleRevision,
        occurrenceOrdinal: 1,
        state: 'due',
        dueAt,
      },
      nowAt: dueAt,
    })
    await subscriptions.claim({
      subscriptionId,
      scheduleRevision: schedule.subscription.scheduleRevision,
      occurrenceOrdinal: 1,
      dueAt,
      taskId: child.taskId,
      operationId: id('operation', 'relay-continuation-claim'),
      inputArtifactDigest: 'sha256:relay-continuation-claim',
      schedulerInstanceId: 'relay-continuation-fixture',
      leaseId: 'relay-continuation-fixture',
      generation: 1,
      executionEpoch: 1,
      nowAt: dueAt,
      leaseUntil: '2026-11-12T01:00:00.000Z',
    })

    // The Runtime opens the mid-execution request on the child occurrence that
    // actually runs. This is the Gate4 parent/child shape seen in production.
    const request = await service.openTaskInputRequest({
      taskId: child.taskId,
      question: '是否公布文件内容？',
      schemaRef: 'humanagent://input/text/v1',
      reason: '需要用户确认后才能继续。',
      impact: '当前执行暂停，等待用户回答。',
      turnId: 'relay-continuation-turn',
      operationId: 'operation-relay-continuation',
      executionEpoch: 1,
    })

    // The user-facing parent detail read must surface that exact request under
    // its own identity, so the detail page offers the answer control.
    const decision = await service.productPendingDecision({
      projectKey,
      mode: 'fake',
      taskId: parent.taskId.value,
    })
    assert.ok(decision, 'the parent detail must surface its child occurrence request')
    assert.equal(decision.kind, 'task-input-request')
    assert.equal(decision.state, 'waiting')
    assert.deepEqual(decision.actions, ['answer'])
    assert.equal(decision.target.taskRef.value, parent.taskId.value)
    assert.equal(decision.request.taskId.value, parent.taskId.value)
    assert.equal(decision.request.requestId, request.requestId)
    assert.equal(decision.request.expectedRevision, request.expectedRevision)

    // Answering through the parent identity consumes the child-owned request
    // and continues the child occurrence in place.
    const receipt = await service.answerTaskInputRequest({
      taskId: parent.taskId,
      requestId: request.requestId,
      answer: '公布',
      expectedRevision: request.expectedRevision,
    })
    assert.equal(receipt.taskId.value, child.taskId.value)
    assert.equal(receipt.inputRevision, request.expectedRevision)
    assert.ok(receipt.continuation.executionEpoch > request.executionEpoch)

    // Exactly once: the parent no longer offers a consumed request, and the
    // relay never creates a third task.
    assert.equal(await service.productPendingDecision({
      projectKey,
      mode: 'fake',
      taskId: parent.taskId.value,
    }), null)
    assert.equal(service.listTasks().counts.total, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
