import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const root = resolve(import.meta.dirname, '../../../docs/ui')
const evidence = import.meta.dirname
const baseline = execFileSync('git', ['show', 'HEAD:docs/ui/dispatch-tracking.js'], { cwd: root, encoding: 'utf8' })
const pageHtml = String.raw`<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/dispatch-tracking.css">
<style>body{margin:0;padding:24px;background:#f4f6f8;font:14px system-ui}.entry-task-list-drawer{margin-bottom:12px}#detail{max-width:560px;background:#fff;padding:16px}</style>
<div class="entry-task-list-drawer"><button id="trigger">打开任务</button></div>
<main id="detail"></main>
<script type="module">
const { createDispatchTracking } = await import(location.search.slice(1))
const scope = { projectKey: 'proof', mode: 'fake', taskId: 'parent-a' }
const task = { taskId: { scope: 'task', value: 'parent-a' }, title: '对照同一任务', state: 'running' }
const turn = { role: 'jenny', kind: 'draft', text: '完成可复核的任务结果' }
const api = {
  readProductRelations: async () => ({ relations: [] }),
  readProductSession: async () => ({}),
  observation: async () => ({ nodes: [{ ownerAgentRole: 'execution', stateDisplay: '执行中',
    toolSteps: [{ stepId: 'step-a', turnId: 'turn-a', name: 'bash', status: 'succeeded', occurredAt: '2026-11-24T08:00:00Z' }] }] }),
  semanticObservation: async () => ({}),
  readScopedToolOutput: async () => ({}),
}
const tracking = createDispatchTracking({ api, scope: () => scope, openDetail: ({ content }) => {
  document.getElementById('detail').append(content)
} })
tracking.sync([task], [turn])
tracking.open(document.getElementById('trigger'), task, turn)
window.__captureReady = new Promise(resolveReady => setTimeout(resolveReady, 500))
</script>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/before' || url.pathname === '/after') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(pageHtml.replace("location.search.slice(1)", `'${url.pathname === '/before' ? '/baseline.js' : '/dispatch-tracking.js'}'`))
    return
  }
  if (url.pathname === '/baseline.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(baseline)
    return
  }
  const path = resolve(root, url.pathname.slice(1))
  assert.ok(path.startsWith(root + '/'))
  const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/plain'
  res.writeHead(200, { 'content-type': `${type}; charset=utf-8` })
  res.end(await readFile(path))
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await playwright.chromium.launch({ headless: true })
try {
  for (const name of ['before', 'after']) {
    const page = await browser.newPage({ viewport: { width: 620, height: 760 }, reducedMotion: 'reduce' })
    await page.goto(`${base}/${name}`)
    await page.waitForFunction(() => Boolean(window.__captureReady))
    await page.evaluate(() => window.__captureReady)
    const text = await page.locator('#detail').innerText()
    if (name === 'before') assert.ok(text.includes('执行链') && text.includes('操作详情'))
    else assert.ok(text.includes('任务概览') && !text.includes('操作详情'))
    await page.screenshot({ path: resolve(evidence, `${name}-task-chain.png`), fullPage: true })
    await page.close()
  }
} finally {
  await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
}
console.log(JSON.stringify({ result: 'PASS', browserClosed: !browser.isConnected(), serverClosed: !server.listening }))
