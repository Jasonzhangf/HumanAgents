import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

// Run with `ego-browser nodejs < tests/ui/semantic-live-tool-cards-ego-browser.mjs`.
// The fixture uses the real public EventSource and fetch paths. It serves both
// SSE shapes from isolated loopback ports and never connects to runtime 10088.
const uiRoot = '/Volumes/extension/playground/humanagent/sidebar-project-intake-20261124/docs/ui'
const evidence = '/Volumes/extension/playground/humanagent/sidebar-project-intake-20261124/docs/verification/semantic-live-tool-cards-20261125'
const startedAt = new Date(Date.now() - 4000).toISOString()
const taskIdFor = index => ({ scope: 'task', value: `task-live-${index}` })
const baseStep = (kind, seq, extra = {}) => ({ kind, seq, summary: kind, occurredAt: startedAt,
  turnId: 'turn-live', requestId: 'request-live', ...extra })
const selectionSteps = [
  baseStep('tool.started', 1, { tool: { kind: 'select-skills', callId: 'skills-live' } }),
  baseStep('tool.finished', 2, { tool: { kind: 'select-skills', callId: 'skills-live', status: 'succeeded',
    detail: { kind: 'skills', skills: ['task-intake'] } } }),
]
const internalSteps = [
  baseStep('tool.started', 3, { tool: { kind: 'read-task-result', callId: 'read-live' } }),
  baseStep('tool.finished', 4, { tool: { kind: 'read-task-result', callId: 'read-live', status: 'succeeded',
    detail: { kind: 'task-result', title: '预算任务', taskState: 'running', publicationState: 'pending' } } }),
]
const projection = {
  surface: 'main-topic', projectName: 'Alex 主会话', mode: 'fake', agentName: 'Alex', role: 'ceo',
  agentId: 'agent-alex', canonicalAddress: 'machine.CEO', topicName: '主会话', scope: { kind: 'alex' },
  tasks: [], turns: [{ turnId: 'turn-live', role: 'jenny', kind: 'status', interactionId: 'interaction-live-1',
    text: '', statusFacts: { state: 'matching', steps: selectionSteps } }],
}
const toolEvent = (index, kind, seq, extra = {}) => ({
  eventId: `event-${index}-${seq}`, kind, seq, occurredAt: startedAt, taskId: taskIdFor(index),
  operationId: `operation-live-${index}`, executionEpoch: 1, turnId: `turn-live-${index}`,
  requestId: `request-live-${index}`, ...extra,
})
const report = { exitCode: 0, signal: null, timedOut: false, aborted: false,
  stdout: { text: '实时工具输出\n', truncated: false }, stderr: { text: '', truncated: false } }
const makeCalls = index => ({
  bashCall: toolEvent(index, 'provider.tool', 10, { callId: `bash-live-${index}`, toolId: 'bash',
    arguments: { command: 'printf "实时工具输出"', description: '验证实时命令卡', workdir: '/isolated/live-tool-fixture' } }),
  fileCall: toolEvent(index, 'provider.tool', 11, { callId: `file-live-${index}`, toolId: 'file.read', arguments: { path: '项目说明.md' } }),
  bashResult: toolEvent(index, 'provider.tool-result', 20, { callId: `bash-live-${index}`, toolId: 'bash', status: 'succeeded',
    outputRef: `fixture-bash-output-${index}`, outputDigest: 'fixture-digest' }),
  fileResult: toolEvent(index, 'provider.tool-result', 21, { callId: `file-live-${index}`, toolId: 'file.read', status: 'succeeded' }),
})

const explicitStreams = new Map()
const executionStreams = new Map()
const interactions = new Map()
const explicitStreamUrls = []
const taskStreamUrls = []
let interactionCount = 0
const server = createServer(async (req, res) => {
  req.resume()
  const url = new URL(req.url, 'http://127.0.0.1')
  const explicitEventMatch = /^\/api\/explicit\/interactions\/([^/]+)\/events$/.exec(url.pathname)
  if (explicitEventMatch) {
    explicitStreamUrls.push(url.toString())
    const interactionId = decodeURIComponent(explicitEventMatch[1])
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.flushHeaders()
    const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    explicitStreams.set(interactionId, { send })
    for (const step of selectionSteps) send('explicit.step', step)
    setTimeout(() => { for (const step of internalSteps) send('explicit.step', step) }, 40)
    req.on('close', () => { if (explicitStreams.get(interactionId)?.send === send) explicitStreams.delete(interactionId) })
    return
  }
  const taskEventMatch = /^\/api\/tasks\/task-live-(\d+)\/events$/.exec(url.pathname)
  if (taskEventMatch) {
    taskStreamUrls.push(url.toString())
    const index = Number(taskEventMatch[1])
    const { bashCall, fileCall } = makeCalls(index)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.flushHeaders()
    const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    executionStreams.set(index, { send })
    send('execution.started', toolEvent(index, 'execution.started', 9, { summary: '任务已开始执行' }))
    setTimeout(() => { send('provider.tool', bashCall); send('provider.tool', bashCall); send('provider.tool', fileCall) }, 100)
    req.on('close', () => { if (executionStreams.get(index)?.send === send) executionStreams.delete(index) })
    return
  }
  if (url.pathname === '/fixture/release-result') {
    const index = Number(url.searchParams.get('task') || 1)
    const executionStream = executionStreams.get(index)
    if (executionStream) {
      const { bashResult, fileResult } = makeCalls(index)
      executionStream.send('provider.tool-result', bashResult)
      executionStream.send('provider.tool-result', fileResult)
      executionStream.send('provider.tool-result', toolEvent(index, 'provider.tool-result', 50, {
        callId: `bash-live-${index}`, toolId: 'bash', requestId: `other-request-${index}`,
        operationId: `other-operation-${index}`, status: 'failed',
        error: { code: 'late.other-request', message: '不同请求的迟到结果' },
      }))
      executionStream.send('provider.tool', toolEvent(index, 'provider.tool', 60, {
        callId: `end-live-${index}`, toolId: 'humanagent.turn.end', arguments: { outcome: 'completed' },
      }))
      executionStream.send('provider.tool-result', toolEvent(index, 'provider.tool-result', 61, {
        callId: `end-live-${index}`, toolId: 'humanagent.turn.end', status: 'succeeded',
      }))
      executionStream.send('execution.terminal', toolEvent(index, 'execution.terminal', 70, {
        summary: '本轮执行结束', terminalPhase: 'final',
      }))
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ released: true }))
    return
  }
  if (url.pathname.endsWith('/tool-output')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(report))
    return
  }
  if (url.pathname.startsWith('/api/')) {
    let body
    if (url.pathname === '/api/runtime/status') body = { mode: 'fake', state: 'ready', connected: true }
    else if (url.pathname === '/api/dashboard') body = { projects: [] }
    else if (url.pathname === '/api/main-topic') body = projection
    else if (url.pathname === '/api/tasks') body = { draft: [], waiting: [],
      running: [...interactions.values()].filter(item => item.confirmed).map(item => ({ taskId: taskIdFor(item.index),
        title: `预算任务 ${item.index}`, sourceInteractionId: item.interactionId, state: 'running' })),
      completed: [], stopped: [], failed: [] }
    else if (url.pathname === '/api/product/session') body = { messages: [], usage: { calls: [] } }
    else if (url.pathname === '/api/explicit/inputs') {
      interactionCount += 1
      const current = { index: interactionCount, interactionId: `interaction-live-${interactionCount}`, confirmed: false }
      interactions.set(current.interactionId, current)
      body = { interactionId: current.interactionId, occurredAt: startedAt }
    } else if (url.pathname === '/api/explicit/interactions/interaction-live-1') {
      body = { state: 'matching', steps: selectionSteps }
    } else if (url.pathname === '/api/explicit/interactions/interaction-live-1/interpret') {
      await new Promise(resolve => setTimeout(resolve, 120))
      body = { state: 'awaiting-confirmation', draft: { draftId: 'draft-live-1', inputRevision: 1,
        proposedIntent: 'create', proposal: '确认项目发布条件', normalizedInput: '确认项目发布条件' } }
    } else if (url.pathname === '/api/explicit/interactions/interaction-live-1/confirmation') {
      interactions.get('interaction-live-1').confirmed = true
      body = { requirement: { requirementId: 'requirement-live-1', draftId: 'draft-live-1', inputRevision: 1 } }
    } else if (url.pathname === '/api/explicit/interactions/interaction-live-2') {
      body = { state: 'awaiting-clarification', reply: '需要补充验收范围。',
        clarifications: [{ question: '请补充验收范围。', options: ['只验收界面', '验收界面与 API'] }] }
    } else if (url.pathname === '/api/projects/roster') body = { members: [] }
    else if (url.pathname === '/api/product/decision') body = { state: 'none' }
    else body = {}
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
    return
  }
  const path = join(uiRoot, url.pathname === '/' ? 'index.html' : `.${url.pathname}`)
  if (!path.startsWith(`${uiRoot}/`)) { res.writeHead(404).end(); return }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] ?? 'text/plain')
    res.end(await readFile(path))
  } catch { res.writeHead(404).end() }
})

await mkdir(evidence, { recursive: true })
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
const origin = `http://127.0.0.1:${server.address().port}`
const receipt = { origin, checks: [], explicitStreamUrls, taskStreamUrls, errors: [], cleanup: {} }
let task
try {
  task = await taskSpace('semantic live tool cards isolated regression')
  const page = task.page('p1')
  await page.goto(`${origin}/?scope=system`)
  await page.waitForSelector('[data-turn-id="turn-live"]', { state: 'visible', timeout: 8000 })
  const requestMetadata = await page.evaluate(() => [...document.querySelectorAll('.mt-request-metadata')].map(node => node.textContent))
  assert.ok(requestMetadata.some(text => text.includes('任务接单')))
  assert.equal(await page.evaluate(() => document.querySelectorAll('.mt-explicit-tools').length), 0)
  const sameInput = '确认项目发布条件'
  await page.fill('textarea[name=rawInput]', sameInput)
  await page.click('#entry-form button[type="submit"]', { label: '发送第一条实时任务' })
  await page.waitForSelector('.tool-card[data-tool-id="bash"][data-tool-class="execution"]', { state: 'visible', timeout: 8000 })
  await page.waitForSelector('.tool-card[data-tool-id="file.read"]', { state: 'visible', timeout: 8000 })
  const running = await page.evaluate(() => ({
    bashCards: document.querySelectorAll('.tool-card[data-tool-id="bash"]').length,
    started: document.body.innerText.includes('任务已开始执行'),
    composerEnabled: !document.querySelector('textarea[name=rawInput]').disabled,
    submitEnabled: !document.querySelector('#entry-form button[type=submit]').disabled,
    elapsed: document.querySelector('.tool-card[data-tool-id="bash"] .tool-elapsed')?.textContent,
  }))
  await page.evaluate(() => { window.__bashCard = document.querySelector('.tool-card[data-tool-id="bash"]') })
  assert.equal(running.bashCards, 1)
  assert.equal(running.started, true)
  assert.equal(running.composerEnabled, true)
  assert.equal(running.submitEnabled, true)
  assert.match(running.elapsed, /^\d+ 秒$/)
  await page.waitForTimeout(1200)
  const elapsedAfter = await page.evaluate(() => document.querySelector('.tool-card[data-tool-id="bash"] .tool-elapsed')?.textContent)
  assert.notEqual(elapsedAfter, '0 秒')
  await page.screenshot({ path: join(evidence, 'ego-live-tools-running.png'), fullPage: true })
  receipt.checks.push('Alex task stream shows started and one timing semantic card')

  await page.fill('textarea[name=rawInput]', sameInput)
  await page.click('#entry-form button[type="submit"]', { label: '重发同一任务取得独立回执' })
  await page.waitForFunction(() => document.body.innerText.includes('请补充验收范围。'), undefined, { timeout: 8000 })
  const concurrent = await page.evaluate(text => ({
    userCards: [...document.querySelectorAll('.mt-turn--user .mt-text')].filter(node => node.textContent === text).length,
    clarificationForms: document.querySelectorAll('.mt-clarification').length,
    composerEnabled: !document.querySelector('textarea[name=rawInput]').disabled,
    submitEnabled: !document.querySelector('#entry-form button[type=submit]').disabled,
  }), sameInput)
  assert.equal(concurrent.userCards, 2)
  assert.equal(concurrent.clarificationForms, 1)
  assert.equal(concurrent.composerEnabled, true)
  assert.equal(concurrent.submitEnabled, true)
  receipt.checks.push('running and pending-answer receipts are independent and keep the composer usable')

  await page.evaluate(async () => { await fetch('/fixture/release-result?task=1') })
  await page.waitForFunction(() => document.querySelector('.tool-card[data-tool-id="bash"]')?.dataset.status === 'succeeded', undefined, { timeout: 8000 })
  const settled = await page.evaluate(() => {
    const bash = document.querySelector('.tool-card[data-tool-id="bash"]')
    return {
      status: bash?.dataset.status,
      text: bash?.textContent ?? '',
      internalHelpers: document.querySelectorAll('.tool-card[data-tool-class="internal-helper"]').length,
      endCards: document.querySelectorAll('.tool-card[data-tool-id="humanagent.turn.end"]').length,
      lateError: (bash?.textContent ?? '').includes('不同请求的迟到结果'),
    }
  })
  assert.equal(settled.status, 'succeeded')
  assert.match(settled.text, /执行成功/)
  assert.equal(settled.internalHelpers, 1)
  assert.equal(settled.endCards, 0)
  assert.equal(settled.lateError, false)
  assert.equal(await page.evaluate(() => window.__bashCard === document.querySelector('.tool-card[data-tool-id="bash"]')), true,
    'the settled result updates the same live card node')
  receipt.checks.push('same semantic card settles; helper stays distinct and end/late facts do not become cards')

  assert.ok(explicitStreamUrls.length >= 1)
  assert.ok(taskStreamUrls.length >= 1)
  for (const raw of explicitStreamUrls) {
    const url = new URL(raw)
    assert.equal(url.searchParams.getAll('scope').length, 1)
    assert.equal(url.searchParams.get('scope'), 'system')
    assert.equal(url.searchParams.has('projectKey'), false)
  }
  for (const raw of taskStreamUrls) {
    const url = new URL(raw)
    assert.match(url.pathname, /^\/api\/tasks\/task-live-1\/events$/)
    assert.equal(url.searchParams.getAll('scope').length, 1)
    assert.equal(url.searchParams.get('scope'), 'system')
    assert.equal(url.searchParams.has('projectKey'), false)
  }
  receipt.checks.push('explicit and task execution SSE use separate expected public URLs')
  const layout = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(layout.scroll <= layout.client + 1)
  await page.screenshot({ path: join(evidence, 'ego-live-tools-settled.png'), fullPage: true })
  receipt.pass = true
  receipt.publicShape = { explicitEvent: 'explicit.step', executionEvents: ['execution.started', 'provider.tool', 'provider.tool-result', 'execution.terminal'] }
} catch (error) {
  receipt.failure = error.stack
  throw error
} finally {
  await new Promise(done => server.close(done))
  receipt.cleanup.serverClosed = !server.listening
  if (task) await task.finish({ keep: [] })
  receipt.cleanup.browserSpaceFinished = true
  await writeFile(join(evidence, 'ego-browser-receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt))
}
