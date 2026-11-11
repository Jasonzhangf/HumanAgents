#!/usr/bin/env node
/**
 * Isolated real-frontend proof for the task dashboard stream stability.
 *
 * The page under test is the real docs/ui/task-dashboard.js, served byte for
 * byte from docs/ui. The harness serves the real page plus a controlled SSE
 * endpoint that replays the operation history when a connection has no
 * Last-Event-ID, exactly like the runtime streamEvents replay in
 * packages/app/src/ui-runtime/server.ts.
 *
 * This makes the pre-fix failure observable: every streamed event drives a
 * refresh, the refresh tears down and reopens the EventSource for the same
 * operation, and the reopened stream replays the whole history again. The
 * harness records dashboard reads and SSE connection opens, and fails if the
 * page exceeds a bounded number of either while a running operation streams.
 *
 * Env:
 *   TASK_DASHBOARD_STORM_EVIDENCE  required: evidence directory
 *   TASK_DASHBOARD_STORM_PLAYWRIGHT default /opt/homebrew/lib/node_modules/playwright/index.js
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = join(repoRoot, 'docs', 'ui')
const evidenceRoot = process.env.TASK_DASHBOARD_STORM_EVIDENCE?.trim()
if (!evidenceRoot) throw new Error('TASK_DASHBOARD_STORM_EVIDENCE is required')
await mkdir(evidenceRoot, { recursive: true })

const playwrightModule = await import(
  process.env.TASK_DASHBOARD_STORM_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule

const taskId = 'storm-fixture-task'
const operationId = 'storm-fixture-operation'
const streamIntervalMs = 120
const observeWindowMs = 2200
const maxDashboardReads = 15
const maxEventConnections = 3

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail ?? null })
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function dashboardBody() {
  return {
    surface: 'runtime-task-dashboard',
    mode: 'fake',
    taskId: { scope: 'task', value: taskId },
    taskTitle: '流稳定性夹具任务',
    state: 'running',
    stateLabel: '运行中',
    currentNode: 'provider.model',
    input: '持续输出直到完成',
    output: null,
    statusSections: { business: '运行中', waiting: '尚无执行等待信息' },
    recentEvents: [],
    history: { events: [], hasMore: false, omitted: 0, gap: false, total: 0 },
    publicOutput: null,
    nextStep: '等待执行完成',
    operationId,
    executionEpoch: 1,
    allowedActions: [],
    observationRef: `task://${taskId}/observation`,
    taskPlanHistory: {
      ok: false,
      failure: {
        code: 'task-plan-history.not-composed',
        ownerId: 'humanagent.ui.projection.runtime',
        message: '本次验收不读取任务计划历史',
        nextAction: '只核对执行事件流稳定性',
      },
    },
  }
}

function writeJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

/** Counters shared by the HTTP server and the assertion phase. */
const counts = {
  dashboardReads: 0,
  eventConnections: 0,
  storm: false,
}

// The single live operation history. Every connection without Last-Event-ID
// replays from the first event; a connection with Last-Event-ID replays only
// the events after that id, mirroring runtime subscribeReplay.
const operationEvents = []
const openSseConnections = new Set()

function sseFrame(event) {
  return `id: ${event.eventId}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
}

function pushOperationEvent() {
  const seq = operationEvents.length + 1
  operationEvents.push({
    eventId: `${operationId}-${seq}`,
    seq,
    kind: 'provider.model',
    taskId: { scope: 'task', value: taskId },
    operationId,
    executionEpoch: 1,
    summary: 'provider provided model reasoning',
  })
  const frame = sseFrame(operationEvents.at(-1))
  for (const res of openSseConnections) {
    if (!res.writableEnded) res.write(frame)
  }
}

function serveEvents(req, res) {
  counts.eventConnections += 1
  if (counts.eventConnections > 400) {
    counts.storm = true
    res.writeHead(503).end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const lastEventId = req.headers['last-event-id']
  const startIndex = typeof lastEventId === 'string' && lastEventId !== ''
    ? operationEvents.findIndex((event) => event.eventId === lastEventId) + 1
    : 0
  for (const event of operationEvents.slice(Math.max(0, startIndex))) {
    if (!res.writableEnded) res.write(sseFrame(event))
  }
  openSseConnections.add(res)
  const keepalive = setInterval(() => {
    if (res.writableEnded) return
    try { res.write(': keep-alive\n\n') } catch {}
  }, 1000)
  req.once('close', () => {
    openSseConnections.delete(res)
    clearInterval(keepalive)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/api/runtime/status') {
    return writeJson(res, 200, { mode: 'fake', state: 'ready', providerState: 'ready', connected: true })
  }
  if (url.pathname === '/api/ui/display-preference') {
    return writeJson(res, 200, { preference: { mode: 'follow-last', lastManual: 'current' }, defaultMode: 'current' })
  }
  if (url.pathname === `/api/tasks/${taskId}/dashboard`) {
    counts.dashboardReads += 1
    if (counts.dashboardReads > 400) counts.storm = true
    return writeJson(res, 200, dashboardBody())
  }
  if (url.pathname === `/api/executions/${operationId}/events`) {
    return serveEvents(req, res)
  }
  if (url.pathname === '/api/product/session') return writeJson(res, 200, { messages: [] })
  if (url.pathname === '/api/product/output') return writeJson(res, 200, { publication: null, commits: [] })
  if (url.pathname === '/api/product/relations') return writeJson(res, 200, { relations: [], gaps: [] })
  if (url.pathname === '/api/product/decision') return writeJson(res, 200, { decisions: [] })
  if (url.pathname === '/api/product/board') return writeJson(res, 200, { boardIndex: { boards: [] }, failures: [] })

  // Static assets from the real docs/ui directory.
  const pathname = url.pathname === '/' ? '/task-dashboard.html' : url.pathname
  const filePath = join(uiRoot, pathname)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
    res.writeHead(200, { 'content-type': mime[extname(filePath)] ?? 'application/octet-stream' })
    createReadStream(filePath).pipe(res)
  } catch {
    res.writeHead(404).end('not found')
  }
})

await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`

let browser
let page
const consoleErrors = []
try {
  // Prime a short history before the page connects so the replay path is real.
  for (let index = 0; index < 4; index += 1) pushOperationEvent()
  const streamTimer = setInterval(pushOperationEvent, streamIntervalMs)

  browser = await playwright.chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

  const query = new URLSearchParams({ task: taskId, projectKey: 'fixture-project', mode: 'fake' })
  await page.goto(`${baseUrl}/task-dashboard.html?${query}`, { waitUntil: 'load', timeout: 45_000 })
  await page.waitForTimeout(observeWindowMs)

  clearInterval(streamTimer)

  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '')
  check('dashboard read count stays bounded', counts.dashboardReads <= maxDashboardReads, {
    dashboardReads: counts.dashboardReads,
    maxDashboardReads,
  })
  check('execution stream uses a single live connection', counts.eventConnections <= maxEventConnections, {
    eventConnections: counts.eventConnections,
    maxEventConnections,
  })
  check('no resource-storm trip fired', counts.storm === false, { storm: counts.storm })
  check(
    'dashboard page stays readable',
    bodyText.includes('运行中') && !bodyText.includes('这次读取没有成功'),
    { bodyText: bodyText.slice(0, 200) },
  )
  check('no repeated console resource errors', consoleErrors.filter((entry) => entry.includes('ERR_INSUFFICIENT_RESOURCES')).length === 0, {
    consoleErrorCount: consoleErrors.length,
  })
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const res of openSseConnections) if (!res.writableEnded) res.end()
  await new Promise((resolveClose) => server.close(resolveClose))
}

const failures = checks.filter((entry) => !entry.pass)
const summary = {
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  evidenceRoot,
  baseUrl,
  ...counts,
  consoleErrors,
  checks,
  failures,
}
await writeFile(join(evidenceRoot, 'stream-storm-evidence.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({
  status: summary.status,
  evidenceRoot,
  baseUrl,
  dashboardReads: counts.dashboardReads,
  eventConnections: counts.eventConnections,
  storm: counts.storm,
  consoleErrorCount: consoleErrors.length,
  failures,
}, null, 2))
if (failures.length > 0) process.exitCode = 1
