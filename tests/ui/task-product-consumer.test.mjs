/*
 * W3 consumer: task page product-session wiring.
 *
 * Basis: plan §6 W3 and the interface map §2.3/§2.5/§2.7.
 * Failure modes under test:
 *   - an agent message is relabelled human;
 *   - one confirmation is sent twice;
 *   - a clarification or error replaces the human's input;
 *   - closing the approval modal writes a rejection;
 *   - an absent public result still draws a result block.
 *
 * Cost is one minimal DOM adapter and injected transports. No HTTP, DOM
 * library or browser is used here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTaskProductController } from '../../docs/ui/task.js'

function createElement(tag, text, className) {
  const listeners = new Map()
  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: text === undefined ? '' : String(text),
    className: className || '',
    children: [],
    parentNode: null,
    attributes: {},
    dataset: {},
    type: undefined,
    disabled: false,
    hidden: false,
    value: '',
    id: '',
    href: '',
    focused: false,
    append(...items) {
      for (const item of items) {
        if (item === undefined || item === null) continue
        if (item.parentNode) item.parentNode.removeChild(item)
        item.parentNode = node
        node.children.push(item)
      }
    },
    replaceChildren(...items) {
      for (const child of node.children) child.parentNode = null
      node.children = []
      node.append(...items)
    },
    removeChild(child) {
      const index = node.children.indexOf(child)
      if (index >= 0) node.children.splice(index, 1)
      child.parentNode = null
      return child
    },
    remove() {
      node.parentNode?.removeChild(node)
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
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event)
      return true
    },
    click() {
      if (node.disabled) return
      node.dispatchEvent({ type: 'click', target: node })
    },
    focus() {
      node.focused = true
    },
    querySelector(selector) {
      return find(node, selector)[0] || null
    },
    querySelectorAll(selector) {
      return find(node, selector)
    },
    get isConnected() {
      return true
    },
  }
  node.ownerDocument = { createElement }
  return node
}

function walk(node) {
  return [node, ...node.children.flatMap((child) => walk(child))]
}

function matches(node, selector) {
  if (selector.startsWith('#')) return node.id === selector.slice(1)
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const body = selector.slice(1, -1)
    const equals = body.indexOf('=')
    if (equals < 0) return node.getAttribute(body) !== null
    const name = body.slice(0, equals)
    const value = body.slice(equals + 1).replace(/^"|"$/g, '')
    return node.getAttribute(name) === value
  }
  return node.tagName === selector.toUpperCase()
}

function find(root, selector) {
  return walk(root).filter((node) => node !== root && matches(node, selector))
}

function text(node) {
  return [node.textContent, ...node.children.map((child) => text(child))]
    .filter(Boolean)
    .join(' ')
}

const taskScope = {
  kind: 'task',
  projectKey: 'humanagent',
  mode: 'fake',
  taskId: { scope: 'task', value: 'task-w3' },
}
const taskRef = { scope: 'task', value: 'task-w3' }
const eventScope = {
  organId: { scope: 'organ', value: 'organ-1' },
  taskId: taskRef,
}

function message(textValue, actor) {
  return {
    ref: {
      eventId: `event-${textValue}`,
      sourceId: 'explicit-intake',
      scope: eventScope,
    },
    targetRef: {
      kind: 'session',
      sessionRef: { sourceKind: 'explicit-interaction', sourceRef: 'interaction-1' },
      taskRef,
      scope: taskScope,
    },
    actor,
    occurredAt: '2026-10-21T10:00:00.000Z',
    text: textValue,
    evidenceRefs: [],
  }
}

function decision() {
  return {
    kind: 'task-grant',
    target: {
      kind: 'interaction',
      taskRef,
      scope: taskScope,
    },
    question: '是否批准继续执行？',
    actions: ['grant', 'revoke'],
    state: 'waiting',
    revision: 2,
    readback: { grant: null, commit: null },
    recoveryOwner: 'humanagent.runtime',
  }
}

function snapshot(state, overrides = {}) {
  return {
    interactionId: 'interaction-1',
    state,
    rawInput: 'RAW-INPUT-SENTINEL',
    reply: '请补充验收标准。',
    nextAction: 'answer the clarification',
    draft: {
      draftId: 'draft-1',
      inputRevision: 3,
      proposal: '整理后的任务正文',
      proposedIntent: 'create',
    },
    ...overrides,
  }
}

function createController(overrides = {}) {
  const calls = {
    confirm: [],
    clarify: [],
    grant: [],
    revoke: [],
  }
  const host = createElement('div')
  const interactionHost = createElement('div')
  const decisionHost = createElement('div')
  const status = createElement('div')
  const transport = {
    readProductSession: async () => ({ messages: [], boardIndex: undefined }),
    readProductOutput: async () => ({
      commits: [],
      resultAvailable: false,
    }),
    confirmExplicitRequirement: async (...args) => {
      calls.confirm.push(args)
      return { accepted: true }
    },
    answerExplicitClarification: async (...args) => {
      calls.clarify.push(args)
      return snapshot('awaiting-confirmation')
    },
    grantTaskControl: async (...args) => {
      calls.grant.push(args)
      return { accepted: true }
    },
    revokeTaskGrant: async (...args) => {
      calls.revoke.push(args)
      return { accepted: true }
    },
    ...overrides.transport,
  }
  const controller = createTaskProductController({
    host,
    interactionHost,
    decisionHost,
    status,
    make: createElement,
    transport,
    scope: taskScope,
    taskId: taskRef.value,
    ...overrides.options,
  })
  return { controller, host, interactionHost, decisionHost, status, calls, transport }
}

test('renders real agent actor and source without relabelling it human', async () => {
  const agent = message('AGENT-BODY', {
    kind: 'agent',
    sourceKind: 'agent-provider',
    sourceRef: 'session-a',
  })
  const { controller, host } = createController({
    transport: {
      readProductSession: async () => ({ messages: [agent] }),
    },
  })

  await controller.refresh()

  const rendered = text(host)
  assert.match(rendered, /AGENT-BODY/)
  assert.match(rendered, /代理/)
  assert.match(rendered, /agent-provider/)
  assert.match(rendered, /session-a/)
  assert.doesNotMatch(rendered, /人类|human/i)
})

test('one explicit confirmation submits exactly once', async () => {
  const { controller, interactionHost, calls } = createController()

  controller.setInteraction({
    interactionId: 'interaction-1',
    snapshot: snapshot('awaiting-confirmation'),
  })
  const confirm = find(interactionHost, '#task-confirm-button')[0]
  assert.ok(confirm, 'an awaiting-confirmation interaction has a confirm control')

  confirm.click()
  confirm.click()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.confirm.length, 1)
  assert.equal(calls.confirm[0][0], 'interaction-1')
  assert.equal(calls.confirm[0][1].draftId, 'draft-1')
  assert.equal(calls.confirm[0][1].inputRevision, 3)
})

test('a clarification failure keeps the typed answer and the original input', async () => {
  const { controller, interactionHost } = createController({
    transport: {
      answerExplicitClarification: async () => {
        throw Object.assign(new Error('clarification unavailable'), {
          code: 'fake.clarification.unavailable',
          ownerId: 'fake.owner',
          nextAction: 'retry the clarification',
        })
      },
    },
  })

  controller.setInteraction({
    interactionId: 'interaction-1',
    snapshot: snapshot('awaiting-clarification'),
  })
  const answer = find(interactionHost, 'textarea')[0]
  answer.value = 'CLARIFICATION-ANSWER-SENTINEL'
  const submit = find(interactionHost, '[data-task-action="answer"]')[0]
  submit.click()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const textarea = find(interactionHost, 'textarea')[0]
  assert.ok(textarea)
  assert.equal(textarea.value, 'CLARIFICATION-ANSWER-SENTINEL')
  assert.match(text(interactionHost), /RAW-INPUT-SENTINEL/)
  assert.match(text(interactionHost), /clarification unavailable/)
})

test('an interaction error keeps the original input visible', async () => {
  const { controller, interactionHost } = createController()

  controller.setInteraction({
    interactionId: 'interaction-1',
    snapshot: snapshot('awaiting-clarification'),
    error: Object.assign(new Error('intake read failed'), {
      code: 'fake.intake.failed',
      ownerId: 'fake.owner',
      nextAction: 'refresh the interaction',
    }),
  })

  const rendered = text(interactionHost)
  assert.match(rendered, /RAW-INPUT-SENTINEL/)
  assert.match(rendered, /intake read failed/)
})

test('closing the approval modal writes no grant or revoke', async () => {
  const pending = decision()
  const { controller, host, decisionHost, calls } = createController({
    transport: {
      readProductSession: async () => ({ messages: [], pendingDecision: pending }),
    },
  })

  await controller.refresh()
  const approve = find(decisionHost, '[data-product-role="decision-grant"]')[0]
  assert.ok(approve, 'the pending decision exposes a formal grant action')
  approve.click()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const close = find(host, '[data-product-role="close-control-modal"]')[0]
  assert.ok(close, 'the modal has a close control')
  close.click()

  assert.equal(calls.grant.length, 0)
  assert.equal(calls.revoke.length, 0)
  assert.equal(find(host, '[role="dialog"]').length, 0)
})

test('draws no result block when no public commit is available', async () => {
  const { controller, host } = createController({
    transport: {
      readProductSession: async () => ({ messages: [] }),
      readProductOutput: async () => ({
        commits: [],
        resultAvailable: false,
        publication: { state: 'pending', commits: [] },
      }),
    },
  })

  await controller.refresh()

  assert.equal(find(host, '[data-product-role="public-result"]').length, 0)
  assert.doesNotMatch(text(host), /已提交结果/)
})
