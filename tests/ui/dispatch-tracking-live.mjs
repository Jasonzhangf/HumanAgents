import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const repo = resolve(import.meta.dirname, '../..')
const evidence = join(repo, 'docs/verification/dispatch-tracking-20261123/real-runtime-verified-20261123')
await mkdir(evidence, { recursive: true })
const fixtures = join(homedir(), '.humanagent/test-fixtures')
await mkdir(fixtures, { recursive: true })
const root = await mkdtemp(join(fixtures, 'dispatch-tracking-20261123-'))
const workspace = join(root, 'workspace'), control = join(root, 'control')
await mkdir(workspace); await writeFile(join(workspace, 'marker.txt'), 'DISPATCH_TRACKING_MARKER\n')
const cli = join(repo, 'dist/app/app/src/cli.js')
const child = spawn(process.execPath, [cli, 'serve', '--mode', 'rcc', '--protocol', process.env.DISPATCH_RCC_PROTOCOL || 'responses', '--binding', 'dispatch-tracking-isolated', '--provider', 'rcc', '--model', process.env.DISPATCH_RCC_MODEL || 'MiniMax-M3', '--route', 'rcc-entry/default', '--rcc-base-url', 'http://127.0.0.1:4444', '--workspace', workspace, '--control-root', control, '--port', '0'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
let output = '', stderr = '', browser, proxy
const checks = [], writes = []
child.stderr.on('data', chunk => { stderr += chunk })
const ready = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`runtime start timeout: ${stderr}`)), 30000)
  child.stdout.on('data', chunk => {
    output += chunk
    const match = output.match(/\{[\s\S]*?\n\}/)
    if (match) { try { const info = JSON.parse(match[0]); clearTimeout(timeout); resolve(info) } catch {} }
  })
  child.once('exit', code => { clearTimeout(timeout); reject(new Error(`runtime exit ${code}: ${stderr}`)) })
})
let runtimeUrl, proxyUrl
try {
  runtimeUrl = (await ready).url
  proxy = createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        if (req.method !== 'GET') writes.push(req.url)
        let body = ''; for await (const chunk of req) body += chunk
        const upstream = await fetch(new URL(req.url, runtimeUrl), { method: req.method, headers: { 'content-type': 'application/json' }, ...(body ? { body } : {}) })
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
        // No persistent SSE forwarding is needed for polling acceptance.
        if (upstream.headers.get('content-type')?.includes('text/event-stream')) { await upstream.body.cancel(); res.end(); return }
        res.end(await upstream.text()); return
      }
      const pathname = new URL(req.url, 'http://localhost').pathname
      const path = resolve(repo, 'docs/ui', '.' + (pathname === '/' ? '/index.html' : pathname))
      assert.ok(path.startsWith(join(repo, 'docs/ui') + '/'))
      res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'text/plain' }); res.end(await readFile(path))
    } catch (error) { res.writeHead(500); res.end(error.message) }
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  browser = await playwright.chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(180000)
  await page.goto(proxyUrl)
  const input = page.locator('textarea[name=rawInput]')
  await input.fill('创建一个简单任务：用 file.read 读取当前工作区 marker.txt，报告其原文。只读，不执行命令，不修改任何文件。无需提问。')
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.locator('.dispatch-card').waitFor()
  await page.waitForFunction(() => !document.querySelector('#entry-form button[type=submit]').disabled, undefined, { timeout: 30000 })
  const parent = await page.locator('.dispatch-card').getAttribute('data-dispatch-task-id')
  checks.push('real runtime confirmed task and released composer')
  await input.fill('1加1等于几？直接回答，不创建任务，不调用工具。')
  const prior = await (await fetch(new URL('/api/main-topic', runtimeUrl))).json()
  const priorInteractions = new Set((prior.turns || []).map(turn => turn.interactionId).filter(Boolean))
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.waitForFunction(async ({ priorInteractions, projectKey, mode }) => {
    const main = await (await fetch('/api/main-topic')).json()
    if (main.projectKey !== projectKey || main.mode !== mode) return false
    const reply = main.turns?.find(turn => turn.interactionId && !priorInteractions.includes(turn.interactionId)
      && turn.role === 'jenny' && turn.kind === 'message' && turn.text?.trim())
    if (!reply) return false
    const interaction = await (await fetch(`/api/explicit/interactions/${encodeURIComponent(reply.interactionId)}`)).json()
    return ['answered', 'status-only'].includes(interaction.state)
      && !document.querySelector('#entry-form button[type=submit]').disabled
  }, { priorInteractions: [...priorInteractions], projectKey: prior.projectKey, mode: prior.mode }, { timeout: 180000 })
  checks.push('second ordinary Jenny reply arrived independently')
  await page.getByRole('button', { name: '任务板', exact: true }).click()
  await page.locator(`.dispatch-board-entry[data-dispatch-task-id="${parent}"]`).click()
  await page.waitForFunction(() => document.querySelector('.dispatch-tool-step, .product-session-tools'), undefined, { timeout: 180000 })
  checks.push('real child tool execution is visible from task board')
  await page.screenshot({ path: join(evidence, 'real-runtime-tool-chain.png') })
  await writeFile(join(evidence, 'real-runtime-detail.txt'), await page.locator('.dispatch-detail').innerText())
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(evidence, 'real-runtime-second-jenny.png') })
  await page.waitForFunction(() => [...document.querySelectorAll('.mt-text, .mt-history-summary')].some(node => node.textContent.includes('DISPATCH_TRACKING_MARKER')), undefined, { timeout: 180000 })
  checks.push('real task returned marker result in the normal conversation')
  await page.screenshot({ path: join(evidence, 'real-runtime-result.png') })
  const main = await (await fetch(new URL('/api/main-topic', runtimeUrl))).json()
  assert.equal(main.tasks.find(task => task.taskId.value === parent)?.state, 'succeeded')
  await writeFile(join(evidence, 'real-runtime-main.json'), JSON.stringify(main, null, 2))
} catch (error) {
  if (runtimeUrl) {
    const current = await (await fetch(new URL('/api/main-topic', runtimeUrl))).json()
    await writeFile(join(evidence, 'real-runtime-failed-main.json'), JSON.stringify(current, null, 2))
  }
  await writeFile(join(evidence, 'real-runtime-failure.txt'), error.stack || String(error))
  throw error
} finally {
  if (browser) await browser.close()
  if (proxy) await new Promise(resolve => proxy.close(resolve))
  if (child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended
  }
  await writeFile(join(evidence, 'real-runtime-receipt.json'), JSON.stringify({ checks, runtimeUrl, proxyUrl, pid: child.pid, exited: child.exitCode !== null || child.signalCode !== null, writes, stderr, runtimeRootRemoved: true }, null, 2))
  await rm(root, { recursive: true, force: true })
}
console.log(JSON.stringify({ result: 'PASS', checks }))
