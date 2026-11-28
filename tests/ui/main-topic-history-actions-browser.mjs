import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

const root = resolve(import.meta.dirname, '../../docs/ui')
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  if (path === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<html><head><link rel="stylesheet" href="/main-topic.css"></head><body><div id="host"></div></body></html>')
    return
  }
  const file = resolve(root, `.${path}`)
  if (!file.startsWith(`${root}/`)) { res.writeHead(403).end(); return }
  try {
    const body = await readFile(file)
    res.setHeader('content-type', extname(file) === '.js' ? 'text/javascript' : 'text/css')
    res.end(body)
  } catch { res.writeHead(404).end() }
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const playwright = await import('/opt/homebrew/lib/node_modules/playwright/index.js')
const { chromium } = playwright.default ?? playwright
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}`)

  const result = await page.evaluate(async () => {
    const { renderMainTopic, disposeMainTopic } = await import('/main-topic.js')
    const { renderTurnProgressDetail } = await import('/turn-progress-detail.js')
    const host = document.querySelector('#host')
    const base = {
      surface: 'main-topic',
      projectKey: 'proj-browser',
      projectName: 'HumanAgent',
      workspaceCwd: '/tmp/proj',
      mode: 'rcc',
      agentName: 'Jenny',
      topicName: '主话题',
    }
    const taskId = { scope: 'task', value: 't-blocked' }
    const controlTaskId = { scope: 'task', value: 'child-blocked' }
    const operationId = { scope: 'operation', value: 'op-blocked' }
    const ev = (seq, kind, extra = {}) => ({
      eventId: `e-${seq}`,
      seq,
      occurredAt: new Date(Date.UTC(2026, 10, 27, 0, 0, seq)).toISOString(),
      taskId: controlTaskId,
      operationId: operationId.value,
      executionEpoch: extra.executionEpoch ?? 1,
      kind,
      summary: extra.summary || '',
      evidenceRefs: [],
      ...extra,
    })

    const blockedEvents = [
      ev(1, 'execution.started', { state: 'running' }),
      ev(2, 'provider.model', { state: 'dispatching', requestId: 'r1', turnId: 't1' }),
      ev(3, 'provider.tool', { callId: 'c1', toolId: 'bash', requestId: 'r1', turnId: 't1', arguments: { command: 'ls' } }),
      ev(4, 'provider.tool-result', { callId: 'c1', toolId: 'bash', requestId: 'r1', turnId: 't1', status: 'failed', error: { code: 'tool.result.failure', message: 'tool failed' } }),
      ev(5, 'provider.error', { requestId: 'r1', turnId: 't1', error: { code: 'http.429', message: 'rate limit' } }),
    ]
    const blockedTask = {
      taskId,
      controlTaskId,
      operationId,
      allowedActions: ['recover', 'stop'],
      title: '审计任务',
      state: 'blocked',
      stateLabel: '受阻',
      currentNode: '',
      currentStepLabel: '受阻',
      nextStep: '恢复继续或停止任务',
      output: '',
      updatedAt: '2026-11-27T00:00:05.000Z',
      error: { code: 'cold-execution.provider-settlement-unverified', message: '缺少收拢记录', nextAction: '恢复继续' },
      sourceInteractionId: 'i-active',
    }
    const removedCalls = []
    const actionCalls = []
    const blockedProjection = {
      ...base,
      tasks: [blockedTask],
      rounds: [
        { roundKey: 'interaction:i-1', interactionId: 'i-1', lane: 'history', removable: true, userText: '问题 1', summary: { text: '回答 1', source: 'answer-excerpt', sourceRef: 'reply:i-1' }, messageRefs: ['user:i-1', 'reply:i-1'] },
        { roundKey: 'interaction:i-2', interactionId: 'i-2', lane: 'history', removable: true, userText: '问题 2', summary: { text: '回答 2', source: 'answer-excerpt', sourceRef: 'reply:i-2' }, messageRefs: ['user:i-2', 'reply:i-2'] },
        { roundKey: 'interaction:i-active', interactionId: 'i-active', taskId, lane: 'active', removable: false, userText: '执行审计', messageRefs: ['user:i-active', 'error:t-blocked'] },
      ],
      turns: [
        { turnId: 'user:i-1', interactionId: 'i-1', role: 'user', kind: 'message', text: '问题 1' },
        { turnId: 'reply:i-1', interactionId: 'i-1', role: 'jenny', kind: 'message', text: '回答 1' },
        { turnId: 'user:i-2', interactionId: 'i-2', role: 'user', kind: 'message', text: '问题 2' },
        { turnId: 'reply:i-2', interactionId: 'i-2', role: 'jenny', kind: 'message', text: '回答 2' },
        { turnId: 'user:i-active', interactionId: 'i-active', role: 'user', kind: 'message', text: '执行审计' },
        {
          turnId: 'error:t-blocked',
          taskId,
          role: 'jenny',
          kind: 'error',
          text: '缺少收拢记录',
          toolEvents: blockedEvents.filter(e => e.kind === 'provider.tool' || e.kind === 'provider.tool-result'),
          statusFacts: { state: 'blocked', events: blockedEvents, waitingForUser: false, error: blockedTask.error },
        },
      ],
    }

    let detailTurn
    renderMainTopic(host, blockedProjection, {
      onOpenDetail: (_t, turn) => { detailTurn = turn },
      onRemoveHistory: async (payload) => { removedCalls.push(payload) },
      onTaskAction: async (action, task) => { actionCalls.push({ action, controlTaskId: task.controlTaskId?.value }) },
    })

    const hasClearBtn = Boolean(host.querySelector('[data-clear-main-topic-history="true"]'))
    const removeButtonsCount = host.querySelectorAll('[data-remove-round-key]').length
    const hasBlockedErrorOnMain = host.querySelectorAll('.conversation-status-row[data-phase="error"]').length === 1
    const hasRecoverBtn = Boolean(host.querySelector('[data-task-action="recover"]'))
    const hasStopBtn = Boolean(host.querySelector('[data-task-action="stop"]'))
    const blockedToolErrorVisible = host.querySelectorAll('.tool-error').length === 1

    host.querySelector('[data-remove-round-key="interaction:i-1"]').click()
    host.querySelector('[data-clear-main-topic-history="true"]').click()
    host.querySelector('[data-task-action="recover"]').click()
    await new Promise(r => setTimeout(r, 10))

    // Transition to recovered running state (epoch 2 model dispatched)
    const recoveredEvents = [
      ...blockedEvents,
      ev(6, 'execution.started', { executionEpoch: 2, state: 'running' }),
      ev(7, 'provider.model', { executionEpoch: 2, state: 'dispatched', requestId: 'r2', turnId: 't2' }),
    ]
    const recoveredTask = {
      ...blockedTask,
      state: 'running',
      stateLabel: '执行中',
      allowedActions: ['stop'],
      error: undefined,
    }
    renderMainTopic(host, {
      ...base,
      tasks: [recoveredTask],
      rounds: [
        { roundKey: 'interaction:i-active', interactionId: 'i-active', taskId, lane: 'active', removable: false, userText: '执行审计', messageRefs: ['user:i-active', 'status:t-blocked'] },
      ],
      turns: [
        { turnId: 'user:i-active', interactionId: 'i-active', role: 'user', kind: 'message', text: '执行审计' },
        {
          turnId: 'status:t-blocked',
          taskId,
          role: 'jenny',
          kind: 'status',
          text: '执行中',
          toolEvents: recoveredEvents.filter(e => e.kind === 'provider.tool' || e.kind === 'provider.tool-result'),
          statusFacts: { state: 'running', events: recoveredEvents, waitingForUser: false },
        },
      ],
    }, {
      onOpenDetail: (_t, turn) => { detailTurn = turn },
      onRemoveHistory: async (payload) => { removedCalls.push(payload) },
      onTaskAction: async (action, task) => { actionCalls.push({ action, controlTaskId: task.controlTaskId?.value }) },
    })

    const recoveredErrorOnMain = host.querySelectorAll('.conversation-status-row[data-phase="error"]').length
    const recoveredToolErrorOnMain = host.querySelectorAll('.tool-error').length
    const recoveredHasClearBtn = Boolean(host.querySelector('[data-clear-main-topic-history="true"]'))
    const recoveredHasRecoverBtn = Boolean(host.querySelector('[data-task-action="recover"]'))
    const recoveredHasStopBtn = Boolean(host.querySelector('[data-task-action="stop"]'))

    host.querySelector('[data-open-turn-detail]').click()
    const detail = renderTurnProgressDetail(detailTurn)
    const detailText = detail.content.textContent
    const detailErrorStepCount = detail.content.querySelectorAll('.progress-step[data-phase="error"]').length
    const detailErrorVisible = detailText.includes('模型服务请求过于频繁或配额受限')
      && detailText.includes('tool.result.failure')
      && detailErrorStepCount === 1
    detail.dispose()
    disposeMainTopic(host)

    return {
      hasClearBtn,
      removeButtonsCount,
      hasBlockedErrorOnMain,
      hasRecoverBtn,
      hasStopBtn,
      blockedToolErrorVisible,
      removedCalls,
      actionCalls,
      recoveredErrorOnMain,
      recoveredToolErrorOnMain,
      recoveredHasClearBtn,
      recoveredHasRecoverBtn,
      recoveredHasStopBtn,
      detailErrorVisible,
      detailErrorStepCount,
      detailText,
    }
  })

  assert.deepEqual(pageErrors, [])
  assert.equal(result.hasClearBtn, true)
  assert.equal(result.removeButtonsCount, 2)
  assert.equal(result.hasBlockedErrorOnMain, true)
  assert.equal(result.hasRecoverBtn, true)
  assert.equal(result.hasStopBtn, true)
  assert.equal(result.blockedToolErrorVisible, true)
  assert.deepEqual(result.removedCalls, [{ roundKey: 'interaction:i-1' }, { action: 'clear-history' }])
  assert.deepEqual(result.actionCalls, [{ action: 'recover', controlTaskId: 'child-blocked' }])
  assert.equal(result.recoveredErrorOnMain, 0, 'recovered main surface must hide prior transient error rows')
  assert.equal(result.recoveredToolErrorOnMain, 0, 'recovered main surface must hide superseded failed tool card')
  assert.equal(result.recoveredHasClearBtn, false)
  assert.equal(result.recoveredHasRecoverBtn, false)
  assert.equal(result.recoveredHasStopBtn, true)
  assert.equal(result.detailErrorVisible, true, 'detail drawer preserves historical errors and failed tools')
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (browser) await browser.close()
  await new Promise((done) => server.close(done))
}
