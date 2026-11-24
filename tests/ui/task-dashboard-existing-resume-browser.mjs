#!/usr/bin/env node
/**
 * Isolated real-page consumer for the existing-task resume action.
 *
 * Failure modes covered: a formal task page has no resume action; the page
 * resumes a different task or omits project/mode; a repeated click sends a
 * second write; a typed refusal is hidden; a request whose outcome is unknown
 * is retried automatically; an unknown-effect hold offers a release action.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = join(repoRoot, 'docs', 'ui')
const evidenceRoot = process.env.HUMANAGENT_RESUME_UI_EVIDENCE?.trim()
  || join(repoRoot, 'docs', 'verification', 'existing-task-resume-ui-20261124')
await mkdir(evidenceRoot, { recursive: true })

const playwrightModule = await import(
  process.env.HUMANAGENT_RESUME_UI_PLAYWRIGHT || '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule

const scenario = {
  successTask: 'business-resume-task',
  executionTask: 'execution-resume-task',
  operationId: 'operation-resume-1',
  unknownTask: 'business-unknown-effect-task',
  ambiguousTask: 'business-multiple-executions-task',
  rejectionTask: 'business-resume-rejected-task',
  unknownResultTask: 'business-resume-unconfirmed-task',
}
const projectKey = 'resume-fixture-project'
const mode = 'fake'
const checks = []
const resumeRequests = []
const dashboardReads = new Map()
let successPosted = false
let nextDashboardDelayMs = 0

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail ?? null })
}

function writeJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

function dashboardBody(taskId, resumeTarget) {
  if (taskId === scenario.unknownTask) {
    return {
      surface: 'runtime-task-dashboard',
      mode,
      taskId: { scope: 'task', value: taskId },
      taskTitle: '未知副作用夹具任务',
      state: 'blocked',
      stateLabel: '受阻',
      currentNode: 'checkpoint.recovery-hold',
      input: '继续一个副作用未知的任务',
      output: null,
      statusSections: { business: '受阻', waiting: '等待恢复条件确认' },
      recentEvents: [],
      history: { events: [], hasMore: false, omitted: 0, gap: false, total: 0 },
      publicOutput: null,
      nextStep: '核实该操作的实际结果并由恢复入口记录后，才能重新检查恢复条件。',
      error: {
        code: 'task.recovery.effect-unknown',
        ownerId: 'humanagent.runtime',
        message: '上一次变更的结果尚未确认。',
        nextAction: '核实该操作的实际结果并由恢复入口记录。',
      },
      checkpoint: {
        checkpointId: 'checkpoint-unknown',
        seq: 1,
        outcome: 'recovery-hold-effect-unknown',
        recoveryOutcome: 'recovery-hold-effect-unknown',
        summary: '未知副作用保持阻断',
      },
      allowedActions: [],
      observationRef: `task://${taskId}/observation`,
      taskPlanHistory: {
        ok: false,
        failure: {
          code: 'task-plan-history.not-composed',
          ownerId: 'humanagent.ui.projection.runtime',
          message: '本夹具不读取任务计划历史',
          nextAction: '核对恢复动作',
        },
      },
    }
  }
  const completed = taskId === scenario.successTask && successPosted
  return {
    surface: 'runtime-task-dashboard',
    mode,
    taskId: { scope: 'task', value: taskId },
    taskTitle: taskId === scenario.successTask ? '安全续办夹具任务' : '续办拒绝夹具任务',
    state: completed ? 'waiting' : 'blocked',
    stateLabel: completed ? '等待中' : '受阻',
    currentNode: completed ? 'resume.released' : 'checkpoint.cold-resume',
    input: '继续原来的任务',
    output: null,
    statusSections: {
      business: completed ? '等待中' : '受阻',
      waiting: completed ? '原执行已释放' : '等待用户确认原任务续办',
    },
    recentEvents: [],
    history: { events: [], hasMore: false, omitted: 0, gap: false, total: 0 },
    publicOutput: null,
    nextStep: completed ? '等待执行继续' : '确认后继续原任务',
    ...(completed ? {} : {
      error: {
        code: 'cold-execution.held',
        ownerId: 'humanagent.runtime',
        message: '原执行仍保留恢复责任。',
        nextAction: '确认后继续原任务。',
      },
    }),
    allowedActions: [],
    observationRef: `task://${taskId}/observation`,
    resumeTarget,
    ...(taskId === scenario.ambiguousTask ? {
      resumeIssue: { code: 'task.execution.ambiguous',
        message: '这项任务有多条执行记录，无法确定要继续哪一条。',
        nextAction: '在任务列表中展开这项任务，选择要继续的执行。' },
    } : {}),
    taskPlanHistory: {
      ok: false,
      failure: {
        code: 'task-plan-history.not-composed',
        ownerId: 'humanagent.ui.projection.runtime',
        message: '本夹具不读取任务计划历史',
        nextAction: '核对恢复动作',
      },
    },
  }
}

function targetFor(taskId) {
  if (taskId !== scenario.successTask && taskId !== scenario.rejectionTask
    && taskId !== scenario.unknownResultTask) return undefined
  return { taskId: scenario.executionTask, operationId: scenario.operationId }
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/api/runtime/status') {
    return writeJson(res, 200, {
      mode: 'fake', state: 'ready', providerState: 'ready', connected: true,
      modes: [{ mode: 'fake', available: true }],
    })
  }
  if (url.pathname === '/api/ui/display-preference') {
    return writeJson(res, 200, { preference: { mode: 'current', lastManual: 'current' }, defaultMode: 'current' })
  }
  const dashboardMatch = /^\/api\/tasks\/([^/]+)\/dashboard$/.exec(url.pathname)
  if (dashboardMatch && req.method === 'GET') {
    const taskId = decodeURIComponent(dashboardMatch[1])
    dashboardReads.set(taskId, (dashboardReads.get(taskId) ?? 0) + 1)
    const delayMs = nextDashboardDelayMs
    nextDashboardDelayMs = 0
    if (delayMs > 0) await new Promise((ready) => setTimeout(ready, delayMs))
    return writeJson(res, 200, dashboardBody(taskId, targetFor(taskId)))
  }
  const resumeMatch = /^\/api\/tasks\/([^/]+)\/resume$/.exec(url.pathname)
  if (resumeMatch && req.method === 'POST') {
    let text = ''
    for await (const chunk of req) text += chunk
    resumeRequests.push({
      taskId: decodeURIComponent(resumeMatch[1]),
      projectKey: url.searchParams.get('projectKey'),
      mode: url.searchParams.get('mode'),
      body: text,
      referer: String(req.headers.referer || ''),
    })
    const referer = String(req.headers.referer || '')
    if (referer.includes(`task=${encodeURIComponent(scenario.unknownResultTask)}`)) {
      return writeJson(res, 202, {
        state: 'unknown',
        taskId: scenario.executionTask,
        operationId: scenario.operationId,
      })
    }
    if (referer.includes(`task=${encodeURIComponent(scenario.rejectionTask)}`)) {
      return writeJson(res, 409, { error: {
        code: 'cold-execution.operation-mismatch',
        ownerId: 'humanagent.runtime',
        message: '原 operation 已变化。',
        nextAction: '刷新任务页并重新确认原任务。',
      } })
    }
    successPosted = true
    return writeJson(res, 202, {
      state: 'released',
      taskId: scenario.executionTask,
      operationId: scenario.operationId,
      businessTurnId: 'business-turn-resume-1',
    })
  }
  if (url.pathname === '/api/product/session') return writeJson(res, 200, { messages: [] })
  if (url.pathname === '/api/product/output') return writeJson(res, 200, { publication: null, commits: [] })
  if (url.pathname === '/api/product/relations') return writeJson(res, 200, { relations: [], gaps: [] })
  if (url.pathname === '/api/product/decision') return writeJson(res, 200, { decisions: [] })
  if (url.pathname === '/api/product/board') return writeJson(res, 200, { boardIndex: { boards: [] }, failures: [] })

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

await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const baseUrl = `http://127.0.0.1:${server.address().port}`

let browser
const consoleErrors = []
try {
  browser = await playwright.chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

  const targetUrl = (taskId) => `${baseUrl}/task-dashboard.html?${new URLSearchParams({
    task: taskId, projectKey, mode,
  })}`

  await page.goto(targetUrl(scenario.successTask), { waitUntil: 'domcontentloaded' })
  const resumeButton = page.getByRole('button', { name: '继续原任务' })
  await resumeButton.waitFor({ state: 'visible', timeout: 10_000 })
  check('formal task page renders the independent resume action', await resumeButton.isEnabled())
  check(
    'resume action exposes the current blocker in the main layer',
    (await page.locator('body').innerText()).includes('原执行仍保留恢复责任。'),
  )

  const readsBefore = dashboardReads.get(scenario.successTask) ?? 0
  await resumeButton.evaluate((button) => {
    button.click()
    button.click()
  })
  await page.getByText('已继续原任务。', { exact: false }).waitFor({ timeout: 10_000 })
  const firstSuccessRequest = resumeRequests[0]
  check('one user action sends one resume POST', resumeRequests.length === 1, resumeRequests)
  check(
    'resume POST uses the execution task from resumeTarget',
    firstSuccessRequest?.taskId === scenario.executionTask,
    firstSuccessRequest,
  )
  check(
    'resume POST carries exact project and mode scope',
    firstSuccessRequest?.projectKey === projectKey && firstSuccessRequest?.mode === mode,
    firstSuccessRequest,
  )
  check(
    'resume POST body contains only the retained operation',
    firstSuccessRequest?.body === JSON.stringify({ operationId: scenario.operationId }),
    firstSuccessRequest,
  )
  check(
    'released receipt triggers a fresh dashboard read',
    (dashboardReads.get(scenario.successTask) ?? 0) > readsBefore,
    { before: readsBefore, after: dashboardReads.get(scenario.successTask) },
  )

  await page.goto(targetUrl(scenario.unknownTask), { waitUntil: 'domcontentloaded' })
  await page.getByText('未知副作用保持阻断', { exact: false }).waitFor({ timeout: 10_000 })
  const unknownText = await page.locator('body').innerText()
  check(
    'unknown effect page explains the blocked resume condition',
    unknownText.includes('上一次变更的结果尚未确认。')
      && unknownText.includes('核实该操作的实际结果并由恢复入口记录'),
    unknownText.slice(0, 400),
  )
  check(
    'unknown effect page offers no resume action',
    await page.getByRole('button', { name: '继续原任务' }).count() === 0,
  )

  await page.goto(targetUrl(scenario.ambiguousTask), { waitUntil: 'domcontentloaded' })
  await page.getByText('选择要继续的执行。', { exact: false }).waitFor({ timeout: 10_000 })
  check('ambiguous parent reports which choice is needed without a resume action',
    await page.getByRole('button', { name: '继续原任务' }).count() === 0 && resumeRequests.length === 1)

  await page.goto(targetUrl(scenario.rejectionTask), { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '继续原任务' }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: '继续原任务' }).click()
  await page.getByText('cold-execution.operation-mismatch', { exact: false }).waitFor({ timeout: 10_000 })
  const rejectionText = await page.locator('body').innerText()
  check(
    'typed refusal keeps its exact code, reason, and next action',
    rejectionText.includes('cold-execution.operation-mismatch')
      && rejectionText.includes('原 operation 已变化。')
      && rejectionText.includes('刷新任务页并重新确认原任务。'),
    rejectionText.slice(0, 500),
  )

  await page.goto(targetUrl(scenario.unknownResultTask), { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '继续原任务' }).waitFor({ state: 'visible', timeout: 10_000 })
  const unknownResultButton = page.getByRole('button', { name: '继续原任务' })
  const requestsBeforeUnknown = resumeRequests.length
  await unknownResultButton.click()
  await page.getByText('继续结果尚未确认', { exact: false }).waitFor({ timeout: 10_000 })
  await unknownResultButton.evaluate((button) => button.click()).catch(() => undefined)
  await page.waitForTimeout(150)
  check(
    'unknown request outcome is not retried automatically',
    resumeRequests.length === requestsBeforeUnknown + 1,
    resumeRequests,
  )
  check(
    'unknown request outcome blocks duplicate action',
    await unknownResultButton.isDisabled(),
  )

  const unknownReadsBeforeRefresh = dashboardReads.get(scenario.unknownResultTask) ?? 0
  nextDashboardDelayMs = 500
  await page.getByRole('button', { name: '刷新当前范围' }).click()
  while ((dashboardReads.get(scenario.unknownResultTask) ?? 0) === unknownReadsBeforeRefresh) {
    await page.waitForTimeout(10)
  }
  await page.locator('[data-shell-section="view"]').evaluate((button) => button.click())
  await page.locator('[data-display-mode="current"]').evaluate((button) => button.click())
  check(
    'read refresh keeps an unknown receipt locked during its authoritative read',
    await unknownResultButton.isDisabled(),
  )
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-task-resume-action="resume"]')
    return Boolean(button && !button.disabled)
  }, undefined, { timeout: 10_000 })
  check(
    'a confirmed same-target read releases the refresh-time lock',
    await unknownResultButton.isEnabled(),
  )
  check(
    'refreshing or switching the reading mode sends no resume POST',
    resumeRequests.length === requestsBeforeUnknown + 1,
    resumeRequests,
  )
} finally {
  if (browser) await browser.close().catch(() => {})
  await new Promise((closed) => server.close(closed))
}

const failures = checks.filter((entry) => !entry.pass)
const evidence = {
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  surface: 'isolated-real-task-dashboard',
  baseUrl,
  projectKey,
  mode,
  checks,
  resumeRequests,
  dashboardReads: Object.fromEntries(dashboardReads),
  consoleErrors,
  failures,
}
await writeFile(join(evidenceRoot, 'whitebox-evidence.json'), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify(evidence, null, 2))
if (failures.length > 0) process.exitCode = 1
