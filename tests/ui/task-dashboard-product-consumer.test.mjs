import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeProductLocation,
  encodeProductLocation,
  locationFromPopState,
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

function mainLayerText(node) {
  if (String(node.tagName).toUpperCase() === 'DETAILS') return ''
  return [node._text, ...node.children.map((child) => mainLayerText(child))]
    .filter(Boolean)
    .join(' ')
}

function detailsFor(node) {
  return walk(node).filter((entry) => String(entry.tagName).toUpperCase() === 'DETAILS')
}

function detailsText(node) {
  return detailsFor(node)
    .flatMap((entry) => walk(entry))
    .map((entry) => entry._text)
    .filter(Boolean)
    .join(' ')
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
const explicitSessionRef = {
  kind: 'session',
  sessionRef: { sourceKind: 'explicit-intake', sourceRef: 'interaction-1' },
  taskRef: taskId,
  scope: taskScope,
}
const explicitChildRef = {
  kind: 'session',
  sessionRef: { sourceKind: 'explicit-intake', sourceRef: 'interaction-2' },
  taskRef: taskId,
  scope: taskScope,
}
const inspectionSessionRef = {
  kind: 'session',
  sessionRef: { sourceKind: 'inspection-occurrence', sourceRef: 'occurrence-1' },
  taskRef: taskId,
  scope: taskScope,
}
const childRef = {
  kind: 'session',
  sessionRef: { sourceKind: 'provider', sourceRef: 'child-1' },
  taskRef: taskId,
  scope: taskScope,
}
const instanceOne = {
  kind: 'execution-instance',
  instance: {
    kind: 'native-execution',
    execution: { runtimeId: 'runtime-a', executionEpoch: 3 },
  },
  taskRef: taskId,
  scope: taskScope,
}
const instanceTwo = {
  kind: 'execution-instance',
  instance: {
    kind: 'incarnation',
    incarnation: {
      runtimeId: 'runtime-b',
      generation: 2,
      agentInstanceId: 'agent-2',
      roleId: 'role-2',
      taskId,
      assignmentId: 'assignment-2',
      executionEpoch: 4,
    },
  },
  taskRef: taskId,
  scope: taskScope,
}
const taskBId = { scope: 'task', value: 'task-2' }
const taskBScope = { kind: 'task', projectKey: 'project-7', mode: 'rcc', taskId: taskBId }
const interactionB = { kind: 'interaction', taskRef: taskBId, scope: taskBScope }
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

function pendingDecision(target = interactionRef, state = 'waiting') {
  return {
    kind: 'task-grant',
    target,
    question: '是否批准继续执行这个任务？',
    actions: ['grant'],
    state,
    readback: { grant: null, commit: null },
    recoveryOwner: 'humanagent.test',
  }
}

// The page module has a browser bootstrap. A single explicit test flag swaps
// only that bootstrap for inert hosts; every controller and renderer below is
// the same production code the page uses.
globalThis.__HUMANAGENT_TASK_DASHBOARD_TEST__ = true
globalThis.location = {
  href: 'http://product.invalid/task-dashboard.html?task=task-1&projectKey=project-7&mode=rcc&control=1',
  pathname: '/task-dashboard.html',
  search: '?task=task-1&projectKey=project-7&mode=rcc&control=1',
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
  productLocationMatchesTask,
  renderProductSessionExtras,
  writePageProductLocation,
} = await import('../../docs/ui/task-dashboard.js')

function taskRowItem(scope, lane) {
  const taskIdValue = typeof scope.taskId === 'object' ? scope.taskId.value : scope.taskId
  const taskRef = { scope: 'task', value: taskIdValue }
  return {
    ref: {
      kind: 'interaction',
      taskRef,
      scope: { kind: 'task', projectKey: scope.projectKey, mode: scope.mode, taskId: taskRef },
    },
    lane,
    ...(lane === 'unknown' ? { unknownReason: 'the task list reported an unknown state' } : {}),
    title: `任务 ${taskIdValue}`,
    displayState: lane === 'live' ? 'running' : 'succeeded',
    evidenceRefs: [],
  }
}

function boardIndexFor(scope, lane) {
  return {
    scope: {
      kind: 'task',
      projectKey: scope.projectKey,
      mode: scope.mode,
      taskId: { scope: 'task', value: scope.taskId },
    },
    observedAt: '2026-10-21T00:00:00.000Z',
    boards: [{
      board: 'orchestration',
      live: lane === 'live' ? [taskRowItem(scope, lane)] : [],
      history: lane === 'history' ? [taskRowItem(scope, lane)] : [],
      unknown: lane === 'unknown' ? [taskRowItem(scope, lane)] : [],
    }],
  }
}

function interventions(root) {
  return walk(root).filter(
    (node) => node.dataset?.productFocusControl === 'intervention',
  )
}

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
  decisionRead = async () => null,
  readLocation = () => ({ kind: 'valid', location: location() }),
  writeLocation,
  closeRelationLayer,
  grantTaskControl,
  stopControl,
  onSessionRendered,
} = {}) {
  const centerHost = createElement('section')
  const relationHost = createElement('aside')
  const writes = []
  const closes = []
  const sessionReads = []
  const decisionReads = []
  const transport = {
    readProductSession: async (scope) => {
      sessionReads.push(scope)
      return sessionRead === undefined
        ? { messages, boardIndex: { boards: [] } }
        : sessionRead(scope)
    },
    readProductRelations: readRelations ?? (async () => ({ relations, gaps: [] })),
    readProductOutput: async () => output,
    readProductDecision: async (scope) => {
      decisionReads.push(scope)
      return decisionRead(scope)
    },
    readTaskGrant: async () => ({ readback: { grant: null, commit: null } }),
    grantTaskControl: grantTaskControl ?? (async () => {
      throw new Error('the consumer must not grant from a read or close')
    }),
    revokeTaskGrant: async () => {
      throw new Error('the consumer must not revoke from a read or close')
    },
    stop: stopControl ?? (async () => {
      throw new Error('the consumer must not stop from a read or close')
    }),
  }
  const controller = createTaskFocusController({
    centerHost,
    relationHost,
    transport,
    element: createElement,
    readLocation,
    writeLocation: writeLocation ?? ((next) => writes.push(next)),
    closeRelationLayer: closeRelationLayer ?? (() => closes.push('closed')),
    ...(onSessionRendered === undefined ? {} : { onSessionRendered }),
  })
  return {
    controller,
    centerHost,
    relationHost,
    transport,
    writes,
    closes,
    sessionReads,
    decisionReads,
  }
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
  // A provider session has no declared body reader. Restoring its exact focus
  // must not re-label the original task body as that session's body.
  assert.match(text(reopened.centerHost), /product-session\.read\.unavailable-target/)
  assert.doesNotMatch(text(reopened.centerHost), /CENTER-BODY/)
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
  const focusSwitch = controller.focusTo(explicitChildRef)

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

test('the session read carries the exact source kind and reference of the current focus', async () => {
  const { controller, sessionReads } = harness()
  await controller.load()
  assert.deepEqual(sessionReads.at(-1), {
    projectKey: 'project-7',
    mode: 'rcc',
    taskId: 'task-1',
  })

  await controller.focusTo(explicitSessionRef)
  assert.deepEqual(sessionReads.at(-1), {
    projectKey: 'project-7',
    mode: 'rcc',
    taskId: 'task-1',
    sessionRef: {
      sourceKind: 'explicit-intake',
      sourceRef: 'interaction-1',
    },
  })

  await controller.focusTo(explicitChildRef)
  assert.deepEqual(sessionReads.at(-1), {
    projectKey: 'project-7',
    mode: 'rcc',
    taskId: 'task-1',
    sessionRef: {
      sourceKind: 'explicit-intake',
      sourceRef: 'interaction-2',
    },
  })
})

test('an execution-instance focus is explicitly unavailable and never shows task messages', async () => {
  const { controller, centerHost, sessionReads } = harness({
    messages: [message('TASK-LEVEL-BODY')],
  })
  await controller.load()
  assert.match(text(centerHost), /TASK-LEVEL-BODY/)
  const readsBefore = sessionReads.length

  await controller.focusTo(instanceOne)
  assert.equal(sessionReads.length, readsBefore, 'an instance without a body reader sends no task-level read')
  assert.equal(controller.state().sessionRead, 'unavailable')
  assert.match(text(centerHost), /product-session\.read\.unavailable-target/)
  const mainOne = mainLayerText(centerHost)
  assert.match(mainOne, /该执行实例暂无正文读取入口/)
  assert.match(mainOne, /回到对应任务查看执行摘要/)
  assert.doesNotMatch(mainOne, /runtimeId|runtime-a|executionEpoch|generation|agentInstanceId|roleId|assignmentId|taskId/)
  const foldedOne = detailsFor(centerHost)
  assert.equal(foldedOne.length, 1, 'instance identity has one on-demand technical detail block')
  assert.equal(foldedOne[0].open, false, 'technical identity starts folded')
  const detailOne = detailsText(centerHost)
  assert.match(detailOne, /runtimeId runtime-a/)
  assert.match(detailOne, /executionEpoch 3/)
  assert.doesNotMatch(text(centerHost), /TASK-LEVEL-BODY/)

  const firstResult = detailOne
  await controller.focusTo(instanceTwo)
  assert.equal(sessionReads.length, readsBefore, 'the second instance also sends no task-level read')
  const mainTwo = mainLayerText(centerHost)
  assert.match(mainTwo, /该执行实例暂无正文读取入口/)
  assert.doesNotMatch(mainTwo, /runtimeId|runtime-b|executionEpoch|generation|agentInstanceId|roleId|assignmentId|taskId/)
  const foldedTwo = detailsFor(centerHost)
  assert.equal(foldedTwo.length, 1, 'the second instance keeps its identity in one technical detail block')
  assert.equal(foldedTwo[0].open, false, 'the second technical identity starts folded')
  const detailTwo = detailsText(centerHost)
  assert.match(detailTwo, /runtimeId runtime-b/)
  assert.match(detailTwo, /generation 2/)
  assert.match(detailTwo, /agentInstanceId agent-2/)
  assert.match(detailTwo, /roleId role-2/)
  assert.match(detailTwo, /assignmentId assignment-2/)
  assert.match(detailTwo, /executionEpoch 4/)
  assert.match(detailTwo, /taskId task-1/)
  assert.doesNotMatch(detailTwo, /runtime-a/)
  assert.doesNotMatch(text(centerHost), /TASK-LEVEL-BODY/)
  assert.notEqual(detailTwo, firstResult, 'two instances keep distinct technical identities')
})

test('a session kind without a body reader is unavailable instead of an empty task read', async () => {
  const { controller, centerHost, sessionReads } = harness({
    messages: [message('TASK-LEVEL-BODY')],
  })
  await controller.load()
  const readsBefore = sessionReads.length

  await controller.focusTo(inspectionSessionRef)
  assert.equal(sessionReads.length, readsBefore, 'the task-level read is not reused for another source kind')
  assert.equal(controller.state().sessionRead, 'unavailable')
  assert.match(text(centerHost), /product-session\.read\.unavailable-target/)
  const main = mainLayerText(centerHost)
  assert.match(main, /该会话来源暂无正文读取入口/)
  assert.match(main, /当前页面不会用任务消息代替来源正文/)
  assert.doesNotMatch(main, /inspection-occurrence|occurrence-1|sourceKind|sourceRef/)
  const folded = detailsFor(centerHost)
  assert.equal(folded.length, 1, 'session source identity has one on-demand technical detail block')
  assert.equal(folded[0].open, false, 'session source identity starts folded')
  assert.match(detailsText(centerHost), /inspection-occurrence/)
  assert.match(detailsText(centerHost), /occurrence-1/)
  assert.doesNotMatch(text(centerHost), /TASK-LEVEL-BODY/)
})

test('crossing from a history task to a Live task mounts intervention only after the matching focus read', async () => {
  const sessionRead = async (scope) => ({
    messages: [message(`BODY-${scope.taskId}`)],
    boardIndex: boardIndexFor(scope, scope.taskId === 'task-1' ? 'history' : 'live'),
  })
  const stops = []
  const { controller, centerHost } = harness({
    sessionRead,
    stopControl: async (taskIdValue) => {
      stops.push(taskIdValue)
      return { execution: { state: 'stopping' } }
    },
    onSessionRendered: renderProductSessionExtras,
  })
  await controller.load()
  assert.equal(controller.state().focusLane, 'history')
  assert.equal(interventions(centerHost).length, 0)

  const switching = controller.focusTo(interactionB)
  assert.equal(interventions(centerHost).length, 0, 'the old intervention is cleared before the new fact arrives')
  await switching
  await controller.settled()

  assert.equal(controller.state().focusLane, 'live')
  assert.equal(interventions(centerHost).length, 1)
  const stopButton = walk(interventions(centerHost)[0]).find(
    (node) => node.getAttribute?.('data-product-control-action') === 'stop',
  )
  assert.ok(stopButton)
  stopButton.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stops.length, 1)
  assert.equal(stops[0], 'task-2', 'the mounted control targets the current focus task')
})

test('crossing from a Live task to a history task removes intervention and keeps the history read read-only', async () => {
  const sessionRead = async (scope) => ({
    messages: [message(`BODY-${scope.taskId}`)],
    boardIndex: boardIndexFor(scope, scope.taskId === 'task-1' ? 'live' : 'history'),
  })
  const { controller, centerHost } = harness({
    sessionRead,
    onSessionRendered: renderProductSessionExtras,
  })
  await controller.load()
  assert.equal(interventions(centerHost).length, 1)

  const switching = controller.focusTo(interactionB)
  assert.equal(interventions(centerHost).length, 0, 'a Live entry never follows the focus into history')
  await switching
  await controller.settled()

  assert.equal(controller.state().focusLane, 'history')
  assert.equal(interventions(centerHost).length, 0)
  assert.match(text(centerHost), /BODY-task-2/)
  assert.equal(
    walk(centerHost).filter((node) => node.getAttribute?.('data-product-control-action')).length,
    0,
  )
})

test('cross-task focus writes one matching query and hash and restores the same focus', async () => {
  const { controller, writes } = harness()
  await controller.load()
  await controller.focusTo(interactionB)
  const next = writes.at(-1)
  assert.deepEqual(next.focus, interactionB)
  assert.deepEqual(next.scope, taskBScope)

  const originalHref = globalThis.location.href
  const originalSearch = globalThis.location.search
  const originalPushState = globalThis.window.history.pushState
  const pushed = []
  globalThis.location.href = 'http://product.invalid/task-dashboard.html?task=task-1&projectKey=project-7&mode=rcc&control=1'
  globalThis.location.search = '?task=task-1&projectKey=project-7&mode=rcc&control=1'
  globalThis.window.history.pushState = (state, title, url) => pushed.push({ state, url })
  try {
    writePageProductLocation(next)
    const written = new URL(pushed.at(-1).url, 'http://product.invalid')
    assert.equal(written.searchParams.get('task'), 'task-2')
    assert.equal(written.searchParams.get('projectKey'), 'project-7')
    assert.equal(written.searchParams.get('mode'), 'rcc')
    assert.equal(written.searchParams.get('control'), null)

    const decoded = decodeProductLocation(written.hash)
    assert.equal(decoded.kind, 'valid')
    assert.deepEqual(decoded.location.focus, interactionB)
    assert.deepEqual(decoded.location.scope, taskBScope)

    const refreshed = harness({ readLocation: () => decoded })
    await refreshed.controller.load()
    assert.deepEqual(refreshed.controller.state().focus, interactionB)

    const popped = locationFromPopState({ state: pushed.at(-1).state, newURL: pushed.at(-1).url })
    assert.equal(popped.kind, 'valid')
    globalThis.location.search = written.search
    assert.equal(productLocationMatchesTask(popped.location), true)
    await refreshed.controller.applyLocation(popped.location)
    assert.deepEqual(refreshed.controller.state().focus, interactionB)
  } finally {
    globalThis.location.href = originalHref
    globalThis.location.search = originalSearch
    globalThis.window.history.pushState = originalPushState
  }
})

test('a real waiting decision renders from the owner read and its action uses the focus task', async () => {
  const grants = []
  const { controller, centerHost, decisionReads } = harness({
    decisionRead: async () => pendingDecision(interactionRef),
    grantTaskControl: async (taskIdValue, input, scope) => {
      grants.push({ taskIdValue, input, scope })
      return { execution: { state: 'granted' } }
    },
  })
  await controller.load()
  assert.deepEqual(decisionReads.at(-1), {
    projectKey: 'project-7',
    mode: 'rcc',
    taskId: 'task-1',
  })

  const block = walk(centerHost).find(
    (node) => node.getAttribute?.('data-product-pending-decision') === 'task-grant',
  )
  assert.ok(block, 'the owner decision is rendered as the one pending decision block')
  assert.match(text(block), /是否批准继续执行这个任务/)
  const target = walk(block).find(
    (node) => node.getAttribute?.('data-product-role') === 'control-target',
  )
  assert.equal(target.getAttribute('data-task-id'), 'task-1')

  const approve = walk(block).find(
    (node) => node.getAttribute?.('data-product-role') === 'decision-grant',
  )
  assert.ok(approve)
  assert.equal(approve.disabled, false)
  approve.click()

  const dialog = walk(centerHost).find(
    (node) => node.getAttribute?.('role') === 'dialog',
  )
  assert.ok(dialog, 'an explicit action opens the approval surface')
  const modalApprove = walk(dialog).find(
    (node) => node.getAttribute?.('data-product-role') === 'decision-grant',
  )
  assert.equal(modalApprove.disabled, false)
  modalApprove.click()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(grants.length, 1)
  assert.equal(grants[0].taskIdValue, 'task-1')
  assert.deepEqual(grants[0].scope, { projectKey: 'project-7', mode: 'rcc' })
  assert.equal(grants[0].input.expectedRevision, 0)
})

test('a decision that names another task is not attached to the current focus', async () => {
  const { controller, centerHost } = harness({
    readLocation: () => ({
      kind: 'valid',
      location: { board: 'interaction', lane: 'live', focus: interactionB, scope: taskBScope },
    }),
    decisionRead: async () => pendingDecision(interactionRef),
  })
  await controller.load()
  assert.deepEqual(controller.state().focus, interactionB)
  assert.equal(
    walk(centerHost).filter((node) => node.getAttribute?.('data-product-pending-decision')).length,
    0,
  )
})

test('a late decision for the old focus does not replace the new focus decision', async () => {
  const first = deferred()
  const second = deferred()
  const grants = []
  let call = 0
  const { controller, centerHost } = harness({
    decisionRead: async () => {
      call += 1
      return call === 1 ? first.promise : second.promise
    },
    grantTaskControl: async (taskIdValue, input, scope) => {
      grants.push({ taskIdValue, scope })
      return { execution: { state: 'granted' } }
    },
  })

  const firstLoad = controller.load()
  const focusSwitch = controller.focusTo(interactionB)
  second.resolve(pendingDecision(interactionB))
  await focusSwitch
  const beforeLate = walk(centerHost).filter(
    (node) => node.getAttribute?.('data-product-pending-decision') === 'task-grant',
  )
  assert.equal(beforeLate.length, 1)
  assert.equal(
    walk(beforeLate[0]).find((node) => node.getAttribute?.('data-product-role') === 'control-target')
      ?.getAttribute('data-task-id'),
    'task-2',
  )

  first.resolve(pendingDecision(interactionRef))
  await firstLoad
  const afterLate = walk(centerHost).filter(
    (node) => node.getAttribute?.('data-product-pending-decision') === 'task-grant',
  )
  assert.equal(afterLate.length, 1)
  assert.equal(
    walk(afterLate[0]).find((node) => node.getAttribute?.('data-product-role') === 'control-target')
      ?.getAttribute('data-task-id'),
    'task-2',
  )

  const approve = walk(afterLate[0]).find(
    (node) => node.getAttribute?.('data-product-role') === 'decision-grant',
  )
  approve.click()
  const dialog = walk(centerHost).find((node) => node.getAttribute?.('role') === 'dialog')
  const modalApprove = walk(dialog).find(
    (node) => node.getAttribute?.('data-product-role') === 'decision-grant',
  )
  modalApprove.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(grants.length, 1)
  assert.equal(grants[0].taskIdValue, 'task-2')
  assert.deepEqual(grants[0].scope, { projectKey: 'project-7', mode: 'rcc' })
})

test('a missing decision transport is explicit and never invents a decision', async () => {
  const { controller, centerHost, transport } = harness()
  delete transport.readProductDecision
  await controller.load()
  assert.equal(controller.state().decisionRead, 'unavailable')
  assert.ok(walk(centerHost).find(
    (node) => node.getAttribute?.('data-product-role') === 'decision-unavailable',
  ))
  assert.equal(
    walk(centerHost).filter((node) => node.getAttribute?.('data-product-pending-decision')).length,
    0,
  )
})

test('a null owner decision draws no block even when control=1 is in the URL', async () => {
  const { controller, centerHost, decisionReads } = harness({
    decisionRead: async () => null,
  })
  await controller.load()
  assert.deepEqual(decisionReads.at(-1), {
    projectKey: 'project-7',
    mode: 'rcc',
    taskId: 'task-1',
  })
  assert.equal(
    walk(centerHost).filter((node) => node.getAttribute?.('data-product-pending-decision')).length,
    0,
  )
  assert.equal(
    walk(centerHost).filter((node) => node.getAttribute?.('data-product-role') === 'decision-unavailable').length,
    0,
  )
})

test('a non-waiting decision fact is never shown as a waiting approval', async () => {
  const { controller, centerHost } = harness({
    decisionRead: async () => pendingDecision(interactionRef, 'resolved'),
  })
  await controller.load()
  assert.equal(
    walk(centerHost).filter((node) => node.getAttribute?.('data-product-pending-decision')).length,
    0,
  )
})

test('a revoke-only decision fact is not an approval and writes nothing', async () => {
  const { controller, centerHost } = harness({
    decisionRead: async () => ({
      ...pendingDecision(interactionRef),
      actions: ['revoke'],
    }),
  })
  await controller.load()
  assert.equal(
    walk(centerHost).filter((node) => node.getAttribute?.('data-product-pending-decision')).length,
    0,
  )
  assert.equal(controller.state().controlWrites, 0)
})
