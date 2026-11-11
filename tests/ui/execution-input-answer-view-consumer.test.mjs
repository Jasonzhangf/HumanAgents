import assert from 'node:assert/strict'
import test from 'node:test'

import { renderPendingDecision } from '../../docs/ui/product-control-view.js'

function createElement(tag, textValue, className) {
  const listeners = new Map()
  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: textValue === undefined ? '' : String(textValue),
    className: className || '',
    children: [],
    attributes: {},
    dataset: {},
    disabled: false,
    value: '',
    type: undefined,
    append(...items) {
      for (const item of items) {
        if (item === undefined || item === null) continue
        node.children.push(item)
      }
    },
    replaceChildren(...items) {
      node.children = []
      node.append(...items)
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name)
        ? node.attributes[name]
        : null
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    click() {
      if (node.disabled) return
      for (const listener of listeners.get('click') ?? []) {
        listener({ currentTarget: node, target: node, preventDefault() {} })
      }
    },
    remove() {
      node.removed = true
    },
  }
  return node
}

function walk(node) {
  return [node, ...(node.children ?? []).flatMap((child) => walk(child))]
}

test('task input request renders the question, answer field and scoped submit action', () => {
  const host = createElement('div')
  const submitted = []
  const decision = {
    kind: 'task-input-request',
    target: {
      kind: 'interaction',
      taskRef: { scope: 'task', value: 'task-relay-ui' },
      scope: {
        kind: 'task',
        projectKey: 'project-relay-ui',
        mode: 'fake',
        taskId: { scope: 'task', value: 'task-relay-ui' },
      },
    },
    request: {
      requestId: 'request-relay-ui',
      taskId: { scope: 'task', value: 'task-relay-ui' },
      schemaRef: 'humanagent://input/text/v1',
      reason: '任务缺少部署目标。',
      impact: '当前执行等待用户回答。',
      question: '请补充部署目标。',
      turnId: 'turn-relay-ui',
      operationId: { scope: 'operation', value: 'operation-relay-ui' },
      executionEpoch: 1,
      expectedRevision: 3,
    },
    question: '请补充部署目标。',
    actions: ['answer'],
    state: 'waiting',
    recoveryOwner: 'humanagent.runtime',
  }

  renderPendingDecision(host, decision, {
    element: createElement,
    onAnswer: (input) => submitted.push(input),
  })

  const questions = walk(host).filter((node) => node.textContent === '请补充部署目标。')
  const fields = walk(host).filter((node) => node.getAttribute('data-product-role') === 'task-input-answer')
  const buttons = walk(host).filter((node) => node.getAttribute('data-product-control-action') === 'answer')
  assert.ok(questions.length >= 1)
  assert.equal(fields.length, 1)
  assert.equal(buttons.length, 1)

  fields[0].value = '生产环境'
  buttons[0].click()
  assert.deepEqual(submitted, [{
    taskId: 'task-relay-ui',
    requestId: 'request-relay-ui',
    expectedRevision: 3,
    answer: '生产环境',
  }])
})
