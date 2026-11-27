import assert from 'node:assert/strict'
import test from 'node:test'
import { explicitRequestMetadata, explicitStepsWithToolEvents, explicitToolActivityFinished, explicitToolRows } from '../../docs/ui/explicit-tool-activity.js'
import { renderTurnProgressDetail } from '../../docs/ui/turn-progress-detail.js'

const at = (second) => new Date(Date.UTC(2026, 10, 23, 0, 0, second)).toISOString()
const step = (kind, second, requestId, callId = 'same', tool = {}) => ({
  kind, occurredAt: at(second), requestId, turnId: 'turn',
  tool: { callId, kind: 'read-task-result', ...tool },
})

// Failure mode: a helper reuses a call id in a later request. Impact: the old
// result is overwritten and its duration becomes the later call's duration.
// Cost: pure row construction with two four-field fixtures.
test('explicit rows retain each completed request and its independent timing', () => {
  const rows = explicitToolRows([
    step('tool.started', 1, 'r1'),
    step('tool.finished', 2, 'r1', 'same', { status: 'succeeded' }),
    step('tool.started', 4, 'r2'),
    step('tool.finished', 6, 'r2', 'same', { status: 'failed', errorCode: 'task.read.failed' }),
  ], true)
  assert.deepEqual(rows.map(({ label, startedAt, endedAt, result }) => ({ label, startedAt, endedAt, result })), [
    { label: '读取任务结果', startedAt: at(1), endedAt: at(2), result: 'succeeded' },
    { label: '读取任务结果', startedAt: at(4), endedAt: at(6), result: 'failed' },
  ])
  assert.equal(rows[1].errorCode, 'task.read.failed')
})

test('project snapshots are rendered as scoped project reads in the live tool card', () => {
  const [row] = explicitToolRows([step('tool.started', 1, 'project-request', 'read', { kind: 'project-snapshot' })])
  assert.equal(row?.label, '查看项目进展')
  assert.equal(row.status, '等待工具返回')
  assert.equal(row.running, true)
})

test('skill selection stays request metadata and internal reads become typed semantic tool events', () => {
  const selection = step('tool.started', 1, 'request', 'skills', { kind: 'select-skills' })
  const selected = step('tool.finished', 2, 'request', 'skills', { kind: 'select-skills', status: 'succeeded', detail: { kind: 'skills', skills: ['task-intake'] } })
  const read = step('tool.started', 3, 'request', 'read', { kind: 'read-task-result', detail: { kind: 'task-result', title: '预算任务', taskState: 'running', publicationState: 'pending' } })
  const end = step('tool.started', 4, 'request', 'end', { kind: 'submit-turn' })
  assert.deepEqual(explicitToolRows([selection, selected, read, end], false).map(row => row.label), ['读取任务结果'])
  assert.equal(explicitRequestMetadata([selection])?.label, '正在加载本轮技能')
  assert.match(explicitRequestMetadata([selection, selected])?.label, /任务接单/)
  const [call] = explicitStepsWithToolEvents([read], 'interaction-1')
  assert.equal(call.kind, 'provider.tool')
  assert.equal(call.toolId, 'humanagent.internal.read-task-result')
  assert.deepEqual(call.taskId, { scope: 'interaction', value: 'interaction-1' })
  assert.equal(explicitStepsWithToolEvents([end], 'interaction-1').length, 0)
})

test('continuation distinguishes the runtime blocker from a published result and a real release', () => {
  const read = { kind: 'task-result', title: '原任务', taskState: 'blocked', publicationState: 'committed', resultAvailable: false }
  const blocker = { code: 'unknown.event', reason: 'unknown responses wire event type', nextStep: '核实外部变更后恢复' }
  const [readRow, held, released] = explicitToolRows([
    step('tool.finished', 1, 'read', 'same', { status: 'succeeded', detail: read }),
    step('tool.finished', 2, 'hold', 'same', { kind: 'resume-task', status: 'succeeded', detail: { ...read, continuation: 'blocked', blocker } }),
    step('tool.finished', 3, 'release', 'same', { kind: 'resume-task', status: 'succeeded', detail: { kind: 'task-result', continuation: 'released' } }),
  ], true)
  assert.match(readRow.explanation, /暂无可显示的已发布结果/)
  assert.equal(held.result, 'blocked')
  assert.equal(held.blocker.code, blocker.code)
  assert.match(held.blocker.reason, /无法识别的响应事件/)
  assert.equal(held.blocker.next, blocker.nextStep)
  assert.match(released.explanation, /已恢复原任务执行/)
});

// Failure mode: the message card and its progress detail choose different
// completion rules, so an ended call shown as "结果未记录" becomes "等待" in
// the detail. Impact: users cannot distinguish a live call from lost evidence.
// Cost: one pure three-state fixture.
test('message cards and progress details share the explicit-turn completion rule', () => {
  assert.equal(explicitToolActivityFinished({ statusFacts: { state: 'matching', steps: [] } }), false)
  assert.equal(explicitToolActivityFinished({ statusFacts: { state: 'running', steps: [] } }), true)
  assert.equal(explicitToolActivityFinished({ statusFacts: undefined, localStatus: [{ error: { code: 'transport.failure' } }] }), true)
})

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = ''; this.hidden = false; this.isConnected = true; this.listeners = {}; this.style = {} }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node) } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = undefined }
  setAttribute(name, value) { this[name] = value }
  addEventListener(name, fn) { this.listeners[name] = fn }
  showModal() { this.open = true }
  close() { this.open = false; this.listeners.close?.() }
  focus() {}
}

const find = (node, className) => node.className === className ? node
  : node.children.map(child => find(child, className)).find(Boolean)
const nodeText = (node) => [node.textContent, ...node.children.map(nodeText)].join('\n')

// Failure mode: the progress drawer drops provider tool events, turns a closed
// missing result into a live call, or reads a result without its original task
// identity. Impact: the card and detail disagree and tool evidence cannot be
// audited. Cost: one deterministic DOM producer with five typed events.
test('progress detail preserves request, tool, empty-result and missing-result facts', async () => {
  const previousDocument = globalThis.document
  globalThis.document = { createElement: tag => new Node(tag) }
  try {
    const taskId = { scope: 'task', value: 'task-detail' }
    const occurredAt = at(10)
    const event = (kind, extra = {}) => ({ kind, occurredAt, taskId,
      operationId: 'op-detail', executionEpoch: 2, turnId: 'turn-detail', requestId: 'request-detail', ...extra })
    const failedCall = event('provider.tool', { seq: 1, callId: 'call-failed', toolId: 'file.read', arguments: { path: '/tmp/evidence.txt' } })
    const failedResult = event('provider.tool-result', { seq: 2, callId: 'call-failed', toolId: 'file.read',
      status: 'failed', error: { code: 'tool.read.denied', message: '拒绝读取' } })
    const emptyCall = event('provider.tool', { seq: 3, callId: 'call-empty', toolId: 'bash', arguments: { command: ':', description: '空输出' } })
    const emptyResult = event('provider.tool-result', { seq: 4, callId: 'call-empty', toolId: 'bash',
      status: 'succeeded', outputRef: 'asset-empty', outputDigest: 'digest-empty' })
    const turn = { turnId: 'turn-detail', role: 'jenny', kind: 'status', text: '', taskId,
      toolEvents: [failedCall, failedResult, emptyCall, emptyResult],
      statusFacts: { state: 'running', events: [event('provider.model', { state: 'dispatched' })],
        steps: [{ seq: 5, kind: 'tool.started', requestId: 'request-explicit', turnId: 'turn-detail',
          occurredAt, tool: { callId: 'call-missing', kind: 'read-task-result' } }] } }
    let target
    const detail = renderTurnProgressDetail(turn, { readOutput: async (next) => { target = next; return '' } })
    assert.equal(find(detail.content, 'progress-step').dataset.phase, 'model-wait')
    assert.match(nodeText(detail.content), /等待模型响应/)
    const failed = find(detail.content, 'tool-card')
    assert.equal(failed.dataset.status, 'failed')
    assert.match(nodeText(failed), /tool.read.denied.*拒绝读取/)
    assert.match(nodeText(detail.content), /结果未记录/)
    const toolBody = find(detail.content, 'tool-body')
    const emptyCard = toolBody.children.find(card => card.dataset.toolId === 'bash')
    await find(emptyCard, 'tool-read-output').listeners.click()
    assert.equal(find(emptyCard, 'tool-output').textContent, '（空字符串）')
    assert.deepEqual(target, { taskId, operationId: 'op-detail', executionEpoch: 2, seq: 4 })
    detail.dispose()
  } finally { globalThis.document = previousDocument }
})
