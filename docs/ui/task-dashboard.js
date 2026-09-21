import {
  api,
  clearNode,
  element,
  formatTime,
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
let actionStatus

function renderDashboard() {
  if (!dashboard) return
  clearNode(main)

  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', '当前任务', 'eyebrow'), element('h1', dashboard.taskTitle))
  const stateChip = element('span', dashboard.stateLabel, 'state-chip')
  stateChip.dataset.tone = stateTone(dashboard.state)
  copy.append(stateChip)
  heading.append(copy)
  main.append(heading)

  const facts = element('dl', undefined, 'detail-grid')
  for (const [label, value] of [
    ['当前状态', dashboard.stateLabel],
    ['当前执行节点', dashboard.currentNode],
    ['模式', dashboard.mode],
    ['最近下一步', dashboard.nextStep],
    ['输入', dashboard.input || '尚未输入'],
    ['输出', dashboard.output || '尚无输出'],
    ['错误 owner', dashboard.error ? `${dashboard.error.ownerId} · ${dashboard.error.nextAction}` : '无错误'],
    ['Checkpoint', dashboard.checkpoint ? `${dashboard.checkpoint.outcome} · seq=${dashboard.checkpoint.seq} · ${dashboard.checkpoint.summary}` : '尚未提交'],
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
  actionStatus = element('p', dashboard.allowedActions.includes('start')
    ? '任务尚未提交给后台，请先进入显式大脑整理并确认。'
    : '看板只负责观察运行状态；需要改变任务时进入显式大脑。', 'muted')
  actionStatus.setAttribute('role', 'status')
  actionStatus.setAttribute('aria-live', 'polite')
  panel.append(actions, actionStatus)
  execution.append(panel)
  main.append(execution)

  const events = element('section', undefined, 'section')
  events.append(element('h2', '最近事件'))
  const eventPanel = element('div', undefined, 'panel')
  if (dashboard.recentEvents.length === 0) {
    eventPanel.append(element('p', '尚无事件。', 'empty'))
  } else {
    const list = element('ol', undefined, 'event-list')
    for (const event of dashboard.recentEvents) {
      const row = element('li', undefined, 'event')
      row.append(
        element('time', formatTime(event.occurredAt)),
        element('span', `${event.kind} · ${event.state}`, 'event-kind'),
        element('span', `${event.summary}${event.ownerId ? ` · owner=${event.ownerId}` : ''}${event.nextAction ? ` · next=${event.nextAction}` : ''}`),
      )
      list.append(row)
    }
    eventPanel.append(list)
  }
  events.append(eventPanel)
  main.append(events)

  const observationLink = element('a', '打开只读 Observation', 'button')
  observationLink.href = observationHref(taskId)
  main.append(observationLink)
}

async function refresh() {
  dashboard = await api.taskDashboard(taskId)
  renderDashboard()
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
    await refresh().catch(() => {})
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
    await refresh().catch(() => {})
  }
}

function subscribe(operationId) {
  stream?.close()
  stream = new EventSource(api.eventsUrl(operationId))
  for (const kind of [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.error',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
    'attention.opened',
    'attention.resolved',
  ]) {
    stream.addEventListener(kind, () => {
      void refresh().catch(() => {})
    })
  }
  stream.onerror = () => {
    actionStatus.textContent = 'SSE 已断开；页面将使用 Runtime projection 恢复。'
  }
}

async function load() {
  try {
    const [{ status: runtimeStatus, error }] = await Promise.all([loadRuntimeStatus()])
    renderRuntimeStatus(status, runtimeStatus, error)
    await refresh()
    if (dashboard.operationId && ['running', 'settling'].includes(dashboard.state)) subscribe(dashboard.operationId)
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
  }
}

void load()
