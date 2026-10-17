#!/usr/bin/env node

/**
 * Real-browser proof for the observation node drawer.
 *
 * The harness serves either the candidate `dist/app/ui` tree or a red-base
 * archive through a loopback server. The page uses the real `observation.js`
 * entry, so the checks bind to the rendered drawer rather than source strings.
 */

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = resolve(process.env.INTERACTION_OBSERVATION_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'))
const evidenceRoot = process.env.INTERACTION_OBSERVATION_EVIDENCE

if (!evidenceRoot?.trim()) {
  throw new Error('INTERACTION_OBSERVATION_EVIDENCE is required; point it at an execution-owned directory')
}

const playwrightModule = await import(
  process.env.INTERACTION_CARD_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js',
)
const playwright = playwrightModule.default ?? playwrightModule

const TASK_ID = 'task-observation'
const MISSING_STATE_TASK_ID = 'task-observation-missing-state'
const TIME = '2026-10-05T12:00:00Z'
// The turn identity the provider binding reported for this node. The proof
// asserts the drawer displays this literal id, not an ordinal.
const REAL_TURN_ID = 'turn-3c7d1f8a-52b4-4e19-8a60-1d9f4b2c7e35'
const ROLE_PAIRS = [
  { raw: 'execution', human: '执行' },
  { raw: 'review', human: '审核' },
  { raw: 'memory', human: '经验整理' },
  { raw: 'unclassified', human: '未归类' },
]
const EXPECTED_REFS = Object.freeze({
  inputs: ['operation://operation-observation/input'],
  outputs: ['artifact://observation-result'],
  evidence: ['evidence:ev-observation'],
})
const SIMULTANEOUS_STATES = Object.freeze({
  'pipeline.execute': { state: 'running', label: '运行中', tone: 'active' },
  settle: { state: 'blocked', label: '受阻', tone: 'warning' },
  'pipeline.unclassified': { state: 'unknown', label: '未知', tone: 'gray' },
  'pipeline.remember': { state: 'stale', label: '过期', tone: 'gray' },
})

function evidenceRef(locator) {
  return {
    evidenceId: { scope: 'evidence', value: locator },
    kind: 'tool',
    source: 'observation-drawer-proof',
    locator,
    scope: {
      organId: { scope: 'organ', value: 'organ-observation' },
      taskId: { scope: 'task', value: TASK_ID },
    },
  }
}

function selectedNode(taskId, nodeId = 'pipeline.execute', { emptyRefs = false } = {}) {
  const identity = {
    'pipeline.execute': {
      title: '执行流水线',
      kindDisplay: '执行',
      stateDisplay: '运行中',
      owner: 'agent-execution',
      ownerAgentRole: 'execution',
      roleDisplay: '执行',
      summary: '执行完成，输出已投影。',
    },
    settle: {
      title: '收拢',
      kindDisplay: '收拢',
      stateDisplay: '受阻',
      owner: 'agent-review',
      ownerAgentRole: 'review',
      roleDisplay: '审核',
      summary: '等待收拢',
    },
    'pipeline.remember': {
      title: '经验整理',
      kindDisplay: '记忆',
      stateDisplay: '过期',
      owner: 'agent-memory',
      ownerAgentRole: 'memory',
      roleDisplay: '经验整理',
      summary: '经验投影已过期',
    },
    'pipeline.unclassified': {
      title: '未归类节点',
      kindDisplay: '未知',
      stateDisplay: '未知',
      owner: 'agent-unclassified',
      ownerAgentRole: 'unclassified',
      roleDisplay: '未归类',
      summary: '等待分类',
    },
  }[nodeId]
  return {
    nodeId,
    ...identity,
    iteration: 2,
    updatedAt: '2026-10-05T12:00:05Z',
    // The provider binding reported this turn id for the node's real events.
    turnId: nodeId === 'pipeline.execute' ? REAL_TURN_ID : undefined,
    inputs: emptyRefs || nodeId !== 'pipeline.execute'
      ? []
      : [{ ref: 'operation://operation-observation/input', label: '执行输入' }],
    outputs: emptyRefs || nodeId !== 'pipeline.execute'
      ? []
      : [{ ref: 'artifact://observation-result', label: '结果' }],
    evidenceRefs: emptyRefs || nodeId !== 'pipeline.execute'
      ? []
      : [evidenceRef('evidence:ev-observation')],
    activity: nodeId === 'pipeline.execute'
      ? [
          { activityRef: 'activity:receive', summary: '已接收执行请求', occurredAt: '2026-10-05T12:00:00Z', turnId: REAL_TURN_ID },
          // The runtime's own settling activity carries no provider turn; it must
          // show the explicit no-turn state instead of a fabricated number.
          { activityRef: 'activity:return', summary: 'provider 返回结果', occurredAt: '2026-10-05T12:00:04Z' },
        ]
      : [],
    toolSteps: nodeId === 'pipeline.execute'
      ? [
          {
            stepId: 'call-returned',
            name: 'read.file',
            status: 'succeeded',
            statusDisplay: '已返回',
            returned: 'status=succeeded · outputRef=asset://output/call-returned',
            occurredAt: '2026-10-05T12:00:01Z',
            turnId: REAL_TURN_ID,
          },
          {
            stepId: 'call-unreturned',
            name: 'write.file',
            status: 'unknown',
            statusDisplay: '未知',
            returned: 'status=unknown · call=write.file',
            occurredAt: '2026-10-05T12:00:02Z',
          },
        ]
      : [],
    childScopeRef: `task://${taskId}/observation/${nodeId}`,
    feedback: [],
  }
}

function observationProjection(withDrawer, taskId, selectedNodeId) {
  const missingState = taskId === MISSING_STATE_TASK_ID
  const detail = selectedNode(taskId, selectedNodeId || 'pipeline.execute', { emptyRefs: missingState })
  const scopeNodes = [
    { nodeId: 'pipeline.execute', title: '执行流水线', state: 'running', stateDisplay: '运行中', kindDisplay: '执行', summary: '执行中', owner: 'agent-execution', updatedAt: TIME, hasChildScope: true, evidenceCount: 1 },
    { nodeId: 'settle', title: '收拢', state: 'blocked', stateDisplay: '受阻', kindDisplay: '收拢', summary: '等待收拢', owner: 'agent-review', updatedAt: TIME, hasChildScope: false, evidenceCount: 0 },
    { nodeId: 'pipeline.remember', title: '经验整理', state: 'stale', stateDisplay: '过期', kindDisplay: '记忆', summary: '经验投影已过期', owner: 'agent-memory', updatedAt: TIME, hasChildScope: false, evidenceCount: 0 },
    { nodeId: 'pipeline.unclassified', title: '未归类节点', state: 'unknown', stateDisplay: '未知', kindDisplay: '未知', summary: '等待分类', owner: 'agent-unclassified', updatedAt: TIME, hasChildScope: false, evidenceCount: 0 },
  ]
  if (missingState) delete scopeNodes.find((node) => node.nodeId === 'settle').state
  return {
    surface: 'observation',
    state: 'running',
    data: {
      state: 'running',
      label: '运行中',
      ...(missingState ? {} : { detail: '真实投影样本' }),
    },
    scope: {
      scopeRef: `task://${taskId}/observation`,
      title: '任务处理流水',
      summary: '只读观测样本',
      projectionSeq: 'seq-12',
      breadcrumbs: [{ ref: `task://${taskId}/observation`, title: '任务处理流水' }],
      canReturn: false,
      nodes: scopeNodes,
    },
    nodes: [
      {
        nodeId: 'pipeline.execute',
        title: '执行流水线',
        row: 8,
        kindDisplay: '执行',
        ownerAgentRole: 'execution',
        roleDisplay: '执行',
        stateDisplay: '运行中',
        iteration: 2,
        activity: detail.activity,
        summary: detail.summary,
        updatedAt: detail.updatedAt,
        toolSteps: detail.toolSteps,
      },
      {
        nodeId: 'settle',
        title: '收拢',
        row: 9,
        kindDisplay: '收拢',
        ownerAgentRole: 'review',
        roleDisplay: '审核',
        stateDisplay: '受阻',
        iteration: 2,
        activity: [],
        summary: '等待收拢',
        updatedAt: TIME,
        toolSteps: [],
      },
      {
        nodeId: 'pipeline.remember',
        title: '经验整理',
        row: 10,
        kindDisplay: '记忆',
        ownerAgentRole: 'memory',
        roleDisplay: '经验整理',
        stateDisplay: '过期',
        iteration: 2,
        activity: [],
        summary: '经验投影已过期',
        updatedAt: TIME,
        toolSteps: [],
      },
      {
        nodeId: 'pipeline.unclassified',
        title: '未归类节点',
        row: 11,
        kindDisplay: '未知',
        ownerAgentRole: 'unclassified',
        roleDisplay: '未归类',
        stateDisplay: '未知',
        iteration: 2,
        activity: [],
        summary: '等待分类',
        updatedAt: TIME,
        toolSteps: [],
      },
    ],
    agentFrames: [
      { agentId: 'agent-execution', role: 'execution', roleDisplay: '执行', stateDisplay: '运行中', iteration: 2, nodeIds: ['pipeline.execute'] },
      { agentId: 'agent-review', role: 'review', roleDisplay: '审核', stateDisplay: '受阻', iteration: 2, nodeIds: ['settle'] },
      { agentId: 'agent-memory', role: 'memory', roleDisplay: '经验整理', stateDisplay: '过期', iteration: 2, nodeIds: ['pipeline.remember'] },
      { agentId: 'agent-unclassified', role: 'unclassified', roleDisplay: '未归类', stateDisplay: '未知', iteration: 2, nodeIds: ['pipeline.unclassified'] },
    ],
    handoffs: [{
      handoffId: 'handoff-execution-to-review',
      fromAgentId: 'agent-execution',
      fromRole: 'execution',
      fromRoleDisplay: '执行',
      toAgentId: 'agent-review',
      toRole: 'review',
      toRoleDisplay: '审核',
      fromNodeId: 'pipeline.execute',
      toNodeId: 'settle',
      carrySummary: '结果与证据',
      payloadPreview: '执行结果摘要',
      notCarried: '未授权内容',
      occurredAt: '2026-10-05T12:00:04Z',
    }],
    selectedNode: withDrawer ? detail : undefined,
    rules: {
      keyboardFocus: ['nodes are buttons', 'drawer focus moves to selected node', 'drawer close returns focus to trigger', 'breadcrumb return keeps the path visible'],
      narrowWidth: ['single-column layout', 'nodes before drawer', 'evidence previews first'],
      mobileOrder: 'single-column',
      drawer: 'read-only-modal',
      readOnly: true,
    },
  }
}

function mimeType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'application/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.png': return 'image/png'
    default: return 'application/octet-stream'
  }
}

// The observation page now also mounts the shared read-only semantic panel from
// the runtime's public semantic GET. A terminal envelope keeps the proof
// subscription-free while still exercising the real page wiring.
function semanticEnvelope(taskId) {
  const scope = {
    organId: { scope: 'organ', value: 'organ-observation' },
    taskId: { scope: 'task', value: taskId },
    operationId: { scope: 'operation', value: 'operation-observation-1' },
  }
  return {
    scope,
    projectionVersion: 'runtime-semantic-v1',
    sourceWatermark: 1,
    events: [{
      eventId: 'semantic-event-1',
      sourceId: 'source-semantic-event-1',
      type: 'task.created',
      scope,
      occurredAt: TIME,
      status: 'completed',
      summary: '任务已创建',
      payloadRef: 'asset://semantic-event-1',
      dataDigest: 'sha256:semantic-event-1',
      evidenceRefs: [],
    }],
    coverageIssues: [],
    pairing: [{
      groupId: 'semantic-group-1',
      kind: 'operation',
      scope,
      executionEpoch: 1,
      state: 'closed',
      eventRefs: [],
    }],
    capabilities: [{ capability: 'runtime-task-events', state: 'available' }],
  }
}

let mutationRequests = 0

async function startServer() {
  const server = createServer(async (request, response) => {
    request.socket.setKeepAlive(false)
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' && url.pathname.startsWith('/api/')) mutationRequests += 1
      if (url.pathname === '/api/runtime/status') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ mode: 'fake', state: 'ready', providerState: 'ready', connected: true }))
        return
      }
      const semanticMatch = /^\/api\/tasks\/([^/]+)\/semantic$/.exec(url.pathname)
      if (semanticMatch) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(semanticEnvelope(decodeURIComponent(semanticMatch[1]))))
        return
      }
      const observationMatch = /^\/api\/tasks\/([^/]+)\/observation$/.exec(url.pathname)
      if (observationMatch) {
        const taskId = decodeURIComponent(observationMatch[1])
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(observationProjection(
          url.searchParams.has('node'),
          taskId,
          url.searchParams.get('node'),
        )))
        return
      }
      const relative = decodeURIComponent(url.pathname === '/' ? '/observation.html' : url.pathname).replace(/^\/+/, '')
      if (!relative || relative.split('/').includes('..')) {
        response.writeHead(400)
        response.end('bad path')
        return
      }
      const filePath = resolve(uiRoot, relative)
      if (!filePath.startsWith(`${uiRoot}${sep}`)) {
        response.writeHead(403)
        response.end('forbidden')
        return
      }
      const body = await readFile(filePath)
      response.writeHead(200, { 'content-type': mimeType(filePath), 'content-length': body.byteLength })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('static server did not expose a TCP port')
  server.unref()
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server) {
  if (!server || !server.listening) return
  server.closeAllConnections?.()
  server.closeIdleConnections?.()
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
}

function technicalTokens(text) {
  return ['requestId', 'turnId', 'callId', 'digest', 'evidence', 'operationId', 'taskId', 'executionEpoch']
    .filter((token) => text.includes(token))
}

async function readDrawer(page) {
  return page.evaluate(() => {
    const drawer = document.querySelector('.node-drawer')
    const card = drawer?.querySelector('.iwc-card')
    const status = card?.querySelector('.iwc-status')
    const conversation = card?.querySelector('.iwc-panel--conversation')
    const trace = card?.querySelector('.iwc-panel--trace')
    const details = [...(card?.querySelectorAll('details') ?? [])]
    const traceRows = [...(trace?.querySelectorAll('.iwc-trace-row') ?? [])]
    const drawerRect = drawer?.getBoundingClientRect()
    return {
      drawerOpen: Boolean(drawer?.open),
      drawerRect: drawerRect
        ? { x: drawerRect.x, y: drawerRect.y, width: drawerRect.width, height: drawerRect.height, right: drawerRect.right, bottom: drawerRect.bottom }
        : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      cardMounted: Boolean(card),
      statusRendered: Boolean(status),
      conversationRendered: Boolean(conversation),
      traceRendered: Boolean(trace),
      statusText: status?.innerText ?? '',
      conversationText: conversation?.innerText ?? '',
      traceText: trace?.innerText ?? '',
      detailsText: details.map((node) => node.textContent ?? '').join('\n'),
      traceGroupCount: trace?.querySelectorAll('.iwc-trace-group').length ?? 0,
      traceGroupText: trace?.querySelector('.iwc-trace-group-head')?.innerText ?? '',
      turnGroups: [...(trace?.querySelectorAll('.iwc-trace-group') ?? [])].map((group) => ({
        turnKey: group.dataset.turnKey,
        turnId: group.dataset.turnId,
        chip: group.querySelector('.iwc-turn-id')?.textContent ?? '',
        chipTurnId: group.querySelector('.iwc-turn-id')?.dataset.turnId,
        unprojected: Boolean(group.querySelector('.iwc-turn-unprojected')),
        unprojectedText: group.querySelector('.iwc-turn-unprojected')?.textContent ?? '',
        rows: group.querySelectorAll('.iwc-trace-row').length,
      })),
      pairedRowText: traceRows.find((row) => row.dataset.callId === 'call-returned')?.innerText ?? '',
      pairedRowState: traceRows.find((row) => row.dataset.callId === 'call-returned')?.dataset.toolPaired ?? '',
      unpairedRowText: traceRows.find((row) => row.dataset.callId === 'call-unreturned')?.innerText ?? '',
      unpairedRowState: traceRows.find((row) => row.dataset.callId === 'call-unreturned')?.dataset.toolPaired ?? '',
      controlCount: drawer?.querySelectorAll('button[data-iwc-action="invoke"], form, [data-action="retry"], [data-action="stop"]').length ?? 0,
      prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    }
  })
}

async function readDefaultObservation(page) {
  return page.evaluate(() => {
    const textOf = (selector) => document.querySelector(selector)?.innerText ?? ''
    const nodes = [...document.querySelectorAll('.flow-node')].map((card) => ({
      nodeId: card.dataset.nodeId ?? '',
      state: card.dataset.state ?? '',
      chipText: card.querySelector('.state-chip')?.textContent ?? '',
      chipTone: card.querySelector('.state-chip')?.dataset.tone ?? '',
      metaText: card.querySelector('.flow-node-meta')?.innerText ?? '',
      laneLabel: card.closest('.agent-lane')?.querySelector('h3')?.textContent ?? '',
    }))
    return {
      headingText: textOf('.page-heading'),
      nextStepText: document.querySelector('[data-observation-next-step="true"]')?.textContent ?? '',
      catalogueTitle: textOf('.flow-section h2'),
      catalogueMeta: textOf('.flow-section .section-meta'),
      catalogueNote: document.querySelector('[data-catalogue-summary="true"]')?.textContent ?? '',
      chainText: textOf('.agent-chain'),
      chainChips: [...document.querySelectorAll('.chain-chip')].map((chip) => chip.innerText),
      laneHeads: [...document.querySelectorAll('.agent-lane-head')].map((head) => head.innerText),
      nodeText: nodes.map((node) => `${node.metaText} ${node.laneLabel}`).join('\n'),
      pageDefaultText: `${textOf('.page-heading')}\n${textOf('.agent-chain')}\n${textOf('.flow-section')}`,
      flowEdgeSvgCount: document.querySelectorAll('svg.flow-edges').length,
      flowEdgeListCount: document.querySelectorAll('.flow-edges-list').length,
      chainArrowCount: document.querySelectorAll('.chain-arrow').length,
      technicalTriggerCount: document.querySelectorAll('[data-observation-technical-trigger="true"]').length,
      nodes,
    }
  })
}

async function openObservationTechnicalDetail(page) {
  const trigger = page.locator('[data-observation-technical-trigger="true"]')
  if (await trigger.count() === 0) {
    return { present: false, open: false, rows: [], text: '', dialogCount: 0, rect: null, viewport: null }
  }
  await trigger.click()
  await page.waitForSelector('dialog[data-technical-detail="true"][open]', { timeout: 5000 }).catch(() => {})
  return page.evaluate(() => {
    const dialog = document.querySelector('dialog[data-technical-detail="true"][open]')
    const rect = dialog?.getBoundingClientRect()
    return {
      present: true,
      open: Boolean(dialog?.open),
      title: dialog?.querySelector('.shell-layer-title')?.textContent ?? '',
      rows: [...(dialog?.querySelectorAll('.draft-receipt > div') ?? [])].map((row) => ({
        label: row.querySelector('dt')?.textContent ?? '',
        value: row.querySelector('dd')?.textContent ?? '',
      })),
      text: dialog?.innerText ?? '',
      dialogCount: document.querySelectorAll('dialog.shell-layer[open]').length,
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  })
}

async function closeObservationTechnicalDetail(page, path) {
  if (path === 'escape') {
    await page.keyboard.press('Escape')
  } else {
    const close = page.locator('dialog[data-technical-detail="true"][open] .shell-layer-close')
    if (await close.count() > 0) await close.click()
  }
  await page.waitForTimeout(100)
  return page.evaluate(() => ({
    open: Boolean(document.querySelector('dialog[data-technical-detail="true"][open]')),
    triggerFocused: document.activeElement?.getAttribute('data-observation-technical-trigger') === 'true',
  }))
}

async function readNodeRefs(page) {
  await page.click('button[data-tab-id="refs"]')
  return page.evaluate(() => {
    const sheet = [...document.querySelectorAll('.drawer-section')]
      .find((section) => section.dataset.tabId === 'refs')
    return {
      present: Boolean(sheet),
      rows: sheet
        ? [...sheet.querySelectorAll('.drawer-facts > div')].map((cell) => ({
            label: cell.querySelector('dt')?.textContent ?? '',
            value: cell.querySelector('dd')?.textContent ?? '',
            empty: cell.querySelector('dd')?.dataset.empty === 'true',
          }))
        : [],
    }
  })
}

const checks = []
const observations = []
let failures = 0

function record(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail })
  if (!pass) failures += 1
}

function observe(name, value) {
  observations.push({ name, value })
}

const artifactDir = join(evidenceRoot, 'artifacts')
await mkdir(artifactDir, { recursive: true })
const browser = await playwright.chromium.launch({ headless: true })
let server
try {
  server = await startServer()
  const runs = [
    { label: 'desktop', viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' },
    { label: 'mobile', viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' },
    { label: 'reduced-motion', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' },
  ]

  for (const run of runs) {
    const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
    await page.goto(`${server.url}/observation.html?task=${TASK_ID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.flow-node[data-node-id="pipeline.execute"]', { timeout: 10000 })

    const defaultObservation = await readDefaultObservation(page)
    observe(`${run.label} default observation`, defaultObservation)
    record(
      `${run.label} default layer shows the provided next step`,
      defaultObservation.pageDefaultText.includes('下一步：真实投影样本')
        && defaultObservation.headingText.includes('真实投影样本'),
      defaultObservation.headingText,
    )
    record(
      `${run.label} default layer keeps machine diagnostics out`,
      !defaultObservation.pageDefaultText.includes('mode=fake')
        && !defaultObservation.pageDefaultText.includes('source=running')
        && !defaultObservation.pageDefaultText.includes('projection seq')
        && ROLE_PAIRS.every(({ raw }) => !defaultObservation.pageDefaultText.split(/\s+/).includes(raw)),
      defaultObservation.pageDefaultText,
    )
    record(
      `${run.label} catalogue is labelled as the fixed read-only system catalogue`,
      defaultObservation.catalogueTitle.includes('系统节点目录')
        && defaultObservation.catalogueMeta.includes('4 个系统节点')
        && defaultObservation.catalogueNote.trim().length > 0
        && !defaultObservation.catalogueNote.includes('只读观测样本'),
      {
        title: defaultObservation.catalogueTitle,
        meta: defaultObservation.catalogueMeta,
        note: defaultObservation.catalogueNote,
      },
    )
    record(
      `${run.label} no invented node edges or role chain arrows remain`,
      defaultObservation.flowEdgeSvgCount === 0
        && defaultObservation.flowEdgeListCount === 0
        && defaultObservation.chainArrowCount === 0,
      {
        svg: defaultObservation.flowEdgeSvgCount,
        list: defaultObservation.flowEdgeListCount,
        arrows: defaultObservation.chainArrowCount,
      },
    )
    const renderedStates = new Map(defaultObservation.nodes.map((node) => [node.nodeId, node]))
    const stateMismatches = Object.entries(SIMULTANEOUS_STATES)
      .map(([nodeId, expected]) => ({ nodeId, expected, rendered: renderedStates.get(nodeId) }))
      .filter(({ expected, rendered }) => rendered?.state !== expected.state
        || rendered?.chipText !== expected.label
        || rendered?.chipTone !== expected.tone)
    record(
      `${run.label} every card state and human label comes from its exact scope node`,
      stateMismatches.length === 0,
      stateMismatches,
    )
    record(
      `${run.label} default layer shows the exact supplied role and node attribution`,
      ROLE_PAIRS.every(({ raw, human }) => defaultObservation.chainChips.some((text) => text.includes(human) && !text.split(/\s+/).includes(raw)))
        && ROLE_PAIRS.every(({ raw, human }) => defaultObservation.laneHeads.some((text) => text.includes(human) && !text.split(/\s+/).includes(raw)))
        && defaultObservation.nodeText.includes('归属：执行')
        && !defaultObservation.nodeText.includes('归属：execution'),
      {
        chips: defaultObservation.chainChips,
        lanes: defaultObservation.laneHeads,
        nodes: defaultObservation.nodeText,
      },
    )

    const technical = await openObservationTechnicalDetail(page)
    observe(`${run.label} observation technical detail`, technical)
    const technicalRow = (label) => technical.rows.find((row) => row.label === label)?.value
    record(
      `${run.label} existing technical detail exposes diagnostics and exact role pairs`,
      technical.present
        && technical.open
        && technical.title === '观测技术详情'
        && technicalRow('mode') === 'fake'
        && technicalRow('source') === 'running'
        && technicalRow('scopeRef') === `task://${TASK_ID}/observation`
        && technicalRow('projectionSeq') === 'seq-12'
        && technicalRow('目录说明') === '只读观测样本'
        && ROLE_PAIRS.every(({ raw, human }) => technical.text.includes(`${human} / ${raw}`)),
      technical,
    )
    if (run.label === 'desktop' || run.label === 'mobile') {
      record(
        `${run.label} technical detail uses the existing docked or bottom drawer`,
        technical.rect !== null
          && (run.label === 'desktop'
            ? technical.rect.x > 0
              && technical.rect.y >= 0
              && technical.rect.height > 0
            : Math.abs(technical.viewport.height - technical.rect.bottom) <= 0.5)
          && technical.rect.x >= -0.5
          && technical.rect.right <= technical.viewport.width + 0.5,
        { rect: technical.rect, viewport: technical.viewport },
      )
    }
    const technicalClosed = await closeObservationTechnicalDetail(page, run.label === 'mobile' ? 'escape' : 'button')
    record(
      `${run.label} technical detail closes and returns focus to its trigger`,
      technicalClosed.open === false && technicalClosed.triggerFocused,
      technicalClosed,
    )

    const beforeRefs = await page.evaluate(() => ({
      open: Boolean(document.querySelector('.node-drawer')?.open),
      focusNode: document.activeElement?.getAttribute('data-node-id') ?? '',
    }))
    record(
      `${run.label} technical detail leaves the shared node surface interactive`,
      beforeRefs.open === false,
      beforeRefs,
    )
    await page.locator('.flow-node[data-node-id="pipeline.execute"]').click()
    try {
      await page.waitForSelector('.node-drawer[open] .iwc-card', { timeout: 5000 })
    } catch {
      // The red base has no shared card. The DOM read below records the gap.
    }
    await page.waitForTimeout(250)
    const drawer = await readDrawer(page)
    observe(`${run.label} drawer`, drawer)
    observe(`${run.label} page errors`, pageErrors)
    const semanticPanel = await page.evaluate(() => ({
      mounted: Boolean(document.querySelector('.semantic-observation')),
      contract: document.querySelector('.semantic-observation')?.dataset.contractVersion ?? '',
      modes: document.querySelectorAll('.so-mode').length,
      text: document.querySelector('.semantic-observation')?.innerText ?? '',
    }))
    observe(`${run.label} semantic panel`, semanticPanel)
    record(`${run.label} shared semantic observation panel mounts read-only`, semanticPanel.mounted && semanticPanel.contract === 'semantic-observation-view@1' && semanticPanel.modes === 4 && semanticPanel.text.includes('任务已创建'), semanticPanel)
    record(`${run.label} shared status/conversation/trace card`, drawer.statusRendered && drawer.conversationRendered && drawer.traceRendered, drawer)
    record(`${run.label} conversation contains real activity and conclusion`, drawer.conversationText.includes('已接收执行请求') && drawer.conversationText.includes('执行完成'), drawer.conversationText)
    const realTurnGroups = drawer.turnGroups.filter((group) => group.turnKey === REAL_TURN_ID)
    const unprojectedGroups = drawer.turnGroups.filter((group) => group.unprojected)
    record(
      `${run.label} drawer displays the real provider turn id as the group label`,
      realTurnGroups.length === 1
        && realTurnGroups[0].turnId === REAL_TURN_ID
        && realTurnGroups[0].chipTurnId === REAL_TURN_ID
        && realTurnGroups[0].chip === `轮次 ${REAL_TURN_ID}`
        && realTurnGroups[0].unprojected === false
        && realTurnGroups[0].rows === 3,
      drawer.turnGroups,
    )
    record(
      `${run.label} real turn group never claims the unprojected state`,
      realTurnGroups.length === 1 && realTurnGroups[0].unprojectedText === '',
      drawer.turnGroups,
    )
    record(
      `${run.label} event without a provider turn shows the explicit no-turn state`,
      unprojectedGroups.length === 1
        && unprojectedGroups[0].turnKey === '__no-turn-identity__'
        && unprojectedGroups[0].turnId === undefined
        && unprojectedGroups[0].unprojectedText.includes('轮次未投影')
        && unprojectedGroups[0].rows === 3,
      drawer.turnGroups,
    )
    record(
      `${run.label} no turn group is labelled with a fabricated ordinal turn`,
      drawer.turnGroups.every((group) => group.chip === '' || !/^轮次 \d+$/.test(group.chip)),
      drawer.turnGroups.map((group) => group.chip),
    )
    record(`${run.label} trace has second-level time and categories`, /\d{2}:\d{2}:\d{2}/.test(drawer.traceText) && ['状态', '结论', '工具调用', '模型请求'].every((label) => drawer.traceText.includes(label)), drawer.traceText)
    record(`${run.label} paired call and result render in one item`, drawer.pairedRowState === 'true' && drawer.pairedRowText.includes('调用与返回已配对'), drawer.pairedRowText)
    record(`${run.label} unpaired call is explicitly not returned`, drawer.unpairedRowState === 'false' && drawer.unpairedRowText.includes('调用未返回'), drawer.unpairedRowText)
    record(`${run.label} human status and conversation keep technical ids out`, technicalTokens(`${drawer.statusText}\n${drawer.conversationText}`).length === 0, technicalTokens(`${drawer.statusText}\n${drawer.conversationText}`))
    record(`${run.label} folded detail keeps callId and returned evidence`, drawer.detailsText.includes('callId') && drawer.detailsText.includes('returned'), drawer.detailsText)
    record(`${run.label} drawer contains no executable control`, drawer.controlCount === 0, drawer.controlCount)
    const refs = await readNodeRefs(page)
    observe(`${run.label} selected node refs`, refs)
    const refValues = Object.fromEntries(refs.rows.map((row) => [row.label, row]))
    record(
      `${run.label} refs show the exact selected node inputs, outputs and evidence`,
      refs.present
        && refValues['输入引用']?.value === EXPECTED_REFS.inputs.join(', ')
        && refValues['输出引用']?.value === EXPECTED_REFS.outputs.join(', ')
        && refValues.Evidence?.value === EXPECTED_REFS.evidence.join(', ')
        && refs.rows.every((row) => !row.empty),
      refs,
    )
    if (run.label === 'desktop') {
      record(
        `${run.label} drawer docks to the right with the project inset`,
        drawer.drawerRect !== null
          && Math.abs(drawer.viewport.width - drawer.drawerRect.right - 16) <= 0.5
          && Math.abs(drawer.drawerRect.y - 16) <= 0.5
          && drawer.drawerRect.width <= 500.5
          && drawer.drawerRect.bottom <= drawer.viewport.height - 16 + 0.5,
        { rect: drawer.drawerRect, viewport: drawer.viewport },
      )
    }
    if (run.label === 'mobile') {
      record(
        `${run.label} drawer stays bottom-anchored without horizontal overflow`,
        drawer.drawerRect !== null
          && Math.abs(drawer.viewport.height - drawer.drawerRect.bottom) <= 0.5
          && drawer.drawerRect.x >= -0.5
          && drawer.drawerRect.right <= drawer.viewport.width + 0.5,
        { rect: drawer.drawerRect, viewport: drawer.viewport },
      )
    }
    if (run.reducedMotion === 'reduce') {
      record(
        `${run.label} keeps the drawer usable with reduced motion`,
        drawer.drawerOpen && drawer.prefersReducedMotion,
        { open: drawer.drawerOpen, reduced: drawer.prefersReducedMotion },
      )
    }
    await page.screenshot({ path: join(artifactDir, `${run.label}-drawer.png`), fullPage: false })

    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    const closed = await page.evaluate(() => ({
      open: Boolean(document.querySelector('.node-drawer')?.open),
      focusNode: document.activeElement?.getAttribute('data-node-id') ?? '',
    }))
    record(`${run.label} Escape closes and returns focus to trigger`, closed.open === false && closed.focusNode === 'pipeline.execute', closed)
    if (run.label === 'desktop') {
      // The four-corner chooser must drive the real panel, not only its own
      // pressed state. A pure mode switch may not re-read the observation.
      await page.locator('button[data-shell-section="view"]').click()
      await page.locator('button[data-display-mode="raw"]').click()
      await page.waitForFunction(() => document.querySelector('.semantic-observation')?.dataset.mode === 'raw', undefined, { timeout: 5000 }).catch(() => {})
      const switched = await page.evaluate(() => {
        const panel = document.querySelector('.semantic-observation')
        return {
          mode: panel?.dataset.mode ?? '',
          pressed: panel?.querySelector('.so-mode[data-semantic-mode="raw"]')?.getAttribute('aria-pressed') ?? '',
          body: panel?.innerText ?? '',
        }
      })
      record('desktop four-corner switch drives the panel mode and body', switched.mode === 'raw' && switched.pressed === 'true' && switched.body.includes('原始记录'), switched)
      await page.locator('.shell-layer-close:visible').click()
    }
    await context.close()
  }

  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
    await page.goto(`${server.url}/observation.html?task=${MISSING_STATE_TASK_ID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.flow-node[data-node-id="settle"]', { timeout: 10000 })
    const missingState = await readDefaultObservation(page)
    const settle = missingState.nodes.find((node) => node.nodeId === 'settle')
    observe('missing state observation', { page: missingState, pageErrors })
    record(
      'missing scope state stays unknown and uses the human unknown label',
      settle?.state === 'unknown' && settle?.chipText === '未知' && settle?.chipTone === 'gray',
      settle,
    )
    await page.locator('.flow-node[data-node-id="pipeline.execute"]').click()
    try {
      await page.waitForSelector('.node-drawer[open] .iwc-card', { timeout: 5000 })
    } catch {}
    const emptyRefs = await readNodeRefs(page)
    observe('missing and empty selected node refs', emptyRefs)
    record(
      'three empty selected node refs stay explicit',
      emptyRefs.present
        && emptyRefs.rows.length === 3
        && emptyRefs.rows.every((row) => row.empty)
        && emptyRefs.rows.map((row) => row.value).join('|') === '无输入引用|无输出引用|无 evidence',
      emptyRefs,
    )
    record('missing state page raises no script error', pageErrors.length === 0, pageErrors)
    await context.close()
  }
  record('observation page issues no mutation request', mutationRequests === 0, mutationRequests)
} finally {
  await closeServer(server)
  await browser.close()
}

await writeFile(join(evidenceRoot, 'checks.json'), `${JSON.stringify({ uiRoot, checks, observations }, null, 2)}\n`)
if (failures > 0) {
  console.error(`${failures} observation drawer browser checks failed`)
  process.exitCode = 1
} else {
  console.log('observation drawer browser checks passed')
}
