import {
  api,
  clearNode,
  element,
  loadRuntimeStatus,
  makePageShell,
  mountSemanticObservationPanel,
  openTechnicalDetail,
  renderPageError,
  renderRuntimeStatus,
  stateTone,
  taskIdFromQuery,
} from './runtime-shell.js'
import { mountInteractionWorkCard } from './interaction-work-card.js'
import { unavailableModeFailure } from './task-display.js'
import {
  agentActivityQuery,
  agentActivitySelectionFromQuery,
  agentSelectionReadFailure,
  renderAgentActivity,
  renderAgentActivityDetail,
} from './agent-activity.js'

// Node order, display row and agent ownership are read from the HTTP projection only. The page keeps
// no second node-order table and no keyword-based attribution: `projection.nodes[].row` comes from
// `PIPELINE_ROWS` in packages/contracts, and `projection.agentFrames` is the only ownership source.
const UNASSIGNED_ROLE = 'unknown'

const UNASSIGNED_LANE = Object.freeze({
  laneId: 'unassigned',
  label: '归属未投影',
  role: 'projection 未给出 agentId / ownerAgentRole',
})

const taskId = taskIdFromQuery()
// The agent-instance selection is URL view state decoded through the shared A3
// helpers with the canonical task id. A bad explicit deep link stays visible
// instead of being dropped to the task catalog.
const canonicalTaskId = { scope: 'task', value: taskId }
const initialAgentSelection = agentActivitySelectionFromQuery(new URLSearchParams(location.search), canonicalTaskId)
let agentSelectionFailure = initialAgentSelection.ok ? undefined : initialAgentSelection.failure
let agentQuery = initialAgentSelection.ok ? requestAgentQuery(initialAgentSelection.value) : undefined
// A late response from a departed selection or scope must not publish over the
// current one; the serial is the page's existing-style invalidation, not a new layer.
let loadSerial = 0
let agentViewDispose = null
let agentDetailDispose = null
let agentDetailLayer = null
let agentReadFailure
let agentReadPending = false
// The projection currently rendered, so a drill-down reads the same supplied field.
let lastProjection

function requestAgentQuery(selection) {
  if (!selection) return undefined
  const encoded = agentActivityQuery(new URLSearchParams(), selection)
  if (!encoded.ok) {
    agentSelectionFailure = encoded.failure
    return undefined
  }
  return encoded.value.size ? encoded.value : undefined
}

// Observation renders the node-flow layer for `current` and drives the shared
// read-only panel for the three history perspectives. The mode chooser and the
// panel buttons converge here; switching perspective never re-reads the page.
const OBSERVATION_DISPLAY_MODES = ['current', 'semantic', 'actions', 'raw']
const OBSERVATION_DISPLAY_SURFACE = {
  supportedModes: OBSERVATION_DISPLAY_MODES,
  applyMode: applyObservationDisplayMode,
}

const {
  main,
  status,
  applyDisplayMode,
  initializeDisplayPreference,
  disposeDisplayPreference,
} = makePageShell(
  'Task List',
  'Pipeline Observation',
  '任务观测',
  '从输入到任务输出的只读节点流转；节点详情只呈现工具调用、工具返回和 agent 写入的结论。',
  { displaySurface: OBSERVATION_DISPLAY_SURFACE },
)

let drawer
let drawerCard
let triggerNodeId
let returnFocusPending = false
let selectedNodeId
// The scope the page is currently showing, so a node click reloads the same scope with the node
// selected instead of re-deriving scope refs on the page.
let currentScopeRef

// Ownership frames and handoffs of the projection the page is currently rendering. They are typed
// projection facts, not page-owned tables: the page only groups and displays them.
let currentFrames = []
let currentHandoffs = []
let runtimeMode = ''
let observationDisplayMode = 'current'

// One shared panel survives flow redraws and node selection. The retained host
// element is re-attached on each render, so an EventSource is not torn down
// just because the page re-renders the rest of Observation.
let semanticObservationPanel = null
let semanticObservationHost = null

// Only `ownerAgentRole` (typed contract field) attributes a node. Anything else, including an
// unrecognised role, stays in the explicit "归属未投影" band.
function agentRoleOf(node) {
  const role = node.ownerAgentRole
  return typeof role === 'string' && role.trim().length > 0 && role !== UNASSIGNED_ROLE ? role.trim() : ''
}

function laneDefinitions(frames) {
  return frames.map((frame) => ({
    laneId: frame.agentId,
    label: frame.roleDisplay || frame.role,
    role: frame.role,
    iteration: frame.iteration,
  }))
}

function agentLaneFor(node, lanes) {
  const role = agentRoleOf(node)
  if (!role) return UNASSIGNED_LANE
  return lanes.find((lane) => lane.role === role) ?? UNASSIGNED_LANE
}

// `row` is the registry display row the projection carries. Nodes the projection leaves rowless are
// not pipeline nodes and sort after every pipeline node.
function pipelineRow(node) {
  return typeof node.row === 'number' ? node.row : Number.MAX_SAFE_INTEGER
}

// Raw LifecycleState for the scope the page is currently rendering. The layout
// `projection.nodes` entries carry only `stateDisplay`, so the typed state comes
// from this same response's `projection.scope.nodes` by exact nodeId. Rebuilt on
// every render, so cards and edges share one lookup and never a stale scope.
let currentScopeStates = new Map()

function scopeStatesOf(projection) {
  const nodes = Array.isArray(projection?.scope?.nodes) ? projection.scope.nodes : []
  return new Map(
    nodes
      .filter((node) => typeof node?.nodeId === 'string' && typeof node.state === 'string' && node.state.length > 0)
      .map((node) => [node.nodeId, node.state]),
  )
}

function nodeState(node) {
  const state = currentScopeStates.get(node.nodeId)
  return typeof state === 'string' && state.length > 0 ? state : 'unknown'
}

function unresolvedList(values, fallback) {
  const items = Array.isArray(values) ? values.filter((value) => typeof value === 'string' && value.length > 0) : []
  if (items.length === 0) return { items: [fallback], empty: true }
  return { items, empty: false }
}

function renderAgentChain(nodes, lanes) {
  const section = element('section', undefined, 'agent-chain')
  section.setAttribute('aria-label', '角色归属概览')
  const head = element('header', undefined, 'agent-chain-head')
  head.append(
    element('h2', '角色归属概览'),
    element('span', '按系统角色汇总归属节点', 'agent-chain-note'),
  )
  section.append(head)
  const strip = element('ol', undefined, 'chain-strip')
  const activeLanes = new Set(nodes.map((node) => agentLaneFor(node, lanes).laneId))
  lanes.forEach((lane) => {
    const item = element('li', undefined, 'chain-step')
    const chip = element('div', undefined, 'chain-chip')
    if (activeLanes.has(lane.laneId)) chip.dataset.active = 'true'
    const count = nodes.filter((node) => agentLaneFor(node, lanes).laneId === lane.laneId).length
    chip.append(
      element('span', lane.label, 'chain-chip-role'),
      element('small', `${count} 个节点`),
    )
    item.append(chip)
    strip.append(item)
  })
  section.append(strip)
  return section
}

function renderNodeCard(node, index) {
  const state = nodeState(node)
  const role = agentRoleOf(node)
  const card = element('button', undefined, 'flow-node')
  card.type = 'button'
  card.dataset.nodeId = node.nodeId
  card.dataset.state = state
  card.dataset.agentRole = role
  const head = element('span', undefined, 'flow-node-head')
  head.append(
    element('span', String(index + 1).padStart(2, '0'), 'flow-node-index'),
    element('strong', node.title),
  )
  const chip = element(
    'span',
    currentScopeStates.has(node.nodeId) && typeof node.stateDisplay === 'string' && node.stateDisplay.trim()
      ? node.stateDisplay
      : currentScopeStates.has(node.nodeId) ? state : '未知',
    'state-chip',
  )
  chip.dataset.tone = stateTone(state)
  head.append(chip)
  const meta = element('span', undefined, 'flow-node-meta')
  const lane = agentLaneFor(node, currentFrames)
  const owner = element('small', `归属：${node.roleDisplay || lane.label || UNASSIGNED_LANE.label}`)
  if (!role) owner.dataset.empty = 'true'
  meta.append(element('small', node.kindDisplay || node.kind || '未标注类型'), owner)
  const summary = element('span', node.summary || '尚未投影节点摘要', 'flow-node-summary')
  if (!node.summary) summary.dataset.empty = 'true'
  card.append(head, meta, summary)
  // The drawer renders from the typed node detail, which only the projection carries. A click
  // therefore selects the node and reloads; the returned `selectedNode` opens the drawer.
  card.addEventListener('click', () => {
    selectedNodeId = node.nodeId
    void load(currentScopeRef)
  })
  return card
}

function renderLane(lane, laneNodes, startIndex) {
  const section = element('section', undefined, 'agent-lane')
  section.dataset.laneId = lane.laneId
  const head = element('header', undefined, 'agent-lane-head')
  head.append(element('h3', lane.label), element('span', `${laneNodes.length} 个节点`, 'agent-lane-meta'))
  section.append(head)
  const body = element('div', undefined, 'agent-lane-body')
  if (laneNodes.length === 0) {
    const placeholder = element('p', '当前 scope 没有归属该 agent 的节点。', 'flow-empty')
    placeholder.dataset.empty = 'true'
    body.append(placeholder)
  } else {
    laneNodes.forEach((node, offset) => body.append(renderNodeCard(node, startIndex + offset)))
  }
  section.append(body)
  return section
}

function buildFlow(nodes, lanes) {
  const canvas = element('div', undefined, 'flow-canvas')

  // Sort by the row the projection carries; the projection's own order (registry order for pipeline
  // nodes, event order for provider sub-events) breaks ties. The page owns no node-order table.
  const ordered = [...nodes].sort((a, b) => pipelineRow(a) - pipelineRow(b))

  // Lane membership comes from the projection; unknown attribution stays in the explicit
  // "归属未投影" band instead of being inferred from owner/module names.
  const buckets = new Map(lanes.map((lane) => [lane.laneId, []]))
  buckets.set(UNASSIGNED_LANE.laneId, [])
  for (const node of ordered) {
    const laneId = agentLaneFor(node, lanes).laneId
    const bucket = buckets.get(laneId)
    bucket.push(node)
  }

  let index = 0
  for (const lane of [...lanes, UNASSIGNED_LANE]) {
    const laneNodes = buckets.get(lane.laneId)
    if (lane === UNASSIGNED_LANE && laneNodes.length === 0) continue
    canvas.append(renderLane(lane, laneNodes, index))
    index += laneNodes.length
  }
  return canvas
}

function buildDrawer() {
  drawer = element('dialog', undefined, 'node-drawer')
  drawer.setAttribute('aria-labelledby', 'drawer-title')
  const body = element('div', undefined, 'drawer-body')
  drawer.append(body)
  drawer.addEventListener('close', () => {
    drawerCard?.dispose()
    drawerCard = undefined
    returnFocusPending = true
    queueMicrotask(focusCurrentTrigger)
  })
  drawer.addEventListener('keydown', trapFocus)
  document.body.append(drawer)
}

// renderObservation replaces every flow node (clearNode(main)), so the node that
// opened the drawer is detached by the time the dialog fires `close`. Hold the
// trigger id instead of the element and resolve it in the CURRENT DOM.
// Breadcrumb-back and enter-scope re-render into a scope where the original id
// can be absent; those paths fall back to that scope's first node.
function currentTriggerNode() {
  const card = triggerNodeId
    ? main.querySelector(`.flow-node[data-node-id="${CSS.escape(String(triggerNodeId))}"]`)
    : null
  return card ?? main.querySelector('.flow-node')
}

// Best effort right after `close`, while the pre-navigation DOM is still
// present. Must not clear the pending flag: a scope navigation re-renders after
// this and still needs the post-render pass below.
function focusCurrentTrigger() {
  if (!returnFocusPending || drawer?.open) return
  currentTriggerNode()?.focus()
}

// Authoritative pass, scheduled by renderObservation after it rebuilds the flow
// nodes. This is what re-establishes focus once the render replaced the trigger.
function restoreFocusAfterRender() {
  if (!returnFocusPending || drawer?.open) return
  const target = currentTriggerNode()
  if (target) target.focus()
  returnFocusPending = false
}

function focusables() {
  return [...drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled)
}

function trapFocus(event) {
  if (event.key !== 'Tab') return
  const items = focusables()
  if (items.length === 0) {
    event.preventDefault()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function renderHandoffPane(node, handoffs) {
  const panel = element('section', undefined, 'drawer-pane')
  panel.append(element('h3', '跨 agent 交接'))
  // Typed contract: top-level `handoffs[]`; a node shows the handoffs whose endpoint it is.
  const touching = (Array.isArray(handoffs) ? handoffs : []).filter(
    (handoff) => handoff.fromNodeId === node.nodeId || handoff.toNodeId === node.nodeId,
  )
  if (touching.length === 0) {
    const empty = element('p', '尚未投影与该节点相关的跨 agent 交接内容。', 'flow-empty')
    empty.dataset.empty = 'true'
    panel.append(empty)
    return panel
  }
  for (const handoff of touching) {
    const block = element('article', undefined, 'handoff')
    block.dataset.handoffId = String(handoff.handoffId || '')
    block.append(element(
      'h4',
      `${handoff.fromRoleDisplay || handoff.fromAgentId || '未标注'} → ${handoff.toRoleDisplay || handoff.toAgentId || '未标注'}`,
    ))
    block.append(element('p', `${handoff.fromNodeId} → ${handoff.toNodeId}`, 'handoff-route'))
    const carried = unresolvedList([handoff.carrySummary, handoff.payloadPreview], '未投影携带内容')
    const notCarried = unresolvedList([handoff.notCarried], '未投影不回传内容')
    const facts = element('dl', undefined, 'drawer-facts')
    for (const [label, group] of [['携带', carried], ['不回传', notCarried]]) {
      const cell = element('div')
      const dd = element('dd', group.items.join('、'))
      if (group.empty) dd.dataset.empty = 'true'
      cell.append(element('dt', label), dd)
      facts.append(cell)
    }
    if (handoff.occurredAt) {
      const cell = element('div')
      cell.append(element('dt', '时间'), element('dd', handoff.occurredAt))
      facts.append(cell)
    }
    block.append(facts)
    panel.append(block)
  }
  return panel
}

function selectDrawerTab(tabs, panels, activeId) {
  for (const tab of tabs) {
    const active = tab.dataset.tabId === activeId
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
  }
  for (const panel of panels) {
    panel.hidden = panel.dataset.tabId !== activeId
  }
}

function renderDrawerSection(definition, node, handoffs, detail) {
  const section = element('section', undefined, 'drawer-section')
  section.dataset.sheetId = definition.sheetId
  section.append(element('h3', definition.label))
  section.append(definition.render(node, handoffs, detail))
  return section
}

function renderNodeDrawer(node, handoffs, detail) {
  triggerNodeId = node.nodeId
  const body = drawer.querySelector('.drawer-body')
  drawerCard?.dispose()
  drawerCard = undefined
  clearNode(body)
  const head = element('header', undefined, 'drawer-head')
  const titleWrap = element('div')
  titleWrap.append(
    element('p', '节点详情 · 只读', 'eyebrow'),
    element('h2', detail?.title || node.title || node.nodeId),
    element('p', '工具调用、工具返回和 agent 自己写入的 summary 结论；不呈现模型私有思维链。', 'drawer-note'),
  )
  const close = element('button', '关闭', 'button drawer-close')
  close.type = 'button'
  close.dataset.action = 'close-drawer'
  close.addEventListener('click', () => drawer.close())
  head.append(titleWrap, close)
  body.append(head)

  // The node drawer uses the same status/conversation/trace shell as every
  // other work card. The adapter keeps this surface read-only.
  const cardHost = element('div', undefined, 'drawer-work-card-host')
  cardHost.dataset.observationWorkCard = 'true'
  body.append(cardHost)
  drawerCard = mountInteractionWorkCard(cardHost, { mode: 'observation' })
  // Typed contract: `node.toolSteps` carries stepId / name / status / statusDisplay / returned.
  // The typed drawer detail owns those steps; the node card is only the fallback identity.
  const observationNode = detail || node
  drawerCard.update({ node: { ...observationNode, toolSteps: observationNode.toolSteps || [] }, handoffs })

  // Handoff lives on its own page inside the same sheet.
  const tabs = element('div', undefined, 'drawer-tabs')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', '节点详情页')
  const sheets = element('div', undefined, 'drawer-sheets')
  const definitions = [
    { sheetId: 'handoff', label: '跨 agent 交接', render: renderHandoffPane },
    { sheetId: 'refs', label: '输入 / 输出 / evidence', render: (_node, _handoffs, detail) => renderReferences(detail) },
  ]
  const tabButtons = []
  const tabSheets = []
  for (const definition of definitions) {
    const tab = element('button', definition.label, 'drawer-tab')
    tab.type = 'button'
    tab.dataset.tabId = definition.sheetId
    tab.setAttribute('role', 'tab')
    tab.id = `drawer-tab-${definition.sheetId}`
    tab.addEventListener('click', () => selectDrawerTab(tabButtons, tabSheets, definition.sheetId))
    const sheet = renderDrawerSection(definition, node, handoffs, detail)
    sheet.dataset.tabId = definition.sheetId
    sheet.setAttribute('role', 'tabpanel')
    sheet.setAttribute('aria-labelledby', tab.id)
    tabButtons.push(tab)
    tabSheets.push(sheet)
    tabs.append(tab)
    sheets.append(sheet)
  }
  body.append(tabs, sheets)
  selectDrawerTab(tabButtons, tabSheets, 'handoff')

  if (detail?.childScopeRef) {
    const enter = element('button', '进入下一层观测', 'button drawer-enter')
    enter.type = 'button'
    enter.addEventListener('click', () => {
      drawer.close()
      void load(detail.childScopeRef)
    })
    body.append(enter)
  }

  drawer.showModal()
  close.focus()
}

function renderReferences(node) {
  const facts = element('dl', undefined, 'drawer-facts')
  // Refs come from the typed drawer detail (`projection.selectedNode`), never from the node card.
  const inputs = unresolvedList((node?.inputs || []).map((entry) => entry.ref), '无输入引用')
  const outputs = unresolvedList((node?.outputs || []).map((entry) => entry.ref), '无输出引用')
  const evidence = unresolvedList((node?.evidenceRefs || []).map((ref) => ref.locator), '无 evidence')
  for (const [label, group] of [['输入引用', inputs], ['输出引用', outputs], ['Evidence', evidence]]) {
    const cell = element('div')
    const dd = element('dd', group.items.join(', '))
    if (group.empty) dd.dataset.empty = 'true'
    cell.append(element('dt', label), dd)
    facts.append(cell)
  }
  return facts
}

/**
 * The same shared A3 renderer and callbacks as the task dashboard. Role lanes keep
 * their projection-owned layout above; this surface adds instance entries only from
 * a supplied read, so absent producer data invents nothing and a failed read stays
 * an explicit alert.
 */
function renderAgentActivitySection(projection) {
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
  const read = projection?.agentActivity
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

// Selecting an instance is URL view state plus a re-read of the same observation
// scope. It writes no control state and opens no second scope.
async function selectAgentInstance(selection) {
  const full = agentActivityQuery(new URLSearchParams(location.search), selection)
  const request = agentActivityQuery(new URLSearchParams(), selection)
  if (!full.ok || !request.ok) {
    agentSelectionFailure = full.failure || request.failure
    await load(currentScopeRef)
    return
  }
  agentSelectionFailure = undefined
  agentQuery = request.value.size ? request.value : undefined
  closeAgentDetail()
  agentReadPending = true
  agentReadFailure = undefined
  window.history.replaceState(null, '', `${location.pathname}?${full.value}${location.hash}`)
  if (lastProjection) renderObservation(lastProjection)
  await load(currentScopeRef)
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

// No exact task-scoped deep link exists for node/commit/evidence yet, so the layer
// shows the exact typed reference and says so instead of fabricating a URL.
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

// The A3 module builds content only; the shared shell layer keeps the one overlay,
// focus, close and the single-open-layer rule.
function openAgentDetail(payload) {
  if (!payload || !payload.selection) return
  closeAgentDetail()
  if (payload.kind === 'activity') {
    const read = lastProjection?.agentActivity
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

function observationRolePairs(frames) {
  const pairs = []
  const seen = new Set()
  for (const frame of frames) {
    const raw = typeof frame.role === 'string' ? frame.role.trim() : ''
    const human = typeof frame.label === 'string' ? frame.label.trim() : ''
    if (!raw || !human || seen.has(raw)) continue
    seen.add(raw)
    pairs.push({ raw, human })
  }
  return pairs
}

function observationTechnicalDetail(projection) {
  const rolePairs = observationRolePairs(currentFrames)
  return openTechnicalDetail({
    title: '观测技术详情',
    entries: [
      ['mode', runtimeMode || '未提供'],
      ['source', projection.data?.state || '未提供'],
      ['scopeRef', projection.scope?.scopeRef || '未提供'],
      ['projectionSeq', projection.scope?.projectionSeq || '未提供'],
      ['目录说明', projection.scope?.summary || '未提供'],
      ...rolePairs.map(({ raw, human }) => [`角色 ${raw}`, `${human} / ${raw}`]),
    ],
  })
}

function renderObservation(projection) {
  if (agentViewDispose) {
    agentViewDispose()
    agentViewDispose = null
  }
  lastProjection = projection
  clearNode(main)

  currentScopeStates = scopeStatesOf(projection)
  currentFrames = laneDefinitions(Array.isArray(projection.agentFrames) ? projection.agentFrames : [])
  currentHandoffs = Array.isArray(projection.handoffs) ? projection.handoffs : []

  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  const nextStep = element(
    'p',
    typeof projection.data?.detail === 'string' && projection.data.detail.trim()
      ? `下一步：${projection.data.detail.trim()}`
      : '本次读取未提供下一步说明。',
    'lede',
  )
  nextStep.dataset.observationNextStep = 'true'
  copy.append(
    element('p', '任务观测 · 只读', 'eyebrow'),
    element('h1', projection.scope?.title || '任务处理流水'),
    nextStep,
  )
  const meta = element('div', undefined, 'observation-meta')
  if (runtimeMode === 'fake') {
    const fake = element('span', '演示模式：非真实 Provider 结果', 'state-chip')
    fake.dataset.tone = 'warning'
    meta.append(fake)
  }
  meta.append(element('span', projection.data?.label || '未投影状态', 'state-chip'))
  const technical = element('button', '技术详情', 'button button--quiet')
  technical.type = 'button'
  technical.dataset.observationTechnicalTrigger = 'true'
  technical.addEventListener('click', () => observationTechnicalDetail(projection))
  meta.append(technical)
  heading.append(copy, meta)
  main.append(heading)

  const breadcrumbs = element('nav', undefined, 'breadcrumbs')
  breadcrumbs.setAttribute('aria-label', '当前观测路径')
  const crumbs = projection.scope?.breadcrumbs || []
  const rootScopeRef = crumbs[0]?.ref
  crumbs.forEach((crumb, index) => {
    const button = element('button', crumb.title, 'segment')
    button.type = 'button'
    button.addEventListener('click', () => {
      void load(crumb.ref === rootScopeRef ? undefined : crumb.ref)
    })
    breadcrumbs.append(button)
  })
  main.append(breadcrumbs)

  main.append(renderAgentChain(projection.nodes, currentFrames))

  const agentSection = renderAgentActivitySection(projection)
  if (agentSection) main.append(agentSection)

  main.append(renderSemanticObservationSection())

  const flowSection = element('section', undefined, 'flow-section')
  const flowHead = element('header', undefined, 'section-head')
  flowHead.append(
    element('h2', '系统节点目录'),
    element('span', `${projection.nodes.length} 个系统节点`, 'section-meta'),
  )
  flowSection.append(flowHead)
  const catalogueNote = element('p', '系统注册表节点目录；这些节点按所属角色分组，不代表任务执行依赖顺序。', 'section-note')
  catalogueNote.dataset.catalogueSummary = 'true'
  flowSection.append(catalogueNote)

  if (projection.nodes.length === 0) {
    const empty = element('p', '当前 scope 没有节点。', 'flow-empty')
    empty.dataset.empty = 'true'
    flowSection.append(empty)
    main.append(flowSection)
    return
  }

  const canvas = buildFlow(projection.nodes, currentFrames)
  flowSection.append(canvas)
  main.append(flowSection)
  requestAnimationFrame(restoreFocusAfterRender)

  // The typed detail of the selected node opens the read-only drawer; `selectedNodeId` is cleared so
  // the drawer opens once per selection and breadcrumb navigation starts from a clean state.
  const selected = projection.selectedNode
  if (selected && selectedNodeId === selected.nodeId) {
    selectedNodeId = undefined
    renderNodeDrawer(
      projection.nodes.find((node) => node.nodeId === selected.nodeId) || { nodeId: selected.nodeId, title: selected.title },
      currentHandoffs,
      selected,
    )
  }
}

function renderSemanticObservationSection() {
  if (!semanticObservationPanel) {
    semanticObservationHost = element('div', undefined, 'semantic-observation-host')
    semanticObservationHost.dataset.semanticObservationHost = taskId ? 'task' : 'missing'
    if (taskId) {
      semanticObservationPanel = mountSemanticObservationPanel(semanticObservationHost, {
        taskId,
        // The panel's own four buttons reuse the shell programmatic transition,
        // so a local click cannot write the follow-last preference. The corner
        // buttons keep the original manual controller path.
        onModeChange: (mode) => {
          if (mode === observationDisplayMode) return
          void applyDisplayMode(mode)
        },
      })
    } else {
      semanticObservationHost.append(element('p', '当前 URL 没有 task 参数，无法读取语义观测。', 'empty'))
    }
  }
  const section = element('section', undefined, 'section semantic-observation-section')
  section.dataset.semanticObservation = semanticObservationPanel ? 'mounted' : 'unavailable'
  section.append(semanticObservationHost)
  return section
}

async function load(scopeRef) {
  const serial = ++loadSerial
  try {
    const projection = await api.observation(taskId, scopeRef, selectedNodeId, agentQuery)
    if (serial !== loadSerial) return
    currentScopeRef = scopeRef
    agentReadPending = false
    agentReadFailure = undefined
    renderObservation(projection)
  } catch (error) {
    if (serial !== loadSerial) return
    agentReadPending = false
    if (agentQuery) {
      agentReadFailure = error
      if (lastProjection) renderObservation(lastProjection)
    }
    renderPageError(status, error)
  }
}

async function applyObservationDisplayMode({ mode }) {
  if (!OBSERVATION_DISPLAY_MODES.includes(mode)) {
    return { ok: false, failure: unavailableModeFailure(mode, '任务观测支持 current、semantic、actions 和 raw。') }
  }
  if (semanticObservationPanel) {
    // Pure perspective switch: the panel keeps its live instance and range, and
    // the page re-presents the projection it already holds.
    observationDisplayMode = mode
    semanticObservationPanel.setMode(mode)
    if (lastProjection) renderObservation(lastProjection)
    return { ok: true, mode }
  }
  if (mode === 'current' && lastProjection) {
    observationDisplayMode = mode
    renderObservation(lastProjection)
    return { ok: true, mode }
  }
  return {
    ok: false,
    failure: {
      code: 'observation.panel-unavailable',
      ownerId: 'humanagent.ui',
      message: '共享语义观测面板尚未挂载。',
      nextAction: '重新打开这个任务观测。',
    },
  }
}

buildDrawer()
void (async () => {
  const { status: runtimeStatus, error } = await loadRuntimeStatus()
  runtimeMode = runtimeStatus?.mode || ''
  renderRuntimeStatus(status, runtimeStatus, error)
  await load()
  // The controller starts after this page's first read settled, so applying
  // the resolved default cannot outrun the node-flow it needs to render.
  await initializeDisplayPreference()
})()

window.addEventListener('pagehide', () => {
  semanticObservationPanel?.dispose()
  semanticObservationPanel = null
  semanticObservationHost = null
  disposeDisplayPreference()
})
