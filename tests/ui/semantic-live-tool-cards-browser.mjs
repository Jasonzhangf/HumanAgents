import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

// Real Chromium regression for the public UI seams. The sandbox blocks local
// socket listeners, so Playwright fulfills an isolated HTTP origin at the
// browser boundary. Every API consumer still uses fetch/EventSource and the
// fixture sends public-shape event-stream bodies; this is not a direct render.
const evidence = process.env.SEMANTIC_LIVE_TOOL_EVIDENCE
if (!evidence) throw new Error('SEMANTIC_LIVE_TOOL_EVIDENCE is required')
const uiRoot = resolve(import.meta.dirname, '../../docs/ui')
const origin = 'http://127.0.0.1:19088'
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
const sendSse = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const interactions = new Map()
const explicitStreamUrls = []
const taskStreamUrls = []
let interactionCount = 0
const taskStreamOpens = new Map()
let releaseTools = false
let releaseResults = false

await mkdir(evidence, { recursive: true })
let browser
const receipt = { origin, checks: [], explicitStreamUrls, taskStreamUrls, errors: [], cleanup: {} }
try {
  browser = await playwright.chromium.launch({ headless: true, args: ['--single-process', '--no-zygote'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route(`${origin}/**`, async route => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url
    const explicitEventMatch = /^\/api\/explicit\/interactions\/([^/]+)\/events$/.exec(pathname)
    if (explicitEventMatch) {
      explicitStreamUrls.push(url.toString())
      const interactionId = decodeURIComponent(explicitEventMatch[1])
      const steps = interactionId === 'interaction-live-1' ? [...selectionSteps, ...internalSteps] : []
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        body: `retry: 2000\n${steps.map(step => sendSse('explicit.step', step)).join('')}` })
    }
    const taskEventMatch = /^\/api\/tasks\/task-live-(\d+)\/events$/.exec(pathname)
    if (taskEventMatch) {
      taskStreamUrls.push(url.toString())
      const index = Number(taskEventMatch[1])
      const opens = (taskStreamOpens.get(index) ?? 0) + 1
      taskStreamOpens.set(index, opens)
      const { bashCall, fileCall, bashResult, fileResult } = makeCalls(index)
      // Real task SSE replays history on reconnect: started is emitted every
      // subscription, then live call and result frames follow as the runtime
      // records them. Gates let the browser observe the real interval between
      // each live fact instead of only a final mock terminal.
      const events = [toolEvent(index, 'execution.started', 9, { summary: '任务已开始执行' })]
      if (opens > 1 && releaseTools) events.push(bashCall, bashCall, fileCall)
      if (opens > 1 && releaseResults) events.push(bashResult, fileResult,
        toolEvent(index, 'provider.tool-result', 50, {
          callId: `bash-live-${index}`, toolId: 'bash', requestId: `other-request-${index}`,
          operationId: `other-operation-${index}`, status: 'failed',
          error: { code: 'late.other-request', message: '不同请求的迟到结果' },
        }),
        toolEvent(index, 'provider.tool', 60, {
          callId: `end-live-${index}`, toolId: 'humanagent.turn.end', arguments: { outcome: 'completed' },
        }),
        toolEvent(index, 'provider.tool-result', 61, {
          callId: `end-live-${index}`, toolId: 'humanagent.turn.end', status: 'succeeded',
        }),
        toolEvent(index, 'execution.terminal', 70, { summary: '本轮执行结束', terminalPhase: 'final' }))
      const body = `retry: 2000\n${events.map(event => sendSse(event.kind, event)).join('')}`
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
        body })
    }
    if (pathname.endsWith('/tool-output')) return route.fulfill(json(report))
    if (pathname === '/fixture/release-result') {
      releaseResults = true
      return route.fulfill(json({ released: true }))
    }
    if (pathname === '/fixture/release-tools') {
      releaseTools = true
      return route.fulfill(json({ released: true }))
    }
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/runtime/status') return route.fulfill(json({ mode: 'fake', state: 'ready', connected: true }))
      if (pathname === '/api/dashboard') return route.fulfill(json({ projects: [] }))
      if (pathname === '/api/main-topic') return route.fulfill(json(projection))
      if (pathname === '/api/tasks') return route.fulfill(json({ draft: [], waiting: [],
        running: [...interactions.values()].filter(item => item.confirmed).map(item => ({ taskId: taskIdFor(item.index),
          title: `预算任务 ${item.index}`, sourceInteractionId: item.interactionId, state: 'running' })),
        completed: [], stopped: [], failed: [] }))
      if (pathname === '/api/product/session') return route.fulfill(json({ messages: [], usage: { calls: [] } }))
      if (pathname === '/api/explicit/inputs') {
        interactionCount += 1
        const current = { index: interactionCount, interactionId: `interaction-live-${interactionCount}`,
          confirmed: false, state: 'matching' }
        interactions.set(current.interactionId, current)
        return route.fulfill(json({ interactionId: current.interactionId, occurredAt: startedAt }, 201))
      }
      const interactionMatch = /^\/api\/explicit\/interactions\/(interaction-live-\d+)$/.exec(pathname)
      if (interactionMatch) {
        const current = interactions.get(interactionMatch[1])
        if (current?.index === 1) return route.fulfill(json({ state: current.state, steps: selectionSteps }))
        if (current?.index === 2) return route.fulfill(json({ state: 'awaiting-clarification', reply: '需要补充验收范围。',
          clarifications: [{ question: '请补充验收范围。', options: ['只验收界面', '验收界面与 API'] }] }))
        return route.fulfill(json({}, 404))
      }
      const interpretMatch = /^\/api\/explicit\/interactions\/(interaction-live-\d+)\/interpret$/.exec(pathname)
      if (interpretMatch) {
        const current = interactions.get(interpretMatch[1])
        current.state = 'awaiting-confirmation'
        return route.fulfill(json({ state: current.state, draft: { draftId: 'draft-live-1', inputRevision: 1,
          proposedIntent: 'create', proposal: '确认项目发布条件', normalizedInput: '确认项目发布条件' } }))
      }
      const confirmationMatch = /^\/api\/explicit\/interactions\/(interaction-live-\d+)\/confirmation$/.exec(pathname)
      if (confirmationMatch) {
        const current = interactions.get(confirmationMatch[1])
        current.confirmed = true
        current.state = 'confirmed'
        return route.fulfill(json({ requirement: { requirementId: 'requirement-live-1', draftId: 'draft-live-1', inputRevision: 1 } }))
      }
      if (pathname === '/api/projects/roster') return route.fulfill(json({ members: [] }))
      if (pathname === '/api/product/decision') return route.fulfill(json({ state: 'none' }))
      return route.fulfill(json({}))
    }
    const path = resolve(uiRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!path.startsWith(`${uiRoot}/`)) return route.fulfill({ status: 404, body: '' })
    try {
      return route.fulfill({ status: 200,
        headers: { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] ?? 'text/plain' },
        body: await readFile(path) })
    } catch {
      return route.fulfill({ status: 404, body: '' })
    }
  })

  const page = await context.newPage()
  page.on('pageerror', error => receipt.errors.push(error.message))
  await page.goto(`${origin}/?scope=system`)
  await page.locator('[data-turn-id="turn-live"]').waitFor({ timeout: 8000 })
  const requestMetadata = await page.locator('.mt-request-metadata').innerText()
  assert.match(requestMetadata, /任务接单/)
  assert.equal(await page.locator('.tool-card[data-tool-id="select-skills"]').count(), 0,
    'skill selection is request preparation, not a business tool card')

  const sameInput = '确认项目发布条件'
  await page.locator('textarea[name=rawInput]').fill(sameInput)
  await page.locator('#entry-form button[type="submit"]').click()
  await page.getByText('任务已开始执行', { exact: false }).waitFor({ timeout: 8000 })
  assert.equal(await page.locator('.tool-card[data-tool-id="bash"]').count(), 0,
    'the started state paints before execution tool facts arrive')
  const startedTurn = page.locator('[data-turn-id^="local-status:"]', { hasText: '任务已开始执行' }).last()
  await startedTurn.waitFor({ timeout: 8000 })
  const startedClock = startedTurn.locator('.conversation-status-time').first()
  assert.match(await startedClock.innerText(), /\d+ 秒/, 'started turn shows a live clock before tool facts')
  const startedFirst = await startedClock.innerText()
  await page.waitForTimeout(1200)
  assert.notEqual(await startedClock.innerText(), startedFirst, 'execution-started receipt clock advances while tool events are pending')
  await page.evaluate(async () => { await fetch('/fixture/release-tools') })
  await page.locator('.tool-card[data-tool-id="bash"][data-tool-class="execution"]').waitFor({ timeout: 8000 })
  await page.locator('.tool-card[data-tool-id="file.read"]').waitFor({ timeout: 8000 })
  console.log('HELPER_DEBUG', JSON.stringify(await page.evaluate(() => ({
    helpers: document.querySelectorAll('.tool-card[data-tool-class="internal-helper"]').length,
    turns: [...document.querySelectorAll('.mt-turn')].map(n => ({ id: n.dataset.turnId, text: n.innerText.slice(0, 160) })),
  }))))
  await page.waitForFunction(() => document.querySelectorAll('.tool-card[data-tool-class="internal-helper"]').length === 1)
  assert.equal(await page.locator('.tool-card[data-tool-id="bash"]').count(), 1, 'duplicate call did not add a card')
  await page.locator('.tool-card[data-tool-id="bash"]').evaluate(node => { window.__bashCard = node })
  await page.waitForTimeout(1200)
  assert.match(await page.locator('.tool-card[data-tool-id="bash"] .tool-elapsed').innerText(), /^\d+ 秒$/)
  assert.notEqual(await page.locator('.tool-card[data-tool-id="bash"] .tool-elapsed').innerText(), '0 秒')
  assert.equal(await page.locator('textarea[name=rawInput]').isEnabled(), true,
    'a running first input does not lock the composer')
  assert.equal(await page.locator('#entry-form button[type="submit"]').isEnabled(), true)
  receipt.checks.push('Alex task SSE shows started state and live semantic execution cards from the public shape')
  await page.screenshot({ path: join(evidence, 'live-tools-running.png'), fullPage: true })

  const firstCard = page.locator('.tool-card[data-tool-id="bash"]')
  await page.locator('textarea[name=rawInput]').fill(sameInput)
  await page.locator('#entry-form button[type="submit"]').click()
  await page.locator('.mt-clarification').waitFor({ timeout: 8000 })
  assert.match(await page.locator('.mt-clarification').innerText(), /需要补充验收范围/)
  assert.equal(await page.locator('.mt-turn--user .mt-text').filter({ hasText: sameInput }).count(), 2,
    'the same input text keeps two independent receipts')
  assert.equal(await page.locator('textarea[name=rawInput]').isEnabled(), true,
    'a waiting clarification keeps the next input available')
  assert.equal(await page.locator('#entry-form button[type="submit"]').isEnabled(), true)
  assert.match(await firstCard.locator('.tool-elapsed').innerText(), /^\d+ 秒$/,
    'the earlier task card continues after the second receipt arrives')
  receipt.checks.push('second input stays independent while the first task runs and another receipt waits for clarification')

  await page.evaluate(async () => { await fetch('/fixture/release-result') })
  await page.waitForFunction(() => window.__bashCard?.dataset.status === 'succeeded', undefined, { timeout: 8000 })
  assert.equal(await page.evaluate(() => window.__bashCard === document.querySelector('.tool-card[data-tool-id="bash"]')), true)
  assert.match(await page.locator('.tool-card[data-tool-id="bash"]').innerText(), /执行成功/)
  assert.match(await page.locator('.tool-card[data-tool-class="internal-helper"]').innerText(), /读取任务结果.*预算任务/s)
  assert.equal(await page.locator('.tool-card[data-tool-id="humanagent.turn.end"]').count(), 0)
  const activeBashText = await page.locator('.tool-card[data-tool-id="bash"]').innerText()
  assert.doesNotMatch(activeBashText, /不同请求的迟到结果|late\.other-request/)
  assert.ok(explicitStreamUrls.length >= 1)
  for (const value of explicitStreamUrls.map(raw => new URL(raw))) {
    assert.equal(value.searchParams.getAll('scope').length, 1)
    assert.equal(value.searchParams.get('scope'), 'system')
    assert.equal(value.searchParams.has('projectKey'), false)
  }
  assert.ok(taskStreamUrls.length >= 2, 'accepted task attaches its task-scoped execution stream')
  for (const value of taskStreamUrls.map(raw => new URL(raw))) {
    assert.match(value.pathname, /^\/api\/tasks\/task-live-1\/events$/)
    assert.equal(value.searchParams.getAll('scope').length, 1)
    assert.equal(value.searchParams.get('scope'), 'system')
    assert.equal(value.searchParams.has('projectKey'), false)
  }
  await page.locator('.tool-card[data-tool-id="bash"]').getByRole('button', { name: '读取完整结果' }).click()
  await page.waitForFunction(() => document.querySelector('.tool-card[data-tool-id="bash"] .tool-output')?.textContent.includes('实时工具输出'),
    undefined, { timeout: 8000 })
  receipt.checks.push('same DOM card settles in place with output; late and turn-end facts do not become cards')

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: join(evidence, `live-tools-${width}.png`), fullPage: true })
  }
  receipt.pass = receipt.errors.length === 0
} catch (error) {
  receipt.failure = error.stack
  throw error
} finally {
  if (browser) await browser.close()
  receipt.cleanup = { browserClosed: true, isolatedOrigin: origin, listenerOpened: false }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify(receipt))

