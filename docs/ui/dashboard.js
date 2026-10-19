import {
  api,
  appendPairingEntry,
  createScopedReadPublication,
  element,
  formatTime,
  makePageShell,
  renderSystemRead,
  renderPageError,
  renderRuntimeStatus,
  renderTaskExecutions,
  taskRowStateText,
  taskRowTitle,
  taskFlowText,
  taskDashboardHref,
} from './runtime-shell.js'
import {
  planActionsForState,
  planControlErrorMessage,
  planControlKey,
  planControlPendingCopy,
  planControlResultCopy,
  planNextDueAt,
  renderPlanSection,
} from './plan-control.js'

const REFRESH_MS = 4000
const { main, status } = makePageShell(
  'Dashboard',
  'Runtime',
  '工作总览',
  '在这里新建、跟踪和管理任务。',
  {
    scope: { kind: 'system' },
    breadcrumbs: [
      { label: '系统', href: null },
      { label: '全部项目', href: null },
    ],
  },
)

// ── DOM regions: canonical task entry + refreshed overview panels ──
const inputRegion = element('section', undefined, 'quick-create')
const statsRegion = element('section', undefined, 'stats')
const plansRegion = element('section', undefined, 'plan-list')
const listRegion = element('div', undefined, 'task-lists')
main.append(inputRegion)
main.append(statsRegion, plansRegion, listRegion)

function renderTaskEntry() {
  clearNode(inputRegion)
  const link = element('a', '新建任务', 'button button--primary')
  link.href = './index.html'
  inputRegion.append(link)
}

// ── List panel (refreshed by polling) ──
const systemRead = createScopedReadPublication(() => api.systemDashboard())

async function refreshLists() {
  try {
    const [read, scheduler] = await Promise.all([
      systemRead.refresh({ kind: 'system' }),
      // The scheduler read is the only surface that lists a plan which has no
      // coordinator task yet. A failure here must not blank the task lists, so
      // it is reported as its own typed notice instead of failing the page.
      api.scheduler().catch((schedulerError) => ({ __error: schedulerError })),
    ])
    if (!read.published) return
    const state = read.state
    if (state.content) {
      renderRuntimeStatus(status, state.content.runtime, null)
      if (state.stale) {
        renderPageError(status, state.failure)
        status.dataset.tone = 'warning'
        status.append(element('span', ' · 上次读取失败，当前显示上次确认内容（stale）'))
      }
      clearNode(statsRegion)
      clearNode(listRegion)
      renderSystemStats(state.content)
      listRegion.append(renderSystemRead(state.content))
    } else {
      renderPageError(status, state.failure || { message: 'system read failed', ownerId: 'humanagent.ui', nextAction: 'retry the system read' })
      clearNode(statsRegion)
      clearNode(listRegion)
    }
    renderPlanList(scheduler)
  } catch (error) {
    renderPageError(status, error)
  }
}

/**
 * The control notice belongs to the one plan it was issued against, so a
 * result for plan A is never rendered under plan B.
 */
let planControlNotice = { subscriptionId: '', text: '', error: undefined }

async function runPlanControl(subscriptionId, action) {
  planControlNotice = { subscriptionId, text: planControlPendingCopy(action), error: undefined }
  renderPlanList(lastSchedulerRead)
  try {
    const result = await api.planControl(subscriptionId, {
      action,
      idempotencyKey: planControlKey(subscriptionId, action),
      requestedAt: new Date().toISOString(),
    })
    planControlNotice = { subscriptionId, text: planControlResultCopy(action, result), error: undefined }
  } catch (error) {
    // Keep the rejection itself as the notice's payload so the shared renderer
    // can add the pairing entry. Overwriting the message first loses the code
    // that decides whether pairing is the right recovery.
    planControlNotice = { subscriptionId, text: planControlErrorMessage(error), error }
  }
  await refreshLists()
}

let lastSchedulerRead

/**
 * Present every persisted execution plan the patrol reports. This includes a
 * plan whose first occurrence has not been claimed yet, which no task page can
 * show. Each plan renders its own durable state and only the controls that read
 * makes available.
 */
function renderPlanList(scheduler) {
  lastSchedulerRead = scheduler
  clearNode(plansRegion)
  const head = element('header', undefined, 'section-head')
  const plans = scheduler?.plans ?? []
  head.append(element('h2', '执行计划'), element('span', `${plans.length} 项`, 'section-meta'))
  plansRegion.append(head)
  const panel = element('div', undefined, 'panel')
  if (scheduler?.__error) {
    panel.append(element(
      'p',
      `读取执行计划失败 · ${scheduler.__error.message} · owner=${scheduler.__error.ownerId || 'unknown'} · next=${scheduler.__error.nextAction || 'inspect the runtime error'}`,
      'empty',
    ))
    appendPairingEntry(panel, scheduler.__error)
  } else if (scheduler?.issue) {
    panel.append(element('p', `计划巡逻上报：${scheduler.issue.code} · ${scheduler.issue.message} · next=${scheduler.issue.nextAction}`, 'empty'))
  } else if (plans.length === 0) {
    panel.append(element('p', '当前没有已持久化的执行计划。', 'empty'))
  }
  for (const plan of plans) {
    panel.append(renderPlanSection(projectSchedulerPlan(plan), {
      ...(planControlNotice.subscriptionId === plan.subscriptionId
        ? {
            notice: planControlNotice.text,
            ...(planControlNotice.error === undefined ? {} : { error: planControlNotice.error }),
          }
        : {}),
      onControl: (action) => runPlanControl(plan.subscriptionId, action),
    }))
  }
  plansRegion.append(panel)
}

/**
 * Adapt one scheduler plan projection to the shared plan section. The list read
 * carries no `can*` booleans, so the availability is restated from the durable
 * `state` by the same rule the task dashboard projection publishes.
 */
function projectSchedulerPlan(plan) {
  return {
    subscriptionId: plan.subscriptionId,
    state: plan.state,
    nextDueAt: planNextDueAt(plan),
    goalId: plan.goalId,
    scheduleRevision: plan.scheduleRevision,
    currentOccurrenceOrdinal: plan.currentOccurrenceOrdinal,
    availableActions: planActionsForState(plan.state),
  }
}

// The system read reports a mechanical coverage code. Show its human meaning
// and keep an unknown scope truthful instead of printing the raw token.
const SYSTEM_COVERAGE_LABELS = Object.freeze({
  'configured-projects-in-current-control-root': '当前系统已声明的项目',
})

function systemCoverageLabel(coverage) {
  if (!coverage) return '未知'
  return SYSTEM_COVERAGE_LABELS[coverage] || '未知'
}

function renderSystemStats(projection) {
  for (const [label, value] of [
    ['项目数', String(projection.projects?.length || 0)],
    ['任务数', String(projection.taskCount || 0)],
    ['读取范围', systemCoverageLabel(projection.coverage)],
    ['完整性', projection.complete ? '完整' : '不完整'],
  ]) {
    const card = element('article', undefined, 'stat')
    card.append(element('span', label), element('strong', value))
    statsRegion.append(card)
  }
}

function taskRow(row) {
  const item = element('div', undefined, 'task-item')
  const link = element('a', undefined, 'task-item-main')
  link.href = taskDashboardHref(row.taskId.value)
  link.append(
    element('h3', taskRowTitle(row)),
    element('p', taskRowStateText(row)),
  )
  const meta = element('div', undefined, 'task-item-meta')
  meta.append(
    element('span', row.stateLabel || row.state || '', 'task-state-pill'),
    element('time', formatTime(row.updatedAt)),
  )
  const taskType = taskFlowText(row.taskFlow)
  if (taskType) meta.append(element('span', taskType))
  link.append(meta)
  const actions = element('div', undefined, 'task-item-actions')
  actions.append(
    actionButton('编辑', () => openEditDialog(row)),
    actionButton('删除', true, (btn) => runDelete(row, btn)),
  )
  item.append(link, actions)
  const executions = renderTaskExecutions(row)
  if (executions) item.append(executions)
  return item
}

function actionButton(label, danger, onClick) {
  if (typeof danger === 'function') { onClick = danger; danger = false }
  const btn = element('button', label, `button button--sm${danger ? ' button--danger' : ''}`)
  btn.type = 'button'
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void onClick(btn)
  })
  return btn
}

async function runDelete(row, btn) {
  if (!window.confirm(`删除任务"${row.title}"？`)) return
  btn.disabled = true
  try {
    await api.deleteTask(row.taskId.value)
    await refreshLists()
  } catch (error) {
    btn.disabled = false
    // The page banner is the one dashboard surface that carries the shared
    // pairing entry, so an expired or revoked session on delete offers the real
    // login page. An alert would be a dead end: it cannot hold a link, and it
    // would drop the runtime's own code/owner/nextAction.
    renderPageError(status, error, 'inspect the task deletion')
  }
}

function openEditDialog(row) {
  const existing = document.querySelector('dialog.edit-dialog')
  if (existing) existing.remove()
  const dialog = element('dialog', undefined, 'edit-dialog')
  const form = element('form', undefined, 'edit-form')
  const input = element('input')
  input.type = 'text'
  input.value = row.title || ''
  input.required = true
  const cancel = element('button', '取消', 'button button--quiet')
  cancel.type = 'button'
  const save = element('button', '保存', 'button button--primary')
  save.type = 'submit'
  const err = element('p', undefined, 'edit-status')
  const editActions = element('div', undefined, 'edit-actions')
  editActions.append(cancel, save)
  form.append(
    element('label', '任务标题', 'field-label'),
    input,
    err,
    editActions,
  )
  dialog.append(form)
  document.body.append(dialog)
  dialog.showModal()
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    save.disabled = true
    err.textContent = '保存中…'
    try {
      await api.updateTask(row.taskId.value, { title: input.value.trim() })
      dialog.close()
      await refreshLists()
    } catch (error) {
      save.disabled = false
      clearNode(err)
      err.append(element('span', `${error.message || error} · owner=${error.ownerId || 'unknown'}`))
      appendPairingEntry(err, error)
    }
  })
  cancel.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => dialog.remove(), { once: true })
}

function section(title, rows, emptyText) {
  const sec = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', title), element('span', `${rows.length} 项`, 'section-meta'))
  const panel = element('div', undefined, 'panel')
  if (rows.length === 0) panel.append(element('p', emptyText, 'empty'))
  else for (const row of rows) panel.append(taskRow(row))
  sec.append(head, panel)
  return sec
}

function renderTaskLists(dashboard, tasks) {
  clearNode(listRegion)
  listRegion.append(
    section('运行中', tasks.running, '当前没有运行中的任务。'),
    section('等待决策', tasks.waiting, '当前没有等待决策的任务。'),
  )
  const layout = element('div', undefined, 'layout')
  const left = element('div')
  const right = element('div')
  left.append(
    section('已完成', tasks.completed, '还没有已完成的任务。'),
    section('已停止', tasks.stopped, '当前没有已停止的任务。'),
  )
  right.append(
    section('最近失败', (dashboard.recentFailures || []).map((f) => ({
      taskId: f.taskId,
      title: f.taskTitle || '失败任务',
      state: 'failed',
      stateLabel: '失败',
      currentState: '执行失败',
      error: {
        code: f.code,
        ownerId: f.ownerId,
        message: f.message,
        retryable: false,
        nextAction: f.nextAction,
      },
      updatedAt: f.occurredAt,
    })), '暂无失败记录。'),
  )
  layout.append(left, right)
  listRegion.append(layout)
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

// ── Init ──
renderTaskEntry()
void refreshLists()
const pollHandle = setInterval(() => void refreshLists(), REFRESH_MS)
