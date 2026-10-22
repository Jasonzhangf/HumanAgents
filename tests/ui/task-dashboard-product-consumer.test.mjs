import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeProductLocation,
  encodeProductLocation,
} from '../../docs/ui/product-location.js'

// Minimal DOM shared by the page module and the three product renderers. It
// records real element structure, attributes and click listeners; the consumer
// asserts rendered nodes and submitted locations, not source text.
function createElement(tag, text, className) {
  const listeners = new Map()
  const node = {
    tagName: String(tag).toUpperCase(),
    className: className || '',
    children: [],
    attributes: new Map(),
    dataset: {},
    type: undefined,
    disabled: false,
    hidden: false,
    _text: text === undefined ? '' : String(text),
    get textContent() {
      return `${node._text}${node.children.map((child) => child.textContent).join('')}`
    },
    set textContent(value) {
      node._text = value === undefined || value === null ? '' : String(value)
      node.children = []
    },
    append(...items) {
      for (const item of items) {
        if (item === undefined || item === null) continue
        node.children.push(item)
      }
    },
    replaceChildren(...items) {
      node.children = []
      node._text = ''
      node.append(...items)
    },
    setAttribute(name, value) {
      node.attributes.set(name, String(value))
    },
    getAttribute(name) {
      return node.attributes.has(name) ? node.attributes.get(name) : null
    },
    removeAttribute(name) {
      node.attributes.delete(name)
    },
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? []
      bucket.push(listener)
      listeners.set(type, bucket)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener))
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener({ type, target: node })
    },
    click() {
      node.dispatch('click')
    },
    focus() {},
  }
  return node
}

function walk(node) {
  return [node, ...node.children.flatMap((child) => walk(child))]
}

function text(node) {
  return walk(node).map((entry) => entry._text).filter(Boolean).join(' ')
}

function byRole(root, role) {
  return walk(root).filter((node) => node.getAttribute?.('data-product-role') === role)
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const taskId = { scope: 'task', value: 'task-1' }
const taskScope = { kind: 'task', projectKey: 'project-7', mode: 'rcc', taskId }
const interactionRef = { kind: 'interaction', taskRef: taskId, scope: taskScope }
const sessionRef = {
  kind: 'session',
  sessionRef: { sourceKind: 'provider', sourceRef: 'session-1' },
  taskRef: taskId,
  scope: taskScope,
}
const childRef = {
  kind: 'session',
  sessionRef: { sourceKind: 'provider', sourceRef: 'child-1' },
  taskRef: taskId,
  scope: taskScope,
}
const evidence = {
  evidenceId: { scope: 'evidence', value: 'ev-1' },
  kind: 'journal',
  source: 'runtime',
  locator: 'journal:12',
}

function message(textValue) {
  return {
    ref: { eventId: `event-${textValue}`, sourceId: 'source-1' },
    targetRef: interactionRef,
    actor: { kind: 'agent', sourceKind: 'provider', sourceRef: 'agent-1' },
    occurredAt: '2026-10-20T12:00:00.000Z',
    text: textValue,
    evidenceRefs: [evidence],
  }
}

function relation(source, target, kind = 'checkpoint') {
  return {
    source,
    target,
    kind,
    sourceOwner: 'humanagent.test',
    evidenceRefs: [evidence],
  }
}

function location(focus = interactionRef) {
  return { board: 'interaction', lane: 'live', focus, scope: taskScope }
}

// The page module has a browser bootstrap. A single explicit test flag swaps
// only that bootstrap for inert hosts; every controller and renderer below is
// the same production code the page uses.
globalThis.__HUMANAGENT_TASK_DASHBOARD_TEST__ = true
globalThis.location = {
  href: 'http://product.invalid/task-dashboard.html?task=task-1&projectKey=project-7&mode=rcc',
  pathname: '/task-dashboard.html',
  search: '?task=task-1&projectKey=project-7&mode=rcc',
  hash: '',
}
globalThis.document = {
  createElement: (tag) => createElement(tag),
  getElementById: () => createElement('div'),
  querySelectorAll: () => [],
  body: createElement('body'),
  activeElement: null,
}
globalThis.window = {
  location: globalThis.location,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false }),
  innerWidth: 1200,
  history: {
    pushState() {},
    replaceState() {},
  },
}
globalThis.history = globalThis.window.history
globalThis.HTMLElement = Object
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
}
globalThis.requestAnimationFrame = (callback) => callback()

const {
  createTaskFocusController,
  dedupeProductRelations,
} = await import('../../docs/ui/task-dashboard.js')

function harness({
  relations = [
    relation(sessionRef, interactionRef, 'occurrence'),
    relation(sessionRef, interactionRef, 'occurrence'),
    relation(interactionRef, childRef, 'child-execution'),
  ],
  messages = [message('CENTER-BODY')],
  output = { commits: [], resultAvailable: false },
  readRelations,
  sessionRead,
  writeLocation,
  closeRelationLayer,
} = {}) {
  const centerHost = createElement('section')
  const relationHost = createElement('aside')
  const writes = []
  const closes = []
  const transport = {
    readProductSession: sessionRead ?? (async () => ({ messages, boardIndex: { boards: [] } })),
    readProductRelations: readRelations ?? (async () => ({ relations, gaps: [] })),
    readProductOutput: async () => output,
    readTaskGrant: async () => ({ readback: { grant: null, commit: null } }),
    grantTaskControl: async () => {
      throw new Error('the consumer must not grant from a read or close')
    },
    revokeTaskGrant: async () => {
      throw new Error('the consumer must not revoke from a read or close')
    },
    stop: async () => {
      throw new Error('the consumer must not stop from a read or close')
    },
  }
  const controller = createTaskFocusController({
    centerHost,
    relationHost,
    transport,
    element: createElement,
    readLocation: () => ({ kind: 'valid', location: location() }),
    writeLocation: writeLocation ?? ((next) => writes.push(next)),
    closeRelationLayer: closeRelationLayer ?? (() => closes.push('closed')),
  })
  return { controller, centerHost, relationHost, transport, writes, closes }
}

test('the focus location carries the exact scope and focus through the URL codec', async () => {
  const submissions = []
  const { controller, relationHost } = harness({
    writeLocation(next) {
      submissions.push(decodeProductLocation(encodeProductLocation(next)))
    },
  })
  await controller.load()

  const sessionButton = walk(relationHost).find(
    (node) => node.tagName === 'BUTTON'
      && node.getAttribute?.('data-product-target-kind') === 'session',
  )
  assert.ok(sessionButton, 'the rendered upstream relation has a focusable session node')
  sessionButton.click()
  await controller.settled()

  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].kind, 'valid')
  assert.deepEqual(submissions[0].location.focus, sessionRef)
  assert.deepEqual(submissions[0].location.scope, taskScope)

  const reopened = harness()
  reopened.controller.applyLocation(submissions[0].location)
  await reopened.controller.settled()
  assert.match(text(reopened.centerHost), /CENTER-BODY/)
  assert.equal(reopened.controller.state().focus.sessionRef.sourceRef, 'session-1')
})

test('relation edges are deduped and focus switching follows the exact direction', async () => {
  assert.equal(dedupeProductRelations([
    relation(sessionRef, interactionRef, 'occurrence'),
    relation(sessionRef, interactionRef, 'occurrence'),
  ]).length, 1)

  const { controller, relationHost, writes } = harness()
  await controller.load()
  assert.equal(controller.state().relations.length, 2, 'the duplicate edge is rendered once')

  const upstream = walk(relationHost).find(
    (node) => node.getAttribute?.('data-product-relation-direction') === 'upstream',
  )
  const upstreamButton = walk(upstream).find((node) => node.tagName === 'BUTTON')
  upstreamButton.click()
  await controller.settled()
  assert.deepEqual(writes.at(-1).focus, sessionRef, 'upstream moves to the relation source')

  await controller.focusTo(interactionRef)
  const downstream = walk(relationHost).find(
    (node) => node.getAttribute?.('data-product-relation-direction') === 'downstream',
  )
  const downstreamButton = walk(downstream).find((node) => node.tagName === 'BUTTON')
  downstreamButton.click()
  await controller.settled()
  assert.deepEqual(writes.at(-1).focus, childRef, 'downstream moves to the relation target')
})

test('no confirmed commit draws no result block, while a confirmed commit does', async () => {
  const empty = harness({ output: { commits: [], resultAvailable: false } })
  await empty.controller.load()
  assert.equal(byRole(empty.centerHost, 'public-result').length, 0)

  const commit = {
    commitId: 'commit-9',
    journalSeq: 9,
    recordDigest: 'digest-9',
    text: '已提交正文',
  }
  const confirmed = harness({
    output: {
      commits: [commit],
      resultAvailable: true,
      publication: { state: 'committed', commits: [commit], publicCommitWatermark: 9 },
    },
  })
  await confirmed.controller.load()
  assert.equal(byRole(confirmed.centerHost, 'public-result').length, 1)
  assert.match(text(confirmed.centerHost), /已提交正文/)
})

test('closing the relation layer writes no decision and submits no control action', async () => {
  const { controller, closes, writes } = harness()
  await controller.load()
  controller.closeRelation()
  assert.deepEqual(closes, ['closed'])
  assert.equal(writes.length, 0)
  assert.equal(controller.state().controlWrites, 0)
})

test('a late session response for the old focus is discarded', async () => {
  const first = deferred()
  const second = deferred()
  let call = 0
  const sessionRead = async () => {
    call += 1
    return call === 1 ? first.promise : second.promise
  }
  const { controller, centerHost } = harness({ sessionRead })

  const firstLoad = controller.load()
  const focusSwitch = controller.focusTo(childRef)

  second.resolve({ messages: [message('NEW-FOCUS-BODY')], boardIndex: { boards: [] } })
  await focusSwitch
  assert.match(text(centerHost), /NEW-FOCUS-BODY/)

  first.resolve({ messages: [message('STALE-FOCUS-BODY')], boardIndex: { boards: [] } })
  await firstLoad
  assert.doesNotMatch(text(centerHost), /STALE-FOCUS-BODY/)
  assert.match(text(centerHost), /NEW-FOCUS-BODY/)
})

test('a missing or failed relation read is explicit and never an invented empty chain', async () => {
  const missing = harness({ readRelations: undefined })
  delete missing.transport.readProductRelations
  await missing.controller.load()
  assert.match(text(missing.relationHost), /关联读取不可用/)
  assert.equal(walk(missing.relationHost).filter((node) => node.getAttribute?.('data-product-relation-kind')).length, 0)

  const failed = harness({
    readRelations: async () => {
      throw Object.assign(new Error('relations source unavailable'), {
        code: 'product.relations.unavailable',
        ownerId: 'humanagent.app',
        nextAction: 'retry the relation read',
      })
    },
  })
  await failed.controller.load()
  assert.match(text(failed.relationHost), /product\.relations\.unavailable/)
  assert.equal(walk(failed.relationHost).filter((node) => node.getAttribute?.('data-product-relation-kind')).length, 0)
})

test('relation gaps keep fact-absent and unrecorded distinct', async () => {
  const { controller, relationHost } = harness({
    relations: [],
    readRelations: async () => ({
      relations: [],
      gaps: [
        {
          code: 'product.relation.absent',
          kind: 'requirement',
          taskId,
          state: 'absent',
          message: '没有需求来源事实。',
          nextAction: 'none',
        },
        {
          code: 'product.relation.unrecorded',
          kind: 'checkpoint',
          taskId,
          state: 'unrecorded',
          message: '事实存在但缺少精确引用。',
          nextAction: 'repair the owner fact',
        },
      ],
    }),
  })
  await controller.load()
  const body = text(relationHost)
  assert.match(body, /没有记录|事实不存在/)
  assert.match(body, /未记录/)
})
