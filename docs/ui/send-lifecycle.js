// Page-local transport presentation. Never a runtime control source.
import { conversationStatus } from './conversation-status.js'
export const intakeFinished = new Set(['answered', 'status-only', 'awaiting-confirmation', 'awaiting-clarification', 'confirmed', 'dispatched', 'rejected', 'failed', 'stopped', 'cancelled'])

export function submissionView(projection, attempt) {
  if (!attempt) return projection
  const turns = [...(projection.turns || [])]
  const id = attempt.interactionId
  const belongs = turn => id && (turn.interactionId === id || turn.turnId === `user:${id}` || turn.turnId === `draft:${id}`)
  if (!turns.some(turn => turn.role === 'user' && belongs(turn))) turns.push({
    turnId: `local-user:${attempt.key}`, role: 'user', kind: 'message', text: attempt.rawInput,
  })
  const related = turns.filter(belongs)
  const official = related.find(turn => turn.statusFacts)
  const snapshot = attempt.snapshot
  const finished = intakeFinished.has(snapshot?.state) || related.some(turn =>
    ['draft', 'clarification', 'result', 'error'].includes(turn.kind)
    || (turn.role !== 'user' && turn.kind === 'message'))
  if (attempt.error || finished) {
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]
      if (belongs(turn) && turn.statusFacts && (attempt.error || turn.statusFacts.steps !== undefined)) {
        turns[i] = { ...turn, localStatus: conversationStatus(turn.statusFacts).map(row => ({ ...row, running: false })) }
      }
    }
  }
  // Official fact clocks stay with the runtime turn. Only a transport failure
  // overlays them; a successful read removes that overlay.
  if (official && !attempt.error) return projectionWithTurns(projection, turns)
  if (finished && !attempt.error) return projectionWithTurns(projection, turns)
  turns.push({ turnId: `local-status:${attempt.key}`, role: 'jenny', kind: 'status', text: '',
    localStatus: attempt.error ? [{ key: 'read-error', phase: 'error', running: false,
      label: id ? '状态读取或处理已中断' : '尚未确认接收，请先核对状态', tone: 'danger', error: attempt.error }]
      : id && snapshot?.steps?.length ? [
        { key: 'accepted', phase: 'accepted', label: '服务已接收', running: false, tone: 'success' },
        ...conversationStatus({ state: snapshot.state, steps: snapshot.steps, error: snapshot.error }),
      ]
        : [{ key: id ? 'accepted' : 'sending', phase: id ? 'accepted' : 'sending',
          label: id ? '服务已接收，等候最新状态' : '发送中', running: !id,
          startedAt: id ? undefined : attempt.startedAt, tone: 'warning' }],
    onRecover: attempt.onRecover,
    onContinue: attempt.processError && snapshot?.state === 'received' ? attempt.onContinue : undefined,
  })
  return projectionWithTurns(projection, turns)
}

function projectionWithTurns(projection, turns) {
  // Local transport turns have no server round references. Keep them visible
  // without altering authoritative round metadata or persisting fake rounds.
  return { ...projection, turns, localTurnIds: turns.filter(t => t.turnId.startsWith('local-')).map(t => t.turnId) }
}
