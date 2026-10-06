import { createRuntimeApi, clearNode, element, formatTime, stateTone } from './runtime-api.js'

const api = createRuntimeApi()

function safe(selector, root) {
  try { return (root || document).querySelector(selector) } catch (_) { return element('span') }
}
function safeAll(selector, root) {
  try { return Array.from((root || document).querySelectorAll(selector)) } catch (_) { return [] }
}

const feedback = document.querySelector('[data-action-feedback]')
const diagnostic = document.querySelector('[data-diagnostic-output]')
const serverResult = document.querySelector('[data-server-result]')
const runtimeMode = document.querySelector('[data-runtime-mode]')
const runtimeStatus = (function(){try {return document.querySelector('[data-runtime-status]')} catch (_) {return element('span')}})()
const visibleState = document.querySelector('[data-visible-state]')
const interactionIdLabel = document.querySelector('[data-interaction-id]')
const inspection = document.querySelector('[data-inspection]')
const draftFeedback = document.querySelector('[data-draft-feedback]')
const inputForm = document.querySelector('[data-explicit-input]')
const matchingForm = document.querySelector('[data-explicit-match]')
const proposalForm = document.querySelector('[data-explicit-proposal]')
const confirmationForm = document.querySelector('[data-explicit-confirmation]')
const controlForm = document.querySelector('[data-control-form]')
const matchButton = matchingForm.querySelector('button[type="submit"]')
const proposalButton = proposalForm.querySelector('button[type="submit"]')
const confirmationButton = confirmationForm.querySelector('button[type="submit"]')
const dispatchButton = document.querySelector('[data-action="dispatch"]')
const statusButtons = document.querySelectorAll('[data-action="status-only"]')
const flowState = safe('[data-flow-state]')
const flowTask = safe('[data-flow-task]')
const flowAction = safe('[data-flow-action]')
const flowNote = safe('[data-flow-note]')
const flowMeta = safe('[data-flow-meta]')
const taskList = safe('[data-task-list]')
const taskQueueMeta = safe('[data-task-queue-meta]')
const createTaskForm = safe('[data-create-task-form]')
const createTaskFeedback = safe('[data-create-task-feedback]')
const createTaskButton = safe('[data-action="create"]', createTaskForm)
const updateTaskButton = safe('[data-action="update"]', createTaskForm)
const deleteTaskButton = safe('[data-action="delete"]', createTaskForm)
const liveEventList = safe('[data-task-live-events]')
const liveEventMeta = safe('[data-task-live-meta]')
const confirmPolicyRadios = safeAll('[data-confirm-policy] input[name="confirmPolicy"]')

const INTERPRET_TIMEOUT_MS = 8000

let interactionId
let currentInspection
let confirmPolicy = 'manual'
let selectedTaskId
let tasks = []

function field(form, name) {
  return form.elements.namedItem(name)
}

function value(form, name) {
  return field(form, name).value.trim()
}

function readable(input, placeholder = '暂无信息') {
  if (input === undefined || input === null || input === '') return placeholder
  if (Array.isArray(input)) return input.length ? input.map((item) => readable(item)).join('；') : placeholder
  if (typeof input === 'object') return JSON.stringify(input)
  return String(input)
}

function setFeedback(message) {
  feedback.textContent = message
}

function setCreateFeedback(message) {
  createTaskFeedback.textContent = message
}

function showServerResult(result) {
  serverResult.textContent = JSON.stringify(result, null, 2)
}

function showError(error) {
  const message = `${readable(error.message, 'Runtime API request failed')} · owner=${readable(error.ownerId, 'unknown')} · next=${readable(error.nextAction, 'inspect runtime error')}`
  setFeedback(message)
  diagnostic.textContent = message
  showServerResult({ error: message, code: readable(error.code, 'runtime.request.failed') })
}

function setFlow({ state, task, action, note, meta }) {
  if (state !== undefined) flowState.textContent = state
  if (task !== undefined) flowTask.textContent = task
  if (action !== undefined) flowAction.textContent = action
  if (note !== undefined) flowNote.textContent = note
  if (meta !== undefined) flowMeta.textContent = meta
}

function renderDraftFeedback(draft) {
  clearNode(draftFeedback)
  const fields = draft
    ? [
        ['意图', draft.proposedIntent],
        ['规范化输入', draft.normalizedInput],
        ['已知事实', draft.knownFacts],
        ['建议', draft.proposal],
      ]
    : [['状态', '尚未生成整理反馈。']]
  for (const [label, content] of fields) {
    const row = element('div')
    row.append(element('dt', label), element('dd', readable(content)))
    draftFeedback.append(row)
  }
}

function renderInspection(snapshot) {
  currentInspection = snapshot
  if (visibleState) visibleState.textContent = readable(snapshot.state)
  interactionIdLabel.textContent = `interaction=${readable(snapshot.interactionId)}`
  clearNode(inspection)
  for (const [label, content] of [
    ['state', snapshot.state],
    ['owner', snapshot.owner],
    ['next action', snapshot.nextAction],
    ['condition', snapshot.condition],
    ['input', snapshot.rawInput],
    ['draft', snapshot.draft],
    ['confirmation', snapshot.confirmation],
    ['history', snapshot.history],
  ]) {
    const row = element('div')
    row.append(element('dt', label), element('dd', readable(content)))
    inspection.append(row)
  }
  renderDraftFeedback(snapshot.draft)
  showServerResult(snapshot)
  if (snapshot.draft) {
    field(confirmationForm, 'draftId').value = snapshot.draft.draftId
    field(confirmationForm, 'inputRevision').value = String(snapshot.draft.inputRevision)
  }
  const state = snapshot.state
  matchButton.disabled = !(interactionId && state === 'received')
  for (const button of statusButtons) button.disabled = !(interactionId && ['received', 'matching', 'awaiting-intent'].includes(state))
  proposalButton.disabled = !(interactionId && ['awaiting-intent', 'awaiting-confirmation'].includes(state))
  confirmationButton.disabled = !(interactionId && state === 'awaiting-confirmation' && snapshot.draft)
  dispatchButton.disabled = !(interactionId && state === 'confirmed')
  setFlow({
    state: readable(snapshot.state),
    task: snapshot.taskId?.value ?? snapshot.draft?.proposedIntent ?? '—',
    action: snapshot.nextAction ?? '—',
    note: snapshot.condition ?? '等待输入或继续操作。',
    meta: snapshot.owner ?? '',
  })
}

async function refreshInspection() {
  if (!interactionId) return
  const snapshot = await api.inspectExplicitInteraction(interactionId)
  renderInspection(snapshot)
  return snapshot
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'request.timeout', ownerId: 'ui.timeout', nextAction: 'retry the request or check the runtime' })), ms)
  })
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout])
}

async function run(action, successMessage, options = {}) {
  try {
    const promise = action()
    const result = options.timeoutMs ? await withTimeout(promise, options.timeoutMs, options.label || 'request') : await promise
    if (interactionId) await refreshInspection()
    if (result !== undefined) showServerResult(result)
    if (successMessage) setFeedback(successMessage)
    return result
  } catch (error) {
    showError(error)
    setFlow({ note: `${error.message} · ${error.nextAction || 'inspect the runtime'}` })
    return undefined
  }
}

inputForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(async () => {
    const result = await api.receiveExplicitInput({
      sourceRef: value(inputForm, 'sourceRef'),
      rawInput: value(inputForm, 'rawInput'),
      inputRevision: Number(value(inputForm, 'inputRevision')),
    })
    interactionId = result.interactionId
    await refreshInspection()
    return result
  }, '输入已接收；正在调用 interpret。', { timeoutMs: INTERPRET_TIMEOUT_MS, label: 'interpretExplicitInput' })
})

matchingForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(async () => {
    const matchedTasksText = value(matchingForm, 'matchedTasks') || '[]'
    const matchedTasks = JSON.parse(matchedTasksText)
    if (!Array.isArray(matchedTasks)) throw new Error('matchedTasks must be a JSON array')
    if (currentInspection?.state === 'received') await api.beginExplicitMatching(interactionId)
    await api.recordExplicitMatch(interactionId, {
      normalizedInput: currentInspection?.draft?.normalizedInput || currentInspection?.rawInput || '',
      matchedTasks,
      knownFacts: value(matchingForm, 'knownFacts').split('\n').map((item) => item.trim()).filter(Boolean),
    })
  }, 'match result 已由服务端记录。')
})

proposalForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(() => api.proposeExplicitRequirement(interactionId, {
    proposedIntent: value(proposalForm, 'proposedIntent'),
    proposal: value(proposalForm, 'proposal'),
    decisionRefs: value(proposalForm, 'decisionRefs').split('\n').map((item) => item.trim()).filter(Boolean),
  }), 'proposal 已提交；确认前不会进入 FIFO。')
})

confirmationForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(() => api.confirmExplicitRequirement(interactionId, {
    draftId: value(confirmationForm, 'draftId'),
    inputRevision: Number(value(confirmationForm, 'inputRevision')),
    confirmationRef: value(confirmationForm, 'confirmationRef'),
    confirmedBy: value(confirmationForm, 'confirmedBy'),
    confirmedAt: new Date(value(confirmationForm, 'confirmedAt')).toISOString(),
    payloadRef: value(confirmationForm, 'payloadRef'),
  }), 'confirmation receipt 已返回；现在才允许 dispatch。')
})

for (const button of statusButtons) {
  button.addEventListener('click', () => void run(async () => {
    if (currentInspection?.state === 'received') await api.beginExplicitMatching(interactionId)
    return api.completeExplicitStatusQuery(interactionId)
  }, 'status-only receipt 已返回；未创建 FIFO 或 Task。'))
}

dispatchButton.addEventListener('click', () => void run(
  () => api.dispatchNextExplicitRequirement(),
  'dispatch receipt 已返回；Task 状态请继续从 Runtime projection 查询。',
))

document.querySelector('[data-action="steer"]').addEventListener('click', () => void run(
  () => api.stop(value(controlForm, 'taskId')),
  'steer/stop 已通过正式 stop operation route 请求。',
))

document.querySelector('[data-action="continue"]').addEventListener('click', () => void run(
  async () => {
    const status = await api.status()
    return api.startExecution(value(controlForm, 'taskId'), { mode: status.mode, prompt: value(controlForm, 'prompt') })
  },
  'continue 已通过正式 execution route 请求。',
))

for (const radio of confirmPolicyRadios) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return
    confirmPolicy = radio.value
    setFlow({ note: confirmPolicy === 'auto' ? '自动确认已启用；提交后将直接 confirm + dispatch。' : '手动确认已启用；proposal 后需要点击确认。' })
  })
}

function renderTasks(tasksData) {
  clearNode(taskList)
  const all = []
  for (const group of ['running', 'waiting', 'draft', 'completed', 'stopped', 'failed']) {
    for (const task of tasksData[group] ?? []) all.push({ task, group })
  }
  if (all.length === 0) {
    taskList.append(element('li', '当前没有任务。请使用“直接创建任务”或在输入框提交需求。', 'task-row-empty'))
    taskQueueMeta.textContent = '0 项'
    return
  }
  taskQueueMeta.textContent = `${all.length} 项`
  for (const { task, group } of all) {
    const row = element('li', undefined, 'task-row')
    if (task.taskId?.value === selectedTaskId) row.classList.add('is-selected')
    const info = element('div')
    info.append(
      element('strong', task.title || task.taskId?.value),
      element('small', `${group} · ${task.currentState || task.stateLabel || task.state}`),
    )
    const chip = element('span', task.stateLabel || task.state, 'state-chip')
    chip.dataset.tone = stateTone(task.state)
    info.append(chip)
    const meta = element('div', undefined, 'task-row-meta')
    meta.append(element('time', formatTime(task.updatedAt)))
    row.append(info, meta)
    row.tabIndex = 0
    row.addEventListener('click', () => selectTask(task.taskId?.value, task.title))
    taskList.append(row)
  }
}

function selectTask(taskIdValue, title) {
  selectedTaskId = taskIdValue
  field(createTaskForm, 'taskId').value = taskIdValue || ''
  field(createTaskForm, 'title').value = title || ''
  updateTaskButton.disabled = !taskIdValue
  deleteTaskButton.disabled = !taskIdValue
  setCreateFeedback(taskIdValue ? `已选择任务 ${taskIdValue}（${title || ''}）；可以保存修改或删除。` : '尚未选择任务。')
  liveEventMeta.textContent = taskIdValue ? `已选择 ${taskIdValue}` : '尚无事件。'
  if (taskIdValue) void loadLiveEvents(taskIdValue)
  renderTasks({ running: tasks.running ?? [], waiting: tasks.waiting ?? [], draft: tasks.draft ?? [], completed: tasks.completed ?? [], stopped: tasks.stopped ?? [], failed: tasks.failed ?? [] })
}

async function loadTasks() {
  try {
    const list = await api.listTasks()
    tasks = list
    renderTasks(list)
  } catch (error) {
    clearNode(taskList); taskList.append(element('li', `${error.message} · ${error.nextAction || 'inspect runtime'}`, 'task-row-empty'))
  }
}

async function loadLiveEvents(taskIdValue) {
  clearNode(liveEventList)
  try {
    const detail = await api.taskDetail(taskIdValue)
    const events = detail.recentEvents ?? detail.events ?? []
    if (events.length === 0) {
      liveEventList.append(element('li', '该任务尚无事件。', 'event-row-empty'))
      return
    }
    for (const event of events.slice(-15).reverse()) {
      const row = element('li', undefined, 'event-row')
      row.append(element('time', formatTime(event.occurredAt)))
      const body = element('div')
      body.append(element('span', event.kind, 'event-row-kind'), element('p', event.summary || event.state || ''))
      row.append(body)
      liveEventList.append(row)
    }
  } catch (error) {
    liveEventList.append(element('li', `${error.message} · ${error.nextAction || 'inspect runtime'}`, 'event-row-empty'))
  }
}

createTaskForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void (async () => {
    const title = value(createTaskForm, 'title')
    const directive = value(createTaskForm, 'directive')
    if (!title) {
      setCreateFeedback('任务名称必填。')
      return
    }
    try {
      const created = await api.createTask({ title, ...(directive ? { directive } : {}) })
      setCreateFeedback(`已创建任务 ${created.taskId?.value || created.taskId}。`)
      field(createTaskForm, 'title').value = ''
      field(createTaskForm, 'directive').value = ''
      await loadTasks()
      if (created.taskId?.value) await loadLiveEvents(created.taskId.value)
    } catch (error) {
      setCreateFeedback(`${error.message} · ${error.nextAction || 'inspect runtime'}`)
    }
  })()
})

updateTaskButton.addEventListener('click', () => void (async () => {
  const taskIdValue = value(createTaskForm, 'taskId')
  const title = value(createTaskForm, 'title')
  if (!taskIdValue) {
    setCreateFeedback('请先从任务队列选择要修改的任务。')
    return
  }
  if (!title) {
    setCreateFeedback('任务名称必填。')
    return
  }
  try {
    await api.updateTask(taskIdValue, { title })
    setCreateFeedback(`已更新任务 ${taskIdValue}。`)
    await loadTasks()
  } catch (error) {
    setCreateFeedback(`${error.message} · ${error.nextAction || 'inspect runtime'}`)
  }
})())

deleteTaskButton.addEventListener('click', () => void (async () => {
  const taskIdValue = value(createTaskForm, 'taskId')
  if (!taskIdValue) {
    setCreateFeedback('请先从任务队列选择要删除的任务。')
    return
  }
  if (!window.confirm(`删除任务 ${taskIdValue}？`)) return
  try {
    await api.deleteTask(taskIdValue)
    setCreateFeedback(`已删除任务 ${taskIdValue}。`)
    field(createTaskForm, 'taskId').value = ''
    field(createTaskForm, 'title').value = ''
    selectedTaskId = undefined
    updateTaskButton.disabled = true
    deleteTaskButton.disabled = true
    await loadTasks()
  } catch (error) {
    setCreateFeedback(`${error.message} · ${error.nextAction || 'inspect runtime'}`)
  }
})())

void api.status().then((status) => {
  runtimeMode.textContent = `mode=${readable(status.mode)}`
  runtimeStatus.dataset.tone = status.state === 'ready' ? 'success' : 'warning'
  runtimeStatus.textContent = `mode=${status.mode} · provider=${status.providerState}`
}).catch(showError)

void loadTasks()
