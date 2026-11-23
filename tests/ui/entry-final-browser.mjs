// Isolated public-page acceptance. No service, provider or production writes.
// Failure basis: previous homepage had a permanent mobile rail, flat member
// placeholder, and two-row composer. Impact: unusable narrow conversation and
// missing task/schedule actions. Cost: one short-lived Chromium, no runtime.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const root = resolve(import.meta.dirname, '../../docs/ui')
const evidence = process.env.ENTRY_LAYOUT_EVIDENCE || resolve(import.meta.dirname, '../../docs/verification/entry-final-20261123')
await mkdir(evidence, { recursive: true })
const browser = await playwright.chromium.launch({ headless: true })
const checks = []
const check = (name, condition) => { assert.ok(condition, name); checks.push(name) }
let reads = 0
let usageReads = 0
const writes = []
const project = { projectKey: 'entry-acceptance', projectName: 'HumanAgent', agentName: 'Jenny',
  workspaceCwd: '/isolated/entry-acceptance', topicName: '主会话', mode: 'fake' }
const task = { taskId: { value: 'acceptance-task' }, title: '隔离验收任务', semanticTitle: '隔离验收任务', state: 'running',
  stateLabel: '执行中', updatedAt: '2026-11-23T12:00:00Z' }
let reply = false
let addedProject = false
let catalogState = 'populated'
const projection = () => ({ ...project, surface: 'main-topic', tasks: [task], activeTask: task,
  turns: [{ turnId: 'user-one', role: 'user', kind: 'message', text: '含税价和未税价有什么区别？' },
    { turnId: 'reply-one', role: 'jenny', kind: 'message', text: '比较报价时需要统一税价口径。', taskId: task.taskId },
    ...(reply ? [{ turnId: 'user-two', role: 'user', kind: 'message', text: '正常消息验收' },
      { turnId: 'reply-two', role: 'jenny', kind: 'message', text: '隔离服务已直接回答。' }] : [])] })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url())
    assert.equal(url.origin, 'http://entry-acceptance.test')
    if (url.pathname.startsWith('/api/')) {
      let data, status = 200
      if (req.method() !== 'GET') writes.push({ path: url.pathname, body: req.postDataJSON() })
      if (url.pathname === '/api/runtime/status') data = { mode: 'fake', state: 'ready', connected: true }
      else if (url.pathname === '/api/main-topic') { reads++; data = projection() }
      else if (url.pathname === '/api/dashboard') {
        if (catalogState === 'failed') {
          status = 503
          data = { error: { code: 'catalog.unavailable', message: '项目列表读取失败' } }
        } else data = { projects: catalogState === 'empty' ? [] : [
          { scope: { projectKey: project.projectKey }, label: project.projectName },
          ...(addedProject ? [{ scope: { projectKey: 'new-project' }, label: '新增工作区' }] : []),
        ] }
      }
      else if (url.pathname === '/api/projects/roster') data = { projectKey: url.searchParams.get('projectKey'), members: [] }
      else if (url.pathname === '/api/tasks') data = { draft: [], waiting: [], running: [task], completed: [], stopped: [], failed: [] }
      else if (url.pathname === '/api/product/session') {
        usageReads++
        data = { messages: [], usage: { calls: [{ callId: 'fixture-call', inputTokens: 42, outputTokens: 12, context: {} }] } }
      }
      else if (url.pathname === '/api/explicit/inputs') data = { interactionId: 'acceptance-chat' }
      else if (url.pathname === '/api/explicit/interactions/acceptance-chat') {
        reply = true; data = { state: 'answered', reply: '隔离服务已直接回答。' }
      } else { status = 404; data = { error: { code: 'fixture.unavailable', message: '此隔离入口未提供该能力' } } }
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    assert.ok(path.startsWith(root + '/'))
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)]
    return route.fulfill({ contentType: type, body: await readFile(path) })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://entry-acceptance.test/')
  await page.locator('.entry-jenny').waitFor()
  await page.locator('[data-task-list-drawer-trigger]').waitFor({ state: 'attached' })
  check('desktop rail is 222px', (await page.locator('.entry-rail').boundingBox()).width === 222)
  check('only public Jenny is nested under members', await page.locator('.entry-members .entry-person').count() === 1)
  check('no placeholder member tree', !await page.getByText('成员目录 · 暂未接入').count())
  await page.getByRole('button', { name: '项目设置', exact: true }).click()
  await page.getByText('当前公开接口支持读取项目', { exact: false }).waitFor()
  await page.reload()
  await page.getByText('当前公开接口支持读取项目', { exact: false }).waitFor()
  check('project settings dialog restores after reload', await page.locator('dialog[open] #technical-detail-title').textContent() === '项目设置')
  await page.locator('dialog[open] .shell-layer-close').click()
  const projectSummary = page.locator('.entry-project > summary').first()
  await projectSummary.focus()
  await projectSummary.evaluate(node => { window.originalProjectSummary = node })
  addedProject = true
  await page.locator('.entry-project > summary').getByText('新增工作区', { exact: true }).waitFor({ timeout: 8000 })
  check('a project appearing in the system read enters the rail without reload or focus loss',
    await projectSummary.evaluate(node => node === window.originalProjectSummary && node === document.activeElement && node.parentElement.open))
  addedProject = false
  await page.locator('.entry-project > summary').getByText('新增工作区', { exact: true }).waitFor({ state: 'detached', timeout: 8000 })
  await page.getByRole('button', { name: /调用明细/ }).click()
  const usageDialog = page.locator('.call-usage-details dialog[open]')
  const usageRow = usageDialog.locator('.call-usage-call')
  await usageRow.evaluate(node => { window.originalUsageRow = node })
  const usageBefore = usageReads
  await page.waitForResponse(response => response.url().includes('/api/product/session'))
  check('an unchanged call snapshot keeps the open detail and its row',
    usageReads > usageBefore && await usageRow.evaluate(node => node === window.originalUsageRow))
  await page.keyboard.press('Escape')
  await page.locator('textarea[name=rawInput]').fill('保留草稿')
  await page.locator('.entry-members > summary').click()
  const priorReads = reads
  await page.waitForFunction(() => document.querySelector('.entry-members')?.open === false)
  // Wait for an actual poll response, rather than replacing the DOM by hand.
  await page.waitForResponse((res) => res.url().includes('/api/main-topic'))
  check('poll retains collapsed tree', !await page.locator('.entry-members').evaluate((el) => el.open))
  check('poll performed', reads > priorReads)
  const width = (await page.locator('.main-topic-host').boundingBox()).width
  await page.getByRole('button', { name: '任务板', exact: true }).click()
  await page.locator('[data-task-list-drawer] .dispatch-board-entry').waitFor()
  check('task board contains task rows', await page.locator('[data-task-list-drawer] .dispatch-board-entry').count() === 1)
  check('task drawer does not resize timeline', (await page.locator('.main-topic-host').boundingBox()).width === width)
  await page.screenshot({ path: resolve(evidence, 'task-board-drawer.png') })
  await page.reload()
  await page.locator('[data-task-list-drawer] .dispatch-board-entry').waitFor()
  check('reload retains board and draft', await page.locator('textarea[name=rawInput]').inputValue() === '保留草稿')
  check('reload retains tree', !await page.locator('.entry-members').evaluate((el) => el.open))
  await page.locator('dialog[open] .shell-layer-close').click()
  await page.getByRole('button', { name: '定时任务', exact: true }).click()
  await page.locator('select[name=executionMode]').selectOption('scheduled')
  await page.locator('input[name=timezone]').fill('Asia/Shanghai')
  await page.reload()
  await page.locator('.entry-schedule-dialog[open]').waitFor()
  check('reload retains schedule selection', await page.locator('select[name=executionMode]').inputValue() === 'scheduled')
  check('reload retains schedule draft', await page.locator('input[name=timezone]').inputValue() === 'Asia/Shanghai')
  check('reload retains focus', await page.locator('input[name=timezone]').evaluate((el) => el === document.activeElement))
  check('schedule drawer does not resize timeline', (await page.locator('.main-topic-host').boundingBox()).width === width)
  await page.screenshot({ path: resolve(evidence, 'schedule-drawer.png') })
  await page.locator('select[name=executionMode]').selectOption('recurring')
  await page.locator('select[name=recurringFrequency]').selectOption('weekly')
  check('recurring form remains reachable', await page.locator('input[name=weekDays]').isVisible() && await page.locator('input[name=timeOfDay]').isVisible())
  await page.locator('select[name=executionMode]').selectOption('once')
  await page.getByRole('button', { name: '完成设置' }).click()
  await page.locator('.entry-members > summary').click()
  await page.screenshot({ path: resolve(evidence, 'desktop-1440.png') })
  const inputBox = await page.locator('textarea[name=rawInput]').boundingBox()
  const sendBox = await page.getByRole('button', { name: '发送给 Jenny', exact: true }).boundingBox()
  check('send is inside single-line input frame', sendBox.y >= inputBox.y && sendBox.y + sendBox.height <= inputBox.y + inputBox.height)
  await page.locator('textarea[name=rawInput]').fill('正常消息验收')
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.getByText('隔离服务已直接回答。', { exact: true }).waitFor()
  check('normal send uses existing public intake once', writes.length === 1 && writes[0].path === '/api/explicit/inputs')
  await page.setViewportSize({ width: 390, height: 844 })
  check('mobile rail defaults closed', !await page.locator('.entry-rail').isVisible())
  check('mobile chat occupies available width', (await page.locator('.main-topic-host').boundingBox()).width > 330)
  await page.getByRole('button', { name: '打开项目菜单' }).click()
  await page.getByRole('button', { name: '关闭菜单' }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '关闭菜单' }).waitFor()
  check('mobile menu restores after reload', await page.locator('.entry-rail-dialog').evaluate((el) => el.open))
  await page.getByRole('button', { name: '关闭菜单' }).click()
  await page.screenshot({ path: resolve(evidence, 'mobile-390.png') })
  check('mobile page has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.setViewportSize({ width: 619, height: 844 })
  check('619px still collapses navigation', !await page.locator('.entry-rail').isVisible())
  await page.setViewportSize({ width: 620, height: 844 })
  check('620px restores desktop rail', await page.locator('.entry-rail').isVisible())
  for (const [state, message] of [['empty', '暂无可读取的项目'], ['failed', '项目暂不可读，请检查连接状态。']]) {
    catalogState = state
    await page.goto('http://entry-acceptance.test/?scope=system')
    await page.getByText(message, { exact: true }).waitFor()
    check(`the ${state} catalog replaces its loading state`, await page.getByText('正在读取项目…', { exact: true }).count() === 0)
  }
  check('no page errors', errors.length === 0)
  await context.close()
} finally {
  await browser.close()
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ checks, reads, writes, cleanup: { browserClosed: !browser.isConnected(), noListeningServer: true, productionWrites: false } }, null, 2))
}
console.log(JSON.stringify({ result: 'PASS', checks, evidence }, null, 2))
