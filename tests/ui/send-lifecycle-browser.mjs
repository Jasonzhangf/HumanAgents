import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const root = resolve(import.meta.dirname, '../../docs/ui')
const evidence = resolve(import.meta.dirname, '../../docs/verification/send-lifecycle-20261123')
await mkdir(evidence, { recursive: true })
const browser = await playwright.chromium.launch({ headless: true })
const checks = [], writes = [], errors = []
const project = { projectKey: 'send-proof', projectName: '发送验收', agentName: 'Jenny', mode: 'fake', workspaceCwd: '/isolated/send-proof' }
let historyTurns = []
let accepted = false, finished = false, offline = false, rejectReceive = false, releaseReceive, releaseInterpret
let failInterpretOnce = false, interpretFailed = false
const receiveWait = new Promise(r => { releaseReceive = r })
const interpretWait = new Promise(r => { releaseInterpret = r })
const projection = () => ({ ...project, tasks: [], turns: accepted ? [...historyTurns,
  { turnId: 'user:interaction-proof', interactionId: 'interaction-proof', role: 'user', kind: 'message', text: '延迟发送验收' },
  ...(finished ? [{ turnId: 'reply:interaction-proof', interactionId: 'interaction-proof', role: 'jenny', kind: 'message', text: '已完成隔离回答' }] : []),
] : [] })
const snapshot = () => ({ interactionId: 'interaction-proof', state: finished ? 'answered' : interpretFailed ? 'received' : 'matching', reply: finished ? '已完成隔离回答' : undefined,
  steps: [{ seq: 1, kind: 'request.dispatched', requestId: 'request-proof', turnId: 'turn-proof', occurredAt: new Date().toISOString(), summary: '请求已发出' }] })
const check = (name, value) => { assert.ok(value, name); checks.push(name) }
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.pathname.startsWith('/api/')) {
      let data, status = 200
      if (req.method() !== 'GET') writes.push(url.pathname)
      if (url.pathname === '/api/runtime/status') data = { mode: 'fake', state: 'ready' }
      else if (url.pathname === '/api/main-topic') {
        if (offline) { status = 503; data = { error: { code: 'fixture.read-offline', message: '读取中断' } } }
        else data = projection()
      } else if (url.pathname === '/api/dashboard') data = { projects: [{ scope: { projectKey: project.projectKey }, label: project.projectName }] }
      else if (url.pathname === '/api/tasks') data = { draft: [], waiting: [], running: [], completed: [], stopped: [], failed: [] }
      else if (url.pathname === '/api/explicit/inputs') {
        if (rejectReceive) { status = 503; data = { error: { code: 'fixture.receive-failed', message: '未确认接收' } } }
        else { await receiveWait; accepted = true; data = { interactionId: 'interaction-proof' } }
      }
      else if (url.pathname.endsWith('/interpret')) {
        await interpretWait
        if (failInterpretOnce) { failInterpretOnce = false; interpretFailed = true; status = 503; data = { error: { code: 'fixture.interpret-failed', message: '本轮处理失败，已回到可恢复状态' } } }
        else { interpretFailed = false; finished = true; data = snapshot() }
      }
      else if (url.pathname === '/api/explicit/interactions/interaction-proof') data = snapshot()
      else { status = 404; data = { error: { code: 'fixture.unavailable', message: '未提供该能力' } } }
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    assert.ok(path.startsWith(root + '/'))
    await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)], body: await readFile(path) })
  })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('http://send-proof.test/')
  const input = page.locator('textarea[name=rawInput]')
  await input.fill('延迟发送验收')
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.locator('.mt-send-status [data-phase="sending"]').waitFor({ timeout: 1800 })
  check('pre-ACK status visible', await page.locator('.mt-send-status').isVisible())
  check('draft retained before ACK', await input.inputValue() === '延迟发送验收')
  check('reduced motion keeps status but disables animation', await page.locator('.mt-send-status .conversation-status-mark').evaluate(n => getComputedStyle(n).animationName) === 'none')
  await page.waitForFunction(() => /[1-9]\d* 秒/.test(document.querySelector('.mt-send-status')?.textContent))
  await input.fill('用户后来输入')
  releaseReceive()
  await page.locator('.mt-send-status [data-phase="model-wait"]').waitFor()
  check('new typing retained after ACK', await input.inputValue() === '用户后来输入')
  check('optimistic user deduplicated', await page.locator('.mt-turn--user').count() === 1)
  check('current state remains in visible conversation', await page.locator('.mt-send-status').evaluate(n => { const r=n.getBoundingClientRect(); const p=n.closest('.page-primary').getBoundingClientRect(); return r.top >= p.top && r.bottom <= p.bottom }))
  await page.screenshot({ path: resolve(evidence, 'ack-wait.png') })
  historyTurns = Array.from({ length: 40 }, (_, i) => ({ turnId: `old-${i}`, role: i % 2 ? 'jenny' : 'user', kind: 'message', text: `较早消息 ${i}，仅用于验证翻阅历史时保持位置。` }))
  await page.waitForFunction(() => document.querySelectorAll('.mt-turn').length > 40)
  check('new progress follows when already at bottom', await page.locator('.mt-send-status').evaluate(n => { const r=n.getBoundingClientRect(), p=n.closest('.page-primary').getBoundingClientRect(); return r.bottom <= p.bottom && r.top >= p.top }))
  await page.locator('.page-primary').evaluate(n => { n.scrollTop = 0 })
  await page.waitForResponse(r => r.url().endsWith('/api/main-topic'))
  check('poll does not pull reader away from history', await page.locator('.page-primary').evaluate(n => n.scrollTop < 5))
  await page.locator('.page-primary').evaluate(n => { n.scrollTop = n.scrollHeight })
  historyTurns = []
  offline = true
  await page.getByText('fixture.read-offline', { exact: false }).first().waitFor({ timeout: 10000 })
  check('read error leaves conversation visible', await page.getByText('延迟发送验收', { exact: true }).isVisible())
  offline = false
  await page.getByRole('button', { name: '重新读取本轮状态' }).click()
  await page.locator('.mt-send-status [data-phase="model-wait"]').waitFor()
  check('recovery does not POST again', writes.filter(p => p.endsWith('/inputs')).length === 1 && writes.filter(p => p.endsWith('/interpret')).length === 1)
  const reader = await context.newPage()
  await reader.goto('http://send-proof.test/')
  await reader.locator('.mt-send-status [data-phase="model-wait"]').waitFor()
  await reader.reload()
  await reader.locator('.mt-send-status [data-phase="model-wait"]').waitFor()
  check('reload during waiting reads same receipt without POST', writes.length === 2)
  await reader.close()
  releaseInterpret()
  await page.getByText('已完成隔离回答', { exact: true }).first().waitFor()
  await page.waitForFunction(() => !document.querySelector('.mt-send-status [data-running="true"]'))
  check('completion preserves later input too', await input.inputValue() === '用户后来输入')
  await page.reload()
  await page.getByText('已完成隔离回答', { exact: true }).first().waitFor()
  check('reload never repeats writes or stale spinner', writes.length === 2 && await page.locator('.mt-send-status [data-running=true]').count() === 0)
  accepted = false; finished = false; rejectReceive = true
  await input.fill('未接收的输入')
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.locator('.mt-send-status').getByText('fixture.receive-failed', { exact: false }).waitFor()
  check('unconfirmed failure retains editable input', await input.inputValue() === '未接收的输入' && !await input.evaluate(n => n.readOnly))
  check('failure stops spinner', await page.locator('.mt-send-status [data-running=true]').count() === 0)
  const beforeRecovery = writes.length
  await page.getByRole('button', { name: '重新读取本轮状态' }).click()
  check('uncertain receive recovery never repeats POST', writes.length === beforeRecovery)
  rejectReceive = false; failInterpretOnce = true
  await page.reload()
  await input.fill('同轮恢复验收')
  const beforeRetry = writes.length
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.getByRole('button', { name: '继续本轮处理' }).waitFor()
  check('failed interpret retains code and stops animation', await page.locator('.mt-send-status').textContent().then(t => t.includes('fixture.interpret-failed')) && await page.locator('.mt-send-status [data-running=true]').count() === 0)
  await page.getByRole('button', { name: '继续本轮处理' }).click()
  await page.getByText('已完成隔离回答', { exact: true }).first().waitFor()
  check('explicit recovery reuses interaction without receiving again', writes.slice(beforeRetry).filter(p => p.endsWith('/inputs')).length === 1 && writes.slice(beforeRetry).filter(p => p.endsWith('/interpret')).length === 2)
  check('no page errors', errors.length === 0)
} finally {
  releaseReceive(); releaseInterpret()
  await browser.close()
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ checks, writes, errors, browserClosed: !browser.isConnected() }, null, 2))
}
console.log(JSON.stringify({ result: 'PASS', checks }))
