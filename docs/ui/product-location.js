/**
 * Read-position codec and history helpers for the five-board product.
 *
 * A `ProductLocation` is only a read view:
 *   { board, lane, focus?, scope }
 *
 * The canonical hash route is:
 *   #/boards/<board>/<live|history>?scope=<json>[&focus=<json>]
 *
 * Only the declared fields are encoded. Principal, grant, authorization and
 * arbitrary payload fields are never copied into the URL. Decoding validates
 * the complete position. A partial or invalid route returns an explicit
 * `unknown` result; it never guesses a default board, lane or scope.
 */

export const PRODUCT_BOARD_KINDS = Object.freeze([
  'interaction',
  'orchestration',
  'inspection',
  'execution',
  'memory',
])

export const PRODUCT_LOCATION_LANES = Object.freeze(['live', 'history'])

const BOARD_KINDS = new Set(PRODUCT_BOARD_KINDS)
const LANES = new Set(PRODUCT_LOCATION_LANES)
const READ_MODES = new Set(['fake', 'rcc', 'dsh'])
const ROUTE_KEYS = new Set(['scope', 'focus'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function normalizeTaskId(value) {
  if (!isRecord(value) || value.scope !== 'task' || !isText(value.value)) return null
  return { scope: 'task', value: value.value }
}

function sameTaskId(left, right) {
  return left !== undefined && right !== undefined && left.value === right.value
}

function normalizeScope(scope) {
  if (!isRecord(scope)) return null
  if (scope.kind === 'system') return { kind: 'system' }
  if (scope.kind === 'project') {
    return isText(scope.projectKey) ? { kind: 'project', projectKey: scope.projectKey } : null
  }
  if (scope.kind === 'task') {
    const taskId = normalizeTaskId(scope.taskId)
    if (!isText(scope.projectKey) || !READ_MODES.has(scope.mode) || taskId === null) return null
    return { kind: 'task', projectKey: scope.projectKey, mode: scope.mode, taskId }
  }
  return null
}

function normalizeInstance(instance) {
  if (!isRecord(instance)) return null
  if (instance.kind === 'native-execution') {
    const execution = instance.execution
    if (!isRecord(execution) || !isText(execution.runtimeId) || !isPositiveInteger(execution.executionEpoch)) {
      return null
    }
    return {
      kind: 'native-execution',
      execution: { runtimeId: execution.runtimeId, executionEpoch: execution.executionEpoch },
    }
  }
  if (instance.kind === 'incarnation') {
    const incarnation = instance.incarnation
    const taskId = normalizeTaskId(incarnation?.taskId)
    if (!isRecord(incarnation)
      || !isText(incarnation.runtimeId)
      || !isPositiveInteger(incarnation.generation)
      || !isText(incarnation.agentInstanceId)
      || !isText(incarnation.roleId)
      || taskId === null
      || !isText(incarnation.assignmentId)
      || !isPositiveInteger(incarnation.executionEpoch)) {
      return null
    }
    return {
      kind: 'incarnation',
      incarnation: {
        runtimeId: incarnation.runtimeId,
        generation: incarnation.generation,
        agentInstanceId: incarnation.agentInstanceId,
        roleId: incarnation.roleId,
        taskId,
        assignmentId: incarnation.assignmentId,
        executionEpoch: incarnation.executionEpoch,
      },
    }
  }
  return null
}

function normalizeFocus(focus) {
  if (!isRecord(focus)) return null
  if (focus.kind === 'interaction') {
    const taskRef = normalizeTaskId(focus.taskRef)
    const scope = normalizeScope(focus.scope)
    if (taskRef === null
      || scope?.kind !== 'task'
      || !sameTaskId(scope.taskId, taskRef)) return null
    return { kind: 'interaction', taskRef, scope }
  }
  if (focus.kind === 'session') {
    const sessionRef = focus.sessionRef
    const scope = normalizeScope(focus.scope)
    const taskRef = focus.taskRef === undefined ? undefined : normalizeTaskId(focus.taskRef)
    if (!isRecord(sessionRef)
      || !isText(sessionRef.sourceKind)
      || !isText(sessionRef.sourceRef)
      || scope === null
      || (focus.taskRef !== undefined && taskRef === null)) {
      return null
    }
    if (scope.kind === 'task') {
      if (taskRef === undefined || !sameTaskId(scope.taskId, taskRef)) return null
    } else if (taskRef !== undefined) {
      return null
    }
    return {
      kind: 'session',
      sessionRef: { sourceKind: sessionRef.sourceKind, sourceRef: sessionRef.sourceRef },
      ...(taskRef === undefined ? {} : { taskRef }),
      scope,
    }
  }
  if (focus.kind === 'execution-instance') {
    const taskRef = normalizeTaskId(focus.taskRef)
    const scope = normalizeScope(focus.scope)
    const instance = normalizeInstance(focus.instance)
    if (taskRef === null
      || scope?.kind !== 'task'
      || !sameTaskId(scope.taskId, taskRef)
      || instance === null) return null
    return { kind: 'execution-instance', instance, taskRef, scope }
  }
  return null
}

function focusMatchesScope(focus, scope) {
  if (scope.kind === 'system') return true
  if (scope.kind === 'project') {
    return (focus.scope.kind === 'project' || focus.scope.kind === 'task')
      && focus.scope.projectKey === scope.projectKey
  }
  return focus.scope.kind === 'task' && sameTaskId(focus.scope.taskId, scope.taskId)
}

function normalizeLocation(location) {
  if (!isRecord(location)
    || !BOARD_KINDS.has(location.board)
    || !LANES.has(location.lane)) return null
  const scope = normalizeScope(location.scope)
  if (scope === null) return null
  const focus = location.focus === undefined ? undefined : normalizeFocus(location.focus)
  if (location.focus !== undefined && focus === null) return null
  if (focus !== undefined && !focusMatchesScope(focus, scope)) return null
  return {
    board: location.board,
    lane: location.lane,
    ...(focus === undefined ? {} : { focus }),
    scope,
  }
}

function unknown(message) {
  return {
    kind: 'unknown',
    failure: {
      code: 'product-location.unknown',
      ownerId: 'humanagent.ui.product-location',
      message,
      nextAction: 'return to the board list and select the task again',
    },
  }
}

function routeFromHash(value) {
  if (!isText(value)) return null
  let hash = value
  if (!value.startsWith('#')) {
    try {
      hash = new URL(value, 'http://product.invalid').hash
    } catch {
      return null
    }
  }
  const match = /^#\/boards\/([^/?#]+)\/([^/?#]+)(?:\?(.*))?$/.exec(hash)
  if (match === null) return null
  const params = new URLSearchParams(match[3] ?? '')
  for (const key of params.keys()) {
    if (!ROUTE_KEYS.has(key)) return null
  }
  for (const key of ROUTE_KEYS) {
    if (params.getAll(key).length > 1) return null
  }
  return { board: match[1], lane: match[2], params }
}

function jsonParam(params, key) {
  const raw = params.get(key)
  if (raw === null || raw.trim() === '') return { ok: false }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

/**
 * Encode a validated location as the canonical hash route. Invalid input throws
 * instead of producing a guessed URL. Unknown fields are not copied.
 */
export function encodeProductLocation(location) {
  const normalized = normalizeLocation(location)
  if (normalized === null) throw new TypeError('product location is invalid')
  const params = new URLSearchParams()
  params.set('scope', JSON.stringify(normalized.scope))
  if (normalized.focus !== undefined) params.set('focus', JSON.stringify(normalized.focus))
  return `#/boards/${normalized.board}/${normalized.lane}?${params.toString()}`
}

/**
 * Decode a hash or a full URL carrying a product hash. Returns an explicit
 * unknown result for every partial or invalid position.
 */
export function decodeProductLocation(value) {
  const route = routeFromHash(value)
  if (route === null) return unknown('product location route is invalid')
  if (!route.params.has('scope')) return unknown('product location is missing its read scope')

  const scope = jsonParam(route.params, 'scope')
  if (!scope.ok) return unknown('product location scope is invalid')

  let focus
  if (route.params.has('focus')) {
    const parsed = jsonParam(route.params, 'focus')
    if (!parsed.ok) return unknown('product location focus is invalid')
    focus = parsed.value
  }

  const location = normalizeLocation({
    board: route.board,
    lane: route.lane,
    ...(focus === undefined ? {} : { focus }),
    scope: scope.value,
  })
  if (location === null) return unknown('product location payload is invalid')
  return { kind: 'valid', location }
}

/** Explicit alias for callers that only decode hash routes. */
export const locationFromHash = decodeProductLocation

/**
 * Return one hierarchy level: the same board/lane/scope without a focus.
 * `null` means the location is already the board level. Invalid input is an
 * explicit unknown result, never a parent guess.
 */
export function hierarchyReturn(location) {
  const normalized = normalizeLocation(location)
  if (normalized === null) return unknown('cannot return from an invalid product location')
  if (normalized.focus === undefined) return null
  return {
    kind: 'board',
    location: {
      board: normalized.board,
      lane: normalized.lane,
      scope: normalized.scope,
    },
  }
}

/** History state for `history.pushState`/`replaceState`. */
export function productLocationHistoryState(location) {
  const normalized = normalizeLocation(location)
  if (normalized === null) throw new TypeError('product location is invalid')
  return { productLocation: normalized }
}

/**
 * Decode a popstate event. A present history state is authoritative: an
 * invalid one stays unknown and is not replaced by the event URL. When the
 * event carries no product state, the browser URL is decoded.
 */
export function locationFromPopState(event) {
  const state = event?.state
  if (state !== undefined && state !== null) {
    if (!isRecord(state)) return unknown('history state is invalid')
    if (Object.prototype.hasOwnProperty.call(state, 'productLocation')) {
      const location = normalizeLocation(state.productLocation)
      if (location === null) return unknown('history state carries an invalid product location')
      return { kind: 'valid', location }
    }
  }
  const url = event?.newURL ?? event?.url
  if (typeof url !== 'string') return unknown('popstate event does not carry a URL')
  return decodeProductLocation(url)
}
