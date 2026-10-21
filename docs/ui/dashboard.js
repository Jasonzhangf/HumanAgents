import {
  api,
  appendPairingEntry,
  createScopedReadPublication,
  element,
  mountPageTemplate,
  renderSystemRead,
  renderPageError,
  renderRuntimeStatus,
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

const template = mountPageTemplate(document.body, {
  layout: 'collection',
  active: 'Dashboard',
  eyebrow: 'Runtime',
  title: '工作总览',
  lede: '在这里新建、跟踪和管理任务。',
  scope: { kind: 'system' },
  breadcrumbs: [
    { label: '系统', href: null },
    { label: '全部项目', href: null },
  ],
})
const { status } = template.hosts

// The controller stops polling at page exit and refuses to publish into the
// removed template after that point. In-flight reads are allowed to settle;
// they just never reach a disposed page.
let pageDisposed = false
let pollHandle = null

// ── DOM regions: canonical task entry + refreshed overview panels ──
const inputRegion = element('section', undefined, 'quick-create')
const statsRegion = element('section', undefined, 'stats')
const plansRegion = element('section', undefined, 'plan-list')
const listRegion = element('div', undefined, 'task-lists')
template.hosts.primary.append(inputRegion, statsRegion, listRegion)
const plansDetails = element('details', undefined, 'plan-list-fold')
plansDetails.append(element('summary', '执行计划管理'), plansRegion)
template.hosts.support.append(plansDetails)

function renderTaskEntry() {
  clearNode(inputRegion)
  const link = element('a', '新建任务', 'button button--primary')
  link.href = './index.html'
  inputRegion.append(link)
}

// ── List panel (refreshed by polling) ──
const systemRead = createScopedReadPublication(() => api.systemDashboard())

async function refreshLists() {
  if (pageDisposed) return
  try {
    const [read, scheduler] = await Promise.all([
      systemRead.refresh({ kind: 'system' }),
      // The scheduler read is the only surface that lists a plan which has no
      // coordinator task yet. A failure here must not blank the task lists, so
      // it is reported as its own typed notice instead of failing the page.
      api.scheduler().catch((schedulerError) => ({ __error: schedulerError })),
    ])
    if (pageDisposed || !read.published) return
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
      const systemReadNode = renderSystemRead(state.content)
      attachTaskActions(systemReadNode, state.content)
      listRegion.append(systemReadNode)
    } else {
      renderPageError(status, state.failure || { message: 'system read failed', ownerId: 'humanagent.ui', nextAction: 'retry the system read' })
      clearNode(statsRegion)
      clearNode(listRegion)
    }
    renderPlanList(scheduler)
  } catch (error) {
    if (!pageDisposed) renderPageError(status, error)
  }
}

/**
 * The control notice belongs to the one plan it was issued against, so a
 * result for plan A is never rendered under plan B.
 */
let planControlNotice = { subscriptionId: '', text: '', error: undefined }

async function runPlanControl(subscriptionId, action) {
  if (pageDisposed) return
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
  if (pageDisposed) return
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

function taskIdValue(taskId) {
  return taskId && typeof taskId === 'object' ? taskId.value : taskId
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
    await api.deleteTask(taskIdValue(row.taskId))
    if (!pageDisposed) await refreshLists()
  } catch (error) {
    if (pageDisposed) return
    btn.disabled = false
    // The page banner is the one dashboard surface that carries the shared
    // pairing entry, so an expired or revoked session on delete offers the real
    // login page. An alert would be a dead end: it cannot hold a link, and it
    // would drop the runtime's own code/owner/nextAction.
    renderPageError(status, error, 'inspect the task deletion')
  }
}

function openTaskEditor(row, trigger) {
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
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    save.disabled = true
    err.textContent = '保存中…'
    try {
      await api.updateTask(taskIdValue(row.taskId), { title: input.value.trim() })
      template.detail.close()
      if (!pageDisposed) await refreshLists()
    } catch (error) {
      if (pageDisposed) return
      save.disabled = false
      clearNode(err)
      err.append(element('span', `${error.message || error} · owner=${error.ownerId || 'unknown'}`))
      appendPairingEntry(err, error)
    }
  })
  cancel.addEventListener('click', () => template.detail.close())
  template.detail.open({
    eyebrow: '编辑任务',
    title: row.title || '任务标题',
    content: form,
  }, trigger)
}

/**
 * The system read renders read-only task rows. The page controller adds the
 * mutation entry points after that render, so the template and the shared row
 * renderer never own a write. Rows are matched in render order to the exact
 * `RuntimeProjectTaskReadRow` objects they came from.
 */
function attachTaskActions(readNode, projection) {
  const projectSections = readNode.querySelectorAll('.section.scope-project')
  for (const [projectIndex, project] of (projection.projects || []).entries()) {
    const projectSection = projectSections[projectIndex]
    if (!projectSection) continue
    const items = projectSection.querySelectorAll('.panel > .task-item')
    for (const [rowIndex, row] of (project.tasks || []).entries()) {
      const item = items[rowIndex]
      if (!item || item.querySelector('.task-item-actions')) continue
      const task = { ...row.task, scope: row.scope }
      const actions = element('div', undefined, 'task-item-actions')
      actions.append(
        actionButton('编辑', (btn) => openTaskEditor(task, btn)),
        actionButton('删除', true, (btn) => runDelete(task, btn)),
      )
      item.append(actions)
    }
  }
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function disposePage(event) {
  if (event?.persisted) return
  if (pageDisposed) return
  pageDisposed = true
  if (pollHandle !== null) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  template.dispose()
}

// ── Init ──
renderTaskEntry()
void refreshLists()
pollHandle = setInterval(() => void refreshLists(), REFRESH_MS)
window.addEventListener('pagehide', disposePage)
