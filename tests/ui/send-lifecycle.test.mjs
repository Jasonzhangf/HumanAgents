import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submissionView, canContinueSubmission } from '../../docs/ui/send-lifecycle.js'

const user = { turnId: 'user:interaction-2', interactionId: 'interaction-2', role: 'user', kind: 'message', text: 'same text' }
const attempt = { key: 'second', rawInput: 'same text', interactionId: 'interaction-2' }
const phase = p => p.turns.at(-1).localStatus
test('a different interaction with the same text cannot consume the optimistic turn', () => {
  const p = submissionView({ turns: [{ ...user, turnId: 'user:interaction-1', interactionId: 'interaction-1' }] }, attempt)
  assert.equal(p.turns.filter(t => t.role === 'user').length, 2)
  assert.equal(submissionView({ turns: [user] }, attempt).turns.filter(t => t.role === 'user').length, 1)
})
test('legacy receipt with no facts never invents model dispatch or elapsed start', () => {
  const rows = phase(submissionView({ turns: [user] }, attempt))
  assert.equal(rows[0].phase, 'accepted')
  assert.equal(rows[0].startedAt, undefined)
  assert.equal(rows[0].running, false)
})
test('real dispatch time survives rereads; earlier rounds cannot provide it', () => {
  const startedAt = '2026-11-23T15:00:00Z'
  const rows = phase(submissionView({ turns: [user] }, { ...attempt, snapshot: { state: 'matching', steps: [
    { kind: 'request.dispatched', requestId: 'request-2', turnId: 'turn-2', occurredAt: startedAt },
  ] } }))
  assert.equal(rows.find(r => r.phase === 'model-wait').startedAt, startedAt)
})
test('formal draft and finish stop the local spinner even on old services', () => {
  for (const kind of ['draft', 'message', 'error', 'clarification']) {
    const p = submissionView({ turns: [user, { turnId: 'draft:interaction-2', interactionId: 'interaction-2', role: 'jenny', kind, text: 'done' }] }, attempt)
    assert.ok(!p.turns.some(t => t.localStatus))
  }
})
test('only the pending draft for this receipt carries its confirmed task-change target', () => {
  const draft = { turnId: 'draft:interaction-2', interactionId: 'interaction-2', role: 'jenny', kind: 'draft', text: '重试计划' }
  const previous = { ...draft, turnId: 'draft:interaction-1', interactionId: 'interaction-1' }
  const taskId = { scope: 'task', value: 'original' }
  const p = submissionView({ turns: [previous, user, draft] }, { ...attempt, snapshot: {
    state: 'awaiting-confirmation',
    draft: { proposedIntent: 'change', matchedTasks: [{ relation: 'current', taskId }] },
  } })
  assert.equal(p.turns[0].draftReview, undefined)
  assert.deepEqual(p.turns[2].draftReview, { state: 'awaiting-confirmation', intent: 'change', taskId: 'original' })
  assert.equal(p.turns[2].taskId, undefined)
})
test('read failure remains visible and cannot animate away the error', () => {
  const error = { code: 'auth.session.expired', message: '重新配对' }
  const rows = phase(submissionView({ turns: [user] }, { ...attempt, error }))
  assert.equal(rows[0].error, error)
  assert.ok(rows.every(r => !r.running))
})
test('interrupted new-task confirmation can continue on the same draft only', () => {
  const error = { code: 'transport.failed', message: '连接已中断' }
  const onContinue = () => {}
  const draft = { turnId: 'draft:interaction-2', interactionId: 'interaction-2', role: 'jenny', kind: 'draft', text: '任务' }
  for (const [intent, canContinue] of [['create', true], ['change', false], ['append', false], [undefined, false]]) {
    const snapshot = { state: 'awaiting-confirmation', draft: { proposedIntent: intent } }
    assert.equal(canContinueSubmission(snapshot), canContinue)
    const projection = submissionView({ turns: [user, draft] }, { ...attempt, snapshot, error, processError: error, onContinue })
    assert.equal(projection.turns.at(-1).onContinue, canContinue ? onContinue : undefined)
  }
  assert.equal(canContinueSubmission({ state: 'matching' }), false)
  assert.equal(canContinueSubmission({ state: 'matching' }, { code: 'explicit-brain.interaction-scope-busy' }), true)
})
test('C07 partial offers continuation from its current interaction without inventing a send', () => {
  const onContinue = () => {}
  const snapshot = { state: 'partial', partial: { partialRef: 'partial:interaction-2' } }
  assert.equal(canContinueSubmission(snapshot), true)
  assert.equal(canContinueSubmission({ state: 'partial' }), false)
  const projection = submissionView({ turns: [user] }, { ...attempt, snapshot, onContinue })
  assert.equal(projection.turns.at(-1).onContinue, onContinue)
  assert.equal(projection.turns.filter(turn => turn.kind === 'message' && turn.text === 'same text').length, 1)
})
test('a finish read or permission error stops stale official explicit clocks', () => {
  const status = { turnId: 'status:interaction-2', interactionId: 'interaction-2', role: 'jenny', kind: 'status',
    statusFacts: { state: 'matching', steps: [{ kind: 'request.dispatched', requestId: 'r', turnId: 't', occurredAt: '2026-11-23T15:00:00Z' }] } }
  for (const extra of [{ snapshot: { state: 'answered' } }, { error: { code: 'auth.session.invalid' } }]) {
    const p = submissionView({ turns: [user, status] }, { ...attempt, ...extra })
    assert.ok(p.turns.find(t => t.turnId === status.turnId).localStatus.every(row => !row.running))
  }
})

test('an interrupted model request retains the dispatch but labels its response unresolved', () => {
  const status = { turnId: 'status:interaction-2', interactionId: 'interaction-2', role: 'jenny', kind: 'status',
    statusFacts: { state: 'matching', steps: [
      { kind: 'request.dispatching', requestId: 'r', turnId: 't', occurredAt: '2026-11-23T15:00:00Z' },
      { kind: 'request.dispatched', requestId: 'r', turnId: 't', occurredAt: '2026-11-23T15:00:03Z' },
    ] } }
  const error = { code: 'transport.failure' }
  const turns = submissionView({ turns: [user, status] }, { ...attempt, error, processError: error }).turns
  const rows = turns.find((turn) => turn.turnId === status.turnId).localStatus
  assert.equal(rows.find((row) => row.phase === 'sending').label, '请求已发出')
  const model = rows.find((row) => row.phase === 'model-wait')
  assert.equal(model.label, '模型响应中断，结果待核实')
  assert.equal(model.running, false)
  assert.equal(model.endedAt, undefined)
  assert.equal(turns.at(-1).localStatus[0].error.code, error.code)
})

test('accepted inputs keep independent states and tool facts while another request runs', () => {
  const first = { ...attempt, key: 'first', interactionId: 'interaction-a', rawInput: '第一条正在运行',
    snapshot: { state: 'matching' }, toolEvents: [{ eventId: 'a-call', kind: 'provider.tool',
      taskId: { scope: 'task', value: 'task-a' }, operationId: 'operation-a', executionEpoch: 1,
      turnId: 'turn-a', requestId: 'request-a', callId: 'call-a', toolId: 'file.read' }] }
  const second = { ...attempt, key: 'second', interactionId: 'interaction-b', rawInput: '第二条独立判断',
    snapshot: { state: 'awaiting-confirmation', draft: { proposedIntent: 'create' } } }
  const third = { ...attempt, key: 'third', interactionId: 'interaction-c', rawInput: '第三条等待回答',
    snapshot: { state: 'awaiting-clarification', clarifications: [{ question: '需要补充什么？', options: ['范围'] }] } }
  const projection = submissionView({ turns: [] }, [first, second, third])
  assert.deepEqual(projection.turns.filter(turn => turn.role === 'user').map(turn => turn.text),
    ['第一条正在运行', '第二条独立判断', '第三条等待回答'])
  const firstStatus = projection.turns.find(turn => turn.turnId === 'local-status:first')
  const secondStatus = projection.turns.find(turn => turn.turnId === 'local-status:second')
  assert.equal(firstStatus.toolEvents[0].callId, 'call-a')
  assert.equal(secondStatus.toolEvents, undefined)
  const thirdStatus = projection.turns.find(turn => turn.turnId === 'local-status:third')
  assert.equal(thirdStatus.clarification.question, '需要补充什么？')
  assert.equal(thirdStatus.toolEvents, undefined)
  assert.equal(projection.turns.some(turn => turn.localStatus?.some(row => row.phase === 'queued')), false)
})

test('each running receipt owns started and error state without another receipt\'s facts', () => {
  const started = { kind: 'execution.started', occurredAt: '2026-11-25T20:00:00Z' }
  const first = { key: 'running', interactionId: 'interaction-a', rawInput: 'A', snapshot: { state: 'confirmed' },
    executionStarted: started }
  const second = { key: 'error', interactionId: 'interaction-b', rawInput: 'B',
    error: { code: 'request.rejected', message: 'B 未获接受' } }
  const rows = submissionView({ turns: [] }, [first, second]).turns
    .filter(turn => turn.turnId.startsWith('local-status:'))
  assert.equal(rows[0].localStatus[0].phase, 'execution')
  assert.equal(rows[0].localStatus[0].startedAt, started.occurredAt)
  assert.equal(rows[0].localStatus[0].error, undefined)
  assert.equal(rows[1].localStatus[0].error.message, 'B 未获接受')
})
