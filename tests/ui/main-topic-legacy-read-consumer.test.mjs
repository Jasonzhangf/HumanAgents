import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderMainTopic, updateMainTopicUsage, disposeMainTopic } from '../../docs/ui/main-topic.js'
import { mainTopicUsageScope } from '../../docs/ui/entry.js'
import { createRuntimeApi, createSessionUsageReader } from '../../docs/ui/runtime-api.js'

// Captured ordinary GETs from 54772, not a synthetic Task or model response.
const captured = JSON.parse(readFileSync(new URL('./fixtures/main-topic-interaction-1-20261123.json', import.meta.url)))
const projection = () => ({ projectKey: 'workspace', mode: 'rcc', projectName: 'workspace', topicName: '主话题', agentName: 'Jenny', ...structuredClone(captured.mainTopic) })

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.className = ''; this.textContent = '' }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item) } }
  prepend(item) { item.parent = this; this.children.unshift(item) }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener() {}
  replaceChildren(...items) { this.children = []; this.textContent = ''; this.append(...items) }
  get firstChild() { return this.children[0] }
  removeChild(child) { this.children = this.children.filter((node) => node !== child) }
  contains(child) { return this.children.some((node) => node === child || node.contains(child)) }
  querySelectorAll(selector) {
    return this.children.flatMap((node) => [...(node.className.split(' ').includes(selector.slice(1).split('[')[0]) ? [node] : []), ...node.querySelectorAll(selector)])
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  replaceWith(item) { const index = this.parent.children.indexOf(this); this.parent.children[index] = item; item.parent = this.parent }
  remove() { this.parent?.removeChild(this) }
}
const text = (node) => [node.textContent, ...node.children.map(text)].join('\n')
async function withHost(run) {
  const originalDocument = globalThis.document, originalElement = globalThis.HTMLElement
  globalThis.document = { createElement: (tag) => new Node(tag) }
  globalThis.HTMLElement = Node
  const host = new Node('div')
  try { await run(host) } finally {
    disposeMainTopic(host)
    globalThis.document = originalDocument
    globalThis.HTMLElement = originalElement
  }
}

for (const rounds of [undefined, []]) {
  test(`captured existing turns render with ${rounds ? 'empty' : 'absent'} rounds and exact interaction usage`, () => withHost(async (host) => {
    const p = projection()
    if (rounds) p.rounds = rounds
    renderMainTopic(host, p)
    assert.deepEqual(host.querySelectorAll('.mt-turn').map((node) => node.dataset.turnId), p.turns.map((turn) => turn.turnId))
    for (const turn of p.turns) assert.ok(text(host).includes(turn.text))
    assert.equal(host.querySelectorAll('.tool-body').length, 0, 'a bash request in prose is not an actual tool event')
    const urls = []
    const api = createRuntimeApi({ fetchImpl: async (url) => {
      urls.push(url)
      return { ok: true, json: async () => ({ usage: captured.usage }) }
    } })
    const reader = createSessionUsageReader({ api, onChange: ({ usage, ...options }) => updateMainTopicUsage(host, usage, options) })
    try {
      await reader.refresh(mainTopicUsageScope(p))
      assert.deepEqual(urls, ['/api/product/session?projectKey=workspace&mode=rcc&sessionId=interaction-1'])
      const calls = host.querySelectorAll('.call-usage-call')
      assert.deepEqual(calls.map((node) => node.dataset.callId), captured.usage.calls.map((call) => call.callId))
      assert.ok(captured.usage.calls.every((call) => captured.steps.some((step) => step.requestId === call.callId)))
    } finally { reader.clear() }
  }))
}

test('complete metadata retains server lanes and messageRefs; scope follows rendered turns', () => withHost((host) => {
  const p = projection()
  p.turns.push({ turnId: 'actual-task-result', role: 'jenny', kind: 'result', text: '任务结果', taskId: { scope: 'task', value: 'actual-task' } })
  p.rounds = [
    { roundKey: 'current', lane: 'active', messageRefs: ['actual-task-result'] },
    { roundKey: 'history', lane: 'history', messageRefs: p.turns.slice(0, 2).map((turn) => turn.turnId), userText: p.turns[0].text, summary: { text: p.turns[1].text } },
  ]
  renderMainTopic(host, p)
  assert.deepEqual(host.querySelectorAll('.mt-history-round').map((node) => node.dataset.historyRoundKey), ['history'])
  assert.deepEqual(host.querySelectorAll('.mt-turn').map((node) => node.dataset.turnId), ['actual-task-result'])
  assert.deepEqual(mainTopicUsageScope(p), { projectKey: 'workspace', mode: 'rcc', taskId: 'actual-task' })
  p.rounds = [p.rounds[1]]
  renderMainTopic(host, p)
  assert.equal(host.querySelectorAll('.mt-turn').length, 0)
  assert.deepEqual(mainTopicUsageScope(p), { projectKey: 'workspace', mode: 'rcc', sessionId: 'interaction-1' })
}))

test('no visible target does not borrow an earlier turn, unreferenced turn, activeTask or round target', () => {
  const p = projection()
  p.activeTask = { taskId: { value: 'foreign-task' } }
  p.turns.push({ turnId: 'no-target', text: '没有目标', role: 'jenny', kind: 'message' })
  assert.equal(mainTopicUsageScope(p), null)
  p.rounds = [{ lane: 'active', taskId: { value: 'foreign-task' }, messageRefs: ['no-target'] }]
  assert.equal(mainTopicUsageScope(p), null)
  p.rounds[0].messageRefs = ['missing-ref']
  assert.equal(mainTopicUsageScope(p), null)
  assert.equal(mainTopicUsageScope({ ...p, turns: [] }), null)
  assert.equal(mainTopicUsageScope({ ...projection(), mode: undefined }), null)
})
