/*
 * I module consumer: pending decisions, approval modal and Live intervention.
 *
 * Basis: plan §6 I and §8 T5/T6/T7/T9. The risky failures are a close gesture
 * that writes a rejection, approve/reject being sent as invented actions, an
 * inexact target or missing formal entry still submitting, a UI-supplied
 * principal granting authority, and an unknown readback being shown as denied
 * or retried without a person.
 *
 * Impact: a wrong task is released or stopped, and the visible receipt no
 * longer proves what the runtime accepted. Cost is one fake element adapter and
 * one fake transport; no HTTP, DOM library or browser is used here.
 *
 * This is module evidence only. The 390x844 real browser acceptance and the
 * mounted page remain with V/W and the page owners.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECISION_INTENT_ACTIONS,
  FORMAL_CONTROL_ACTIONS,
  ProductControlError,
  decisionActionLabel,
  formalActionForIntent,
  isExactControllableTarget,
  openDecisionModal,
  readbackState,
  renderControlReceipt,
  renderInterventionEntry,
  renderPendingDecision,
} from '../../docs/ui/product-control-view.js'

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
    disabled: false,
    hidden: false,
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
    focus() {
      node.focusCount += 1
      node.focused = true
      return node
    },
    blur() {
      node.focused = false
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

function createHost() {
  return createElement('div')
}

function walk(node) {
  return [node, ...(node.children ?? []).flatMap((child) => walk(child))]
}

function text(node) {
  return [node.textContent, ...(node.children ?? []).map((child) => text(child))]
    .filter(Boolean)
    .join(' ')
}

function withAttribute(node, name, value) {
  return walk(node).filter((candidate) => candidate.getAttribute(name) === value)
}

function oneWithAttribute(node, name, value) {
  const found = withAttribute(node, name, value)
  assert.equal(found.length, 1, `expected exactly one ${name}=${value}`)
  return found[0]
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

const taskA = { scope: 'task', value: 'task-a' }
const taskB = { scope: 'task', value: 'task-b' }
const scopeA = { kind: 'task', projectKey: 'project-a', mode: 'fake', taskId: taskA }
const scopeB = { kind: 'task', projectKey: 'project-a', mode: 'fake', taskId: taskB }
const targetA = { kind: 'interaction', taskRef: taskA, scope: scopeA }
const targetB = { kind: 'interaction', taskRef: taskB, scope: scopeB }
const mismatchedTarget = { kind: 'interaction', taskRef: taskB, scope: scopeA }
const sessionWithoutTask = {
  kind: 'session',
  sessionRef: { sourceKind: 'dsh', sourceRef: 'session-a' },
  scope: { kind: 'project', projectKey: 'project-a' },
}

function capability(taskId) {
  return {
    actionId: 'task.execute',
    capabilities: ['provider.execution'],
    scope: { organId: { scope: 'organ', value: 'humanagent' }, taskId },
  }
}

function grant(taskId, revision, state) {
  return {
    revision,
    requestId: `request-${revision}`,
    task: taskId,
    owner: 'server-resolved-principal',
    capability: capability(taskId),
    state,
    updatedAt: '2026-10-21T00:00:00.000Z',
  }
}

const grantedGrant = grant(taskA, 2, 'granted')
const grantedReadback = {
  grant: grantedGrant,
  commit: { commitId: 'commit-2', journalSeq: 2, recordDigest: 'digest-2' },
}
const revokedGrant = grant(taskA, 3, 'revoked')
const revokedReadback = {
  grant: revokedGrant,
  commit: { commitId: 'commit-3', journalSeq: 3, recordDigest: 'digest-3' },
}

const grantedReceipt = {
  taskId: taskA,
  owner: 'server-resolved-principal',
  readback: grantedReadback,
  authority: {
    grant: grantedGrant,
    commit: grantedReadback.commit,
    owner: 'server-resolved-principal',
    permissionRevision: 'permission-1',
  },
  receivedAt: '2026-10-21T00:00:01.000Z',
  execution: { state: 'running', operationId: 'operation-1' },
}

const revokedReceipt = {
  taskId: taskA,
  owner: 'server-resolved-principal',
  readback: revokedReadback,
  authority: null,
  receivedAt: '2026-10-21T00:00:02.000Z',
  execution: { state: 'stopped', operationId: 'operation-2' },
  stop: { state: 'stopped', operationId: 'operation-2' },
}

function decisionFor({
  target = targetA,
  actions = ['grant', 'revoke'],
  state = 'waiting',
  readback = { grant: null, commit: null },
  revision,
} = {}) {
  return {
    kind: 'task-grant',
    target,
    question: '是否允许该任务继续执行？',
    actions,
    state,
    readback,
    recoveryOwner: 'humanagent.runtime',
    ...(revision === undefined ? {} : { revision }),
  }
}

function createTransport(overrides = {}) {
  const calls = []
  const transport = {
    calls,
    async readTaskGrant(taskId, scope) {
      calls.push({ method: 'readTaskGrant', taskId, scope })
      if (typeof overrides.readTaskGrant === 'function') {
        return overrides.readTaskGrant(taskId, scope)
      }
      return overrides.readResult
    },
    async grantTaskControl(taskId, input, scope) {
      calls.push({ method: 'grantTaskControl', taskId, input, scope })
      if (typeof overrides.grantTaskControl === 'function') {
        return overrides.grantTaskControl(taskId, input, scope)
      }
      return overrides.grantResult ?? grantedReceipt
    },
    async revokeTaskGrant(taskId, input, scope) {
      calls.push({ method: 'revokeTaskGrant', taskId, input, scope })
      if (typeof overrides.revokeTaskGrant === 'function') {
        return overrides.revokeTaskGrant(taskId, input, scope)
      }
      return overrides.revokeResult ?? revokedReceipt
    },
  }
  if (overrides.stop !== undefined) {
    transport.stop = async (taskId) => {
      calls.push({ method: 'stop', taskId })
      return overrides.stop
    }
  }
  return transport
}

function assertNoAuthorityFields(input) {
  for (const key of [
    'owner',
    'principal',
    'principalOwner',
    'authority',
    'confirmedBy',
    'session',
    'token',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(input, key), false, `request must not carry ${key}`)
  }
}

test('T7: exact target requires one task identity shared by target and scope', () => {
  assert.equal(isExactControllableTarget(targetA), true)
  assert.equal(isExactControllableTarget(targetB), true)
  assert.equal(isExactControllableTarget(mismatchedTarget), false)
  assert.equal(isExactControllableTarget(sessionWithoutTask), false)
  assert.equal(isExactControllableTarget({
    kind: 'interaction',
    taskRef: taskA,
    scope: { kind: 'project', projectKey: 'project-a' },
  }), false)
})

test('T7: an inexact Live target renders a disabled entry and never fetches', async () => {
  const host = createHost()
  const transport = createTransport()
  const handle = renderInterventionEntry(host, sessionWithoutTask, transport, { element: createElement })

  assert.equal(handle.element.getAttribute('data-product-control-available'), 'false')
  const entry = oneWithAttribute(handle.element, 'data-product-control-action', 'open-intervention')
  assert.equal(entry.disabled, true)
  assert.equal(entry.getAttribute('aria-disabled'), 'true')
  assert.match(text(handle.element), /精确/)

  entry.click()
  await flush()
  assert.equal(transport.calls.length, 0)
})

test('T7: a mismatched target cannot submit and shows the refusal locally', async () => {
  const transport = createTransport()
  const handle = openDecisionModal({
    decision: decisionFor({ target: mismatchedTarget, readback: grantedReadback, revision: 2 }),
    transport,
    element: createElement,
    requestId: 'request-wrong-target',
  })

  await assert.rejects(
    () => handle.confirm('approve'),
    (error) => error instanceof ProductControlError && error.code === 'product-control.target.invalid',
  )
  assert.equal(transport.calls.length, 0)
  assert.match(text(handle.element), /目标/)
})

test('T5: approve maps to the formal grant call and renders receipt, authority and readback', async () => {
  assert.equal(DECISION_INTENT_ACTIONS.approve, 'grant')
  assert.equal(DECISION_INTENT_ACTIONS.reject, 'revoke')
  assert.equal(formalActionForIntent('approve'), 'grant')
  assert.equal(formalActionForIntent('reject'), 'revoke')
  assert.deepEqual([...FORMAL_CONTROL_ACTIONS], ['grant', 'revoke'])

  const transport = createTransport()
  const handle = openDecisionModal({
    decision: decisionFor({ readback: grantedReadback, revision: 2 }),
    transport,
    element: createElement,
    requestId: 'request-approve',
  })
  assert.equal(oneWithAttribute(handle.element, 'data-product-control-action', 'grant').textContent,
    decisionActionLabel('grant'))

  const receipt = await handle.confirm('approve')

  assert.equal(receipt, grantedReceipt)
  assert.equal(transport.calls.length, 1)
  assert.equal(transport.calls[0].method, 'grantTaskControl')
  assert.equal(transport.calls[0].taskId, 'task-a')
  assert.deepEqual(transport.calls[0].input, {
    requestId: 'request-approve',
    expectedRevision: 2,
  })
  assert.deepEqual(transport.calls[0].scope, { projectKey: 'project-a', mode: 'fake' })
  assertNoAuthorityFields(transport.calls[0].input)

  assert.match(text(oneWithAttribute(handle.element, 'data-product-role', 'control-receipt')), /running/)
  assert.match(text(oneWithAttribute(handle.element, 'data-product-role', 'control-authority')), /权限/)
  assert.match(text(oneWithAttribute(handle.element, 'data-product-role', 'control-readback')), /授权已确认/)
  assert.equal(handle.state().receipt, grantedReceipt)
})

test('T6: closing the approval modal writes nothing and blocks a late confirm', async () => {
  let closed = 0
  const transport = createTransport()
  const handle = openDecisionModal({
    decision: decisionFor({ readback: grantedReadback, revision: 2 }),
    transport,
    element: createElement,
    onClose: () => { closed += 1 },
  })

  oneWithAttribute(handle.element, 'data-product-role', 'close-control-modal').click()
  await flush()

  assert.equal(closed, 1)
  assert.equal(transport.calls.length, 0)
  await assert.rejects(
    () => handle.confirm('approve'),
    (error) => error instanceof ProductControlError && error.code === 'product-control.closed',
  )
  assert.equal(transport.calls.length, 0)
})

test('T6: only an explicit reject maps to revoke and its exact revision', async () => {
  const transport = createTransport()
  const handle = openDecisionModal({
    decision: decisionFor({ readback: grantedReadback, revision: 2 }),
    transport,
    element: createElement,
    requestId: 'request-reject',
  })

  assert.equal(transport.calls.length, 0)
  await handle.confirm('reject')

  assert.equal(transport.calls.length, 1)
  assert.equal(transport.calls[0].method, 'revokeTaskGrant')
  assert.deepEqual(transport.calls[0].input, {
    requestId: 'request-reject',
    expectedRevision: 2,
  })
  assertNoAuthorityFields(transport.calls[0].input)
  assert.match(text(oneWithAttribute(handle.element, 'data-product-role', 'control-readback')), /授权已撤销/)
})

test('T6: an unknown readback stays unknown, is not denied, and is never auto-retried', async () => {
  const unknownReceipt = {
    taskId: taskA,
    owner: 'server-resolved-principal',
    receivedAt: '2026-10-21T00:00:03.000Z',
    execution: { state: 'unknown' },
  }
  const transport = createTransport({ grantResult: unknownReceipt })
  const handle = openDecisionModal({
    decision: decisionFor({ readback: grantedReadback, revision: 2 }),
    transport,
    element: createElement,
    requestId: 'request-unknown',
  })

  await handle.confirm('approve')
  await flush()

  assert.equal(transport.calls.length, 1)
  const readback = text(oneWithAttribute(handle.element, 'data-product-role', 'control-readback'))
  assert.match(readback, /未知/)
  assert.match(readback, /不会自动重试/)
  assert.doesNotMatch(readback, /denied|deny|拒绝/i)
  assert.equal(readbackState(undefined).kind, 'unknown')
  assert.equal(readbackState({ grant: grantedGrant, commit: null }).kind, 'unknown')
  assert.equal(readbackState({ grant: null, commit: null }).kind, 'absent')

  await flush()
  assert.equal(transport.calls.length, 1)
})

test('T6: a late receipt stays bound to its own target and never rewrites a new focus', async () => {
  let resolveGrant
  const deferredGrant = new Promise((resolve) => { resolveGrant = resolve })
  const transportA = createTransport({ grantTaskControl: () => deferredGrant })
  const handleA = openDecisionModal({
    decision: decisionFor({ target: targetA, readback: grantedReadback, revision: 2 }),
    transport: transportA,
    element: createElement,
    requestId: 'request-a',
  })
  const pendingA = handleA.confirm('approve')

  const transportB = createTransport()
  const handleB = openDecisionModal({
    decision: decisionFor({ target: targetB, readback: { grant: null, commit: null } }),
    transport: transportB,
    element: createElement,
    requestId: 'request-b',
  })

  resolveGrant(grantedReceipt)
  const receiptA = await pendingA

  assert.equal(receiptA, grantedReceipt)
  assert.equal(handleB.state().receipt, undefined)
  assert.equal(transportB.calls.length, 0)
  assert.doesNotMatch(text(handleB.element), /operation-1/)
  assert.match(text(handleA.element), /running/)
})

test('T7: a missing formal transport method refuses before any fetch', async () => {
  const transport = createTransport()
  delete transport.grantTaskControl
  const handle = openDecisionModal({
    decision: decisionFor({ readback: grantedReadback, revision: 2 }),
    transport,
    element: createElement,
  })

  await assert.rejects(
    () => handle.confirm('approve'),
    (error) => error instanceof ProductControlError
      && error.code === 'product-control.transport.unavailable',
  )
  assert.equal(transport.calls.length, 0)
})

test('T7: a pending object without a formal action never renders an approval button', () => {
  const attentionDecision = {
    kind: 'attention-decision',
    target: targetA,
    attention: { attentionId: { scope: 'attention', value: 'attention-a' } },
    question: '需要人工关注',
    actions: [],
    state: 'unavailable',
    unavailableReason: '没有公开的 Attention 处置路由',
    recoveryOwner: 'humanagent.runtime',
  }
  const host = createHost()
  renderPendingDecision(host, attentionDecision, { element: createElement })

  assert.equal(withAttribute(host, 'data-product-control-action', 'grant').length, 0)
  assert.equal(withAttribute(host, 'data-product-control-action', 'revoke').length, 0)
  assert.match(text(host), /没有公开的 Attention 处置路由/)
  assert.match(text(host), /humanagent\.runtime/)

  assert.throws(
    () => openDecisionModal({
      decision: attentionDecision,
      transport: createTransport(),
      element: createElement,
    }),
    (error) => error instanceof ProductControlError
      && error.code === 'product-control.no-formal-action',
  )
})

test('T6/T7: receipt, authority and readback are separate owner facts', () => {
  const host = createHost()
  renderControlReceipt(host, {
    taskId: taskA,
    owner: 'server-resolved-principal',
    readback: undefined,
    authority: undefined,
    execution: { state: 'unknown' },
  }, { element: createElement })

  assert.match(text(oneWithAttribute(host, 'data-product-role', 'control-receipt')), /unknown/)
  assert.match(text(oneWithAttribute(host, 'data-product-role', 'control-authority')), /权限状态未提供/)
  assert.match(text(oneWithAttribute(host, 'data-product-role', 'control-readback')), /未知/)
  assert.doesNotMatch(text(host), /denied|拒绝/i)
})

test('T9 module: modal is a labelled dialog with native buttons and restores opener focus', async () => {
  const opener = createElement('button', '打开审批')
  const handle = openDecisionModal({
    decision: decisionFor({ readback: grantedReadback, revision: 2 }),
    transport: createTransport(),
    element: createElement,
    opener,
  })

  assert.equal(handle.element.getAttribute('role'), 'dialog')
  assert.equal(handle.element.getAttribute('aria-modal'), 'true')
  assert.ok(handle.element.getAttribute('aria-labelledby'))
  const buttons = walk(handle.element).filter((node) => node.tagName === 'BUTTON')
  assert.ok(buttons.length >= 3)
  for (const button of buttons) {
    assert.equal(button.type, 'button')
    assert.ok(button.textContent.trim().length > 0 || button.getAttribute('aria-label'))
  }
  assert.equal(buttons[0].focused, true)

  handle.close()
  assert.equal(opener.focusCount, 1)
})
