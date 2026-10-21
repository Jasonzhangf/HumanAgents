import {
  clearNode,
  createRuntimeApi,
  createRuntimeReadPublication,
  element,
  formatTime,
  freezeJsonValue,
  isAuthSessionError,
  loginHref,
  queryParam,
  readScopeKey,
  stateTone,
} from './runtime-api.js'
import {
  createDisplayPreferenceController,
  DISPLAY_ORIGINS,
  DISPLAY_MODES,
  DISPLAY_PREFERENCE_MODES,
} from './display-preferences.js'
import {
  DISPLAY_MODE_DESCRIPTIONS,
  displayModeLabel,
  unavailableModeFailure,
} from './task-display.js'
import {
  UNCLASSIFIED_REASON_LABELS,
  groupTaskFlowRows,
  unclassifiedTaskFlowReason,
} from './task-flow-groups.js'
import { mountSemanticObservation, renderSemanticEvidenceContent } from './semantic-observation.js'
import { buildSemanticObservationProjection } from './semantic-observation-projection.js'

export const api = createRuntimeApi()

export { buildSemanticObservationProjection }

// The path the browser is on now. Pairing must return the user to the entry that
// actually failed instead of dropping them on a default page.
function currentEntryPath() {
  return `${location.pathname}${location.search}`
}

/**
 * A typed session rejection says "pair this browser", so the surface that shows
 * it must carry a real link to the page that pairs. The runtime's own
 * code/owner/message/nextAction are preserved verbatim; the link only adds the
 * entry the user was trying to reach.
 */
export function appendPairingEntry(target, error) {
  if (!isAuthSessionError(error)) return false
  const link = element('a', '打开登录页并配对这台浏览器', 'auth-pair-link')
  link.href = loginHref(error, currentEntryPath())
  link.dataset.authPairLink = 'true'
  target.append(link)
  return true
}

export async function loadRuntimeStatus() {
  try {
    const status = await api.status()
    return { status, error: null }
  } catch (error) {
    return { status: null, error }
  }
}

export function renderRuntimeStatus(target, status, error) {
  clearNode(target)
  if (error) {
    const copy = readFailureCopy(error)
    target.dataset.tone = 'danger'
    target.append(
      element('strong', copy.result),
      element('p', copy.next),
      technicalDetailTrigger(() => ({
        title: '技术详情',
        entries: errorDetailEntries(error, 'retry the runtime status read'),
      })),
    )
    appendPairingEntry(target, error)
    return
  }
  target.dataset.tone = status.state === 'ready' ? 'success' : 'warning'
  if (status.implicitScheduling) target.dataset.tone = status.implicitScheduling.state === 'failed' ? 'danger' : 'warning'
  const modeLabel = status.mode === 'fake' ? '演示模式' : `模式 ${status.mode}`
  const stateLabel = status.state === 'ready' ? '运行正常' : '运行状态需要注意'
  const summary = [status.connected ? '服务已连接。' : '服务当前未连接。']
  if (status.providerError) summary.push('提供方状态需要注意，可打开技术详情核对。')
  if (status.implicitScheduling) {
    summary.push(status.implicitScheduling.state === 'failed'
      ? '隐式调度失败，可打开技术详情核对。'
      : '隐式调度需要注意，可打开技术详情核对。')
  }
  const entries = [
    ['mode', status.mode, 'data-detail-mode'],
    ['state', status.state, 'data-detail-state'],
    ['providerState', status.providerState, 'data-detail-provider-state'],
    ['connected', String(status.connected), 'data-detail-connected'],
  ]
  if (status.providerError) {
    entries.push(
      ['providerError.code', status.providerError.code, 'data-detail-provider-code'],
      ['providerError.owner', status.providerError.ownerId, 'data-detail-provider-owner'],
      ['providerError.message', status.providerError.message, 'data-detail-provider-message'],
      ['providerError.nextAction', status.providerError.nextAction, 'data-detail-provider-next'],
    )
  }
  if (status.implicitScheduling) {
    entries.push(
      ['implicit.requirementId', status.implicitScheduling.requirementId, 'data-detail-implicit-requirement'],
      ['implicit.code', status.implicitScheduling.code, 'data-detail-implicit-code'],
      ['implicit.owner', status.implicitScheduling.ownerId, 'data-detail-implicit-owner'],
      ['implicit.nextAction', status.implicitScheduling.nextAction, 'data-detail-implicit-next'],
    )
  }
  target.append(
    element('strong', `${modeLabel} · ${stateLabel}`),
    element('p', summary.join('')),
    technicalDetailTrigger(() => ({ title: '技术详情', entries })),
  )
}

export function makeTopbar(active) {
  const header = element('header', undefined, 'topbar')
  const brand = element('a', 'HumanAgent', 'brand')
  brand.href = './dashboard.html'
  const nav = element('nav', undefined, 'topnav')
  nav.setAttribute('aria-label', '主导航')
  const links = [
    ['dashboard.html', 'Dashboard'],
    ['tasks.html', 'Task List'],
    ['./index.html', '新建 Task'],
    ['memory.html', 'Memory'],
  ]
  for (const [href, label] of links) {
    const link = element('a', label)
    link.href = href
    if (label === active) link.setAttribute('aria-current', 'page')
    nav.append(link)
  }
  header.append(brand, nav)
  return header
}

// The four corner buttons are the surface's persistent configuration entries: top-left work
// scope, top-right view mode, bottom-left display settings, bottom-right input settings. Each
// one opens the same next-layer panel instead of stacking dialogs. The panel only reports what
// the current surface really supports: it never renders a fake selector and never calls a task
// action, so opening or closing it cannot change task state.
const SHELL_SECTIONS = [
  { id: 'scope', corner: 'top-left', label: '工作范围', title: '工作范围：查看当前内容属于哪个任务' },
  { id: 'view', corner: 'top-right', label: '查看方式', title: '查看方式：选择这一层的阅读深度' },
  { id: 'display', corner: 'bottom-left', label: '显示设置', title: '显示设置：调整展开与排版方式' },
  { id: 'input', corner: 'bottom-right', label: '输入设置', title: '输入设置：设置如何输入与操作' },
]

export const RUNTIME_READ_MODES = Object.freeze(['fake', 'rcc'])

function taskIdValue(taskId) {
  return taskId && typeof taskId === 'object' ? taskId.value : taskId
}

const TASK_RECORD_REF_KEYS = Object.freeze([
  'projectKey',
  'mode',
  'source',
  'ordinal',
  'operationId',
  'executionEpoch',
  'checkpointId',
])

/**
 * Exact stored-record identity shared by the scoped pagination check and the
 * raw renderer.
 */
export function sameStoredRecordRef(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  return TASK_RECORD_REF_KEYS.every((key) => left[key] === right[key])
    && taskIdValue(left.taskId) === taskIdValue(right.taskId)
}

export function readScopeLabel(scope) {
  if (scope?.kind === 'system') return '全部项目（System）'
  if (scope?.kind === 'project') return `项目 ${scope.projectKey}`
  if (scope?.kind === 'task') {
    return `项目 ${scope.projectKey} · 模式 ${scope.mode} · 任务 ${taskIdValue(scope.taskId)}`
  }
  return '未确认范围'
}

/**
 * Read the project selection carried by the URL. The URL is UI display state;
 * it never changes the runtime's current project or execution mode.
 */
export function projectReadScopeFromQuery() {
  const projectKey = queryParam('projectKey')
  return projectKey
    ? { kind: 'project', projectKey }
    : { kind: 'system' }
}

/**
 * Read an explicit task scope from the URL. A task page without any scope is
 * kept as a legacy read for old links. A partial or unsupported explicit scope
 * is invalid and must fail visibly instead of falling back to another project.
 */
export function taskReadScopeFromQuery() {
  const task = queryParam('task')
  const projectKey = queryParam('projectKey')
  const mode = queryParam('mode')
  if (task && !projectKey && !mode) return { kind: 'legacy', taskId: task }
  if (!task && !projectKey && !mode) return { kind: 'legacy', taskId: undefined }
  const missing = []
  if (!task) missing.push('task')
  if (!projectKey) missing.push('projectKey')
  if (!mode) missing.push('mode')
  if (missing.length > 0) {
    return {
      kind: 'invalid',
      failure: {
        code: 'read.scope.invalid',
        ownerId: 'humanagent.ui',
        message: `explicit task scope is missing ${missing.join(', ')}`,
        nextAction: 'open the task from the project list so the URL carries task, projectKey, and mode',
      },
    }
  }
  if (!RUNTIME_READ_MODES.includes(mode)) {
    return {
      kind: 'invalid',
      failure: {
        code: 'read.scope.invalid',
        ownerId: 'humanagent.ui',
        message: `unsupported scoped read mode: ${mode}`,
        nextAction: 'use a task row whose mode is fake or rcc',
      },
    }
  }
  return { kind: 'task', projectKey, mode, taskId: { value: task } }
}

function addTaskScope(params, scope) {
  if (scope?.kind === 'task') {
    params.set('projectKey', scope.projectKey)
    params.set('mode', scope.mode)
  }
  return params
}

export function projectTasksHref(projectKey) {
  return `./tasks.html?projectKey=${encodeURIComponent(projectKey)}`
}

export function systemTasksHref() {
  return './tasks.html'
}

export function observationHref(taskId, scope) {
  const params = new URLSearchParams({ task: String(taskIdValue(taskId)) })
  addTaskScope(params, scope)
  return `./observation.html?${params}`
}

export function taskDashboardHref(taskId, scope) {
  const params = new URLSearchParams({ task: String(taskIdValue(taskId)) })
  addTaskScope(params, scope)
  return `./task-dashboard.html?${params}`
}

// The control entry is a second explicit intent over the same formal Task
// navigation. The default link stays readonly; this link never drops the
// scoped Task identity that the control target resolver must verify.
export function taskControlHref(taskId, scope) {
  const params = new URLSearchParams({ task: String(taskIdValue(taskId)) })
  addTaskScope(params, scope)
  params.set('control', '1')
  return `./task-dashboard.html?${params}`
}

export function taskDetailHref(taskId, scope) {
  const params = new URLSearchParams({ task: String(taskIdValue(taskId)) })
  addTaskScope(params, scope)
  return `./task.html?${params}`
}

/**
 * Wrap an existing public GET in the shared scoped-publication owner. The API
 * builders return projections, while the publication owner consumes typed
 * results; this adapter keeps that conversion in one place for every page.
 */
export function createScopedReadPublication(read) {
  if (typeof read !== 'function') throw new TypeError('createScopedReadPublication requires a read function')
  return createRuntimeReadPublication({
    read: async (scope) => {
      try {
        return { ok: true, value: await read(scope) }
      } catch (error) {
        return { ok: false, failure: error }
      }
    },
  })
}

// Human failure copy for one scoped/page read. The mapping covers the codes the runtime
// or the scoped UI read owner actually returns; every other code keeps the confirmed
// default (this read failed, the specific reason is not confirmed yet) instead of guessing
// a direction. The exact code/owner/message/nextAction stay verbatim in the evidence
// detail, so the mapping never hides or relabels an unknown failure.
const READ_FAILURE_COPY = Object.freeze({
  'auth.session.missing': {
    result: '这台浏览器尚未配对',
    next: '请打开配对入口，用一次性配对码连接这台浏览器。',
  },
  'auth.session.expired': {
    result: '会话已失效',
    next: '请打开配对入口，用一次性配对码重新配对这台浏览器。',
  },
  'auth.session.invalid': {
    result: '会话无效',
    next: '请打开配对入口，用一次性配对码重新配对这台浏览器。',
  },
  'read.scope.invalid': {
    result: '读取范围不完整',
    next: '请从项目或任务列表重新打开这一层，不要选择未知范围。',
  },
  'runtime.read.invalid-target': {
    result: '读取目标不在当前范围内',
    next: '请从项目或任务列表重新打开这一层，不要选择未知范围。',
  },
  'project.unknown': {
    result: '当前范围内没有这个项目',
    next: '请回到项目列表核对范围后再进入。',
  },
  'task.not-found': {
    result: '当前范围内没有这个任务',
    next: '请回到任务列表核对范围后再进入。',
  },
  'task.not.found': {
    result: '当前范围内没有这个任务',
    next: '请回到任务列表核对范围后再进入。',
  },
  'i2.history.unavailable': {
    result: '权威历史读取尚未接入',
    next: '此次历史结果暂不可用，请查看已有详情。',
  },
  'history.identity.mismatch': {
    result: '历史读取范围不匹配',
    next: '请从所属项目重新打开任务历史。',
  },
  'history.comparison.mismatch': {
    result: '巡检对比记录与所选轮次不一致',
    next: '请重新选择两次记录比较。',
  },
  'project-manifest-missing': {
    result: '该项目资源未登记',
    next: '请先登记该项目再读取。',
  },
})

function readFailureCopy(failure) {
  return READ_FAILURE_COPY[failure?.code] || {
    result: '这次读取没有成功',
    next: '具体原因尚未确认，可打开技术详情核对。',
  }
}

function renderScopedFailures(failures, emptyText) {
  const panel = element('div', undefined, 'panel scope-failures')
  if (!failures || failures.length === 0) {
    if (emptyText) panel.append(element('p', emptyText, 'empty'))
    return panel
  }
  panel.append(element('p', '部分内容读取失败', 'eyebrow'))
  for (const failure of failures) {
    const row = element('div', undefined, 'scope-failure')
    row.dataset.failureCode = failure.code || ''
    const copy = readFailureCopy(failure)
    row.append(
      element('strong', copy.result),
      element('p', copy.next),
      historyRawDetail([
        ['code', failure.code || 'read.failed'],
        ['detail', `${failure.message || ''} · owner=${failure.ownerId || 'unknown'} · next=${failure.nextAction || 'retry the same read'}`],
      ]),
    )
    panel.append(row)
  }
  return panel
}

function publishedOutputText(publicOutput) {
  const commits = publicOutput?.commits
  if (!Array.isArray(commits)) return ''
  for (let index = commits.length - 1; index >= 0; index -= 1) {
    const text = commits[index]?.text
    if (typeof text === 'string' && text.trim() !== '') return text
  }
  return ''
}

/**
 * The list row reports only facts the row itself carries. A terminal row shows
 * its committed result when one exists; otherwise the row's existing task
 * link is the result/detail entry. It never appends a required nextStep or
 * advertises a control that the row did not receive.
 */
export function taskRowTitle(task) {
  return typeof task?.semanticTitle === 'string' && task.semanticTitle.trim() !== ''
    ? task.semanticTitle
    : '未整理名称的任务'
}

export function taskFlowText(taskFlow) {
  return { 'one-shot': '单次任务', inspection: '巡检任务', 'long-running': '长程任务' }[taskFlow?.kind] || ''
}

export function taskExecutionHref(child, control = false, readScope = undefined) {
  if (control && !child.controlTarget) return undefined
  const scopeSource = control
    ? child.controlTarget
    : readScope !== undefined ? readScope : child.controlTarget
  const scope = scopeSource ? { kind: 'task', ...scopeSource } : undefined
  return control ? taskControlHref(child.taskId, scope) : taskDashboardHref(child.taskId, scope)
}

// The list projection already chose the current child. Read that exact choice
// instead of re-deriving it here, and keep an unverified row on its parent.
function taskCurrentExecutionChild(task) {
  const currentId = task?.currentExecutionTaskId
  if (currentId === undefined || currentId === null) return undefined
  const executions = Array.isArray(task?.executions) ? task.executions : []
  return executions.find((child) => taskIdValue(child.taskId) === taskIdValue(currentId))
}

export function renderTaskExecutions(task, readScope = undefined) {
  if (!task.executions?.length) return null
  const details = element('details', undefined, 'section')
  details.append(element('summary', `执行记录（${task.executions.length}）`))
  for (const child of task.executions) {
    const record = element('div', undefined, 'stack')
    const read = element('a', `查看执行记录 · ${child.stateLabel || child.currentState}`, 'button button--sm')
    read.href = taskExecutionHref(child, false, readScope)
    record.append(element('p', taskRowStateText(child)), read)
    if (child.controlTarget) {
      const control = element('a', '管理此执行', 'button button--sm')
      control.href = taskExecutionHref(child, true)
      record.append(control)
    }
    details.append(record)
  }
  return details
}

export function taskRowStateText(task) {
  const state = task?.currentState || task?.stateLabel || task?.state || ''
  if (!task) return state
  const facts = taskCurrentExecutionChild(task) || task
  if (facts.error) {
    const label = task.stateLabel || facts.stateLabel || state
    const impact = ['failed', 'blocked', 'cancelled'].includes(facts.state)
      ? '暂不能继续；查看原因与恢复方式' : '查看已记录的问题'
    return [label, impact].filter(Boolean).join(' · ')
  }
  const committed = publishedOutputText(facts.publicOutput)
  if (committed) return [state, '查看已提交结果'].filter(Boolean).join(' · ')
  if (typeof facts.output === 'string' && facts.output.trim() !== '') {
    return [state, '查看结果'].filter(Boolean).join(' · ')
  }
  if (['succeeded', 'failed', 'stopped', 'cancelled', 'blocked'].includes(facts.state)) {
    return [state, '查看任务详情'].filter(Boolean).join(' · ')
  }
  return state
}

function renderTaskReadRow(row, options = {}) {
  const task = row.task
  const currentChild = taskCurrentExecutionChild(task)
  const currentScope = currentChild
    ? { ...row.scope, taskId: currentChild.taskId }
    : row.scope
  const item = element('div', undefined, 'task-item')
  const link = element('a', undefined, 'task-item-main')
  link.href = currentChild
    ? taskExecutionHref(currentChild, false, row.scope)
    : taskDashboardHref(row.scope.taskId, row.scope)
  link.dataset.taskScope = JSON.stringify(currentScope)
  link.append(
    element('h3', taskRowTitle(task)),
    element('p', taskRowStateText(task)),
  )
  const meta = element('div', undefined, 'task-item-meta')
  const state = element('span', task.stateLabel || task.state || '', 'task-state-pill')
  state.dataset.tone = stateTone(task.executionState || task.state)
  meta.append(
    state,
    element('span', row.basis === 'live-runtime' ? '当前实例' : '持久历史', 'scope-basis'),
    element('time', formatTime(task.updatedAt)),
  )
  const taskType = taskFlowText(task.taskFlow)
  if (taskType) meta.append(element('span', taskType))
  if (options.reasonLabel) meta.append(element('span', options.reasonLabel, 'task-flow-reason'))
  link.append(meta)
  item.append(link)
  const executions = renderTaskExecutions(task, row.scope)
  if (executions) item.append(executions)
  return item
}

// Scope and completeness facts belong to the section header metadata, so the
// empty paragraph below never repeats them. A System scope is confirmed only
// when both the owning scope and the known coverage token are present.
function completenessLabel(complete) {
  if (complete === true) return '本次读取完整'
  if (complete === false) return '本次读取不完整'
  return '完整性尚未确认'
}

function hasConfirmedSystemScope(projection) {
  return projection?.scope?.kind === 'system'
    && projection.coverage === 'configured-projects-in-current-control-root'
}

function hasConfirmedProjectScope(projection) {
  return projection?.scope?.kind === 'project'
    && typeof projection.scope.projectKey === 'string'
    && projection.scope.projectKey !== ''
}

function systemScopeMeta(projection) {
  return hasConfirmedSystemScope(projection) ? '读取范围：当前系统已声明的项目' : '读取范围尚未确认'
}

function projectScopeMeta(projection) {
  return hasConfirmedProjectScope(projection) ? '读取范围：当前项目' : '读取范围尚未确认'
}

function systemReadMeta(projection) {
  const projects = Array.isArray(projection.projects) ? projection.projects : null
  const parts = []
  if (projects !== null) {
    parts.push(`本次读取返回 ${projects.length} 个项目`)
    if (typeof projection.taskCount === 'number') parts.push(`本次读取返回 ${projection.taskCount} 个任务`)
  }
  parts.push(systemScopeMeta(projection), completenessLabel(projection.complete))
  return parts.join(' · ')
}

function projectTaskMeta(projection) {
  const tasks = Array.isArray(projection.tasks) ? projection.tasks : null
  const parts = []
  if (tasks !== null) parts.push(`本次读取返回 ${tasks.length} 个任务`)
  parts.push(projectScopeMeta(projection), completenessLabel(projection.complete))
  return parts.join(' · ')
}

// One type section of the grouped list. Every group reuses renderTaskReadRow, so
// the link, scope, basis, state pill and time stay owned by the shared row
// renderer. An unclassified row keeps its binding reason label visible.
function renderTaskFlowSection(group) {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(element('h3', group.label))
  section.append(head)
  const panel = element('div', undefined, 'panel')
  if (group.rows.length === 0) {
    panel.append(element('p', `本次读取的内容里没有匹配的${group.label}任务。`, 'empty'))
  } else {
    for (const row of group.rows) {
      const reason = unclassifiedTaskFlowReason(row)
      panel.append(renderTaskReadRow(row, reason ? { reasonLabel: UNCLASSIFIED_REASON_LABELS[reason] } : {}))
    }
  }
  section.append(panel)
  return section
}

// A native labelled select. The visible text is the row's own stateLabel; the raw
// state is only the transient option value used by the grouping helper. No new
// lifecycle schema and no persisted default: the choice is local view state.
function renderLifecycleControl(rows, current, onChange) {
  const label = element('label')
  const select = element('select')
  const all = element('option', '全部')
  all.value = ''
  select.append(all)
  const seen = new Set()
  for (const row of rows) {
    const state = row?.task?.state
    if (state === undefined || state === null || seen.has(state)) continue
    seen.add(state)
    const option = element('option', row.task.stateLabel || '状态未标注')
    option.value = String(state)
    select.append(option)
  }
  select.value = current ?? ''
  select.addEventListener('change', () => onChange(select.value))
  label.append('生命周期', select)
  return label
}

// Type-first grouped list. The three TaskFlow type groups render before the
// lifecycle refinement, and the helper returns the original scoped wrappers, so
// the input rows and their references are never mutated. The lifecycle choice is
// local readonly view state: it re-renders only the row sections, not the
// control, so the select keeps focus, and it never fetches or persists anything.
function renderTaskFlowGroups(rows) {
  const host = element('div')
  const sectionsHost = element('div')
  let lifecycle = ''
  const renderSections = () => {
    const grouped = groupTaskFlowRows(rows, lifecycle ? { lifecycle } : {})
    clearNode(sectionsHost)
    for (const group of grouped.sections) sectionsHost.append(renderTaskFlowSection(group))
    if (grouped.unclassified.rows.length > 0) sectionsHost.append(renderTaskFlowSection(grouped.unclassified))
  }
  renderSections()
  const control = element('div', undefined, 'actions')
  control.append(renderLifecycleControl(rows, lifecycle, (value) => {
    lifecycle = value
    renderSections()
  }))
  host.append(sectionsHost, control)
  return host
}

export function renderProjectRead(projection, options = {}) {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', projection.label || projection.scope?.projectKey || '项目'),
    element('span', projectTaskMeta(projection), 'section-meta'),
  )
  section.append(head)
  section.append(renderScopedFailures(projection.failures, null))
  const tasks = Array.isArray(projection.tasks) ? projection.tasks : null
  if (tasks === null) {
    const empty = element('div', undefined, 'panel')
    empty.append(element('p', '这次响应没有提供任务列表。', 'empty'))
    section.append(empty)
    return section
  }
  if (tasks.length === 0) {
    const empty = element('div', undefined, 'panel')
    empty.append(element('p', hasConfirmedProjectScope(projection) && projection.complete === true
      ? '该项目没有已保存的任务。'
      : '本次未读到任务。', 'empty'))
    section.append(empty)
    return section
  }
  section.append(renderTaskFlowGroups(tasks))
  if (options.includeProjectLink !== false && projection.scope?.projectKey) {
    const footer = element('p', undefined, 'section-footnote')
    const link = element('a', '在项目页查看', 'button button--quiet')
    link.href = projectTasksHref(projection.scope.projectKey)
    footer.append(link)
    section.append(footer)
  }
  return section
}

function renderProjectSummary(project) {
  const section = element('section', undefined, 'section scope-project')
  const head = element('header', undefined, 'section-head')
  const title = element('h2')
  const link = element('a', project.label || project.scope?.projectKey || '项目')
  link.href = projectTasksHref(project.scope?.projectKey || '')
  title.append(link)
  head.append(
    title,
    element('span', projectTaskMeta(project), 'section-meta'),
  )
  section.append(head)
  section.append(renderScopedFailures(project.failures, null))
  const tasks = Array.isArray(project.tasks) ? project.tasks : null
  if (tasks === null) {
    const empty = element('div', undefined, 'panel')
    empty.append(element('p', '这次响应没有提供任务列表。', 'empty'))
    section.append(empty)
    return section
  }
  if (tasks.length === 0) {
    const empty = element('div', undefined, 'panel')
    empty.append(element('p', hasConfirmedProjectScope(project) && project.complete === true
      ? '该项目没有已保存的任务。'
      : '本次未读到任务。', 'empty'))
    section.append(empty)
    return section
  }
  const panel = element('div', undefined, 'panel')
  for (const row of tasks) panel.append(renderTaskReadRow(row))
  section.append(panel)
  return section
}

export function renderSystemRead(projection, options = {}) {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', options.title || '全部项目'),
    element('span', systemReadMeta(projection), 'section-meta'),
  )
  section.append(head)
  section.append(renderScopedFailures(projection.failures, null))
  const projects = Array.isArray(projection.projects) ? projection.projects : null
  if (projects === null) {
    const empty = element('div', undefined, 'panel')
    empty.append(element('p', '这次响应没有提供项目列表。', 'empty'))
    section.append(empty)
    return section
  }
  if (projects.length === 0) {
    const empty = element('div', undefined, 'panel')
    empty.append(element('p', hasConfirmedSystemScope(projection) && projection.complete === true
      ? '当前范围内没有已声明项目。'
      : '本次未读到项目。', 'empty'))
    section.append(empty)
    return section
  }
  for (const project of projects) {
    if (options.includeTasks === false) {
      const row = element('div', undefined, 'task-item')
      const link = element('a', undefined, 'task-item-main')
      link.href = projectTasksHref(project.scope?.projectKey || '')
      link.append(
        element('h3', project.label || project.scope?.projectKey || '项目'),
        element('p', projectTaskMeta(project)),
      )
      row.append(link)
      section.append(row)
    } else {
      section.append(renderProjectSummary(project))
    }
  }
  return section
}

function renderRawRef(ref) {
  const facts = element('dl', undefined, 'record-ref')
  for (const [label, value] of [
    ['source', ref.source],
    ['ordinal', String(ref.ordinal)],
    ['projectKey', ref.projectKey],
    ['mode', ref.mode],
    ['taskId', taskIdValue(ref.taskId)],
    ['operationId', ref.operationId],
    ['executionEpoch', ref.executionEpoch],
    ['checkpointId', ref.checkpointId],
  ]) {
    const row = element('div')
    row.append(element('dt', label), element('dd', value ?? '未提供'))
    facts.append(row)
  }
  return facts
}

/**
 * Render records in the exact order returned by the runtime. The ordinal is
 * the source-local position from the projection; the page never sorts or
 * renumbers records globally.
 */
export function renderTaskRecords(projection, options = {}) {
  const section = element('section', undefined, 'records')
  const head = element('header', undefined, 'section-head')
  const count = options.view === 'raw' ? (projection.raw?.length || 0) : (projection.actions?.length || 0)
  head.append(
    element('h2', options.view === 'raw' ? '原始记录' : '动作轨迹'),
    element('span', `${count} 条 · ${projection.hasMore ? '还有更多' : '已到末尾'}`, 'section-meta'),
  )
  section.append(head)
  section.append(element('p', `范围：${readScopeLabel(projection.scope)}`, 'muted'))
  const list = element('div', undefined, 'record-list')
  if (options.view === 'raw') {
    let selectionMarked = false
    for (const record of projection.raw || []) {
      const selected = !selectionMarked && sameStoredRecordRef(record.ref, options.selectedRef)
      if (selected) selectionMarked = true
      const item = element('article', undefined, selected ? 'record-item record-item--selected' : 'record-item')
      item.dataset.source = record.ref.source
      item.dataset.ordinal = String(record.ref.ordinal)
      if (selected) {
        item.dataset.recordSelected = 'true'
        item.setAttribute('aria-current', 'true')
        item.tabIndex = -1
      }
      item.append(
        element('p', `${record.ref.source} · ordinal=${record.ref.ordinal} · ${record.body?.kind || 'unknown'}`, 'record-kind'),
      )
      if (selected) item.append(element('p', '正在查看这条记录', 'record-selected-tag'))
      item.append(
        element('time', formatTime(record.occurredAt), 'record-time'),
        element('pre', JSON.stringify(record.body, null, 2), 'record-body'),
      )
      item.append(renderRawRef(record.ref))
      list.append(item)
    }
  } else {
    for (const action of projection.actions || []) {
      const item = element('article', undefined, 'record-item')
      item.dataset.ordinal = String(action.rawRef?.ordinal ?? '')
      item.append(
        element('p', `seq=${action.entry?.seq ?? '未知'} · ${action.entry?.kind || 'unknown'}`, 'record-kind'),
        element('time', formatTime(action.entry?.occurredAt), 'record-time'),
        element('p', action.entry?.summary || action.entry?.modelRef || '未提供摘要'),
      )
      if (action.rawRef) item.append(renderRawRef(action.rawRef))
      if (action.rawRef && options.onRawRef) {
        const raw = element('button', '查看这条原始记录', 'button button--quiet')
        raw.type = 'button'
        raw.addEventListener('click', (event) => options.onRawRef(action.rawRef, event.currentTarget))
        item.append(raw)
      }
      list.append(item)
    }
  }
  if (list.children.length === 0) list.append(element('p', '没有可显示的记录。', 'empty'))
  section.append(list)
  if (projection.hasMore && projection.nextCursor) {
    const next = element('button', '继续读取下一页', 'button button--quiet')
    next.type = 'button'
    next.dataset.nextCursor = projection.nextCursor
    next.addEventListener('click', () => options.onNext?.(projection.nextCursor))
    section.append(next)
  }
  return section
}

// Typed enums are mapped for display only. An unrecognized raw value keeps a
// truthful "not yet determined" default here, and the raw value moves to the
// evidence detail instead of being guessed or treated as success/failure.
const REPLACEMENT_REASON_LABELS = Object.freeze({
  observation: '新增观察',
  compaction: '整理上下文',
  recovery: '恢复任务',
})

function replacementReasonLabel(reason) {
  return REPLACEMENT_REASON_LABELS[reason] || '未说明原因'
}

// Evidence-only detail level. Raw commit IDs, digests and cursors stay here so
// the default copy shows readable summaries instead of mechanical identifiers.
function historyRawDetail(pairs) {
  const details = element('details', undefined, 'history-detail')
  details.append(element('summary', '证据详情'))
  const list = element('dl', undefined, 'record-ref')
  for (const [label, value] of pairs) {
    const row = element('div')
    const text = value === undefined || value === null || value === '' ? '未提供' : String(value)
    row.append(element('dt', label), element('dd', text))
    list.append(row)
  }
  details.append(list)
  return details
}

function historyActions(projection, options) {
  const actions = element('div', undefined, 'history-actions')
  const refresh = element('button', '重新读取历史', 'button button--quiet')
  refresh.type = 'button'
  refresh.addEventListener('click', () => options.onRefresh?.())
  actions.append(refresh)
  if (projection.nextCursor) {
    const next = element('button', '继续读取下一页', 'button button--quiet')
    next.type = 'button'
    next.dataset.nextCursor = projection.nextCursor
    next.addEventListener('click', () => options.onNext?.(projection.nextCursor))
    actions.append(next)
  }
  return actions
}

export function renderContextHistory(projection, options = {}) {
  const section = element('section', undefined, 'history-section')
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', '上下文变化'),
    element('span', `${projection.views?.length || 0} 个视图 · ${projection.replacements?.length || 0} 次替换`, 'section-meta'),
  )
  section.append(head)
  section.append(historyRawDetail([
    ['mode', projection.mode],
    ['taskId', taskIdValue(projection.taskId)],
  ]))
  section.append(element('p', projection.currentContextCommitRef
    ? '当前上下文：已提交一个持久上下文。'
    : '当前上下文：本任务尚无已提交的持久上下文。', 'muted'))

  const views = element('div', undefined, 'history-list')
  for (const view of projection.views || []) {
    const item = element('article', undefined, 'history-item')
    item.dataset.contextView = view.contextViewRef
    item.append(
      element('p', `执行轮次 ${view.executionEpoch} · 保留 ${view.activeRefs?.length || 0} 个引用 · 省略 ${view.omittedRefs?.length || 0} 个引用`, 'history-item-title'),
      historyRawDetail([
        ['contextViewRef', view.contextViewRef],
        ['contextDigest', view.contextDigest],
        ['checkpointId', view.checkpointId],
        ['activeRefs', (view.activeRefs || []).join(', ')],
        ['omittedRefs', (view.omittedRefs || []).join(', ')],
      ]),
    )
    views.append(item)
  }
  if (views.children.length === 0) views.append(element('p', '这个任务还没有记录到上下文变化。', 'empty'))
  section.append(views)

  if ((projection.replacements || []).length > 0) {
    section.append(element('h3', '替换关系'))
    const replacements = element('div', undefined, 'history-list')
    for (const replacement of projection.replacements) {
      const item = element('article', undefined, 'history-item')
      item.dataset.replacement = replacement.replacementId
      item.append(
        element('p', `替换原因：${replacementReasonLabel(replacement.reason)} · 涉及 ${replacement.deltaIds?.length || 0} 项增量`, 'history-item-title'),
        element('p', `执行轮次 ${replacement.executionEpoch} · 由旧视图切换到新视图`, 'muted'),
        historyRawDetail([
          ['reason', replacement.reason],
          ['replacementId', replacement.replacementId],
          ['fromContextViewRef', replacement.fromContextViewRef],
          ['toContextViewRef', replacement.toContextViewRef],
          ['toContextDigest', replacement.toContextDigest],
          ['replacementDigest', replacement.replacementDigest],
          ['deltaIds', (replacement.deltaIds || []).join(', ')],
        ]),
      )
      replacements.append(item)
    }
    section.append(replacements)
  }

  section.append(historyActions(projection, options))
  return section
}

export function readHistoryFilters(host) {
  const filters = {}
  for (const input of host.querySelectorAll('[data-filter]')) {
    const value = String(input.value ?? '').trim()
    if (value !== '') filters[input.dataset.filter] = value
  }
  return filters
}

// ── I2 durable history renderers ───────────────────────────────────────────
// Semantic business labels come first: what was inspected, what failed, cycle
// progress/result/next action, review verdict/findings/alignment. Commit IDs,
// digests and check IDs stay in the evidence-only detail level.
const I2_CYCLE_OUTCOME_LABELS = Object.freeze({
  continue: '继续',
  wait: '等待',
  stop: '停止',
  recover: '恢复',
})
const I2_REVIEW_STATUS_LABELS = Object.freeze({
  passed: '通过',
  failed: '未通过',
  inconclusive: '未定',
})
const I2_ITEM_STATE_LABELS = Object.freeze({
  completed: '已完成',
  failed: '失败',
  missing: '缺失',
})
const I2_ITEM_OUTCOME_LABELS = Object.freeze({
  completed: '已观测',
  failed: '失败',
  blocked: '阻塞',
  cancelled: '取消',
  unknown: '未知',
  missing: '缺失',
})
const I2_OCCURRENCE_OUTCOME_LABELS = Object.freeze({
  completed: '完成',
  failed: '失败',
  blocked: '阻塞',
  cancelled: '取消',
  unknown: '未知',
  pending: '进行中',
})
const I2_ITEM_CHANGE_LABELS = Object.freeze({
  unchanged: '无变化',
  changed: '有变化',
  'not-compared': '未可比对',
})

function i2Label(labels, value) {
  return labels[value] || (value === undefined || value === null ? '' : String(value))
}

function i2CurrentLabel(current) {
  if (current?.state === 'known') {
    return current.cycleId ? `当前业务周期：${current.cycleId}` : '当前没有已打开的业务周期。'
  }
  return `当前执行位置未知：${current?.reason || '未绑定当前执行位置读取'}。历史仍然可用。`
}

function i2EvidenceRefsText(refs) {
  return (refs || []).map((ref) => ref?.evidenceId?.value || ref?.locator || '').filter(Boolean).join(', ')
}

function i2ItemLine(item) {
  const outcome = i2Label(I2_ITEM_OUTCOME_LABELS, item.outcome)
  if (item.state === 'completed') return `${outcome} · ${item.judgment || '未提供观测结果'}`
  if (item.reason) return `${outcome} · ${item.reason}`
  return outcome
}

function i2OccurrenceSummary(occurrence) {
  const counts = { failed: 0, missing: 0 }
  for (const item of occurrence.items || []) {
    if (item.state === 'failed') counts.failed += 1
    if (item.state === 'missing') counts.missing += 1
  }
  const parts = [`${occurrence.items?.length || 0} 项检查`]
  if (counts.failed > 0) parts.push(`${counts.failed} 项失败`)
  if (counts.missing > 0) parts.push(`${counts.missing} 项缺失`)
  return parts.join(' · ')
}

function i2ItemDetail(item) {
  return historyRawDetail([
    ['checkId', item.checkId],
    ['outcome', item.outcome],
    ['judgment', item.judgment],
    ['reason', item.reason],
    ['resultRef', item.resultRef],
    ['completedAt', item.completedAt],
    ['evidenceRefs', i2EvidenceRefsText(item.evidenceRefs)],
  ])
}

function i2TaskScopeDetail(projection) {
  const scope = projection.scope?.kind === 'task'
    ? [
        ['projectKey', projection.scope.projectKey],
        ['mode', projection.scope.mode],
      ]
    : []
  return [
    ...scope,
    ['organId', projection.taskScope?.organId?.value],
    ['taskId', projection.taskScope?.taskId?.value],
  ]
}

export function renderI2BusinessCycles(projection, options = {}) {
  const section = element('section', undefined, 'history-section')
  section.dataset.i2History = 'cycles'
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', '业务周期'),
    element('span', `${projection.entries?.length || 0} 个周期 · ${projection.nextCursor ? '还有更多' : '已到末尾'}`, 'section-meta'),
  )
  section.append(head)
  section.append(historyRawDetail(i2TaskScopeDetail(projection)))
  section.append(element('p', i2CurrentLabel(projection.current), 'muted'))
  const list = element('div', undefined, 'history-list')
  for (const cycle of projection.entries || []) {
    const item = element('article', undefined, 'history-item')
    item.dataset.businessCycle = cycle.cycleId
    item.dataset.progress = cycle.progress
    const viewed = projection.viewed?.cycleId === cycle.cycleId
    if (viewed) item.append(element('span', '正在查看', 'history-viewed-tag'))
    const progressLabel = cycle.progress === 'closed' ? '已收拢' : '进行中'
    const outcomeLabel = cycle.outcome ? ` · 结果：${i2Label(I2_CYCLE_OUTCOME_LABELS, cycle.outcome)}` : ''
    item.append(
      element('p', `${progressLabel}${outcomeLabel} · ${formatTime(cycle.openedAt)}`, 'history-item-title'),
      element('p', cycle.openingReason || '未提供开启原因', 'muted'),
    )
    const reviewText = cycle.reviews?.length
      ? cycle.reviews.map((review) => `${review.milestoneId} ${i2Label(I2_REVIEW_STATUS_LABELS, review.status)}${review.alignment === 'pending' ? '（待对齐）' : ''}`).join(' · ')
      : '本周期还没有里程碑评审'
    item.append(element('p', `里程碑评审：${reviewText}`, 'muted'))
    if (cycle.next) {
      const nextLabel = i2Label(I2_CYCLE_OUTCOME_LABELS, cycle.next.kind)
      item.append(element('p', `下一步：${cycle.next.ref ? `${nextLabel}（${cycle.next.ref}）` : nextLabel}`, 'muted'))
    }
    item.append(historyRawDetail([
      ['cycleId', cycle.cycleId],
      ['progress', cycle.progress],
      ['outcome', cycle.outcome],
      ['directiveRevision', cycle.directiveRevision],
      ['executionEpoch', cycle.executionEpoch],
      ['taskFlow kind', cycle.taskFlow?.kind],
      ['taskFlow definitionVersion', cycle.taskFlow?.definitionVersion],
      ['openedCommitRef', cycle.openedCommitRef?.commitId],
      ['planRevisionCommitRef', cycle.planRevisionCommitRef?.commitId],
      ['closureCommitRef', cycle.closureCommitRef?.commitId],
      ['checkpointCommitRef', cycle.checkpointCommitRef?.commitId],
      ['inspectionSettlementCommitRef', cycle.inspectionSettlementCommitRef?.commitId],
      ['alignmentPending', cycle.alignmentPending],
    ]))
    list.append(item)
  }
  if (list.children.length === 0) list.append(element('p', '这个任务还没有记录到业务周期。', 'empty'))
  section.append(list)
  section.append(historyActions(projection, options))
  return section
}

export function renderI2MilestoneReviews(projection, options = {}) {
  const section = element('section', undefined, 'history-section')
  section.dataset.i2History = 'reviews'
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', '里程碑评审'),
    element('span', `${projection.entries?.length || 0} 条 · ${projection.nextCursor ? '还有更多' : '已到末尾'}`, 'section-meta'),
  )
  section.append(head)
  section.append(historyRawDetail(i2TaskScopeDetail(projection)))
  section.append(element('p', i2CurrentLabel(projection.current), 'muted'))

  const filters = element('div', undefined, 'history-filters')
  for (const [name, label] of [['cycleId', '任务周期'], ['milestoneId', '里程碑']]) {
    const wrap = element('label', undefined, 'history-filter')
    wrap.append(element('span', label))
    const input = element('input')
    input.type = 'text'
    input.value = options.filters?.[name] ?? ''
    input.dataset.filter = name
    wrap.append(input)
    filters.append(wrap)
  }
  const apply = element('button', '应用筛选', 'button button--quiet')
  apply.type = 'button'
  apply.addEventListener('click', () => options.onFilter?.(readHistoryFilters(filters)))
  filters.append(apply)
  section.append(filters)

  const list = element('div', undefined, 'history-list')
  for (const review of projection.entries || []) {
    const item = element('article', undefined, 'history-item')
    item.dataset.milestoneReview = `${review.milestoneId}:${review.cycleId}`
    item.dataset.alignment = review.alignment
    const verdict = i2Label(I2_REVIEW_STATUS_LABELS, review.status)
    item.append(
      element('p', `${review.milestoneId} · ${verdict} · ${review.alignment === 'pending' ? '待对齐' : '已对齐'}`, 'history-item-title'),
      element('p', `周期 ${review.cycleId} · ${formatTime(review.completedAt)}`, 'muted'),
      element('p', review.outputText || '未提供评审输出', 'muted'),
    )
    if (review.findings?.length) {
      const findings = element('div', undefined, 'history-list')
      for (const finding of review.findings) {
        const row = element('article', undefined, 'history-item')
        row.dataset.finding = finding.findingId
        row.append(
          element('p', `${finding.problem || '未提供问题'} · ${finding.severity || ''}`, 'history-item-title'),
          element('p', `期望：${finding.expected || '未提供'}`, 'muted'),
          historyRawDetail([
            ['findingId', finding.findingId],
            ['locationRef', finding.locationRef],
            ['severity', finding.severity],
            ['evidenceRefs', i2EvidenceRefsText(finding.evidenceRefs)],
          ]),
        )
        findings.append(row)
      }
      item.append(findings)
    }
    item.append(historyRawDetail([
      ['reviewKind', review.reviewKind],
      ['reviewCommitRef', review.reviewCommitRef?.commitId],
      ['planRevisionCommitRef', review.planRevisionCommitRef?.commitId],
      ['alignment', review.alignment],
      ['alignmentCommitRef', review.alignmentCommitRef?.commitId],
      ['alignedPlanRevisionCommitRef', review.alignedPlanRevisionCommitRef?.commitId],
      ['checkpointCommitRef', review.checkpointCommitRef?.commitId],
      ['artifactRef', review.artifactRef],
      ['artifactDigest', review.artifactDigest],
      ['reviewer runtimeId', review.reviewer?.runtimeId],
      ['evidenceRefs', i2EvidenceRefsText(review.evidenceRefs)],
    ]))
    list.append(item)
  }
  if (list.children.length === 0) list.append(element('p', '这个任务还没有记录到里程碑评审。', 'empty'))
  section.append(list)
  section.append(historyActions(projection, options))
  return section
}

export function renderI2InspectionOccurrences(projection, options = {}) {
  const section = element('section', undefined, 'history-section')
  section.dataset.i2History = 'inspections'
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', '巡检记录'),
    element('span', `${projection.entries?.length || 0} 次 · ${projection.nextCursor ? '还有更多' : '已到末尾'}`, 'section-meta'),
  )
  section.append(head)
  section.append(historyRawDetail(i2TaskScopeDetail(projection)))
  section.append(element('p', i2CurrentLabel(projection.current), 'muted'))
  if (options.comparisonLeft) {
    section.append(element('p', `已选择 ${options.comparisonLeft} 作为对比基准；请选择另一次巡检作为右侧。`, 'muted'))
  }
  const list = element('div', undefined, 'history-list')
  for (const occurrence of projection.entries || []) {
    const item = element('article', undefined, 'history-item')
    item.dataset.occurrence = occurrence.occurrenceId
    const viewed = projection.viewed?.occurrenceId === occurrence.occurrenceId
    if (viewed) item.append(element('span', '正在查看', 'history-viewed-tag'))
    const outcome = i2Label(I2_OCCURRENCE_OUTCOME_LABELS, occurrence.outcome)
    item.append(
      element('p', `${occurrence.occurrenceId} · ${outcome} · ${formatTime(occurrence.openedAt)}`, 'history-item-title'),
      element('p', i2OccurrenceSummary(occurrence), 'muted'),
    )
    const items = element('details', undefined, 'history-detail')
    items.append(element('summary', '检查明细'))
    const rows = element('div', undefined, 'history-list')
    for (const check of occurrence.items || []) {
      const row = element('article', undefined, 'history-item')
      row.dataset.checkItem = check.checkId
      row.dataset.itemState = check.state
      row.append(
        element('p', check.criterion || '未提供检查内容', 'history-item-title'),
        element('p', `状态：${i2Label(I2_ITEM_STATE_LABELS, check.state)} · ${i2ItemLine(check)}`, 'muted'),
        i2ItemDetail(check),
      )
      rows.append(row)
    }
    items.append(rows)
    item.append(items)
    const selected = options.comparisonLeft === occurrence.occurrenceId
    const compare = element(
      'button',
      selected ? '已选为基准' : (options.comparisonLeft ? '作为右侧对比' : '选择为对比基准'),
      'button button--quiet',
    )
    compare.type = 'button'
    compare.disabled = selected
    compare.addEventListener('click', () => {
      if (options.comparisonLeft) options.onCompare?.(options.comparisonLeft, occurrence.occurrenceId)
      else options.onSelectCompare?.(occurrence.occurrenceId)
    })
    item.append(compare)
    item.append(historyRawDetail([
      ['definitionId', occurrence.definitionId],
      ['definitionVersion', occurrence.definitionVersion],
      ['definitionDigest', occurrence.definitionDigest],
      ['definitionCommitRef', occurrence.definitionCommitRef?.commitId],
      ['openingCommitRef', occurrence.openingCommitRef?.commitId],
      ['settlementCommitRef', occurrence.settlementCommitRef?.commitId],
      ['cycleId', occurrence.cycleId],
      ['executionEpoch', occurrence.executionEpoch],
      ['state', occurrence.state],
      ['outcome', occurrence.outcome],
      ['outcomeReason', occurrence.outcomeReason],
      ['scheduleOccurrenceRef', occurrence.scheduleOccurrenceRef ? `${occurrence.scheduleOccurrenceRef.subscriptionId}:${occurrence.scheduleOccurrenceRef.occurrenceId}` : '未绑定调度槽'],
      ['evidenceRefs', i2EvidenceRefsText(occurrence.evidenceRefs)],
    ]))
    list.append(item)
  }
  if (list.children.length === 0) list.append(element('p', '这个任务还没有记录到巡检。', 'empty'))
  section.append(list)
  section.append(historyActions(projection, options))
  return section
}

export function renderI2InspectionComparison(projection, options = {}) {
  const section = element('section', undefined, 'history-section')
  section.dataset.i2History = 'comparison'
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', '巡检对比'),
    element('span', `左 ${projection.left?.occurrenceId || ''} · 右 ${projection.right?.occurrenceId || ''}`, 'section-meta'),
  )
  section.append(head)
  section.append(historyRawDetail(i2TaskScopeDetail(projection)))
  section.append(element('p', i2CurrentLabel(projection.current), 'muted'))
  if (!projection.comparable) {
    section.append(element('p', `无法对比：${projection.reason || '未提供原因'}。`, 'muted'))
  } else if (projection.definition) {
    section.append(element('p', `定义 ${projection.definition.definitionId} · 版本 ${projection.definition.definitionVersion}`, 'muted'))
  }
  const list = element('div', undefined, 'history-list')
  for (const item of projection.items || []) {
    const row = element('article', undefined, 'history-item')
    row.dataset.comparisonItem = item.checkId
    row.dataset.change = item.change
    row.append(
      element('p', item.criterion || '未提供检查内容', 'history-item-title'),
      element('p', `变化：${i2Label(I2_ITEM_CHANGE_LABELS, item.change)}`, 'muted'),
      element('p', `对比前：${i2ItemLine(item.before)}`, 'muted'),
      element('p', `对比后：${i2ItemLine(item.after)}`, 'muted'),
    )
    row.append(historyRawDetail([
      ['checkId', item.checkId],
      ['change', item.change],
      ['before state', item.before?.state],
      ['before judgment', item.before?.judgment],
      ['before reason', item.before?.reason],
      ['after state', item.after?.state],
      ['after judgment', item.after?.judgment],
      ['after reason', item.after?.reason],
    ]))
    list.append(row)
  }
  if (projection.comparable && list.children.length === 0) {
    list.append(element('p', '没有可对比的检查项。', 'empty'))
  }
  section.append(list)
  const actions = historyActions(projection, options)
  const back = element('button', '返回巡检历史', 'button button--quiet')
  back.type = 'button'
  back.addEventListener('click', () => options.onBack?.())
  actions.append(back)
  section.append(actions)
  return section
}

function shellPanel(id, label) {
  const section = element('section', undefined, 'shell-panel')
  section.dataset.shellPanel = id
  section.setAttribute('aria-label', label)
  section.hidden = true
  return section
}

function scopeSectionContent(context) {
  const scope = context.scope
  if (scope?.kind === 'task') {
    return [
      `当前范围：${readScopeLabel(scope)}。`,
      '这个范围来自当前 URL 或上一层的任务行。刷新和重新打开只重新读取同一范围。',
      '工作范围只改变你正在查看的内容，不会停止、重试或改变任务状态。',
    ]
  }
  if (scope?.kind === 'project') {
    return [
      `当前范围：${readScopeLabel(scope)}。`,
      '项目范围来自 URL 或上一层的项目行。返回全部项目请使用面包屑。',
      '工作范围只改变你正在查看的内容，不会停止、重试或改变任务状态。',
    ]
  }
  return [
    '当前范围：全部项目（System）。',
    '选择项目或任务后，范围会进入 URL；刷新会重新读取当前 URL 的范围。',
    '工作范围只改变你正在查看的内容，不会停止、重试或改变任务状态。',
  ]
}

function viewSectionContent(context) {
  const page = location.pathname.split('/').pop() || ''
  const taskScope = context.scope?.kind === 'task'
  const current = page === 'observation.html'
    ? '节点流转与节点详情（只读）'
    : taskScope
      ? '任务概要与按需记录'
      : '默认阅读层'
  const paragraphs = [
    `当前查看方式：${current}`,
    '切换查看方式只改变阅读深度，不会停止、重试或改变任务状态。',
  ]
  const showHistory = taskScope && context.capabilities?.history === true
  if (showHistory) paragraphs.push('阶段记录和上下文变化是只读历史：选择旧点只改变正在查看的内容，不会移动当前执行点。')
  return { paragraphs, showHistory }
}

function displaySectionContent(hasPreferenceBinding) {
  const paragraphs = [
    '展开方式：桌面在右侧展开，主内容保留在旁边；手机从底部抽屉展开。',
    '排版：窄屏时正文换行，展开层正文可以滚动，标题与关闭入口保持可用。',
    '调整显示只改变这一层怎么展开，不会停止、重试或改变任务状态。',
  ]
  if (hasPreferenceBinding) paragraphs.push('默认阅读方式保存在这台浏览器；直接手动切换会在 follow-last 下记录上一次成功选择。')
  return paragraphs
}

function inputSectionContent() {
  return [
    '键盘操作：展开层打开后，Tab 在展开层内移动；Esc 关闭展开层。',
    '读屏：展开层的标题与正文按页面文字播报。',
    '自定义输入源、语音输入和输入历史尚未提供，因此这里不显示对应选项。',
    '输入设置只改变你怎么操作这一层，不会停止、重试或改变任务状态。',
  ]
}

// One shell-layer frame owns the next-layer surface for both the four-corner configuration
// panel and a contextual 技术详情 disclosure. Desktop shows it beside the page; mobile shows
// it as a bottom drawer. Keeping one frame builder means a contextual detail cannot drift from
// the configuration panel or become a second overlay primitive.
function createShellLayerFrame({ ariaLabel, eyebrow, titleText = '', titleId }) {
  const layer = element('dialog', undefined, 'shell-layer')
  layer.setAttribute('aria-label', ariaLabel)
  const head = element('header', undefined, 'shell-layer-head')
  const titleWrap = element('div')
  const title = element('h2', titleText, 'shell-layer-title')
  if (titleId) title.id = titleId
  const eyebrowNode = element('p', eyebrow, 'eyebrow')
  titleWrap.append(eyebrowNode, title)
  const close = element('button', '关闭', 'button shell-layer-close')
  close.type = 'button'
  close.addEventListener('click', () => layer.close())
  head.append(titleWrap, close)
  const body = element('div', undefined, 'shell-layer-body')
  layer.append(head, body)
  return { layer, eyebrow: eyebrowNode, title, body, close }
}

// The contextual 技术详情 disclosure. It reuses the shell-layer frame, so it opens as the same
// desktop side panel / mobile bottom drawer. Exact typed values (code/owner/message/nextAction
// and the control-plane footer) live here; the primary layer keeps only human copy. The
// document only ever has one open shell layer: opening the detail closes any other open layer,
// and closing it returns focus to the trigger.
let technicalDetailLayer = null
// Register the drawer's lifetime owner before any handoff. The technical frame
// retains that same owner until the replacement layer actually leaves.
const shellLayerLeaves = new WeakMap()
// `content` lets a page module host its own read-only drill-down (for example the
// shared agent-activity detail) in this same shell layer. Either way the layer stays
// the one desktop side panel / mobile bottom drawer: the header, close button, single
// open layer and focus return are not re-implemented by the page.
export function openTechnicalDetail({ title = '技术详情', eyebrow = '技术详情', entries = [], footer, content, onClose, trigger } = {}) {
  if (!technicalDetailLayer) {
    const frame = createShellLayerFrame({
      ariaLabel: '技术详情',
      eyebrow: '技术详情',
      titleText: '技术详情',
      titleId: 'technical-detail-title',
    })
    frame.layer.dataset.technicalDetail = 'true'
    frame.close.addEventListener('click', closeTechnicalDetailLayer)
    frame.layer.addEventListener('cancel', (event) => {
      event.preventDefault()
      closeTechnicalDetailLayer()
    })
    frame.layer.addEventListener('close', () => {
      // A queued close from an earlier opening cannot close a reopened frame.
      if (!frame.layer.open) closeTechnicalDetailLayer()
    })
    document.body.append(frame.layer)
    technicalDetailLayer = frame
  }
  const { layer, eyebrow: eyebrowNode, title: titleNode, body, close } = technicalDetailLayer
  if (trigger instanceof HTMLElement) technicalDetailLayer.returnFocus = trigger
  else if (!technicalDetailLayer.active) technicalDetailLayer.returnFocus = document.activeElement
  technicalDetailLayer.active = true
  technicalDetailLayer.onClose = onClose
  for (const openLayer of document.querySelectorAll('dialog.shell-layer[open]')) {
    if (openLayer !== layer) {
      // Transfer before close() queues the drawer's native close event.
      technicalDetailLayer.leaveDrawer = shellLayerLeaves.get(openLayer)
      openLayer.close()
    }
  }
  layer.setAttribute('aria-label', eyebrow)
  eyebrowNode.textContent = eyebrow
  titleNode.textContent = title
  clearNode(body)
  if (content) {
    body.append(content)
  } else {
    const list = element('dl', undefined, 'draft-receipt')
    for (const [label, value, hook] of entries) {
      const raw = value === undefined || value === null ? '' : String(value)
      const detail = element('dd', raw === '' ? '未提供' : raw)
      detail.setAttribute('data-detail-label', label)
      detail.setAttribute('data-detail-value', raw)
      if (hook) detail.setAttribute(hook, raw)
      const row = element('div')
      row.append(element('dt', label), detail)
      list.append(row)
    }
    body.append(list)
  }
  if (footer) body.append(element('p', footer))
  if (!layer.open) layer.showModal()
  close.focus()
  return layer
}

// Native close, section changes and page leave all consume this one lifetime.
// Clear ownership before callbacks, which can themselves close the same dialog.
function closeTechnicalDetailLayer() {
  if (!technicalDetailLayer?.active) return
  const { layer, onClose, leaveDrawer, returnFocus } = technicalDetailLayer
  technicalDetailLayer.active = false
  technicalDetailLayer.onClose = null
  technicalDetailLayer.leaveDrawer = null
  technicalDetailLayer.returnFocus = null
  // Native dismissal has already detached the frame. Closing it again here can
  // dispatch a queued close after a page callback reopens the same frame.
  if (layer.open) layer.close()
  if (leaveDrawer) leaveDrawer()
  else if (returnFocus?.isConnected && !returnFocus.closest('dialog:not([open]), [hidden]')) returnFocus.focus()
  // An explicit page callback owns the final focus destination. Generic
  // restoration finishes first so it cannot overwrite that destination.
  if (typeof onClose === 'function') onClose()
}

function removeTechnicalDetailLayer() {
  if (!technicalDetailLayer) return
  const { layer } = technicalDetailLayer
  closeTechnicalDetailLayer()
  if (layer.isConnected) layer.remove()
  technicalDetailLayer = null
}

// A contextual trigger for the technical-detail layer. It is not a global configuration
// button: the caller places it next to the state it explains.
export function technicalDetailTrigger(getDetail, { label = '技术详情' } = {}) {
  const button = element('button', label, 'button button--quiet')
  button.type = 'button'
  button.dataset.technicalDetailTrigger = 'true'
  button.addEventListener('click', () => openTechnicalDetail(getDetail()))
  return button
}

function errorDetailEntries(error, fallbackNext) {
  return [
    ['code', error?.code, 'data-detail-code'],
    ['owner', error?.ownerId, 'data-detail-owner'],
    ['message', error?.message, 'data-detail-message'],
    ['nextAction', error?.nextAction || fallbackNext, 'data-detail-next'],
  ]
}

function displayMountFailure() {
  return {
    code: 'display-preference.missing-mount',
    ownerId: 'humanagent.ui',
    message: 'this page did not mount a display preference surface',
    nextAction: 'open a task reading surface that can render a reading mode',
  }
}

function renderDisplayModeChooser({ surface, state, onSelect }) {
  const group = element('div', undefined, 'shell-mode-chooser')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', '阅读方式')
  const supported = new Set(Array.isArray(surface?.supportedModes) ? surface.supportedModes : [])
  for (const mode of DISPLAY_MODES) {
    const label = displayModeLabel(mode)
    const button = element('button', label, 'button button--quiet shell-mode')
    button.type = 'button'
    button.dataset.displayMode = mode
    button.dataset.shellFocus = `mode:${mode}`
    button.setAttribute('aria-pressed', String(state?.mode === mode))
    if (supported.has(mode)) {
      button.addEventListener('click', () => onSelect(mode))
    } else {
      button.disabled = true
      button.dataset.unavailable = 'true'
      button.setAttribute('aria-disabled', 'true')
      button.title = `${label}尚未接入`
    }
    group.append(button)
    if (DISPLAY_MODE_DESCRIPTIONS[mode]) {
      const description = element('p', DISPLAY_MODE_DESCRIPTIONS[mode], 'muted')
      description.dataset.displayModeDescription = mode
      group.append(description)
    }
  }
  for (const mode of DISPLAY_MODES) {
    if (supported.has(mode)) continue
    const reason = surface?.unavailableReasons?.[mode] || '这个页面还不能渲染这层内容。'
    const note = element('p', `${displayModeLabel(mode)}：${reason}`, 'muted display-mode-unavailable')
    note.dataset.displayUnavailable = mode
    group.append(note)
  }
  return group
}

function preferenceStatusCopy(state, { draftDefault, notice }) {
  if (!state) return '显示偏好控制尚未挂载。'
  if (state.disposed) return '显示偏好控制已经离开这个页面。'
  if (state.preferenceRead === 'error') return '显示偏好读取失败，当前保留可用视图；保存和重置已停用。'
  if (state.pending) return '正在处理显示偏好…'
  if (state.unsaved) return '未保存：这次手动选择没有写入，仍保留上一次保存的偏好。'
  if (state.error) return '显示偏好操作失败，仍保留上一次确认的偏好；请查看详情后重试。'
  const saved = state.preference?.mode
  const currentDraft = draftDefault ?? saved ?? ''
  if (saved && currentDraft && currentDraft !== saved) return '有未保存的修改；点保存才会写入默认阅读方式。'
  if (saved) {
    const resolved = state.defaultMode && state.defaultMode !== saved
      ? `（当前解析为${displayModeLabel(state.defaultMode)}）`
      : ''
    return `已保存默认：${displayModeLabel(saved)}${resolved}。`
  }
  return notice || '显示偏好控制已就绪。'
}

function renderDisplayPreferencePanel({ state, draftDefault, notice, onDraft, onSave, onReset, onRetry }) {
  const panel = element('div', undefined, 'display-preference-panel')
  panel.dataset.displayPreference = 'true'

  const field = element('label', undefined, 'display-preference-field')
  field.htmlFor = 'display-default-select'
  field.append(element('span', '默认阅读方式'))
  const select = element('select')
  select.id = 'display-default-select'
  select.dataset.shellFocus = 'default-select'
  const savedMode = state?.preference?.mode ?? state?.defaultMode ?? 'current'
  for (const mode of DISPLAY_PREFERENCE_MODES) {
    const option = element('option', displayModeLabel(mode))
    option.value = mode
    select.append(option)
  }
  select.value = draftDefault ?? savedMode
  select.disabled = state?.preferenceRead !== 'ready' || state?.pending === true
  select.addEventListener('change', () => onDraft(select.value))
  field.append(select)
  panel.append(field)

  const actions = element('div', undefined, 'display-preference-actions')
  const save = element('button', '保存默认', 'button button--primary')
  save.type = 'button'
  save.dataset.shellFocus = 'default-save'
  save.disabled = state?.preferenceRead !== 'ready' || state?.pending === true
  save.addEventListener('click', () => onSave())
  const reset = element('button', '重置', 'button button--quiet')
  reset.type = 'button'
  reset.dataset.shellFocus = 'default-reset'
  reset.disabled = state?.preferenceRead !== 'ready' || state?.pending === true
  reset.addEventListener('click', () => onReset())
  actions.append(save, reset)
  panel.append(actions)

  const status = element('p', preferenceStatusCopy(state, { draftDefault, notice }), 'muted display-preference-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  if (state?.error) status.dataset.tone = 'danger'
  panel.append(status)

  if (state?.preferenceRead === 'error') {
    const retry = element('button', '重试读取', 'button button--quiet')
    retry.type = 'button'
    retry.dataset.shellFocus = 'default-retry'
    retry.addEventListener('click', () => onRetry())
    panel.append(retry)
  }
  if (state?.error) {
    panel.append(technicalDetailTrigger(() => ({
      title: '技术详情',
      entries: errorDetailEntries(state.error, 'retry the display preference request'),
    })))
  }
  return panel
}

function renderMissingDisplayMount() {
  const box = element('div', undefined, 'display-preference-panel display-preference-missing')
  box.dataset.displayPreference = 'missing-mount'
  box.append(
    element('strong', '显示偏好未接入'),
    element('p', '这个页面没有可切换的阅读层，无法读取或保存显示偏好。', 'muted'),
    technicalDetailTrigger(() => ({ title: '技术详情', entries: errorDetailEntries(displayMountFailure(), 'open a task reading surface') })),
  )
  return box
}

export function mountShellLayer(context = {}, mountRoot = document.body) {
  if (!(mountRoot instanceof HTMLElement)) throw new TypeError('mountShellLayer requires an HTMLElement mount root')
  const controls = element('div', undefined, 'shell-controls')
  controls.setAttribute('role', 'group')
  controls.setAttribute('aria-label', '主动配置')
  const triggers = new Map()
  for (const item of SHELL_SECTIONS) {
    const button = element('button', item.label, 'button shell-corner')
    button.type = 'button'
    button.dataset.shellCorner = item.corner
    button.dataset.shellSection = item.id
    button.setAttribute('aria-label', item.title)
    controls.append(button)
    triggers.set(item.id, button)
  }

  const { layer, title, body, close } = createShellLayerFrame({
    ariaLabel: '主动配置',
    eyebrow: '主动配置',
    titleText: '',
    titleId: 'shell-layer-title',
  })
  const panels = new Map()
  for (const item of SHELL_SECTIONS) {
    const section = shellPanel(item.id, item.label)
    panels.set(item.id, section)
    body.append(section)
  }

  mountRoot.append(controls, layer)

  let returnFocus = null
  let currentContext = { ...context }
  let openPanelId = null
  let drawerReadsActive = false
  let displayController = null
  let displayUnsubscribe = null
  let draftDefault = null
  let displayNotice = ''
  let disposed = false

  if (currentContext.displaySurface) {
    displayController = createDisplayPreferenceController({
      client: {
        displayPreference: () => api.displayPreference(),
        updateDisplayPreference: (update) => api.updateDisplayPreference(update),
        resetDisplayPreference: () => api.resetDisplayPreference(),
      },
      surface: currentContext.displaySurface,
    })
    displayUnsubscribe = displayController.subscribe(() => {
      if (openPanelId === 'view' || openPanelId === 'display') renderPanel(openPanelId)
    })
  }

  function renderPanel(id) {
    const section = panels.get(id)
    if (!section) return
    const active = document.activeElement
    const focusKey = active && section.contains(active) ? active.dataset?.shellFocus : null
    clearNode(section)
    if (id === 'scope') {
      for (const text of scopeSectionContent(currentContext)) section.append(element('p', text))
      const system = element('a', '全部项目', 'button button--quiet')
      system.href = systemTasksHref()
      section.append(system)
      if (currentContext.scope?.projectKey) {
        const project = element('a', '当前项目', 'button button--quiet')
        project.href = projectTasksHref(currentContext.scope.projectKey)
        section.append(project)
      }
      restorePanelFocus(section, focusKey)
      return
    }
    if (id === 'view') {
      const content = viewSectionContent(currentContext)
      const parentNodes = []
      for (const text of content.paragraphs) {
        const paragraph = element('p', text)
        parentNodes.push(paragraph)
        section.append(paragraph)
      }
      // The chooser's own display:grid rule overrides [hidden], so the parent
      // visibility switch owns this plain wrapper instead.
      const parentChoice = element('div')
      if (currentContext.displaySurface) {
        parentChoice.append(renderDisplayModeChooser({
          surface: currentContext.displaySurface,
          state: displayController?.getState(),
          onSelect: (mode) => void selectDisplayMode(mode),
        }))
      } else {
        const missing = element('div', undefined, 'display-mount-failure')
        missing.dataset.displayMount = 'missing'
        missing.append(
          element('strong', '阅读方式未接入'),
          element('p', '这个页面没有可切换的阅读层。', 'muted'),
        )
        parentChoice.append(missing)
      }
      parentNodes.push(parentChoice)
      section.append(parentChoice)
      if (!content.showHistory) {
        restorePanelFocus(section, focusKey)
        return
      }
      const host = element('div', undefined, 'shell-records-host')
      host.dataset.shellRecordsHost = ''
      const actions = element('div', undefined, 'shell-record-actions')
      const backToView = () => {
        leaveDrawerReads()
        renderPanel('view')
        const focusTarget = panels.get('view').querySelector('[data-history-view]')
        focusTarget?.focus()
      }
      const openLevel = (run) => {
        // The records/history sublayer owns the view panel while active: the
        // parent mode copy stays hidden until the back entry rebuilds it.
        for (const node of parentNodes) node.hidden = true
        const back = element('button', '返回查看方式', 'button button--quiet')
        back.type = 'button'
        back.addEventListener('click', backToView)
        actions.replaceChildren(back)
        drawerReadsActive = true
        void run()
      }
      for (const [view, label] of [
        ['cycles', '查看业务周期'],
        ['reviews', '查看里程碑评审'],
        ['inspections', '查看巡检历史'],
        ['checkpoints', '查看阶段记录'],
        ['context', '查看上下文变化'],
      ]) {
        const button = element('button', label, 'button button--quiet')
        button.type = 'button'
        button.dataset.historyView = view
        button.addEventListener('click', () => {
          if (typeof currentContext.capabilities?.onReadHistory !== 'function') return
          openLevel(() => currentContext.capabilities.onReadHistory(view, host))
        })
        actions.append(button)
      }
      section.append(actions, host)
      restorePanelFocus(section, focusKey)
      return
    }
    if (id === 'display') {
      const hasBinding = Boolean(currentContext.displaySurface && displayController)
      for (const text of displaySectionContent(hasBinding)) section.append(element('p', text))
      if (hasBinding) {
        section.append(renderDisplayPreferencePanel({
          state: displayController.getState(),
          draftDefault,
          notice: displayNotice,
          onDraft: (mode) => {
            draftDefault = mode
            displayNotice = ''
            renderPanel('display')
          },
          onSave: () => void saveDisplayDefault(),
          onReset: () => void resetDisplayPreference(),
          onRetry: () => void refreshDisplayPreference(),
        }))
      } else {
        section.append(renderMissingDisplayMount())
      }
      const wrap = element('button', '切换记录换行', 'button button--quiet')
      wrap.type = 'button'
      wrap.addEventListener('click', () => {
        const enabled = layer.classList.toggle('shell-layer--wrap')
        wrap.setAttribute('aria-pressed', String(enabled))
      })
      section.append(wrap)
      restorePanelFocus(section, focusKey)
      return
    }
    for (const text of inputSectionContent()) section.append(element('p', text))
    const focusClose = element('button', '移到关闭入口', 'button button--quiet')
    focusClose.type = 'button'
    focusClose.addEventListener('click', () => close.focus())
    section.append(focusClose)
    restorePanelFocus(section, focusKey)
  }

  function restorePanelFocus(section, focusKey) {
    if (!focusKey) return
    const next = section.querySelector(`[data-shell-focus="${CSS.escape(focusKey)}"]`)
    if (next) next.focus()
  }

  async function selectDisplayMode(mode) {
    if (!displayController) return
    displayNotice = ''
    await displayController.selectMode(mode)
  }

  // Page-owned navigation uses the existing controller instead of replacing a
  // page host directly. The origin stays programmatic, so no manual preference
  // write is triggered by an in-page reference jump.
  function applyDisplayMode(mode) {
    if (!displayController) return Promise.resolve({ ok: false, failure: displayMountFailure() })
    return displayController.applyMode(mode, { origin: DISPLAY_ORIGINS.programmatic })
  }

  async function saveDisplayDefault() {
    if (!displayController) return
    const state = displayController.getState()
    const mode = draftDefault ?? state.preference?.mode ?? state.defaultMode ?? 'current'
    displayNotice = '正在保存默认阅读方式…'
    renderPanel('display')
    const result = await displayController.saveDefault(mode)
    if (result.ok) {
      draftDefault = mode
      displayNotice = `已保存默认：${displayModeLabel(mode)}。`
    } else {
      displayNotice = ''
    }
    renderPanel('display')
  }

  async function resetDisplayPreference() {
    if (!displayController) return
    displayNotice = ''
    const result = await displayController.reset()
    if (result.ok) {
      draftDefault = result.preference?.mode ?? result.defaultMode ?? 'current'
      displayNotice = `已重置默认阅读方式：${displayModeLabel(draftDefault)}。`
    }
    renderPanel('display')
  }

  async function refreshDisplayPreference() {
    if (!displayController) return
    displayNotice = ''
    const result = await displayController.refreshPreference()
    if (result.ok) {
      const state = displayController.getState()
      draftDefault = state.preference?.mode ?? state.defaultMode ?? 'current'
      displayNotice = '显示偏好已重新读取。'
    }
    renderPanel('display')
  }

  async function initializeDisplayPreference() {
    if (!displayController) {
      return { ok: false, failure: displayMountFailure() }
    }
    draftDefault = null
    displayNotice = ''
    const result = await displayController.initialize({ displayParam: queryParam('display') })
    if (result.ok) {
      const state = displayController.getState()
      draftDefault = state.preference?.mode ?? state.defaultMode ?? 'current'
    }
    if (openPanelId === 'view' || openPanelId === 'display') renderPanel(openPanelId)
    return result
  }

  function disposeDisplayPreference() {
    if (displayUnsubscribe) {
      displayUnsubscribe()
      displayUnsubscribe = null
    }
    displayController?.dispose()
    displayController = null
  }

  function open(id) {
    const item = SHELL_SECTIONS.find((entry) => entry.id === id)
    if (!item) return
    closeTechnicalDetailLayer()
    leaveDrawerReads()
    returnFocus = triggers.get(id) || null
    openPanelId = id
    drawerReadsActive = true
    title.textContent = item.title
    for (const [key, section] of panels) {
      section.hidden = key !== id
      if (key === id) renderPanel(key)
    }
    layer.showModal()
    close.focus()
  }

  // Leaving the drawer (or switching sections) discards any records or history
  // read that belonged to the departed level, so a late response cannot publish
  // into a level the user already left.
  function leaveDrawerReads() {
    if (!drawerReadsActive) return
    drawerReadsActive = false
    currentContext.capabilities?.onLeaveRecords?.()
    currentContext.capabilities?.onLeaveHistory?.()
  }

  // Return/close restores focus to the visible corner, including after a detail
  // handoff where the original opener now belongs to the closed drawer.
  function leaveDrawer() {
    if (openPanelId === null) return
    openPanelId = null
    if (layer.open) layer.close()
    leaveDrawerReads()
    const target = returnFocus
    returnFocus = null
    for (const section of panels.values()) section.hidden = true
    if (target && target.isConnected) target.focus()
  }
  shellLayerLeaves.set(layer, leaveDrawer)
  layer.addEventListener('close', () => {
    // The technical frame owns the departed drawer until its final close. A
    // queued close also cannot tear down a section that has already reopened.
    if (layer.open || technicalDetailLayer?.leaveDrawer === leaveDrawer) return
    leaveDrawer()
  })
  const onPageHide = () => {
    closeTechnicalDetailLayer()
    leaveDrawer()
  }
  window.addEventListener('pagehide', onPageHide)
  for (const [id, button] of triggers) button.addEventListener('click', () => open(id))

  function setScope(scope) {
    currentContext = { ...currentContext, scope }
  }

  function setCapabilities(capabilities) {
    currentContext = { ...currentContext, capabilities }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    window.removeEventListener('pagehide', onPageHide)
    closeTechnicalDetailLayer()
    leaveDrawer()
    disposeDisplayPreference()
    controls.remove()
    layer.remove()
  }

  return {
    open,
    setScope,
    setCapabilities,
    applyDisplayMode,
    initializeDisplayPreference,
    disposeDisplayPreference,
    dispose,
  }
}

const PAGE_LAYOUTS = Object.freeze({
  collection: 'collection',
  work: 'work',
  standalone: 'standalone',
})

// The explicit-root template is the single page composition owner. It builds
// the heading/status/primary/support/composer slots for every business layout
// and the shared detail/focus carrier. Page controllers keep business reads,
// writes, selection and URL state; optional slots stay visually absent until
// the controller publishes real content.
export function mountPageTemplate(root, config = {}) {
  if (!(root instanceof HTMLElement)) throw new TypeError('mountPageTemplate requires an HTMLElement root')
  const layout = PAGE_LAYOUTS[config.layout] || PAGE_LAYOUTS.collection
  const active = typeof config.active === 'string' ? config.active : ''
  const eyebrow = typeof config.eyebrow === 'string' ? config.eyebrow : ''
  const title = typeof config.title === 'string' ? config.title : ''
  const lede = typeof config.lede === 'string' ? config.lede : ''
  const context = {
    scope: config.scope,
    capabilities: config.capabilities,
    ...(config.displaySurface ? { displaySurface: config.displaySurface } : {}),
  }

  root.replaceChildren()

  const page = element('main', undefined, 'page')
  page.dataset.pageLayout = layout
  const heading = element('section', undefined, 'page-heading')
  heading.dataset.pageSlot = 'heading'
  const copy = element('div', undefined, 'page-heading-copy')
  if (eyebrow) copy.append(element('p', eyebrow, 'eyebrow'))
  copy.append(element('h1', title))
  if (lede) copy.append(element('p', lede, 'lede'))
  const breadcrumbs = element('nav', undefined, 'breadcrumbs')
  breadcrumbs.setAttribute('aria-label', '范围面包屑')
  function setBreadcrumbs(items) {
    breadcrumbs.replaceChildren()
    for (const crumb of items || []) {
      if (crumb && crumb.href) {
        const link = element('a', crumb.label)
        link.href = crumb.href
        breadcrumbs.append(link)
      } else if (crumb) {
        breadcrumbs.append(element('span', crumb.label))
      }
    }
    if (breadcrumbs.children.length > 0 && !breadcrumbs.isConnected) copy.append(breadcrumbs)
  }
  setBreadcrumbs(config.breadcrumbs)
  const status = element('div', undefined, 'status-banner')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.textContent = '正在读取当前状态…'
  heading.append(copy, status)
  page.append(heading)

  const primary = element('section', undefined, 'page-primary')
  primary.dataset.pageSlot = 'primary'
  const support = element('aside', undefined, 'page-support')
  support.dataset.pageSlot = 'support'
  const composer = element('section', undefined, 'page-composer')
  composer.dataset.pageSlot = 'composer'
  page.append(primary, support, composer)

  const header = layout === PAGE_LAYOUTS.standalone ? null : makeTopbar(active)
  if (header) root.append(header)
  root.append(page)

  let shell = null
  if (layout !== PAGE_LAYOUTS.standalone) {
    const shellLayer = mountShellLayer(context, root)
    shell = {
      openShellSection: shellLayer.open,
      setShellScope: shellLayer.setScope,
      setShellCapabilities: shellLayer.setCapabilities,
      applyDisplayMode: shellLayer.applyDisplayMode,
      initializeDisplayPreference: shellLayer.initializeDisplayPreference,
      disposeDisplayPreference: shellLayer.disposeDisplayPreference,
      dispose: shellLayer.dispose,
    }
  }

  const detail = {
    open(detailConfig, trigger) {
      openTechnicalDetail({ ...detailConfig, trigger })
      return detail
    },
    close() {
      closeTechnicalDetailLayer()
      return detail
    },
    dispose() {
      removeTechnicalDetailLayer()
    },
  }

  function dispose() {
    detail.dispose()
    shell?.dispose()
    root.replaceChildren()
  }

  return {
    root,
    layout,
    hosts: { page, heading, status, primary, support, composer },
    shell,
    detail,
    setBreadcrumbs,
    dispose,
  }
}

export function showError(target, error) {
  clearNode(target)
  target.dataset.tone = 'danger'
  target.append(
    element('strong', error.code || 'request.failed'),
    element('p', `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`),
  )
  appendPairingEntry(target, error)
}

/**
 * The page-level failure banner. A business read can reject before any status
 * projection renders, and when that rejection is a typed session error the page
 * must still offer the real pairing entry instead of leaving the runtime's
 * "open the login page" instruction as dead text.
 */
export function renderPageError(target, error, fallbackNext = 'check runtime') {
  clearNode(target)
  target.dataset.tone = 'danger'
  const copy = readFailureCopy(error)
  // The primary layer is human copy. The runtime's exact diagnostic line (code, owner,
  // message, next) is preserved verbatim in the contextual 技术详情 layer so nothing is
  // swallowed and existing failure detectors keep their exact tokens.
  target.append(
    element('strong', copy.result),
    element('p', copy.next),
    technicalDetailTrigger(() => ({
      title: '技术详情',
      entries: errorDetailEntries(error, fallbackNext),
    })),
  )
  appendPairingEntry(target, error)
}

export function taskIdFromQuery(required = true) {
  const taskId = queryParam('task')
  if (!taskId && required) throw new Error('URL 缺少 task 参数')
  return taskId
}

/**
 * Read-only semantic observation panel over the public GET/SSE contract.
 *
 * The confirmed envelope is the only cached state. A dropped stream, a
 * malformed revision or a rejected reload keeps the last confirmed content and
 * marks it stale: an `open` that delivers no revision is not freshness, and only
 * a decoded revision restores it. Mode and breadcrumb selection re-project the
 * envelope already in memory, so no switch issues a request. The panel never
 * writes a task, consumes a queue, retries an operation or changes execution.
 *
 * @param {HTMLElement} host
 * @param {{ taskId: string, scope?: Object, apiClient?: Object, onModeChange?: (mode: string) => void, onEvidenceRequest?: (evidence: Object, trigger: HTMLButtonElement) => void }} options
 * @returns {{ reload: () => Promise<void>, setMode: (mode: string) => void, setScopeRef: (scopeRef: string) => void, dispose: () => void }}
 */
export function mountSemanticObservationPanel(host, {
  taskId,
  scope,
  apiClient = api,
  onModeChange,
  onEvidenceRequest,
} = {}) {
  if (!(host instanceof HTMLElement)) throw new TypeError('mountSemanticObservationPanel requires an HTMLElement host')
  if (typeof taskId !== 'string' || !taskId) throw new TypeError('mountSemanticObservationPanel requires a taskId')

  let envelope = null
  let displayMode = 'current'
  let scopeRef = ''
  let streamDisconnected = false
  let readError = null
  let source = null
  let readSerial = 0
  let disposed = false

  const view = mountSemanticObservation(host, {
    onModeChange(nextMode) {
      displayMode = nextMode
      onModeChange?.(nextMode)
      render()
    },
    onScopeRequest(nextScopeRef) {
      scopeRef = nextScopeRef
      render()
    },
    onEvidenceRequest(evidence, trigger) {
      if (typeof onEvidenceRequest === 'function') {
        onEvidenceRequest(evidence, trigger)
        return
      }
      openTechnicalDetail({
        eyebrow: '只读证据',
        title: evidence?.title || '证据详情',
        content: renderSemanticEvidenceContent(evidence),
        trigger,
      })
    },
  })

  // The public stream serves revisions until the operation it observes is
  // terminal. Only the operation named by `envelope.scope` decides that, so a
  // retained earlier closed operation never stops a live one. Admission follows
  // that typed pairing group instead of one event kind, so a new event kind
  // cannot silently freeze the panel.
  function observedOperationGroup(envelope) {
    const observedOperationId = envelope?.scope?.operationId?.value
    if (typeof observedOperationId !== 'string' || !observedOperationId) return undefined
    return (Array.isArray(envelope.pairing) ? envelope.pairing : []).find(
      (group) => group?.kind === 'operation' && group?.scope?.operationId?.value === observedOperationId,
    )
  }

  function canStream(envelope) {
    if (envelope === null) return false
    const group = observedOperationGroup(envelope)
    // No typed group for the observed operation keeps the stream open on
    // purpose: a not-yet-paired operation still publishes its first revision.
    if (group === undefined) return true
    return group.state !== 'closed'
  }

  function render() {
    if (disposed) return
    if (envelope === null) {
      view.update({
        contractVersion: 'semantic-observation-view@1',
        mode: displayMode,
        modes: [
          { id: 'current', label: '简洁' },
          { id: 'semantic', label: '语义' },
          { id: 'actions', label: '动作' },
          { id: 'raw', label: '原始' },
        ],
        scope: { scopeRef: `task:${taskId}`, title: `任务范围 · ${taskId}`, summary: '', breadcrumbs: [] },
        state: 'loading',
        stateLabel: '读取中',
        projectionVersion: '未标注',
        summary: [],
        notices: [{ tone: 'loading', title: '正在读取语义观测', detail: '只读读取任务语义观测信封。' }],
        emptyMessage: '正在读取语义观测。',
        capabilities: [],
        sections: [],
      })
      return
    }
    view.update(buildSemanticObservationProjection(envelope, {
      mode: displayMode,
      ...(scopeRef ? { scopeRef } : {}),
      stale: streamDisconnected || readError !== null,
      streamDisconnected,
      ...(readError ? { error: readError } : {}),
    }))
  }

  function closeStream() {
    if (source) {
      source.onerror = null
      source.onmessage = null
      source.close()
      source = null
    }
  }

  function openStream() {
    if (disposed || source !== null || typeof EventSource !== 'function') return
    if (!canStream(envelope)) return
    const stream = new EventSource(apiClient.semanticEventsUrl(taskId, scope))
    const streamRevision = readSerial
    stream.addEventListener('semantic.observation', (event) => {
      if (disposed || source !== stream || streamRevision !== readSerial) return
      let next = null
      try {
        next = JSON.parse(event.data)
      } catch {
        next = null
      }
      if (!next || typeof next !== 'object') {
        // A malformed revision is not a silent drop: the confirmed content stays
        // and the typed read failure is shown.
        readError = {
          code: 'semantic.stream.malformed',
          message: '实时语义事件流格式无效',
          ownerId: 'humanagent.ui',
          nextAction: '重新读取语义观测',
        }
        render()
        return
      }
      freezeJsonValue(next)
      envelope = next
      readError = null
      streamDisconnected = false
      render()
    })
    stream.addEventListener('semantic-complete', () => {
      if (disposed || source !== stream || streamRevision !== readSerial) return
      closeStream()
      render()
    })
    // Reconnecting only means the socket opened again. Freshness returns only
    // with a decoded revision, so `onopen` deliberately changes nothing.
    stream.onopen = () => {}
    stream.onerror = () => {
      if (disposed) return
      // The transport dropped. The confirmed envelope stays; the stale notice is
      // explicit, and a decoded revision is the only thing that clears it.
      streamDisconnected = true
      render()
    }
    source = stream
  }

  function typedError(error, fallbackCode, fallbackMessage) {
    return {
      code: error?.code || fallbackCode,
      message: error?.message || fallbackMessage,
      ...(error?.ownerId ? { ownerId: error.ownerId } : {}),
      ...(error?.nextAction ? { nextAction: error.nextAction } : {}),
    }
  }

  async function read() {
    const serial = ++readSerial
    closeStream()
    try {
      const next = freezeJsonValue(await apiClient.semanticObservation(taskId, scope))
      if (disposed || serial !== readSerial) return
      envelope = next
      readError = null
      streamDisconnected = false
    } catch (error) {
      if (disposed || serial !== readSerial) return
      // A rejected read keeps the last confirmed envelope and marks it stale. It
      // never claims a stream disconnection, because a plain GET failure means no
      // stream was ever involved.
      readError = typedError(error, 'semantic.read.failed', '语义观测读取失败')
    }
    render()
    openStream()
  }

  render()
  void read()

  return {
    async reload() {
      await read()
    },
    setMode(nextMode) {
      displayMode = nextMode
      render()
    },
    setScopeRef(nextScopeRef) {
      scopeRef = nextScopeRef
      render()
    },
    dispose() {
      disposed = true
      closeStream()
      view.dispose()
    },
  }
}

export { clearNode, element, formatTime, queryParam, readScopeKey, stateTone }
