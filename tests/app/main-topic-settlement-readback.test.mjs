import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { id } from '../../dist/app/contracts/src/index.js'
import { JsonlOrganJournal, readLatestExplicitBrainStateFromFile } from '../../dist/app/adapters/jsonl/src/index.js'
import { JsonlTaskIdentityJournal } from '../../dist/app/adapters/jsonl/src/task-identities.js'
import { TaskIdentityConsumer } from '../../dist/app/runtime/src/orchestration/task-identity.js'
import { SubscriptionControlPort } from '../../dist/app/runtime/src/subscriptions/index.js'
import { MemoryCoordinator } from '../../dist/app/runtime/src/index.js'
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js'
import { FakeReplayExecutionRuntimePort, FileCheckpointStore, UiRuntimeJournal, UiRuntimeService } from '../../dist/app/app/src/ui-runtime/index.js'

// Replay an existing acceptance receipt. This test never submits or executes
// business work. The fixture and temporary runtime roots must be under ~/.humanagent.
// HUMANAGENT_SETTLEMENT_FIXTURE=<click-run> HUMANAGENT_SETTLEMENT_TEST_ROOT=<own runtime root>
const fixture = process.env.HUMANAGENT_SETTLEMENT_FIXTURE
const testRoot = process.env.HUMANAGENT_SETTLEMENT_TEST_ROOT

test('completed submitted work rejoins its original interaction after dispatch bookkeeping is retired',
  { skip: !fixture || !testRoot }, async (t) => {
    const expected = JSON.parse(await readFile(join(fixture, 'evidence/latest-topic.json'), 'utf8'))
    const projectKey = expected.projectKey
    const original = expected.tasks[0]
    const interactionId = 'interaction-1'
    const modeRoot = join(fixture, 'control/sessions', projectKey, 'checkpoints/ui-runtime/rcc')
    const state = readLatestExplicitBrainStateFromFile(join(fixture, 'control/main/sessions/explicit-brain.jsonl')).state
    assert.equal(state.dispatchLedger.length, 0, 'historical fixture must exercise retired bookkeeping')
    assert.equal(original.state, 'succeeded')
    assert.ok(original.output.includes('109.18') && original.output.includes('乙报价.txt'))
    await mkdir(testRoot, { recursive: true })

    async function readTopic({ editState, editIdentity, foreignProject = false, conflictingParent = false } = {}) {
      const root = await mkdtemp(join(testRoot, 'settlement-case-'))
      try {
        for (const name of ['ui-runtime-journal.jsonl', 'task-control.jsonl', 'subscriptions.jsonl']) {
          await copyFile(join(modeRoot, name), join(root, name))
        }
        const restored = structuredClone(state)
        editState?.(restored)
        const interactionJournal = new UiRuntimeJournal(join(root, 'explicit-brain.jsonl'))
        interactionJournal.append({ kind: 'explicit-brain.state', state: restored })
        const organId = id('organ', 'humanagent-ui')
        const binding = { bindingId: 'readback', providerId: 'readback', protocol: 'responses',
          endpointRef: 'fake://readback', modelRef: 'unused', configDigest: 'sha256:fixture', capabilityDigest: 'sha256:fixture' }
        const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'))
        const identity = new TaskIdentityConsumer(new JsonlTaskIdentityJournal(new JsonlOrganJournal(join(root, 'task-control.jsonl'))))
        let providerStarts = 0
        const port = new FakeReplayExecutionRuntimePort({ binding })
        port.start = async () => { providerStarts++; throw new Error('readback must not execute') }
        const service = new UiRuntimeService({
          mode: 'rcc', organId, projectKey, workspaceRoot: expected.workspaceCwd,
          binding, port, providerState: 'ready', autoResumeOnHydrate: false,
          journal: foreignProject ? new UiRuntimeJournal(join(root, 'other-project.jsonl')) : journal,
          interactionJournal, closurePort: journal,
          checkpointStoreFor: () => new FileCheckpointStore(join(root, 'task-control.jsonl')),
          taskIdentity: { async read(scope) {
            const record = await identity.read(scope)
            return record === undefined ? undefined : editIdentity?.(structuredClone(record)) ?? record
          } },
          subscriptionControl: new SubscriptionControlPort(new JsonlOrganJournal(join(root, 'subscriptions.jsonl')), { organId }, join(root, 'subscriptions.jsonl')),
          attentionPort: { async publish() {}, async resolve() {} },
          memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey, roleId: 'execution' },
          runtimeComposition: { admitExecution: async () => { throw new Error('readback must not admit') } },
        })
        await service.hydrate()
        if (conflictingParent) {
          const other = service.createTask({ title: original.title, directive: 'unrelated work with identical text' })
          const sourceRecord = await identity.read({ organId, taskId: original.taskId })
          await identity.establish({ scope: { organId, taskId: other.taskId }, source: sourceRecord.source })
        }
        const topic = await service.readMainTopic()
        assert.equal(providerStarts, 0)
        return topic
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    await t.test('original output and consumed question/answer survive two fresh hydrations exactly once', async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const topic = await readTopic()
        const results = topic.turns.filter((turn) => turn.kind === 'result')
        assert.equal(results.length, 1)
        assert.equal(topic.tasks[0].sourceInteractionId, interactionId)
        assert.deepEqual(results[0].taskId, original.taskId)
        assert.equal(results[0].text, original.output)
        assert.equal(topic.turns.filter((turn) => turn.kind === 'input-request').length, 1)
        assert.equal(topic.turns.filter((turn) => turn.role === 'user' && turn.quote).length, 1)
      }
    })
    for (const field of ['requirementId', 'draftId', 'inputRevision', 'draftRevisionVersion', 'draftRevisionHash', 'confirmationRef']) {
      await t.test(`a mismatched TaskIdentity ${field} does not borrow the result`, async () => {
        const topic = await readTopic({ editIdentity(record) {
          record.source[field] = typeof record.source[field] === 'number' ? record.source[field] + 1 : 'different'
          return record
        } })
        assert.equal(topic.turns.filter((turn) => turn.kind === 'result').length, 0)
      })
    }
    for (const field of ['inputRevision', 'revisionVersion', 'revisionHash']) {
      await t.test(`a mismatched interaction ${field} does not borrow the result`, async () => {
        const topic = await readTopic({ editState(s) {
          const r = s.intake.interactions[0].revision
          r[field] = typeof r[field] === 'number' ? r[field] + 1 : 'different'
        } })
        assert.equal(topic.turns.filter((turn) => turn.kind === 'result').length, 0)
      })
    }
    for (const field of ['interactionId', 'payloadRef']) {
      await t.test(`a mismatched confirmation ${field} stays unlinked`, async () => {
        const topic = await readTopic({ editState(s) { s.intake.interactions[0].confirmations[0][field] = 'different' } })
        assert.equal(topic.turns.filter((turn) => turn.kind === 'result').length, 0)
      })
    }
    await t.test('existing task changes are not new-task origins', async () => {
      const topic = await readTopic({ editState(s) {
        const requestIdentity = `existing-task-change:task:${original.taskId.value}`
        s.finalSubmissions[0].requestIdentity = requestIdentity
        s.confirmationLedger.finalSubmitBindings[0].requestIdentity = requestIdentity
      } })
      assert.equal(topic.turns.filter((turn) => turn.kind === 'result').length, 0)
    })
    await t.test('missing final receipts stay unlinked', async () => {
      const topic = await readTopic({ editState(s) { s.finalSubmissions = [] } })
      assert.equal(topic.turns.filter((turn) => turn.kind === 'result').length, 0)
    })
    await t.test('another project inventory cannot supply a completed task', async () => {
      const topic = await readTopic({ foreignProject: true })
      assert.equal(topic.tasks.length, 0)
      assert.equal(topic.turns.filter((turn) => turn.kind === 'result').length, 0)
    })
    await t.test('two matching business parents remain ambiguous', async () => {
      const topic = await readTopic({ conflictingParent: true })
      assert.equal(topic.turns.filter((turn) => turn.kind === 'result').length, 0)
    })
  })
