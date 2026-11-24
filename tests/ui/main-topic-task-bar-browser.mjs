import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

// Failure basis: the expanded task bar can repeat live tool, retry, timing and
// result facts owned by the main timeline. Impact: users cannot tell where to
// act while the mobile drawer consumes input space. Cost: one isolated Chromium
// run across desktop and mobile.
const root = resolve(import.meta.dirname, '../../docs/ui')
const evidence = process.env.MAIN_TOPIC_TASK_BAR_EVIDENCE
  ?? resolve(import.meta.dirname, '../../.worker-runs/main-topic-task-bar-p2-20261124/shots')
const taskOne = 'internal-task-id-not-for-display'
const operationOne = 'internal-operation-id-not-for-display'
const callOne = 'internal-call-id-not-for-display'
const taskId = { scope: 'task', value: taskOne }
const operationId = { scope: 'operation', value: operationOne }
const baseEvent = {
  taskId, operationId, executionEpoch: 1, requestId: 'request-private', turnId: 'turn-private',
}
const fileCall = {
  ...baseEvent, seq: 3, occurredAt: '2026-11-24T12:00:02.000Z', kind: 'provider.tool',
  callId: callOne, toolId: 'file.read', arguments: { path: 'finance/quarterly-report.md' },
}
const fileResult = {
  ...baseEvent, seq: 4, occurredAt: '2026-11-24T12:00:03.000Z', kind: 'provider.tool-result',
  callId: callOne, toolId: 'file.read', status: 'succeeded',
  outputRef: { relativePath: 'tool-outputs/quarterly-report.txt' }, outputDigest: 'fixture-digest',
}
const modelWaiting = {
  ...baseEvent, seq: 1, occurredAt: '2026-11-24T12:00:00.000Z', kind: 'provider.model', state: 'dispatched',
}
const receiving = {
  ...baseEvent, seq: 2, occurredAt: '2026-11-24T12:00:01.000Z', kind: 'provider.output', state: 'received',
}
const task = (state = 'running', error) => ({
  taskId, title: '核对季度预算与采购计划', semanticTitle: '核对季度预算与采购计划',
  state, stateLabel: state === 'succeeded' || state === 'completed' ? '已完成' : state === 'blocked' ? '受阻' : '执行中',
  currentNode: 'provider.tool', currentStepLabel: '读取预算文件', nextStep: '核对采购计划',
  output: state === 'succeeded' ? '预算与采购计划已核对，差异已整理。' : '',
  updatedAt: state === 'running' ? '2026-11-24T12:00:03.000Z' : '2026-11-24T12:00:05.000Z',
  startedAt: '2026-11-24T11:59:59.000Z', sourceInteractionId: 'interaction-private',
  ...(error ? { error } : {}),
})
const projection = ({ state = 'running', phase = 'tool', error } = {}) => {
  const currentTask = task(state, error)
  const events = phase === 'wait' ? [modelWaiting]
    : phase === 'receiving' ? [modelWaiting, receiving]
      : phase === 'tool' ? [modelWaiting, receiving, fileCall]
        : [modelWaiting, receiving, fileCall, fileResult]
  const toolEvents = phase === 'tool' || phase === 'done' ? [fileCall, fileResult] : []
  return {
    surface: 'main-topic', projectKey: 'budget-project', projectName: '季度预算项目',
    workspaceCwd: '/tmp/budget-project', mode: 'fake', agentName: 'Jenny', topicName: '主会话',
    tasks: [currentTask], activeTask: state === 'running' ? currentTask : undefined,
    turns: [
      { turnId: 'user-private', role: 'user', kind: 'message', text: '核对预算和采购计划。' },
      { turnId: 'status-private', role: 'jenny', kind: 'status', text: '正在核对预算与采购计划。', taskId,
        statusFacts: { state, events, waitingForUser: false, ...(error ? { error } : {}) }, toolEvents },
    ], rounds: [],
  }
}
const retryProjection = () => {
  const base = projection({ phase: 'receiving' })
  const retryEvent = {
    ...baseEvent, seq: 3, occurredAt: '2026-11-24T12:00:02.000Z', kind: 'execution.retry',
    state: 'retrying', attemptNumber: 2, summary: '第 2 次尝试',
    retryDeadlineAt: '2026-11-24T23:59:59.000Z',
    error: { code: 'http.503', message: 'HTTP 503' },
  }
  const taskError = { code: 'http.503', message: 'HTTP 503' }
  const currentTask = { ...base.tasks[0], currentStepLabel: '第 2 次尝试',
    nextStep: '等待 Provider 事件', error: taskError }
  const status = base.turns[1]
  return {
    ...base, tasks: [currentTask], activeTask: currentTask,
    turns: [base.turns[0], { ...status, statusFacts: {
      state: 'running', events: [...status.statusFacts.events, retryEvent], waitingForUser: false, error: taskError,
    } }],
  }
}
const receipt = { checks: [], errors: [], mutations: [], cleanup: {} }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method !== 'GET') receipt.mutations.push({ method: req.method, path: url.pathname })
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json')
    if (/\/tool-output$/.test(url.pathname)) {
      const content = Array.from({ length: 80 }, (_, index) => `预算明细 ${index + 1}：采购计划与预算保持可核对`).join('\n')
      res.end(JSON.stringify({ content }))
    } else res.end(JSON.stringify({ error: { code: 'fixture.unavailable', message: '隔离测试未提供该接口' } }))
    return
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.setHeader('content-type', 'text/html')
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link rel="stylesheet" href="/runtime.css"><link rel="stylesheet" href="/main-topic.css">
      <link rel="stylesheet" href="/entry-shell.css"></head><body>
      <div id="page-root" class="entry-workspace">
      <dialog class="entry-rail-dialog"><nav class="entry-rail" aria-label="项目与成员">
      <div class="entry-brand"><span class="entry-mark">H</span><span>HumanAgent</span></div>
      <button class="entry-person entry-jenny" type="button">Jenny</button></nav></dialog>
      <main class="page" data-page-layout="work">
      <header class="entry-toolbar"><strong class="entry-scope-title">季度预算项目 · Jenny</strong></header>
      <section class="page page-primary"><div class="main-topic-host"></div></section>
      <section class="page page-composer"><textarea name="rawInput"></textarea></section></main>
      </div></body></html>`)
    return
  }
  const file = resolve(root, `.${url.pathname}`)
  if (!file.startsWith(`${root}/`)) return res.writeHead(403).end()
  try {
    res.setHeader('content-type', { '.css': 'text/css', '.js': 'text/javascript' }[extname(file)] || 'text/plain')
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
})
await mkdir(evidence, { recursive: true })
await new Promise(done => server.listen(0, '127.0.0.1', done))
receipt.port = server.address().port
let browser
const check = (name, condition) => { assert.ok(condition, name); receipt.checks.push(name) }
try {
  browser = await playwright.chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
  page.setDefaultTimeout(5000)
  page.on('pageerror', error => receipt.errors.push(error.message))
  await page.goto(`http://127.0.0.1:${receipt.port}/`)
  await page.evaluate(async initial => {
    const { renderMainTopic, disposeMainTopic } = await import('/main-topic.js')
    const { openTechnicalDetail } = await import('/runtime-shell.js')
    const host = document.querySelector('.main-topic-host')
    window.disposeProbe = () => disposeMainTopic(host)
    window.openScriptCount = 0
    window.renderProbe = value => renderMainTopic(host, value, {
      onOpenDispatch: (trigger, currentTask) => {
        window.openScriptCount += 1
        openTechnicalDetail({
          title: currentTask.title, content: document.createTextNode('完整执行链已打开'), trigger,
        })
      },
    })
    window.renderProbe(initial)
  }, projection({ phase: 'wait' }))
  const bar = page.locator('.jenny-task-bar')
  await bar.waitFor()
  check('active Jenny task has a retained top bar', await bar.getByText('核对季度预算与采购计划', { exact: true }).count() === 1)
  check('waiting model has an explicit phase', (await bar.innerText()).includes('等待模型响应'))
  const collapsed = await bar.locator('.jenny-task-bar-toggle').innerText()
  check('collapsed bar is one hierarchy: bullet, title, one live fact', collapsed.includes('核对季度预算与采购计划')
    && collapsed.includes('等待模型响应') && !collapsed.includes('执行中') && !collapsed.includes('Jenny 交办')
    && await bar.locator('.jenny-task-bar-toggle .jenny-task-bar-phase').count() === 1)
  await page.screenshot({ path: join(evidence, 'desktop-1440-collapsed.png'), fullPage: true })
  const toggle = bar.locator('.jenny-task-bar-toggle')
  await toggle.click()
  check('first click expands semantic detail', await toggle.getAttribute('aria-expanded') === 'true' && await bar.locator('.jenny-task-bar-detail').isVisible())
  const expanded = await bar.locator('.jenny-task-bar-detail').innerText()
  check('expanded detail is a concise summary with independent scope', expanded.includes('执行摘要')
    && expanded.includes('季度预算项目') && expanded.includes('下一步：核对采购计划'))
  check('expanded detail does not clone timeline facts', await bar.locator('.jenny-task-bar-detail .conversation-status, .jenny-task-bar-detail .tool-card').count() === 0)
  await toggle.focus()
  await page.evaluate(value => window.renderProbe(value), projection({ phase: 'receiving' }))
  check('receiving response is distinct', (await bar.innerText()).includes('正在接收模型响应'))
  check('rapid refresh retains bar and expanded focus', await bar.evaluate((node, toggleNode) => node === document.querySelector('.jenny-task-bar')
    && node.querySelector('.jenny-task-bar-toggle') === toggleNode, await toggle.elementHandle()))
  check('rapid refresh retains open state and focus', await toggle.getAttribute('aria-expanded') === 'true'
    && await toggle.evaluate(node => node === document.activeElement))
  await page.evaluate(value => window.renderProbe(value), retryProjection())
  const retryDetail = bar.locator('.jenny-task-bar-detail')
  const retryDetailText = await retryDetail.innerText()
  check('retry state appears once in the task bar, in its compact line',
    (await toggle.innerText()).includes('第 2 次尝试') && !retryDetailText.includes('第 2 次尝试'))
  const retryTimeline = page.locator('.mt-stream .conversation-status-row[data-phase="retry"]')
  await retryTimeline.waitFor()
  const retryTimelineText = await retryTimeline.innerText()
  check('original timeline keeps retry timing and error', retryTimelineText.includes('第 2 次尝试')
    && retryTimelineText.includes('秒后重试') && retryTimelineText.includes('模型服务暂时不可用'))
  check('expanded bar leaves retry time and code in the original timeline', !retryDetailText.includes('秒后重试')
    && !retryDetailText.includes('http.503') && !retryDetailText.includes('模型服务暂时不可用'))
  check('raw provider wait hint is absent', !(await bar.innerText()).includes('等待 Provider 事件'))
  const retryGeometry = await page.evaluate(() => {
    const toggleNode = document.querySelector('.jenny-task-bar-toggle')
    const detailNode = document.querySelector('.jenny-task-bar-detail')
    const composerNode = document.querySelector('.page-composer')
    const r = node => { const b = node.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height } }
    return { toggle: r(toggleNode), detail: r(detailNode), composer: r(composerNode) }
  })
  check('desktop task bar stays one row and leaves the composer visible', retryGeometry.toggle.height <= 52
    && retryGeometry.detail.bottom < retryGeometry.composer.top)
  await page.screenshot({ path: join(evidence, 'desktop-1440-retry-expanded.png'), fullPage: true })
  await page.evaluate(value => window.renderProbe(value), projection({ phase: 'tool' }))
  check('tool phase is semantically named', (await bar.innerText()).includes('读取文件'))
  const toolCard = page.locator('.mt-stream .tool-card[data-tool-id="file.read"]')
  await toolCard.waitFor()
  check('actual tool card remains once in the original timeline', await toolCard.count() === 1
    && await bar.locator('.jenny-task-bar-detail .tool-card').count() === 0)
  await toolCard.locator('.tool-read-output').click()
  const toolDialog = toolCard.locator('.tool-result-detail dialog[open]')
  await toolDialog.waitFor()
  await toolDialog.locator('.tool-output').waitFor({ state: 'visible' })
  const preview = toolCard.locator('.tool-preview')
  await preview.evaluate(node => { node.scrollTop = 37 })
  receipt.scrollProbe = await preview.evaluate(node => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }))
  await page.evaluate(value => window.renderProbe(value), projection({ phase: 'tool' }))
  check('unchanged poll retains the same tool card', await toolCard.evaluate(node => node === document.querySelector('.mt-stream .tool-card[data-tool-id="file.read"]')))
  receipt.scrollProbe.afterPoll = await preview.evaluate(node => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }))
  check('unchanged poll keeps the open tool result', await toolDialog.evaluate(node => node.open))
  check('unchanged poll retains tool scroll', await preview.evaluate(node => node.scrollTop === 37))
  const toolDialogElement = await toolDialog.elementHandle()
  await toolDialog.locator('.detail-disclosure-close').first().click()
  check('tool result can close without replacing its card', await toolDialogElement.evaluate(node => !node.open))
  const factsButton = toolCard.locator('.tool-facts > .detail-disclosure-trigger')
  const factsStyle = await factsButton.evaluate(node => {
    const style = getComputedStyle(node)
    return { border: style.borderStyle, radius: style.borderRadius, background: style.backgroundColor, minHeight: style.minHeight }
  })
  check('tool evidence control uses the local detail surface', factsStyle.border === 'solid'
    && factsStyle.radius !== '2px' && factsStyle.background !== 'rgba(0, 0, 0, 0)' && factsStyle.minHeight === '32px')
  await factsButton.click()
  const factsDialog = toolCard.locator('.tool-facts dialog[open]')
  await factsDialog.waitFor()
  check('tool evidence control opens the existing detail dialog', (await factsDialog.innerText()).includes('finance/quarterly-report.md'))
  await page.screenshot({ path: join(evidence, 'desktop-1440-tool-details.png'), fullPage: true })
  await page.keyboard.press('Escape')
  const openChain = bar.getByRole('button', { name: '查看完整执行链' })
  await openChain.click()
  const drawer = page.locator('dialog[data-technical-detail][open]')
  await drawer.waitFor()
  check('second level opens the existing right drawer', await page.evaluate(() => window.openScriptCount) === 1 && (await drawer.innerText()).includes('完整执行链已打开'))
  await page.keyboard.press('Escape')
  check('drawer returns focus to its task-bar trigger', await openChain.evaluate(node => node === document.activeElement))
  await page.evaluate(value => window.renderProbe(value), projection({ state: 'completed', phase: 'done' }))
  check('success is green and readable', await bar.getAttribute('data-tone') === 'success'
    && (await bar.innerText()).includes('结果已交付') && !(await bar.innerText()).includes('已完成'))
  const blocked = projection({ state: 'blocked', phase: 'done', error: {
    code: 'unknown.event', message: '模型服务返回了无法识别的响应事件', nextAction: 'inspect the runtime error and retry from a new operation',
  } })
  await page.evaluate(value => window.renderProbe(value), blocked)
  const blockedText = await bar.innerText()
  check('blocked is red with reason and next action', await bar.getAttribute('data-tone') === 'danger'
    && blockedText.includes('受阻') && blockedText.includes('模型服务返回了无法识别的响应事件')
    && blockedText.includes('查看执行错误，再从新一轮执行重试'))
  check('expanded detail names the owner route and current scope', blockedText.includes('编排 Agent 执行')
    && blockedText.includes('季度预算项目 / 主会话'))
  check('internal task and operation identities are absent from visible bar copy', !blockedText.includes(taskOne)
    && !blockedText.includes(operationOne) && !blockedText.includes(callOne))
  await page.screenshot({ path: join(evidence, 'desktop-1440.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(value => window.renderProbe(value), projection({ phase: 'tool' }))
  const geometry = await page.evaluate(() => {
    const barNode = document.querySelector('.jenny-task-bar')
    const button = document.querySelector('.jenny-task-bar-toggle')
    const head = document.querySelector('.mt-head')
    const user = document.querySelector('.mt-turn--user')
    const main = document.querySelector('.page-primary')
    const composer = document.querySelector('.page-composer')
    const input = document.querySelector('.page-composer textarea, .page-composer #entry-form') || document.querySelector('.page-composer')
    const r = node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, height: b.height, top: b.top, bottom: b.bottom } }
    return { body: r(document.body), root: r(document.querySelector('#page-root')), main: r(main), composer: r(composer), bar: r(barNode), button: r(button), detail: r(barNode.querySelector('.jenny-task-bar-detail')), head: r(head), user: r(user), input: r(input),
      sticky: getComputedStyle(barNode).position, overflow: document.documentElement.scrollWidth > innerWidth }
  })
  receipt.mobileGeometry = geometry
  check('mobile has no horizontal overflow', geometry.overflow === false && geometry.button.right <= 390 && geometry.button.left >= 0)
  check('bar remains a floating single row', geometry.sticky === 'sticky' && geometry.button.height <= 52)
  check('expanded mobile detail leaves the input visible', geometry.detail.bottom < geometry.composer.top)
  check('mobile keeps the actual tool card in the original timeline', await page.locator('.mt-stream .tool-card[data-tool-id="file.read"]').count() === 1
    && await bar.locator('.jenny-task-bar-detail .tool-card').count() === 0)
  check('title, messages and input share the content edges', Math.abs(geometry.head.left - geometry.input.left) <= 1
    && Math.abs(geometry.head.right - geometry.user.right) <= 1
    && Math.abs(geometry.head.right - geometry.input.right) <= 1)
  const motionBefore = await bar.locator('.jenny-task-bar-mark').evaluate(node => getComputedStyle(node).animationName)
  check('real activity has a restrained loop', motionBefore !== 'none')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  check('reduced motion disables the activity loop', await bar.locator('.jenny-task-bar-mark').evaluate(node => getComputedStyle(node).animationName) === 'none')
  await page.screenshot({ path: join(evidence, 'mobile-390.png'), fullPage: true })
  check('no page errors', receipt.errors.length === 0)
  check('no writes to public APIs', receipt.mutations.length === 0)
} catch (error) {
  receipt.failure = error.stack
  throw error
} finally {
  if (browser) await browser.close()
  await new Promise(done => server.close(done))
  receipt.cleanup = { browserClosed: !browser?.isConnected(), serverClosed: !server.listening }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ result: 'PASS', checks: receipt.checks, evidence }, null, 2))
