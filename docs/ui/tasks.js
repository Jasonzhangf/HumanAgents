import {
  api,
  createScopedReadPublication,
  element,
  loadRuntimeStatus,
  mountPageTemplate,
  projectReadScopeFromQuery,
  renderPageError,
  renderProjectRead,
  renderRuntimeStatus,
  renderSystemRead,
  systemTasksHref,
} from './runtime-shell.js'
import { encodeProductLocation } from './product-location.js'

export const LEGACY_TASK_FOCUS_PAGE = './task-dashboard.html'
export const LEGACY_TASK_BOARD = 'interaction'
export const LEGACY_TASK_LANE = 'live'

const READ_MODES = new Set(['fake', 'rcc'])

export function legacyTaskScopeFailure(message) {
  return {
    code: 'read.scope.invalid',
    ownerId: 'humanagent.ui',
    message,
    nextAction: 'open the task from the project list so the URL carries task, projectKey, and mode',
  }
}

/**
 * Build the one exact product focus the page can prove from a task row: an
 * interaction focus carrying the task ref and the task read scope. Board is a
 * presentation default only; no session or execution-instance identity is
 * invented from a title or a board name.
 */
export function taskFocusLocation(scope) {
  return {
    board: LEGACY_TASK_BOARD,
    lane: LEGACY_TASK_LANE,
    scope,
    focus: { kind: 'interaction', taskRef: scope.taskId, scope },
  }
}

export function taskFocusHref(scope) {
  const params = new URLSearchParams()
  if (scope?.kind === 'task') {
    const value = typeof scope.taskId === 'object' ? scope.taskId?.value : scope.taskId
    if (typeof value === 'string' && value !== '') params.set('task', value)
    if (typeof scope.projectKey === 'string' && scope.projectKey !== '') params.set('projectKey', scope.projectKey)
    if (typeof scope.mode === 'string' && scope.mode !== '') params.set('mode', scope.mode)
  }
  const query = params.toString()
  return `${LEGACY_TASK_FOCUS_PAGE}${query ? `?${query}` : ''}${encodeProductLocation(taskFocusLocation(scope))}`
}

/**
 * Resolve an old project/task deep link into the canonical read view. The
 * result is a pure function of the query: a task link produces the focus page
 * and exact ref, a project link produces the project collection scope, an
 * absent link produces the system scope, and a partial link fails explicitly
 * instead of guessing a fallback.
 */
export function legacyTasksDeepLink(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search ?? '')
  const task = params.get('task')
  const projectKey = params.get('projectKey')
  const mode = params.get('mode')

  if (task && projectKey && mode) {
    if (!READ_MODES.has(mode)) {
      return { kind: 'invalid', failure: legacyTaskScopeFailure(`unsupported scoped read mode: ${mode}`) }
    }
    const scope = { kind: 'task', projectKey, mode, taskId: { scope: 'task', value: task } }
    const location = taskFocusLocation(scope)
    return {
      kind: 'task',
      scope,
      focus: location.focus,
      location,
      href: taskFocusHref(scope),
    }
  }
  if (!task && !projectKey && !mode) return { kind: 'system', scope: { kind: 'system' } }
  if (task && !projectKey && !mode) return { kind: 'legacy', taskId: { scope: 'task', value: task } }
  if (projectKey && !task && !mode) return { kind: 'project', scope: { kind: 'project', projectKey } }
  return {
    kind: 'invalid',
    failure: legacyTaskScopeFailure('explicit task scope is missing task, projectKey, or mode'),
  }
}

/**
 * Rewrite an old task-dashboard query link into the canonical focus route. A
 * non-task or non-dashboard href stays untouched so the page does not invent a
 * second navigation path.
 */
export function legacyTaskFocusHref(href) {
  if (typeof href !== 'string' || !href.includes('task-dashboard.html')) return null
  const queryIndex = href.indexOf('?')
  if (queryIndex < 0) return null
  const deep = legacyTasksDeepLink(href.slice(queryIndex))
  return deep.kind === 'task' ? deep.href : null
}

/**
 * Resolve the Task List read scope the same way the Dashboard resolves its
 * board scope: an explicit URL scope always wins, and a bare URL falls back to
 * the live serve binding (runtime status projectKey plus mode). The explicit
 * `scope=system` selection keeps the system ("全部项目") list reachable even
 * when the serve is bound to a project. A failed runtime status read never
 * invents a scope; with no binding the page stays on the system scope.
 */
export function resolveTasksReadScope(search, runtime = { status: null, error: null }) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search ?? '')
  const explicitSystem = params.get('scope') === 'system'
    && !params.get('projectKey') && !params.get('mode') && !params.get('task')
  if (explicitSystem) return { kind: 'system' }

  const deep = legacyTasksDeepLink(search)
  if (deep.kind === 'project' || deep.kind === 'task') return deep.scope
  if (deep.kind === 'invalid' || deep.kind === 'legacy') return deep

  const status = runtime?.status
  if (runtime?.error || !status || typeof status !== 'object') {
    return { kind: 'system' }
  }
  const projectKey = typeof status.projectKey === 'string' ? status.projectKey.trim() : ''
  if (projectKey === '') return { kind: 'system' }
  const result = { kind: 'project', projectKey }
  const mode = READ_MODES.has(status.mode) ? status.mode : undefined
  return mode === undefined ? result : { ...result, mode }
}

function projectBreadcrumbs(label) {
  return [
    { label: '系统', href: './dashboard.html' },
    { label: '项目', href: systemTasksHref() },
    { label, href: null },
  ]
}

async function mountTasksPage() {
  const deepLink = legacyTasksDeepLink(location.search)

  // An old task-scoped link enters the focus page directly. It is a one-shot
  // navigation, not a page-owned navigation state.
  if (deepLink.kind === 'task') {
    location.replace(deepLink.href)
    return
  }

  // An explicit URL scope never needs the serve binding. Only the bare default
  // reads runtime status, the same way the Dashboard resolves its board scope.
  const runtimeStatus = deepLink.kind === 'system'
    ? await loadRuntimeStatus()
    : null
  const readScope = resolveTasksReadScope(location.search, runtimeStatus)
  const projectView = readScope.kind === 'project'
  // An invalid or legacy link never reads. It keeps the system-shaped page
  // frame while the explicit failure below names the real problem.
  const pageScope = projectView || readScope.kind === 'system' ? readScope : { kind: 'system' }

  const template = mountPageTemplate(document.getElementById('page-root'), {
    layout: 'collection',
    active: 'Task List',
    eyebrow: '',
    title: projectView ? '项目任务' : '全部项目',
    lede: projectView
      ? '这里列出这个项目本次读取返回的任务，并标明读取是否完整。'
      : '这里列出系统本次读取返回的项目，并标明读取范围是否已确认。',
    scope: pageScope,
    breadcrumbs: projectView
      ? projectBreadcrumbs('当前项目')
      : [
          { label: '系统', href: './dashboard.html' },
          { label: '全部项目', href: null },
        ],
  })

  const { primary, status } = template.hosts
  const { setBreadcrumbs } = template

  const listRegion = element('div', undefined, 'task-lists')
  const refreshButton = element('button', '刷新当前范围', 'button button--quiet')
  refreshButton.type = 'button'
  refreshButton.dataset.taskListRefresh = ''
  refreshButton.addEventListener('click', () => void load())
  primary.append(refreshButton, listRegion)

  // Task rows keep the collection renderer; a click on an old task-dashboard
  // href is rewritten to the canonical focus route on the fly, so the list
  // itself owns no second navigation state.
  listRegion.addEventListener('click', (event) => {
    const target = event?.target
    if (!target || typeof target.closest !== 'function') return
    const link = target.closest('a[href]')
    if (!link) return
    const next = legacyTaskFocusHref(link.getAttribute('href'))
    if (!next) return
    event.preventDefault()
    location.assign(next)
  })

  const readPublication = createScopedReadPublication((scope) => (
    scope.kind === 'project'
      ? api.projectDashboard({ projectKey: scope.projectKey })
      : api.systemDashboard()
  ))

  function renderReadState(state) {
    if (!state.content) {
      renderPageError(status, state.failure || {
        message: 'scoped read failed',
        ownerId: 'humanagent.ui',
        nextAction: 'retry the same scoped read',
      })
      return
    }
    listRegion.replaceChildren()
    if (state.content.scope?.kind === 'project') {
      listRegion.append(renderProjectRead(state.content, { includeProjectLink: false }))
    } else {
      listRegion.append(renderSystemRead(state.content, { includeTasks: false }))
    }
    if (state.stale) {
      renderPageError(status, state.failure)
      status.dataset.tone = 'warning'
      status.append(element('span', ' · 上次读取失败，当前显示上次确认内容（stale）'))
    }
  }

  function applyProjectBreadcrumb(state) {
    if (!projectView) return
    const content = state?.content
    const label = content?.scope?.kind === 'project'
      && content.scope.projectKey === readScope.projectKey
      && typeof content.label === 'string'
      && content.label.trim() !== ''
      ? content.label
      : '当前项目'
    setBreadcrumbs(projectBreadcrumbs(label))
  }

  // The initial status result already decided the default scope, so the first
  // render reuses it; a manual refresh reads the status again.
  async function load(runtimeResult = null) {
    try {
      const [read, runtime] = await Promise.all([
        readPublication.refresh(readScope),
        runtimeResult ?? loadRuntimeStatus(),
      ])
      if (!read.published) return
      renderRuntimeStatus(status, runtime.status, runtime.error)
      renderReadState(read.state)
      applyProjectBreadcrumb(read.state)
    } catch (error) {
      renderPageError(status, error)
    }
  }

  if (deepLink.kind === 'invalid' || deepLink.kind === 'legacy') {
    renderPageError(status, deepLink.failure || legacyTaskScopeFailure('legacy task link has no readable scope'))
    return
  }

  window.addEventListener('pagehide', (event) => {
    if (event?.persisted) return
    template.dispose()
  })

  void load(runtimeStatus)
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && typeof location !== 'undefined') {
  void mountTasksPage()
}
