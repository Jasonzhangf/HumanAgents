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
  taskDashboardHref,
} from './runtime-shell.js'
import { mountInteractionWorkCard } from './interaction-work-card.js'
import {
  projectInteractionCardFromEntries,
  projectInteractionCardFromSnapshot,
} from './interaction-card-page.js'

const { main, status, interactionCardHosts } = makePageShell(
  'Index',
  'Explicit Input',
  '任务输入',
  '接受用户任务、展示只读整理反馈，并在提交后进入执行观测。',
)
const interactionCardHost = interactionCardHosts[0]
const interactionCard = interactionCardHost ? mountInteractionWorkCard(interactionCardHost) : null
interactionCard?.update(projectInteractionCardFromEntries([], 'received'))

let interactionId
let confirmation
let latestState = 'received'
let submitting = false
let pendingSubmission
const cardState = { sequence: 0, entries: [] }

function appendCardEvent(kind, text, sourceKind = kind, detail = {}) {
  cardState.sequence += 1
  const activeInteractionId = detail.interactionId || interactionId || 'pending-input'
  cardState.entries = [
    ...cardState.entries,
    {
      sequence: cardState.sequence,
      interactionId: activeInteractionId,
      kind,
      sourceKind,
      eventKey: detail.eventKey || kind,
      text,
      ...detail,
    },
  ]
  interactionCard?.update(projectInteractionCardFromEntries(cardState.entries, latestState))
}

function appendCardError(error) {
  appendCardEvent('failure', error.message || String(error), 'error', {
    eventKey: 'request-failed',
    error: { code: error.code, message: error.message || String(error), ownerId: error.ownerId || 'humanagent.app' },
    evidenceRefs: error.evidenceRefs || [],
  })
}

function updateCardFromSnapshot(snapshot) {
  cardState.sequence = 0
  cardState.entries = []
  const projection = projectInteractionCardFromSnapshot(snapshot)
  // The entry form submit is the only authorization point. The work card
  // therefore never exposes a second confirmation action on this page.
  interactionCard?.update({ ...projection, actions: [] })
}

function liveArea() {
  const section = element('section', undefined, 'section')
  section.id = 'entry-live'
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '队列与任务状态'), element('span', 'Runtime', 'section-meta'))
  section.append(head, element('p', '尚未提交任务。', 'empty'))
  return section
}

function renderField(section, label, value) {
  const row = element('div', undefined, 'detail-cell')
  row.append(element('dt', label), element('dd', value || '—'))
  section.append(row)
}

function renderDraftContainer() {
  const section = element('section', undefined, 'section')
  section.id = 'entry-draft'
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '整理反馈（只读）'), element('span', '提交后自动进入执行观测', 'section-meta'))
  section.append(head)
  return section
}

function setEntryError(error) {
  const panel = document.querySelector('#entry-error')
  if (!panel) return
  if (!error) {
    panel.hidden = true
    clearNode(panel)
    return
  }
  clearNode(panel)
  panel.hidden = false
  panel.append(
    element('strong', error.code || 'request.failed'),
    element('p', `${error.message || String(error)} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'inspect the runtime error'}`),
  )
}

function renderDraft(snapshot) {
  const section = document.querySelector('#entry-draft')
  if (!section) return
  clearNode(section)
  if (snapshot.state === 'awaiting-clarification') {
    const panel = element('div', undefined, 'panel')
    const question = snapshot.clarifications?.at(-1)?.question || snapshot.reply || '需要澄清'
    panel.append(element('h3', question))
    const form = element('form', undefined, 'form-grid')
    const label = element('label')
    label.append('澄清', element('input', undefined))
    const input = label.querySelector('input')
    input.name = 'answer'
    input.required = true
    form.append(label)
    const actions = element('div', undefined, 'actions')
    const button = element('button', '回答并继续', 'button button--primary')
    button.type = 'submit'
    actions.append(button)
    form.append(actions)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const answer = input.value.trim()
      if (!answer) {
        setEntryError(Object.assign(new Error('请先填写澄清内容。'), {
          code: 'request.invalid-field',
          ownerId: 'humanagent.app.ui',
          nextAction: 'provide the requested clarification',
        }))
        return
      }
      if (submitting || !pendingSubmission) return
      submitting = true
      button.disabled = true
      clearEntryError()
      void executeSubmission(pendingSubmission, answer)
        .catch((error) => handleSubmissionError(error, button))
        .finally(() => {
          submitting = false
          button.disabled = false
        })
    })
    panel.append(form)
    section.append(panel)
    updateCardFromSnapshot(snapshot)
    return
  }

  if (snapshot.draft) {
    const panel = element('div', undefined, 'panel')
    const grid = element('dl', undefined, 'detail-grid')
    renderField(grid, '意图', snapshot.draft.proposedIntent)
    renderField(grid, '规范化输入', snapshot.draft.normalizedInput)
    renderField(grid, '已知事实', (snapshot.draft.knownFacts || []).join('\n'))
    panel.append(grid)
    const proposal = element('section', undefined, 'section')
    proposal.append(element('h3', '建议'), element('p', snapshot.draft.proposal, 'muted'))
    panel.append(proposal)
    section.append(panel)
    updateCardFromSnapshot(snapshot)
    return
  }

  section.append(element('p', `状态：${snapshot.state} · ${snapshot.nextAction}`, 'empty'))
  updateCardFromSnapshot(snapshot)
}

function clearEntryError() {
  setEntryError(null)
}

function renderStatus(summary, rows) {
  const section = document.querySelector('#entry-live')
  if (!section) return
  clearNode(section)
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '队列与任务状态'), element('span', `${rows.length} 项`, 'section-meta'))
  section.append(head)

  const stats = element('div', undefined, 'stats')
  if (summary.implicitScheduling) {
    const queue = summary.implicitScheduling
    const card = element('article', undefined, 'stat')
    card.append(
      element('span', `FIFO · ${queue.requirementId}`),
      element('strong', String(queue.fifoSeq)),
      element('p', `${queue.state} · ${queue.code} · ${queue.nextAction}`, 'muted'),
    )
    stats.append(card)
  }
  for (const [label, value] of [
    ['已确认', confirmation ? confirmation.requirementId : '未确认'],
    ['任务数量', String(rows.length)],
  ]) {
    const card = element('article', undefined, 'stat')
    card.append(element('span', label), element('strong', value))
    stats.append(card)
  }
  section.append(stats)

  if (rows.length === 0) {
    section.append(element('p', confirmation ? '已确认，等待隐式队列创建任务。' : '尚未提交任务。', 'empty'))
    return
  }
  const list = element('div', undefined, 'panel stack')
  for (const row of rows) {
    const link = element('a', undefined, 'task-row-link')
    link.href = taskDashboardHref(row.taskId.value)
    const copy = element('div')
    copy.append(element('h3', row.title))
    copy.append(element('p', `${row.currentState} · 下一步：${row.nextStep}`))
    const stateChip = element('span', row.stateLabel, 'state-chip')
    stateChip.dataset.tone = stateTone(row.state)
    const meta = element('div', undefined, 'item-meta')
    meta.append(element('time', formatTime(row.updatedAt)))
    link.append(copy, stateChip, meta)
    link.style.textDecoration = 'none'
    list.append(link)
  }
  section.append(list)
}

function taskRows(tasks) {
  return [
    ...(tasks?.draft ?? []),
    ...(tasks?.waiting ?? []),
    ...(tasks?.running ?? []),
    ...(tasks?.completed ?? []),
    ...(tasks?.stopped ?? []),
    ...(tasks?.failed ?? []),
  ]
}

async function refreshQueue() {
  try {
    const [runtimeStatus, tasks] = await Promise.all([api.status(), api.listTasks()])
    renderStatus(runtimeStatus, taskRows(tasks))
  } catch (error) {
    const panel = document.querySelector('#entry-live')
    if (panel) {
      clearNode(panel)
      panel.append(element('p', `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`, 'empty'))
    }
  }
}

function value(form, name) {
  const control = form.elements.namedItem(name)
  return control ? String(control.value).trim() : ''
}

function timeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function isIanaTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date())
    return true
  } catch (_) {
    return false
  }
}

function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) throw new Error('请填写有效的本地日期和时间。')
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  }
}

function localParts(date, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

function zonedDateTimeToUtc(value, timezone) {
  if (!isIanaTimeZone(timezone)) throw new Error(`时区无效：${timezone}`)
  const desired = parseLocalDateTime(value)
  const desiredUtc = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, desired.second)
  let guess = desiredUtc
  for (let index = 0; index < 4; index += 1) {
    const actual = localParts(new Date(guess), timezone)
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    const delta = desiredUtc - actualUtc
    if (delta === 0) break
    guess += delta
  }
  return new Date(guess).toISOString()
}

function defaultLocalDateTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function optionalNumber(form, name) {
  const raw = value(form, name)
  if (!raw) return undefined
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数。`)
  return parsed
}

function buildExecutionPolicy(form, submissionId) {
  const timezone = value(form, 'timezone')
  if (!isIanaTimeZone(timezone)) throw new Error(`时区无效：${timezone}`)
  const now = new Date().toISOString()
  const common = {
    policyId: `execution-policy:${submissionId}`,
    policyRevision: 1,
    timezone,
    canonicalInstant: now,
    dstMode: 'wall',
    dstMissedPolicy: 'shift-forward',
    dstAmbiguousPolicy: 'earlier-offset',
    latePolicy: 'run-once',
    busyPolicy: 'skip',
  }
  const mode = value(form, 'executionMode')
  if (mode === 'once') return { ...common, executionMode: 'once', dueAt: now }
  const startAt = zonedDateTimeToUtc(value(form, 'scheduledStartAt'), timezone)
  const endAt = value(form, 'scheduledEndAt') ? zonedDateTimeToUtc(value(form, 'scheduledEndAt'), timezone) : undefined
  const maxOccurrences = optionalNumber(form, 'maxOccurrences')
  const optional = {
    ...(endAt === undefined ? {} : { endAt }),
    ...(maxOccurrences === undefined ? {} : { maxOccurrences }),
  }
  if (mode === 'scheduled') return { ...common, ...optional, executionMode: 'scheduled', startAt }
  if (mode !== 'recurring') throw new Error(`不支持执行类型：${mode}`)
  const frequency = value(form, 'recurringFrequency')
  if (frequency === 'interval') {
    return {
      ...common,
      ...optional,
      executionMode: 'recurring',
      startAt,
      frequency,
      intervalMinutes: optionalNumber(form, 'intervalMinutes'),
    }
  }
  const timeOfDay = value(form, 'timeOfDay') || value(form, 'scheduledStartAt').slice(11, 16)
  if (frequency === 'daily') return { ...common, ...optional, executionMode: 'recurring', startAt, frequency, timeOfDay }
  if (frequency === 'weekly') {
    const weekDays = value(form, 'weekDays')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
    if (weekDays.length === 0 || weekDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error('weekDays 必须是 0 到 6 的整数列表。')
    }
    return { ...common, ...optional, executionMode: 'recurring', startAt, frequency, timeOfDay, weekDays }
  }
  throw new Error(`不支持周期类型：${frequency}`)
}

async function prepareSubmission(rawInput, form) {
  const submissionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const knownTaskIds = new Set(taskRows(await api.listTasks().catch(() => ({}))).map((row) => row.taskId?.value).filter(Boolean))
  return {
    rawInput,
    executionPolicy: buildExecutionPolicy(form, submissionId),
    confirmationRef: `confirmation:ui:${submissionId}`,
    confirmedAt: new Date().toISOString(),
    payloadRef: `asset://requirements/ui:${submissionId}`,
    idempotencyKey: `ui-entry:${submissionId}`,
    knownTaskIds,
  }
}

async function waitForTask(submission) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const tasks = await api.listTasks()
    const rows = taskRows(tasks)
    const candidate = rows.find((row) => {
      const taskIdValue = row.taskId?.value
      if (!taskIdValue || submission.knownTaskIds.has(taskIdValue)) return false
      return !submission.normalizedInput || row.title === submission.normalizedInput || row.title === submission.rawInput
    }) ?? rows.find((row) => {
      const taskIdValue = row.taskId?.value
      return taskIdValue && !submission.knownTaskIds.has(taskIdValue)
    })
    if (candidate?.taskId?.value) return candidate.taskId.value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Object.assign(new Error('任务已提交，但执行观测任务尚未就绪。'), {
    code: 'observation.task-not-ready',
    ownerId: 'humanagent.app.ui',
    nextAction: 'open the task list and retry observation',
  })
}

async function executeSubmission(submission, clarificationAnswer) {
  if (!interactionId) {
    const received = await api.receiveExplicitInput({
      sourceRef: 'ui:entry',
      rawInput: submission.rawInput,
      inputRevision: 1,
      requestKind: 'new-task-preview',
    })
    interactionId = received.interactionId
    appendCardEvent('user', submission.rawInput, 'user', { eventKey: 'explicit.raw-input', interactionId })
  }

  let snapshot = await api.inspectExplicitInteraction(interactionId)
  if (snapshot.state === 'awaiting-clarification') {
    if (!clarificationAnswer) {
      renderDraft(snapshot)
      return snapshot
    }
    await api.answerExplicitClarification(interactionId, clarificationAnswer)
    appendCardEvent('user', clarificationAnswer, 'user', { eventKey: 'explicit.clarification-answer' })
    snapshot = await api.inspectExplicitInteraction(interactionId)
  }
  if (snapshot.state === 'received' || snapshot.state === 'matching') {
    snapshot = await api.interpretExplicitInput(interactionId)
  }
  latestState = snapshot.state
  renderDraft(snapshot)
  if (snapshot.state === 'awaiting-clarification') return snapshot
  if (snapshot.state === 'status-only') {
    status.dataset.tone = 'success'
    status.textContent = snapshot.reply || snapshot.nextAction
    return snapshot
  }
  if (snapshot.state === 'confirmed') {
    const taskIdValue = await waitForTask(submission)
    window.location.assign(observationHref(taskIdValue))
    return snapshot
  }
  if (snapshot.state !== 'awaiting-confirmation' || !snapshot.draft) {
    throw Object.assign(new Error(`显式大脑当前状态：${snapshot.state}。${snapshot.nextAction}`), {
      code: 'explicit-brain.state-invalid',
      ownerId: 'humanagent.runtime.explicit-brain',
      nextAction: 'inspect the current interaction state before retrying',
    })
  }

  submission.normalizedInput = snapshot.draft.normalizedInput
  const receipt = await api.confirmExplicitRequirement(interactionId, {
    draftId: snapshot.draft.draftId,
    inputRevision: snapshot.draft.inputRevision,
    confirmationRef: submission.confirmationRef,
    confirmedBy: 'human:operator',
    confirmedAt: submission.confirmedAt,
    payloadRef: submission.payloadRef,
    idempotencyKey: submission.idempotencyKey,
    goal: snapshot.draft.proposal,
    scope: snapshot.draft.normalizedInput,
    executionPolicy: submission.executionPolicy,
  })
  confirmation = receipt.requirement
  appendCardEvent('decision', '任务已提交，正在打开执行观测', 'decision', { eventKey: 'explicit.confirmation-submitted' })
  status.dataset.tone = 'success'
  if (submission.executionPolicy.executionMode !== 'once') {
    status.textContent = '执行计划已保存，等待真实 occurrence 进入执行观测。'
    await refreshQueue()
    return snapshot
  }
  status.textContent = '任务已提交，正在打开执行观测…'
  const taskIdValue = await waitForTask(submission)
  window.location.assign(observationHref(taskIdValue))
  return snapshot
}

function handleSubmissionError(error, button) {
  appendCardError(error)
  setEntryError(error)
  status.dataset.tone = 'danger'
  status.textContent = `${error.message || String(error)} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'inspect the runtime error'}`
  if (button) button.textContent = interactionId ? '重试本次提交' : '重试提交'
}

function field(labelText, control) {
  const label = element('label')
  label.append(labelText, control)
  return label
}

function renderForm() {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '用户任务'), element('span', '提交即授权创建并执行', 'section-meta'))
  section.append(head)

  const panel = element('div', undefined, 'panel')
  const form = element('form', undefined, 'form-grid')
  form.id = 'entry-form'
  const textarea = element('textarea')
  textarea.name = 'rawInput'
  textarea.required = true
  textarea.placeholder = '描述要处理的一个任务'
  form.append(field('任务输入', textarea))

  const mode = element('select')
  mode.name = 'executionMode'
  for (const [value, label] of [['once', '单次执行'], ['scheduled', '定时执行'], ['recurring', '周期执行']]) {
    const option = element('option', label)
    option.value = value
    mode.append(option)
  }
  form.append(field('执行类型', mode))

  const timezone = element('input')
  timezone.name = 'timezone'
  timezone.required = true
  timezone.value = timeZone()
  form.append(field('时区', timezone))

  const startAt = element('input')
  startAt.name = 'scheduledStartAt'
  startAt.type = 'datetime-local'
  startAt.required = true
  startAt.value = defaultLocalDateTime()
  const startField = field('开始时间', startAt)
  startField.dataset.executionField = 'scheduled recurring'
  form.append(startField)

  const endAt = element('input')
  endAt.name = 'scheduledEndAt'
  endAt.type = 'datetime-local'
  const endField = field('结束时间（可选）', endAt)
  endField.dataset.executionField = 'scheduled recurring'
  form.append(endField)

  const maxOccurrences = element('input')
  maxOccurrences.name = 'maxOccurrences'
  maxOccurrences.type = 'number'
  maxOccurrences.min = '1'
  const maxField = field('最大次数（可选）', maxOccurrences)
  maxField.dataset.executionField = 'scheduled recurring'
  form.append(maxField)

  const frequency = element('select')
  frequency.name = 'recurringFrequency'
  for (const [value, label] of [['interval', '固定间隔'], ['daily', '每天'], ['weekly', '每周']]) {
    const option = element('option', label)
    option.value = value
    frequency.append(option)
  }
  const frequencyField = field('周期规则', frequency)
  frequencyField.dataset.executionField = 'recurring'
  form.append(frequencyField)

  const intervalMinutes = element('input')
  intervalMinutes.name = 'intervalMinutes'
  intervalMinutes.type = 'number'
  intervalMinutes.min = '1'
  intervalMinutes.value = '60'
  const intervalField = field('间隔分钟', intervalMinutes)
  intervalField.dataset.executionField = 'recurring'
  intervalField.dataset.recurringFrequency = 'interval'
  form.append(intervalField)

  const timeOfDay = element('input')
  timeOfDay.name = 'timeOfDay'
  timeOfDay.placeholder = 'HH:mm'
  timeOfDay.pattern = '([01][0-9]|2[0-3]):[0-5][0-9]'
  const timeOfDayField = field('每天时间', timeOfDay)
  timeOfDayField.dataset.executionField = 'recurring'
  timeOfDayField.dataset.recurringFrequency = 'daily weekly'
  form.append(timeOfDayField)

  const weekDays = element('input')
  weekDays.name = 'weekDays'
  weekDays.placeholder = '例如：1,2,3（周日=0）'
  const weekDaysField = field('星期（逗号分隔）', weekDays)
  weekDaysField.dataset.executionField = 'recurring'
  weekDaysField.dataset.recurringFrequency = 'weekly'
  form.append(weekDaysField)

  const errorPanel = element('section', undefined, 'panel')
  errorPanel.id = 'entry-error'
  errorPanel.hidden = true
  errorPanel.setAttribute('role', 'alert')
  form.append(errorPanel)

  const actions = element('div', undefined, 'actions')
  const submitButton = element('button', '创建并执行', 'button button--primary')
  submitButton.type = 'submit'
  actions.append(submitButton)
  form.append(actions)

  const syncExecutionFields = () => {
    const modeValue = mode.value
    for (const node of form.querySelectorAll('[data-execution-field]')) {
      node.hidden = !node.dataset.executionField.split(' ').includes(modeValue)
    }
    for (const node of form.querySelectorAll('[data-recurring-frequency]')) {
      node.hidden = modeValue !== 'recurring' || !node.dataset.recurringFrequency.split(' ').includes(frequency.value)
    }
    submitButton.textContent = modeValue === 'once' ? '创建并执行' : '保存执行计划'
  }
  mode.addEventListener('change', syncExecutionFields)
  frequency.addEventListener('change', syncExecutionFields)
  syncExecutionFields()

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (submitting) return
    const rawInput = textarea.value.trim()
    if (!rawInput) {
      setEntryError(Object.assign(new Error('请先填写任务输入。'), {
        code: 'request.invalid-field',
        ownerId: 'humanagent.app.ui',
        nextAction: 'provide the task input',
      }))
      return
    }
    submitting = true
    submitButton.disabled = true
    textarea.readOnly = true
    clearEntryError()
    status.dataset.tone = 'warning'
    status.textContent = '正在整理并提交任务…'
    void (async () => {
      if (!pendingSubmission || pendingSubmission.rawInput !== rawInput) {
        pendingSubmission = await prepareSubmission(rawInput, form)
      }
      await executeSubmission(pendingSubmission)
    })().catch((error) => handleSubmissionError(error, submitButton)).finally(() => {
      submitting = false
      submitButton.disabled = false
      if (!interactionId) textarea.readOnly = false
    })
  })

  panel.append(form)
  section.append(panel)
  return section
}

async function load() {
  const { status: runtimeStatus, error } = await loadRuntimeStatus()
  renderRuntimeStatus(status, runtimeStatus, error)
  const layout = element('div', undefined, 'layout')
  const left = element('div')
  left.append(renderForm())
  if (interactionCardHost) left.append(interactionCardHost)
  left.append(renderDraftContainer(), liveArea())
  layout.append(left)
  main.append(layout)
  await refreshQueue()
}

void load().catch((error) => {
  status.dataset.tone = 'danger'
  status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
})
