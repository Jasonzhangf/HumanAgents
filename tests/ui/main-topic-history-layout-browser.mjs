import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'

// Layout regression for the reported gray native button. Captured prose is
// reused without inventing a business result; extra shapes are layout probes.
const evidence = process.env.MAIN_TOPIC_LAYOUT_EVIDENCE
if (!evidence) throw new Error('MAIN_TOPIC_LAYOUT_EVIDENCE is required')
const root = resolve('docs/ui')
const captured = JSON.parse(await readFile(new URL('./fixtures/main-topic-interaction-1-20261123.json', import.meta.url)))
const turns = captured.mainTopic.turns
const projection = {
  ...captured.mainTopic, projectKey: 'workspace', mode: 'rcc',
  projectName: 'workspace', agentName: 'Jenny', topicName: '主话题',
  rounds: [{ roundKey: 'recorded-history', lane: 'history',
    userText: turns[0].text, summary: { text: turns[1].text },
    messageRefs: turns.map(turn => turn.turnId) }],
}
const receipt = { checks: [], errors: [], mutations: [], cleanup: {} }
let longLayout = false
// Explicit read-only layout data, served through the normal homepage reader.
const longProjection = { ...projection, turns: [], rounds: [] }
for (let i = 0; i < 18; i++) {
  const pair = turns.map((turn, j) => ({ ...turn, turnId: `scroll-layout-${i}-${j}` }))
  longProjection.turns.push(...pair)
  longProjection.rounds.push({ ...projection.rounds[0], roundKey: `scroll-layout-${i}`,
    messageRefs: pair.map(turn => turn.turnId) })
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path.startsWith('/api/')) {
    if (req.method !== 'GET') receipt.mutations.push({ method: req.method, path })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(path === '/api/main-topic' ? (longLayout ? longProjection : projection)
      : path === '/api/tasks' ? { waiting: [], running: [], completed: [], stopped: [], failed: [] }
      : path === '/api/product/session' ? { messages: [] }
      : { mode: 'rcc', state: 'ready', connected: true }))
    return
  }
  const file = resolve(root, path === '/' ? 'index.html' : `.${path}`)
  if (!file.startsWith(`${root}/`)) return res.writeHead(403).end()
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'text/plain')
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
})
await mkdir(evidence, { recursive: true })
await new Promise(done => server.listen(0, '127.0.0.1', done))
receipt.port = server.address().port
const { default: playwright } = await import('/opt/homebrew/lib/node_modules/playwright/index.js')
let browser
try {
  browser = await playwright.chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', error => receipt.errors.push(error.message))
  await page.goto(`http://127.0.0.1:${receipt.port}/index.html?project=workspace&mode=rcc`)
  await page.locator('#page-root.entry-workspace').waitFor()
  await page.locator('.mt-history-round').waitFor()
  assert.equal(await page.locator('.mt-head').innerText(), '主会话')
  assert.equal(await page.locator('.mt-history-user').evaluate(node => node.closest('button')), null)
  const trigger = page.locator('.mt-history-summary-button')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const drawer = page.locator('dialog[data-technical-detail][open]')
  await drawer.waitFor()
  assert.ok((await drawer.innerText()).includes(turns[0].text))
  assert.equal(await drawer.locator('.mt-turn--jenny .mt-turn-head').innerText(), 'Jenny')
  const box = await drawer.boundingBox()
  assert.ok(box.x > 0, 'actual detail opens on the right')
  receipt.drawerBounds = box
  await page.screenshot({ path: join(evidence, 'actual-history-drawer.png'), fullPage: true })
  await page.keyboard.press('Escape')
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true)
  await page.evaluate(async p => {
    const { renderMainTopic } = await import('/main-topic.js')
    window.layoutHost = document.querySelector('.main-topic-host')
    window.layoutProjection = p
    window.layoutTrigger = document.querySelector('.mt-history-summary-button')
    renderMainTopic(window.layoutHost, p)
  }, projection)
  assert.equal(await trigger.evaluate(node => node === window.layoutTrigger && node === document.activeElement), true)
  await page.keyboard.press('Space')
  await drawer.waitFor()
  await page.keyboard.press('Escape')
  receipt.checks.push('captured history: separate user, Enter/Space actual drawer, Escape focus, refresh node identity and callback retained')
  const taskId = { scope: 'task', value: 'layout-partial-read' }
  const readError = { turnId: 'detail-read-error:layout-partial-read', taskId, role: 'jenny', kind: 'status',
    text: '执行详情读取失败', detailReadError: { message: '本次工具记录读取失败' } }
  await page.route('**/api/main-topic*', route => route.fulfill({ json: {
    ...projection, tasks: [{ taskId, state: 'completed', title: '读取工具报告', sourceInteractionId: turns[1].interactionId }],
    turns: [...turns, readError], rounds: [{ ...projection.rounds[0], lane: 'active', messageRefs: [...projection.rounds[0].messageRefs, readError.turnId] }],
  } }))
  await page.reload()
  assert.equal(await page.locator('.mt-detail-read-error').innerText(), readError.detailReadError.message)
  await page.locator('.dispatch-card').waitFor()
  receipt.checks.push('dispatched task and scoped detail read error are visible together')
  await page.unroute('**/api/main-topic*')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    // Each viewport starts from a fresh entry; keyboard/drawer checks above
    // retain one live page to exercise refresh and focus restoration.
    await page.reload()
    await page.locator('.mt-history-round').waitFor()
    await page.evaluate(p => {
      window.layoutHost = document.querySelector('.main-topic-host')
      window.layoutProjection = p
    }, projection)
    await page.screenshot({ path: join(evidence, `captured-${width}.png`), fullPage: true })
    // Explicit layout probes, never claimed as runtime or model data.
    const geometry = await page.evaluate(async () => {
      const { renderMainTopic } = await import('/main-topic.js')
      const p = structuredClone(window.layoutProjection)
      p.turns[0].quote = '布局探针：引用问题'
      p.turns[0].text = 'long_unbroken_layout_probe_'.repeat(35)
      p.rounds[0].userText = p.turns[0].text
      p.rounds[0].summary.text = 'long_summary_layout_probe_'.repeat(35)
      p.rounds.push({ ...p.rounds[0], roundKey: 'second-layout-probe' })
      const active = { ...p.turns[0], turnId: 'active-layout-user' }
      p.turns.push(active, { turnId: 'active-layout-agent', role: 'jenny', kind: 'message',
        text: '布局探针：引用回复', quote: p.turns[1].quote })
      p.rounds.push({ roundKey: 'active-probe', lane: 'active', messageRefs: ['active-layout-user', 'active-layout-agent'] })
      renderMainTopic(window.layoutHost, p)
      const bounds = s => {
        const n = document.querySelector(s), r = n.getBoundingClientRect()
        return { x: r.x, right: r.right, width: r.width, scroll: n.scrollWidth, client: n.clientWidth }
      }
      return { user: bounds('.mt-history-user'), summary: bounds('.mt-history-summary-button'),
        ancestors: [window.layoutHost, window.layoutHost.parentElement, window.layoutHost.parentElement.parentElement].map(n => ({ tag: n.tagName, cls: n.className, id: n.id, data: { ...n.dataset }, width: n.clientWidth })),
        activeUser: bounds('.mt-turn--user'), activeAgent: bounds('.mt-turn--jenny'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        order: [...document.querySelectorAll('.mt-history-summary-button')].map(n => n.dataset.roundKey),
        quotes: [...document.querySelectorAll('.mt-stream .mt-quote-text')].map(n => n.textContent),
        divider: document.querySelectorAll('.mt-conversation-divider').length }
    })
    receipt.checks.push({ width, geometry })
    assert.equal(geometry.overflow, false)
    assert.ok(geometry.user.right > geometry.summary.right)
    assert.ok(geometry.activeUser.right > geometry.activeAgent.right)
    for (const key of ['user', 'summary', 'activeUser', 'activeAgent']) assert.ok(geometry[key].scroll <= geometry[key].client + 1, `${key} wraps at ${width}`)
    assert.deepEqual(geometry.order, ['recorded-history', 'second-layout-probe'])
    assert.deepEqual(geometry.quotes, ['布局探针：引用问题', '布局探针：引用问题', '布局探针：引用问题', turns[1].quote])
    assert.equal(geometry.divider, 1)
    await page.screenshot({ path: join(evidence, `layout-probes-${width}.png`), fullPage: true })
  }
  longLayout = true
  receipt.scrolling = []
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.reload()
    await page.locator('[data-round-key="scroll-layout-17"]').first().waitFor()
    // The product initially follows the latest record. Start user gestures at
    // the top without assigning scrollTop or scrolling an element in script.
    await page.mouse.move(width === 390 ? 180 : 900, 300)
    await page.mouse.wheel(0, -100000)
    await page.waitForTimeout(250)
    const primary = page.locator('.page-primary')
    const measure = () => page.evaluate(() => {
      const facts = node => {
        const s = getComputedStyle(node), r = node.getBoundingClientRect()
        return { tag: node.tagName, cls: node.className, display: s.display,
          gridRow: s.gridRow, rows: s.gridTemplateRows, alignItems: s.alignItems,
          height: r.height, top: r.top, bottom: r.bottom, overflowY: s.overflowY,
          scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
      }
      const last = document.querySelector('[data-round-key="scroll-layout-17"]')
      const ancestors = []
      for (let node = last; node; node = node.parentElement) ancestors.push(facts(node))
      return { ancestors, nearestScrollable: ancestors.find(n => /auto|scroll/.test(n.overflowY) && n.scrollHeight > n.clientHeight),
        primary: facts(document.querySelector('.page-primary')), composer: facts(document.querySelector('.page-composer')),
        page: facts(document.querySelector('.page[data-page-layout]')) }
    })
    const sample = { width, before: await measure() }
    receipt.scrolling.push(sample)
    await page.screenshot({ path: join(evidence, `scroll-top-${width}.png`) })
    await page.mouse.move(width === 390 ? 180 : 900, 300)
    await page.mouse.wheel(0, 100000)
    await page.waitForTimeout(250)
    sample.afterWheel = await measure()
    await page.screenshot({ path: join(evidence, `scroll-tail-${width}.png`) })
    assert.ok(sample.afterWheel.primary.scrollTop > sample.before.primary.scrollTop, 'wheel moves actual primary scroll owner')
    assert.equal(sample.afterWheel.nearestScrollable.cls, 'page-primary')
    assert.ok(sample.afterWheel.primary.bottom <= sample.afterWheel.composer.top + 1, 'primary ends above fixed composer')
    const usage = page.locator('.page-primary .call-usage-summary')
    const usageBox = await usage.boundingBox()
    assert.ok(usageBox.y + usageBox.height <= sample.afterWheel.composer.top + 1, 'usage is fully above input')
    const lastBox = await page.locator('[data-round-key="scroll-layout-17"]').first().boundingBox()
    assert.ok(lastBox.y >= sample.afterWheel.primary.top && lastBox.y + lastBox.height <= sample.afterWheel.composer.top, 'last record visible')
    await usage.click()
    const usageDialog = page.locator('.call-usage-details dialog[open]')
    await usageDialog.waitFor()
    await page.mouse.move(8, 300)
    await page.mouse.wheel(0, -700)
    await page.waitForTimeout(150)
    sample.dialogBackground = await measure()
    assert.equal(sample.dialogBackground.primary.scrollTop, sample.afterWheel.primary.scrollTop, 'modal blocks background wheel')
    await page.screenshot({ path: join(evidence, `usage-open-${width}.png`) })
    await page.keyboard.press('Escape')
    assert.equal(await usage.evaluate(n => n === document.activeElement), true)
    if (width === 390) {
      await page.locator('.entry-menu-toggle').click()
      await page.mouse.move(360, 400)
      await page.mouse.wheel(0, -700)
      await page.waitForTimeout(150)
      sample.navBackground = await measure()
      assert.equal(sample.navBackground.primary.scrollTop, sample.afterWheel.primary.scrollTop, 'nav blocks background wheel')
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.entry-rail-dialog').evaluate(n => n.open), false)
      await page.mouse.move(180, 300)
      await page.mouse.wheel(0, -100000)
      await page.waitForTimeout(250)
      sample.touchBefore = await measure()
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      sample.touchSteps = []
      for (let i = 0; i < 40; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 640 }] })
        for (const y of [560, 460, 360, 260, 160]) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y }] })
          await page.waitForTimeout(16)
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForTimeout(100)
        const step = await measure()
        sample.touchSteps.push(step.primary.scrollTop)
        if (step.primary.scrollHeight - step.primary.clientHeight - step.primary.scrollTop < 2) break
      }
      await page.waitForTimeout(300)
      sample.afterTouch = await measure()
      assert.ok(sample.afterTouch.primary.scrollTop > sample.touchBefore.primary.scrollTop, 'touch moves primary')
      assert.ok(sample.afterTouch.primary.scrollHeight - sample.afterTouch.primary.clientHeight - sample.afterTouch.primary.scrollTop < 2, 'touch reaches tail')
      assert.equal(sample.afterTouch.composer.top, sample.before.composer.top, 'composer stays fixed')
      await page.screenshot({ path: join(evidence, 'touch-tail-390.png') })
      await cdp.detach()
      // Reverse only the repaired height rule. This must reproduce the old
      // unscrollable primary, then removal must restore the bounded row.
      const oldHeight = await page.addStyleTag({ content: '#page-root .page-primary { align-self: start; }' })
      sample.oldHeightBefore = await measure()
      await page.mouse.move(180, 300)
      await page.mouse.wheel(0, 100000)
      await page.waitForTimeout(250)
      sample.oldHeightAfter = await measure()
      assert.equal(sample.oldHeightAfter.primary.scrollTop, 0, 'old height counterexample cannot wheel')
      assert.equal(sample.oldHeightAfter.primary.clientHeight, sample.oldHeightAfter.primary.scrollHeight, 'old primary expands to content')
      assert.ok(sample.oldHeightAfter.primary.bottom > sample.oldHeightAfter.composer.top, 'old height overlaps composer')
      await page.screenshot({ path: join(evidence, 'old-height-counterexample-390.png') })
      await oldHeight.evaluate(node => node.remove())
      sample.restored = await measure()
      assert.equal(sample.restored.primary.height, sample.before.primary.height)
    }
  }
  assert.deepEqual(receipt.errors, [])
  assert.deepEqual(receipt.mutations, [])
  receipt.result = 'PASS'
} catch (error) {
  receipt.result = 'FAIL'
  receipt.failure = error.stack
  throw error
} finally {
  if (browser) await browser.close()
  await new Promise(done => server.close(done))
  receipt.cleanup = { browserClosed: true, serverClosed: !server.listening }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
