import {
  api,
  appendPairingEntry,
  clearNode,
  element,
  formatTime,
  loadRuntimeStatus,
  mountPageTemplate,
  openTechnicalDetail,
  renderPageError,
  renderRuntimeStatus,
  renderTaskExecutions,
  stateTone,
  taskRowStateText,
  taskRowTitle,
  taskFlowText,
  taskDashboardHref,
  taskExecutionHref,
  technicalDetailTrigger,
} from './runtime-shell.js'
import { mountInteractionWorkCard } from './interaction-work-card.js'
import {
  projectInteractionCardFromEntries,
  projectInteractionCardFromSnapshot,
} from './interaction-card-page.js'
import { locationFromHash } from './product-location.js'

// ── Page seams shared with the W4 product consumer ──────────────────────────
//
// The entry page is the one authorization point for a genuine new task. The
// seams below keep the risky invariants in pure, injectable functions: one
// submit never creates twice, navigation and refresh never re-submit, browser
// back keeps the draft, and a confirmed task lands on the interaction task page
// with its exact read scope.

export function shouldDisposeEntryPage(event) {
  return !event?.persisted
}

export function createSubmissionGate() {
  let current = null
  return {
    get pending() {
      return current !== null
    },
    begin(operation) {
      if (current !== null) return { started: false, result: current }
      const run = (async () => {
        try {
          return await operation()
        } finally {
          current = null
        }
      })()
      current = run
      return { started: true, result: run }
    },
  }
}

/**
 * Build the visible result for an explicit interaction that does not create a
 * task. A simple answer is a business result, not an invalid intermediate state.
 * Keep the reply in the main status region; it must not be hidden in diagnostics.
 */
export function answeredSubmissionPresentation(snapshot) {
  const state = snapshot?.state
  if (state !== 'answered' && state !== 'status-only') return null
  const reply = typeof snapshot?.reply === 'string' ? snapshot.reply.trim() : ''
  // An answered interaction carries the answer itself; a status receipt carries
  // either its own reply or the runtime's next action. Neither may be invented.
  const text = state === 'answered' ? reply : reply || (typeof snapshot?.nextAction === 'string' ? snapshot.nextAction.trim() : '')
  if (text === '') {
    throw Object.assign(new Error(`显式大脑状态：${state}，但没有返回可展示的结果。`), {
      code: state === 'answered' ? 'explicit-brain.reply-missing' : 'explicit-brain.state-invalid',
      ownerId: 'humanagent.app.ui',
      nextAction: 'inspect the answered interaction before presenting it',
    })
  }
  return { tone: 'success', text, retry: false }
}

export function entryDraftState(state, draft) {
  const base = state && typeof state === 'object' ? state : {}
  return { ...base, entryDraft: { ...draft } }
}

export function entryDraftFromState(state) {
  const draft = state?.entryDraft
  if (!draft || typeof draft.rawInput !== 'string') return null
  return {
    rawInput: draft.rawInput,
    ...(draft.execution && typeof draft.execution === 'object' ? { execution: draft.execution } : {}),
  }
}

function taskIdValue(taskId) {
  return taskId && typeof taskId === 'object' ? taskId.value : taskId
}

function normalizedHint(projectKey, mode) {
  const key = typeof projectKey === 'string' ? projectKey.trim() : ''
  if (!key) return {}
  if (mode === 'fake' || mode === 'rcc') return { projectKey: key, mode }
  return { projectKey: key }
}

/**
 * Read the entry read scope from the explicit URL or a product location hash.
 * The entry page is a write surface, so it only accepts an exact declared
 * project/mode; it never invents one from a task list or a title.
 */
export function entryScopeFromLocation({ search, hash } = {}) {
  const params = search instanceof URLSearchParams
    ? search
    : new URLSearchParams(typeof search === 'string' && search.startsWith('?') ? search.slice(1) : search || '')
  const queryScope = normalizedHint(params.get('projectKey'), params.get('mode'))
  if (queryScope.projectKey) return queryScope

  if (typeof hash === 'string' && hash.includes('#/boards/')) {
    const decoded = locationFromHash(hash)
    if (decoded.kind === 'valid' && decoded.location.scope) {
      const scope = decoded.location.scope
      if (scope.kind === 'task') return normalizedHint(scope.projectKey, scope.mode)
      if (scope.kind === 'project') return normalizedHint(scope.projectKey, undefined)
    }
  }
  return {}
}

/**
 * Find the exact task read scope inside a system project read. A row keeps its
 * own committed projectKey/mode; the entry page only accepts that exact row and
 * never reconstructs a scope from a task id alone.
 */
export function taskScopeFromSystemRead(read, taskId) {
  const id = taskIdValue(taskId)
  if (!read || !Array.isArray(read.projects)) return null
  for (const project of read.projects) {
    if (!Array.isArray(project?.tasks)) continue
    for (const row of project.tasks) {
      const rowId = taskIdValue(row?.scope?.taskId ?? row?.task?.taskId)
      if (rowId !== id || row.scope?.kind !== 'task') continue
      return {
        kind: 'task',
        projectKey: row.scope.projectKey,
        mode: row.scope.mode,
        taskId: { scope: 'task', value: id },
      }
    }
    for (const row of project.tasks) {
      if (row.scope?.kind !== 'task' || !Array.isArray(row.task?.executions)) continue
      for (const child of row.task.executions) {
        const childId = taskIdValue(child?.taskId)
        if (childId !== id) continue
        return {
          kind: 'task',
          projectKey: row.scope.projectKey,
          mode: row.scope.mode,
          taskId: { scope: 'task', value: id },
        }
      }
    }
  }
  return null
}

export function resolveSubmittedTaskScope({ taskId, hint, systemRead, statusMode }) {
  const id = taskIdValue(taskId)
  if (!id) return null
  const exact = taskScopeFromSystemRead(systemRead, id)
  if (exact) return exact

  const key = hint?.projectKey
  const mode = hint?.mode === 'fake' || hint?.mode === 'rcc'
    ? hint.mode
    : (statusMode === 'fake' || statusMode === 'rcc' ? statusMode : undefined)
  if (key) {
    return mode
      ? { kind: 'task', projectKey: key, mode, taskId: { scope: 'task', value: id } }
      : null
  }
  return null
}

export function taskLandingHref(taskId, scope, interactionId) {
  const params = new URLSearchParams({ task: String(taskIdValue(taskId)) })
  if (scope?.kind === 'task') {
    params.set('projectKey', scope.projectKey)
    params.set('mode', scope.mode)
  } else if (scope?.kind === 'project') {
    params.set('projectKey', scope.projectKey)
  }
  if (interactionId) params.set('interaction', String(interactionId))
  return `./task.html?${params.toString()}`
}

/**
 * The confirmed new-task submission lands on the live execution dashboard. The
 * entry form submit is the single human confirmation, so the page must show the
 * real execution steps in place; it never auto-navigates to the static
 * task.html confirm page or the task dashboard. This href remains the explicit
 * "open the full task board" link inside the in-place detail layer.
 * `task.html?interaction=...` stays the existing-task-change entry for a
 * genuine confirm/clarify/abandon decision.
 */
export function submittedTaskLandingHref(taskId, scope) {
  return taskDashboardHref(taskId, scope)
}

function taskScopeUnresolved() {
  return Object.assign(new Error('任务已提交，但无法定位本次任务的确切读取范围。'), {
    code: 'entry.task-scope-unresolved',
    ownerId: 'humanagent.app.ui',
    nextAction: 'open the task from the project list so the URL carries projectKey and mode',
  })
}

/**
 * Resolve and build the confirmed task's interaction landing. The scope comes
 * from the exact project read row or the explicit entry URL; a missing scope is
 * an explicit failure, never an unscoped navigation or a new-task write.
 */
export async function resolveTaskLanding({ api, taskId, search, hash, statusMode, interactionId }) {
  const hint = entryScopeFromLocation({ search, hash })
  const hasExactScope = Boolean(hint.projectKey && hint.mode)
  const systemRead = hasExactScope ? undefined : await api.systemDashboard()
  const scope = resolveSubmittedTaskScope({ taskId, hint, systemRead, statusMode })
  if (!scope) throw taskScopeUnresolved()
  return { scope, href: taskLandingHref(taskId, scope, interactionId) }
}

export async function readEntryQueue(api) {
  const [runtimeStatus, tasks] = await Promise.all([api.status(), api.listTasks()])
  return { runtimeStatus, tasks }
}

// The runtime publishes its real execution step summaries as internal English
// phase names. The page keeps them reachable but shows a readable label so a
// Chinese surface never leaks `request to the model`-style internal copy.
const INTERNAL_STEP_LABELS = new Map([
  ['Dispatching request to the model', '正在派发模型请求'],
  ['Model request dispatched', '模型请求已派发'],
  ['Model request settled', '模型请求已收拢'],
  ['provider requested model work', '已向模型请求工作'],
  ['provider request settled', '模型请求已收束'],
  ['provider requested model work settled', '模型工作已收束'],
  ['execution started', '执行已开始'],
  ['execution succeeded', '执行成功'],
  ['execution failed', '执行失败'],
  ['execution cancelled', '执行已取消'],
  ['execution settling', '执行正在收拢'],
  ['execution retry', '执行重试'],
  ['execution terminal', '执行已结束'],
  ['checkpoint committed', '检查点已提交'],
  ['stopped checkpoint committed', '停止检查点已提交'],
  ['provider tool', '调用工具'],
  ['provider tool-result', '工具返回'],
  ['attention opened', '需要关注'],
  ['attention resolved', '关注已处理'],
])

export function localizedStepSummary(summary) {
  const text = typeof summary === 'string' ? summary.trim() : ''
  if (text === '') return ''
  const exact = INTERNAL_STEP_LABELS.get(text)
  if (exact !== undefined) return exact
  for (const [prefix, label] of INTERNAL_STEP_LABELS) {
    if (text.startsWith(`${prefix}:`)) return `${label}${text.slice(prefix.length)}`
    if (text.startsWith(`${prefix} `)) return `${label} ${text.slice(prefix.length + 1)}`
  }
  return text
}

/**
 * The live submit progress banner.
 *
 * While a submission is in flight the status region shows one live block: the
 * shell's existing progress spinner, the current real turn step, the total
 * elapsed time and the current step's elapsed time. The step label starts with
 * the page's own waiting copy; each real `explicit.step` event replaces it with
 * `步骤 <seq>` plus the runtime summary and resets the per-step timer. The
 * timers are observation-only: they start at mount and at the last real step,
 * never recompute time that elapsed before the banner was mounted. The block and
 * its timer are removed on settle.
 *
 * Nothing touches the document until the returned methods are called, so the
 * seam stays import-safe in Node.
 */
export function createSubmitStatusBanner(target, { onOpenDetail } = {}) {
  let block = null
  let phase = null
  let detail = null
  let totalTimer = null
  let stepTimer = null
  let tick = null
  let startedAt = 0
  let stepStartedAt = 0
  // Every real runtime step the page observed, in arrival order. The detail
  // layer reads this list; the page never re-derives a step from a timer.
  const steps = []

  // A monotonic clock keeps the elapsed labels stable across clock changes.
  const elapsedNow = () => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  )
  const formatElapsed = (milliseconds) => {
    const wholeSeconds = Math.max(0, Math.floor(milliseconds / 1000))
    const minutes = Math.floor(wholeSeconds / 60)
    const seconds = wholeSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  const paintTimers = () => {
    if (!totalTimer || !stepTimer) return
    const now = elapsedNow()
    totalTimer.textContent = `总耗时 ${formatElapsed(now - startedAt)}`
    stepTimer.textContent = `本步 ${formatElapsed(now - stepStartedAt)}`
  }
  const startTimer = () => {
    if (tick !== null) return
    paintTimers()
    tick = setInterval(paintTimers, 1000)
  }
  const stopTimer = () => {
    if (tick === null) return
    clearInterval(tick)
    tick = null
  }
  const mount = () => {
    steps.length = 0
    if (!block) {
      block = element('div', undefined, 'progress progress--live')
      block.dataset.tone = 'active'
      block.append(element('span', undefined, 'progress-spinner'))
      phase = element('span', undefined, 'progress-phase')
      phase.setAttribute('aria-live', 'polite')
      block.append(phase)
      detail = element('span', undefined, 'progress-detail')
      detail.setAttribute('aria-live', 'polite')
      block.append(detail)
      totalTimer = element('span', undefined, 'progress-timer')
      totalTimer.setAttribute('aria-hidden', 'true')
      block.append(totalTimer)
      stepTimer = element('span', undefined, 'progress-timer')
      stepTimer.setAttribute('aria-hidden', 'true')
      block.append(stepTimer)
      // The card opens the detail layer only on an explicit click. The whole
      // block is the affordance, so a human can inspect the real step history
      // and then close back to this same input surface.
      if (typeof onOpenDetail === 'function') {
        block.dataset.interactive = 'true'
        block.setAttribute('role', 'button')
        block.setAttribute('tabindex', '0')
        block.setAttribute('aria-label', '查看任务执行进度详情')
        const open = () => onOpenDetail(block)
        block.addEventListener('click', open)
        block.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          open()
        })
        block.append(element('span', '详情', 'progress-detail-hint'))
      }
    }
    clearNode(target)
    target.append(block)
    startedAt = elapsedNow()
    stepStartedAt = startedAt
    startTimer()
    if (typeof block.scrollIntoView === 'function' && typeof window !== 'undefined') {
      const rect = block.getBoundingClientRect()
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0
      const intersects = rect.bottom > 0 && rect.top < viewportHeight
      if (!intersects) block.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }
  const text = (copy) => {
    if (typeof copy !== 'string' || copy.trim() === '') return
    if (block && phase) {
      phase.textContent = copy
      return
    }
    target.textContent = copy
  }
  // A real `explicit.step` arrived: show its number and summary and reset the
  // per-step timer. Number and summary are the runtime's; the page adds none.
  const step = (event) => {
    if (!block || !phase) return
    const seq = event?.seq
    const summary = typeof event?.summary === 'string' ? event.summary.trim() : ''
    const humanSummary = localizedStepSummary(summary)
    if (Number.isFinite(seq)) phase.textContent = `步骤 ${seq}/${steps.length + 1}`
    if (humanSummary !== '' && detail) detail.textContent = humanSummary
    if (event && (Number.isFinite(seq) || summary !== '')) {
      steps.push({
        seq: Number.isFinite(seq) ? seq : null,
        summary: humanSummary,
        kind: typeof event.kind === 'string' ? event.kind : undefined,
        occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt : undefined,
      })
    }
    stepStartedAt = elapsedNow()
    paintTimers()
  }
  const clear = () => {
    stopTimer()
    if (!block) return
    const stale = block
    block = null
    phase = null
    detail = null
    totalTimer = null
    stepTimer = null
    if (typeof stale.remove === 'function') stale.remove()
    else if (target && typeof target.removeChild === 'function') target.removeChild(stale)
  }
  const isLive = () => block !== null
  const history = () => steps.slice()
  return { mount, text, step, clear, isLive, history }
}

// The page seams above are pure and import-safe in Node. Everything below owns
// the real DOM surface and only runs when the page is actually mounted in a
// browser, so the product consumer can exercise the seams without a document.
if (typeof document !== 'undefined') {

const pageRoot = document.querySelector('#page-root')
const interactionCardHost = document.querySelector('[data-interaction-work-card-host][data-entry="entry"]')
if (!(pageRoot instanceof HTMLElement)) throw new Error('index page requires #page-root')
if (!(interactionCardHost instanceof HTMLElement)) throw new Error('index page requires an interaction work card host')
const template = mountPageTemplate(pageRoot, {
  layout: 'work',
  active: '新建 Task',
  title: '任务输入',
})
const { status } = template.hosts
const submitBanner = createSubmitStatusBanner(status, { onOpenDetail: openSubmitProgressDetail })
let interactionCard = null
let pageLeaving = false
const submissionGate = createSubmissionGate()
// A confirmed once task hands its live execution progress to the single entry
// interface. While this handle exists the submit banner stays on the page and
// mirrors the runtime's real execution steps; otherwise it settles normally.
let liveTaskProgress = null

/**
 * Keep this attempt's user input in a page-owning history state so browser
 * Back and a reload can restore the draft without a second submission. Only the
 * declared input is kept; every other key belongs to the browser or the
 * product location and is left untouched.
 */
function retainEntryDraft() {
  if (typeof window.history !== 'object' || typeof window.history.replaceState !== 'function') return
  const form = document.querySelector('#entry-form')
  if (!(form instanceof HTMLFormElement)) return
  const controls = {
    rawInput: form.elements.namedItem('rawInput')?.value ?? '',
    execution: executionInputs(form),
  }
  const state = entryDraftState(window.history.state, controls)
  try {
    window.history.replaceState(state, '', window.location.href)
  } catch {
    // A replaceState rejection (sandboxed history) must not block the input.
  }
}

function restoreEntryDraft(form) {
  const draft = entryDraftFromState(window.history.state)
  if (!draft || !form) return
  const raw = form.elements.namedItem('rawInput')
  if (raw) raw.value = draft.rawInput
  const restored = draft.execution || {}
  for (const [name, value] of Object.entries(restored)) {
    const control = form.elements.namedItem(name)
    if (control && typeof value === 'string') control.value = value
  }
}

function disposeEntryPage(event) {
  if (!shouldDisposeEntryPage(event)) return
  if (pageLeaving) return
  pageLeaving = true
  interactionCard?.dispose()
  template.dispose()
}
window.addEventListener('pagehide', disposeEntryPage)

// The shared work card mounts on the first real event or snapshot update. Until
// then the host stays genuinely empty, so first entry claims no work.
function presentInteractionCard(projection) {
  if (pageLeaving || !interactionCardHost || !projection) return
  if (!interactionCard) interactionCard = mountInteractionWorkCard(interactionCardHost)
  interactionCard.update(projection)
}

let interactionId
let confirmation
let latestState = 'received'
let latestRuntimeStatus = null
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
  head.append(element('h2', '队列与任务状态'))
  section.append(head, element('p', '尚未提交任务。', 'empty'))
  return section
}

// A simple direct answer or status receipt is the interaction's business
// result. It is rendered as a full-width result card in the main column; the
// top status banner keeps only a short status word, so a long answer can never
// squeeze the page heading into a one-character column.
function ensureDirectAnswerRegion() {
  let host = template.hosts.primary.querySelector('#entry-direct-answer')
  if (host) return host
  host = element('section', undefined, 'section entry-direct-answer')
  host.id = 'entry-direct-answer'
  const live = template.hosts.primary.querySelector('#entry-live')
  if (live && live.parentNode) live.parentNode.insertBefore(host, live)
  else template.hosts.primary.append(host)
  return host
}

function renderDirectAnswer(result) {
  const host = ensureDirectAnswerRegion()
  clearNode(host)
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '直接回答'), element('span', '本次请求已直接回答', 'section-meta'))
  host.append(head)
  const card = element('article', undefined, 'panel')
  card.dataset.directAnswer = 'true'
  card.append(element('p', result.text, 'business-output-text'))
  host.append(card)
  const live = template.hosts.primary.querySelector('#entry-live')
  if (live) {
    clearNode(live)
    const liveHead = element('header', undefined, 'section-head')
    liveHead.append(element('h2', '队列与任务状态'), element('span', '0 项', 'section-meta'))
    live.append(liveHead, element('p', '本次请求已直接回答，未创建任务。', 'empty'))
  }
}

function renderField(section, label, value) {
  const row = element('div', undefined, 'detail-cell')
  row.append(element('dt', label), element('dd', value || '—'))
  section.append(row)
}

// The draft region exists only once a real interaction snapshot supplies
// content. It takes the place the old always-rendered container occupied.
function ensureDraftSection() {
  const existing = template.hosts.primary.querySelector('#entry-draft')
  if (existing) return existing
  const section = element('section', undefined, 'section')
  section.id = 'entry-draft'
  const live = template.hosts.primary.querySelector('#entry-live')
  if (live && live.parentNode) live.parentNode.insertBefore(section, live)
  return section
}

function setEntryError(error) {
  const panel = template.hosts.composer.querySelector('#entry-error')
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
    element('p', error.message || String(error)),
    technicalDetailTrigger(() => ({
      title: '技术详情',
      entries: [
        ['code', error?.code, 'data-detail-code'],
        ['owner', error?.ownerId, 'data-detail-owner'],
        ['nextAction', error?.nextAction, 'data-detail-next'],
      ],
    })),
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
      if (submissionGate.pending || !pendingSubmission) return
      const run = submissionGate.begin(() => executeSubmission(pendingSubmission, answer))
      if (!run.started) return
      submitting = true
      button.disabled = true
      clearEntryError()
      void run.result
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
    // The main layer keeps only the actual task identity the runtime committed.
    const grid = element('dl', undefined, 'detail-grid')
    if (typeof snapshot.revision?.title === 'string' && snapshot.revision.title.trim() !== '') {
      renderField(grid, '任务名称', snapshot.revision.title)
    }
    const taskType = taskFlowText(snapshot.revision?.taskFlow)
    if (taskType) renderField(grid, '任务类型', taskType)
    if (grid.children.length > 0) panel.append(grid)
    // The full model interpretation stays reachable in a collapsed details
    // block so it never expands over the main reading layer. Nothing is
    // truncated; the proposal text keeps the raw evidence refs it reported.
    const interpretation = element('details', undefined, 'implicit-entry')
    const summary = element('summary')
    const summaryLabel = element('span')
    summaryLabel.append(element('span', '+', 'details-glyph'), '整理详情')
    summary.append(summaryLabel, element('small', '模型整理 · 默认折叠'))
    interpretation.append(summary)
    const content = element('div', undefined, 'implicit-content')
    const factGrid = element('dl', undefined, 'diagnostic-grid')
    for (const [label, value] of [
      ['意图', snapshot.draft.proposedIntent],
      ['规范化输入', snapshot.draft.normalizedInput],
      ['已知事实', (snapshot.draft.knownFacts || []).join('\n')],
    ]) {
      const row = element('div')
      row.append(element('dt', label), element('dd', value || '—'))
      factGrid.append(row)
    }
    content.append(factGrid)
    if (snapshot.draft.proposal) {
      const note = element('div', undefined, 'implicit-note')
      note.append(element('strong', '建议'), element('p', snapshot.draft.proposal))
      content.append(note)
    }
    interpretation.append(content)
    panel.append(interpretation)
    section.append(panel)
    updateCardFromSnapshot(snapshot)
    return
  }

  // A direct answer or a status receipt has no draft to inspect; the answer is
  // the result and it is shown in the main column result card. The raw
  // interaction enum stays internal instead of being printed as page text.
  if (snapshot.state !== 'answered' && snapshot.state !== 'status-only') {
    section.append(element('p', `状态：${snapshot.state} · ${snapshot.nextAction}`, 'empty'))
  }
  updateCardFromSnapshot(snapshot)
}

function clearEntryError() {
  setEntryError(null)
}

function renderStatus(summary, rows) {
  const section = template.hosts.primary.querySelector('#entry-live')
  if (!section) return
  clearNode(section)
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '队列与任务状态'), element('span', `${rows.length} 项`, 'section-meta'))
  section.append(head)

  const stats = element('div', undefined, 'stats')
  if (summary.implicitScheduling) {
    const queue = summary.implicitScheduling
    const card = element('article', undefined, 'stat')
    const queueLabel = queue.state === 'executing' || queue.state === 'admitted'
      ? '已排入队列，正在执行'
      : queue.state === 'queued'
        ? '已排入执行队列，等待调度'
        : '队列调度就绪'
    card.append(
      element('span', '队列进度'),
      element('strong', `第 ${queue.fifoSeq} 位`),
      element('p', queueLabel, 'muted'),
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
    const currentId = row.currentExecutionTaskId && typeof row.currentExecutionTaskId === 'object'
      ? row.currentExecutionTaskId.value
      : row.currentExecutionTaskId
    const currentChild = currentId === undefined || currentId === null
      ? undefined
      : (Array.isArray(row.executions) ? row.executions : []).find((child) => {
          const childId = child.taskId && typeof child.taskId === 'object' ? child.taskId.value : child.taskId
          return childId === currentId
        })
    link.href = currentChild
      ? taskExecutionHref(currentChild, false, row.scope)
      : taskDashboardHref(row.taskId.value)
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
    const executions = renderTaskExecutions(row, row.scope)
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
  if (pageLeaving) return
  try {
    const { runtimeStatus, tasks } = await readEntryQueue(api)
    if (pageLeaving) return
    latestRuntimeStatus = runtimeStatus
    renderStatus(runtimeStatus, taskRows(tasks))
  } catch (error) {
    if (pageLeaving) return
    const panel = template.hosts.primary.querySelector('#entry-live')
    if (panel) {
      clearNode(panel)
      panel.append(
        element('p', error.message || '队列状态暂时无法刷新，请稍后重试。', 'empty'),
        technicalDetailTrigger(() => ({
          title: '技术详情',
          entries: [
            ['code', error?.code, 'data-detail-code'],
            ['owner', error?.ownerId, 'data-detail-owner'],
            ['nextAction', error?.nextAction, 'data-detail-next'],
          ],
        })),
      )
      appendPairingEntry(panel, error)
    }
  }
}

// The runtime's real execution event kinds. The entry page mirrors these to the
// submit banner's live step and never invents a step of its own.
const EXECUTION_STEP_EVENTS = [
  'execution.started',
  'provider.model',
  'provider.output',
  'provider.tool',
  'provider.tool-result',
  'provider.error',
  'execution.settling',
  'execution.retry',
  'checkpoint.committed',
  'execution.terminal',
  'attention.opened',
  'attention.resolved',
]
// Match the task dashboard's observation cadence while a confirmed task is
// admitted but has not yet published its executing operation.
const LIVE_PROGRESS_OBSERVE_MS = 750

/**
 * Subscribe to the runtime's real execution event stream for a confirmed task's
 * operation. Each event carries the runtime's own `seq` and `summary`; the page
 * only mirrors them. The stream closes itself on the final terminal event so a
 * finished task does not reconnect.
 */
function subscribeExecutionStepStream(operationId, onEvent) {
  if (!operationId || typeof EventSource === 'undefined') return () => {}
  let stream
  try {
    stream = new EventSource(api.eventsUrl(operationId))
  } catch {
    return () => {}
  }
  let closed = false
  const stop = () => {
    if (closed) return
    closed = true
    try { stream.close() } catch {}
  }
  for (const kind of EXECUTION_STEP_EVENTS) {
    stream.addEventListener(kind, (message) => {
      if (closed) return
      let payload
      try {
        payload = JSON.parse(message.data || '{}')
      } catch {
        payload = {}
      }
      const event = {
        ...payload,
        kind: typeof payload.kind === 'string' ? payload.kind : kind,
        seq: Number.isSafeInteger(payload.seq) ? payload.seq : undefined,
      }
      onEvent(event)
      if (kind === 'execution.terminal' && payload.terminalPhase === 'final') stop()
    })
  }
  return stop
}

function stopLiveTaskProgress() {
  if (!liveTaskProgress) return
  try { liveTaskProgress.stop() } catch {}
  liveTaskProgress = null
}

// The progress card's next layer. It reports only the task identity, the
// runtime state the dashboard read returned, and the real steps the page
// mirrored from the execution stream. Closing it returns to this same entry.
function openSubmitProgressDetail(trigger) {
  const progress = liveTaskProgress
  const content = element('div', undefined, 'stack progress-detail-body')
  if (!progress) {
    content.append(element('p', '任务尚未进入执行进度。', 'empty'))
  } else {
    const facts = element('dl', undefined, 'draft-receipt')
    const addFact = (label, value) => {
      const row = element('div')
      row.append(element('dt', label), element('dd', value || '未提供'))
      facts.append(row)
    }
    addFact('任务', progress.taskId)
    addFact('状态', progress.dashboard?.stateLabel || progress.dashboard?.state)
    addFact('执行来源', progress.operationId)
    content.append(facts)
    const steps = submitBanner.history()
    if (steps.length === 0) {
      content.append(element('p', '等待运行时返回执行步骤…', 'empty'))
    } else {
      const list = element('ol', undefined, 'progress-step-list')
      for (const step of steps) {
        const item = element('li', undefined, 'progress-step')
        item.append(
          element('span', Number.isFinite(step.seq) ? `步骤 ${step.seq}` : '步骤', 'progress-step-seq'),
          element('span', step.summary || step.kind || '执行事件', 'progress-step-summary'),
        )
        if (step.occurredAt) item.append(element('time', formatTime(step.occurredAt), 'progress-step-time'))
        list.append(item)
      }
      content.append(list)
    }
    const link = element('a', '打开完整任务看板', 'button button--sm')
    link.href = submittedTaskLandingHref(progress.taskId, progress.scope)
    content.append(link)
  }
  openTechnicalDetail({ title: '任务执行进度', eyebrow: '实时进度', content, trigger })
}

/**
 * Keep a confirmed new-task submission on the single entry interface. Refresh
 * the committed task row in place, read the task's real dashboard to discover
 * its executing operation, then mirror the operation's real execution event
 * stream into the live submit banner. No navigation, no second confirmation,
 * and no fabricated step: a missing dashboard read stays an explicit failure.
 */
async function startLiveTaskProgress({ taskId, scope }) {
  stopLiveTaskProgress()
  const taskIdValue = taskId && typeof taskId === 'object' ? taskId.value : taskId
  const readDashboardFor = (idValue) => api.scopedTaskDashboard({
    projectKey: scope.projectKey,
    mode: scope.mode,
    taskId: { scope: 'task', value: idValue },
  })
  // A committed new task is a queued parent whose real execution runs on its
  // current execution child, the task that actually carries the operation. Read
  // the parent's own dashboard first; when it has no operation yet, follow the
  // child the runtime grouped under this row so the live card mirrors the real
  // steps instead of waiting on an operation the parent never receives.
  const resolveExecutingDashboard = async () => {
    const own = await readDashboardFor(taskIdValue)
    if (own?.operationId) return own
    try {
      const row = taskRows(await api.listTasks())
        .find((candidate) => candidate.taskId?.value === taskIdValue)
      const rawChild = row?.currentExecutionTaskId
      const childId = rawChild && typeof rawChild === 'object' ? rawChild.value : rawChild
      if (childId && childId !== taskIdValue) {
        const child = await readDashboardFor(childId)
        if (child?.operationId) return child
      }
    } catch {
      // A task-list read failure must not hide the parent's own dashboard state.
    }
    return own
  }
  const dashboard = await resolveExecutingDashboard()
  if (pageLeaving) return
  const progress = {
    taskId: taskIdValue,
    scope,
    operationId: dashboard?.operationId,
    dashboard,
    stop: () => {},
  }
  liveTaskProgress = progress
  // A clarification loop re-enters submission without the original mount, so
  // the live card must be (re)mounted here before its step history is used.
  if (!submitBanner.isLive()) submitBanner.mount()
  submitBanner.text('任务已提交，正在执行…')
  let streamStop = () => {}
  let observeTimer = null
  progress.stop = () => {
    if (observeTimer !== null) clearTimeout(observeTimer)
    observeTimer = null
    streamStop()
  }
  function observeDashboard() {
    if (observeTimer !== null) return
    observeTimer = setTimeout(async () => {
      observeTimer = null
      if (pageLeaving || liveTaskProgress !== progress) return
      try {
        const next = await resolveExecutingDashboard()
        if (pageLeaving || liveTaskProgress !== progress) return
        status.dataset.tone = 'success'
        connect(next)
      } catch {
        if (pageLeaving || liveTaskProgress !== progress) return
        status.dataset.tone = 'danger'
        submitBanner.text('任务进度暂时不可读，正在重试…')
        observeDashboard()
      }
    }, LIVE_PROGRESS_OBSERVE_MS)
  }
  function connect(nextDashboard) {
    if (pageLeaving || liveTaskProgress !== progress) return
    progress.dashboard = nextDashboard
    progress.operationId = nextDashboard?.operationId
    if (progress.operationId) {
      submitBanner.text('任务已提交，正在执行…')
      streamStop = subscribeExecutionStepStream(progress.operationId, (event) => {
        if (pageLeaving || liveTaskProgress !== progress) return
        submitBanner.step({
          seq: event.seq,
          summary: event.summary,
          kind: event.kind,
          occurredAt: event.occurredAt,
        })
        if (event.kind === 'execution.terminal') {
          status.dataset.tone = ['failed', 'blocked', 'cancelled'].includes(event.status)
            ? 'danger'
            : 'success'
        }
      })
      return
    }
    if (!['created', 'admitted', 'running', 'settling'].includes(nextDashboard?.state)) {
      submitBanner.text(nextDashboard?.stateLabel || nextDashboard?.state || '任务状态已更新')
      return
    }
    submitBanner.text('任务已提交，等待调度…')
    observeDashboard()
  }
  connect(dashboard)
}

/**
 * Move a confirmed new-task submission into the live execution main line. It
 * resolves the exact task scope and leaves the human on the single entry
 * interface so the live progress card shows the real execution steps. A read
 * that cannot find the scope stays an explicit landing failure; it never falls
 * back to an unscoped task read or a second create.
 */
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
  if (pageLeaving) return
  if (!taskIdValue) {
    await refreshQueue()
    if (lookupError) throw lookupError
    throw taskLandingUnresolved('entry.task-not-ready', '任务已提交，但任务列表尚未返回本次任务。')
  }
  try {
    const landing = await resolveTaskLanding({
      api,
      taskId: taskIdValue,
      search: window.location.search,
      hash: window.location.hash,
      statusMode: latestRuntimeStatus?.mode,
      interactionId,
    })
    if (pageLeaving) return
    // Refresh the committed task row in place so the entry list reflects the
    // new task before the live progress card carries its real steps.
    await refreshQueue()
    if (pageLeaving) return
    await startLiveTaskProgress({ taskId: taskIdValue, scope: landing.scope })
  } catch (error) {
    if (lookupError) throw lookupError
    throw error
  }
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
    if (pageLeaving) return undefined
    const tasks = await api.listTasks()
    if (pageLeaving) return undefined
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
 * Subscribe to the runtime's explicit-intake step stream while the brain is
 * still organizing the input. The page only mirrors the runtime's real steps —
 * their `seq` and `summary` — and never mints steps or a second confirmation.
 * The server emits these frames as the SSE event `explicit.step`
 * (server.ts:2460-2474). In a non-browser (or non-SSE) environment the call
 * degrades to a no-op so tests and server slices stay side-effect free.
 */
function subscribeExplicitStepStream(activeId) {
  if (!activeId || typeof EventSource === 'undefined') return () => {}
  let stream
  try {
    stream = new EventSource(`/api/explicit/interactions/${encodeURIComponent(activeId)}/events`)
  } catch {
    return () => {}
  }
  stream.addEventListener('explicit.step', (event) => {
    try {
      const payload = JSON.parse(event.data || '{}')
      const step = payload?.step ?? payload
      if (step && typeof step.summary === 'string' && step.summary.trim() !== '') {
        appendCardEvent('status', step.summary, 'progress', {
          eventKey: step.kind || 'explicit.step',
          interactionId: activeId,
        })
        status.dataset.tone = 'warning'
        // Show the real step number and summary in the live banner and reset
        // its per-step timer; the progress block survives each step update.
        submitBanner.step({ seq: step.seq, summary: step.summary })
      }
    } catch {
      // Ignore malformed step event payloads
    }
  })
  return () => {
    try { stream.close() } catch {}
  }
}

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
    appendCardEvent('user', submission.rawInput, 'user', {
      eventKey: 'explicit.raw-input',
      interactionId,
      ...(typeof received.occurredAt === 'string' && received.occurredAt.trim() !== ''
        ? { occurredAt: received.occurredAt }
        : {}),
    })
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
    const stopStepStream = subscribeExplicitStepStream(interactionId)
    try {
      snapshot = await api.interpretExplicitInput(interactionId)
    } finally {
      stopStepStream()
    }
  }
  latestState = snapshot.state
  renderDraft(snapshot)
  if (snapshot.state === 'awaiting-clarification') return snapshot
  // A simple answer and a status receipt are both the interaction's business
  // result. They end this submission: the reply is shown in the main status
  // result card, and no draft, requirement or task is created.
  const directResult = answeredSubmissionPresentation(snapshot)
  if (directResult) {
    status.dataset.tone = directResult.tone
    status.textContent = '本次请求已直接回答'
    renderDirectAnswer(directResult)
    return snapshot
  }
  if (snapshot.state === 'confirmed') {
    // The backend snapshot already proves the business confirmation. Keep that
    // fact so a later task-refresh failure still reports the accepted
    // demand instead of downgrading to an unfinished input.
    confirmation = snapshot.confirmation || confirmation || snapshot
    status.dataset.tone = 'success'
    submitBanner.text('需求已接收，正在刷新任务进展…')
    await landOnSubmittedTask(identityFromConfirmedSnapshot(snapshot))
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
  submitBanner.text('需求已提交，正在刷新任务进展…')
  await landOnSubmittedTask(identityFromReceipt(receipt.requirement))
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
  head.append(element('h2', '用户任务'), element('span', '一次提交即确认本次新任务', 'section-meta'))
  section.append(head)

  const panel = element('div', undefined, 'panel')
  const form = element('form', undefined, 'form-grid')
  form.id = 'entry-form'
  const textarea = element('textarea')
  textarea.name = 'rawInput'
  textarea.required = true
  textarea.placeholder = '描述要处理的一个新任务'
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
  restoreEntryDraft(form)
  syncExecutionFields()
  form.addEventListener('input', retainEntryDraft)

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
    if (submissionGate.pending) return
    const rawInput = textarea.value.trim()
    if (!rawInput) {
      setEntryError(Object.assign(new Error('请先填写任务输入。'), {
        code: 'request.invalid-field',
        ownerId: 'humanagent.app.ui',
        nextAction: 'provide the task input',
      }))
      return
    }
    const run = submissionGate.begin(async () => {
      const selection = selectionInputs(rawInput, form)
      if (!pendingSubmission || !selectionsEqual(pendingSubmission.selection, selection)) {
        pendingSubmission = await prepareSubmission(rawInput, form)
      }
      retainEntryDraft()
      await executeSubmission(pendingSubmission)
    })
    if (!run.started) return
    submitting = true
    submitButton.disabled = true
    textarea.readOnly = true
    clearEntryError()
    status.dataset.tone = 'warning'
    submitBanner.mount()
    submitBanner.text('正在整理并提交任务…')
    void run.result.catch((error) => handleSubmissionError(error, submitButton)).finally(() => {
      submitting = false
      submitButton.disabled = false
      // A confirmed once task keeps the live progress card after this settle;
      // every other result (error, answer, saved plan) removes it normally.
      if (!liveTaskProgress) submitBanner.clear()
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
  if (pageLeaving) return
  renderRuntimeStatus(status, runtimeStatus, error, {
    extraEntries: [
      ['界面', 'Explicit Input'],
      ['区块', 'Runtime'],
    ],
  })
  template.hosts.primary.append(interactionCardHost, liveArea())
  template.hosts.composer.append(renderForm())
  await refreshQueue()
}

void load().catch((error) => {
  if (!pageLeaving) renderPageError(status, error)
})

}
