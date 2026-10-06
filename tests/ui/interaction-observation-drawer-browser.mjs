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
const TIME = '2026-10-05T12:00:00Z'
// The turn identity the provider binding reported for this node. The proof
// asserts the drawer displays this literal id, not an ordinal.
const REAL_TURN_ID = 'turn-3c7d1f8a-52b4-4e19-8a60-1d9f4b2c7e35'

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

function selectedNode() {
  return {
    nodeId: 'pipeline.execute',
    title: '执行流水线',
    kindDisplay: '执行',
    stateDisplay: '运行中',
    owner: 'agent-execution',
    ownerAgentRole: 'execution',
    roleDisplay: '执行',
    iteration: 2,
    updatedAt: '2026-10-05T12:00:05Z',
    // The provider binding reported this turn id for the node's real events.
    turnId: REAL_TURN_ID,
    summary: '执行完成，输出已投影。',
    inputs: [{ ref: 'operation://operation-observation/input', label: '执行输入' }],
    outputs: [{ ref: 'artifact://observation-result', label: '结果' }],
    evidenceRefs: [evidenceRef('evidence:ev-observation')],
    activity: [
      { activityRef: 'activity:receive', summary: '已接收执行请求', occurredAt: '2026-10-05T12:00:00Z', turnId: REAL_TURN_ID },
      // The runtime's own settling activity carries no provider turn; it must
      // show the explicit no-turn state instead of a fabricated number.
      { activityRef: 'activity:return', summary: 'provider 返回结果', occurredAt: '2026-10-05T12:00:04Z' },
    ],
    toolSteps: [
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
    ],
    childScopeRef: `task://${TASK_ID}/observation/pipeline.execute`,
    feedback: [],
  }
}

function observationProjection(withDrawer) {
  const detail = selectedNode()
  return {
    surface: 'observation',
    state: 'running',
    data: { state: 'running', label: '运行中', detail: '真实投影样本' },
    scope: {
      scopeRef: `task://${TASK_ID}/observation`,
      title: '任务处理流水',
      summary: '只读观测样本',
      projectionSeq: 'seq-12',
      breadcrumbs: [{ ref: `task://${TASK_ID}/observation`, title: '任务处理流水' }],
      canReturn: false,
      nodes: [
        { nodeId: 'pipeline.execute', title: '执行流水线', state: 'running', stateDisplay: '运行中', kindDisplay: '执行', summary: '执行中', owner: 'agent-execution', updatedAt: TIME, hasChildScope: true, evidenceCount: 1 },
        { nodeId: 'settle', title: '收拢', state: 'running', stateDisplay: '收拢中', kindDisplay: '收拢', summary: '等待收拢', owner: 'agent-review', updatedAt: TIME, hasChildScope: false, evidenceCount: 0 },
      ],
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
        state: 'running',
      },
      {
        nodeId: 'settle',
        title: '收拢',
        row: 9,
        kindDisplay: '收拢',
        ownerAgentRole: 'review',
        roleDisplay: '审核',
        stateDisplay: '收拢中',
        iteration: 2,
        activity: [],
        summary: '等待收拢',
        updatedAt: TIME,
        toolSteps: [],
        state: 'running',
      },
    ],
    agentFrames: [
      { agentId: 'agent-execution', role: 'execution', roleDisplay: '执行', stateDisplay: '运行中', iteration: 2, nodeIds: ['pipeline.execute'] },
      { agentId: 'agent-review', role: 'review', roleDisplay: '审核', stateDisplay: '运行中', iteration: 2, nodeIds: ['settle'] },
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

async function startServer() {
  const server = createServer(async (request, response) => {
    request.socket.setKeepAlive(false)
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/runtime/status') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ mode: 'fake', state: 'ready', providerState: 'ready', connected: true }))
        return
      }
      const observationMatch = /^\/api\/tasks\/([^/]+)\/observation$/.exec(url.pathname)
      if (observationMatch) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify(observationProjection(url.searchParams.has('node'))))
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
    return {
      drawerOpen: Boolean(drawer?.open),
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
      reducedMotionEdge: getComputedStyle(document.querySelector('.flow-edge--active') ?? document.body).animationName,
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
    if (run.reducedMotion === 'reduce') {
      record(`${run.label} honors reduced motion`, drawer.reducedMotionEdge === 'none', drawer.reducedMotionEdge)
    }
    await page.screenshot({ path: join(artifactDir, `${run.label}-drawer.png`), fullPage: false })

    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    const closed = await page.evaluate(() => ({
      open: Boolean(document.querySelector('.node-drawer')?.open),
      focusNode: document.activeElement?.getAttribute('data-node-id') ?? '',
    }))
    record(`${run.label} Escape closes and returns focus to trigger`, closed.open === false && closed.focusNode === 'pipeline.execute', closed)
    await context.close()
  }
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
