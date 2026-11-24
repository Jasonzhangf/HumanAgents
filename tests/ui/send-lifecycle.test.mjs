import { test } from 'node:test'
import assert from 'node:assert/strict'
import { submissionView, canContinueSubmission, submissionNeedsResolution } from '../../docs/ui/send-lifecycle.js'

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

test('a queued message stays behind the active turn with explicit waiting semantics', () => {
  const active = { ...attempt, snapshot: { state: 'matching' } }
  const queued = { key: 'queued-3', rawInput: '第三条仍等待', startedAt: '2026-11-24T10:00:01Z', queued: true }
  const projection = submissionView({ turns: [] }, [active, queued])
  const users = projection.turns.filter(turn => turn.role === 'user').map(turn => turn.text)
  assert.deepEqual(users, ['same text', '第三条仍等待'])
  const queuedStatus = projection.turns.find(turn => turn.turnId === 'local-status:queued-3')
  assert.equal(queuedStatus.localStatus[0].phase, 'queued')
  assert.equal(queuedStatus.localStatus[0].label, '排队中，等待上一轮处理完成')
})

test('completion of the active turn cannot overwrite the queued draft or order', () => {
  const active = { ...attempt, snapshot: { state: 'answered', reply: '第一条摘要' } }
  const queued = { key: 'queued-4', rawInput: '用户第二条草稿', startedAt: '2026-11-24T10:00:02Z', queued: true }
  const projection = submissionView({ turns: [user, { ...user, turnId: `reply:${user.interactionId}`, role: 'jenny', kind: 'message', text: '第一条摘要' }] }, [active, queued])
  const local = projection.turns.filter(turn => turn.turnId.startsWith('local-'))
  assert.deepEqual(local.map(turn => turn.turnId), ['local-user:queued-4', 'local-status:queued-4'])
  assert.equal(local[0].text, '用户第二条草稿')
  assert.equal(local.some(turn => turn.text === '第一条摘要'), false)
})

test('an active failure is rendered before the following queued draft', () => {
  const failed = { key: 'failed-5', rawInput: '第一条失败内容', startedAt: '2026-11-24T10:00:01Z',
    error: { code: 'transport.failure', message: '连接中断' } }
  const queued = { key: 'queued-5', rawInput: '第二条新草稿', startedAt: '2026-11-24T10:00:02Z', queued: true }
  const local = submissionView({ turns: [] }, [failed, queued]).turns
    .filter(turn => turn.turnId.startsWith('local-'))
  assert.deepEqual(local.map(turn => turn.turnId), [
    'local-user:failed-5', 'local-status:failed-5', 'local-user:queued-5', 'local-status:queued-5',
  ])
  assert.equal(local[1].localStatus[0].error.code, 'transport.failure')
  assert.equal(local[2].text, '第二条新草稿')
})

test('unfinished and user-owned states keep the next live turn queued', () => {
  assert.equal(submissionNeedsResolution({ interactionId: 'interaction-1', snapshot: { state: 'matching' } }), true)
  assert.equal(submissionNeedsResolution({ interactionId: 'interaction-1' }), true)
  assert.equal(submissionNeedsResolution({ interactionId: 'interaction-1', snapshot: { state: 'awaiting-clarification' } }), true)
  assert.equal(submissionNeedsResolution({ interactionId: 'interaction-1', snapshot: { state: 'awaiting-confirmation' } }), true)
  assert.equal(submissionNeedsResolution({ interactionId: 'interaction-1', snapshot: { state: 'answered' } }), false)
  assert.equal(submissionNeedsResolution({ error: { code: 'transport.failure' } }), false)
})
