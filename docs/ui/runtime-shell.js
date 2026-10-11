import {
  clearNode,
  createRuntimeApi,
  element,
  formatTime,
  isAuthSessionError,
  loginHref,
  queryParam,
  RuntimeApiError,
  stateTone,
} from './runtime-api.js'
import { mountSemanticObservation } from './semantic-observation.js'

export const api = createRuntimeApi()

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
    target.dataset.tone = 'danger'
    target.append(
      element('strong', 'Runtime 未连接'),
      element('span', ` ${error.message} · ${error.ownerId} · ${error.nextAction}`),
    )
    appendPairingEntry(target, error)
    return
  }
  target.dataset.tone = status.state === 'ready' ? 'success' : 'warning'
  const provider = status.providerError
    ? ` · ${status.providerError.code} · owner=${status.providerError.ownerId} · ${status.providerError.nextAction}`
    : ''
  const implicit = status.implicitScheduling
    ? ` · requirement=${status.implicitScheduling.requirementId} · ${status.implicitScheduling.code} · owner=${status.implicitScheduling.ownerId} · next=${status.implicitScheduling.nextAction}`
    : ''
  if (status.implicitScheduling) target.dataset.tone = status.implicitScheduling.state === 'failed' ? 'danger' : 'warning'
  target.append(
    element('strong', `mode=${status.mode}`),
    element('span', ` · provider=${status.providerState} · ${status.connected ? 'connected' : 'disconnected'}${provider}${implicit}`),
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
    ['task.html?task=new', '新建 Task'],
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

export function makePageShell(active, eyebrow, title, lede) {
  const interactionCardHosts = [...document.querySelectorAll('[data-interaction-work-card-host]')]
  document.body.replaceChildren()
  const header = makeTopbar(active)
  const main = element('main', undefined, 'page')
  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', eyebrow, 'eyebrow'), element('h1', title))
  if (lede) copy.append(element('p', lede, 'lede'))
  const status = element('div', undefined, 'status-banner')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.textContent = '正在连接 Runtime API…'
  heading.append(copy, status)
  main.append(heading)
  document.body.append(header, main)
  return { main, status, interactionCardHosts }
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
  target.append(element(
    'span',
    `${error.message || String(error)} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || fallbackNext}`,
  ))
  appendPairingEntry(target, error)
}

export function taskIdFromQuery(required = true) {
  const taskId = queryParam('task')
  if (!taskId && required) throw new Error('URL 缺少 task 参数')
  return taskId
}

export function observationHref(taskId) {
  return `./observation.html?task=${encodeURIComponent(taskId)}`
}

export function taskDashboardHref(taskId) {
  return `./task-dashboard.html?task=${encodeURIComponent(taskId)}`
}

export function taskDetailHref(taskId) {
  return `./task.html?task=${encodeURIComponent(taskId)}`
}

export { clearNode, element, formatTime, queryParam, stateTone }

/* ---------------------------------------------------------------------------
 * Shared semantic observation surface.
 *
 * One transport boundary decodes the runtime's public semantic envelope exactly
 * once (GET `response.json()` and SSE `JSON.parse`); the read-only adapter below
 * turns that typed envelope into the shared component projection. The Task
 * Observation page and the Task Dashboard mount the same panel, so rendering and
 * evidence references are identical across consumers and a revision replaces the
 * whole decoded payload instead of mutating bytes another view still holds.
 * ------------------------------------------------------------------------- */

export const SEMANTIC_OBSERVATION_MODES = Object.freeze([
  { id: 'current', label: '简洁' },
  { id: 'semantic', label: '语义' },
  { id: 'actions', label: '动作' },
  { id: 'raw', label: '原始' },
])

// Closed presentation vocabularies. These map typed canonical fields to human
// labels; they never re-derive the event taxonomy or pairing from raw text.
const SEMANTIC_STATUS_LABELS = Object.freeze({
  active: { label: '进行中', tone: 'warning' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  resolved: { label: '已解决', tone: 'success' },
  superseded: { label: '已被取代', tone: 'gray' },
  rejected: { label: '已否决', tone: 'warning' },
})

const SEMANTIC_GROUP_LABELS = Object.freeze({
  open: { label: '进行中', tone: 'warning' },
  closed: { label: '已收拢', tone: 'success' },
  waiting: { label: '等待中', tone: 'warning' },
  blocked: { label: '受阻', tone: 'warning' },
  cancelled: { label: '已取消', tone: 'gray' },
  unknown: { label: '未知', tone: 'warning' },
  unavailable: { label: '不可用', tone: 'gray' },
})

const SEMANTIC_PAIR_ROLE_LABELS = Object.freeze({
  opened: '起始事件',
  resolved: '已闭合',
  rejected: '已否决',
})

const SEMANTIC_ACTION_KIND_LABELS = Object.freeze({
  request: '模型请求',
  operation: '操作',
  invocation: '工具调用',
})

const SEMANTIC_COVERAGE_LABELS = Object.freeze({
  'unknown-kind': '存在未归类事件',
  'waiting-is-not-terminal': '等待不等于结束',
  'indistinguishable-tool-phase': '工具阶段无法区分',
  'correlation-unavailable': '缺少关联信息',
  'source-facet-missing': '来源字段缺失',
  'duplicate-conflict': '重复事实冲突',
  'opener-missing': '缺少起始事件',
  'multi-opener': '存在多个起始事件',
  'closer-conflict': '结束事件冲突',
})

function semanticModes() {
  return SEMANTIC_OBSERVATION_MODES.map((mode) => ({ id: mode.id, label: mode.label, available: true }))
}

function semanticValue(part) {
  return part && typeof part.value === 'string' ? part.value : ''
}

function semanticScopeCrumbs(scope) {
  const crumbs = []
  const organ = semanticValue(scope?.organId)
  if (organ) crumbs.push({ scopeRef: `organ:${organ}`, title: '组织范围' })
  const task = semanticValue(scope?.taskId)
  if (task) crumbs.push({ scopeRef: `task:${task}`, title: '任务范围' })
  const operation = semanticValue(scope?.operationId)
  if (operation) crumbs.push({ scopeRef: `operation:${operation}`, title: '当前操作' })
  return crumbs
}

// A crumb ref names the depth it filters to; the value stays in the ref (data
// attribute) so no technical id leaks into the human-readable breadcrumb text.
function semanticScopeMatches(ref, scope) {
  const index = ref.indexOf(':')
  if (index < 0) return true
  const kind = ref.slice(0, index)
  const value = ref.slice(index + 1)
  if (kind === 'task') return semanticValue(scope?.taskId) === value
  if (kind === 'operation') return semanticValue(scope?.operationId) === value
  return true
}

function semanticScopeSummary(scope) {
  const parts = []
  const operation = semanticValue(scope?.operationId)
  if (operation) parts.push('当前操作')
  const task = semanticValue(scope?.taskId)
  if (task) parts.push('任务范围')
  if (parts.length === 0) parts.push('组织范围')
  return `只读观测：${parts.join(' · ')}`
}

function semanticShortDigest(digest) {
  const value = typeof digest === 'string' ? digest : ''
  return value.length > 16 ? `${value.slice(0, 16)}…` : value
}

function semanticEvidenceOf(event) {
  const ref = Array.isArray(event?.evidenceRefs) ? event.evidenceRefs[0] : undefined
  const status = SEMANTIC_STATUS_LABELS[event?.status] ?? { label: event?.status ?? '未知' }
  return {
    evidenceId: ref?.evidenceId?.value || `event:${event?.eventId ?? 'unknown'}`,
    title: event?.summary || event?.type || '事件证据',
    summary: `${event?.type ?? '事件'} · ${status.label}`,
    scopeLabel: semanticScopeSummary(event?.scope),
    sourceLabel: ref?.source || event?.sourceId || 'runtime semantic projection',
    inputs: event?.summary ? [event.summary] : [],
    outputs: event?.payloadRef ? [`payload=${event.payloadRef}`] : [],
    refs: [
      ...(ref?.locator ? [ref.locator] : []),
      `source=${event?.sourceId ?? '未提供'}`,
      ...(event?.payloadRef ? [`payload=${event.payloadRef}`] : []),
      ...(event?.dataDigest ? [`digest=${event.dataDigest}`] : []),
    ],
    raw: {
      label: '原始事件记录（主动查看）',
      content: JSON.stringify({
        eventId: event?.eventId,
        sourceId: event?.sourceId,
        type: event?.type,
        status: event?.status,
        occurredAt: event?.occurredAt,
        payloadRef: event?.payloadRef,
        dataDigest: event?.dataDigest,
      }, null, 2),
    },
  }
}

function semanticEventItem(event) {
  const status = SEMANTIC_STATUS_LABELS[event?.status] ?? { label: event?.status ?? '未知', tone: 'gray' }
  return {
    id: event?.eventId ?? 'event',
    title: event?.summary || '未提供摘要',
    kind: 'semantic',
    state: event?.status,
    stateLabel: status.label,
    tone: status.tone,
    meta: [
      event?.occurredAt ? formatTime(event.occurredAt) : '',
      event?.pairing?.role ? SEMANTIC_PAIR_ROLE_LABELS[event.pairing.role] ?? event.pairing.role : '',
      event?.supersededByEventId ? '已被后续事件取代' : '',
      event?.type ?? '',
    ].filter((value) => value),
    evidence: semanticEvidenceOf(event),
  }
}

function semanticActionItem(group) {
  const state = SEMANTIC_GROUP_LABELS[group?.state] ?? { label: group?.state ?? '未知', tone: 'gray' }
  const identity = group?.toolId || group?.callId || group?.requestId || group?.groupId || '动作'
  const kind = SEMANTIC_ACTION_KIND_LABELS[group?.kind] ?? group?.kind ?? '动作'
  return {
    id: group?.groupId ?? identity,
    title: `${kind} · ${identity}`,
    kind: 'action',
    state: group?.state,
    stateLabel: state.label,
    tone: state.tone,
    meta: [
      Number.isSafeInteger(group?.executionEpoch) ? `epoch=${group.executionEpoch}` : '',
      Array.isArray(group?.eventRefs) ? `${group.eventRefs.length} 个事件引用` : '',
    ].filter((value) => value),
  }
}

function semanticRawItem(event) {
  return {
    id: event?.eventId ?? 'event',
    title: event?.type || '未标注类型',
    detail: `${event?.eventId ?? '未知事件'} · ${event?.sourceId ?? '未知来源'}`,
    kind: 'raw',
    state: event?.status,
    stateLabel: SEMANTIC_STATUS_LABELS[event?.status]?.label ?? event?.status ?? '未知',
    meta: [
      event?.occurredAt ?? '',
      `payload=${event?.payloadRef || '未提供'}`,
      `digest=${semanticShortDigest(event?.dataDigest) || '未提供'}`,
    ].filter((value) => value),
    evidence: semanticEvidenceOf(event),
  }
}

// The typed pairing vocabulary of `PAIRED_EXECUTION_STATES` maps to one headline
// state each. `waiting`, `blocked`, `cancelled`, `unknown` and `unavailable` are
// never rewritten as `completed` or as an ordinary `failed` summary.
const SEMANTIC_PAIRING_HEADLINE = Object.freeze({
  open: 'running',
  closed: 'completed',
  waiting: 'waiting',
  blocked: 'blocked',
  cancelled: 'cancelled',
  unknown: 'unknown',
  unavailable: 'unavailable',
})

// Headline precedence when one scope holds several typed states: unfinished and
// abnormal states outrank `completed` so a closed group cannot hide them. The
// summary below still lists every state that is present.
const SEMANTIC_STATE_PRECEDENCE = Object.freeze([
  'running',
  'blocked',
  'waiting',
  'cancelled',
  'failed',
  'unknown',
  'unavailable',
  'completed',
])

// Non-open/non-closed pairing states get their own summary row, so a `completed`
// headline never becomes the only visible fact about the scope.
const SEMANTIC_LISTED_PAIRING_STATES = Object.freeze(['blocked', 'waiting', 'cancelled', 'unknown', 'unavailable'])

function semanticDeriveState(events, pairing) {
  if (events.length === 0 && pairing.length === 0) return 'empty'
  const observed = new Set()
  for (const group of pairing) {
    observed.add(SEMANTIC_PAIRING_HEADLINE[group?.state] ?? 'unknown')
  }
  for (const event of events) {
    if (event?.status === 'active') observed.add('running')
    else if (event?.status === 'failed') observed.add('failed')
  }
  for (const state of SEMANTIC_STATE_PRECEDENCE) {
    if (observed.has(state)) return state
  }
  return 'completed'
}

const SEMANTIC_STATE_LABELS = Object.freeze({
  running: '进行中',
  waiting: '等待中',
  blocked: '受阻',
  cancelled: '已取消',
  failed: '失败',
  completed: '已收拢',
  empty: '空',
  stale: '已过期',
  unknown: '未知',
  unavailable: '不可用',
})

function semanticSections(mode, events, pairing) {
  if (mode === 'semantic') {
    return [{
      id: 'semantic',
      title: '语义事实',
      kind: 'semantic',
      description: '来自 Runtime canonical 事件的只读语义；按发生顺序。',
      items: events.map(semanticEventItem),
    }]
  }
  if (mode === 'actions') {
    return [{
      id: 'actions',
      title: '实际动作时间线',
      kind: 'action',
      description: '实际发生的操作与工具调用；不改写已执行事实。',
      items: pairing.map(semanticActionItem),
    }]
  }
  if (mode === 'raw') {
    return [{
      id: 'raw',
      title: '原始记录',
      kind: 'raw',
      description: '仅在主动查看时读取，不驱动语义分类。',
      items: events.map(semanticRawItem),
    }]
  }
  const stable = events.filter((event) => event?.status !== 'active' && event?.status !== 'superseded')
  const live = events.filter((event) => event?.status === 'active')
  const superseded = events.filter((event) => event?.status === 'superseded')
  const sections = [
    {
      id: 'stable',
      title: '已提交事实',
      kind: 'stable',
      description: '已收拢的语义事实；进行中的活动不在此列。',
      items: stable.map(semanticEventItem),
    },
    {
      id: 'live',
      title: '当前活动',
      kind: 'live',
      description: '未收拢活动不冒充完成。',
      items: live.map(semanticEventItem),
    },
  ]
  if (superseded.length > 0) {
    sections.push({
      id: 'superseded',
      title: '已被取代',
      kind: 'semantic',
      description: '被后续事件取代的历史事实。',
      items: superseded.map(semanticEventItem),
    })
  }
  return sections
}

function semanticCoverageNotices(coverageIssues) {
  const notices = []
  if (coverageIssues.length > 0) {
    notices.push({
      tone: 'unknown',
      title: '覆盖不完整（partial）',
      detail: `${coverageIssues.length} 项事实未能完整归入语义；未覆盖内容保持未知，不冒充完成。`,
    })
    for (const issue of coverageIssues) {
      const label = SEMANTIC_COVERAGE_LABELS[issue?.reason] ?? '语义覆盖问题'
      notices.push({ tone: 'unavailable', title: label, detail: semanticScopeSummary(issue?.scope) })
    }
  }
  return notices
}

/**
 * Pure read-only adapter: RuntimeSemanticObservationEnvelope -> the shared
 * component projection. It reads only typed canonical fields (scope, events,
 * pairing, coverageIssues, capabilities); it never re-derives the event
 * taxonomy, pairing or authorization and never mutates the envelope.
 */
export function buildSemanticObservationProjection(envelope, options = {}) {
  const source = envelope && typeof envelope === 'object' ? envelope : {}
  const events = Array.isArray(source.events) ? source.events : []
  const pairing = Array.isArray(source.pairing) ? source.pairing : []
  const coverageIssues = Array.isArray(source.coverageIssues) ? source.coverageIssues : []
  const capabilities = Array.isArray(source.capabilities) ? source.capabilities : []
  const mode = SEMANTIC_OBSERVATION_MODES.some((entry) => entry.id === options.mode) ? options.mode : 'current'

  const crumbs = semanticScopeCrumbs(source.scope)
  const requested = typeof options.focusScopeRef === 'string' && options.focusScopeRef
    ? options.focusScopeRef
    : ''
  const activeRef = requested && crumbs.some((crumb) => crumb.scopeRef === requested)
    ? requested
    : (crumbs.length > 0 ? crumbs[crumbs.length - 1].scopeRef : '')

  const scopedEvents = events.filter((event) => semanticScopeMatches(activeRef, event?.scope))
  const scopedPairing = pairing.filter((group) => semanticScopeMatches(activeRef, group?.scope))
  const state = semanticDeriveState(scopedEvents, scopedPairing)
  const pairingCounts = new Map()
  for (const group of scopedPairing) {
    const key = typeof group?.state === 'string' && group.state ? group.state : 'unknown'
    pairingCounts.set(key, (pairingCounts.get(key) ?? 0) + 1)
  }
  const closed = pairingCounts.get('closed') ?? 0
  const open = pairingCounts.get('open') ?? 0

  return {
    mode,
    modes: semanticModes(),
    scope: {
      scopeRef: activeRef,
      title: '语义观测',
      summary: '从 Runtime canonical 事实到只读证据；不消费需求、不修改队列、不执行控制。',
      breadcrumbs: crumbs.map((crumb) => ({
        scopeRef: crumb.scopeRef,
        title: crumb.title,
        current: crumb.scopeRef === activeRef,
      })),
    },
    state,
    stateLabel: SEMANTIC_STATE_LABELS[state] ?? '未知',
    projectionVersion: typeof source.projectionVersion === 'string' ? source.projectionVersion : '',
    summary: [
      { label: '语义事件', value: `${scopedEvents.length} 条` },
      { label: '已收拢动作', value: `${closed} 项` },
      { label: '进行中动作', value: `${open} 项`, tone: open > 0 ? 'warning' : undefined },
      ...SEMANTIC_LISTED_PAIRING_STATES
        .filter((pairingState) => (pairingCounts.get(pairingState) ?? 0) > 0)
        .map((pairingState) => ({
          label: `${SEMANTIC_GROUP_LABELS[pairingState].label}动作`,
          value: `${pairingCounts.get(pairingState)} 项`,
          tone: SEMANTIC_GROUP_LABELS[pairingState].tone,
        })),
      { label: '覆盖问题', value: `${coverageIssues.length} 项`, tone: coverageIssues.length > 0 ? 'warning' : undefined },
    ],
    notices: semanticCoverageNotices(coverageIssues),
    capabilities: capabilities.map((capability) => ({
      capability: capability?.capability ?? '未命名能力',
      state: capability?.state ?? 'unknown',
      reason: capability?.reason,
    })),
    sections: semanticSections(mode, scopedEvents, scopedPairing),
  }
}

export function semanticObservationLoadingProjection() {
  return {
    mode: 'current',
    modes: semanticModes(),
    scope: { scopeRef: '', title: '语义观测', summary: '', breadcrumbs: [] },
    state: 'loading',
    stateLabel: '加载中',
    projectionVersion: '',
    summary: [],
    notices: [{ tone: 'loading', title: '正在读取语义投影', detail: '完成前不使用原始内容推断状态。' }],
    capabilities: [],
    sections: [],
  }
}

export function semanticObservationFailureProjection(error) {
  return {
    mode: 'current',
    modes: semanticModes(),
    scope: { scopeRef: '', title: '语义观测', summary: '', breadcrumbs: [] },
    state: 'failed',
    stateLabel: '失败',
    projectionVersion: '',
    summary: [],
    notices: [{
      tone: 'error',
      title: '读取语义投影失败',
      detail: `${error?.code || 'runtime.request.failed'} · ${error?.message || String(error)}`,
      nextAction: error?.nextAction || '检查 runtime',
    }],
    capabilities: [],
    sections: [],
  }
}

// A semantic stream is terminal only for the operation it currently observes;
// reaching it means the runtime closed the live read, not that the task was
// cancelled. Closing our own subscription is unsubscribe, not a control command.
function semanticEnvelopeTerminal(envelope) {
  const operationId = semanticValue(envelope?.scope?.operationId)
  if (!operationId) return false
  const pairing = Array.isArray(envelope?.pairing) ? envelope.pairing : []
  return pairing.some((group) => group?.kind === 'operation'
    && semanticValue(group?.scope?.operationId) === operationId
    && group?.state === 'closed')
}

// The Task Dashboard page only links runtime.css, so the shared component styles
// are attached once (guarded) instead of duplicating the token-driven rules.
function ensureSemanticObservationStyles() {
  const present = [...document.querySelectorAll('link[rel="stylesheet"]')].some((link) => {
    const href = link.getAttribute('href') || ''
    return href.split('?')[0].endsWith('observation.css')
  })
  if (present) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = './observation.css'
  link.dataset.semanticObservationStyles = 'true'
  document.head.append(link)
}

// A read is only successful when the runtime returns a decoded envelope object.
// A malformed body is a typed read failure, not an empty observation.
function isSemanticEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function decodeSemanticEnvelope(data) {
  let decoded
  try {
    decoded = JSON.parse(data)
  } catch {
    return null
  }
  return isSemanticEnvelope(decoded) ? decoded : null
}

async function fetchSemanticObservation(taskId) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/semantic`, {
    headers: { accept: 'application/json' },
  })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) throw new RuntimeApiError(body?.error || body || {}, response.status)
  if (!isSemanticEnvelope(body)) {
    throw new RuntimeApiError({
      code: 'semantic.read.malformed',
      message: 'Runtime semantic read did not return a JSON envelope',
      ownerId: 'humanagent.app',
      nextAction: 'reload the semantic observation',
    }, response.status)
  }
  return body
}

/**
 * Mount the shared read-only semantic observation panel for one task.
 *
 * The panel owns the transport boundary (one GET decode + one SSE decode per
 * revision), mode and scope selection, and stale/empty/failure presentation. It
 * never issues a task, checkpoint, confirmation or control mutation: mode
 * switching and scope drill-down only re-project the already-decoded envelope.
 */
export function mountSemanticObservationPanel(host, options = {}) {
  if (!(host instanceof HTMLElement)) {
    throw new TypeError('mountSemanticObservationPanel requires an HTMLElement host')
  }
  const taskId = options.taskId
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new TypeError('mountSemanticObservationPanel requires a taskId')
  }
  ensureSemanticObservationStyles()

  let component
  let envelope = null
  let mode = 'current'
  let focusScopeRef = ''
  let stream = null
  let stale = false
  let errorState = null
  let disposed = false

  const errorHost = element('div', undefined, 'semantic-observation-error')

  function renderError(error) {
    clearNode(errorHost)
    // A typed session rejection is the only failure the component cannot voice
    // itself: it needs a real pairing entry. Every other failure is already shown
    // by the component's own error notice, so no duplicate banner is rendered.
    if (!isAuthSessionError(error)) return
    errorHost.dataset.tone = 'danger'
    errorHost.append(element('span', `${error.code || 'semantic.read.failed'} · ${error.message}`))
    appendPairingEntry(errorHost, error)
  }

  // The kept envelope stays visible, but a dropped stream or a failed read/parse
  // makes it stale and is stated with a typed notice. Neither path retries or
  // sends a control command: this is read-only transport state.
  function transportNotices() {
    const notices = []
    if (stale) {
      notices.push({
        tone: 'stale',
        title: '实时连接已断开，显示上次内容',
        detail: '断开不改变任务终态。',
      })
    }
    if (errorState) {
      notices.push({
        tone: 'error',
        title: '语义读取失败，显示上次内容',
        detail: `${errorState.code || 'runtime.request.failed'} · ${errorState.message || String(errorState)}`,
        nextAction: errorState.nextAction || '检查 runtime',
      })
    }
    return notices
  }

  function render() {
    if (disposed) return
    if (!envelope) {
      component.update(errorState ? semanticObservationFailureProjection(errorState) : semanticObservationLoadingProjection())
      return
    }
    const projection = buildSemanticObservationProjection(envelope, { mode, focusScopeRef })
    const notices = transportNotices()
    if (notices.length > 0) {
      projection.state = 'stale'
      projection.stateLabel = SEMANTIC_STATE_LABELS.stale
      projection.notices = [...notices, ...(projection.notices || [])]
    }
    component.update(projection)
  }

  function closeStream() {
    if (!stream) return
    const closing = stream
    stream = null
    closing.close()
  }

  function subscribe() {
    closeStream()
    const next = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/semantic/stream`)
    stream = next
    next.addEventListener('semantic.observation', (message) => {
      if (disposed || stream !== next) return
      const decoded = decodeSemanticEnvelope(message.data)
      if (!decoded) {
        errorState = new RuntimeApiError({
          code: 'semantic.stream.malformed',
          message: 'Runtime semantic stream delivered an unreadable revision',
          ownerId: 'humanagent.app',
          nextAction: 'wait for the next revision or reload the read',
        }, 0)
        render()
        return
      }
      envelope = decoded
      stale = false
      errorState = null
      renderError(null)
      render()
      if (semanticEnvelopeTerminal(decoded)) closeStream()
    })
    // Opening a stream is not receiving a revision. Only a decoded envelope
    // clears `stale`, so a reconnect that carries no data keeps the stale notice.
    next.onerror = () => {
      if (disposed || stream !== next || !envelope) return
      stale = true
      render()
    }
  }

  async function start() {
    render()
    try {
      const decoded = await fetchSemanticObservation(taskId)
      if (disposed) return
      envelope = decoded
      stale = false
      errorState = null
      renderError(null)
      render()
      if (!semanticEnvelopeTerminal(decoded)) subscribe()
    } catch (error) {
      if (disposed) return
      errorState = error
      render()
      renderError(error)
    }
  }

  component = mountSemanticObservation(host, {
    onModeChange(nextMode) {
      mode = nextMode
      render()
    },
    onScopeRequest(scopeRef) {
      focusScopeRef = scopeRef
      render()
    },
    onEvidenceRequest(evidence, trigger) {
      component.openEvidence(evidence, trigger)
    },
  })
  host.append(errorHost)
  void start()

  return {
    reload() {
      void start()
    },
    dispose() {
      disposed = true
      closeStream()
      component.dispose()
      clearNode(errorHost)
    },
  }
}
