import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'
import pw from '/opt/homebrew/lib/node_modules/playwright/index.js'

// Same isolated HTTP/browser pattern as main-topic-answer-browser.mjs. These
// controlled receipts exercise the real entry form, without a shared runtime.
const uiRoot = resolve(process.env.CONTINUOUS_UI_ROOT ?? 'docs/ui')
const evidence = process.env.CONTINUOUS_EVIDENCE
assert.ok(evidence, 'CONTINUOUS_EVIDENCE must name an owned evidence directory')
await mkdir(evidence, { recursive: true })
const inputs = [], confirmations = [], answers = [], interactions = new Map()
const turns = [], errors = [], checks = []
const request = { requestId: 'price-request', taskId: { value: 'price-task' },
  expectedRevision: 7, question: '请选择价格口径', options: ['含税价', '未税价'],
  operationId: { value: 'price-operation' }, executionEpoch: 2, turnId: 'price-turn' }
let openRequest, task, release, waiting, failInterpretOnce = true, failLandingOnce = false
function hold() { waiting = new Promise(done => { release = done }) }
function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    if (url.pathname === '/api/runtime/status') return json(res, { mode: 'fake', state: 'ready', connected: true })
    if (url.pathname === '/api/main-topic') return json(res, {
      surface: 'main-topic', agentName: 'Jenny', topicName: '主话题', projectKey: 'continuous',
      projectName: 'continuous', mode: 'fake', turns, tasks: task ? [task] : [],
      ...(openRequest ? { openInputRequest: openRequest, activeTask: task } : {}),
    })
    if (url.pathname === '/api/tasks') return json(res, { waiting: task ? [task] : [], running: [], completed: [], stopped: [], failed: [] })
    if (url.pathname === '/api/explicit/inputs' && req.method === 'POST') {
      inputs.push(body)
      const id = `message-${inputs.length}`
      interactions.set(id, { interactionId: id, state: 'received', rawInput: body.rawInput })
      turns.push({ turnId: `user:${id}`, role: 'user', kind: 'message', text: body.rawInput, interactionId: id })
      return json(res, { interactionId: id }, 201)
    }
    const match = url.pathname.match(/^\/api\/explicit\/interactions\/([^/]+)(?:\/(.*))?$/)
    if (match) {
      const current = interactions.get(match[1])
      if (match[2] === 'events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end() }
      if (match[2] === 'interpret') {
        if (waiting) { await waiting; waiting = undefined }
        if (current.rawInput === '重试问题' && failInterpretOnce) {
          failInterpretOnce = false
          return json(res, { error: { code: 'fixture.failed', message: 'controlled interpretation failure' } }, 500)
        }
        if (current.rawInput === '需要澄清' && !current.clarified) {
          Object.assign(current, { state: 'awaiting-clarification', clarifications: [{ question: '请补充问题' }] })
          return json(res, current)
        }
        if (current.rawInput === '请交办报价任务') {
          Object.assign(current, { state: 'awaiting-confirmation', draft: {
            draftId: 'price-draft', inputRevision: 1, normalizedInput: current.rawInput, proposal: '报价任务',
          } })
        } else {
          Object.assign(current, { state: current.rawInput === '状态问题' ? 'status-only' : 'answered', reply: `唯一回答：${current.rawInput}` })
          turns.push({ turnId: `reply:${current.interactionId}`, role: 'jenny', kind: 'message',
            text: current.reply, interactionId: current.interactionId })
        }
      }
      if (match[2] === 'clarification') {
        current.clarified = true; current.state = 'received'
      }
      if (match[2] === 'confirmation') {
        confirmations.push({ id: match[1], body })
        current.state = 'dispatched'
        current.confirmation = { draftId: 'price-draft', inputRevision: 1, confirmationRef: body.confirmationRef }
        task = { taskId: request.taskId, title: '报价任务', state: 'waiting', stateLabel: '等待回答',
          identitySource: { requirementId: 'price-requirement', draftId: 'price-draft', inputRevision: 1, confirmationRef: body.confirmationRef } }
        openRequest = request
        turns.push({ ...request, turnId: `input-request:${request.requestId}`, role: 'jenny', kind: 'input-request',
          text: request.question })
        return json(res, { requirement: { status: 'submitted', requirementId: 'price-requirement', draftId: 'price-draft', inputRevision: 1 } })
      }
      return json(res, current)
    }
    if (url.pathname === '/api/dashboard') return json(res, { surface: 'runtime-project', projects: [{
      projectKey: 'continuous', mode: 'fake', tasks: [{ scope: { kind: 'task', projectKey: 'continuous', mode: 'fake', taskId: request.taskId }, task }],
    }] })
    if (url.pathname === '/api/tasks/price-task/dashboard') {
      if (failLandingOnce) { failLandingOnce = false; return json(res, { error: { code: 'fixture.failed', message: 'controlled dashboard failure' } }, 500) }
      return json(res, { ...task, allowedActions: [], recentEvents: [] })
    }
    if (url.pathname === '/api/tasks/price-task/input-requests/price-request/answer') {
      answers.push(body); openRequest = undefined
      turns.push({ turnId: 'input-answer:price-request', requestId: request.requestId, taskId: request.taskId,
        role: 'user', kind: 'message', text: body.answer })
      return json(res, { taskId: request.taskId, requestId: request.requestId })
    }
    if (url.pathname.startsWith('/api/')) return json(res, {}, 404)
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1)
    const path = resolve(uiRoot, relative)
    assert.ok(path.startsWith(uiRoot + '/'))
    const file = await readFile(path)
    res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] ?? 'application/octet-stream' })
    res.end(file)
  } catch (error) { json(res, { message: error.message }, 500) }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const port = server.address().port, base = `http://127.0.0.1:${port}`
const browser = await (pw.default ?? pw).chromium.launch({ headless: true })
let failure, page
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  const input = page.locator('#entry-form textarea[name=rawInput]')
  const send = page.locator('#entry-form button[type=submit]')
  async function editable() {
    await page.waitForFunction(() => !document.querySelector('#entry-form button[type=submit]').disabled)
    assert.equal(await input.isEditable(), true, 'settled ordinary form must unlock')
    assert.equal(await input.inputValue(), '', 'settled input must clear')
    assert.equal(await send.innerText(), '发送给 Jenny')
  }
  for (const text of ['第一道简单问题', '第二道简单问题']) {
    hold(); await input.fill(text); await send.click()
    await page.waitForFunction(() => document.querySelector('#entry-form textarea').readOnly)
    await page.locator('#entry-form').evaluate(form => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    release()
    await editable()
    await page.waitForSelector(`[data-turn-id="reply:message-${inputs.length}"]`)
    checks.push(`same-page ${text} settled and unlocked`)
  }
  assert.equal(inputs.length, 2, 'pending submissions cannot repost')
  assert.equal(confirmations.length, 0, 'simple questions create no task')
  for (let i = 1; i <= 2; i++) assert.equal(await page.locator(`[data-turn-id="reply:message-${i}"]`).count(), 1)
  failLandingOnce = true
  await input.fill('请交办报价任务'); await send.click()
  await page.waitForFunction(() => document.querySelector('#entry-form button[type=submit]').textContent === '重试刷新任务进展')
  assert.equal(await input.isEditable(), false, 'failed accepted handoff retains original goal')
  await send.click(); await editable()
  await page.waitForSelector('[data-turn-id="input-request:price-request"]')
  assert.equal(confirmations.length, 1)
  assert.equal(await page.locator('#entry-draft').isVisible(), false,
    'confirmed task keeps the old draft workspace hidden behind the main topic')
  const custom = page.locator('[data-answer-custom="price-request"]')
  await custom.fill('待提交的口径')
  await input.fill('等待答问时独立普通消息'); await send.click(); await editable()
  assert.equal(inputs.length, 4)
  assert.equal(confirmations.length, 1, 'ordinary message cannot create a duplicate task')
  assert.equal(answers.length, 0, 'ordinary message cannot answer an execution request')
  assert.equal(await custom.inputValue(), '待提交的口径', 'ordinary chat preserves the request draft')
  assert.deepEqual(openRequest, request, 'question identity remains bound to the original task')
  for (const body of inputs) {
    for (const key of ['interactionId', 'taskId', 'requestId', 'expectedRevision', 'quote']) assert.equal(key in body, false, key)
  }
  await custom.fill('用未税价')
  await page.getByRole('button', { name: '提交自定义回答', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[data-answer-custom="price-request"]'))
  assert.deepEqual(answers, [{ answer: '用未税价', expectedRevision: 7 }])
  await input.fill('重试问题'); await send.click()
  await page.waitForFunction(() => document.querySelector('#entry-form button[type=submit]').textContent === '重试本次提交')
  assert.equal(await input.isEditable(), false)
  const beforeRetry = inputs.length
  await send.click(); await editable()
  assert.equal(inputs.length, beforeRetry, 'failed interpretation retries the same interaction')
  await input.fill('需要澄清'); await send.click()
  await page.waitForSelector('#entry-draft input[name=answer]')
  assert.equal(await input.isEditable(), false, 'intake clarification keeps its submission identity')
  await page.locator('#entry-draft input[name=answer]').fill('补充信息')
  await page.locator('#entry-draft button[type=submit]').click()
  await page.waitForFunction(() => !document.querySelector('#entry-form textarea').readOnly)
  await editable()
  assert.equal(inputs.length, beforeRetry + 1, 'clarification cannot create a new interaction')
  for (let i=0; i<2; i++) {
    await input.fill('状态问题'); await send.click(); await editable()
  }
  assert.equal(inputs.length, beforeRetry + 3, 'identical later messages still get independent interactions')
  assert.equal(confirmations.length, 1)
  assert.equal(errors.length, 0)
  checks.push('successful handoff and waiting question allow fresh ordinary chat; exact request answer preserved')
  checks.push('failed interpretation and dispatched landing retry retain identity; clarification settles; repeated status messages are independent')
  await page.screenshot({ path: join(evidence, 'same-page-conversation.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await input.fill('手机普通消息'); await send.click(); await editable()
  await page.screenshot({ path: join(evidence, 'same-page-mobile.png'), fullPage: true })
  await context.close()
} catch (error) {
  failure = error.stack; process.exitCode = 1
  if (page) {
    await page.locator('.status-banner [data-technical-detail-trigger]').click({ timeout: 1000 }).catch(() => {})
    await writeFile(join(evidence, 'failure-body.txt'), await page.locator('body').innerText())
    await writeFile(join(evidence, 'failure.html'), await page.content())
  }
}
finally {
  release?.(); await browser.close(); await new Promise(done => server.close(done))
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ base, checks, inputs, confirmations, answers, errors,
    failure, browserClosed: true, serverListening: server.listening }, null, 2))
}
if (failure) console.error(failure)
else console.log(JSON.stringify({ checks, inputs: inputs.length, confirmations: confirmations.length, evidence }))
