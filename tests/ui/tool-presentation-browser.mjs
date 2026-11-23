import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { projectMainTopic } from '../../dist/app/ui/projection/main-topic.js'

const evidence = process.env.TOOL_PRESENTATION_EVIDENCE
if (!evidence) throw new Error('TOOL_PRESENTATION_EVIDENCE is required')
const uiRoot = resolve('docs/ui')
const full = '供应商乙：单价 109.18 元，含税。\n'.repeat(1000) + '财务材料全文结束'
const taskId = { scope: 'task', value: 'finance' }
const event = (kind, callId, seq, extra = {}) => ({
  eventId: `e-${seq}`, kind, callId, seq, taskId, operationId: 'read', executionEpoch: 2,
  toolId: 'file.read', occurredAt: '2026-11-23T00:00:00Z', evidenceRefs: [], ...extra,
})
const events = [
  event('provider.tool', 'a', 1, { arguments: { path: '财务/甲.txt' } }),
  event('provider.tool', 'b', 2, { arguments: { path: '财务/乙.txt' } }),
  event('provider.tool-result', 'b', 3, { status: 'succeeded', outputRef: '乙', outputDigest: 'recorded' }),
  event('provider.tool-result', 'a', 4, { status: 'failed', error: { code: 'file.denied', message: '甲文件拒绝读取' } }),
  event('provider.tool', 'unknown', 5, { toolId: 'future.lookup', arguments: { query: '未知工具原参数' } }),
  event('provider.tool-result', 'unknown', 6, { toolId: 'future.lookup', status: 'succeeded', outputRef: '未知', outputDigest: 'recorded' }),
]
const projection = projectMainTopic({
  projectKey: 'fixture-finance', projectName: '财务', workspaceCwd: '/fixture', mode: 'fake',
  interactions: [{ interactionId: 'i', rawInput: '读取甲乙完整财务材料', state: 'submitted', taskId }],
  tasks: [{ taskId, title: '财务读取', sourceInteractionId: 'i', state: 'waiting', stateLabel: '等待回答',
    currentNode: 'provider.tool', nextStep: '回答后继续', output: '', updatedAt: '2026-11-23T00:00:00Z', events,
    inputRequest: { taskId, requestId: 'q', expectedRevision: 1, question: '按什么口径？', options: ['含税价'] } }],
})
let outputReads = 0
const server = createServer(async (req, res) => {
  if (req.url.endsWith('/tool-output')) {
    outputReads++
    res.setHeader('content-type', 'application/json')
    if (req.url.includes('/events/6/')) {
      res.statusCode = 409
      res.end(JSON.stringify({ error: { code: 'tool-output.not-available', message: '记录正文不可读' } }))
    } else res.end(JSON.stringify({ path: '财务/乙.txt', workspaceRef: 'fixture', content: full }))
    return
  }
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html')
    res.end('<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/main-topic.css"><main id="host"></main>')
    return
  }
  const path = resolve(uiRoot, '.' + req.url.split('?')[0])
  if (!path.startsWith(uiRoot + '/')) { res.writeHead(404).end(); return }
  try {
    res.setHeader('content-type', extname(path) === '.js' ? 'text/javascript' : 'text/css')
    res.end(await readFile(path))
  } catch { res.writeHead(404).end() }
})
await mkdir(evidence, { recursive: true })
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
const receipt = { kind: 'controlled-public-consumer', origin, checks: [], cleanup: {} }
try {
  const imported = await import('/opt/homebrew/lib/node_modules/playwright/index.js')
  const { chromium } = imported.default ?? imported
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.goto(origin)
  await page.evaluate(async (projection) => {
    const { renderMainTopic } = await import('/main-topic.js')
    window.projection = projection
    window.render = () => renderMainTopic(document.querySelector('#host'), window.projection)
    window.render()
  }, projection)
  assert.equal(outputReads, 0)
  assert.equal(await page.locator('.tool-card').count(), 3)
  await page.locator('[data-answer-custom]').fill('未提交草稿')
  const b = page.locator('.tool-card').filter({ hasText: '财务/乙.txt' })
  await b.locator('button').click()
  await page.waitForFunction(() => document.querySelector('.tool-output:not([hidden])')?.textContent.endsWith('财务材料全文结束'))
  assert.equal(await b.locator('.tool-output').textContent(), full)
  await page.evaluate(() => window.render())
  assert.equal(await b.locator('.tool-output').textContent(), full)
  assert.equal(await b.locator('.tool-output').isVisible(), true)
  assert.equal(await page.locator('[data-answer-custom]').inputValue(), '未提交草稿')
  assert.equal(outputReads, 1)
  const failed = page.locator('.tool-card').filter({ hasText: '甲文件拒绝读取' })
  assert.equal(await failed.locator('button').count(), 0)
  const unknown = page.locator('.tool-card').filter({ hasText: 'future.lookup' })
  await unknown.locator('button').click()
  await page.waitForFunction(() => document.body.textContent.includes('结果不可读：tool-output.not-available'))
  assert.match(await unknown.textContent(), /记录正文不可读/)
  receipt.checks.push('exact file/result pairing', 'complete long output', 'poll retains loaded output and answer draft', 'failed tool', 'unknown tool with typed read error', 'no eager output reads')
  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: 1080 })
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      order: Boolean(document.querySelector('.conversation-status').compareDocumentPosition(document.querySelector('.tool-body')) & Node.DOCUMENT_POSITION_FOLLOWING) }))
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout))
    assert.equal(layout.order, true)
    await page.screenshot({ path: join(evidence, `tools-${width}.png`), fullPage: true })
  }
  await writeFile(join(evidence, 'projection.json'), JSON.stringify(projection, null, 2))
  await writeFile(join(evidence, 'dom.html'), await page.content())
  await page.evaluate(async () => {
    const { renderMainTopic, disposeMainTopic } = await import('/main-topic.js')
    const host = document.querySelector('#host')
    renderMainTopic(host, { ...window.projection, turns: [{ turnId: 'simple', role: 'jenny', kind: 'message', text: '普通聊天完整正文' }] })
    if (host.querySelector('.tool-body')) throw new Error('simple chat has tools')
    disposeMainTopic(host)
  })
  receipt.checks.push('desktop/mobile no horizontal overflow', 'status precedes tool body', 'simple chat has no tools')
  receipt.pass = true
} finally {
  if (browser) { await browser.close(); receipt.cleanup.browserClosed = true }
  await new Promise((done) => server.close(done))
  receipt.cleanup.serverClosed = !server.listening
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
