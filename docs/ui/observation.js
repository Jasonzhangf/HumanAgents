import {
  api,
  clearNode,
  element,
  loadRuntimeStatus,
  mountPageTemplate,
  mountSemanticObservationPanel,
  openTechnicalDetail,
  renderPageError,
  renderRuntimeStatus,
  stateTone,
  taskIdFromQuery,
  taskReadScopeFromQuery,
} from './runtime-shell.js'
import { renderSemanticEvidenceContent } from './semantic-observation.js'
import { mountInteractionWorkCard } from './interaction-work-card.js'
import {
  renderTaskActualExecutionGraphSection,
  unavailableModeFailure,
} from './task-display.js'
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
const readScope = taskReadScopeFromQuery()
const explicitScope = readScope.kind === 'task' ? readScope : null
const scopeFailure = readScope.kind === 'invalid' ? readScope.failure : null
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

const pageRoot = document.getElementById('page-root')
const template = mountPageTemplate(pageRoot, {
  layout: 'work',
  active: 'Task List',
  eyebrow: '任务观测 · 只读',
  title: '任务观测',
  lede: '从输入到任务输出的只读节点流转；节点详情只呈现工具调用、工具返回和 agent 写入的结论。',
  scope: explicitScope,
  displaySurface: OBSERVATION_DISPLAY_SURFACE,
})
const { heading, status, primary, support } = template.hosts
const { applyDisplayMode, initializeDisplayPreference } = template.shell
const headingCopy = heading.querySelector('.page-heading-copy')
const headingMeta = element('div', undefined, 'observation-meta')
headingCopy.append(headingMeta)

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
  const summaryText = node.summary && node.summary !== node.title && node.summary !== node.kindDisplay
    ? node.summary
    : ''
  card.append(head, meta)
  if (summaryText) card.append(element('span', summaryText, 'flow-node-summary'))
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

// renderObservation replaces every flow node (clearNode(primary)), so the node that
// opened the detail is detached by the time a scope navigation re-renders. Hold
// the trigger id instead of the element and resolve it in the CURRENT DOM.
// Breadcrumb-back and enter-scope re-render into a scope where the original id
// can be absent; those paths fall back to that scope's first node.
function currentTriggerNode() {
  const card = triggerNodeId
    ? primary.querySelector(`.flow-node[data-node-id="${CSS.escape(String(triggerNodeId))}"]`)
    : null
  return card ?? primary.querySelector('.flow-node')
}

// Best effort right after `close`, while the pre-navigation DOM is still
// present. Must not clear the pending flag: a scope navigation re-renders after
// this and still needs the post-render pass below.
function focusCurrentTrigger() {
  if (!returnFocusPending || document.querySelector('dialog.shell-layer[open]')) return
  currentTriggerNode()?.focus()
}

// Authoritative pass, scheduled by renderObservation after it rebuilds the flow
// nodes. This is what re-establishes focus once the render replaced the trigger.
function restoreFocusAfterRender() {
  if (!returnFocusPending || document.querySelector('dialog.shell-layer[open]')) return
  const target = currentTriggerNode()
  if (target) target.focus()
  returnFocusPending = false
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

function renderNodeDrawer(node, handoffs, detail, purpose, trigger) {
  triggerNodeId = node.nodeId
  const body = element('div', undefined, 'drawer-body')
  drawerCard?.dispose()
  drawerCard = undefined
  const eventView = purpose === 'execution-events'
  // The work-card note describes summary conclusions and CoT; an execution event
  // is a recorded fact, not a work item, so it carries no such note.
  if (!eventView) {
    body.append(element('p', '工具调用、工具返回和 agent 自己写入的 summary 结论；不呈现模型私有思维链。', 'drawer-note'))
  }

  if (eventView) {
    // A recorded execution event is not a work item: show its typed facts once
    // and reuse the shared reference/technical-source block. No goal/result
    // turns, no handoff tab and no nested conversation scroll.
    body.append(renderEventFacts(detail), renderReferences(detail, true))
  } else {
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
  }

  if (detail?.childScopeRef) {
    const enter = element('button', '进入下一层观测', 'button drawer-enter')
    enter.type = 'button'
    enter.addEventListener('click', () => {
      template.detail.close()
      void load(detail.childScopeRef)
    })
    body.append(enter)
  }

  template.detail.open({
    eyebrow: '节点详情 · 只读',
    title: detail?.title || node.title || node.nodeId,
    content: body,
    onClose: () => {
      drawerCard?.dispose()
      drawerCard = undefined
      returnFocusPending = true
      queueMicrotask(focusCurrentTrigger)
    },
  }, trigger)
}

// Compact facts for one recorded execution event. State always shows once; the
// record time and owning role appear only when the typed detail supplies them.
function renderEventFacts(detail) {
  const facts = element('dl', undefined, 'drawer-facts')
  const status = element('div')
  status.append(element('dt', '状态'), element('dd', detail?.stateDisplay || '未提供'))
  facts.append(status)
  if (detail?.updatedAt) {
    const time = element('div')
    time.append(element('dt', '记录时间'), element('dd', detail.updatedAt))
    facts.append(time)
  }
  if (detail?.roleDisplay) {
    const source = element('div')
    source.append(element('dt', '来源'), element('dd', detail.roleDisplay))
    facts.append(source)
  }
  return facts
}

function renderReferences(node, eventView = false) {
  const wrap = element('div')
  const source = node?.technicalSource
  const inputs = unresolvedList((node?.inputs || []).map((entry) => entry.ref), '无输入引用')
  const outputs = unresolvedList((node?.outputs || []).map((entry) => entry.ref), '无输出引用')
  const evidence = unresolvedList((node?.evidenceRefs || []).map((ref) => ref.locator), '无 evidence')
  const groups = [
    ['输入引用', inputs],
    ['输出引用', outputs],
    [eventView ? '证据' : 'Evidence', evidence],
  ]
  const referenceGroups = groups.filter(([, group]) => !group.empty)

  if (eventView) {
    if (!source && referenceGroups.length === 0) return wrap
    const details = element('details', undefined, 'drawer-technical-source')
    const counts = referenceGroups.map(([label, group]) => `${label} ${group.items.length} 项`)
    details.append(element('summary', ['查看来源与引用', counts.length > 0 ? `（${counts.join('，')}）` : ''].join('')))
    if (source) {
      const sourceFacts = element('dl', undefined, 'drawer-facts')
      for (const [label, value] of [
        ['原始类型', source.kind],
        ['原始标题', source.title],
        ['原始摘要', source.summary],
        ['原始时间', source.occurredAt],
      ]) {
        const cell = element('div')
        const detail = element('dd', value || '未提供')
        if (!value) detail.dataset.empty = 'true'
        cell.append(element('dt', label), detail)
        sourceFacts.append(cell)
      }
      details.append(sourceFacts)
    }
    if (referenceGroups.length > 0) {
      const facts = element('dl', undefined, 'drawer-facts')
      for (const [label, group] of referenceGroups) {
        const cell = element('div')
        cell.append(element('dt', label), element('dd', group.items.join(', ')))
        facts.append(cell)
      }
      details.append(facts)
    }
    wrap.append(details)
    return wrap
  }

  if (source) {
    const details = element('details', undefined, 'drawer-technical-source')
    details.append(element('summary', '技术详情'))
    const sourceFacts = element('dl', undefined, 'drawer-facts')
    for (const [label, value] of [
      ['原始类型', source.kind],
      ['原始标题', source.title],
      ['原始摘要', source.summary],
      ['原始时间', source.occurredAt],
    ]) {
      const cell = element('div')
      const detail = element('dd', value || '未提供')
      if (!value) detail.dataset.empty = 'true'
      cell.append(element('dt', label), detail)
      sourceFacts.append(cell)
    }
    details.append(sourceFacts)
    wrap.append(details)
  }
  const facts = element('dl', undefined, 'drawer-facts')
  // Refs come from the typed drawer detail (`projection.selectedNode`), never from the node card.
  for (const [label, group] of groups) {
    const cell = element('div')
    const dd = element('dd', group.items.join(', '))
    if (group.empty) dd.dataset.empty = 'true'
    cell.append(element('dt', label), dd)
    facts.append(cell)
  }
  wrap.append(facts)
  return wrap
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
  const value = read.ok === true ? read.value : undefined
  const isEmptyCatalog = value !== undefined
    && value.mode !== 'selected'
    && (value.current?.length ?? 0) === 0
    && (value.historical?.length ?? 0) === 0
    && (value.unknown?.length ?? 0) === 0
  if (isEmptyCatalog) {
    // A catalog read with no instance records is an honest "no execution yet",
    // not four empty record headings. The optional runtime-pool inspector notice
    // is not an execution fact; other unavailable sources stay visible.
    section.dataset.agentActivity = 'empty'
    section.append(
      element('h2', '执行实例 / 处理经过'),
      element('p', '尚无实际执行记录。', 'muted'),
    )
    const runtimePoolDiagnostic = renderRuntimePoolDiagnostic(value)
    if (runtimePoolDiagnostic) section.append(runtimePoolDiagnostic)
    const otherUnavailable = (value.unavailableSources ?? []).filter((source) => source?.sourceId !== 'runtime-pool')
    if (otherUnavailable.length > 0) {
      const block = element('section')
      block.append(element('h3', '部分记录来源不可用'))
      for (const source of otherUnavailable) {
        block.append(element('p', source.message))
        block.append(element('p', `${source.sourceId} · ${source.ownerId}`, 'muted'))
      }
      section.append(block)
    }
    return section
  }
  section.dataset.agentActivity = read.ok ? (read.value?.mode || 'read') : 'failed'
  section.append(element('h2', '执行实例 / 处理经过'))
  // The runtime-pool inspector is an optional live source, not a recorded fact.
  // Its absence stays out of the primary read; every other unavailable source
  // is preserved for the shared renderer.
  const renderRead = read.ok === true && value
    ? {
        ...read,
        value: {
          ...value,
          unavailableSources: (value.unavailableSources ?? []).filter((source) => source?.sourceId !== 'runtime-pool'),
        },
      }
    : read
  const view = renderAgentActivity(renderRead, {
    element,
    onSelect: (selection) => void selectAgentInstance(selection),
    ...(read.ok && read.value?.mode === 'selected' ? { onOpenDetail: openAgentDetail } : {}),
  })
  agentViewDispose = view.dispose
  section.append(view.element)
  const runtimePoolDiagnostic = renderRuntimePoolDiagnostic(value)
  if (runtimePoolDiagnostic) section.append(runtimePoolDiagnostic)
  return section
}

function renderRuntimePoolDiagnostic(value) {
  const sources = (value?.unavailableSources ?? []).filter((source) => source?.sourceId === 'runtime-pool')
  if (sources.length === 0) return null
  const details = element('details', undefined, 'drawer-technical-source')
  details.dataset.observationRuntimePoolDiagnostic = 'true'
  details.append(element('summary', '运行池诊断'))
  const facts = element('dl', undefined, 'drawer-facts')
  for (const source of sources) {
    for (const [label, text] of [
      ['消息', source.message],
      ['sourceId', source.sourceId],
      ['ownerId', source.ownerId],
    ]) {
      const cell = element('div')
      const detail = element('dd', text)
      if (!text) detail.dataset.empty = 'true'
      cell.append(element('dt', label), detail)
      facts.append(cell)
    }
  }
  details.append(facts)
  return details
}

// Actual execution records are a task-level attachment on the successful
// activity read. This read-only surface does not create a second reader or a
// graph placeholder when the activity read is pending, failed or absent.
function renderActualExecutionGraphSection(read) {
  if (agentSelectionFailure || agentReadPending || agentReadFailure) return null
  if (!read || read.ok !== true || !read.value?.actualExecutionGraph) return null
  return renderTaskActualExecutionGraphSection(read.value.actualExecutionGraph, {
    onOpenDetail: openTechnicalDetail,
  })
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
      ['用途', projection.scope?.purpose || '未提供'],
      ['projectionSeq', projection.scope?.projectionSeq || '未提供'],
      ['目录说明', projection.scope?.summary || '未提供'],
      ...rolePairs.map(({ raw, human }) => [`角色 ${raw}`, `${human} / ${raw}`]),
    ],
  })
}

function observationCollection(projection) {
  const count = Array.isArray(projection.nodes) ? projection.nodes.length : 0
  if (projection.scope?.purpose === 'pipeline-registry') {
    return {
      title: '系统节点目录',
      meta: `${count} 个系统节点`,
      note: '系统注册表节点目录；这些节点按所属角色分组，不代表任务执行依赖顺序。',
    }
  }
  if (projection.scope?.purpose === 'execution-events') {
    return {
      title: '执行事件记录',
      meta: `${count} 条执行事件`,
      note: '按记录顺序展示执行事件；原始类型和摘要可在节点技术详情中核对。',
    }
  }
  return {
    title: '观测记录',
    meta: `${count} 条记录`,
    note: '当前读取未说明记录用途；原始来源可在节点技术详情中核对。',
  }
}

function hasActualExecutionFacts(projection) {
  const read = projection?.agentActivity
  if (read?.ok === true && read.value) {
    const value = read.value
    const count = (value.selected?.length ?? 0)
      + (value.current?.length ?? 0)
      + (value.historical?.length ?? 0)
      + (value.unknown?.length ?? 0)
    if (count > 0) return true
    if (value.actualExecutionGraph?.history?.status === 'recorded') return true
  }
  return projection?.scope?.purpose === 'execution-events'
    && Array.isArray(projection.nodes)
    && projection.nodes.length > 0
}

function observationNextStep(projection) {
  const detail = typeof projection.data?.detail === 'string' ? projection.data.detail.trim() : ''
  // A business anchor with no execution must not present a control next step
  // that this read-only page cannot perform.
  if (!hasActualExecutionFacts(projection)) return '尚无实际执行记录。'
  return detail ? `下一步：${detail}` : '本次读取未提供下一步说明。'
}

function renderNodeCollection(projection, collection) {
  const flowSection = element('section', undefined, 'flow-section')
  const flowHead = element('header', undefined, 'section-head')
  flowHead.append(
    element('h2', collection.title),
    element('span', collection.meta, 'section-meta'),
  )
  flowSection.append(flowHead)
  const catalogueNote = element('p', collection.note, 'section-note')
  catalogueNote.dataset.catalogueSummary = 'true'
  flowSection.append(catalogueNote)
  if (projection.nodes.length === 0) {
    const empty = element('p', '当前 scope 没有节点。', 'flow-empty')
    empty.dataset.empty = 'true'
    flowSection.append(empty)
    return flowSection
  }
  flowSection.append(buildFlow(projection.nodes, currentFrames))
  return flowSection
}

// The static system-node registry is diagnostic material, not the task's actual
// execution. Keep it in one deliberate disclosure on the registry scope so the
// recorded execution facts stay the primary reading.
function renderCatalogueDisclosure(projection, collection) {
  const disclosure = element('details', undefined, 'observation-catalogue')
  disclosure.dataset.observationCatalogue = 'true'
  const summary = element('summary', undefined, 'observation-catalogue-summary')
  summary.append(
    element('span', collection.title),
    element('small', `${collection.meta}；默认折叠，展开查看系统节点`, 'section-meta'),
  )
  disclosure.append(
    summary,
    renderAgentChain(projection.nodes, currentFrames),
    renderNodeCollection(projection, collection),
  )
  return disclosure
}

function renderHeading(projection) {
  const title = headingCopy.querySelector('h1')
  if (title) title.textContent = projection.scope?.title || '任务处理流水'
  let nextStep = headingCopy.querySelector('.lede')
  if (!nextStep) {
    nextStep = element('p', undefined, 'lede')
    headingCopy.insertBefore(nextStep, headingMeta)
  }
  nextStep.textContent = observationNextStep(projection)
  nextStep.dataset.observationNextStep = 'true'

  clearNode(headingMeta)
  if (runtimeMode === 'fake') {
    const fake = element('span', '演示模式：非真实 Provider 结果', 'state-chip')
    fake.dataset.tone = 'warning'
    headingMeta.append(fake)
  }
  headingMeta.append(element('span', projection.data?.label || '未投影状态', 'state-chip'))
  const technical = element('button', '技术详情', 'button button--quiet')
  technical.type = 'button'
  technical.dataset.observationTechnicalTrigger = 'true'
  technical.addEventListener('click', () => observationTechnicalDetail(projection))
  headingMeta.append(technical)
}

function renderObservation(projection) {
  if (agentViewDispose) {
    agentViewDispose()
    agentViewDispose = null
  }
  lastProjection = projection

  currentScopeStates = scopeStatesOf(projection)
  currentFrames = laneDefinitions(Array.isArray(projection.agentFrames) ? projection.agentFrames : [])
  currentHandoffs = Array.isArray(projection.handoffs) ? projection.handoffs : []

  clearNode(primary)
  clearNode(support)
  renderHeading(projection)

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
  primary.append(breadcrumbs)

  const collection = observationCollection(projection)
  const catalogue = projection.scope?.purpose === 'pipeline-registry'
  if (!catalogue) primary.append(renderAgentChain(projection.nodes, currentFrames))

  const agentSection = renderAgentActivitySection(projection)
  if (agentSection) support.append(agentSection)

  const actualGraphSection = renderActualExecutionGraphSection(projection?.agentActivity)
  if (actualGraphSection) support.append(actualGraphSection)

  primary.append(renderSemanticObservationSection())

  primary.append(catalogue
    ? renderCatalogueDisclosure(projection, collection)
    : renderNodeCollection(projection, collection))
  if (projection.nodes.length === 0) return
  requestAnimationFrame(restoreFocusAfterRender)

  // The typed detail of the selected node opens the shared detail carrier; `selectedNodeId` is cleared so
  // the detail opens once per selection and breadcrumb navigation starts from a clean state.
  const selected = projection.selectedNode
  if (selected && selectedNodeId === selected.nodeId) {
    selectedNodeId = undefined
    const trigger = primary.querySelector(`.flow-node[data-node-id="${CSS.escape(String(selected.nodeId))}"]`)
    renderNodeDrawer(
      projection.nodes.find((node) => node.nodeId === selected.nodeId) || { nodeId: selected.nodeId, title: selected.title },
      currentHandoffs,
      selected,
      projection.scope?.purpose,
      trigger,
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
        scope: explicitScope,
        // The panel's own four buttons reuse the shell programmatic transition,
        // so a local click cannot write the follow-last preference. The corner
        // buttons keep the original manual controller path.
        onModeChange: (mode) => {
          if (mode === observationDisplayMode) return
          void applyDisplayMode(mode)
        },
        onEvidenceRequest: (evidence, trigger) => {
          template.detail.open({
            eyebrow: '只读证据',
            title: evidence.title,
            content: renderSemanticEvidenceContent(evidence),
          }, trigger)
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
  if (scopeFailure) {
    renderPageError(status, scopeFailure)
    return
  }
  const serial = ++loadSerial
  try {
    const projection = await api.observation(taskId, scopeRef, selectedNodeId, agentQuery, explicitScope)
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

void (async () => {
  const { status: runtimeStatus, error } = await loadRuntimeStatus()
  runtimeMode = runtimeStatus?.mode || ''
  renderRuntimeStatus(status, runtimeStatus, error)
  await load()
  // The controller starts after this page's first read settled, so applying
  // the resolved default cannot outrun the node-flow it needs to render.
  await initializeDisplayPreference()
})()

window.addEventListener('pagehide', (event) => {
  if (event?.persisted) return
  agentViewDispose?.()
  agentViewDispose = null
  closeAgentDetail()
  drawerCard?.dispose()
  drawerCard = undefined
  semanticObservationPanel?.dispose()
  semanticObservationPanel = null
  semanticObservationHost = null
  template.dispose()
})
