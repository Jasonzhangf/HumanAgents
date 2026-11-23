import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'

const evidence = process.env.MAIN_TOPIC_DETAIL_EVIDENCE
if (!evidence) throw new Error('MAIN_TOPIC_DETAIL_EVIDENCE is required')
const root = resolve(process.env.MAIN_TOPIC_DETAIL_UI_ROOT ?? 'docs/ui')
const at = '2026-11-22T10:00:00.000Z'
const steps = [
  { seq: 1, kind: 'request.dispatched', occurredAt: at, requestId: 'request-simple', turnId: 'simple' },
  { seq: 2, kind: 'response.streaming', occurredAt: '2026-11-22T10:00:02.000Z', requestId: 'request-simple', turnId: 'simple' },
  { seq: 3, kind: 'request.settled', occurredAt: '2026-11-22T10:00:03.000Z', requestId: 'request-simple', turnId: 'simple' },
]
const task = (value) => ({ scope: 'task', value })
const projection = {
  surface: 'main-topic', projectKey: 'detail-project', projectName: '详情归属', workspaceCwd: '/fixture', mode: 'fake', agentName: 'Jenny', topicName: '主话题', tasks: [], activeTask: { taskId: task('other'), state: 'running' },
  turns: [
    { turnId: 'simple', role: 'jenny', kind: 'message', text: '简单回答', interactionId: 'simple-interaction', statusFacts: { state: 'answered', steps } },
    ...['history', 'other'].map((value) => ({ turnId: value, role: 'jenny', kind: 'status', text: value, taskId: task(value), statusFacts: { state: value === 'history' ? 'succeeded' : 'failed', events: [], ...(value === 'other' ? { error: { code: 'controlled-error', message: '受控失败' } } : {}) } })),
  ],
}
const receipt = { checks: [], errors: [], cleanup: {} }
let submissionReads = 0
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path.startsWith('/api/')) {
    if (req.method === 'POST') submissionReads++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(path === '/api/main-topic' ? projection : path === '/api/tasks' ? { waiting: [], running: [], completed: [], stopped: [], failed: [] } : { mode: 'fake', state: 'ready', connected: true }))
    return
  }
  // This checkout ships index.html with entry.js. Exercise the same HTML under
  // an entry.html fixture alias too; the production server has no such alias.
  const file = resolve(root, path === '/entry.html' ? 'index.html' : `.${path}`)
  if (!file.startsWith(`${root}/`)) { res.writeHead(403).end(); return }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'text/plain')
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
})
await mkdir(evidence, { recursive: true })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
receipt.port = server.address().port
const { default: playwright } = await import('/opt/homebrew/lib/node_modules/playwright/index.js')
let browser
try {
  browser = await playwright.chromium.launch({ headless: true })
  for (const entry of ['index.html', 'entry.html']) {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    await page.addInitScript(() => {
      window.intervalCallbacks = []
      const schedule = window.setInterval
      window.setInterval = (callback, ...args) => {
        window.intervalCallbacks.push(String(callback))
        return schedule(callback, ...args)
      }
    })
    page.on('pageerror', (error) => receipt.errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/${entry}?project=detail-project&mode=fake`)
    for (const reload of [false, true]) {
      if (reload) await page.reload()
      for (const id of ['simple', 'history', 'other']) {
        const trigger = page.locator(`[data-turn-id="${id}"] .conversation-status-detail`)
        await trigger.click()
        const dialog = page.locator('dialog[data-technical-detail][open]')
        const text = await dialog.innerText()
        await writeFile(join(evidence, `${entry}-${reload}-${id}.txt`), text)
        const expected = { simple: '本次请求总耗时', history: '任务已完成', other: '受控失败' }[id]
        assert.ok(text.includes(expected), `${entry} ${id}: expected ${expected}, got ${text}`)
        assert.ok(!text.includes('任务尚未进入执行进度'))
        const href = await dialog.locator('a').count() ? await dialog.locator('a').getAttribute('href') : null
        if (id === 'simple') assert.equal(href, null)
        else { assert.ok(href.includes(id)); assert.ok(href.includes('detail-project')) }
        if (id === 'simple' && !reload) {
          const polled = page.waitForResponse((response) => response.url().includes('/api/main-topic'))
          await polled
          assert.equal(await dialog.innerText(), text, 'poll cannot replace the selected message facts')
        }
        await page.keyboard.press('Escape')
        assert.equal(await trigger.evaluate((node) => node === document.activeElement), true)
        receipt.checks.push({ entry, reload, id, text, href, focusReturned: true })
      }
    }
    const beforeSubmit = submissionReads
    await page.locator('#entry-form textarea').fill('受控详情测试')
    await page.locator('#entry-form button[type="submit"]').click()
    await page.waitForFunction(() => !document.querySelector('#entry-form button[type="submit"]').disabled)
    assert.ok(submissionReads > beforeSubmit, 'exercise the actual submission/banner mount')
    const callbacks = await page.evaluate(() => window.intervalCallbacks)
    assert.equal(callbacks.some((callback) => callback.includes('totalTimer.textContent')), false, 'main chat must not start the hidden banner clock')
    receipt.checks.push({ entry, hiddenBannerClock: false, submissionExercised: true })
    await page.route('**/api/main-topic*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'controlled-read-failure', message: '受控读取失败' } }) }))
    await page.reload()
    await page.locator('.mt-unavailable').waitFor()
    assert.match(await page.locator('.mt-unavailable').innerText(), /主话题记录暂时无法读取/)
    await page.locator('.mt-unavailable button').click()
    assert.match(await page.locator('dialog[data-technical-detail][open]').innerText(), /受控读取失败/)
    receipt.checks.push({ entry, readFailureVisible: true })
    await page.close()
  }
  assert.deepEqual(receipt.errors, [])
} finally {
  await browser?.close()
  await new Promise((done) => server.close(done))
  receipt.cleanup = { browserClosed: !browser?.isConnected(), serverClosed: !server.listening }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
