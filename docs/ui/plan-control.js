// Single owner for presenting a persisted execution plan (`SubscriptionState`)
// and its control edge.
//
// Every value here is a fact of a runtime read. The durable state is rendered
// verbatim through `PLAN_STATE_LABELS`; an unknown state falls back to its raw
// value so the page never translates an unrecognised state into a claim the
// read did not make. A control button is offered only for an action the caller
// lists as available from that read.
//
// The control edge is plan-scoped: `POST /api/plans/{subscriptionId}/control`.
// A scheduled plan has no coordinator task until its first claim, so addressing
// the plan by its own id is the only edge that can reach it.
import { element } from './runtime-api.js'

/**
 * The real durable `SubscriptionState` set. There is no `paused`: pausing a
 * plan yields `suspended`. All five values render as themselves.
 */
export const PLAN_STATE_LABELS = {
  active: '生效中',
  completed: '已完成',
  exhausted: '已耗尽',
  cancelled: '已取消',
  suspended: '已暂停',
}

export const PLAN_MODE_LABELS = { once: '单次', scheduled: '定时', recurring: '周期' }

export const PLAN_STATE_TONES = {
  active: 'success',
  completed: 'gray',
  exhausted: 'gray',
  cancelled: 'gray',
  suspended: 'warning',
}

export const PLAN_CONTROLS = [
  { action: 'pause', label: '暂停计划', className: 'button button--quiet' },
  { action: 'resume', label: '继续计划', className: 'button button--primary' },
  { action: 'cancel-future', label: '取消后续执行', className: 'button button--danger' },
]

export function planStateLabel(state) {
  if (state === undefined || state === null || state === '') return '未提供'
  return PLAN_STATE_LABELS[state] || String(state)
}

export function planModeLabel(mode) {
  if (mode === undefined || mode === null || mode === '') return '未提供'
  return PLAN_MODE_LABELS[mode] || String(mode)
}

export function planStateTone(state) {
  return PLAN_STATE_TONES[state] || 'gray'
}

export function planControlLabel(action) {
  return PLAN_CONTROLS.find((control) => control.action === action)?.label || action
}

/**
 * Control availability restated from the durable `state` fact of a plan read
 * that does not carry the `can*` booleans (the scheduler plan list).
 *
 * This is the same advisory restatement `projectExecutionPlan` publishes: pause
 * requires `active`, resume requires `suspended`, and cancel-future is refused
 * only when the plan is already `cancelled`. It is never a control truth — the
 * port re-checks inside its own transaction, and a refusal is rendered as the
 * typed rejection it is.
 */
export function planActionsForState(state) {
  return PLAN_CONTROLS
    .filter((control) => {
      if (control.action === 'pause') return state === 'active'
      if (control.action === 'resume') return state === 'suspended'
      return state !== 'cancelled'
    })
    .map((control) => control.action)
}

/**
 * The next due instant a plan read reports, if any. Only `due` occurrences are
 * pending slots, so an already claimed or consumed slot is not presented as the
 * next due time.
 */
export function planNextDueAt(plan) {
  const due = (plan.occurrences ?? []).filter((occurrence) => occurrence.state === 'due')
  if (due.length === 0) return undefined
  return [...due].sort((left, right) => left.occurrenceOrdinal - right.occurrenceOrdinal)[0].dueAt
}

/**
 * One control request needs one idempotency key. It is minted per click so a
 * retried request is a durable duplicate instead of a second action.
 */
export function planControlKey(subscriptionId, action) {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `plan-control:${subscriptionId}:${action}:${random}`
}

function revisionText(value) {
  return Number.isFinite(value) ? String(value) : '未提供'
}

/**
 * The 200 body reports what the runtime did with the control. Only `applied`
 * means the plan changed: `duplicate` means an identical control was already
 * applied, and `stale`/`conflict` mean it did not take effect. An unknown status
 * is reported as unrecognised instead of being read as success.
 */
export function planControlResultCopy(action, result) {
  const label = planControlLabel(action)
  const revisions = `policy=${revisionText(result.policyRevision)} · schedule=${revisionText(result.scheduleRevision)}`
  const superseded = Array.isArray(result.supersededUnclaimedOccurrences)
    ? ` · 已取消未领取的到期 ${result.supersededUnclaimedOccurrences.length} 个`
    : ''
  switch (result.status) {
    case 'applied':
      return `${label}已生效 · ${revisions}${superseded} · control=${result.controlRef || '未提供'}`
    case 'duplicate':
      return `${label}此前已生效，本次未重复应用 · ${revisions} · key=${result.idempotencyKey || '未提供'}`
    case 'stale':
      return `${label}未生效：计划已被其他控制改变 · ${revisions} · next=重新读取计划后再选择控制`
    case 'conflict':
      return `${label}未生效：与当前计划状态冲突 · ${revisions} · next=按当前计划状态重新选择控制`
    default:
      return `${label}结果未识别：status=${result.status === undefined ? '未提供' : String(result.status)}`
  }
}

/**
 * A typed rejection is rendered as the error it is: code, owner, message and
 * the next action the owning component declared. It is never folded into a
 * success notice.
 */
export function planControlErrorMessage(error) {
  return `计划控制被拒绝 · code=${error?.code || 'runtime.request.failed'} · owner=${error?.ownerId || 'unknown'} · ${error?.message || String(error)} · next=${error?.nextAction || 'inspect the runtime error'}`
}

export function planControlPendingCopy(action) {
  return `正在提交${planControlLabel(action)}…`
}

function formatTime(value) {
  if (!value) return '未提供'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

/**
 * Render one persisted plan as a section.
 *
 * `plan.availableActions` is the caller's expression of the read's own control
 * facts; an action absent from it renders no button. `plan.nextDueAt` is shown
 * only when the read reported one, and `plan.state` is shown verbatim.
 */
export function renderPlanSection(plan, options = {}) {
  const availableActions = plan.availableActions ?? planActionsForState(plan.state)
  const section = element('section', undefined, 'section')
  section.dataset.planSection = 'true'
  section.dataset.planSubscription = plan.subscriptionId ?? ''
  section.append(element('h2', options.title || '执行计划'))
  const panel = element('div', undefined, 'panel')

  const facts = element('dl', undefined, 'detail-grid')
  const stateCell = element('div', undefined, 'detail-cell')
  const stateChip = element('span', planStateLabel(plan.state), 'state-chip')
  stateChip.dataset.planState = plan.state ?? ''
  stateChip.dataset.tone = planStateTone(plan.state)
  stateCell.append(element('dt', '计划状态'), stateChip)
  facts.append(stateCell)

  if (plan.executionMode !== undefined) {
    const modeCell = element('div', undefined, 'detail-cell')
    const modeValue = element('span', planModeLabel(plan.executionMode))
    modeValue.dataset.planMode = plan.executionMode ?? ''
    modeCell.append(element('dt', '执行模式'), modeValue)
    facts.append(modeCell)
  }

  const dueCell = element('div', undefined, 'detail-cell')
  const dueValue = element('span', plan.nextDueAt ? formatTime(plan.nextDueAt) : '未提供')
  dueValue.dataset.planNextDue = plan.nextDueAt ?? ''
  dueCell.append(element('dt', '下次到期'), dueValue)
  facts.append(dueCell)
  panel.append(facts)

  const available = PLAN_CONTROLS.filter((control) => availableActions.includes(control.action))
  const actions = element('div', undefined, 'actions')
  for (const control of available) {
    const button = element('button', control.label, control.className)
    button.type = 'button'
    button.dataset.planAction = control.action
    button.addEventListener('click', () => void options.onControl?.(control.action))
    actions.append(button)
  }
  if (available.length === 0) {
    actions.append(element('p', '这次读取没有报告可用的计划控制。', 'muted'))
  }
  panel.append(actions)

  const notice = element('p', options.notice || `计划状态：${planStateLabel(plan.state)}。`, 'muted')
  notice.dataset.planStatus = 'true'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  panel.append(notice)

  const details = element('details')
  details.dataset.planDetails = 'true'
  const body = element('dl', undefined, 'event-detail')
  const rows = [
    ['subscriptionId', plan.subscriptionId],
    ['state', plan.state],
  ]
  if (plan.executionMode !== undefined) rows.push(['executionMode', plan.executionMode])
  if (plan.goalId !== undefined) rows.push(['goalId', plan.goalId])
  if (plan.scheduleRevision !== undefined) rows.push(['scheduleRevision', plan.scheduleRevision])
  if (plan.currentOccurrenceOrdinal !== undefined) rows.push(['currentOccurrenceOrdinal', plan.currentOccurrenceOrdinal])
  rows.push(['nextDueAt', plan.nextDueAt], ['可用控制', availableActions.join(', ')])
  for (const [label, value] of rows) {
    const cell = element('div')
    cell.append(
      element('dt', label),
      element('dd', value === undefined || value === null || value === '' ? '未提供' : String(value)),
    )
    body.append(cell)
  }
  details.append(element('summary', '计划技术身份'), body)
  panel.append(details)

  section.append(panel)
  return section
}
