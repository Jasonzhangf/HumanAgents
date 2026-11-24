// Page-local transport presentation. Never a runtime control source.
import { conversationStatus } from './conversation-status.js'
export const intakeFinished = new Set(['answered', 'status-only', 'awaiting-confirmation', 'awaiting-clarification', 'confirmed', 'dispatched', 'rejected', 'failed', 'stopped', 'cancelled'])

export function draftReviewFromSnapshot(snapshot) {
  if (snapshot?.state !== 'awaiting-confirmation' || !snapshot.draft) return undefined
  const target = snapshot.draft.matchedTasks?.find(task => task.relation === 'current')?.taskId
  return { state: snapshot.state, intent: snapshot.draft.proposedIntent, taskId: target?.value }
}

export function canContinueSubmission(snapshot, processError) {
  return (snapshot?.state === 'partial' && typeof snapshot.partial?.partialRef === 'string'
      && snapshot.partial.partialRef !== '')
    || snapshot?.state === 'received'
    || (snapshot?.state === 'matching' && processError?.code === 'explicit-brain.interaction-scope-busy')
    || (snapshot?.state === 'awaiting-confirmation' && snapshot.draft?.proposedIntent === 'create')
}

// The receipt protects the one live turn even before its first snapshot read
// arrives. Clarification and confirmation also remain with the user.
export function submissionNeedsResolution(attempt) {
  if (!attempt?.interactionId) return false
  const state = attempt.snapshot?.state
  return state === undefined
    || state === 'awaiting-clarification'
    || state === 'awaiting-confirmation'
    || !intakeFinished.has(state)
}

function mergeIntakeSteps(recorded = [], live = []) {
  if (!live.length) return recorded
  return [...new Map([...live, ...recorded].map(step => [step.seq, step])).values()].sort((a, b) => a.seq - b.seq)
}

export function submissionView(projection, attempts) {
  const pending = (Array.isArray(attempts) ? attempts : attempts ? [attempts] : []).filter(Boolean)
  if (pending.length === 0) return projection
  const turns = [...(projection.turns || [])]
  for (const attempt of pending) {
    const id = attempt.interactionId
    const belongs = turn => id && (turn.interactionId === id || turn.turnId === `user:${id}` || turn.turnId === `draft:${id}`)
    if (!turns.some(turn => turn.role === 'user' && belongs(turn))) turns.push({
      turnId: `local-user:${attempt.key}`, role: 'user', kind: 'message', text: attempt.rawInput,
    })
    for (const [index, turn] of turns.entries()) {
      if (belongs(turn) && turn.statusFacts?.steps !== undefined && attempt.steps?.length) {
        turns[index] = { ...turn, statusFacts: { ...turn.statusFacts, steps: mergeIntakeSteps(turn.statusFacts.steps, attempt.steps) } }
      }
    }
    const related = turns.filter(belongs)
    const official = related.find(turn => turn.statusFacts)
    const snapshot = attempt.snapshot
    const steps = mergeIntakeSteps(snapshot?.steps, attempt.steps)
    const draftReview = draftReviewFromSnapshot(snapshot)
    if (draftReview) {
      const index = turns.findIndex(turn => belongs(turn) && turn.kind === 'draft')
      if (index !== -1) turns[index] = { ...turns[index], draftReview }
    }
    const finished = intakeFinished.has(snapshot?.state) || related.some(turn =>
      ['draft', 'clarification', 'result', 'error'].includes(turn.kind)
      || (turn.role !== 'user' && turn.kind === 'message'))
    if (attempt.error || finished) {
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]
        if (belongs(turn) && turn.statusFacts && (attempt.error || turn.statusFacts.steps !== undefined)) {
          const localStatus = conversationStatus(turn.statusFacts).map(row => ({
            ...row,
            running: false,
            ...(attempt.error && attempt.processError && row.running && ['model-wait', 'streaming'].includes(row.phase)
              ? { label: '模型响应中断，结果待核实' } : {}),
          }))
          turns[i] = { ...turn, localStatus }
        }
      }
    }
    // Official fact clocks stay with the runtime turn. Only a transport failure
    // overlays them; a successful read removes that overlay.
    if (finished && !attempt.error) continue
    const canContinue = !attempt.queued && canContinueSubmission(snapshot, attempt.processError)
    turns.push({ turnId: `local-status:${attempt.key}`, role: 'jenny', kind: 'status', text: '',
      explicitSteps: steps,
      localStatus: attempt.queued
        ? [{ key: 'queued', phase: 'queued', running: false,
          label: '排队中，等待上一轮处理完成', tone: 'warning' }]
        : attempt.error ? [{ key: 'read-error', phase: 'error', running: false,
          label: id ? '状态读取或处理已中断' : '尚未确认接收，请先核对状态', tone: 'danger', error: attempt.error,
          ...(canContinue ? { statusLabel: '可按原回执继续本次处理' } : {}) }]
          : id && steps.length ? [
            { key: 'accepted', phase: 'accepted', label: '服务已接收', running: false, tone: 'success' },
            ...conversationStatus({ state: snapshot?.state || 'matching', steps, error: snapshot?.error }),
          ]
            : [{ key: id ? 'accepted' : 'sending', phase: id ? 'accepted' : 'sending',
              label: id ? '服务已接收，等候最新状态' : '发送中', running: !id,
              startedAt: id ? undefined : attempt.startedAt, tone: 'warning' }],
      onRecover: attempt.queued ? undefined : attempt.onRecover,
      onContinue: canContinue ? attempt.onContinue : undefined,
    })
  }
  return projectionWithTurns(projection, turns)
}

function projectionWithTurns(projection, turns) {
  // Local transport turns have no server round references. Keep them visible
  // without altering authoritative round metadata or persisting fake rounds.
  return { ...projection, turns, localTurnIds: turns.filter(t => t.turnId.startsWith('local-')).map(t => t.turnId) }
}
