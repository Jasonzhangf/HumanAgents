/**
 * Shared read-only semantic observation component.
 *
 * Contract:
 * - `mountSemanticObservation(host, options)` receives only the concrete,
 *   presentation-ready projection produced by the UI projection owner. The
 *   component does not decode transport, inspect raw event fields to infer
 *   semantics, or own journal/runtime state.
 * - The component is controlled by `update({ mode, modes, scope, ...view })`.
 *   Clicking a mode or scope control emits a callback; it does not mutate a
 *   task, consume a queue, retry an operation, or steer an execution.
 * - `current`, `semantic`, `actions`, and `raw` remain separate presentation
 *   sections. Stale, unknown, unavailable, empty, and failure states are
 *   rendered from explicit projection fields.
 *
 * @typedef {Object} SemanticObservationCrumbs
 * @property {string} scopeRef
 * @property {string} title
 * @property {boolean} [current]
 *
 * @typedef {Object} SemanticObservationItem
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
 * @typedef {Object} SemanticObservationSection
 * @property {string} id
 * @property {string} title
 * @property {'stable'|'live'|'semantic'|'action'|'raw'|'capability'|string} [kind]
 * @property {string} [description]
 * @property {readonly SemanticObservationItem[]} items
 *
 * @typedef {Object} SemanticObservationNotice
 * @property {'info'|'stale'|'unknown'|'unavailable'|'error'|'empty'|'loading'|string} tone
 * @property {string} title
 * @property {string} [detail]
 * @property {string} [nextAction]
 *
 * @typedef {Object} SemanticObservationCapability
 * @property {string} capability
 * @property {'available'|'unavailable'|'unknown'|string} state
 * @property {string} [reason]
 *
 * @typedef {Object} SemanticObservationProjection
 * @property {string} mode
 * @property {readonly { id: string, label: string, available?: boolean, reason?: string }[]} modes
 * @property {{ scopeRef?: string, title?: string, summary?: string, breadcrumbs?: readonly SemanticObservationCrumbs[] }} [scope]
 * @property {string} [state]
 * @property {string} [stateLabel]
 * @property {string} [projectionVersion]
 * @property {readonly { label: string, value: string, tone?: string }[]} [summary]
 * @property {readonly SemanticObservationNotice[]} [notices]
 * @property {readonly SemanticObservationCapability[]} [capabilities]
 * @property {readonly SemanticObservationSection[]} [sections]
 * @property {Object} [evidence]
 */

export const SEMANTIC_OBSERVATION_CONTRACT_VERSION = 'semantic-observation-view@1'

const INSTANCE_IDS = new WeakMap()
let nextInstanceId = 1

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}

function clear(node) {
  node.replaceChildren()
}

function text(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function normaliseScope(scope, fallbackRef) {
  const source = scope && typeof scope === 'object' ? scope : {}
  const breadcrumbs = array(source.breadcrumbs).map((crumb) => ({
    scopeRef: text(crumb?.scopeRef),
    title: text(crumb?.title, '未命名范围'),
    current: Boolean(crumb?.current),
  }))
  return {
    scopeRef: text(source.scopeRef, fallbackRef),
    title: text(source.title, '当前观测范围'),
    summary: text(source.summary),
    breadcrumbs,
  }
}

function noticeTone(notice) {
  return text(notice?.tone, 'info')
}

function renderNotice(notice) {
  const tone = noticeTone(notice)
  const node = element('div', 'so-notice')
  node.dataset.noticeKind = tone
  if (tone === 'error') node.setAttribute('role', 'alert')
  node.append(
    element('strong', undefined, text(notice?.title, '观测状态未投影')),
  )
  if (notice?.detail) node.append(element('p', undefined, text(notice.detail)))
  if (notice?.nextAction) node.append(element('p', 'so-next-action', `下一步：${text(notice.nextAction)}`))
  return node
}

function renderScope(scope, onScopeRequest) {
  const header = element('header', 'so-head')
  const copy = element('div', 'so-head-copy')
  copy.append(
    element('p', 'so-kicker', '只读语义观测'),
    element('h2', undefined, scope.title),
  )
  if (scope.summary) copy.append(element('p', 'so-summary', scope.summary))
  header.append(copy)

  const crumbNav = element('nav', 'so-breadcrumbs')
  crumbNav.setAttribute('aria-label', '语义观测范围')
  if (scope.breadcrumbs.length === 0) {
    const current = element('span', 'so-crumb', scope.title)
    current.setAttribute('aria-current', 'page')
    current.tabIndex = -1
    current.dataset.scopeRef = scope.scopeRef
    crumbNav.append(current)
  } else {
    // The projection owns which scope is current. Only when it names no explicit
    // current crumb does the deepest crumb act as the default, so drilling up
    // leaves exactly one `aria-current` and keeps the deeper crumbs clickable.
    const hasExplicitCurrent = scope.breadcrumbs.some((crumb) => crumb.current)
    scope.breadcrumbs.forEach((crumb, index) => {
      const isCurrent = hasExplicitCurrent ? crumb.current : index === scope.breadcrumbs.length - 1
      if (isCurrent) {
        const current = element('span', 'so-crumb', crumb.title)
        current.setAttribute('aria-current', 'page')
        current.tabIndex = -1
        current.dataset.scopeRef = crumb.scopeRef
        crumbNav.append(current)
        return
      }
      const button = element('button', 'so-crumb', crumb.title)
      button.type = 'button'
      button.dataset.scopeRef = crumb.scopeRef
      button.addEventListener('click', () => onScopeRequest?.(crumb.scopeRef, button))
      crumbNav.append(button)
    })
  }
  header.append(crumbNav)
  return header
}

function renderModes(modes, activeMode, onModeChange) {
  const bar = element('div', 'so-modebar')
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', '展示方式')
  array(modes).forEach((mode) => {
    const id = text(mode?.id)
    if (!id) return
    const available = mode?.available !== false
    const button = element('button', 'so-mode', text(mode?.label, id))
    button.type = 'button'
    button.dataset.semanticMode = id
    button.setAttribute('aria-pressed', String(id === activeMode))
    if (!available) {
      button.disabled = true
      button.title = text(mode?.reason, '该展示方式当前不可用')
    }
    button.addEventListener('click', () => {
      if (available) onModeChange?.(id, button)
    })
    bar.append(button)
  })
  return bar
}

function renderSummary(summary) {
  const list = element('dl', 'so-summary-list')
  array(summary).forEach((entry) => {
    const cell = element('div', 'so-summary-cell')
    if (entry?.tone) cell.dataset.tone = text(entry.tone)
    cell.append(
      element('dt', undefined, text(entry?.label, '状态')),
      element('dd', undefined, text(entry?.value, '未投影')),
    )
    list.append(cell)
  })
  return list
}

function renderCapabilities(capabilities) {
  if (array(capabilities).length === 0) return null
  const section = element('section', 'so-capabilities')
  section.dataset.sectionKind = 'capability'
  section.append(element('h3', undefined, '能力状态'))
  const list = element('ul', 'so-capability-list')
  array(capabilities).forEach((capability) => {
    const state = text(capability?.state, 'unknown')
    const item = element('li', 'so-capability')
    item.dataset.capabilityState = state
    item.append(
      element('span', 'so-capability-name', text(capability?.capability, '未命名能力')),
      element('span', 'so-capability-state', `${state}${capability?.reason ? ` · ${capability.reason}` : ''}`),
    )
    list.append(item)
  })
  section.append(list)
  return section
}

function renderEvidenceButton(evidence, onEvidenceRequest) {
  if (!evidence || typeof evidence !== 'object') return null
  const button = element('button', 'so-evidence', '查看只读证据')
  button.type = 'button'
  button.dataset.evidenceId = text(evidence.id || evidence.evidenceId)
  button.addEventListener('click', () => onEvidenceRequest?.(evidence, button))
  return button
}

function renderItem(item, onEvidenceRequest) {
  const article = element('article', 'so-item')
  article.dataset.itemId = text(item?.id)
  article.dataset.itemKind = text(item?.kind, 'semantic')
  if (item?.tone) article.dataset.tone = text(item.tone)
  if (item?.state) article.dataset.state = text(item.state)

  const head = element('header', 'so-item-head')
  head.append(element('h4', undefined, text(item?.title, '未命名条目')))
  if (item?.stateLabel) {
    const chip = element('span', 'state-chip', text(item.stateLabel))
    if (item?.tone) chip.dataset.tone = text(item.tone)
    head.append(chip)
  }
  article.append(head)

  if (item?.detail) article.append(element('p', 'so-item-detail', text(item.detail)))
  const meta = array(item?.meta).filter((value) => text(value).length > 0)
  if (meta.length > 0) {
    const metaRow = element('p', 'so-item-meta')
    metaRow.append(...meta.map((value) => element('span', undefined, text(value))))
    article.append(metaRow)
  }
  const evidence = renderEvidenceButton(item?.evidence, onEvidenceRequest)
  if (evidence) article.append(evidence)
  return article
}

function renderSection(section, onEvidenceRequest) {
  const kind = text(section?.kind, 'semantic')
  const node = element('section', 'so-section')
  node.dataset.sectionId = text(section?.id)
  node.dataset.sectionKind = kind

  const head = element('header', 'so-section-head')
  const copy = element('div')
  copy.append(
    element('h3', undefined, text(section?.title, '观测内容')),
  )
  if (section?.description) copy.append(element('p', 'so-section-description', text(section.description)))
  head.append(copy)
  const count = array(section?.items).length
  head.append(element('span', 'so-section-count', `${count} 项`))
  node.append(head)

  if (count === 0) {
    const empty = element('p', 'so-empty', '当前范围没有已投影内容。')
    empty.dataset.empty = 'true'
    node.append(empty)
    return node
  }
  const list = element('div', 'so-item-list')
  array(section.items).forEach((item) => list.append(renderItem(item, onEvidenceRequest)))
  node.append(list)
  return node
}

function renderEvidenceDrawer(dialog, evidence) {
  const body = dialog.querySelector('.so-drawer-body')
  clear(body)
  const head = element('header', 'so-drawer-head')
  const copy = element('div')
  copy.append(
    element('p', 'so-kicker', '只读证据'),
    element('h2', undefined, text(evidence?.title, '证据详情')),
  )
  if (evidence?.summary) copy.append(element('p', 'so-drawer-summary', text(evidence.summary)))
  const close = element('button', 'button so-drawer-close', '关闭')
  close.type = 'button'
  close.addEventListener('click', () => dialog.close())
  head.append(copy, close)
  body.append(head)

  const facts = element('dl', 'so-fact-list')
  const rows = [
    ['证据 ID', evidence?.evidenceId || evidence?.id],
    ['范围', evidence?.scopeLabel],
    ['来源', evidence?.sourceLabel],
  ]
  rows.forEach(([label, value]) => {
    if (!value) return
    const row = element('div')
    row.append(element('dt', undefined, label), element('dd', undefined, text(value)))
    facts.append(row)
  })
  if (facts.childElementCount > 0) body.append(facts)

  for (const [title, entries] of [
    ['输入', array(evidence?.inputs)],
    ['输出', array(evidence?.outputs)],
    ['引用', array(evidence?.refs)],
  ]) {
    if (entries.length === 0) continue
    const section = element('section', 'so-drawer-section')
    section.append(element('h3', undefined, title))
    const list = element('ul', 'so-ref-list')
    entries.forEach((entry) => {
      const label = typeof entry === 'string' ? entry : text(entry?.label || entry?.ref || entry?.value)
      if (label) list.append(element('li', undefined, label))
    })
    section.append(list)
    body.append(section)
  }

  if (evidence?.raw) {
    const raw = element('section', 'so-drawer-section')
    raw.dataset.raw = 'true'
    raw.append(element('h3', undefined, text(evidence.raw.label, '原始记录')))
    raw.append(element('pre', 'so-raw', text(evidence.raw.content)))
    body.append(raw)
  }
}

/**
 * Mount the shared observation component.
 *
 * @param {HTMLElement} host
 * @param {{
 *   onModeChange?: (mode: string, trigger: HTMLButtonElement) => void,
 *   onScopeRequest?: (scopeRef: string, trigger: HTMLButtonElement) => void,
 *   onEvidenceRequest?: (evidence: Object, trigger: HTMLButtonElement) => void
 * }} [options]
 * @returns {{
 *   update: (projection: SemanticObservationProjection) => void,
 *   openEvidence: (evidence: Object, trigger?: HTMLElement) => void,
 *   closeEvidence: () => void,
 *   dispose: () => void
 * }}
 */
export function mountSemanticObservation(host, options = {}) {
  if (!(host instanceof HTMLElement)) {
    throw new TypeError('mountSemanticObservation requires an HTMLElement host')
  }

  const instanceId = INSTANCE_IDS.get(host) || nextInstanceId++
  INSTANCE_IDS.set(host, instanceId)
  const titleId = `so-title-${instanceId}`
  const dialogTitleId = `so-evidence-title-${instanceId}`
  const root = element('section', 'semantic-observation')
  root.dataset.contractVersion = SEMANTIC_OBSERVATION_CONTRACT_VERSION
  const content = element('div', 'so-content')
  const dialog = element('dialog', 'so-drawer')
  dialog.setAttribute('aria-labelledby', dialogTitleId)
  const dialogBody = element('div', 'so-drawer-body')
  dialog.append(dialogBody)
  root.append(content, dialog)
  host.replaceChildren(root)

  let latest = null
  let returnFocus = null

  // The consumer re-renders synchronously after a scope request. Move focus to
  // the newly current crumb instead of leaving it on the removed button.
  function requestScope(scopeRef, trigger) {
    options.onScopeRequest?.(scopeRef, trigger)
    const current = content.querySelector('.so-crumb[aria-current="page"]')
    if (current instanceof HTMLElement) current.focus()
  }

  dialog.addEventListener('close', () => {
    const target = returnFocus
    returnFocus = null
    if (target?.isConnected) queueMicrotask(() => target.focus())
  })

  function render() {
    clear(content)
    const projection = latest && typeof latest === 'object' ? latest : {}
    const mode = text(projection.mode, 'current')
    const scope = normaliseScope(projection.scope, text(projection.scopeRef))
    const viewState = text(projection.state, 'unknown')

    root.dataset.mode = mode
    root.dataset.state = viewState
    content.append(renderScope(scope, requestScope))
    content.append(renderModes(projection.modes, mode, options.onModeChange))

    const notices = array(projection.notices).map(renderNotice)
    if (notices.length > 0) {
      const noticeRegion = element('div', 'so-notices')
      noticeRegion.setAttribute('aria-live', 'polite')
      noticeRegion.append(...notices)
      content.append(noticeRegion)
    }

    const status = element('div', 'so-state')
    const stateLabel = text(projection.stateLabel, viewState)
    status.append(
      element('span', 'so-state-label', `状态：${stateLabel}`),
      element('span', 'so-projection-version', `投影 ${text(projection.projectionVersion, '未标注')}`),
    )
    if (projection.summary) status.append(renderSummary(projection.summary))
    content.append(status)

    const capabilities = renderCapabilities(projection.capabilities)
    if (capabilities) content.append(capabilities)

    const sections = array(projection.sections)
    if (viewState === 'empty' || sections.length === 0) {
      const empty = element('div', 'so-empty-state')
      empty.dataset.empty = 'true'
      empty.append(
        element('h3', undefined, '没有可展示的观测内容'),
        element('p', undefined, text(projection.emptyMessage, '当前范围没有已发布语义内容。')),
      )
      content.append(empty)
      return
    }
    sections.forEach((section) => content.append(renderSection(section, options.onEvidenceRequest)))
  }

  return {
    update(projection) {
      latest = projection
      render()
    },
    openEvidence(evidence, trigger) {
      returnFocus = trigger instanceof HTMLElement ? trigger : null
      renderEvidenceDrawer(dialog, evidence)
      if (!dialog.open) dialog.showModal()
      dialog.querySelector('.so-drawer-close')?.focus()
    },
    closeEvidence() {
      if (dialog.open) dialog.close()
    },
    dispose() {
      if (dialog.open) dialog.close()
      host.replaceChildren()
      INSTANCE_IDS.delete(host)
    },
  }
}
