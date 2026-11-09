#!/usr/bin/env node

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = join(repoRoot, 'docs', 'ui')

const taskId = 'agent-filter-no-role-scope-fixture'
const canonicalRoles = ['interaction', 'orchestration', 'execution', 'review', 'memory']
const agentDebugInspections = canonicalRoles.map((agentRole) => ({
  agentRole,
  invocationStatus: 'not-invoked',
}))

const baseProjection = {
  scope: {
    scopeRef: `task://${taskId}/observation`,
    title: 'Agent filter no-role scope fixture',
    purpose: 'task',
    breadcrumbs: [],
  },
  data: { state: 'succeeded', label: '已完成', detail: '无角色范围浏览器验证。' },
  nodes: [],
  agentFrames: [],
  handoffs: [],
  agentDebugInspections,
}

const catalogProjection = {
  ...baseProjection,
  agentActivity: {
    ok: true,
    value: { mode: 'catalog', current: [], historical: [], unknown: [], unavailableSources: [] },
  },
}

const unroledNativeProjection = {
  ...baseProjection,
  agentActivity: {
    ok: true,
    value: {
      mode: 'selected',
      selectedRole: undefined,
      selected: [{
        instance: {
          kind: 'native-execution',
          runtimeId: 'unroled-native-runtime',
          executionEpoch: 1,
          assignmentId: 'unroled-native-assignment',
        },
      }],
      current: [],
      historical: [],
      unknown: [],
      unavailableSources: [],
    },
  },
}

const runtimeStatus = { mode: 'fake', state: 'ready', providerState: 'ready', connected: true }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function mimeType(filePath) {
  return MIME[extname(filePath)] ?? 'application/octet-stream'
}

function sendJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/api/runtime/status') {
      sendJson(res, runtimeStatus)
      return
    }
    if (url.pathname === `/api/tasks/${taskId}/observation`) {
      sendJson(res, url.searchParams.has('agentKind') ? unroledNativeProjection : catalogProjection)
      return
    }
    if (url.pathname === `/api/tasks/${taskId}/semantic`) {
      sendJson(res, { ok: true, value: { frames: [], observations: [] } })
      return
    }
    if (url.pathname === `/api/tasks/${taskId}/semantic/stream`) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end()
      return
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!relative || relative.split('/').includes('..')) {
      res.writeHead(400)
      res.end('bad path')
      return
    }
    const filePath = resolve(uiRoot, relative)
    if (!filePath.startsWith(`${uiRoot}${sep}`)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    try {
      const body = await readFile(filePath)
      res.writeHead(200, { 'content-type': mimeType(filePath) })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

const { server, origin } = await serve()
const playwrightModule = await import('/opt/homebrew/lib/node_modules/playwright/index.js')
const playwright = playwrightModule.default ?? playwrightModule
const browser = await playwright.chromium.launch({ headless: true })
let failures = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`${origin}/observation.html?task=${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.agent-debug-section')
  const catalogMarker = await page.locator('.agent-debug-section [data-agent-role-scope]').count()
  if (catalogMarker !== 0) failures.push('catalog view rendered an agent role scope marker')

  await page.goto(
    `${origin}/observation.html?task=${encodeURIComponent(taskId)}`
    + `&agentKind=native-execution`
    + `&agentRuntimeId=unroled-native-runtime`
    + `&agentExecutionEpoch=1`
    + `&agentAssignmentId=unroled-native-assignment`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForSelector('.agent-debug-section')
  const marker = page.locator('.agent-debug-section [data-agent-role-scope="unscoped-native"]')
  const markerCount = await marker.count()
  if (markerCount !== 1) failures.push(`unroled native view rendered ${markerCount} no-role markers, expected 1`)
  if (markerCount === 1) {
    const text = await marker.first().textContent()
    if (!text.startsWith('无角色范围')) failures.push(`no-role marker text was ${JSON.stringify(text)}`)
  }
  const cardCount = await page.locator('.agent-debug-section .agent-debug-card').count()
  if (cardCount !== 5) failures.push(`unroled native view rendered ${cardCount} debug cards, expected 5`)
  if (pageErrors.length > 0) failures.push(`browser errors: ${pageErrors.join('; ')}`)
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, catalogMarker: 0, marker: 'unscoped-native', cardCount: 5 }, null, 2))
