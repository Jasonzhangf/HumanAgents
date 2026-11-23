import test from 'node:test'
import assert from 'node:assert/strict'
import * as runtime from '../../docs/ui/runtime-api.js'
import * as entry from '../../docs/ui/entry.js'
import { renderMainTopic, updateMainTopicUsage, disposeMainTopic } from '../../docs/ui/main-topic.js'

// Missing page wiring is observed. Races are plausible during polling and
// scope navigation; impact is another conversation's cost being shown. These
// deterministic read consumers cost no server or model request to maintain.
const scope = { projectKey: 'project', mode: 'rcc', taskId: 'task-a' }
const usageFailure = { code: 'usage.source.failed', ownerId: 'journal-owner', message: '调用统计暂时无法读取', nextAction: '稍后刷新统计' }
const usage = (id) => ({ calls: [{ callId: id, turnId: 'turn', inputTokens: 0 }], coverage: { calls: 1, callsWithKnownInput: 1, callsWithKnownCacheRead: 0 } })
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

test('normal entry resolves only its last displayed turn exact task or actual explicit session', () => {
  const projection = { ...scope, turns: [{ turnId: 'old', taskId: { value: 'old' } }, { turnId: 'current', interactionId: 'actual-explicit-id' }],
    rounds: [{ messageRefs: ['old'] }, { messageRefs: ['current'] }] }
  assert.deepEqual(entry.mainTopicUsageScope(projection), { projectKey: 'project', mode: 'rcc', sessionId: 'actual-explicit-id' })
  projection.turns[1].taskId = { value: 'task-current' }
  assert.deepEqual(entry.mainTopicUsageScope(projection), { ...scope, taskId: 'task-current' })
  assert.equal(entry.mainTopicUsageScope({ ...scope, turns: [], rounds: [] }), null)
})

test('normal session read sends exact identity, consumes only top-level usage, preserves order and empty', async () => {
  const urls = [], paints = []
  const responses = [usage('historical'), usage('latest'), { calls: [], coverage: { calls: 0, callsWithKnownInput: 0, callsWithKnownCacheRead: 0 } }]
  const api = runtime.createRuntimeApi({ fetchImpl: async (url) => {
    urls.push(url)
    return { ok: true, json: async () => ({ usage: responses.shift(), debug: { usage: usage('wrong') } }) }
  } })
  const reader = runtime.createSessionUsageReader({ api, onChange: (state) => paints.push(state) })
  await reader.refresh(scope)
  assert.equal(paints.at(-1).usage.calls[0].callId, 'historical')
  await reader.refresh(scope)
  assert.equal(paints.at(-1).usage.calls[0].callId, 'latest')
  await reader.refresh({ projectKey: 'project', mode: 'rcc', sessionId: 'actual-explicit-id' })
  assert.deepEqual(paints.at(-1).usage.calls, [])
  assert.equal(urls[0], '/api/product/session?projectKey=project&mode=rcc&taskId=task-a')
  assert.equal(urls.at(-1), '/api/product/session?projectKey=project&mode=rcc&sessionId=actual-explicit-id')
  assert.ok(urls.every((url) => !url.includes('debug')))
})

test('completion during an old GET queues one reread without overlap; old success cannot win', async () => {
  const reads = [], paints = []
  const reader = runtime.createSessionUsageReader({ api: { readProductSession: () => {
    const read = deferred(); reads.push(read); return read.promise
  } }, onChange: (state) => paints.push(state) })
  const first = reader.refresh(scope)
  const completed = reader.refresh(scope, { force: true })
  reader.refresh(scope, { force: true })
  assert.equal(reads.length, 1)
  reads[0].resolve({ usage: usage('old') })
  await new Promise(setImmediate)
  assert.equal(reads.length, 2)
  assert.ok(!paints.some((state) => state.usage?.calls[0]?.callId === 'old'))
  reads[1].resolve({ usage: usage('completed') })
  await Promise.all([first, completed])
  assert.equal(paints.at(-1).usage.calls[0].callId, 'completed')
})

test('continuous polls coalesce with a slow same-scope GET and publish every result', async () => {
  const reads = [], paints = []
  const reader = runtime.createSessionUsageReader({ api: { readProductSession: () => {
    const read = deferred(); reads.push(read); return read.promise
  } }, onChange: (state) => paints.push(state) })
  for (let cycle = 0; cycle < 3; cycle++) {
    const pending = reader.refresh(scope)
    reader.refresh(scope) // 1.5s poll arrives before the GET returns
    reader.refresh(scope)
    assert.equal(reads.length, cycle + 1)
    reads[cycle].resolve({ usage: usage(`slow-${cycle}`) })
    await new Promise(setImmediate)
    assert.equal(paints.at(-1).usage?.calls[0].callId, `slow-${cycle}`)
    assert.equal(reads.length, cycle + 1, 'periodic polling does not queue another GET')
    await pending
  }
  reader.clear()
})

test('ordinary HTTP errors remain errors while a successful empty usage is empty', async () => {
  let failed = true
  const paints = []
  const api = runtime.createRuntimeApi({ fetchImpl: async () => ({
    ok: !failed, status: failed ? 503 : 200,
    json: async () => failed ? { error: { code: 'session.read.failed', message: 'usage unavailable' } }
      : { usage: { calls: [], coverage: { calls: 0 } } },
  }) })
  const reader = runtime.createSessionUsageReader({ api, onChange: (state) => paints.push(state) })
  await reader.refresh(scope)
  assert.match(paints.at(-1).error.message, /usage unavailable/)
  failed = false
  await reader.refresh(scope)
  assert.equal(paints.at(-1).error, undefined)
  assert.deepEqual(paints.at(-1).usage.calls, [])
  reader.clear()
})

test('HTTP 200 partial failure uses top-level failure, survives refresh pending and clears on success', async () => {
  const paints = [], reads = []
  const reader = runtime.createSessionUsageReader({ api: { readProductSession: () => {
    const read = deferred(); reads.push(read); return read.promise
  } }, onChange: (state) => paints.push(state) })
  const first = reader.refresh(scope)
  reads[0].resolve({ usage: null, usageFailure, messages: ['kept'], boardIndex: ['kept'] })
  await first
  assert.deepEqual(paints.at(-1).error, usageFailure)
  const next = reader.refresh(scope)
  assert.deepEqual(paints.at(-1).error, usageFailure)
  reads[1].resolve({ usage: { calls: [], coverage: { calls: 0 } } })
  await next
  assert.equal(paints.at(-1).error, undefined)
  const stale = reader.refresh(scope)
  const selected = reader.refresh({ projectKey: 'project', mode: 'rcc', sessionId: 'explicit' })
  reads[3].resolve({ usage: usage('selected') })
  await selected
  reads[2].resolve({ usage: null, usageFailure })
  await stale
  assert.equal(paints.at(-1).error, undefined)
  assert.equal(paints.at(-1).usage.calls[0].callId, 'selected')
  reader.clear()
})

test('scope switch, async errors, invalidation and reconnect never publish foreign usage', async () => {
  const reads = [], paints = []
  const reader = runtime.createSessionUsageReader({ api: { readProductSession: (s, { signal }) => {
    const read = deferred(); reads.push({ ...read, scope: s, signal }); return read.promise
  } }, onChange: (state) => paints.push(state) })
  const a = reader.refresh(scope)
  const session = { projectKey: 'other-project', mode: 'fake', sessionId: 'actual-session' }
  const b = reader.refresh(session)
  assert.equal(reads[0].signal.aborted, true)
  assert.equal(reads[1].signal.aborted, false)
  reads[0].reject(new Error('old task failed'))
  reads[1].resolve({ usage: usage('session') })
  await Promise.all([a, b])
  assert.equal(paints.at(-1).usage.calls[0].callId, 'session')
  assert.equal(paints.at(-1).error, undefined)
  const failed = reader.refresh(session)
  reads[2].reject(new Error('disconnected'))
  await failed
  assert.match(paints.at(-1).error.message, /disconnected/)
  const reconnect = reader.refresh(session)
  reads[3].resolve({ usage: usage('reconnected') })
  await reconnect
  assert.equal(paints.at(-1).usage.calls[0].callId, 'reconnected')
  const leaving = reader.refresh(session)
  reader.clear()
  assert.equal(reads[4].signal.aborted, true)
  const length = paints.length
  reads[4].resolve({ usage: usage('late') })
  await leaving
  assert.equal(paints.length, length)
})

test('real main-topic renderer mounts and updates its reachable footer without replacing chat or disclosure', async () => {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; this.attributes = {} }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item) } }
    prepend(item) { item.parent = this; this.children.unshift(item) }
    setAttribute(key, value) { this.attributes[key] = value }
    replaceChildren(...items) { this.children = []; this.textContent = ''; this.append(...items) }
    get firstChild() { return this.children[0] }
    removeChild(child) { this.children = this.children.filter((node) => node !== child) }
    contains(child) { return this.children.some((node) => node === child || node.contains(child)) }
    querySelectorAll(selector) {
      return this.children.flatMap((node) => [...(node.className.split(' ').includes(selector.slice(1)) ? [node] : []), ...node.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    replaceWith(item) { const index = this.parent.children.indexOf(this); this.parent.children[index] = item; item.parent = this.parent }
  }
  const originalDocument = globalThis.document, originalElement = globalThis.HTMLElement
  globalThis.document = { createElement: (tag) => new Node(tag) }
  globalThis.HTMLElement = Node
  const host = new Node('div')
  try {
    const projection = { projectKey: 'project', mode: 'rcc', workspaceCwd: '/workspace', projectName: '项目', topicName: '主话题', agentName: 'Jenny',
      turns: [{ turnId: 'current', role: 'jenny', kind: 'message', text: '回答', interactionId: 'actual-explicit-id' }],
      rounds: [{ messageRefs: ['current'] }] }
    renderMainTopic(host, projection)
    const footer = host.querySelector('.call-usage-footer')
    const stream = host.querySelector('.mt-stream')
    const details = footer.querySelector('.call-usage-details')
    details.open = true
    const snapshot = usage('normal-page')
    snapshot.calls[0].context = { used: 0, limit: null, percent: null }
    let response = { usage: snapshot }
    const reader = runtime.createSessionUsageReader({ api: { readProductSession: async () => response },
      onChange: ({ usage, ...options }) => updateMainTopicUsage(host, usage, options) })
    await reader.refresh(entry.mainTopicUsageScope(projection))
    assert.equal(footer.querySelector('.call-usage-call').dataset.callId, 'normal-page')
    renderMainTopic(host, projection)
    assert.equal(host.querySelector('.call-usage-footer'), footer)
    assert.equal(host.querySelector('.mt-stream'), stream)
    assert.equal(details.open, true)
    response = { usage: null, usageFailure }
    await reader.refresh(entry.mainTopicUsageScope(projection))
    assert.match(footer.querySelector('.call-usage-error').textContent, /usage.source.failed.*调用统计暂时无法读取/)
    assert.equal(host.querySelector('.mt-stream'), stream)
    assert.equal(details.open, true)
    response = { usage: snapshot }
    await reader.refresh(entry.mainTopicUsageScope(projection))
    assert.equal(footer.querySelector('.call-usage-error'), null)
    assert.equal(footer.querySelector('.call-usage-call').dataset.callId, 'normal-page')
    reader.clear()
  } finally {
    disposeMainTopic(host)
    globalThis.document = originalDocument
    globalThis.HTMLElement = originalElement
  }
})
