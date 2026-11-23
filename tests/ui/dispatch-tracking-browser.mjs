import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { createServer } from 'node:http'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const root = resolve(import.meta.dirname, '../../docs/ui')
const evidence = process.env.DISPATCH_EVIDENCE_DIR || resolve(import.meta.dirname, '../../docs/verification/dispatch-tracking-20261123')
await mkdir(evidence, { recursive: true })
const writes = [], checks = [], errors = []
const originalEndpoint = process.env.DISPATCH_ORIGINAL_READ_URL
const project = { projectKey: 'dispatch-proof', projectName: '交办验收', agentName: 'Jenny', mode: 'fake', workspaceCwd: '/isolated/dispatch-proof' }
const tasks = [], turns = [], interactions = new Map()
let phase = 'fixture'
const scope = id => ({ kind: 'task', projectKey: project.projectKey, mode: project.mode, taskId: { scope: 'task', value: id } })
const ref = id => ({ kind: 'interaction', taskRef: { scope: 'task', value: id }, scope: scope(id) })
const fixture = async (req, url) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const input = body ? JSON.parse(body) : {}
  if (req.method !== 'GET') writes.push(url.pathname)
  if (url.pathname === '/api/runtime/status') return { mode: 'fake', state: 'ready' }
  if (url.pathname === '/api/dashboard') return { projects: [{ scope: { projectKey: project.projectKey }, label: project.projectName }] }
  if (url.pathname === '/api/main-topic') return { ...project, turns, tasks }
  if (url.pathname === '/api/tasks') return { draft: [], waiting: [], running: tasks, completed: [], stopped: [], failed: [] }
  if (url.pathname === '/api/explicit/inputs') {
    const id = `interaction-proof-${interactions.size + 1}`
    interactions.set(id, { state: 'received', rawInput: input.rawInput })
    turns.push({ turnId: `user:${id}`, interactionId: id, role: 'user', kind: 'message', text: input.rawInput })
    return { interactionId: id }
  }
  const match = url.pathname.match(/^\/api\/explicit\/interactions\/([^/]+)(?:\/(.*))?$/)
  if (match) {
    const [ , id, action] = match, snapshot = interactions.get(id)
    if (action === 'interpret') {
      if (['重试', '追加要求'].includes(snapshot.rawInput)) {
        const target = tasks[0].taskId
        const intent = snapshot.rawInput === '重试' ? 'change' : 'append'
        Object.assign(snapshot, { state: 'awaiting-confirmation', draft: { draftId: `draft-${id}`, inputRevision: 1,
          proposal: snapshot.rawInput, proposedIntent: intent, matchedTasks: [{ relation: 'current', taskId: target }] } })
        turns.push({ turnId: `draft:${id}`, interactionId: id, role: 'jenny', kind: 'draft', text: snapshot.rawInput })
      } else if (snapshot.rawInput.includes('等于')) {
        Object.assign(snapshot, { state: 'answered', reply: '等于 2' })
        turns.push({ turnId: `reply:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: '等于 2' })
      } else Object.assign(snapshot, { state: 'awaiting-confirmation', draft: { draftId: `draft-${id}`, inputRevision: 1,
        proposal: '检查隔离项目', proposedIntent: 'create', normalizedInput: snapshot.rawInput } })
    }
    if (action === 'confirmation') {
      const taskId = `parent-${id}`
      const requirement = { requirementId: `req-${id}`, draftId: snapshot.draft.draftId, inputRevision: 1 }
      Object.assign(snapshot, { state: 'dispatched', confirmation: requirement })
      tasks.push({ taskId: { scope: 'task', value: taskId }, sourceInteractionId: id, title: `检查隔离项目 ${tasks.length + 1}`, state: 'running', stateLabel: '执行中', identitySource: requirement, scope: scope(taskId) })
      turns.push({ turnId: `draft:${id}`, interactionId: id, role: 'jenny', kind: 'draft', text: `完整任务文档 ${id}`, quote: snapshot.rawInput, taskId: { scope: 'task', value: taskId } })
      return { requirement }
    }
    return snapshot
  }
  if (url.pathname === '/api/product/relations') {
    const id = url.searchParams.get('taskId')
    assert.equal(url.searchParams.get('projectKey'), project.projectKey)
    assert.equal(url.searchParams.get('mode'), 'fake')
    return { relations: [{ kind: 'child-execution', source: ref(id), target: ref(`child-${id}`) }] }
  }
  if (url.pathname === '/api/product/session') {
    const id = url.searchParams.get('taskId')
    const firstExecution = tasks[0] && `child-${tasks[0].taskId.value}`
    if (id !== firstExecution) return { messages: [], usage: { calls: [] } }
    return { messages: [], toolEvents: [{
      kind: 'provider.tool', scope: scope(id), seq: 1, eventId: 'fixture-read-call',
      operationId: 'fixture-op', executionEpoch: 1, callId: 'fixture-read', toolId: 'file.read',
      arguments: { path: 'read-before-turn-end.txt' }, occurredAt: '2026-11-23T12:00:00Z',
    }], usage: { calls: [] } }
  }
  if (url.pathname.endsWith('/observation')) return { nodes: [{ nodeId: 'execute', ownerAgentRole: 'execution', stateDisplay: '进行中', toolSteps: [{ stepId: 'step-1', turnId: 'turn-1', name: 'bash', status: 'succeeded', occurredAt: '2026-11-23T12:00:00Z', returned: 'must never be parsed' }] }] }
  if (url.pathname.endsWith('/semantic')) return { events: [{ type: 'model.started', occurredAt: '2026-11-23T12:00:00Z' }] }
  return {}
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      if (phase === 'live') {
        assert.equal(req.method, 'GET', 'original sample is read-only')
        const response = await fetch(new URL(`${url.pathname}${url.search}`, originalEndpoint))
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text()); return
      }
      const data = await fixture(req, url)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); return
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    assert.ok(path.startsWith(root + '/'))
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'text/plain' }); res.end(await readFile(path))
  } catch (error) { errors.push(error.message); res.writeHead(500); res.end(JSON.stringify({ error: { code: 'proof.failed', message: error.message } })) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await playwright.chromium.launch({ headless: true })
const check = (label, value) => { assert.ok(value, label); checks.push(label) }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/?projectKey=${project.projectKey}&mode=fake`)
  const input = page.locator('textarea[name=rawInput]')
  await input.fill('检查隔离项目')
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.locator('.dispatch-card').waitFor()
  await page.waitForFunction(() => !document.querySelector('#entry-form button[type=submit]').disabled)
  check('formal dispatch releases composer before task completion', tasks[0].state === 'running')
  await page.locator('.mt-turn--dispatch .tool-card').filter({ hasText: 'read-before-turn-end.txt' }).waitFor()
  check('the actual scoped child tool call is visible in chat before the task finishes', tasks[0].state === 'running')
  const beforeRetry = writes.filter(path => path.endsWith('/confirmation')).length
  for (const [index, message] of ['重试', '追加要求'].entries()) {
    await input.fill(message)
    await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
    const draft = page.locator(`[data-turn-id="draft:interaction-proof-${index + 2}"]`)
    const originalLink = draft.getByRole('link', { name: '查看原任务' })
    const targetUrl = new URL(await originalLink.getAttribute('href'), base)
    check(`existing-task proposal “${message}” opens the original scoped task without creating a task`,
      targetUrl.searchParams.get('task') === tasks[0].taskId.value &&
      targetUrl.searchParams.get('projectKey') === project.projectKey &&
      targetUrl.searchParams.get('control') === '1' &&
      writes.filter(path => path.endsWith('/confirmation')).length === beforeRetry)
  }
  await input.fill('1加1等于几')
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.getByText('等于 2', { exact: true }).first().waitFor()
  check('second Jenny conversation works while prior task runs', tasks.length === 1)
  await input.fill('检查第二个独立项目')
  await page.getByRole('button', { name: '发送给 Jenny', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.dispatch-card').length === 2)
  check('two running tasks own separate cards', new Set(await page.locator('.dispatch-card').evaluateAll(nodes => nodes.map(node => node.dataset.dispatchTaskId))).size === 2)
  await input.fill('抽屉关闭后保留这条输入')
  await page.getByRole('button', { name: '任务板', exact: true }).click()
  await page.locator('.dispatch-board-entry').first().click()
  try { await page.locator('.dispatch-detail .tool-card').filter({ hasText: 'read-before-turn-end.txt' }).waitFor({ timeout: 7000 }) }
  catch (error) { await writeFile(resolve(evidence, 'failed-detail.txt'), await page.locator('body').innerText()); throw error }
  check('board opens exact formal child tools', await page.locator('[data-execution-task-id]').getAttribute('data-execution-task-id') === `child-${tasks[0].taskId.value}`)
  const detailText = await page.locator('.dispatch-detail').innerText()
  check('peer delivery and acceptance are separate facts', detailText.includes('任务来源 Jenny · 投递给 编排 Agent')
    && detailText.includes('接单情况：未读到明确接单回执') && detailText.includes('已观察到执行')
    && !detailText.includes('编排 Agent → 执行 Agent') && !detailText.includes('已接手'))
  await page.getByText('模型与操作生命周期', { exact: true }).click()
  await page.getByText('模型开始处理', { exact: false }).waitFor()
  await page.getByText('模型与操作生命周期', { exact: true }).focus()
  await page.evaluate(() => { window.dispatchStableSummary = [...document.querySelectorAll('.dispatch-detail summary')].find(node => node.textContent === '模型与操作生命周期') })
  await page.waitForTimeout(4400)
  check('unchanged polling preserves disclosure DOM and keyboard focus', await page.evaluate(() => window.dispatchStableSummary?.isConnected
    && window.dispatchStableSummary.parentElement.open && document.activeElement === window.dispatchStableSummary))
  await page.screenshot({ path: resolve(evidence, 'isolated-task-chain.png') })
  await page.keyboard.press('Escape')
  check('close retains draft and restores composer focus', await input.inputValue() === '抽屉关闭后保留这条输入' && await input.evaluate(node => document.activeElement === node))
  tasks[0].state = 'blocked'; tasks[0].error = { code: 'fixture.execution-failed', retryable: false, message: 'raw original failure', ownerId: 'execution' }
  await page.waitForFunction(() => document.querySelector('.dispatch-card')?.textContent.includes('fixture.execution-failed'))
  check('error is Chinese and task-owned', !(await page.locator('.dispatch-card').first().innerText()).includes('raw original failure'))
  tasks[1].state = 'succeeded'
  turns.push({ turnId: 'result-second', role: 'jenny', kind: 'result', taskId: tasks[1].taskId, text: '第二个项目检查完成' })
  await page.getByText('第二个项目检查完成', { exact: true }).waitFor()
  check('completed result stays with second task', (await page.locator('.dispatch-card').nth(1).innerText()).includes('完成')
    && await page.locator('[data-turn-id="result-second"] .mt-turn-head strong').innerText() === '任务执行链')
  const before = writes.length
  await page.getByRole('button', { name: '任务板', exact: true }).click()
  await page.locator('.dispatch-board-entry').first().click()
  await page.locator('.dispatch-detail .tool-card').filter({ hasText: 'read-before-turn-end.txt' }).waitFor()
  check('reopening never dispatches again', writes.length === before)
  await page.keyboard.press('Escape')
  if (originalEndpoint) {
    phase = 'live'
    await page.goto(base)
    await page.locator('.dispatch-card').waitFor()
    check('original card is tied to original parent', await page.locator('.dispatch-card').getAttribute('data-dispatch-task-id') === 'ui-task-implicit-draft-2')
    const retryCard = page.locator('[data-turn-id="draft:interaction-3"]')
    const retryTarget = retryCard.getByRole('link', { name: '查看原任务' })
    await retryTarget.waitFor()
    check('original retry draft points to the user’s original blocked task',
      new URL(await retryTarget.getAttribute('href'), base).searchParams.get('task') === 'ui-task-implicit-draft-2')
    await page.screenshot({ path: resolve(evidence, 'original-dispatch-card.png') })
    await page.getByRole('button', { name: '任务板', exact: true }).click()
    await page.locator('.dispatch-board-entry[data-dispatch-task-id="ui-task-implicit-draft-2"]').click()
    await page.getByText('执行 Agent · 列出文件', { exact: true }).waitFor()
    await page.getByText('执行 Agent · 读取文件', { exact: true }).waitFor()
    check('old reader opens real execution child', await page.locator('[data-execution-task-id]').getAttribute('data-execution-task-id') === 'scheduled-task-665227213af5adf02045')
    check('old reader shows structured completed steps', (await page.locator('.dispatch-tool-step').allTextContents()).every(text => text.includes('已完成')))
    await page.screenshot({ path: resolve(evidence, 'original-tool-chain.png') })
  }
  check('no page or HTTP errors', errors.length === 0)
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ checks, writes, errors, browserClosed: !browser.isConnected(), serverClosed: !server.listening, scope: originalEndpoint ? 'isolated fixture and original GET-only proxy' : 'isolated public-API fixture' }, null, 2))
}
console.log(JSON.stringify({ result: 'PASS', checks }))
