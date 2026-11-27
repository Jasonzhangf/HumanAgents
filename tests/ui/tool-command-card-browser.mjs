import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

// Failure basis: a drawer full of successful command cards named only
// "执行命令", while old results without a record body looked like silent success.
// This controlled Chromium run renders the production tool card with the real
// drawer stylesheet. It performs no shell execution and writes no runtime data.
const uiRoot = resolve(import.meta.dirname, '../../docs/ui')
const evidence = process.env.TOOL_COMMAND_CARD_EVIDENCE ?? '/tmp/tool-command-card-evidence-20261124'
await mkdir(evidence, { recursive: true })

const base = { taskId: { scope: 'task', value: 'command-card-task' }, operationId: 'command-op', executionEpoch: 1, turnId: 'turn', requestId: 'request' }
const call = (id, seq, args) => ({ ...base, eventId: 'call-' + id, kind: 'provider.tool', seq, callId: id, toolId: 'bash', arguments: args })
const result = (id, seq, extra = {}) => ({ ...base, eventId: 'result-' + id, kind: 'provider.tool-result', seq, callId: id, toolId: 'bash', status: 'succeeded', outputRefs: [], ...extra })
const oldCommand = 'pwd; ls -a "$(pwd)" | head -50; echo \'---\'; ls -a /Users/fanzhang/.humanagent 2>/dev/null | head -30'
const fullCommand = 'pwd; ls -la /tmp | head -5; echo done'
const events = [
  call('old', 1, { command: oldCommand, description: '确认工作区根目录与 .humanagent 目录', workdir: '/workspace/project' }),
  result('old', 2, { outputRef: undefined, outputDigest: undefined, outputRefs: [] }),
  call('full', 3, { command: fullCommand, description: '读取临时目录前几项', workdir: '/workspace/project' }),
  result('full', 4, { outputRef: 'report-full', outputDigest: 'recorded' }),
  call('failed', 5, { command: 'cat missing.conf', description: '读取缺失的配置文件', workdir: '/workspace/project' }),
  result('failed', 6, { status: 'failed', outputRef: undefined, outputDigest: undefined, error: { code: 'bash.exit', message: '命令退出码 2：配置文件缺失' } }),
  call('failed-empty-reason', 7, { command: 'true', description: '无错误详情的失败样本' }),
  result('failed-empty-reason', 8, { status: 'failed', outputRef: undefined, outputDigest: undefined }),
  call('empty', 9, { command: 'true', description: '空输出样本' }),
  result('empty', 10, { outputRef: 'report-empty', outputDigest: 'recorded' }),
]
const reports = {
  4: {
    exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: 'tmp-a\ntmp-b\n', truncated: false },
    stderr: { text: '警告：只读取了前几项\n', truncated: false },
  },
  10: {
    exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
  },
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/runtime.css"><link rel="stylesheet" href="/main-topic.css"><link rel="stylesheet" href="/dispatch-tracking.css"></head><body><main id="host" class="dispatch-detail"></main></body></html>')
    return
  }
  const path = resolve(uiRoot, '.' + url.pathname)
  if (!path.startsWith(uiRoot + '/')) { res.writeHead(404).end(); return }
  try {
    res.setHeader('content-type', extname(path) === '.js' ? 'text/javascript' : 'text/css')
    res.end(await readFile(path))
  } catch { res.writeHead(404).end() }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const origin = 'http://127.0.0.1:' + server.address().port
const receipt = { kind: 'controlled-public-consumer', origin, checks: [], reads: [], cleanup: {} }
let browser
try {
  browser = await playwright.chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => { throw error })
  await page.goto(origin)
  await page.evaluate(async data => {
    const { renderToolBody } = await import('/tool-presentation.js')
    const host = document.querySelector('#host')
    window.renderTools = () => renderToolBody(host, data.events, async target => {
      window.reads = window.reads || []
      window.reads.push(target.seq)
      if (!Object.hasOwn(data.reports, target.seq)) throw Object.assign(new Error('fixture report missing'), { code: 'fixture.report.missing' })
      return data.reports[target.seq]
    })
    window.renderTools()
  }, { events, reports })
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('.tool-card')]
    return cards.length === 5 && cards.some(card => card.textContent.includes('命令序列整体退出码：0'))
      && cards.some(card => card.textContent.includes('输出为空'))
  })

  const oldCard = page.locator('.tool-card').filter({ hasText: '确认工作区根目录与 .humanagent 目录' })
  const oldText = await oldCard.innerText()
  assert.match(oldText, /显示当前工作目录/)
  assert.match(oldText, /工作摘要：确认工作区根目录与 \.humanagent 目录/)
  assert.match(oldText, /工作目录：\/workspace\/project/)
  assert.match(oldText, /结果正文未提供；历史记录未保存完整结果正文/)
  assert.equal(await oldCard.locator('.tool-read-feedback').isVisible(), true, 'drawer keeps the missing-history notice visible')
  const oldSemantic = await oldCard.locator('.tool-semantic').innerText()
  assert.doesNotMatch(oldSemantic, /2>\/dev\/null|\$\(pwd\)/, 'raw long command is not pushed onto the main face')
  assert.equal(await oldCard.locator('.tool-command').count(), 0, 'raw command is built only when its detail opens')
  await oldCard.locator('.tool-facts > .detail-disclosure-trigger').click()
  assert.equal(await oldCard.locator('.tool-command').innerText(), oldCommand)
  await page.keyboard.press('Escape')
  await oldCard.locator('.tool-facts dialog').waitFor({ state: 'hidden' })
  receipt.checks.push('old history keeps truthful intent and missing-body notice', 'raw command stays in the call evidence drawer')

  const fullCard = page.locator('.tool-card').filter({ hasText: '读取临时目录前几项' })
  const fullText = await fullCard.innerText()
  assert.match(fullText, /命令序列整体退出码：0/)
  assert.match(fullText, /工作摘要：读取临时目录前几项/)
  assert.match(fullText, /工作目录：\/workspace\/project/)
  assert.match(fullText, /tmp-a/)
  assert.match(fullText, /标准错误：警告：只读取了前几项/)
  await fullCard.locator('.tool-read-output').click()
  await fullCard.locator('.tool-output').waitFor({ state: 'visible' })
  assert.match(await fullCard.locator('.tool-output').innerText(), /标准输出（stdout）[\s\S]*tmp-a[\s\S]*标准错误（stderr）[\s\S]*警告/)
  receipt.checks.push('complete bash shows exit code, work summary, cwd and both stream excerpts', 'full report remains readable in details')

  const failed = page.locator('.tool-card').filter({ hasText: '命令退出码 2：配置文件缺失' })
  assert.match(await failed.locator('.tool-error').innerText(), /bash\.exit · 命令退出码 2：配置文件缺失/)
  const failedUnknown = page.locator('.tool-card').filter({ hasText: '历史记录中没有错误原因' })
  assert.equal(await failedUnknown.locator('.tool-read-feedback').isVisible(), true)
  const empty = page.locator('.tool-card').filter({ hasText: '空输出样本' })
  assert.match(await empty.innerText(), /输出为空/)
  receipt.checks.push('failure uses its real reason and missing reason is explicit', 'empty output is explicit')

  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: 1080 })
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout))
    await page.screenshot({ path: join(evidence, 'tool-command-card-' + width + '.png'), fullPage: true })
  }
  receipt.reads = await page.evaluate(() => window.reads || [])
  receipt.checks.push('desktop and mobile have no horizontal overflow')
  receipt.pass = true
} catch (error) {
  receipt.failure = error.stack
  throw error
} finally {
  if (browser) await browser.close()
  await new Promise(done => server.close(done))
  receipt.cleanup = { browserClosed: !browser?.isConnected(), serverClosed: !server.listening }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))
