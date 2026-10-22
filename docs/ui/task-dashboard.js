import {
  api,
  clearNode,
  createScopedReadPublication,
  element,
  loadRuntimeStatus,
  mountProductShell,
  mountSemanticObservationPanel,
  observationHref,
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
import {
  encodeProductLocation,
  hierarchyReturn,
  locationFromHash,
  locationFromPopState,
  productLocationHistoryState,
} from './product-location.js'
import { renderProductSessionView } from './product-session-view.js'
import {
  focusFromRelation,
  productRelationRefKey,
  relationDirection,
  renderProductRelationChain,
} from './product-relation-view.js'
import {
  isExactControllableTarget,
  openDecisionModal,
  renderInterventionEntry,
  renderPendingDecision,
} from './product-control-view.js'

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
let agentDetailOpen = false
let agentDetailSerial = 0
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

function detailEntriesContent(entries) {
  const list = element('dl', undefined, 'draft-receipt')
  for (const [label, value] of entries) {
    const row = element('div')
    row.append(element('dt', label), element('dd', value === undefined || value === null ? '未提供' : String(value)))
    list.append(row)
  }
  return list
}

// Every page-owned drill-down enters the one template detail carrier. The
// wrapper only composes the existing back control and content; it does not
// create another dialog or own focus.
function openPageDetail({ onBack, entries = [], content, ...config }, trigger) {
  if (typeof onBack !== 'function') {
    return detail.open({ ...config, entries, ...(content ? { content } : {}) }, trigger)
  }
  const body = element('div', undefined, 'page-detail-content')
  const back = element('button', '返回计划详情', 'button button--quiet')
  back.type = 'button'
  back.addEventListener('click', onBack)
  body.append(back)
  if (content) body.append(content)
  if (entries.length > 0) body.append(detailEntriesContent(entries))
  return detail.open({ ...config, content: body }, trigger)
}

// The existing contextual 技术详情 drawer is the evidence reader this surface
// supports. It shows the exact typed reference and never fabricates a
// checkpoint association or a resolvable link the runtime did not supply.
function openPlanDetail(detailContent, trigger) {
  const layer = openPageDetail({
    ...detailContent,
    onClose: () => {
      if (trigger?.dataset.planDetailTrigger === 'current' && !trigger.isConnected && displayMode === 'current') {
        primary.querySelector('[data-plan-detail-trigger="current"]')?.focus()
      }
    },
  }, trigger)
  return layer
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

const TASK_DASHBOARD_TEST_MODE = globalThis.__HUMANAGENT_TASK_DASHBOARD_TEST__ === true

function productFailure(error, fallbackCode = 'product-read.failed') {
  return {
    code: typeof error?.code === 'string' && error.code ? error.code : fallbackCode,
    ownerId: typeof error?.ownerId === 'string' && error.ownerId
      ? error.ownerId
      : 'humanagent.ui.task-dashboard',
    message: typeof error?.message === 'string' && error.message
      ? error.message
      : '这次读取没有返回可用内容。',
    nextAction: typeof error?.nextAction === 'string' && error.nextAction
      ? error.nextAction
      : '重试同一读取；如果仍然失败，打开技术详情核对来源。',
    ...(typeof error?.detail === 'string' && error.detail !== ''
      ? { detail: error.detail }
      : {}),
  }
}

function productReadLocationFailure(message, nextAction = '从任务列表重新打开这个任务') {
  return {
    code: 'product-location.unknown',
    ownerId: 'humanagent.ui.product-location',
    message,
    nextAction,
  }
}

function productControllerHost(host, label) {
  if (!host || typeof host.replaceChildren !== 'function' || typeof host.append !== 'function') {
    throw new TypeError(`${label} must be a DOM element`)
  }
  return host
}

/**
 * Consume the owner's ProductOutputView. Only an existing publication with at
 * least one confirmed commit can reach the renderer; an empty selection never
 * becomes an empty result block.
 */
export function selectProductOutputPublication(view) {
  if (!view || typeof view !== 'object' || Array.isArray(view)) return undefined
  const publication = view.publication
  if (publication && typeof publication === 'object' && Array.isArray(publication.commits)
    && publication.commits.length > 0) {
    return publication
  }
  if (Array.isArray(view.commits) && view.commits.length > 0) {
    return {
      state: typeof view.state === 'string' ? view.state : 'unknown',
      commits: view.commits,
    }
  }
  return undefined
}

/** Exact edge identity. Display labels, titles and times never participate. */
export function dedupeProductRelations(relations) {
  if (!Array.isArray(relations)) return []
  const seen = new Set()
  const unique = []
  for (const relation of relations) {
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) continue
    const key = [
      productRelationRefKey(relation.source),
      productRelationRefKey(relation.target),
      relation.kind,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(relation)
  }
  return unique
}

function groundedProductRelations(relations) {
  return dedupeProductRelations(relations).filter((relation) => (
    typeof relation.sourceOwner === 'string'
    && relation.sourceOwner.trim().length > 0
    && Array.isArray(relation.evidenceRefs)
    && relation.evidenceRefs.length > 0
  ))
}

function productScopeKey(scope) {
  if (scope?.kind === 'system') return 'system'
  if (scope?.kind === 'project') return `project:${scope.projectKey}`
  if (scope?.kind === 'task') {
    return `task:${scope.projectKey}:${scope.mode}:${scope.taskId?.value ?? ''}`
  }
  return 'invalid-scope'
}

function defaultProductFocus(scope) {
  if (scope?.kind !== 'task') return undefined
  return { kind: 'interaction', taskRef: scope.taskId, scope }
}

function productScopeForFocus(focus, fallback) {
  return focus?.scope?.kind === 'task' ? focus.scope : fallback
}

function productTaskScopeValue(scope) {
  if (scope?.kind !== 'task') return undefined
  const value = typeof scope.taskId === 'object' ? scope.taskId?.value : scope.taskId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function productTargetTaskId(value) {
  const taskValue = typeof value === 'object' ? value?.value : value
  return typeof taskValue === 'string' && taskValue !== ''
    ? { scope: 'task', value: taskValue }
    : undefined
}

function productTargetScope(scope) {
  if (scope?.kind === 'project') {
    return typeof scope.projectKey === 'string' && scope.projectKey !== ''
      ? { kind: 'project', projectKey: scope.projectKey }
      : undefined
  }
  if (scope?.kind !== 'task') return undefined
  const taskRef = productTargetTaskId(scope.taskId)
  if (taskRef === undefined
    || typeof scope.projectKey !== 'string' || scope.projectKey === ''
    || (scope.mode !== 'fake' && scope.mode !== 'rcc' && scope.mode !== 'dsh')) {
    return undefined
  }
  return {
    kind: 'task',
    projectKey: scope.projectKey,
    mode: scope.mode,
    taskId: taskRef,
  }
}

function productExecutionInstanceIdentity(instance) {
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return undefined
  if (instance.kind === 'native-execution') {
    const execution = instance.execution
    if (typeof execution?.runtimeId !== 'string' || execution.runtimeId === '') return undefined
    if (!Number.isSafeInteger(execution.executionEpoch) || execution.executionEpoch < 1) return undefined
    return {
      kind: 'native-execution',
      execution: {
        runtimeId: execution.runtimeId,
        executionEpoch: execution.executionEpoch,
      },
    }
  }
  if (instance.kind === 'incarnation') {
    const incarnation = instance.incarnation
    if (!incarnation || typeof incarnation !== 'object' || Array.isArray(incarnation)) return undefined
    const incarnationTaskRef = productTargetTaskId(incarnation.taskId)
    if (typeof incarnation.runtimeId !== 'string' || incarnation.runtimeId === '') return undefined
    if (!Number.isSafeInteger(incarnation.generation) || incarnation.generation < 1) return undefined
    if (typeof incarnation.agentInstanceId !== 'string' || incarnation.agentInstanceId === '') return undefined
    if (typeof incarnation.roleId !== 'string' || incarnation.roleId === '') return undefined
    if (incarnationTaskRef === undefined) return undefined
    if (typeof incarnation.assignmentId !== 'string' || incarnation.assignmentId === '') return undefined
    if (!Number.isSafeInteger(incarnation.executionEpoch) || incarnation.executionEpoch < 1) return undefined
    return {
      kind: 'incarnation',
      incarnation: {
        runtimeId: incarnation.runtimeId,
        generation: incarnation.generation,
        agentInstanceId: incarnation.agentInstanceId,
        roleId: incarnation.roleId,
        taskId: incarnationTaskRef,
        assignmentId: incarnation.assignmentId,
        executionEpoch: incarnation.executionEpoch,
      },
    }
  }
  return undefined
}

/**
 * Build the complete, discriminated read target for one focus. Only the exact
 * fields already present in the owner target cross this boundary. A missing or
 * inconsistent identity returns undefined; the page never derives a target
 * from a title, a URL label or a synthesized session id.
 */
function productFocusReadTarget(focus) {
  if (!focus || typeof focus !== 'object' || Array.isArray(focus)) return undefined
  const scope = productTargetScope(focus.scope)
  if (scope === undefined) return undefined
  if (focus.kind === 'interaction') {
    const taskRef = productTargetTaskId(focus.taskRef)
    if (taskRef === undefined || scope.kind !== 'task' || scope.taskId.value !== taskRef.value) {
      return undefined
    }
    return { kind: 'interaction', taskRef, scope }
  }
  if (focus.kind === 'session') {
    const sourceKind = focus.sessionRef?.sourceKind
    const sourceRef = focus.sessionRef?.sourceRef
    if (typeof sourceKind !== 'string' || sourceKind === '') return undefined
    if (typeof sourceRef !== 'string' || sourceRef === '') return undefined
    const taskRef = focus.taskRef === undefined ? undefined : productTargetTaskId(focus.taskRef)
    if (focus.taskRef !== undefined && taskRef === undefined) return undefined
    if (scope.kind === 'task') {
      if (taskRef === undefined || scope.taskId.value !== taskRef.value) return undefined
    } else if (taskRef !== undefined) {
      return undefined
    }
    return {
      kind: 'session',
      sessionRef: { sourceKind, sourceRef },
      ...(taskRef === undefined ? {} : { taskRef }),
      scope,
    }
  }
  if (focus.kind === 'execution-instance') {
    if (scope.kind !== 'task') return undefined
    const taskRef = productTargetTaskId(focus.taskRef)
    if (taskRef === undefined || scope.taskId.value !== taskRef.value) return undefined
    const instance = productExecutionInstanceIdentity(focus.instance)
    if (instance === undefined) return undefined
    return { kind: 'execution-instance', instance, taskRef, scope }
  }
  return undefined
}

function productExecutionInstanceIdentityText(instance) {
  if (instance?.kind === 'native-execution') {
    const execution = instance.execution ?? {}
    return `runtimeId ${execution.runtimeId} · executionEpoch ${execution.executionEpoch}`
  }
  if (instance?.kind === 'incarnation') {
    const incarnation = instance.incarnation ?? {}
    return [
      `runtimeId ${incarnation.runtimeId}`,
      `generation ${incarnation.generation}`,
      `agentInstanceId ${incarnation.agentInstanceId}`,
      `roleId ${incarnation.roleId}`,
      `taskId ${incarnation.taskId?.value}`,
      `assignmentId ${incarnation.assignmentId}`,
      `executionEpoch ${incarnation.executionEpoch}`,
    ].join(' · ')
  }
  return '实例身份未提供'
}

function productFocusTargetDetail(target) {
  if (target?.kind === 'execution-instance') {
    return `执行实例：${productExecutionInstanceIdentityText(target.instance)}`
  }
  if (target?.kind === 'session') {
    return `会话来源：${target.sessionRef.sourceKind} · ${target.sessionRef.sourceRef}`
  }
  return undefined
}

/**
 * A body reader may be absent for a focus that is still a valid read target.
 * That absence is a typed result, not an empty message list and not the task
 * body under another name.
 */
function productFocusTargetUnavailable(target) {
  const detail = productFocusTargetDetail(target)
  if (target?.kind === 'execution-instance') {
    return {
      code: 'product-session.read.unavailable-target',
      ownerId: 'humanagent.ui.task-dashboard',
      message: '该执行实例暂无正文读取入口。',
      nextAction: '请回到对应任务查看执行摘要；实例正文需要接入读取入口后才能显示。',
      ...(detail === undefined ? {} : { detail }),
    }
  }
  if (target?.kind === 'session') {
    return {
      code: 'product-session.read.unavailable-target',
      ownerId: 'humanagent.ui.task-dashboard',
      message: '该会话来源暂无正文读取入口。',
      nextAction: '请在该来源自己的读取界面查看正文；当前页面不会用任务消息代替来源正文。',
      ...(detail === undefined ? {} : { detail }),
    }
  }
  return {
    code: 'product-session.read.unavailable',
    ownerId: 'humanagent.ui.task-dashboard',
    message: '当前焦点没有可用的正文读取入口。',
    nextAction: '重新选择精确的交互、会话或执行实例。',
  }
}

/**
 * Dispatch one focus to its declared body owner. Explicit intake reads narrow
 * the real interaction messages. A target without a body reader returns the
 * typed unavailable result above; it never falls back to the task body.
 */
function productSessionReadForTarget(target, transport) {
  if (target === undefined) return Promise.reject(productFocusTargetUnavailable(undefined))
  if (target.kind === 'execution-instance') {
    return Promise.reject(productFocusTargetUnavailable(target))
  }
  if (target.kind === 'session' && target.sessionRef.sourceKind !== 'explicit-intake') {
    return Promise.reject(productFocusTargetUnavailable(target))
  }
  if (typeof transport.readProductSession !== 'function') {
    return Promise.reject(productFailure(
      { code: 'product-session.read.unavailable', message: '当前页面没有会话读取入口。', ownerId: 'humanagent.ui.task-dashboard' },
      'product-session.read.unavailable',
    ))
  }
  const read = productFlatReadScope(target, target.scope)
  if (read === undefined) return Promise.reject(productFocusTargetUnavailable(target))
  return Promise.resolve().then(() => transport.readProductSession(read))
}

/**
 * The flat read scope declared by decision 1. A task identity crosses as a
 * string. An explicit intake session contributes both owner words, sourceKind
 * and sourceRef, so the read cannot collapse two sources into one id. The
 * internal `{scope,value}` object and every authority field stay on the page.
 */
function productFlatReadScope(focus, scope) {
  if (scope?.kind !== 'task' && scope?.kind !== 'project') return undefined
  const read = { projectKey: scope.projectKey }
  if (scope.mode === 'fake' || scope.mode === 'rcc' || scope.mode === 'dsh') read.mode = scope.mode
  if (scope.kind === 'task') {
    const taskIdValue = productTaskScopeValue(scope)
    if (taskIdValue === undefined) return undefined
    read.taskId = taskIdValue
  }
  if (focus?.kind === 'session') {
    const sourceKind = focus.sessionRef?.sourceKind
    const sourceRef = focus.sessionRef?.sourceRef
    if (typeof sourceKind !== 'string' || sourceKind === '') return undefined
    if (typeof sourceRef !== 'string' || sourceRef === '') return undefined
    read.sessionRef = { sourceKind, sourceRef }
  }
  return read
}

function productDecisionReadScope(scope) {
  return productFlatReadScope(undefined, scope)
}

/**
 * A decision belongs to the focus only when its owner-supplied target names
 * the same task and read scope. A waiting state is the only state this page
 * treats as an approval; a resolved, revoked or unknown decision never becomes
 * a pending block.
 */
function decisionMatchesFocus(decision, focus, scope) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return false
  if (decision.kind !== 'task-grant' || decision.state !== 'waiting') return false
  // A waiting approval must offer the formal continue action. A revoke-only
  // card is grant management, not a pending decision.
  if (!Array.isArray(decision.actions) || !decision.actions.includes('grant')) return false
  const target = decision.target
  if (target?.kind !== 'interaction' || !isExactControllableTarget(target)) return false
  const scopeTaskId = productTaskScopeValue(scope)
  if (scopeTaskId === undefined || target.taskRef?.value !== scopeTaskId) return false
  if (target.scope?.projectKey !== scope.projectKey || target.scope?.mode !== scope.mode) return false
  if (target.scope?.taskId?.value !== scopeTaskId) return false
  if (productTaskScopeValue(focus?.scope) !== scopeTaskId) return false
  return focus?.taskRef?.value === scopeTaskId
}

function selectProductPendingDecision(value, focus, scope) {
  if (value === null || value === undefined) return null
  return decisionMatchesFocus(value, focus, scope) ? value : undefined
}

/**
 * The focus's own lane from the product read that just completed. The lookup
 * uses the exact owner target key, so a stale task row or another task's card
 * can never make this focus actionable. A missing match stays undefined and
 * therefore fail-closed.
 */
function productFocusLane(sessionValue, focus) {
  const boards = sessionValue?.boardIndex?.boards
  if (!Array.isArray(boards) || !focus) return undefined
  const wanted = productRelationRefKey(focus)
  // An interaction focus is the task-level interaction stream, so its Live or
  // history state is the task row's lane, not an explicit intake card that
  // happens to share the same interaction target key.
  const taskRowBoards = focus.kind === 'interaction'
    ? new Set(['orchestration', 'inspection'])
    : undefined
  for (const board of boards) {
    if (!board || typeof board !== 'object') continue
    if (taskRowBoards !== undefined && !taskRowBoards.has(board.board)) continue
    for (const lane of ['live', 'history', 'unknown']) {
      const items = Array.isArray(board[lane]) ? board[lane] : []
      for (const item of items) {
        if (productRelationRefKey(item?.ref) === wanted) return lane
      }
    }
  }
  return undefined
}

function normalizeProductLocationRead(value) {
  if (value === undefined || value === null) {
    return {
      failure: productReadLocationFailure(
        '当前页面没有可用的产品读取位置。',
        '从板块或任务列表重新打开这个任务。',
      ),
    }
  }
  if (value.kind === 'valid' && value.location) {
    return value.canonicalize === true
      ? { location: value.location, canonicalize: true }
      : { location: value.location }
  }
  if (value.kind === 'unknown') {
    return { failure: value.failure ?? productReadLocationFailure('产品读取位置无效。') }
  }
  if (value.board && value.scope) return { location: value }
  return { failure: productReadLocationFailure('产品读取位置无效。') }
}

function renderProductFocusFailure(host, make, title, failure) {
  host.replaceChildren()
  const node = make('div', undefined, 'product-focus-failure')
  node.setAttribute('data-product-role', 'focus-failure')
  node.setAttribute('role', 'alert')
  const technical = make('details', undefined, 'plan-detail product-focus-failure-detail')
  technical.open = false
  technical.append(make('summary', '技术详情'))
  const entries = make('dl', undefined, 'record-ref')
  const detailRows = [
    ['code', failure.code],
    ['owner', failure.ownerId],
    ['message', failure.message],
    ['nextAction', failure.nextAction],
    ...(typeof failure.detail === 'string' && failure.detail !== ''
      ? [['来源与实例身份', failure.detail]]
      : []),
  ]
  for (const [label, value] of detailRows) {
    const row = make('div')
    row.append(
      make('dt', label),
      make('dd', value === undefined || value === null || value === '' ? '未提供' : String(value)),
    )
    entries.append(row)
  }
  technical.append(entries)
  node.append(
    make('strong', title),
    make('p', failure.message, 'product-focus-failure-message'),
    make('p', failure.nextAction, 'product-focus-failure-next'),
    technical,
  )
  host.append(node)
  return node
}

function renderProductRelationUnavailable(host, make, title, failure) {
  host.replaceChildren()
  const node = make('div', undefined, 'product-relation-unavailable')
  node.setAttribute('data-product-role', 'relation-unavailable')
  node.setAttribute('role', 'alert')
  node.append(
    make('strong', title),
    make('p', `${failure.code} · ${failure.message}`, 'product-relation-unavailable-message'),
    make('p', failure.nextAction, 'product-relation-unavailable-next'),
  )
  host.append(node)
  return node
}

function renderProductDecisionUnavailable(host, make, failure) {
  const node = make('div', undefined, 'product-focus-decision-unavailable')
  node.setAttribute('data-product-role', 'decision-unavailable')
  node.setAttribute('role', 'alert')
  node.append(
    make('strong', '待决定事项读取不可用'),
    make('p', `${failure.code} · ${failure.message}`),
    make('p', failure.nextAction, 'muted'),
  )
  host.append(node)
  return node
}

/**
 * The task focus controller.
 *
 * It owns only focus-bound read sequencing and the two rendered hosts. The
 * exact scope, URL codec, relation identity, session projection and formal
 * control transport stay with their declared owners. A focus change invalidates
 * every in-flight request; closing the relation layer only closes presentation.
 */
export function createTaskFocusController({
  centerHost,
  relationHost,
  transport,
  element: make = element,
  readLocation = () => undefined,
  writeLocation = () => undefined,
  replaceLocation,
  closeRelationLayer = () => undefined,
  onSessionRendered,
} = {}) {
  productControllerHost(centerHost, 'product focus center host')
  if (relationHost) productControllerHost(relationHost, 'product focus relation host')
  if (typeof transport !== 'object' || transport === null) {
    throw new TypeError('product focus controller requires a read transport')
  }
  if (typeof make !== 'function') throw new TypeError('product focus controller requires an element factory')

  let disposed = false
  let serial = 0
  let activity = Promise.resolve()
  let currentLocation
  let controlWrites = 0
  const state = {
    focus: undefined,
    scope: undefined,
    location: undefined,
    relations: [],
    gaps: [],
    sessionRead: 'idle',
    focusLane: undefined,
    outputRead: 'idle',
    relationRead: 'idle',
    decisionRead: 'idle',
    decision: undefined,
    decisionFailure: undefined,
    controlWrites: 0,
  }

  const controlTransport = {
    readTaskGrant: typeof transport.readTaskGrant === 'function'
      ? transport.readTaskGrant.bind(transport)
      : undefined,
    grantTaskControl: typeof transport.grantTaskControl === 'function'
      ? (...args) => {
        controlWrites += 1
        state.controlWrites = controlWrites
        return transport.grantTaskControl(...args)
      }
      : undefined,
    revokeTaskGrant: typeof transport.revokeTaskGrant === 'function'
      ? (...args) => {
        controlWrites += 1
        state.controlWrites = controlWrites
        return transport.revokeTaskGrant(...args)
      }
      : undefined,
    stop: typeof transport.stop === 'function'
      ? (...args) => {
        controlWrites += 1
        state.controlWrites = controlWrites
        return transport.stop(...args)
      }
      : undefined,
  }

  function track(promise) {
    const tracked = Promise.resolve(promise).catch(() => undefined)
    activity = tracked
    return promise
  }

  function renderPending() {
    centerHost.replaceChildren()
    const section = make('section', undefined, 'product-focus-center')
    section.setAttribute('data-product-focus-state', 'pending')
    section.append(make('h2', '当前会话'), make('p', '正在读取当前会话…', 'muted'))
    centerHost.append(section)
    if (relationHost) {
      relationHost.replaceChildren()
      relationHost.append(make('p', '正在读取关联…', 'muted'))
    }
  }

  function renderCenter(sessionResult, outputResult, focus, scope, focusLane) {
    centerHost.replaceChildren()
    const section = make('section', undefined, 'product-focus-center')
    section.setAttribute('data-product-focus-state', 'ready')
    section.setAttribute('data-product-focus-scope', productScopeKey(scope))
    section.append(make('h2', '当前会话'))

    const sessionBody = make('div', undefined, 'product-focus-session')
    if (sessionResult.status === 'rejected') {
      const failure = productFailure(sessionResult.reason, 'product-session.read.failed')
      renderProductFocusFailure(sessionBody, make, '当前会话读取失败', failure)
    } else {
      const value = sessionResult.value
      const messages = Array.isArray(value?.messages) ? value.messages : undefined
      const publication = outputResult.status === 'fulfilled'
        ? selectProductOutputPublication(outputResult.value)
        : undefined
      renderProductSessionView(sessionBody, {
        ...(messages === undefined ? {} : { messages }),
        ...(publication === undefined ? {} : { publicOutput: publication }),
      }, { element: make })
      if (outputResult.status === 'rejected') {
        const failure = productFailure(outputResult.reason, 'product-output.read.failed')
        const node = make('div', undefined, 'product-focus-output-failure')
        node.setAttribute('data-product-role', 'output-failure')
        node.setAttribute('role', 'alert')
        node.append(
          make('strong', '已提交结果读取失败'),
          make('p', `${failure.code} · ${failure.message}`),
          make('p', failure.nextAction, 'muted'),
        )
        sessionBody.append(node)
      }
    }
    section.append(sessionBody)
    centerHost.append(section)
    if (typeof onSessionRendered === 'function') {
      onSessionRendered(section, {
        focus,
        scope,
        lane: focusLane,
        transport: controlTransport,
        relations: state.relations,
        output: outputResult.status === 'fulfilled' ? outputResult.value : undefined,
      })
    }
  }

  function renderRelationGaps(gaps) {
    if (!relationHost || !Array.isArray(gaps) || gaps.length === 0) return
    const section = make('section', undefined, 'product-relation-gaps')
    section.setAttribute('data-product-role', 'relation-gaps')
    section.append(make('h3', '未完成的关联'))
    for (const gap of gaps) {
      const stateLabel = gap?.state === 'absent' ? '事实不存在' : '事实存在但引用未记录'
      section.append(make(
        'p',
        `${stateLabel}：${gap?.message ?? '未提供原因。'}`,
        'product-relation-gap',
      ))
    }
    relationHost.append(section)
  }

  function renderRelations(relationResult, focus) {
    if (!relationHost) return
    if (relationResult.status === 'rejected') {
      const failure = productFailure(relationResult.reason, 'product-relations.read.failed')
      state.relationRead = 'failed'
      renderProductRelationUnavailable(relationHost, make, '关联读取不可用', failure)
      return
    }
    const read = relationResult.value
    const relations = Array.isArray(read?.relations) ? read.relations : []
    const grounded = groundedProductRelations(relations)
    state.relations = grounded
    state.gaps = Array.isArray(read?.gaps) ? read.gaps : []
    state.relationRead = 'ready'

    relationHost.replaceChildren()
    renderProductRelationChain(relationHost, grounded, {
      element: make,
      ...(focus === undefined ? {} : { focus }),
      onSelect: (ref, direction) => {
        void focusTo(ref, direction)
      },
    })
    renderRelationGaps(state.gaps)
  }

  function renderDecision(decisionResult) {
    if (decisionResult.status === 'rejected') {
      renderProductDecisionUnavailable(centerHost, make, state.decisionFailure
        ?? productFailure(decisionResult.reason, 'product-decision.read.failed'))
      return
    }
    const decision = state.decision
    if (!decision) return
    const decisionHost = make('div', undefined, 'product-focus-decision')
    decisionHost.dataset.productFocusControl = 'decision'
    renderPendingDecision(decisionHost, decision, {
      element: make,
      onIntent: (intent, selectedDecision) => {
        // A focus change replaces state.decision; a stale card handler must not
        // open an approval for the previous task.
        if (state.decision !== selectedDecision) return
        openDecisionModal({
          decision: selectedDecision,
          transport: controlTransport,
          element: make,
          host: decisionHost,
          title: '审批执行授权',
        })
      },
    })
    centerHost.append(decisionHost)
  }

  function focusSelectionTarget(ref, direction) {
    if (direction !== 'upstream' && direction !== 'downstream') return undefined
    const wanted = productRelationRefKey(ref)
    const match = state.relations.find((relation) => {
      if (relationDirection(relation, state.focus) !== direction) return false
      const endpoint = direction === 'upstream' ? relation.source : relation.target
      return productRelationRefKey(endpoint) === wanted
    })
    if (!match) return undefined
    return focusFromRelation(match, state.focus, direction)
  }

  async function load({ location: supplied } = {}) {
    if (disposed) return { ok: false, disposed: true }
    const read = supplied === undefined
      ? normalizeProductLocationRead(readLocation())
      : normalizeProductLocationRead({ kind: 'valid', location: supplied })
    if (read.failure) {
      serial += 1
      centerHost.replaceChildren()
      renderProductFocusFailure(centerHost, make, '读取位置无效', read.failure)
      if (relationHost) {
        renderProductRelationUnavailable(relationHost, make, '关联读取不可用', read.failure)
      }
      return { ok: false, failure: read.failure }
    }

    const requestSerial = ++serial
    const locationValue = read.location
    if (read.canonicalize === true && supplied === undefined && typeof replaceLocation === 'function') {
      // The page owns this rewrite: the URL gains the route the read already
      // resolved, so Back and refresh restore the same focus.
      try {
        replaceLocation(locationValue)
      } catch {
        // A refused history write must not stop the read the page already owns.
      }
    }
    currentLocation = locationValue
    const focus = locationValue.focus ?? defaultProductFocus(locationValue.scope)
    const scope = productScopeForFocus(focus, locationValue.scope)
    state.location = locationValue
    state.focus = focus
    state.scope = scope
    state.sessionRead = 'pending'
    state.focusLane = undefined
    state.relationRead = 'pending'
    state.outputRead = 'pending'
    state.decisionRead = 'pending'
    state.decision = undefined
    state.decisionFailure = undefined
    renderPending()

    const sessionPromise = productSessionReadForTarget(productFocusReadTarget(focus), transport)
    const relationsPromise = typeof transport.readProductRelations === 'function'
      ? Promise.resolve().then(() => transport.readProductRelations(scope))
      : Promise.reject(productFailure(
        { code: 'product.relations.unavailable', message: '关联读取未提供来源。', ownerId: 'humanagent.ui.task-dashboard' },
        'product.relations.unavailable',
      ))
    const outputPromise = scope?.kind === 'task' && typeof transport.readProductOutput === 'function'
      ? Promise.resolve().then(() => transport.readProductOutput(scope.taskId))
      : Promise.resolve(undefined)

    const decisionReadScope = productDecisionReadScope(scope)
    const decisionPromise = decisionReadScope === undefined
      ? Promise.resolve(null)
      : typeof transport.readProductDecision === 'function'
        ? Promise.resolve().then(() => transport.readProductDecision(decisionReadScope))
        : Promise.reject(productFailure(
          { code: 'product-decision.read.unavailable', message: '当前页面没有待决定事项读取入口。', ownerId: 'humanagent.ui.task-dashboard' },
          'product-decision.read.unavailable',
        ))

    const [sessionResult, relationResult, outputResult, decisionResult] = await Promise.allSettled([
      sessionPromise,
      relationsPromise,
      outputPromise,
      decisionPromise,
    ])
    if (disposed || requestSerial !== serial) {
      return { ok: false, superseded: true, focus, scope }
    }

    const focusLane = sessionResult.status === 'fulfilled'
      ? productFocusLane(sessionResult.value, focus)
      : undefined
    state.focusLane = focusLane
    state.sessionRead = sessionResult.status === 'fulfilled'
      ? 'ready'
      : (sessionResult.reason?.code === 'product-session.read.unavailable-target' ? 'unavailable' : 'failed')
    state.outputRead = outputResult.status === 'fulfilled'
      ? (selectProductOutputPublication(outputResult.value) === undefined ? 'empty' : 'ready')
      : 'failed'
    const decisionValue = decisionResult.status === 'fulfilled' ? decisionResult.value : undefined
    const selectedDecision = decisionResult.status === 'fulfilled'
      ? selectProductPendingDecision(decisionValue, focus, scope)
      : undefined
    state.decision = selectedDecision
    state.decisionRead = decisionResult.status === 'fulfilled'
      ? (decisionValue === null || decisionValue === undefined
          ? 'empty'
          : selectedDecision === undefined ? 'mismatch' : 'ready')
      : (decisionResult.reason?.code === 'product-decision.read.unavailable' ? 'unavailable' : 'failed')
    state.decisionFailure = decisionResult.status === 'rejected'
      ? productFailure(decisionResult.reason, 'product-decision.read.failed')
      : undefined
    renderCenter(sessionResult, outputResult, focus, scope, focusLane)
    renderRelations(relationResult, focus)
    renderDecision(decisionResult)
    return { ok: true, focus, scope }
  }

  function reload() {
    return track(load())
  }

  function applyLocation(locationValue) {
    return track(load({ location: locationValue }))
  }

  async function focusTo(ref, direction) {
    if (disposed || !ref || typeof ref !== 'object') return { ok: false, invalid: true }
    const target = direction === undefined ? ref : focusSelectionTarget(ref, direction)
    if (!target) return { ok: false, directionMissed: true }
    const base = currentLocation
    if (!base) return { ok: false, missingLocation: true }
    const scope = productScopeForFocus(target, base.scope)
    const next = {
      board: base.board,
      lane: base.lane,
      focus: target,
      scope,
    }
    try {
      encodeProductLocation(next)
    } catch {
      return { ok: false, invalid: true }
    }
    serial += 1
    state.focus = target
    state.scope = scope
    writeLocation(next)
    return track(load({ location: next }))
  }

  async function returnToParent() {
    if (disposed || !currentLocation) return { ok: false }
    const parent = hierarchyReturn(currentLocation)
    if (!parent) return { ok: false, atBoard: true }
    writeLocation(parent.location)
    return track(load({ location: parent.location }))
  }

  function closeRelation() {
    closeRelationLayer()
    return { ok: true, controlWrites }
  }

  async function settled() {
    for (let index = 0; index < 4; index += 1) {
      const current = activity
      await current
      await Promise.resolve()
      if (current === activity) break
    }
  }

  function dispose() {
    disposed = true
    serial += 1
  }

  return {
    centerHost,
    relationHost,
    transport: controlTransport,
    load: reload,
    reload,
    applyLocation,
    focusTo,
    returnToParent,
    closeRelation,
    settled,
    dispose,
    state: () => ({ ...state }),
  }
}

function createTaskDashboardTestTemplate() {
  const host = () => document.createElement('div')
  return {
    hosts: {
      page: host(),
      heading: host(),
      status: host(),
      primary: host(),
      support: host(),
      composer: host(),
      board: null,
      center: host(),
      relation: host(),
      drawer: null,
      config: null,
    },
    shell: {
      host: null,
      initializeDisplayPreference() {},
      applyDisplayMode() { return Promise.resolve({ ok: true }) },
      dispose() {},
    },
    detail: {
      open() { return {} },
      close() {},
      dispose() {},
    },
    setBreadcrumbs() {},
    openBoard() {},
    openRelation() {},
    closeRelation() {},
    toggleRelation() {},
    openDrawer() {},
    setDrawerTab() {},
    closeDrawer() {},
    dispose() {},
  }
}

const template = TASK_DASHBOARD_TEST_MODE
  ? createTaskDashboardTestTemplate()
  : mountProductShell(document.getElementById('page-root'), {
  layout: 'work',
  active: 'Task List',
  eyebrow: 'Task Dashboard',
  title: '任务看板',
  lede: '这里显示这个任务当前的状态、执行进展、关键节点和可执行操作。',
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
})
const { hosts, shell, detail } = template
const { primary, support, status, heading } = hosts

let productFocusController = null
let productCenterHost = null
let productRelationHost = null

function productTaskScope() {
  // Focus navigation rewrites the query and hash together, so the live URL is
  // the current product task. The initial scope is the fallback for a page
  // opened without a complete explicit task query.
  const live = taskReadScopeFromQuery()
  const source = live.kind === 'task' ? live : explicitScope
  if (!source) return undefined
  const value = typeof source.taskId === 'object'
    ? source.taskId.value
    : source.taskId
  if (typeof value !== 'string' || value === '') return undefined
  return {
    kind: 'task',
    projectKey: source.projectKey,
    mode: source.mode,
    taskId: { scope: 'task', value },
  }
}

export function productLocationMatchesTask(value) {
  const scope = productTaskScope()
  if (!scope || !value) return false
  if (value.scope?.kind === 'task') {
    return value.scope.projectKey === scope.projectKey
      && value.scope.mode === scope.mode
      && value.scope.taskId?.value === scope.taskId.value
  }
  if (value.scope?.kind === 'project') {
    return value.scope.projectKey === scope.projectKey
  }
  return false
}

function readPageProductLocation() {
  if (location.hash && location.hash.startsWith('#/boards/')) {
    const decoded = locationFromHash(location.hash)
    if (decoded.kind !== 'valid') return decoded
    if (!productLocationMatchesTask(decoded.location)) {
      return {
        kind: 'unknown',
        failure: productReadLocationFailure(
          'URL 的产品读取范围与当前任务不一致。',
          '返回当前任务后重新选择会话或关联节点。',
        ),
      }
    }
    return decoded
  }
  // No product route: this page was opened from a task list or a submit landing.
  // The task scope below is the exact read position, and the caller canonicalizes
  // it into the current history entry so Back has a location to restore.
  const scope = productTaskScope()
  if (!scope) {
    return {
      kind: 'unknown',
      failure: productReadLocationFailure(
        '当前 URL 没有精确的 task、projectKey 和 mode。',
        '从项目任务行重新打开任务看板。',
      ),
    }
  }
  return {
    kind: 'valid',
    location: {
      board: 'interaction',
      lane: 'live',
      focus: { kind: 'interaction', taskRef: scope.taskId, scope },
      scope,
    },
    canonicalize: true,
  }
}

function productPageQuery(scope) {
  const params = new URLSearchParams()
  if (scope?.kind === 'task') {
    const value = typeof scope.taskId === 'object' ? scope.taskId?.value : scope.taskId
    if (typeof value === 'string' && value !== '') params.set('task', value)
    params.set('projectKey', scope.projectKey)
    params.set('mode', scope.mode)
  } else if (scope?.kind === 'project') {
    params.set('projectKey', scope.projectKey)
    if (explicitScope) params.set('mode', explicitScope.mode)
  }
  return params
}

function pageProductLocationUrl(next) {
  const hash = encodeProductLocation(next)
  const url = new URL(location.href)
  const query = productPageQuery(next?.scope).toString()
  // The query and hash always describe the same focus scope. Retaining the
  // old task query made refresh and Back/Forward reject the new focus.
  return `${url.pathname}${query ? `?${query}` : ''}${hash}`
}

export function writePageProductLocation(next) {
  window.history.pushState(
    productLocationHistoryState(next),
    '',
    pageProductLocationUrl(next),
  )
}

// A page opened from a task list carries only the task query, so its first
// history entry has no product route and Back cannot restore it. Rewriting that
// entry in place gives Back a location to return to without adding an entry.
export function replacePageProductLocation(next) {
  window.history.replaceState(
    productLocationHistoryState(next),
    '',
    pageProductLocationUrl(next),
  )
}

function productScopeQuery(scope) {
  const params = new URLSearchParams()
  if (scope?.kind === 'task') {
    params.set('projectKey', scope.projectKey)
    params.set('mode', scope.mode)
    params.set('taskId', scope.taskId?.value ?? '')
  } else if (scope?.kind === 'project') {
    params.set('projectKey', scope.projectKey)
    if (explicitScope) params.set('mode', explicitScope.mode)
  } else if (explicitScope) {
    params.set('projectKey', explicitScope.projectKey)
    params.set('mode', explicitScope.mode)
  }
  return params
}

function productReadQuery(scope) {
  const params = new URLSearchParams()
  const projectKey = typeof scope?.projectKey === 'string' && scope.projectKey !== ''
    ? scope.projectKey
    : explicitScope?.projectKey
  const mode = scope?.mode === 'fake' || scope?.mode === 'rcc' || scope?.mode === 'dsh'
    ? scope.mode
    : explicitScope?.mode
  if (projectKey) params.set('projectKey', projectKey)
  if (mode) params.set('mode', mode)
  const taskValue = typeof scope?.taskId === 'object' ? scope.taskId?.value : scope?.taskId
  if (typeof taskValue === 'string' && taskValue !== '') params.set('taskId', taskValue)
  if (typeof scope?.sessionRef?.sourceKind === 'string' && scope.sessionRef.sourceKind !== '') {
    params.set('sessionKind', scope.sessionRef.sourceKind)
  }
  if (typeof scope?.sessionRef?.sourceRef === 'string' && scope.sessionRef.sourceRef !== '') {
    params.set('sessionId', scope.sessionRef.sourceRef)
  }
  return params
}

async function fetchProductRead(path, params) {
  const response = await globalThis.fetch(`${path}?${params}`)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const failure = productFailure(
      { ...(body?.error ?? body), status: response.status },
      'product-read.http',
    )
    const error = new Error(failure.message)
    Object.assign(error, failure, { status: response.status })
    throw error
  }
  return body
}

function pageProductTransport() {
  return {
    readProductSession: (scope) => fetchProductRead('/api/product/session', productReadQuery(scope)),
    readProductDecision: (scope) => fetchProductRead('/api/product/decision', productReadQuery(scope)),
    readProductRelations: (scope) => fetchProductRead('/api/product/relations', productScopeQuery(scope)),
    readProductOutput: (taskIdValue) => {
      const params = new URLSearchParams()
      params.set('taskId', String(taskIdValue?.value ?? taskIdValue))
      if (explicitScope) {
        params.set('projectKey', explicitScope.projectKey)
        params.set('mode', explicitScope.mode)
      }
      return fetchProductRead('/api/product/output', params)
    },
    readTaskGrant: (...args) => api.readTaskGrant(...args),
    grantTaskControl: (...args) => api.grantTaskControl(...args),
    revokeTaskGrant: (...args) => api.revokeTaskGrant(...args),
    stop: (...args) => api.stop(...args),
  }
}

function productDashboardIsLive() {
  return Boolean(dashboard && ['created', 'admitted', 'running', 'settling', 'waiting'].includes(dashboard.state))
}

// The product center stays in the main layer. The live intervention entry is
// mounted only when the focus is exact and the focus's own completed read
// classifies it as Live. The page never borrows the state of the task that
// opened the page. The pending decision is owned by the focus controller's
// owner read; this page never synthesizes one from the URL or a grant readback.
export function renderProductSessionExtras(host, { focus, lane, transport }) {
  if (!focus || !isExactControllableTarget(focus)) return
  if (lane === 'live') {
    const interventionHost = element('div', undefined, 'product-focus-intervention')
    interventionHost.dataset.productFocusControl = 'intervention'
    renderInterventionEntry(interventionHost, focus, transport ?? productFocusController?.transport ?? api, {
      element,
      modalHost: host,
    })
    host.append(interventionHost)
  }
}

function ensureProductFocus() {
  if (TASK_DASHBOARD_TEST_MODE || !explicitScope) return null
  if (productFocusController) return productFocusController
  productCenterHost = element('div', undefined, 'product-focus-center-host')
  productCenterHost.dataset.productFocusHost = 'center'
  if (hosts.relation) {
    productRelationHost = element('div', undefined, 'product-focus-relation-host')
    productRelationHost.dataset.productFocusHost = 'relation'
    hosts.relation.append(productRelationHost)
  }
  productFocusController = createTaskFocusController({
    centerHost: productCenterHost,
    ...(productRelationHost ? { relationHost: productRelationHost } : {}),
    transport: pageProductTransport(),
    element,
    readLocation: readPageProductLocation,
    writeLocation: writePageProductLocation,
    replaceLocation: replacePageProductLocation,
    closeRelationLayer: () => template.closeRelation?.(),
    onSessionRendered: renderProductSessionExtras,
  })
  return productFocusController
}

function applyDisplayMode(mode) {
  return shell.applyDisplayMode(mode)
}

const refreshButton = element('button', '刷新当前范围', 'button button--quiet')
refreshButton.type = 'button'
refreshButton.dataset.pageRefresh = 'true'
refreshButton.addEventListener('click', refreshPage)
heading.append(refreshButton)

function refreshPage() {
  if (pageDisposed) return
  // A manual refresh is the one path that re-reads the shared semantic panel.
  // Plain re-renders re-attach its retained host without a new request.
  void refresh().then(() => semanticObservationPanel?.reload()).catch(setRefreshError)
}

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
 * The selected reading mode owns what the primary/support hosts show. A background refresh
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
  clearNode(primary)
  clearNode(support)
  primary.append(renderSemanticObservationSection())
  support.append(mode === 'semantic' ? renderPlanHistoryDetailSection() : renderRecordsDetailSection(mode))
  const trace = element('details', undefined, 'display-detail-fold')
  trace.dataset.executionTraceDetail = 'true'
  trace.open = executionTraceDetailOpen
  trace.append(element('summary', '任务事件明细'))
  trace.addEventListener('toggle', () => { executionTraceDetailOpen = trace.open })
  trace.append(renderExecutionTraceSection())
  support.append(trace)
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
// keys, so reload and popstate restore the exact target. The page slots and the
// shared shell detail layer each own a disposer so replacing a renderer cannot
// leave a stale listener behind.
let checkpointViewDispose = null
let checkpointRenderRead = null
let checkpointDetailDispose = null
let checkpointDetailOpen = false
let checkpointDetailSerial = 0

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

function releaseCheckpointDetail() {
  invalidateCheckpointAssetBody()
  disposeCheckpointDetailRenderer()
}

function disposeCheckpointDetailRenderer() {
  checkpointDetailOpen = false
  if (checkpointDetailDispose) {
    checkpointDetailDispose()
    checkpointDetailDispose = null
  }
}

function closeCheckpointDetail() {
  const wasOpen = checkpointDetailOpen
  releaseCheckpointDetail()
  if (wasOpen) detail.close()
}

// Every drill-down reuses the one shell layer, so the exact checkpoint detail and
// a chosen reference share the same desktop side panel / mobile bottom drawer.
// There is no second overlay and no page-owned store.
function showCheckpointDetail(title, content, dispose, trigger) {
  const serial = ++checkpointDetailSerial
  disposeCheckpointDetailRenderer()
  checkpointDetailDispose = dispose ?? null
  checkpointDetailOpen = true
  openPageDetail({
    title,
    content,
    onClose: () => {
      if (serial === checkpointDetailSerial) releaseCheckpointDetail()
    },
  }, trigger)
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
  const reopenDetail = checkpointDetailOpen
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
// Unknown or malformed states stay out of the page slots and remain diagnosable here.
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
  if (pageDisposed) return
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
  if (pageDisposed) return
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
  if (pageDisposed) return
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
  if (checkpointDetailOpen) openCheckpointDetail()
}

async function renderCheckpointHistoryView(host, keep = false) {
  if (pageDisposed) return
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
  if (pageDisposed) return
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
  if (pageDisposed) return
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
  if (pageDisposed) return
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
  if (pageDisposed) return
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
    if (pageDisposed) return
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
    onOpenDetail: openPageDetail,
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
    if (pageDisposed) return
    agentReadFailure = error
    setRefreshError(error)
  } finally {
    agentReadPending = false
    if (dashboard && !pageDisposed) renderActiveReadingMode()
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

function releaseAgentDetail() {
  agentDetailOpen = false
  if (agentDetailDispose) {
    agentDetailDispose()
    agentDetailDispose = null
  }
}

function closeAgentDetail() {
  const wasOpen = agentDetailOpen
  releaseAgentDetail()
  if (wasOpen) detail.close()
}

// One shared shell layer hosts every drill-down: this page never opens a second
// overlay. The A3 module only builds content; focus and close stay with the shell.
function openAgentDetail(payload) {
  if (!payload || !payload.selection) return
  const serial = ++agentDetailSerial
  releaseAgentDetail()
  agentDetailOpen = true
  if (payload.kind === 'activity') {
    const read = dashboard?.agentActivity
    if (!read) {
      releaseAgentDetail()
      return
    }
    const detail = renderAgentActivityDetail(read, {
      element,
      onSelect: (selection) => void selectAgentInstance(selection),
      onOpenDetail: openAgentDetail,
    })
    agentDetailDispose = detail.dispose
    openPageDetail({
      title: '运行实例详情',
      content: detail.element,
      onClose: () => {
        if (serial === agentDetailSerial) releaseAgentDetail()
      },
    })
    return
  }
  openPageDetail({
    title: '关联引用',
    content: agentReferenceDetail(payload),
    onClose: () => {
      if (serial === agentDetailSerial) releaseAgentDetail()
    },
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
  technical.addEventListener('click', () => openPageDetail({
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
  taskGrantControlHost.dataset.taskGrantControlDrawer = 'true'
  openPageDetail({
    title: '任务控制 / 执行授权',
    content: taskGrantControlHost,
    onClose: () => {
      taskGrantDrawerOpen = false
      taskGrantDrawerDismissed = true
      if (taskGrantEntry?.isConnected) taskGrantEntry.focus()
    },
  }, taskGrantEntry)
}

async function refreshTaskGrantControl() {
  if (pageDisposed) return
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
    if (pageDisposed) return
    taskGrantReadState = taskGrantTargetMatches() ? 'ready' : 'unconfirmed'
  } catch (error) {
    if (pageDisposed) return
    taskGrantRead = error?.status === 409 || error?.status === 400 ? null : previousRead
    taskGrantReadState = error?.status === 409 ? 'target-unverified'
      : error?.status === 400 ? 'unavailable'
        : taskGrantReceipt ? 'unconfirmed' : 'unavailable'
    taskGrantReadError = error
  }
  if (!pageDisposed) renderTaskGrantControlInto(taskGrantControlHost)
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
    if (pageDisposed) return
    taskGrantReceipt = receipt
    taskGrantBusy = false
    try {
      await refreshTaskGrantControl()
    } catch (error) {
      taskGrantReadError = error
      taskGrantReadState = 'unconfirmed'
    }
    if (!pageDisposed) renderTaskGrantControlInto(taskGrantControlHost)
  } catch (error) {
    if (pageDisposed) return
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
  clearNode(primary)
  clearNode(support)

  const titleBlock = element('div', undefined, 'task-title-block')
  titleBlock.append(element('h2', taskRowTitle(dashboard), 'task-title task-title-current'))
  const fullBrief = element('button', '查看完整任务说明', 'button button--quiet')
  fullBrief.type = 'button'
  fullBrief.addEventListener('click', () => {
    const content = element('div')
    if (dashboard.taskTitle && dashboard.taskTitle !== taskRowTitle(dashboard) && dashboard.taskTitle !== dashboard.input) {
      content.append(element('h3', '原始任务名称'), element('p', dashboard.taskTitle, 'business-output-text'))
    }
    content.append(renderTaskDescriptionContent({ input: dashboard.input }))
    openPageDetail({ title: '任务说明', eyebrow: '任务说明', content })
  })
  titleBlock.append(fullBrief)
  const stateChip = element('span', businessStateLabel(), 'state-chip')
  stateChip.dataset.tone = stateTone(dashboard.state)
  const currentCopy = element('div', undefined, 'page-heading-copy')
  currentCopy.append(element('p', '当前任务', 'eyebrow'), titleBlock, stateChip)
  if (explicitScope) {
    const breadcrumbs = element('nav', undefined, 'breadcrumbs')
    breadcrumbs.setAttribute('aria-label', '范围面包屑')
    const system = element('a', '全部项目')
    system.href = './tasks.html'
    const project = element('a', '所属项目')
    project.href = `./tasks.html?projectKey=${encodeURIComponent(explicitScope.projectKey)}`
    breadcrumbs.append(system, project, element('span', '当前任务'))
    currentCopy.append(breadcrumbs)
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
    currentCopy.append(control)
    taskGrantEntry = control
  }
  const currentSection = element('section', undefined, 'section task-dashboard-summary')
  currentSection.append(currentCopy)
  primary.append(currentSection)

  const productFocus = ensureProductFocus()
  if (productFocus) primary.append(productFocus.centerHost)

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
    primary.append(errorNotice)
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
    primary.append(currentSection)
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
  technicalDetail.addEventListener('click', () => openPageDetail({
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
  support.append(renderDashboardDetailFold('运行与连接详情', supportDetails))

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
    support.append(execution)
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
    support.append(renderDashboardDetailFold('任务计划', planDetails, planFailureVisible))
  }

  const actualGraphSection = renderActualExecutionGraphSection()
  const agentSection = renderAgentActivitySection()
  if (actualGraphSection || agentSection) {
    const runtimeDetails = element('div')
    if (actualGraphSection) runtimeDetails.append(actualGraphSection)
    if (agentSection) runtimeDetails.append(agentSection)
    support.append(renderDashboardDetailFold(
      '执行实例与分配',
      runtimeDetails,
      agentSection?.dataset.agentActivity === 'failed'
        || agentSection?.dataset.agentActivity === 'selection-failed',
    ))
  }

  const semanticSection = renderSemanticObservationSection()
  primary.append(renderDashboardDetailFold(
    '语义观测',
    semanticSection,
    semanticSection.dataset.semanticObservation === 'unavailable',
  ))
  const diagnosticsDetails = element('div')
  const traceSection = element('section', undefined, 'section')
  traceSection.append(element('h2', '执行轨迹'))
  const traceTrigger = element('button', '查看执行轨迹', 'button button--quiet')
  traceTrigger.type = 'button'
  traceTrigger.addEventListener('click', () => {
    const traceHost = element('div', undefined, 'execution-trace-drawer')
    renderExecutionTraceInto(traceHost)
    openPageDetail({ title: '执行轨迹', content: traceHost })
  })
  traceSection.append(traceTrigger)
  diagnosticsDetails.append(traceSection)
  const observationLink = element('a', '打开只读 Observation', 'button')
  observationLink.href = observationHref(taskId, explicitScope)
  diagnosticsDetails.append(observationLink)
  support.append(renderDashboardDetailFold(
    '执行轨迹与只读观测',
    diagnosticsDetails,
  ))
  if (productFocus) void productFocus.reload().catch(() => undefined)
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
    if (pageDisposed) return
    if (scopeFailure || !taskId) {
      setRefreshError(scopeFailure || { code: 'read.scope.invalid', message: 'URL 缺少 task 参数', ownerId: 'humanagent.ui', nextAction: '从项目任务行打开任务' })
      return
    }
    if (explicitScope) {
      closeStream()
      subscribedOperationId = undefined
      stopObserving()
      const read = await scopedTaskRead.refresh({ ...explicitScope, ...(agentQuery ? { agentQuery } : {}) })
      if (pageDisposed) return
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
      if (pageDisposed) return
      if (!taskGrantDrawerOpen && !taskGrantDrawerDismissed && taskGrantEntry?.isConnected) {
        openTaskGrantControl()
      }
      renderTaskGrantControlInto(taskGrantControlHost)
      return
    }
    const nextDashboard = await api.taskDashboard(taskId, agentQuery)
    if (pageDisposed) return
    dashboard = nextDashboard
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
      if (pageDisposed) return
    }
    status.dataset.tone = 'success'
    status.textContent = '任务投影已同步'
    markSync()
    renderActiveReadingMode()
  } catch (error) {
    if (pageDisposed) return
    agentReadPending = false
    if (agentQuery) agentReadFailure = error
    setRefreshError(error)
    throw error
  }
  if (pageDisposed) return
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
    if (pageDisposed) return
    await refresh()
    actionStatus.textContent = result.state === 'stopped'
      ? `stopped · operation=${result.operationId}`
      : `stop=${result.state} · operation=${result.operationId}`
  } catch (error) {
    if (pageDisposed) return
    renderPageError(actionStatus, error)
    await refresh().catch(setRefreshError)
  }
}

async function retryStopExecution() {
  try {
    actionStatus.textContent = 'retrying stop · 正在重试 stop 收拢'
    const result = await api.retryStop(taskId)
    if (pageDisposed) return
    await refresh()
    actionStatus.textContent = result.state === 'stopped'
      ? `stopped · operation=${result.operationId}`
      : `stop=${result.state} · operation=${result.operationId}`
  } catch (error) {
    if (pageDisposed) return
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
    if (pageDisposed) return
    await refresh()
  } catch (error) {
    if (pageDisposed) return
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
    if (pageDisposed) return
    renderRuntimeStatus(status, runtimeStatus, error)
    await refresh()
  } catch (error) {
    if (pageDisposed) return
    renderPageError(status, error)
  }
}

// The reading-mode controller starts only after the page's own first read has
// settled. A controller that applies `current` before the dashboard read
// resolves cannot report a truthful render receipt, so it must wait for the
// read this page actually owns.
// Back and forward re-read the exact target the URL now names. Only the open
// checkpoint level reacts; leaving the level or closing the drawer clears it, so
// a late popstate cannot publish into a departed host.
function handlePopState(event) {
  if (historyView === 'checkpoints' && historyHost?.isConnected) {
    void renderCheckpointHistoryView(historyHost, true)
  }
  if (productFocusController && !TASK_DASHBOARD_TEST_MODE) {
    const decoded = locationFromPopState(event)
    if (decoded.kind === 'valid' && productLocationMatchesTask(decoded.location)) {
      void productFocusController.applyLocation(decoded.location).catch(() => undefined)
    }
  }
}

let pageDisposed = false
function disposePage(event) {
  if (pageDisposed) return
  if (event?.persisted) return
  pageDisposed = true
  window.removeEventListener('popstate', handlePopState)
  window.removeEventListener('pagehide', disposePage)
  refreshButton.removeEventListener('click', refreshPage)
  stopObserving()
  closeStream()
  closeAgentDetail()
  closeCheckpointDetail()
  productFocusController?.dispose()
  productFocusController = null
  semanticObservationPanel?.dispose()
  semanticObservationPanel = null
  semanticObservationHost = null
  if (agentViewDispose) {
    agentViewDispose()
    agentViewDispose = null
  }
  leaveRecords()
  leaveHistory()
  template.dispose()
}

if (!TASK_DASHBOARD_TEST_MODE) {
  window.addEventListener('popstate', handlePopState)
  window.addEventListener('pagehide', disposePage)
  void load().then(() => shell.initializeDisplayPreference())
}
