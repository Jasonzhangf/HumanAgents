#!/usr/bin/env node

/**
 * Real-browser proof for the entry task-list drawer (requirement v35
 * `humanagent-entry-task-list-in-drawer`).
 *
 * The proof starts a test-only static server for this worktree's docs/ui and
 * proxies /api/* to the live runtime. It reads /api/tasks from that runtime
 * before opening the browser, so the drawer assertions use the real task rows
 * rather than a fixture.
 *
 * Set `ENTRY_DRAWER_EVIDENCE` to the execution-owned evidence root. Optional:
 *   ENTRY_DRAWER_UI_ROOT    default docs/ui
 *   ENTRY_DRAWER_RUNTIME    default http://127.0.0.1:10086
 *   ENTRY_DRAWER_PLAYWRIGHT default /opt/homebrew/lib/node_modules/playwright/index.js
 *   ENTRY_DRAWER_BROWSER_ARGS default --single-process,--no-zygote
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startEntryDrawerServer } from './entry-task-list-drawer-server.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = resolve(process.env.ENTRY_DRAWER_UI_ROOT ?? join(repoRoot, 'docs', 'ui'))
const evidenceRoot = process.env.ENTRY_DRAWER_EVIDENCE?.trim()
const runtimeBase = process.env.ENTRY_DRAWER_RUNTIME?.trim() ?? 'http://127.0.0.1:10086'

if (!evidenceRoot) {
  throw new Error('ENTRY_DRAWER_EVIDENCE is required; point it at an execution-owned directory')
}

const servingCommand = [
  `ENTRY_DRAWER_UI_ROOT="${uiRoot}"`,
  `ENTRY_DRAWER_EVIDENCE="${evidenceRoot}"`,
  `ENTRY_DRAWER_RUNTIME="${runtimeBase}"`,
  process.execPath,
  fileURLToPath(import.meta.url),
].join(' ')

const playwrightModule = await import(
  process.env.ENTRY_DRAWER_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule
const browserArgs = (process.env.ENTRY_DRAWER_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

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

function taskIdValue(taskId) {
  return taskId && typeof taskId === 'object' ? taskId.value : taskId
}

function listedTasks(tasks) {
  return [
    ...(tasks?.draft ?? []),
    ...(tasks?.waiting ?? []),
    ...(tasks?.running ?? []),
    ...(tasks?.completed ?? []),
    ...(tasks?.stopped ?? []),
    ...(tasks?.failed ?? []),
  ]
}

function sourceTitle(task) {
  return typeof task?.semanticTitle === 'string' && task.semanticTitle.trim() !== ''
    ? task.semanticTitle.trim()
    : '未整理名称的任务'
}

function sourceStatus(task) {
  return task?.stateLabel || task?.state || ''
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function readMainColumn() {
  const section = document.querySelector('#entry-live')
  const trigger = section?.querySelector('button[data-task-list-drawer-trigger="true"]') ?? null
  return {
    inlineRows: section ? section.querySelectorAll('a.task-row-link').length : -1,
    hasTrigger: Boolean(trigger),
    triggerLabel: (trigger?.textContent || '').trim(),
    triggerHaspopup: trigger?.getAttribute('aria-haspopup') ?? null,
    summaryText: (section?.textContent || '').replace(/\s+/g, ' ').trim(),
  }
}

function readDrawerRows() {
  const body = document.querySelector('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]')
  if (!body) return null
  return [...body.querySelectorAll('a.task-row-link')].map((link) => ({
    taskId: link.dataset.taskId,
    status: link.dataset.taskStatus,
    heading: (link.querySelector('h3')?.textContent || '').trim(),
    href: link.getAttribute('href'),
  }))
}

await mkdir(evidenceRoot, { recursive: true })
const server = await startEntryDrawerServer({ uiRoot, runtimeBase })

try {
  const api = await server.observeTasks()
  await writeFile(join(evidenceRoot, 'real-api-tasks.json'), api.text.endsWith('\n') ? api.text : `${api.text}\n`)
  if (api.status !== 200 || !api.body) {
    throw new Error(`live /api/tasks unavailable: HTTP ${api.status} :: ${api.text}`)
  }

  const expectedTasks = listedTasks(api.body)
  const expectedIds = expectedTasks.map((task) => taskIdValue(task.taskId))
  const expectedStatuses = expectedTasks.map(sourceStatus)
  const expectedTitles = expectedTasks.map(sourceTitle)
  const taskSource = {
    url: `${server.runtimeBase}/api/tasks`,
    status: api.status,
    contentType: api.contentType,
    responseFile: 'real-api-tasks.json',
    surface: api.body.surface,
    mode: api.body.mode,
    counts: api.body.counts,
    taskIds: expectedIds,
    stateLabels: [...new Set(expectedStatuses)],
    titles: expectedTitles,
  }
  observe('live /api/tasks response', taskSource)
  record('live /api/tasks responds 200', api.status === 200, api.status)
  record('live /api/tasks returns real task rows', expectedTasks.length > 0, expectedTasks.length)
  record('live /api/tasks observation records every task id', sameArray(taskSource.taskIds, expectedIds), taskSource.taskIds)

  const VIEWPORTS = [
    { label: 'desktop-1440', viewport: { width: 1440, height: 1000 } },
    { label: 'mobile-390', viewport: { width: 390, height: 844 } },
  ]

  async function runScenario({ label, viewport }) {
    const browser = await playwright.chromium.launch({ headless: true, args: browserArgs })
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const pageErrors = []
    const mutatingApiRequests = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    context.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
        mutatingApiRequests.push(`${request.method()} ${url.pathname}`)
      }
    })

    try {
      await page.goto(`${server.baseUrl}/index.html`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('#entry-form textarea[name="rawInput"]')
      await page.waitForFunction((expectedCount) => {
        const section = document.querySelector('#entry-live')
        return Boolean(section && section.textContent && section.textContent.includes(expectedCount))
      }, String(expectedTasks.length), { timeout: 10_000 })

      const main = await page.evaluate(readMainColumn)
      observe(`${label} entry main column`, main)
      record(`${label} entry main column exposes the task-list trigger`, main.hasTrigger === true, main)
      record(`${label} entry main column does not render the inline task list rows`, main.inlineRows === 0, main.inlineRows)
      record(
        `${label} entry main column keeps the live task count`,
        main.summaryText.includes('任务数量') && main.summaryText.includes(String(expectedTasks.length)),
        main.summaryText,
      )
      record(`${label} the task-list trigger advertises a dialog`, main.triggerHaspopup === 'dialog', main.triggerHaspopup)

      await page.click('button[data-task-list-drawer-trigger="true"]')
      await page
        .locator('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 })
      const rows = await page.evaluate(readDrawerRows)
      observe(`${label} drawer rows`, rows)
      record(`${label} the drawer opens with the live task list`, Array.isArray(rows) && rows.length === expectedTasks.length, rows)
      record(
        `${label} drawer rows carry the live task ids`,
        sameArray((rows ?? []).map((row) => row.taskId), expectedIds),
        { expected: expectedIds, actual: (rows ?? []).map((row) => row.taskId) },
      )
      record(
        `${label} drawer rows carry the live task states`,
        sameArray((rows ?? []).map((row) => row.status), expectedStatuses),
        { expected: expectedStatuses, actual: (rows ?? []).map((row) => row.status) },
      )
      record(
        `${label} drawer rows carry the live semantic titles`,
        sameArray((rows ?? []).map((row) => row.heading), expectedTitles),
        { expected: expectedTitles, actual: (rows ?? []).map((row) => row.heading) },
      )
      record(
        `${label} drawer rows link to the task dashboard`,
        (rows ?? []).every((row) => typeof row.href === 'string' && row.href.includes('task-dashboard.html')),
        (rows ?? []).map((row) => row.href),
      )

      const overflow = await page.evaluate(() => {
        const body = document.querySelector('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]')
        if (!body) return null
        return {
          scrollWidth: body.scrollWidth,
          clientWidth: body.clientWidth,
          overflowX: body.scrollWidth > body.clientWidth + 1,
        }
      })
      observe(`${label} drawer overflow`, overflow)
      record(`${label} drawer content has no horizontal overflow`, overflow !== null && overflow.overflowX === false, overflow)
      await page.screenshot({ path: join(evidenceRoot, `entry-task-list-drawer-open-${label}.png`) })

      await page.locator('dialog[data-technical-detail="true"][open] button.shell-layer-close').first().click()
      await page.locator('dialog[data-technical-detail="true"]').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      const afterClose = {
        openDrawers: await page.evaluate(() => document.querySelectorAll('dialog[data-technical-detail="true"][open]').length),
        ...(await page.evaluate(readMainColumn)),
        inputPresent: await page.evaluate(() => Boolean(document.querySelector('#entry-form textarea[name="rawInput"]'))),
      }
      observe(`${label} after close`, afterClose)
      record(`${label} closing the drawer hides it again`, afterClose.openDrawers === 0, afterClose.openDrawers)
      record(`${label} the task-list trigger remains on the entry page`, afterClose.hasTrigger === true, afterClose.hasTrigger)
      record(`${label} the entry form stays available after the drawer closes`, afterClose.inputPresent === true, afterClose.inputPresent)
      record(`${label} closing the drawer does not navigate away`, new URL(page.url()).pathname === '/index.html', page.url())
      await page.screenshot({ path: join(evidenceRoot, `entry-task-list-drawer-closed-${label}.png`) })

      // This is the post-close form path. A whitespace-only input reaches the
      // page's own trimmed validation and must stop before any mutating API.
      await page.locator('#entry-form textarea[name="rawInput"]').fill('   ')
      await page.locator('#entry-form button[type="submit"]').click()
      await page.locator('#entry-error').waitFor({ state: 'visible', timeout: 5_000 })
      const validation = await page.evaluate(() => ({
        message: (document.querySelector('#entry-error')?.textContent || '').replace(/\s+/g, ' ').trim(),
        formPresent: Boolean(document.querySelector('#entry-form')),
        path: window.location.pathname,
      }))
      await page.waitForTimeout(100)
      observe(`${label} post-close form validation`, { ...validation, mutatingApiRequests })
      record(
        `${label} empty entry after close shows the real validation without mutation`,
        validation.message.includes('请先填写任务输入')
          && validation.formPresent
          && validation.path === '/index.html'
          && mutatingApiRequests.length === 0,
        { ...validation, mutatingApiRequests },
      )
      await page.screenshot({ path: join(evidenceRoot, `entry-task-list-drawer-form-validation-${label}.png`) })

      await page.click('button[data-task-list-drawer-trigger="true"]')
      await page
        .locator('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 })
      const reopened = await page.evaluate(
        () => document.querySelectorAll(
          'dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"] a.task-row-link',
        ).length,
      )
      record(`${label} the drawer reopens with the same live task list`, reopened === expectedTasks.length, reopened)
      await page.keyboard.press('Escape')
      await page.locator('dialog[data-technical-detail="true"]').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      record(
        `${label} Escape closes the drawer back to the entry page`,
        await page.locator('dialog[data-technical-detail="true"][open]').count() === 0,
        null,
      )
      record(`${label} entry page produced no runtime errors`, pageErrors.length === 0, pageErrors)
    } catch (error) {
      record(`${label} entry task-list drawer proof completed`, false, error.message)
    } finally {
      await context.close().catch(() => {})
      await browser.close().catch(() => {})
    }
  }

  const startedAt = new Date().toISOString()
  for (const run of VIEWPORTS) {
    await runScenario(run)
  }
  const browserRun = {
    command: servingCommand,
    startedAt,
    finishedAt: new Date().toISOString(),
    viewports: VIEWPORTS.map(({ label, viewport }) => ({ label, viewport })),
    passes: failures === 0,
  }

  const result = {
    evidence: {
      servingCommand,
      staticRoot: server.uiRoot,
      apiProxyBase: server.runtimeBase,
      entryUrl: `${server.baseUrl}/index.html`,
      taskSource,
      browserRun,
    },
    checks,
    observations,
  }
  await writeFile(join(evidenceRoot, 'checks.json'), `${JSON.stringify(result, null, 2)}\n`)

  console.log(`entry task-list drawer checks: ${checks.length - failures}/${checks.length} passed`)
  for (const check of checks) {
    if (!check.pass) console.log(`FAIL: ${check.name} :: ${JSON.stringify(check.detail)}`)
  }
  console.log(failures === 0 ? 'entry task-list drawer checks passed' : 'entry task-list drawer checks FAILED')
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await server.close()
}
