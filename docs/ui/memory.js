import { RuntimeApiError } from './runtime-api.js'
import {
  api,
  appendPairingEntry,
  clearNode,
  element as defaultElement,
  loadRuntimeStatus,
  mountPageTemplate,
  projectReadScopeFromQuery,
  renderRuntimeStatus,
  stateTone,
} from './runtime-shell.js'
import { bindMemoryReviewAction } from './memory-actions.js'
import { renderProductBoardSection } from './product-board-view.js'

export const MEMORY_SESSION_TITLE = '记忆 agent session'
export const MEMORY_SESSION_SOURCE_UNAVAILABLE = 'session 来源不可用'
export const MEMORY_CANDIDATES_TITLE = '候选（非 session）'

const CANDIDATE_STATE_LABELS = Object.freeze({
  candidate: '待审核',
  approved: '已接受',
  active: '已启用',
  superseded: '已被替代',
  expired: '已过期',
  archived: '已归档',
  rejected: '已拒绝',
  deferred: '已延期',
})

function makeFactory(options) {
  return typeof options?.element === 'function' ? options.element : defaultElement
}

function openDetailFactory(options) {
  return typeof options?.openDetail === 'function' ? options.openDetail : () => {}
}

function taskIdValue(taskId) {
  if (taskId && typeof taskId === 'object') return taskId.value
  return taskId
}

function failureCopy(failure) {
  return {
    code: failure?.code ?? 'memory.read.failed',
    ownerId: failure?.ownerId ?? 'humanagent.app',
    message: failure?.message ?? '读取失败。',
    nextAction: failure?.nextAction ?? 'retry the read',
  }
}

function failureEntries(failure, prefix) {
  const copy = failureCopy(failure)
  return [
    [`${prefix}.code`, copy.code],
    [`${prefix}.ownerId`, copy.ownerId],
    [`${prefix}.message`, copy.message],
    [`${prefix}.nextAction`, copy.nextAction],
  ]
}

function detailButton(make, label, detail, openDetail) {
  const button = make('button', label, 'button button--quiet')
  button.type = 'button'
  button.dataset.memoryTechnicalDetail = ''
  button.addEventListener('click', () => openDetail(detail, button))
  return button
}

function appendReadFailure(root, failure, make, openDetail, label = '技术详情') {
  const copy = failureCopy(failure)
  root.append(
    make('p', `读取失败：${copy.message}`, 'panel muted'),
    make('p', `恢复：${copy.nextAction}`, 'muted'),
    detailButton(make, label, {
      title: '记忆读取技术详情',
      eyebrow: '只读证据',
      entries: failureEntries(failure, 'failure'),
    }, openDetail),
  )
}

function candidateStateText(state) {
  return CANDIDATE_STATE_LABELS[state] ?? String(state ?? '未知')
}

function candidateScopeText(candidate) {
  const parts = [`记忆库：${candidate.namespace ?? '未知'}`]
  if (candidate.projectKey) parts.push(`项目：${candidate.projectKey}`)
  const taskId = taskIdValue(candidate.taskId)
  if (taskId) parts.push(`任务：${taskId}`)
  return parts.join(' · ')
}

async function settle(read) {
  try {
    return { ok: true, value: await read() }
  } catch (failure) {
    return { ok: false, failure }
  }
}

/**
 * Read the memory board source and the candidate review source independently.
 * A failed read stays a typed failure; it never becomes an empty result.
 */
export async function readMemorySurface({ readBoard, readSummary, scope } = {}) {
  if (typeof readBoard !== 'function') throw new TypeError('readMemorySurface requires readBoard')
  if (typeof readSummary !== 'function') throw new TypeError('readMemorySurface requires readSummary')
  const [board, summary] = await Promise.all([
    settle(() => readBoard(scope)),
    settle(() => readSummary({ namespace: 'project', limit: 20 })),
  ])
  return { board, summary }
}

export function memoryBoardSection(boardIndex) {
  const boards = Array.isArray(boardIndex?.boards) ? boardIndex.boards : []
  return boards.find((section) => section.board === 'memory') ?? null
}

/**
 * Render the memory-agent session area from the product board read. The board
 * has no declared memory session reader yet, so the normal result is an
 * explicit source-unavailable failure, not three empty lanes.
 */
export function renderMemorySessions(host, boardRead, options = {}) {
  const make = makeFactory(options)
  const openDetail = openDetailFactory(options)
  const section = boardRead?.ok === true ? memoryBoardSection(boardRead.value) : null
  const items = section === null
    ? []
    : [...(section.live ?? []), ...(section.history ?? []), ...(section.unknown ?? [])]

  if (section !== null && items.length > 0) {
    const root = renderProductBoardSection(null, section, {
      element: make,
      ...(typeof options.onSelect === 'function' ? { onSelect: options.onSelect } : {}),
    })
    root.dataset.memorySection = 'sessions'
    root.setAttribute('data-memory-section', 'sessions')
    if (host !== undefined && host !== null) host.append(root)
    return root
  }

  const root = make('section', undefined, 'section')
  root.dataset.memorySection = 'sessions'
  root.setAttribute('data-memory-section', 'sessions')
  root.append(make('h2', MEMORY_SESSION_TITLE))

  if (boardRead?.ok !== true) {
    root.append(make('p', MEMORY_SESSION_SOURCE_UNAVAILABLE, 'panel muted'))
    appendReadFailure(root, boardRead?.failure, make, openDetail, 'session 来源详情')
    if (host !== undefined && host !== null) host.append(root)
    return root
  }

  const failures = Array.isArray(section?.failures) && section.failures.length > 0
    ? section.failures
    : [{
        code: 'memory.session-source-unavailable',
        ownerId: 'humanagent.app.ui-runtime.product-session-read',
        message: 'board 没有提供记忆 session 事实；记忆候选不是 session。',
        nextAction: '确认记忆 session 读取 owner 后重新读取记忆板块。',
      }]

  root.append(make('p', MEMORY_SESSION_SOURCE_UNAVAILABLE, 'panel muted'))
  for (const failure of failures) {
    const copy = failureCopy(failure)
    root.append(
      make('p', copy.message, 'muted'),
      make('p', `恢复：${copy.nextAction}`, 'muted'),
    )
  }
  root.append(detailButton(make, 'session 来源详情', {
    title: '记忆 session 来源详情',
    eyebrow: '只读证据',
    entries: failures.flatMap((failure, index) => failureEntries(failure, `failures[${index}]`)),
  }, openDetail))

  if (host !== undefined && host !== null) host.append(root)
  return root
}

function candidateCard(candidate, make, options) {
  const openDetail = openDetailFactory(options)
  const card = make('article', undefined, 'panel')
  card.setAttribute('data-memory-candidate', candidate.candidateId ?? 'unknown')
  card.setAttribute('data-memory-candidate-kind', 'candidate')
  card.append(
    make('h3', candidate.proposedRule || '未命名候选'),
    make('p', `状态：${candidateStateText(candidate.state)}`),
    make('p', candidateScopeText(candidate)),
  )

  if (candidate.state === 'candidate' && typeof options.review === 'function') {
    const actions = make('div', undefined, 'actions')
    for (const [decision, label] of [['approve', '接受'], ['reject', '拒绝'], ['defer', '延期']]) {
      const button = make('button', label, `button${decision === 'approve' ? ' button--primary' : ''}`)
      button.type = 'button'
      bindMemoryReviewAction({
        button,
        candidateId: candidate.candidateId,
        decision,
        readReason: options.readReason ?? (() => ''),
        review: options.review,
        refresh: options.refresh ?? (async () => {}),
        showError: options.showError ?? (() => {}),
      })
      actions.append(button)
    }
    card.append(actions)
  }

  const sourceRefs = Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs : []
  const sourceDigests = Array.isArray(candidate.sourceDigests) ? candidate.sourceDigests : []
  card.append(detailButton(make, '候选技术详情', {
    title: '候选技术详情',
    eyebrow: '只读证据',
    entries: [
      ['candidateId', candidate.candidateId],
      ['state', candidate.state],
      ['namespace', candidate.namespace],
      ['projectKey', candidate.projectKey],
      ['taskId', taskIdValue(candidate.taskId) ?? ''],
      ...sourceRefs.map((sourceRef, index) => [
        `sourceRefs[${index}]`,
        sourceRef,
        'data-memory-source-ref',
      ]),
      ...sourceDigests.map((digest, index) => [
        `sourceDigests[${index}]`,
        digest,
        'data-memory-source-digest',
      ]),
    ],
  }, openDetail))
  return card
}

/**
 * Render the review candidates as their own layer. They carry review state,
 * namespace, reason and failure, but no product target or session lane.
 */
export function renderMemoryCandidates(host, summaryRead, options = {}) {
  const make = makeFactory(options)
  const openDetail = openDetailFactory(options)
  const root = make('section', undefined, 'section')
  root.dataset.memorySection = 'candidates'
  root.setAttribute('data-memory-section', 'candidates')
  root.append(make('h2', MEMORY_CANDIDATES_TITLE))

  if (summaryRead?.ok !== true) {
    appendReadFailure(root, summaryRead?.failure, make, openDetail)
    if (host !== undefined && host !== null) host.append(root)
    return root
  }

  const candidates = Array.isArray(summaryRead.value?.skillCandidates)
    ? summaryRead.value.skillCandidates
    : []
  if (candidates.length === 0) {
    root.append(make('p', '当前没有待审核候选。', 'panel empty'))
  }
  for (const candidate of candidates) root.append(candidateCard(candidate, make, options))

  if (host !== undefined && host !== null) host.append(root)
  return root
}

/**
 * The compact curation status. Mode, update switch and refs stay in the
 * on-demand detail; the main layer keeps one state and one human sentence.
 */
export function renderMemoryAnalysis(host, summaryRead, options = {}) {
  const make = makeFactory(options)
  const openDetail = openDetailFactory(options)
  const root = make('section', undefined, 'section')
  root.dataset.memorySection = 'analysis'
  root.setAttribute('data-memory-section', 'analysis')
  root.append(make('h2', '整理状态'))

  if (summaryRead?.ok !== true) {
    appendReadFailure(root, summaryRead?.failure, make, openDetail)
    if (host !== undefined && host !== null) host.append(root)
    return root
  }

  const view = summaryRead.value ?? {}
  const analysis = view.analysis ?? { mode: 'unknown', state: 'unknown' }
  const panel = make('div', undefined, 'panel')
  const chip = make('span', analysis.state ?? 'unknown', 'state-chip')
  chip.dataset.tone = stateTone(analysis.state)
  panel.append(
    chip,
    make('p', analysis.failureRef
      ? '上次整理有失败记录，可打开技术详情核对。'
      : analysis.operationRef
        ? '已有记忆整理操作记录，可打开技术详情核对。'
        : '尚无记忆整理 operation。', 'muted'),
    detailButton(make, '整理技术详情', {
      title: '记忆整理技术详情',
      eyebrow: '只读证据',
      entries: [
        ['analysis.state', analysis.state],
        ['analysis.mode', analysis.mode],
        ['autoUpdate', String(view.autoUpdate)],
        ['analysis.operationRef', analysis.operationRef ?? ''],
        ['analysis.failureRef', analysis.failureRef ?? ''],
      ],
    }, openDetail),
  )
  root.append(panel)
  if (host !== undefined && host !== null) host.append(root)
  return root
}

/**
 * The reason field stays mandatory for every formal review. It is created once
 * and re-attached on refresh, so an in-progress reason is not lost.
 */
export function createMemoryReviewReason(host, options = {}) {
  const make = makeFactory(options)
  const field = make('label', '审核理由')
  const input = make('textarea')
  input.dataset.memoryReviewReason = ''
  input.placeholder = '写明审核理由'
  input.setAttribute('aria-label', '审核理由')
  field.append(input)
  const section = make('section', undefined, 'section')
  section.dataset.memorySupport = 'review-reason'
  section.append(
    make('h2', '审核理由'),
    make('p', '接受、拒绝或延期前，请写明理由。理由会随这次决定提交。', 'muted'),
    field,
  )

  function readReason() {
    const reason = String(input.value ?? '').trim()
    if (!reason && typeof input.focus === 'function') input.focus()
    return reason
  }

  if (host !== undefined && host !== null) host.append(section)
  return { section, input, readReason }
}

/**
 * The product board route is not exported by runtime-api.js yet. Keep the
 * exact `readProductBoard(scope)` call site local and read-only until H2's
 * named export lands; the page consumer injects its own reader.
 */
export async function readProductBoard(scope) {
  const params = new URLSearchParams()
  if (scope?.kind === 'project') {
    params.set('projectKey', scope.projectKey)
  } else if (scope?.kind === 'task') {
    params.set('projectKey', scope.projectKey)
    params.set('mode', scope.mode)
    params.set('taskId', String(taskIdValue(scope.taskId)))
  } else {
    params.set('scope', 'system')
  }
  const response = await fetch(`/api/product/board?${params}`, { method: 'GET' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new RuntimeApiError(body.error ? { ...body, ...body.error } : body, response.status)
  }
  return body
}

function mountMemoryPage(root) {
  const template = mountPageTemplate(root, {
    layout: 'collection',
    active: 'Memory',
    eyebrow: 'Memory Agent',
    title: '记忆与候选审核',
    lede: '查看记忆 agent session 与候选审核；接受、拒绝或延期都由你明确决定。',
  })
  const { primary, support, status } = template.hosts
  const reason = createMemoryReviewReason()
  const scope = projectReadScopeFromQuery()
  let disposed = false

  function showReviewError(error) {
    status.dataset.tone = 'danger'
    clearNode(status)
    status.append(
      defaultElement('strong', error.code),
      defaultElement('span', ` · ${error.message} · owner=${error.ownerId} · next=${error.nextAction}`),
    )
    appendPairingEntry(status, error)
  }

  async function refresh() {
    const [runtime, surface] = await Promise.all([
      loadRuntimeStatus(),
      readMemorySurface({ readBoard: readProductBoard, readSummary: api.memorySummary, scope }),
    ])
    if (disposed) return

    renderRuntimeStatus(status, runtime.status, runtime.error)
    clearNode(primary)
    clearNode(support)

    renderMemorySessions(primary, surface.board, { openDetail: template.detail.open })
    renderMemoryAnalysis(primary, surface.summary, { openDetail: template.detail.open })
    renderMemoryCandidates(primary, surface.summary, {
      openDetail: template.detail.open,
      readReason: reason.readReason,
      review: api.reviewMemoryCandidate,
      refresh: refreshAfterReview,
      showError: showReviewError,
    })

    const candidates = surface.summary.ok && Array.isArray(surface.summary.value?.skillCandidates)
      ? surface.summary.value.skillCandidates
      : []
    if (candidates.some((candidate) => candidate.state === 'candidate')) {
      support.append(reason.section)
    }
  }

  async function refreshAfterReview() {
    await refresh()
    reason.input.value = ''
  }

  window.addEventListener('pagehide', (event) => {
    if (event?.persisted) return
    disposed = true
    template.dispose()
  })

  void refresh()
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('page-root')
  if (root) mountMemoryPage(root)
}
