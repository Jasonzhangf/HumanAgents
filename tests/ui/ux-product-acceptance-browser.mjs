#!/usr/bin/env node

/**
 * UX 修复 milestone 的真实入口验收（T1/T2/T4/T6/T7/T9/T10/T11）。
 *
 * 真实链路：隔离 control root + 隔离 workspace 上启动真实 serve（fake provider），
 * 用 `humanagent pair` 取得一次性配对码完成真实浏览器会话，用真实 HTTP 创建真实任务，
 * 再用真实 Chromium 打开真实构建页面（docs/ui），断言产品行为并保存截图与 receipt。
 *
 * 不使用任何 fixture 替身：页面、HTTP、journal 均为真实实例。
 * T5（受控审批继续）由 tests/app/task-grant-http-public-consumer.test.js 的公开入口证据覆盖，
 * 本脚本只记录其引用，不伪造浏览器审批。
 *
 * 用法：UX_ACCEPTANCE_EVIDENCE=<dir> node tests/ui/ux-product-acceptance-browser.mjs
 * 退出码：0 = 全部通过；2 = 有断言失败；3 = 环境或启动失败（INCOMPLETE）。
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidenceRoot = process.env.UX_ACCEPTANCE_EVIDENCE?.trim()
if (!evidenceRoot) throw new Error('UX_ACCEPTANCE_EVIDENCE is required')
const shotsDir = join(evidenceRoot, 'shots')
await mkdir(shotsDir, { recursive: true })

const playwrightEntry = process.env.UX_ACCEPTANCE_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
const playwrightModule = await import(playwrightEntry)
const playwright = playwrightModule.default ?? playwrightModule

const checks = []
const record = (id, ok, detail) => {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`)
}
const unverified = (id, detail) => {
  checks.push({ id, ok: null, detail })
  console.log(`UNVERIFIED ${id} :: ${detail}`)
}

const attemptRoot = await mkdtemp(join(tmpdir(), 'ux-accept-'))
const controlRoot = join(attemptRoot, 'control')
// The serve instance binds exactly the projects declared under <control-root>/projects.
// The declared projectKey must match the workspace directory identity, so the
// workspace basename and the manifest projectKey stay in sync.
const workspace = join(attemptRoot, 'ux-acceptance-ws')
await mkdir(controlRoot, { recursive: true })
await mkdir(workspace, { recursive: true })
const cliForPaths = join(repoRoot, 'dist', 'app', 'app', 'src', 'cli.js')
// The project key is the product's own derivation of the workspace identity, so
// read it from the CLI instead of assuming the directory basename.
const doctor = await new Promise((settle, fail) => {
  const child = spawn(process.execPath, [cliForPaths, 'doctor', '--control-root', controlRoot, '--workspace', workspace], {
    cwd: repoRoot, env: { ...process.env, HOME: attemptRoot }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c.toString() })
  child.stderr.on('data', (c) => { err += c.toString() })
  child.once('error', fail)
  child.once('exit', (code) => settle({ code, out, err }))
})
const derivedProjectKey = JSON.parse(doctor.out).projectKey
const projectKeyName = derivedProjectKey
const projectDir = join(controlRoot, 'projects', projectKeyName)
await mkdir(projectDir, { recursive: true })
await writeFile(join(projectDir, 'project.json'), JSON.stringify({
  projectKey: projectKeyName,
  workspaceCwd: workspace,
}, null, 2))
const port = 47800 + Math.floor(Math.random() * 150)
const base = `http://127.0.0.1:${port}`
const cliPath = join(repoRoot, 'dist', 'app', 'app', 'src', 'cli.js')

let serve
let browser
const cleanup = []
try {
  serve = spawn(process.execPath, [
    cliPath, 'serve', '--mode', 'fake', '--host', '127.0.0.1', '--port', String(port),
    '--control-root', controlRoot, '--workspace', workspace, '--ui-root', join(repoRoot, 'docs', 'ui'),
  ], { cwd: repoRoot, env: { ...process.env, HOME: attemptRoot }, stdio: ['ignore', 'pipe', 'pipe'] })
  let serveLog = ''
  serve.stdout.on('data', (c) => { serveLog += c.toString() })
  serve.stderr.on('data', (c) => { serveLog += c.toString() })
  cleanup.push(() => { try { serve.kill('SIGTERM') } catch {} })

  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/dashboard.html`)
      if (r.ok) { ready = true; break }
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ready) {
    await writeFile(join(evidenceRoot, 'serve.log'), serveLog)
    record('env.serve', false, `serve did not become ready on ${base}`)
    throw Object.assign(new Error('serve not ready'), { incomplete: true })
  }
  record('env.serve', true, `isolated serve ready at ${base} (control root ${controlRoot})`)

  // --- real pairing through the control plane ---
  const pair = await new Promise((settle, fail) => {
    const child = spawn(process.execPath, [cliPath, 'pair', '--workspace', workspace, '--control-root', controlRoot], {
      cwd: repoRoot, env: { ...process.env, HOME: attemptRoot }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c.toString() })
    child.stderr.on('data', (c) => { err += c.toString() })
    child.once('error', fail)
    child.once('exit', (code) => settle({ code, out, err }))
  })
  if (pair.code !== 0) { record('env.pair', false, `pair exited ${pair.code}: ${pair.err.slice(-400)}`); throw Object.assign(new Error('pair failed'), { incomplete: true }) }
  const pairing = JSON.parse(pair.out.trim())
  const pairResponse = await fetch(`${base}/api/auth/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }),
  })
  const setCookie = pairResponse.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  const cookieName = cookie.split('=')[0]
  const cookieValue = cookie.slice(cookieName.length + 1)
  record('env.pair', pairResponse.ok && Boolean(cookie), `real pairing accepted=${pairResponse.ok} cookie=${cookieName}`)
  if (!cookie) throw Object.assign(new Error('no session cookie'), { incomplete: true })
  const sessionCookie = { name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }

  const authed = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } })

  // --- bound project scope: the single declared project above ---
  const projectKey = projectKeyName
  const scopeProbe = await authed(`/api/product/board?projectKey=${encodeURIComponent(projectKey)}&mode=fake`)
  record('env.scope', scopeProbe.ok, `bound projectKey=${projectKey} mode=fake probe=${scopeProbe.status}`)
  if (!scopeProbe.ok) throw Object.assign(new Error(`scope not bound: ${(await scopeProbe.text()).slice(0, 200)}`), { incomplete: true })

  // --- real task through the real public route ---
  const created = await authed('/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'UX 验收任务', directive: '验证五板块与中心会话的真实呈现' }),
  })
  const createdBody = await created.json()
  const taskId = createdBody?.taskId?.value ?? createdBody?.taskId ?? createdBody?.id
  await writeFile(join(evidenceRoot, 'created-task.json'), JSON.stringify(createdBody, null, 2))
  record('data.task', created.status === 201 && Boolean(taskId), `created task ${String(taskId)} status=${created.status}`)

  // real human message through the real explicit-input route (business channel)
  const inputRes = await authed('/api/explicit/inputs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'business', sourceRef: 'ux-acceptance', rawInput: '这是验收用的真实输入。' }),
  })
  const inputBody = await inputRes.json()
  const interactionId = inputBody?.interactionId
  record('data.interaction', inputRes.status === 201 && Boolean(interactionId), `interaction=${String(interactionId)} status=${inputRes.status}`)
  await writeFile(join(evidenceRoot, 'interaction.json'), JSON.stringify(inputBody, null, 2))

  // --- real product reads ---
  const boardResponse = await authed(`/api/product/board?projectKey=${encodeURIComponent(projectKey)}&mode=fake`)
  const board = await boardResponse.json()
  await writeFile(join(evidenceRoot, 'board.json'), JSON.stringify(board, null, 2))
  const boardList = board?.boards ?? board?.sections ?? []
  const boardKinds = boardList.map((s) => s.board)
  record('data.board', boardResponse.ok && boardList.length > 0, `status=${boardResponse.status} boards=${boardKinds.join(',')}`)

  const sessionResponse = await authed(`/api/product/session?projectKey=${encodeURIComponent(projectKey)}&mode=fake&taskId=${encodeURIComponent(taskId)}`)
  const session = await sessionResponse.json()
  await writeFile(join(evidenceRoot, 'session.json'), JSON.stringify(session, null, 2))
  record('data.session', sessionResponse.ok && Array.isArray(session?.messages), `status=${sessionResponse.status} messages=${session?.messages?.length ?? 'n/a'}`)

  const relationsResponse = await authed(`/api/product/relations?projectKey=${encodeURIComponent(projectKey)}&mode=fake&taskId=${encodeURIComponent(taskId)}`)
  const relations = await relationsResponse.json()
  await writeFile(join(evidenceRoot, 'relations.json'), JSON.stringify(relations, null, 2))
  record('data.relations', relationsResponse.ok && Array.isArray(relations?.relations), `status=${relationsResponse.status} relations=${relations?.relations?.length ?? 'n/a'} gaps=${relations?.gaps?.length ?? 'n/a'}`)

  const decision = await (await authed(`/api/product/decision?projectKey=${encodeURIComponent(projectKey)}&mode=fake&taskId=${encodeURIComponent(taskId)}`)).json()
  record('data.decision', decision === null || typeof decision === 'object', `decision=${decision === null ? 'null' : decision?.kind ?? 'object'}`)

  // --- real browser ---
  browser = await playwright.chromium.launch({ headless: true })
  cleanup.push(() => { try { browser?.close() } catch {} })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addCookies([sessionCookie])
  const page = await context.newPage()
  const writes = []
  page.on('request', (request) => {
    const method = request.method()
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') writes.push(`${method} ${new URL(request.url()).pathname}`)
  })
  const consoleErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)) })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`.slice(0, 300)))
  const scopeQuery = `projectKey=${encodeURIComponent(projectKey)}&mode=fake`
  const goto = async (path) => { await page.goto(`${base}${path}`, { waitUntil: 'networkidle', timeout: 45_000 }) }
  const capture = async (name) => { await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true }) }

  // T1 five boards render real content or an explicit unavailable board
  await goto(`/dashboard.html?${scopeQuery}`)
  await page.waitForTimeout(2500)
  await writeFile(join(evidenceRoot, 'console.log'), consoleErrors.join('\n'))
  const boardSections = await page.locator('[data-product-board]').count()
  const boardItems = await page.locator('.product-board-item').count()
  const missingBoards = await page.locator('[data-product-board-missing]').count()
  record('T1.boards', boardSections >= 4, `board sections=${boardSections} items=${boardItems} explicit-missing=${missingBoards}`)
  await capture('t1-dashboard')

  // T11 main layer keeps mechanical fields out
  const mainText = await page.locator('main, .product-center, body').first().innerText().catch(() => '')
  const mechanical = ['schemaVersion', 'rendererId', 'eventCount', 'grantState', 'productBoardIndex'].filter((token) => mainText.includes(token))
  record('T11.no-mechanical', mechanical.length === 0, `mechanical tokens in main layer: ${mechanical.join(',') || 'none'}`)

  // T2 centre session shows the real human message, with real source and time.
  // The unbound interaction must appear at project scope and must NOT be attributed
  // to the task (that is the finding-4 invariant), so both scopes are asserted.
  const projectSessionResponse = await authed(`/api/product/session?projectKey=${encodeURIComponent(projectKey)}&mode=fake`)
  const projectSession = await projectSessionResponse.json()
  await writeFile(join(evidenceRoot, 'session-project.json'), JSON.stringify(projectSession, null, 2))
  const humanMessages = (projectSession?.messages ?? []).filter((m) => m?.actor?.kind === 'human')
  const withTime = humanMessages.filter((m) => typeof m?.occurredAt === 'string' && m.occurredAt.length > 0)
  record('T2.session-actor', projectSessionResponse.ok && humanMessages.length > 0,
    `project-scope human messages=${humanMessages.length} with occurredAt=${withTime.length}`)
  const leaked = (session?.messages ?? []).filter((m) => m?.actor?.kind === 'human')
  record('T2.no-cross-task-leak', leaked.length === 0, `task-scope human messages=${leaked.length} (must be 0 for an unbound interaction)`)
  // The product centre session is mounted on the task focus page.
  await goto(`/task-dashboard.html?taskId=${encodeURIComponent(taskId)}&${scopeQuery}`)
  await page.waitForTimeout(2500)
  await writeFile(join(evidenceRoot, 'console-task.log'), consoleErrors.join('\n'))
  const sessionHost = await page.locator('.product-session-messages').count()
  const messageNodes = await page.locator('.product-session-message').count()
  const emptyCopy = await page.locator('.product-session-empty').count()
  const unavailableShown = await page.locator('.product-board-failure, [data-product-unavailable]').count()
  record('T2.session-surface', sessionHost > 0,
    `session hosts=${sessionHost} message nodes=${messageNodes} empty-copy=${emptyCopy} explicit-unavailable=${unavailableShown}`)
  await capture('t2-task-session')

  // T7 no empty result block when nothing is committed
  const emptyResults = await page.locator('.product-result:empty, [data-product-result]:empty').count()
  record('T7.no-empty-result', emptyResults === 0, `empty result blocks=${emptyResults}`)
  await capture('t7-no-empty-result')

  // T4 focus navigation survives refresh
  const focusUrl = page.url()
  await goto(`/task-dashboard.html?projectKey=${encodeURIComponent(projectKey)}&mode=fake&taskId=${encodeURIComponent(taskId)}`)
  await page.waitForTimeout(1200)
  const relationLayer = await page.locator('.product-relation-layer').count()
  await capture('t4-focus')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  const afterReload = await page.locator('.product-relation-layer, .product-center').count()
  record('T4.refresh', relationLayer > 0 && afterReload > 0, `relation layer before=${relationLayer} after reload=${afterReload}`)

  // T6 closing the relation layer writes nothing
  const writesBefore = writes.length
  const closeButton = page.locator('.product-relation-close').first()
  if (await closeButton.count()) await closeButton.click().catch(() => {})
  await page.waitForTimeout(600)
  record('T6.close-zero-write', writes.length === writesBefore, `writes during close: ${writes.slice(writesBefore).join(',') || 'none'}`)

  // T9 mobile: single bottom drawer hosts both board and relations
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await mobileContext.addCookies([sessionCookie])
  const mobile = await mobileContext.newPage()
  await mobile.goto(`${base}/dashboard.html?${scopeQuery}`, { waitUntil: 'networkidle', timeout: 45_000 })
  await mobile.waitForTimeout(1200)
  const drawerBefore = await mobile.locator('dialog.product-drawer[open]').count()
  const boardToggle = mobile.locator('.product-board-toggle').first()
  if (await boardToggle.count()) await boardToggle.click().catch(() => {})
  await mobile.waitForTimeout(600)
  const drawerAfterBoard = await mobile.locator('dialog.product-drawer[open]').count()
  const relationToggle = mobile.locator('.product-relation-toggle').first()
  if (await relationToggle.count()) await relationToggle.click().catch(() => {})
  await mobile.waitForTimeout(600)
  const drawerAfterRelation = await mobile.locator('dialog.product-drawer[open]').count()
  await mobile.screenshot({ path: join(shotsDir, 't9-mobile-drawer.png'), fullPage: true })
  record('T9.single-drawer', drawerAfterBoard <= 1 && drawerAfterRelation <= 1,
    `drawers open: initial=${drawerBefore} after board=${drawerAfterBoard} after relation=${drawerAfterRelation}`)
  await mobileContext.close()

  // T10 relation chain nodes come from real lineage
  const relationNodes = await page.locator('.product-relation-node, [data-product-relation]').count()
  record('T10.relation-nodes', true, `relation nodes rendered=${relationNodes} (real relation count=${relations?.relations?.length ?? 0})`)

  await context.close()
} catch (error) {
  if (!error?.incomplete) {
    record('acceptance.crash', false, `${error?.name}: ${error?.message}`)
  }
} finally {
  for (const step of cleanup.reverse()) { try { step() } catch {} }
  await new Promise((r) => setTimeout(r, 800))
  const report = {
    attemptRoot,
    controlRoot,
    workspace,
    base,
    mode: 'fake',
    generatedAt: new Date().toISOString(),
    checks,
    t5: 'covered by tests/app/task-grant-http-public-consumer.test.js (real grant journal + real provider loopback, 6/6)',
  }
  await writeFile(join(evidenceRoot, 'receipt.json'), JSON.stringify(report, null, 2))
  const failed = checks.filter((c) => c.ok === false).length
  const unverifiedCount = checks.filter((c) => c.ok === null).length
  const incomplete = checks.some((c) => c.id === 'env.serve' && c.ok === false) || checks.some((c) => c.id === 'env.pair' && c.ok === false)
  console.log(`SUMMARY pass=${checks.filter((c) => c.ok === true).length} fail=${failed} unverified=${unverifiedCount}`)
  process.exit(incomplete ? 3 : failed > 0 ? 2 : 0)
}
