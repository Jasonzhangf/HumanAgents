import {
  api,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  renderRuntimeStatus,
  taskDashboardHref,
} from './runtime-shell.js'

const REFRESH_MS = 4000
const { main, status } = makePageShell(
  'Dashboard',
  'Runtime',
  '工作总览',
  '在这里新建、跟踪、管理任务；所有数据来自 HumanAgent Runtime API。',
)

// ── DOM regions: input panel (stable, never rebuilt) + list panel (refreshed) ──
const inputRegion = element('section', undefined, 'quick-create')
const statsRegion = element('section', undefined, 'stats')
const listRegion = element('div', undefined, 'task-lists')
main.append(inputRegion, statsRegion, listRegion)

// ── Interaction state (surVives refresh) ──
const interaction = {
  id: null,
  draft: null,
  inFlight: false,
}

function createProgressWidget() {
  const root = element('div', undefined, 'progress')
  root.setAttribute('role', 'status')
  root.setAttribute('aria-live', 'polite')
  root.dataset.tone = 'idle'
  const spinner = element('span', undefined, 'progress-spinner')
  spinner.setAttribute('aria-hidden', 'true')
  const phase = element('span', 'idle', 'progress-phase')
  phase.setAttribute('data-default', 'idle')
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
      root.dataset.tone = 'active'
      root.classList.add('progress--live')
    },
    waiting(phaseText, detailText) {
      if (handle) clearInterval(handle)
      phase.textContent = phaseText || 'waiting'
      detail.textContent = detailText || ''
      timer.textContent = '0.0s'
      timer.hidden = true
      root.dataset.tone = 'waiting'
      root.classList.remove('progress--live')
    },
    done(phaseText, detailText) {
      if (handle) clearInterval(handle)
      tick()
      phase.textContent = phaseText || 'done'
      detail.textContent = detailText || ''
      timer.hidden = false
      root.dataset.tone = 'success'
      root.classList.remove('progress--live')
    },
    error(phaseText, detailText) {
      if (handle) clearInterval(handle)
      tick()
      phase.textContent = phaseText || 'failed'
      detail.textContent = detailText || ''
      timer.hidden = false
      root.dataset.tone = 'danger'
      root.classList.remove('progress--live')
    },
    idle(phaseText, detailText) {
      if (handle) clearInterval(handle)
      phase.textContent = phaseText || 'idle'
      detail.textContent = detailText || ''
      timer.textContent = '0.0s'
      timer.hidden = false
      root.dataset.tone = 'idle'
      root.classList.remove('progress--live')
    },
  }
}

// ── Input panel ──
function renderInputPanel() {
  clearNode(inputRegion)
  const form = element('form', undefined, 'quick-create-form')
  const label = element('label', '新建任务', 'quick-create-label')
  const textarea = element('textarea')
  textarea.name = 'directive'
  textarea.required = true
  textarea.rows = 3
  textarea.placeholder = '一句话告诉显式大脑要做什么。'
  label.append(textarea)

  const submit = element('button', '提交给显式大脑', 'button button--primary')
  submit.type = 'submit'

  const progress = createProgressWidget()
  progress.root.classList.add('quick-create-progress')
  progress.idle('空闲', '输入任务后点击提交，显式大脑按 理解 → 匹配 → 确认 → 派发 处理')

  const policyRow = element('label', undefined, 'quick-create-policy')
  const autoConfirm = element('input')
  autoConfirm.type = 'checkbox'
  autoConfirm.name = 'autoConfirm'
  autoConfirm.dataset.testid = 'auto-confirm'
  policyRow.append(autoConfirm, element('span', '自动确认并派发（跳过手动确认步骤）'))

  // Interaction actions (shown after draft is produced)
  const draftArea = element('div', undefined, 'draft-area')
  draftArea.hidden = true

  const actions = element('div', undefined, 'quick-create-actions')
  actions.append(submit)
  form.append(label, actions, progress.root, policyRow, draftArea)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
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
    progress.set('显式大脑正在理解输入', '正在接收并解析你的输入')
    try {
      if (!interaction.id) {
        // First turn: send raw input to explicit brain intake
        const received = await api.receiveExplicitInput({
          sourceRef: 'ui:dashboard',
          rawInput,
          inputRevision: 1,
        })
        interaction.id = received.interactionId
      }
      // Check current interaction state
      let snap = await api.inspectExplicitInteraction(interaction.id)
      if (snap.state === 'awaiting-clarification') {
        // Second turn: user answered the clarification question
        progress.set('显式大脑正在理解你的回答', '正在将补充信息交给显式大脑')
        snap = await api.answerExplicitClarification(interaction.id, rawInput)
        // After answering, re-interpret to produce a draft
        progress.set('显式大脑正在重新整理意图', '显式大脑正在生成任务草案')
        snap = await api.interpretExplicitInput(interaction.id)
      } else if (snap.state === 'received' || snap.state === 'matching') {
        // First turn: drive interpretation + matching
        progress.set('显式大脑正在匹配任务', '显式大脑正在整理意图')
        snap = await api.interpretExplicitInput(interaction.id)
      }
      if (snap.state === 'awaiting-clarification') {
        progress.done('需要补充信息', snap.reply || '请回答显式大脑的问题')
        textarea.value = ''
        textarea.readOnly = false
        textarea.placeholder = snap.reply || '请补充显式大脑需要的信息。'
        submit.textContent = '回答并继续'
        submit.disabled = false
        interaction.inFlight = false
        textarea.focus()
        return
      }
      if (snap.state === 'awaiting-confirmation' && snap.draft) {
        progress.waiting('等待你确认任务草案', '查看下方显式大脑整理结果')
        interaction.draft = snap.draft
        // Reset inFlight so the confirm/cancel buttons inside the draft panel
        // are not blocked by the submit guard.
        interaction.inFlight = false
        renderDraftConfirmation(draftArea, snap, textarea, submit, progress, autoConfirm.checked)
        return
      }
      // status-only or other terminal
      progress.done('已处理', snap.reply || snap.nextAction || '')
      textarea.readOnly = false
      textarea.value = ''
      submit.textContent = '提交给显式大脑'
      submit.disabled = false
      interaction.id = null
      interaction.inFlight = false
      textarea.focus()
    } catch (error) {
      progress.error('请求失败', error.message || String(error))
      submit.textContent = '重试'
      submit.disabled = false
      textarea.readOnly = false
      interaction.inFlight = false
      textarea.focus()
    }
  })

  inputRegion.append(form)
}

function renderDraftConfirmation(area, snap, textarea, submit, progress, autoConfirm) {
  area.hidden = false
  clearNode(area)
  const proposal = snap.draft?.proposal || snap.rawInput || ''
  const normalized = snap.draft?.normalizedInput || ''
  const intent = snap.draft?.proposedIntent || ''
  area.append(
    element('p', '显式大脑整理结果', 'eyebrow'),
    element('p', proposal, 'draft-proposal'),
  )
  if (normalized) area.append(element('p', `标准化输入：${normalized}`, 'draft-meta'))
  if (intent) area.append(element('p', `意图：${intent}`, 'draft-meta'))

  const confirmBtn = element('button', '确认并执行', 'button button--primary')
  confirmBtn.type = 'button'
  const rejectBtn = element('button', '取消', 'button button--quiet')
  rejectBtn.type = 'button'
  const confirmStatus = element('p', undefined, 'muted')
  confirmStatus.setAttribute('role', 'status')

  const draftActions = element('div', undefined, 'draft-actions')
  draftActions.append(confirmBtn, rejectBtn)
  area.append(draftActions, confirmStatus)

  confirmBtn.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (interaction.inFlight) return
    interaction.inFlight = true
    confirmBtn.disabled = true
    rejectBtn.disabled = true
    progress.set('显式大脑正在提交任务', '正在写入任务需求并进入执行队列')
    try {
      const confirmed = await api.confirmExplicitRequirement(interaction.id, {
        draftId: snap.draft.draftId,
        inputRevision: snap.draft.inputRevision || 1,
        confirmationRef: `confirmation:dashboard-${Date.now()}`,
        confirmedBy: 'human:operator',
        confirmedAt: new Date().toISOString(),
        payloadRef: `asset://requirements/dashboard-${Date.now()}`,
      })
      progress.done('已入队 · 隐式大脑将消费', '任务需求已进入隐式大脑队列')
      // Implicit dispatch is async — wait for the task to appear in the list
      // and jump straight to its dashboard so the user sees live turns instead
      // of a stale "已入队" message on the input panel.
      const dispatchedTaskId = await findDispatchedTaskId()
      if (dispatchedTaskId) {
        window.location.href = taskDashboardHref(dispatchedTaskId)
        return
      }
      area.hidden = true
      clearNode(area)
      // Reset input for next task
      textarea.value = ''
      textarea.readOnly = false
      textarea.placeholder = '一句话告诉显式大脑要做什么。'
      submit.textContent = '提交给显式大脑'
      submit.disabled = false
      interaction.id = null
      interaction.draft = null
      interaction.inFlight = false
      textarea.focus()
      void refreshLists()
    } catch (error) {
      progress.error('确认失败', `${error.message || error} · owner=${error.ownerId || 'unknown'}`)
      confirmBtn.disabled = false
      rejectBtn.disabled = false
      interaction.inFlight = false
    }
  })

  // Auto-confirm uses the same confirmation edge as the manual button.
  if (autoConfirm) {
    progress.set('显式大脑正在自动确认', '已开启跳过手动确认')
    setTimeout(() => confirmBtn.click(), 0)
  }

  rejectBtn.addEventListener('click', () => {
    area.hidden = true
    clearNode(area)
    interaction.id = null
    interaction.draft = null
    interaction.inFlight = false
    textarea.readOnly = false
    textarea.value = ''
    textarea.placeholder = '一句话告诉显式大脑要做什么。'
    submit.textContent = '提交给显式大脑'
    submit.disabled = false
    progress.idle('已取消', '你可以重新输入任务')
    textarea.focus()
  })

}

// ── List panel (refreshed by polling) ──
async function refreshLists() {
  try {
    const [{ status: runtimeStatus, error }, dashboard, tasks] = await Promise.all([
      loadRuntimeStatus(),
      api.dashboard(),
      api.listTasks(),
    ])
    renderRuntimeStatus(status, runtimeStatus, error)
    renderStats(dashboard)
    renderTaskLists(dashboard, tasks)
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
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
    actionButton('删除', true, () => runDelete(row)),
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
    window.alert(`删除失败：${error.message || error}`)
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
      err.textContent = `${error.message || error} · owner=${error.ownerId || 'unknown'}`
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

// Poll listTasks until implicit dispatch creates a task for the just-confirmed
// requirement, then return its id. Returns null if dispatch never shows up.
async function findDispatchedTaskId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const tasks = await api.listTasks()
      const candidates = []
        .concat(tasks.running || [])
        .concat(tasks.waiting || [])
        .concat(tasks.draft || [])
        .filter((task) => task && task.updatedAt)
      if (candidates.length > 0) {
        const latest = candidates
          .map((task) => ({ task, ts: new Date(task.updatedAt).getTime() }))
          .sort((left, right) => right.ts - left.ts)[0]
        if (latest?.task?.taskId?.value) return latest.task.taskId.value
      }
    } catch (_) {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return null
}

// ── Init ──
renderInputPanel()
void refreshLists()
const pollHandle = setInterval(() => void refreshLists(), REFRESH_MS)
