// Public read facts in, presentation out. The clock never creates a phase.
const terminalStates = new Set(['succeeded', 'failed', 'blocked', 'stopped', 'cancelled', 'stale'])
const explicitFinished = new Set(['answered', 'status-only', 'confirmed', 'dispatched', 'rejected'])
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const executionKey = (e) => JSON.stringify([e.taskId?.scope, e.taskId?.value, e.operationId, e.executionEpoch])
const requestKey = (e) => e.requestId ? `${executionKey(e)}:${JSON.stringify([e.turnId, e.requestId])}` : executionKey(e)

export function elapsedSeconds(row, now = Date.now()) {
  if (!validTime(row.startedAt)) return undefined
  const end = validTime(row.endedAt) ? Date.parse(row.endedAt) : row.running ? now : undefined
  if (end === undefined || end < Date.parse(row.startedAt)) return undefined
  return Math.floor((end - Date.parse(row.startedAt)) / 1000)
}

export function conversationStatus(facts = {}) {
  const rows = []
  const models = new Map()
  const tools = new Map()
  const executions = new Map()
  const retries = new Map()
  const finished = terminalStates.has(facts.state) || (facts.steps !== undefined && explicitFinished.has(facts.state))
  const add = (key, phase, label, at, tone = 'warning') => {
    const row = { key, phase, label, tone, startedAt: at, running: !finished }
    rows.push(row)
    return row
  }
  const close = (row, at) => {
    if (!row || row.endedAt !== undefined) return
    row.endedAt = at
    row.running = false
  }
  const model = (key, at, sending = false) => {
    const previous = models.get(key)
    if (sending && previous?.sending && !previous.wait) return previous
    const group = { sending: sending ? add(`${key}:send:${rows.length}`, 'sending', '正在发出请求', at) : undefined }
    models.set(key, group)
    if (!sending) group.wait = add(`${key}:wait:${rows.length}`, 'model-wait', '等待模型响应', at)
    return group
  }
  const respond = (group, at) => {
    if (!group) return
    close(group.wait, at)
    if (group.wait) group.wait.label = '等待模型响应（已收到）'
    if (!group.response) group.response = add(`response:${rows.length}`, 'streaming', '正在接收模型响应', at, 'active')
  }
  const dispatch = (key, at) => {
    const group = models.get(key)
    close(group?.sending, at)
    if (group?.sending) { group.sending.label = '请求已发出'; group.sending.tone = 'success' }
    if (group && !group.wait) group.wait = add(`${key}:wait`, 'model-wait', '等待模型响应', at)
    else if (!group) model(key, at)
  }
  const settle = (group, at) => {
    close(group?.response, at)
    if (group?.response) { group.response.label = '模型响应已结束'; group.response.tone = 'success' }
    // A settled request with no first-response fact cannot supply wait duration.
    if (group?.wait) group.wait.running = false
  }
  // Task/operation/epoch and explicit request/turn are separate identity domains.
  for (const e of facts.events ?? []) {
    const key = requestKey(e)
    const group = models.get(key)
    if (['provider.model', 'provider.output', 'execution.terminal'].includes(e.kind)) {
      const retry = retries.get(executionKey(e))
      if (retry && retry.endedAt === undefined) { close(retry, e.occurredAt); retry.label = '已继续重试当前任务' }
    }
    if (e.kind === 'execution.started' && !executions.has(executionKey(e))) {
      executions.set(executionKey(e), add(`${executionKey(e)}:total`, 'total', '本轮总耗时', e.occurredAt, 'active'))
    }
    if (e.kind === 'execution.terminal' && e.terminalPhase === 'final') close(executions.get(executionKey(e)), e.occurredAt)
    if (e.kind === 'provider.model') {
      if (e.state === 'dispatching') model(key, e.occurredAt, true)
      else if (e.state === 'dispatched') dispatch(key, e.occurredAt)
      else if (e.state === 'settled') settle(group, e.occurredAt)
      else if (e.state === 'waiting') { if (!group?.wait) dispatch(key, undefined) }
      else if (e.state === undefined) model(key, e.occurredAt)
    }
    if (e.kind === 'provider.output') respond(group, e.occurredAt)
    if (e.kind === 'provider.tool' && e.callId) {
      close(group?.wait, e.occurredAt)
      if (group?.wait) group.wait.label = '等待模型响应（已收到）'
      const toolKey = `${executionKey(e)}:${e.callId}`
      if (!tools.has(toolKey)) tools.set(toolKey, add(toolKey, 'tool', '执行工具等待结果', e.occurredAt, 'active'))
    }
    if (e.kind === 'provider.tool-result' && e.callId) {
      const row = tools.get(`${executionKey(e)}:${e.callId}`)
      if (row) {
        close(row, e.occurredAt)
        row.label = e.status === 'succeeded' ? '工具执行完成' : e.status === 'failed' ? '工具执行失败' : '工具已返回'
        row.tone = e.status === 'failed' ? 'danger' : e.status === 'succeeded' ? 'success' : 'warning'
        row.error = e.error
      }
    }
    if (e.kind === 'execution.terminal' && e.terminalPhase === 'provider') {
      settle(group, e.occurredAt)
    }
    if (e.kind === 'provider.error') {
      close(group?.wait, e.occurredAt)
      close(group?.response, e.occurredAt)
      const row = add(`${key}:error:${e.seq}`, 'error', '请求失败', undefined, 'danger')
      row.error = e.error
      row.running = false
    }
    if (e.kind === 'execution.retry') retries.set(executionKey(e), add(`${key}:retry:${e.seq}`, 'retry', '正在重试当前任务', e.occurredAt))
  }
  for (const step of facts.steps ?? []) {
    // Unidentified steps can describe a phase, but cannot close another request.
    const key = step.requestId && step.turnId ? JSON.stringify([step.turnId, step.requestId]) : undefined
    const group = key === undefined ? undefined : models.get(key)
    if (step.kind === 'request.dispatching') {
      model(key ?? `unpaired:${step.seq}`, step.occurredAt, true)
      if (key && !executions.has(key)) executions.set(key, add(`${key}:total`, 'total', '本次请求总耗时', step.occurredAt, 'active'))
    }
    if (step.kind === 'request.dispatched') {
      dispatch(key ?? `unpaired:${step.seq}`, step.occurredAt)
      if (key && !executions.has(key)) executions.set(key, add(`${key}:total`, 'total', '本次请求总耗时', step.occurredAt, 'active'))
    }
    if (step.kind === 'response.reasoning' || step.kind === 'response.streaming') respond(group, step.occurredAt)
    if (step.kind === 'request.settled') {
      settle(group, step.occurredAt)
      if (key) close(executions.get(key), step.occurredAt)
    }
  }
  // Keep the latest model request visible with its independent wait/response rows.
  const latest = [...models.values()].at(-1)
  const modelRows = new Set(latest ? [latest.sending, latest.wait, latest.response] : [])
  const toolRows = [...tools.values()]
  const activeTools = toolRows.filter((row) => row.running && row.endedAt === undefined)
  const visibleTools = new Set([...activeTools, ...toolRows.slice(-1)])
  const latestTotal = [...executions.values()].at(-1)
  const latestRetry = [...retries.values()].at(-1)
  const latestError = [...rows].reverse().find((row) => row.phase === 'error')
  const visible = rows.filter((row) => {
    if (['sending', 'model-wait', 'streaming'].includes(row.phase)) return modelRows.has(row)
    if (row.phase === 'tool') return visibleTools.has(row)
    if (row.phase === 'total') return row === latestTotal
    if (row.phase === 'retry') return row === latestRetry
    if (row.phase === 'error') return row === latestError
    return true
  })
  if (facts.waitingForUser) {
    for (const row of visible) if (row.phase !== 'total') row.running = false
    visible.push({ key: 'user-wait', phase: 'user-wait', label: '等待你的回答', tone: 'warning', running: true })
  } else if (terminalStates.has(facts.state)) {
    const subject = facts.steps === undefined ? '任务' : '请求'
    visible.push({ key: 'terminal', phase: 'terminal', label: facts.state === 'succeeded' ? `${subject}已完成` : facts.state === 'failed' ? `${subject}失败` : `${subject}已停止或受阻`, tone: facts.state === 'succeeded' ? 'success' : 'danger', running: false, error: facts.error })
  } else if (visible.length === 0) {
    const label = { received: '已接收，准备发送请求', matching: '正在整理你的请求', created: '准备执行', admitted: '排队等待执行', settling: '正在核对执行结果', 'awaiting-clarification': '等待你的补充', answered: '已回答', 'status-only': '已回答' }[facts.state] ?? '等待执行回执'
    visible.push({ key: 'state', phase: 'state', label, tone: 'warning', running: false })
  }
  if (finished) for (const row of visible) row.running = false
  return visible
}

// One controller per conversation host. Re-rendering never owns a new timer.
export function createConversationStatusClock(host, { now = Date.now, schedule = setInterval, cancel = clearInterval } = {}) {
  let timer
  let bindings = []
  const paint = () => {
    for (const { row, node } of bindings) {
      const seconds = elapsedSeconds(row, now())
      node.textContent = seconds === undefined ? '' : `${seconds} 秒`
      node.hidden = seconds === undefined
    }
  }
  const dispose = () => { if (timer !== undefined) cancel(timer); timer = undefined; bindings = [] }
  return {
    update(next) {
      dispose()
      bindings = next
      paint()
      if (bindings.some(({ row }) => row.running && validTime(row.startedAt))) timer = schedule(() => {
        if (!host.isConnected) { dispose(); return }
        paint()
      }, 1000)
    },
    dispose,
  }
}
