#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = resolve(process.env.HUMANAGENT_UI_ROOT ?? join(repoRoot, 'docs', 'ui'))
const evidenceRoot = process.env.HUMANAGENT_UI_EVIDENCE?.trim()
const proofOrigin = 'http://humanagent.memory-layout.test'
const projectKey = 'fixture-project'
const mode = 'fake'

const playwrightModule = await import(
  process.env.HUMANAGENT_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule

const runtimeStatus = {
  mode,
  state: 'ready',
  providerState: 'ready',
  connected: true,
  projectKey,
}

const projectRead = {
  surface: 'runtime-project',
  scope: { kind: 'project', projectKey },
  label: 'fixture-project',
  observedAt: '2026-11-10T12:00:00.000Z',
  tasks: [
    {
      scope: {
        kind: 'task',
        projectKey,
        mode,
        taskId: { scope: 'task', value: 'task-fixture-1' },
      },
      task: {
        taskId: { scope: 'task', value: 'task-fixture-1' },
        semanticTitle: '移动端设置控件不应覆盖任务正文',
        state: 'created',
        stateLabel: '已创建',
        currentState: '等待处理',
        nextStep: '查看任务详情',
        updatedAt: '2026-11-10T12:00:00.000Z',
        taskFlow: { kind: 'one-shot', definitionVersion: 1 },
      },
      basis: 'durable-history',
    },
  ],
  taskCount: 1,
  complete: true,
}

const memorySummary = {
  analysis: { mode: 'deterministic', state: 'idle' },
  autoUpdate: false,
  skillCandidates: [],
}

const productBoard = {
  scope: { kind: 'project', projectKey },
  observedAt: '2026-11-10T12:00:00.000Z',
  boards: [
    {
      board: 'memory',
      live: [],
      history: [],
      unknown: [],
      failures: [
        {
          code: 'memory.session-source-unavailable',
          ownerId: 'humanagent.app.ui-runtime.product-session-read',
          message: 'no declared memory-agent session reader exists; memory review candidates are not sessions',
          nextAction: 'bind a real memory session reader before enumerating the memory board',
        },
      ],
    },
  ],
}

function mimeType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs': return 'application/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

function jsonBody(value) {
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) }
}

async function installRoutes(context, requests) {
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== proofOrigin) {
      await route.continue()
      return
    }

    if (url.pathname === '/api/runtime/status') {
      requests.push(`${request.method()} ${url.pathname}`)
      await route.fulfill(jsonBody(runtimeStatus))
      return
    }
    if (url.pathname === '/api/dashboard' && url.searchParams.get('scope') === 'project') {
      requests.push(`${request.method()} ${url.pathname}?${url.searchParams}`)
      await route.fulfill(jsonBody(projectRead))
      return
    }
    if (url.pathname === '/api/product/board') {
      requests.push(`${request.method()} ${url.pathname}?${url.searchParams}`)
      await route.fulfill(jsonBody(productBoard))
      return
    }
    if (url.pathname === '/api/memory/summary') {
      requests.push(`${request.method()} ${url.pathname}?${url.searchParams}`)
      await route.fulfill(jsonBody(memorySummary))
      return
    }
    if (url.pathname.startsWith('/api/')) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          error: {
            code: 'fixture.route.missing',
            ownerId: 'fixture',
            message: `${request.method()} ${url.pathname}`,
            nextAction: 'add the fixture route',
          },
        }),
      })
      return
    }

    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '')
    const filePath = resolve(uiRoot, relative)
    if (relative.split('/').includes('..') || !filePath.startsWith(`${uiRoot}${sep}`)) {
      await route.fulfill({ status: 403, body: 'forbidden' })
      return
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: mimeType(filePath),
        body: await readFile(filePath),
      })
    } catch {
      await route.fulfill({ status: 404, body: 'not found' })
    }
  })
}

function overlapProbe() {
  const visible = (node) => {
    if (!(node instanceof Element)) return false
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return rect.width > 0
      && rect.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0
  }
  const intersects = (left, right) => (
    left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top
  )
  const corners = [...document.querySelectorAll('[data-shell-corner]')]
    .filter(visible)
    .map((node) => ({
      label: node.textContent?.trim() || node.getAttribute('aria-label') || '',
      rect: node.getBoundingClientRect().toJSON(),
    }))
  const textOverlaps = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let textNode
  while ((textNode = walker.nextNode())) {
    if (!textNode.textContent?.trim()) continue
    const parent = textNode.parentElement
    if (!parent || parent.closest('.shell-controls, dialog, [hidden], [aria-hidden="true"]')) continue
    if (!visible(parent)) continue
    const range = document.createRange()
    range.selectNodeContents(textNode)
    for (const textRect of range.getClientRects()) {
      if (textRect.width <= 0 || textRect.height <= 0) continue
      const hit = corners.find((corner) => intersects(textRect, corner.rect))
      if (!hit) continue
      textOverlaps.push({
        text: textNode.textContent.trim().slice(0, 120),
        textRect: textRect.toJSON(),
        corner: hit.label,
        cornerRect: hit.rect,
      })
    }
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    scrollY: window.scrollY,
    corners,
    textOverlaps,
  }
}

async function waitForPageReady(page, selector) {
  await page.waitForSelector(selector, { timeout: 10_000 })
  await page.waitForTimeout(250)
}

const browser = await playwright.chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] })
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const requests = []
const consoleMessages = []
const pageErrors = []
const checks = []

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail ?? null })
}

try {
  await installRoutes(context, requests)
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleMessages.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.goto(
    `${proofOrigin}/memory.html?projectKey=${encodeURIComponent(projectKey)}&mode=${mode}`,
    { waitUntil: 'domcontentloaded' },
  )
  await waitForPageReady(page, '[data-memory-section="analysis"]')
  const memoryText = await page.locator('body').innerText()
  check(
    'Memory page has no unavailable-session dead face',
    !memoryText.includes('session 来源不可用')
      && !memoryText.includes('no declared memory-agent session reader exists')
      && !memoryText.includes('bind a real memory session reader'),
    memoryText,
  )

  const overlapPages = [
    { name: 'Task List', url: `${proofOrigin}/tasks.html?projectKey=${encodeURIComponent(projectKey)}`, ready: '.task-item' },
    { name: 'Memory', url: `${proofOrigin}/memory.html?projectKey=${encodeURIComponent(projectKey)}&mode=${mode}`, ready: '[data-memory-section="analysis"]' },
  ]
  const overlapReceipts = []
  for (const target of overlapPages) {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' })
    await waitForPageReady(page, target.ready)
    const scrollSteps = await page.evaluate(() => {
      const max = Math.max(0, document.documentElement.scrollHeight - innerHeight)
      return [...new Set([0, Math.round(max * 0.25), Math.round(max * 0.5), Math.round(max * 0.75), max])]
    })
    for (const scrollY of scrollSteps) {
      await page.evaluate((top) => window.scrollTo(0, top), scrollY)
      await page.waitForTimeout(50)
      const probe = await page.evaluate(overlapProbe)
      overlapReceipts.push({ page: target.name, ...probe })
    }
  }
  const textOverlaps = overlapReceipts.flatMap((receipt) => (
    receipt.textOverlaps.map((overlap) => ({ page: receipt.page, scrollY: receipt.scrollY, ...overlap }))
  ))
  check('floating settings controls do not overlap body text at 390x844', textOverlaps.length === 0, textOverlaps)
  check('focused browser proof has no page exception', pageErrors.length === 0, pageErrors)
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}

const failed = checks.filter((item) => !item.pass)
const receipt = {
  viewport: { width: 390, height: 844 },
  requests,
  consoleMessages,
  pageErrors,
  checks,
  pass: failed.length === 0,
}
if (evidenceRoot) {
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, 'focused-browser.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
if (failed.length > 0) process.exitCode = 1
