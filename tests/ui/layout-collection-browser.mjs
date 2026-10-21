#!/usr/bin/env node

/**
 * Real-browser proof for the collection-layout Memory page.
 *
 * This consumer loads the real docs/ui memory.html, memory.js and
 * memory-actions.js in Chromium through Playwright request interception. It
 * covers the page-level wiring that the binder tests cannot observe:
 * the exact initial summary GET, the visible review controls, one review POST
 * with exact candidate/reason values, one refresh after success, a typed
 * failure that stays visible, and source refs/digests in the shared technical
 * detail drawer.
 *
 * Run: node tests/ui/layout-collection-browser.mjs
 *
 * Environment:
 *   MEMORY_UI_ROOT       UI root to serve (default <repo>/docs/ui)
 *   MEMORY_EVIDENCE      evidence directory; when set, checks.json is written
 *   MEMORY_PLAYWRIGHT    Playwright entry point override
 *   MEMORY_VIEWPORT      set to mobile for the 390x844 layout proof
 *   MEMORY_BROWSER_ARGS  Chromium launch args (default --single-process,--no-zygote)
 *   MEMORY_RED_PROOF=1   run the controlled detached-refresh counterexample
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = resolve(process.env.MEMORY_UI_ROOT ?? join(repoRoot, 'docs', 'ui'))
const evidenceRoot = process.env.MEMORY_EVIDENCE?.trim()
const redProofMode = process.env.MEMORY_RED_PROOF === '1'
const proofOrigin = 'http://humanagent.memory.test'
const mobileViewport = process.env.MEMORY_VIEWPORT?.trim() === 'mobile'
const viewport = mobileViewport ? { width: 390, height: 844 } : { width: 1440, height: 1000 }

const launchArgs = (process.env.MEMORY_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

const playwrightModule = await import(
  process.env.MEMORY_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule

const fixture = {
  summaryPath: '/api/memory/summary',
  summarySearch: '?namespace=project&limit=20',
  reviewPath: '/api/memory/review',
  candidateId: 'candidate-alpha',
  decision: 'reject',
  decisionReason: 'fixture reason for reject',
  sourceRefs: ['fixture://docs/ui/memory.js', 'fixture://docs/ui/memory-actions.js'],
  sourceDigests: ['fixture-digest-alpha', 'fixture-digest-beta'],
  failure: {
    code: 'memory.review.fixture-denied',
    ownerId: 'memory-coordinator',
    message: 'fixture review was denied',
    nextAction: 'inspect the candidate and retry the fixture review',
  },
}

const runtimeStatus = {
  mode: 'fake',
  state: 'ready',
  providerState: 'ready',
  connected: true,
}

const memorySummary = {
  surface: 'memory-interaction',
  state: 'ready',
  data: {
    state: 'ready',
    label: 'Memory Interaction',
    detail: 'controlled memory page fixture',
  },
  scope: 'fixture-project',
  summary: 'controlled memory page fixture',
  indexState: 'fixture-index-1',
  entries: [],
  selectedDetail: undefined,
  comparison: undefined,
  skillCandidates: [{
    candidateId: fixture.candidateId,
    pattern: 'fixture-pattern',
    proposedRule: 'Fixture candidate rule for page-level review proof',
    uniqueness: 'unique',
    repeatability: 'observed',
    value: 'review',
    state: 'candidate',
    evidenceRefs: ['fixture-evidence'],
    namespace: 'project',
    projectKey: 'fixture-project',
    taskId: 'fixture-task',
    sourceRefs: [...fixture.sourceRefs],
    sourceDigests: [...fixture.sourceDigests],
  }],
  inspectEnabled: false,
  compareEnabled: false,
  analysis: {
    mode: 'deterministic',
    state: 'succeeded',
    operationRef: 'fixture-operation',
  },
  autoUpdate: true,
}

const checks = []
const observations = []
let failures = 0

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail })
  if (!pass) failures += 1
}

function observe(name, value) {
  observations.push({ name, value })
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

function waitFor(predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout
  return new Promise((resolvePromise) => {
    const poll = () => {
      if (predicate()) {
        resolvePromise(true)
        return
      }
      if (Date.now() >= deadline) {
        resolvePromise(false)
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

function exactSummaryUrl(requestUrl) {
  const url = new URL(requestUrl)
  return `${url.pathname}${url.search}`
}

async function installRoutes(context, requests, options) {
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())

    if (url.origin !== proofOrigin) {
      await route.continue()
      return
    }

    if (url.pathname === '/api/runtime/status' && request.method() === 'GET') {
      requests.status.push(`${url.pathname}${url.search}`)
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(runtimeStatus),
      })
      return
    }

    if (url.pathname === fixture.summaryPath && request.method() === 'GET') {
      requests.summary.push(`${url.pathname}${url.search}`)
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(memorySummary),
      })
      return
    }

    if (url.pathname === fixture.reviewPath && request.method() === 'POST') {
      const raw = request.postData()
      let body
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = undefined
      }
      requests.review.push({ method: request.method(), path: url.pathname, body })
      await route.fulfill({
        status: options.reviewFailure ? 500 : 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(options.reviewFailure
          ? { error: fixture.failure }
          : { candidateId: body?.candidateId, decision: body?.decision }),
      })
      return
    }

    if (url.pathname.startsWith('/api/')) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: { code: 'scripted.route.missing', message: `${request.method()} ${url.pathname}` } }),
      })
      return
    }

    const relative = decodeURIComponent(url.pathname === '/' ? '/memory.html' : url.pathname).replace(/^\/+/, '')
    if (!relative || relative.split('/').includes('..')) {
      await route.fulfill({ status: 400, body: 'bad path' })
      return
    }
    const filePath = resolve(uiRoot, relative)
    if (!filePath.startsWith(`${uiRoot}${sep}`)) {
      await route.fulfill({ status: 403, body: 'forbidden' })
      return
    }
    try {
      const file = await readFile(filePath)
      await route.fulfill({ status: 200, contentType: mimeType(filePath), body: file })
    } catch {
      await route.fulfill({ status: 404, body: 'not found' })
    }
  })
}

async function withMemoryPage(run, options = {}) {
  const browser = await playwright.chromium.launch({ headless: true, args: launchArgs })
  const context = await browser.newContext({ viewport })
  const requests = { status: [], summary: [], review: [] }
  const pageErrors = []

  if (options.simulateDetachedRefresh) {
    await context.addInitScript(() => {
      const originalFetch = globalThis.fetch.bind(globalThis)
      let summaryCalls = 0
      globalThis.fetch = (input, init) => {
        const target = typeof input === 'string' ? input : input.url
        const url = new URL(target, globalThis.location.href)
        if (url.pathname === '/api/memory/summary') {
          summaryCalls += 1
          if (summaryCalls > 1) return new Promise(() => {})
        }
        return originalFetch(input, init)
      }
    })
  }

  await installRoutes(context, requests, options)
  const page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  try {
    await page.goto(`${proofOrigin}/memory.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-memory-section="candidates"] article')
    await page.waitForFunction(() => (
      document.querySelectorAll('[data-memory-section="candidates"] article .actions button').length === 3
    ))
    return await run({ page, requests, pageErrors })
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

function probePage() {
  const isRendered = (node) => {
    if (!node) return false
    if (node.getClientRects().length === 0) return false
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const candidate = document.querySelector('[data-memory-section="candidates"] article')
  const actions = candidate ? [...candidate.querySelectorAll('.actions button')] : []
  const reason = document.querySelector('[data-memory-review-reason]')
  const technical = candidate?.querySelector('button[data-memory-technical-detail]') ?? null
  return {
    candidateVisible: isRendered(candidate),
    reasonVisible: isRendered(reason),
    actionCount: actions.filter(isRendered).length,
    technicalDetailVisible: isRendered(technical),
    candidateRule: candidate?.querySelector('h3')?.textContent?.trim() ?? null,
  }
}

function probeFailure() {
  const status = document.querySelector('[role="status"]')
  const candidate = document.querySelector('[data-memory-section="candidates"] article')
  const reason = document.querySelector('[data-memory-review-reason]')
  const actions = candidate ? [...candidate.querySelectorAll('.actions button')] : []
  return {
    tone: status?.dataset.tone ?? null,
    text: (status?.textContent || '').replace(/\s+/g, ' ').trim(),
    candidateVisible: Boolean(candidate),
    reasonValue: reason?.value ?? null,
    actionDisabled: actions.map((button) => Boolean(button.disabled)),
  }
}

function probeMobileLayout() {
  const page = document.querySelector('.page[data-page-layout]')
  const primary = document.querySelector('.page-primary')
  const support = document.querySelector('.page-support')
  const reason = document.querySelector('[data-memory-review-reason]')
  const actions = [...document.querySelectorAll('[data-memory-section="candidates"] article .actions button')]
  const rect = (node) => node ? {
    left: node.getBoundingClientRect().left,
    right: node.getBoundingClientRect().right,
    width: node.getBoundingClientRect().width,
  } : null
  const columns = page ? getComputedStyle(page).gridTemplateColumns.split(/\s+/).filter(Boolean) : []
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    gridTemplateColumns: page ? getComputedStyle(page).gridTemplateColumns : null,
    columnCount: columns.length,
    page: rect(page),
    primary: rect(primary),
    support: rect(support),
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 1,
    reasonInSupport: Boolean(support?.contains(reason)),
    actionCount: actions.length,
  }
}

function probeTechnicalDetail() {
  const layer = document.querySelector('dialog.shell-layer[open][data-technical-detail="true"]')
  const body = layer?.querySelector('.shell-layer-body') ?? layer
  const values = (selector) => [...(body?.querySelectorAll(selector) ?? [])].map((node) => node.textContent || '')
  return {
    open: Boolean(layer),
    candidateId: body?.querySelector('dd[data-detail-label="candidateId"]')?.textContent ?? null,
    sourceRefs: values('dd[data-memory-source-ref]'),
    sourceDigests: values('dd[data-memory-source-digest]'),
    text: (body?.textContent || '').replace(/\s+/g, ' ').trim(),
  }
}

async function clickReject(page) {
  await page.locator('[data-memory-section="candidates"] article .actions button').nth(1).click()
}

async function reviewAndWait(page, requests, options = {}) {
  await page.fill('[data-memory-review-reason]', fixture.decisionReason)
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === fixture.reviewPath
  ))
  await clickReject(page)
  const response = await responsePromise
  const refreshed = options.expectRefresh
    ? await waitFor(() => requests.summary.length >= 2)
    : await waitFor(() => false, 500)
  if (options.expectRefresh) await page.waitForTimeout(100)
  return { response, refreshed }
}

async function successScenario() {
  await withMemoryPage(async ({ page, requests, pageErrors }) => {
    const initial = await page.evaluate(probePage)
    observe('initial memory controls', initial)
    check('initial GET is exactly /api/memory/summary?namespace=project&limit=20',
      requests.summary.length === 1
      && exactSummaryUrl(`${proofOrigin}${requests.summary[0]}`) === `${fixture.summaryPath}${fixture.summarySearch}`,
      requests.summary)
    check('candidate and reason controls are visible',
      initial.candidateVisible && initial.reasonVisible && initial.actionCount === 3,
      initial)
    check('candidate exposes the shared technical detail control',
      initial.technicalDetailVisible,
      initial)

    const { response, refreshed } = await reviewAndWait(page, requests, { expectRefresh: true })
    check('formal review endpoint accepts the click with HTTP 200', response.status() === 200, response.status())
    check('one click sends exactly one review POST to /api/memory/review',
      requests.review.length === 1
      && requests.review[0].method === 'POST'
      && requests.review[0].path === fixture.reviewPath,
      requests.review)
    check('review POST preserves the exact candidateId, decision and reason',
      JSON.stringify(requests.review[0]?.body) === JSON.stringify({
        candidateId: fixture.candidateId,
        decision: fixture.decision,
        decisionReason: fixture.decisionReason,
      }),
      requests.review[0]?.body)
    check('successful review refreshes the exact summary once',
      refreshed && requests.summary.length === 2
      && requests.summary.every((entry) => entry === `${fixture.summaryPath}${fixture.summarySearch}`),
      requests.summary)

    await page.locator('[data-memory-section="candidates"] article button[data-memory-technical-detail]').click()
    await page.waitForSelector('dialog.shell-layer[open][data-technical-detail="true"]')
    const detail = await page.evaluate(probeTechnicalDetail)
    observe('candidate technical detail', detail)
    check('shared technical detail exposes the exact candidate id',
      detail.open && detail.candidateId === fixture.candidateId,
      detail)
    check('shared technical detail exposes every exact source ref',
      JSON.stringify(detail.sourceRefs) === JSON.stringify(fixture.sourceRefs),
      detail.sourceRefs)
    check('shared technical detail exposes every exact source digest',
      JSON.stringify(detail.sourceDigests) === JSON.stringify(fixture.sourceDigests),
      detail.sourceDigests)
    check('success scenario has no page exception', pageErrors.length === 0, pageErrors)
  })
}

async function failureScenario() {
  await withMemoryPage(async ({ page, requests, pageErrors }) => {
    const { response } = await reviewAndWait(page, requests, { expectRefresh: false })
    check('failed review returns the controlled typed HTTP failure', response.status() === 500, response.status())
    await page.waitForFunction((code) => (
      (document.querySelector('[role="status"]')?.textContent || '').includes(code)
    ), fixture.failure.code)
    const failure = await page.evaluate(probeFailure)
    observe('typed review failure', failure)
    check('typed review failure remains visible with its exact code, owner, message and next action',
      failure.tone === 'danger'
      && failure.text.includes(fixture.failure.code)
      && failure.text.includes(fixture.failure.message)
      && failure.text.includes(`owner=${fixture.failure.ownerId}`)
      && failure.text.includes(`next=${fixture.failure.nextAction}`),
      failure)
    check('typed failure does not become a success state or remove the candidate',
      failure.tone !== 'success' && failure.candidateVisible,
      failure)
    check('typed failure preserves the exact submitted reason for a retry',
      failure.reasonValue === fixture.decisionReason,
      failure.reasonValue)
    check('typed failure does not refresh the summary',
      requests.summary.length === 1,
      requests.summary)
    check('typed failure sends exactly one exact review body',
      requests.review.length === 1
      && JSON.stringify(requests.review[0]?.body) === JSON.stringify({
        candidateId: fixture.candidateId,
        decision: fixture.decision,
        decisionReason: fixture.decisionReason,
      }),
      requests.review)
    check('failure scenario has no page exception', pageErrors.length === 0, pageErrors)
  }, { reviewFailure: true })
}

async function mobileLayoutScenario() {
  await withMemoryPage(async ({ page, requests, pageErrors }) => {
    const initial = await page.evaluate(probeMobileLayout)
    observe('mobile memory layout', initial)
    const substantial = (panel) => Boolean(panel)
      && panel.width >= initial.page.width * 0.9
      && panel.left >= initial.page.left - 1
      && panel.right <= initial.page.right + 1
    check('mobile memory page computes one grid column',
      initial.viewport.width === 390 && initial.viewport.height === 844 && initial.columnCount === 1,
      initial)
    check('mobile primary and support panels stay substantial within the page',
      initial.reasonInSupport && substantial(initial.primary) && substantial(initial.support),
      initial)
    check('mobile memory page has no document horizontal overflow',
      !initial.horizontalOverflow,
      { documentWidth: initial.documentWidth, viewportWidth: initial.viewport.width })

    await page.locator('[data-memory-review-reason]').click()
    const reasonFocused = await page.evaluate(() => (
      document.activeElement === document.querySelector('[data-memory-review-reason]')
    ))
    check('mobile reason input is reachable by normal click', reasonFocused, { reasonFocused })

    await page.fill('[data-memory-review-reason]', fixture.decisionReason)
    const responsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === fixture.reviewPath
    ))
    await page.locator('[data-memory-section="candidates"] article .actions button').nth(1).click()
    const response = await responsePromise
    check('mobile original action click reaches the exact review POST',
      response.status() === 200
      && requests.review.length === 1
      && JSON.stringify(requests.review[0]?.body) === JSON.stringify({
        candidateId: fixture.candidateId,
        decision: fixture.decision,
        decisionReason: fixture.decisionReason,
      }),
      { status: response.status(), review: requests.review, initial })
    check('mobile scenario has no page exception', pageErrors.length === 0, pageErrors)
  })
}

async function detachedRefreshRedProof() {
  let result
  await withMemoryPage(async ({ page, requests }) => {
    const { response } = await reviewAndWait(page, requests, { expectRefresh: false })
    await page.waitForTimeout(600)
    result = {
      responseStatus: response.status(),
      reviewRequests: requests.review.length,
      summaryRequests: requests.summary.length,
      expectedSummaryRequestsAfterSuccess: 2,
    }
  }, { simulateDetachedRefresh: true })
  return result
}

let crashed = null
let redProof = null
try {
  if (redProofMode) {
    redProof = await detachedRefreshRedProof()
    const caught = redProof.responseStatus === 200
      && redProof.reviewRequests === 1
      && redProof.summaryRequests !== redProof.expectedSummaryRequestsAfterSuccess
    check('detached refresh callback is detected by the summary refresh assertion', caught, redProof)
    process.stdout.write(`FAIL one click sends exactly one review and refreshes once :: ${JSON.stringify({
      expectedSummaryRequests: redProof.expectedSummaryRequestsAfterSuccess,
      receivedSummaryRequests: redProof.summaryRequests,
    })}\n`)
  } else {
    await successScenario()
    await failureScenario()
    if (mobileViewport) await mobileLayoutScenario()
  }
} catch (error) {
  crashed = error.stack ?? String(error)
}

const result = {
  uiRoot,
  redProofMode,
  viewportMode: mobileViewport ? 'mobile' : 'desktop',
  checks,
  observations,
  failures,
  redProof,
  crashed,
  ok: failures === 0 && crashed === null,
}

if (evidenceRoot) {
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, redProofMode ? 'red-proof.json' : 'checks.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

for (const entry of checks) {
  process.stdout.write(`${entry.pass ? 'ok  ' : 'FAIL'} ${entry.name}${entry.pass ? '' : ` :: ${JSON.stringify(entry.detail)}`}\n`)
}
process.stdout.write(`\n# checks ${checks.length}\n# pass ${checks.length - failures}\n# fail ${failures}\n`)
if (crashed) process.stdout.write(`\n# crashed\n${crashed}\n`)
process.exit(result.ok ? 0 : 1)
