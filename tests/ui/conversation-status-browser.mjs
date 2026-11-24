import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, join } from 'node:path'

const evidence = process.env.CONVERSATION_STATUS_EVIDENCE
if (!evidence) throw new Error('CONVERSATION_STATUS_EVIDENCE is required')
const root = resolve(process.env.CONVERSATION_STATUS_UI_ROOT ?? 'docs/ui')
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
      const { renderTurnProgressDetail } = await import('/turn-progress-detail.js')
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
      const log = host.querySelector('.mt-stream')
      const observer = new MutationObserver(() => {})
      observer.observe(log, { childList: true })
      paint()
      const results = {
        realClock: Number.parseInt(later) > Number.parseInt(initial),
        pollKeepsStart: host.querySelector('[data-phase="model-wait"] .conversation-status-time').textContent === later,
        pollLeavesActiveCardsMounted: observer.takeRecords().every(change => !change.removedNodes.length && !change.addedNodes.length),
        draftAndFocus: host.querySelector('input') === input && input.value === '含税草稿' && document.activeElement === input,
      }
      observer.disconnect()
      host.querySelector('.conversation-status-detail').click()
      results.detail = details === 1
      const atOffset = seconds => new Date(Date.parse(start) + seconds * 1000).toISOString()
      const verifyingTurn = { ...turn, statusFacts: { state: 'settling', events: [
        ...facts.events,
        event('provider.model', { state: 'settled', requestId: 'r', turnId: 't', occurredAt: atOffset(1) }),
        event('execution.settling', { state: 'settling', occurredAt: atOffset(2) }),
        event('provider.model', { state: 'planner.aligning', occurredAt: atOffset(3) }),
      ] } }
      renderMainTopic(host, { ...base, turns: [verifyingTurn, question] })
      const verification = host.querySelector('[data-phase="task-verification"]')
      results.verificationHasLiveTiming = verification?.innerText.includes('正在核对交付结果')
        && !verification.querySelector('.conversation-status-time').hidden
        && getComputedStyle(verification.querySelector('.conversation-status-mark')).animationName === 'conversation-spin'
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

      const baseTime = Date.now() - 10_000
      const occurredAt = (seconds) => new Date(baseTime + seconds * 1000).toISOString()
      const requestStep = (seq, kind, requestId, seconds) => ({ seq, kind, requestId, turnId: 'turn-tools', occurredAt: occurredAt(seconds) })
      const toolStep = (seq, kind, requestId, callId, seconds, tool) => ({ ...requestStep(seq, kind, requestId, seconds), tool: { callId, ...tool } })
      const earlier = {
        state: 'matching',
        steps: [
          requestStep(1, 'request.dispatching', 'request-1', 0),
          requestStep(2, 'request.dispatched', 'request-1', 1),
          requestStep(3, 'response.streaming', 'request-1', 2),
          toolStep(4, 'tool.started', 'request-1', 'call-1', 3, { kind: 'select-skills' }),
          toolStep(5, 'tool.finished', 'request-1', 'call-1', 5, {
            kind: 'select-skills', status: 'succeeded', detail: { kind: 'skills', skills: ['task-intake'] },
          }),
          toolStep(6, 'tool.started', 'request-1', 'call-2', 5.5, { kind: 'read-task-result' }),
          toolStep(7, 'tool.finished', 'request-1', 'call-2', 7, {
            kind: 'read-task-result', status: 'failed', errorCode: 'task.read_result.invalid-arguments',
            detail: { kind: 'task-result', title: '预算任务', taskState: 'running', publicationState: 'pending' },
          }),
          requestStep(8, 'request.settled', 'request-1', 7.5),
        ],
      }
      const laterExplicit = {
        ...earlier,
        steps: [
          ...earlier.steps,
          requestStep(9, 'request.dispatching', 'request-2', 8),
          requestStep(10, 'request.dispatched', 'request-2', 9),
        ],
      }
      const explicitTurn = { turnId: 'explicit-tools', role: 'jenny', kind: 'status', text: '', statusFacts: earlier }
      renderMainTopic(host, { ...base, turns: [explicitTurn] }, { onOpenDetail: () => details++ })
      const article = host.querySelector('[data-turn-id="explicit-tools"]')
      const priorCards = [...article.querySelectorAll('.mt-explicit-tool')]
      const priorStatus = article.querySelector('.conversation-status')
      const firstToolTime = priorCards[0]?.querySelector('.conversation-status-time')?.textContent
      renderMainTopic(host, { ...base, turns: [explicitTurn] }, { onOpenDetail: () => details++ })
      const stableStatus = article.querySelector('.conversation-status')
      explicitTurn.statusFacts = laterExplicit
      renderMainTopic(host, { ...base, turns: [explicitTurn] }, { onOpenDetail: () => details++ })
      const nextCards = [...article.querySelectorAll('.mt-explicit-tool')]
      const visibleText = article.innerText
      results.toolsPreserved = priorCards.length === 2 && nextCards.length === 2
        && priorCards.every((card, index) => card === nextCards[index])
      results.pollDoesNotReplaceStatus = stableStatus === priorStatus
      results.toolClockIsReal = firstToolTime === '2 秒'
        && nextCards[0].querySelector('.conversation-status-time')?.textContent === '2 秒'
      results.modelClockIsIndependent = [...article.querySelectorAll('.conversation-status-row[data-phase="model-wait"]')]
        .some((row) => row.querySelector('.conversation-status-time')?.textContent !== firstToolTime)
      results.toolSemantics = visibleText.includes('加载本轮技能')
        && visibleText.includes('读取任务结果')
        && visibleText.includes('读取预算任务') === false
        && visibleText.includes('预算任务')
        && visibleText.includes('任务执行中')
        && visibleText.includes('正式结果尚待发布')
      results.failureVisible = nextCards[1].dataset.status === 'failed'
        && nextCards[1].innerText.includes('失败')
        && nextCards[1].innerText.includes('task.read_result.invalid-arguments')
      results.privateAndDuplicateCopyHidden = !/request-1|call-1|SECRET_REASONING/.test(visibleText)
        && !visibleText.includes('正在处理你的请求')
      const pendingDetails = { ...explicitTurn, statusFacts: { ...earlier, steps: earlier.steps.slice(0, 6) } }
      const completedDetails = { ...explicitTurn, statusFacts: { ...earlier, steps: earlier.steps.slice(0, 7) } }
      let openedTurn
      const captureDetail = { onOpenDetail: (_trigger, turn) => { openedTurn = turn } }
      renderMainTopic(host, { ...base, turns: [pendingDetails] }, captureDetail)
      const stableDetailButton = article.querySelector('[data-open-turn-detail]')
      renderMainTopic(host, { ...base, turns: [completedDetails] }, captureDetail)
      article.querySelector('[data-open-turn-detail]').click()
      results.reusedDetailOpensLatestToolResult = stableDetailButton === article.querySelector('[data-open-turn-detail]')
        && openedTurn.statusFacts.steps.at(-1).tool.errorCode === 'task.read_result.invalid-arguments'

      const detailTime = new Date(Date.now() - 2000).toISOString()
      const detailEvent = (kind, extra = {}) => ({ kind, occurredAt: detailTime, taskId,
        operationId: 'op-detail', executionEpoch: 2, turnId: 'turn-detail', requestId: 'request-detail', ...extra })
      const failedCall = detailEvent('provider.tool', { callId: 'call-failed', toolId: 'file.read', arguments: { path: '/tmp/evidence.txt' } })
      const failedResult = detailEvent('provider.tool-result', { seq: 2, callId: 'call-failed', toolId: 'file.read',
        status: 'failed', error: { code: 'tool.read.denied', message: '拒绝读取' } })
      const emptyCall = detailEvent('provider.tool', { seq: 3, callId: 'call-empty', toolId: 'bash', arguments: { command: ':', description: '空输出' } })
      const emptyResult = detailEvent('provider.tool-result', { seq: 4, callId: 'call-empty', toolId: 'bash',
        status: 'succeeded', outputRef: 'asset-empty', outputDigest: 'digest-empty' })
      const detailTurn = { turnId: 'turn-detail', role: 'jenny', kind: 'status', text: '', taskId,
        toolEvents: [failedCall, failedResult, emptyCall, emptyResult],
        statusFacts: { state: 'running',
          events: [detailEvent('provider.model', { state: 'dispatched' })],
          steps: [{ seq: 5, kind: 'tool.started', requestId: 'request-explicit', turnId: 'turn-detail',
            occurredAt: detailTime, tool: { callId: 'call-missing', kind: 'read-task-result' } }] } }
      host.replaceChildren()
      let readTarget
      const detail = renderTurnProgressDetail(detailTurn, { readOutput: async (target) => { readTarget = target; return '' } })
      host.append(detail.content)
      results.detailShowsCurrentRequest = detail.content.querySelector('.progress-step[data-phase="model-wait"]')?.innerText.includes('等待模型响应')
      results.detailShowsFailedTool = detail.content.querySelector('.tool-card[data-tool-id="file.read"][data-status="failed"]')?.innerText.includes('tool.read.denied')
      results.detailShowsFinishedMissingResult = detail.content.querySelector('.mt-explicit-tool')?.innerText.includes('结果未记录')
      const outputButton = detail.content.querySelector('.tool-read-output')
      outputButton?.click()
      await new Promise((done) => setTimeout(done, 20))
      results.detailShowsEmptyResult = detail.content.querySelector('.tool-output')?.textContent === '（空字符串）'
      results.detailKeepsToolIdentity = readTarget?.taskId?.value === taskId.value
        && readTarget?.operationId === 'op-detail' && readTarget?.executionEpoch === 2 && readTarget?.seq === 4
      detail.dispose()
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
