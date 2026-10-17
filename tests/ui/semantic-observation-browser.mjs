#!/usr/bin/env node

/**
 * Real-browser proof for the shared semantic observation component.
 *
 * This is a component-level consumer. It serves the source UI directory over a
 * loopback port bound to 0 and drives the public mount/update API through the
 * browser DOM. It does not decode transport, call a runtime API, install a
 * service, or claim the future I1-V composed behavior.
 *
 * Set SEMANTIC_OBSERVATION_EVIDENCE to an execution-owned directory. Successful
 * runs write `checks.json`, raw text observations, and screenshots there.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = resolve(process.env.SEMANTIC_OBSERVATION_UI_ROOT ?? join(repoRoot, 'docs', 'ui'))
const evidenceRoot = process.env.SEMANTIC_OBSERVATION_EVIDENCE?.trim()

if (!evidenceRoot) {
  throw new Error('SEMANTIC_OBSERVATION_EVIDENCE is required; point it at an execution-owned directory')
}

const playwrightModule = await import(
  process.env.SEMANTIC_OBSERVATION_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
)
const playwright = playwrightModule.default ?? playwrightModule

const scope = {
  scopeRef: 'task://task-observation/observation',
  title: '任务处理流水',
  summary: '从任务事实到只读证据的语义观测。',
  breadcrumbs: [
    { scopeRef: 'system://observation', title: '系统概要' },
    { scopeRef: 'project://humanagent/observation', title: 'HumanAgent' },
    { scopeRef: 'task://task-observation/observation', title: '任务处理流水', current: true },
  ],
}

const base = {
  mode: 'current',
  modes: [
    { id: 'current', label: '简洁' },
    { id: 'semantic', label: '语义' },
    { id: 'actions', label: '动作' },
    { id: 'raw', label: '原始' },
  ],
  scope,
  state: 'running',
  stateLabel: '运行中',
  projectionVersion: 'projection-v7',
  summary: [
    { label: '已提交事实', value: '3 条', tone: 'success' },
    { label: '当前活动', value: '1 项', tone: 'warning' },
  ],
  notices: [],
  capabilities: [
    { capability: 'revision-history', state: 'unavailable', reason: 'I1 尚未提供历史查询' },
  ],
  sections: [
    {
      id: 'stable',
      title: '已提交事实',
      kind: 'stable',
      description: '工具结果与 checkpoint 已提交。',
      items: [
        {
          id: 'fact-tool-result',
          title: 'file.search 已返回',
          detail: '在允许的目录中找到 12 个候选文件。',
          kind: 'semantic',
          state: 'completed',
          stateLabel: '已完成',
          tone: 'success',
          meta: ['call-1', '已配对', '09:41:12'],
          evidence: {
            evidenceId: 'evidence-tool-result',
            title: 'file.search 结果证据',
            summary: '只读展示工具返回摘要。',
            scopeLabel: 'task://task-observation',
            sourceLabel: 'runtime projection',
            inputs: ['query=config'],
            outputs: ['12 matching files'],
            refs: ['artifact://search/result-1'],
            raw: {
              label: '原始工具记录（主动查看）',
              content: '{"tool":"file.search","status":"succeeded","count":12}',
            },
          },
        },
      ],
    },
    {
      id: 'live',
      title: '当前活动',
      kind: 'live',
      description: '未收拢活动不冒充完成。',
      items: [
        {
          id: 'live-read',
          title: '正在读取 config.routes',
          detail: '当前活动尚未提交为稳定事实。',
          kind: 'live',
          state: 'active',
          stateLabel: '进行中',
          tone: 'warning',
          meta: ['provider.tool', '未收拢'],
        },
      ],
    },
  ],
}

const fixtures = {
  valid: base,
  stale: {
    ...base,
    state: 'stale',
    stateLabel: '已过期',
    notices: [
      {
        tone: 'stale',
        title: '连接已断开，显示上次内容',
        detail: '最后同步 09:41:15。断开不改变任务终态。',
      },
    ],
  },
  unknown: {
    ...base,
    state: 'unknown',
    stateLabel: '未知',
    notices: [
      {
        tone: 'unknown',
        title: '存在未映射语义',
        detail: '一个事件类型未归类，保持 unknown，不显示成功。',
      },
    ],
    sections: [{
      id: 'unknown',
      title: '未归类',
      kind: 'semantic',
      items: [{
        id: 'unknown-1',
        title: '未映射事件',
        detail: '语义不可用，原始记录未被用来猜测状态。',
        state: 'unknown',
        stateLabel: '未知',
        tone: 'warning',
      }],
    }],
  },
  unavailable: {
    ...base,
    capabilities: [
      { capability: 'revision-history', state: 'unavailable', reason: '尚未提供历史查询' },
      { capability: 'agent-view', state: 'unknown', reason: '真实实例绑定尚未投影' },
    ],
    modes: base.modes.map((mode) => (mode.id === 'semantic'
      ? { ...mode, available: false, reason: '历史查询尚未提供' }
      : mode)),
  },
  empty: {
    ...base,
    mode: 'current',
    state: 'empty',
    stateLabel: '空',
    projectionVersion: 'projection-v0',
    summary: [],
    notices: [{ tone: 'empty', title: '当前范围没有已发布语义内容', detail: '这是空态，不是读取失败。' }],
    sections: [],
  },
  failure: {
    ...base,
    state: 'failed',
    stateLabel: '失败',
    notices: [{
      tone: 'error',
      title: '读取观测投影失败',
      detail: 'runtime.projection.read failed',
      nextAction: '保留旧内容并检查 runtime',
    }],
    sections: [],
  },
  loading: {
    ...base,
    state: 'loading',
    stateLabel: '加载中',
    projectionVersion: '',
    summary: [],
    notices: [{ tone: 'loading', title: '正在读取语义投影', detail: '完成前不使用 raw 内容推断状态。' }],
    sections: [],
  },
  actions: {
    ...base,
    mode: 'actions',
    sections: [{
      id: 'actions',
      title: '实际动作时间线',
      kind: 'action',
      items: [
        { id: 'action-1', title: 'tool.invoke file.search', detail: '实际发生，不改写已执行事实。', state: 'completed', stateLabel: '已发生' },
      ],
    }],
  },
  raw: {
    ...base,
    mode: 'raw',
    sections: [{
      id: 'raw',
      title: '原始记录',
      kind: 'raw',
      description: '仅在主动查看时读取，不驱动语义分类。',
      items: [
        { id: 'raw-1', title: 'record #1', detail: '{"source":"runtime","seq":1}', state: 'observed', stateLabel: '已记录' },
      ],
    }],
  },
}

const harnessHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Semantic observation component proof</title>
  <link rel="stylesheet" href="/runtime.css">
  <link rel="stylesheet" href="/observation.css">
</head>
<body>
  <main class="page">
    <div id="host"></div>
  </main>
  <script type="module">
    import { mountSemanticObservation } from '/semantic-observation.js'
    window.__events = []
    window.__mutations = []
    window.__component = mountSemanticObservation(document.querySelector('#host'), {
      onModeChange(mode, trigger) {
        window.__events.push({ type: 'mode', mode, text: trigger.textContent })
      },
      onScopeRequest(scopeRef, trigger) {
        window.__events.push({ type: 'scope', scopeRef, text: trigger.textContent })
      },
      onEvidenceRequest(evidence, trigger) {
        window.__events.push({ type: 'evidence', evidenceId: evidence.evidenceId, text: trigger.textContent })
        window.__component.openEvidence(evidence, trigger)
      },
    })
    window.__fixtures = ${JSON.stringify(fixtures)}
    window.__component.update(window.__fixtures.valid)
    window.__ready = true
  </script>
</body>
</html>`

function mimeType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'application/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.png': return 'image/png'
    default: return 'application/octet-stream'
  }
}

// --- Real public wiring mode -------------------------------------------------
// A second harness mounts the shared panel against the runtime's public
// GET/SSE envelope (no hand-built projection). It is kept separate from the
// component fixture matrix above so a fixture PASS is never reported as a real
// transport PASS.

const wiredScope = {
  organId: { scope: 'organ', value: 'organ-observation' },
  taskId: { scope: 'task', value: 'task-observation' },
  operationId: { scope: 'operation', value: 'operation-observation-1' },
}

function wiredEvent(id, type, status, summary, occurredAt) {
  return {
    eventId: id,
    sourceId: `source-${id}`,
    type,
    scope: wiredScope,
    occurredAt,
    status,
    summary,
    payloadRef: `asset://${id}`,
    dataDigest: `sha256:${id}`,
    evidenceRefs: [{
      evidenceId: { scope: 'evidence', value: `evidence-${id}` },
      kind: 'operation',
      source: 'runtime',
      locator: `evidence:${id}`,
      scope: wiredScope,
    }],
  }
}

function wiredEnvelope(events) {
  return {
    scope: wiredScope,
    projectionVersion: 'runtime-semantic-v1',
    sourceWatermark: events.length,
    events,
    coverageIssues: [{
      reason: 'correlation-unavailable',
      scope: wiredScope,
      sourceRef: {
        evidenceId: { scope: 'evidence', value: 'evidence-gap' },
        kind: 'execution',
        source: 'runtime',
        locator: 'evidence:gap',
        scope: wiredScope,
      },
    }],
    pairing: [{
      groupId: 'group-operation-1',
      kind: 'operation',
      scope: wiredScope,
      executionEpoch: 1,
      state: 'open',
      eventRefs: [],
    }],
    capabilities: [{ capability: 'runtime-task-events', state: 'available' }],
  }
}

const wiredV1 = wiredEnvelope([
  wiredEvent('event-1', 'task.created', 'completed', '任务已创建', '2026-10-10T09:40:00Z'),
  wiredEvent('event-2', 'plan.proposed', 'active', '正在生成最终答复', '2026-10-10T09:41:00Z'),
])
const wiredV2 = wiredEnvelope([
  ...wiredV1.events,
  wiredEvent('event-3', 'operation.completed', 'completed', '最终答复已提交', '2026-10-10T09:42:00Z'),
])

function panelHtml(taskId, prelude = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Semantic observation panel proof</title>
  <link rel="stylesheet" href="/runtime.css">
  <link rel="stylesheet" href="/observation.css">
</head>
<body>
  <main class="page">
    <div id="host"></div>
  </main>
  <script type="module">
    import { mountSemanticObservationPanel } from '/runtime-shell.js'
    ${prelude}
    window.__panel = mountSemanticObservationPanel(document.querySelector('#host'), { taskId: ${JSON.stringify(taskId)} })
    window.__panelReady = true
  </script>
</body>
</html>`
}

const wiredHtml = panelHtml('task-observation')

// The shared wired fixture is the only source of the real scope ids, version,
// capability and reference values, so the human-readable joint assertion below
// reads them from the fixture instead of repeating illustrative constants.
const wiredFirstEvent = wiredV1.events[0]
const wiredEvidenceRefs = {
  eventId: wiredFirstEvent.eventId,
  payloadRef: wiredFirstEvent.payloadRef,
  evidenceLocator: wiredFirstEvent.evidenceRefs[0].locator,
}
const wiredTechnicalTokens = [
  wiredScope.organId.value,
  wiredScope.taskId.value,
  wiredScope.operationId.value,
  wiredV1.projectionVersion,
  wiredV1.capabilities[0].capability,
  wiredV1.capabilities[0].state,
  wiredV2.events.at(-1).type,
]

// The adapter matrix drives the real read-only projection function, not the
// component: a fixture that hands the component an already-correct view model
// cannot prove that typed pairing states survive the transport adapter.
const adapterHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Semantic observation adapter proof</title>
  <link rel="stylesheet" href="/runtime.css">
  <link rel="stylesheet" href="/observation.css">
</head>
<body>
  <main class="page">
    <div id="host"></div>
  </main>
  <script type="module">
    import { buildSemanticObservationProjection } from '/runtime-shell.js'
    window.__project = (envelope) => buildSemanticObservationProjection(envelope)
    window.__adapterReady = true
  </script>
</body>
</html>`

// --- typed-state, drill-down and transport harnesses -------------------------

const adapterScope = {
  organId: { scope: 'organ', value: 'organ-adapter' },
  taskId: { scope: 'task', value: 'task-adapter' },
  operationId: { scope: 'operation', value: 'operation-adapter' },
}

function adapterGroup(state, groupId = `group-${state}`) {
  return { groupId, kind: 'operation', scope: adapterScope, executionEpoch: 1, state, eventRefs: [] }
}

function adapterEvent(id, eventScope, summary, status = 'completed') {
  return {
    eventId: id,
    sourceId: `source-${id}`,
    type: 'task.created',
    scope: eventScope,
    occurredAt: '2026-10-10T09:40:00Z',
    status,
    summary,
    evidenceRefs: [],
  }
}

function adapterEnvelope(pairing, coverageIssues = []) {
  return {
    scope: adapterScope,
    projectionVersion: 'runtime-semantic-v1',
    sourceWatermark: 1,
    events: [adapterEvent('event-adapter-1', adapterScope, '任务已创建')],
    coverageIssues,
    pairing,
    capabilities: [],
  }
}

const adapterStateMatrix = {
  open: ['running', '进行中'],
  closed: ['completed', '已收拢'],
  waiting: ['waiting', '等待中'],
  blocked: ['blocked', '受阻'],
  cancelled: ['cancelled', '已取消'],
  unknown: ['unknown', '未知'],
  unavailable: ['unavailable', '不可用'],
}

const stateScope = {
  organId: { scope: 'organ', value: 'organ-state' },
  taskId: { scope: 'task', value: 'task-state' },
  operationId: { scope: 'operation', value: 'operation-state' },
}
// The closed operation group makes the envelope terminal (no SSE subscription);
// the blocked invocation group is the state under test.
const stateEnvelope = {
  scope: stateScope,
  projectionVersion: 'runtime-semantic-v1',
  sourceWatermark: 2,
  events: [adapterEvent('event-state-1', stateScope, '任务已创建')],
  coverageIssues: [],
  pairing: [
    { groupId: 'group-state-operation', kind: 'operation', scope: stateScope, executionEpoch: 1, state: 'closed', eventRefs: [] },
    { groupId: 'group-state-invocation', kind: 'invocation', scope: stateScope, executionEpoch: 1, state: 'blocked', eventRefs: [] },
  ],
  capabilities: [],
}

const drillScope = {
  organId: { scope: 'organ', value: 'organ-drill' },
  taskId: { scope: 'task', value: 'task-drill' },
  operationId: { scope: 'operation', value: 'operation-drill' },
}
const drillEnvelope = {
  scope: drillScope,
  projectionVersion: 'runtime-semantic-v1',
  sourceWatermark: 3,
  events: [
    adapterEvent('event-organ', { organId: drillScope.organId }, '组织级事实'),
    adapterEvent('event-task', { organId: drillScope.organId, taskId: drillScope.taskId }, '任务级事实'),
    adapterEvent('event-operation', drillScope, '操作级事实'),
  ],
  coverageIssues: [],
  pairing: [
    { groupId: 'group-drill-operation', kind: 'operation', scope: drillScope, executionEpoch: 1, state: 'closed', eventRefs: [] },
  ],
  capabilities: [],
}

const transportScope = {
  organId: { scope: 'organ', value: 'organ-transport' },
  taskId: { scope: 'task', value: 'task-transport' },
  operationId: { scope: 'operation', value: 'operation-transport' },
}
const transportV1 = {
  scope: transportScope,
  projectionVersion: 'runtime-semantic-v1',
  sourceWatermark: 1,
  events: [adapterEvent('event-transport-1', transportScope, '任务已创建')],
  coverageIssues: [],
  pairing: [
    { groupId: 'group-transport-operation', kind: 'operation', scope: transportScope, executionEpoch: 1, state: 'open', eventRefs: [] },
  ],
  capabilities: [],
}

const openScope = {
  organId: { scope: 'organ', value: 'organ-open' },
  taskId: { scope: 'task', value: 'task-open' },
  operationId: { scope: 'operation', value: 'operation-open' },
}
const openV1 = {
  scope: openScope,
  projectionVersion: 'runtime-semantic-v1',
  sourceWatermark: 1,
  events: [adapterEvent('event-open-1', openScope, '任务已创建')],
  coverageIssues: [],
  pairing: [
    { groupId: 'group-open-operation', kind: 'operation', scope: openScope, executionEpoch: 1, state: 'open', eventRefs: [] },
  ],
  capabilities: [],
}
const openV2 = {
  ...openV1,
  sourceWatermark: 2,
  events: [...openV1.events, adapterEvent('event-open-2', openScope, '最终答复已提交')],
}

// A deterministic EventSource stand-in: the transport primitive is browser-owned,
// so the adapter's reconnect/no-data handling is driven exactly instead of racing
// a real reconnect timer.
const fakeEventSourcePrelude = `
    window.__fake = { instances: [] }
    class FakeEventSource {
      constructor(url) {
        this.url = url
        this.closed = false
        this.listeners = {}
        window.__fake.instances.push(this)
      }
      addEventListener(type, listener) {
        this.listeners[type] = this.listeners[type] || []
        this.listeners[type].push(listener)
      }
      close() { this.closed = true }
      fireOpen() { if (typeof this.onopen === 'function') this.onopen() }
      fireError() { if (typeof this.onerror === 'function') this.onerror() }
      emit(data) {
        for (const listener of this.listeners['semantic.observation'] || []) listener({ data })
      }
    }
    window.EventSource = FakeEventSource
`

// The UI is served through Playwright request interception against a synthetic
// origin. This needs no listening socket, so the proof runs in a restricted
// sandbox without claiming a shared port.
const proofOrigin = 'http://semantic-observation.test'

let sseServed = 0
let transportReads = 0
let transportStreams = 0
let openReads = 0
async function serveUi(page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/tasks/task-observation/semantic') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(wiredV1) })
      return
    }
    if (url.pathname === '/api/tasks/task-observation/semantic/stream') {
      sseServed += 1
      if (sseServed === 1) {
        const body = `id: semantic-${wiredV2.sourceWatermark}\nevent: semantic.observation\ndata: ${JSON.stringify(wiredV2)}\n\n`
        await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body })
      } else {
        await route.fulfill({ status: 500, body: 'closed' })
      }
      return
    }
    if (url.pathname === '/api/tasks/task-state/semantic') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(stateEnvelope) })
      return
    }
    if (url.pathname === '/api/tasks/task-drill/semantic') {
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(drillEnvelope) })
      return
    }
    if (url.pathname === '/api/tasks/task-transport/semantic') {
      transportReads += 1
      if (transportReads === 1) {
        await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(transportV1) })
      } else {
        await route.fulfill({
          status: 503,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            error: {
              code: 'runtime.projection.read.failed',
              message: 'reload rejected by runtime',
              ownerId: 'humanagent.app',
              nextAction: 'retry the read',
            },
          }),
        })
      }
      return
    }
    if (url.pathname === '/api/tasks/task-transport/semantic/stream') {
      transportStreams += 1
      if (transportStreams === 1) {
        await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: 'event: semantic.observation\ndata: {not-json\n\n' })
      } else {
        await route.fulfill({ status: 500, body: 'closed' })
      }
      return
    }
    if (url.pathname === '/api/tasks/task-open/semantic') {
      openReads += 1
      if (openReads === 1) {
        await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(openV1) })
      } else {
        await route.fulfill({ status: 500, body: 'closed' })
      }
      return
    }
    if (url.pathname === '/' || url.pathname === '/proof.html') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: harnessHtml })
      return
    }
    if (url.pathname === '/adapter.html') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: adapterHtml })
      return
    }
    for (const [path, body] of [
      ['/wired.html', wiredHtml],
      ['/wired-state.html', panelHtml('task-state')],
      ['/wired-drill.html', panelHtml('task-drill')],
      ['/wired-transport.html', panelHtml('task-transport')],
      ['/wired-open.html', panelHtml('task-open', fakeEventSourcePrelude)],
    ]) {
      if (url.pathname === path) {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body })
        return
      }
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!relative || relative.split('/').includes('..')) {
      await route.fulfill({ status: 400, body: 'bad path' })
      return
    }
    const filePath = resolve(uiRoot, relative)
    if (!filePath.startsWith(`${uiRoot}${sep}`)) {
      await route.fulfill({ status: 403, body: 'forbidden' })
      return
    }
    try {
      const body = await readFile(filePath)
      await route.fulfill({ status: 200, contentType: mimeType(filePath), body })
    } catch {
      await route.fulfill({ status: 404, body: 'not found' })
    }
  })
}

const checks = []
let failures = 0
const observations = []

function record(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail })
  if (!pass) failures += 1
}

function observe(name, value) {
  observations.push({ name, value })
}

// A missing UI state must be reported as a failed check with the observed DOM,
// not abort the whole proof run before the remaining checks execute.
async function waitForCondition(page, predicate, timeout = 15_000) {
  try {
    await page.waitForFunction(predicate, undefined, { timeout })
    return true
  } catch {
    return false
  }
}

await mkdir(join(evidenceRoot, 'artifacts'), { recursive: true })

// Constrained execution sandboxes can deny Chromium's bootstrap mach port.
// `--single-process --no-zygote` keeps the proof runnable without a host
// service; override with SEMANTIC_OBSERVATION_BROWSER_ARGS when needed.
const launchArgs = (process.env.SEMANTIC_OBSERVATION_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const browser = await playwright.chromium.launch({ headless: true, args: launchArgs })

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await serveUi(page)

  await page.goto(`${proofOrigin}/proof.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 15_000 })

  const initial = await page.evaluate(() => {
    const root = document.querySelector('.semantic-observation')
    return {
      mounted: Boolean(root),
      contract: root?.dataset.contractVersion ?? '',
      mode: root?.dataset.mode ?? '',
      sections: [...document.querySelectorAll('.so-section')].map((section) => ({
        kind: section.dataset.sectionKind,
        text: section.innerText,
      })),
      modes: [...document.querySelectorAll('.so-mode')].map((button) => ({
        id: button.dataset.semanticMode,
        pressed: button.getAttribute('aria-pressed'),
        disabled: button.disabled,
      })),
      bodies: document.body.innerText,
      forbiddenControls: document.querySelectorAll('[data-action="retry"], [data-action="stop"], [data-action="steer"]').length,
      mutationCallbacks: window.__mutations.length,
    }
  })
  observe('initial', initial)
  record('component mounts with the shared contract marker', initial.mounted && initial.contract === 'semantic-observation-view@1', initial)
  record('stable semantic facts and live current activity stay separate', initial.sections.some((section) => section.kind === 'stable' && section.text.includes('已提交事实') && section.text.includes('file.search 已返回')) && initial.sections.some((section) => section.kind === 'live' && section.text.includes('当前活动') && section.text.includes('正在读取 config.routes')), initial.sections)
  record('the component offers only the four read-only display modes', initial.modes.map((mode) => mode.id).join(',') === 'current,semantic,actions,raw', initial.modes)
  record('current is the initial active display mode', initial.modes.find((mode) => mode.id === 'current')?.pressed === 'true')
  record('no mutation controls are rendered', initial.forbiddenControls === 0 && initial.mutationCallbacks === 0, initial)

  await page.screenshot({ path: join(evidenceRoot, 'artifacts', 'valid-current.png'), fullPage: true })

  // Actions and raw are view selections only. The fixture update happens in
  // this proof harness, not inside the component, and the component emits only
  // a typed mode intent.
  await page.click('.so-mode[data-semantic-mode="actions"]')
  await page.evaluate(() => window.__component.update(window.__fixtures.actions))
  const actions = await page.evaluate(() => ({
    mode: document.querySelector('.semantic-observation')?.dataset.mode,
    text: document.querySelector('.so-section[data-section-kind="action"]')?.innerText ?? '',
    events: window.__events.slice(),
    mutationCallbacks: window.__mutations.length,
    controls: document.querySelectorAll('button[data-action="retry"], button[data-action="stop"], button[data-action="steer"]').length,
  }))
  observe('actions', actions)
  record('actions mode renders the actual-action timeline without domain mutation', actions.mode === 'actions' && actions.text.includes('实际动作时间线') && actions.text.includes('tool.invoke file.search') && actions.controls === 0 && actions.mutationCallbacks === 0, actions)
  record('actions mode emits only a read-only mode intent', actions.events.some((event) => event.type === 'mode' && event.mode === 'actions'), actions.events)

  await page.click('.so-mode[data-semantic-mode="raw"]')
  await page.evaluate(() => window.__component.update(window.__fixtures.raw))
  const raw = await page.evaluate(() => ({
    mode: document.querySelector('.semantic-observation')?.dataset.mode,
    text: document.querySelector('.so-section[data-section-kind="raw"]')?.innerText ?? '',
    mutationCallbacks: window.__mutations.length,
  }))
  observe('raw', raw)
  record('raw mode renders the explicit raw ledger separately', raw.mode === 'raw' && raw.text.includes('原始记录') && raw.text.includes('不驱动语义分类') && raw.mutationCallbacks === 0, raw)

  // Drawer open, raw evidence remains behind the explicit action, close returns
  // focus to the initiating evidence button.
  await page.click('.so-mode[data-semantic-mode="current"]')
  await page.evaluate(() => window.__component.update(window.__fixtures.valid))
  const evidenceTrigger = page.locator('.so-evidence').first()
  await evidenceTrigger.focus()
  await page.keyboard.press('Enter')
  const drawerOpen = await page.evaluate(() => {
    const dialog = document.querySelector('.so-drawer')
    return {
      open: Boolean(dialog?.open),
      text: dialog?.innerText ?? '',
      active: document.activeElement?.className ?? '',
    }
  })
  observe('drawer-open', drawerOpen)
  record('evidence drawer opens as a read-only dialog', drawerOpen.open && drawerOpen.text.includes('只读证据') && drawerOpen.text.includes('file.search 结果证据'), drawerOpen)
  record('raw evidence content is only inside the active drawer', drawerOpen.text.includes('原始工具记录') && drawerOpen.active.includes('so-drawer-close'), drawerOpen)
  await page.screenshot({ path: join(evidenceRoot, 'artifacts', 'evidence-drawer.png'), fullPage: true })
  await page.keyboard.press('Escape')
  const drawerClosed = await page.evaluate(() => ({
    open: Boolean(document.querySelector('.so-drawer')?.open),
    activeText: document.activeElement?.textContent ?? '',
    activeClass: document.activeElement?.className ?? '',
    activeTag: document.activeElement?.tagName ?? '',
  }))
  observe('drawer-closed', drawerClosed)
  record('Escape closes the drawer and returns focus to the evidence trigger', drawerClosed.open === false && drawerClosed.activeText.includes('查看只读证据') && drawerClosed.activeClass.includes('so-evidence'), drawerClosed)

  // Keyboard mode selection with visible focus.
  const focusAfterCloseFrames = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      tag: document.activeElement?.tagName ?? '',
      className: document.activeElement?.className ?? '',
      text: document.activeElement?.textContent ?? '',
    })))
  }))
  const focusBefore = await page.evaluate(() => {
    const target = document.querySelector('.so-mode[data-semantic-mode="semantic"]')
    const root = document.querySelector('.semantic-observation')
    return {
      fixtureMode: window.__fixtures.valid.mode,
      fixtureSemanticAvailable: window.__fixtures.valid.modes.find((mode) => mode.id === 'semantic')?.available !== false,
      componentMode: root?.dataset.mode ?? '',
      target: target ? {
        exists: true,
        disabled: target.disabled,
        connected: target.isConnected,
        rect: (() => {
          const rect = target.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        })(),
      } : { exists: false },
    }
  })
  const keyboardFocusPath = []
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Shift+Tab')
    keyboardFocusPath.push(await page.evaluate(() => ({
      mode: document.activeElement?.dataset?.semanticMode ?? '',
      tag: document.activeElement?.tagName ?? '',
      className: document.activeElement?.className ?? '',
      disabled: document.activeElement instanceof HTMLButtonElement ? document.activeElement.disabled : null,
    })))
  }
  const focusVisible = await page.evaluate(() => {
    const active = document.activeElement
    const target = document.querySelector('.so-mode[data-semantic-mode="semantic"]')
    const style = getComputedStyle(active)
    return {
      mode: active?.dataset?.semanticMode ?? '',
      activeTag: active?.tagName ?? '',
      activeClass: active?.className ?? '',
      activeDisabled: active instanceof HTMLButtonElement ? active.disabled : null,
      targetExists: target instanceof HTMLButtonElement,
      targetDisabled: target instanceof HTMLButtonElement ? target.disabled : null,
      targetConnected: target?.isConnected ?? false,
      targetIsActive: active === target,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  const focusFrames = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve({
          mode: document.activeElement?.dataset?.semanticMode ?? '',
          activeTag: document.activeElement?.tagName ?? '',
          activeClass: document.activeElement?.className ?? '',
          targetIsActive: document.activeElement === document.querySelector('.so-mode[data-semantic-mode="semantic"]'),
          targetDisabled: document.querySelector('.so-mode[data-semantic-mode="semantic"]')?.disabled ?? null,
        })
      })
    })
  }))
  const focusDiagnostic = { before: focusBefore, afterCloseFrames: focusAfterCloseFrames, keyboardFocusPath, immediate: focusVisible, afterTwoFrames: focusFrames }
  observe('keyboard-focus-diagnostic', focusDiagnostic)
  await writeFile(join(evidenceRoot, 'keyboard-focus-diagnostic.json'), JSON.stringify(focusDiagnostic, null, 2), 'utf8')
  observe('keyboard-focus', focusVisible)
  record('keyboard focus reaches display controls with a visible focus outline', focusVisible.mode === 'semantic' && focusVisible.targetIsActive && focusVisible.targetDisabled === false && focusVisible.outlineStyle !== 'none' && Number.parseFloat(focusVisible.outlineWidth) >= 2, focusVisible)

  // Recursive scope navigation and breadcrumb return.
  await page.click('.so-crumb[data-scope-ref="project://humanagent/observation"]')
  const scopeEvents = await page.evaluate(() => window.__events.filter((event) => event.type === 'scope'))
  observe('scope-events', scopeEvents)
  record('scope controls emit the selected recursive scope without changing domain refs', scopeEvents.some((event) => event.scopeRef === 'project://humanagent/observation'), scopeEvents)
  const nested = await page.evaluate(() => {
    window.__component.update({
      ...window.__fixtures.valid,
      scope: {
        ...window.__fixtures.valid.scope,
        scopeRef: 'project://humanagent/observation',
        title: 'HumanAgent 项目观测',
        breadcrumbs: [
          { scopeRef: 'system://observation', title: '系统概要' },
          { scopeRef: 'project://humanagent/observation', title: 'HumanAgent', current: true },
        ],
      },
    })
    return {
      crumbs: [...document.querySelectorAll('.so-crumb')].map((crumb) => ({
        text: crumb.textContent,
        ref: crumb.dataset.scopeRef ?? '',
        current: crumb.getAttribute('aria-current'),
      })),
    }
  })
  observe('nested-scope', nested)
  record('the same component renders a nested scope with a current breadcrumb', nested.crumbs.some((crumb) => crumb.ref === 'system://observation' && crumb.current === null) && nested.crumbs.some((crumb) => crumb.ref === 'project://humanagent/observation' && crumb.current === 'page'), nested.crumbs)
  await page.click('.so-crumb[data-scope-ref="system://observation"]')
  const returnEvent = await page.evaluate(() => window.__events.filter((event) => event.type === 'scope').at(-1))
  observe('scope-return', returnEvent)
  record('breadcrumb return emits the root scope request', returnEvent?.scopeRef === 'system://observation', returnEvent)

  // Without an explicit current crumb the deepest scope stays the default; with
  // one, only that crumb is current (F07).
  const defaulted = await page.evaluate(() => {
    window.__component.update({
      ...window.__fixtures.valid,
      scope: {
        ...window.__fixtures.valid.scope,
        breadcrumbs: window.__fixtures.valid.scope.breadcrumbs.map((crumb) => ({ ...crumb, current: false })),
      },
    })
    return {
      crumbs: [...document.querySelectorAll('.so-crumb')].map((crumb) => ({
        ref: crumb.dataset.scopeRef ?? '',
        current: crumb.getAttribute('aria-current'),
        tag: crumb.tagName,
      })),
      currentCount: document.querySelectorAll('.so-crumb[aria-current="page"]').length,
    }
  })
  observe('defaulted-scope', defaulted)
  record('without an explicit current crumb the deepest scope is the single default', defaulted.currentCount === 1
    && defaulted.crumbs.find((crumb) => crumb.ref === 'task://task-observation/observation')?.current === 'page'
    && defaulted.crumbs.find((crumb) => crumb.ref === 'task://task-observation/observation')?.tag === 'SPAN'
    && defaulted.crumbs.filter((crumb) => crumb.tag === 'BUTTON').length === 2, defaulted)

  // Reachable boundary states.
  for (const [fixture, expectation] of [
    ['stale', '连接已断开，显示上次内容'],
    ['unknown', '存在未映射语义'],
    ['unavailable', 'revision-history'],
    ['empty', '没有可展示的观测内容'],
    ['failure', '读取观测投影失败'],
    ['loading', '正在读取语义投影'],
  ]) {
    await page.evaluate((name) => window.__component.update(window.__fixtures[name]), fixture)
    const state = await page.evaluate(() => ({
      rootState: document.querySelector('.semantic-observation')?.dataset.state ?? '',
      text: document.body.innerText,
      notices: [...document.querySelectorAll('.so-notice')].map((notice) => notice.dataset.noticeKind),
      disabledModes: [...document.querySelectorAll('.so-mode:disabled')].map((button) => button.dataset.semanticMode),
      mutationCallbacks: window.__mutations.length,
    }))
    observe(`state-${fixture}`, state)
    record(`${fixture} state is explicit and mutation-free`, state.text.includes(expectation) && state.mutationCallbacks === 0, state)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.__component.update(window.__fixtures.valid))
  const narrow = await page.evaluate(() => {
    const root = document.querySelector('.semantic-observation')
    const rect = root?.getBoundingClientRect()
    return {
      width: rect?.width ?? 0,
      viewport: window.innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      modeWidth: document.querySelector('.so-modebar')?.getBoundingClientRect().width ?? 0,
    }
  })
  observe('narrow', narrow)
  record('narrow viewport keeps the component within the viewport', narrow.width > 0 && narrow.width <= narrow.viewport && narrow.horizontalOverflow === false, narrow)
  await page.screenshot({ path: join(evidenceRoot, 'artifacts', 'narrow.png'), fullPage: true })

  if (process.env.SEMANTIC_OBSERVATION_COMPONENT_ONLY !== '1') {
  // --- real public wiring: the shared panel consumes the A GET/SSE envelope ---
  const wiredPage = await context.newPage()
  const wiredErrors = []
  wiredPage.on('pageerror', (error) => wiredErrors.push(error.message))
  const requests = { semantic: 0, stream: 0, mutations: 0 }
  wiredPage.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith('/semantic')) requests.semantic += 1
    else if (path.endsWith('/semantic/stream')) requests.stream += 1
    if (request.method() !== 'GET') requests.mutations += 1
  })
  await serveUi(wiredPage)
  await wiredPage.goto(`${proofOrigin}/wired.html`, { waitUntil: 'domcontentloaded' })
  await wiredPage.waitForFunction(() => window.__panelReady === true, undefined, { timeout: 15_000 })
  await wiredPage.waitForFunction(() => document.body.innerText.includes('任务已创建'), undefined, { timeout: 15_000 })
  const wiredInitial = await wiredPage.evaluate(() => ({
    mounted: Boolean(document.querySelector('.semantic-observation')),
    contract: document.querySelector('.semantic-observation')?.dataset.contractVersion ?? '',
    text: document.body.innerText,
    modes: [...document.querySelectorAll('.so-mode')].map((button) => button.dataset.semanticMode),
    controls: document.querySelectorAll('[data-action="retry"], [data-action="stop"], form').length,
  }))
  observe('wired-initial', wiredInitial)
  record('wired panel mounts the shared component for the real task scope', wiredInitial.mounted && wiredInitial.contract === 'semantic-observation-view@1' && wiredInitial.text.includes('语义观测'), wiredInitial)
  record('wired current mode separates committed fact from live activity', wiredInitial.text.includes('已提交事实') && wiredInitial.text.includes('任务已创建') && wiredInitial.text.includes('当前活动') && wiredInitial.text.includes('正在生成最终答复'), wiredInitial.text)
  record('wired panel renders only the four read-only modes', wiredInitial.modes.join(',') === 'current,semantic,actions,raw', wiredInitial.modes)
  record('wired panel surfaces partial coverage from the envelope', wiredInitial.text.includes('覆盖不完整'), wiredInitial.text)

  // SSE revision is decoded once and applied without a second GET.
  await wiredPage.waitForFunction(() => document.body.innerText.includes('最终答复已提交'), undefined, { timeout: 15_000 })
  record('wired SSE revision updates the panel from the live envelope', true)
  record('wired decode happens once per transport (one plain GET)', requests.semantic === 1, requests)

  // Connection loss is explicit and keeps content.
  await wiredPage.waitForFunction(() => document.body.innerText.includes('实时连接已断开'), undefined, { timeout: 15_000 })
  const wiredStale = await wiredPage.evaluate(() => document.body.innerText)
  record('wired dropped stream is explicit stale, not a silent success', wiredStale.includes('实时连接已断开') && wiredStale.includes('最终答复已提交'))

  // Mode switch re-projects the decoded envelope (no refetch, no mutation).
  await wiredPage.click('.so-mode[data-semantic-mode="actions"]')
  const wiredActions = await wiredPage.evaluate(() => ({
    mode: document.querySelector('.semantic-observation')?.dataset.mode,
    text: document.body.innerText,
  }))
  record('wired actions mode renders the actual-action timeline', wiredActions.mode === 'actions' && wiredActions.text.includes('实际动作时间线'), wiredActions)
  record('wired mode switch does not refetch or mutate', requests.semantic === 1 && requests.mutations === 0, requests)

  await wiredPage.click('.so-mode[data-semantic-mode="raw"]')
  const wiredRaw = await wiredPage.evaluate(() => document.body.innerText)
  record('wired raw mode renders the explicit raw ledger', wiredRaw.includes('原始记录') && wiredRaw.includes('operation.completed'), wiredRaw)

  // Scope drill-down filters the single decoded envelope.
  await wiredPage.click('.so-mode[data-semantic-mode="current"]')
  const wiredCrumbs = await wiredPage.evaluate(() => [...document.querySelectorAll('.so-crumb')].map((crumb) => ({ text: crumb.textContent, ref: crumb.dataset.scopeRef })))
  observe('wired-crumbs', wiredCrumbs)
  record('wired scope controls expose organ/task/operation breadcrumbs', wiredCrumbs.some((crumb) => crumb.ref === 'organ:organ-observation') && wiredCrumbs.some((crumb) => crumb.ref === 'task:task-observation') && wiredCrumbs.some((crumb) => crumb.ref === 'operation:operation-observation-1'), wiredCrumbs)
  const wiredOrganCrumb = wiredPage.locator('.so-crumb[data-scope-ref="organ:organ-observation"]')
  await wiredOrganCrumb.focus()
  await wiredPage.keyboard.press('Enter')
  const wiredEnterFocus = await wiredPage.evaluate(() => ({
    activeRef: document.activeElement?.dataset?.scopeRef ?? '',
    activeCurrent: document.activeElement?.getAttribute('aria-current') ?? '',
    activeClass: document.activeElement?.className ?? '',
    activeText: document.activeElement?.textContent ?? '',
  }))
  observe('wired-breadcrumb-enter-focus', wiredEnterFocus)
  record('keyboard Enter on a breadcrumb focuses the new current scope', wiredEnterFocus.activeRef === 'organ:organ-observation' && wiredEnterFocus.activeCurrent === 'page' && wiredEnterFocus.activeClass.includes('so-crumb') && wiredEnterFocus.activeText.includes('所属器官'), wiredEnterFocus)
  await wiredPage.locator('.so-crumb[data-scope-ref="operation:operation-observation-1"]').focus()
  await wiredPage.keyboard.press('Space')
  const wiredSpaceFocus = await wiredPage.evaluate(() => ({
    activeRef: document.activeElement?.dataset?.scopeRef ?? '',
    activeCurrent: document.activeElement?.getAttribute('aria-current') ?? '',
    activeClass: document.activeElement?.className ?? '',
    activeText: document.activeElement?.textContent ?? '',
  }))
  observe('wired-breadcrumb-space-focus', wiredSpaceFocus)
  record('keyboard Space on a breadcrumb focuses the new current scope', wiredSpaceFocus.activeRef === 'operation:operation-observation-1' && wiredSpaceFocus.activeCurrent === 'page' && wiredSpaceFocus.activeClass.includes('so-crumb') && wiredSpaceFocus.activeText.includes('当前操作'), wiredSpaceFocus)
  await wiredOrganCrumb.focus()
  await wiredPage.keyboard.press('Enter')
  const wiredDrill = await wiredPage.evaluate(() => document.body.innerText)
  record('wired breadcrumb drill-down keeps the read-only observation', wiredDrill.includes('语义观测') && requests.semantic === 1)

  // Default business text stays human-readable in all three non-raw modes; the
  // original ids, version and references remain readable in raw and evidence.
  const readContentText = () => wiredPage.evaluate(() => document.querySelector('.so-content')?.innerText ?? '')
  const wiredCurrentText = await readContentText()
  await wiredPage.click('.so-mode[data-semantic-mode="semantic"]')
  const wiredSemanticText = await readContentText()
  await wiredPage.click('.so-mode[data-semantic-mode="actions"]')
  const wiredActionsText = await readContentText()
  await wiredPage.click('.so-mode[data-semantic-mode="raw"]')
  const wiredRawText = await readContentText()
  await wiredPage.click('.so-mode[data-semantic-mode="current"]')

  // Evidence drawer is read-only.
  await wiredPage.locator('.so-evidence').first().click()
  const wiredDrawer = await wiredPage.evaluate(() => {
    const dialog = document.querySelector('.so-drawer')
    return { open: Boolean(dialog?.open), text: dialog?.innerText ?? '', active: document.activeElement?.className ?? '' }
  })
  record('wired evidence drawer opens read-only and focuses its close control', wiredDrawer.open && wiredDrawer.text.includes('只读证据') && wiredDrawer.active.includes('so-drawer-close'), wiredDrawer)
  record('wired default modes are human-readable and raw evidence stays traceable',
    [wiredCurrentText, wiredSemanticText, wiredActionsText].every((body) =>
      !wiredTechnicalTokens.some((token) => body.includes(token)))
      && wiredCurrentText.includes('当前操作')
      && wiredCurrentText.includes('所属器官')
      && wiredCurrentText.includes('当前任务')
      && wiredCurrentText.includes('任务事件记录')
      && wiredCurrentText.includes('可用')
      && wiredCurrentText.includes('覆盖不完整')
      && wiredTechnicalTokens.every((token) => wiredRawText.includes(token))
      && wiredDrawer.text.includes(wiredEvidenceRefs.eventId)
      && wiredDrawer.text.includes(wiredEvidenceRefs.payloadRef)
      && wiredDrawer.text.includes(wiredEvidenceRefs.evidenceLocator),
    { currentText: wiredCurrentText, semanticText: wiredSemanticText, actionsText: wiredActionsText, rawText: wiredRawText, drawerText: wiredDrawer.text })
  await wiredPage.keyboard.press('Escape')

  record('wired panel exposes no executable control and issues no mutation request', wiredInitial.controls === 0 && requests.mutations === 0, { controls: wiredInitial.controls, requests })
  record('wired page raised no errors', wiredErrors.length === 0, wiredErrors)

  await wiredPage.screenshot({ path: join(evidenceRoot, 'artifacts', 'wired-current.png'), fullPage: true })
  await wiredPage.close()

  // --- typed pairing states survive the adapter (F02) ------------------------
  const adapterPage = await context.newPage()
  const adapterErrors = []
  adapterPage.on('pageerror', (error) => adapterErrors.push(error.message))
  await serveUi(adapterPage)
  await adapterPage.goto(`${proofOrigin}/adapter.html`, { waitUntil: 'domcontentloaded' })
  await waitForCondition(adapterPage, () => window.__adapterReady === true)

  const projectAdapter = (envelope) => adapterPage.evaluate((input) => {
    const projection = window.__project(input)
    return {
      state: projection.state,
      stateLabel: projection.stateLabel,
      summary: projection.summary.map((entry) => `${entry.label}:${entry.value}`),
      notices: projection.notices.map((notice) => notice.title),
    }
  }, envelope)

  const adapterMatrix = {}
  for (const [pairingState, expectation] of Object.entries(adapterStateMatrix)) {
    const got = await projectAdapter(adapterEnvelope([adapterGroup(pairingState)]))
    adapterMatrix[pairingState] = got
    record(`adapter keeps typed pairing state ${pairingState} as ${expectation[0]}`, got.state === expectation[0] && got.stateLabel === expectation[1], got)
  }
  observe('adapter-state-matrix', adapterMatrix)

  const mixed = await projectAdapter(adapterEnvelope([adapterGroup('closed', 'group-closed'), adapterGroup('waiting', 'group-waiting')]))
  record('adapter never hides a waiting group behind a completed headline', mixed.state === 'waiting' && mixed.summary.includes('已收拢动作:1 项') && mixed.summary.includes('等待中动作:1 项'), mixed)

  const covered = await projectAdapter(adapterEnvelope([adapterGroup('waiting')], [{
    reason: 'waiting-is-not-terminal',
    scope: adapterScope,
  }]))
  record('adapter keeps the coverage gap visible beside the typed state', covered.state === 'waiting' && covered.notices.includes('覆盖不完整') && covered.notices.includes('等待不等于结束'), covered)
  record('adapter page raised no errors', adapterErrors.length === 0, adapterErrors)
  await adapterPage.close()

  // --- the adapter's typed state reaches the panel DOM -----------------------
  const statePage = await context.newPage()
  const stateErrors = []
  statePage.on('pageerror', (error) => stateErrors.push(error.message))
  const stateRequests = { semantic: 0, stream: 0, mutations: 0 }
  statePage.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith('/semantic')) stateRequests.semantic += 1
    else if (path.endsWith('/semantic/stream')) stateRequests.stream += 1
    if (request.method() !== 'GET') stateRequests.mutations += 1
  })
  await serveUi(statePage)
  await statePage.goto(`${proofOrigin}/wired-state.html`, { waitUntil: 'domcontentloaded' })
  await waitForCondition(statePage, () => document.querySelector('.semantic-observation')?.dataset.state === 'blocked')
  const wiredState = await statePage.evaluate(() => ({
    state: document.querySelector('.semantic-observation')?.dataset.state ?? '',
    stateLabel: document.querySelector('.so-state-label')?.textContent ?? '',
    summary: [...document.querySelectorAll('.so-summary-cell')].map((cell) => cell.innerText.replace(/\s+/g, ' ')),
    text: document.body.innerText,
  }))
  observe('wired-typed-state', wiredState)
  record('wired panel renders a blocked operation as blocked, never completed', wiredState.state === 'blocked' && wiredState.stateLabel.includes('受阻') && !wiredState.stateLabel.includes('已收拢') && wiredState.summary.some((row) => row.includes('受阻动作')) && wiredState.text.includes('任务已创建'), wiredState)
  record('wired typed state read stays read-only', stateRequests.semantic === 1 && stateRequests.stream === 0 && stateRequests.mutations === 0, stateRequests)
  record('wired typed-state page raised no errors', stateErrors.length === 0, stateErrors)
  await statePage.close()

  // --- organ -> task -> operation drill-down (F07) ---------------------------
  const drillPage = await context.newPage()
  const drillErrors = []
  drillPage.on('pageerror', (error) => drillErrors.push(error.message))
  const drillRequests = { semantic: 0, stream: 0, mutations: 0 }
  drillPage.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith('/semantic')) drillRequests.semantic += 1
    else if (path.endsWith('/semantic/stream')) drillRequests.stream += 1
    if (request.method() !== 'GET') drillRequests.mutations += 1
  })
  await serveUi(drillPage)
  await drillPage.goto(`${proofOrigin}/wired-drill.html`, { waitUntil: 'domcontentloaded' })
  await waitForCondition(drillPage, () => window.__panelReady === true && document.body.innerText.includes('操作级事实'))
  const readDrill = () => drillPage.evaluate(() => ({
    crumbs: [...document.querySelectorAll('.so-crumb')].map((crumb) => ({
      ref: crumb.dataset.scopeRef ?? '',
      tag: crumb.tagName,
      current: crumb.getAttribute('aria-current'),
    })),
    currentCount: document.querySelectorAll('.so-crumb[aria-current="page"]').length,
    items: [...document.querySelectorAll('.so-item')].map((item) => item.dataset.itemId),
    summary: [...document.querySelectorAll('.so-summary-cell')].map((cell) => cell.innerText.replace(/\s+/g, ' ')),
  }))
  const drillInitial = await readDrill()
  observe('drill-initial', drillInitial)
  record('operation scope shows only the operation fact with exactly one current crumb', drillInitial.currentCount === 1
    && drillInitial.crumbs.find((crumb) => crumb.ref === 'operation:operation-drill')?.current === 'page'
    && drillInitial.crumbs.find((crumb) => crumb.ref === 'operation:operation-drill')?.tag === 'SPAN'
    && drillInitial.crumbs.find((crumb) => crumb.ref === 'task:task-drill')?.tag === 'BUTTON'
    && drillInitial.crumbs.find((crumb) => crumb.ref === 'organ:organ-drill')?.tag === 'BUTTON'
    && drillInitial.items.join(',') === 'event-operation', drillInitial)

  await drillPage.click('.so-crumb[data-scope-ref="task:task-drill"]')
  const drillTask = await readDrill()
  observe('drill-task', drillTask)
  record('drilling up to the task scope filters the facts and keeps exactly one current crumb', drillTask.currentCount === 1
    && drillTask.crumbs.find((crumb) => crumb.ref === 'task:task-drill')?.current === 'page'
    && drillTask.crumbs.find((crumb) => crumb.ref === 'operation:operation-drill')?.current === null
    && drillTask.crumbs.find((crumb) => crumb.ref === 'operation:operation-drill')?.tag === 'BUTTON'
    && drillTask.items.join(',') === 'event-task,event-operation', drillTask)

  await drillPage.click('.so-crumb[data-scope-ref="operation:operation-drill"]')
  const drillOperation = await readDrill()
  observe('drill-operation', drillOperation)
  record('the operation crumb stays clickable to drill back down to a single current crumb', drillOperation.currentCount === 1
    && drillOperation.crumbs.find((crumb) => crumb.ref === 'operation:operation-drill')?.current === 'page'
    && drillOperation.items.join(',') === 'event-operation', drillOperation)
  record('drill-down re-projects the decoded envelope without refetch or mutation', drillRequests.semantic === 1 && drillRequests.stream === 0 && drillRequests.mutations === 0, drillRequests)
  record('drill page raised no errors', drillErrors.length === 0, drillErrors)
  await drillPage.screenshot({ path: join(evidenceRoot, 'artifacts', 'wired-drill.png'), fullPage: true })
  await drillPage.close()

  // --- malformed stream and rejected reload (F08) ----------------------------
  const transportPage = await context.newPage()
  const transportErrors = []
  transportPage.on('pageerror', (error) => transportErrors.push(error.message))
  const transportRequests = { semantic: 0, stream: 0, mutations: 0 }
  transportPage.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith('/semantic')) transportRequests.semantic += 1
    else if (path.endsWith('/semantic/stream')) transportRequests.stream += 1
    if (request.method() !== 'GET') transportRequests.mutations += 1
  })
  await serveUi(transportPage)
  await transportPage.goto(`${proofOrigin}/wired-transport.html`, { waitUntil: 'domcontentloaded' })
  await waitForCondition(transportPage, () => document.body.innerText.includes('语义读取失败'))
  const malformed = await transportPage.evaluate(() => ({
    state: document.querySelector('.semantic-observation')?.dataset.state ?? '',
    text: document.body.innerText,
    notices: [...document.querySelectorAll('.so-notice')].map((notice) => ({ kind: notice.dataset.noticeKind, text: notice.innerText })),
  }))
  observe('malformed-stream', malformed)
  record('a malformed SSE revision keeps the last envelope and shows a typed read failure', malformed.text.includes('任务已创建')
    && malformed.state === 'stale'
    && malformed.notices.some((notice) => notice.kind === 'error' && notice.text.includes('semantic.stream.malformed')), malformed)

  await transportPage.evaluate(() => window.__panel.reload())
  await waitForCondition(transportPage, () => document.body.innerText.includes('reload rejected by runtime'))
  const reloadRejected = await transportPage.evaluate(() => ({
    state: document.querySelector('.semantic-observation')?.dataset.state ?? '',
    text: document.body.innerText,
    notices: [...document.querySelectorAll('.so-notice')].map((notice) => ({ kind: notice.dataset.noticeKind, text: notice.innerText })),
  }))
  observe('reload-rejected', reloadRejected)
  record('a rejected reload keeps the old envelope and shows the typed failure', reloadRejected.text.includes('任务已创建')
    && reloadRejected.state === 'stale'
    && reloadRejected.notices.some((notice) => notice.kind === 'error' && notice.text.includes('reload rejected by runtime'))
    && transportRequests.semantic === 2 && transportRequests.mutations === 0, reloadRejected)
  record('transport page raised no errors', transportErrors.length === 0, transportErrors)
  await transportPage.screenshot({ path: join(evidenceRoot, 'artifacts', 'wired-transport.png'), fullPage: true })
  await transportPage.close()

  // --- reconnect that opens without delivering a revision (F08) --------------
  const openPage = await context.newPage()
  const openErrors = []
  openPage.on('pageerror', (error) => openErrors.push(error.message))
  await serveUi(openPage)
  await openPage.goto(`${proofOrigin}/wired-open.html`, { waitUntil: 'domcontentloaded' })
  await waitForCondition(openPage, () => window.__panelReady === true && document.body.innerText.includes('任务已创建'))
  const readOpen = () => openPage.evaluate(() => ({
    state: document.querySelector('.semantic-observation')?.dataset.state ?? '',
    notices: [...document.querySelectorAll('.so-notice')].map((notice) => notice.dataset.noticeKind),
    text: document.body.innerText,
  }))
  const openInitial = await readOpen()
  record('a live open operation is projected as running before any transport error', openInitial.state === 'running', openInitial)

  await openPage.evaluate(() => window.__fake.instances[0].fireError())
  const openDropped = await readOpen()
  observe('open-dropped', openDropped)
  record('a dropped stream marks the kept envelope stale', openDropped.state === 'stale' && openDropped.notices.includes('stale'), openDropped)

  await openPage.evaluate(() => window.__fake.instances[0].fireOpen())
  const openReconnected = await readOpen()
  observe('open-reconnected', openReconnected)
  record('a reconnect that delivers no revision keeps the stale notice', openReconnected.state === 'stale'
    && openReconnected.notices.includes('stale')
    && openReconnected.text.includes('任务已创建'), openReconnected)

  await openPage.evaluate((data) => window.__fake.instances[0].emit(data), JSON.stringify(openV2))
  const openRevised = await readOpen()
  observe('open-revised', openRevised)
  record('only a decoded revision restores freshness', openRevised.state === 'running'
    && !openRevised.notices.includes('stale')
    && openRevised.text.includes('最终答复已提交'), openRevised)
  record('open page raised no errors', openErrors.length === 0, openErrors)
  await openPage.close()
  }

  if (pageErrors.length > 0) {
    await writeFile(join(evidenceRoot, 'browser-errors.txt'), pageErrors.join('\n'), 'utf8')
    throw new Error(`browser page raised errors:\n${pageErrors.join('\n')}`)
  }

  await writeFile(join(evidenceRoot, 'checks.json'), JSON.stringify({ checks, observations }, null, 2), 'utf8')
  await writeFile(join(evidenceRoot, 'browser-text.txt'), await page.evaluate(() => document.body.innerText), 'utf8')

  if (checks.length === 0) throw new Error('semantic observation browser proof recorded no checks')
  if (failures > 0) {
    throw new Error(
      `semantic observation browser proof failed ${failures}/${checks.length}:\n${checks.filter((check) => !check.pass).map((check) => `  - ${check.name}: ${JSON.stringify(check.detail)}`).join('\n')}`,
    )
  }

  console.log(`semantic observation browser proof: ${checks.length} checks passed`)
  for (const check of checks) console.log(`  - ${check.name}`)
} finally {
  await browser.close().catch(() => {})
}
