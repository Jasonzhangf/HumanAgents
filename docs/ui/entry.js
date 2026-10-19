import {
  api,
  appendPairingEntry,
  clearNode,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  renderPageError,
  renderRuntimeStatus,
  renderTaskExecutions,
  stateTone,
  taskRowStateText,
  taskRowTitle,
  taskFlowText,
  taskDashboardHref,
  technicalDetailTrigger,
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
  '接受用户任务、展示只读整理反馈，并在提交后显示任务进展与执行入口。',
)
const interactionCardHost = interactionCardHosts[0]
let interactionCard = null

// The shared work card mounts on the first real event or snapshot update. Until
// then the host stays genuinely empty, so first entry claims no work.
function presentInteractionCard(projection) {
  if (!interactionCardHost || !projection) return
  if (!interactionCard) interactionCard = mountInteractionWorkCard(interactionCardHost)
  interactionCard.update(projection)
}

let interactionId
let confirmation
let latestState = 'received'
let submitting = false
let pendingSubmission
const cardState = { sequence: 0, entries: [] }

function appendCardEvent(kind, text, sourceKind = kind, detail = {}) {
  cardState.sequence += 1
  // The interaction id is only the one the runtime reported. The page never
  // mints a placeholder identity for an event that carries none.
  const activeInteractionId = detail.interactionId || interactionId
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
  presentInteractionCard(projectInteractionCardFromEntries(cardState.entries, latestState))
}

function updateCardFromSnapshot(snapshot) {
  cardState.sequence = 0
  cardState.entries = []
  const projection = projectInteractionCardFromSnapshot(snapshot)
  if (!projection) return
  // The entry form submit is this new requirement's business confirmation. The
  // work card therefore never exposes a second confirmation action on this page.
  presentInteractionCard({ ...projection, actions: [] })
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

// The draft region exists only once a real interaction snapshot supplies
// content. It takes the place the old always-rendered container occupied.
function ensureDraftSection() {
  const existing = document.querySelector('#entry-draft')
  if (existing) return existing
  const section = element('section', undefined, 'section')
  section.id = 'entry-draft'
  const live = document.querySelector('#entry-live')
  if (live && live.parentNode) live.parentNode.insertBefore(section, live)
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
  appendPairingEntry(panel, error)
}

function renderDraft(snapshot) {
  const section = ensureDraftSection()
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
    if (typeof snapshot.revision?.title === 'string' && snapshot.revision.title.trim() !== '') {
      renderField(grid, '任务名称', snapshot.revision.title)
    }
    const taskType = taskFlowText(snapshot.revision?.taskFlow)
    if (taskType) renderField(grid, '任务类型', taskType)
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
    ['任务数量', String(rows.length)],
  ]) {
    const card = element('article', undefined, 'stat')
    card.append(element('span', label), element('strong', value))
    stats.append(card)
  }
  section.append(stats)

  if (rows.length === 0) {
    section.append(element('p', confirmation ? '需求已提交，等待隐式队列创建任务。' : '尚未提交任务。', 'empty'))
    return
  }
  const list = element('div', undefined, 'panel stack')
  for (const row of rows) {
    const link = element('a', undefined, 'task-row-link')
    link.href = taskDashboardHref(row.taskId.value)
    link.dataset.taskId = row.taskId.value
    const copy = element('div')
    copy.append(element('h3', taskRowTitle(row)))
    copy.append(element('p', taskRowStateText(row)))
    const stateChip = element('span', row.stateLabel, 'state-chip')
    stateChip.dataset.tone = stateTone(row.executionState || row.state)
    const meta = element('div', undefined, 'item-meta')
    meta.append(element('time', formatTime(row.updatedAt)))
    const taskType = taskFlowText(row.taskFlow)
    if (taskType) meta.append(element('span', taskType))
    link.append(copy, stateChip, meta)
    link.style.textDecoration = 'none'
    list.append(link)
    const executions = renderTaskExecutions(row)
    if (executions) list.append(executions)
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
      appendPairingEntry(panel, error)
    }
  }
}

// Land on the real business Task row after a submission. The row carries the
// runtime's own executions and controlTarget links; Observation stays a
// deliberate deeper read-only navigation.
function focusSubmittedTask(taskIdValue) {
  const link = [...document.querySelectorAll('#entry-live .task-row-link')]
    .find((candidate) => candidate.dataset.taskId === taskIdValue)
  if (link) link.scrollIntoView({ block: 'center' })
}

async function landOnSubmittedTask(identity) {
  let taskIdValue
  let lookupError
  try {
    taskIdValue = await waitForTask(identity)
  } catch (error) {
    // The task list is still the real business projection even when the exact
    // row identity was not returned in time; refresh it and keep the failure.
    lookupError = error
  }
  await refreshQueue()
  if (taskIdValue) focusSubmittedTask(taskIdValue)
  if (lookupError) throw lookupError
}

function value(form, name) {
  const control = form.elements.namedItem(name)
  return control ? String(control.value).trim() : ''
}

// Every user-selected input that must stay fixed for one attempted submission:
// the goal text and the execution trigger. Classification is owned by the
// explicit brain and is not a human input.
function executionInputs(form) {
  return {
    executionMode: value(form, 'executionMode'),
    timezone: value(form, 'timezone'),
    scheduledStartAt: value(form, 'scheduledStartAt'),
    scheduledEndAt: value(form, 'scheduledEndAt'),
    maxOccurrences: value(form, 'maxOccurrences'),
    recurringFrequency: value(form, 'recurringFrequency'),
    intervalMinutes: value(form, 'intervalMinutes'),
    timeOfDay: value(form, 'timeOfDay'),
    weekDays: value(form, 'weekDays'),
  }
}

function selectionInputs(rawInput, form) {
  return { rawInput, execution: executionInputs(form) }
}

// Text equality alone must not reuse a prepared submission: a retry reuses the
// same receipt identity only when the goal and the trigger are unchanged.
function selectionsEqual(left, right) {
  if (!left || !right) return false
  return left.rawInput === right.rawInput
    && JSON.stringify(left.execution) === JSON.stringify(right.execution)
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

function prepareSubmission(rawInput, form) {
  const submissionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return {
    rawInput,
    executionPolicy: buildExecutionPolicy(form, submissionId),
    confirmationRef: `confirmation:ui:${submissionId}`,
    confirmedAt: new Date().toISOString(),
    payloadRef: `asset://requirements/ui:${submissionId}`,
    idempotencyKey: `ui-entry:${submissionId}`,
    selection: selectionInputs(rawInput, form),
  }
}

function taskLandingUnresolved(code, message) {
  return Object.assign(new Error(message), {
    code,
    ownerId: 'humanagent.app.ui',
    nextAction: 'refresh the task list and retry',
  })
}

// Exact correlation only. Every key in `identity` must be present and equal on
// the row's committed identitySource, so a missing field on either side can
// never match and two absent values can never form a successful selection.
function rowMatchesIdentitySource(identitySource, identity) {
  if (!identitySource || !identity) return false
  const keys = Object.keys(identity)
  if (keys.length === 0) return false
  return keys.every((key) => {
    const expected = identity[key]
    if (expected === undefined || expected === null || expected === '') return false
    return identitySource[key] === expected
  })
}

// The normal receipt is the only source for this identity. It carries exactly
// requirementId, draftId and inputRevision; all three must be nonmissing.
function identityFromReceipt(requirement) {
  const requirementId = requirement?.requirementId
  const draftId = requirement?.draftId
  const inputRevision = requirement?.inputRevision
  if (!requirementId || !draftId || inputRevision === undefined || inputRevision === null) return null
  return { requirementId, draftId, inputRevision }
}

// A confirmed retry reads the backend snapshot, never the outbound submission.
// The snapshot confirmation carries draftId, inputRevision and confirmationRef;
// revision fields are added only when the same snapshot proves they belong to
// that same confirmed draft.
function identityFromConfirmedSnapshot(snapshot) {
  const confirmed = snapshot?.confirmation
  const draftId = confirmed?.draftId
  const inputRevision = confirmed?.inputRevision
  const confirmationRef = confirmed?.confirmationRef
  if (!draftId || inputRevision === undefined || inputRevision === null || !confirmationRef) return null
  const identity = { draftId, inputRevision, confirmationRef }
  const recorded = (snapshot.confirmations || []).find(
    (item) => item?.draftId === draftId && item?.confirmationRef === confirmationRef,
  )
  const revision = snapshot.revision
  const revisionBelongs = Boolean(revision) && revision.draftId === draftId && revision.inputRevision === inputRevision
  const draftRevisionVersion = recorded?.draftRevisionVersion ?? (revisionBelongs ? revision.revisionVersion : undefined)
  const draftRevisionHash = recorded?.draftRevisionHash ?? (revisionBelongs ? revision.revisionHash : undefined)
  if (draftRevisionVersion !== undefined && draftRevisionHash !== undefined) {
    identity.draftRevisionVersion = draftRevisionVersion
    identity.draftRevisionHash = draftRevisionHash
  }
  return identity
}

async function waitForTask(identity) {
  if (!identity) {
    throw taskLandingUnresolved('entry.task-identity-unresolved', '需求已接收，但返回的执行身份不完整，无法定位本次任务。')
  }
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const tasks = await api.listTasks()
    const rows = taskRows(tasks)
    const candidate = rows.find((row) => row.taskId?.value && rowMatchesIdentitySource(row.identitySource, identity))
    if (candidate?.taskId?.value) return candidate.taskId.value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw taskLandingUnresolved('entry.task-not-ready', '任务已提交，但任务列表尚未返回本次任务。')
}

// The explicit-intake states the runtime records once the human authorization is
// done. Only these may drive the card after the confirmation request.
const POST_CONFIRMATION_STATES = new Set(['confirmed', 'dispatched'])

/**
 * The interaction state the work card may project once the runtime accepted the
 * requirement.
 *
 * The caller only reaches this after the runtime returned the typed confirmation
 * receipt for the exact revision, so the interaction is at least `confirmed`.
 * The interaction is re-read so the card reports the state the runtime owns now
 * — for example `dispatched` once the coordinator consumed the requirement. The
 * snapshot the page read before the submit is read-only draft history and never
 * drives this projection. No state name is minted here.
 */
async function postConfirmationState() {
  const current = await api.inspectExplicitInteraction(interactionId).catch(() => undefined)
  return POST_CONFIRMATION_STATES.has(current?.state) ? current.state : 'confirmed'
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
    // The backend snapshot already proves the business confirmation. Keep that
    // fact so a later task-refresh failure still reports the accepted
    // demand instead of downgrading to an unfinished input.
    confirmation = snapshot.confirmation || confirmation || snapshot
    status.dataset.tone = 'success'
    status.textContent = '需求已接收，正在刷新任务进展…'
    await landOnSubmittedTask(identityFromConfirmedSnapshot(snapshot))
    status.textContent = '需求已接收；任务进展已刷新。'
    return snapshot
  }
  if (snapshot.state !== 'awaiting-confirmation' || !snapshot.draft) {
    throw Object.assign(new Error(`显式大脑当前状态：${snapshot.state}。${snapshot.nextAction}`), {
      code: 'explicit-brain.state-invalid',
      ownerId: 'humanagent.runtime.explicit-brain',
      nextAction: 'inspect the current interaction state before retrying',
    })
  }

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
  // The submit is the confirmation. `latestState` still holds the
  // pre-confirmation snapshot the read-only draft above was rendered from, so
  // the card must project the runtime's post-confirmation state from here on.
  latestState = await postConfirmationState()
  appendCardEvent('decision', '需求已提交，正在刷新任务进展', 'decision', { eventKey: 'explicit.confirmation-submitted' })
  status.dataset.tone = 'success'
  if (submission.executionPolicy.executionMode !== 'once') {
    status.textContent = '执行计划已保存；任务进展已刷新。'
    await refreshQueue()
    return snapshot
  }
  status.textContent = '需求已提交，正在刷新任务进展…'
  await landOnSubmittedTask(identityFromReceipt(receipt.requirement))
  status.textContent = '需求已提交；任务进展已刷新。'
  return snapshot
}

function submissionFailureSummary() {
  if (confirmation) return '需求已接收，任务进展尚未刷新。'
  if (interactionId) return '输入已接收，本次处理未完成。'
  return '本次提交未获接收确认。'
}

function handleSubmissionError(error, button) {
  clearNode(status)
  status.dataset.tone = 'danger'
  const recovered = confirmation
    ? '需求已接收；保留已返回内容，刷新任务进展后继续。'
    : interactionId
      ? '输入已接收；保留已返回内容，继续本次处理。'
      : '输入保留，可修正后重试本次提交。'
  status.append(
    element('strong', submissionFailureSummary()),
    element('p', `${recovered} 技术详情保留原始诊断。`),
    technicalDetailTrigger(() => ({
      title: '技术详情',
      entries: [
        ['code', error?.code, 'data-detail-code'],
        ['owner', error?.ownerId, 'data-detail-owner'],
        ['message', error?.message, 'data-detail-message'],
        ['nextAction', error?.nextAction, 'data-detail-next'],
      ],
    })),
  )
  appendPairingEntry(status, error)
  if (button) button.textContent = confirmation ? '重试刷新任务进展' : interactionId ? '重试本次提交' : '重试提交'
}

function field(labelText, control) {
  const label = element('label')
  label.append(labelText, control)
  return label
}

function renderForm() {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '用户任务'), element('span', '提交即确认本次新任务需求', 'section-meta'))
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
  const timezoneField = field('时区', timezone)
  timezoneField.dataset.executionField = 'scheduled recurring'
  form.append(timezoneField)

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
  const submitButton = element('button', '提交任务', 'button button--primary')
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
    // A control inside a hidden field must not stay `required`: the browser
    // would otherwise block the simple 单次 submission on fields the human
    // never sees. The default execution policy is 单次, so only the task input,
    // the execution type and the submit action are shown until the human picks
    // 定时 or 周期.
    const rendered = (control) => !control.closest('[hidden]')
    timezone.required = rendered(timezone)
    startAt.required = rendered(startAt)
    submitButton.textContent = modeValue === 'once' ? '提交任务' : '保存执行计划'
  }
  mode.addEventListener('change', syncExecutionFields)
  frequency.addEventListener('change', syncExecutionFields)
  syncExecutionFields()

  // Once a real interaction exists, this attempt's identity is fixed. The
  // execution trigger is disabled with the goal text so a retry cannot rebind
  // the same receipt to a different execution strategy.
  const freezeCreationInputs = () => {
    for (const control of [mode, timezone, startAt, endAt, maxOccurrences, frequency, intervalMinutes, timeOfDay, weekDays]) {
      control.disabled = true
    }
  }

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
      const selection = selectionInputs(rawInput, form)
      if (!pendingSubmission || !selectionsEqual(pendingSubmission.selection, selection)) {
        pendingSubmission = await prepareSubmission(rawInput, form)
      }
      await executeSubmission(pendingSubmission)
    })().catch((error) => handleSubmissionError(error, submitButton)).finally(() => {
      submitting = false
      submitButton.disabled = false
      if (interactionId) {
        freezeCreationInputs()
      } else {
        textarea.readOnly = false
      }
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
  left.append(liveArea())
  layout.append(left)
  main.append(layout)
  await refreshQueue()
}

void load().catch((error) => {
  renderPageError(status, error)
})
