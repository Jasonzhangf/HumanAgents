import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateExecutionProgress,
  evaluateGrantDecision,
  evaluateNavigationState,
  summarizeChecks,
  unavailableSurfaceFields,
} from './ux-rcc-approval-acceptance-browser.mjs'
import { readFocusFailureNode } from './ux-product-acceptance-browser.mjs'

const taskScope = {
  kind: 'task',
  projectKey: 'project-1',
  mode: 'rcc',
  taskId: { scope: 'task', value: 'task-1' },
}

const target = {
  kind: 'interaction',
  taskRef: { scope: 'task', value: 'task-1' },
  scope: taskScope,
}

function productUrl(focus = target, { task = 'task-1', projectKey = 'project-1', mode = 'rcc' } = {}) {
  const location = {
    board: 'interaction',
    lane: 'live',
    focus,
    scope: focus.scope,
  }
  return `http://127.0.0.1:49000/task-dashboard.html?task=${task}&projectKey=${projectKey}&mode=${mode}`
    + `#/boards/interaction/live?scope=${encodeURIComponent(JSON.stringify(location.scope))}`
    + `&focus=${encodeURIComponent(JSON.stringify(location.focus))}`
}

function message(eventId, text, messageTarget = target) {
  return {
    ref: { eventId },
    text,
    targetRef: messageTarget,
    actor: { kind: 'agent' },
  }
}

function sessionBody({
  scope = taskScope,
  messages = [message('evt-1', '当前 target 正文')],
} = {}) {
  return { boardIndex: { scope }, messages }
}

function sessionReceipt({
  status = 200,
  body = sessionBody(),
  search = { projectKey: 'project-1', mode: 'rcc', taskId: 'task-1' },
} = {}) {
  return {
    method: 'GET',
    path: '/api/product/session',
    search,
    status,
    ok: Number.isInteger(status) && status >= 200 && status < 300,
    settled: true,
    body,
  }
}

function focusSurface({
  focusScope = 'task:project-1:rcc:task-1',
  centerReady = true,
  sessionHostCount = 1,
  messageCount = 1,
  messageEventIds = ['evt-1'],
  messageTexts = ['当前 target 正文'],
  emptyCount = 0,
  unavailableCount = 0,
  unavailableCode = '',
  unavailableCodeRows = 0,
  unavailableMessage = '',
} = {}) {
  return {
    centerReady,
    focusScope,
    sessionHostCount,
    messageCount,
    messageEventIds,
    messageTexts,
    emptyCount,
    unavailableCount,
    unavailableCode,
    unavailableCodeRows,
    unavailableMessage,
  }
}

test('receipt evaluation refuses an empty run and a green check without evidence', () => {
  const empty = summarizeChecks([])
  assert.equal(empty.status, 'INCOMPLETE')

  const noEvidence = summarizeChecks([
    { id: 'fake-pass', status: 'PASS', detail: 'looks good', evidenceFiles: [] },
  ])
  assert.notEqual(noEvidence.status, 'PASS')
  assert.deepEqual(noEvidence.missingEvidence, ['fake-pass'])

  const realPass = summarizeChecks([
    { id: 'real-pass', status: 'PASS', detail: 'observed', evidenceFiles: ['receipt.json'] },
  ])
  assert.equal(realPass.status, 'PASS')

  const failure = summarizeChecks([
    { id: 'real-fail', status: 'FAIL', detail: 'observed failure', evidenceFiles: ['error.json'] },
  ])
  assert.equal(failure.status, 'FAIL')
})

test('grant evaluation requires the exact waiting task and a formal grant action', () => {
  const waiting = {
    kind: 'task-grant',
    state: 'waiting',
    actions: ['grant'],
    target,
    readback: { grant: null, commit: null },
  }
  assert.equal(evaluateGrantDecision({ decision: waiting, taskId: 'task-1' }).ok, true)
  assert.equal(evaluateGrantDecision({ decision: waiting, taskId: 'task-2' }).ok, false)
  assert.equal(evaluateGrantDecision({ decision: null, taskId: 'task-1' }).ok, false)
  assert.equal(evaluateGrantDecision({
    decision: { ...waiting, target: { ...target, taskRef: { scope: 'task', value: 'task-2' } } },
    taskId: 'task-1',
  }).ok, false)
  assert.equal(evaluateGrantDecision({ decision: { ...waiting, actions: ['revoke'] }, taskId: 'task-1' }).ok, false)
  // A project-scope read must still prove the decision names one task inside that scope.
  assert.equal(evaluateGrantDecision({
    decision: waiting,
    scope: { projectKey: 'project-1', mode: 'rcc' },
  }).ok, true)
  assert.equal(evaluateGrantDecision({
    decision: waiting,
    scope: { projectKey: 'other-project', mode: 'rcc' },
  }).ok, false)
})

test('execution progress must leave waiting and expose a real execution or result signal', () => {
  assert.equal(evaluateExecutionProgress({
    dashboard: { state: 'waiting' },
    output: { resultAvailable: false, commits: [] },
    session: { messages: [] },
  }).ok, false)

  assert.equal(evaluateExecutionProgress({
    dashboard: { state: 'running', execution: { state: 'running' } },
    output: { resultAvailable: false, commits: [] },
    session: { messages: [] },
  }).ok, true)

  assert.equal(evaluateExecutionProgress({
    dashboard: { state: 'succeeded' },
    output: { resultAvailable: true, commits: [{ text: 'done' }] },
    session: { messages: [] },
  }).ok, true)
})

test('navigation evaluation binds the fixed target to request, body and visible messages', () => {
  const url = productUrl()
  const good = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt()],
    surface: focusSurface(),
  })
  assert.equal(good.ok, true)
  assert.equal(good.bodyState, 'messages')

  const empty = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt({ body: sessionBody({ messages: [] }) })],
    surface: focusSurface({
      messageCount: 0,
      messageEventIds: [],
      messageTexts: [],
      emptyCount: 1,
    }),
  })
  assert.equal(empty.ok, true)
  assert.equal(empty.bodyState, 'empty')

  const unavailable = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [],
    contractUnavailable: true,
    surface: focusSurface({
      messageCount: 0,
      messageEventIds: [],
      messageTexts: [],
      emptyCount: 0,
      unavailableCount: 1,
      unavailableCode: 'product-session.read.unavailable-target',
      unavailableCodeRows: 1,
      unavailableMessage: '该执行实例暂无正文读取入口。',
    }),
  })
  assert.equal(unavailable.ok, true)
  assert.equal(unavailable.bodyState, 'unavailable')
})

// renderProductFocusFailure emits a main human message and a closed technical
// detail whose record-ref rows carry the diagnostic code. This reproduces that
// structure so the unavailable branch is exercised through the same collector
// the RCC page uses, instead of hand-filling fields that collector may not
// produce.
function domElement(tag, text, className) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: className ?? '',
    children: [],
    _text: text === undefined ? '' : String(text),
    get textContent() {
      return `${node._text}${node.children.map((child) => child.textContent).join('')}`
    },
    get innerText() {
      return `${node._text}${node.children.map((child) => child.innerText).join('')}`
    },
    append(...items) {
      for (const item of items) {
        if (item === undefined || item === null) continue
        if (typeof item === 'string') {
          node.children.push(domElement('span', item))
        } else {
          node.children.push(item)
        }
      }
    },
  }
  return node
}

function failureSurfaceFromDom(failure) {
  const node = domElement('div', undefined, 'product-focus-failure')
  const technical = domElement('details', undefined, 'product-focus-failure-detail')
  const entries = domElement('dl', undefined, 'record-ref')
  for (const [label, value] of [
    ['code', failure.code],
    ['owner', failure.ownerId],
    ['message', failure.message],
    ['nextAction', failure.nextAction],
  ]) {
    const row = domElement('div')
    row.append(domElement('dt', label), domElement('dd', value))
    entries.append(row)
  }
  technical.append(entries)
  node.append(
    domElement('p', failure.message, 'product-focus-failure-message'),
    domElement('p', failure.nextAction, 'product-focus-failure-next'),
    technical,
  )
  return node
}

test('the unavailable branch passes through the real failure node collector', () => {
  const url = productUrl()
  const collected = readFocusFailureNode(failureSurfaceFromDom({
    code: 'product-session.read.unavailable-target',
    ownerId: 'humanagent.ui.product-session',
    message: '该执行实例暂无正文读取入口。',
    nextAction: '返回任务看板后重新选择。',
  }))
  // The page collector builds these fields itself; hand-writing them here would
  // hide a collector that stops producing what the evaluator requires.
  const fields = unavailableSurfaceFields(collected, 1)
  assert.equal(fields.unavailableCount, 1)
  assert.equal(fields.unavailableCode, 'product-session.read.unavailable-target')
  assert.equal(fields.unavailableCodeRows, 1)
  assert.equal(fields.unavailableMessage, '该执行实例暂无正文读取入口。')
  const unavailable = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [],
    contractUnavailable: true,
    surface: focusSurface({
      messageCount: 0,
      messageEventIds: [],
      messageTexts: [],
      emptyCount: 0,
      ...fields,
    }),
  })
  assert.equal(unavailable.ok, true)
  assert.equal(unavailable.bodyState, 'unavailable')

  // A page that renders a second unavailable node is not the single typed
  // failure the evaluator accepts, even when the first node looks correct.
  const duplicated = focusSurface({
    messageCount: 0,
    messageEventIds: [],
    messageTexts: [],
    emptyCount: 0,
    ...unavailableSurfaceFields(collected, 2),
  })
  assert.equal(duplicated.unavailableCount, 2)
  assert.equal(duplicated.unavailableCode, '')
  const rejected = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [],
    contractUnavailable: true,
    surface: duplicated,
  })
  assert.equal(rejected.ok, false)
})

test('navigation evaluation rejects stale or foreign visible bodies', () => {
  const url = productUrl()

  // The response body belongs to the new target, but the page still shows the
  // previous target's message.
  const staleVisible = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt()],
    surface: focusSurface({
      messageEventIds: ['evt-old'],
      messageTexts: ['上一个 target 的旧正文'],
    }),
  })
  assert.equal(staleVisible.ok, false)
  assert.equal(staleVisible.bodyState, 'stale')

  // An explicit empty response must render an empty state, never the old body.
  const oldBodyAfterEmpty = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt({ body: sessionBody({ messages: [] }) })],
    surface: focusSurface({
      messageCount: 1,
      messageEventIds: ['evt-old'],
      messageTexts: ['上一个 target 的旧正文'],
    }),
  })
  assert.equal(oldBodyAfterEmpty.ok, false)
  assert.equal(oldBodyAfterEmpty.bodyState, 'stale')

  // A contract-unavailable target must also refuse a retained old body.
  const unavailableStale = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [],
    contractUnavailable: true,
    surface: focusSurface({
      messageCount: 1,
      messageEventIds: ['evt-old'],
      messageTexts: ['上一个 target 的旧正文'],
      unavailableCount: 1,
      unavailableCode: 'product-session.read.unavailable-target',
      unavailableCodeRows: 1,
      unavailableMessage: '该执行实例暂无正文读取入口。',
    }),
  })
  assert.equal(unavailableStale.ok, false)
  assert.equal(unavailableStale.bodyState, 'stale')
})

test('navigation evaluation rejects wrong scope, non-2xx, missing messages and wrong requests', () => {
  const url = productUrl()
  const otherScope = {
    ...taskScope,
    taskId: { scope: 'task', value: 'task-2' },
  }
  const otherTarget = {
    ...target,
    taskRef: { scope: 'task', value: 'task-2' },
    scope: otherScope,
  }

  // The response body describes another task scope.
  const wrongScope = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt({
      body: sessionBody({
        scope: otherScope,
        messages: [message('evt-2', '另一个 target 正文', otherTarget)],
      }),
    })],
    surface: focusSurface(),
  })
  assert.equal(wrongScope.ok, false)
  assert.equal(wrongScope.bodyState, 'scope')

  // A 500 response is a failed read even when a body and visible text exist.
  const failed500 = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt({ status: 500 })],
    surface: focusSurface(),
  })
  assert.equal(failed500.ok, false)
  assert.equal(failed500.bodyState, 'failed')

  // A 2xx body without a messages array is not a valid session body.
  const missingMessages = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt({ body: { boardIndex: { scope: taskScope } } })],
    surface: focusSurface(),
  })
  assert.equal(missingMessages.ok, false)
  assert.equal(missingMessages.bodyState, 'failed')

  // The response body's message targetRef must name the fixed target.
  const wrongBodyTarget = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt({
      body: sessionBody({ messages: [message('evt-2', '另一个 target 正文', otherTarget)] }),
    })],
    surface: focusSurface({
      messageEventIds: ['evt-2'],
      messageTexts: ['另一个 target 正文'],
    }),
  })
  assert.equal(wrongBodyTarget.ok, false)
  assert.equal(wrongBodyTarget.bodyState, 'target')

  // The request query must name the same task as the fixed target.
  const wrongRequest = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt({
      search: { projectKey: 'project-1', mode: 'rcc', taskId: 'task-2' },
    })],
    surface: focusSurface(),
  })
  assert.equal(wrongRequest.ok, false)
  assert.equal(wrongRequest.state, 'request')

  // The visible URL query must also describe the fixed target.
  const wrongUrlQuery = evaluateNavigationState({
    actualUrl: productUrl(target, { task: 'task-2' }),
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [sessionReceipt()],
    surface: focusSurface(),
  })
  assert.equal(wrongUrlQuery.ok, false)
  assert.equal(wrongUrlQuery.state, 'url')

  // A URL focus from another target cannot stand in for the fixed target.
  const wrongFocus = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: otherTarget,
    expectedScope: otherScope,
    receipts: [sessionReceipt()],
    surface: focusSurface(),
  })
  assert.equal(wrongFocus.ok, false)
  assert.equal(wrongFocus.state, 'url')

  // A missing receipt is not a successful body read.
  const noReceipt = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    receipts: [],
    surface: focusSurface(),
  })
  assert.equal(noReceipt.ok, false)
  assert.equal(noReceipt.state, 'request')
})

test('navigation evaluation rejects a session request without the fixed focus parameters', () => {
  const sessionTarget = {
    kind: 'session',
    sessionRef: { sourceKind: 'explicit-intake', sourceRef: 'intake-1' },
    taskRef: { scope: 'task', value: 'task-1' },
    scope: taskScope,
  }
  const url = productUrl(sessionTarget)
  const body = sessionBody({
    messages: [message('evt-1', '当前会话正文', sessionTarget)],
  })
  const missingSessionId = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: sessionTarget,
    expectedScope: taskScope,
    receipts: [sessionReceipt({ body })],
    surface: focusSurface(),
  })
  assert.equal(missingSessionId.ok, false)
  assert.equal(missingSessionId.state, 'request')

  const wrongSessionKind = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: sessionTarget,
    expectedScope: taskScope,
    receipts: [sessionReceipt({
      body,
      search: {
        projectKey: 'project-1',
        mode: 'rcc',
        taskId: 'task-1',
        sessionKind: 'inspection-occurrence',
        sessionId: 'intake-1',
      },
    })],
    surface: focusSurface(),
  })
  assert.equal(wrongSessionKind.ok, false)
  assert.equal(wrongSessionKind.state, 'request')
})
