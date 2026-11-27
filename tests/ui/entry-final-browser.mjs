// Isolated public-page acceptance. No service, provider or production writes.
// Failure basis: the shell's outer grid row could grow with 153 workspace
// groups or a long chat, pushing the composer below the viewport and losing
// independent scrolling. Impact: the user cannot send while browsing history.
// Cost: one short-lived Chromium and synthetic API fixtures, no runtime writes.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const root = resolve(import.meta.dirname, '../../docs/ui')
const evidence = process.env.ENTRY_LAYOUT_EVIDENCE || resolve(import.meta.dirname, '../../docs/verification/entry-final-20261123')
const red = process.env.DRAWER_LIGHT_DISMISS_RED === '1'
await mkdir(evidence, { recursive: true })
const browser = await playwright.chromium.launch({ headless: true })
const checks = []
const drawerDismissalMetrics = { mode: red ? 'red-disabled-helper' : 'green' }
let result = 'RUNNING'
let failure
const check = (name, condition, detail) => {
  assert.ok(condition, detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`)
  checks.push(name)
}
let reads = 0
let usageReads = 0
const writes = []
let longLayoutMetrics
let narrowLayoutMetrics
let drawerMetrics
const project = { projectKey: 'entry-acceptance', projectName: 'HumanAgent', agentName: 'Jenny',
  workspaceCwd: '/isolated/entry-acceptance', topicName: '主会话', mode: 'fake',
  agentId: 'agent-jenny', canonicalAddress: 'machine.entry-acceptance.Jenny', role: 'project-lead',
  scope: { kind: 'project', projectKey: 'entry-acceptance' } }
const projectUrl = 'http://entry-acceptance.test/?scope=project&projectKey=entry-acceptance&mode=fake'
const task = { taskId: { value: 'acceptance-task' }, title: '隔离验收任务', semanticTitle: '隔离验收任务', state: 'running',
  stateLabel: '执行中', updatedAt: '2026-11-23T12:00:00Z' }
let reply = false
let addedProject = false
let catalogState = 'populated'
let longLayout = false
const longProjects = Array.from({ length: 153 }, (_, index) => ({
  scope: { projectKey: index === 0 ? project.projectKey : `entry-long-project-${index}` },
  label: index === 0 ? project.projectName : `项目 ${index + 1}`,
  workspaceCwd: `/isolated/entry-long-workspace-${index}`,
}))
const projection = () => ({ ...project, surface: 'main-topic', tasks: [task], activeTask: task,
  turns: longLayout ? Array.from({ length: 160 }, (_, index) => ({
    turnId: `long-turn-${index}`,
    role: index % 2 === 0 ? 'user' : 'jenny',
    kind: 'message',
    text: index % 2 === 0 ? `第 ${index / 2 + 1} 轮长聊天问题：请比较含税价和未税价，并说明报价口径。`
      : `第 ${(index + 1) / 2} 轮长聊天回答：统一税价口径后再比较报价，避免把税额重复计入。`,
  })) : [{ turnId: 'user-one', role: 'user', kind: 'message', text: '含税价和未税价有什么区别？' },
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
        } else data = { projects: catalogState === 'empty' ? [] : longLayout ? longProjects : [
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
    let body = await readFile(path)
    // Recreate the pre-fix runtime without mutating this shared worktree. The
    // surrounding page, call sites and coordinates stay identical in red/green.
    if (red && path.endsWith('/runtime-shell.js')) {
      body = String(body)
        .replace("dialog.setAttribute('closedby', 'any')", 'void dialog')
        .replace('if (dialog.open && !startedInside && !insideRect(event)) dialog.close()', 'void dialog')
    }
    return route.fulfill({ contentType: type, body })
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(projectUrl)
  await page.locator('.entry-jenny').waitFor()
  await page.locator('[data-task-list-drawer-trigger]').waitFor({ state: 'attached' })
  check('desktop rail is 222px', (await page.locator('.entry-rail').boundingBox()).width === 222)
  check('only public Jenny is nested under members', await page.locator('.entry-members .entry-person').count() === 1)
  check('no placeholder member tree', !await page.getByText('成员目录 · 暂未接入').count())
  await page.getByRole('button', { name: '项目设置', exact: true }).click()
  await page.getByText('选择一条或多条真实登记', { exact: false }).waitFor()
  await page.reload()
  await page.getByText('选择一条或多条真实登记', { exact: false }).waitFor()
  check('project settings dialog restores after reload', await page.locator('dialog[open] #technical-detail-title').textContent() === '项目设置')
  await page.locator('dialog[open] .shell-layer-close').click()
  check('project settings close button still closes the drawer',
    await page.locator('dialog[data-technical-detail="true"][open]').count() === 0)
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
  const desktopTaskDrawerBox = await page.locator('dialog[data-technical-detail="true"][open]').boundingBox()
  drawerDismissalMetrics.desktopRight = { rect: desktopTaskDrawerBox, outside: { x: 8, y: 8 } }
  await page.mouse.click(8, 8)
  const desktopDismissState = await page.locator('dialog[data-technical-detail="true"]').first().evaluate((dialog) => ({
    open: dialog.open,
    closedby: dialog.getAttribute('closedby'),
    rect: dialog.getBoundingClientRect().toJSON(),
  })).catch(() => null)
  check('desktop right drawer closes from a point outside its rect',
    await page.locator('dialog[data-technical-detail="true"][open]').count() === 0 && desktopTaskDrawerBox?.x > 8,
    { desktopTaskDrawerBox, desktopDismissState })
  check('desktop right drawer returns focus to its trigger',
    await page.evaluate(() => document.activeElement?.matches('[data-entry-dialog="任务板"]')), null)
  await page.getByRole('button', { name: '任务板', exact: true }).click()
  await page.locator('[data-task-list-drawer] .dispatch-board-entry').waitFor()
  await page.keyboard.press('Escape')
  check('Escape still closes an ordinary drawer and returns focus',
    await page.locator('dialog[data-technical-detail="true"][open]').count() === 0
      && await page.evaluate(() => document.activeElement?.matches('[data-entry-dialog="任务板"]')))
  await page.getByRole('button', { name: '任务板', exact: true }).click()
  await page.locator('[data-task-list-drawer] .dispatch-board-entry').waitFor()
  const desktopDrawerRow = await page.locator('[data-task-list-drawer] .dispatch-board-entry').boundingBox()
  await page.mouse.move(desktopDrawerRow.x + 8, desktopDrawerRow.y + 8)
  await page.mouse.down()
  await page.mouse.move(8, 8, { steps: 8 })
  await page.mouse.up()
  check('dragging from inside the desktop drawer does not dismiss it',
    await page.locator('dialog[data-technical-detail="true"][open]').count() === 1, desktopTaskDrawerBox)
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
  const scheduleDrawerBox = await page.locator('.entry-schedule-dialog[open]').boundingBox()
  drawerDismissalMetrics.desktopSchedule = { rect: scheduleDrawerBox, outside: { x: 200, y: 8 } }
  await page.mouse.click(200, 8)
  check('schedule drawer closes from a desktop point outside its rect',
    await page.locator('.entry-schedule-dialog[open]').count() === 0 && scheduleDrawerBox?.x > 8, scheduleDrawerBox)
  await page.waitForFunction(() => document.activeElement?.matches('[data-entry-schedule-trigger]'))
  check('schedule drawer returns focus to its trigger',
    await page.evaluate(() => document.activeElement?.matches('[data-entry-schedule-trigger]')), null)
  await page.getByRole('button', { name: '定时任务', exact: true }).click()
  await page.locator('.entry-schedule-dialog[open]').waitFor()
  const scheduleFieldBox = await page.locator('.entry-schedule-dialog[open] input[name=timezone]').boundingBox()
  await page.mouse.move(scheduleFieldBox.x + 8, scheduleFieldBox.y + 8)
  await page.mouse.down()
  await page.mouse.move(8, 8, { steps: 8 })
  await page.mouse.up()
  check('dragging from inside the schedule drawer does not dismiss it',
    await page.locator('.entry-schedule-dialog[open]').count() === 1, scheduleDrawerBox)
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
  await page.getByRole('button', { name: '任务板', exact: true }).click()
  await page.locator('[data-task-list-drawer] .dispatch-board-entry').waitFor()
  const mobileTaskDrawerBox = await page.locator('dialog[data-technical-detail="true"][open]').boundingBox()
  const mobileDrawerRowBox = await page.locator('[data-task-list-drawer] .dispatch-board-entry').boundingBox()
  drawerDismissalMetrics.mobileBottom = { rect: mobileTaskDrawerBox, outside: { x: 200, y: 8 } }
  await page.mouse.move(mobileDrawerRowBox.x + 8, mobileDrawerRowBox.y + 8)
  await page.mouse.down()
  await page.mouse.move(200, 8, { steps: 8 })
  await page.mouse.up()
  check('dragging from inside the mobile bottom drawer does not dismiss it',
    await page.locator('dialog[data-technical-detail="true"][open]').count() === 1, mobileTaskDrawerBox)
  await page.mouse.click(200, 8)
  check('mobile bottom drawer closes from a point outside its rect',
    await page.locator('dialog[data-technical-detail="true"][open]').count() === 0
      && mobileTaskDrawerBox?.y > 8,
    mobileTaskDrawerBox)
  check('mobile bottom drawer returns focus to its trigger',
    await page.evaluate(() => document.activeElement?.matches('[data-entry-dialog="任务板"]')), null)
  await page.getByRole('button', { name: '打开项目菜单' }).click()
  await page.getByRole('button', { name: '关闭菜单' }).waitFor()
  const mobileRailBox = await page.locator('.entry-rail-dialog[open]').boundingBox()
  drawerDismissalMetrics.mobileNavigation = { rect: mobileRailBox, outside: { x: 380, y: 820 } }
  await page.mouse.click(380, 820)
  check('mobile project navigation closes from a point outside its rect',
    await page.locator('.entry-rail-dialog[open]').count() === 0 && mobileRailBox?.x + mobileRailBox?.width < 380, mobileRailBox)
  check('mobile project navigation returns focus to its menu trigger',
    await page.evaluate(() => document.activeElement?.matches('[aria-label="打开项目菜单"]')), null)
  await page.getByRole('button', { name: '打开项目菜单' }).click()
  await page.getByRole('button', { name: '关闭菜单' }).waitFor()
  const railBox = await page.locator('.entry-rail-dialog[open]').boundingBox()
  await page.mouse.move(railBox.x + 40, railBox.y + 40)
  await page.mouse.down()
  await page.mouse.move(railBox.x + 80, railBox.y + 40, { steps: 4 })
  await page.mouse.up()
  check('dragging inside mobile project navigation does not dismiss it',
    await page.locator('.entry-rail-dialog[open]').count() === 1, mobileRailBox)
  await page.reload()
  await page.getByRole('button', { name: '关闭菜单' }).waitFor()
  check('mobile menu restores after reload', await page.locator('.entry-rail-dialog').evaluate((el) => el.open))
  await page.getByRole('button', { name: '关闭菜单' }).click()
  await page.screenshot({ path: resolve(evidence, 'mobile-390.png') })
  check('mobile page has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  const approvalDialogFactory = await page.evaluate(async () => {
    const { createTaskDecisionPrompt } = await import('./product-control-view.js')
    const taskId = { scope: 'task', value: 'acceptance-task' }
    const scope = { kind: 'task', projectKey: 'entry-acceptance', mode: 'fake', taskId }
    const decision = {
      kind: 'task-grant',
      state: 'waiting',
      question: '需要授权后继续执行。',
      actions: ['grant'],
      target: { kind: 'interaction', taskRef: taskId, scope },
      readback: { grant: null, commit: null },
      presentation: { taskTitle: '隔离验收任务', requesterName: 'Jenny', recipientName: 'HumanAgent', projectName: 'HumanAgent' },
    }
    const prompt = createTaskDecisionPrompt({ api: {}, host: document.body })
    prompt.sync(decision, { projectKey: scope.projectKey, mode: scope.mode, taskId: taskId.value }, '隔离验收任务')
    window.approvalPrompt = prompt
    const dialog = document.querySelector('dialog.task-decision-prompt[open]')
    return {
      closedby: dialog?.getAttribute('closedby') ?? null,
      openBefore: Boolean(dialog?.open),
    }
  })
  check('approval dialogs do not receive ordinary drawer light dismiss',
    approvalDialogFactory.closedby === null,
    { closedby: approvalDialogFactory.closedby, openBefore: approvalDialogFactory.openBefore })
  const approvalGeometry = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.task-decision-prompt[open]')
    return dialog ? {
      open: dialog.open,
      rect: dialog.getBoundingClientRect().toJSON(),
    } : null
  })
  check('approval prompt is open before its outside-click probe', approvalGeometry?.open)
  if (!approvalGeometry) throw new Error('approval prompt left the page before its outside-click probe')
  const approvalBox = approvalGeometry.rect
  const approvalOutside = { x: 8, y: Math.max(8, approvalBox.y - 8) }
  drawerDismissalMetrics.approval = { rect: approvalBox, outside: approvalOutside }
  await page.mouse.click(approvalOutside.x, approvalOutside.y)
  check('an approval dialog stays open after an outside click',
    await page.locator('dialog.task-decision-prompt[open]').count() === 1,
    { approvalBox, approvalOutside })
  await page.locator('dialog.task-decision-prompt[open] [data-product-role="close-control-modal"]').click()
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
  catalogState = 'populated'
  longLayout = true
  await page.setViewportSize({ width: 1905, height: 1080 })
  await page.goto(projectUrl)
  await page.locator('.entry-jenny').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.entry-project').length === 153)
  await page.locator('.entry-project').evaluateAll((nodes) => { for (const node of nodes) node.open = true })
  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect()
      return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width } : null
    }
    const rail = document.querySelector('.entry-rail')
    const primary = document.querySelector('.page-primary')
    return {
      viewport: { width: innerWidth, height: innerHeight },
      root: box('#page-root'),
      page: box('#page-root > .page'),
      rail: box('.entry-rail'),
      composer: box('.page-composer'),
      railScroll: rail ? { clientHeight: rail.clientHeight, scrollHeight: rail.scrollHeight } : null,
      chatScroll: primary ? { clientHeight: primary.clientHeight, scrollHeight: primary.scrollHeight } : null,
    }
  })
  longLayoutMetrics = layout
  check('long catalog and chat keep the page inside the viewport',
    layout.page.height <= layout.viewport.height + 1)
  check('long catalog and chat keep the composer inside the viewport',
    layout.composer.top >= 0 && layout.composer.bottom <= layout.viewport.height + 1)
  check('long catalog scrolls inside the bounded rail',
    layout.rail.height <= layout.viewport.height + 1 && layout.railScroll.scrollHeight > layout.railScroll.clientHeight)
  check('long chat scrolls inside the bounded main column',
    layout.chatScroll.scrollHeight > layout.chatScroll.clientHeight)
  const railScrolled = await page.locator('.entry-rail').evaluate((node) => {
    node.scrollTop = node.scrollHeight
    return node.scrollTop > 0
  })
  const chatScrolled = await page.locator('.page-primary').evaluate((node) => {
    node.scrollTop = node.scrollHeight
    return node.scrollTop > 0
  })
  check('long catalog rail remains independently scrollable', railScrolled)
  check('long chat remains independently scrollable', chatScrolled)
  const composerAfterScroll = await page.locator('.page-composer').boundingBox()
  check('composer stays inside the viewport after chat and rail scroll',
    composerAfterScroll.y >= 0 && composerAfterScroll.y + composerAfterScroll.height <= 1081)
  await page.screenshot({ path: resolve(evidence, 'long-layout-1905.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '打开项目菜单' }).waitFor()
  const narrow = await page.evaluate(() => {
    const composer = document.querySelector('.page-composer')?.getBoundingClientRect()
    const primary = document.querySelector('.page-primary')
    return {
      composer: composer ? { top: composer.top, bottom: composer.bottom } : null,
      chatScroll: primary ? { clientHeight: primary.clientHeight, scrollHeight: primary.scrollHeight } : null,
    }
  })
  narrowLayoutMetrics = narrow
  check('narrow viewport keeps the long-chat composer inside the viewport',
    narrow.composer.top >= 0 && narrow.composer.bottom <= 845)
  check('narrow viewport keeps the long chat scrollable',
    narrow.chatScroll.scrollHeight > narrow.chatScroll.clientHeight)
  check('narrow viewport keeps the project drawer closed', !await page.locator('.entry-rail').isVisible())
  await page.getByRole('button', { name: '打开项目菜单' }).click()
  await page.getByRole('button', { name: '关闭菜单' }).waitFor()
  const drawer = await page.evaluate(() => {
    const dialog = document.querySelector('.entry-rail-dialog')?.getBoundingClientRect()
    const rail = document.querySelector('.entry-rail')
    return {
    dialog: dialog ? { top: dialog.top, bottom: dialog.bottom, left: dialog.left, right: dialog.right } : null,
      railScroll: rail ? { clientHeight: rail.clientHeight, scrollHeight: rail.scrollHeight } : null,
    }
  })
  drawerMetrics = drawer
  check('narrow drawer stays inside the viewport and scrolls its long catalog',
    drawer.dialog.top >= 0 && drawer.dialog.bottom <= 845 && drawer.railScroll.scrollHeight > drawer.railScroll.clientHeight)
  await page.screenshot({ path: resolve(evidence, 'long-layout-390-drawer.png') })
  await page.getByRole('button', { name: '关闭菜单' }).click()
  check('no page errors', errors.length === 0)
  result = 'PASS'
  await context.close()
} catch (error) {
  result = 'FAIL'
  failure = error?.message ?? String(error)
  throw error
} finally {
  await browser.close()
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({
    result, failure, checks, drawerDismissalMetrics, reads, writes, longLayoutMetrics, narrowLayoutMetrics,
    drawerMetrics, cleanup: { browserClosed: !browser.isConnected(), noListeningServer: true, productionWrites: false },
  }, null, 2))
}
console.log(JSON.stringify({ result, checks, evidence }, null, 2))
