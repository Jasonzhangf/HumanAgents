/**
 * Human-readable decision, approval and live-intervention controls.
 *
 * This module owns presentation and the tiny call contract around the formal
 * task-control actions. It never owns HTTP, the server principal, authorization
 * or a second decision store:
 *
 *  - `renderPendingDecision(host, decision, handlers)` renders one C-contract
 *    `ProductPendingDecision`. Only the `task-grant` branch carries a formal
 *    action. The `task-input-request` and `attention-decision` branches have no
 *    public disposal route, so they render their real unavailable reason and
 *    never grow an approve/reject button.
 *  - `openDecisionModal(...)` opens the approval surface. A close (or a
 *    navigation away that drops the modal) writes nothing. Only an explicit
 *    approve/reject calls the injected transport, and approve/reject are just
 *    UI labels for the formal `grant`/`revoke` actions.
 *  - `renderInterventionEntry(host, target, transport)` renders the Live human
 *    intervention entry. It is disabled unless the target is exact. Rendering
 *    never fetches; an explicit click reads the current grant readback first.
 *  - `renderControlReceipt(host, receipt, options)` keeps the action receipt,
 *    the server authority and the durable grant readback separate. An unknown
 *    readback stays unknown: it is never rendered as a denial and never causes
 *    an automatic resubmission.
 *
 * Injected transport (the default is `createRuntimeApi()`):
 *
 *   readTaskGrant(taskId, scope)                            -> TaskGrantControlRead
 *   grantTaskControl(taskId, { requestId, expectedRevision }, scope)  -> TaskGrantControlReceipt
 *   revokeTaskGrant(taskId, { requestId, expectedRevision }, scope)   -> TaskGrantControlReceipt
 *   stop(taskId)                                            -> { state, operationId? }  // optional
 *
 * `taskId` is the string value of the exact `ProductTargetRef.taskRef`.
 * `scope` is exactly `{ projectKey, mode }`. The transport owns the HTTP edge
 * and the session cookie. This view never receives or sends a principal,
 * owner, authority or confirmed-by field.
 */

import { createRuntimeApi } from './runtime-api.js'

export const FORMAL_CONTROL_ACTIONS = Object.freeze(['grant', 'revoke'])

/** The only intent vocabulary the UI exposes. It maps onto formal actions. */
export const DECISION_INTENT_ACTIONS = Object.freeze({
  approve: 'grant',
  reject: 'revoke',
})

/** Reverse mapping used when a formal action button reports its UI intent. */
export const DECISION_ACTION_INTENTS = Object.freeze({
  grant: 'approve',
  revoke: 'reject',
})

export const CONTROL_ACTION_LABELS = Object.freeze({
  grant: '批准继续',
  revoke: '拒绝并撤销执行',
})

export const PENDING_DECISION_TITLES = Object.freeze({
  'task-grant': '等待你批准继续',
  'task-input-request': '等待补充输入',
  'attention-decision': '需要人工关注',
})

export const READBACK_LABELS = Object.freeze({
  granted: '授权已确认',
  revoked: '授权已撤销',
  absent: '尚无执行授权',
  unknown: '授权状态未知',
})

const DECISION_STATE_LABELS = Object.freeze({
  waiting: '等待决定',
  resolved: '已处理',
  revoked: '已撤销',
  unavailable: '当前没有正式处置入口',
  unknown: '状态未知',
})

/**
 * These keys are authority. The view must never put them in a request body,
 * query or header. The server resolves the principal from the session cookie.
 */
const FORBIDDEN_AUTHORITY_KEYS = Object.freeze([
  'owner',
  'ownerId',
  'principal',
  'principalOwner',
  'authority',
  'confirmedBy',
  'confirmedByOwner',
  'token',
  'session',
])

let runtimeTransport
let modalSerial = 0

function defaultTransport() {
  runtimeTransport ??= createRuntimeApi()
  return runtimeTransport
}

export class ProductControlError extends Error {
  constructor(code, message, nextAction) {
    super(message)
    this.name = 'ProductControlError'
    this.code = code
    this.nextAction = nextAction ?? 'refresh the exact target and reopen the control'
  }
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isTaskId(value) {
  return record(value) && value.scope === 'task' && nonEmptyText(value.value)
}

function sameTaskId(left, right) {
  return isTaskId(left) && isTaskId(right) && left.value === right.value
}

function isTaskScope(scope, taskRef) {
  return record(scope)
    && scope.kind === 'task'
    && nonEmptyText(scope.projectKey)
    && (scope.mode === 'fake' || scope.mode === 'rcc' || scope.mode === 'dsh')
    && isTaskId(scope.taskId)
    && (taskRef === undefined || sameTaskId(scope.taskId, taskRef))
}

/**
 * A target is controllable only when its owner-provided identity is complete
 * and the read scope names the same task. A session target qualifies only when
 * it carries an exact task ref and a task scope; a project-only session is a
 * reading target, not a control target.
 */
export function isExactControllableTarget(target) {
  if (!record(target)) return false
  if (target.kind === 'interaction') {
    return isTaskId(target.taskRef) && isTaskScope(target.scope, target.taskRef)
  }
  if (target.kind === 'execution-instance') {
    return record(target.instance)
      && isTaskId(target.taskRef)
      && isTaskScope(target.scope, target.taskRef)
  }
  if (target.kind === 'session') {
    return record(target.sessionRef)
      && nonEmptyText(target.sessionRef.sourceKind)
      && nonEmptyText(target.sessionRef.sourceRef)
      && isTaskId(target.taskRef)
      && isTaskScope(target.scope, target.taskRef)
  }
  return false
}

function runtimeTarget(target) {
  if (!isExactControllableTarget(target)) return null
  return {
    taskId: target.taskRef.value,
    taskRef: target.taskRef,
    scope: {
      projectKey: target.scope.projectKey,
      mode: target.scope.mode,
    },
  }
}

export function formalActionForIntent(intent) {
  const action = DECISION_INTENT_ACTIONS[intent] ?? (FORMAL_CONTROL_ACTIONS.includes(intent) ? intent : undefined)
  if (action === undefined) {
    throw new ProductControlError(
      'product-control.action.invalid',
      `未识别的决定意图：${String(intent)}`,
      'use approve/reject or the formal grant/revoke action',
    )
  }
  return action
}

export function decisionActionLabel(action) {
  return CONTROL_ACTION_LABELS[action] ?? String(action)
}

/**
 * Read a durable grant readback without inventing a state.
 *
 * `absent` means the owner explicitly returned `grant: null, commit: null`.
 * `unknown` means the readback is missing, malformed or not yet a recognised
 * state. `unknown` is never converted into a denial.
 */
export function readbackState(value) {
  const readback = record(value) && Object.prototype.hasOwnProperty.call(value, 'readback')
    ? value.readback
    : value
  if (!record(readback)) {
    return {
      kind: 'unknown',
      grant: null,
      commit: null,
      label: READBACK_LABELS.unknown,
      reason: 'owner 未提供可读的 readback',
    }
  }
  const grant = readback.grant ?? null
  const commit = readback.commit ?? null
  if (grant === null && commit === null) {
    return { kind: 'absent', grant: null, commit: null, label: READBACK_LABELS.absent }
  }
  if (!record(grant)
    || !record(commit)
    || !nonEmptyText(commit.commitId)
    || !Number.isSafeInteger(grant.revision)
    || grant.revision < 0) {
    return {
      kind: 'unknown',
      grant: record(grant) ? grant : null,
      commit: record(commit) ? commit : null,
      label: READBACK_LABELS.unknown,
      reason: 'readback 缺少 grant 或精确 commit',
    }
  }
  if (grant.state !== 'granted' && grant.state !== 'revoked') {
    return {
      kind: 'unknown',
      grant,
      commit,
      label: READBACK_LABELS.unknown,
      reason: `未识别的授权状态 ${String(grant.state)}`,
    }
  }
  return {
    kind: grant.state,
    grant,
    commit,
    label: grant.state === 'granted' ? READBACK_LABELS.granted : READBACK_LABELS.revoked,
    revision: grant.revision,
  }
}

function expectedRevisionFor(subject, action) {
  if (Number.isSafeInteger(subject?.expectedRevision) && subject.expectedRevision >= 0) {
    return subject.expectedRevision
  }
  const readback = readbackState(subject?.readback)
  // Never guess a revision from an unknown readback.
  if (readback.kind === 'unknown') return undefined
  if (Number.isSafeInteger(subject?.revision) && subject.revision >= 0) {
    return subject.revision
  }
  if (action === 'grant') {
    if (readback.kind === 'absent') return 0
    return Number.isSafeInteger(readback.revision) ? readback.revision : undefined
  }
  if (readback.kind === 'granted' || readback.kind === 'revoked') {
    return Number.isSafeInteger(readback.revision) ? readback.revision : undefined
  }
  return undefined
}

function requireHost(host) {
  if (!host || typeof host.replaceChildren !== 'function' || typeof host.append !== 'function') {
    throw new TypeError('product control view host must be a DOM element')
  }
}

function resolveElementFactory(host, options) {
  if (typeof options?.element === 'function') return options.element
  const documentRef = host?.ownerDocument
    ?? (typeof document === 'undefined' ? undefined : document)
  if (typeof documentRef?.createElement !== 'function') {
    throw new TypeError('product control view requires an element factory or a DOM host')
  }
  return (tag, text, className) => {
    const node = documentRef.createElement(tag)
    if (text !== undefined) node.textContent = String(text)
    if (className) node.className = className
    return node
  }
}

function markRole(node, name) {
  node.setAttribute('data-product-role', name)
  return node
}

function makeButton(make, label, disabled, role, action) {
  const button = make('button', label, 'button')
  button.type = 'button'
  button.setAttribute('type', 'button')
  button.setAttribute('data-product-role', role)
  if (action !== undefined) button.setAttribute('data-product-control-action', action)
  button.disabled = Boolean(disabled)
  if (disabled) button.setAttribute('aria-disabled', 'true')
  return button
}

function targetNode(make, target) {
  const node = make('p', undefined, 'product-control-target')
  markRole(node, 'control-target')
  const exact = runtimeTarget(target)
  if (exact === null) {
    node.textContent = '目标不精确，无法提交正式动作。缺少精确的 task、projectKey 或 mode。'
    node.setAttribute('data-target-exact', 'false')
    return node
  }
  node.textContent = `目标：${exact.taskId} · ${exact.scope.projectKey} · ${exact.scope.mode}`
  node.setAttribute('data-target-exact', 'true')
  node.setAttribute('data-task-id', exact.taskId)
  return node
}

function readbackNode(make, state, role = 'control-readback') {
  const node = make('p', undefined, 'product-control-readback')
  markRole(node, role)
  node.setAttribute('data-readback-state', state.kind)
  let text = state.label
  if (Number.isSafeInteger(state.revision)) text += ` · revision ${state.revision}`
  if (nonEmptyText(state.reason)) text += ` · ${state.reason}`
  if (state.kind === 'unknown') text += ' · 请刷新读取精确状态；不会自动重试。'
  node.textContent = text
  return node
}

function decisionStateNode(make, decision) {
  const state = typeof decision?.state === 'string' ? decision.state : 'unknown'
  const node = make('p', DECISION_STATE_LABELS[state] ?? state, 'product-control-decision-state')
  node.setAttribute('data-decision-state', state)
  return node
}

function actionControls(make, decision, handlers) {
  const container = make('div', undefined, 'product-control-actions')
  container.setAttribute('role', 'group')
  container.setAttribute('aria-label', '审批动作')

  const actions = Array.isArray(decision?.actions)
    ? decision.actions.filter((action) => FORMAL_CONTROL_ACTIONS.includes(action))
    : []
  if (actions.length === 0) {
    container.append(make('p', '没有正式动作入口，不提供批准或拒绝。', 'product-control-unavailable'))
    return container
  }

  const target = runtimeTarget(decision.target)
  const readback = readbackState(decision.readback)
  const questionKnown = nonEmptyText(decision.question)
  const handlerKnown = typeof handlers?.onIntent === 'function'

  for (const action of actions) {
    const revision = expectedRevisionFor(
      { revision: decision.revision, readback: decision.readback },
      action,
    )
    const disabled = target === null
      || revision === undefined
      || !questionKnown
      || !handlerKnown
      || readback.kind === 'unknown'
    const button = makeButton(
      make,
      decisionActionLabel(action),
      disabled,
      `decision-${action}`,
      action,
    )
    button.setAttribute('aria-label', `${decisionActionLabel(action)}（正式动作 ${action}）`)
    button.addEventListener('click', () => {
      if (button.disabled) return
      handlers.onIntent(DECISION_ACTION_INTENTS[action], decision)
    })
    container.append(button)
  }

  if (target === null) {
    container.append(make('p', '精确目标缺失，动作已禁用。', 'muted'))
  } else if (readback.kind === 'unknown') {
    container.append(make('p', '授权状态未知，先刷新再决定；不会自动重试。', 'muted'))
  } else if (!questionKnown) {
    container.append(make('p', '该对象未提供明确问题，动作已禁用。', 'muted'))
  } else if (!handlerKnown) {
    container.append(make('p', '未连接正式动作入口，动作已禁用。', 'muted'))
  }
  return container
}

/**
 * Render one pending decision card. The card is a pure rendering surface: the
 * caller supplies `handlers.onIntent(intent, decision)` and owns the modal or
 * the formal call. No transport is touched here.
 */
export function renderPendingDecision(host, decision, handlers = {}) {
  requireHost(host)
  const make = resolveElementFactory(host, handlers)
  host.replaceChildren()

  const root = make('section', undefined, 'product-control-decision')
  root.setAttribute('data-product-pending-decision', typeof decision?.kind === 'string' ? decision.kind : 'unknown')
  root.setAttribute('aria-label', '待处理决定')

  const title = PENDING_DECISION_TITLES[decision?.kind] ?? '待处理决定'
  root.append(make('h2', title, 'product-control-decision-title'))

  const question = nonEmptyText(decision?.question)
    ? decision.question
    : '该对象未提供问题或选项，因此不能在此批准。'
  root.append(make('p', question, 'product-control-decision-question'))
  root.append(decisionStateNode(make, decision))

  if (decision?.kind === 'task-grant') {
    root.append(targetNode(make, decision.target))
    root.append(readbackNode(make, readbackState(decision.readback)))
    root.append(actionControls(make, decision, handlers))
  } else {
    if (nonEmptyText(decision?.unavailableReason)) {
      root.append(make('p', decision.unavailableReason, 'product-control-unavailable'))
    }
    if (nonEmptyText(decision?.recoveryOwner)) {
      root.append(make('p', `恢复责任：${decision.recoveryOwner}`, 'muted'))
    }
    // No approval control: the object's real state has no formal route.
  }

  host.append(root)
  return root
}

function transportMethod(transport, action) {
  const method = action === 'grant' ? 'grantTaskControl' : 'revokeTaskGrant'
  return typeof transport?.[method] === 'function' ? transport[method].bind(transport) : null
}

function requestIdFor(options, action, target) {
  if (nonEmptyText(options?.requestId)) return options.requestId
  const suffix = Date.now().toString(36)
  return `product-control:${action}:${target.taskId}:${suffix}`
}

function assertFormalRequest(input) {
  for (const key of FORBIDDEN_AUTHORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new ProductControlError(
        'product-control.authority.forbidden',
        `UI 不得提交授权字段 ${key}`,
        'let the server resolve the principal from the session',
      )
    }
  }
  for (const key of Object.keys(input)) {
    if (key !== 'requestId' && key !== 'expectedRevision') {
      throw new ProductControlError(
        'product-control.request.invalid',
        `正式动作请求包含未允许字段 ${key}`,
        'send only requestId and expectedRevision',
      )
    }
  }
}

function safeCall(callback, ...args) {
  if (typeof callback !== 'function') return undefined
  try {
    return callback(...args)
  } catch (error) {
    // A presentation callback must not destroy the typed receipt state.
    return { callbackError: error }
  }
}

function resolveSubject({ decision, control }) {
  if (decision !== undefined) {
    if (!record(decision) || decision.kind !== 'task-grant') {
      throw new ProductControlError(
        'product-control.no-formal-action',
        '该对象没有正式可执行动作，不能打开审批弹窗。',
        'only a task-grant waiting item has a formal grant/revoke route',
      )
    }
    const actions = Array.isArray(decision.actions)
      ? decision.actions.filter((action) => FORMAL_CONTROL_ACTIONS.includes(action))
      : []
    if (actions.length === 0) {
      throw new ProductControlError(
        'product-control.no-formal-action',
        'task-grant 决定未提供 grant 或 revoke 动作。',
        'repair the owner read before offering approval',
      )
    }
    return {
      decision,
      target: decision.target,
      actions,
      question: decision.question,
      state: decision.state,
      readback: decision.readback,
      revision: decision.revision,
      expectedRevision: undefined,
    }
  }

  if (control !== undefined) {
    if (!record(control)) {
      throw new ProductControlError(
        'product-control.target.invalid',
        '人工介入缺少 control 对象。',
        'pass the exact target and its readback',
      )
    }
    const readback = readbackState(control.readback)
    const actions = Array.isArray(control.actions)
      ? control.actions.filter((action) => FORMAL_CONTROL_ACTIONS.includes(action))
      : readback.kind === 'granted'
        ? ['revoke']
        : readback.kind === 'revoked' || readback.kind === 'absent'
          ? ['grant']
          : []
    if (actions.length === 0) {
      throw new ProductControlError(
        'product-control.readback.unknown',
        '当前授权状态未知，不能提交正式动作。',
        'refresh the exact grant readback and reopen the entry',
      )
    }
    return {
      control,
      target: control.target,
      actions,
      question: control.question ?? '对该任务执行人工介入？',
      state: 'waiting',
      readback: control.readback,
      revision: readback.revision,
      expectedRevision: control.expectedRevision,
    }
  }

  throw new ProductControlError(
    'product-control.subject.missing',
    '审批弹窗缺少决定或介入对象。',
    'pass a ProductPendingDecision or an exact control target',
  )
}

/**
 * Open the approval modal. Closing writes no decision. An explicit approve or
 * reject calls exactly one formal transport method and renders the owner's
 * receipt. A receipt or a failure disables further submissions from this
 * modal; the caller must close and reopen with a fresh read to try again.
 *
 * Options:
 *   host, element             mount point and element factory
 *   decision                  owner `ProductPendingDecision` (task-grant)
 *   control                   `{ target, readback, authority? }` for a live entry
 *   transport                 injected runtime-api surface
 *   requestId, expectedRevision
 *   opener                    element whose focus is restored on close
 *   onReceipt(receipt, context), onError(error, context), onClose(context)
 */
export function openDecisionModal(options = {}) {
  const subject = resolveSubject(options)
  const transport = options.transport ?? defaultTransport()
  const host = options.host
  const make = resolveElementFactory(host, options)
  const target = runtimeTarget(subject.target)
  const readback = readbackState(subject.readback)

  const state = {
    closed: false,
    busy: false,
    action: undefined,
    receipt: undefined,
    error: undefined,
    pending: undefined,
  }
  let handle

  const root = make('div', undefined, 'product-control-modal')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  const titleId = `product-control-title-${++modalSerial}`
  root.setAttribute('aria-labelledby', titleId)

  const title = make('h2', options.title ?? '审批执行授权', 'product-control-modal-title')
  title.setAttribute('id', titleId)
  root.append(title)
  root.append(make('p', subject.question ?? '对该任务执行人工介入？', 'product-control-question'))
  root.append(targetNode(make, subject.target))
  root.append(readbackNode(make, readback, 'control-readback-preview'))

  const status = make('p', '', 'product-control-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  root.append(status)

  const receiptHost = make('div', undefined, 'product-control-receipt-host')
  root.append(receiptHost)

  const actions = make('div', undefined, 'product-control-actions')
  actions.setAttribute('role', 'group')
  actions.setAttribute('aria-label', '审批动作')
  const actionButtons = []

  for (const action of subject.actions) {
    const revision = expectedRevisionFor(subject, action)
    const disabled = target === null
      || revision === undefined
      || readback.kind === 'unknown'
      || !nonEmptyText(subject.question)
      || transportMethod(transport, action) === null
    const button = makeButton(make, decisionActionLabel(action), disabled, `decision-${action}`, action)
    button.setAttribute('aria-label', `${decisionActionLabel(action)}（正式动作 ${action}）`)
    button.addEventListener('click', () => {
      if (button.disabled) return
      void confirm(DECISION_ACTION_INTENTS[action])
    })
    actionButtons.push({ action, button, revision })
    actions.append(button)
  }

  const closeButton = makeButton(make, '关闭', false, 'close-control-modal', 'close')
  closeButton.setAttribute('aria-label', '关闭审批，不写任何决定')
  closeButton.addEventListener('click', () => handle.close())
  actions.append(closeButton)
  root.append(actions)

  if (target === null) {
    root.append(make('p', '精确目标缺失，动作已禁用。', 'muted'))
  } else if (readback.kind === 'unknown') {
    root.append(make('p', '授权状态未知，先刷新再决定；不会自动重试。', 'muted'))
  } else if (!nonEmptyText(subject.question)) {
    root.append(make('p', '该对象未提供明确问题，动作已禁用。', 'muted'))
  }

  function updateButtons() {
    const finished = state.receipt !== undefined || state.error !== undefined
    for (const { action, button, revision } of actionButtons) {
      const blocked = state.closed
        || state.busy
        || finished
        || target === null
        || revision === undefined
        || readback.kind === 'unknown'
        || !nonEmptyText(subject.question)
        || transportMethod(transport, action) === null
      button.disabled = blocked
      if (blocked) button.setAttribute('aria-disabled', 'true')
    }
  }

  async function confirm(intentOrAction) {
    if (state.closed) {
      throw new ProductControlError(
        'product-control.closed',
        '弹窗已关闭，未提交决定。',
        'reopen the approval for an explicit decision',
      )
    }
    if (state.busy) return state.pending
    if (state.receipt !== undefined) return state.receipt
    if (state.error !== undefined) throw state.error

    const action = formalActionForIntent(intentOrAction)
    if (!subject.actions.includes(action)) {
      throw new ProductControlError(
        'product-control.action.not-offered',
        `该决定未提供 ${action} 动作。`,
        'use one of the actions the owner read offered',
      )
    }
    if (target === null) {
      const error = new ProductControlError(
        'product-control.target.invalid',
        '目标不精确，未提交正式动作。',
        'open the control from an exact task target',
      )
      state.error = error
      if (!state.closed) renderControlReceipt(receiptHost, error, { element: make })
      updateButtons()
      throw error
    }

    const method = transportMethod(transport, action)
    if (method === null) {
      const error = new ProductControlError(
        'product-control.transport.unavailable',
        `缺少正式 ${action} 动作入口。`,
        'inject the runtime-api task-control surface',
      )
      state.error = error
      if (!state.closed) renderControlReceipt(receiptHost, error, { element: make })
      updateButtons()
      throw error
    }

    const revision = expectedRevisionFor(subject, action)
    if (revision === undefined) {
      const error = new ProductControlError(
        'product-control.revision.unavailable',
        '缺少可用的正式 revision，未提交动作。',
        'refresh the exact grant readback',
      )
      state.error = error
      if (!state.closed) renderControlReceipt(receiptHost, error, { element: make })
      updateButtons()
      throw error
    }
    if (readback.kind === 'unknown') {
      const error = new ProductControlError(
        'product-control.readback.unknown',
        '授权状态未知，未提交动作，也不会自动重试。',
        'refresh the exact grant readback',
      )
      state.error = error
      if (!state.closed) renderControlReceipt(receiptHost, error, { element: make })
      updateButtons()
      throw error
    }

    const input = {
      requestId: requestIdFor(options, action, target),
      expectedRevision: revision,
    }
    assertFormalRequest(input)

    state.busy = true
    state.action = action
    updateButtons()
    status.textContent = action === 'grant' ? '正在提交批准…' : '正在提交拒绝…'

    state.pending = (async () => {
      try {
        const receipt = await method(target.taskId, input, target.scope)
        state.receipt = receipt
        if (!state.closed) renderControlReceipt(receiptHost, receipt, { element: make, action })
        safeCall(options.onReceipt, receipt, {
          target: subject.target,
          action,
          requestId: input.requestId,
        })
        return receipt
      } catch (error) {
        state.error = error
        if (!state.closed) renderControlReceipt(receiptHost, error, { element: make, action })
        safeCall(options.onError, error, {
          target: subject.target,
          action,
          requestId: input.requestId,
        })
        throw error
      } finally {
        state.busy = false
        state.pending = undefined
        updateButtons()
        if (!state.closed) {
          status.textContent = state.receipt !== undefined
            ? '决定已提交；请以回执为准。'
            : state.error !== undefined
              ? '提交失败；请刷新后再打开审批。'
              : ''
        }
      }
    })()

    return state.pending
  }

  function close() {
    if (state.closed) return
    state.closed = true
    if (typeof root.remove === 'function') root.remove()
    if (host && typeof host.removeChild === 'function' && root.parentNode === host) {
      host.removeChild(root)
    }
    updateButtons()
    if (options.opener && typeof options.opener.focus === 'function') options.opener.focus()
    safeCall(options.onClose, { target: subject.target, wroteDecision: false })
  }

  function snapshot() {
    return Object.freeze({
      closed: state.closed,
      busy: state.busy,
      action: state.action,
      receipt: state.receipt,
      error: state.error,
      target: subject.target,
      actions: Object.freeze([...subject.actions]),
    })
  }

  handle = {
    element: root,
    confirm,
    decide: confirm,
    close,
    state: snapshot,
  }

  if (host) host.append(root)
  const focusTarget = actionButtons.find(({ button }) => !button.disabled)?.button ?? closeButton
  if (typeof focusTarget.focus === 'function') focusTarget.focus()
  return handle
}

function renderControlFailure(host, error, make) {
  const node = make('div', undefined, 'product-control-error')
  node.setAttribute('role', 'alert')
  node.append(
    make('p', `${error?.code ?? 'product-control.failed'} · ${error?.ownerId ?? 'owner 未提供'}`, 'product-control-error-code'),
    make('p', error?.message ?? String(error), 'product-control-error-message'),
    make('p', error?.nextAction ?? '刷新后重试', 'product-control-error-next'),
  )
  host.append(node)
  return node
}

/**
 * Render one typed receipt. The three facts stay separate:
 *   execution  - what the formal action caused
 *   authority  - what the server authorized for this principal
 *   readback   - the durable grant and its exact commit
 *
 * A missing or malformed readback renders as unknown. It is never shown as a
 * denial and it never triggers another request.
 */
export function renderControlReceipt(host, receipt, options = {}) {
  requireHost(host)
  const make = resolveElementFactory(host, options)
  host.replaceChildren()

  if (receipt?.code && (receipt?.message || receipt?.nextAction)) {
    const root = make('section', undefined, 'product-control-receipt')
    markRole(root, 'control-receipt')
    root.setAttribute('data-receipt-kind', 'error')
    renderControlFailure(root, receipt, make)
    host.append(root)
    return root
  }

  const root = make('section', undefined, 'product-control-receipt')
  markRole(root, 'control-receipt')
  root.setAttribute('data-receipt-kind', 'receipt')

  const execution = receipt?.execution
    ?? receipt?.stop
    ?? (nonEmptyText(receipt?.state) ? receipt : undefined)
  const executionNode = make('div', undefined, 'product-control-execution')
  markRole(executionNode, 'control-execution')
  if (record(execution) && nonEmptyText(execution.state)) {
    const operation = nonEmptyText(execution.operationId) ? ` · operation=${execution.operationId}` : ''
    executionNode.append(make('p', `执行结果：${execution.state}${operation}`, 'product-control-execution-line'))
  } else {
    executionNode.append(make('p', '执行结果未提供', 'product-control-execution-line'))
  }
  root.append(executionNode)

  if (options.includeAuthority !== false) {
    const authorityNode = make('div', undefined, 'product-control-authority')
    markRole(authorityNode, 'control-authority')
    if (record(receipt?.authority)) {
      const owner = nonEmptyText(receipt.authority.owner) ? ` · owner=${receipt.authority.owner}` : ''
      const revision = nonEmptyText(receipt.authority.permissionRevision)
        ? ` · permissionRevision=${receipt.authority.permissionRevision}`
        : ''
      authorityNode.append(make('p', `权限状态：已确认${owner}${revision}`, 'product-control-authority-line'))
    } else {
      authorityNode.append(make('p', '权限状态未提供', 'product-control-authority-line'))
    }
    root.append(authorityNode)
  }

  if (options.includeReadback !== false) {
    root.append(readbackNode(make, readbackState(receipt?.readback)))
  }

  host.append(root)
  return root
}

/**
 * Render the Live human-intervention entry for one exact target.
 *
 * Rendering never reads or writes. An explicit click on 介入 performs one
 * read-only grant read before opening the approval surface; an explicit click
 * on 停止执行 performs the existing formal stop action once. Both controls are
 * native buttons and both are disabled when the target is not exact.
 *
 * Options:
 *   element, modalHost        element factory and where a self-opened modal mounts
 *   onIntervene(context)      let the page owner mount the modal instead
 *   onReceipt(receipt, context), onError(error, context), onClose(context)
 */
export function renderInterventionEntry(host, target, transport, options = {}) {
  requireHost(host)
  const make = resolveElementFactory(host, options)
  host.replaceChildren()

  const exact = isExactControllableTarget(target)
  const root = make('section', undefined, 'product-intervention-entry')
  root.setAttribute('data-product-intervention-entry', '')
  root.setAttribute('data-product-control-available', exact ? 'true' : 'false')
  root.setAttribute('aria-label', '人工介入')
  root.append(make('h2', '人工介入', 'product-control-title'))

  const status = make('p', '', 'product-control-status')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')

  if (!exact) {
    status.textContent = '目标不精确，无法提交正式动作。缺少精确的 task、projectKey 或 mode。'
  }

  const openButton = makeButton(
    make,
    exact ? '介入' : '目标未精确，无法介入',
    !exact,
    'open-intervention',
    'open-intervention',
  )
  openButton.setAttribute('aria-label', '打开人工介入，不自动提交任何决定')

  const stopButton = makeButton(
    make,
    '停止执行',
    !exact,
    'stop-execution',
    'stop',
  )
  stopButton.setAttribute('aria-label', '停止执行（正式停止动作）')

  const receiptHost = make('div', undefined, 'product-control-receipt-host')
  root.append(openButton, stopButton, status, receiptHost)

  const state = {
    disposed: false,
    reading: false,
    stopped: false,
    modal: undefined,
    lastReceipt: undefined,
    lastError: undefined,
  }

  const handle = {
    element: root,
    open,
    stop: stopExecution,
    close,
    state: () => Object.freeze({
      available: exact,
      reading: state.reading,
      stopped: state.stopped,
      opened: state.modal !== undefined,
      receipt: state.lastReceipt,
      error: state.lastError,
    }),
  }

  openButton.addEventListener('click', () => {
    if (openButton.disabled) return
    void open()
  })
  stopButton.addEventListener('click', () => {
    if (stopButton.disabled) return
    void stopExecution()
  })

  host.append(root)
  return handle

  async function open() {
    if (!exact || state.disposed) return
    if (state.modal !== undefined) return
    const runtime = runtimeTarget(target)
    if (runtime === null) return
    if (typeof transport?.readTaskGrant !== 'function') {
      status.textContent = '缺少正式读取入口，无法介入。'
      return
    }
    if (state.reading) return
    state.reading = true
    status.textContent = '正在读取授权状态…'
    try {
      const read = await transport.readTaskGrant(runtime.taskId, runtime.scope)
      if (state.disposed) return
      state.reading = false
      status.textContent = ''
      if (typeof options.onIntervene === 'function') {
        options.onIntervene({
          target,
          readback: read?.readback,
          authority: read?.authority,
          read,
        })
        return
      }
      if (readbackState(read?.readback).kind === 'unknown') {
        status.textContent = '授权状态未知，已停止介入；请刷新读取精确状态。'
        return
      }
      state.modal = openDecisionModal({
        control: {
          target,
          readback: read?.readback,
          authority: read?.authority,
          expectedRevision: readbackState(read?.readback).revision,
        },
        transport,
        element: make,
        host: options.modalHost ?? host,
        title: '人工介入',
        requestId: options.requestId,
        opener: openButton,
        onReceipt: (receipt, context) => {
          state.lastReceipt = receipt
          safeCall(options.onReceipt, receipt, context)
        },
        onError: (error, context) => {
          state.lastError = error
          safeCall(options.onError, error, context)
        },
        onClose: (context) => {
          state.modal = undefined
          safeCall(options.onClose, context)
        },
      })
    } catch (error) {
      if (state.disposed) return
      state.reading = false
      state.lastError = error
      status.textContent = error?.message ?? '读取授权状态失败。'
      safeCall(options.onError, error, { target, action: 'read' })
    }
  }

  async function stopExecution() {
    if (!exact || state.disposed || state.stopped) return
    const runtime = runtimeTarget(target)
    if (runtime === null) return
    if (typeof transport?.stop !== 'function') {
      status.textContent = '缺少正式停止入口。'
      return
    }
    state.stopped = true
    stopButton.disabled = true
    stopButton.setAttribute('aria-disabled', 'true')
    status.textContent = '正在停止…'
    try {
      const result = await transport.stop(runtime.taskId)
      if (state.disposed) return
      state.lastReceipt = result
      renderControlReceipt(receiptHost, result, {
        element: make,
        includeAuthority: false,
        includeReadback: false,
      })
      status.textContent = '停止动作已提交；请以回执为准。'
      safeCall(options.onReceipt, result, { target, action: 'stop' })
    } catch (error) {
      if (state.disposed) return
      state.lastError = error
      renderControlReceipt(receiptHost, error, { element: make })
      status.textContent = '停止失败；请刷新后复核。'
      safeCall(options.onError, error, { target, action: 'stop' })
    }
  }

  function close() {
    if (state.disposed) return
    state.disposed = true
    if (state.modal !== undefined) state.modal.close()
    state.modal = undefined
  }
}
