import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationStatus, elapsedSeconds, createConversationStatusClock } from '../../docs/ui/conversation-status.js'

const at = (s) => new Date(Date.UTC(2026, 10, 23, 0, 0, s)).toISOString()
const event = (kind, s, extra = {}) => ({ kind, occurredAt: at(s), seq: s, taskId: { value: 'task' }, operationId: 'op', executionEpoch: 1, ...extra })
test('public events keep first response time and freeze model wait separately from task', () => {
  const facts = { state: 'running', events: [event('provider.model', 1), event('provider.output', 4), event('provider.output', 6)] }
  const rows = conversationStatus(facts)
  assert.equal(rows.find((r) => r.phase === 'model-wait').endedAt, at(4))
  const stream = rows.find((r) => r.phase === 'streaming')
  assert.equal(stream.startedAt, at(4))
  assert.equal(elapsedSeconds(stream, Date.parse(at(9))), 5)
  assert.equal(conversationStatus(facts).some((r) => r.label === '任务已完成'), false)
})
test('terminal without a matching boundary omits duration; foreign execution cannot close a phase', () => {
  const rows = conversationStatus({ state: 'succeeded', events: [event('provider.model', 1), event('provider.output', 4, { operationId: 'other' })] })
  assert.equal(rows.find((r) => r.phase === 'model-wait').endedAt, undefined)
  assert.equal(elapsedSeconds(rows.find((r) => r.phase === 'model-wait'), Date.parse(at(30))), undefined)
  assert.equal(elapsedSeconds({ startedAt: at(1), running: false }, Date.parse(at(30))), undefined)
})
test('tool identity includes call, task, operation and epoch; failure and retry are facts', () => {
  const events = [event('provider.tool', 1, { callId: 'a' }), event('provider.tool', 2, { callId: 'b' }), event('provider.tool-result', 3, { callId: 'a', executionEpoch: 2 }), event('provider.tool-result', 4, { callId: 'b', status: 'failed', error: { code: 'tool.failed', message: '读取失败' } })]
  const rows = conversationStatus({ state: 'running', events })
  const tools = rows.filter((row) => row.phase === 'tool')
  assert.equal(tools.length, 2)
  assert.equal(tools[0].endedAt, undefined)
  assert.equal(tools[1].tone, 'danger')
  assert.equal(rows.some((r) => r.phase === 'retry'), false)
  assert.equal(conversationStatus({ state: 'running', events: [...events, event('execution.retry', 5)] }).some((r) => r.phase === 'retry'), true)
})
// Failure mode: completed tools disappear behind later activity or reused call ids
// close another request's row. Impact: users lose a real execution action.
// Cost: one pure event list, no model or browser resource.
test('completed tools remain visible and reused call ids stay request-scoped', () => {
  const events = [
    event('provider.model', 1, { state: 'dispatched', requestId: 'r1', turnId: 'turn' }),
    event('provider.tool', 2, { callId: 'same', requestId: 'r1', turnId: 'turn', toolId: 'file.read' }),
    event('provider.tool-result', 3, { callId: 'same', requestId: 'r1', turnId: 'turn', status: 'succeeded' }),
    event('provider.model', 4, { state: 'dispatched', requestId: 'r2', turnId: 'turn' }),
    event('provider.tool', 5, { callId: 'same', requestId: 'r2', turnId: 'turn', toolId: 'bash' }),
    event('provider.tool-result', 6, { callId: 'same', requestId: 'r2', turnId: 'turn', status: 'succeeded' }),
  ]
  const tools = conversationStatus({ state: 'running', events }).filter((row) => row.phase === 'tool')
  assert.deepEqual(tools.map(({ label, startedAt, endedAt }) => ({ label, startedAt, endedAt })), [
    { label: '读取文件', startedAt: at(2), endedAt: at(3) },
    { label: '执行命令', startedAt: at(5), endedAt: at(6) },
  ])
  assert.notEqual(tools[0].key, tools[1].key)
})
test('a later model request keeps each prior tool action with its own labels and timing', () => {
  const events = [
    event('provider.model', 1, { state: 'dispatched', requestId: 'r1', turnId: 't' }),
    event('provider.tool', 2, { callId: 'read', toolId: 'file.read' }),
    event('provider.tool-result', 4, { callId: 'read', status: 'succeeded' }),
    event('provider.tool', 5, { callId: 'shell', toolId: 'bash' }),
    event('provider.tool-result', 7, { callId: 'shell', status: 'succeeded' }),
    event('provider.model', 8, { state: 'dispatching', requestId: 'r2', turnId: 't' }),
    event('provider.model', 9, { state: 'dispatched', requestId: 'r2', turnId: 't' }),
  ]
  const rows = conversationStatus({ state: 'running', events })
  const tools = rows.filter((row) => row.phase === 'tool')
  assert.deepEqual(tools.map(({ label, startedAt, endedAt }) => ({ label, startedAt, endedAt })), [
    { label: '读取文件', startedAt: at(2), endedAt: at(4) },
    { label: '执行命令', startedAt: at(5), endedAt: at(7) },
  ])
  assert.equal(rows.filter((row) => row.phase === 'tool').every((row) => row.running === false), true)
  assert.equal(rows.find((row) => row.phase === 'model-wait').startedAt, at(9))
})
test('explicit request has sourced wait before a task exists and settles without task completion', () => {
  const rows = conversationStatus({ state: 'matching', steps: [
    { kind: 'request.dispatched', occurredAt: at(1), requestId: 'r', turnId: 't' },
    { kind: 'response.streaming', occurredAt: at(3), requestId: 'r', turnId: 't' },
    { kind: 'request.settled', occurredAt: at(7), requestId: 'r', turnId: 't' },
  ] })
  assert.equal(elapsedSeconds(rows.find((r) => r.phase === 'model-wait')), 2)
  assert.equal(elapsedSeconds(rows.find((r) => r.phase === 'streaming')), 4)
  assert.equal(elapsedSeconds(rows.find((r) => r.phase === 'total')), 6)
  assert.equal(rows.some((r) => r.label === '任务已完成'), false)
})
test('request lifecycle updates preserve dispatch time and use settled time, not next polling time', () => {
  const rows = conversationStatus({ state: 'running', events: [
    event('provider.model', 1, { state: 'dispatching', requestId: 'r', turnId: 't' }),
    event('provider.model', 2, { state: 'dispatched', requestId: 'r', turnId: 't' }),
    event('provider.model', 3, { state: 'waiting', requestId: 'r', turnId: 't' }),
    event('provider.output', 5, { requestId: 'r', turnId: 't' }),
    event('provider.model', 8, { state: 'settled', requestId: 'r', turnId: 't' }),
  ] })
  assert.equal(rows.find((r) => r.phase === 'model-wait').startedAt, at(2))
  assert.equal(elapsedSeconds(rows.find((r) => r.phase === 'model-wait')), 3)
  assert.equal(elapsedSeconds(rows.find((r) => r.phase === 'streaming')), 3)
})
test('returning a tool closes the corresponding model response before tool execution', () => {
  const step = (kind, time) => ({ kind, occurredAt: at(time), requestId: 'r', turnId: 't' })
  const tool = { kind: 'read-task-result', callId: 'c' }
  const rows = conversationStatus({ state: 'matching', steps: [
    step('request.dispatching', 1),
    step('request.dispatched', 2),
    step('response.reasoning', 3),
    { ...step('tool.started', 4), tool },
    { ...step('tool.finished', 8), tool: { ...tool, status: 'succeeded' } },
    step('request.settled', 9),
  ] })
  const model = rows.find(row => row.phase === 'streaming')
  assert.equal(model.label, '模型已返回工具调用')
  assert.equal(model.running, false)
  assert.equal(elapsedSeconds(model), 1)
})
test('clock uses wall time, cancels on terminal update and disposes on page teardown', () => {
  let tick, active = 0, time = Date.parse(at(5))
  const clock = createConversationStatusClock({ isConnected: true }, { now: () => time, schedule: (fn) => { tick = fn; active++; return 1 }, cancel: () => active-- })
  const node = {}
  clock.update([{ row: { startedAt: at(1), running: true }, node }])
  assert.equal(node.textContent, '4 秒')
  time += 2000; tick()
  assert.equal(node.textContent, '6 秒')
  clock.update([{ row: { startedAt: at(1), endedAt: at(5), running: false }, node }])
  assert.equal(node.textContent, '4 秒')
  assert.equal(active, 0)
  clock.update([{ row: { startedAt: at(1), running: true }, node }])
  clock.dispose()
  assert.equal(active, 0)
})
