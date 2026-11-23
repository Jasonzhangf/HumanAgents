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
})
test('a finish read or permission error stops stale official explicit clocks', () => {
  const status = { turnId: 'status:interaction-2', interactionId: 'interaction-2', role: 'jenny', kind: 'status',
    statusFacts: { state: 'matching', steps: [{ kind: 'request.dispatched', requestId: 'r', turnId: 't', occurredAt: '2026-11-23T15:00:00Z' }] } }
  for (const extra of [{ snapshot: { state: 'answered' } }, { error: { code: 'auth.session.invalid' } }]) {
    const p = submissionView({ turns: [user, status] }, { ...attempt, ...extra })
    assert.ok(p.turns.find(t => t.turnId === status.turnId).localStatus.every(row => !row.running))
  }
})
