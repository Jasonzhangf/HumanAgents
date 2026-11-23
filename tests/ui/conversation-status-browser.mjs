import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'

const evidence = process.env.CONVERSATION_STATUS_EVIDENCE
if (!evidence) throw new Error('CONVERSATION_STATUS_EVIDENCE is required')
const root = resolve('dist/app/ui')
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/') { res.end('<html><head><link rel="stylesheet" href="/main-topic.css"></head><body><div id="host"></div></body></html>'); return }
  const file = resolve(root, `.${path}`)
  if (!file.startsWith(`${root}/`)) { res.writeHead(403).end(); return }
  try {
    const body = await readFile(file)
    res.setHeader('content-type', extname(file) === '.js' ? 'text/javascript' : 'text/css')
    res.end(body)
  } catch { res.writeHead(404).end() }
})
await mkdir(evidence, { recursive: true })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const playwright = await import('/opt/homebrew/lib/node_modules/playwright/index.js')
const { chromium } = playwright.default ?? playwright
let browser
const receipt = { port, checks: [], errors: [], cleanup: {} }
try {
  browser = await chromium.launch({ headless: true })
  for (const width of [1920, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    page.on('pageerror', (error) => receipt.errors.push(error.message))
    await page.goto(`http://127.0.0.1:${port}`)
    const checks = await page.evaluate(async () => {
      const { renderMainTopic, disposeMainTopic } = await import('/main-topic.js')
      const host = document.querySelector('#host')
      const start = new Date(Date.now() - 5000).toISOString()
      const taskId = { scope: 'task', value: 'task' }
      const base = { projectKey: 'test', workspaceCwd: '/test', mode: 'fake', projectName: '受控状态测试', agentName: 'Jenny', topicName: '主话题' }
      const event = (kind, extra = {}) => ({ kind, occurredAt: start, taskId, operationId: 'op', executionEpoch: 1, ...extra })
      const facts = { state: 'running', events: [event('execution.started'), event('provider.model', { state: 'dispatched', requestId: 'r', turnId: 't' })] }
      const turn = { turnId: 'status', role: 'jenny', kind: 'status', text: '保留原消息', statusFacts: facts, taskId }
      const question = { turnId: 'question', role: 'jenny', kind: 'input-request', text: '按什么口径？', taskId, requestId: 'q', expectedRevision: 1 }
      let details = 0
      const paint = () => renderMainTopic(host, { ...base, turns: [turn, question] }, { onOpenDetail: () => details++ })
      paint()
      const input = host.querySelector('input')
      input.value = '含税草稿'; input.focus()
      const initial = host.querySelector('[data-phase="model-wait"] .conversation-status-time').textContent
      await new Promise((done) => setTimeout(done, 1150))
      const later = host.querySelector('[data-phase="model-wait"] .conversation-status-time').textContent
      paint()
      const results = {
        realClock: Number.parseInt(later) > Number.parseInt(initial),
        pollKeepsStart: host.querySelector('[data-phase="model-wait"] .conversation-status-time').textContent === later,
        draftAndFocus: host.querySelector('input') === input && input.value === '含税草稿' && document.activeElement === input,
      }
      host.querySelector('.conversation-status-detail').click()
      results.detail = details === 1
      const end = new Date(Date.parse(start) + 3000).toISOString()
      facts.state = 'succeeded'
      facts.events.push(event('execution.terminal', { occurredAt: end, terminalPhase: 'final' }))
      paint()
      const frozen = host.querySelector('[data-phase="total"] .conversation-status-time').textContent
      await new Promise((done) => setTimeout(done, 1100))
      results.terminalFrozen = frozen === '3 秒' && host.querySelector('[data-phase="total"] .conversation-status-time').textContent === frozen
      results.missingEndOmitted = host.querySelector('[data-phase="model-wait"] .conversation-status-time').hidden
      results.visible = [...host.querySelectorAll('.conversation-status')].every((node) => node.getBoundingClientRect().width > 0)
      results.noHorizontalOverflow = document.documentElement.scrollWidth <= innerWidth
      disposeMainTopic(host)
      return results
    })
    receipt.checks.push({ width, ...checks })
    await page.screenshot({ path: join(evidence, `status-${width}.png`), fullPage: true })
    await writeFile(join(evidence, `status-${width}.html`), await page.content())
    await page.close()
    for (const [name, value] of Object.entries(checks)) assert.equal(value, true, `${width}: ${name}`)
  }
  assert.deepEqual(receipt.errors, [])
} finally {
  if (browser) await browser.close()
  await new Promise((done) => server.close(done))
  receipt.cleanup = { browserClosed: !browser?.isConnected(), serverListening: server.listening }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
