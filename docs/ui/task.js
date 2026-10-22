import {
  api,
  appendPairingEntry,
  clearNode,
  element,
  formatTime,
  loadRuntimeStatus,
  mountPageTemplate,
  observationHref,
  queryParam,
  renderPageError,
  renderRuntimeStatus,
  stateTone,
  taskDashboardHref,
  taskIdFromQuery,
  taskReadScopeFromQuery,
} from './runtime-shell.js'
import { advanceExplicitInteraction } from './explicit-interaction-flow.js'
import { mountInteractionWorkCard } from './interaction-work-card.js'
import {
  projectInteractionCardFromEntries,
  projectInteractionCardFromSnapshot,
  withTaskHistory,
} from './interaction-card-page.js'
import { renderProductSessionView } from './product-session-view.js'
import {
  openDecisionModal,
  renderPendingDecision,
} from './product-control-view.js'

// The task page reads one declared product session. The reader is injected so
// the page consumer exercises the same wiring without a browser, and so the H2
// HTTP surface can be adopted without a second presentation path.
function productScopeOf(scope) {
  if (scope?.kind !== 'task' || !scope.projectKey || !scope.mode || !scope.taskId?.value) {
    return undefined
  }
  return {
    kind: 'task',
    projectKey: scope.projectKey,
    mode: scope.mode,
    taskId: scope.taskId,
  }
}

function productScopeQuery(scope) {
  return {
    projectKey: scope.projectKey,
    mode: scope.mode,
    taskId: scope.taskId.value,
  }
}

async function readProductJson(path, query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const response = await fetch(`${path}?${params}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `读取失败（${response.status}）`)
  return body
}

function outputPublication(view) {
  if (!view || typeof view !== 'object') return undefined
  if (view.publication !== undefined) return view.publication
  // Accept the exact ready-to-render projection when a caller hands one in;
  // ProductOutputView itself remains the preferred shape.
  if (view.commits !== undefined || view.state !== undefined) return view
  return undefined
}

function attach(parent, child) {
  if (!parent || !child) return child
  if (typeof child.remove === 'function' && child.parentNode && child.parentNode !== parent) {
    child.remove()
  }
  if (child.parentNode === parent && parent.lastChild === child) return child
  parent.append(child)
  return child
}

/**
 * Create the testable task-page product surface.
 *
 * One confirmation is bound to the interaction identity; repeated clicks reuse
 * the same in-flight guard and submit once. Clarification answers live in
 * controller state, so an error can rerender diagnostics without replacing the
 * human's text. Decisions come only from the session read or an injected
 * reader; the controller never invents one from the task dashboard.
 */
export function createTaskProductController(options = {}) {
  const {
    host,
    interactionHost,
    decisionHost,
    status,
    make,
    transport = {},
    scope,
    taskId,
    onActivity,
    onError,
  } = options
  const productScope = productScopeOf(scope)
  const currentTaskId = typeof taskId === 'string'
    ? taskId
    : scope?.taskId?.value

  const section = make('section', undefined, 'product-task-session')
  section.setAttribute('aria-label', '当前交互会话')
  const heading = make('h2', '当前交互会话', 'section-title')
  const sessionHost = make('div', undefined, 'product-task-session-messages')
  const outputHost = make('div', undefined, 'product-task-session-output')
  const sessionStatus = make('p', '', 'muted product-task-session-status')
  sessionStatus.setAttribute('role', 'status')
  sessionStatus.setAttribute('aria-live', 'polite')
  const modalHost = make('div', undefined, 'product-task-decision-modal-host')
  section.append(heading, sessionStatus, sessionHost, outputHost)

  let state = {
    interactionId: undefined,
    rawInput: undefined,
    snapshot: undefined,
    organized: undefined,
    answer: '',
    submitting: false,
    error: undefined,
    notice: undefined,
    confirmed: false,
    lastDecision: undefined,
    modal: undefined,
  }

  function mount() {
    attach(host, section)
    attach(host, interactionHost)
    attach(host, decisionHost)
    attach(host, modalHost)
    return controller
  }

  function dispose() {
    if (state.modal && typeof state.modal.close === 'function') state.modal.close()
    state.modal = undefined
    section.remove?.()
    interactionHost?.remove?.()
    decisionHost?.remove?.()
    modalHost?.remove?.()
  }

  function currentAnswer() {
    if (state.answer) return state.answer
    const field = interactionHost?.querySelector?.('textarea')
    return typeof field?.value === 'string' ? field.value : ''
  }

  function showError(error, message) {
    state.error = error
    const summary = message ?? error?.message ?? String(error)
    state.notice = error?.message && error.message !== summary
      ? `${summary} ${error.message}`
      : summary
    if (status) {
      status.textContent = state.notice
      status.setAttribute?.('data-status', 'error')
    }
    safeError(error)
  }

  function safeError(error) {
    if (typeof onError === 'function') onError(error)
  }

  function appendDiagnostics(container, error) {
    if (!container || !error) return
    const details = make('details', undefined, 'product-task-diagnostics')
    details.append(make('summary', '诊断', 'product-task-diagnostic-title'))
    for (const [label, value] of [
      ['code', error.code],
      ['owner', error.ownerId],
      ['message', error.message],
      ['next', error.nextAction],
    ]) {
      if (value === undefined || value === null || value === '') continue
      details.append(make('p', `${label}: ${value}`, 'product-task-diagnostic-line'))
    }
    const causeLines = []
    for (let cause = error.cause, depth = 0; cause && depth < 4; cause = cause.cause, depth += 1) {
      const name = cause.name || 'Error'
      const causeMessage = cause.message || String(cause)
      causeLines.push(`${'  '.repeat(depth)}cause: ${name}: ${causeMessage}`)
    }
    if (causeLines.length > 0) {
      const pre = make('pre', causeLines.join('\n'), 'product-task-diagnostic-cause')
      pre.setAttribute('data-detail-cause', '')
      details.append(pre)
    }
    container.append(details)
  }

  function renderInteraction() {
    if (!interactionHost) return
    interactionHost.replaceChildren()
    if (state.interactionId === undefined) {
      interactionHost.hidden = true
      return
    }
    interactionHost.hidden = false

    const panel = make('section', undefined, 'section product-task-interaction')
    panel.setAttribute('aria-label', '交互状态')
    panel.dataset.taskProductInteraction = 'true'
    if (state.rawInput !== undefined && state.rawInput !== '') {
      panel.append(make('p', '你的输入', 'eyebrow'))
      panel.append(make('p', state.rawInput, 'product-task-input'))
    }
    const organized = state.organized?.proposal
      || state.snapshot?.draft?.proposal
      || state.snapshot?.reply
    if (organized !== undefined && organized !== '') {
      panel.append(make('p', '整理后的任务', 'eyebrow'))
      panel.append(make('p', organized, 'product-task-organized'))
    }

    const feedback = make(
      'p',
      state.notice ?? (state.snapshot?.state === 'awaiting-clarification'
        ? state.snapshot.reply || '请补充显式大脑需要的信息。'
        : state.snapshot?.state === 'awaiting-confirmation'
          ? '已整理完成。此次确认只提交一次；已有任务的目标或范围变更仍会单独确认。'
          : state.snapshot?.nextAction || ''),
      state.error ? 'product-task-feedback product-task-feedback--error' : 'product-task-feedback',
    )
    feedback.setAttribute('role', 'status')
    feedback.setAttribute('aria-live', 'polite')
    if (state.error) appendPairingEntry(feedback, state.error)
    panel.append(feedback)

    const actions = make('div', undefined, 'actions product-task-actions')
    if (state.snapshot?.state === 'awaiting-clarification') {
      const answer = make('textarea', undefined, 'product-task-answer')
      answer.required = true
      answer.value = currentAnswer()
      answer.placeholder = state.snapshot.reply || '请补充显式大脑需要的信息。'
      answer.setAttribute('aria-label', '补充输入')
      answer.addEventListener('input', () => {
        state.answer = answer.value
      })
      state.answer = answer.value
      const submit = make('button', '回答并继续', 'button button--primary')
      submit.type = 'button'
      submit.setAttribute('data-task-action', 'answer')
      submit.addEventListener('click', () => void clarify())
      actions.append(answer, submit)
    } else if (state.snapshot?.state === 'awaiting-confirmation' && state.snapshot.draft) {
      const confirm = make('button', '按此方案继续', 'button button--primary')
      confirm.type = 'button'
      confirm.id = 'task-confirm-button'
      confirm.setAttribute('data-task-action', 'confirm')
      confirm.disabled = state.submitting
      confirm.addEventListener('click', () => void confirmInteraction(confirm))
      actions.append(confirm)
    }
    panel.append(actions)

    if (state.confirmed) {
      const taskList = make('a', '打开任务列表', 'button button--primary')
      taskList.href = './tasks.html'
      panel.append(taskList)
    }
    if (state.error) appendDiagnostics(panel, state.error)
    interactionHost.append(panel)
  }

  function afterInteraction(nextSnapshot) {
    if (!nextSnapshot || typeof nextSnapshot !== 'object') {
      throw Object.assign(new Error('交互读取未返回状态。'), {
        code: 'task.interaction.empty',
        ownerId: 'humanagent.ui',
        nextAction: 'refresh the interaction',
      })
    }
    const nextState = typeof nextSnapshot.state === 'string' ? nextSnapshot.state : 'unknown'
    state.snapshot = nextSnapshot
    state.organized = nextSnapshot.draft ?? state.organized
    state.error = undefined
    if (nextState === 'confirmed' || nextState === 'dispatched') {
      state.confirmed = true
      state.notice = nextSnapshot.reply
        || `已确认，需求已进入 FIFO。当前状态：${nextState}。`
    } else {
      state.notice = nextSnapshot.reply || nextSnapshot.nextAction
    }
    if (status && state.notice) {
      status.textContent = state.notice
      status.removeAttribute?.('data-status')
    }
    return nextSnapshot
  }

  async function confirmInteraction(button) {
    if (state.submitting || state.confirmed || !state.snapshot?.draft) return
    if (typeof transport.confirmExplicitRequirement !== 'function') {
      showError(Object.assign(new Error('缺少正式确认入口。'), {
        code: 'task.confirmation.transport-unavailable',
        ownerId: 'humanagent.ui',
        nextAction: 'inject the runtime-api confirmation surface',
      }))
      renderInteraction()
      return
    }
    state.submitting = true
    if (button) button.disabled = true
    state.notice = '正在确认并提交…'
    renderInteraction()
    try {
      await transport.confirmExplicitRequirement(state.interactionId, {
        draftId: state.snapshot.draft.draftId,
        inputRevision: state.snapshot.draft.inputRevision,
        confirmationRef: `ui:confirmation:${state.interactionId}`,
        confirmedBy: 'human:operator',
        confirmedAt: new Date().toISOString(),
        payloadRef: `asset://requirements/${state.interactionId}`,
      })
      state.submitting = false
      state.confirmed = true
      state.error = undefined
      state.notice = '已确认，需求已进入 FIFO。可在任务列表查看 queued/admitted/executing 等状态。'
      if (status) {
        status.textContent = state.notice
        status.removeAttribute?.('data-status')
      }
      if (typeof onActivity === 'function') {
        onActivity({
          kind: 'decision',
          text: '任务已确认，等待队列消费',
          sourceKind: 'decision',
          detail: {
            eventKey: 'explicit.confirmation-submitted',
            interactionId: state.interactionId,
          },
        })
      }
      renderInteraction()
      await refresh().catch(() => {})
    } catch (error) {
      state.submitting = false
      showError(error, '本次确认提交未获成功回执。')
      renderInteraction()
    }
  }

  async function clarify() {
    if (state.submitting) return
    const answer = currentAnswer()
    if (!answer.trim()) {
      state.notice = '请先填写补充内容。'
      renderInteraction()
      return
    }
    if (typeof transport.answerExplicitClarification !== 'function') {
      showError(Object.assign(new Error('缺少正式澄清入口。'), {
        code: 'task.clarification.transport-unavailable',
        ownerId: 'humanagent.ui',
        nextAction: 'inject the runtime-api clarification surface',
      }))
      renderInteraction()
      return
    }
    state.answer = answer
    state.submitting = true
    state.notice = '正在继续整理…'
    renderInteraction()
    try {
      const next = await transport.answerExplicitClarification(state.interactionId, answer)
      state.submitting = false
      afterInteraction(next)
      renderInteraction()
      await refresh().catch(() => {})
    } catch (error) {
      state.submitting = false
      showError(error, '这次补充未能处理完成。')
      renderInteraction()
    }
  }

  function setInteraction(input = {}) {
    state = {
      ...state,
      interactionId: input.interactionId,
      rawInput: input.rawInput ?? input.snapshot?.rawInput,
      snapshot: input.snapshot ?? state.snapshot,
      organized: input.organized ?? input.snapshot?.draft ?? state.organized,
      error: input.error,
      notice: input.notice,
      confirmed: input.snapshot?.state === 'confirmed' || input.snapshot?.state === 'dispatched',
      submitting: false,
    }
    if (status && input.error) {
      status.textContent = input.error.message || input.notice || '交互读取失败。'
      status.setAttribute?.('data-status', 'error')
    }
    renderInteraction()
    return controller
  }

  function pendingDecisionOf(sessionRead) {
    const pending = sessionRead?.pendingDecision
      ?? state.lastDecision
      ?? undefined
    if (pending === undefined) return undefined
    if (pending === null || typeof pending !== 'object') {
      showError(Object.assign(new Error('待决定对象格式无效。'), {
        code: 'task.decision.invalid',
        ownerId: 'humanagent.ui',
        nextAction: 'repair the owner decision read',
      }))
      return undefined
    }
    return pending
  }

  function renderDecision(pending) {
    if (!decisionHost) return
    if (!pending) {
      state.lastDecision = undefined
      decisionHost.replaceChildren()
      return
    }
    state.lastDecision = pending
    renderPendingDecision(decisionHost, pending, {
      element: make,
      onIntent: (_intent, selected) => {
        openDecision(selected ?? pending)
      },
    })
  }

  function openDecision(pending = state.lastDecision) {
    if (!pending || state.modal) return undefined
    state.modal = openDecisionModal({
      host: modalHost,
      element: make,
      decision: pending,
      transport,
      title: '审核执行决定',
      onClose: (context) => {
        state.modal = undefined
        if (context?.wroteDecision === false) {
          state.notice = '审批已关闭，未写入任何决定。'
          renderInteraction()
        }
      },
      onReceipt: () => {
        void refresh().catch(() => {})
      },
    })
    return state.modal
  }

  async function refresh() {
    if (!productScope || !currentTaskId || currentTaskId === 'new') {
      if (sessionStatus) {
        sessionStatus.textContent = productScope
          ? '来源不可用：缺少当前任务身份，无法读取公开会话。'
          : '来源不可用：缺少 projectKey 与 mode，无法读取公开会话。'
      }
      return undefined
    }
    const query = productScopeQuery(productScope)
    const sessionRead = typeof transport.readProductSession === 'function'
      ? await transport.readProductSession(productScope)
      : await readProductJson('/api/product/session', query)
    let resolvedOutput
    try {
      resolvedOutput = typeof transport.readProductOutput === 'function'
        ? await transport.readProductOutput(productScope.taskId.value, productScope)
        : await readProductJson('/api/product/output', query)
    } catch {
      resolvedOutput = undefined
    }
    const publication = outputPublication(resolvedOutput)
    renderProductSessionView(sessionHost, {
      messages: sessionRead?.messages ?? [],
      publicOutput: publication,
    }, { element: make })
    outputHost.replaceChildren()
    if (!publication && resolvedOutput?.resultAvailable === true && resolvedOutput.commits?.length > 0) {
      renderProductSessionView(outputHost, {
        messages: [],
        publicOutput: resolvedOutput.publication ?? resolvedOutput,
      }, { element: make })
    }
    sessionStatus.textContent = ''
    renderDecision(pendingDecisionOf(sessionRead))
    return { session: sessionRead, output: resolvedOutput }
  }

  const controller = {
    mount,
    refresh,
    setInteraction,
    openDecision,
    dispose,
    state: () => ({ ...state }),
  }
  mount()
  return controller
}

function taskPageNeedsBoot() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  return document.querySelector('#page-root') !== null
    && document.querySelector('[data-interaction-work-card-host][data-entry="task"]') !== null
}

// Browser-only boot. The existing page controller stays in this guarded block
// so a Node consumer can import `createTaskProductController` without a DOM.
if (taskPageNeedsBoot()) {

const requestedTask = taskIdFromQuery(false)
const requestedInteraction = queryParam('interaction')
const taskReadScope = taskReadScopeFromQuery()
const explicitScope = taskReadScope.kind === 'task' ? taskReadScope : null
const isNew = (requestedTask === 'new' || !requestedTask) && !requestedInteraction
const pageRoot = document.querySelector('#page-root')
const interactionCardHost = document.querySelector('[data-interaction-work-card-host][data-entry="task"]')
if (!(pageRoot instanceof HTMLElement)) throw new Error('task page requires #page-root')
if (!(interactionCardHost instanceof HTMLElement)) throw new Error('task page requires an interaction work card host')
const template = mountPageTemplate(pageRoot, {
  layout: 'work',
  active: 'Task List',
  eyebrow: 'Task',
  title: requestedInteraction ? '确认任务' : '任务详情',
  lede: requestedInteraction ? '显式大脑会先整理，再由你确认是否提交后台。' : '查看任务状态和处理结果。',
})
const { composer, primary, status } = template.hosts
let pageLeaving = false
const productController = createTaskProductController({
  host: primary,
  interactionHost: element('div'),
  decisionHost: element('div'),
  status,
  make: (tag, text, className) => element(tag, text, className),
  transport: api,
  scope: taskReadScope,
  taskId: requestedTask,
  onActivity: (activity) => appendCardEvent(
    activity.kind,
    activity.text,
    activity.sourceKind,
    activity.detail,
  ),
  onError: () => {},
})
// The shared work card mounts on the first real projection: a returned
// interaction event or snapshot, or an existing Task's own dashboard/history
// read. Until one of those facts exists the host stays genuinely empty, so an
// unsent new Task no longer claims that a task or interaction exists. The
// shared projector maps `received` onto `created`, so the old eager empty
// projection is what produced a source-less "已创建" card here.
let interactionCard = null

function mountTaskCard() {
  interactionCard = mountInteractionWorkCard(interactionCardHost, {
    onAction: async (action) => {
      if (action.id === 'confirm-requirement') {
        const confirmationButton = composer.querySelector('#task-confirm-button')
        if (confirmationButton) void confirmationButton.click()
      }
    },
    onHistoryQuery: (query) => loadTaskHistory(query),
  })
  return interactionCard
}

// The one Task-local presentation path. Every existing card update is routed
// through it, so the card appears with real content only, and it re-attaches
// the preserved host after the page rebuilds that `renderInteraction` /
// `renderTask` perform.
function presentInteractionCard(projection) {
  if (pageLeaving || !interactionCardHost || !projection) return
  attachInteractionCardHost()
  if (!interactionCard) mountTaskCard()
  interactionCard.update(projection)
}

// ── Liveness + transport ─────────────────────────────────────────────────────
//
// The transport fact is page-local by contract (`RuntimeLivenessProjection`
// deliberately carries no transport): only the page that holds the event stream
// can observe a transport loss, and a server-derived value cannot be fetched
// while that transport is down. This page holds the stream, so it keeps its own
// `transportState`.
//
// `settled` is the close the server performs once the execution reached its
// terminal state (`execution.terminal` with `terminalPhase==='final'`). The
// browser fires `onerror` for that intentional close, so an `onerror` alone is
// not a transport loss: a `lost` verdict needs both a real `onerror` and no
// terminal close yet.
//
// The dashboard poll is what makes the card truthful while the execution is
// live. It must keep running during `running`/`settling` — a stalled execution
// emits no events, so only the poll can report that the activity has stopped.
// Polling also stops being able to report once the execution is terminal, which
// is when the card should hold its final state instead of re-observing.
const DASHBOARD_POLL_MS = 750
const TERMINAL_TASK_STATES = Object.freeze(['succeeded', 'failed', 'cancelled', 'stopped'])
let transportState = 'unknown'
let terminalClosed = false
let taskStream = null
let closingStream = false
let subscribedOperationId
let dashboardPollTimer = 0
// The last dashboard read this page performed. A transport change re-renders
// against it so a loss is visible before the next scheduled read.
let lastDashboard

function stopDashboardPoll() {
  if (dashboardPollTimer) {
    clearTimeout(dashboardPollTimer)
    dashboardPollTimer = 0
  }
}

function scheduleDashboardPoll(delayMs = DASHBOARD_POLL_MS) {
  stopDashboardPoll()
  if (pageLeaving) return
  dashboardPollTimer = setTimeout(() => {
    dashboardPollTimer = 0
    if (!pageLeaving) void refreshTaskDashboard().catch(() => {})
  }, delayMs)
}

function setTransportState(next) {
  if (pageLeaving) return
  if (transportState === next) return
  transportState = next
  // A transport change is itself a fact the card must show, and no dashboard
  // read is scheduled between two SSE callbacks, so re-render against the last
  // observed read. A loss therefore becomes visible immediately.
  if (lastDashboard) updateTaskExecution(lastDashboard)
}

function closeTaskStream() {
  const stream = taskStream
  taskStream = undefined
  subscribedOperationId = undefined
  if (!stream) return
  closingStream = true
  stream.close()
  closingStream = false
}

function subscribeTaskStream(operationId) {
  if (pageLeaving || subscribedOperationId === operationId) return
  closeTaskStream()
  subscribedOperationId = operationId
  terminalClosed = false
  taskStream = new EventSource(api.eventsUrl(operationId))
  taskStream.onopen = () => {
    if (pageLeaving) return
    // A reconnected stream is a real transport fact; re-observe at once so the
    // card reports the recovery without waiting a poll tick.
    setTransportState('connected')
    void refreshTaskDashboard().catch(() => {})
  }
  taskStream.onerror = () => {
    if (pageLeaving) return
    if (closingStream) return
    if (terminalClosed) return
    setTransportState('lost')
  }
  for (const kind of [
    'execution.started',
    'provider.model',
    'provider.output',
    'provider.tool',
    'provider.tool-result',
    'provider.error',
    'execution.settling',
    'checkpoint.committed',
    'execution.terminal',
  ]) {
    taskStream.addEventListener(kind, (message) => {
      if (pageLeaving) return
      if (terminalClosed) return
      let payload
      try {
        payload = JSON.parse(message.data)
      } catch {
        // A frame the page cannot parse is not an event. Counting it as a
        // heartbeat would read a corrupt stream as healthy progress, so the
        // transport is reported as lost instead of the failure being swallowed.
        setTransportState('lost')
        return
      }
      if (payload.kind === 'execution.terminal' && payload.terminalPhase === 'final') {
        terminalClosed = true
        setTransportState('settled')
        void refreshTaskDashboard().catch(() => {})
        return
      }
      // A real event is a heartbeat for both facts: it proves the transport is
      // attached, and it is the activity the dashboard read observes.
      setTransportState('connected')
      void refreshTaskDashboard().catch(() => {})
    })
  }
}

function disposeTaskPage(event) {
  if (event?.persisted) return
  if (pageLeaving) return
  pageLeaving = true
  stopDashboardPoll()
  closeTaskStream()
  productController.dispose()
  interactionCard?.dispose()
  template.dispose()
}
window.addEventListener('pagehide', disposeTaskPage)

function projectTaskLiveness(dashboard) {
  // The card is built from the interaction entries; the execution facts come
  // from the runtime dashboard read the page performed. Both are reported
  // facts, and the execution side may be absent. The dashboard's own Task,
  // Operation and epoch identity are forwarded verbatim so the card reports the
  // real execution identity instead of deriving one from the interaction.
  return projectInteractionCardFromEntries(cardState.entries, activeInteractionId ? 'received' : 'awaiting-confirmation', {
    liveness: dashboard.liveness,
    execution: {
      taskId: dashboard.taskId,
      operationId: dashboard.operationId,
      executionEpoch: dashboard.executionEpoch,
      state: dashboard.state,
      // The runtime's own localized label. Without it the card would fall back
      // to a raw LifecycleState value and show the human `任务 failed`.
      stateLabel: dashboard.stateLabel,
      error: dashboard.error,
      nextStep: dashboard.nextStep,
    },
  })
}

function updateTaskExecution(dashboard) {
  if (pageLeaving) return
  // Rebuild the card from the interaction entries plus the runtime's own
  // execution facts, keep the page-local transport fact on it, then re-apply
  // the loaded history page so the trace is not dropped by the observation.
  // `cardState.projection` stays the base that history is re-applied onto.
  lastDashboard = dashboard
  const base = projectTaskLiveness(dashboard)
  if (!base) return
  const projection = {
    ...base,
    // The page-local four-value stream fact rides on its OWN carrier.
    // `cardMetadata.transport` is the typed `InteractionTraceTransport`
    // (`{connected, lastSyncedAt, ...}`) and has no `state` field, so writing the
    // four-value fact there broke that declared shape.
    cardMetadata: { ...base.cardMetadata, stream: { state: effectiveTransport(dashboard) } },
  }
  cardState.projection = projection
  presentInteractionCard(cardState.history
    ? withTaskHistory(projection, cardState.history.query, cardState.history.result)
    : projection)
}

/**
 * The transport fact as the card must show it.
 *
 * A terminal execution means the server has closed the stream by design, so an
 * `onerror` arriving from that close is an expected closure, not a loss. The
 * server writes the terminal frame and then ends the response, so the browser
 * can dispatch the close error before or after the terminal frame; deriving the
 * fact from the observed execution state removes that race instead of relying
 * on delivery order. A `lost` verdict therefore only survives while the
 * execution is still live.
 */
function effectiveTransport(dashboard) {
  return TERMINAL_TASK_STATES.includes(dashboard.state) ? 'settled' : transportState
}

async function refreshTaskDashboard() {
  if (pageLeaving) return
  // Eligibility is the real host plus a real existing Task identity, not
  // whether the card already mounted: a valid Task with zero interaction
  // events must still issue this read and render the dashboard it returns.
  if (!interactionCardHost || !taskId || taskId === 'new') return
  let dashboard
  try {
    dashboard = await api.taskDashboard(taskId)
  } catch {
    if (pageLeaving) return
    // A failed read is the only transport fact left once the event stream has
    // stopped reporting. An established stream survives a silent network drop,
    // so its `onerror` may never fire; the read failing is what proves this page
    // can no longer observe the execution. Reporting that is the point of the
    // card, so it is recorded instead of being retried in silence.
    setTransportState('lost')
    scheduleDashboardPoll()
    return
  }
  if (pageLeaving) return
  if (!dashboard) return
  if (TERMINAL_TASK_STATES.includes(dashboard.state)) {
    // Terminal is the last thing worth observing. Hold the card here; do not
    // keep re-observing a settled execution.
    stopDashboardPoll()
    if (subscribedOperationId) closeTaskStream()
    updateTaskExecution(dashboard)
    return
  }
  if (dashboard.operationId && ['running', 'settling'].includes(dashboard.state)) {
    // A read that succeeds after a loss proves the connection is back. Re-open
    // the stream so the recovery is an observed new connection rather than a
    // stale `lost` carried over from the connection that failed. The stream's
    // own `onopen` is what clears the loss here, because while an execution is
    // live the stream is the transport this card reports on.
    if (subscribedOperationId === dashboard.operationId && transportState === 'lost') {
      closeTaskStream()
    }
    subscribeTaskStream(dashboard.operationId)
  } else if (subscribedOperationId) {
    closeTaskStream()
  } else if (transportState === 'lost') {
    // No stream is expected for this state, so the successful read is itself the
    // proof of reachability that clears the loss. Without this a single failed
    // read would leave a permanent false alarm on a task that has no live stream
    // to reopen.
    setTransportState('connected')
  }
  updateTaskExecution(dashboard)
  // Keep polling while the execution is live: silence is the case this poll
  // exists to detect, and silence produces no events of its own.
  scheduleDashboardPoll()
}

// The card's trace is the runtime's own history for this task. It is loaded
// from the public history surface, so the displayed turn ids and occurrence
// times are the values the provider binding reported; when the task has no
// event yet the card keeps the explicit empty state.
async function loadTaskHistory(query) {
  if (pageLeaving) return
  // Same boundary as the dashboard read: the host and a real Task identity.
  if (!interactionCardHost || !taskId || taskId === 'new') return
  const effectiveQuery = query ?? { limit: 20, replay: true }
  let result
  try {
    result = await api.taskHistory(taskId, {
      limit: effectiveQuery.limit,
      ...(effectiveQuery.cursor === undefined ? {} : { cursor: effectiveQuery.cursor }),
      ...(effectiveQuery.search === undefined ? {} : { search: effectiveQuery.search }),
      ...(effectiveQuery.filter?.kinds === undefined ? {} : { kinds: effectiveQuery.filter.kinds }),
    })
  } catch (error) {
    result = {
      ok: false,
      failure: {
        code: error.code || 'unavailable',
        message: error.message || String(error),
        retryable: false,
        evidenceRefs: error.evidenceRefs || [],
      },
    }
  }
  if (pageLeaving) return
  cardState.history = { query: effectiveQuery, result }
  // History can return before the base projection exists. The read is a real
  // runtime fact, so it is cached and applied onto the base when the actual
  // dashboard/event/snapshot projection arrives; it is never projected against
  // an absent base.
  if (!cardState.projection) return
  presentInteractionCard(withTaskHistory(cardState.projection, effectiveQuery, result))
}

let taskId = requestedTask
let detail
let activeInteractionId
const cardState = {
  sequence: 0,
  entries: [],
  // The base projection stays absent until an actual update exists.
  projection: null,
  history: null,
}

function updateCard(projection) {
  // A loaded history page is a real runtime fact, so rebuilding the card from
  // local interaction events must not drop it. `cardState.projection` stays the
  // base projection; the last loaded history page is re-applied on top.
  if (!projection) return
  cardState.projection = projection
  presentInteractionCard(cardState.history
    ? withTaskHistory(projection, cardState.history.query, cardState.history.result)
    : projection)
}

function appendCardEvent(kind, text, sourceKind = kind, detail = {}) {
  cardState.sequence += 1
  // The interaction id is only the one the runtime reported. The page never
  // mints a placeholder identity for an event that carries none.
  const interactionId = detail.interactionId || activeInteractionId
  cardState.entries = [
    ...cardState.entries,
    {
      sequence: cardState.sequence,
      interactionId,
      kind,
      sourceKind,
      eventKey: detail.eventKey || kind,
      text,
      ...detail,
    },
  ]
  updateCard(projectInteractionCardFromEntries(cardState.entries, activeInteractionId ? 'received' : 'awaiting-confirmation'))
}

function updateCardFromSnapshot(snapshot) {
  cardState.sequence = 0
  cardState.entries = []
  updateCard(projectInteractionCardFromSnapshot(snapshot))
}

// `renderInteraction` / `renderTask` rebuild `primary`, so the card host must be
// re-attached after every rebuild instead of being dropped.
function attachInteractionCardHost() {
  if (!pageLeaving && interactionCardHost) primary.append(interactionCardHost)
}

function readable(value, placeholder = '暂无信息') {
  if (value === undefined || value === null || value === '') return placeholder
  if (Array.isArray(value)) {
    const items = value
      .map((item) => item && typeof item === 'object' ? item.label : item)
      .filter((item) => item !== undefined && item !== null && item !== '')
    return items.length ? items.join('、') : placeholder
  }
  return String(value)
}

async function renderInteraction(interactionId, currentTaskId) {
  if (pageLeaving) return
  clearNode(primary)
  clearNode(composer)
  attachInteractionCardHost()
  // Keep the human's source text even when the interaction read fails, so an
  // error cannot replace the input with a blank primary layer.
  if (currentTaskId && currentTaskId !== 'new' && !detail) {
    detail = await api.taskDetail(currentTaskId)
    if (pageLeaving) return
  }
  const priorInput = detail?.priorInput || detail?.title
  try {
    const snapshot = await advanceExplicitInteraction(api, { interactionId })
    if (pageLeaving) return
    activeInteractionId = interactionId
    updateCardFromSnapshot(snapshot)
    productController.setInteraction({ interactionId, snapshot })
    await productController.refresh().catch(() => {})
  } catch (error) {
    if (pageLeaving) return
    productController.setInteraction({
      interactionId,
      rawInput: priorInput,
      error,
      notice: '这次交互未能打开或整理完成。',
    })
  }
}

function renderTask() {
  if (pageLeaving) return
  clearNode(primary)
  clearNode(composer)
  productController.setInteraction({})
  const heading = element('section', undefined, 'section')
  const copy = element('div')
  copy.append(element('p', 'Task Detail', 'eyebrow'), element('h2', readable(detail.title)))
  const chip = element('span', readable(detail.currentState), 'state-chip')
  chip.dataset.tone = stateTone(detail.state)
  copy.append(chip)
  heading.append(copy)
  primary.append(heading)

  const facts = element('dl', undefined, 'detail-grid')
  for (const [label, value] of [
    ['输入', detail.priorInput],
    ['调查结果', detail.investigation],
    ['建议', detail.proposal],
    ['需要你决定', detail.requiredDecisions],
    ['输出', detail.output?.summary],
    ['artifact', detail.output?.artifacts],
    ['任务观测', detail.observationRef],
    ['最近下一步', detail.nextAction],
    ['最近更新', detail.data.updatedAt ? formatTime(detail.data.updatedAt) : undefined],
  ]) {
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', readable(value)))
    facts.append(cell)
  }
  primary.append(facts)

  const actions = element('section', undefined, 'actions')
  const dashboardLink = element('a', '打开 Task Dashboard', 'button button--primary')
  // The dashboard owns the confirmed checkpoint controls, so the detail page
  // must not drop the task's projectKey/mode on the way there.
  dashboardLink.href = taskDashboardHref(taskId, explicitScope)
  const observationLink = element('a', '打开只读 Observation', 'button')
  observationLink.href = observationHref(taskId)
  actions.append(dashboardLink, observationLink)
  primary.append(actions)
  attachInteractionCardHost()
  void productController.refresh().catch(() => {})
  void loadTaskHistory()
  void refreshTaskDashboard()
}

async function load() {
  // The public new-task entry is the canonical index page, where one form
  // submit is the confirmation and the typed submit is the single creation
  // mechanism. This old alias therefore replaces itself before any runtime
  // read or business request happens here, and it submits nothing on load. An
  // explicit interaction (task=new&interaction=<id>) is not a new form and
  // stays on `renderInteraction`.
  if (isNew) {
    window.location.replace('./index.html')
    return
  }
  const { status: runtimeStatus, error } = await loadRuntimeStatus()
  if (pageLeaving) return
  renderRuntimeStatus(status, runtimeStatus, error)
  if (requestedInteraction) {
    if (taskId && taskId !== 'new') detail = await api.taskDetail(taskId)
    if (pageLeaving) return
    await renderInteraction(requestedInteraction, taskId)
    return
  }
  if (taskId && window.location.hash === '#task-interaction') {
    detail = await api.taskDetail(taskId)
    if (pageLeaving) return
    const received = await api.receiveExplicitInput({
      sourceRef: `ui:task:${taskId}`,
      rawInput: detail.priorInput || detail.title,
      inputRevision: 1,
    })
    if (pageLeaving) return
    activeInteractionId = received.interactionId
    window.history.replaceState(null, '', `./task.html?task=${encodeURIComponent(taskId)}&interaction=${encodeURIComponent(received.interactionId)}#task-interaction`)
    await renderInteraction(received.interactionId, taskId)
    return
  }
  detail = await api.taskDetail(taskId)
  if (pageLeaving) return
  renderTask()
}

void load().catch((error) => {
  if (!pageLeaving) renderPageError(status, error)
})
}
