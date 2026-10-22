/*
 * W5 page consumer: memory sessions are read from the memory board source,
 * while review candidates stay a separate non-session review layer.
 *
 * Basis: the memory board currently has no declared session reader. The board
 * reports `memory.session-source-unavailable`; rendering an ordinary empty
 * lane would turn a missing owner into a confirmed empty session set. Review
 * candidates are real facts, but they are not execution sessions.
 *
 * Failure mode: a candidate shown as a session, an unavailable source shown as
 * an empty list, a namespace/reason/failure dropped, or a refresh that writes a
 * review. Impact is a wrong memory owner or an unintended decision. Cost is one
 * minimal element adapter over the real page exports.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MEMORY_CANDIDATES_TITLE,
  MEMORY_SESSION_SOURCE_UNAVAILABLE,
  createMemoryReviewReason,
  memoryBoardSection,
  readProductBoard,
  readMemorySurface,
  renderMemoryCandidates,
  renderMemorySessions,
  resolveMemoryReadScope,
} from '../../docs/ui/memory.js'
import { createRuntimeApi } from '../../docs/ui/runtime-api.js'

function createElement(tag, textValue, className) {
  const listeners = new Map()
  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: textValue === undefined ? '' : String(textValue),
    className: className || '',
    children: [],
    attributes: {},
    dataset: {},
    type: undefined,
    value: '',
    placeholder: '',
    disabled: false,
    focused: false,
    focusCount: 0,
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
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    focus() {
      node.focusCount += 1
      node.focused = true
      return node
    },
    remove() {
      node.removed = true
    },
    click() {
      if (node.disabled) return
      for (const listener of listeners.get('click') ?? []) {
        listener({ currentTarget: node, target: node, preventDefault() {} })
      }
    },
  }
  return node
}

function walk(node) {
  return [node, ...(node.children ?? []).flatMap((child) => walk(child))]
}

function text(node) {
  return walk(node)
    .map((child) => child.textContent)
    .filter(Boolean)
    .join(' ')
}

function buttons(root, label) {
  return walk(root).filter((node) => node.tagName === 'BUTTON' && node.textContent === label)
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

const projectScope = { kind: 'project', projectKey: 'project-a' }
const taskId = { scope: 'task', value: 'task-a' }
const observedAt = '2026-10-21T10:00:00.000Z'

const sessionSourceFailure = {
  code: 'memory.session-source-unavailable',
  ownerId: 'humanagent.app.ui-runtime.product-session-read',
  message: 'no declared memory-agent session reader exists; memory review candidates are not sessions',
  nextAction: 'bind a real memory session reader before enumerating the memory board',
}

const reviewView = {
  analysis: { mode: 'deterministic', state: 'idle' },
  autoUpdate: false,
  skillCandidates: [
    {
      candidateId: 'candidate-1',
      state: 'candidate',
      namespace: 'project',
      projectKey: 'project-a',
      taskId,
      proposedRule: '把已确认的检索步骤写入项目记忆',
      sourceRefs: ['journal:task-a:12'],
      sourceDigests: ['digest-a'],
    },
    {
      candidateId: 'candidate-2',
      state: 'approved',
      namespace: 'global',
      projectKey: 'project-b',
      proposedRule: '已接受的候选',
      sourceRefs: [],
      sourceDigests: [],
    },
  ],
}

test('memory board session source stays explicitly unavailable', () => {
  const memory = {
    board: 'memory',
    live: [],
    history: [],
    unknown: [],
    failures: [sessionSourceFailure],
  }
  const index = {
    scope: projectScope,
    observedAt,
    boards: [memory],
  }
  const details = []
  const host = createElement('div')
  renderMemorySessions(host, { ok: true, value: index }, {
    element: createElement,
    openDetail: (detail) => details.push(detail),
  })

  assert.equal(memoryBoardSection(index), memory)
  assert.match(text(host), new RegExp(MEMORY_SESSION_SOURCE_UNAVAILABLE))
  assert.match(text(host), /no declared memory-agent session reader/)
  assert.match(text(host), /bind a real memory session reader/)
  assert.doesNotMatch(text(host), /没有条目/)
  assert.equal(walk(host).some((node) => node.getAttribute('data-product-lane') === 'live'), false)

  const detailButton = buttons(host, 'session 来源详情')[0]
  assert.ok(detailButton, 'the failure keeps an on-demand detail entry')
  detailButton.click()
  assert.equal(details.length, 1)
  assert.ok(details[0].entries.some(([key, value]) =>
    key === 'failures[0].code' && value === 'memory.session-source-unavailable'))
  assert.ok(details[0].entries.some(([key, value]) =>
    key === 'failures[0].ownerId' && value === sessionSourceFailure.ownerId))

  const missingHost = createElement('div')
  renderMemorySessions(missingHost, { ok: true, value: { ...index, boards: [] } }, {
    element: createElement,
  })
  assert.match(text(missingHost), new RegExp(MEMORY_SESSION_SOURCE_UNAVAILABLE))
  assert.doesNotMatch(text(missingHost), /没有条目/)

  const failedHost = createElement('div')
  renderMemorySessions(failedHost, {
    ok: false,
    failure: {
      code: 'product.board.read.failed',
      ownerId: 'humanagent.app',
      message: 'board read failed',
      nextAction: 'retry the board read',
    },
  }, { element: createElement })
  const failedText = text(failedHost)
  assert.match(failedText, new RegExp(MEMORY_SESSION_SOURCE_UNAVAILABLE))
  assert.match(failedText, /board read failed/)
  assert.match(failedText, /retry the board read/)
  assert.doesNotMatch(failedText, /没有条目/)
})

test('candidates stay a non-session review layer with namespace, reason and typed failure', async () => {
  const reasonHost = createElement('div')
  const reason = createMemoryReviewReason(reasonHost, { element: createElement })
  assert.equal(reasonHost.children.includes(reason.section), true)
  assert.equal(reason.input.getAttribute('aria-label'), '审核理由')
  reason.input.value = '  保留理由  '
  assert.equal(reason.readReason(), '保留理由')
  reason.input.value = ''
  assert.equal(reason.readReason(), '')
  assert.equal(reason.input.focusCount, 1)
  reason.input.value = '保留理由'

  const reviews = []
  const errors = []
  const details = []
  let refreshes = 0
  const host = createElement('div')
  renderMemoryCandidates(host, { ok: true, value: reviewView }, {
    element: createElement,
    readReason: reason.readReason,
    review: async (...args) => reviews.push(args),
    refresh: async () => { refreshes += 1 },
    showError: (error) => errors.push(error),
    openDetail: (detail) => details.push(detail),
  })

  const body = text(host)
  assert.match(body, new RegExp(MEMORY_CANDIDATES_TITLE))
  assert.match(body, /记忆库：project/)
  assert.match(body, /项目：project-a/)
  assert.match(body, /把已确认的检索步骤写入项目记忆/)
  assert.equal(host.children[0].getAttribute('data-memory-section'), 'candidates')
  assert.equal(walk(host).some((node) => node.getAttribute('data-product-lane') !== null), false)

  const cards = walk(host).filter((node) => node.getAttribute('data-memory-candidate') !== null)
  assert.equal(cards.length, 2)
  for (const card of cards) {
    assert.equal(card.getAttribute('data-product-target'), null)
    assert.equal(card.getAttribute('data-product-board'), null)
    assert.equal(card.className.split(/\s+/).includes('product-board-item'), false)
  }

  buttons(host, '接受')[0].click()
  await flush()
  await flush()
  assert.deepEqual(reviews, [['candidate-1', 'approve', '保留理由']])
  assert.equal(refreshes, 1)
  assert.equal(errors.length, 0)

  buttons(host, '候选技术详情')[0].click()
  assert.equal(details.length, 1)
  assert.ok(details[0].entries.some(([key, value]) => key === 'namespace' && value === 'project'))
  assert.ok(details[0].entries.some(([key, value, hook]) =>
    key === 'sourceRefs[0]' && value === 'journal:task-a:12' && hook === 'data-memory-source-ref'))
  assert.ok(details[0].entries.some(([key, value, hook]) =>
    key === 'sourceDigests[0]' && value === 'digest-a' && hook === 'data-memory-source-digest'))

  reason.input.value = ''
  buttons(host, '拒绝')[0].click()
  await flush()
  assert.equal(reviews.length, 1, 'a missing reason must not submit a review')

  const failure = {
    code: 'memory.review.failed',
    ownerId: 'memory-coordinator',
    message: 'candidate review rejected',
    nextAction: 'inspect the candidate and retry the review',
  }
  const failedHost = createElement('div')
  renderMemoryCandidates(failedHost, { ok: true, value: reviewView }, {
    element: createElement,
    readReason: () => '拒绝理由',
    review: async () => { throw failure },
    refresh: async () => {},
    showError: (error) => errors.push(error),
    openDetail: () => {},
  })
  buttons(failedHost, '拒绝')[0].click()
  await flush()
  await flush()
  assert.deepEqual(errors.at(-1), failure)

  const unavailableHost = createElement('div')
  renderMemoryCandidates(unavailableHost, { ok: false, failure }, { element: createElement })
  assert.match(text(unavailableHost), /candidate review rejected/)
  assert.match(text(unavailableHost), /inspect the candidate and retry the review/)
  assert.doesNotMatch(text(unavailableHost), /当前没有待审核候选/)
})

test('refresh reads board and candidate summary without any review write', async () => {
  const calls = []
  let writes = 0
  const board = { scope: projectScope, observedAt, boards: [] }
  const surface = await readMemorySurface({
    scope: projectScope,
    readBoard: async (scope) => {
      calls.push(['board', scope])
      return board
    },
    readSummary: async (input) => {
      calls.push(['summary', input])
      return reviewView
    },
    reviewMemoryCandidate: async () => { writes += 1 },
  })

  assert.deepEqual(calls, [
    ['board', projectScope],
    ['summary', { namespace: 'project', limit: 20 }],
  ])
  assert.equal(writes, 0)
  assert.deepEqual(surface.board, { ok: true, value: board })
  assert.deepEqual(surface.summary, { ok: true, value: reviewView })

  const failure = {
    code: 'product.board.read.failed',
    ownerId: 'humanagent.app',
    message: 'board read failed',
    nextAction: 'retry the board read',
  }
  const partial = await readMemorySurface({
    scope: projectScope,
    readBoard: async () => { throw failure },
    readSummary: async () => reviewView,
    reviewMemoryCandidate: async () => { writes += 1 },
  })
  assert.equal(writes, 0)
  assert.deepEqual(partial.board, { ok: false, failure })
  assert.equal('value' in partial.board, false)
  assert.deepEqual(partial.summary, { ok: true, value: reviewView })
})

test('memory board project read sends projectKey and mode to the formal reader', async () => {
  const calls = []
  const formal = createRuntimeApi({
    fetchImpl: async (url) => {
      calls.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => ({ boards: [] }),
      }
    },
  })

  const index = await readProductBoard(
    { kind: 'project', projectKey: 'project-a', mode: 'rcc' },
    { readBoard: formal.readProductBoard },
  )

  assert.deepEqual(index, { boards: [] })
  assert.equal(calls.length, 1)
  const params = new URL(calls[0], 'http://humanagent.local').searchParams
  assert.equal(params.get('projectKey'), 'project-a')
  assert.equal(params.get('mode'), 'rcc')
})

test('memory board project read refuses a missing mode instead of using a default', async () => {
  const calls = []
  await assert.rejects(
    () => readProductBoard(
      { kind: 'project', projectKey: 'project-a' },
      {
        readBoard: async (scope) => {
          calls.push(scope)
          return { boards: [] }
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'memory.scope-unavailable')
      assert.equal(error.ownerId, 'humanagent.ui.memory')
      return true
    },
  )
  assert.deepEqual(calls, [])
})

test('memory board read without a bound scope refuses explicitly without a request', async () => {
  let calls = 0
  await assert.rejects(
    () => readProductBoard(
      { kind: 'system' },
      {
        readBoard: async () => {
          calls += 1
          return { boards: [] }
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'memory.scope-unavailable')
      assert.equal(error.ownerId, 'humanagent.ui.memory')
      assert.equal(typeof error.nextAction, 'string')
      assert.ok(error.nextAction.length > 0)
      return true
    },
  )
  assert.equal(calls, 0)
})

test('memory scope binds URL scope or the sole system project without guessing', async () => {
  const fromUrl = await resolveMemoryReadScope({
    search: '?projectKey=project-b&mode=rcc',
    statusReader: async () => {
      throw new Error('URL scope must not read runtime status')
    },
    systemReader: async () => {
      throw new Error('URL scope must not read the system projects')
    },
  })
  assert.deepEqual(fromUrl, { kind: 'project', projectKey: 'project-b', mode: 'rcc' })

  const fromSystem = await resolveMemoryReadScope({
    search: '',
    statusReader: async () => ({ status: { mode: 'fake' }, error: null }),
    systemReader: async () => ({
      projects: [{ scope: { projectKey: 'project-a' }, tasks: [] }],
      runtime: { mode: 'fake' },
    }),
  })
  assert.deepEqual(fromSystem, { kind: 'project', projectKey: 'project-a', mode: 'fake' })

  await assert.rejects(
    () => resolveMemoryReadScope({
      search: '',
      statusReader: async () => ({ status: { mode: 'fake' }, error: null }),
      systemReader: async () => ({
        projects: [
          { scope: { projectKey: 'project-a' }, tasks: [] },
          { scope: { projectKey: 'project-b' }, tasks: [] },
        ],
        runtime: { mode: 'fake' },
      }),
    }),
    (error) => {
      assert.equal(error.code, 'memory.scope-unavailable')
      assert.equal(error.ownerId, 'humanagent.ui.memory')
      return true
    },
  )
})
