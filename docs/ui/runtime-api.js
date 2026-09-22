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

export class RuntimeApiError extends Error {
  constructor(body, status) {
    super(body?.message || `Runtime API request failed with HTTP ${status}`)
    this.name = 'RuntimeApiError'
    this.code = body?.code || 'runtime.request.failed'
    this.ownerId = body?.ownerId || 'humanagent.app'
    this.nextAction = body?.nextAction || 'inspect the runtime error'
    this.evidenceRefs = body?.evidenceRefs || []
    this.status = status
  }
}

export function createRuntimeApi(options = {}) {
  const baseUrl = (options.baseUrl || '').replace(/\/$/, '')
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis)

  async function request(path, init = {}) {
    const headers = new Headers(init.headers || {})
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new RuntimeApiError(body.error || body, response.status)
    return body
  }

  return {
    status: () => request('/api/runtime/status'),
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
    confirmExplicitRequirement: (interactionId, confirmation) => request(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`, {
      method: 'POST',
      body: JSON.stringify(confirmation),
    }),
    dispatchNextExplicitRequirement: () => request('/api/explicit/dispatch-next', { method: 'POST' }),
    taskDetail: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}`),
    taskDashboard: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/dashboard`),
    observation: (taskId, scopeRef, selectedNodeId) => {
      const query = new URLSearchParams()
      if (scopeRef) query.set('scope', scopeRef)
      if (selectedNodeId) query.set('node', selectedNodeId)
      const suffix = query.size ? `?${query}` : ''
      return request(`/api/tasks/${encodeURIComponent(taskId)}/observation${suffix}`)
    },
    startExecution: (taskId, input) => request(`/api/tasks/${encodeURIComponent(taskId)}/executions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    stop: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: 'POST' }),
    retryStop: (taskId) => request(`/api/tasks/${encodeURIComponent(taskId)}/stop/retry`, { method: 'POST' }),
    eventsUrl: (operationId) => `${baseUrl}/api/executions/${encodeURIComponent(operationId)}/events`,
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

export function stateTone(state) {
  if (state === 'failed' || state === 'blocked' || state === 'cancelled' || state === 'unknown') return 'danger'
  if (state === 'waiting' || state === 'settling') return 'warning'
  if (state === 'succeeded' || state === 'stopped') return 'success'
  return 'active'
}

export function queryParam(name) {
  return new URLSearchParams(location.search).get(name)
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
