import {
  RUNTIME_READ_MODES,
  api,
  clearNode,
  createScopedReadPublication,
  element,
  loadRuntimeStatus,
  mountPageTemplate,
  mountProductShell,
  renderPageError,
} from './runtime-shell.js'
import {
  PRODUCT_BOARD_LABELS,
  PRODUCT_BOARD_ORDER,
  renderProductBoardIndex,
} from './product-board-view.js'
import { encodeProductLocation, locationFromHash } from './product-location.js'
import {
  planActionsForState,
  planControlErrorMessage,
  planControlKey,
  planControlPendingCopy,
  planControlResultCopy,
  planNextDueAt,
  renderPlanSection,
} from './plan-control.js'

const REFRESH_MS = 4000
const PRODUCT_BOARD_ENDPOINT = '/api/product/board'
const BOARD_LANES = Object.freeze(['live', 'history', 'unknown'])

function searchParams(search) {
  if (search instanceof URLSearchParams) return search
  if (typeof search === 'string') {
    return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  }
  return new URLSearchParams()
}

function readMode(value) {
  return RUNTIME_READ_MODES.includes(value) ? value : undefined
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function taskIdValue(taskId) {
  if (typeof taskId === 'string') return taskId
  return taskId && typeof taskId === 'object' && typeof taskId.value === 'string'
    ? taskId.value
    : ''
}

/**
 * The board home has no task identity of its own. Its read scope comes from the
 * explicit `projectKey` selection in the URL, or the caller's default project.
 * The mode follows the same rule: URL, caller default, then the page's runtime
 * default. Without a project it stays the system scope; it never invents one.
 */
export function boardScopeFromSearch(search, defaultProjectKey, defaultMode) {
  const params = searchParams(search)
  const projectKey = textValue(params.get('projectKey')) || textValue(defaultProjectKey)
  const mode = readMode(params.get('mode')) || readMode(defaultMode)
  return projectKey
    ? { kind: 'project', projectKey, ...(mode === undefined ? {} : { mode }) }
    : { kind: 'system' }
}

/**
 * Restore the read position from the URL hash. A valid product location keeps
 * its exact scope and focus. A present but invalid product hash stays explicit:
 * the scope falls back to the URL/default project, but no focus is guessed.
 */
export function initialBoardState({ hash, search, defaultProjectKey, defaultMode } = {}) {
  const scope = boardScopeFromSearch(search, defaultProjectKey, defaultMode)
  const mode = readMode(searchParams(search).get('mode')) || readMode(defaultMode)
  if (typeof hash === 'string' && hash.trim() !== '' && hash.includes('#/boards/')) {
    const decoded = locationFromHash(hash)
    if (decoded.kind === 'valid') {
      const locationScope = decoded.location.scope
      const readScope = locationScope.kind === 'project' && mode !== undefined
        ? { ...locationScope, mode }
        : locationScope
      return { kind: 'valid', location: decoded.location, scope: readScope }
    }
    return { kind: 'unknown', failure: decoded.failure, scope }
  }
  return { kind: 'board', scope }
}

export function productBoardPath(scope) {
  const projectKey = textValue(scope?.projectKey)
  const mode = readMode(scope?.mode)
  if ((scope?.kind !== 'project' && scope?.kind !== 'task') || !projectKey || mode === undefined) {
    return null
  }
  const params = new URLSearchParams({ projectKey, mode })
  if (scope.kind === 'task') {
    const taskId = taskIdValue(scope.taskId)
    if (!taskId) return null
    params.set('taskId', taskId)
  }
  return `${PRODUCT_BOARD_ENDPOINT}?${params}`
}

function typedFailure(cause, fallback) {
  const failure = new Error(cause?.message || fallback.message)
  failure.code = cause?.code || fallback.code
  failure.ownerId = cause?.ownerId || fallback.ownerId
  failure.nextAction = cause?.nextAction || fallback.nextAction
  if (cause?.status !== undefined) failure.status = cause.status
  return failure
}

/**
 * Read one ProductBoardIndex. This is the local transport wrapper the shared
 * wiring contract allows while runtime-api.js has no readProductBoard export.
 * Once the shared API names it, the page can inject that reader unchanged.
 */
export async function readProductBoard(scope, { fetchImpl = globalThis.fetch } = {}) {
  const path = productBoardPath(scope)
  if (path === null) {
    throw typedFailure(undefined, {
      code: 'product-board.scope-unavailable',
      ownerId: 'humanagent.ui.dashboard',
      message: '产品板块读取需要完整的 projectKey 和 mode。',
      nextAction: 'open the dashboard from a project link that carries projectKey and mode',
    })
  }
  if (typeof fetchImpl !== 'function') {
    throw typedFailure(undefined, {
      code: 'product-board.transport-unavailable',
      ownerId: 'humanagent.ui.dashboard',
      message: 'fetch is unavailable',
      nextAction: 'open the dashboard in a browser',
    })
  }
  const response = await fetchImpl(path, {
    method: 'GET',
    headers: { accept: 'application/json' },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw typedFailure(body?.error ?? body, {
      code: 'product-board.read.failed',
      ownerId: 'humanagent.app',
      message: 'product board read failed',
      nextAction: 'retry the board read',
    })
  }
  if (!isBoardIndex(body)) {
    throw typedFailure(undefined, {
      code: 'product-board.invalid',
      ownerId: 'humanagent.app',
      message: 'product board read did not return a ProductBoardIndex',
      nextAction: 'inspect the board read owner',
    })
  }
  return body
}

function isBoardIndex(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value.boards)
}

/**
 * Page render seam. It delegates to the shared board renderer so the consumer
 * exercises the exact renderer the browser uses.
 */
export function renderBoardIndex(host, index, options = {}) {
  return renderProductBoardIndex(host, index, options)
}

/**
 * The task focus page for a card. A card with an exact task keeps the task and
 * its project/mode in the query and the whole product location in the hash.
 * A card without a task has no task page; returning null keeps the caller from
 * inventing a task or a new-task entry.
 */
export function focusPageHref(location) {
  const focus = location?.focus
  if (!focus) return null
  const hash = encodeProductLocation(location)
  const taskRef = focus.taskRef
  if (!taskRef || focus.scope?.kind !== 'task') return null
  const params = new URLSearchParams({ task: String(taskRef.value) })
  params.set('projectKey', focus.scope.projectKey)
  params.set('mode', focus.scope.mode)
  return `./task-dashboard.html?${params.toString()}${hash}`
}

/**
 * One card selection. Live/history keep their exact board, lane, focus ref and
 * the ref's own scope. Unknown has no read location and is refused.
 */
export function cardSelection(item, { board } = {}) {
  if (!item || typeof item !== 'object' || !item.ref) {
    throw new TypeError('cardSelection requires a board item with an exact ref')
  }
  if (item.lane === 'unknown') {
    throw new TypeError('unknown board items do not have a Live/history location')
  }
  if (!board) throw new TypeError('cardSelection requires the source board')
  const location = {
    board,
    lane: item.lane,
    focus: item.ref,
    scope: item.ref.scope,
  }
  return {
    location,
    hash: encodeProductLocation(location),
    href: focusPageHref(location),
  }
}

function noContentFailure() {
  return {
    code: 'product-board.no-content',
    ownerId: 'humanagent.ui.dashboard',
    message: '板块读取没有返回 ProductBoardIndex。',
    nextAction: 'retry the board read',
  }
}

/**
 * Board page controller. The shared scoped-publication owner keeps the last
 * confirmed index for the current scope, marks a same-scope refresh failure
 * stale and discards late responses. This controller only decides what to
 * render: a confirmed index, or an explicit failure when no index exists.
 * Refresh never writes; selection only changes the read location.
 */
export function createBoardController({
  publication,
  render = () => {},
  renderFailure = () => {},
  navigate = () => {},
  initialScope = { kind: 'system' },
} = {}) {
  if (!publication || typeof publication.refresh !== 'function') {
    throw new TypeError('createBoardController requires a scoped read publication')
  }

  let scope = initialScope

  async function refresh(nextScope) {
    if (nextScope !== undefined) scope = nextScope
    const result = await publication.refresh(scope)
    if (result?.reason === 'discarded-late') {
      return { ok: false, superseded: true, reason: result.reason }
    }
    const state = result?.state ?? {}
    if (!isBoardIndex(state.content)) {
      const failure = state.failure ?? noContentFailure()
      renderFailure(failure, { stale: false, reason: result?.reason })
      return { ok: false, failure, reason: result?.reason }
    }
    render(state.content, { stale: state.stale === true, failure: state.failure })
    return {
      ok: true,
      index: state.content,
      stale: state.stale === true,
      failure: state.failure,
    }
  }

  function select(item, context = {}) {
    if (!item || item.lane === 'unknown') return { ok: false, reason: 'unknown-lane' }
    const selection = cardSelection(item, context)
    navigate(selection)
    return { ok: true, selection }
  }

  function setScope(nextScope) {
    scope = nextScope
  }

  function getScope() {
    return scope
  }

  return { refresh, select, setScope, getScope }
}

// ── Browser page ──────────────────────────────────────────────────────────

function mountBoardPage(scope = { kind: 'system' }) {
  const config = {
    layout: 'collection',
    active: 'Dashboard',
    eyebrow: '工作板块',
    title: '五个工作板块',
    scope,
    breadcrumbs: [
      { label: '系统', href: null },
      { label: '全部项目', href: null },
    ],
  }
  if (typeof mountProductShell === 'function') return mountProductShell(document.body, config)
  return mountPageTemplate(document.body, config)
}

function scopeLabel(scope) {
  if (scope?.kind === 'project') return `项目 ${scope.projectKey}`
  if (scope?.kind === 'task') return `项目 ${scope.projectKey} · 任务 ${scope.taskId?.value ?? ''}`
  return '全部项目'
}

function configuredProjectKey(pageConfig) {
  return textValue(pageConfig?.defaultProjectKey) || textValue(pageConfig?.scope?.projectKey)
}

function configuredMode(pageConfig) {
  return readMode(pageConfig?.mode) || readMode(pageConfig?.scope?.mode)
}

function defaultProjectKeyFromSystemRead(systemRead) {
  const keys = []
  const liveKeys = []
  for (const project of Array.isArray(systemRead?.projects) ? systemRead.projects : []) {
    const key = textValue(project?.scope?.projectKey)
    if (!key) continue
    if (!keys.includes(key)) keys.push(key)
    const hasLiveRuntime = Array.isArray(project?.tasks)
      && project.tasks.some((row) => row?.basis === 'live-runtime')
    if (hasLiveRuntime && !liveKeys.includes(key)) liveKeys.push(key)
  }
  if (liveKeys.length === 1) return liveKeys[0]
  return keys.length === 1 ? keys[0] : ''
}

/**
 * Resolve the complete board read scope. URL selection wins over page config.
 * A missing mode comes from the live runtime status. A missing project comes
 * from the configured-project read: the one project with live-runtime rows wins,
 * otherwise a sole configured project. An ambiguous catalog stays unresolved
 * instead of guessing.
 */
async function resolveBoardReadDefaults({ search, pageConfig = {} } = {}) {
  const params = searchParams(search)
  let projectKey = textValue(params.get('projectKey')) || configuredProjectKey(pageConfig)
  let mode = readMode(params.get('mode')) || configuredMode(pageConfig)
  if (projectKey && mode !== undefined) return { projectKey, mode }

  if (mode === undefined) {
    const runtime = await loadRuntimeStatus()
    if (runtime.error) return { projectKey, mode, failure: runtime.error }
    mode = readMode(runtime.status?.mode)
  }

  if (!projectKey) {
    try {
      const systemRead = await api.systemDashboard()
      projectKey = defaultProjectKeyFromSystemRead(systemRead)
      if (mode === undefined) mode = readMode(systemRead?.runtime?.mode)
    } catch (error) {
      return { projectKey, mode, failure: error }
    }
  }
  return { projectKey, mode }
}

function bootstrapDashboardPage(pageConfig = {}) {
  const template = mountBoardPage(pageConfig.scope)
  const status = template.hosts.status
  const center = template.hosts.center ?? template.hosts.primary
  const boardHost = element('section', undefined, 'product-board-home')
  boardHost.setAttribute('aria-label', '五个 agent 板块')
  center.append(boardHost)

  const plansRegion = element('section', undefined, 'plan-list')
  const plansDetails = element('details', undefined, 'plan-list-fold')
  plansDetails.append(element('summary', '执行计划管理'), plansRegion)
  template.hosts.support.append(plansDetails)

  let pageDisposed = false
  let pollHandle = null
  let controller = null
  let renderedBoardRoot = null
  let locationFailure = null

  const publication = createScopedReadPublication((scope) => readProductBoard(scope))

  function navigateSelection(selection) {
    if (selection.href) {
      window.location.assign(selection.href)
      return
    }
    if (window.location.hash !== selection.hash) window.location.hash = selection.hash
  }

  function renderBoard(index, { stale = false, failure } = {}) {
    clearNode(status)
    status.dataset.tone = stale || locationFailure ? 'warning' : 'neutral'
    if (locationFailure) {
      status.append(element(
        'p',
        `位置无法恢复 · ${locationFailure.message} · next=${locationFailure.nextAction}`,
        'empty',
      ))
    }
    if (stale) {
      status.append(element('span', '上次读取失败，当前显示上次确认的板块内容。', 'status-note'))
      if (failure) {
        const details = element('details', undefined, 'status-detail')
        details.append(
          element('summary', '读取失败详情'),
          element('p', `${failure.code} · ${failure.ownerId} · ${failure.message} · next=${failure.nextAction}`, 'empty'),
        )
        status.append(details)
      }
    }
    const itemBoards = new WeakMap()
    for (const section of index.boards) {
      for (const lane of BOARD_LANES) {
        for (const item of section[lane] || []) itemBoards.set(item, section.board)
      }
    }
    renderedBoardRoot = renderBoardIndex(boardHost, index, {
      element,
      onSelect: (_ref, item) => {
        controller.select(item, { board: itemBoards.get(item) })
      },
    })
  }

  function renderBoardFailure(failure) {
    const primary = failure ?? noContentFailure()
    renderPageError(status, primary)
    if (locationFailure && locationFailure.code !== primary.code) {
      status.append(element(
        'p',
        `位置无法恢复 · ${locationFailure.message} · next=${locationFailure.nextAction}`,
        'empty',
      ))
    }
    renderedBoardRoot = null
    clearNode(boardHost)
  }

  function mountBoardNav(host) {
    if (!host) return
    clearNode(host)
    const nav = element('nav', undefined, 'product-board-nav')
    nav.setAttribute('aria-label', '五个工作板块')
    for (const board of PRODUCT_BOARD_ORDER) {
      const button = element('button', PRODUCT_BOARD_LABELS[board], 'button button--quiet product-board-nav-item')
      button.type = 'button'
      button.dataset.boardNav = board
      button.addEventListener('click', () => {
        const section = Array.from(renderedBoardRoot?.children ?? [])
          .find((node) => node.getAttribute('data-product-board') === board)
        if (section && typeof section.scrollIntoView === 'function') {
          section.scrollIntoView({ block: 'start' })
        }
        if (typeof template.closeDrawer === 'function') template.closeDrawer()
      })
      nav.append(button)
    }
    host.append(nav)
  }

  mountBoardNav(template.hosts.board)

  // ── Execution-plan panel (unchanged owner) ──
  let planControlNotice = { subscriptionId: '', text: '', error: undefined }
  let lastSchedulerRead

  async function runPlanControl(subscriptionId, action) {
    if (pageDisposed) return
    planControlNotice = { subscriptionId, text: planControlPendingCopy(action), error: undefined }
    renderPlanList(lastSchedulerRead)
    try {
      const result = await api.planControl(subscriptionId, {
        action,
        idempotencyKey: planControlKey(subscriptionId, action),
        requestedAt: new Date().toISOString(),
      })
      planControlNotice = { subscriptionId, text: planControlResultCopy(action, result), error: undefined }
    } catch (error) {
      planControlNotice = { subscriptionId, text: planControlErrorMessage(error), error }
    }
    if (pageDisposed) return
    await refreshPlans()
  }

  function projectSchedulerPlan(plan) {
    return {
      subscriptionId: plan.subscriptionId,
      state: plan.state,
      nextDueAt: planNextDueAt(plan),
      goalId: plan.goalId,
      scheduleRevision: plan.scheduleRevision,
      currentOccurrenceOrdinal: plan.currentOccurrenceOrdinal,
      availableActions: planActionsForState(plan.state),
    }
  }

  function renderPlanList(scheduler) {
    lastSchedulerRead = scheduler
    clearNode(plansRegion)
    const head = element('header', undefined, 'section-head')
    const plans = scheduler?.plans ?? []
    head.append(element('h2', '执行计划'), element('span', `${plans.length} 项`, 'section-meta'))
    plansRegion.append(head)
    const panel = element('div', undefined, 'panel')
    if (scheduler?.__error) {
      panel.append(element(
        'p',
        `读取执行计划失败 · ${scheduler.__error.message} · owner=${scheduler.__error.ownerId || 'unknown'} · next=${scheduler.__error.nextAction || 'inspect the runtime error'}`,
        'empty',
      ))
    } else if (scheduler?.issue) {
      panel.append(element('p', `计划巡逻上报：${scheduler.issue.code} · ${scheduler.issue.message} · next=${scheduler.issue.nextAction}`, 'empty'))
    } else if (plans.length === 0) {
      panel.append(element('p', '当前没有已持久化的执行计划。', 'empty'))
    }
    for (const plan of plans) {
      panel.append(renderPlanSection(projectSchedulerPlan(plan), {
        ...(planControlNotice.subscriptionId === plan.subscriptionId
          ? {
              notice: planControlNotice.text,
              ...(planControlNotice.error === undefined ? {} : { error: planControlNotice.error }),
            }
          : {}),
        onControl: (action) => runPlanControl(plan.subscriptionId, action),
      }))
    }
    plansRegion.append(panel)
  }

  async function refreshPlans() {
    try {
      const scheduler = await api.scheduler().catch((error) => ({ __error: error }))
      if (!pageDisposed) renderPlanList(scheduler)
    } catch (error) {
      if (!pageDisposed) renderPlanList({ __error: error })
    }
  }

  async function refreshPage() {
    if (pageDisposed) return
    await Promise.all([
      controller.refresh(),
      refreshPlans(),
    ])
  }

  function disposePage(event) {
    if (event?.persisted) return
    if (pageDisposed) return
    pageDisposed = true
    if (pollHandle !== null) {
      clearInterval(pollHandle)
      pollHandle = null
    }
    template.dispose()
  }

  async function start() {
    const defaults = await resolveBoardReadDefaults({
      search: window.location.search,
      pageConfig,
    })
    if (pageDisposed) return
    if (defaults.failure) {
      renderPageError(status, defaults.failure)
      await refreshPlans()
      return
    }
    const initial = initialBoardState({
      hash: window.location.hash,
      search: window.location.search,
      defaultProjectKey: defaults.projectKey,
      defaultMode: defaults.mode,
    })
    template.shell?.setScope?.(initial.scope)
    template.setBreadcrumbs([
      { label: '系统', href: null },
      { label: scopeLabel(initial.scope), href: null },
    ])
    locationFailure = initial.kind === 'unknown' ? initial.failure : null
    if (locationFailure) renderPageError(status, locationFailure)
    controller = createBoardController({
      publication,
      initialScope: initial.scope,
      render: renderBoard,
      renderFailure: renderBoardFailure,
      navigate: navigateSelection,
    })
    await refreshPage()
    if (pageDisposed) return
    pollHandle = setInterval(() => void refreshPage(), REFRESH_MS)
  }

  void start().catch((error) => {
    if (!pageDisposed) renderPageError(status, error)
  })
  window.addEventListener('pagehide', disposePage)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && controller !== null) void refreshPage()
  })
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  bootstrapDashboardPage()
}
