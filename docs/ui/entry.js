import {
  appendPairingEntry,
  bindDrawerLightDismiss,
  clearNode,
  element,
  formatTime,
  loadRuntimeStatus,
  mountPageTemplate,
  openTechnicalDetail,
  renderPageError,
  renderRuntimeStatus,
  taskFlowText,
  taskDashboardHref,
  technicalDetailTrigger,
} from './runtime-shell.js'
import { mountInteractionWorkCard } from './interaction-work-card.js'
import { renderMainTopic, disposeMainTopic, updateMainTopicUsage, mainTopicTurnGroups } from './main-topic.js'
import { renderMainTopicHistoryDetail } from './main-topic-history-detail.js'
import { createRuntimeApi, createSessionUsageReader } from './runtime-api.js'
import { renderTurnProgressDetail } from './turn-progress-detail.js'
import {
  projectInteractionCardFromEntries,
  projectInteractionCardFromSnapshot,
} from './interaction-card-page.js'
import { locationFromHash } from './product-location.js'
import { entryConversationScope, entryWorkspaceSelection, entryProjectHref, mountEntryWorkspace } from './entry-workspace.js'
import { submissionView, intakeFinished, draftReviewFromSnapshot, canContinueSubmission } from './send-lifecycle.js'
import { applyTaskCardResult, createDispatchTracking, taskValue } from './dispatch-tracking.js'
import { createTaskDecisionPrompt, decisionMatchesTaskScope } from './product-control-view.js'

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

// The final displayed turn owns the footer. An interactionId is the
// explicit intake owner's actual session selector, including before a Task exists.
export function mainTopicUsageScope(projection) {
  if (!projection?.projectKey || !['fake', 'rcc'].includes(projection.mode)) return null
  const { history, activeTurns } = mainTopicTurnGroups(projection)
  const turn = activeTurns.at(-1) ?? history.at(-1)?.turns.at(-1)
  if (!turn) return null
  const scope = { projectKey: projection.projectKey, mode: projection.mode }
  if (turn.taskId?.value) return { ...scope, taskId: turn.taskId.value }
  if (turn.interactionId) return { ...scope, sessionId: turn.interactionId }
  return null
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

import {
  localizedStepPhase,
  localizedStepSummary,
  sanitizeUserVisibleText,
} from './step-labels.js'

export { localizedStepPhase, localizedStepSummary, sanitizeUserVisibleText } from './step-labels.js'

/**
 * The live submit progress banner.
 *
 * While a submission is in flight the status region shows one live block: the
 * shell's existing progress spinner, the current semantic execution phase, the
 * total elapsed time and the current phase's elapsed time. The phase label
 * starts with the page's own waiting copy; each real runtime event replaces it
 * with a user-facing Chinese phase and resets the per-step timer. The timers are
 * observation-only: they start at mount and at the last real event, never
 * recompute time that elapsed before the banner was mounted. The block and its
 * timer are removed on settle.
 *
 * Nothing touches the document until the returned methods are called, so the
 * seam stays import-safe in Node.
 */
// A live card reports semantic execution steps, not transport frames. Even an
// unusually long task must keep a bounded, readable step list (bug 486ddd4).
const MAX_LIVE_STEPS = 50

export function createSubmitStatusBanner(target, { onOpenDetail, clock = true } = {}) {
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
    if (!clock) return
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
  // A real runtime step arrived: show its semantic phase and readable summary,
  // then reset the per-step timer.
  const step = (event) => {
    if (!block || !phase) return
    const kind = typeof event?.kind === 'string' ? event.kind : undefined
    const seq = event?.seq
    const summary = typeof event?.summary === 'string' ? event.summary.trim() : ''
    // Token deltas are model output content, not user-facing steps. Counting
    // them inflated one real task from 2 steps to 515 (bug 486ddd4).
    if (kind === 'provider.output') {
      stepStartedAt = elapsedNow()
      paintTimers()
      return
    }
    const humanSummary = localizedStepSummary(summary)
    const previous = steps.length > 0 ? steps[steps.length - 1] : undefined
    const repeatsPrevious = previous !== undefined
      && previous.summary === humanSummary
      && previous.kind === kind
    const ordinal = repeatsPrevious
      ? previous.ordinal
      : Math.min(steps.length + 1, MAX_LIVE_STEPS)
    if (Number.isFinite(seq) || summary !== '') {
      phase.textContent = localizedStepPhase({ kind, state: event?.state, summary })
    }
    if (humanSummary !== '' && detail) {
      detail.textContent = sanitizeUserVisibleText(humanSummary)
    }
    if (event && (Number.isFinite(seq) || summary !== '')) {
      const entry = {
        ordinal,
        seq: Number.isFinite(seq) ? seq : null,
        summary: sanitizeUserVisibleText(humanSummary),
        kind,
        state: typeof event.state === 'string' ? event.state : undefined,
        occurredAt: typeof event.occurredAt === 'string' ? event.occurredAt : undefined,
      }
      if (steps.length > 0 && (repeatsPrevious || steps.length >= MAX_LIVE_STEPS)) {
        steps[steps.length - 1] = entry
      } else {
        steps.push(entry)
      }
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

export function mergeLiveExplicitToolEvents(recorded = [], live = []) {
  const merged = new Map()
  for (const event of [...live, ...recorded]) {
    const key = JSON.stringify([event.kind, event.taskId?.scope, event.taskId?.value,
      event.operationId, event.executionEpoch, event.turnId, event.requestId, event.callId])
    merged.set(key, event)
  }
  return [...merged.values()].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
}

export function liveToolEvent(step, interactionId) {
  if (step.kind !== 'tool.started' && step.kind !== 'tool.finished') return undefined
  if (step.tool?.kind === 'select-skills' || step.tool?.kind === 'submit-turn') return undefined
  const toolId = step.tool?.kind ? `humanagent.internal.${step.tool.kind}` : undefined
  if (!toolId || !step.tool?.callId) return undefined
  return {
    eventId: `explicit-step-${step.seq}`,
    kind: step.kind === 'tool.started' ? 'provider.tool' : 'provider.tool-result',
    seq: step.seq,
    occurredAt: step.occurredAt,
    callId: step.tool.callId,
    turnId: step.turnId,
    requestId: step.requestId,
    taskId: step.taskId ?? { scope: 'interaction', value: interactionId },
    operationId: step.requestId,
    executionEpoch: 1,
    toolId,
    toolClass: 'internal-helper',
    arguments: step.tool.detail,
    ...(step.kind === 'tool.finished' ? { status: step.tool.status, error: step.tool.errorCode ? {
      code: step.tool.errorCode, message: step.tool.errorCode,
    } : undefined } : {}),
  }
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
const conversationScope = entryConversationScope(window.location.search)
const api = createRuntimeApi({
  ...(conversationScope === null ? {} : { conversationScope }),
})
const workspaceShell = mountEntryWorkspace({ root: pageRoot, template, api })
let pageLeaving = false
const mainTopicHost = element('div', undefined, 'main-topic-host')
let latestMainTopic = null
let mainTopicPoll = null
let mainTopicRefreshing = null
let mainTopicRefreshQueued = false
let mainTopicUsageForce = false
const submissionAttempts = []
let mainTopicReadFailures = 0
const pendingDrafts = new Map()
const liveExplicitToolEvents = new Map()
const explicitStepStops = new Map()
const executionStepStops = new Map()
const dispatchTracking = createDispatchTracking({ api, openDetail: openTechnicalDetail,
  scope: () => latestMainTopic,
  onChange: () => { if (!pageLeaving) paintSubmission() },
})
function syncComposerIdentity(projection) {
  const agentName = typeof projection?.agentName === 'string' && projection.agentName.trim()
    ? projection.agentName.trim()
    : '助手'
  const heading = template.hosts.composer.querySelector('.entry-composer-heading')
  if (heading) heading.textContent = `继续和 ${agentName} 对话`
  const submitButton = template.hosts.composer.querySelector('#entry-form button[type="submit"]')
  const mode = template.hosts.composer.querySelector('#entry-form select[name="executionMode"]')
  if (submitButton && mode) {
    submitButton.setAttribute('aria-label', mode.value === 'once' ? `发送给 ${agentName}` : '保存执行计划')
  }
}
function paintSubmission() {
  if (pageLeaving || (!latestMainTopic && submissionAttempts.length === 0)) return
  const projection = latestMainTopic || { turns: [] }
  const attempts = submissionAttempts.filter(attempt => attempt !== undefined).map(attempt => {
    const live = attempt.interactionId && liveExplicitToolEvents.get(attempt.interactionId)
    return live?.length
      ? { ...attempt, toolEvents: mergeLiveExplicitToolEvents(attempt.toolEvents, live) }
      : attempt
  })
  const turns = (projection.turns || []).map(turn => {
    const decorated = turn.kind === 'draft' && pendingDrafts.has(turn.interactionId)
      ? { ...turn, draftReview: pendingDrafts.get(turn.interactionId) } : turn
    const receiptOwnsExplicitSteps = submissionAttempts.some(attempt => attempt.interactionId === turn.interactionId)
    const failure = decorated.kind === 'draft' && !decorated.taskId && attempts.find(attempt =>
      attempt.interactionId === decorated.interactionId && attempt.error)?.error
    return {
      ...decorated,
      ...(receiptOwnsExplicitSteps ? { explicitSteps: [] } : {}),
      ...(failure ? { dispatchError: failure } : {}),
    }
  })
  renderMainTopic(mainTopicHost, submissionView({ ...projection, turns }, attempts), {
    onOpenDecision: (request) => openEntryDecision(request),
    onOpenDetail: (trigger, turn) => openMainTopicProgressDetail(trigger, turn, latestMainTopic),
    onOpenHistoryDetail: openMainTopicHistoryDetail,
    onOpenDispatch: dispatchTracking.open,
    dispatchObservation: dispatchTracking.observation,
    dispatchExecutionObserved: dispatchTracking.executionObserved,
    readToolOutput: api.readToolOutput,
  })
}

function acceptSubmission(id, attempt) {
  if (!attempt || !id) return
  attempt.interactionId = id
  attempt.error = undefined
  const form = document.querySelector('#entry-form')
  const submitButton = form?.querySelector('button[type="submit"]')
  if (submitButton) submitButton.disabled = false
  // Persist only the receipt identity for read-only reload recovery, never a
  // local phase start. A reload must obtain phase times from runtime facts.
  const receipt = {
    interactionId: id,
    rawInput: attempt.rawInput,
    key: attempt.key,
    ...(attempt.submission === undefined ? {} : { submission: attempt.submission }),
  }
  const previous = Array.isArray(window.history.state?.entryReceipts)
    ? window.history.state.entryReceipts : []
  const entryReceipts = [...previous.filter(item => item?.interactionId !== id), receipt]
  window.history.replaceState({
    ...window.history.state,
    // Keep the existing field for older reopened pages. The array lets one
    // browser history item recover several independently accepted inputs.
    entryReceipt: receipt,
    entryReceipts,
  }, '', window.location.href)
  const input = document.querySelector('#entry-form textarea[name=rawInput]')
  if (input?.value === attempt.rawDraft) { input.value = ''; retainEntryDraft() }
  paintSubmission()
}

async function recoverSubmission(attempt) {
  if (!attempt) return
  if (attempt?.interactionId) {
    await refreshMainTopic()
    return
  }
  if (!attempt?.error) return
  const form = document.querySelector('#entry-form')
  const input = form?.elements.namedItem('rawInput')
  // Recovery belongs to the failed item. Restore its text only when the user
  // has not already started a newer draft, then unlock the ordinary form.
  const recoveredAttempt = attempt
  if (input && input.value.trim() === '') {
    input.value = attempt.rawDraft || attempt.rawInput
    retainEntryDraft()
  }
  recoveredAttempt.error = undefined
  recoveredAttempt.processError = undefined
  recoveredAttempt.running = false
  recoveredAttempt.submitting = false
  clearEntryError()
  paintSubmission()
  const button = form?.querySelector('button[type="submit"]')
  if (button) {
    button.textContent = '↑'
    button.setAttribute('aria-label', form.elements.namedItem('executionMode').value === 'once'
      ? `发送给 ${latestMainTopic?.agentName || '助手'}` : '保存执行计划')
  }
  input?.focus()
  void runAttempt(recoveredAttempt)
}

async function continueSubmission(attempt) {
  // A refreshed C07 interaction keeps its public interaction and partialRef;
  // the page-local pendingSubmission may be gone and must not be required for
  // resuming that exact turn.
  const resumableSnapshot = attempt?.interactionId && attempt?.snapshot?.state === 'partial'
    && typeof attempt.snapshot.partial?.partialRef === 'string'
    && attempt.snapshot.partial.partialRef !== ''
  if (!attempt || attempt.submitting || (!attempt.submission && !resumableSnapshot)
    || !attempt.interactionId || !canContinueSubmission(attempt.snapshot, attempt.processError)) return
  if (!attempt.submission) {
    const form = document.querySelector('#entry-form')
    if (!(form instanceof HTMLFormElement)) return
    attempt.submission = prepareSubmission(attempt.rawInput, form)
  }
  attempt.error = undefined
  attempt.processError = undefined
  paintSubmission()
  void runAttempt(attempt)
}
const mainTopicUsage = createSessionUsageReader({ api,
  onChange: ({ usage, ...options }) => updateMainTopicUsage(mainTopicHost, usage, options),
})
const decisionNotice = element('aside', undefined, 'status-banner task-decision-notice')
decisionNotice.hidden = true
decisionNotice.dataset.tone = 'warning'
const entryDecisionPrompt = createTaskDecisionPrompt({ api, host: template.hosts.page, onReceipt: () => void refreshMainTopic() })
let visibleDecisions = []
let selectedDecisionKey
let decisionRead
function clearEntryDecision() {
  visibleDecisions = []
  selectedDecisionKey = undefined
  decisionNotice.hidden = true
  entryDecisionPrompt.dismiss()
}
function currentEntryQuestions(projection) {
  const questions = new Map()
  for (const turn of projection.turns ?? []) {
    const taskId = taskValue(turn.taskId)
    if (!taskId || !turn.requestId) continue
    if (turn.kind === 'input-request') questions.set(taskId, turn)
    else if (turn.role === 'user' && turn.turnId.startsWith('input-answer:')) {
      const question = questions.get(taskId)
      if (question?.requestId === turn.requestId && question.expectedRevision === turn.expectedRevision) questions.delete(taskId)
    }
  }
  const pending = projection.openInputRequest
  if (pending) questions.set(taskValue(pending.taskId), pending)
  return questions
}
function openEntryDecision(request) {
  const item = typeof request === 'string'
    ? visibleDecisions.find(item => item.key === request)
    : visibleDecisions.find(({ decision, scope }) => taskValue(request?.taskId) === scope.taskId
      && request.requestId === decision.request?.requestId && request.expectedRevision === decision.request?.expectedRevision)
  if (!item) return
  const { key, decision, scope, title } = item
  const question = currentEntryQuestions(latestMainTopic).get(scope.taskId)
  if (question && (decision.request?.requestId !== question.requestId
    || decision.request?.expectedRevision !== question.expectedRevision)) return
  selectedDecisionKey = key
  entryDecisionPrompt.sync(decision, scope, title, { reopen: true, recipient: latestMainTopic.agentName, project: latestMainTopic.projectName })
}
function waitingDecisionTasks(projection) {
  const pendingId = taskValue(projection.openInputRequest?.taskId)
  const waitingIds = (projection.tasks ?? []).filter(task => task.state === 'waiting').map(task => taskValue(task.taskId))
  return [...new Set([pendingId, ...waitingIds].filter(Boolean))]
}

function refreshEntryDecision(projection) {
  const { projectKey, mode } = projection
  const taskIds = waitingDecisionTasks(projection)
  if (!projectKey || !mode || taskIds.length === 0) {
    clearEntryDecision()
    return
  }
  if (decisionRead) return
  decisionRead = Promise.allSettled(taskIds.map(taskId => api.readProductDecision({ projectKey, mode, taskId }))).then(results => {
    const current = latestMainTopic
    if (pageLeaving || current?.projectKey !== projectKey || current.mode !== mode) return
    const waitingNow = new Set(waitingDecisionTasks(current))
    const questions = currentEntryQuestions(current)
    const items = results.flatMap((result, index) => {
      const decision = result.status === 'fulfilled' ? result.value : null
      const taskId = taskIds[index]
      const scope = { projectKey, mode, taskId }
      if (!waitingNow.has(taskId) || decision?.state !== 'waiting' || !decisionMatchesTaskScope(decision, scope)
        || !['task-input-request', 'task-grant'].includes(decision.kind)) return []
      const pending = questions.get(taskId)
      if (pending && (decision.kind !== 'task-input-request'
        || decision.request?.requestId !== pending.requestId || decision.request?.expectedRevision !== pending.expectedRevision)) return []
      const title = current.tasks?.find(task => taskValue(task.taskId) === taskId)?.title
      const label = decision.kind === 'task-grant' ? '等待授权' : '等待你的回答'
      const key = JSON.stringify([scope, decision.target.taskRef.value, decision.kind, title, decision.question,
        decision.request?.requestId, decision.request?.expectedRevision])
      return [{ key, decision, scope, title, label }]
    })
    if (!items.length) {
      clearEntryDecision()
      const failure = results.find((result, index) => result.status === 'rejected' && waitingNow.has(taskIds[index]))?.reason
      if (failure) {
        decisionNotice.replaceChildren(element('p', `暂时无法读取待回复事项${failure.code ? `（${failure.code}）` : ''}`))
        decisionNotice.hidden = false
      }
      return
    }
    if (items.map(item => item.key).join() !== visibleDecisions.map(item => item.key).join()) {
      decisionNotice.replaceChildren(...items.map(({ key, title, label }) => {
        const row = element('div')
        const button = element('button', '处理待回复事项', 'button')
        button.type = 'button'
        button.addEventListener('click', () => openEntryDecision(key))
        row.append(element('strong', title ? `${title} · ${label}` : label), button)
        return row
      }))
    }
    visibleDecisions = items
    const { key, decision, scope, title } = items.find(item => item.key === selectedDecisionKey) ?? items[0]
    selectedDecisionKey = key
    decisionNotice.hidden = false
    entryDecisionPrompt.sync(decision, scope, title, { recipient: current.agentName, project: current.projectName })
  }).finally(() => { decisionRead = undefined })
}
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
  const focused = document.activeElement
  if (focused?.name && form.contains(focused)) state.entryFocus = {
    name: focused.name, start: focused.selectionStart, end: focused.selectionEnd,
  }
  try {
    window.history.replaceState(state, '', window.location.href)
  } catch {
    // A replaceState rejection (sandboxed history) must not block the input.
  }
}

window.addEventListener('pagehide', () => {
  retainEntryDraft()
  const control = document.activeElement
  if (control?.name && control.closest('#entry-form')) {
    window.history.replaceState({ ...window.history.state, entryFocus: {
      name: control.name, start: control.selectionStart, end: control.selectionEnd,
    } }, '', window.location.href)
  }
})

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
  workspaceShell.dispose()
  dispatchTracking.dispose()
  mainTopicUsage.clear()
  entryDecisionPrompt.dismiss()
  disposeMainTopic(mainTopicHost)
  for (const stop of explicitStepStops.values()) stop()
  explicitStepStops.clear()
  for (const stop of executionStepStops.values()) stop()
  executionStepStops.clear()
  if (mainTopicPoll !== null) clearTimeout(mainTopicPoll)
  mainTopicPoll = null
  template.dispose()
}
window.addEventListener('pagehide', disposeEntryPage)

function scheduleMainTopicPoll(projection) {
  if (mainTopicPoll !== null) clearTimeout(mainTopicPoll)
  mainTopicPoll = null
  if (pageLeaving || (submissionAttempts.length === 0 && !projection?.activeTask && !projection?.tasks?.some(task => !['succeeded', 'completed', 'failed', 'blocked', 'stopped', 'cancelled'].includes(task.state)) && !projection?.turns?.some((turn) =>
    turn.statusFacts?.steps !== undefined && ['received', 'matching'].includes(turn.statusFacts.state)))) return
  mainTopicPoll = setTimeout(() => {
    mainTopicPoll = null
    void refreshMainTopic()
  }, Math.min(1500 * 2 ** mainTopicReadFailures, 15000))
}

async function refreshMainTopic({ forceUsage = false } = {}) {
  if (pageLeaving) return undefined
  if (!conversationScope) {
    clearEntryDecision()
    const selection = workspaceShell.update(null)
    mainTopicHost.replaceChildren(element('h2', selection.label), element('p', selection.reason))
    template.hosts.composer.hidden = true
    return undefined
  }
  mainTopicUsageForce ||= forceUsage
  if (mainTopicRefreshing !== null) {
    mainTopicRefreshQueued = true
    return mainTopicRefreshing
  }
  mainTopicRefreshing = (async () => {
    try {
      const projection = await api.readMainTopic()
      if (pageLeaving) return projection
      latestMainTopic = projection
      dispatchTracking.sync(projection.tasks || [], projection.turns || [])
      const receipts = [
        ...(Array.isArray(window.history.state?.entryReceipts) ? window.history.state.entryReceipts : []),
        window.history.state?.entryReceipt,
      ].filter(receipt => receipt?.interactionId)
      for (const receipt of receipts) {
        if (submissionAttempts.some(attempt => attempt.interactionId === receipt.interactionId)) continue
        const restored = attemptRecord(receipt.rawInput || '', receipt.submission, receipt.key || receipt.interactionId)
        restored.interactionId = receipt.interactionId
        submissionAttempts.push(restored)
      }
      // Recover every unresolved user turn, not only the latest one. A prior
      // waiting question or running request cannot hide a later accepted input
      // after a reload.
      for (const [index, user] of (projection.turns || []).entries()) {
        if (user.role !== 'user') continue
        const id = user.interactionId || (user.turnId.startsWith('user:') ? user.turnId.slice(5) : undefined)
        if (!id) continue
        const settled = projection.turns.slice(index + 1).some(turn =>
          (turn.interactionId === id || turn.turnId === `user:${id}`)
          && ['message', 'result', 'error', 'draft', 'clarification'].includes(turn.kind))
        if (!settled && !submissionAttempts.some(attempt => attempt.interactionId === id)) {
          const restored = attemptRecord(user.text || '', undefined, id)
          restored.interactionId = id
          submissionAttempts.push(restored)
        }
      }
      // Each receipt owns its read. One failed or waiting interaction does not
      // overwrite or delay another input's status.
      await Promise.all(submissionAttempts.filter(attempt => attempt.interactionId && !attempt.submitting).map(async attempt => {
        try {
          attempt.snapshot = await api.inspectExplicitInteraction(attempt.interactionId)
          const draft = draftReviewFromSnapshot(attempt.snapshot)
          if (draft) pendingDrafts.set(attempt.interactionId, draft)
          else pendingDrafts.delete(attempt.interactionId)
          const finished = intakeFinished.has(attempt.snapshot.state) && !canContinueSubmission(attempt.snapshot)
          attempt.error = finished ? undefined : attempt.processError
          if (!finished && !explicitStepStops.has(attempt.interactionId)) subscribeExplicitStepStream(attempt)
        } catch (error) {
          attempt.error = error
          mainTopicReadFailures++
        }
      }))
      if (!submissionAttempts.some(attempt => attempt.error)) mainTopicReadFailures = 0
      const selection = workspaceShell.update(projection)
      if (!selection.available) {
        clearEntryDecision()
        mainTopicUsage.clear()
        disposeMainTopic(mainTopicHost)
        mainTopicHost.replaceChildren(element('h2', selection.label), element('p', selection.reason))
        template.hosts.composer.hidden = true
        return projection
      }
      template.hosts.composer.hidden = false
      syncComposerIdentity(projection)
      refreshEntryDecision(projection)
      paintSubmission()
      if (submissionAttempts.length > 0 && submissionAttempts.every(attempt =>
        intakeFinished.has(attempt.snapshot?.state) && attempt.snapshot?.state !== 'partial')) {
        const { entryReceipt, entryReceipts: _entryReceipts, ...rest } = window.history.state || {}
        window.history.replaceState(rest, '', window.location.href)
      }
      // Usage is an independent read: it must never delay the chat or submit.
      const force = mainTopicUsageForce
      mainTopicUsageForce = false
      void mainTopicUsage.refresh(mainTopicUsageScope(projection), { force })
      scheduleMainTopicPoll(projection)
      return projection
    } catch (error) {
      if (pageLeaving) return undefined
      mainTopicReadFailures++
      if (latestMainTopic || submissionAttempts.length > 0) {
        paintSubmission()
        scheduleMainTopicPoll({ activeTask: { state: 'retry' } })
        return undefined
      }
      mainTopicUsage.clear()
      disposeMainTopic(mainTopicHost)
      clearNode(mainTopicHost)
      const panel = element('section', undefined, 'section mt-unavailable')
      panel.append(
        element('h2', conversationScope?.kind === 'alex' ? 'Alex · CEO' : '项目主会话'),
        element('p', '主会话记录暂时无法读取。请稍后重试。', 'empty'),
        technicalDetailTrigger(() => ({
          title: '技术详情',
          entries: [
            ['code', error?.code, 'data-detail-code'],
            ['owner', error?.ownerId, 'data-detail-owner'],
            ['message', error?.message, 'data-detail-message'],
          ],
        })),
      )
      mainTopicHost.append(panel)
      scheduleMainTopicPoll({ activeTask: { state: 'retry' } })
      return undefined
    } finally {
      mainTopicRefreshing = null
      if (mainTopicRefreshQueued && !pageLeaving) {
        mainTopicRefreshQueued = false
        void refreshMainTopic()
      }
    }
  })()
  return mainTopicRefreshing
}

let latestRuntimeStatus = null
function attemptRecord(rawInput, submission, key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) {
  const attempt = {
    key,
    rawInput,
    rawDraft: rawInput,
    startedAt: new Date().toISOString(),
    submission,
    steps: [],
    running: true,
    submitting: false,
  }
  attempt.onRecover = () => recoverSubmission(attempt)
  attempt.onContinue = () => continueSubmission(attempt)
  attempt.onAnswer = (answer) => runAttempt(attempt, answer)
  submissionAttempts.push(attempt)
  return attempt
}

function setAttemptSubmitting(attempt, value) {
  if (!attempt) return
  attempt.submitting = value
  attempt.running = value
}

// Every returned snapshot updates only the receipt that requested it. A prior
// clarification, confirmation or running turn remains an independent card.
function completeSubmission(snapshot, attempt) {
  if (attempt) {
    attempt.snapshot = snapshot
    attempt.error = undefined
    attempt.running = false
    paintSubmission()
  }
  if (snapshot.state === 'awaiting-clarification' || snapshot.state === 'awaiting-confirmation'
    || snapshot.state === 'partial') {
    renderDraft(snapshot, attempt)
    return
  }
  const form = document.querySelector('#entry-form')
  // The exact submitted draft was cleared at receipt time. Text typed after
  // that receipt belongs to the next message and must survive completion.
  form.elements.namedItem('rawInput').readOnly = false
  for (const name of ['executionMode', 'timezone', 'scheduledStartAt', 'scheduledEndAt', 'maxOccurrences',
    'recurringFrequency', 'intervalMinutes', 'timeOfDay', 'weekDays']) {
    form.elements.namedItem(name).disabled = false
  }
  form.querySelector('button[type="submit"]').setAttribute('aria-label',
    form.elements.namedItem('executionMode').value === 'once'
      ? `发送给 ${latestMainTopic?.agentName || '助手'}`
      : '保存执行计划')
  retainEntryDraft()
}

async function runAttempt(attempt, clarificationAnswer) {
  if (!attempt || attempt.submitting || pageLeaving) return
  setAttemptSubmitting(attempt, true)
  clearEntryError()
  const form = document.querySelector('#entry-form')
  if (form) form.querySelector('button[type="submit"]').disabled = false
  paintSubmission()
  try {
    const snapshot = await executeSubmission(attempt, clarificationAnswer)
    completeSubmission(snapshot, attempt)
  } catch (error) {
    handleSubmissionError(error, undefined, attempt)
  } finally {
    setAttemptSubmitting(attempt, false)
    const form = document.querySelector('#entry-form')
    if (form) {
      form.elements.namedItem('rawInput').readOnly = false
      form.querySelector('button[type="submit"]').disabled = false
    }
    void refreshMainTopic()
    paintSubmission()
  }
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
  host.hidden = true
  void result
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

function setEntryError(error, target = template.hosts.composer.querySelector('#entry-error')) {
  const panel = target
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

function renderDraft(snapshot, attempt) {
  const section = ensureDraftSection()
  if (!section) return
  if (mainTopicHost.dataset.surface === 'main-topic') {
    clearNode(section)
    section.hidden = true
    return
  }
  section.hidden = false
  clearNode(section)
  if (snapshot.state === 'awaiting-clarification') {
    const panel = element('div', undefined, 'panel')
    const latestClarification = snapshot.clarifications?.at(-1)
    const question = latestClarification?.question || snapshot.reply || '需要澄清'
    panel.append(element('h3', question))
    const form = element('form', undefined, 'form-grid')
    const label = element('label')
    label.append('澄清', element('input', undefined))
    const input = label.querySelector('input')
    input.name = 'answer'
    input.required = true
    const actions = element('div', undefined, 'actions')
    const button = element('button', '回答并继续', 'button button--primary')
    button.type = 'submit'
    actions.append(button)
    const optionButtons = []
    const setClarificationControlsDisabled = (disabled) => {
      button.disabled = disabled
      for (const optionButton of optionButtons) optionButton.disabled = disabled
    }
    const submitClarificationAnswer = (rawAnswer, triggerButton) => {
      const answer = String(rawAnswer ?? '').trim()
      if (!answer) {
        setEntryError(Object.assign(new Error('请先填写澄清内容。'), {
          code: 'request.invalid-field',
          ownerId: 'humanagent.app.ui',
          nextAction: 'provide the requested clarification',
        }))
        return
      }
      if (!attempt || attempt.submitting) return
      setClarificationControlsDisabled(true)
      clearEntryError()
      void runAttempt(attempt, answer)
        .finally(() => {
          setClarificationControlsDisabled(false)
        })
    }
    const candidateOptions = Array.isArray(latestClarification?.options)
      ? latestClarification.options
        .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        .map((entry) => entry.trim())
      : []
    if (candidateOptions.length > 0) {
      const optionsGroup = element('div', undefined, 'actions clarification-options')
      optionsGroup.setAttribute('role', 'group')
      optionsGroup.setAttribute('aria-label', '候选澄清选项')
      candidateOptions.forEach((optionText, index) => {
        const optionButton = element('button', optionText, 'button clarification-option')
        optionButton.type = 'button'
        optionButton.dataset.clarificationOption = String(index)
        optionButton.addEventListener('click', () => {
          input.value = optionText
          submitClarificationAnswer(optionText, optionButton)
        })
        optionButtons.push(optionButton)
        optionsGroup.append(optionButton)
      })
      form.append(optionsGroup)
    }
    form.append(label)
    form.append(actions)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitClarificationAnswer(input.value, button)
    })
    panel.append(form)
    section.append(panel)
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
    return
  }

  // A direct answer or a status receipt has no draft to inspect; the answer is
  // the result and it is shown in the main column result card. The raw
  // interaction enum stays internal instead of being printed as page text.
  if (snapshot.state !== 'answered' && snapshot.state !== 'status-only') {
    section.append(element('p', `状态：${snapshot.state} · ${snapshot.nextAction}`, 'empty'))
  }
}

function clearEntryError(target) {
  setEntryError(null, target)
}

function renderStatus(summary, tasks) {
  const section = template.hosts.primary.querySelector('#entry-live')
  if (!section) return
  clearNode(section)
  const rows = taskRows(tasks)
  // Task rows live in the toolbar drawer, keeping the conversation full width.
  const trigger = element('button', '当前任务', 'button button--quiet')
  trigger.type = 'button'
  trigger.dataset.taskListDrawerTrigger = 'true'
  // The toolbar owns this action; retain the trigger as its event endpoint.
  trigger.hidden = true
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-label', `查看项目任务（${rows.length} 项）`)
  trigger.addEventListener('click', () => openActiveTasksDrawer(rows, trigger))
  trigger.addEventListener('entry-open-tasks', (event) => openActiveTasksDrawer(rows, event.detail))
  section.append(trigger)
}

// The entry task board reuses task rows and the shared shell-layer lifecycle.
// Entry CSS makes it a right drawer without changing conversation geometry.
function openActiveTasksDrawer(activeRows, trigger) {
  const body = element('div', undefined, 'panel stack entry-task-list-drawer')
  body.dataset.taskListDrawer = 'true'
  const tracked = new Map(activeRows.map(task => [taskValue(task.taskId), task]))
  for (const record of dispatchTracking.records.values()) {
    if (record.scope.projectKey === latestMainTopic?.projectKey && record.scope.mode === latestMainTopic?.mode)
      tracked.set(record.scope.taskId, record.task)
  }
  const historyStates = new Set(['succeeded', 'completed', 'failed', 'blocked', 'stopped', 'cancelled', 'stale'])
  const current = element('section', undefined, 'stack')
  const history = element('section', undefined, 'stack')
  current.append(element('h3', '当前任务'))
  history.append(element('h3', '历史任务'))
  for (const task of tracked.values()) {
    const button = element('button', task.title || '已交办任务', 'button dispatch-board-entry')
    button.type = 'button'
    button.dataset.dispatchTaskId = taskValue(task.taskId)
    applyTaskCardResult(button, task, dispatchTracking.observation(task), dispatchTracking.executionObserved(task))
    button.addEventListener('click', () => dispatchTracking.open(button, task))
    const section = historyStates.has(task.state) ? history : current
    section.append(button)
  }
  if (current.childElementCount > 1) body.append(current)
  if (history.childElementCount > 1) body.append(history)
  if (tracked.size === 0) body.append(element('p', '当前项目暂无任务。', 'empty'))
  const allTasks = element('a', '查看全部任务', 'button button--quiet')
  allTasks.href = latestMainTopic?.projectKey ? entryProjectHref('tasks.html', latestMainTopic.projectKey, latestMainTopic.mode) : './tasks.html'
  allTasks.dataset.entryAllTasks = 'true'
  body.append(allTasks)
  rememberEntryDrawer('tasks')
  openTechnicalDetail({
    eyebrow: '任务板',
    title: '项目任务',
    content: body,
    trigger,
    onClose: () => rememberEntryDrawer(null),
  })
}

function rememberEntryDrawer(drawer) {
  window.history.replaceState({ ...window.history.state, entryDrawer: drawer }, '', window.location.href)
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
  if (!entryWorkspaceSelection(window.location.search, latestMainTopic).available
    && new URLSearchParams(window.location.search).size > 0) return
  try {
    const { runtimeStatus, tasks } = await readEntryQueue(api)
    if (pageLeaving) return
    latestRuntimeStatus = runtimeStatus
    renderStatus(runtimeStatus, tasks)
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
function subscribeStepStream(url, onEvent) {
  if (!url || typeof EventSource === 'undefined') return () => {}
  let stream
  try {
    stream = new EventSource(url)
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
  stream.onopen = () => { if (!pageLeaving) void refreshMainTopic() }
  return stop
}

function subscribeExecutionStepStream(operationId, onEvent) {
  return subscribeStepStream(operationId ? api.eventsUrl(operationId) : undefined, onEvent)
}

function subscribeTaskStepStream(taskId, onEvent) {
  return subscribeStepStream(taskId ? api.taskEventsUrl(taskId) : undefined, onEvent)
}

function openMainTopicHistoryDetail(trigger, round, turns, host = mainTopicHost) {
  const detail = renderMainTopicHistoryDetail(round, turns)
  openTechnicalDetail({ title: '本轮对话', eyebrow: '历史消息', content: detail.content, trigger, onClose: () => {
    detail.dispose()
    if (!trigger.isConnected) host.querySelector(`[data-round-key="${CSS.escape(round.roundKey)}"]`)?.focus()
  } })
}

function openMainTopicProgressDetail(trigger, turn, scope) {
  const detail = renderTurnProgressDetail(turn, { readOutput: api.readToolOutput })
  const { content } = detail
  if (turn.taskId) {
    const link = element('a', '打开完整任务看板', 'button button--sm')
    link.href = taskDashboardHref(turn.taskId.value, { kind: 'task', projectKey: scope.projectKey, mode: scope.mode })
    content.append(link)
  }
  openTechnicalDetail({ title: '执行进度详情', content, trigger, onClose: () => {
    detail.dispose()
    // A normal poll may replace the clicked button while this layer is open.
    if (!trigger.isConnected) {
      mainTopicHost.querySelector(`[data-turn-id="${CSS.escape(turn.turnId)}"] .conversation-status-detail`)?.focus()
    }
  } })
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
  // Alex has no project dashboard scope. The public task identity is enough to
  // attach its task-scoped execution stream, so do not perform a guaranteed
  // unresolved project landing read first.
  if (conversationScope?.kind === 'alex') {
    await refreshQueue()
    const task = latestMainTopic?.tasks?.find(row => taskValue(row.taskId) === taskIdValue)
      || { taskId: { scope: 'task', value: taskIdValue }, sourceInteractionId: identity.interactionId, state: 'created', title: '已交办任务' }
    return { taskId: taskIdValue, taskIdRef: { scope: 'task', value: taskIdValue },
      scope: null, task, interactionId: identity.interactionId }
  }
  try {
    const landing = await resolveTaskLanding({
      api,
      taskId: taskIdValue,
      search: window.location.search,
      hash: window.location.hash,
      statusMode: latestRuntimeStatus?.mode,
      interactionId: identity.interactionId,
    })
    if (pageLeaving) return
    // Refresh the committed task row in place so the entry list reflects the
    // new task before the live progress card carries its real steps.
    await refreshQueue()
    if (pageLeaving) return
    const task = latestMainTopic?.tasks?.find(row => taskValue(row.taskId) === taskIdValue)
      || { taskId: { scope: 'task', value: taskIdValue }, sourceInteractionId: identity.interactionId, state: 'created', title: '已交办任务' }
    dispatchTracking.remember(task, landing.scope)
    dispatchTracking.sync([task])
    return { taskId: taskIdValue, taskIdRef: { scope: 'task', value: taskIdValue },
      scope: landing.scope, task, interactionId: identity.interactionId }
  } catch (error) {
    if (lookupError) throw lookupError
    throw error
  }
}

function mergeToolFact(events = [], event) {
  if (event?.kind !== 'provider.tool' && event?.kind !== 'provider.tool-result') return events
  if (String(event.toolId).startsWith('humanagent.turn.end')
    || String(event.toolId).startsWith('humanagent_turn_end')) return events
  const key = JSON.stringify([event.kind, event.taskId?.scope, event.taskId?.value,
    event.operationId, event.executionEpoch, event.turnId, event.requestId, event.callId])
  return [...events.filter(item => JSON.stringify([item.kind, item.taskId?.scope, item.taskId?.value,
    item.operationId, item.executionEpoch, item.turnId, item.requestId, item.callId]) !== key), event]
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
}

/**
 * Continue an accepted task on its task-scoped execution stream. This stream
 * supports subscription before the first operation exists and replays the same
 * public events, so it is also the path for Alex, whose conversation has no
 * project dashboard scope. Each interaction owns its own stop handle.
 */
function observeAttemptExecution(attempt, landing) {
  if (!attempt?.interactionId || !landing?.taskId || pageLeaving) return
  attempt.landing = landing
  attempt.landingError = undefined
  const id = attempt.interactionId
  executionStepStops.get(id)?.()
  let stopped = false
  const stop = subscribeTaskStepStream(taskIdValue(landing.taskId), event => {
    if (stopped || pageLeaving || attempt.interactionId !== id) return
    attempt.lastExecutionEvent = event
    if (event.kind === 'execution.started') {
      attempt.executionStarted = event
      paintSubmission()
    }
    if (typeof event.operationId === 'string') attempt.operationId = event.operationId
    if (typeof event.taskId?.value === 'string') attempt.executionTaskId = event.taskId.value
    if (event.kind === 'provider.tool' || event.kind === 'provider.tool-result') {
      attempt.toolEvents = mergeToolFact(attempt.toolEvents, event)
      paintSubmission()
    }
    if (event.kind === 'execution.terminal') {
      attempt.executionTerminal = event
      attempt.running = false
      paintSubmission()
      void refreshMainTopic({ forceUsage: event.terminalPhase === 'final' })
    }
  })
  executionStepStops.set(id, () => { stopped = true; stop() })
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
  let polls = 0
  while (Date.now() < deadline) {
    if (pageLeaving) return undefined
    const tasks = await api.listTasks()
    if (pageLeaving) return undefined
    const rows = taskRows(tasks)
    const { interactionId: sourceInteractionId, ...requirementIdentity } = identity
    const candidate = rows.find((row) => row.taskId?.value && (
      (sourceInteractionId && row.sourceInteractionId === sourceInteractionId)
      || rowMatchesIdentitySource(row.identitySource, requirementIdentity)))
    if (candidate?.taskId?.value) return candidate.taskId.value
    polls += 1
    await new Promise((resolve) => setTimeout(resolve, polls <= 20 ? 25 : 100))
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
function subscribeExplicitStepStream(attempt) {
  const activeId = attempt?.interactionId
  if (!activeId || typeof EventSource === 'undefined') return () => {}
  let stream
  try {
    stream = new EventSource(api.explicitEventsUrl(activeId))
  } catch {
    return () => {}
  }
  const seen = new Set()
  const acceptStep = (event) => {
    if (pageLeaving) return
    try {
      const payload = JSON.parse(event.data || '{}')
      const step = payload?.step ?? payload
      const toolEvent = step && liveToolEvent(step, activeId)
      if (toolEvent && (toolEvent.kind === 'provider.tool' || toolEvent.kind === 'provider.tool-result')) {
        if (attempt.interactionId !== activeId) return
        const current = liveExplicitToolEvents.get(activeId) ?? []
        const key = JSON.stringify([toolEvent.taskId?.scope, toolEvent.taskId?.value, toolEvent.operationId,
          toolEvent.executionEpoch, toolEvent.turnId, toolEvent.requestId, toolEvent.callId, toolEvent.kind])
        const next = current.filter(item => JSON.stringify([item.taskId?.scope, item.taskId?.value,
          item.operationId, item.executionEpoch, item.turnId, item.requestId, item.callId, item.kind]) !== key)
        liveExplicitToolEvents.set(activeId, [...next, toolEvent].sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0)))
        paintSubmission()
        return
      }
      if (step && typeof step.summary === 'string' && step.summary.trim() !== '') {
        if (Number.isSafeInteger(step.seq)) {
          if (seen.has(step.seq)) return
          seen.add(step.seq)
          if (attempt.interactionId === activeId) {
            attempt.steps ??= []
            attempt.steps.push(step)
            paintSubmission()
          }
        }
        void refreshMainTopic()
      }
    } catch {
      // Ignore malformed step event payloads
    }
  }
  stream.addEventListener('explicit.step', acceptStep)
  const stop = () => {
    try { stream.close() } catch {}
    if (explicitStepStops.get(activeId) === stop) explicitStepStops.delete(activeId)
  }
  explicitStepStops.set(activeId, stop)
  stream.onopen = () => { if (!pageLeaving) void refreshMainTopic() }
  return stop
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
async function postConfirmationState(interactionId) {
  const current = await api.inspectExplicitInteraction(interactionId).catch(() => undefined)
  return POST_CONFIRMATION_STATES.has(current?.state) ? current.state : 'confirmed'
}

async function executeSubmission(attempt, clarificationAnswer) {
  const submission = attempt.submission
  if (!attempt.interactionId) {
    const received = await api.receiveExplicitInput({
      sourceRef: 'ui:entry',
      rawInput: submission.rawInput,
      inputRevision: 1,
      requestKind: 'new-task-preview',
      idempotencyKey: submission.idempotencyKey,
      topicRef: 'main',
    })
    attempt.interactionId = received.interactionId
    acceptSubmission(attempt.interactionId, attempt)
    await refreshMainTopic()
  }
  const interactionId = attempt.interactionId

  let snapshot = await api.inspectExplicitInteraction(interactionId)
  if (snapshot.state === 'partial' && snapshot.partial?.partialRef) {
    snapshot = await api.continueExplicitPartial(interactionId, snapshot.partial.partialRef)
  }
  attempt.snapshot = snapshot
  paintSubmission()
  if (snapshot.state === 'awaiting-clarification') {
    if (!clarificationAnswer) return snapshot
    await api.answerExplicitClarification(interactionId, clarificationAnswer)
    snapshot = await api.inspectExplicitInteraction(interactionId)
    await refreshMainTopic()
  }
  if (snapshot.state === 'received' || snapshot.state === 'matching') {
    const stopStepStream = subscribeExplicitStepStream(attempt)
    try {
      snapshot = await api.interpretExplicitInput(interactionId)
    } finally {
      stopStepStream()
    }
    attempt.snapshot = snapshot
    paintSubmission()
  }
  attempt.latestState = snapshot.state
  if (snapshot.state === 'partial') return snapshot
  if (snapshot.state === 'awaiting-clarification') return snapshot
  // A simple answer and a status receipt are both the interaction's business
  // result. They end this submission: the reply is shown in the main status
  // result card, and no draft, requirement or task is created.
  const directResult = answeredSubmissionPresentation(snapshot)
  if (directResult) {
    await refreshMainTopic({ forceUsage: true })
    if (mainTopicHost.dataset.surface !== 'main-topic') renderDirectAnswer(directResult)
    return snapshot
  }
  if (POST_CONFIRMATION_STATES.has(snapshot.state)) {
    // The backend snapshot already proves the business confirmation. Keep that
    // fact so a later task-refresh failure still reports the accepted
    // demand instead of downgrading to an unfinished input.
    attempt.confirmation = snapshot.confirmation || attempt.confirmation || snapshot
    await refreshMainTopic()
    void landOnSubmittedTask({ ...identityFromConfirmedSnapshot(snapshot), interactionId, attempt })
      .then(landing => { if (landing) observeAttemptExecution(attempt, landing) })
      .catch(error => {
        attempt.landingError = error
        paintSubmission()
        void refreshQueue()
      })
    await refreshMainTopic()
    return snapshot
  }
  if (snapshot.state !== 'awaiting-confirmation' || !snapshot.draft) {
    throw Object.assign(new Error(`显式大脑当前状态：${snapshot.state}。${snapshot.nextAction}`), {
      code: 'explicit-brain.state-invalid',
      ownerId: 'humanagent.runtime.explicit-brain',
      nextAction: 'inspect the current interaction state before retrying',
    })
  }

  // Existing-task proposals require their own confirmation. Only a create
  // proposal can use the new-task authorization from the composer.
  if (snapshot.draft.proposedIntent !== 'create') {
    pendingDrafts.set(interactionId, draftReviewFromSnapshot(snapshot))
    await refreshMainTopic({ forceUsage: true })
    return snapshot
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
  attempt.confirmation = receipt.requirement
  // The submit is the confirmation. `latestState` still holds the
  // pre-confirmation snapshot the read-only draft above was rendered from, so
  // the card must project the runtime's post-confirmation state from here on.
  attempt.latestState = await postConfirmationState(interactionId)
  if (submission.executionPolicy.executionMode !== 'once') {
    await refreshQueue()
    return snapshot
  }
  await refreshMainTopic()
  void landOnSubmittedTask({ ...identityFromReceipt(receipt.requirement), interactionId, attempt })
    .then(landing => { if (landing) observeAttemptExecution(attempt, landing) })
    .catch(error => {
      attempt.landingError = error
      paintSubmission()
      void refreshQueue()
    })
  await refreshMainTopic()
  return { ...snapshot, state: attempt.latestState }
}

function submissionFailureSummary(attempt) {
  if (attempt?.confirmation) return '需求已接收，任务进展尚未刷新。'
  if (attempt?.interactionId) return '输入已接收，本次处理未完成。'
  return '本次提交未获接收确认。'
}

function handleSubmissionError(error, button, attempt) {
  if (attempt) {
    attempt.error = error
    attempt.processError = error
    attempt.running = false
    paintSubmission()
    scheduleMainTopicPoll(latestMainTopic)
  }
  const submit = template.hosts.composer.querySelector('#entry-form button[type="submit"]')
  if (submit) submit.textContent = '↑'
  if (button) button.textContent = '↑'
}

function field(labelText, control) {
  const label = element('label')
  label.append(labelText, control)
  return label
}

function renderForm() {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  const heading = element('h2', '继续对话', 'entry-composer-heading')
  head.append(heading, element('span', '简单问题直接回答 · 新任务一次提交即确认', 'section-meta'))
  section.append(head)

  const panel = element('div', undefined, 'panel')
  const form = element('form', undefined, 'form-grid')
  form.id = 'entry-form'
  const textarea = element('textarea')
  textarea.name = 'rawInput'
  textarea.rows = 1
  textarea.required = true
  textarea.placeholder = '给 HumanAgent 发消息…'
  form.append(field('消息', textarea))

  const mode = element('select')
  mode.name = 'executionMode'
  for (const [value, label] of [['once', '单次执行'], ['scheduled', '定时执行'], ['recurring', '周期执行']]) {
    const option = element('option', label)
    option.value = value
    mode.append(option)
  }
  const modeField = field('执行类型', mode)

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
  const submitButton = element('button', '发送', 'button button--primary')
  submitButton.setAttribute('aria-label', '发送消息')
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
    submitButton.textContent = '↑'
    submitButton.setAttribute('aria-label', modeValue === 'once'
      ? `发送给 ${latestMainTopic?.agentName || '助手'}` : '保存执行计划')
    scheduleEdit.textContent = modeValue === 'once' ? '执行设置' : '已设置执行计划'
  }
  // The dialog stays inside this form, preserving named controls and validation.
  const scheduleDialog = element('dialog', undefined, 'entry-schedule-dialog')
  scheduleDialog.setAttribute('aria-label', '定时任务')
  bindDrawerLightDismiss(scheduleDialog)
  const scheduleHead = element('div', undefined, 'entry-schedule-head')
  const scheduleClose = element('button', '完成设置', 'button')
  scheduleClose.type = 'button'
  scheduleClose.addEventListener('click', () => scheduleDialog.close())
  scheduleHead.append(element('h2', '定时任务'), scheduleClose)
  scheduleDialog.append(scheduleHead, element('p', '设置当前消息的单次、定时或周期执行。发送时保存执行计划。已有任务请在任务板查看；此处没有独立的定时计划列表。', 'muted'), modeField)
  for (const node of [...form.querySelectorAll('[data-execution-field]')]) scheduleDialog.append(node)
  form.append(scheduleDialog)
  const scheduleEdit = element('button', '执行设置', 'button entry-execution-settings')
  scheduleEdit.type = 'button'
  scheduleEdit.dataset.entryScheduleTrigger = 'true'
  scheduleEdit.addEventListener('click', () => { rememberEntryDrawer('schedule'); scheduleDialog.showModal() })
  scheduleDialog.addEventListener('close', () => {
    rememberEntryDrawer(null)
    retainEntryDraft()
    setTimeout(() => {
      if (!scheduleDialog.open && scheduleEdit.isConnected) scheduleEdit.focus()
    }, 0)
  })
  actions.prepend(scheduleEdit)
  form.addEventListener('invalid', (event) => {
    if (scheduleDialog.contains(event.target) && !scheduleDialog.open) scheduleDialog.showModal()
  }, true)
  mode.addEventListener('change', syncExecutionFields)
  frequency.addEventListener('change', syncExecutionFields)
  syncExecutionFields()
  restoreEntryDraft(form)
  syncExecutionFields()
  form.addEventListener('input', retainEntryDraft)
  form.addEventListener('change', retainEntryDraft)
  form.addEventListener('focusin', retainEntryDraft)
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      form.requestSubmit(submitButton)
    }
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!entryWorkspaceSelection(window.location.search, latestMainTopic).available) return
    const rawInput = textarea.value.trim()
    const rawDraft = textarea.value
    if (!rawInput) {
      setEntryError(Object.assign(new Error('请先填写任务输入。'), {
        code: 'request.invalid-field',
        ownerId: 'humanagent.app.ui',
        nextAction: 'provide the task input',
      }))
      return
    }
    let submission
    try { submission = prepareSubmission(rawInput, form) }
    catch (error) { setEntryError(error); return }
    const attempt = attemptRecord(rawInput, submission)
    attempt.rawDraft = rawDraft
    paintSubmission()
    scheduleMainTopicPoll(latestMainTopic)
    textarea.value = ''
    retainEntryDraft()
    submitButton.disabled = false
    textarea.readOnly = false
    clearEntryError()
    void runAttempt(attempt)
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
  interactionCardHost.hidden = true
  template.hosts.primary.append(decisionNotice, mainTopicHost, interactionCardHost, liveArea())
  template.hosts.composer.append(renderForm())
  template.hosts.composer.hidden = true
  await refreshMainTopic()
  await refreshQueue()
  if (window.history.state?.entryDrawer === 'tasks') pageRoot.querySelector('[data-entry-board-trigger]')?.click()
  if (window.history.state?.entryDrawer === 'schedule') pageRoot.querySelector('[data-entry-schedule-trigger]')?.click()
  const focus = window.history.state?.entryFocus
  const control = focus && document.querySelector('#entry-form')?.elements.namedItem(focus.name)
  if (control && control.getClientRects().length && !control.closest('dialog:not([open])')) {
    control.focus()
    if (typeof focus.start === 'number' && typeof control.setSelectionRange === 'function') control.setSelectionRange(focus.start, focus.end)
  }
}

void load().catch((error) => {
  if (!pageLeaving) renderPageError(status, error)
})

}
