import assert from 'node:assert/strict'
import test from 'node:test'
import { ownedMainTopicTurns } from '../../docs/ui/main-topic.js'
import { conversationStatus, conversationStatusTime } from '../../docs/ui/conversation-status.js'

test('tracking a dispatched task keeps its live execution facts in the conversation', () => {
  const taskId = { scope: 'task', value: 'request' }
  const task = { taskId, sourceInteractionId: 'requester', title: '读取项目文档', state: 'running' }
  const draft = { turnId: 'draft', taskId, interactionId: 'requester', role: 'jenny', kind: 'draft',
    text: '任务说明', statusFacts: { state: 'dispatched', steps: [] } }
  const event = { kind: 'provider.tool', toolId: 'file.read', arguments: { path: 'project.md' } }
  const live = { turnId: 'live', taskId, role: 'jenny', kind: 'status', text: '等待 Provider 事件',
    statusFacts: { state: 'running', events: [{ kind: 'execution.retry', state: 'retrying' }, event] },
    toolEvents: [event] }
  const turns = ownedMainTopicTurns({ tasks: [task], turns: [draft, live] })
  assert.equal(turns[0].kind, 'dispatch')
  assert.equal(turns[0].statusFacts, draft.statusFacts)
  assert.equal(turns[1]?.turnId, 'live')
  assert.equal(turns[1].role, 'task')
  assert.equal(turns[1].statusFacts, live.statusFacts)
  assert.equal(turns[1].toolEvents, live.toolEvents)
  assert.equal(turns[1].text, '')
})

test('model progress names the actual tool and retains earlier requests for round details', () => {
  const request = (kind, second, requestId, extra) => ({
    kind, seq: second, occurredAt: new Date(Date.UTC(2026, 10, 24, 0, 0, second)).toISOString(),
    taskId: { scope: 'task', value: 'work' }, operationId: 'execute', executionEpoch: 1,
    turnId: 'round', requestId, ...extra,
  })
  const facts = { state: 'running', events: [
    request('provider.model', 1, 'first', { state: 'dispatched' }),
    request('provider.tool', 2, 'first', { toolId: 'file.search', callId: 'search' }),
    request('provider.tool', 3, 'first', { toolId: 'file.read', callId: 'read' }),
    request('provider.model', 4, 'second', { state: 'dispatched' }),
  ] }
  const live = conversationStatus(facts)
  assert.equal(live.filter(row => row.phase === 'model-wait').length, 1)
  const detail = conversationStatus(facts, { allRequests: true })
  assert.equal(detail.filter(row => row.phase === 'model-wait').length, 2)
  assert.equal(detail.find(row => row.phase === 'streaming')?.statusLabel, '搜索文件、读取文件')
})

test('a native retry counts down to its recorded deadline and freezes at the actual next request', () => {
  const taskId = { scope: 'task', value: 'work' }
  const at = (seconds) => new Date(Date.UTC(2026, 10, 24, 0, 0, seconds)).toISOString()
  const retry = { taskId, operationId: 'op', executionEpoch: 1, seq: 1, kind: 'execution.retry',
    state: 'retrying', occurredAt: at(1), retryDeadlineAt: at(5), attemptNumber: 3, maxAttempts: 11,
    error: { code: 'http.503', message: 'transport body' } }
  const project = (events) => conversationStatus({ state: 'running', events }).find(row => row.phase === 'retry')
  const waiting = project([retry])
  assert.equal(waiting.label, '第 3 次尝试')
  assert.equal(conversationStatusTime(waiting, Date.parse(at(3))), '已等 2 秒 · 2 秒后重试')
  const reissued = project([retry, { ...retry, seq: 2, kind: 'provider.model', state: 'dispatching', occurredAt: at(5) }])
  assert.equal(reissued.statusLabel, '已发出重试请求')
  assert.equal(conversationStatusTime(reissued, Date.parse(at(20))), '已等 4 秒')
})
