/*
 * W1 dashboard page consumer.
 *
 * Basis: the board home is a read-only projection. The risky failures are an
 * unknown item counted as Live, a card losing its exact focus/scope, a failed
 * or empty read rendered as a confirmed empty board, and a refresh issuing a
 * write. Impact is a wrong task target or a false Live/empty claim. Cost is one
 * small DOM adapter over the real board renderer and the real scoped
 * publication owner.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boardScopeFromSearch,
  cardSelection,
  createBoardController,
  initialBoardState,
  productBoardPath,
  readProductBoard,
  renderBoardIndex,
} from '../../docs/ui/dashboard.js'
import {
  createScopedReadPublication,
} from '../../docs/ui/runtime-shell.js'
import {
  decodeProductLocation,
  encodeProductLocation,
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

function boardRoot(host, board) {
  return walk(host).find((node) => node.getAttribute('data-product-board') === board)
}

function laneNodes(root) {
  return walk(root).filter((node) => node.className === 'product-board-lane')
}

function targetButtons(lane) {
  return walk(lane).filter((node) => node.getAttribute('data-product-target') !== null)
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

const taskId = { scope: 'task', value: 'task-1' }
const projectScope = { kind: 'project', projectKey: 'project-a' }
const taskScope = {
  kind: 'task',
  projectKey: 'project-a',
  mode: 'rcc',
  taskId,
}

const liveItem = {
  lane: 'live',
  ref: { kind: 'interaction', taskRef: taskId, scope: taskScope },
  title: 'Live interaction',
  displayState: 'running',
  evidenceRefs: [],
}

const historyItem = {
  lane: 'history',
  ref: {
    kind: 'session',
    sessionRef: { sourceKind: 'dsh', sourceRef: 'session-1' },
    taskRef: taskId,
    scope: taskScope,
  },
  title: 'History session',
  displayState: 'recorded',
  evidenceRefs: [],
}

const unknownItem = {
  lane: 'unknown',
  ref: {
    kind: 'execution-instance',
    taskRef: taskId,
    scope: taskScope,
    instance: {
      kind: 'incarnation',
      incarnation: {
        runtimeId: 'runtime-1',
        generation: 2,
        agentInstanceId: 'agent-instance-1',
        roleId: 'executor',
        taskId,
        assignmentId: 'assignment-1',
        executionEpoch: 3,
      },
    },
  },
  title: 'Unknown execution',
  displayState: 'unknown',
  unknownReason: 'owner did not provide liveness',
  evidenceRefs: [],
}

const boardIndex = {
  scope: projectScope,
  observedAt: '2026-10-21T00:00:00.000Z',
  boards: [
    {
      board: 'interaction',
      live: [liveItem],
      history: [historyItem],
      unknown: [unknownItem],
    },
  ],
}

test('unknown board items stay in the unknown lane and never become Live', async () => {
  const host = createElement('section')
  const failures = []
  const controller = createBoardController({
    publication: createScopedReadPublication(async () => boardIndex),
    render: (index) => renderBoardIndex(host, index, { element: createElement }),
    renderFailure: (failure) => failures.push(failure),
  })

  const result = await controller.refresh(projectScope)
  assert.equal(result.ok, true)
  assert.deepEqual(failures, [])

  const interaction = boardRoot(host, 'interaction')
  assert.notEqual(interaction, undefined)
  const [live, history, unknown] = laneNodes(interaction)

  assert.equal(live.getAttribute('data-product-lane'), 'live')
  assert.equal(history.getAttribute('data-product-lane'), 'history')
  assert.equal(unknown.getAttribute('data-product-lane'), 'unknown')

  assert.match(text(live), /Live interaction/)
  assert.doesNotMatch(text(live), /Unknown execution/)
  assert.match(text(history), /History session/)
  assert.doesNotMatch(text(history), /Unknown execution/)
  assert.match(text(unknown), /Unknown execution/)
  assert.match(text(unknown), /owner did not provide liveness/)

  const liveTargets = targetButtons(live)
  const historicalTargets = targetButtons(history)
  const unknownTargets = targetButtons(unknown)
  assert.deepEqual(JSON.parse(liveTargets[0].getAttribute('data-product-target')), liveItem.ref)
  assert.deepEqual(JSON.parse(historicalTargets[0].getAttribute('data-product-target')), historyItem.ref)
  assert.deepEqual(JSON.parse(unknownTargets[0].getAttribute('data-product-target')), unknownItem.ref)
})

test('a Live/history card produces the exact focus and scope in its location and task page URL', () => {
  const liveSelection = cardSelection(liveItem, { board: 'interaction' })
  assert.deepEqual(liveSelection.location, {
    board: 'interaction',
    lane: 'live',
    focus: liveItem.ref,
    scope: taskScope,
  })
  assert.deepEqual(decodeProductLocation(liveSelection.hash), {
    kind: 'valid',
    location: liveSelection.location,
  })

  const url = new URL(liveSelection.href, 'https://product.invalid/')
  assert.equal(url.pathname.endsWith('/task-dashboard.html'), true)
  assert.equal(url.searchParams.get('task'), 'task-1')
  assert.equal(url.searchParams.get('projectKey'), 'project-a')
  assert.equal(url.searchParams.get('mode'), 'rcc')
  assert.equal(url.hash, liveSelection.hash)
  assert.doesNotMatch(liveSelection.href, /create|new-task|entry/i)

  const historySelection = cardSelection(historyItem, { board: 'interaction' })
  assert.deepEqual(historySelection.location, {
    board: 'interaction',
    lane: 'history',
    focus: historyItem.ref,
    scope: taskScope,
  })
  assert.deepEqual(decodeProductLocation(historySelection.hash).location, historySelection.location)
})

test('unknown items are not selectable locations', () => {
  assert.throws(
    () => cardSelection(unknownItem, { board: 'interaction' }),
    TypeError,
  )

  let navigations = 0
  const controller = createBoardController({
    publication: { refresh: async () => ({ published: true, state: { content: boardIndex } }) },
    navigate: () => { navigations += 1 },
  })
  const result = controller.select(unknownItem, { board: 'interaction' })
  assert.deepEqual(result, { ok: false, reason: 'unknown-lane' })
  assert.equal(navigations, 0)
})

test('a failed or empty read never renders a guessed empty board', async () => {
  const failures = []
  let renders = 0

  const failedController = createBoardController({
    publication: createScopedReadPublication(async () => {
      const error = new Error('product board source is unavailable')
      error.code = 'product-board.unavailable'
      error.ownerId = 'humanagent.app'
      error.nextAction = 'restore the board source'
      throw error
    }),
    render: () => { renders += 1 },
    renderFailure: (failure) => failures.push(failure),
  })
  const failed = await failedController.refresh(projectScope)
  assert.equal(failed.ok, false)
  assert.equal(failed.failure.code, 'product-board.unavailable')
  assert.equal(failed.failure.ownerId, 'humanagent.app')
  assert.equal(failed.failure.nextAction, 'restore the board source')
  assert.equal(renders, 0)

  const emptyController = createBoardController({
    publication: {
      refresh: async () => ({
        published: true,
        reason: 'published',
        state: { content: undefined, stale: false, failure: undefined },
      }),
    },
    render: () => { renders += 1 },
    renderFailure: (failure) => failures.push(failure),
  })
  const empty = await emptyController.refresh(projectScope)
  assert.equal(empty.ok, false)
  assert.equal(empty.failure.code, 'product-board.no-content')
  assert.equal(renders, 0)
  assert.equal(failures.length, 2)
})

test('refresh is read-only and never navigates or writes', async () => {
  let reads = 0
  let writes = 0
  let navigations = 0
  let renders = 0
  const transport = {
    readBoard: async () => {
      reads += 1
      return boardIndex
    },
    write: async () => {
      writes += 1
      throw new Error('refresh must not write')
    },
  }
  const controller = createBoardController({
    publication: createScopedReadPublication(transport.readBoard),
    render: () => { renders += 1 },
    renderFailure: () => assert.fail('the confirmed board must not fail'),
    navigate: () => { navigations += 1 },
  })

  const first = await controller.refresh(projectScope)
  const second = await controller.refresh(projectScope)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(
    { reads, writes, navigations, renders },
    { reads: 2, writes: 0, navigations: 0, renders: 2 },
  )

  const selected = controller.select(liveItem, { board: 'interaction' })
  assert.equal(selected.ok, true)
  assert.equal(navigations, 1)
  assert.equal(writes, 0)
})

test('initial scope comes from the URL or default project and a valid hash restores its exact scope', () => {
  assert.deepEqual(boardScopeFromSearch('?projectKey=project-b'), {
    kind: 'project',
    projectKey: 'project-b',
  })
  assert.deepEqual(boardScopeFromSearch('', 'project-c'), {
    kind: 'project',
    projectKey: 'project-c',
  })
  assert.deepEqual(boardScopeFromSearch(''), { kind: 'system' })

  const restoredLocation = {
    board: 'execution',
    lane: 'history',
    focus: unknownItem.ref,
    scope: taskScope,
  }
  const hash = encodeProductLocation(restoredLocation)
  const restored = initialBoardState({
    hash,
    search: '?projectKey=another-project',
  })
  assert.equal(restored.kind, 'valid')
  assert.deepEqual(restored.location, restoredLocation)
  assert.deepEqual(restored.scope, taskScope)

  const noHash = initialBoardState({ hash: '', search: '?projectKey=project-b' })
  assert.equal(noHash.kind, 'board')
  assert.deepEqual(noHash.scope, { kind: 'project', projectKey: 'project-b' })
})

test('an invalid product hash is explicit and never invents a focus', () => {
  const restored = initialBoardState({
    hash: '#/boards/execution/live',
    search: '?projectKey=project-b',
  })
  assert.equal(restored.kind, 'unknown')
  assert.equal(restored.failure.code, 'product-location.unknown')
  assert.equal('location' in restored, false)
  assert.deepEqual(restored.scope, { kind: 'project', projectKey: 'project-b' })
})

test('a project-scoped session without a task keeps the exact hash instead of inventing a task page', () => {
  const projectSession = {
    lane: 'history',
    ref: {
      kind: 'session',
      sessionRef: { sourceKind: 'memory', sourceRef: 'memory-session-1' },
      scope: projectScope,
    },
    title: 'Project memory session',
    displayState: 'recorded',
    evidenceRefs: [],
  }
  const selection = cardSelection(projectSession, { board: 'memory' })
  assert.equal(selection.href, null)
  assert.deepEqual(decodeProductLocation(selection.hash).location, selection.location)
})

test('the board read forwards the exact scope and rejects a body without a board index', async () => {
  assert.equal(productBoardPath({ kind: 'system' }), '/api/product/board')
  assert.equal(
    productBoardPath(projectScope),
    '/api/product/board?projectKey=project-a',
  )
  assert.equal(
    productBoardPath(taskScope),
    '/api/product/board?projectKey=project-a&mode=rcc&taskId=task-1',
  )

  const calls = []
  const index = await readProductBoard(projectScope, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(boardIndex)
    },
  })
  assert.equal(index, boardIndex)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/product/board?projectKey=project-a')
  assert.equal(calls[0].init.method, 'GET')

  await assert.rejects(
    () => readProductBoard(projectScope, {
      fetchImpl: async () => jsonResponse({ boards: null }),
    }),
    (error) => {
      assert.equal(error.code, 'product-board.invalid')
      assert.equal(error.ownerId, 'humanagent.app')
      return true
    },
  )
})
