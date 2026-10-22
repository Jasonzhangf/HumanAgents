/*
 * U1 module consumer.
 *
 * Basis: navigation and board rendering are read-only projections. The risky
 * failures are a location round trip that loses the exact focus/scope, an
 * unknown item appearing in the Live lane, and a refresh/Back path that
 * substitutes a guessed location. Impact is a wrong task target or a false
 * status. Cost is one small element adapter over the real exported modules.
 *
 * This is module evidence only. Page-controller/API wiring remains with S/H/W.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PRODUCT_BOARD_ORDER,
  renderProductBoardIndex,
  renderProductBoardSection,
} from '../../docs/ui/product-board-view.js'
import {
  decodeProductLocation,
  encodeProductLocation,
  hierarchyReturn,
  locationFromHash,
  locationFromPopState,
  productLocationHistoryState,
} from '../../docs/ui/product-location.js'

function createElement(tag, text, className) {
  const listeners = new Map()
  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: text === undefined ? '' : String(text),
    className: className || '',
    children: [],
    attributes: {},
    dataset: {},
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
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
  }
  return node
}

function walk(node) {
  return [node, ...node.children.flatMap((child) => walk(child))]
}

function text(node) {
  return [node.textContent, ...node.children.map((child) => text(child))].filter(Boolean).join(' ')
}

function laneNodes(root) {
  return walk(root).filter((node) => node.className === 'product-board-lane')
}

function targetButtons(lane) {
  return walk(lane).filter((node) => node.getAttribute('data-product-target') !== null)
}

const taskA = { scope: 'task', value: 'task-a' }
const taskB = { scope: 'task', value: 'task-b' }
const projectScope = { kind: 'project', projectKey: 'project-a' }
const taskScope = { kind: 'task', projectKey: 'project-a', mode: 'fake', taskId: taskA }

const interactionFocus = {
  kind: 'interaction',
  taskRef: taskA,
  scope: taskScope,
}
const sessionFocus = {
  kind: 'session',
  sessionRef: { sourceKind: 'dsh', sourceRef: 'session-a' },
  scope: projectScope,
}
const executionFocus = {
  kind: 'execution-instance',
  taskRef: taskA,
  scope: taskScope,
  instance: {
    kind: 'incarnation',
    incarnation: {
      runtimeId: 'runtime-a',
      generation: 2,
      agentInstanceId: 'agent-instance-a',
      roleId: 'executor',
      taskId: taskA,
      assignmentId: 'assignment-a',
      executionEpoch: 3,
    },
  },
}

function boardSection() {
  return {
    board: 'interaction',
    live: [
      {
        lane: 'live',
        ref: interactionFocus,
        title: 'Live interaction',
        displayState: 'running',
        evidenceRefs: [],
      },
    ],
    history: [
      {
        lane: 'history',
        ref: sessionFocus,
        title: 'History session',
        displayState: 'recorded',
        evidenceRefs: [],
      },
    ],
    unknown: [
      {
        lane: 'unknown',
        ref: executionFocus,
        title: 'Unknown execution',
        displayState: 'unknown',
        unknownReason: 'owner did not provide liveness',
        evidenceRefs: [],
      },
    ],
  }
}

test('renders five boards and keeps Live, history and unknown in separate lanes', () => {
  const section = boardSection()
  const root = renderProductBoardSection(null, section, { element: createElement })

  assert.equal(root.getAttribute('data-product-board'), 'interaction')
  assert.deepEqual(
    laneNodes(root).map((node) => node.getAttribute('data-product-lane')),
    ['live', 'history', 'unknown'],
  )

  const liveButtons = targetButtons(laneNodes(root)[0])
  const historyButtons = targetButtons(laneNodes(root)[1])
  const unknownButtons = targetButtons(laneNodes(root)[2])

  assert.equal(liveButtons.length, 1)
  assert.deepEqual(JSON.parse(liveButtons[0].getAttribute('data-product-target')), interactionFocus)
  assert.equal(historyButtons.length, 1)
  assert.deepEqual(JSON.parse(historyButtons[0].getAttribute('data-product-target')), sessionFocus)
  assert.equal(unknownButtons.length, 1)
  assert.deepEqual(JSON.parse(unknownButtons[0].getAttribute('data-product-target')), executionFocus)

  assert.match(text(liveButtons[0]), /Live interaction/)
  assert.doesNotMatch(text(liveButtons[0]), /Unknown execution/)
  assert.match(text(unknownButtons[0]), /Unknown execution/)
  assert.match(text(unknownButtons[0]), /owner did not provide liveness/)

  const index = renderProductBoardIndex(null, {
    scope: projectScope,
    observedAt: '2026-10-21T00:00:00.000Z',
    boards: [section],
  }, { element: createElement })

  const boardRoots = walk(index).filter((node) => node.getAttribute('data-product-board') !== null)
  assert.deepEqual(
    boardRoots.map((node) => node.getAttribute('data-product-board')),
    [...PRODUCT_BOARD_ORDER],
  )
  assert.equal(
    boardRoots.filter((node) => node.getAttribute('data-product-board-missing') === 'true').length,
    PRODUCT_BOARD_ORDER.length - 1,
  )
})

test('location round trip preserves the exact focus and scope for every target kind', () => {
  const cases = [
    interactionFocus,
    sessionFocus,
    executionFocus,
    undefined,
  ]

  for (const focus of cases) {
    const location = {
      board: 'orchestration',
      lane: 'live',
      scope: focus?.scope ?? projectScope,
      ...(focus === undefined ? {} : { focus }),
    }
    const hash = encodeProductLocation(location)
    const decoded = decodeProductLocation(hash)

    assert.equal(decoded.kind, 'valid', `decoded ${focus?.kind ?? 'board-only'} location`)
    assert.deepEqual(decoded.location, location)
  }
})

test('encoded URL contains no principal, grant or secret field', () => {
  const location = {
    board: 'execution',
    lane: 'history',
    scope: { ...taskScope, principal: 'alice', authorization: 'grant' },
    focus: { ...interactionFocus, principal: 'alice', authorization: 'grant' },
    principal: 'alice',
    authorization: 'grant',
    secret: 's3cr3t',
  }

  const hash = encodeProductLocation(location)

  for (const forbidden of ['alice', 's3cr3t', 'principal', 'authorization', 'grant', 'secret']) {
    assert.equal(hash.includes(forbidden), false, `URL must not contain ${forbidden}`)
  }

  const decoded = decodeProductLocation(hash)
  assert.equal(decoded.kind, 'valid')
  assert.equal('principal' in decoded.location, false)
  assert.equal('authorization' in decoded.location, false)
  assert.deepEqual(decoded.location, {
    board: 'execution',
    lane: 'history',
    scope: taskScope,
    focus: interactionFocus,
  })
})

test('hierarchy return keeps the selected lane and drops only the focus', () => {
  for (const lane of ['live', 'history']) {
    const location = { board: 'inspection', lane, scope: projectScope, focus: sessionFocus }
    const parent = hierarchyReturn(location)

    assert.equal(parent?.kind, 'board')
    assert.deepEqual(parent.location, { board: 'inspection', lane, scope: projectScope })
    assert.equal(hierarchyReturn(parent.location), null)
  }
})

test('popstate restores the exact state and never guesses around an invalid state', () => {
  const location = {
    board: 'memory',
    lane: 'history',
    scope: projectScope,
    focus: sessionFocus,
  }
  const validHash = encodeProductLocation(location)

  const fromState = locationFromPopState({
    state: productLocationHistoryState(location),
    newURL: 'https://example.invalid/#/boards/execution/live',
  })
  assert.equal(fromState.kind, 'valid')
  assert.deepEqual(fromState.location, location)

  const fromUrl = locationFromPopState({
    state: null,
    newURL: `https://example.invalid/${validHash}`,
  })
  assert.equal(fromUrl.kind, 'valid')
  assert.deepEqual(fromUrl.location, location)

  const invalid = locationFromPopState({
    state: { productLocation: { board: 'memory', lane: 'history' } },
    newURL: `https://example.invalid/${validHash}`,
  })
  assert.equal(invalid.kind, 'unknown')
  assert.equal(invalid.failure.code, 'product-location.unknown')
})

test('invalid or partial locations stay explicitly unknown', () => {
  const missingScope = locationFromHash('#/boards/execution/live')
  assert.equal(missingScope.kind, 'unknown')

  const unknownBoard = locationFromHash(
    `#/boards/unknown/live?scope=${encodeURIComponent(JSON.stringify({ kind: 'system' }))}`,
  )
  assert.equal(unknownBoard.kind, 'unknown')

  const unexpectedKey = locationFromHash(
    `#/boards/execution/live?scope=${encodeURIComponent(JSON.stringify({ kind: 'system' }))}&principal=alice`,
  )
  assert.equal(unexpectedKey.kind, 'unknown')

  const foreignFocus = {
    board: 'execution',
    lane: 'live',
    scope: taskScope,
    focus: { ...interactionFocus, taskRef: taskB },
  }
  assert.throws(() => encodeProductLocation(foreignFocus), TypeError)

  const zeroEpoch = {
    board: 'execution',
    lane: 'live',
    scope: taskScope,
    focus: {
      ...executionFocus,
      instance: {
        kind: 'incarnation',
        incarnation: { ...executionFocus.instance.incarnation, executionEpoch: 0 },
      },
    },
  }
  assert.throws(() => encodeProductLocation(zeroEpoch), TypeError)
})
