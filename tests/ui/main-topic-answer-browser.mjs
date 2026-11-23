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
        expectedRevision: consumed.request.expectedRevision,
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
  const productRead = ['/api/product/session', '/api/product/relations'].includes(url.pathname)
  const taskRead = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(observation|semantic)$/)
  if (productRead || taskRead) {
    // Bind the existing read-scope counterexamples to the isolated HTTP owner:
    // product-relations-http-consumer and product-read-http-public-consumer,
    // plus observation-read.graph.json. Reads never invent lineage or execution.
    if (req.method !== 'GET') {
      return json(res, { error: { code: 'method.not-allowed', message: 'fixture read is GET only' } }, 405)
    }
    const projectKey = url.searchParams.get('projectKey')
    const mode = url.searchParams.get('mode')
    const allowed = new Set(['projectKey', 'mode', ...(productRead ? ['taskId',
      ...(url.pathname === '/api/product/session' ? ['sessionId'] : [])] : [])])
    if (!projectKey?.trim() || !['fake', 'rcc'].includes(mode)
      || [...url.searchParams].some(([key, value]) => !allowed.has(key)
        || !value.trim() || url.searchParams.getAll(key).length !== 1)) {
      return json(res, { error: { code: 'read.scope.invalid', message: 'fixture needs one complete read scope' } }, 400)
    }
    if (projectKey !== 'main-topic-answer-fixture' || mode !== 'fake') {
      return json(res, { error: { code: productRead ? 'product-read.scope-not-bound'
        : projectKey !== 'main-topic-answer-fixture' ? 'project.unknown' : 'task.not-found',
      message: 'fixture scope is not bound' } }, productRead ? 409 : 404)
    }
    const taskId = taskRead ? decodeURIComponent(taskRead[1]) : url.searchParams.get('taskId')
    if (taskId && !project.tasks.has(taskId)) {
      return json(res, { error: { code: 'task.not-found', message: 'fixture task missing in selected scope' } }, 404)
    }
    if (url.pathname === '/api/product/relations') return json(res, { relations: [], gaps: [] })
    if (url.pathname === '/api/product/session') return json(res, { messages: [] })
    if (taskRead[2] === 'observation') return json(res, { surface: 'observation', nodes: [], agentFrames: [], handoffs: [] })
    return json(res, { events: [] })
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard'
    && url.search === '?scope=system') {
    return json(res, { scope: { kind: 'system' }, projects: [{
      scope: { kind: 'project', projectKey: 'main-topic-answer-fixture' },
      label: 'main-topic-answer-fixture',
    }] })
  }
  if (req.method === 'GET' && url.pathname === '/api/projects/roster'
    && url.searchParams.size === 1 && url.searchParams.has('projectKey')) {
    if (url.searchParams.get('projectKey') !== 'main-topic-answer-fixture') {
      return json(res, { error: { code: 'project.unknown', message: 'fixture project missing' } }, 404)
    }
    return json(res, { surface: 'project-roster', projectKey: 'main-topic-answer-fixture',
      rosterState: 'not-initialized', members: [] })
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
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    return json(res, { error: { code: 'not-found', message: 'fixture API route missing' } }, 404)
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
const checks = []
const pageErrors = []
const consoleMessages = []
const requestFailures = []
const layoutMetrics = []

function check(name, pass, detail = '') {
  checks.push({ name, pass, ...(detail ? { detail } : {}) })
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

  // Reuse the answer suite's cross-project/user and closed-request cases for
  // tracking reads. A successful empty read must not mask a wrong task scope.
  const beforeTrackingReads = JSON.stringify([...projects].map(([key, value]) =>
    [key, [...value.tasks], value.answers, value.interactions, value.normalChat]))
  const trackingReadChecks = await page.evaluate(async () => {
    const results = []
    const scope = 'projectKey=main-topic-answer-fixture&mode=fake'
    const routes = ['/api/product/relations', '/api/product/session',
      '/api/tasks/task-alpha/observation', '/api/tasks/task-alpha/semantic']
    const read = async (path, query, method = 'GET', selection) => {
      const response = await fetch(`${path}?${query}`, { method,
        ...(selection ? { referrer: `${location.origin}/?${selection}` } : {}) })
      return { status: response.status, body: await response.json() }
    }
    const expect = async (name, path, query, status, code, method, selection) => {
      const actual = await read(path, query, method, selection)
      results.push({ name, pass: actual.status === status
        && (code ? actual.body.error?.code === code : true), actual })
      return actual.body
    }
    for (const path of routes) {
      const product = path.startsWith('/api/product/')
      const query = product ? `${scope}&taskId=task-alpha` : scope
      const body = await expect(`scoped empty GET ${path}`, path, query, 200)
      const collection = path.endsWith('/relations') ? body.relations : path.endsWith('/session')
        ? body.messages : path.endsWith('/observation') ? body.nodes : body.events
      results.push({ name: `no invented execution facts ${path}`, pass: Array.isArray(collection) && collection.length === 0 })
      await expect(`partial scope rejected ${path}`, path, 'projectKey=main-topic-answer-fixture', 400, 'read.scope.invalid')
      await expect(`invalid mode rejected ${path}`, path, 'projectKey=main-topic-answer-fixture&mode=invalid', 400, 'read.scope.invalid')
      await expect(`unbound mode rejected ${path}`, path, query.replace('mode=fake', 'mode=rcc'), product ? 409 : 404,
        product ? 'product-read.scope-not-bound' : 'task.not-found')
      await expect(`unbound project rejected ${path}`, path, query.replace('main-topic-answer-fixture', 'unknown'), product ? 409 : 404,
        product ? 'product-read.scope-not-bound' : 'project.unknown')
      await expect(`missing task rejected ${path}`, product ? path : path.replace('task-alpha', 'missing'),
        product ? `${scope}&taskId=missing` : scope, 404, 'task.not-found')
      for (const selection of ['project=other', 'user=other']) {
        await expect(`cross ${selection} cannot read main task ${path}`, path, query, 404, 'task.not-found', 'GET', selection)
        await expect(`selected ${selection} reads its own task ${path}`,
          product ? path : path.replace('task-alpha', 'task-other'),
          product ? `${scope}&taskId=task-other` : scope, 200, undefined, 'GET', selection)
      }
      for (const method of ['POST', 'PUT', 'DELETE']) {
        await expect(`${method} cannot mutate tracking ${path}`, path, query, 405, 'method.not-allowed', method)
      }
    }
    for (const path of routes.slice(0, 2)) await expect(`project empty GET ${path}`, path, scope, 200)
    await expect('unknown API stays a failure', '/api/unknown', scope, 404, 'not-found')
    await expect('empty session selector rejected', '/api/product/session', `${scope}&sessionId=%20`, 400, 'read.scope.invalid')
    return results
  })
  for (const result of trackingReadChecks) check(result.name, result.pass, JSON.stringify(result.actual ?? ''))
  check('tracking GETs and rejected writes preserve task, answer and chat state', beforeTrackingReads
    === JSON.stringify([...projects].map(([key, value]) =>
      [key, [...value.tasks], value.answers, value.interactions, value.normalChat])))
  await writeFile(join(evidenceRoot, 'tracking-read-checks.json'), JSON.stringify(trackingReadChecks, null, 2))

  // Exercise the public renderer with deliberately reused IDs on the same host.
  // Navigation would discard the DOM and cannot expose cross-scope reuse.
  const updateChecks = await page.evaluate(async () => {
    const { renderMainTopic } = await import('./main-topic.js')
    const host = document.createElement('div')
    document.body.append(host)
    const results = []
    const check = (name, pass) => results.push({ name, pass })
    const question = { turnId: 'shared-question', kind: 'input-request', role: 'jenny',
      text: '旧问题', requestId: 'shared-request', taskId: { scope: 'task', value: 'task-a' },
      expectedRevision: 1, options: ['旧选项'] }
    const status = { turnId: 'status:T', kind: 'status', role: 'jenny', text: '已创建',
      occurredAt: '2026-11-22T10:00:00Z', quote: '旧引用' }
    let projection = { projectKey: 'project-a', workspaceCwd: '/project-a', mode: 'fake',
      agentName: 'Jenny', projectName: 'A', topicName: '主话题', turns: [status, question] }
    let calls = [], release
    const pendingAnswer = (request, answer) => {
      calls.push({ request, answer })
      return new Promise(resolve => { release = resolve })
    }
    const render = (onAnswer = pendingAnswer) => renderMainTopic(host, projection, { onAnswer })
    const input = () => host.querySelector('input')
    const option = () => host.querySelector('[data-answer-option]')
    try {
      render()
      const shell = host.querySelector('.mt-shell'), stream = host.querySelector('.mt-stream')
      const article = host.querySelector('[data-turn-id="status:T"]'), originalInput = input()
      originalInput.value = '保留草稿'
      originalInput.focus()
      projection = { ...projection, turns: [{ ...status, text: '执行工具等待结果', role: 'user',
        kind: 'result', occurredAt: '2026-11-22T11:05:00Z', quote: '新引用' },
      { ...question, text: '新问题', options: ['新选项'], quote: '新问题出处' }] }
      render()
      check('same turn updates body, role, kind, time and quote', article.querySelector('.mt-text').textContent === '执行工具等待结果'
        && article.classList.contains('mt-turn--user') && article.classList.contains('mt-turn--result')
        && article.querySelector('time').textContent.includes('05')
        && article.querySelector('.mt-quote-text').textContent === '新引用')
      check('shell, stream and message remain mounted', host.querySelector('.mt-shell') === shell
        && host.querySelector('.mt-stream') === stream && article.isConnected)
      check('updated question keeps its draft and focus', input() === originalInput
        && input().value === '保留草稿' && document.activeElement === originalInput)
      check('question options update', option()?.textContent === '新选项')
      projection = { ...projection, turns: [...projection.turns].reverse() }
      render()
      check('reordered question keeps input focus and draft', input() === originalInput
        && document.activeElement === originalInput && input().value === '保留草稿')
      projection = { ...projection, turns: [...projection.turns].reverse() }
      render()
      option().click()
      render()
      option().click()
      check('poll preserves submit lock and latest event attributes', calls.length === 1
        && calls[0].answer === '新选项' && calls[0].request.question === '新问题'
        && calls[0].request.sourceQuestion === '新问题出处' && input().disabled)
      release(undefined)
      await new Promise(resolve => setTimeout(resolve, 0))
      check('failed submit keeps draft and allows retry', input().value === '保留草稿' && !input().disabled
        && host.querySelector('.mt-answer-status').dataset.tone === 'danger')
      const answered = []
      render(async (request, answer) => { answered.push({ request, answer }); throw new Error('latest handler') })
      option().click()
      await new Promise(resolve => setTimeout(resolve, 0))
      check('reused controls call latest handler', answered.length === 1)
      for (const [name, change] of [
        ['revision', p => ({ ...p, turns: [p.turns[0], { ...p.turns[1], expectedRevision: 2 }] })],
        ['task', p => ({ ...p, turns: [p.turns[0], { ...p.turns[1], taskId: { scope: 'task', value: 'task-b' } }] })],
        ['task scope', p => ({ ...p, turns: [p.turns[0], { ...p.turns[1], taskId: { ...p.turns[1].taskId, scope: 'another-task-scope' } }] })],
        ['request', p => ({ ...p, turns: [p.turns[0], { ...p.turns[1], requestId: 'request-b' }] })],
        ['project', p => ({ ...p, projectKey: 'project-b' })],
        ['mode', p => ({ ...p, mode: 'rcc' })],
        ['workspace', p => ({ ...p, workspaceCwd: '/project-b' })],
      ]) {
        input().value = `旧 ${name} 草稿`
        const oldInput = input()
        const oldOption = option()
        projection = change(projection)
        render()
        check(`same message ID isolates ${name}`, input() !== oldInput && input().value === '')
        const before = calls.length
        oldOption.click()
        check(`detached ${name} control cannot submit`, calls.length === before)
        option().click()
        const latest = calls.at(-1)
        check(`new ${name} control uses current request`, calls.length === before + 1
          && latest.request.taskId.value === projection.turns[1].taskId.value
          && latest.request.requestId === projection.turns[1].requestId
          && latest.request.expectedRevision === projection.turns[1].expectedRevision)
        release(undefined)
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      input().value = '当前答案'
      option().click()
      const staleRelease = release
      const oldProjection = projection
      projection = { ...projection, projectKey: 'project-c' }
      render()
      staleRelease({ ...oldProjection, turns: [{ turnId: `input-answer:${oldProjection.turns[1].requestId}`,
        kind: 'message', role: 'user', text: '新选项' }] })
      await new Promise(resolve => setTimeout(resolve, 0))
      check('old answer response cannot overwrite a new scope', host.dataset.projectKey === 'project-c' && input()?.value === '')
      projection = { ...projection, turns: [{ ...status, quote: undefined, occurredAt: undefined }] }
      render()
      check('removed quote, time and question controls disappear', !host.querySelector('.mt-quote, time, .mt-answer'))

      // Same task/request identifiers do not identify a question without revision.
      const revisedQuestion = { ...question, expectedRevision: 2 }
      const answerTurn = { turnId: `input-answer:${question.requestId}`, kind: 'message', role: 'user',
        taskId: question.taskId, requestId: question.requestId, expectedRevision: 1, text: '旧选项' }
      projection = { ...projection, turns: [revisedQuestion] }
      for (const [name, revision] of [['old revision', 1], ['missing revision', undefined]]) {
        render(async () => ({ ...projection, turns: [{ ...answerTurn, expectedRevision: revision }] }))
        const currentInput = input()
        currentInput.value = '未提交草稿'
        currentInput.focus()
        option().click()
        await new Promise(resolve => setTimeout(resolve, 0))
        check(`${name} readback cannot acknowledge the current answer`, input() === currentInput
          && !currentInput.disabled && currentInput.value === '未提交草稿'
          && host.querySelector('.mt-answer-status')?.dataset.tone === 'danger')
        projection = { ...projection, turns: [revisedQuestion] }
        render()
      }
      for (const [name, revision] of [['old revision', 1], ['missing revision', undefined]]) {
        projection = { ...projection, turns: [revisedQuestion, { ...answerTurn, expectedRevision: revision }] }
        render()
        check(`${name} history cannot hide the new revision control`, input()?.isConnected === true)
      }
      projection = { ...projection, turns: [{ ...question, expectedRevision: undefined },
        { ...answerTurn, expectedRevision: undefined }] }
      render()
      check('two missing revisions do not prove an answered question', input()?.isConnected === true)
      projection = { ...projection, turns: [revisedQuestion] }
      render(async (request, answer) => ({ ...projection, turns: [revisedQuestion,
        { ...answerTurn, expectedRevision: request.expectedRevision, text: answer }] }))
      option()?.click()
      await new Promise(resolve => setTimeout(resolve, 0))
      check('exact revision readback accepts the answer and removes controls', !input()
        && host.querySelector('[data-turn-id="input-answer:shared-request"] .mt-text')?.textContent === '旧选项')
      projection = { ...projection, turns: [revisedQuestion] }
      render(async (request, answer) => ({ ...projection,
        openInputRequest: { ...request, expectedRevision: 3 },
        turns: [{ ...revisedQuestion, expectedRevision: 3 },
          { ...answerTurn, expectedRevision: request.expectedRevision, text: answer }] }))
      option()?.click()
      await new Promise(resolve => setTimeout(resolve, 0))
      check('exact answer may coexist with a newer open revision', input()?.isConnected === true
        && host.querySelector('.mt-answer-status')?.dataset.tone !== 'danger')
    } finally {
      host.remove()
    }
    return results
  })
  for (const result of updateChecks) check(result.name, result.pass)
  await writeFile(join(evidenceRoot, 'message-update-checks.json'), JSON.stringify(updateChecks, null, 2))

  const alpha = page.locator('[data-turn-id="input-request:request-alpha"]')
  const beta = page.locator('[data-turn-id="input-request:request-beta"]')
  check('two questions render independently', await alpha.count() === 1 && await beta.count() === 1)
  for (const question of [alpha, beta]) {
    check('open question shows that its own task is waiting for the user',
      await question.locator('.mt-turn-kind').innerText() === '等待你的回答'
      && !(await question.innerText()).includes('发出请求等待响应'))
  }

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
  check('option answer quotes its own original question',
    await page.locator('[data-turn-id="input-answer:request-alpha"] .mt-quote-text').innerText()
      === '甲供应商按哪种价格口径比较？')
  check('consumed question no longer renders controls', await alpha.locator('[data-answer-custom="request-alpha"], [data-answer-option]').count() === 0)
  check('option answer keeps the other question open', await beta.locator('[data-answer-custom="request-beta"]').count() === 1)

  await beta.locator('[data-answer-custom="request-beta"]').fill('上海')
  await beta.locator('button.mt-option--custom').click()
  await page.waitForSelector('[data-turn-id="input-answer:request-beta"]')
  check('custom answer uses its own request path and revision', main.answers.length === 2
    && main.answers[1].taskId === 'task-beta' && main.answers[1].requestId === 'request-beta'
    && main.answers[1].body.answer === '上海' && main.answers[1].body.expectedRevision === 7)
  check('custom answer quotes its own original question',
    await page.locator('[data-turn-id="input-answer:request-beta"] .mt-quote-text').innerText()
      === '乙供应商发货到哪个城市？')
  check('controlled readback retains the same tasks after answers',
    main.tasks.size === 2 && [...main.tasks.values()].every((task) =>
      task.state === 'running' && !task.inputRequest && task.consumedInputRequests.length === 1))

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
  check('refresh retains both answers and their original question quotes',
    await page.locator('[data-turn-id="input-answer:request-alpha"] .mt-quote-text').innerText()
      === '甲供应商按哪种价格口径比较？'
    && await page.locator('[data-turn-id="input-answer:request-beta"] .mt-quote-text').innerText()
      === '乙供应商发货到哪个城市？')

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
  // The formal homepage owns conversation scrolling at .page-primary; the
  // inner message stream grows with its content in the new workspace shell.
  const mobileScroll = await page.locator('.page-primary').evaluate((stream) => {
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
      const stream = document.querySelector('.page-primary')
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
  // Persist cleanup even when an unchanged browser assertion throws early.
  await writeFile(join(evidenceRoot, 'cleanup.json'), `${JSON.stringify({ origin,
    browserClosed: !browser.isConnected(), serverListening: server.listening,
    failures, checks, pageErrors, requestFailures,
  }, null, 2)}\n`)
}

await writeFile(join(evidenceRoot, 'main-topic-answer-controlled.json'), `${JSON.stringify({
  surface: 'controlled-browser-regression',
  origin,
  fixture: {
    mode: 'fake',
    projects: ['main', 'other'],
    executionEvidence: 'controlled HTTP state only; no provider execution or final result is simulated or proved',
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
  checks,
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
