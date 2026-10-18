export const RUNTIME_EVENT_KINDS = Object.freeze([
  'execution.started',
  'provider.model',
  'provider.output',
  'provider.tool',
  'provider.error',
  'execution.settling',
  'checkpoint.committed',
  'execution.terminal',
  'attention.opened',
  'attention.resolved',
])

// Declared A1 execution action for the one-gesture authorize-execution control
// intent. The server resolves the verified owner; these constants only name
// the capability the browser asks the runtime to authorize.
export const TASK_EXECUTION_ACTION_ID = 'task.execute'
export const TASK_EXECUTION_CAPABILITY = 'provider.execution'

// The runtime gates every business read behind a browser session. These are the
// three typed codes it returns when that session is absent, expired or invalid,
// and they are the only errors whose nextAction tells the user to pair this
// browser. They name the entry the shell must offer.
export const AUTH_SESSION_CODES = Object.freeze([
  'auth.session.missing',
  'auth.session.expired',
  'auth.session.invalid',
])

export function isAuthSessionError(error) {
  return typeof error?.code === 'string' && AUTH_SESSION_CODES.includes(error.code)
}

// Contract: a same-origin absolute path, optionally carrying a query string and
// a fragment. `currentEntryPath()` passes `pathname + search`, so `?task=...`
// must survive; `#` is accepted for the same reason. The guarantee is
// same-origin only — callers pass the result to `URLSearchParams` and
// `location.assign`, both of which keep a leading-slash path on this origin.
// Percent-encoded separators inside the path are not rewritten to a scheme by
// either, so they stay same-origin too; the cases that must be refused are the
// ones a URL parser reinterprets as authority separators (a backslash and its
// `%5c`/`%0a`-style encoded forms, and raw control bytes).
// Leading and trailing whitespace is trimmed, and the caller receives the
// trimmed value. Trimming cannot re-expose a refused form: the separator and
// control checks run on the raw value first, and the leading-slash and `//`
// checks run on the trimmed value, so `'\u00a0//evil.com'` still falls back.
// Interior whitespace stays where it is and remains inside the path, which
// keeps the result on this origin.
export function sameOriginPath(value, fallback = '/dashboard.html') {
  if (typeof value !== 'string') return fallback
  // Reject parser-significant separators and controls before trimming. URL and
  // URLSearchParams normalize these into backslashes, tabs, or line breaks;
  // accepting them would make a path that looks local resolve off-origin.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback
  if (/%(?:5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return fallback
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback
  return trimmed
}

// The pairing entry, carrying the entry that failed and the typed rejection the
// runtime produced for it. The login page renders those exact fields, so the
// user sees the runtime's own code/owner/message/nextAction instead of a dead
// instruction to open a page that does not exist.
export function loginHref(error, next) {
  const params = new URLSearchParams({ next: sameOriginPath(next) })
  if (isAuthSessionError(error)) {
    params.set('authCode', error.code)
    params.set('authOwner', error.ownerId ?? '')
    params.set('authMessage', error.message ?? '')
    params.set('authNext', error.nextAction ?? '')
  }
  return `./login.html?${params.toString()}`
}

export class RuntimeApiError extends Error {
  constructor(body, status) {
    // The runtime already shapes the original cause chain into a bounded body
    // (boundedErrorCause). Keep it as the native Error cause so the caller can
    // name the underlying failure instead of collapsing it to a status code.
    super(body?.message || `Runtime API request failed with HTTP ${status}`, {
      cause: body?.cause,
    })
    this.name = 'RuntimeApiError'
    this.code = body?.code || 'runtime.request.failed'
    this.ownerId = body?.ownerId || 'humanagent.app'
    this.nextAction = body?.nextAction || 'inspect the runtime error'
    this.evidenceRefs = body?.evidenceRefs || []
    this.execution = body?.execution
    this.apiError = body?.apiError
    this.status = status
  }
}

/**
 * Agent-instance selection is URL view state owned by ./agent-activity.js. The API
 * layer only forwards what the caller already validated: it never parses, defaults,
 * repairs, or invents an instance selection, and it never imports the UI renderer.
 * The keys ride on the same task-scoped GET, so no global Agent endpoint exists.
 */
function appendAgentSelection(query, agentQuery) {
  if (!agentQuery) return query
  for (const [key, value] of new URLSearchParams(agentQuery)) query.append(key, value)
  return query
}

// The same forwarded selection, isolated, for the legacy unscoped dashboard GET.
function agentSelectionQuery(agentQuery) {
  if (!agentQuery) return ''
  return appendAgentSelection(new URLSearchParams(), agentQuery).toString()
}

/**
 * A checkpoint selection is URL view state owned by ./checkpoint-history.js. The
 * API layer only forwards the four keys the caller already encoded: it never
 * parses, defaults, or invents a checkpoint target, and it never imports the UI
 * renderer. The keys ride on the same task-scoped checkpoint GET.
 */
function appendCheckpointSelection(query, checkpointQuery) {
  if (!checkpointQuery) return query
  for (const [key, value] of new URLSearchParams(checkpointQuery)) query.append(key, value)
  return query
}

// Task control scope is an explicit pair or absent. A partial pair is invalid
// at the page boundary, so a caller cannot accidentally compose a legacy URL.
export function taskControlScopeQuery({ projectKey, mode } = {}) {
  if (projectKey === undefined && mode === undefined) return ''
  if (typeof projectKey !== 'string' || projectKey === ''
    || (mode !== 'fake' && mode !== 'rcc')) {
    throw new TypeError('task control scope requires projectKey and mode=fake|rcc')
  }
  return `?${new URLSearchParams({ projectKey, mode })}`
}

function appendI2TaskScope(query, scope) {
  for (const [key, value] of new URLSearchParams(taskControlScopeQuery(scope))) query.set(key, value)
  return query
}

function taskScopeSearch(scope) {
  if (scope === undefined) return ''
  if (scope === null || typeof scope !== 'object' || scope.kind !== 'task') {
    throw new TypeError('semantic observation scope requires one task read scope')
  }
  return taskControlScopeQuery(scope)
}

// A checkpoint asset body is addressed only by its role, or by the exact adopted
// child triple. The four checkpoint selection keys on the query already name the
// exact checkpoint; nothing else may be sent as authority.
function checkpointAssetBodyPath(selector) {
  if (!selector || typeof selector !== 'object') return null
  if (selector.kind === 'capture') return 'capture'
  if (selector.kind === 'adopted-child') {
    const { invocationId, childTurnId, deliverySeq } = selector
    if (typeof invocationId !== 'string' || !invocationId.trim()
      || typeof childTurnId !== 'string' || !childTurnId.trim()
      || !Number.isSafeInteger(deliverySeq) || deliverySeq < 0) {
      return null
    }
    const encode = (value) => encodeURIComponent(value)
    return `adopted-child/${encode(invocationId)}/${encode(childTurnId)}/${encode(String(deliverySeq))}`
  }
  return null
}

export function createRuntimeApi(options = {}) {
  const baseUrl = (options.baseUrl || '').replace(/\/$/, '')
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis)

  async function request(path, init = {}) {
    const headers = new Headers(init.headers || {})
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new RuntimeApiError(body.error ? { ...body, ...body.error } : body, response.status)
    return body
  }

  return {
    status: () => request('/api/runtime/status'),
    // The only two public auth edges the browser is allowed to use. The pairing
    // challenge and the supervisor token stay in the control plane.
    authSession: () => request('/api/auth/session'),
    authPair: (code) => request('/api/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
    // Display preference is a separate reading-mode boundary from `mode=fake|rcc`,
    // which stays the execution/read scope. The three methods reuse the same
    // request adapter and typed error shape as every other runtime read.
    displayPreference: () => request('/api/ui/display-preference'),
    updateDisplayPreference: (update) => request('/api/ui/display-preference', {
      method: 'PUT',
      body: JSON.stringify(update),
    }),
    resetDisplayPreference: () => request('/api/ui/display-preference', { method: 'DELETE' }),
    dashboard: () => request('/api/dashboard'),
    listTasks: () => request('/api/tasks'),
    updateTask: (taskId, input) => request(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
    deleteTask: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),
    bulkTaskAction: (taskIds, action) => request('/api/tasks/bulk', {
      method: 'POST',
      body: JSON.stringify({ taskIds, action }),
    }),
    createTask: (input) => request('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),
    readTaskGrant: (taskId, scope) => request(
      `/api/tasks/${encodeURIComponent(taskId)}/control/grant${taskControlScopeQuery(scope)}`,
    ),
    grantTaskControl: (taskId, input, scope) => request(
      `/api/tasks/${encodeURIComponent(taskId)}/control/grant${taskControlScopeQuery(scope)}`, {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
    revokeTaskGrant: (taskId, input, scope) => request(
      `/api/tasks/${encodeURIComponent(taskId)}/control/revoke${taskControlScopeQuery(scope)}`, {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
    receiveExplicitInput: (input) => request('/api/explicit/inputs', {
      method: 'POST',
      body: JSON.stringify({ ...input, channel: 'business' }),
    }),
    inspectExplicitInteraction: (interactionId) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}`),
    interpretExplicitInput: (interactionId) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, { method: 'POST' }),
    answerExplicitClarification: (interactionId, answer) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/clarification`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    }),
    beginExplicitMatching: (interactionId) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/matching`, { method: 'POST' }),
    recordExplicitMatch: (interactionId, result) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/match`, {
      method: 'POST',
      body: JSON.stringify(result),
    }),
    proposeExplicitRequirement: (interactionId, proposal) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/proposal`, {
      method: 'POST',
      body: JSON.stringify(proposal),
    }),
    completeExplicitStatusQuery: (interactionId) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/status-only`, { method: 'POST' }),
    confirmExplicitRequirement: (interactionId, confirmation, control) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`, {
      method: 'POST',
      body: JSON.stringify({ ...confirmation, ...(control === undefined ? {} : { control }) }),
    }),
    scheduler: () => request('/api/runtime/scheduler'),
    planControl: (subscriptionId, { action, idempotencyKey, requestedAt }) => request(`/api/plans/${encodeURIComponent(subscriptionId)}/control`, {
      method: 'POST',
      body: JSON.stringify({ action, idempotencyKey, requestedAt }),
    }),
    // 修改: a typed edit against the exact revision the caller is looking at. The
    // runtime rejects a stale base revision instead of editing a newer one.
    refineExplicitDraft: (interactionId, input) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/refine`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    // 重新整理: re-run the explicit brain over the original input, optionally
    // with a human correction.
    regenerateExplicitDraft: (interactionId, input = {}) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/regenerate`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    // 放弃: the durable closure. The response carries the abandon receipt.
    rejectExplicitDraft: (interactionId, input) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/reject`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    dispatchNextExplicitRequirement: () => request('/api/explicit/dispatch-next', { method: 'POST' }),
    memorySummary: ({ namespace = 'project', query = '', limit = 20 } = {}) => {
      const params = new URLSearchParams({ namespace, limit: String(limit) })
      if (query.trim()) params.set('query', query.trim())
      return request(`/api/memory/summary?${params}`)
    },
    reviewMemoryCandidate: (candidateId, decision, decisionReason) => request('/api/memory/review', {
      method: 'POST',
      body: JSON.stringify({ candidateId, decision, decisionReason }),
    }),
    taskDetail: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`),
    taskDashboard: (taskId, agentQuery) => {
      const query = agentSelectionQuery(agentQuery)
      const suffix = query ? `?${query}` : ''
      return request(`/api/tasks/${encodeURIComponent(taskId)}/dashboard${suffix}`)
    },
    // I4 scoped reads are explicit GET builders. There is deliberately no
    // default scope: a caller that omits the scope gets the existing unscoped
    // dashboard, never an invented project/task identity.
    systemDashboard: () => request('/api/dashboard?scope=system', { method: 'GET' }),
    projectDashboard: ({ projectKey }) => {
      const query = new URLSearchParams({ scope: 'project', projectKey })
      return request(`/api/dashboard?${query}`, { method: 'GET' })
    },
    scopedTaskDashboard: ({ projectKey, mode, taskId, agentQuery }) => {
      const query = new URLSearchParams({ projectKey, mode })
      appendAgentSelection(query, agentQuery)
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/dashboard?${query}`, { method: 'GET' })
    },
    taskRecords: (taskId, { projectKey, mode, view, limit = 20, cursor } = {}) => {
      const query = new URLSearchParams({ projectKey, mode, view, limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/records?${query}`, { method: 'GET' })
    },
    // I5 readonly history reads. Both are explicit scoped GET builders: the
    // caller passes the returned projectKey/mode/task identity, and neither
    // builder derives a scope or execution control from the URL or display
    // state. `viewed` is a read-only selection; it never writes current.
    taskContextHistory: (taskId, { projectKey, mode, agentRuntimeId, contextViewRef, cursor, limit = 20 } = {}) => {
      const query = new URLSearchParams({ projectKey, mode, limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      if (agentRuntimeId) query.set('agentRuntimeId', agentRuntimeId)
      if (contextViewRef) query.set('contextViewRef', contextViewRef)
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/context-history?${query}`, { method: 'GET' })
    },
    // Independent AND filters: each present filter is its own query field and
    // the builder never merges revision/cycle/occurrence identities. The
    // four-key `checkpointQuery` carries the selected old checkpoint so the read
    // resolves current and viewed separately; the API never encodes it itself.
    taskCheckpointHistory: (taskId, { projectKey, mode, checkpointQuery, directiveRevision, executionEpoch, cycleId, occurrenceRef, cursor, limit = 20 } = {}) => {
      const query = new URLSearchParams({ projectKey, mode, limit: String(limit) })
      appendCheckpointSelection(query, checkpointQuery)
      if (cursor) query.set('cursor', cursor)
      for (const [name, value] of Object.entries({ directiveRevision, executionEpoch, cycleId, occurrenceRef })) {
        if (value === undefined || value === null || value === '') continue
        query.set(name, String(value))
      }
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/checkpoints?${query}`, { method: 'GET' })
    },
    // The body read names the exact checkpoint with the same four selection keys
    // and names the asset only by role or adopted-child triple. The descriptor,
    // scope and locator stay with the service; the browser never authorizes them.
    taskCheckpointAssetBody: (taskId, { projectKey, mode, checkpointQuery, selector } = {}) => {
      const path = checkpointAssetBodyPath(selector)
      if (!path) {
        throw new RuntimeApiError({
          code: 'checkpoint-asset.invalid-selector',
          ownerId: 'humanagent.ui.runtime-api',
          message: 'checkpoint 资产正文读取选择器无效。',
          nextAction: '从检查点详情重新打开对应资产正文。',
        })
      }
      const query = new URLSearchParams({ projectKey, mode })
      appendCheckpointSelection(query, checkpointQuery)
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/checkpoints/assets/${path}?${query}`, { method: 'GET' })
    },
    // I2 readonly history reads. These are explicit task GET builders. The
    // injected I2 authority is service-scoped, so the builder carries only the
    // exact task identity and the read-only selection/filters. `viewed` is a
    // selection: it never writes the current execution position.
    taskBusinessCycles: (taskId, { projectKey, mode, viewed, cursor, limit = 20 } = {}) => {
      const query = appendI2TaskScope(new URLSearchParams({ limit: String(limit) }), { projectKey, mode })
      if (viewed) query.set('viewed', viewed)
      if (cursor) query.set('cursor', cursor)
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/cycles?${query}`, { method: 'GET' })
    },
    taskBusinessCycle: (taskId, cycleId, { projectKey, mode } = {}) => {
      const query = appendI2TaskScope(new URLSearchParams(), { projectKey, mode })
      const suffix = query.size ? `?${query}` : ''
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/cycles/${encodeURIComponent(cycleId)}${suffix}`, { method: 'GET' })
    },
    // Independent AND filters: cycleId and milestoneId are separate query fields
    // and are never merged into one identity.
    taskMilestoneReviews: (taskId, { projectKey, mode, cycleId, milestoneId, cursor, limit = 20 } = {}) => {
      const query = appendI2TaskScope(new URLSearchParams({ limit: String(limit) }), { projectKey, mode })
      if (cursor) query.set('cursor', cursor)
      if (cycleId) query.set('cycleId', cycleId)
      if (milestoneId) query.set('milestoneId', milestoneId)
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/reviews?${query}`, { method: 'GET' })
    },
    taskInspectionOccurrences: (taskId, { projectKey, mode, viewed, cursor, limit = 20 } = {}) => {
      const query = appendI2TaskScope(new URLSearchParams({ limit: String(limit) }), { projectKey, mode })
      if (viewed) query.set('viewed', viewed)
      if (cursor) query.set('cursor', cursor)
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/inspection-occurrences?${query}`, { method: 'GET' })
    },
    taskInspectionOccurrence: (taskId, occurrenceId, { projectKey, mode } = {}) => {
      const query = appendI2TaskScope(new URLSearchParams(), { projectKey, mode })
      const suffix = query.size ? `?${query}` : ''
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/inspection-occurrences/${encodeURIComponent(occurrenceId)}${suffix}`, { method: 'GET' })
    },
    // Comparison joins by checkId and immutable definition identity/version on
    // the server; the browser only names the exact left/right occurrences.
    taskInspectionComparison: (taskId, { projectKey, mode, left, right }) => {
      const query = appendI2TaskScope(new URLSearchParams({ left, right }), { projectKey, mode })
      return request(`/api/tasks/${encodeURIComponent(taskId.value)}/inspection-comparison?${query}`, { method: 'GET' })
    },
    taskHistory: (taskId, { cursor, limit = 20, kinds, search } = {}) => {
      const query = new URLSearchParams({ limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      if (search) query.set('search', search)
      for (const kind of kinds || []) query.append('kind', kind)
      return request(`/api/tasks/${encodeURIComponent(taskId)}/history?${query}`)
    },
    observation: (taskId, scopeRef, selectedNodeId, agentQuery) => {
      const query = new URLSearchParams()
      if (scopeRef) query.set('scope', scopeRef)
      if (selectedNodeId) query.set('node', selectedNodeId)
      appendAgentSelection(query, agentQuery)
      const suffix = query.size ? `?${query}` : ''
      return request(`/api/tasks/${encodeURIComponent(taskId)}/observation${suffix}`)
    },
    // Read-only semantic observation. The plain GET carries the confirmed
    // envelope; the SSE URL only names the same task's revision stream. Both are
    // GET edges, and neither builder derives control state from a raw payload.
    // An absent scope keeps the legacy serve-bound read; a task scope sends the
    // one complete projectKey/mode pair to both edges.
    semanticObservation: (taskId, scope) => request(
      `/api/tasks/${encodeURIComponent(taskId)}/semantic${taskScopeSearch(scope)}`,
    ),
    semanticEventsUrl: (taskId, scope) => `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/semantic/stream${taskScopeSearch(scope)}`,
    startExecution: (taskId, input) => request(`/api/tasks/${encodeURIComponent(taskId)}/executions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    stop: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST' }),
    retryStop: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/stop/retry`, { method: 'POST' }),
    eventsUrl: (operationId) => `${baseUrl}/api/executions/${encodeURIComponent(operationId)}/events`,
  }
}

// Stable comparison identity for a read scope. It is a UI-local cache key only;
// it is never a domain identity and never appears in a request.
export function readScopeKey(scope) {
  if (!scope || typeof scope !== 'object') return ''
  if (scope.kind === 'system') return 'system'
  if (scope.kind === 'project') return `project:${scope.projectKey}`
  if (scope.kind === 'task') {
    // The canonical filter identity joins the key so two different AND-filter
    // sets are never treated as the same scope. An explicit instance or
    // checkpoint selection is also part of the identity, so a failed new
    // selection has no prior content to re-publish as stale. The legacy I2
    // `viewed` cursor stays out of the key so a failed re-selection keeps the
    // confirmed list for the same task/view/cursor/filters.
    const filters = scope.filters && typeof scope.filters === 'object'
      ? Object.keys(scope.filters).sort().map((key) => [key, scope.filters[key]])
      : undefined
    const identity = ['task', scope.projectKey, scope.mode, scope.taskId?.value || '', scope.view, scope.cursor, filters]
    // An explicit instance selection is part of the read identity. A task catalog
    // read and an exact-instance read are different reads, so a failed instance
    // read never re-publishes the previous selection's content as "stale".
    if (scope.agentQuery) identity.push([...new URLSearchParams(scope.agentQuery)].sort())
    // The same rule for an exact checkpoint selection: current, ck-a and ck-b
    // are three distinct reads with three distinct identities.
    if (scope.checkpointQuery) identity.push([...new URLSearchParams(scope.checkpointQuery)].sort())
    return JSON.stringify(identity)
  }
  return ''
}

/**
 * Freeze one parsed JSON value in place, children before parents. The same
 * object or array reference is returned, so every consumer of one publication
 * or envelope keeps the exact received value.
 */
export function freezeJsonValue(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const item of value) freezeJsonValue(item)
  } else {
    for (const item of Object.values(value)) freezeJsonValue(item)
  }
  return Object.freeze(value)
}

/**
 * Shared publication owner for scoped reads.
 *
 * `read(scope)` must return a promise resolving to `RuntimeReadResult`. The
 * owner captures `scope` plus a local request serial, publishes only the latest
 * result for the current scope, and discards late responses from a previous
 * scope or an older request on the same scope. A same-scope refresh failure
 * keeps the last confirmed content for that scope explicitly stale; a
 * new-scope failure never falls back to another scope's content.
 *
 * A failure only becomes the current publication while its own request is still
 * the current one. A rejection that arrives after navigation to another scope
 * (or after a newer request on the same scope) is discarded, so a late rejected
 * read can never clear or replace the content a newer request already published.
 */
export function createRuntimeReadPublication({ read }) {
  if (typeof read !== 'function') throw new TypeError('Runtime read publication requires a read function')

  let currentScope
  let currentRequest = null
  let requestSerial = 0
  let content
  let stale = false
  let pending = false
  let failure
  const lastScopeKey = new Map()

  function isCurrent(capture, serial) {
    return Boolean(currentRequest && currentRequest.scope === capture && currentRequest.serial === serial)
  }

  function fail(capture, error, overrides = {}) {
    const code = error?.code || overrides.code || 'runtime.read.failed'
    const ownerId = error?.ownerId || overrides.ownerId || 'humanagent.ui'
    const message = error?.message || overrides.message || 'the scoped read failed'
    const nextAction = error?.nextAction || overrides.nextAction || 'retry the same scoped read'
    failure = { code, ownerId, message, nextAction }
    const key = readScopeKey(capture)
    const prior = lastScopeKey.get(key)
    if (prior !== undefined && key === readScopeKey(currentScope)) {
      content = prior
      stale = true
    } else {
      content = undefined
      stale = false
    }
    pending = false
  }

  async function refresh(scope) {
    const key = readScopeKey(scope)
    if (!key) {
      currentScope = scope
      currentRequest = null
      content = undefined
      stale = false
      pending = false
      failure = {
        code: 'runtime.read.invalid-target',
        ownerId: 'humanagent.ui',
        message: 'the requested read scope is not a system, project, or exact task scope',
        nextAction: 'choose an existing project or exact task scope',
      }
      return { published: false, reason: 'invalid-target', state: snapshot() }
    }

    currentScope = scope
    const serial = ++requestSerial
    const capture = scope
    currentRequest = { scope: capture, serial }
    // A new-scope navigation has no fallback; the previous scope is only kept
    // as its own stale entry the moment a same-scope refresh fails again.
    content = undefined
    stale = false
    pending = true
    failure = undefined

    let result
    try {
      result = await read(capture)
    } catch (error) {
      // A late rejection must not touch the current publication. Only a still
      // current request may record its failure.
      if (!isCurrent(capture, serial)) return { published: false, reason: 'discarded-late', state: snapshot() }
      fail(capture, error)
      return { published: true, reason: 'read-failed', state: snapshot() }
    }

    if (!isCurrent(capture, serial)) return { published: false, reason: 'discarded-late', state: snapshot() }

    if (result && result.ok === true) {
      content = freezeJsonValue(result.value)
      stale = false
      pending = false
      failure = undefined
      lastScopeKey.set(key, content)
      return { published: true, reason: 'published', state: snapshot() }
    }

    fail(capture, result?.failure)
    return { published: true, reason: 'read-failed', state: snapshot() }
  }

  function snapshot() {
    return Object.freeze({
      scope: currentScope,
      requestSerial: currentRequest?.serial || 0,
      content,
      stale,
      pending,
      failure,
    })
  }

  return {
    refresh,
    state: snapshot,
  }
}

export function formatTime(value) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

// Status chips carry the same semantic legend as the runtime dashboard: green for
// running/settling and finished work, blue for created/admitted/waiting queues,
// red for hard failures, yellow for blocked attention, gray for cancelled and
// unknown/unavailable/stale states.
export function stateTone(state) {
  switch (state) {
    case 'running':
    case 'settling':
      return 'active'
    case 'waiting':
    case 'created':
    case 'admitted':
      return 'blue'
    case 'blocked':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'succeeded':
    case 'stopped':
      return 'success'
    case 'cancelled':
    case 'unknown':
    case 'stale':
    case 'unavailable':
      return 'gray'
    default:
      return 'gray'
  }
}

export function queryParam(name) {
  return new URLSearchParams(location.search).get(name)
}

/**
 * Whether one returned body projection is exactly the checkpoint and asset a
 * body read asked for: the checkpoint identity, its full physical receipt and the
 * selector. A response for another checkpoint, another receipt or another asset
 * role is refused instead of published, so a late or mismatched response can
 * never present itself as the opened body. Callers keep their own serial to
 * decide whether the read is still current at all; this only compares identity.
 */
export function sameCheckpointAssetBodyAddress(projection, address) {
  if (!projection || typeof projection !== 'object') return false
  if (!address || typeof address !== 'object') return false
  if (projection.surface !== 'runtime-checkpoint-asset-body') return false
  if (projection.checkpoint?.checkpointId?.value !== address.target?.checkpointId) return false
  const receipt = projection.checkpoint?.commitRef
  const wanted = address.target?.commitRef
  if (!receipt || !wanted) return false
  if (receipt.commitId !== wanted.commitId) return false
  if (receipt.journalSeq !== wanted.journalSeq) return false
  if (receipt.recordDigest !== wanted.recordDigest) return false
  const selector = projection.selector
  const wantedSelector = address.selector
  if (!selector || !wantedSelector || selector.kind !== wantedSelector.kind) return false
  if (selector.kind === 'capture') return true
  return selector.invocationId === wantedSelector.invocationId
    && selector.childTurnId === wantedSelector.childTurnId
    && selector.deliverySeq === wantedSelector.deliverySeq
}

export function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
