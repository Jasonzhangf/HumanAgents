#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const baseUrl = process.env.HUMANAGENT_BASE_URL?.trim()
const pairCode = process.env.HUMANAGENT_PAIR_CODE?.trim()
const evidenceRoot = process.env.HUMANAGENT_UI_EVIDENCE?.trim()

if (!baseUrl) throw new Error('HUMANAGENT_BASE_URL is required')
if (!pairCode) throw new Error('HUMANAGENT_PAIR_CODE is required')
if (!evidenceRoot) throw new Error('HUMANAGENT_UI_EVIDENCE is required')

const origin = new URL(baseUrl).origin
const root = resolve(evidenceRoot)
const desktopViewport = { width: 1280, height: 720 }
const mobileViewport = { width: 390, height: 844 }
const bannedMemoryText = [
  'session 来源不可用',
  'no declared memory-agent session reader exists',
  'bind a real memory session reader',
]

const playwrightModule = await import(
  process.env.HUMANAGENT_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule
const browser = await playwright.chromium.launch({
  headless: true,
  args: ['--single-process', '--no-zygote'],
})
const context = await browser.newContext({ viewport: desktopViewport })
const page = await context.newPage()

const requests = []
const responses = []
const requestFailures = []
const consoleMessages = []
const pageErrors = []
const checks = []

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail ?? null })
}

page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.origin !== origin) return
  requests.push({
    method: request.method(),
    path: `${url.pathname}${url.search}`,
    resourceType: request.resourceType(),
  })
})
page.on('response', (response) => {
  const url = new URL(response.url())
  if (url.origin !== origin) return
  responses.push({
    path: `${url.pathname}${url.search}`,
    status: response.status(),
    contentType: response.headers()['content-type'] ?? null,
  })
})
page.on('requestfailed', (request) => {
  requestFailures.push({
    path: new URL(request.url()).pathname,
    error: request.failure()?.errorText ?? 'unknown',
  })
})
page.on('console', (message) => {
  if (message.type() === 'error') consoleMessages.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))

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

async function waitForReady(selector) {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(250)
}

async function clearScreenshotState() {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(50)
}

async function readMemoryText(label) {
  const text = await page.locator('body').innerText()
  const leaked = bannedMemoryText.filter((value) => text.includes(value))
  check(`${label} Memory page has no unavailable-session dead face`, leaked.length === 0, {
    leaked,
    text,
  })
  return text
}

async function mobileOverlapReceipt(label) {
  const scrollSteps = await page.evaluate(() => {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight)
    return [...new Set([0, Math.round(max * 0.25), Math.round(max * 0.5), Math.round(max * 0.75), max])]
  })
  const receipts = []
  for (const scrollY of scrollSteps) {
    await page.evaluate((top) => window.scrollTo(0, top), scrollY)
    await page.waitForTimeout(50)
    receipts.push(await page.evaluate(overlapProbe))
  }
  const overlaps = receipts.flatMap((receipt) => (
    receipt.textOverlaps.map((overlap) => ({ ...overlap, scrollY: receipt.scrollY }))
  ))
  check(`${label} has four visible settings controls`, receipts.every((receipt) => receipt.corners.length === 4), receipts)
  check(`${label} body text is not covered by floating settings controls`, overlaps.length === 0, overlaps)
  return { scrollSteps, receipts, overlaps }
}

const receipt = {
  baseUrl,
  desktopViewport,
  mobileViewport,
  pair: null,
  screenshots: {},
  mobile: {},
  checks,
  requests,
  responses,
  requestFailures,
  consoleMessages,
  pageErrors,
  pass: false,
}

try {
  await mkdir(root, { recursive: true })
  const pairResponse = await context.request.post(`${origin}/api/auth/pair`, {
    failOnStatusCode: false,
    headers: {
      'content-type': 'application/json',
      origin,
    },
    data: { code: pairCode },
  })
  const pairBody = await pairResponse.json().catch(() => ({}))
  receipt.pair = {
    status: pairResponse.status(),
    authenticated: pairBody.authenticated === true,
  }
  check(
    'real browser pairing succeeded',
    receipt.pair.status === 200 && receipt.pair.authenticated === true,
    receipt.pair,
  )

  await page.setViewportSize(desktopViewport)
  await page.goto(`${origin}/memory.html`, { waitUntil: 'domcontentloaded' })
  await waitForReady('[data-memory-section="analysis"]')
  await readMemoryText('desktop 1280x720')
  await clearScreenshotState()
  receipt.screenshots.memoryDesktop = join(root, 'memory-desktop-1280x720.png')
  await page.screenshot({ path: receipt.screenshots.memoryDesktop, fullPage: true })

  await page.setViewportSize(mobileViewport)
  await page.goto(`${origin}/tasks.html`, { waitUntil: 'domcontentloaded' })
  await waitForReady('.task-lists')
  receipt.mobile.taskList = await mobileOverlapReceipt('mobile 390x844 Task List')
  await clearScreenshotState()
  receipt.screenshots.tasksMobile = join(root, 'tasks-mobile-390x844.png')
  await page.screenshot({ path: receipt.screenshots.tasksMobile, fullPage: true })

  await page.goto(`${origin}/memory.html`, { waitUntil: 'domcontentloaded' })
  await waitForReady('[data-memory-section="analysis"]')
  await readMemoryText('mobile 390x844')
  receipt.mobile.memory = await mobileOverlapReceipt('mobile 390x844 Memory')
  await clearScreenshotState()
  receipt.screenshots.memoryMobile = join(root, 'memory-mobile-390x844.png')
  await page.screenshot({ path: receipt.screenshots.memoryMobile, fullPage: true })

  check('real frontend has no request failures', requestFailures.length === 0, requestFailures)
  check('real frontend has no console errors', consoleMessages.length === 0, consoleMessages)
  check('real frontend has no page exceptions', pageErrors.length === 0, pageErrors)
} catch (error) {
  check('real frontend runner completed', false, {
    name: error?.name,
    message: error?.message,
    stack: error?.stack,
  })
} finally {
  receipt.pass = checks.every((item) => item.pass)
  await writeFile(join(root, 'real-frontend.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
if (!receipt.pass) process.exitCode = 1
