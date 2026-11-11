import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/process-view-leak-sanitization.json', import.meta.url),
  'utf8',
))

const providerResultId = 'provider-c649f1a4a7afab07-tool-result-output-provider-tool-result-call-8353380d-f165-4feb-bab8-d7976611ff6c'
const internalFields = [
  'runtime-task-event',
  'provider.model',
  'provider provided model reasoning',
  'provider prepared model output',
  'provider request settled',
  'execution.terminal',
  'execution.settling',
  'checkpoint.committed',
  '步骤 27',
  providerResultId,
]

function createNode(tag = 'div', text, className) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: className ?? '',
    textContent: text === undefined ? '' : String(text),
    children: [],
    attributes: {},
    dataset: {},
    append(...items) {
      node.children.push(...items.filter((item) => item !== undefined && item !== null))
    },
    replaceChildren(...items) {
      node.children = items.filter((item) => item !== undefined && item !== null)
    },
    removeChild(child) {
      node.children = node.children.filter((item) => item !== child)
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name)
        ? node.attributes[name]
        : null
    },
    removeAttribute(name) {
      delete node.attributes[name]
    },
    addEventListener() {},
    removeEventListener() {},
  }
  Object.defineProperty(node, 'firstChild', {
    get() {
      return node.children[0] ?? null
    },
  })
  return node
}

function walk(node) {
  return [node, ...node.children.flatMap((child) => walk(child))]
}

function text(node) {
  return walk(node).map((entry) => entry.textContent).filter(Boolean).join(' ')
}

function assertNoInternalFields(value, label) {
  for (const field of internalFields) {
    assert.equal(
      String(value).includes(field),
      false,
      `${label} must not expose ${field}`,
    )
  }
  assert.doesNotMatch(String(value), /(?:^|\n)\s*回答\s*(?:\n|$)/u, `${label} must not expose the raw answer marker`)
}

test('child session process messages localize event identity and provider copy without hiding failure', async () => {
  const { renderProductSessionView } = await import('../../docs/ui/product-session-view.js')
  const host = createNode('div')
  renderProductSessionView(host, {
    messages: fixture.messages,
    publicOutput: fixture.publicOutput,
  }, { element: createNode })

  const rendered = text(host)
  assertNoInternalFields(rendered, 'child session process view')
  assert.match(rendered, /模型正在推理/u)
  assert.match(rendered, /模型正在准备输出/u)
  assert.match(rendered, /模型请求已收束/u)
  assert.match(rendered, /执行结束/u)
  assert.match(rendered, /执行正在收拢/u)
  assert.match(rendered, /检查点已提交/u)
  assert.match(rendered, /执行失败：真实失败原因/u)
})

test('entry progress uses semantic Chinese phases instead of mechanical step numbers', async () => {
  // Import before installing the DOM double; entry.js only boots its page when
  // a real document exists at module evaluation time.
  const { createSubmitStatusBanner } = await import('../../docs/ui/entry.js')
  const previousDocument = globalThis.document
  globalThis.document = {
    createElement: (tag) => createNode(tag),
    createTextNode: (value) => {
      const node = createNode('#text')
      node.textContent = String(value)
      return node
    },
  }
  try {
    const status = createNode('div')
    const banner = createSubmitStatusBanner(status)
    try {
      banner.mount()
      banner.step(fixture.entryStep)
      const rendered = text(status)
      assert.doesNotMatch(rendered, /步骤\s*27/u)
      assert.match(rendered, /模型处理/u)
      assert.match(rendered, /模型正在准备输出/u)
      assert.equal(
        banner.history().some((entry) => /provider|Model is streaming/u.test(entry.summary)),
        false,
      )
    } finally {
      banner.clear()
    }
  } finally {
    globalThis.document = previousDocument
  }
})

test('runtime projection sanitizes raw output while retaining the real failure', async () => {
  const { projectRuntimeTaskList } = await import('../../dist/app/ui/projection/runtime.js')
  const task = {
    taskId: fixture.taskId,
    title: '进程视图脱敏',
    state: 'failed',
    currentState: 'failed',
    nextStep: '查看失败原因',
    updatedAt: '2026-11-10T18:58:05.000Z',
    input: '检查进程输出',
    output: fixture.failureOutput,
    currentNode: 'execution.terminal',
    allowedActions: [],
    recentEvents: fixture.recentEvents,
    publicOutput: fixture.publicOutput,
  }

  const row = projectRuntimeTaskList({ mode: 'fake', tasks: [task] }).failed[0]
  assertNoInternalFields(row.output, 'projected task output')
  assert.match(row.output, /执行失败：真实失败原因/u)
  assertNoInternalFields(JSON.stringify(row.publicOutput), 'projected public output')
  assert.match(JSON.stringify(row.publicOutput), /执行失败：真实失败原因/u)
})

test('runtime projection preserves significant output whitespace while removing hidden markers', async () => {
  const { projectRuntimeTaskList } = await import('../../dist/app/ui/projection/runtime.js')
  const rawOutput = [
    '  leading content',
    '',
    '保留的失败原因：真实失败原因',
    '<thinking>hidden</thinking>',
    providerResultId,
    '回答',
    '证据：',
    '   ',
    'trailing content  ',
  ].join('\n')
  const expectedOutput = [
    '  leading content',
    '',
    '保留的失败原因：真实失败原因',
    'hidden',
    '',
    '   ',
    'trailing content  ',
  ].join('\n')
  const row = projectRuntimeTaskList({
    mode: 'fake',
    tasks: [{
      taskId: fixture.taskId,
      title: '输出空白保留',
      state: 'failed',
      currentState: 'failed',
      nextStep: '查看失败原因',
      updatedAt: '2026-11-10T18:58:05.000Z',
      input: '检查空白保留',
      output: rawOutput,
      currentNode: 'execution.terminal',
      allowedActions: [],
      recentEvents: [],
      publicOutput: { state: 'unavailable', commits: [] },
    }],
  }).failed[0]

  assert.equal(row.output, expectedOutput)
  assert.doesNotMatch(row.output, /<thinking>/u)
  assertNoInternalFields(row.output, 'whitespace-preserving projected task output')
  assert.match(row.output, /保留的失败原因：真实失败原因/u)
})
