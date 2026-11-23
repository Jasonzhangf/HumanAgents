#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = resolve(process.env.MAIN_TOPIC_ANSWER_UI_ROOT ?? join(repoRoot, 'docs', 'ui'))
const evidenceRoot = process.env.MAIN_TOPIC_ANSWER_EVIDENCE?.trim()

if (!evidenceRoot) {
  throw new Error('MAIN_TOPIC_ANSWER_EVIDENCE is required; point it at an execution-owned directory')
}

function createTasks() {
  return new Map([
    ['task-alpha', {
      taskId: { value: 'task-alpha' },
      title: '甲供应商比价',
      state: 'waiting',
      stateLabel: '等待回答',
      currentNode: 'provider.model',
      currentStepLabel: '发出请求等待响应',
      nextStep: '等待用户选择比价口径',
      output: '',
      updatedAt: '2026-11-22T10:00:00.000Z',
      inputRequest: {
        requestId: 'request-alpha',
        taskId: { value: 'task-alpha' },
        schemaRef: 'humanagent://input/text/v1',
        reason: 'fixture',
        impact: 'fixture',
        question: '甲供应商按哪种价格口径比较？',
        options: ['未税价', '含税价'],
        turnId: 'turn-alpha',
        operationId: { value: 'operation-alpha' },
        executionEpoch: 1,
        expectedRevision: 4,
      },
    }],
    ['task-beta', {
      taskId: { value: 'task-beta' },
      title: '乙供应商比价',
      state: 'waiting',
      stateLabel: '等待回答',
      currentNode: 'provider.model',
      currentStepLabel: '发出请求等待响应',
      nextStep: '等待用户补充发货城市',
      output: '',
      updatedAt: '2026-11-22T10:01:00.000Z',
      inputRequest: {
        requestId: 'request-beta',
        taskId: { value: 'task-beta' },
        schemaRef: 'humanagent://input/text/v1',
        reason: 'fixture',
        impact: 'fixture',
        question: '乙供应商发货到哪个城市？',
        turnId: 'turn-beta',
        operationId: { value: 'operation-beta' },
        executionEpoch: 2,
        expectedRevision: 7,
      },
    }],
  ])
}

function createOtherProjectTasks() {
  return new Map([
    ['task-other', {
      taskId: { value: 'task-other' },
      title: '另一个项目',
      state: 'waiting',
      stateLabel: '等待回答',
      currentNode: 'provider.model',
      currentStepLabel: '发出请求等待响应',
      nextStep: '另一个项目没有主项目回答',
      output: '',
      updatedAt: '2026-11-22T10:02:00.000Z',
      inputRequest: {
        requestId: 'request-other',
        taskId: { value: 'task-other' },
        schemaRef: 'humanagent://input/text/v1',
        reason: 'fixture',
        impact: 'fixture',
        question: '另一个项目需要哪种材料？',
        turnId: 'turn-other',
        operationId: { value: 'operation-other' },
        executionEpoch: 1,
        expectedRevision: 2,
      },
    }],
  ])
}

const projects = new Map([
  ['main', { tasks: createTasks(), interactions: [], answers: [], normalChat: [], mainTopicReads: [] }],
  ['other', { tasks: createOtherProjectTasks(), interactions: [], answers: [], normalChat: [], mainTopicReads: [] }],
  ['other-user', { tasks: createOtherProjectTasks(), interactions: [], answers: [], normalChat: [], mainTopicReads: [] }],
  ['layout', { tasks: new Map([['short-message', {
    taskId: { value: 'short-message' }, title: '普通聊天', state: 'succeeded', stateLabel: '已回答',
    updatedAt: '2026-11-22T10:00:00.000Z', sourceInteractionId: 'short-message', rawInput: '你好',
  }]]), interactions: [], answers: [], normalChat: [], mainTopicReads: [] }],
])

function projectFromRequest(req, url) {
  const requested = url.searchParams.get('project')
    ?? (req.headers.referer === undefined ? undefined : new URL(req.headers.referer).searchParams.get('project'))
  const user = url.searchParams.get('user')
    ?? (req.headers.referer === undefined ? undefined : new URL(req.headers.referer).searchParams.get('user'))
  return projects.get(user === 'other' ? 'other-user' : requested) ?? projects.get('main')
}

function mainTopicProjection(project) {
  const { tasks } = project
  const waiting = [...tasks.values()].filter((task) => task.inputRequest)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  const turns = []
  for (const task of tasks.values()) {
    if (task.sourceInteractionId) {
      turns.push({
        turnId: `chat-user:${task.sourceInteractionId}`,
        role: 'user',
        kind: 'message',
        text: task.rawInput,
        interactionId: task.sourceInteractionId,
      })
    }
    for (const consumed of task.consumedInputRequests ?? []) {
      turns.push({
        turnId: `input-request:${consumed.request.requestId}`,
        role: 'jenny',
        kind: 'input-request',
        text: consumed.request.question,
        occurredAt: task.updatedAt,
        taskId: task.taskId,
        requestId: consumed.request.requestId,
        expectedRevision: consumed.request.expectedRevision,
        ...(consumed.request.options === undefined ? {} : { options: consumed.request.options }),
        ...(task.rawInput === undefined ? {} : { quote: task.rawInput }),
      }, {
        turnId: `input-answer:${consumed.request.requestId}`,
        role: 'user',
        kind: 'message',
        text: consumed.answer,
        occurredAt: task.updatedAt,
        taskId: task.taskId,
        requestId: consumed.request.requestId,
        quote: consumed.request.question,
      })
    }
    if (task.inputRequest) {
      turns.push({
        turnId: `input-request:${task.inputRequest.requestId}`,
        role: 'jenny',
        kind: 'input-request',
        text: task.inputRequest.question,
        occurredAt: task.updatedAt,
        taskId: task.taskId,
        requestId: task.inputRequest.requestId,
        expectedRevision: task.inputRequest.expectedRevision,
        ...(task.inputRequest.options === undefined ? {} : { options: task.inputRequest.options }),
        ...(task.rawInput === undefined ? {} : { quote: task.rawInput }),
      })
    }
  }
  const activeTask = waiting ?? [...tasks.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt))[0]
  for (const interaction of project.interactions) {
    turns.push({
      turnId: `user:${interaction.interactionId}`,
      role: 'user',
      kind: 'message',
      text: interaction.rawInput,
      interactionId: interaction.interactionId,
      occurredAt: interaction.occurredAt,
    }, {
      turnId: `reply:${interaction.interactionId}`,
      role: 'jenny',
      kind: 'message',
      text: interaction.reply,
      interactionId: interaction.interactionId,
    })
  }
  return {
    surface: 'main-topic',
    projectKey: 'main-topic-answer-fixture',
    projectName: 'main-topic-answer-fixture',
    workspaceCwd: '/tmp/main-topic-answer-fixture',
    agentName: 'Jenny',
    topicName: '主话题',
    mode: 'fake',
    turns,
    tasks: [...tasks.values()].map(({ inputRequest, sourceInteractionId, rawInput, ...task }) => task),
    ...(waiting?.inputRequest === undefined ? {} : {
      openInputRequest: {
        ...waiting.inputRequest,
        ...(waiting.rawInput === undefined ? {} : { sourceQuestion: waiting.rawInput }),
      },
    }),
    activeTask,
  }
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw === '' ? {} : JSON.parse(raw)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function sendFile(res, filePath) {
  import('node:fs/promises').then(async ({ readFile }) => {
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' })
    res.end(await readFile(filePath))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const project = projectFromRequest(req, url)
  if (req.method === 'GET' && url.pathname === '/api/runtime/status') {
    return json(res, { mode: 'fake', state: 'ready', providerState: 'ready', connected: true })
  }
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    return json(res, { surface: 'tasks', mode: 'fake', counts: { total: project.tasks.size }, waiting: [], running: [], completed: [], stopped: [], failed: [] })
  }
  if (req.method === 'GET' && url.pathname === '/api/main-topic') {
    project.mainTopicReads.push({ sequence: project.mainTopicReads.length + 1 })
    return json(res, mainTopicProjection(project))
  }
  const answerMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/input-requests\/([^/]+)\/answer$/)
  if (req.method === 'POST' && answerMatch) {
    const [, taskId, requestId] = answerMatch
    const task = project.tasks.get(decodeURIComponent(taskId))
    const body = await readBody(req)
    if (task?.inputRequest?.requestId !== decodeURIComponent(requestId)) {
      return json(res, { error: { code: 'task-input-request.not-found', message: 'fixture request is closed' } }, 409)
    }
    project.answers.push({ taskId, requestId, body })
    const expectedRevision = task.inputRequest.expectedRevision
    task.consumedInputRequests = [...task.consumedInputRequests ?? [], {
      request: task.inputRequest,
      answer: String(body.answer ?? '').trim(),
    }]
    task.inputRequest = undefined
    task.state = 'running'
    task.stateLabel = '执行中'
    task.updatedAt = new Date().toISOString()
    return json(res, {
      taskId: task.taskId,
      requestId: decodeURIComponent(requestId),
      inputRevision: expectedRevision,
      continuation: { operationId: { value: `operation-${requestId}` }, executionEpoch: task.inputRequest?.executionEpoch ?? 3 },
    })
  }
  if (req.method === 'POST' && url.pathname === '/api/explicit/inputs') {
    const body = await readBody(req)
    project.normalChat.push(body)
    const interaction = {
      interactionId: `chat-${project.normalChat.length}`,
      rawInput: body.rawInput,
      occurredAt: new Date().toISOString(),
      state: 'answered',
      reply: '这是普通聊天的直接回答。',
    }
    project.interactions.push(interaction)
    return json(res, { interactionId: interaction.interactionId, occurredAt: interaction.occurredAt })
  }
  const explicitMatch = url.pathname.match(/^\/api\/explicit\/interactions\/([^/]+)$/)
  if (req.method === 'GET' && explicitMatch) {
    const interaction = project.interactions.find((candidate) => candidate.interactionId === decodeURIComponent(explicitMatch[1]))
    if (!interaction) return json(res, { error: { code: 'not-found', message: 'fixture interaction missing' } }, 404)
    return json(res, interaction)
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  if (!relative || relative.split('/').includes('..')) {
    res.writeHead(400)
    return res.end('bad path')
  }
  const filePath = resolve(uiRoot, relative)
  if (!filePath.startsWith(`${uiRoot}${sep}`)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  return sendFile(res, filePath)
})

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const playwrightModule = await import(
  process.env.MAIN_TOPIC_ANSWER_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule
const browser = await playwright.chromium.launch({ headless: true })
const failures = []
const pageErrors = []
const consoleMessages = []
const requestFailures = []
const layoutMetrics = []

function check(name, pass, detail = '') {
  if (pass) return
  failures.push({ name, detail })
}

try {
  await mkdir(evidenceRoot, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`))
  page.on('requestfailed', (request) => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`))
  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mt-turn--input-request')
  } catch (error) {
    await writeFile(join(evidenceRoot, 'initial-page.html'), await page.content())
    throw error
  }

  const alpha = page.locator('[data-turn-id="input-request:request-alpha"]')
  const beta = page.locator('[data-turn-id="input-request:request-beta"]')
  check('two questions render independently', await alpha.count() === 1 && await beta.count() === 1)
  const activeTaskText = await page.locator('.mt-active').innerText()
  check('waiting task names the human answer as the wait object', activeTaskText.includes('等待你的回答后继续原任务')
    && !activeTaskText.includes('发出请求等待响应'), activeTaskText)

  const alphaInput = alpha.locator('[data-answer-custom="request-alpha"]')
  await alphaInput.focus()
  await alphaInput.fill('未税价')
  await page.waitForTimeout(2100)
  check('poll keeps the in-progress custom draft', await alphaInput.inputValue() === '未税价')
  check('poll keeps input focus', await page.evaluate(() => document.activeElement?.dataset.answerCustom) === 'request-alpha')

  await alpha.locator('button[data-answer-option="含税价"]').click()
  await page.waitForSelector('[data-turn-id="input-answer:request-alpha"]')
  const main = projects.get('main')
  check('option answer uses the clicked request path and revision', main.answers.length === 1
    && main.answers[0].taskId === 'task-alpha' && main.answers[0].requestId === 'request-alpha'
    && main.answers[0].body.expectedRevision === 4)
  check('server answer turn renders exactly once', await page.locator('[data-turn-id="input-answer:request-alpha"]').count() === 1)
  check('consumed question no longer renders controls', await alpha.locator('[data-answer-custom="request-alpha"], [data-answer-option]').count() === 0)
  check('option answer keeps the other question open', await beta.locator('[data-answer-custom="request-beta"]').count() === 1)

  await beta.locator('[data-answer-custom="request-beta"]').fill('上海')
  await beta.locator('button.mt-option--custom').click()
  await page.waitForSelector('[data-turn-id="input-answer:request-beta"]')
  check('custom answer uses its own request path and revision', main.answers.length === 2
    && main.answers[1].taskId === 'task-beta' && main.answers[1].requestId === 'request-beta'
    && main.answers[1].body.answer === '上海' && main.answers[1].body.expectedRevision === 7)

  const staleResponse = await page.evaluate(async () => {
    const response = await fetch('/api/tasks/task-alpha/input-requests/request-alpha/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: '未税价', expectedRevision: 4 }),
    })
    return { status: response.status, body: await response.json() }
  })
  check('a consumed request reports its real closed state', staleResponse.status === 409
    && staleResponse.body.error.code === 'task-input-request.not-found')
  check('a consumed question cannot submit twice from the browser', main.answers.length === 2)

  const chatInput = page.locator('#entry-form [name="rawInput"]')
  await chatInput.fill('普通聊天不引用任何待答问题')
  await page.locator('#entry-form button[type="submit"]').click()
  await page.waitForSelector('[data-turn-id="reply:chat-1"]')
  check('normal chat posts without input-request identifiers', main.normalChat.length === 1
    && main.normalChat[0].rawInput === '普通聊天不引用任何待答问题'
    && !('taskId' in main.normalChat[0]) && !('requestId' in main.normalChat[0]) && !('expectedRevision' in main.normalChat[0])
    && !('quote' in main.normalChat[0]))
  const normalTurn = page.locator('.mt-turn', { hasText: '普通聊天不引用任何待答问题' }).last()
  check('normal chat does not carry a quote', (await normalTurn.locator('.mt-quote').count()) === 0)
  check('entry shows an ordinary answer once', await page.locator('.mt-text', { hasText: '这是普通聊天的直接回答。' }).count() === 1
    && await page.locator('#entry-direct-answer, .interaction-work-card-host .iwc-card').count() === 0)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-turn-id="input-answer:request-alpha"]')
  check('refresh keeps the answered question and answer', await page.locator('[data-turn-id="input-answer:request-alpha"]', { hasText: '含税价' }).count() === 1)
  check('readback used the public main-topic endpoint', main.mainTopicReads.length >= 4)
  check('refresh renders the authoritative request and answer exactly once',
    await page.locator('[data-turn-id="input-request:request-alpha"]').count() === 1
    && await page.locator('[data-turn-id="input-answer:request-alpha"]').count() === 1)

  const reopened = await context.newPage()
  await reopened.goto(origin, { waitUntil: 'domcontentloaded' })
  await reopened.waitForSelector('[data-turn-id="input-answer:request-alpha"]')
  check('a new page reads the same authoritative answer', await reopened.locator('[data-turn-id="input-answer:request-alpha"]', { hasText: '含税价' }).count() === 1)
  await reopened.close()

  await page.goto(`${origin}/?project=other`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-turn-id="input-request:request-other"]')
  check('switching projects hides the prior project answer', await page.locator('[data-turn-id="input-answer:request-alpha"]').count() === 0)
  check('the browser keeps no local answered-request copy', await page.evaluate(() =>
    sessionStorage.getItem('humanagent.main-topic.input-answers')) === null)
  check('other project read uses its own history', projects.get('other').mainTopicReads.length > 0)
  await page.goto(`${origin}/?user=other`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-turn-id="input-request:request-other"]')
  check('switching users hides the prior user answer', await page.locator('[data-turn-id="input-answer:request-alpha"]').count() === 0)
  check('other user read uses its own history', projects.get('other-user').mainTopicReads.length > 0)
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-turn-id="input-answer:request-alpha"]')
  check('browser has no page errors', pageErrors.length === 0, pageErrors.join('; '))

  await page.screenshot({ path: join(evidenceRoot, 'main-topic-answer-controlled.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(evidenceRoot, 'main-topic-answer-mobile.png'), fullPage: true })
  const mobileScroll = await page.locator('.mt-stream').evaluate((stream) => {
    stream.scrollTop = stream.scrollHeight
    return { scrollTop: stream.scrollTop, scrollHeight: stream.scrollHeight, clientHeight: stream.clientHeight }
  })
  check('mobile conversation scrolls to later answers', mobileScroll.scrollTop > 0, JSON.stringify(mobileScroll))
  await page.screenshot({ path: join(evidenceRoot, 'main-topic-answer-mobile-tail.png'), fullPage: true })
  for (const viewport of [{ width: 1920, height: 1541 }, { width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.goto(`${origin}/?project=layout`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-turn-id="chat-user:short-message"]')
    const metrics = await page.evaluate(() => {
      const bubble = document.querySelector('.mt-bubble')
      const header = document.querySelector('.mt-turn-head')
      const stream = document.querySelector('.mt-stream')
      const input = document.querySelector('#entry-form [name="rawInput"]')
      const rect = input.getBoundingClientRect()
      const style = getComputedStyle(bubble)
      const textStyle = getComputedStyle(bubble.querySelector('.mt-text'))
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        bubbleHeight: bubble.getBoundingClientRect().height,
        naturalBubbleHeight: parseFloat(textStyle.lineHeight) + parseFloat(style.paddingTop)
          + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
        headerBubbleGap: bubble.getBoundingClientRect().top - header.getBoundingClientRect().bottom,
        streamAlignContent: getComputedStyle(stream).alignContent,
        inputVisible: rect.top >= 0 && rect.bottom <= innerHeight,
        inputWidth: rect.width,
        composerWidth: document.querySelector('.page-composer').getBoundingClientRect().width,
        composerPaddingInline: getComputedStyle(document.querySelector('.page-composer')).paddingInline,
        streamOverflowY: getComputedStyle(stream).overflowY,
      }
    })
    layoutMetrics.push(metrics)
    check(`input keeps a readable width at ${viewport.width}`, metrics.inputWidth >= Math.min(viewport.width === 390 ? 240 : 320, viewport.width - 48), JSON.stringify(metrics))
    check(`short bubble has natural height at ${viewport.width}`, Math.abs(metrics.bubbleHeight - metrics.naturalBubbleHeight) < 2, JSON.stringify(metrics))
    check(`no horizontal overflow at ${viewport.width}`, !metrics.horizontalOverflow)
    check(`input remains visible at ${viewport.width}`, metrics.inputVisible)
    check(`stream remains scrollable at ${viewport.width}`, metrics.streamOverflowY === 'auto')
    await page.screenshot({ path: join(evidenceRoot, `${viewport.width === 390 ? 'mobile' : 'desktop'}-${viewport.width}x${viewport.height}.png`), fullPage: true })
  }
  await context.close()
} finally {
  await browser.close().catch(() => {})
  await new Promise((done) => server.close(done))
}

await writeFile(join(evidenceRoot, 'main-topic-answer-controlled.json'), `${JSON.stringify({
  surface: 'controlled-browser-regression',
  origin,
  fixture: {
    mode: 'fake',
    projects: ['main', 'other'],
  },
  answers: projects.get('main').answers,
  normalChat: projects.get('main').normalChat,
  mainTopicReads: projects.get('main').mainTopicReads.length,
  pageErrors,
  consoleMessages,
  requestFailures,
  layoutMetrics,
  cleanup: { browserClosed: !browser.isConnected(), serverListening: server.listening, port: new URL(origin).port },
  failures,
}, null, 2)}\n`)

if (failures.length > 0 || pageErrors.length > 0) {
  console.error(JSON.stringify({ status: 'FAIL', failures, pageErrors }, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({
    status: 'PASS',
    answers: projects.get('main').answers,
    normalChat: projects.get('main').normalChat,
    mainTopicReads: projects.get('main').mainTopicReads.length,
  }))
}
