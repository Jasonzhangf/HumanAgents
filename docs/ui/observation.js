import {
  api,
  clearNode,
  element,
  loadRuntimeStatus,
  makePageShell,
  renderRuntimeStatus,
  stateTone,
  taskIdFromQuery,
} from './runtime-shell.js'

// Node order and row numbers are the single local copy of the pipeline registry table
// (docs/architecture/organ-runtime.md:221). TODO(registry): 待注册表接线后改为导入
// packages/contracts 的 `PIPELINE_ROWS`，本文件不得再出现第二份节点顺序表。
export const PIPELINE_ROWS = Object.freeze({
  'sensory.inbox': 1,
  'explicit.normalize': 2,
  'implicit.classify': 3,
  'interactive.queue': 4,
  'execution.queue': 4,
  'research.queue': 4,
  'maintenance.queue': 4,
  'task.correlate-or-create': 5,
  'resource.admission': 6,
  'pipeline.execute': 7,
  'settle': 8,
  'task.output': 9,
  'memory.agent': 9,
})

// Object key order is the canonical tie-break inside a shared row (the four queues, task.output).
const PIPELINE_ORDER = Object.freeze(Object.keys(PIPELINE_ROWS))

// Agent attribution is layout scaffolding, not runtime state. The five product roles are fixed;
// membership is read from the typed projection only, never guessed from keywords or module names.
const AGENT_LANES = Object.freeze([
  { laneId: 'interaction', label: '交互', role: '交互 agent' },
  { laneId: 'orchestration', label: '任务编排', role: '任务编排 agent' },
  { laneId: 'execution', label: '执行', role: '执行 agent' },
  { laneId: 'review', label: '审核', role: '审核 agent' },
  { laneId: 'memory', label: '经验整理', role: '经验整理 agent' },
])

const UNASSIGNED_LANE = Object.freeze({
  laneId: 'unassigned',
  label: '归属未投影',
  role: 'projection 未给出 agentId / ownerAgentRole',
})

const UNPROJECTED_ROLE = '归属未投影'

// Distance from the last node box edge to the routing channel, and the channel width itself.
// The channel width is CSS-owned (`--flow-corridor` on .flow-canvas) so JS only reads it.
const EDGE_GAP = 1.5
const EDGE_STUB = 24

const taskId = taskIdFromQuery()
const { main, status } = makePageShell(
  'Task List',
  'Pipeline Observation',
  '任务观测',
  '从输入到任务输出的只读节点流转；节点详情只呈现工具调用、工具返回和 agent 写入的结论。',
)

let drawer
let lastTrigger
let selectedNode
let edgeFrame

function agentRoleOf(node) {
  for (const field of [node.agentId, node.ownerAgentRole, node.agentRole]) {
    if (typeof field === 'string' && field.trim().length > 0) return field.trim()
  }
  return ''
}

function agentLaneFor(node) {
  const role = agentRoleOf(node)
  return AGENT_LANES.find((lane) => lane.laneId === role || lane.role === role) ?? UNASSIGNED_LANE
}

function canonicalNodeId(nodeId) {
  const value = String(nodeId || '')
  const exact = PIPELINE_ORDER.find((candidate) => candidate === value)
  if (exact) return exact
  return PIPELINE_ORDER.find((candidate) => value.endsWith(`.${candidate}`) || value.endsWith(`/${candidate}`)) ?? ''
}

function pipelineRow(node) {
  const canonical = canonicalNodeId(node.nodeId)
  return canonical ? PIPELINE_ROWS[canonical] : Number.MAX_SAFE_INTEGER
}

function canonicalIndex(node) {
  const canonical = canonicalNodeId(node.nodeId)
  return canonical ? PIPELINE_ORDER.indexOf(canonical) : -1
}

function nodeState(node) {
  return typeof node.state === 'string' && node.state.length > 0 ? node.state : 'unknown'
}

function isRunningState(state) {
  return state === 'running' || state === 'settling' || state === 'admitted'
}

function isSettledState(state) {
  return state === 'succeeded' || state === 'stopped'
}

function unresolvedList(values, fallback) {
  const items = Array.isArray(values) ? values.filter((value) => typeof value === 'string' && value.length > 0) : []
  if (items.length === 0) return { items: [fallback], empty: true }
  return { items, empty: false }
}

function renderAgentChain(nodes) {
  const section = element('section', undefined, 'agent-chain')
  section.setAttribute('aria-label', 'agent 链路')
  const head = element('header', undefined, 'agent-chain-head')
  head.append(
    element('h2', 'agent 链路'),
    element('span', '上游 agent → 下游 agent', 'agent-chain-note'),
  )
  section.append(head)
  const strip = element('ol', undefined, 'chain-strip')
  const activeLanes = new Set(nodes.map((node) => agentLaneFor(node).laneId))
  AGENT_LANES.forEach((lane, index) => {
    const item = element('li', undefined, 'chain-step')
    const chip = element('div', undefined, 'chain-chip')
    if (activeLanes.has(lane.laneId)) chip.dataset.active = 'true'
    chip.append(element('span', lane.label, 'chain-chip-role'), element('small', lane.role))
    item.append(chip)
    const next = AGENT_LANES[index + 1]
    if (next) {
      const arrow = element('span', '→', 'chain-arrow')
      arrow.setAttribute('aria-hidden', 'true')
      item.append(arrow)
    }
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
  const chip = element('span', node.stateDisplay || state, 'state-chip')
  chip.dataset.tone = stateTone(state)
  head.append(chip)
  const meta = element('span', undefined, 'flow-node-meta')
  const owner = element('small', `归属：${role || UNPROJECTED_ROLE}`)
  if (!role) owner.dataset.empty = 'true'
  meta.append(element('small', node.kindDisplay || node.kind || '未标注类型'), owner)
  const summary = element('span', node.summary || '尚未投影节点摘要', 'flow-node-summary')
  if (!node.summary) summary.dataset.empty = 'true'
  card.append(head, meta, summary)
  card.addEventListener('click', () => openNode(node, card))
  return card
}

function renderLane(lane, laneNodes, startIndex) {
  const section = element('section', undefined, 'agent-lane')
  section.dataset.laneId = lane.laneId
  const head = element('header', undefined, 'agent-lane-head')
  const count = laneNodes.length === 0 ? '0 个节点' : `${laneNodes.length} 个节点`
  head.append(element('h3', lane.label), element('span', `${lane.role} · ${count}`, 'agent-lane-meta'))
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

function buildFlow(nodes) {
  const canvas = element('div', undefined, 'flow-canvas')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'flow-edges')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  canvas.append(svg)

  const ordered = [...nodes].sort((a, b) => {
    const rowDelta = pipelineRow(a) - pipelineRow(b)
    if (rowDelta !== 0) return rowDelta
    const indexDelta = canonicalIndex(a) - canonicalIndex(b)
    if (indexDelta !== 0) return indexDelta
    return String(a.nodeId).localeCompare(String(b.nodeId))
  })

  // Lane membership comes from the projection; unknown attribution stays in the explicit
  // "归属未投影" band instead of being inferred from owner/module names.
  const lanes = new Map(AGENT_LANES.map((lane) => [lane.laneId, []]))
  lanes.set(UNASSIGNED_LANE.laneId, [])
  const laneOf = new Map()
  const lanePositionOf = new Map()
  for (const node of ordered) {
    const laneId = agentLaneFor(node).laneId
    const bucket = lanes.get(laneId)
    lanePositionOf.set(node.nodeId, bucket.length)
    laneOf.set(node.nodeId, laneId)
    bucket.push(node)
  }

  let index = 0
  for (const lane of [...AGENT_LANES, UNASSIGNED_LANE]) {
    const laneNodes = lanes.get(lane.laneId)
    if (lane === UNASSIGNED_LANE && laneNodes.length === 0) continue
    canvas.append(renderLane(lane, laneNodes, index))
    index += laneNodes.length
  }

  const edges = []
  ordered.forEach((node, position) => {
    if (position === 0) return
    const from = ordered[position - 1]
    const state = nodeState(node)
    edges.push({
      fromNodeId: from.nodeId,
      toNodeId: node.nodeId,
      tone: isRunningState(state) ? 'active' : isSettledState(state) ? 'done' : 'pending',
      label: `${from.title || from.nodeId} → ${node.title || node.nodeId}`,
      // Only vertically adjacent cards in the same band may be joined by a direct line;
      // every other pair detours through the corridor beside the node boxes.
      direct: laneOf.get(from.nodeId) === laneOf.get(node.nodeId)
        && lanePositionOf.get(node.nodeId) === lanePositionOf.get(from.nodeId) + 1,
    })
  })
  if (edges.length === 0 && ordered.length === 1) {
    edges.push({ fromNodeId: null, toNodeId: ordered[0].nodeId, tone: 'pending', label: `上游未标注 → ${ordered[0].title || ordered[0].nodeId}`, direct: true })
  }

  const flowList = element('ol', undefined, 'flow-edges-list')
  flowList.setAttribute('aria-label', '节点上下游顺序')
  for (const edge of edges) {
    const item = element('li', truncate(edge.label, 120))
    item.dataset.tone = edge.tone
    flowList.append(item)
  }
  canvas.append(flowList)
  return { canvas, svg, edges }
}

function truncate(text, limit) {
  const value = String(text)
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function drawEdges(flow) {
  const { canvas, svg, edges } = flow
  const canvasRect = canvas.getBoundingClientRect()
  const width = canvas.clientWidth
  const height = canvas.scrollHeight
  const corridorWidth = Number.parseFloat(getComputedStyle(canvas).getPropertyValue('--flow-corridor')) || 26
  const corridorX = Math.max(width - corridorWidth / 2, 1)
  svg.setAttribute('viewBox', `0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`)
  svg.setAttribute('width', String(Math.max(width, 1)))
  svg.setAttribute('height', String(Math.max(height, 1)))
  clearNode(svg)
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker')
  marker.setAttribute('id', 'flow-arrow')
  marker.setAttribute('viewBox', '0 0 10 10')
  marker.setAttribute('refX', '9')
  marker.setAttribute('refY', '5')
  marker.setAttribute('markerWidth', '7')
  marker.setAttribute('markerHeight', '7')
  marker.setAttribute('orient', 'auto-start-reverse')
  const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  markerPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z')
  markerPath.setAttribute('class', 'flow-arrow-head')
  marker.append(markerPath)
  defs.append(marker)
  svg.append(defs)

  const rectOf = (nodeId) => {
    const card = nodeId === null ? null : canvas.querySelector(`.flow-node[data-node-id="${CSS.escape(String(nodeId))}"]`)
    if (!card) return null
    const rect = card.getBoundingClientRect()
    return {
      top: rect.top - canvasRect.top,
      bottom: rect.bottom - canvasRect.top,
      left: rect.left - canvasRect.left,
      right: rect.right - canvasRect.left,
      width: rect.width,
      height: rect.height,
      centerX: rect.left - canvasRect.left + rect.width / 2,
      centerY: rect.top - canvasRect.top + rect.height / 2,
    }
  }

  // Edges stay 1.5px clear of every node box: a direct line for vertically adjacent cards in a
  // band, and an orthogonal detour through the corridor beside the boxes for everything else.
  const edgePath = (edge, source, target) => {
    if (!source) {
      return `M ${target.centerX} ${Math.max(target.top - EDGE_STUB, 0)} L ${target.centerX} ${target.top - EDGE_GAP}`
    }
    if (edge.direct) {
      return `M ${source.centerX} ${source.bottom + EDGE_GAP} L ${target.centerX} ${target.top - EDGE_GAP}`
    }
    return [
      `M ${source.right + EDGE_GAP} ${source.centerY}`,
      `L ${corridorX} ${source.centerY}`,
      `L ${corridorX} ${target.centerY}`,
      `L ${target.right + EDGE_GAP} ${target.centerY}`,
    ].join(' ')
  }

  const midArrow = (path) => {
    const total = path.getTotalLength()
    if (!(total > 0)) return null
    const middle = total / 2
    const reach = Math.min(2, total / 4)
    const before = path.getPointAtLength(middle - reach)
    const after = path.getPointAtLength(middle + reach)
    const angle = Math.atan2(after.y - before.y, after.x - before.x) * (180 / Math.PI)
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z')
    arrow.setAttribute('class', 'flow-arrow-head flow-arrow-head--mid')
    arrow.setAttribute('transform', `translate(${after.x} ${after.y}) rotate(${angle}) translate(-10 -5)`)
    return arrow
  }

  for (const edge of edges) {
    const target = rectOf(edge.toNodeId)
    if (!target) continue
    const source = edge.fromNodeId === null ? null : rectOf(edge.fromNodeId)
    if (edge.fromNodeId !== null && !source) continue
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', edgePath(edge, source, target))
    path.setAttribute('class', `flow-edge flow-edge--${edge.tone}`)
    path.dataset.tone = edge.tone
    if (edge.tone === 'done') {
      svg.append(path)
      const arrow = midArrow(path)
      if (arrow) svg.append(arrow)
      continue
    }
    if (edge.tone === 'active') {
      path.setAttribute('marker-end', 'url(#flow-arrow)')
    }
    svg.append(path)
  }
}

function scheduleEdgeDraw(flow) {
  cancelAnimationFrame(edgeFrame)
  edgeFrame = requestAnimationFrame(() => drawEdges(flow))
}

function buildDrawer() {
  drawer = element('dialog', undefined, 'node-drawer')
  drawer.setAttribute('aria-labelledby', 'drawer-title')
  const body = element('div', undefined, 'drawer-body')
  drawer.append(body)
  drawer.addEventListener('close', () => {
    lastTrigger?.focus()
  })
  drawer.addEventListener('keydown', trapFocus)
  document.body.append(drawer)
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

function renderToolHistory(node) {
  const panel = element('section', undefined, 'drawer-pane')
  panel.append(element('h3', '工具调用历史'))
  const calls = Array.isArray(node.toolCalls) ? node.toolCalls : []
  if (calls.length === 0) {
    const empty = element('p', '尚未投影工具调用记录；本栏只呈现工具调用与工具返回，不呈现模型私有思维链。', 'flow-empty')
    empty.dataset.empty = 'true'
    panel.append(empty)
    return panel
  }
  const list = element('ol', undefined, 'tool-list')
  for (const call of calls) {
    const item = element('li', undefined, 'tool-call')
    const head = element('div', undefined, 'tool-call-head')
    head.append(element('strong', call.toolName || call.name || '未标注工具'))
    const chip = element('span', call.state || 'unknown', 'state-chip')
    chip.dataset.tone = stateTone(call.state)
    head.append(chip)
    item.append(head)
    if (call.summary) item.append(element('p', call.summary))
    const args = unresolvedList(call.inputRefs, '未投影工具输入')
    const results = unresolvedList(call.outputRefs, '未投影工具返回')
    const refs = element('dl', undefined, 'tool-refs')
    for (const [label, group] of [['工具输入', args], ['工具返回', results]]) {
      const cell = element('div')
      const dd = element('dd', group.items.join(', '))
      if (group.empty) dd.dataset.empty = 'true'
      cell.append(element('dt', label), dd)
      refs.append(cell)
    }
    item.append(refs)
    list.append(item)
  }
  panel.append(list)
  return panel
}

function renderSummaryPane(node) {
  const panel = element('section', undefined, 'drawer-pane drawer-pane--summary')
  panel.append(element('h3', 'summary'))
  const summary = element('p', node.summary || '尚未投影 summary。', 'drawer-summary')
  if (!node.summary) summary.dataset.empty = 'true'
  panel.append(summary, element('p', 'summary 是 agent 自己写入的结论，不代表模型私有推理。', 'drawer-note'))
  const facts = element('dl', undefined, 'drawer-facts')
  const role = agentRoleOf(node)
  for (const [label, value] of [
    ['节点类型', node.kindDisplay || node.kind || '未标注'],
    ['状态', node.stateDisplay || nodeState(node)],
    ['归属 agent', role || UNPROJECTED_ROLE],
    ['更新时间', node.updatedAt || '未投影'],
  ]) {
    const cell = element('div')
    const dd = element('dd', value)
    if (!value || value === '未投影' || value === '未标注' || value === UNPROJECTED_ROLE) dd.dataset.empty = 'true'
    cell.append(element('dt', label), dd)
    facts.append(cell)
  }
  panel.append(facts)
  return panel
}

function renderHandoffPane(node) {
  const panel = element('section', undefined, 'drawer-pane')
  panel.append(element('h3', '跨 agent 交接'))
  const handoffs = Array.isArray(node.handoffs) ? node.handoffs : []
  if (handoffs.length === 0) {
    const empty = element('p', '尚未投影跨 agent 交接内容。', 'flow-empty')
    empty.dataset.empty = 'true'
    panel.append(empty)
    return panel
  }
  for (const handoff of handoffs) {
    const block = element('article', undefined, 'handoff')
    block.append(element('h4', `${handoff.fromAgent || '未标注'} → ${handoff.toAgent || '未标注'}`))
    const carried = unresolvedList(handoff.carried, '未投影携带内容')
    const notReturned = unresolvedList(handoff.notReturned, '未投影不回传内容')
    const facts = element('dl', undefined, 'drawer-facts')
    for (const [label, group] of [['携带', carried], ['不回传', notReturned]]) {
      const cell = element('div')
      const dd = element('dd', group.items.join('、'))
      if (group.empty) dd.dataset.empty = 'true'
      cell.append(element('dt', label), dd)
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

function renderDrawerSection(definition, node) {
  const section = element('section', undefined, 'drawer-section')
  section.dataset.sheetId = definition.sheetId
  section.append(element('h3', definition.label))
  section.append(definition.render(node))
  return section
}

function openNode(node, trigger) {
  lastTrigger = trigger
  selectedNode = node
  const body = drawer.querySelector('.drawer-body')
  clearNode(body)
  const head = element('header', undefined, 'drawer-head')
  const titleWrap = element('div')
  titleWrap.append(
    element('p', '节点详情 · 只读', 'eyebrow'),
    element('h2', node.title || node.nodeId),
    element('p', '工具调用、工具返回和 agent 自己写入的 summary 结论；不呈现模型私有思维链。', 'drawer-note'),
  )
  const close = element('button', '关闭', 'button drawer-close')
  close.type = 'button'
  close.dataset.action = 'close-drawer'
  close.addEventListener('click', () => drawer.close())
  head.append(titleWrap, close)
  body.append(head)

  // Two visible panes: tool call history on the left, summary on the right.
  const panes = element('div', undefined, 'drawer-panes')
  const toolsPane = renderToolHistory(node)
  toolsPane.classList.add('drawer-pane--tools')
  panes.append(toolsPane, renderSummaryPane(node))
  body.append(panes)

  // Handoff lives on its own page inside the same sheet.
  const tabs = element('div', undefined, 'drawer-tabs')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', '节点详情页')
  const sheets = element('div', undefined, 'drawer-sheets')
  const definitions = [
    { sheetId: 'handoff', label: '跨 agent 交接', render: renderHandoffPane },
    { sheetId: 'refs', label: '输入 / 输出 / evidence', render: renderReferences },
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
    const sheet = renderDrawerSection(definition, node)
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

  if (node.childScopeRef) {
    const enter = element('button', '进入下一层观测', 'button drawer-enter')
    enter.type = 'button'
    enter.addEventListener('click', () => {
      drawer.close()
      void load(node.childScopeRef)
    })
    body.append(enter)
  }

  drawer.showModal()
  close.focus()
}

function renderReferences(node) {
  const facts = element('dl', undefined, 'drawer-facts')
  const inputs = unresolvedList(node.inputRefs, '无输入引用')
  const outputs = unresolvedList(node.outputRefs, '无输出引用')
  const evidence = unresolvedList((node.evidenceRefs || []).map((ref) => ref.locator), '无 evidence')
  for (const [label, group] of [['输入引用', inputs], ['输出引用', outputs], ['Evidence', evidence]]) {
    const cell = element('div')
    const dd = element('dd', group.items.join(', '))
    if (group.empty) dd.dataset.empty = 'true'
    cell.append(element('dt', label), dd)
    facts.append(cell)
  }
  return facts
}

function renderObservation(projection) {
  clearNode(main)

  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(
    element('p', '只读 Observation', 'eyebrow'),
    element('h1', projection.title),
    element('p', projection.summary, 'lede'),
  )
  const meta = element('div', undefined, 'observation-meta')
  meta.append(element('span', `mode=${projection.mode}`, 'mode-chip'))
  if (projection.mode === 'fake') {
    const fake = element('span', 'fake 模式：非真实 Provider 结果', 'state-chip')
    fake.dataset.tone = 'warning'
    meta.append(fake)
  }
  heading.append(copy, meta)
  main.append(heading)

  const breadcrumbs = element('nav', undefined, 'breadcrumbs')
  breadcrumbs.setAttribute('aria-label', '当前观测路径')
  projection.breadcrumbs.forEach((crumb, index) => {
    const button = element('button', crumb.title, 'segment')
    button.type = 'button'
    button.addEventListener('click', () => {
      void load(index === 0 ? undefined : `task://${taskId}/observation`)
    })
    breadcrumbs.append(button)
  })
  main.append(breadcrumbs)

  main.append(renderAgentChain(projection.nodes))

  const flowSection = element('section', undefined, 'flow-section')
  const flowHead = element('header', undefined, 'section-head')
  flowHead.append(
    element('h2', '节点流转'),
    element('span', `projection seq ${projection.projectionSeq}`, 'section-meta'),
  )
  flowSection.append(flowHead)

  if (projection.nodes.length === 0) {
    const empty = element('p', '当前 scope 没有节点。', 'flow-empty')
    empty.dataset.empty = 'true'
    flowSection.append(empty)
    main.append(flowSection)
    return
  }

  const flow = buildFlow(projection.nodes)
  const canvas = flow.canvas
  canvas.append(renderLegend())
  flowSection.append(canvas)
  main.append(flowSection)
  scheduleEdgeDraw(flow)
  window.addEventListener('resize', () => scheduleEdgeDraw(flow))
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => scheduleEdgeDraw(flow))
    observer.observe(canvas)
    canvas.dataset.observed = 'true'
  }
}

function renderLegend() {
  const legend = element('div', undefined, 'flow-legend')
  for (const [tone, label] of [
    ['done', '已完成的流程：静态线，箭头在中点'],
    ['active', '正在运行的流程：流动线，箭头在终点'],
    ['pending', '未开始的流程：静态线，暂无箭头'],
  ]) {
    const item = element('span', label, 'legend-item')
    item.dataset.tone = tone
    legend.append(item)
  }
  return legend
}

async function load(scopeRef) {
  try {
    const projection = await api.observation(taskId, scopeRef, selectedNode?.nodeId)
    renderObservation(projection)
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
  }
}

buildDrawer()
void (async () => {
  const { status: runtimeStatus, error } = await loadRuntimeStatus()
  renderRuntimeStatus(status, runtimeStatus, error)
  await load()
})()
