import test from 'node:test'
import assert from 'node:assert/strict'
import { renderProductSessionView, disposeProductSessionView } from '../../docs/ui/product-session-view.js'
import { createRuntimeApi } from '../../docs/ui/runtime-api.js'

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = ''; this.listeners = {}; this.isConnected = true }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node) } }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes) }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners[name] = fn }
  showModal() { this.open = true }
  close() { this.open = false; this.listeners.close?.() }
  focus() {}
}
globalThis.document = { createElement: tag => new Node(tag) }
const make = (tag, text, cls) => Object.assign(new Node(tag), { textContent: text ?? '', className: cls })
const walk = node => [node, ...node.children.flatMap(walk)]
const text = node => walk(node).map(n => n.textContent).join('\n')
const scope = { projectKey: 'project-a', mode: 'rcc', taskId: 'task-a' }
const event = (kind, extra = {}) => ({ scope: { ...scope, kind: 'task', taskId: { scope: 'task', value: scope.taskId } }, eventId: kind, kind, operationId: 'op', executionEpoch: 1, seq: kind === 'provider.tool' ? 1 : 2, callId: 'same-call', toolId: 'bash', arguments: { command: 'printf actual' }, execution: { runtimeId: 'runtime-a', assignmentId: 'assignment-a' }, ...extra })
const call = event('provider.tool')
const result = event('provider.tool-result', { status: 'succeeded', outputRef: 'ref', outputDigest: 'recorded' })

test('formal scoped facts render once, preserve legacy body and publication, and dispose nested details', async () => {
  const host = new Node('main'); const reads = []
  const reader = async target => { reads.push(target); return { exitCode: 0, stdout: { text: '', truncated: false }, stderr: { text: 'actual stderr', truncated: false } } }
  const input = { toolScope: scope, messages: [{ text: 'legacy body' }, { text: 'tool message', toolEvent: call }], toolEvents: [call, result, call, event('provider.tool-result', { scope: { ...call.scope, projectKey: 'other' }, status: 'failed', error: { message: 'WRONG PROJECT' } })], publicOutput: { commits: [{ text: 'published result' }] } }
  renderProductSessionView(host, input, { element: make, readToolOutput: reader })
  const cards = () => walk(host).filter(n => n.className === 'tool-card')
  assert.equal(cards().length, 1)
  const card = cards()[0]
  await walk(card).find(n => n.className === 'tool-read-output').listeners.click()
  assert.equal(reads.length, 1)
  assert.equal(reads[0].taskId.value, scope.taskId)
  assert.match(text(host), /legacy body/)
  assert.match(text(host), /published result/)
  assert.match(text(host), /空字符串/)
  assert.doesNotMatch(text(host), /WRONG PROJECT/)
  renderProductSessionView(host, input, { element: make, readToolOutput: reader })
  assert.equal(cards()[0], card, 'poll preserves the existing card and loaded output')
  await walk(card).find(n => n.className === 'tool-read-output').listeners.click()
  assert.equal(reads.length, 1)
  disposeProductSessionView(host)
  assert.equal(walk(card).filter(n => n.open === true).length, 0)
})

test('execution focus cannot pair identical call ids from another epoch or task', () => {
  const host = new Node('main')
  renderProductSessionView(host, { toolScope: scope, toolInstance: { kind: 'native-execution', execution: { runtimeId: 'runtime-a', executionEpoch: 1 } }, toolEvents: [call, event('provider.tool-result', { executionEpoch: 2, status: 'failed', error: { message: 'WRONG EPOCH' } }), event('provider.tool', { scope: { ...call.scope, taskId: { scope: 'task', value: 'other' } } })] }, { element: make })
  assert.equal(walk(host).filter(n => n.className === 'tool-card').length, 1)
  assert.match(text(host), /执行工具等待结果/)
  assert.doesNotMatch(text(host), /WRONG EPOCH/)
})

test('scoped tool reader keeps project/mode and allocation selectors on exact GET', async () => {
  const urls = []
  const original = globalThis.fetch
  globalThis.fetch = async url => { urls.push(String(url)); return { ok: true, json: async () => null } }
  try {
    const api = createRuntimeApi()
    assert.equal(await api.readScopedToolOutput({ taskId: { value: scope.taskId }, operationId: 'op', executionEpoch: 1, seq: 2 }, { ...scope, roleId: 'execution', configuredAgentId: 'agent-a' }), null)
    const url = new URL(urls[0], 'http://localhost')
    assert.equal(url.searchParams.get('projectKey'), scope.projectKey)
    assert.equal(url.searchParams.get('roleId'), 'execution')
    assert.equal(url.searchParams.get('configuredAgentId'), 'agent-a')
    assert.throws(() => api.readScopedToolOutput({ taskId: { value: 'other' } }, scope), /selected task scope/)
  } finally { globalThis.fetch = original }
})
