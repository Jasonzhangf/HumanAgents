import {
  api,
  appendPairingEntry,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  renderPageError,
  renderRuntimeStatus,
  taskDashboardHref,
} from './runtime-shell.js'
import { mountInteractionWorkCard } from './interaction-work-card.js'
import {
  projectInteractionCardFromEntries,
  projectInteractionCardFromSnapshot,
} from './interaction-card-page.js'
import {
  planActionsForState,
  planControlErrorMessage,
  planControlKey,
  planControlPendingCopy,
  planControlResultCopy,
  planNextDueAt,
  renderPlanSection,
} from './plan-control.js'
import { createNewTaskSubmissionSession } from './requirement-submission.js'

const REFRESH_MS = 4000
const { main, status, interactionCardHosts } = makePageShell(
  'Dashboard',
  'Runtime',
  '工作总览',
  '在这里新建、跟踪、管理任务；所有数据来自 HumanAgent Runtime API。',
)
const interactionCardHost = interactionCardHosts[0]
// The new-task form submit is the only authorization point on this page. The
// work card is a read-only progress projection here, so it must not expose a
// second confirmation action that would gate a new task behind another click.
const interactionCard = interactionCardHost ? mountInteractionWorkCard(interactionCardHost, {}) : null
interactionCard?.update(projectInteractionCardFromEntries([], 'received'))

// ── DOM regions: input panel (stable, never rebuilt) + list panel (refreshed) ──
const inputRegion = element('section', undefined, 'quick-create')
const statsRegion = element('section', undefined, 'stats')
const plansRegion = element('section', undefined, 'plan-list')
const listRegion = element('div', undefined, 'task-lists')
main.append(inputRegion)
if (interactionCardHost) main.append(interactionCardHost)
main.append(statsRegion, plansRegion, listRegion)

// ── Interaction state (surVives refresh) ──
const interaction = {
  id: null,
  draft: null,
  inFlight: false,
  sequence: 0,
  entries: [],
  state: 'received',
}

function appendCardEvent(kind, text, sourceKind = kind, detail = {}) {
  interaction.sequence += 1
  const interactionId = interaction.id || 'pending-input'
  interaction.entries = [
    ...interaction.entries,
    {
      sequence: interaction.sequence,
      interactionId,
      kind,
      sourceKind,
      eventKey: detail.eventKey || kind,
      text,
      ...detail,
    },
  ]
  interactionCard?.update(projectInteractionCardFromEntries(interaction.entries, interaction.state))
}

function appendCardError(error) {
  appendCardEvent('failure', error.message || String(error), 'error', {
    eventKey: 'request-failed',
    error: { code: error.code, message: error.message || String(error), ownerId: error.ownerId || 'humanagent.app' },
    evidenceRefs: error.evidenceRefs || [],
  })
}

/**
 * Show the interaction's current state on the read-only work card.
 *
 * `snapshot` must be the state the runtime reports *now*. The pre-confirmation
 * snapshot the page organized from is history and must never be handed here as
 * the current state.
 */
function updateCardFromSnapshot(snapshot) {
  interaction.id = interaction.id || 'pending-input'
  if (snapshot?.state) interaction.state = snapshot.state
  // The work card carries no confirmation action on this page: the form submit
  // is the only authorization point for a new task.
  interactionCard?.update({ ...projectInteractionCardFromSnapshot(snapshot), actions: [] })
}

function createInteractionProgressWidget() {
  const root = element('div', undefined, 'progress')
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  const spinner = element('span', undefined, 'progress-spinner')
  spinner.setAttribute('aria-hidden', 'true')
  const phase = element('span', '', 'progress-phase')
  const detail = element('span', '', 'progress-detail')
  const timer = element('time', '0.0s', 'progress-timer')
  timer.setAttribute('aria-hidden', 'true')
  root.append(spinner, phase, detail, timer)

  let startTime = 0
  let handle = 0
  function tick() {
    if (!startTime) return
    const elapsed = (performance.now() - startTime) / 1000
    timer.textContent = elapsed.toFixed(1) + 's'
  }

  return {
    root,
    spinner,
    set(phaseText, detailText) {
      phase.textContent = phaseText
      detail.textContent = detailText || ''
      startTime = performance.now()
      timer.textContent = '0.0s'
      timer.hidden = false
      if (handle) clearInterval(handle)
      handle = setInterval(tick, 100)
      root.classList.add('progress--live')
      appendCardEvent('status', phaseText, 'progress')
    },
    done(phaseText, detailText) {
      if (handle) clearInterval(handle)
      tick()
      phase.textContent = phaseText || 'done'
      detail.textContent = detailText || ''
      timer.hidden = false
      root.classList.remove('progress--live')
      appendCardEvent('status', phaseText || 'done', 'result')
    },
    error(phaseText, detailText) {
      if (handle) clearInterval(handle)
      tick()
      phase.textContent = phaseText || 'failed'
      detail.textContent = detailText || ''
      timer.hidden = false
      root.classList.remove('progress--live')
      appendCardEvent('failure', phaseText || 'failed', 'error')
    },
    idle(phaseText, detailText) {
      if (handle) clearInterval(handle)
      phase.textContent = phaseText || 'idle'
      detail.textContent = detailText || ''
      timer.textContent = '0.0s'
      timer.hidden = false
      root.classList.remove('progress--live')
      appendCardEvent('status', phaseText || 'idle', 'progress')
    },
  }
}

// ── Input panel ──
// The form submit is the only authorization point for a new task on this page.
// One submit organizes the input through the explicit brain and hands the exact
// reviewable revision to the runtime's final-submit edge in the same handling.
// There is no second confirmation panel, no auto-confirm and no local enqueue.
function renderInputPanel() {
  clearNode(inputRegion)
  const form = element('form', undefined, 'quick-create-form')
  form.id = 'dashboard-create-form'
  const label = element('label', '新建任务', 'quick-create-label')
  const textarea = element('textarea')
  textarea.name = 'directive'
  textarea.required = true
  textarea.rows = 3
  textarea.placeholder = '一句话告诉显式大脑要做什么。'
  label.append(textarea)

  const submit = element('button', '创建并执行', 'button button--primary')
  submit.type = 'submit'
  submit.id = 'dashboard-create-submit'

  const progress = createInteractionProgressWidget()
  progress.root.classList.add('quick-create-progress')
  progress.idle('空闲', '输入任务后点击创建并执行，提交即授权，显式大脑按 理解 → 匹配 → 整理 → 派发 处理')

  // Read-only organizing feedback. The submit is the confirmation, so this
  // region never re-runs the submission and never offers a second authorize.
  const feedback = element('div', undefined, 'quick-create-feedback')
  feedback.id = 'dashboard-create-feedback'
  feedback.hidden = true
  feedback.setAttribute('role', 'status')
  feedback.setAttribute('aria-live', 'polite')

  const errorPanel = element('section', undefined, 'panel')
  errorPanel.id = 'dashboard-create-error'
  errorPanel.hidden = true
  errorPanel.setAttribute('role', 'alert')

  const actions = element('div', undefined, 'quick-create-actions')
  actions.append(submit)
  form.append(label, actions, errorPanel, progress.root, feedback)

  // One session per page keeps the submission identity and the interaction
  // identity stable across a clarification round; a fresh human intent gets a
  // fresh identity inside the session.
  const session = createNewTaskSubmissionSession({ api, sourceRef: 'ui:dashboard' })

  function showError(error) {
    clearNode(errorPanel)
    errorPanel.hidden = false
    errorPanel.append(
      element('strong', error.code || 'request.failed'),
      element('p', `${error.message || String(error)} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'inspect the runtime error'}`),
    )
    appendPairingEntry(errorPanel, error)
    appendCardError(error)
  }

  function clearError() {
    clearNode(errorPanel)
    errorPanel.hidden = true
  }

  /**
   * Render the read-only organizing result. `snapshot` is the organized draft
   * shown as history; `cardSnapshot` is the state the work card must show. For
   * an accepted submission that is the server's post-confirmation snapshot,
   * never the organized draft the human reviewed before the submit authorized
   * it.
   */
  function renderOrganized(snapshot, cardSnapshot = snapshot) {
    clearNode(feedback)
    feedback.hidden = false
    feedback.append(element('p', '显式大脑整理结果（只读）', 'eyebrow'))
    const draft = snapshot?.draft
    if (draft) {
      const grid = element('dl', undefined, 'detail-grid')
      for (const [fieldLabel, fieldValue] of [
        ['意图', draft.proposedIntent],
        ['规范化输入', draft.normalizedInput],
        ['建议', draft.proposal],
      ]) {
        const row = element('div', undefined, 'detail-cell')
        row.append(element('dt', fieldLabel), element('dd', fieldValue || '—'))
        grid.append(row)
      }
      feedback.append(grid)
    } else if (snapshot?.reply || snapshot?.nextAction) {
      feedback.append(element('p', snapshot.reply || snapshot.nextAction, 'muted'))
    }
    updateCardFromSnapshot(cardSnapshot)
  }

  function renderClarification(snapshot) {
    clearNode(feedback)
    feedback.hidden = false
    const question = snapshot?.clarifications?.at(-1)?.question || snapshot?.reply || '显式大脑需要补充信息。'
    feedback.append(
      element('p', '显式大脑需要补充信息（只读）', 'eyebrow'),
      element('p', question, 'draft-proposal'),
    )
    const answerForm = element('form', undefined, 'form-grid')
    answerForm.id = 'dashboard-create-clarification'
    const answerLabel = element('label')
    const answer = element('input')
    answer.name = 'answer'
    answer.required = true
    answerLabel.append('补充信息', answer)
    const answerActions = element('div', undefined, 'actions')
    const answerButton = element('button', '回答并继续', 'button button--primary')
    answerButton.type = 'submit'
    answerActions.append(answerButton)
    answerForm.append(answerLabel, answerActions)
    answerForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = answer.value.trim()
      if (!value) {
        progress.error('请填写补充信息', '')
        answer.focus()
        return
      }
      void runSubmission({ clarificationAnswer: value })
    })
    feedback.append(answerForm)
    updateCardFromSnapshot(snapshot)
  }

  async function runSubmission({ clarificationAnswer } = {}) {
    if (interaction.inFlight) return
    const rawInput = textarea.value.trim()
    if (!rawInput) {
      progress.error('请填写任务内容', '')
      textarea.focus()
      return
    }
    interaction.inFlight = true
    submit.disabled = true
    textarea.readOnly = true
    submit.textContent = '正在处理…'
    clearError()
    progress.set('显式大脑正在整理并提交', '一次提交即授权创建并执行')
    try {
      const result = await session.submit(
        rawInput,
        clarificationAnswer === undefined ? {} : { clarificationAnswer },
      )
      interaction.id = result.interactionId || interaction.id
      if (result.outcome === 'clarification') {
        renderClarification(result.snapshot)
        progress.done('需要补充信息', result.snapshot?.reply || '请回答显式大脑的问题')
        submit.textContent = '回答并继续'
        submit.disabled = false
        textarea.readOnly = false
        interaction.inFlight = false
        return
      }
      if (result.outcome === 'refused') {
        // An existing-task material change is a separate authorization; the
        // new-task form refuses it and the queue stays unchanged.
        renderOrganized(result.snapshot)
        showError(result.refusal)
        progress.error('未作为新任务提交', result.refusal.message)
        submit.textContent = '重新提交'
        submit.disabled = false
        textarea.readOnly = false
        interaction.inFlight = false
        return
      }
      if (result.outcome === 'status-only') {
        renderOrganized(result.snapshot)
        progress.done('已处理', result.snapshot?.reply || result.snapshot?.nextAction || '')
        submit.textContent = '创建并执行'
        submit.disabled = false
        textarea.readOnly = false
        interaction.id = null
        interaction.inFlight = false
        session.reset()
        textarea.focus()
        return
      }
      // The runtime accepted the exact revision and FIFO-enqueued it. Nothing is
      // enqueued here; the page reports the runtime's own acceptance, keeps the
      // organized draft as history and takes the card's current state from the
      // post-confirmation server snapshot, so the card never keeps waiting for a
      // second confirmation.
      renderOrganized(result.organizedSnapshot ?? result.snapshot, result.snapshot)
      appendCardEvent('decision', '任务已提交，正在等待隐式大脑派发', 'decision', { eventKey: 'explicit.confirmation-submitted' })
      progress.done('已入队 · 隐式大脑将消费', '任务需求已进入隐式大脑 FIFO 队列')
      textarea.value = ''
      textarea.readOnly = false
      textarea.placeholder = '一句话告诉显式大脑要做什么。'
      submit.textContent = '创建并执行'
      submit.disabled = false
      interaction.id = null
      interaction.inFlight = false
      session.reset()
      textarea.focus()
      void refreshLists()
    } catch (error) {
      // A refused or failed submission is never retried automatically and the
      // input stays visible so the human can correct it.
      showError(error)
      progress.error('请求失败', error.message || String(error))
      submit.textContent = '重试本次提交'
      submit.disabled = false
      textarea.readOnly = false
      interaction.inFlight = false
      textarea.focus()
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void runSubmission()
  })

  inputRegion.append(form)
}

// ── List panel (refreshed by polling) ──
async function refreshLists() {
  try {
    const [{ status: runtimeStatus, error }, dashboard, tasks, scheduler] = await Promise.all([
      loadRuntimeStatus(),
      api.dashboard(),
      api.listTasks(),
      // The scheduler read is the only surface that lists a plan which has no
      // coordinator task yet. A failure here must not blank the task lists, so
      // it is reported as its own typed notice instead of failing the page.
      api.scheduler().catch((schedulerError) => ({ __error: schedulerError })),
    ])
    renderRuntimeStatus(status, runtimeStatus, error)
    renderStats(dashboard)
    renderTaskLists(dashboard, tasks)
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

function renderStats(dashboard) {
  clearNode(statsRegion)
  for (const [label, value] of [
    ['运行中', dashboard.hasRunning ? '是' : '否'],
    ['任务数', String(dashboard.taskCount)],
    ['等待决策', String(dashboard.waitingDecisionCount)],
    ['最近失败', String((dashboard.recentFailures || []).length)],
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
    element('h3', row.title || '未命名任务'),
    element('p', `${row.currentState || row.state || ''} · ${row.nextStep || ''}`),
  )
  const meta = element('div', undefined, 'task-item-meta')
  meta.append(
    element('span', row.stateLabel || row.state || '', 'task-state-pill'),
    element('time', formatTime(row.updatedAt)),
  )
  link.append(meta)
  const actions = element('div', undefined, 'task-item-actions')
  actions.append(
    actionButton('编辑', () => openEditDialog(row)),
    actionButton('删除', true, (btn) => runDelete(row, btn)),
  )
  item.append(link, actions)
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
      currentState: f.code || 'failed',
      nextStep: f.nextAction || '',
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
renderInputPanel()
void refreshLists()
const pollHandle = setInterval(() => void refreshLists(), REFRESH_MS)
