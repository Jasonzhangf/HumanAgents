import {
  api,
  clearNode,
  element,
  loadRuntimeStatus,
  makePageShell,
  observationHref,
  renderRuntimeStatus,
  stateTone,
  taskDetailHref,
  taskIdFromQuery,
} from './runtime-shell.js'

const taskId = taskIdFromQuery()
const { main, status } = makePageShell(
  'Task List',
  'Task Dashboard',
  '任务看板',
  '当前状态、执行节点、事件、checkpoint 和操作都来自 HumanAgent Runtime API。',
)

let dashboard
let stream
let closingStream = false
let subscribedOperationId
let observeTimer
let actionStatus
let connectionState = 'connecting'
let lastEventAt = ''
let lastSyncAt = ''
let lastSeenSeq = 0
let historyPage = 0
const seenEventIds = new Set()

const OBSERVE_REFRESH_MS = 750
const HISTORY_PAGE_SIZE = 10

function formatPreciseTime(value) {
  if (!value) return '未知时间'
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

function setRefreshError(error) {
  status.dataset.tone = 'danger'
  status.textContent = `读取任务失败：${error instanceof Error ? error.message : String(error)}`
}

function isReplay(event) {
  if (event.seq != null && event.seq <= lastSeenSeq) return true
  if (event.eventId && seenEventIds.has(event.eventId)) return true
  return false
}

function rememberEvent(event) {
  if (event.seq != null) lastSeenSeq = Math.max(lastSeenSeq, event.seq)
  if (event.eventId) seenEventIds.add(event.eventId)
}

function shouldObserveActiveState() {
  return ['created', 'admitted', 'running', 'settling'].includes(dashboard.state)
    && !dashboard.operationId
}

function visibleRecentEvents(events) {
  return events.filter((event) => event.kind !== 'provider.model' || (event.summary && event.summary !== 'model'))
}

function isRequestStart(event) {
  return event.kind === 'provider.model' && event.summary === 'provider requested model work'
}

function eventIdentity(event) {
  return event.eventId ?? String(event.seq ?? '')
}

function historyChunks(events) {
  const turns = []
  let current
  let modelTurn = 0
  for (const event of events) {
    const requestStart = isRequestStart(event)
    if (requestStart) modelTurn += 1
    if (!current || requestStart) {
      current = {
        label: requestStart ? '模型轮次' : '任务事件',
        turnNumber: requestStart ? modelTurn : 0,
        events: [],
      }
      turns.push(current)
    }
    current.events.push(event)
  }
  return turns.flatMap((turn) => {
    const chunks = []
    for (let index = 0; index < turn.events.length; index += HISTORY_PAGE_SIZE) {
      chunks.push({
        label: turn.label,
        turnNumber: turn.turnNumber,
        events: turn.events.slice(index, index + HISTORY_PAGE_SIZE),
      })
    }
    return chunks
  })
}

function connectionText() {
  const syncedAt = lastSyncAt ? formatPreciseTime(lastSyncAt) : '尚未同步'
  const eventAge = lastEventAt ? ageText(lastEventAt) : '尚无业务事件'
  if (taskSettled()) {
    return `执行已收拢 · 最近同步 ${syncedAt} · 最近业务事件 ${eventAge}`
  }
  if (connectionState === 'disconnected') {
    return `实时连接已断开 · 最近同步 ${syncedAt} · 最近业务事件 ${eventAge}`
  }
  if (connectionState === 'connected') {
    return `实时连接已建立 · 最近同步 ${syncedAt} · 最近业务事件 ${eventAge}`
  }
  return '正在连接实时事件流 · 尚未同步'
}

function taskSettled() {
  if (!dashboard) return false
  if (dashboard.checkpoint) return true
  return ['succeeded', 'failed'].includes(dashboard.state)
}

function businessStateLabel() {
  if (!dashboard) return '未知'
  if ((dashboard.state === 'stopped' || dashboard.state === 'cancelled') && !dashboard.checkpoint) {
    return '停止请求已受理'
  }
  return dashboard.stateLabel
}

function ageText(since) {
  const delta = Date.now() - new Date(since).getTime()
  if (Number.isNaN(delta)) return '未知'
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return '< 1 分钟'
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.floor(minutes / 60)} 小时前`
}

function markSync() {
  lastSyncAt = new Date().toISOString()
  if (dashboard.history?.events?.length) {
    const newest = dashboard.history.events.reduce((max, event) => (
      String(event.occurredAt) > String(max) ? event.occurredAt : max
    ), '')
    if (newest) lastEventAt = newest
  }
}

function actionCopy() {
  if (dashboard.state === 'succeeded') return dashboard.output ? '任务已完成，结果可用。' : '任务已完成；当前没有合法操作。'
  if (dashboard.state === 'stopped') {
    return dashboard.checkpoint
      ? '已停止；收拢 receipt / checkpoint 已提交。'
      : '停止请求已受理，但尚未收到收拢 receipt；不能宣称已停止。'
  }
  if (dashboard.state === 'blocked') return '执行失败或受阻，仍在释放资源；请按详情中的恢复动作处理。'
  if (dashboard.state === 'failed') return dashboard.error
    ? `执行失败：${dashboard.error.nextAction}`
    : '执行失败；请查看详情中的证据。'
  if (dashboard.allowedActions.includes('start')) return '当前没有正在运行的执行；可以进入显式大脑发起新的处理。'
  return dashboard.allowedActions.length > 0
    ? `当前可用操作：${dashboard.allowedActions.join(', ')}。`
    : '当前没有合法操作；请等待收拢或按详情处理。'
}

// The plan surface is driven only by the dashboard read: the state, mode and due
// time are reported facts, and a control is rendered only when the read marks it
// available. A label falls back to the raw value, so an unknown state is never
// translated into a claim the read did not make.
const PLAN_STATE_LABELS = { active: '生效中', paused: '已暂停', cancelled: '已取消' }
const PLAN_MODE_LABELS = { once: '单次', scheduled: '定时', recurring: '周期' }
const PLAN_STATE_TONES = { active: 'success', paused: 'warning', cancelled: 'gray' }
const PLAN_CONTROLS = [
  { action: 'pause', field: 'canPause', label: '暂停计划', className: 'button button--quiet' },
  { action: 'resume', field: 'canResume', label: '继续计划', className: 'button button--primary' },
  { action: 'cancel-future', field: 'canCancelFuture', label: '取消后续执行', className: 'button button--danger' },
]

let planControlNotice = ''

function planStateLabel(state) {
  if (state === undefined || state === null || state === '') return '未提供'
  return PLAN_STATE_LABELS[state] || String(state)
}

function planModeLabel(mode) {
  if (mode === undefined || mode === null || mode === '') return '未提供'
  return PLAN_MODE_LABELS[mode] || String(mode)
}

function planControlKey(subscriptionId, action) {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `plan-control:${subscriptionId}:${action}:${random}`
}

/**
 * The 200 body reports what the runtime did with the control. Only `applied`
 * means the plan changed: `duplicate` means an identical control was already
 * applied, and `stale`/`conflict` mean it did not take effect. An unknown status
 * is reported as unrecognised instead of being read as success.
 */
function planControlResultCopy(action, result) {
  const label = PLAN_CONTROLS.find((control) => control.action === action)?.label || action
  const revisions = `policy=${result.policyRevision || '未提供'} · schedule=${result.scheduleRevision || '未提供'}`
  const superseded = Number.isFinite(result.supersededUnclaimedOccurrences)
    ? ` · 已取消未领取的到期 ${result.supersededUnclaimedOccurrences} 个`
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

async function runPlanControl(action) {
  const plan = dashboard?.plan
  if (!plan) return
  const label = PLAN_CONTROLS.find((control) => control.action === action)?.label || action
  planControlNotice = `正在提交${label}…`
  renderDashboard()
  try {
    const result = await api.planControl(taskId, {
      action,
      idempotencyKey: planControlKey(plan.subscriptionId, action),
      requestedAt: new Date().toISOString(),
    })
    planControlNotice = planControlResultCopy(action, result)
    await refresh()
  } catch (error) {
    planControlNotice = `计划控制被拒绝 · code=${error.code || 'runtime.request.failed'} · owner=${error.ownerId || 'unknown'} · ${error.message} · next=${error.nextAction || 'inspect the runtime error'}`
    renderDashboard()
    await refresh().catch(setRefreshError)
  }
}

function renderPlanSection(plan) {
  const section = element('section', undefined, 'section')
  section.dataset.planSection = 'true'
  section.dataset.planSubscription = plan.subscriptionId ?? ''
  section.append(element('h2', '执行计划'))
  const panel = element('div', undefined, 'panel')

  const facts = element('dl', undefined, 'detail-grid')
  const stateCell = element('div', undefined, 'detail-cell')
  const stateChip = element('span', planStateLabel(plan.state), 'state-chip')
  stateChip.dataset.planState = plan.state ?? ''
  stateChip.dataset.tone = PLAN_STATE_TONES[plan.state] || 'gray'
  stateCell.append(element('dt', '计划状态'), stateChip)
  const modeCell = element('div', undefined, 'detail-cell')
  const modeValue = element('span', planModeLabel(plan.executionMode))
  modeValue.dataset.planMode = plan.executionMode ?? ''
  modeCell.append(element('dt', '执行模式'), modeValue)
  const dueCell = element('div', undefined, 'detail-cell')
  const dueValue = element('span', plan.nextDueAt ? formatPreciseTime(plan.nextDueAt) : '未提供')
  dueValue.dataset.planNextDue = plan.nextDueAt ?? ''
  dueCell.append(element('dt', '下次到期'), dueValue)
  facts.append(stateCell, modeCell, dueCell)
  panel.append(facts)

  const available = PLAN_CONTROLS.filter((control) => plan[control.field] === true)
  const actions = element('div', undefined, 'actions')
  for (const control of available) {
    const button = element('button', control.label, control.className)
    button.type = 'button'
    button.dataset.planAction = control.action
    button.addEventListener('click', () => void runPlanControl(control.action))
    actions.append(button)
  }
  if (available.length === 0) {
    actions.append(element('p', '这次读取没有报告可用的计划控制。', 'muted'))
  }
  panel.append(actions)

  const notice = element('p', planControlNotice || `计划状态：${planStateLabel(plan.state)}。`, 'muted')
  notice.dataset.planStatus = 'true'
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  panel.append(notice)

  const details = element('details')
  details.dataset.planDetails = 'true'
  const body = element('dl', undefined, 'event-detail')
  for (const [label, value] of [
    ['subscriptionId', plan.subscriptionId],
    ['executionMode', plan.executionMode],
    ['nextDueAt', plan.nextDueAt],
    ['canPause', plan.canPause],
    ['canResume', plan.canResume],
    ['canCancelFuture', plan.canCancelFuture],
  ]) {
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

function stopObserving() {
  if (observeTimer) {
    clearTimeout(observeTimer)
    observeTimer = 0
  }
}

function scheduleObservation() {
  stopObserving()
  if (!shouldObserveActiveState()) return
  observeTimer = setTimeout(() => {
    observeTimer = 0
    void refresh().catch(setRefreshError)
  }, OBSERVE_REFRESH_MS)
}

function renderDashboard() {
  if (!dashboard) return
  clearNode(main)

  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', '当前任务', 'eyebrow'), element('h1', dashboard.taskTitle))
  const stateChip = element('span', businessStateLabel(), 'state-chip')
  stateChip.dataset.tone = stateTone(dashboard.state)
  copy.append(stateChip)
  heading.append(copy, status)
  main.append(heading)

  const statuses = element('dl', undefined, 'detail-grid status-layers')
  for (const [label, value] of [
    ['任务业务状态', dashboard.statusSections.business],
    ['等待 / 收拢状态', dashboard.statusSections.waiting],
    ['连接新鲜度', connectionText()],
  ]) {
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', value))
    statuses.append(cell)
  }
  main.append(statuses)

  const facts = element('dl', undefined, 'detail-grid')
  for (const [label, value] of [
    ['当前状态', dashboard.stateLabel],
    ['当前执行节点', dashboard.currentNode],
    ['模式', dashboard.mode],
    ['最近下一步', dashboard.nextStep],
    ['输入', dashboard.input || '尚未输入'],
    ['输出', dashboard.output || '尚无输出'],
    ['错误 owner', dashboard.error ? `${dashboard.error.ownerId} · ${dashboard.error.nextAction}` : '无错误'],
    ['Checkpoint', dashboard.checkpoint ? `${dashboard.checkpoint.outcome} · seq=${dashboard.checkpoint.seq} · ${dashboard.checkpoint.summary}` : '本任务尚无 checkpoint'],
    ['最近业务事件', lastEventAt ? formatPreciseTime(lastEventAt) : '尚无业务事件'],
  ]) {
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', value))
    facts.append(cell)
  }
  main.append(facts)

  const execution = element('section', undefined, 'section')
  execution.append(element('h2', '任务控制'))
  const panel = element('div', undefined, 'panel')
  const actions = element('div', undefined, 'actions')
  const stopButton = element('button', 'Stop / 收拢', 'button button--danger')
  stopButton.type = 'button'
  stopButton.disabled = !dashboard.allowedActions.includes('stop')
  stopButton.addEventListener('click', () => void stopExecution())
  const retryStopButton = element('button', 'Retry Stop / 重试收拢', 'button button--danger')
  retryStopButton.type = 'button'
  retryStopButton.disabled = !dashboard.allowedActions.includes('retry-stop')
  retryStopButton.addEventListener('click', () => void retryStopExecution())
  if (dashboard.allowedActions.includes('stop')) actions.append(stopButton)
  if (dashboard.allowedActions.includes('retry-stop')) actions.append(retryStopButton)
  if (dashboard.allowedActions.includes('start')) {
    const detailLink = element('a', '进入显式大脑', 'button button--primary')
    detailLink.href = `${taskDetailHref(taskId)}#task-interaction`
    actions.append(detailLink)
  }
  actionStatus = element('p', actionCopy(), 'muted')
  actionStatus.setAttribute('role', 'status')
  actionStatus.setAttribute('aria-live', 'polite')
  panel.append(actions, actionStatus)
  execution.append(panel)
  main.append(execution)

  // The plan section exists only when the dashboard read reports a persisted
  // plan; a task without one must not show a plan surface at all.
  if (dashboard.plan) main.append(renderPlanSection(dashboard.plan))

  const events = element('section', undefined, 'section')
  events.append(element('h2', '执行轨迹'))
  const eventPanel = element('div', undefined, 'panel')
  const history = dashboard.history ?? { events: dashboard.recentEvents, hasMore: false, omitted: 0, gap: false, total: dashboard.recentEvents.length }
  const allHistoryEvents = visibleRecentEvents(history.events ?? [])
  const chunks = historyChunks(allHistoryEvents)
  const pageCount = Math.max(1, chunks.length)
  historyPage = Math.min(Math.max(historyPage, 0), pageCount - 1)
  const pageStart = Math.max(0, chunks.length - (historyPage + 1))
  const pageEnd = chunks.length - historyPage
  const pageChunks = chunks.slice(pageStart, pageEnd)
  const pageEventCount = pageChunks.reduce((total, chunk) => total + chunk.events.length, 0)
  const olderEventCount = chunks.slice(0, pageStart).reduce((total, chunk) => total + chunk.events.length, 0)
  if (pageEventCount === 0) {
    eventPanel.append(element('p', '尚无事件。', 'empty'))
  } else {
    if (history.gap || pageStart > 0 || pageCount > 1) {
      const summaryText = history.gap
        ? ` · 最近事件摘要截断 ${history.omitted ?? 0} 条`
        : ''
      eventPanel.append(element('p', `执行轨迹第 ${pageCount - historyPage} / ${pageCount} 页 · 共 ${allHistoryEvents.length} 条 · 本页 ${pageEventCount} 条${olderEventCount > 0 ? ` · 更早还有 ${olderEventCount} 条` : ''}${summaryText}`, 'muted history-gap'))
      const pager = element('div', undefined, 'history-pager')
      const older = element('button', '更早', 'button button--quiet')
      older.type = 'button'
      older.disabled = pageStart === 0
      older.addEventListener('click', () => {
        historyPage += 1
        renderDashboard()
      })
      const newer = element('button', '更新', 'button button--quiet')
      newer.type = 'button'
      newer.disabled = historyPage <= 0
      newer.addEventListener('click', () => {
        historyPage -= 1
        renderDashboard()
      })
      pager.append(older, newer)
      eventPanel.append(pager)
    }
    for (const turn of pageChunks) {
      const turnSection = element('section', undefined, 'history-turn')
      const turnLabel = turn.label === '模型轮次'
        ? `轮次 ${turn.turnNumber} · 模型请求`
        : '任务事件'
      turnSection.append(element('h3', `${turnLabel}（${turn.events.length} 条）`, 'history-turn-title'))
      const list = element('ol', undefined, 'event-list')
      for (const event of turn.events) {
        const row = element('li', undefined, 'event')
        row.dataset.eventId = eventIdentity(event)
        const details = element('details')
        const summary = element('summary')
        summary.append(
          element('time', formatPreciseTime(event.occurredAt)),
          element('span', `${event.kind} · ${event.state}`, 'event-kind'),
          element('span', event.summary),
          element('span', `seq=${event.seq}`, 'event-seq'),
        )
        details.append(summary)
        const body = element('dl', undefined, 'event-detail')
        for (const [label, value] of [
          ['精确时间', event.occurredAt],
          ['seq', String(event.seq)],
          ['callId', event.callId || '不适用'],
          ['toolId', event.toolId || '不适用'],
          ['status', event.status || '不适用'],
          ['arguments', event.arguments === undefined || event.arguments === null ? '不适用' : JSON.stringify(event.arguments)],
          ['outputRef', event.outputRef || '不适用'],
          ['错误', event.error ? `${event.error.code}: ${event.error.message}` : '无'],
        ]) {
          const cell = element('div')
          cell.append(element('dt', label), element('dd', value))
          body.append(cell)
        }
        details.append(body)
        row.append(details)
        list.append(row)
      }
      turnSection.append(list)
      eventPanel.append(turnSection)
    }
  }
  events.append(eventPanel)
  main.append(events)

  const observationLink = element('a', '打开只读 Observation', 'button')
  observationLink.href = observationHref(taskId)
  main.append(observationLink)
}

async function refresh() {
  try {
    dashboard = await api.taskDashboard(taskId)
    status.dataset.tone = 'success'
    status.textContent = '任务投影已同步'
    markSync()
    renderDashboard()
  } catch (error) {
    setRefreshError(error)
    throw error
  }
  if (dashboard.operationId && ['running', 'settling'].includes(dashboard.state)) {
    stopObserving()
    subscribe(dashboard.operationId)
  } else if (dashboard.state === 'created' || dashboard.state === 'admitted' || dashboard.state === 'running' || dashboard.state === 'settling') {
    scheduleObservation()
  } else {
    if (subscribedOperationId) {
      subscribedOperationId = undefined
      closeStream()
    }
    stopObserving()
  }
}

async function stopExecution() {
  try {
    await refresh()
    actionStatus.textContent = 'stopping · 正在请求 stop，等待 stopped checkpoint'
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const result = await api.stop(taskId)
    await refresh()
    actionStatus.textContent = result.state === 'stopped'
      ? `stopped · operation=${result.operationId}`
      : `stop=${result.state} · operation=${result.operationId}`
  } catch (error) {
    actionStatus.textContent = `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`
    await refresh().catch(setRefreshError)
  }
}

async function retryStopExecution() {
  try {
    actionStatus.textContent = 'retrying stop · 正在重试 stop 收拢'
    const result = await api.retryStop(taskId)
    await refresh()
    actionStatus.textContent = result.state === 'stopped'
      ? `stopped · operation=${result.operationId}`
      : `stop=${result.state} · operation=${result.operationId}`
  } catch (error) {
    actionStatus.textContent = `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`
    await refresh().catch(setRefreshError)
  }
}

function subscribe(operationId) {
  if (subscribedOperationId === operationId) return
  closeStream()
  subscribedOperationId = undefined
  lastSeenSeq = 0
  seenEventIds.clear()
  closingStream = false
  stream = new EventSource(api.eventsUrl(operationId))
  for (const kind of [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.tool-result',
    'provider.error',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
    'attention.opened',
    'attention.resolved',
  ]) {
    stream.addEventListener(kind, (message) => {
      let payload
      try {
        payload = JSON.parse(message.data)
      } catch {
        payload = {}
      }
      const event = {
        eventId: payload.eventId ?? message.lastEventId,
        seq: Number.isSafeInteger(payload.seq) ? payload.seq : undefined,
        kind: payload.kind ?? kind,
      }
      if (isReplay(event)) return
      rememberEvent(event)
      connectionState = 'connected'
      void refresh().catch(setRefreshError)
    })
  }
  stream.onopen = () => {
    connectionState = 'connected'
    renderDashboard()
    void refresh().catch(setRefreshError)
  }
  subscribedOperationId = operationId
  stream.onerror = () => {
    if (closingStream) return
    connectionState = 'disconnected'
    renderDashboard()
    void refresh().catch(setRefreshError)
  }
}

function closeStream() {
  if (!stream) return
  closingStream = true
  stream.close()
  stream = undefined
}

async function load() {
  try {
    const [{ status: runtimeStatus, error }] = await Promise.all([loadRuntimeStatus()])
    renderRuntimeStatus(status, runtimeStatus, error)
    await refresh()
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
  }
}

void load()
