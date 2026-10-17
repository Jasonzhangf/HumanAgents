/**
 * Shared presentation projection for the read-only semantic observation view.
 *
 * This is the single implementation of the `semantic-observation-view@1`
 * mapping. The browser has no build step that links `packages/ui`, so a second
 * copy in TypeScript would be a second classification table to drift. The typed
 * envelope remains the truth: this function only projects the canonical
 * `SemanticObservationEnvelope` that the public GET/SSE contract already serves.
 * It reads no DOM, no clock and no global state, and it never rebuilds pairing
 * or control from a raw payload.
 *
 * @typedef {Object} SemanticObservationViewCrumb
 * @property {string} scopeRef
 * @property {string} title
 * @property {boolean} [current]
 *
 * @typedef {Object} SemanticObservationViewItem
 * @property {string} id
 * @property {string} title
 * @property {string} [detail]
 * @property {readonly string[]} [meta]
 * @property {string} [state]
 * @property {string} [stateLabel]
 * @property {string} [tone]
 * @property {string} [kind]
 * @property {Object} [evidence]
 *
 * @typedef {Object} SemanticObservationViewSection
 * @property {string} id
 * @property {string} title
 * @property {'stable'|'live'|'semantic'|'action'|'raw'|'capability'} kind
 * @property {string} [description]
 * @property {readonly SemanticObservationViewItem[]} items
 *
 * @typedef {Object} SemanticObservationViewNotice
 * @property {string} tone
 * @property {string} title
 * @property {string} [detail]
 * @property {string} [nextAction]
 *
 * @typedef {Object} SemanticObservationViewProjection
 * @property {'semantic-observation-view@1'} contractVersion
 * @property {string} mode
 * @property {readonly { id: string, label: string }[]} modes
 * @property {{ scopeRef: string, title: string, summary: string, breadcrumbs: readonly SemanticObservationViewCrumb[] }} scope
 * @property {string} state
 * @property {string} stateLabel
 * @property {string} projectionVersion
 * @property {readonly { label: string, value: string, tone?: string }[]} summary
 * @property {readonly SemanticObservationViewNotice[]} notices
 * @property {readonly { capability: string, state: string, reason?: string }[]} capabilities
 * @property {readonly SemanticObservationViewSection[]} sections
 */

export const SEMANTIC_OBSERVATION_VIEW_VERSION = 'semantic-observation-view@1'

export const SEMANTIC_OBSERVATION_DISPLAY_MODES = Object.freeze([
  Object.freeze({ id: 'current', label: '简洁' }),
  Object.freeze({ id: 'semantic', label: '语义' }),
  Object.freeze({ id: 'actions', label: '动作' }),
  Object.freeze({ id: 'raw', label: '原始' }),
])

// §17.4: `open`/`closed` are the live/stable pair, and every other typed state
// keeps its own meaning instead of collapsing into a generic failure.
const PAIRING_STATE_PROJECTION = Object.freeze({
  open: Object.freeze({ state: 'running', stateLabel: '进行中', summaryLabel: '进行中动作', tone: 'warning' }),
  closed: Object.freeze({ state: 'completed', stateLabel: '已收拢', summaryLabel: '已收拢动作', tone: 'success' }),
  waiting: Object.freeze({ state: 'waiting', stateLabel: '等待中', summaryLabel: '等待中动作', tone: 'warning' }),
  blocked: Object.freeze({ state: 'blocked', stateLabel: '受阻', summaryLabel: '受阻动作', tone: 'danger' }),
  cancelled: Object.freeze({ state: 'cancelled', stateLabel: '已取消', summaryLabel: '已取消动作', tone: 'gray' }),
  unknown: Object.freeze({ state: 'unknown', stateLabel: '未知', summaryLabel: '未知动作', tone: 'warning' }),
  unavailable: Object.freeze({ state: 'unavailable', stateLabel: '不可用', summaryLabel: '不可用动作', tone: 'gray' }),
})

// A closed group must never mask a live, waiting or blocked group beside it.
const PAIRING_STATE_PRIORITY = Object.freeze([
  'blocked',
  'waiting',
  'open',
  'unknown',
  'unavailable',
  'cancelled',
  'closed',
])

const EVENT_STATE_LABELS = Object.freeze({
  active: '进行中',
  completed: '已完成',
  failed: '失败',
  resolved: '已解决',
  rejected: '已拒绝',
  superseded: '已替换',
})

function array(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function scopeValue(node) {
  return typeof node?.value === 'string' ? node.value : ''
}

function scopeBreadcrumbs(scope) {
  const source = scope && typeof scope === 'object' ? scope : {}
  const crumbs = []
  const organId = scopeValue(source.organId)
  if (organId) crumbs.push({ scopeRef: `organ:${organId}`, title: `组织范围 · ${organId}` })
  const taskId = scopeValue(source.taskId)
  if (taskId) crumbs.push({ scopeRef: `task:${taskId}`, title: `任务范围 · ${taskId}` })
  const operationId = scopeValue(source.operationId)
  if (operationId) crumbs.push({ scopeRef: `operation:${operationId}`, title: `当前操作 · ${operationId}` })
  return crumbs
}

// Scope filtering is a local projection over the decoded envelope. An operation
// scope shows its own facts, a task scope also shows its operations' facts, and
// an organ scope keeps every fact below it. No other scope is ever mixed in.
function eventMatchesScope(eventScope, selectedScopeRef) {
  const separator = selectedScopeRef.indexOf(':')
  if (separator < 0) return false
  const kind = selectedScopeRef.slice(0, separator)
  const value = selectedScopeRef.slice(separator + 1)
  if (!value) return false
  if (kind === 'organ') return scopeValue(eventScope?.organId) === value
  if (kind === 'task') return scopeValue(eventScope?.taskId) === value
  if (kind === 'operation') return scopeValue(eventScope?.operationId) === value
  return false
}

function eventTone(status) {
  if (status === 'completed' || status === 'resolved') return 'success'
  if (status === 'failed' || status === 'rejected') return 'danger'
  if (status === 'active') return 'warning'
  return 'gray'
}

// Technical identifiers belong to the read-only evidence drawer and raw mode.
function eventEvidence(event, scopeTitle) {
  const refs = array(event.evidenceRefs)
    .map((ref) => text(ref?.locator))
    .filter((locator) => locator.length > 0)
  const raw = [
    `eventId: ${text(event.eventId)}`,
    `type: ${text(event.type)}`,
    `sourceId: ${text(event.sourceId)}`,
    `payloadRef: ${text(event.payloadRef)}`,
    `dataDigest: ${text(event.dataDigest)}`,
  ]
  return {
    evidenceId: text(event.eventId),
    title: text(event.summary, '只读证据'),
    summary: '来自规范语义观测信封的只读证据。',
    scopeLabel: scopeTitle,
    sourceLabel: text(event.sourceId),
    ...(refs.length > 0 ? { refs } : {}),
    raw: {
      label: '原始事件记录（主动查看）',
      content: raw.join('\n'),
    },
  }
}

function eventItem(event, kind, scopeTitle, meta) {
  const status = text(event.status, 'unknown')
  return {
    id: text(event.eventId),
    title: text(event.summary, text(event.type, '未命名事件')),
    meta,
    state: status,
    stateLabel: EVENT_STATE_LABELS[status] ?? '未知',
    tone: eventTone(status),
    kind,
    evidence: eventEvidence(event, scopeTitle),
  }
}

function headlinePairingState(pairing) {
  return PAIRING_STATE_PRIORITY.find((candidate) => pairing.some((group) => group?.state === candidate)) ?? 'unknown'
}

/**
 * @param {Object} envelope canonical `SemanticObservationEnvelope` from the public GET/SSE
 * @param {{ mode?: string, scopeRef?: string, stale?: boolean, streamDisconnected?: boolean, error?: { code?: string, message?: string, nextAction?: string } }} [options]
 * @returns {SemanticObservationViewProjection}
 */
export function buildSemanticObservationProjection(envelope, options = {}) {
  const source = envelope && typeof envelope === 'object' ? envelope : {}
  const events = array(source.events)
  const pairing = array(source.pairing)
  const coverageIssues = array(source.coverageIssues)
  const mode = SEMANTIC_OBSERVATION_DISPLAY_MODES.some((entry) => entry.id === options.mode)
    ? options.mode
    : 'current'

  const crumbs = scopeBreadcrumbs(source.scope)
  const requestedScope = crumbs.some((crumb) => crumb.scopeRef === options.scopeRef) ? options.scopeRef : ''
  const selectedScopeRef = requestedScope || crumbs.at(-1)?.scopeRef || 'task'
  const currentCrumb = crumbs.find((crumb) => crumb.scopeRef === selectedScopeRef)
  const scopeTitle = currentCrumb?.title ?? '当前观测范围'

  const visibleEvents = events.filter((event) => eventMatchesScope(event?.scope, selectedScopeRef))
  const stateCounts = new Map()
  for (const group of pairing) {
    const state = text(group?.state, 'unknown')
    stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1)
  }

  const headline = headlinePairingState(pairing)
  const projected = PAIRING_STATE_PROJECTION[headline] ?? PAIRING_STATE_PROJECTION.unknown
  let state = projected.state
  let stateLabel = projected.stateLabel
  if (options.stale) {
    state = 'stale'
    stateLabel = '已过期'
  } else if (pairing.length === 0 && events.length === 0) {
    state = 'empty'
    stateLabel = '空'
  }

  const summary = [...stateCounts.entries()].map(([pairingState, count]) => ({
    label: PAIRING_STATE_PROJECTION[pairingState]?.summaryLabel ?? `${pairingState}动作`,
    value: `${count} 项`,
    tone: PAIRING_STATE_PROJECTION[pairingState]?.tone,
  }))

  const notices = []
  if (coverageIssues.length > 0) {
    notices.push({
      tone: 'unknown',
      title: '覆盖不完整（partial）',
      detail: '部分事实缺少关联或来源信息，保持未知而不显示成功。',
    })
    if (coverageIssues.some((issue) => issue?.reason === 'waiting-is-not-terminal')) {
      notices.push({
        tone: 'info',
        title: '等待不等于结束',
        detail: '存在等待中的执行分组，不能视为已收拢终态。',
      })
    }
  }
  if (options.streamDisconnected) {
    notices.push({
      tone: 'stale',
      title: '实时连接已断开，显示上次确认内容',
      detail: '连接断开不改变任务终态。',
    })
  }
  if (options.error) {
    notices.push({
      tone: 'error',
      title: '语义读取失败',
      detail: `${text(options.error.code, 'semantic.read.failed')}: ${text(options.error.message)}`,
      ...(options.error.nextAction ? { nextAction: text(options.error.nextAction) } : {}),
    })
  }

  const humanMeta = (event) => [text(event.occurredAt)].filter((entry) => entry.length > 0)
  const semanticItems = visibleEvents.map((event) => eventItem(event, 'semantic', scopeTitle, humanMeta(event)))
  const stableItems = visibleEvents
    .filter((event) => event?.status === 'completed' || event?.status === 'resolved')
    .map((event) => eventItem(event, 'semantic', scopeTitle, humanMeta(event)))
  const liveItems = visibleEvents
    .filter((event) => event?.status === 'active')
    .map((event) => eventItem(event, 'live', scopeTitle, humanMeta(event)))
  const actionItems = visibleEvents.map((event) => eventItem(
    event,
    'action',
    scopeTitle,
    [text(event.type), ...humanMeta(event)].filter((entry) => entry.length > 0),
  ))
  const rawItems = visibleEvents.map((event) => ({
    id: text(event.eventId),
    title: text(event.type, '未命名事件'),
    meta: [text(event.sourceId), text(event.payloadRef), text(event.dataDigest)].filter((entry) => entry.length > 0),
    kind: 'raw',
  }))

  const sections = []
  if (mode === 'current') {
    if (stableItems.length > 0) {
      sections.push({
        id: 'stable',
        title: '已提交事实',
        kind: 'stable',
        description: '已完成并提交的事实。',
        items: stableItems,
      })
    }
    if (liveItems.length > 0) {
      sections.push({
        id: 'live',
        title: '当前活动',
        kind: 'live',
        description: '未收拢的活动不冒充已完成。',
        items: liveItems,
      })
    }
  } else if (mode === 'semantic') {
    sections.push({
      id: 'semantic',
      title: '语义事件与配对分组',
      kind: 'semantic',
      description: '按规范语义呈现事件与配对状态。',
      items: semanticItems,
    })
  } else if (mode === 'actions') {
    sections.push({
      id: 'actions',
      title: '实际动作时间线',
      kind: 'action',
      description: '按发生顺序呈现已记录的动作。',
      items: actionItems,
    })
  } else {
    sections.push({
      id: 'raw',
      title: '原始记录',
      kind: 'raw',
      description: '仅在主动查看时读取，不驱动语义分类。',
      items: rawItems,
    })
  }

  return {
    contractVersion: SEMANTIC_OBSERVATION_VIEW_VERSION,
    mode,
    modes: SEMANTIC_OBSERVATION_DISPLAY_MODES,
    scope: {
      scopeRef: selectedScopeRef,
      title: scopeTitle,
      summary: '只读语义观测：人类可读语义在前，技术标识留在证据与原始模式。',
      breadcrumbs: crumbs.map((crumb) => ({
        scopeRef: crumb.scopeRef,
        title: crumb.title,
        current: crumb.scopeRef === selectedScopeRef,
      })),
    },
    state,
    stateLabel,
    projectionVersion: text(source.projectionVersion, '未标注'),
    summary,
    notices,
    capabilities: array(source.capabilities).map((capability) => ({
      capability: text(capability?.capability, '未命名能力'),
      state: text(capability?.state, 'unknown'),
      ...(capability?.reason ? { reason: text(capability.reason) } : {}),
    })),
    sections,
  }
}
