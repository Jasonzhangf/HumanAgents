#!/usr/bin/env node

/**
 * Real-browser proof for the browser pairing entry.
 *
 * The harness runs the candidate `dist/app/ui` tree inside a REAL
 * `humanagent serve` process, so the page drives the production access-control
 * edge: `GET /api/auth/session`, a same-origin `POST /api/auth/pair {code}` and
 * the durable `HA_SESSION` cookie. The pairing code comes from the real
 * `humanagent pair` CLI challenge, not from a fixture.
 *
 * Every check is strict: the page must render the runtime's own
 * code/owner/message/nextAction for a missing session, a wrong code, a replayed
 * one-time code and an expired code, and it must reach the authenticated
 * runtime after a real pairing.
 *
 * Required environment:
 *   AUTH_LOGIN_EVIDENCE   execution-owned directory for checks.json and artifacts
 * Optional environment:
 *   AUTH_LOGIN_UI_ROOT    UI tree to serve (default: <repo>/dist/app/ui)
 *   AUTH_LOGIN_PLAYWRIGHT playwright entry (default: homebrew global install)
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = resolve(process.env.AUTH_LOGIN_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'))
const evidenceRoot = process.env.AUTH_LOGIN_EVIDENCE

if (!evidenceRoot?.trim()) {
  throw new Error('AUTH_LOGIN_EVIDENCE is required; point it at an execution-owned directory')
}

const cliPath = resolve(repoRoot, 'dist', 'app', 'app', 'src', 'cli.js')
const playwrightModule = await import(
  process.env.AUTH_LOGIN_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule

// The runtime's own pairing TTL. `access-control.ts` DEFAULT_PAIRING_TTL_MS is
// two minutes, so the expired-code branch is proven by waiting the real TTL out
// instead of manufacturing an expiry the runtime never produced.
const PAIRING_TTL_MS = 120_000
const EXPIRY_WAIT_MS = PAIRING_TTL_MS + 3_000

const ACCESS_CONTROL_OWNER = 'humanagent.app.access-control'
const SESSION_MISSING_NEXT = 'open the login page and pair this browser'

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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

// ---------------------------------------------------------------------------
// Real composed runtime
// ---------------------------------------------------------------------------

function startServe(binding) {
  const env = { ...process.env }
  const userHome = env.HOME
  env.HOME = binding.attemptRoot
  if ((env.XDG_CONFIG_HOME ?? '') === '' && userHome) env.XDG_CONFIG_HOME = join(userHome, '.config')

  const child = spawn(process.execPath, [
    cliPath, 'serve',
    '--provider', 'fake',
    '--protocol', 'responses',
    '--binding', 'auth-login-proof',
    '--ui-root', uiRoot,
    '--workspace', binding.workspace,
    '--control-root', binding.controlRoot,
    '--port', '0',
  ], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  const ready = new Promise((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`serve did not report a URL: ${stderr.slice(-2000)}`)), 60_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      const match = stdout.match(/\{[\s\S]*?\n\}/)
      if (!match) return
      try {
        const parsed = JSON.parse(match[0])
        clearTimeout(timer)
        settle(parsed)
      } catch {
        // keep buffering until the JSON object is complete
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('exit', (code) => fail(new Error(`serve exited early (${String(code)}): ${stderr.slice(-2000)}`)))
  })

  return {
    ready,
    pid: child.pid,
    stderr: () => stderr.slice(-4000),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((done) => child.once('exit', done))
      child.kill('SIGTERM')
      await exited
    },
  }
}

/**
 * The real control-plane challenge. `humanagent pair` derives the supervisor
 * token from the daemon lease and asks the running serve owner for a one-time
 * code; the browser never sees any of that.
 */
async function requestPairingCode(binding) {
  const env = { ...process.env }
  const userHome = env.HOME
  env.HOME = binding.attemptRoot
  if ((env.XDG_CONFIG_HOME ?? '') === '' && userHome) env.XDG_CONFIG_HOME = join(userHome, '.config')
  const child = spawn(process.execPath, [
    cliPath, 'pair',
    '--workspace', binding.workspace,
    '--control-root', binding.controlRoot,
  ], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const code = await new Promise((settle, fail) => {
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', fail)
    child.once('exit', (exitCode) => settle(exitCode))
  })
  if (code !== 0) throw new Error(`humanagent pair exited ${String(code)}; stderr=${stderr.slice(-1200)}`)
  const receipt = JSON.parse(stdout.trim())
  if (typeof receipt.code !== 'string' || !receipt.code) throw new Error('humanagent pair returned no pairing code')
  return receipt
}

async function readStatus(binding, cookie) {
  const response = await fetch(`${binding.serveBaseUrl}/api/runtime/status`, {
    headers: cookie ? { cookie } : {},
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

// ---------------------------------------------------------------------------
// Page reads
// ---------------------------------------------------------------------------

function readLoginSurface(page) {
  return page.evaluate(() => {
    const errorCard = document.querySelector('[data-auth-error]')
    const attr = (name) => document.querySelector(`[data-auth-error-${name}]`)?.getAttribute(`data-auth-error-${name}`) ?? null
    return {
      loginPage: Boolean(document.querySelector('[data-login-page]')),
      sessionState: document.querySelector('[data-auth-session-state]')?.textContent ?? '',
      bannerText: document.querySelector('[data-auth-status]')?.textContent ?? '',
      bannerTone: document.querySelector('[data-auth-status]')?.dataset.tone ?? '',
      formPresent: Boolean(document.querySelector('[data-pair-form]')),
      codeInputPresent: Boolean(document.querySelector('[data-pair-code]')),
      errorVisible: Boolean(errorCard && !errorCard.hidden),
      errorCode: attr('code'),
      errorOwner: attr('owner'),
      errorMessage: attr('message'),
      errorNext: attr('next'),
      errorText: errorCard?.innerText ?? '',
      retryVisible: Boolean(document.querySelector('[data-auth-error-retry]') && !document.querySelector('[data-auth-error-retry]').hidden),
      retryText: document.querySelector('[data-auth-error-retry]')?.textContent ?? '',
      url: location.href,
    }
  })
}

function readBanner(page) {
  return page.evaluate(() => {
    const banner = document.querySelector('.status-banner')
    const link = document.querySelector('[data-auth-pair-link]')
    return {
      bannerText: banner?.innerText ?? '',
      pairLinkPresent: Boolean(link),
      pairLinkHref: link?.getAttribute('href') ?? '',
      pairLinkText: link?.textContent ?? '',
    }
  })
}

async function submitCode(page, code) {
  await page.fill('[data-pair-code]', code)
  await page.click('[data-pair-submit]')
}

async function waitForErrorCode(page, expected, timeoutMs = 30_000) {
  await page.waitForFunction(
    (wanted) => document.querySelector('[data-auth-error-code]')?.getAttribute('data-auth-error-code') === wanted,
    expected,
    { timeout: timeoutMs },
  ).catch(() => {})
  return readLoginSurface(page)
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const artifactDir = join(evidenceRoot, 'artifacts')
await mkdir(artifactDir, { recursive: true })

const attemptRoot = await mkdtemp(join(tmpdir(), 'humanagent-auth-login-'))
const workspace = join(attemptRoot, 'workspace')
const controlRoot = join(attemptRoot, 'control')
await mkdir(workspace, { recursive: true })
await mkdir(controlRoot, { recursive: true })
const binding = { attemptRoot, workspace, controlRoot, serveBaseUrl: '' }

let serve
let browser
let screenshotCount = 0

async function capture(page, name) {
  screenshotCount += 1
  await page.screenshot({ path: join(artifactDir, `${String(screenshotCount).padStart(2, '0')}-${name}.png`), fullPage: true })
}

try {
  // --- 0. the candidate really ships the entry ----------------------------
  const docsLogin = join(repoRoot, 'docs', 'ui', 'login.html')
  const distLogin = join(uiRoot, 'login.html')
  let docsBytes = null
  let distBytes = null
  try { docsBytes = await readFile(docsLogin) } catch { docsBytes = null }
  try { distBytes = await readFile(distLogin) } catch { distBytes = null }
  observe('login entry bytes', {
    docsLogin,
    distLogin,
    docsPresent: docsBytes !== null,
    distPresent: distBytes !== null,
    identical: docsBytes !== null && distBytes !== null && docsBytes.equals(distBytes),
  })
  record('the built UI tree ships login.html identical to docs/ui/login.html',
    docsBytes !== null && distBytes !== null && docsBytes.equals(distBytes),
    { docsLogin, distLogin })

  serve = startServe(binding)
  const ready = await serve.ready
  const port = ready.port ?? ready.url?.match(/:(\d+)/)?.[1]
  binding.serveBaseUrl = `http://127.0.0.1:${String(port)}`
  observe('real serve', { url: binding.serveBaseUrl, pid: serve.pid })

  browser = await playwright.chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  // Two different facts: an uncaught exception in the page is a defect, while the
  // browser's own log of a deliberate 401 is the runtime rejecting an unpaired
  // read. They are recorded separately so neither is hidden by the other.
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  // --- 1. the runtime really gates the entry ------------------------------
  const unauthenticated = await readStatus(binding, null)
  observe('unauthenticated runtime status', unauthenticated)
  record('the real runtime rejects an unpaired browser with the typed session error',
    unauthenticated.status === 401
      && unauthenticated.body?.error?.code === 'auth.session.missing'
      && unauthenticated.body?.error?.ownerId === ACCESS_CONTROL_OWNER
      && unauthenticated.body?.error?.nextAction === SESSION_MISSING_NEXT,
    unauthenticated)

  // --- 2. the shell links to a real pairing page --------------------------
  await page.goto(`${binding.serveBaseUrl}/dashboard.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-auth-pair-link]', { timeout: 30_000 })
  const linked = await readBanner(page)
  observe('shell pairing link', linked)
  const linkUrl = new URL(linked.pairLinkHref, `${binding.serveBaseUrl}/dashboard.html`)
  record('the auth-gated shell links to a real login page and preserves the runtime nextAction',
    linked.pairLinkPresent
      && linkUrl.pathname === '/login.html'
      && linkUrl.searchParams.get('next') === '/dashboard.html'
      && linkUrl.searchParams.get('authCode') === 'auth.session.missing'
      && linkUrl.searchParams.get('authOwner') === ACCESS_CONTROL_OWNER
      && linkUrl.searchParams.get('authMessage') === 'browser session is required'
      && linkUrl.searchParams.get('authNext') === SESSION_MISSING_NEXT
      && linked.bannerText.includes(SESSION_MISSING_NEXT),
    { linked, resolved: linkUrl.href })
  await capture(page, 'shell-auth-missing')

  // --- 3. every hostile path variant stays on the same-origin fallback -----
  const hostilePaths = ['/%5Cevil.com', '/%09//evil.com']
  // Import the actual shipped module in the page context rather than duplicating
  // its parser logic in this proof.
  const evaluatedHostile = await page.evaluate(async (values) => {
    const module = await import('./runtime-api.js')
    return values.map((value) => ({ value, resolved: module.sameOriginPath(value) }))
  }, hostilePaths)
  observe('hostile next path guards', evaluatedHostile)
  record('backslash and encoded control path variants use the same-origin fallback',
    evaluatedHostile.every((entry) => entry.resolved === '/dashboard.html'),
    evaluatedHostile)

  // --- 4. an expired runtime session still links from tasks.html -----------
  const expiredTasksContext = await browser.newContext()
  const expiredTasksPage = await expiredTasksContext.newPage()
  await expiredTasksPage.route('**/api/tasks', async (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'auth.session.expired', ownerId: ACCESS_CONTROL_OWNER, message: 'browser session has expired', nextAction: 'open the login page and pair this browser' }),
  }))
  await expiredTasksPage.goto(`${binding.serveBaseUrl}/tasks.html`, { waitUntil: 'domcontentloaded' })
  await expiredTasksPage.waitForSelector('[data-auth-pair-link]', { timeout: 30_000 })
  const expiredTasksLink = await expiredTasksPage.evaluate(() => document.querySelector('[data-auth-pair-link]')?.getAttribute('href') ?? '')
  observe('tasks expired session pairing link', { expiredTasksLink })
  record('tasks.html renders a real pairing link for an auth.session.expired mutation',
    new URL(expiredTasksLink, `${binding.serveBaseUrl}/tasks.html`).searchParams.get('authCode') === 'auth.session.expired'
      && new URL(expiredTasksLink, `${binding.serveBaseUrl}/tasks.html`).pathname === '/login.html',
    { expiredTasksLink })
  await expiredTasksContext.close()

  // --- 5. the login page is served by the real runtime --------------------
  const loginResponse = await fetch(`${binding.serveBaseUrl}/login.html`)
  const loginBody = await loginResponse.text()
  observe('login.html response', {
    status: loginResponse.status,
    contentType: loginResponse.headers.get('content-type'),
    bytes: loginBody.length,
  })
  record('the real runtime serves /login.html as the pairing entry',
    loginResponse.status === 200
      && (loginResponse.headers.get('content-type') ?? '').includes('text/html')
      && loginBody.includes('data-pair-form'),
    { status: loginResponse.status, bytes: loginBody.length })

  // --- 4. the page renders the carried typed rejection --------------------
  await page.goto(linkUrl.href, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-login-page]', { timeout: 30_000 })
  await page.waitForFunction(
    () => document.querySelector('[data-auth-error-code]')?.getAttribute('data-auth-error-code') === 'auth.session.missing',
    undefined,
    { timeout: 30_000 },
  )
  const carried = await readLoginSurface(page)
  observe('login page carried rejection', carried)
  record('the login page renders the carried typed rejection with code, owner, message and next action',
    carried.errorVisible
      && carried.errorCode === 'auth.session.missing'
      && carried.errorOwner === ACCESS_CONTROL_OWNER
      && carried.errorMessage === 'browser session is required'
      && carried.errorNext === SESSION_MISSING_NEXT
      && carried.formPresent
      && carried.codeInputPresent
      && carried.retryVisible,
    carried)
  await capture(page, 'login-carried-rejection')

  // --- 5. a real wrong code is a real typed failure -----------------------
  await submitCode(page, 'not-a-real-pairing-code')
  const wrong = await waitForErrorCode(page, 'auth.pair.invalid')
  observe('real wrong-code failure', wrong)
  record('a real wrong pairing code renders the typed pair failure and keeps the form',
    wrong.errorCode === 'auth.pair.invalid'
      && wrong.errorOwner === ACCESS_CONTROL_OWNER
      && wrong.errorMessage === 'pairing code is invalid or already used'
      && wrong.errorNext === 'run humanagent pair again'
      && wrong.formPresent
      && new URL(wrong.url).pathname === '/login.html',
    wrong)
  await capture(page, 'login-wrong-code')

  // --- 6. a real pairing code completes the browser session ---------------
  const first = await requestPairingCode(binding)
  observe('real pairing challenge', { expiresAt: first.expiresAt, codeLength: first.code.length })
  await page.goto(`${binding.serveBaseUrl}/login.html?next=%2Fdashboard.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-pair-code]', { timeout: 30_000 })
  await submitCode(page, first.code)
  await page.waitForURL((url) => url.pathname === '/dashboard.html', { timeout: 60_000 })
  await page.waitForSelector('.status-banner', { timeout: 30_000 })
  await sleep(1_000)
  const authenticatedSurface = await page.evaluate(() => ({
    url: location.href,
    bannerText: document.querySelector('.status-banner')?.innerText ?? '',
    pairLinkPresent: Boolean(document.querySelector('[data-auth-pair-link]')),
  }))
  observe('post-pairing entry', authenticatedSurface)
  const sessionAfterPair = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session')
    return { status: response.status, body: await response.json().catch(() => ({})) }
  })
  const statusAfterPair = await readStatus(binding, await context.cookies().then((cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ')))
  observe('post-pairing session', { sessionAfterPair, statusAfterPair })
  record('a real pairing code sets the browser session and reaches the authenticated runtime',
    authenticatedSurface.url.endsWith('/dashboard.html')
      && sessionAfterPair.body?.authenticated === true
      && typeof sessionAfterPair.body?.expiresAt === 'string'
      && statusAfterPair.status === 200
      && authenticatedSurface.pairLinkPresent === false,
    { authenticatedSurface, sessionAfterPair, statusAfterPair })
  await capture(page, 'post-pairing-dashboard')

  // --- 7. the one-time code really is one-time ---------------------------
  const replayContext = await browser.newContext()
  const replayPage = await replayContext.newPage()
  await replayPage.goto(`${binding.serveBaseUrl}/login.html`, { waitUntil: 'domcontentloaded' })
  await replayPage.waitForSelector('[data-pair-code]', { timeout: 30_000 })
  await submitCode(replayPage, first.code)
  const replay = await waitForErrorCode(replayPage, 'auth.pair.invalid')
  observe('replayed pairing code', replay)
  record('a consumed pairing code cannot pair a second browser',
    replay.errorCode === 'auth.pair.invalid'
      && replay.errorOwner === ACCESS_CONTROL_OWNER
      && replay.errorMessage === 'pairing code is invalid or already used'
      && replay.errorNext === 'run humanagent pair again',
    replay)
  await replayContext.close()

  // --- 8. a real expired code is a real typed failure ---------------------
  const expiring = await requestPairingCode(binding)
  const expiredContext = await browser.newContext()
  const expiredPage = await expiredContext.newPage()
  await expiredPage.goto(`${binding.serveBaseUrl}/login.html`, { waitUntil: 'domcontentloaded' })
  await expiredPage.waitForSelector('[data-pair-code]', { timeout: 30_000 })
  observe('expiry wait', { waitMs: EXPIRY_WAIT_MS, challengeExpiresAt: expiring.expiresAt })
  await sleep(EXPIRY_WAIT_MS)
  await submitCode(expiredPage, expiring.code)
  const expired = await waitForErrorCode(expiredPage, 'auth.pair.expired')
  observe('real expired-code failure', expired)
  record('a real expired pairing code renders the typed expired failure',
    expired.errorCode === 'auth.pair.expired'
      && expired.errorOwner === ACCESS_CONTROL_OWNER
      && expired.errorMessage === 'pairing code has expired'
      && expired.errorNext === 'run humanagent pair again'
      && expired.retryVisible,
    expired)
  await capture(expiredPage, 'login-expired-code')
  await expiredContext.close()

  // --- 9. the entry target cannot be turned into an open redirect ---------
  const redirect = await requestPairingCode(binding)
  const redirectContext = await browser.newContext()
  const redirectPage = await redirectContext.newPage()
  await redirectPage.goto(
    `${binding.serveBaseUrl}/login.html?next=${encodeURIComponent('https://evil.example/steal')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await redirectPage.waitForSelector('[data-pair-code]', { timeout: 30_000 })
  await submitCode(redirectPage, redirect.code)
  await redirectPage.waitForURL((url) => url.pathname !== '/login.html', { timeout: 60_000 })
  const landed = redirectPage.url()
  observe('open-redirect attempt', { landed })
  record('a foreign next target falls back to the same-origin entry',
    landed.startsWith(binding.serveBaseUrl) && new URL(landed).pathname === '/dashboard.html',
    { landed })
  await redirectContext.close()

  observe('page errors', [...pageErrors])
  observe('console errors', [...consoleErrors])
  record('the pairing pages raise no uncaught page error', pageErrors.length === 0, pageErrors)
  record('the only console errors are the browser log of the deliberate unpaired 401 reads',
    consoleErrors.every((text) => text.includes('401')),
    consoleErrors)

  await context.close()
} catch (error) {
  record('auth login proof completed', false, { message: error instanceof Error ? error.message : String(error) })
  observe('proof failure', { message: error instanceof Error ? error.message : String(error), serveStderr: serve?.stderr?.() ?? '' })
} finally {
  if (browser) await browser.close().catch(() => {})
  if (serve) await serve.stop().catch(() => {})
  await rm(attemptRoot, { recursive: true, force: true }).catch(() => {})
}

await writeFile(
  join(evidenceRoot, 'checks.json'),
  `${JSON.stringify({ uiRoot, checks, observations }, null, 2)}\n`,
)

const passed = checks.filter((check) => check.pass).length
console.log(`auth login browser proof: ${passed}/${checks.length} passed`)
for (const check of checks) {
  if (!check.pass) console.log(`FAIL ${check.name}: ${JSON.stringify(check.detail)}`)
}
if (failures > 0) {
  console.log('auth login browser proof failed')
  process.exitCode = 1
} else {
  console.log('auth login browser proof passed')
}
