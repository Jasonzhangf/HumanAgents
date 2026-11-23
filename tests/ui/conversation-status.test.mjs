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
  assert.equal(rows.find((r) => r.key.endsWith(':a')).endedAt, undefined)
  assert.equal(rows.find((r) => r.key.endsWith(':b')).tone, 'danger')
  assert.equal(rows.some((r) => r.phase === 'retry'), false)
  assert.equal(conversationStatus({ state: 'running', events: [...events, event('execution.retry', 5)] }).some((r) => r.phase === 'retry'), true)
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
