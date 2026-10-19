import {
  api,
  clearNode,
  createScopedReadPublication,
  element,
  loadRuntimeStatus,
  makePageShell,
  mountSemanticObservationPanel,
  observationHref,
  openTechnicalDetail,
  queryParam,
  readHistoryFilters,
  readScopeLabel,
  renderContextHistory,
  renderI2BusinessCycles,
  renderI2InspectionComparison,
  renderI2InspectionOccurrences,
  renderI2MilestoneReviews,
  renderPageError,
  renderRuntimeStatus,
  renderTaskRecords,
  sameStoredRecordRef,
  stateTone,
  taskDetailHref,
  taskControlHref,
  taskIdFromQuery,
  taskReadScopeFromQuery,
  taskRowTitle,
} from './runtime-shell.js'
import {
  sameCheckpointAssetBodyAddress,
} from './runtime-api.js'
import {
  checkpointQuery,
  checkpointSelectionFromQuery,
  renderCheckpointAssetBody,
  renderCheckpointHistory,
  renderCheckpointHistoryDetail,
} from './checkpoint-history.js'
import {
  planControlErrorMessage,
  planControlKey,
  planControlPendingCopy,
  planControlResultCopy,
  renderPlanSection,
} from './plan-control.js'
import {
  commitScopedReadTransition,
  displayModeLabel,
  planHistoryAvailability,
  planHistoryScopeFailure,
  publicOutputActionCopy,
  resolveCurrentPlanRevision,
  renderTaskActualExecutionGraphSection,
  renderTaskPlanCurrentSection,
  renderTaskPlanSemanticView,
  renderTaskPublicOutputPanel,
  renderTaskDescriptionContent,
  unavailableModeFailure,
} from './task-display.js'
import {
  agentActivityQuery,
  agentActivitySelectionFromQuery,
  agentSelectionReadFailure,
  renderAgentActivity,
  renderAgentActivityDetail,
} from './agent-activity.js'
import { createSubmissionIdentity } from './requirement-submission.js'

const taskId = taskIdFromQuery(false)
const readScope = taskReadScopeFromQuery()
const explicitScope = readScope.kind === 'task' ? readScope : null
const scopeFailure = readScope.kind === 'invalid' ? readScope.failure : null
const taskGrantIntent = queryParam('control') === '1'
const ABSENT_WAITING_STATUS = '尚无执行等待信息'
const ABSENT_PLAN_CODES = new Set([
  'task-plan-history.unavailable',
  'task-plan-history.current-unknown',
])
let displayMode = 'current'

// The agent-instance selection is URL view state, decoded once through the shared
// A3 helpers with the canonical task id the parent already bound. A malformed or
// partial explicit selection is kept as an explicit failure instead of being
// dropped to the task catalog, so a bad deep link never "shows current" silently.
const canonicalTaskId = taskId ? { scope: 'task', value: taskId } : null
const initialAgentSelection = canonicalTaskId
  ? agentActivitySelectionFromQuery(new URLSearchParams(location.search), canonicalTaskId)
  : { ok: true, value: null }
let agentSelectionFailure = initialAgentSelection.ok ? undefined : initialAgentSelection.failure
let agentQuery = initialAgentSelection.ok ? requestAgentQuery(initialAgentSelection.value) : undefined
let agentViewDispose = null
let agentDetailDispose = null
let agentDetailLayer = null
let agentReadFailure
let agentReadPending = false

// The shared semantic panel keeps one live mount for the page lifetime: a
// dashboard redraw re-attaches the retained element instead of building a
// second panel and a second observation subscription.
let semanticObservationPanel = null
let semanticObservationHost = null

// The request carries only the validated agent keys; the API owner adds the
// canonical project/mode/task scope itself. An absent instance means a task
// catalog read, which sends no agent keys at all.
function requestAgentQuery(selection) {
  if (!selection) return undefined
  const encoded = agentActivityQuery(new URLSearchParams(), selection)
  if (!encoded.ok) {
    agentSelectionFailure = encoded.failure
    return undefined
  }
  return encoded.value.size ? encoded.value : undefined
}

// The authoritative reasoning history arrives inside the original Dashboard
// GET, so this page never issues a second semantic fetch. `planHistoryState` is
// that field's availability; `semantic` is offered only while it is readable.
let planHistoryState = {
  ok: false,
  failure: {
    code: 'task-plan-history.not-read',
    ownerId: 'humanagent.ui',
    message: '当前任务投影还没有成功读取。',
    nextAction: '刷新这个任务后再切换阅读方式',
  },
}
let dashboardStale = false
let dashboardFailure

// Reading-mode surface for this page. Every mode drives the one shared semantic
// panel the page mounts; the plan history and the authoritative records stay
// reachable through the explicit detail sections the panel-backed view shows.
const TASK_DISPLAY_SURFACE = {
  get supportedModes() {
    const modes = ['current']
    if (taskId) modes.push('semantic', 'actions', 'raw')
    return modes
  },
  get unavailableReasons() {
    const reasons = {}
    if (!taskId) {
      reasons.semantic = '这个页面没有 task 参数，无法挂载共享语义观测面板。'
      reasons.actions = reasons.semantic
      reasons.raw = reasons.semantic
    }
    return reasons
  },
  applyMode: (input) => applyTaskDisplayMode(input),
}

// A legal historical selection is URL view state only. It is separate from the
// checkpoint/context `viewed` keys and never changes the runtime's current plan.
function readPlanSelectionFromQuery() {
  return {
    revisionId: queryParam('planRevision') || '',
    publication: queryParam('planPublication') || '',
  }
}

function hasPlanSelection(selection) {
  return Boolean(selection && (selection.revisionId || selection.publication))
}

function planViewOptions() {
  const selection = readPlanSelectionFromQuery()
  return {
    explicitScope,
    selection: hasPlanSelection(selection) ? selection : null,
    conflictSelection: hasPlanSelection(selection) ? selection : null,
    explicitDisplay: queryParam('display') || '',
    onOpenDetail: openPlanDetail,
    onEvidenceRef: (ref, navigation) => evidenceTrigger(ref, navigation),
    onSelectRevision: (revision) => {
      updatePlanViewUrl({
        display: 'semantic',
        selection: { revisionId: revision.revisionId, publication: revision.journalCommitRef },
      })
      renderSemanticHost()
    },
  }
}

function updatePlanViewUrl({ display, selection } = {}) {
  const url = new URL(location.href)
  if (display !== undefined) {
    if (display) url.searchParams.set('display', display)
    else url.searchParams.delete('display')
  }
  if (selection === null) {
    url.searchParams.delete('planRevision')
    url.searchParams.delete('planPublication')
  } else if (selection) {
    url.searchParams.set('planRevision', selection.revisionId)
    url.searchParams.set('planPublication', selection.publication)
  }
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

// The existing contextual 技术详情 drawer is the evidence reader this surface
// supports. It shows the exact typed reference and never fabricates a
// checkpoint association or a resolvable link the runtime did not supply.
function openPlanDetail({ onBack, ...detail }, trigger) {
  const layer = openTechnicalDetail({
    ...detail,
    onClose: () => {
      if (trigger?.dataset.planDetailTrigger === 'current' && !trigger.isConnected && displayMode === 'current') {
        main.querySelector('[data-plan-detail-trigger="current"]')?.focus()
      }
    },
  })
  if (typeof onBack === 'function') {
    const back = element('button', '返回计划详情', 'button button--quiet')
    back.type = 'button'
    back.addEventListener('click', onBack)
    layer.querySelector('.shell-layer-body').append(back)
  }
}

function evidenceTrigger(ref, { onOpenDetail = openPlanDetail } = {}) {
  const button = element('button', '查看证据', 'button button--quiet plan-evidence-trigger')
  button.type = 'button'
  button.addEventListener('click', () => onOpenDetail({
    title: '证据引用',
    entries: [
      ['evidenceId', ref?.evidenceId?.value],
      ['kind', ref?.kind],
      ['source', ref?.source],
      ['locator', ref?.locator],
      ['digest', ref?.digest],
      ['scope.organId', ref?.scope?.organId?.value],
      ['scope.taskId', ref?.scope?.taskId?.value],
      ['scope.operationId', ref?.scope?.operationId?.value],
    ],
  }, button))
  return button
}

const {
  main,
  status,
  applyDisplayMode,
  initializeDisplayPreference,
  disposeDisplayPreference,
} = makePageShell(
  'Task List',
  'Task Dashboard',
  '任务看板',
  '这里显示这个任务当前的状态、执行进展、关键节点和可执行操作。',
  {
    scope: explicitScope,
    breadcrumbs: explicitScope
      ? [
          { label: '系统', href: './dashboard.html' },
          { label: '项目', href: `./tasks.html?projectKey=${encodeURIComponent(explicitScope.projectKey)}` },
          { label: '任务', href: null },
        ]
      : [
          { label: '系统', href: './dashboard.html' },
          { label: '任务', href: null },
        ],
    capabilities: explicitScope
      ? {
          onLeaveRecords: leaveRecords,
          history: true,
          onReadHistory: loadHistory,
          onLeaveHistory: leaveHistory,
        }
      : undefined,
    // Pass the surface by reference: its mode/reason getters must stay live so
    // `semantic` appears only after the authoritative history has been read.
    displaySurface: TASK_DISPLAY_SURFACE,
  },
)

let dashboard
let taskGrantControl = null
let taskGrantRead = null
let taskGrantReadState = 'idle'
let taskGrantReadError
let taskGrantReceipt
let taskGrantControlHost = null
let taskGrantEntry = null
let taskGrantDrawerOpen = false
let taskGrantDrawerDismissed = false
let taskGrantBusy = false
let stream
let closingStream = false
let subscribedOperationId
let observeTimer
let actionStatus
let taskControlError
let connectionState = 'connecting'
let lastEventAt = ''
let lastSyncAt = ''
let lastSeenSeq = 0
let historyPage = 0
const seenEventIds = new Set()

const OBSERVE_REFRESH_MS = 750
const HISTORY_PAGE_SIZE = 10
const scopedTaskRead = createScopedReadPublication((scope) => api.scopedTaskDashboard(scope))
const recordsRead = createScopedReadPublication((scope) => api.taskRecords(scope.taskId, {
  projectKey: scope.projectKey, mode: scope.mode, view: scope.view, limit: 50,
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
}))
const contextHistoryRead = createScopedReadPublication((scope) => api.taskContextHistory(scope.taskId, {
  projectKey: scope.projectKey,
  mode: scope.mode,
  ...(scope.contextViewRef ? { contextViewRef: scope.contextViewRef } : {}),
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
}))
const checkpointHistoryRead = createScopedReadPublication((scope) => api.taskCheckpointHistory(scope.taskId, {
  projectKey: scope.projectKey,
  mode: scope.mode,
  ...(scope.filters || {}),
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
  ...(scope.checkpointQuery ? { checkpointQuery: scope.checkpointQuery } : {}),
}))
const businessCyclesRead = createScopedReadPublication((scope) => api.taskBusinessCycles(scope.taskId, {
  projectKey: scope.projectKey,
  mode: scope.mode,
  ...(scope.viewed ? { viewed: scope.viewed } : {}),
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
}))
const milestoneReviewsRead = createScopedReadPublication((scope) => api.taskMilestoneReviews(scope.taskId, {
  projectKey: scope.projectKey,
  mode: scope.mode,
  ...(scope.filters || {}),
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
}))
const inspectionOccurrencesRead = createScopedReadPublication((scope) => api.taskInspectionOccurrences(scope.taskId, {
  projectKey: scope.projectKey,
  mode: scope.mode,
  ...(scope.viewed ? { viewed: scope.viewed } : {}),
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
}))
const inspectionComparisonRead = createScopedReadPublication((scope) => api.taskInspectionComparison(scope.taskId, {
  projectKey: scope.projectKey,
  mode: scope.mode,
  left: scope.filters?.left,
  right: scope.filters?.right,
}))

function leaveRecords() {
  recordsNavigationVersion += 1
  void recordsRead.refresh({ kind: 'closed' })
}

const displayModeHosts = new Map()
let recordsNavigationVersion = 0

// One-level source return for the raw reference jump. The actions host stays
// retained while raw is shown, so returning reuses its confirmed page and the
// exact trigger the user left.
let rawActionsReturn = null
let pendingRawRecordRef = null
// The plan history and the authoritative records are explicit details of the
// panel-backed perspectives. A plain perspective switch never reads records;
// an explicit open, a page turn, or a record reference jump does.
let planHistoryDetailOpen = false
let executionTraceDetailOpen = false
const recordsDetailOpen = { actions: false, raw: false }

function mountDisplayModeHost(mode) {
  const host = element('section', undefined, 'display-mode-host')
  host.dataset.displayModeHost = mode
  return host
}

function currentUnavailableFailure() {
  return {
    code: 'display-preference.current-unavailable',
    ownerId: 'humanagent.ui',
    message: '当前任务投影还没有成功读取。',
    nextAction: '刷新这个任务后再切换阅读方式',
  }
}

function staleReadFailure() {
  return dashboardFailure || {
    code: 'runtime.read.failed',
    ownerId: 'humanagent.ui',
    message: '这次任务投影刷新没有成功，保留上一次确认内容。',
    nextAction: '重试当前范围的读取',
  }
}

function panelUnavailableFailure() {
  return {
    code: 'semantic-observation.panel-unavailable',
    ownerId: 'humanagent.ui',
    message: '共享语义观测面板尚未挂载。',
    nextAction: '刷新这个任务后再切换阅读方式',
  }
}

// The retained instance is the single panel this page mounts. It follows the
// page's active perspective, so a redraw re-attaches the same host instead of
// mounting a second panel and a second observation subscription.
function syncPanelMode(mode) {
  if (!semanticObservationPanel || typeof semanticObservationPanel.setMode !== 'function') return false
  semanticObservationPanel.setMode(mode)
  return true
}

async function applyTaskDisplayMode({ mode, origin }) {
  if (mode !== 'current' && mode !== 'semantic' && mode !== 'actions' && mode !== 'raw') {
    return { ok: false, failure: unavailableModeFailure(mode, '这个页面不能渲染这层内容。') }
  }
  if (origin === 'manual' || mode === 'current' || mode === 'semantic') {
    rawActionsReturn = null
    if (origin === 'manual') pendingRawRecordRef = null
  }
  if (mode === 'current') {
    if (!dashboard) return { ok: false, failure: currentUnavailableFailure() }
    if (dashboardStale) return { ok: false, failure: staleReadFailure() }
    if (planHistoryState.ok) {
      const current = resolveCurrentPlanRevision(planHistoryState.value, { explicitScope })
      if (!current.ok) return { ok: false, failure: current.failure }
    }
    leaveRecords()
    displayMode = 'current'
    if (origin === 'manual') updatePlanViewUrl({ display: 'current', selection: null })
    renderDashboard()
    return { ok: true, mode: 'current' }
  }
  if (!dashboard) return { ok: false, failure: currentUnavailableFailure() }
  if (!semanticObservationPanel) return { ok: false, failure: panelUnavailableFailure() }
  // Every panel-backed perspective keeps the same live panel and its exact
  // range. Only the panel's own reading mode changes; the page re-presents the
  // content it already holds, and no records GET happens here.
  leaveRecords()
  displayMode = mode
  try {
    if (!syncPanelMode(mode)) return { ok: false, failure: panelUnavailableFailure() }
  } catch {
    return { ok: false, failure: panelUnavailableFailure() }
  }
  // A revision/publication deep link opens its exact plan-history detail; an
  // ordinary semantic switch keeps the detail as the user left it.
  if (mode === 'semantic' && hasPlanSelection(readPlanSelectionFromQuery())) planHistoryDetailOpen = true
  renderActiveReadingMode()
  // A raw record reference jump is an explicit detail read. The plain mode
  // switch above did not read anything.
  const rawJump = mode === 'raw' ? pendingRawRecordRef : null
  pendingRawRecordRef = null
  let receipt = { ok: true, mode }
  if (rawJump) {
    recordsDetailOpen.raw = true
    receipt = await openRecordsDetail('raw', { selectedRef: rawJump })
    if (receipt.superseded) return receipt
  }
  if (origin === 'manual' || origin === 'programmatic') {
    updatePlanViewUrl({ display: mode, selection: mode === 'semantic' ? undefined : null })
  }
  return receipt.ok ? { ok: true, mode } : receipt
}

let renderedPlanHistoryState = null
function renderSemanticHost() {
  const host = displayModeHosts.get('semantic')
  if (!host || !planHistoryState.ok) return
  clearNode(host)
  host.append(renderTaskPlanSemanticView(planHistoryState, planViewOptions()))
  host.dataset.planHistoryState = 'confirmed'
  renderedPlanHistoryState = planHistoryState
}

function renderPlanHistoryDetailSection() {
  const section = element('section', undefined, 'section display-mode-detail')
  section.dataset.planHistoryDetail = 'true'
  section.append(element('h2', '任务计划版本历史'))
  if (!planHistoryState.ok) {
    section.dataset.planHistoryState = 'unavailable'
    const notice = element('div')
    renderPageError(notice, planHistoryState.failure, '重新读取这个任务后再查看计划历史')
    section.append(notice)
    return section
  }
  section.dataset.planHistoryState = 'confirmed'
  const details = element('details', undefined, 'display-detail-fold')
  details.dataset.planHistoryFold = 'true'
  details.open = planHistoryDetailOpen
  details.append(element('summary', '权威计划版本历史'))
  details.addEventListener('toggle', () => { planHistoryDetailOpen = details.open })
  const host = displayModeHosts.get('semantic') || mountDisplayModeHost('semantic')
  displayModeHosts.set('semantic', host)
  if (host.dataset.planHistoryState !== 'confirmed'
    || (!dashboardStale && renderedPlanHistoryState !== planHistoryState)) renderSemanticHost()
  details.append(host)
  section.append(details)
  return section
}

function renderRecordsDetailSection(mode) {
  const section = element('section', undefined, 'section display-mode-detail')
  section.dataset.recordsDetail = explicitScope
    ? (recordsDetailOpen[mode] ? 'open' : 'closed')
    : 'unavailable'
  section.append(element('h2', mode === 'raw' ? '权威原始记录' : '权威动作记录'))
  if (!explicitScope) {
    section.append(element('p', '这个页面没有已确认的 task scope，无法读取动作轨迹。', 'empty'))
    return section
  }
  const host = displayModeHosts.get(mode) || mountDisplayModeHost(mode)
  displayModeHosts.set(mode, host)
  const toggle = element('button', recordsDetailOpen[mode] ? '收起权威记录' : `打开${displayModeLabel(mode)}`, 'button button--quiet')
  toggle.type = 'button'
  toggle.dataset.recordsDetailToggle = mode
  toggle.setAttribute('aria-expanded', String(recordsDetailOpen[mode]))
  toggle.addEventListener('click', () => {
    if (recordsDetailOpen[mode]) {
      recordsDetailOpen[mode] = false
      renderActiveReadingMode()
      return
    }
    void openRecordsDetail(mode)
  })
  section.append(toggle)
  if (!recordsDetailOpen[mode]) return section
  if (host.dataset.recordsState === 'pending') section.append(element('p', '正在读取权威记录…', 'muted'))
  if (mode === 'raw' && rawActionsReturn) {
    const back = element('button', '返回动作轨迹', 'button button--quiet')
    back.type = 'button'
    back.dataset.recordsReturn = 'actions'
    back.addEventListener('click', () => void returnToActionsSource())
    section.append(back)
  }
  section.append(host)
  return section
}

async function openRecordsDetail(mode, { selectedRef } = {}) {
  if (!explicitScope) {
    return {
      ok: false,
      failure: {
        code: 'read.scope.invalid',
        ownerId: 'humanagent.ui',
        message: '这个页面没有已确认的 task scope。',
        nextAction: '从项目任务行打开这个任务',
      },
    }
  }
  const navigationVersion = ++recordsNavigationVersion
  const host = displayModeHosts.get(mode) || mountDisplayModeHost(mode)
  displayModeHosts.set(mode, host)
  recordsDetailOpen[mode] = true
  // Returning to a confirmed actions page is a view switch over the retained
  // content, not a new read.
  if (mode === 'actions' && !selectedRef && host.dataset.recordsState === 'confirmed') {
    renderActiveReadingMode()
    return { ok: true, mode }
  }
  host.dataset.recordsState = 'pending'
  renderActiveReadingMode()
  const receipt = await loadRecords(mode, host, { selectedRef, navigationVersion })
  if (navigationVersion !== recordsNavigationVersion) return { ok: false, superseded: true }
  if (!receipt.ok) {
    host.dataset.recordsState = 'failed'
    renderPageError(host, receipt.failure)
    return receipt
  }
  renderActiveReadingMode()
  if (mode === 'raw' && selectedRef) {
    const selected = host.querySelector('[data-record-selected="true"]')
    selected?.focus({ preventScroll: true })
    selected?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  return { ok: true, mode }
}

async function openRawRecord(ref, trigger) {
  const sourceHost = displayModeHosts.get('actions')
  sourceHost?.querySelector('[data-records-navigation-failure]')?.remove()
  // The shell controller owns the selected mode, so the jump goes through the
  // public programmatic transition. `pendingRawRecordRef` turns that transition
  // into the one explicit raw-detail read the jump needs.
  pendingRawRecordRef = ref
  rawActionsReturn = { trigger: trigger?.focus ? trigger : null }
  recordsDetailOpen.actions = false
  const result = await applyDisplayMode('raw')
  if (!result?.ok && !result?.superseded) {
    pendingRawRecordRef = null
    rawActionsReturn = null
    // The raw read failed, so the page stays on the confirmed actions detail
    // and shows the recoverable failure there instead of a departed page.
    recordsDetailOpen.raw = false
    recordsDetailOpen.actions = true
    // The fallback is a local re-presentation of the retained actions page, so
    // it does not re-enter the controller transition.
    displayMode = 'actions'
    try {
      syncPanelMode('actions')
    } catch {
      // The failed raw read already owns the visible failure receipt.
    }
    updatePlanViewUrl({ display: 'actions', selection: null })
    renderActiveReadingMode()
    if (sourceHost?.isConnected) {
      const notice = element('div', undefined, 'records-navigation-failure')
      notice.dataset.recordsNavigationFailure = 'true'
      notice.setAttribute('role', 'alert')
      renderPageError(notice, result.failure)
      sourceHost.prepend(notice)
    }
  }
}

async function returnToActionsSource() {
  if (!rawActionsReturn) return
  recordsDetailOpen.actions = true
  recordsDetailOpen.raw = false
  const trigger = rawActionsReturn.trigger
  rawActionsReturn = null
  // Returning is a programmatic transition over the confirmed actions page, so
  // it reuses the retained content without a second read.
  const result = await applyDisplayMode('actions')
  if (result?.ok && trigger?.isConnected) trigger.focus()
}

/**
 * The selected reading mode owns what `main` shows. A background refresh
 * re-reads the task projection, so it has to re-apply the active reading mode
 * instead of forcing the dashboard back over a confirmed Actions/Raw view.
 */
function renderActiveReadingMode() {
  if (displayMode === 'current') {
    renderDashboard()
    return
  }
  renderPanelPerspectiveView(displayMode)
}

/**
 * Every non-current perspective keeps the shared panel as its reading body. The
 * plan history and the authoritative records stay readable as explicit detail
 * sections, so the original readers are preserved without bypassing the panel.
 */
function renderPanelPerspectiveView(mode) {
  if (agentViewDispose) {
    agentViewDispose()
    agentViewDispose = null
  }
  clearNode(main)
  const heading = element('section', undefined, 'page-heading')
  const copy = element('div', undefined, 'page-heading-copy')
  copy.append(element('p', '只读阅读', 'eyebrow'), element('h1', displayModeLabel(mode)))
  heading.append(copy, status, refreshButton)
  main.append(heading)
  main.append(renderSemanticObservationSection())
  main.append(mode === 'semantic' ? renderPlanHistoryDetailSection() : renderRecordsDetailSection(mode))
  const trace = element('details', undefined, 'display-detail-fold')
  trace.dataset.executionTraceDetail = 'true'
  trace.open = executionTraceDetailOpen
  trace.append(element('summary', '任务事件明细'))
  trace.addEventListener('toggle', () => { executionTraceDetailOpen = trace.open })
  trace.append(renderExecutionTraceSection())
  main.append(trace)
}

function recordsContentHasRef(content, selectedRef) {
  return (content?.raw || []).some((record) => sameStoredRecordRef(record.ref, selectedRef))
}

async function readRecordsUntilRef(view, cursor, selectedRef, navigationVersion) {
  let read = await recordsRead.refresh({
    ...explicitScope,
    view,
    ...(cursor ? { cursor } : {}),
  })
  if (navigationVersion !== recordsNavigationVersion) return { published: false }
  while (selectedRef && read.published && read.state?.content && !recordsContentHasRef(read.state.content, selectedRef)) {
    if (read.state.stale || read.state.failure) break
    if (!read.state.content.hasMore || !read.state.content.nextCursor) break
    read = await recordsRead.refresh({
      ...explicitScope,
      view,
      cursor: read.state.content.nextCursor,
    })
    if (navigationVersion !== recordsNavigationVersion) return { published: false }
  }
  if (selectedRef && read.published && !read.state?.stale && !read.state?.failure
    && read.state?.content && !recordsContentHasRef(read.state.content, selectedRef)) {
    return {
      published: true,
      reason: 'read-failed',
      state: {
        content: undefined,
        stale: false,
        failure: {
          code: 'records.ref-not-found',
          ownerId: 'humanagent.ui',
          message: '所选原始记录不在返回的记录页中。',
          nextAction: '重新读取动作轨迹并选择记录',
        },
      },
    }
  }
  return read
}

async function loadRecords(view, host, { cursor, selectedRef, navigationVersion = recordsNavigationVersion } = {}) {
  if (!explicitScope) {
    return {
      ok: false,
      failure: {
        code: 'read.scope.invalid',
        ownerId: 'humanagent.ui',
        message: '这个页面没有已确认的 task scope。',
        nextAction: '从项目任务行打开这个任务',
      },
    }
  }
  const receipt = await commitScopedReadTransition({
    read: () => readRecordsUntilRef(view, cursor, selectedRef, navigationVersion),
    build: (content) => renderTaskRecords(content, {
      view,
      ...(selectedRef ? { selectedRef } : {}),
      onNext: (nextCursor) => void loadRecords(view, host, { cursor: nextCursor }),
      onRawRef: (ref, trigger) => void openRawRecord(ref, trigger),
    }),
    commit: (staged) => {
      clearNode(host)
      host.append(staged)
      host.dataset.recordsState = 'confirmed'
    },
  })
  if (receipt.ok) return { ok: true, mode: view }
  return { ok: false, failure: receipt.failure, superseded: receipt.superseded === true }
}

// ── I5 readonly history navigation ─────────────────────────────────────────
// Checkpoint and Context history are separate scoped reads. A viewed old point
// is a read-only selection (the checkpoint target rides on the URL four-key
// query, the context target on its own `viewed` query); the current execution
// point is whatever the read returns and is never written by selecting,
// paginating, returning or closing.
let historyView = ''
let historyHost = null
let contextHistoryCursor = ''
let checkpointHistoryCursor = ''
let checkpointHistoryFilters = {}
let businessCycleCursor = ''
let viewedCycleId = ''
let milestoneReviewCursor = ''
let milestoneReviewFilters = {}
let inspectionCursor = ''
let viewedInspectionId = ''
let comparisonLeft = ''

// The checkpoint selection lives in the URL only: the old local
// `viewedCheckpointId` is gone. The frozen C5 helper encodes and decodes the four
// keys, so reload and popstate restore the exact target. The main layer and the
// shared shell detail layer each own a disposer so replacing a renderer cannot
// leave a stale listener behind.
let checkpointViewDispose = null
let checkpointRenderRead = null
let checkpointDetailDispose = null
let checkpointDetailLayer = null

function leaveHistory() {
  historyView = ''
  historyHost = null
  checkpointRenderRead = null
  contextHistoryCursor = ''
  checkpointHistoryCursor = ''
  checkpointHistoryFilters = {}
  businessCycleCursor = ''
  viewedCycleId = ''
  milestoneReviewCursor = ''
  milestoneReviewFilters = {}
  inspectionCursor = ''
  viewedInspectionId = ''
  comparisonLeft = ''
  closeCheckpointDetail()
  disposeCheckpointView()
  void contextHistoryRead.refresh({ kind: 'closed' })
  void checkpointHistoryRead.refresh({ kind: 'closed' })
  void businessCyclesRead.refresh({ kind: 'closed' })
  void milestoneReviewsRead.refresh({ kind: 'closed' })
  void inspectionOccurrencesRead.refresh({ kind: 'closed' })
  void inspectionComparisonRead.refresh({ kind: 'closed' })
}

function historyIdentityFailure(projection, expectedSurface) {
  if (projection.surface !== expectedSurface
    || projection.mode !== explicitScope.mode
    || projection.taskId?.value !== explicitScope.taskId?.value) {
    return {
      code: 'history.identity.mismatch',
      ownerId: 'humanagent.ui',
      message: '历史读取返回了其他任务、模式或 surface 的投影',
      nextAction: '重新打开该任务的历史',
    }
  }
  return null
}

// I2 history carries a task scope instead of an I5 mode/taskId pair. A missing
// or mismatched scope must never fall back to the surrounding task.
function i2IdentityFailure(projection, expectedSurface, expectedComparison) {
  if (projection.surface !== expectedSurface
    || projection.taskScope?.taskId?.value !== explicitScope.taskId?.value
    || projection.scope?.kind !== 'task'
    || projection.scope.projectKey !== explicitScope.projectKey
    || projection.scope.mode !== explicitScope.mode
    || projection.scope.taskId?.value !== explicitScope.taskId?.value) {
    return {
      code: 'history.identity.mismatch',
      ownerId: 'humanagent.ui',
      message: '历史读取返回了其他项目、任务、模式或 surface 的投影',
      nextAction: '重新打开该任务的历史',
    }
  }
  if (expectedComparison
    && (projection.left?.occurrenceId !== expectedComparison.left
      || projection.right?.occurrenceId !== expectedComparison.right)) {
    return {
      code: 'history.comparison.mismatch',
      ownerId: 'humanagent.ui',
      message: '巡检对比返回了非当前所选的巡检记录对',
      nextAction: '重新选择两次巡检后再执行对比',
    }
  }
  return null
}

const CHECKPOINT_SELECTION_NOT_CONFIRMED = Object.freeze({
  code: 'checkpoint-history.selection-not-confirmed',
  ownerId: 'humanagent.ui.checkpoint-history',
  message: '这次读取没有返回所选 checkpoint，不能把当前执行点当作该选择。',
  nextAction: '重试所选 checkpoint 读取，或清除选择并返回当前执行位置。',
})

const CHECKPOINT_HISTORY_FILTER_LABELS = Object.freeze({
  directiveRevision: '任务版本',
  executionEpoch: '执行轮次',
  cycleId: '任务周期',
  occurrenceRef: '巡检轮次',
})

function sameCommitReceipt(left, right) {
  return Boolean(left && right)
    && left.commitId === right.commitId
    && left.journalSeq === right.journalSeq
    && left.recordDigest === right.recordDigest
}

// The checkpoint projection carries its scope in `projection.scope`, not at the
// top level. A projection for another project/mode/task, or one that does not
// confirm the exact requested target, is refused as a typed failure; it is never
// rendered as this selection's content.
function checkpointReadFailure(content, requestedViewed) {
  if (content.surface !== 'runtime-checkpoint-history'
    || content.scope?.kind !== 'task'
    || content.scope.projectKey !== explicitScope.projectKey
    || content.scope.mode !== explicitScope.mode
    || content.scope.taskId?.value !== explicitScope.taskId?.value) {
    return {
      code: 'history.identity.mismatch',
      ownerId: 'humanagent.ui',
      message: '历史读取返回了其他任务、模式或 surface 的投影',
      nextAction: '重新打开该任务的历史',
    }
  }
  if (requestedViewed === undefined) return null
  const identity = content.viewed?.identity
  if (requestedViewed.checkpointId !== undefined
    && identity?.checkpointId?.value !== requestedViewed.checkpointId) {
    return CHECKPOINT_SELECTION_NOT_CONFIRMED
  }
  if (requestedViewed.commitRef !== undefined
    && !sameCommitReceipt(identity?.commitRef, requestedViewed.commitRef)) {
    return CHECKPOINT_SELECTION_NOT_CONFIRMED
  }
  return null
}

// ── exact checkpoint asset body read ───────────────────────────────────────
// The body read is bound to the exact clicked checkpoint identity, receipt and
// selector before any await. Only the serial decides whether a late response may
// still publish: back, close, level leave or a newer body read invalidates it, so
// a response can never land in a target it was not asked for.
let checkpointAssetBodySerial = 0

const CHECKPOINT_ASSET_BODY_IDENTITY_MISMATCH = Object.freeze({
  code: 'checkpoint-asset.identity-mismatch',
  ownerId: 'humanagent.ui.task-dashboard',
  message: '正文读取返回了其他检查点或资产角色的投影。',
  nextAction: '重试这次读取，或返回检查点详情核对来源。',
})

function invalidateCheckpointAssetBody() {
  checkpointAssetBodySerial += 1
}

function checkpointAssetBodyFailure(error) {
  return {
    code: error?.code ?? 'checkpoint-asset.read-failed',
    ownerId: error?.ownerId ?? 'humanagent.ui.task-dashboard',
    message: error?.message ?? '资产正文读取失败。',
    nextAction: error?.nextAction ?? '重试这次读取，或返回检查点详情核对来源。',
  }
}

function checkpointAssetBodyOptions(address) {
  return {
    element,
    onBack: () => openCheckpointDetail(),
    onRetry: () => openCheckpointAssetBody(address),
  }
}

function showCheckpointAssetBody(state, address) {
  const view = renderCheckpointAssetBody(state, checkpointAssetBodyOptions(address))
  showCheckpointDetail('资产正文', view.element, view.dispose)
}

function openCheckpointAssetBody(address) {
  if (!explicitScope || !address?.target?.commitRef || address.selector === undefined) return
  // Snapshot the clicked address so a later mutation cannot change the request.
  const frozen = {
    target: {
      checkpointId: address.target.checkpointId,
      commitRef: {
        commitId: address.target.commitRef.commitId,
        journalSeq: address.target.commitRef.journalSeq,
        recordDigest: address.target.commitRef.recordDigest,
      },
    },
    selector: address.selector,
  }
  const serial = ++checkpointAssetBodySerial
  showCheckpointAssetBody({ pending: true }, frozen)
  void readCheckpointAssetBody(frozen, serial)
}

async function readCheckpointAssetBody(address, serial) {
  const encoded = checkpointQuery(new URLSearchParams(), { viewed: address.target })
  let result
  if (!encoded.ok) {
    result = { ok: false, failure: encoded.failure }
  } else {
    try {
      const projection = await api.taskCheckpointAssetBody(explicitScope.taskId, {
        projectKey: explicitScope.projectKey,
        mode: explicitScope.mode,
        checkpointQuery: encoded.value,
        selector: address.selector,
      })
      result = { ok: true, value: projection }
    } catch (error) {
      result = { ok: false, failure: checkpointAssetBodyFailure(error) }
    }
  }
  // A closed, switched or replaced layer must not receive this response. The
  // serial covers staleness; the address check refuses a payload for another
  // checkpoint, receipt or asset role.
  if (serial !== checkpointAssetBodySerial) return
  if (result.ok && !sameCheckpointAssetBodyAddress(result.value, address)) {
    result = { ok: false, failure: CHECKPOINT_ASSET_BODY_IDENTITY_MISMATCH }
  }
  showCheckpointAssetBody(result.ok ? result : { ok: false, failure: result.failure }, address)
}

function disposeCheckpointView() {
  if (checkpointViewDispose) {
    checkpointViewDispose()
    checkpointViewDispose = null
  }
}

function closeCheckpointDetail() {
  invalidateCheckpointAssetBody()
  if (checkpointDetailDispose) {
    checkpointDetailDispose()
    checkpointDetailDispose = null
  }
  if (checkpointDetailLayer?.open) checkpointDetailLayer.close()
  checkpointDetailLayer = null
}

// Every drill-down reuses the one shell layer, so the exact checkpoint detail and
// a chosen reference share the same desktop side panel / mobile bottom drawer.
// There is no second overlay and no page-owned store.
function showCheckpointDetail(title, content, dispose) {
  if (checkpointDetailDispose) {
    checkpointDetailDispose()
    checkpointDetailDispose = null
  }
  checkpointDetailDispose = dispose ?? null
  checkpointDetailLayer = openTechnicalDetail({
    title,
    content,
    onClose: closeCheckpointDetail,
  })
}

function checkpointReferenceRows(reference) {
  const ref = reference.ref
  const rows = reference.kind === 'commit'
    ? [
        ['commitId', ref?.commitId],
        ['journalSeq', ref?.journalSeq],
        ['recordDigest', ref?.recordDigest],
      ]
    : reference.kind === 'asset'
      ? [
          ['evidenceId', ref?.ref?.evidenceId?.value],
          ['view.kind', ref?.view?.kind],
        ]
      : [
          ['evidenceId', ref?.evidenceId?.value],
          ['kind', ref?.kind],
          ['source', ref?.source],
          ['locator', ref?.locator],
          ['digest', ref?.digest],
        ]
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== '')
}

// Node, commit and evidence references have no supported exact task-scoped deep
// link yet, so the layer shows the exact typed reference and says so plainly
// instead of fabricating a URL.
function openCheckpointReference(reference) {
  invalidateCheckpointAssetBody()
  const wrap = element('div', undefined, 'checkpoint-reference')
  const back = element('button', '返回检查点详情', 'button button--quiet')
  back.type = 'button'
  back.addEventListener('click', () => openCheckpointDetail())
  const list = element('dl', undefined, 'draft-receipt')
  for (const [label, value] of checkpointReferenceRows(reference)) {
    const row = element('div')
    const detail = element('dd', String(value))
    detail.setAttribute('data-detail-label', label)
    row.append(element('dt', label), detail)
    list.append(row)
  }
  wrap.append(back, list, element('p', '没有可用的任务内深链；上面是该引用的精确内容。', 'muted'))
  showCheckpointDetail('关联引用', wrap)
}

function checkpointControlIdentity(kind) {
  const identity = createSubmissionIdentity(kind)
  return { commandId: identity.submissionId, confirmationRef: identity.confirmationRef }
}

function checkpointControlReceipt(result) {
  const receipt = result?.receipt ?? result
  if (receipt?.state === 'committed') return
  throw Object.assign(new Error('控制请求已返回，但没有显示已提交的权威收据。'), {
    code: 'checkpoint-control.no-commit-receipt',
    ownerId: 'humanagent.ui.task-dashboard',
    nextAction: '重新读取检查点，确认当前状态后再继续。',
  })
}

function checkpointControlUnavailable() {
  return Object.assign(new Error('当前页面没有已确认的任务范围或控制提交接口。'), {
    code: 'checkpoint-control.unavailable',
    ownerId: 'humanagent.ui.task-dashboard',
    nextAction: '重新打开这个任务的看板后再试。',
  })
}

function checkpointControlRefreshFailure(error, stage) {
  return Object.assign(new Error(`控制已提交，但${stage}失败：${error?.message || String(error)}`), {
    code: error?.code || 'checkpoint-control.refresh-failed',
    ownerId: error?.ownerId || 'humanagent.ui.task-dashboard',
    nextAction: error?.nextAction || '重新读取权威任务与检查点状态后再继续。',
    // The write already exists. The renderer must keep the control closed so a
    // refresh failure can never turn into a second confirmed command.
    committed: true,
  })
}

async function refreshCheckpointAfterControl() {
  const reopenDetail = checkpointDetailLayer?.open === true
  try {
    if (!historyHost) throw checkpointControlUnavailable()
    await renderCheckpointHistoryView(historyHost, true)
    if (reopenDetail) openCheckpointDetail()
  } catch (error) {
    throw checkpointControlRefreshFailure(error, '权威检查点重读')
  }
}

async function refreshDashboardAfterControl() {
  try {
    await refresh()
  } catch (error) {
    throw checkpointControlRefreshFailure(error, '任务看板刷新')
  }
}

async function submitCheckpointContextCorrection(body) {
  if (!explicitScope || typeof api.submitTaskContextCorrection !== 'function') {
    throw checkpointControlUnavailable()
  }
  const identity = checkpointControlIdentity('context-correction')
  const result = await api.submitTaskContextCorrection(explicitScope.taskId.value, {
    ...body,
    ...identity,
  }, explicitScope)
  checkpointControlReceipt(result)
  await refreshDashboardAfterControl()
  await refreshCheckpointAfterControl()
  return result
}

async function submitCheckpointReentry(body) {
  if (!explicitScope || typeof api.submitTaskCheckpointReentry !== 'function') {
    throw checkpointControlUnavailable()
  }
  const identity = checkpointControlIdentity('checkpoint-reentry')
  const result = await api.submitTaskCheckpointReentry(explicitScope.taskId.value, {
    ...body,
    ...identity,
  }, explicitScope)
  checkpointControlReceipt(result)
  await refreshDashboardAfterControl()
  await refreshCheckpointAfterControl()
  return result
}

function openCheckpointDetail() {
  if (!checkpointRenderRead) return
  invalidateCheckpointAssetBody()
  const detail = renderCheckpointHistoryDetail(checkpointRenderRead, {
    element,
    onOpenReference: openCheckpointReference,
    // A body read is bound to the exact checkpoint this detail renders, so a body
    // opened from an older read can never re-read the currently selected one.
    onReadAssetBody: (request) => openCheckpointAssetBody({
      target: request.target,
      selector: request.selector,
    }),
    onContextCorrection: submitCheckpointContextCorrection,
    onCheckpointReentry: submitCheckpointReentry,
  })
  appendCheckpointCapabilityDiagnostics(detail.element, checkpointRenderRead)
  showCheckpointDetail('检查点精确详情', detail.element, detail.dispose)
}

function checkpointDetailTrigger() {
  const button = element('button', '技术详情', 'button button--quiet')
  button.type = 'button'
  button.addEventListener('click', () => openCheckpointDetail())
  return button
}

function checkpointHistoryFiltersView(host, capabilities) {
  const filters = element('div', undefined, 'history-filters')
  for (const [name, labelText] of Object.entries(CHECKPOINT_HISTORY_FILTER_LABELS)) {
    if (capabilities?.[name]?.state !== 'available') continue
    const label = element('label', undefined, 'history-filter')
    label.append(element('span', labelText))
    const input = element('input')
    input.type = name === 'executionEpoch' ? 'number' : 'text'
    input.value = checkpointHistoryFilters[name] ?? ''
    input.dataset.filter = name
    label.append(input)
    filters.append(label)
  }
  if (filters.children.length === 0) return null
  const apply = element('button', '应用筛选', 'button button--quiet')
  apply.type = 'button'
  apply.addEventListener('click', () => {
    checkpointHistoryFilters = readHistoryFilters(filters)
    checkpointHistoryCursor = ''
    void renderCheckpointHistoryView(host, true)
  })
  filters.append(apply)
  return filters
}

function checkpointHistoryActions(host, read) {
  const actions = element('div', undefined, 'history-actions')
  const refresh = element('button', '重新读取历史', 'button button--quiet')
  refresh.type = 'button'
  refresh.addEventListener('click', () => void renderCheckpointHistoryView(host, true))
  actions.append(refresh)
  const nextCursor = read?.ok ? read.value.nextCursor : undefined
  if (nextCursor !== undefined && nextCursor !== null && nextCursor !== '') {
    const next = element('button', '继续读取下一页', 'button button--quiet')
    next.type = 'button'
    next.dataset.nextCursor = String(nextCursor)
    next.addEventListener('click', () => {
      checkpointHistoryCursor = nextCursor
      void renderCheckpointHistoryView(host, true)
    })
    actions.append(next)
  }
  return actions
}

// C5 already renders unavailable capability reasons in the shared detail.
// Unknown or malformed states stay out of the main layer and remain diagnosable here.
function appendCheckpointCapabilityDiagnostics(root, read) {
  if (!read?.ok) return
  const entries = Object.entries(read.value.capabilities ?? {})
    .filter(([, capability]) => capability?.state !== 'available' && capability?.state !== 'unavailable')
  if (entries.length === 0) return
  const section = element('section', undefined, 'history-section')
  section.append(element('h3', '筛选能力尚未确定'))
  const list = element('ul', undefined, 'history-capabilities')
  for (const [name, capability] of entries) {
    const row = element('li')
    row.dataset.capability = name
    row.dataset.capabilityState = capability?.state || 'unknown'
    row.append(
      element('strong', CHECKPOINT_HISTORY_FILTER_LABELS[name] || name),
      element('span', ` · ${capability?.reason || '读取结果未提供原因'}`),
    )
    list.append(row)
  }
  section.append(list)
  root.append(section)
}

async function loadHistory(view, host) {
  if (!explicitScope) {
    host.append(element('p', '当前页面没有已确认的 task scope，无法读取历史。', 'empty'))
    return
  }
  historyView = view
  historyHost = host
  if (view === 'context') {
    contextHistoryCursor = ''
    await renderContextHistoryView(host)
    return
  }
  if (view === 'cycles') {
    businessCycleCursor = ''
    viewedCycleId = ''
    await renderBusinessCyclesView(host)
    return
  }
  if (view === 'reviews') {
    milestoneReviewCursor = ''
    milestoneReviewFilters = {}
    await renderMilestoneReviewsView(host)
    return
  }
  if (view === 'inspections') {
    inspectionCursor = ''
    viewedInspectionId = ''
    comparisonLeft = ''
    await renderInspectionOccurrencesView(host)
    return
  }
  checkpointHistoryCursor = ''
  checkpointHistoryFilters = {}
  await renderCheckpointHistoryView(host)
}

async function renderContextHistoryView(host, keep = false) {
  if (!keep) {
    clearNode(host)
    host.append(element('p', '正在读取 Context 历史…', 'muted'))
  }
  let read
  try {
    read = await contextHistoryRead.refresh({
      ...explicitScope,
      view: 'context-history',
      ...(contextHistoryCursor ? { cursor: contextHistoryCursor } : {}),
    })
  } catch (error) {
    clearNode(host)
    renderPageError(host, error, 'inspect the scoped context history read')
    return
  }
  // A late read from a departed level must not touch the current host.
  if (!read.published) return
  clearNode(host)
  if (!read.state.content) {
    renderPageError(host, read.state.failure)
    return
  }
  const mismatch = historyIdentityFailure(read.state.content, 'runtime-context-history')
  if (mismatch) {
    renderPageError(host, mismatch)
    return
  }
  // A same-scope refresh failure keeps the last confirmed content, marked stale.
  if (read.state.stale) renderPageError(host, read.state.failure)
  host.append(renderContextHistory(read.state.content, {
    onRefresh: () => void renderContextHistoryView(host, true),
    onNext: (next) => {
      contextHistoryCursor = next
      void renderContextHistoryView(host, true)
    },
  }))
}

// Selecting or leaving a checkpoint writes the four keys into the URL and re-reads
// the same task. It is URL view state only: the call never writes current, a
// preference, or another scope's read.
function pushCheckpointSelection(viewed) {
  const encoded = checkpointQuery(new URLSearchParams(location.search), { viewed })
  if (!encoded.ok) {
    void checkpointHistoryRead.refresh({ kind: 'closed' })
    if (historyHost) mountCheckpointView(historyHost, { ok: false, failure: encoded.failure })
    return
  }
  window.history.pushState(null, '', `${location.pathname}?${encoded.value}${location.hash}`)
  if (historyHost) void renderCheckpointHistoryView(historyHost, true)
}

function mountCheckpointView(host, read) {
  disposeCheckpointView()
  checkpointRenderRead = read
  const view = renderCheckpointHistory(read, {
    element,
    onSelect: (selection) => pushCheckpointSelection(selection),
    onReturnToCurrent: () => pushCheckpointSelection(undefined),
  })
  checkpointViewDispose = view.dispose
  clearNode(host)
  const filters = read.ok ? checkpointHistoryFiltersView(host, read.value.capabilities) : null
  if (filters) host.append(filters)
  host.append(view.element)
  const actions = checkpointHistoryActions(host, read)
  actions.append(checkpointDetailTrigger())
  host.append(actions)
  // An open detail layer belongs to the previous read. Refresh it so it can never
  // show content for a selection the page no longer displays.
  if (checkpointDetailLayer?.open) openCheckpointDetail()
}

async function renderCheckpointHistoryView(host, keep = false) {
  closeCheckpointDetail()
  checkpointRenderRead = null
  disposeCheckpointView()
  if (!keep) {
    clearNode(host)
    host.append(element('p', '正在读取 Checkpoint 历史…', 'muted'))
  }
  // The URL is the single source of the viewed target. A malformed four-key
  // deep link is its own failure; the page keeps the URL and never issues a
  // fallback read that would silently show the authoritative current.
  const selection = checkpointSelectionFromQuery(new URLSearchParams(location.search))
  const encoded = selection.ok
    ? checkpointQuery(new URLSearchParams(), { viewed: selection.value.viewed })
    : selection
  if (!encoded.ok) {
    await checkpointHistoryRead.refresh({ kind: 'closed' })
    mountCheckpointView(host, { ok: false, failure: encoded.failure })
    return
  }
  const requestedViewed = selection.value.viewed
  let read
  try {
    read = await checkpointHistoryRead.refresh({
      ...explicitScope,
      view: 'checkpoint-history',
      ...(Object.keys(checkpointHistoryFilters).length ? { filters: checkpointHistoryFilters } : {}),
      ...(checkpointHistoryCursor ? { cursor: checkpointHistoryCursor } : {}),
      ...(encoded.value.size ? { checkpointQuery: encoded.value } : {}),
    })
  } catch (error) {
    clearNode(host)
    renderPageError(host, error, 'inspect the scoped checkpoint history read')
    return
  }
  // A late read from a departed level or an older selection must not publish.
  if (!read.published) return
  // A failed, stale or unconfirmed read must not let older content impersonate
  // the requested selection: the renderer receives the typed failure instead.
  const failure = read.state.stale || read.state.failure || !read.state.content
    ? read.state.failure
    : checkpointReadFailure(read.state.content, requestedViewed)
  mountCheckpointView(host, failure ? { ok: false, failure } : { ok: true, value: read.state.content })
}

async function renderBusinessCyclesView(host, keep = false) {
  if (!keep) {
    clearNode(host)
    host.append(element('p', '正在读取业务周期…', 'muted'))
  }
  let read
  try {
    read = await businessCyclesRead.refresh({
      ...explicitScope,
      view: 'business-cycles',
      ...(viewedCycleId ? { viewed: viewedCycleId } : {}),
      ...(businessCycleCursor ? { cursor: businessCycleCursor } : {}),
    })
  } catch (error) {
    clearNode(host)
    renderPageError(host, error, 'inspect the business cycle read')
    return
  }
  if (!read.published) return
  clearNode(host)
  if (!read.state.content) {
    renderPageError(host, read.state.failure)
    return
  }
  const mismatch = i2IdentityFailure(read.state.content, 'runtime-business-cycles')
  if (mismatch) {
    renderPageError(host, mismatch)
    return
  }
  if (read.state.stale) renderPageError(host, read.state.failure)
  host.append(renderI2BusinessCycles(read.state.content, {
    onRefresh: () => void renderBusinessCyclesView(host, true),
    onNext: (next) => {
      businessCycleCursor = next
      void renderBusinessCyclesView(host, true)
    },
  }))
}

async function renderMilestoneReviewsView(host, keep = false) {
  if (!keep) {
    clearNode(host)
    host.append(element('p', '正在读取里程碑评审…', 'muted'))
  }
  let read
  try {
    read = await milestoneReviewsRead.refresh({
      ...explicitScope,
      view: 'milestone-reviews',
      ...(Object.keys(milestoneReviewFilters).length ? { filters: milestoneReviewFilters } : {}),
      ...(milestoneReviewCursor ? { cursor: milestoneReviewCursor } : {}),
    })
  } catch (error) {
    clearNode(host)
    renderPageError(host, error, 'inspect the milestone review read')
    return
  }
  if (!read.published) return
  clearNode(host)
  if (!read.state.content) {
    renderPageError(host, read.state.failure)
    return
  }
  const mismatch = i2IdentityFailure(read.state.content, 'runtime-milestone-reviews')
  if (mismatch) {
    renderPageError(host, mismatch)
    return
  }
  if (read.state.stale) renderPageError(host, read.state.failure)
  host.append(renderI2MilestoneReviews(read.state.content, {
    filters: milestoneReviewFilters,
    onRefresh: () => void renderMilestoneReviewsView(host, true),
    onFilter: (filters) => {
      milestoneReviewFilters = filters
      milestoneReviewCursor = ''
      void renderMilestoneReviewsView(host, true)
    },
    onNext: (next) => {
      milestoneReviewCursor = next
      void renderMilestoneReviewsView(host, true)
    },
  }))
}

async function renderInspectionOccurrencesView(host, keep = false) {
  if (!keep) {
    clearNode(host)
    host.append(element('p', '正在读取巡检记录…', 'muted'))
  }
  let read
  try {
    read = await inspectionOccurrencesRead.refresh({
      ...explicitScope,
      view: 'inspection-occurrences',
      ...(viewedInspectionId ? { viewed: viewedInspectionId } : {}),
      ...(inspectionCursor ? { cursor: inspectionCursor } : {}),
    })
  } catch (error) {
    clearNode(host)
    renderPageError(host, error, 'inspect the inspection occurrence read')
    return
  }
  if (!read.published) return
  clearNode(host)
  if (!read.state.content) {
    renderPageError(host, read.state.failure)
    return
  }
  const mismatch = i2IdentityFailure(read.state.content, 'runtime-inspection-occurrences')
  if (mismatch) {
    renderPageError(host, mismatch)
    return
  }
  if (read.state.stale) renderPageError(host, read.state.failure)
  host.append(renderI2InspectionOccurrences(read.state.content, {
    comparisonLeft,
    onRefresh: () => void renderInspectionOccurrencesView(host, true),
    onSelectCompare: (occurrenceId) => {
      comparisonLeft = occurrenceId
      void renderInspectionOccurrencesView(host, true)
    },
    onCompare: (left, right) => {
      comparisonLeft = ''
      void renderInspectionComparisonView(host, left, right)
    },
    onNext: (next) => {
      inspectionCursor = next
      void renderInspectionOccurrencesView(host, true)
    },
  }))
}

async function renderInspectionComparisonView(host, left, right) {
  clearNode(host)
  host.append(element('p', '正在对比巡检记录…', 'muted'))
  let read
  try {
    read = await inspectionComparisonRead.refresh({
      ...explicitScope,
      view: 'inspection-comparison',
      filters: { left, right },
    })
  } catch (error) {
    clearNode(host)
    renderPageError(host, error, 'inspect the inspection comparison read')
    return
  }
  if (!read.published) return
  clearNode(host)
  if (!read.state.content) {
    renderPageError(host, read.state.failure)
    return
  }
  const mismatch = i2IdentityFailure(read.state.content, 'runtime-inspection-comparison', { left, right })
  if (mismatch) {
    renderPageError(host, mismatch)
    return
  }
  if (read.state.stale) renderPageError(host, read.state.failure)
  host.append(renderI2InspectionComparison(read.state.content, {
    onRefresh: () => void renderInspectionComparisonView(host, left, right),
    onBack: () => {
      comparisonLeft = ''
      void renderInspectionOccurrencesView(host)
    },
  }))
}

function formatPreciseTime(value) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function setRefreshError(error) {
  renderPageError(status, error)
}

function isReplay(event) {
  if (event.seq != null && event.seq <= lastSeenSeq) return true
  if (event.eventId && seenEventIds.has(event.eventId)) return true
  return false
}

function rememberEvent(event) {
  if (event.seq != null) lastSeenSeq = Math.max(lastSeenSeq, event.seq)
  if (event.eventId) seenEventIds.add(event.eventId)
}

function shouldObserveActiveState() {
  return ['created', 'admitted', 'running', 'settling'].includes(dashboard.state)
    && !dashboard.operationId
}

function visibleRecentEvents(events) {
  return events.filter((event) => event.kind !== 'provider.model' || (event.summary && event.summary !== 'model'))
}

function isRequestStart(event) {
  return event.kind === 'provider.model' && event.summary === 'provider requested model work'
}

function eventIdentity(event) {
  return event.eventId ?? String(event.seq ?? '')
}

function historyChunks(events) {
  const turns = []
  let current
  let modelTurn = 0
  for (const event of events) {
    const requestStart = isRequestStart(event)
    if (requestStart) modelTurn += 1
    if (!current || requestStart) {
      current = {
        label: requestStart ? '模型轮次' : '任务事件',
        turnNumber: requestStart ? modelTurn : 0,
        events: [],
      }
      turns.push(current)
    }
    current.events.push(event)
  }
  return turns.flatMap((turn) => {
    const chunks = []
    for (let index = 0; index < turn.events.length; index += HISTORY_PAGE_SIZE) {
      chunks.push({
        label: turn.label,
        turnNumber: turn.turnNumber,
        events: turn.events.slice(index, index + HISTORY_PAGE_SIZE),
      })
    }
    return chunks
  })
}

function connectionText() {
  const syncedAt = lastSyncAt ? formatPreciseTime(lastSyncAt) : '尚未同步'
  if (explicitScope) return `只读范围 · 最近同步 ${syncedAt}`
  const eventAge = lastEventAt ? ageText(lastEventAt) : '尚无业务事件'
  if (taskSettled()) {
    return `执行已收拢 · 最近同步 ${syncedAt} · 最近业务事件 ${eventAge}`
  }
  if (connectionState === 'disconnected') {
    return `实时连接已断开 · 最近同步 ${syncedAt} · 最近业务事件 ${eventAge}`
  }
  if (connectionState === 'connected') {
    return `实时连接已建立 · 最近同步 ${syncedAt} · 最近业务事件 ${eventAge}`
  }
  return '正在连接实时事件流 · 尚未同步'
}

function taskSettled() {
  if (!dashboard) return false
  return ['succeeded', 'failed'].includes(dashboard.state)
    || (['stopped', 'cancelled'].includes(dashboard.state) && Boolean(dashboard.checkpoint))
}

function businessStateLabel() {
  if (!dashboard) return '未知'
  if ((dashboard.state === 'stopped' || dashboard.state === 'cancelled') && !dashboard.checkpoint) {
    return '停止请求已受理'
  }
  return dashboard.stateLabel
}

function ageText(since) {
  const delta = Date.now() - new Date(since).getTime()
  if (Number.isNaN(delta)) return '未知'
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return '< 1 分钟'
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.floor(minutes / 60)} 小时前`
}

function markSync() {
  lastSyncAt = new Date().toISOString()
  if (dashboard.history?.events?.length) {
    const newest = dashboard.history.events.reduce((max, event) => (
      String(event.occurredAt) > String(max) ? event.occurredAt : max
    ), '')
    if (newest) lastEventAt = newest
  }
}

const STOP_ACTION_LABEL = '停止本次执行'
const RETRY_STOP_ACTION_LABEL = '重试停止'
const START_ACTION_LABEL = '处理任务'
const GRANT_CONTROL_FAILURE_COPY = '执行授权处理未完成；请打开技术详情查看原因。'

function actionCopy() {
  if (dashboard.state === 'succeeded') {
    return publicOutputActionCopy({ output: dashboard.output, publication: dashboard.publicOutput })
  }
  if (dashboard.state === 'stopped') {
    const planNote = dashboard.plan?.state === 'active'
      ? `计划仍保持生效；下次到期：${dashboard.plan.nextDueAt ? formatPreciseTime(dashboard.plan.nextDueAt) : '未提供'}。需要暂停或取消后续执行，请展开“任务计划”并使用计划控制。`
      : ''
    return dashboard.checkpoint
      ? `本次执行已停止，停止结果已保存。${planNote}`
      : `停止请求已受理，尚未确认停止完成。${planNote}`
  }
  if (dashboard.state === 'blocked') return '执行失败或受阻，仍在释放资源；请按详情中的恢复动作处理。'
  if (dashboard.state === 'failed') return '执行失败，请打开技术详情查看原因和处理建议。'
  if (dashboard.allowedActions.includes('start')) return `当前没有正在运行的执行；可以使用“${START_ACTION_LABEL}”发起新的处理。`
  const actionLabels = []
  if (dashboard.allowedActions.includes('stop')) actionLabels.push(STOP_ACTION_LABEL)
  if (dashboard.allowedActions.includes('retry-stop')) actionLabels.push(RETRY_STOP_ACTION_LABEL)
  return actionLabels.length > 0
    ? `当前可用操作：${actionLabels.join('、')}。`
    : '当前没有本页可执行的操作；请等待收拢或打开技术详情查看原因。'
}

// The plan surface is owned by `plan-control.js`, which renders the durable
// `SubscriptionState` verbatim. This page decides only which of the read's own
// control facts are available and routes one click to one plan-scoped control
// request.
const PLAN_ACTION_FIELDS = {
  pause: 'canPause',
  resume: 'canResume',
  'cancel-future': 'canCancelFuture',
}

let planControlNotice = ''
let planControlError

/**
 * The dashboard read states the control facts as booleans. Only `true` is an
 * available action: an absent or false fact offers no control.
 */
function planAvailableActions(plan) {
  return Object.entries(PLAN_ACTION_FIELDS)
    .filter(([, field]) => plan[field] === true)
    .map(([action]) => action)
}

async function runPlanControl(subscriptionId, action) {
  planControlNotice = planControlPendingCopy(action)
  planControlError = undefined
  renderActiveReadingMode()
  try {
    const result = await api.planControl(subscriptionId, {
      action,
      idempotencyKey: planControlKey(subscriptionId, action),
      requestedAt: new Date().toISOString(),
    })
    planControlNotice = planControlResultCopy(action, result)
    await refresh()
  } catch (error) {
    // A typed rejection is a real outcome, not a hidden failure: the re-read
    // keeps the page truthful about the plan the runtime still reports, and the
    // rejection itself stays available so a session error still offers pairing.
    planControlNotice = planControlErrorMessage(error)
    planControlError = error
    renderActiveReadingMode()
    await refresh().catch(setRefreshError)
  }
}

function renderTaskPlanSection(plan) {
  return renderPlanSection(
    { ...plan, availableActions: explicitScope ? [] : planAvailableActions(plan) },
    {
      notice: planControlNotice || undefined,
      ...(planControlError === undefined ? {} : { error: planControlError }),
      onControl: (action) => runPlanControl(plan.subscriptionId, action),
    },
  )
}

function stopObserving() {
  if (observeTimer) {
    clearTimeout(observeTimer)
    observeTimer = 0
  }
}

function scheduleObservation() {
  stopObserving()
  if (!shouldObserveActiveState()) return
  observeTimer = setTimeout(() => {
    observeTimer = 0
    void refresh().catch(setRefreshError)
  }, OBSERVE_REFRESH_MS)
}

/**
 * The agent-activity surface is rendered only from a supplied read. With no
 * producer field there is no invented history and no entry. A supplied failure
 * stays an explicit semantic-unavailable alert, and a bad explicit URL selection
 * stays visible instead of falling back to the task catalog.
 */
function renderAgentActivitySection() {
  if (agentSelectionFailure) {
    const section = element('section', undefined, 'section agent-activity-section')
    section.dataset.agentActivity = 'selection-failed'
    section.append(element('h2', '执行实例 / 处理经过'))
    renderPageError(section, agentSelectionFailure, '重新选择完整的运行实例或返回任务实例列表')
    return section
  }
  if (agentReadPending) {
    const section = element('section', undefined, 'section agent-activity-section')
    section.dataset.agentActivity = 'pending'
    section.append(
      element('h2', '执行实例 / 处理经过'),
      element('p', '正在读取所选运行实例…', 'muted'),
    )
    return section
  }
  const read = dashboard?.agentActivity
  const readFailure = agentReadFailure || agentSelectionReadFailure(agentQuery, read)
  if (!read && !readFailure) return null
  const section = element('section', undefined, 'section agent-activity-section')
  if (readFailure) {
    section.dataset.agentActivity = 'failed'
    section.append(element('h2', '执行实例 / 处理经过'))
    renderPageError(section, readFailure, '重试所选实例读取，或返回任务实例列表')
    return section
  }
  section.dataset.agentActivity = read.ok ? (read.value?.mode || 'read') : 'failed'
  section.append(element('h2', '执行实例 / 处理经过'))
  const view = renderAgentActivity(read, {
    element,
    onSelect: (selection) => void selectAgentInstance(selection),
    ...(read.ok && read.value?.mode === 'selected' ? { onOpenDetail: openAgentDetail } : {}),
  })
  agentViewDispose = view.dispose
  section.append(view.element)
  return section
}

// The actual execution graph is a task-level attachment on the successful
// activity read. Pending or failed activity reads keep their own explicit state
// and never render an older graph in their place.
function renderActualExecutionGraphSection() {
  if (agentSelectionFailure || agentReadPending || agentReadFailure) return null
  const read = dashboard?.agentActivity
  if (!read || read.ok !== true || !read.value?.actualExecutionGraph) return null
  return renderTaskActualExecutionGraphSection(read.value.actualExecutionGraph, {
    onOpenDetail: openTechnicalDetail,
  })
}

// Selecting an instance is URL view state plus a re-read of the same task. It
// never writes control state, a preference, or a second scope's read.
async function selectAgentInstance(selection) {
  const full = agentActivityQuery(new URLSearchParams(location.search), selection)
  const request = agentActivityQuery(new URLSearchParams(), selection)
  if (!full.ok || !request.ok) {
    agentSelectionFailure = full.failure || request.failure
    renderActiveReadingMode()
    return
  }
  agentSelectionFailure = undefined
  agentQuery = request.value.size ? request.value : undefined
  closeAgentDetail()
  agentReadPending = true
  agentReadFailure = undefined
  window.history.replaceState(null, '', `${location.pathname}?${full.value}${location.hash}`)
  if (dashboard) renderActiveReadingMode()
  try {
    await refresh()
  } catch (error) {
    agentReadFailure = error
    setRefreshError(error)
  } finally {
    agentReadPending = false
    if (dashboard) renderActiveReadingMode()
  }
}

function referenceRows(payload) {
  const selection = payload.selection || {}
  const rows = [
    ['实例类型', selection.instance?.kind === 'native-execution' ? '原生执行' : '运行实例'],
    ['assignmentId', selection.assignmentId],
    ['attempt', selection.attempt],
  ]
  if (payload.kind === 'node') rows.push(['nodeId', payload.nodeId])
  if (payload.kind === 'commit') rows.push(
    ['commitId', payload.commitRef?.commitId],
    ['journalSeq', payload.commitRef?.journalSeq],
    ['recordDigest', payload.commitRef?.recordDigest],
  )
  if (payload.kind === 'evidence') rows.push(
    ['evidenceId', payload.evidenceRef?.evidenceId?.value],
    ['kind', payload.evidenceRef?.kind],
    ['source', payload.evidenceRef?.source],
    ['locator', payload.evidenceRef?.locator],
    ['digest', payload.evidenceRef?.digest],
  )
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== '')
}

// Node, commit and evidence references have no supported exact task-scoped deep
// link yet, so the layer shows the exact typed reference and says so plainly
// instead of fabricating a URL.
function agentReferenceDetail(payload) {
  const wrap = element('div', undefined, 'agent-activity-reference')
  const back = element('button', '返回实例详情', 'button button--quiet')
  back.type = 'button'
  back.addEventListener('click', () => openAgentDetail({ kind: 'activity', selection: payload.selection }))
  const list = element('dl', undefined, 'draft-receipt')
  for (const [label, value] of referenceRows(payload)) {
    const row = element('div')
    const detail = element('dd', String(value))
    detail.setAttribute('data-detail-label', label)
    row.append(element('dt', label), detail)
    list.append(row)
  }
  wrap.append(back, list, element('p', '没有可用的任务内深链；上面是该引用的精确内容。', 'muted'))
  return wrap
}

function closeAgentDetail() {
  if (agentDetailDispose) {
    agentDetailDispose()
    agentDetailDispose = null
  }
  if (agentDetailLayer?.open) agentDetailLayer.close()
  agentDetailLayer = null
}

// One shared shell layer hosts every drill-down: this page never opens a second
// overlay. The A3 module only builds content; focus and close stay with the shell.
function openAgentDetail(payload) {
  if (!payload || !payload.selection) return
  closeAgentDetail()
  if (payload.kind === 'activity') {
    const read = dashboard?.agentActivity
    if (!read) return
    const detail = renderAgentActivityDetail(read, {
      element,
      onSelect: (selection) => void selectAgentInstance(selection),
      onOpenDetail: openAgentDetail,
    })
    agentDetailDispose = detail.dispose
    agentDetailLayer = openTechnicalDetail({
      title: '运行实例详情',
      content: detail.element,
      onClose: closeAgentDetail,
    })
    return
  }
  agentDetailLayer = openTechnicalDetail({
    title: '关联引用',
    content: agentReferenceDetail(payload),
    onClose: closeAgentDetail,
  })
}

function controlTaskIdValue(value) {
  return value && typeof value === 'object' ? value.value : value
}

function taskGrantTargetMatches(read = taskGrantRead) {
  if (!explicitScope || !read) return false
  return controlTaskIdValue(read.taskId) === taskId
    && read.targetScope?.projectKey === explicitScope.projectKey
    && read.targetScope?.mode === explicitScope.mode
}

function taskGrantStatusCopy() {
  if (taskGrantReadState === 'pending') return '正在读取最新控制状态…'
  if (taskGrantReadState === 'unconfirmed') {
    return taskGrantReceipt
      ? '上次操作已记录，最新状态暂不能确认。'
      : '最新控制状态暂不能确认；先前没有控制命令回执，授权操作不可用。'
  }
  if (taskGrantReadState === 'target-unverified') return '控制目标未验证，授权操作不可用。'
  if (taskGrantReadState === 'unavailable') {
    if (taskGrantReadError?.status === 400) return '控制范围不完整，未发送控制请求。'
    return taskGrantReadError
      ? '控制状态暂时不可用，授权操作不可用。'
      : '尚未读取控制状态。'
  }
  if (taskGrantReadState !== 'ready') return '尚未读取控制状态。'
  const grant = taskGrantRead?.readback?.grant
  if (grant?.state === 'granted') return '最新状态已确认：执行授权有效。'
  if (grant?.state === 'revoked') return '最新状态已确认：执行授权已撤销。'
  return '最新状态已确认：当前没有执行授权。'
}

function taskGrantReceiptCopy() {
  if (!taskGrantReceipt) return '尚未提交控制命令。'
  const execution = taskGrantReceipt.execution
  if (execution?.state === 'blocked') {
    return '上次控制命令已记录，但执行未完成；请核对技术详情中的原错误与下一步。'
  }
  if (taskGrantReceipt.code) return '上次控制命令已记录；执行结果需要核对。'
  return '上次控制命令已记录。'
}

function taskGrantTechnicalEntries() {
  const grant = taskGrantRead?.readback?.grant
  const execution = taskGrantReceipt?.execution
  return [
    ['targetScope.projectKey', taskGrantRead?.targetScope?.projectKey],
    ['targetScope.mode', taskGrantRead?.targetScope?.mode],
    ['taskId', controlTaskIdValue(taskGrantRead?.taskId)],
    ['readback.commitId', taskGrantRead?.readback?.commit?.commitId],
    ['readback.grant.revision', grant?.revision],
    ['readback.grant.state', grant?.state],
    ['readback.grant.owner', grant?.owner],
    ['authority', taskGrantRead?.authority === undefined ? undefined : JSON.stringify(taskGrantRead.authority)],
    ['read.error.code', taskGrantReadError?.code],
    ['read.error.ownerId', taskGrantReadError?.ownerId],
    ['read.error.message', taskGrantReadError?.message],
    ['read.error.nextAction', taskGrantReadError?.nextAction],
    ['execution.state', execution?.state],
    ['execution.current.state', execution?.current?.state],
    ['execution.current.error.code', execution?.current?.error?.code],
    ['execution.current.error.message', execution?.current?.error?.message],
    ['execution.current.nextStep', execution?.current?.nextStep],
    ['execution.apiError.code', execution?.apiError?.code],
    ['execution.apiError.message', execution?.apiError?.message],
    ['execution.error.code', execution?.error?.code],
    ['execution.error.ownerId', execution?.error?.ownerId],
    ['execution.error.message', execution?.error?.message],
    ['execution.error.nextAction', execution?.error?.nextAction],
    ['error.code', taskGrantReceipt?.error?.code],
    ['error.ownerId', taskGrantReceipt?.error?.ownerId],
    ['error.message', taskGrantReceipt?.error?.message],
    ['error.nextAction', taskGrantReceipt?.error?.nextAction],
    ['apiError.code', taskGrantReceipt?.apiError?.code],
    ['apiError.message', taskGrantReceipt?.apiError?.message],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
}

function renderTaskGrantControlInto(host) {
  if (!host) return
  clearNode(host)
  const section = element('section', undefined, 'section')
  section.dataset.taskGrantControl = 'true'
  section.dataset.controlState = taskGrantReadState === 'ready' ? 'ready' : 'unavailable'
  section.append(element('h2', '任务控制 / 执行授权'))
  const panel = element('div', undefined, 'panel')
  const actions = element('div', undefined, 'actions')
  const grant = taskGrantRead?.readback?.grant
  const confirmed = taskGrantReadState === 'ready'

  const grantButton = element('button', '授权执行', 'button button--primary')
  grantButton.type = 'button'
  grantButton.dataset.taskGrantAction = 'grant'
  grantButton.disabled = !confirmed || taskGrantBusy || grant?.state === 'granted'
  grantButton.addEventListener('click', () => void runTaskGrantCommand('grant'))

  const revokeButton = element('button', '撤销执行授权', 'button button--danger')
  revokeButton.type = 'button'
  revokeButton.dataset.taskGrantAction = 'revoke'
  revokeButton.disabled = !confirmed || taskGrantBusy || grant?.state !== 'granted'
  revokeButton.addEventListener('click', () => void runTaskGrantCommand('revoke'))
  actions.append(grantButton, revokeButton)

  const actionStatus = element('p', taskGrantStatusCopy(), 'muted')
  actionStatus.dataset.taskGrantActionStatus = 'true'
  actionStatus.setAttribute('role', 'status')
  actionStatus.setAttribute('aria-live', 'polite')
  const receipt = element('p', taskGrantReceiptCopy(), 'muted')
  receipt.dataset.taskGrantReceipt = 'true'
  const technical = element('button', '查看控制技术详情', 'button button--quiet')
  technical.type = 'button'
  technical.dataset.taskGrantTechnical = 'true'
  technical.addEventListener('click', () => openTechnicalDetail({
    title: '任务控制技术详情',
    entries: taskGrantTechnicalEntries(),
    onClose: () => {
      if (!taskGrantIntent) return
      openTaskGrantControl()
      taskGrantControlHost?.querySelector('[data-task-grant-technical]')?.focus()
    },
  }))
  panel.append(actions, actionStatus, receipt, technical)
  section.append(panel)
  host.append(section)
}

function openTaskGrantControl() {
  if (!taskGrantIntent || !explicitScope) return
  taskGrantDrawerDismissed = false
  if (!taskGrantControlHost || !taskGrantControlHost.isConnected) {
    taskGrantControlHost = element('div')
    taskGrantControlHost.dataset.taskGrantControlHost = 'true'
  }
  renderTaskGrantControlInto(taskGrantControlHost)
  taskGrantDrawerOpen = true
  const detail = openTechnicalDetail({
    title: '任务控制 / 执行授权',
    content: taskGrantControlHost,
    onClose: () => {
      taskGrantDrawerOpen = false
      taskGrantDrawerDismissed = true
      if (taskGrantEntry?.isConnected) taskGrantEntry.focus()
    },
  })
  detail.dataset.taskGrantControlDrawer = 'true'
}

async function refreshTaskGrantControl() {
  if (!taskGrantIntent) return
  if (!explicitScope) {
    taskGrantRead = null
    taskGrantReadState = 'unavailable'
    taskGrantReadError = scopeFailure ?? {
      code: 'read.scope.invalid',
      ownerId: 'humanagent.ui',
      message: '任务控制需要 task、projectKey 和 mode。',
      nextAction: '从正式任务导航重新打开任务控制。',
    }
    return
  }
  const previousRead = taskGrantRead
  taskGrantReadState = 'pending'
  taskGrantReadError = undefined
  renderTaskGrantControlInto(taskGrantControlHost)
  try {
    taskGrantRead = await api.readTaskGrant(taskId, {
      projectKey: explicitScope.projectKey,
      mode: explicitScope.mode,
    })
    taskGrantReadState = taskGrantTargetMatches() ? 'ready' : 'unconfirmed'
  } catch (error) {
    taskGrantRead = error?.status === 409 || error?.status === 400 ? null : previousRead
    taskGrantReadState = error?.status === 409 ? 'target-unverified'
      : error?.status === 400 ? 'unavailable'
        : taskGrantReceipt ? 'unconfirmed' : 'unavailable'
    taskGrantReadError = error
  }
  renderTaskGrantControlInto(taskGrantControlHost)
}

async function runTaskGrantCommand(action) {
  if (!explicitScope || taskGrantReadState !== 'ready' || taskGrantBusy) return
  const grant = taskGrantRead?.readback?.grant
  const expectedRevision = action === 'revoke' ? grant?.revision : grant?.revision ?? 0
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return
  const scope = { projectKey: explicitScope.projectKey, mode: explicitScope.mode }
  taskGrantBusy = true
  taskGrantReadError = undefined
  renderTaskGrantControlInto(taskGrantControlHost)
  const input = {
    requestId: `control:${action}:task-dashboard:${Date.now()}`,
    expectedRevision,
  }
  try {
    const receipt = action === 'grant'
      ? await api.grantTaskControl(taskId, input, scope)
      : await api.revokeTaskGrant(taskId, input, scope)
    taskGrantReceipt = receipt
    taskGrantBusy = false
    try {
      await refreshTaskGrantControl()
    } catch (error) {
      taskGrantReadError = error
      taskGrantReadState = 'unconfirmed'
    }
    renderTaskGrantControlInto(taskGrantControlHost)
  } catch (error) {
    taskGrantBusy = false
    if (error?.status) {
      taskGrantReceipt = {
        code: error.code,
        ownerId: error.ownerId,
        message: error.message,
        nextAction: error.nextAction,
        execution: error?.execution,
        apiError: error?.apiError,
      }
    }
    taskGrantReadError = error
    taskGrantReadState = error?.execution?.state === 'blocked' ? 'ready' : 'unconfirmed'
    renderTaskGrantControlInto(taskGrantControlHost)
  }
}

// A plan history the projection never returned, or a history without a known
// current revision, is an optional absence on the current surface. Real plan
// read failures keep their visible alert; the exact absence code and recovery
// text stay readable in the existing technical detail.
function absentPlanFailure(read) {
  const state = read?.ok === true
    ? resolveCurrentPlanRevision(read.value, { explicitScope })
    : read
  if (state?.ok === true) return undefined
  return ABSENT_PLAN_CODES.has(state?.failure?.code) ? state.failure : undefined
}

function renderDashboardDetailFold(label, content, open = false) {
  const details = element('details', undefined, 'display-detail-fold')
  details.open = open === true
  details.append(element('summary', label), content)
  return details
}

function renderDashboard() {
  if (!dashboard) return
  if (agentViewDispose) {
    agentViewDispose()
    agentViewDispose = null
  }
  clearNode(main)

  const heading = element('section', undefined, 'page-heading')
  const copy = element('div', undefined, 'page-heading-copy')
  const titleBlock = element('div', undefined, 'task-title-block')
  titleBlock.append(element('h1', taskRowTitle(dashboard), 'task-title task-title-current'))
  const fullBrief = element('button', '查看完整任务说明', 'button button--quiet')
  fullBrief.type = 'button'
  fullBrief.addEventListener('click', () => {
    const content = element('div')
    if (dashboard.taskTitle && dashboard.taskTitle !== taskRowTitle(dashboard) && dashboard.taskTitle !== dashboard.input) {
      content.append(element('h3', '原始任务名称'), element('p', dashboard.taskTitle, 'business-output-text'))
    }
    content.append(renderTaskDescriptionContent({ input: dashboard.input }))
    openTechnicalDetail({ title: '任务说明', eyebrow: '任务说明', content })
  })
  titleBlock.append(fullBrief)
  copy.append(element('p', '当前任务', 'eyebrow'), titleBlock)
  const stateChip = element('span', businessStateLabel(), 'state-chip')
  stateChip.dataset.tone = stateTone(dashboard.state)
  copy.append(stateChip)
  if (explicitScope) {
    const breadcrumbs = element('nav', undefined, 'breadcrumbs')
    breadcrumbs.setAttribute('aria-label', '范围面包屑')
    const system = element('a', '全部项目')
    system.href = './tasks.html'
    const project = element('a', '所属项目')
    project.href = `./tasks.html?projectKey=${encodeURIComponent(explicitScope.projectKey)}`
    breadcrumbs.append(system, project, element('span', '当前任务'))
    copy.append(breadcrumbs)
  }
  if (explicitScope) {
    const control = element('button', '任务控制 / 执行授权', 'button button--quiet')
    control.dataset.taskGrantControlEntry = 'entry'
    control.setAttribute('aria-haspopup', 'dialog')
    control.addEventListener('click', () => {
      if (!taskGrantIntent) {
        location.assign(taskControlHref(explicitScope.taskId, explicitScope))
        return
      }
      openTaskGrantControl()
    })
    copy.append(control)
    taskGrantEntry = control
  }
  heading.append(copy, status, refreshButton)
  main.append(heading)

  const waitingStatus = dashboard.statusSections.waiting
  const waitingStatusAbsent = !waitingStatus || waitingStatus === ABSENT_WAITING_STATUS
  const absentPlan = absentPlanFailure(planHistoryState)
  const renderedActionLabels = [
    ['start', START_ACTION_LABEL],
    ['stop', STOP_ACTION_LABEL],
    ['retry-stop', RETRY_STOP_ACTION_LABEL],
  ].filter(([action]) => !explicitScope && dashboard.allowedActions.includes(action))
    .map(([, label]) => label)
  const applicableNextStep = renderedActionLabels.length > 0
    ? `可使用：${renderedActionLabels.join('、')}`
    : ''

  if (dashboard.error) {
    const errorNotice = element('div', undefined, 'status-banner')
    errorNotice.dataset.tone = 'danger'
    errorNotice.setAttribute('role', 'alert')
    errorNotice.append(element('strong', '任务执行遇到问题，需要处理。'))
    const failureDetailButton = element('button', '查看失败原因', 'button button--quiet')
    failureDetailButton.type = 'button'
    failureDetailButton.addEventListener('click', () => technicalDetail.click())
    errorNotice.append(failureDetailButton)
    main.append(errorNotice)
  }

  if (!['succeeded', 'failed', 'cancelled', 'stopped'].includes(dashboard.state)
    && (!waitingStatusAbsent || applicableNextStep)) {
    const currentSection = element('section', undefined, 'section')
    currentSection.append(element('h2', '当前进展'))
    const currentFacts = element('dl', undefined, 'detail-grid status-layers')
    if (!waitingStatusAbsent) {
      const waitingCell = element('div', undefined, 'detail-cell')
      waitingCell.append(element('dt', '等待原因'), element('dd', waitingStatus))
      currentFacts.append(waitingCell)
    }
    if (applicableNextStep) {
      const nextCell = element('div', undefined, 'detail-cell')
      nextCell.append(element('dt', '下一步'), element('dd', applicableNextStep))
      currentFacts.append(nextCell)
    }
    currentSection.append(currentFacts)
    main.append(currentSection)
  }

  const outputPresent = (dashboard.output !== undefined && dashboard.output !== null && dashboard.output !== '')
    || (dashboard.publicOutput !== undefined && dashboard.publicOutput !== null)
  if (dashboard.state === 'succeeded' || outputPresent) {
    const outputSection = element('section', undefined, 'section business-output')
    outputSection.append(element('h2', '交付结果'))
    outputSection.append(renderTaskPublicOutputPanel({
      output: dashboard.output,
      publication: dashboard.publicOutput,
    }))
    main.append(outputSection)
  }

  const statuses = element('dl', undefined, 'detail-grid status-layers')
  for (const [label, value] of [
    ['任务业务状态', dashboard.statusSections.business],
    ['等待 / 收拢状态', waitingStatus],
    ['连接新鲜度', connectionText()],
    ['最近业务事件', lastEventAt ? formatPreciseTime(lastEventAt) : '尚无业务事件'],
  ]) {
    if (label === '等待 / 收拢状态' && waitingStatusAbsent) continue
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', value))
    statuses.append(cell)
  }

  const technicalDetail = element('button', '技术详情', 'button button--quiet')
  technicalDetail.type = 'button'
  technicalDetail.addEventListener('click', () => openTechnicalDetail({
    title: '任务技术详情',
    entries: [
      ['当前执行节点', dashboard.currentNode],
      ['projectKey', explicitScope?.projectKey],
      ['taskId', taskId],
      ['mode', dashboard.mode],
      ['nextStep', dashboard.nextStep],
      ['error.ownerId', dashboard.error?.ownerId],
      ['error.code', dashboard.error?.code],
      ['error.message', dashboard.error?.message],
      ['error.nextAction', dashboard.error?.nextAction],
      ['control.error.ownerId', taskControlError?.ownerId],
      ['control.error.code', taskControlError?.code],
      ['control.error.message', taskControlError?.message],
      ['control.error.nextAction', taskControlError?.nextAction],
      ['error.cleanupError（清理错误链）', dashboard.error?.cleanupError === undefined
        ? undefined
        : JSON.stringify(dashboard.error.cleanupError, null, 2)],
      ['保留的 checkpoint 记录', dashboard.checkpoint ? '以下为保留记录，不表示任务当前受阻。' : undefined],
      ['checkpoint.outcome', dashboard.checkpoint?.outcome],
      ['checkpoint.seq', dashboard.checkpoint?.seq],
      ['checkpoint.summary', dashboard.checkpoint?.summary],
      ['任务输入', dashboard.input === undefined || dashboard.input === null || dashboard.input === ''
        ? '尚未输入'
        : dashboard.input],
      ['等待 / 收拢状态', waitingStatusAbsent ? waitingStatus : undefined],
      ['当前任务计划', absentPlan
        ? `${absentPlan.code} · ${absentPlan.message} · next=${absentPlan.nextAction}`
        : undefined],
    ].filter(([, value]) => value !== undefined && value !== null),
  }))
  const supportDetails = element('div')
  supportDetails.append(statuses, technicalDetail)
  main.append(renderDashboardDetailFold('运行与连接详情', supportDetails))

  if (!explicitScope) {
    const execution = element('section', undefined, 'section')
    execution.append(element('h2', '任务控制'))
    const panel = element('div', undefined, 'panel')
    const actions = element('div', undefined, 'actions')
    const stopButton = element('button', STOP_ACTION_LABEL, 'button button--danger')
    stopButton.type = 'button'
    stopButton.disabled = !dashboard.allowedActions.includes('stop')
    stopButton.addEventListener('click', () => void stopExecution())
    const retryStopButton = element('button', RETRY_STOP_ACTION_LABEL, 'button button--danger')
    retryStopButton.type = 'button'
    retryStopButton.disabled = !dashboard.allowedActions.includes('retry-stop')
    retryStopButton.addEventListener('click', () => void retryStopExecution())
    const grant = taskGrantControl?.readback?.grant
    const revokeGrantButton = grant === undefined || grant === null
      ? null
      : element('button', '撤销执行授权', 'button button--danger')
    if (revokeGrantButton) {
      revokeGrantButton.type = 'button'
      revokeGrantButton.disabled = !taskGrantControl.authority
      revokeGrantButton.addEventListener('click', () => void revokeTaskGrantControl())
    }
    if (dashboard.allowedActions.includes('stop')) actions.append(stopButton)
    if (dashboard.allowedActions.includes('retry-stop')) actions.append(retryStopButton)
    if (revokeGrantButton) actions.append(revokeGrantButton)
    if (dashboard.allowedActions.includes('start')) {
      const detailLink = element('a', START_ACTION_LABEL, 'button button--primary')
      detailLink.href = `${taskDetailHref(taskId, explicitScope)}#task-interaction`
      actions.append(detailLink)
    }
    const grantState = grant
      ? `执行授权 TG1 revision=${grant.revision} · ${grant.state}`
      : '尚无执行授权'
    const controlNotice = taskControlError
      ? GRANT_CONTROL_FAILURE_COPY
      : grantState
    const actionMessage = `${actionCopy()}${controlNotice ? ` · ${controlNotice}` : ''}`
    actionStatus = element('p', actionMessage, 'muted')
    actionStatus.setAttribute('role', 'status')
    actionStatus.setAttribute('aria-live', 'polite')
    panel.append(actions, actionStatus)
    execution.append(panel)
    main.append(execution)
  }

  // The accepted reasoning plan for this task: exactly the current revision the
  // runtime accepted. It is separate from the scheduling/subscription section
  // below, which is never used as reasoning history. An absent or unknown
  // current plan stays in the technical detail instead of taking over the
  // current surface.
  const planSelection = readPlanSelectionFromQuery()
  const planDetails = element('div')
  let planFailureVisible = false
  if (!absentPlan) {
    const planSection = renderTaskPlanCurrentSection(planHistoryState, {
      explicitScope,
      conflictSelection: hasPlanSelection(planSelection) ? planSelection : null,
      onOpenDetail: openPlanDetail,
      onEvidenceRef: (ref, navigation) => evidenceTrigger(ref, navigation),
    })
    planFailureVisible = Boolean(planSection.planFailure)
    planDetails.append(planSection)
  }

  // The schedule section exists only when the dashboard read reports a
  // persisted plan; a task without one must not show a schedule surface.
  if (dashboard.plan) planDetails.append(renderTaskPlanSection(dashboard.plan))
  if (planDetails.children.length > 0) {
    main.append(renderDashboardDetailFold('任务计划', planDetails, planFailureVisible))
  }

  const actualGraphSection = renderActualExecutionGraphSection()
  const agentSection = renderAgentActivitySection()
  if (actualGraphSection || agentSection) {
    const runtimeDetails = element('div')
    if (actualGraphSection) runtimeDetails.append(actualGraphSection)
    if (agentSection) runtimeDetails.append(agentSection)
    main.append(renderDashboardDetailFold(
      '执行实例与分配',
      runtimeDetails,
      agentSection?.dataset.agentActivity === 'failed'
        || agentSection?.dataset.agentActivity === 'selection-failed',
    ))
  }

  const diagnosticsDetails = element('div')
  const semanticSection = renderSemanticObservationSection()
  diagnosticsDetails.append(semanticSection)
  const traceSection = element('section', undefined, 'section')
  traceSection.append(element('h2', '执行轨迹'))
  const traceTrigger = element('button', '查看执行轨迹', 'button button--quiet')
  traceTrigger.type = 'button'
  traceTrigger.addEventListener('click', () => {
    const traceHost = element('div', undefined, 'execution-trace-drawer')
    renderExecutionTraceInto(traceHost)
    openTechnicalDetail({ title: '执行轨迹', content: traceHost })
  })
  traceSection.append(traceTrigger)
  diagnosticsDetails.append(traceSection)
  const observationLink = element('a', '打开只读 Observation', 'button')
  observationLink.href = observationHref(taskId, explicitScope)
  diagnosticsDetails.append(observationLink)
  main.append(renderDashboardDetailFold(
    '语义观测与执行轨迹',
    diagnosticsDetails,
    semanticSection.dataset.semanticObservation === 'unavailable',
  ))
}

/**
 * The task event trace stays available in every perspective. The panel-backed
 * views keep it folded as an explicit detail; the current layer opens the same
 * shared technical-detail drawer and rerenders it locally for paging.
 */
function renderExecutionTraceInto(host) {
  clearNode(host)
  host.append(renderExecutionTraceSection(() => renderExecutionTraceInto(host)))
}

function renderExecutionTraceSection(rerender = renderActiveReadingMode) {
  const events = element('section', undefined, 'section')
  events.append(element('h2', '执行轨迹'))
  const eventPanel = element('div', undefined, 'panel')
  const recentEvents = dashboard.recentEvents ?? []
  const history = dashboard.history ?? { events: recentEvents, hasMore: false, omitted: 0, gap: false, total: recentEvents.length }
  const allHistoryEvents = visibleRecentEvents(history.events ?? [])
  const chunks = historyChunks(allHistoryEvents)
  const pageCount = Math.max(1, chunks.length)
  historyPage = Math.min(Math.max(historyPage, 0), pageCount - 1)
  const pageStart = Math.max(0, chunks.length - (historyPage + 1))
  const pageEnd = chunks.length - historyPage
  const pageChunks = chunks.slice(pageStart, pageEnd)
  const pageEventCount = pageChunks.reduce((total, chunk) => total + chunk.events.length, 0)
  const olderEventCount = chunks.slice(0, pageStart).reduce((total, chunk) => total + chunk.events.length, 0)
  if (pageEventCount === 0) {
    eventPanel.append(element('p', '尚无事件。', 'empty'))
  } else {
    if (history.gap || pageStart > 0 || pageCount > 1) {
      const summaryText = history.gap
        ? ` · 最近事件摘要截断 ${history.omitted ?? 0} 条`
        : ''
      eventPanel.append(element('p', `执行轨迹第 ${pageCount - historyPage} / ${pageCount} 页 · 共 ${allHistoryEvents.length} 条 · 本页 ${pageEventCount} 条${olderEventCount > 0 ? ` · 更早还有 ${olderEventCount} 条` : ''}${summaryText}`, 'muted history-gap'))
      const pager = element('div', undefined, 'history-pager')
      const older = element('button', '更早', 'button button--quiet')
      older.type = 'button'
      older.disabled = pageStart === 0
      older.addEventListener('click', () => {
        historyPage += 1
        rerender()
      })
      const newer = element('button', '更新', 'button button--quiet')
      newer.type = 'button'
      newer.disabled = historyPage <= 0
      newer.addEventListener('click', () => {
        historyPage -= 1
        rerender()
      })
      pager.append(older, newer)
      eventPanel.append(pager)
    }
    for (const turn of pageChunks) {
      const turnSection = element('section', undefined, 'history-turn')
      const turnLabel = turn.label === '模型轮次'
        ? `轮次 ${turn.turnNumber} · 模型请求`
        : '任务事件'
      turnSection.append(element('h3', `${turnLabel}（${turn.events.length} 条）`, 'history-turn-title'))
      const list = element('ol', undefined, 'event-list')
      for (const event of turn.events) {
        const row = element('li', undefined, 'event')
        row.dataset.eventId = eventIdentity(event)
        const details = element('details')
        const summary = element('summary')
        summary.append(
          element('time', formatPreciseTime(event.occurredAt)),
          element('span', `${event.kind} · ${event.state}`, 'event-kind'),
          element('span', event.summary),
          element('span', `seq=${event.seq}`, 'event-seq'),
        )
        details.append(summary)
        const body = element('dl', undefined, 'event-detail')
        for (const [label, value] of [
          ['精确时间', event.occurredAt],
          ['seq', String(event.seq)],
          ['callId', event.callId || '不适用'],
          ['toolId', event.toolId || '不适用'],
          ['status', event.status || '不适用'],
          ['arguments', event.arguments === undefined || event.arguments === null ? '不适用' : JSON.stringify(event.arguments)],
          ['outputRef', event.outputRef || '不适用'],
          ['错误', event.error ? `${event.error.code}: ${event.error.message}` : '无'],
        ]) {
          const cell = element('div')
          cell.append(element('dt', label), element('dd', value))
          body.append(cell)
        }
        details.append(body)
        row.append(details)
        list.append(row)
      }
      turnSection.append(list)
      eventPanel.append(turnSection)
    }
  }
  events.append(eventPanel)
  return events
}

/**
 * The shared semantic observation panel, mounted once per page load and
 * re-attached on every render. `semantic` here is the typed envelope
 * presentation of the journal projection, not the plan-history surface, so
 * both surfaces stay readable without claiming to be the same content.
 */
function renderSemanticObservationSection() {
  if (!semanticObservationPanel) {
    semanticObservationHost = element('div', undefined, 'semantic-observation-host')
    semanticObservationHost.dataset.semanticObservationHost = taskId ? 'task' : 'missing'
    if (taskId) {
      semanticObservationPanel = mountSemanticObservationPanel(semanticObservationHost, {
        taskId,
        scope: explicitScope,
        // The panel's own four buttons reuse the shell programmatic transition,
        // so a local click cannot write follow-last. The corner buttons keep the
        // original manual controller path. An equal mode is already applied.
        onModeChange: (mode) => {
          if (mode === displayMode) return
          void applyDisplayMode(mode)
        },
      })
    } else {
      semanticObservationHost.append(element('p', '当前 URL 没有 task 参数，无法读取语义观测。', 'empty'))
    }
  }
  // The one retained panel follows the page's active perspective on every
  // re-attach. This is a mode update, not a remount, reload, or new read.
  if (semanticObservationPanel) syncPanelMode(displayMode)
  const section = element('section', undefined, 'section semantic-observation-section')
  section.dataset.semanticObservation = semanticObservationPanel ? 'mounted' : 'unavailable'
  section.append(element('h2', '语义观测'))
  section.append(semanticObservationHost)
  return section
}

/**
 * Refresh the page read. An explicit scope always re-reads through the
 * publication owner for that exact scope; a legacy unscoped task URL keeps the
 * existing unscoped GET rather than inventing a project or mode.
 */
function applyPlanHistoryRead(projection) {
  const availability = planHistoryAvailability(projection?.taskPlanHistory)
  if (!availability.ok) return availability
  const scopeFailure = planHistoryScopeFailure(availability.value, explicitScope)
  return scopeFailure ? { ok: false, failure: scopeFailure } : availability
}

async function refresh() {
  try {
    if (scopeFailure || !taskId) {
      setRefreshError(scopeFailure || { code: 'read.scope.invalid', message: 'URL 缺少 task 参数', ownerId: 'humanagent.ui', nextAction: '从项目任务行打开任务' })
      return
    }
    if (explicitScope) {
      closeStream()
      subscribedOperationId = undefined
      stopObserving()
      const read = await scopedTaskRead.refresh({ ...explicitScope, ...(agentQuery ? { agentQuery } : {}) })
      if (!read.published) return
      if (!read.state.content) {
        agentReadPending = false
        if (agentQuery) agentReadFailure = read.state.failure
        setRefreshError(read.state.failure)
        if (dashboard) renderActiveReadingMode()
        return
      }
      dashboard = read.state.content
      agentReadPending = false
      agentReadFailure = undefined
      dashboardStale = read.state.stale === true
      dashboardFailure = read.state.failure
      planHistoryState = applyPlanHistoryRead(dashboard)
      if (read.state.stale) {
        renderPageError(status, read.state.failure)
        status.dataset.tone = 'warning'
        status.append(element('span', ` · 显示上次确认内容（stale）· ${readScopeLabel(explicitScope)}`))
      } else {
        status.dataset.tone = 'success'
        status.textContent = '任务投影已同步'
      }
      markSync()
      renderActiveReadingMode()
      await refreshTaskGrantControl()
      if (!taskGrantDrawerOpen && !taskGrantDrawerDismissed && taskGrantEntry?.isConnected) {
        openTaskGrantControl()
      }
      renderTaskGrantControlInto(taskGrantControlHost)
      return
    }
    dashboard = await api.taskDashboard(taskId, agentQuery)
    agentReadPending = false
    agentReadFailure = undefined
    dashboardStale = false
    dashboardFailure = undefined
    planHistoryState = applyPlanHistoryRead(dashboard)
    taskControlError = undefined
    if (!taskGrantIntent) {
      taskGrantControl = await api.readTaskGrant(taskId).catch((error) => {
        taskControlError = error
        return null
      })
    }
    status.dataset.tone = 'success'
    status.textContent = '任务投影已同步'
    markSync()
    renderActiveReadingMode()
  } catch (error) {
    agentReadPending = false
    if (agentQuery) agentReadFailure = error
    setRefreshError(error)
    throw error
  }
  if (!dashboard) return
  if (dashboard.operationId && ['running', 'settling'].includes(dashboard.state)) {
    stopObserving()
    subscribe(dashboard.operationId)
  } else if (dashboard.state === 'created' || dashboard.state === 'admitted' || dashboard.state === 'running' || dashboard.state === 'settling') {
    scheduleObservation()
  } else {
    if (subscribedOperationId) {
      subscribedOperationId = undefined
      closeStream()
    }
    stopObserving()
  }
}

async function stopExecution() {
  try {
    await refresh()
    actionStatus.textContent = 'stopping · 正在请求 stop，等待 stopped checkpoint'
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const result = await api.stop(taskId)
    await refresh()
    actionStatus.textContent = result.state === 'stopped'
      ? `stopped · operation=${result.operationId}`
      : `stop=${result.state} · operation=${result.operationId}`
  } catch (error) {
    renderPageError(actionStatus, error)
    await refresh().catch(setRefreshError)
  }
}

async function retryStopExecution() {
  try {
    actionStatus.textContent = 'retrying stop · 正在重试 stop 收拢'
    const result = await api.retryStop(taskId)
    await refresh()
    actionStatus.textContent = result.state === 'stopped'
      ? `stopped · operation=${result.operationId}`
      : `stop=${result.state} · operation=${result.operationId}`
  } catch (error) {
    renderPageError(actionStatus, error)
    await refresh().catch(setRefreshError)
  }
}

async function revokeTaskGrantControl() {
  const grant = taskGrantControl?.readback?.grant
  if (!grant) return
  try {
    taskGrantControl = await api.revokeTaskGrant(taskId, {
      requestId: `control:revoke:task-dashboard:${Date.now()}`,
      expectedRevision: grant.revision,
    })
    await refresh()
  } catch (error) {
    taskControlError = error
    renderActiveReadingMode()
  }
}

function subscribe(operationId) {
  if (subscribedOperationId === operationId) return
  closeStream()
  subscribedOperationId = undefined
  lastSeenSeq = 0
  seenEventIds.clear()
  closingStream = false
  stream = new EventSource(api.eventsUrl(operationId))
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
    'attention.opened',
    'attention.resolved',
  ]) {
    stream.addEventListener(kind, (message) => {
      let payload
      try {
        payload = JSON.parse(message.data)
      } catch {
        payload = {}
      }
      const event = {
        eventId: payload.eventId ?? message.lastEventId,
        seq: Number.isSafeInteger(payload.seq) ? payload.seq : undefined,
        kind: payload.kind ?? kind,
      }
      if (isReplay(event)) return
      rememberEvent(event)
      connectionState = 'connected'
      void refresh().catch(setRefreshError)
    })
  }
  stream.onopen = () => {
    connectionState = 'connected'
    renderActiveReadingMode()
    void refresh().catch(setRefreshError)
  }
  subscribedOperationId = operationId
  stream.onerror = () => {
    if (closingStream) return
    connectionState = 'disconnected'
    renderActiveReadingMode()
    void refresh().catch(setRefreshError)
  }
}

function closeStream() {
  if (!stream) return
  closingStream = true
  stream.close()
  stream = undefined
}

async function load() {
  try {
    const [{ status: runtimeStatus, error }] = await Promise.all([loadRuntimeStatus()])
    renderRuntimeStatus(status, runtimeStatus, error)
    await refresh()
  } catch (error) {
    renderPageError(status, error)
  }
}

// The reading-mode controller starts only after the page's own first read has
// settled. A controller that applies `current` before the dashboard read
// resolves cannot report a truthful render receipt, so it must wait for the
// read this page actually owns.
void load().then(() => initializeDisplayPreference())

const refreshButton = element('button', '刷新当前范围', 'button button--quiet')
refreshButton.type = 'button'
refreshButton.addEventListener('click', () => {
  // A manual refresh is the one path that re-reads the shared semantic panel.
  // Plain re-renders re-attach its retained host without a new request.
  void refresh().then(() => semanticObservationPanel?.reload()).catch(setRefreshError)
})
status.after(refreshButton)

// Back and forward re-read the exact target the URL now names. Only the open
// checkpoint level reacts; leaving the level or closing the drawer clears it, so
// a late popstate cannot publish into a departed host.
window.addEventListener('popstate', () => {
  if (historyView === 'checkpoints' && historyHost?.isConnected) {
    void renderCheckpointHistoryView(historyHost, true)
  }
})

window.addEventListener('pagehide', () => {
  semanticObservationPanel?.dispose()
  semanticObservationPanel = null
  semanticObservationHost = null
  disposeDisplayPreference()
  closeStream()
  stopObserving()
  leaveRecords()
  leaveHistory()
})
