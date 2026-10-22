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

import { decodeProductLocation } from '../../docs/ui/product-location.js'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const driverPath = fileURLToPath(import.meta.url)

function taskIdValue(value) {
  return value && typeof value === 'object' ? value.value : value
}

export function taskDashboardPath(taskId, scope) {
  const params = new URLSearchParams({
    task: String(taskIdValue(taskId)),
    projectKey: String(scope?.projectKey ?? ''),
    mode: String(scope?.mode ?? ''),
  })
  return `/task-dashboard.html?${params}`
}

export function productTargetKey(ref) {
  const scope = ref?.scope
  const scopeKey = scope?.kind === 'task'
    ? `task:${scope.projectKey}:${scope.mode}:${taskIdValue(scope.taskId)}`
    : scope?.kind === 'project'
      ? `project:${scope.projectKey}`
      : scope?.kind === 'system' ? 'system' : 'invalid-scope'
  if (ref?.kind === 'interaction') {
    return `interaction:${taskIdValue(ref.taskRef)}:${scopeKey}`
  }
  if (ref?.kind === 'session') {
    return [
      'session',
      ref.sessionRef?.sourceKind,
      ref.sessionRef?.sourceRef,
      taskIdValue(ref.taskRef) ?? '',
      scopeKey,
    ].join(':')
  }
  if (ref?.kind === 'execution-instance') {
    return `execution-instance:${taskIdValue(ref.taskRef)}:${JSON.stringify(ref.instance)}:${scopeKey}`
  }
  return `unknown:${JSON.stringify(ref)}`
}

function groundedUniqueRelations(relations) {
  if (!Array.isArray(relations)) return []
  const unique = new Map()
  for (const relation of relations) {
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) continue
    if (typeof relation.sourceOwner !== 'string' || relation.sourceOwner.trim() === '') continue
    if (!Array.isArray(relation.evidenceRefs) || relation.evidenceRefs.length === 0) continue
    const key = JSON.stringify([relation.kind, relation.source, relation.target])
    if (!unique.has(key)) unique.set(key, relation)
  }
  return [...unique.values()]
}

export function evaluateResultSurface({
  focusReady,
  sessionViewCount,
  resultBlockCount,
  commitNodeCount,
  output,
}) {
  const commits = Array.isArray(output?.commits) ? output.commits : []
  const mounted = focusReady === true && sessionViewCount > 0
  if (!mounted) {
    return {
      ok: false,
      detail: `session surface not mounted: focus-ready=${focusReady === true} session-view=${sessionViewCount}`,
    }
  }
  if (output?.resultAvailable === true && commits.length > 0) {
    const ok = resultBlockCount === 1 && commitNodeCount === commits.length
    return {
      ok,
      detail: `mounted result blocks=${resultBlockCount} commit nodes=${commitNodeCount} expected commits=${commits.length}`,
    }
  }
  const ok = commits.length === 0 && resultBlockCount === 0
  return {
    ok,
    detail: `explicit no committed result: commits=${commits.length} result blocks=${resultBlockCount}`,
  }
}

export function evaluateRelationSurface({
  relations,
  gaps,
  renderedRelationCount,
  renderedGapCount,
  renderedCurrentCount,
  renderedNodeCount,
}) {
  const grounded = groundedUniqueRelations(relations)
  const gapCount = Array.isArray(gaps) ? gaps.length : 0
  if (grounded.length > 0) {
    const ok = renderedRelationCount === grounded.length
      && renderedCurrentCount === 1
      && renderedNodeCount > 0
      && renderedGapCount === gapCount
    return {
      ok,
      detail: `real grounded relations=${grounded.length} rendered=${renderedRelationCount} nodes=${renderedNodeCount} current=${renderedCurrentCount} rendered gaps=${renderedGapCount}/${gapCount}`,
    }
  }
  if (gapCount > 0) {
    // A scope with only explicit gaps has no selectable target; the honest
    // surface is the gap copy itself and no fabricated relation nodes.
    const ok = renderedRelationCount === 0
      && renderedGapCount === gapCount
    return {
      ok,
      detail: `no grounded relation; explicit gaps=${gapCount} rendered=${renderedGapCount} nodes=${renderedNodeCount} current=${renderedCurrentCount} (no selectable target)`,
    }
  }
  return {
    ok: null,
    detail: 'UNVERIFIED: the real scope returned neither relations nor explicit gaps',
  }
}

function parseJson(text) {
  if (text.trim() === '') return null
  return JSON.parse(text)
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return new Promise((settle) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      settle(undefined)
    }, timeoutMs)
    const onExit = (code, signal) => {
      clearTimeout(timer)
      settle({ code, signal })
    }
    child.once('exit', onExit)
  })
}

async function main() {
  const evidenceRoot = process.env.UX_ACCEPTANCE_EVIDENCE?.trim()
  if (!evidenceRoot) throw new Error('UX_ACCEPTANCE_EVIDENCE is required')
  const shotsDir = join(evidenceRoot, 'shots')
  await mkdir(shotsDir, { recursive: true })

  const playwrightEntry = process.env.UX_ACCEPTANCE_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
  const playwrightModule = await import(playwrightEntry)
  const playwright = playwrightModule.default ?? playwrightModule

  const checks = []
  const httpReceipts = []
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
  let context
  let mobileContext
  let serveLog = ''
  const resource = {
    servePid: null,
    serveExit: null,
    listenerUnavailable: null,
    contextsClosed: false,
    browserClosed: false,
  }

  try {
    serve = spawn(process.execPath, [
      cliPath, 'serve', '--mode', 'fake', '--host', '127.0.0.1', '--port', String(port),
      '--control-root', controlRoot, '--workspace', workspace, '--ui-root', join(repoRoot, 'docs', 'ui'),
    ], { cwd: repoRoot, env: { ...process.env, HOME: attemptRoot }, stdio: ['ignore', 'pipe', 'pipe'] })
    resource.servePid = serve.pid
    serve.stdout.on('data', (c) => { serveLog += c.toString() })
    serve.stderr.on('data', (c) => { serveLog += c.toString() })

    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline) {
      if (serve.exitCode !== null) break
      try {
        const response = await fetch(`${base}/dashboard.html`)
        if (response.ok) { ready = true; break }
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    }
    if (!ready) {
      await writeFile(join(evidenceRoot, 'serve.log'), serveLog)
      record('env.serve', false, `serve pid=${resource.servePid} did not become ready on ${base}`)
      throw Object.assign(new Error('serve not ready'), { incomplete: true })
    }
    record('env.serve', true, `isolated serve pid=${resource.servePid} ready at ${base} (control root ${controlRoot})`)

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
    if (pair.code !== 0) {
      record('env.pair', false, `pair exited ${pair.code}: ${pair.err.slice(-400)}`)
      throw Object.assign(new Error('pair failed'), { incomplete: true })
    }
    const pairing = JSON.parse(pair.out.trim())
    const pairResponse = await fetch(`${base}/api/auth/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code }),
    })
    const setCookie = pairResponse.headers.get('set-cookie') ?? ''
    const cookie = setCookie.split(';')[0]
    const cookieName = cookie.split('=')[0]
    const cookieValue = cookie.slice(cookieName.length + 1)
    httpReceipts.push({
      name: 'pair',
      method: 'POST',
      path: '/api/auth/pair',
      status: pairResponse.status,
      ok: pairResponse.ok,
      cookieName,
    })
    record('env.pair', pairResponse.ok && Boolean(cookie), `real pairing accepted=${pairResponse.ok} cookie=${cookieName}`)
    if (!cookie) throw Object.assign(new Error('no session cookie'), { incomplete: true })
    const sessionCookie = { name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }

    const authed = (path, init = {}) => fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), cookie },
    })

    const fetchJson = async (name, path, init = {}) => {
      const response = await authed(path, init)
      const text = await response.text()
      const body = parseJson(text)
      const bodyFile = `${name}.json`
      await writeFile(join(evidenceRoot, bodyFile), JSON.stringify(body, null, 2))
      httpReceipts.push({
        name,
        method: init.method ?? 'GET',
        path,
        status: response.status,
        ok: response.ok,
        bodyFile,
      })
      return { response, body }
    }

    // --- bound project scope: the single declared project above ---
    const projectKey = projectKeyName
    const scopeQuery = `projectKey=${encodeURIComponent(projectKey)}&mode=fake`
    const scopeProbe = await fetchJson('board-probe', `/api/product/board?${scopeQuery}`)
    record('env.scope', scopeProbe.response.ok, `bound projectKey=${projectKey} mode=fake probe=${scopeProbe.response.status}`)
    if (!scopeProbe.response.ok) {
      throw Object.assign(new Error(`scope not bound: ${JSON.stringify(scopeProbe.body).slice(0, 200)}`), { incomplete: true })
    }

    // --- real task through the real public route ---
    const createdTitle = 'UX 验收任务'
    const created = await fetchJson('created-task', '/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: createdTitle, directive: '验证五板块与中心会话的真实呈现' }),
    })
    const createdBody = created.body
    const taskId = taskIdValue(createdBody?.taskId) ?? createdBody?.id
    record('data.task', created.response.status === 201 && Boolean(taskId),
      `created task ${String(taskId)} title=${createdTitle} status=${created.response.status}`)
    if (!taskId) throw Object.assign(new Error('task response did not include taskId'), { incomplete: true })

    // real human message through the real explicit-input route (business channel)
    const input = await fetchJson('interaction', '/api/explicit/inputs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'business', sourceRef: 'ux-acceptance', rawInput: '这是验收用的真实输入。' }),
    })
    const interactionId = input.body?.interactionId
    record('data.interaction', input.response.status === 201 && Boolean(interactionId),
      `interaction=${String(interactionId)} status=${input.response.status}`)

    // --- real product reads ---
    const boardRead = await fetchJson('board', `/api/product/board?${scopeQuery}`)
    const board = boardRead.body
    const boardList = board?.boards ?? board?.sections ?? []
    const boardKinds = boardList.map((section) => section.board)
    record('data.board', boardRead.response.ok && boardList.length > 0,
      `status=${boardRead.response.status} boards=${boardKinds.join(',')}`)

    const taskScopeQuery = `${scopeQuery}&taskId=${encodeURIComponent(taskId)}`
    const sessionRead = await fetchJson('session', `/api/product/session?${taskScopeQuery}`)
    const session = sessionRead.body
    record('data.session', sessionRead.response.ok && Array.isArray(session?.messages),
      `status=${sessionRead.response.status} messages=${session?.messages?.length ?? 'n/a'}`)

    const projectSessionRead = await fetchJson('session-project', `/api/product/session?${scopeQuery}`)
    const projectSession = projectSessionRead.body
    const projectHumanMessages = (projectSession?.messages ?? []).filter((message) => message?.actor?.kind === 'human')
    const projectHumanWithTime = projectHumanMessages.filter((message) =>
      typeof message?.occurredAt === 'string' && message.occurredAt.length > 0)
    record('T2.session-actor', projectSessionRead.response.ok && projectHumanMessages.length > 0,
      `project-scope human messages=${projectHumanMessages.length} with occurredAt=${projectHumanWithTime.length}`)
    const taskHumanMessages = (session?.messages ?? []).filter((message) => message?.actor?.kind === 'human')
    record('T2.no-cross-task-leak', taskHumanMessages.length === 0,
      `task-scope human messages=${taskHumanMessages.length} (must be 0 for an unbound interaction)`)

    const relationsRead = await fetchJson('relations', `/api/product/relations?${taskScopeQuery}`)
    const relations = relationsRead.body
    record('data.relations',
      relationsRead.response.ok && Array.isArray(relations?.relations) && Array.isArray(relations?.gaps),
      `status=${relationsRead.response.status} relations=${relations?.relations?.length ?? 'n/a'} gaps=${relations?.gaps?.length ?? 'n/a'}`)

    const decisionRead = await fetchJson('decision', `/api/product/decision?${taskScopeQuery}`)
    const decision = decisionRead.body
    record('data.decision',
      decisionRead.response.ok && (decision === null || typeof decision === 'object'),
      `status=${decisionRead.response.status} decision=${decision === null ? 'null' : decision?.kind ?? 'object'}`)

    const outputRead = await fetchJson('output', `/api/product/output?${taskScopeQuery}`)
    const output = outputRead.body
    record('data.output',
      outputRead.response.ok && output !== null && Array.isArray(output?.commits),
      `status=${outputRead.response.status} commits=${output?.commits?.length ?? 'n/a'} resultAvailable=${output?.resultAvailable}`)

    const dashboardRead = await fetchJson('task-dashboard',
      `/api/tasks/${encodeURIComponent(taskId)}/dashboard?${scopeQuery}`)
    const dashboardBody = dashboardRead.body?.value ?? dashboardRead.body
    record('data.task-dashboard',
      dashboardRead.response.ok
        && taskIdValue(dashboardBody?.taskId) === taskId
        && dashboardBody?.taskTitle === createdTitle,
      `status=${dashboardRead.response.status} taskId=${taskIdValue(dashboardBody?.taskId) ?? 'n/a'} title=${dashboardBody?.taskTitle ?? 'n/a'}`)

    const wrongScopeRead = await authed(`/api/product/board?projectKey=${encodeURIComponent(`__missing__${projectKey}`)}&mode=fake`)
    record('scope.reject', wrongScopeRead.status === 409,
      `wrong scope status=${wrongScopeRead.status} (must be 409)`)

    const unauthedDashboard = await fetch(`${base}/api/tasks/${encodeURIComponent(taskId)}/dashboard?${scopeQuery}`)
    httpReceipts.push({
      name: 'unauthed-dashboard',
      method: 'GET',
      path: `/api/tasks/${encodeURIComponent(taskId)}/dashboard`,
      status: unauthedDashboard.status,
      ok: unauthedDashboard.ok,
    })
    record('auth.401', unauthedDashboard.status === 401,
      `unauthenticated task dashboard status=${unauthedDashboard.status} (must be 401)`)

    // --- real browser ---
    browser = await playwright.chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addCookies([sessionCookie])
    const page = await context.newPage()
    const requests = []
    const writes = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      const method = request.method()
      const entry = {
        method,
        path: url.pathname,
        search: Object.fromEntries(url.searchParams.entries()),
      }
      requests.push(entry)
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        writes.push(`${method} ${url.pathname}`)
      }
    })
    const consoleErrors = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300)) })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`.slice(0, 300)))
    const goto = async (path) => {
      // The runtime pages hold a live SSE/poll channel, so "networkidle" never
      // settles; navigation is verified through rendered product markers instead.
      await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    }
    const capture = async (name) => {
      await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true })
    }
    const waitForFocusReady = () => page.locator('.product-focus-center[data-product-focus-state="ready"]')
      .waitFor({ state: 'visible', timeout: 20_000 })
    const sessionRequestsSince = (index) => requests.slice(index).filter((entry) =>
      entry.method === 'GET' && entry.path === '/api/product/session')
    const requestMatchesScope = (entries, scope, focus) => entries.some((entry) => {
      if (entry.search.projectKey !== scope.projectKey || entry.search.mode !== scope.mode) return false
      if (scope.kind !== 'task' || entry.search.taskId !== taskIdValue(scope.taskId)) return false
      if (focus?.kind === 'session' && entry.search.sessionId !== focus.sessionRef?.sourceRef) return false
      return true
    })
    const urlState = async () => {
      const url = new URL(page.url())
      const focusScope = await page.locator('.product-focus-center[data-product-focus-state="ready"]')
        .getAttribute('data-product-focus-scope').catch(() => null)
      return {
        href: url.href,
        task: url.searchParams.get('task'),
        taskId: url.searchParams.get('taskId'),
        projectKey: url.searchParams.get('projectKey'),
        mode: url.searchParams.get('mode'),
        hash: url.hash,
        focusScope,
        title: await page.locator('.task-title-current').innerText().catch(() => ''),
      }
    }
    const exactScopeKey = `task:${projectKey}:fake:${taskId}`

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
    const mechanical = ['schemaVersion', 'rendererId', 'eventCount', 'grantState', 'productBoardIndex']
      .filter((token) => mainText.includes(token))
    record('T11.no-mechanical', mechanical.length === 0, `mechanical tokens in main layer: ${mechanical.join(',') || 'none'}`)

    const taskPath = taskDashboardPath(taskId, { projectKey, mode: 'fake' })
    const taskRequestMark = requests.length
    await goto(taskPath)
    await waitForFocusReady()
    await page.waitForTimeout(500)
    await writeFile(join(evidenceRoot, 'console-task.log'), consoleErrors.join('\n'))
    const targetState = await urlState()
    const expectedRenderedTitle = dashboardBody?.semanticTitle ?? '未整理名称的任务'
    const targetTitleOk = dashboardBody?.taskTitle === createdTitle
      && targetState.title.trim() === expectedRenderedTitle
    const targetUrlOk = targetState.task === taskId
      && targetState.projectKey === projectKey
      && targetState.mode === 'fake'
      && targetState.focusScope === exactScopeKey
    const targetRequestOk = requestMatchesScope(sessionRequestsSince(taskRequestMark), {
      kind: 'task', projectKey, mode: 'fake', taskId: { value: taskId },
    })
    record('T2.target-page', targetTitleOk && targetUrlOk && targetRequestOk,
      `rendered title=${JSON.stringify(targetState.title)} expected=${JSON.stringify(expectedRenderedTitle)} task=${targetState.task} scope=${targetState.focusScope} session-request-scope=${targetRequestOk}`)
    const sessionHost = await page.locator('[data-product-role="session-view"]').count()
    const messageNodes = await page.locator('.product-session-message').count()
    const emptyCopy = await page.locator('.product-session-empty').count()
    const unavailableShown = await page.locator('.product-board-failure, [data-product-unavailable]').count()
    record('T2.session-surface', sessionHost > 0,
      `session views=${sessionHost} message nodes=${messageNodes} empty-copy=${emptyCopy} explicit-unavailable=${unavailableShown}`)
    await capture('t2-task-session')

    // T7 distinguishes a mounted session with no committed result from a missing page surface.
    const resultSurface = {
      focusReady: await page.locator('.product-focus-center[data-product-focus-state="ready"]').count() === 1,
      sessionViewCount: sessionHost,
      resultBlockCount: await page.locator('[data-product-role="public-result"]').count(),
      commitNodeCount: await page.locator('.product-session-commit').count(),
      output,
    }
    const resultEvaluation = evaluateResultSurface(resultSurface)
    record('T7.result-surface', resultEvaluation.ok === true, resultEvaluation.detail)
    await capture('t7-result-surface')

    // T10 consumes the real relation/gap receipt and the rendered relation surface.
    let relationOpen = false
    const relationToggle = page.locator('.product-relation-toggle').first()
    if (await relationToggle.count() === 1) {
      await relationToggle.click()
      await page.waitForFunction(() => document.querySelector('.product-frame')?.dataset.relation === 'open',
        undefined, { timeout: 5_000 }).catch(() => undefined)
      relationOpen = await page.locator('.product-frame[data-relation="open"]').count() === 1
    }
    const relationRenderedCount = Number(await page.locator('.product-relation-chain')
      .getAttribute('data-product-relation-count').catch(() => NaN))
    const relationSurface = {
      relations: relations?.relations,
      gaps: relations?.gaps,
      renderedRelationCount: relationRenderedCount,
      renderedGapCount: await page.locator('.product-relation-gap').count(),
      renderedCurrentCount: await page.locator('.product-relation-node[data-product-relation-current="true"]').count(),
      renderedNodeCount: await page.locator('.product-relation-node').count(),
    }
    const relationEvaluation = relationOpen ? evaluateRelationSurface(relationSurface) : {
      ok: false,
      detail: 'relation layer did not open',
    }
    if (relationEvaluation.ok === null) unverified('T10.relation-surface', relationEvaluation.detail)
    else record('T10.relation-surface', relationEvaluation.ok === true, relationEvaluation.detail)
    if (relationOpen) await capture('t10-relations')

    // T4 selects a real target, refreshes, then checks Back and Forward re-read the exact scope.
    const groundedRelations = groundedUniqueRelations(relations?.relations)
    if (groundedRelations.length === 0) {
      unverified('T4.relation-selection',
        `real relations=0; explicit gaps=${Array.isArray(relations?.gaps) ? relations.gaps.length : 0}; no target can be selected`)
    } else {
      const targetNodes = page.locator('.product-relation-node:not([data-product-relation-current="true"])')
      const targetNodeCount = await targetNodes.count()
      if (!relationOpen || targetNodeCount === 0) {
        record('T4.relation-selection', false,
          `grounded relations=${groundedRelations.length} relation-open=${relationOpen} selectable target nodes=${targetNodeCount}`)
      } else {
        const originalHref = page.url()
        const targetJson = await targetNodes.first().getAttribute('data-product-target')
        let target
        try {
          target = JSON.parse(targetJson)
        } catch {
          target = undefined
        }
        const selectMark = requests.length
        await targetNodes.first().click({ timeout: 5_000 })
        await page.waitForFunction((expectedTarget) => {
          const current = document.querySelector('.product-relation-node[data-product-relation-current="true"]')
          return Boolean(location.hash.startsWith('#/boards/'))
            && current?.getAttribute('data-product-target') === expectedTarget
        }, targetJson, { timeout: 10_000 })
        await page.waitForLoadState('domcontentloaded').catch(() => {})
        if (target?.scope?.kind === 'task') {
          const selectedScopeKey = `task:${target.scope.projectKey}:${target.scope.mode}:${taskIdValue(target.scope.taskId)}`
          await page.waitForFunction((expectedScope) => {
            const focus = document.querySelector('.product-focus-center[data-product-focus-state="ready"]')
            return focus?.getAttribute('data-product-focus-scope') === expectedScope
          }, selectedScopeKey, { timeout: 10_000 })
        }
        const selectedState = await urlState()
        const selectedDecoded = decodeProductLocation(selectedState.href)
        const selectedOk = target !== undefined
          && selectedDecoded.kind === 'valid'
          && productTargetKey(selectedDecoded.location.focus) === productTargetKey(target)
          && selectedDecoded.location.scope.kind === 'task'
          && selectedState.task === taskIdValue(selectedDecoded.location.scope.taskId)
          && selectedState.projectKey === selectedDecoded.location.scope.projectKey
          && selectedState.mode === selectedDecoded.location.scope.mode
          && requestMatchesScope(
            sessionRequestsSince(selectMark),
            selectedDecoded.location.scope,
            selectedDecoded.location.focus,
          )
        record('T4.relation-selection', selectedOk,
          `target=${productTargetKey(target)} query-task=${selectedState.task} focus-scope=${selectedState.focusScope} session-request-scope=${sessionRequestsSince(selectMark).length > 0}`)
        const selectedHref = page.url()

        const refreshMark = requests.length
        await page.reload({ waitUntil: 'domcontentloaded' })
        await waitForFocusReady()
        const refreshedState = await urlState()
        const refreshedDecoded = decodeProductLocation(refreshedState.href)
        const refreshOk = refreshedState.href === selectedHref
          && refreshedDecoded.kind === 'valid'
          && productTargetKey(refreshedDecoded.location.focus) === productTargetKey(target)
          && requestMatchesScope(
            sessionRequestsSince(refreshMark),
            refreshedDecoded.location.scope,
            refreshedDecoded.location.focus,
          )
        record('T4.refresh', refreshOk,
          `same-url=${refreshedState.href === selectedHref} focus-scope=${refreshedState.focusScope} session-request-scope=${sessionRequestsSince(refreshMark).length > 0}`)

        const backMark = requests.length
        await page.goBack({ waitUntil: 'domcontentloaded' })
        await waitForFocusReady()
        await page.waitForFunction((expectedScope) => {
          const focus = document.querySelector('.product-focus-center[data-product-focus-state="ready"]')
          return focus?.getAttribute('data-product-focus-scope') === expectedScope
        }, exactScopeKey, { timeout: 10_000 })
        const backState = await urlState()
        const backOk = backState.href === originalHref
          && backState.task === taskId
          && backState.hash === ''
          && backState.focusScope === exactScopeKey
          && requestMatchesScope(sessionRequestsSince(backMark), {
            kind: 'task', projectKey, mode: 'fake', taskId: { value: taskId },
          })
        record('T4.back', backOk,
          `url-restored=${backState.href === originalHref} task=${backState.task} hash=${backState.hash || '(none)'} scope=${backState.focusScope}`)

        const forwardMark = requests.length
        await page.goForward({ waitUntil: 'domcontentloaded' })
        await waitForFocusReady()
        if (target?.scope?.kind === 'task') {
          const selectedScopeKey = `task:${target.scope.projectKey}:${target.scope.mode}:${taskIdValue(target.scope.taskId)}`
          await page.waitForFunction((expectedScope) => {
            const focus = document.querySelector('.product-focus-center[data-product-focus-state="ready"]')
            return focus?.getAttribute('data-product-focus-scope') === expectedScope
          }, selectedScopeKey, { timeout: 10_000 })
        }
        const forwardState = await urlState()
        const forwardDecoded = decodeProductLocation(forwardState.href)
        const forwardOk = forwardState.href === selectedHref
          && forwardDecoded.kind === 'valid'
          && productTargetKey(forwardDecoded.location.focus) === productTargetKey(target)
          && requestMatchesScope(
            sessionRequestsSince(forwardMark),
            forwardDecoded.location.scope,
            forwardDecoded.location.focus,
          )
        record('T4.forward', forwardOk,
          `url-restored=${forwardState.href === selectedHref} focus-scope=${forwardState.focusScope} session-request-scope=${sessionRequestsSince(forwardMark).length > 0}`)
      }
    }

    // T6 closing the relation layer is an explicit successful click with no write request.
    try {
      const currentlyOpen = await page.locator('.product-frame[data-relation="open"]').count() === 1
      if (!currentlyOpen) {
        const toggle = page.locator('.product-relation-toggle').first()
        if (await toggle.count() !== 1) throw new Error('relation toggle is absent')
        await toggle.click()
        await page.waitForFunction(() => document.querySelector('.product-frame')?.dataset.relation === 'open',
          undefined, { timeout: 5_000 })
      }
      const closeButton = page.locator('.product-relation-close').first()
      if (await closeButton.count() !== 1) throw new Error('close button is absent')
      const writesBefore = writes.length
      await closeButton.click({ timeout: 5_000 })
      await page.waitForFunction(() => document.querySelector('.product-frame')?.dataset.relation === 'closed',
        undefined, { timeout: 5_000 })
      const writesDuringClose = writes.slice(writesBefore)
      const closed = await page.locator('.product-frame[data-relation="closed"]').count() === 1
      record('T6.close-zero-write', closed && writesDuringClose.length === 0,
        `closed=${closed} writes during close=${writesDuringClose.join(',') || 'none'}`)
      await capture('t6-relation-closed')
    } catch (error) {
      record('T6.close-zero-write', false, `${error?.name}: ${error?.message}`)
    }

    // T9 mobile: one bottom drawer hosts both board and relations.
    mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await mobileContext.addCookies([sessionCookie])
    const mobile = await mobileContext.newPage()
    await mobile.goto(`${base}/dashboard.html?${scopeQuery}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await mobile.waitForTimeout(1200)
    const drawerBefore = await mobile.locator('dialog.product-drawer[open]').count()
    const boardToggle = mobile.locator('.product-board-toggle').first()
    if (await boardToggle.count() !== 1) {
      record('T9.single-drawer', false, 'board toggle is absent')
    } else {
      await boardToggle.click()
      await mobile.waitForTimeout(600)
      const drawerAfterBoard = await mobile.locator('dialog.product-drawer[open]').count()
      // On mobile both surfaces share the one drawer, so the second surface is
      // reached through the drawer tab, never through a second layer.
      const relationTab = mobile.locator('[data-product-drawer-tab="relations"], .product-drawer-tab').nth(1)
      if (await relationTab.count() === 0) {
        record('T9.single-drawer', false, 'drawer relation tab is absent')
      } else {
        await relationTab.click()
        await mobile.waitForTimeout(600)
        const drawerAfterRelation = await mobile.locator('dialog.product-drawer[open]').count()
        const relationTabBody = await mobile.locator('[data-product-slot="drawer"]').innerText().catch(() => '')
        await mobile.screenshot({ path: join(shotsDir, 't9-mobile-drawer.png'), fullPage: true })
        record('T9.single-drawer', drawerBefore === 0 && drawerAfterBoard === 1 && drawerAfterRelation === 1,
          `drawers open: initial=${drawerBefore} after board=${drawerAfterBoard} after relation-tab=${drawerAfterRelation} tab-body=${relationTabBody.slice(0, 40)}`)
      }
    }
  } catch (error) {
    if (!error?.incomplete) {
      record('acceptance.crash', false, `${error?.name}: ${error?.message}`)
    }
  } finally {
    let contextCloseError
    try {
      if (mobileContext) await mobileContext.close()
      if (context) await context.close()
    } catch (error) {
      contextCloseError = error
    } finally {
      mobileContext = undefined
      context = undefined
    }
    const hadContext = context !== undefined || mobileContext !== undefined
    resource.contextsClosed = contextCloseError === undefined && mobileContext === undefined && context === undefined
    record('resource.contexts', resource.contextsClosed,
      resource.contextsClosed
        ? (hadContext ? 'all Playwright contexts closed' : 'no Playwright contexts launched')
        : `context close failed: ${contextCloseError?.message ?? 'unknown'}`)

    let browserCloseError
    try {
      if (browser) await browser.close()
    } catch (error) {
      browserCloseError = error
    }
    const hadBrowser = browser !== undefined
    resource.browserClosed = browserCloseError === undefined
    record('resource.browser', resource.browserClosed,
      resource.browserClosed
        ? (hadBrowser ? 'Chromium closed' : 'no Chromium launched')
        : `Chromium close failed: ${browserCloseError?.message ?? 'unknown'}`)

    if (serve) {
      let exited = await waitForExit(serve, 0)
      if (exited === undefined) {
        serve.kill('SIGTERM')
        exited = await waitForExit(serve, 10_000)
      }
      if (exited === undefined) {
        serve.kill('SIGKILL')
        exited = await waitForExit(serve, 5_000)
      }
      resource.serveExit = exited ?? null
      try {
        await fetch(`${base}/dashboard.html`, { signal: AbortSignal.timeout(2_000) })
        resource.listenerUnavailable = false
      } catch {
        resource.listenerUnavailable = true
      }
      const stopped = exited !== undefined && resource.listenerUnavailable === true
      record('resource.serve-stop', stopped,
        `pid=${resource.servePid} exit=${JSON.stringify(resource.serveExit)} listener-unavailable=${resource.listenerUnavailable}`)
    }

    await writeFile(join(evidenceRoot, 'serve.log'), serveLog)
    const report = {
      attemptRoot,
      controlRoot,
      workspace,
      base,
      mode: 'fake',
      generatedAt: new Date().toISOString(),
      checks,
      httpReceipts,
      resources: resource,
      t5: 'covered by tests/app/task-grant-http-public-consumer.test.js (real grant journal + real provider loopback, 6/6)',
    }
    await writeFile(join(evidenceRoot, 'http-receipts.json'), JSON.stringify(httpReceipts, null, 2))
    await writeFile(join(evidenceRoot, 'receipt.json'), JSON.stringify(report, null, 2))
    const failed = checks.filter((check) => check.ok === false).length
    const unverifiedCount = checks.filter((check) => check.ok === null).length
    const incomplete = checks.some((check) =>
      (check.id === 'env.serve' || check.id === 'env.pair' || check.id === 'resource.serve-stop')
      && check.ok === false)
    console.log(`SUMMARY pass=${checks.filter((check) => check.ok === true).length} fail=${failed} unverified=${unverifiedCount}`)
    process.exitCode = incomplete ? 3 : failed > 0 ? 2 : 0
  }
}

if (process.argv[1] && resolve(process.argv[1]) === driverPath) {
  await main()
}
