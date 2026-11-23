import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { id } from '../../dist/app/contracts/src/index.js'
import { UiRuntimeJournal, UiRuntimeService, FakeReplayExecutionRuntimePort, FileCheckpointStore } from '../../dist/app/app/src/ui-runtime/index.js'
import { createUiRuntimeRequestDispatcher } from '../../dist/app/app/src/ui-runtime/server.js'
import { AccessControlService } from '../../dist/app/app/src/ui-runtime/access-control.js'
import { MemoryCoordinator } from '../../dist/app/runtime/src/index.js'
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js'
import { projectMainTopic } from '../../dist/app/ui/projection/main-topic.js'

// The interpreter is controlled. This checks UI/service boundaries, not model
// correction counting or the core checkpoint owner.
export async function fixture() {
  const base = join(homedir(), '.humanagent', 'test-fixtures')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'c07-ui-'))
  const binding = { bindingId: 'c07', providerId: 'c07', protocol: 'responses', endpointRef: 'fake://c07', modelRef: 'fake', configDigest: 'fixture', capabilityDigest: 'fixture' }
  let calls = []
  let service
  const open = () => {
    const journal = new UiRuntimeJournal(join(root, 'journal.jsonl'))
    return new UiRuntimeService({
      mode: 'fake', organId: id('organ', 'c07'), projectKey: 'c07', workspaceRoot: root,
      binding, port: new FakeReplayExecutionRuntimePort({ binding }), journal, closurePort: journal, providerState: 'ready',
      checkpointStoreFor: (task, cycle) => new FileCheckpointStore(join(root, `${task.value}-${cycle.value}.jsonl`)),
      attentionPort: { async publish(i) { return { attentionId: i.attentionId, delivered: true } }, async resolve(i) { return { attentionId: i.attentionId, delivered: true } } },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: 'c07', roleId: 'execution' },
      runtimeComposition: { admitExecution: async () => {} },
      explicitBrainInterpreter: { async interpret(input) {
        calls.push(input)
        if (!input.resumePartialRef) return {
          kind: 'partial', partialRef: `partial:${input.interactionId}`, interactionId: input.interactionId,
          inputRevision: input.inputRevision, turnId: 'controlled-turn', failedAttempt: 3, maxAttempts: 3,
          userMessage: '已保留原输入。本次回复未能完成整理。', recoverable: true,
          lastCheckpointRef: 'controlled-previous-valid-checkpoint',
          errors: [1, 2, 3].map(n => ({ path: `attempt[${n}].capsule.goal`, message: '目标不能为空' })),
        }
        await new Promise(resolve => setTimeout(resolve, 80))
        return { kind: 'answer', normalizedInput: input.rawInput, knownFacts: [], answer: '已从原交互继续，正确结果。', decisionRefs: [] }
      } },
    })
  }
  service = open()
  const accessControl = await AccessControlService.open({ credentialPath: join(root, 'access.json'), create: true })
  const challenge = await accessControl.issuePairingChallenge()
  const session = await accessControl.consumePairingCode(challenge.code)
  const cookie = accessControl.sessionCookie(session).split(';')[0]
  let dispatcher = createUiRuntimeRequestDispatcher({ service, accessControl, productRoot: root, uiRoot: join(process.cwd(), 'docs/ui'), isClosing: () => false })
  const server = createServer((req, res) => dispatcher.listener(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const request = async (path, body) => {
    const res = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: url, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: res.status, data: await res.json() }
  }
  return { root, url, cookie, calls, request,
    async reopen() { service = open(); await service.hydrate(); dispatcher = createUiRuntimeRequestDispatcher({ service, accessControl, productRoot: root, uiRoot: join(process.cwd(), 'docs/ui'), isClosing: () => false }) },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) },
  }
}

if (!process.env.C07_BROWSER_SERVER) test('typed partial survives cold read and resumes the original interaction exactly once through HTTP', async () => {
  const f = await fixture()
  try {
    const received = await f.request('/api/explicit/inputs', { sourceRef: 'c07:controlled', rawInput: '保留此原输入', channel: 'business' })
    assert.equal(received.status, 201)
    const iid = received.data.interactionId
    const path = `/api/explicit/interactions/${iid}`
    const partial = await f.request(path + '/interpret', {})
    assert.equal(partial.status, 200, JSON.stringify(partial.data))
    assert.equal(partial.data.state, 'partial')
    assert.equal(partial.data.partial.errors[2].path, 'attempt[3].capsule.goal')
    const interruptedResume = projectMainTopic({ projectKey: 'c07', projectName: 'c07', workspaceCwd: f.root, mode: 'fake', tasks: [],
      interactions: [{ interactionId: iid, rawInput: partial.data.rawInput, state: 'matching', partial: { ...partial.data.partial, resumed: true } }] })
    assert.equal(interruptedResume.turns.filter(t => t.kind === 'partial').length, 1, 'cold in-flight recovery must keep its continue surface')
    await f.reopen()
    const reread = await f.request(path)
    assert.deepEqual(reread.data.partial, partial.data.partial)
    const projection = await f.request('/api/main-topic')
    assert.equal(projection.data.turns.find(t => t.kind === 'partial').text, partial.data.partial.userMessage)
    assert.equal((await f.request(path + '/continue', { partialRef: 'wrong' })).status, 409)
    const body = { partialRef: partial.data.partial.partialRef }
    const [a, b] = await Promise.all([f.request(path + '/continue', body), f.request(path + '/continue', body)])
    assert.equal(a.status, 200); assert.deepEqual(a, b)
    assert.equal(a.data.state, 'answered')
    assert.equal(a.data.rawInput, '保留此原输入')
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[1].inputRevision, f.calls[0].inputRevision)
    assert.equal(f.calls[1].interactionId, iid)
    assert.equal(f.calls[1].resumePartialRef, body.partialRef)
    await f.reopen()
    const duplicate = await f.request(path + '/continue', body)
    assert.equal(duplicate.status, 200); assert.equal(duplicate.data.reply, a.data.reply)
    assert.equal(f.calls.length, 2)
    const final = await f.request('/api/main-topic')
    assert.equal(final.data.turns.filter(t => t.text === a.data.reply).length, 1)
    assert.equal(final.data.tasks.length, 0)
  } finally { await f.close() }
})
