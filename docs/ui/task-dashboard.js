import {
  api,
  clearNode,
  createScopedReadPublication,
  element,
  loadRuntimeStatus,
  makePageShell,
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
  stateTone,
  taskDetailHref,
  taskIdFromQuery,
  taskReadScopeFromQuery,
} from './runtime-shell.js'
import { sameCheckpointAssetBodyAddress } from './runtime-api.js'
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
  resolveCurrentPlanRevision,
  renderTaskPlanCurrentSection,
  renderTaskPlanSemanticView,
  unavailableModeFailure,
} from './task-display.js'
import {
  agentActivityQuery,
  agentActivitySelectionFromQuery,
  agentSelectionReadFailure,
  renderAgentActivity,
  renderAgentActivityDetail,
} from './agent-activity.js'

const taskId = taskIdFromQuery(false)
const readScope = taskReadScopeFromQuery()
const explicitScope = readScope.kind === 'task' ? readScope : null
const scopeFailure = readScope.kind === 'invalid' ? readScope.failure : null
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

// Reading-mode surface for this page. `current` is the already rendered task
// projection with the accepted reasoning plan. `semantic` reads the same
// authoritative history from the current projection. `actions` and `raw` are
// real scoped record reads.
const TASK_DISPLAY_SURFACE = {
  get supportedModes() {
    const modes = ['current']
    if (explicitScope) modes.push('actions', 'raw')
    if (planHistoryState.ok) modes.push('semantic')
    return modes
  },
  get unavailableReasons() {
    const reasons = {}
    if (!planHistoryState.ok) {
      reasons.semantic = planHistoryState.failure?.message || '权威计划版本历史还没有可用接口。'
    }
    if (!explicitScope) {
      reasons.actions = '这个页面没有已确认的 task scope，无法读取动作轨迹。'
      reasons.raw = '这个页面没有已确认的 task scope，无法读取原始记录。'
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
    onEvidenceRef: (ref) => evidenceTrigger(ref),
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
function evidenceTrigger(ref) {
  const button = element('button', '查看证据', 'button button--quiet plan-evidence-trigger')
  button.type = 'button'
  button.addEventListener('click', () => openTechnicalDetail({
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
  }))
  return button
}

const {
  main,
  status,
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
  ...(scope.viewed ? { viewed: scope.viewed } : {}),
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
}))
const milestoneReviewsRead = createScopedReadPublication((scope) => api.taskMilestoneReviews(scope.taskId, {
  ...(scope.filters || {}),
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
}))
const inspectionOccurrencesRead = createScopedReadPublication((scope) => api.taskInspectionOccurrences(scope.taskId, {
  ...(scope.viewed ? { viewed: scope.viewed } : {}),
  ...(scope.cursor ? { cursor: scope.cursor } : {}),
}))
const inspectionComparisonRead = createScopedReadPublication((scope) => api.taskInspectionComparison(scope.taskId, {
  left: scope.filters?.left,
  right: scope.filters?.right,
}))

function leaveRecords() {
  void recordsRead.refresh({ kind: 'closed' })
}

const displayModeHosts = new Map()

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

async function applyTaskDisplayMode({ mode, origin }) {
  if (mode === 'current') {
    if (!dashboard) return { ok: false, failure: currentUnavailableFailure() }
    if (dashboardStale) return { ok: false, failure: staleReadFailure() }
    if (planHistoryState.ok) {
      const current = resolveCurrentPlanRevision(planHistoryState.value, { explicitScope })
      if (!current.ok) return { ok: false, failure: current.failure }
    }
    displayMode = 'current'
    if (origin === 'manual') updatePlanViewUrl({ display: 'current', selection: null })
    renderDashboard()
    return { ok: true, mode: 'current' }
  }
  if (mode === 'semantic') {
    if (!dashboard) return { ok: false, failure: currentUnavailableFailure() }
    if (dashboardStale) return { ok: false, failure: staleReadFailure() }
    if (!planHistoryState.ok) return { ok: false, failure: planHistoryState.failure }
    const host = displayModeHosts.get('semantic') || mountDisplayModeHost('semantic')
    displayModeHosts.set('semantic', host)
    const receipt = await commitScopedReadTransition({
      // The authoritative history already arrived in the single Dashboard GET.
      // This transition only stages and commits its real render.
      read: async () => ({
        published: true,
        reason: 'published',
        state: { content: planHistoryState, stale: false },
      }),
      build: (content) => renderTaskPlanSemanticView(content, planViewOptions()),
      commit: (staged) => {
        clearNode(host)
        host.append(staged)
        host.dataset.planHistoryState = 'confirmed'
        displayMode = 'semantic'
        renderPlanHistoryView(host)
      },
    })
    if (!receipt.ok) return { ok: false, failure: receipt.failure, superseded: receipt.superseded === true }
    if (origin === 'manual') updatePlanViewUrl({ display: 'semantic' })
    return { ok: true, mode: 'semantic' }
  }
  if (mode !== 'actions' && mode !== 'raw') {
    return { ok: false, failure: unavailableModeFailure(mode, '这个页面不能渲染这层内容。') }
  }
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
  const host = displayModeHosts.get(mode) || mountDisplayModeHost(mode)
  displayModeHosts.set(mode, host)
  const receipt = await loadRecords(mode, host)
  if (!receipt.ok) return receipt
  displayMode = mode
  renderRecordsView(mode, host)
  if (origin === 'manual') updatePlanViewUrl({ display: mode, selection: null })
  return { ok: true, mode }
}

function renderSemanticHost() {
  const host = displayModeHosts.get('semantic')
  if (!host || !planHistoryState.ok) return
  clearNode(host)
  host.append(renderTaskPlanSemanticView(planHistoryState, planViewOptions()))
  host.dataset.planHistoryState = 'confirmed'
}

function renderPlanHistoryView(host) {
  clearNode(main)
  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', '只读计划历史', 'eyebrow'), element('h1', displayModeLabel('semantic')))
  heading.append(copy, status, refreshButton)
  const section = element('section', undefined, 'section')
  section.append(host)
  main.append(heading, section)
}

function renderRecordsView(mode, host) {
  clearNode(main)
  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(
    element('p', '只读记录', 'eyebrow'),
    element('h1', displayModeLabel(mode)),
  )
  heading.append(copy, status, refreshButton)
  const section = element('section', undefined, 'section')
  section.append(host)
  main.append(heading, section)
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
  if (displayMode === 'semantic') {
    const host = displayModeHosts.get('semantic') || mountDisplayModeHost('semantic')
    displayModeHosts.set('semantic', host)
    // A stale refresh keeps the last confirmed history; a fresh, readable
    // history rebuilds from the new projection before the view is re-shown.
    if (!dashboardStale && planHistoryState.ok) {
      clearNode(host)
      host.append(renderTaskPlanSemanticView(planHistoryState, planViewOptions()))
      host.dataset.planHistoryState = 'confirmed'
    }
    renderPlanHistoryView(host)
    return
  }
  const host = displayModeHosts.get(displayMode)
  if (host) {
    renderRecordsView(displayMode, host)
    return
  }
  renderDashboard()
}

function recordsContentHasRef(content, selectedRef) {
  return (content?.raw || []).some((record) => (
    ['projectKey', 'mode', 'source', 'ordinal', 'operationId', 'executionEpoch', 'checkpointId']
      .every((key) => record.ref[key] === selectedRef[key])
    && record.ref.taskId.value === selectedRef.taskId.value
  ))
}

async function readRecordsUntilRef(view, cursor, selectedRef) {
  let read = await recordsRead.refresh({
    ...explicitScope,
    view,
    ...(cursor ? { cursor } : {}),
  })
  while (selectedRef && read.published && read.state?.content && !recordsContentHasRef(read.state.content, selectedRef)) {
    if (!read.state.content.hasMore || !read.state.content.nextCursor) break
    read = await recordsRead.refresh({
      ...explicitScope,
      view,
      cursor: read.state.content.nextCursor,
    })
  }
  if (selectedRef && read.published && read.state?.content && !recordsContentHasRef(read.state.content, selectedRef)) {
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

async function loadRecords(view, host, { cursor, selectedRef } = {}) {
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
    read: () => readRecordsUntilRef(view, cursor, selectedRef),
    build: (content) => renderTaskRecords(content, {
      view,
      onNext: (nextCursor) => void loadRecords(view, host, { cursor: nextCursor }),
      onRawRef: (ref) => void loadRecords('raw', host, { selectedRef: ref }),
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

// I2 history carries a task scope instead of an I5 mode/taskId pair. The
// identity guard is the same idea: a projection for another task or surface is
// refused rather than rendered as this task's history.
function i2IdentityFailure(projection, expectedSurface) {
  if (projection.surface !== expectedSurface
    || projection.taskScope?.taskId?.value !== explicitScope.taskId?.value) {
    return {
      code: 'history.identity.mismatch',
      ownerId: 'humanagent.ui',
      message: '历史读取返回了其他任务或 surface 的投影',
      nextAction: '重新打开该任务的历史',
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
  const mismatch = i2IdentityFailure(read.state.content, 'runtime-inspection-comparison')
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

function actionCopy() {
  if (dashboard.state === 'succeeded') return dashboard.output ? '任务已完成，结果可用。' : '任务已完成；当前没有合法操作。'
  if (dashboard.state === 'stopped') {
    const planNote = dashboard.plan?.state === 'active'
      ? `计划仍保持生效；下次到期：${dashboard.plan.nextDueAt ? formatPreciseTime(dashboard.plan.nextDueAt) : '未提供'}。需要暂停或取消后续执行请使用下方计划控制。`
      : ''
    return dashboard.checkpoint
      ? `已停止；收拢 receipt / checkpoint 已提交。${planNote}`
      : `停止请求已受理，但尚未收到收拢 receipt；不能宣称已停止。${planNote}`
  }
  if (dashboard.state === 'blocked') return '执行失败或受阻，仍在释放资源；请按详情中的恢复动作处理。'
  if (dashboard.state === 'failed') return dashboard.error
    ? `执行失败：${dashboard.error.nextAction}`
    : '执行失败；请查看详情中的证据。'
  if (dashboard.allowedActions.includes('start')) return '当前没有正在运行的执行；可以进入显式大脑发起新的处理。'
  return dashboard.allowedActions.length > 0
    ? `当前可用操作：${dashboard.allowedActions.join(', ')}。`
    : '当前没有合法操作；请等待收拢或按详情处理。'
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

function renderDashboard() {
  if (!dashboard) return
  if (agentViewDispose) {
    agentViewDispose()
    agentViewDispose = null
  }
  clearNode(main)

  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', '当前任务', 'eyebrow'), element('h1', dashboard.taskTitle))
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
  heading.append(copy, status, refreshButton)
  main.append(heading)

  const statuses = element('dl', undefined, 'detail-grid status-layers')
  for (const [label, value] of [
    ['任务业务状态', dashboard.statusSections.business],
    ['等待 / 收拢状态', dashboard.statusSections.waiting],
    ['连接新鲜度', connectionText()],
  ]) {
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', value))
    statuses.append(cell)
  }
  main.append(statuses)

  const technicalDetail = element('button', '技术详情', 'button button--quiet')
  technicalDetail.type = 'button'
  technicalDetail.addEventListener('click', () => openTechnicalDetail({
    title: '任务技术详情',
    entries: [
      ['当前执行节点', dashboard.currentNode],
      ['projectKey', explicitScope?.projectKey],
      ['taskId', taskId],
      ['mode', dashboard.mode],
      ['checkpoint.outcome', dashboard.checkpoint?.outcome],
      ['checkpoint.seq', dashboard.checkpoint?.seq],
    ].filter(([, value]) => value !== undefined && value !== null),
  }))
  main.append(technicalDetail)

  const facts = element('dl', undefined, 'detail-grid')
  for (const [label, value] of [
    ['当前状态', dashboard.stateLabel],
    ['模式', dashboard.mode],
    ['最近下一步', dashboard.nextStep],
    ['输入', dashboard.input || '尚未输入'],
    ['输出', dashboard.output || '尚无输出'],
    ['错误 owner', dashboard.error ? `${dashboard.error.ownerId} · ${dashboard.error.nextAction}` : '无错误'],
    ['Checkpoint', dashboard.checkpoint ? `${dashboard.checkpoint.outcome} · seq=${dashboard.checkpoint.seq} · ${dashboard.checkpoint.summary}` : '本任务尚无 checkpoint'],
    ['最近业务事件', lastEventAt ? formatPreciseTime(lastEventAt) : '尚无业务事件'],
  ]) {
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', value))
    facts.append(cell)
  }
  main.append(facts)

  const execution = element('section', undefined, 'section')
  execution.append(element('h2', '任务控制'))
  const panel = element('div', undefined, 'panel')
  const actions = element('div', undefined, 'actions')
  const stopButton = element('button', 'Stop / 收拢', 'button button--danger')
  stopButton.type = 'button'
  stopButton.disabled = !dashboard.allowedActions.includes('stop')
  stopButton.addEventListener('click', () => void stopExecution())
  const retryStopButton = element('button', 'Retry Stop / 重试收拢', 'button button--danger')
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
  if (!explicitScope && dashboard.allowedActions.includes('stop')) actions.append(stopButton)
  if (!explicitScope && dashboard.allowedActions.includes('retry-stop')) actions.append(retryStopButton)
  if (!explicitScope && revokeGrantButton) actions.append(revokeGrantButton)
  if (!explicitScope && dashboard.allowedActions.includes('start')) {
    const detailLink = element('a', '进入显式大脑', 'button button--primary')
    detailLink.href = `${taskDetailHref(taskId, explicitScope)}#task-interaction`
    actions.append(detailLink)
  }
  const grantState = grant
    ? `执行授权 TG1 revision=${grant.revision} · ${grant.state}`
    : '尚无执行授权'
  const controlNotice = !explicitScope
    ? taskControlError
      ? `执行授权失败：${taskControlError.message || String(taskControlError)}`
      : grantState
    : ''
  actionStatus = element('p', `${actionCopy()}${controlNotice ? ` · ${controlNotice}` : ''}`, 'muted')
  actionStatus.setAttribute('role', 'status')
  actionStatus.setAttribute('aria-live', 'polite')
  panel.append(actions, actionStatus)
  if (explicitScope) panel.append(element('p', '此范围提供只读查看；当前控制接口不接受 projectKey 和 mode。', 'muted'))
  execution.append(panel)
  main.append(execution)

  // The accepted reasoning plan for this task: exactly the current revision the
  // runtime accepted. It is separate from the scheduling/subscription section
  // below, which is never used as reasoning history.
  const planSelection = readPlanSelectionFromQuery()
  main.append(renderTaskPlanCurrentSection(planHistoryState, {
    explicitScope,
    conflictSelection: hasPlanSelection(planSelection) ? planSelection : null,
    onEvidenceRef: (ref) => evidenceTrigger(ref),
  }))

  // The schedule section exists only when the dashboard read reports a
  // persisted plan; a task without one must not show a schedule surface.
  if (dashboard.plan) main.append(renderTaskPlanSection(dashboard.plan))

  if (explicitScope) {
    const factsPanel = element('div', undefined, 'panel')
    factsPanel.append(element('p', `当前 scope：${readScopeLabel(explicitScope)}`, 'scope-line'))
    main.append(factsPanel)
  }

  const agentSection = renderAgentActivitySection()
  if (agentSection) main.append(agentSection)

  const events = element('section', undefined, 'section')
  events.append(element('h2', '执行轨迹'))
  const eventPanel = element('div', undefined, 'panel')
  const history = dashboard.history ?? { events: dashboard.recentEvents, hasMore: false, omitted: 0, gap: false, total: dashboard.recentEvents.length }
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
        renderDashboard()
      })
      const newer = element('button', '更新', 'button button--quiet')
      newer.type = 'button'
      newer.disabled = historyPage <= 0
      newer.addEventListener('click', () => {
        historyPage -= 1
        renderDashboard()
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
  main.append(events)

  const observationLink = element('a', '打开只读 Observation', 'button')
  observationLink.href = observationHref(taskId, explicitScope)
  main.append(observationLink)
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
      return
    }
    dashboard = await api.taskDashboard(taskId, agentQuery)
    agentReadPending = false
    agentReadFailure = undefined
    dashboardStale = false
    dashboardFailure = undefined
    planHistoryState = applyPlanHistoryRead(dashboard)
    taskControlError = undefined
    taskGrantControl = await api.readTaskGrant(taskId).catch((error) => {
      taskControlError = error
      return null
    })
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
refreshButton.addEventListener('click', () => void refresh().catch(setRefreshError))
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
  disposeDisplayPreference()
  closeStream()
  stopObserving()
  leaveRecords()
  leaveHistory()
})
