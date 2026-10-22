import { formatTime } from './runtime-api.js'

// Read-only renderer for one human-readable session read. It consumes
// ProductMessage and PublicOutputPublicationProjection from the declared
// owners and never fetches, infers an actor, or fills a timestamp from task
// state. A missing actor stays unknown; a missing event time stays explicit;
// an empty commit collection produces no result block.

const ACTOR_LABELS = Object.freeze({
  human: '人类',
  agent: '代理',
  system: '系统',
  unknown: '来源未知',
})

const PUBLICATION_STATE_LABELS = Object.freeze({
  pending: '有未提交内容',
  committed: '已提交',
  unavailable: '结果状态不可用',
  unknown: '结果状态未知',
})

// A human message needs a decoded principal. Task input and task update time
// are known wrong sources, so a message that only carries those never renders
// as human.
const UNAUTHENTICATED_HUMAN_SOURCES = new Set(['task.input', 'task.updatedAt', 'unknown'])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function requireHost(host) {
  if (!host || typeof host.replaceChildren !== 'function' || typeof host.append !== 'function') {
    throw new TypeError('product session view host must be a DOM element')
  }
}

function resolveElementFactory(host, options) {
  if (typeof options?.element === 'function') return options.element
  const documentRef = host.ownerDocument
    ?? (typeof document === 'undefined' ? undefined : document)
  if (typeof documentRef?.createElement !== 'function') {
    throw new TypeError('product session view requires an element factory or a DOM host')
  }
  return (tag, text, className) => {
    const node = documentRef.createElement(tag)
    if (text !== undefined) node.textContent = String(text)
    if (className) node.className = className
    return node
  }
}

function markRole(node, name) {
  node.setAttribute('data-product-role', name)
  return node
}

function messageList(messages) {
  if (messages === undefined) return []
  if (!Array.isArray(messages)) {
    throw new TypeError('product session messages must be an array')
  }
  return messages
}

function actorKind(actor) {
  if (!actor || typeof actor !== 'object') return 'unknown'
  if (!Object.prototype.hasOwnProperty.call(ACTOR_LABELS, actor.kind)) return 'unknown'
  if (actor.kind === 'human') {
    if (!nonEmpty(actor.sourceRef)) return 'unknown'
    if (!nonEmpty(actor.sourceKind) || UNAUTHENTICATED_HUMAN_SOURCES.has(actor.sourceKind)) {
      return 'unknown'
    }
  }
  return actor.kind
}

function actorSourceText(actor) {
  if (!actor || typeof actor !== 'object') return '来源未记录'
  const parts = []
  if (nonEmpty(actor.sourceKind)) parts.push(actor.sourceKind.trim())
  if (nonEmpty(actor.sourceRef)) parts.push(actor.sourceRef.trim())
  return parts.length > 0 ? parts.join(' · ') : '来源未记录'
}

function renderMessageTime(make, message) {
  if (nonEmpty(message.occurredAt)) {
    const time = make('time', formatTime(message.occurredAt), 'product-session-time')
    time.setAttribute('datetime', message.occurredAt)
    return markRole(time, 'message-time')
  }
  const reason = nonEmpty(message.occurredAtUnavailableReason)
    ? message.occurredAtUnavailableReason.trim()
    : '事件时间未记录'
  return markRole(
    make('span', `时间不可用：${reason}`, 'product-session-time-unavailable'),
    'message-time-unavailable',
  )
}

function evidenceText(evidence) {
  const parts = []
  if (nonEmpty(evidence?.evidenceId?.value)) parts.push(`evidenceId ${evidence.evidenceId.value}`)
  if (nonEmpty(evidence?.locator)) parts.push(`locator ${evidence.locator}`)
  return parts.length > 0 ? parts.join(' · ') : '证据引用未完整提供'
}

function renderMessageDiagnostics(make, message) {
  const eventId = nonEmpty(message.ref?.eventId) ? message.ref.eventId : undefined
  const sourceId = nonEmpty(message.ref?.sourceId) ? message.ref.sourceId : undefined
  const evidenceRefs = Array.isArray(message.evidenceRefs) ? message.evidenceRefs : []
  if (eventId === undefined && sourceId === undefined && evidenceRefs.length === 0) {
    return undefined
  }

  const details = markRole(
    make('details', undefined, 'product-session-diagnostics'),
    'message-diagnostics',
  )
  details.append(make('summary', undefined, '诊断'))
  if (eventId !== undefined || sourceId !== undefined) {
    const parts = []
    if (eventId !== undefined) parts.push(`eventId ${eventId}`)
    if (sourceId !== undefined) parts.push(`sourceId ${sourceId}`)
    details.append(make('p', parts.join(' · '), 'product-session-diagnostic-line'))
  }
  for (const evidence of evidenceRefs) {
    details.append(make('p', evidenceText(evidence), 'product-session-diagnostic-line'))
  }
  return details
}

function renderMessage(make, message) {
  const item = markRole(make('li', undefined, 'product-session-message'), 'message')
  const kind = actorKind(message?.actor)
  item.setAttribute('data-actor-kind', kind)
  if (nonEmpty(message?.ref?.eventId)) {
    item.setAttribute('data-message-event-id', message.ref.eventId)
  }

  const header = make('header', undefined, 'product-session-message-head')
  header.append(markRole(make('span', ACTOR_LABELS[kind], 'product-session-actor'), 'message-actor'))
  header.append(markRole(
    make('span', actorSourceText(message?.actor), 'product-session-source'),
    'message-source',
  ))
  header.append(renderMessageTime(make, message ?? {}))
  item.append(header)

  const bodyText = nonEmpty(message?.text) ? message.text : '正文未提供'
  item.append(markRole(make('div', bodyText, 'product-session-message-body'), 'message-body'))

  const diagnostics = renderMessageDiagnostics(make, message ?? {})
  if (diagnostics !== undefined) item.append(diagnostics)
  return item
}

function renderMessagesInto(make, container, messages) {
  const list = messageList(messages)
  const wrapper = markRole(make('div', undefined, 'product-session-messages'), 'messages')
  if (list.length === 0) {
    wrapper.append(markRole(
      make('p', '来源未提供公开消息', 'product-session-empty'),
      'messages-empty',
    ))
    container.append(wrapper)
    return wrapper
  }

  const ordered = make('ol', undefined, 'product-session-message-list')
  list.forEach((message) => ordered.append(renderMessage(make, message)))
  wrapper.append(ordered)
  container.append(wrapper)
  return wrapper
}

function commitList(publicOutput) {
  if (publicOutput === undefined || publicOutput === null) return undefined
  if (typeof publicOutput !== 'object' || Array.isArray(publicOutput)) {
    throw new TypeError('public output must be a projection object')
  }
  if (publicOutput.commits === undefined) return []
  if (!Array.isArray(publicOutput.commits)) {
    throw new TypeError('public output commits must be an array')
  }
  return publicOutput.commits
}

function renderCommitRefs(make, commit) {
  const details = markRole(
    make('details', undefined, 'product-session-commit-refs'),
    'public-commit-refs',
  )
  details.append(make('summary', undefined, '提交引用'))
  const parts = []
  if (nonEmpty(commit.commitId)) parts.push(`commitId ${commit.commitId}`)
  if (Number.isSafeInteger(commit.journalSeq)) parts.push(`journalSeq ${commit.journalSeq}`)
  if (nonEmpty(commit.recordDigest)) parts.push(`recordDigest ${commit.recordDigest}`)
  details.append(make(
    'p',
    parts.length > 0 ? parts.join(' · ') : '提交引用未完整提供',
    'product-session-diagnostic-line',
  ))
  return details
}

function renderPublicCommit(make, commit) {
  const item = markRole(make('li', undefined, 'product-session-commit'), 'public-commit')
  if (nonEmpty(commit?.commitId)) item.setAttribute('data-commit-id', commit.commitId)
  if (Number.isSafeInteger(commit?.journalSeq)) {
    item.setAttribute('data-commit-journal-seq', String(commit.journalSeq))
  }
  if (nonEmpty(commit?.recordDigest)) {
    item.setAttribute('data-commit-record-digest', commit.recordDigest)
  }

  const bodyText = typeof commit?.text === 'string' ? commit.text : '提交正文未提供'
  item.append(markRole(
    make('div', bodyText, 'product-session-commit-text'),
    'public-commit-text',
  ))
  item.append(renderCommitRefs(make, commit ?? {}))
  return item
}

function renderPublicResult(make, container, publicOutput) {
  const commits = commitList(publicOutput)
  if (commits === undefined || commits.length === 0) return undefined

  const state = typeof publicOutput.state === 'string' ? publicOutput.state : 'unknown'
  const section = markRole(
    make('section', undefined, 'product-session-public-result'),
    'public-result',
  )
  section.setAttribute('data-publication-state', state)

  const head = make('header', undefined, 'product-session-public-head')
  head.append(make('h3', '已提交结果'))
  head.append(make(
    'span',
    PUBLICATION_STATE_LABELS[state] ?? '结果状态未知',
    'product-session-public-state',
  ))
  section.append(head)

  const list = make('ol', undefined, 'product-session-commit-list')
  commits.forEach((commit) => list.append(renderPublicCommit(make, commit)))
  section.append(list)

  if (Number.isSafeInteger(publicOutput.publicCommitWatermark)) {
    const diagnostics = markRole(
      make('details', undefined, 'product-session-result-diagnostics'),
      'public-result-diagnostics',
    )
    diagnostics.append(make('summary', undefined, '诊断'))
    diagnostics.append(make(
      'p',
      `publicCommitWatermark ${publicOutput.publicCommitWatermark}`,
      'product-session-diagnostic-line',
    ))
    section.append(diagnostics)
  }

  container.append(section)
  return section
}

/**
 * Render the public message list into `host`. The host is replaced, so stale
 * session content cannot survive a new read.
 */
export function renderProductMessages(host, messages, options = {}) {
  requireHost(host)
  const make = resolveElementFactory(host, options)
  host.replaceChildren()
  const root = markRole(
    make('section', undefined, 'product-session-messages-root'),
    'session-messages',
  )
  root.setAttribute('aria-label', '公开会话消息')
  renderMessagesInto(make, root, messages)
  host.append(root)
  return root
}

/**
 * Render one session read: public messages followed by confirmed public
 * commits. `publicOutput` must be a PublicOutputPublicationProjection. When it
 * is absent or has no commits, no result block is created.
 */
export function renderProductSessionView(host, input = {}, options = {}) {
  requireHost(host)
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('product session view input must be an object')
  }

  const make = resolveElementFactory(host, options)
  host.replaceChildren()
  const root = markRole(make('section', undefined, 'product-session-view'), 'session-view')
  root.setAttribute('aria-label', '当前会话')
  renderMessagesInto(make, root, input.messages)
  renderPublicResult(make, root, input.publicOutput)
  host.append(root)
  return root
}
