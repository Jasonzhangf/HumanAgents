#!/usr/bin/env node

/**
 * Isolated real-frontend proof for the child task process view.
 *
 * The built HumanAgent CLI serves the built UI from its own isolated control
 * root on port 0. Playwright routes only the API reads to the committed leak
 * fixture, so the served product code performs the localization and
 * sanitization that this task changes.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeProductLocation } from '../../docs/ui/product-location.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cliPath = join(repoRoot, 'dist', 'app', 'app', 'src', 'cli.js')
const evidenceRoot = resolve(process.env.PROCESS_VIEW_EVIDENCE
  ?? join(repoRoot, 'docs', 'evidence', 'p1-process-view-leak-sanitization-20261110', 'browser'))
const fixturePath = join(repoRoot, 'tests', 'ui', 'fixtures', 'process-view-leak-sanitization.json')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const internalFields = [
  'runtime-task-event',
  'provider.model',
  'provider provided model reasoning',
  'provider prepared model output',
  'provider request settled',
  'execution.terminal',
  'execution.settling',
  'checkpoint.committed',
  '步骤 27',
  'provider-c649f1a4a7afab07-tool-result-output-provider-tool-result-call-8353380d-f165-4feb-bab8-d7976611ff6c',
]

await mkdir(evidenceRoot, { recursive: true })

const playwrightModule = await import(
  process.env.PROCESS_VIEW_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule

const tempRoot = await mkdtemp(join(tmpdir(), 'humanagent-process-view-'))
const workspace = join(tempRoot, 'workspace')
const controlRoot = join(tempRoot, 'control')
await mkdir(workspace, { recursive: true })
await mkdir(controlRoot, { recursive: true })

const checks = []
const observations = []
const consoleMessages = []
const network = []

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail ?? null })
}

function observe(name, value) {
  observations.push({ name, value })
}

function dashboardBody() {
  return {
    surface: 'runtime-task-dashboard',
    mode: 'fake',
    taskId: fixture.taskId,
    taskTitle: '进程视图脱敏',
    state: 'failed',
    stateLabel: '失败',
    currentNode: 'execution.terminal',
    input: '检查进程输出',
    output: fixture.failureOutput,
    statusSections: { business: '失败', waiting: '尚无执行等待信息' },
    recentEvents: fixture.recentEvents,
    history: {
      events: fixture.recentEvents,
      hasMore: false,
      omitted: 0,
      gap: false,
      total: fixture.recentEvents.length,
    },
    publicOutput: fixture.publicOutput,
    nextStep: '查看失败原因',
    operationId: 'fixture-operation',
    executionEpoch: 1,
    allowedActions: [],
    observationRef: `task://${fixture.taskId.value}/observation`,
    taskPlanHistory: {
      ok: false,
      failure: {
        code: 'task-plan-history.not-composed',
        ownerId: 'humanagent.ui.projection.runtime',
        message: '本次验收不读取任务计划历史',
        nextAction: '只核对进程视图与公开输出',
      },
    },
  }
}

function requestBody(publication = fixture.publicOutput) {
  return {
    publication,
    commits: publication.commits,
    resultAvailable: publication.commits.length > 0,
  }
}

async function handleApi(route) {
  const request = route.request()
  const url = new URL(request.url())
  const method = request.method()
  let body
  let status = 200

  if (url.pathname === '/api/runtime/status') {
    body = { mode: 'fake', state: 'ready', providerState: 'ready', connected: true }
  } else if (url.pathname === '/api/ui/display-preference') {
    body = { preference: { mode: 'follow-last', lastManual: 'current' }, defaultMode: 'current' }
  } else if (url.pathname === `/api/tasks/${fixture.taskId.value}/dashboard`) {
    body = dashboardBody()
  } else if (url.pathname === '/api/product/session') {
    body = { messages: fixture.messages }
  } else if (url.pathname === '/api/product/output') {
    body = requestBody()
  } else if (url.pathname === '/api/product/relations') {
    body = { relations: [], gaps: [] }
  } else if (url.pathname === '/api/product/decision') {
    body = { decisions: [] }
  } else if (url.pathname === '/api/product/board') {
    body = { boardIndex: { boards: [] }, failures: [] }
  } else if (url.pathname.endsWith('/semantic/stream')) {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      body: 'event: semantic-complete\ndata: {}\n\n',
    })
    return
  } else if (url.pathname.endsWith('/semantic')) {
    status = 404
    body = {
      error: {
        code: 'semantic-observation.not-used',
        ownerId: 'p1-process-view-leak-sanitization',
        message: '本验收只读取进程视图与公开输出',
        nextAction: '无需处理',
      },
    }
  } else {
    status = 404
    body = {
      error: {
        code: 'fixture.route.missing',
        ownerId: 'p1-process-view-leak-sanitization',
        message: `fixture does not define ${method} ${url.pathname}`,
        nextAction: 'add the exact fixture route',
      },
    }
  }

  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  })
}

function startServe() {
  const child = spawn(process.execPath, [
    cliPath,
    'serve',
    '--provider', 'fake',
    '--workspace', workspace,
    '--control-root', controlRoot,
    '--port', '0',
  ], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`isolated serve did not report ready: ${stderr}`)), 60_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      const match = stdout.match(/\{[\s\S]*?\n\}/)
      if (!match) return
      try {
        const parsed = JSON.parse(match[0])
        clearTimeout(timer)
        resolveReady(parsed)
      } catch {}
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectReady(new Error(`isolated serve exited early (${code}): ${stderr}`))
    })
  })
  return {
    child,
    ready,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((done) => child.once('exit', done))
      child.kill('SIGTERM')
      await exited
    },
  }
}

async function waitForText(page, selector, timeout = 30_000) {
  await page.waitForFunction(
    (value) => {
      const node = document.querySelector(value)
      return Boolean(node && (node.textContent ?? '').trim())
    },
    selector,
    { timeout },
  )
}

function hasStandaloneAnswerMarker(text) {
  return /(?:^|\n)\s*回答\s*(?:\n|$)/u.test(text)
}

function assertCleanText(text, label) {
  for (const field of internalFields) {
    check(`${label} does not expose ${field}`, !String(text).includes(field), {
      field,
    })
  }
  check(`${label} does not expose the raw answer marker`, !hasStandaloneAnswerMarker(text))
  check(`${label} retains the real failure`, String(text).includes('执行失败：真实失败原因'))
  check(`${label} shows Chinese model progress`, String(text).includes('模型正在推理'))
  check(`${label} shows Chinese settlement progress`, String(text).includes('执行正在收拢'))
}

async function capture(page, name, viewport) {
  await page.setViewportSize(viewport)
  await page.waitForTimeout(500)
  const text = await page.evaluate(() => document.body.innerText)
  const allText = await page.evaluate(() => document.body.textContent ?? '')
  const details = await page.evaluate(() => [...document.querySelectorAll('details')].map((node) => ({
    summary: node.querySelector('summary')?.textContent ?? '',
    open: node.open,
  })))
  const shot = join(evidenceRoot, `${name}-${viewport.width}x${viewport.height}.png`)
  await page.screenshot({ path: shot, fullPage: true })
  assertCleanText(text, `${name} visible body`)
  assertCleanText(allText, `${name} complete DOM`)
  check(`${name} keeps the failed state visible`, /失败/u.test(text) && !/执行成功/u.test(text))
  check(`${name} does not show an ordinal step label`, !/步骤\s*\d+/u.test(allText))
  return { name, viewport, url: page.url(), text, allText, details, screenshot: shot }
}

let serve
let browser
let artifacts
let stopResult = 'not started'
try {
  serve = startServe()
  const startup = await serve.ready
  observe('startup', startup)
  await writeFile(join(evidenceRoot, 'startup.json'), JSON.stringify({
    pid: serve.child.pid,
    controlRoot,
    workspace,
    startup,
    stdout: serve.stdout(),
    stderr: serve.stderr(),
  }, null, 2))

  browser = await playwright.chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await context.route('**/api/**', handleApi)
  const page = await context.newPage()
  page.on('console', (message) => consoleMessages.push({
    type: message.type(),
    text: message.text(),
  }))
  page.on('pageerror', (error) => consoleMessages.push({
    type: 'pageerror',
    text: error.stack ?? error.message,
  }))
  page.on('response', (response) => {
    if (!response.url().includes('/api/')) return
    network.push({
      status: response.status(),
      method: response.request().method(),
      url: response.url(),
    })
  })

  const query = new URLSearchParams({
    task: fixture.taskId.value,
    projectKey: 'fixture-project',
    mode: 'fake',
  })
  const scope = {
    kind: 'task',
    projectKey: 'fixture-project',
    mode: 'fake',
    taskId: fixture.taskId,
  }
  const hash = encodeProductLocation({
    board: 'interaction',
    lane: 'live',
    focus: { kind: 'interaction', taskRef: fixture.taskId, scope },
    scope,
  })
  const url = `${startup.url}/task-dashboard.html?${query}${hash}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForText(page, '.product-session-message')
  await page.getByText('执行轨迹与只读观测', { exact: true }).click().catch(() => {})
  await page.waitForTimeout(500)

  const desktop = await capture(page, 'desktop-child-dashboard', { width: 1280, height: 720 })
  const mobile = await capture(page, 'mobile-child-dashboard', { width: 390, height: 844 })

  const pageErrors = consoleMessages.filter((entry) => entry.type === 'pageerror')
  check('real frontend produced no uncaught page error', pageErrors.length === 0, pageErrors)
  check('real frontend used the isolated CLI origin', url.startsWith(startup.url), { url, startupUrl: startup.url })

  artifacts = {
    startup,
    url,
    controlRoot,
    workspace,
    desktop,
    mobile,
    checks,
    observations,
    consoleMessages,
    network,
  }
} catch (error) {
  artifacts = {
    error: error?.stack ?? String(error),
    controlRoot,
    workspace,
    checks,
    observations,
    consoleMessages,
    network,
  }
} finally {
  if (browser) await browser.close().catch(() => {})
  if (serve) {
    try {
      await serve.stop()
      stopResult = `SIGTERM sent to isolated PID ${serve.child.pid}`
    } catch (error) {
      stopResult = `stop failed for isolated PID ${serve.child.pid}: ${error.message}`
    }
  }
  await rm(tempRoot, { recursive: true, force: true })
}

const failures = checks.filter((entry) => !entry.pass)
const summary = {
  status: failures.length === 0 && artifacts?.error === undefined ? 'PASS' : 'FAIL',
  evidenceRoot,
  stopResult,
  tempRootRemoved: true,
  failures,
  ...artifacts,
}
await writeFile(join(evidenceRoot, 'console.json'), JSON.stringify(consoleMessages, null, 2))
await writeFile(join(evidenceRoot, 'network.json'), JSON.stringify(network, null, 2))
await writeFile(join(evidenceRoot, 'browser-evidence.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({
  status: summary.status,
  evidenceRoot,
  screenshots: [artifacts?.desktop?.screenshot, artifacts?.mobile?.screenshot].filter(Boolean),
  failures,
  stopResult,
}, null, 2))
if (summary.status !== 'PASS') process.exitCode = 1
