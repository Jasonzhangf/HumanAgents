// Public read facts in, presentation out. The clock never creates a phase.
const terminalStates = new Set(['succeeded', 'failed', 'blocked', 'stopped', 'cancelled', 'stale'])
const successStates = new Set(['succeeded', 'completed', 'answered', 'status-only'])
const activeProgressModelStates = new Set(['dispatching', 'dispatched', 'waiting', 'settled'])
const explicitFinished = new Set(['answered', 'status-only', 'confirmed', 'dispatched', 'rejected'])

function isHealthyProgressionEvent(event, taskState) {
  if (!event) return false
  if (event.kind === 'execution.started') return true
  if (event.kind === 'provider.model') return activeProgressModelStates.has(event.state)
  if (event.kind === 'provider.output' || event.kind === 'provider.tool') return true
  if (event.kind === 'provider.tool-result') return event.status === 'succeeded'
  if (event.kind === 'execution.terminal') return event.state === 'succeeded' || successStates.has(taskState)
  return false
}

function supersededEventKey(event) {
  return `${event?.seq ?? ''}:${event?.executionEpoch ?? ''}:${event?.kind ?? ''}:${event?.callId ?? ''}`
}

export function isSupersededEvent(superseded, event) {
  if (!superseded || !event) return false
  return superseded.events.has(event) || (event.seq !== undefined && superseded.keys.has(supersededEventKey(event)))
}

export function supersededEventSet(events = [], taskState) {
  const supersededEvents = new Set()
  const supersededKeys = new Set()
  const add = (event) => {
    supersededEvents.add(event)
    if (event?.seq !== undefined) supersededKeys.add(supersededEventKey(event))
  }
  if (successStates.has(taskState)) {
    for (const event of events) add(event)
    return { events: supersededEvents, keys: supersededKeys }
  }
  let seenHealthyAfter = false
  let maxEpochAfter = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const epoch = Number.isSafeInteger(event?.executionEpoch) ? event.executionEpoch : 0
    if (seenHealthyAfter || (epoch > 0 && maxEpochAfter > epoch)) {
      add(event)
    }
    if (isHealthyProgressionEvent(event, taskState)) seenHealthyAfter = true
    if (epoch > maxEpochAfter) maxEpochAfter = epoch
  }
  return { events: supersededEvents, keys: supersededKeys }
}
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const executionKey = (e) => JSON.stringify([e.taskId?.scope, e.taskId?.value, e.operationId, e.executionEpoch])
const requestKey = (e) => e.requestId ? `${executionKey(e)}:${JSON.stringify([e.turnId, e.requestId])}` : executionKey(e)
const toolKey = (e) => `${requestKey(e)}:${JSON.stringify(e.callId)}`
const toolLabels = Object.freeze({
  'file.read': '读取文件',
  'file.write': '写入文件',
  'file.edit': '修改文件',
  'file.search': '搜索文件',
  'file.list': '列出文件',
  'web.search': '搜索网页',
  bash: '执行命令',
})
const explicitToolLabels = Object.freeze({
  'select-skills': '加载本轮技能',
  'read-task-result': '读取任务结果',
  'project-snapshot': '查看项目进展',
  'resume-task': '继续原任务',
  'submit-turn': '提交本轮结果',
})
export const explicitToolLabel = kind => Object.hasOwn(explicitToolLabels, kind) ? explicitToolLabels[kind] : undefined
const toolResultLabels = Object.freeze({
  succeeded: '已完成',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消',
  unknown: '状态未知',
})
const toolLabel = (event) => Object.hasOwn(toolLabels, event.toolId) ? toolLabels[event.toolId] : '工具操作'

export function elapsedSeconds(row, now = Date.now()) {
  if (!validTime(row.startedAt)) return undefined
  const end = validTime(row.endedAt) ? Date.parse(row.endedAt) : row.running ? now : undefined
  if (end === undefined || end < Date.parse(row.startedAt)) return undefined
  return Math.floor((end - Date.parse(row.startedAt)) / 1000)
}

export function conversationStatusTime(row, now = Date.now()) {
  const elapsed = elapsedSeconds(row, now)
  if (elapsed === undefined) return ''
  if (!validTime(row.retryDeadlineAt)) return `${elapsed} 秒`
  const waited = `已等 ${elapsed} 秒`
  if (!row.running) return waited
  const remaining = Math.ceil((Date.parse(row.retryDeadlineAt) - now) / 1000)
  return `${waited} · ${remaining > 0 ? `${remaining} 秒后重试` : '等待重试发出'}`
}

export function conversationStatus(facts = {}, { allRequests = false } = {}) {
  const rows = []
  const models = new Map()
  const tools = new Map()
  const executions = new Map()
  const endedExecutions = new Set()
  const finishing = new Map()
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
  const respond = (group, at, output = true) => {
    if (!group || group.settled || group.returnedTool) return
    close(group.wait, at)
    if (group.wait) group.wait.label = '等待模型响应（已收到）'
    if (!group.response) group.response = add(`response:${rows.length}`, 'streaming', '模型正在处理', at, 'active')
    if (output) group.response.label = '正在接收模型响应'
  }
  const respondWithTool = (group, at, action) => {
    if (!group || group.settled) return
    if (!group.returnedTool) {
      respond(group, at, false)
      group.returnedTool = true
      close(group.response, at)
      group.response.label = '模型已返回工具调用'
      group.response.tone = 'success'
    }
    if (action) {
      group.actions ??= new Set()
      group.actions.add(action)
      group.response.statusLabel = [...group.actions].join('、')
    }
  }
  const dispatch = (key, at) => {
    const group = models.get(key)
    close(group?.sending, at)
    if (group?.sending) { group.sending.label = '请求已发出'; group.sending.tone = 'success' }
    if (group && !group.wait) group.wait = add(`${key}:wait`, 'model-wait', '等待模型响应', at)
    else if (!group) model(key, at)
  }
  const settle = (group, at) => {
    if (group) group.settled = true
    close(group?.response, at)
    if (group?.response && !group.returnedTool) { group.response.label = '模型响应已结束'; group.response.tone = 'success' }
    // A settled request with no first-response fact cannot supply wait duration.
    if (group?.wait) group.wait.running = false
  }
  const events = facts.events ?? []
  const superseded = allRequests ? null : supersededEventSet(events, facts.state)
  // Task/operation/epoch and explicit request/turn are separate identity domains.
  for (const e of events) {
    const key = requestKey(e)
    const group = models.get(key)
    if (['provider.model', 'provider.output', 'execution.terminal'].includes(e.kind)) {
      const retry = retries.get(executionKey(e))
      if (retry && retry.endedAt === undefined) {
        close(retry, e.occurredAt)
        retry.statusLabel = e.kind === 'execution.terminal' ? '重试已结束' : '已发出重试请求'
      }
    }
    const execution = executionKey(e)
    if (e.kind === 'execution.started' && (!executions.has(execution) || endedExecutions.has(execution))) {
      executions.set(execution, add(`${execution}:total:${rows.length}`, 'total', '本次执行耗时', e.occurredAt, 'active'))
      endedExecutions.delete(execution)
      finishing.delete(execution)
    }
    if (e.kind === 'execution.settling' && !finishing.has(execution)) {
      finishing.set(execution, add(`${execution}:finishing`, 'task-settling', '正在收尾', e.occurredAt, 'active'))
    }
    if (e.kind === 'execution.terminal' && e.terminalPhase === 'final') {
      close(executions.get(execution), e.occurredAt)
      close(finishing.get(execution), e.occurredAt)
      endedExecutions.add(execution)
    }
    if (e.kind === 'provider.model') {
      if (e.state === 'dispatching') model(key, e.occurredAt, true)
      else if (e.state === 'dispatched') dispatch(key, e.occurredAt)
      else if (e.state === 'settled') settle(group, e.occurredAt)
      else if (e.state === 'waiting') { if (!group?.wait) dispatch(key, undefined) }
      else if (e.state === undefined) model(key, e.occurredAt)
      else if (e.state === 'planner.aligning' && finishing.get(execution)?.phase !== 'task-verification') {
        close(finishing.get(execution), e.occurredAt)
        finishing.set(execution, add(`${execution}:verification`, 'task-verification', '正在核对交付结果', e.occurredAt, 'active'))
      } else if (e.state === 'planner.aligned') {
        const verification = finishing.get(execution)
        if (verification?.phase === 'task-verification') {
          close(verification, e.occurredAt)
          verification.label = '交付结果已核对'
          verification.tone = 'success'
        }
      }
    }
    if (e.kind === 'provider.output') respond(group, e.occurredAt)
    if (e.kind === 'provider.tool' && e.callId) {
      respondWithTool(group, e.occurredAt, e.toolId && toolLabel(e))
      const key = toolKey(e)
      if (!tools.has(key)) tools.set(key, add(key, 'tool', toolLabel(e), e.occurredAt, 'active'))
    }
    if (e.kind === 'provider.tool-result' && e.callId) {
      const row = tools.get(toolKey(e))
      if (row) {
        close(row, e.occurredAt)
        row.statusLabel = toolResultLabels[e.status] || '已返回'
        row.tone = e.status === 'failed' ? 'danger' : e.status === 'succeeded' ? 'success' : 'warning'
        row.error = e.error
      }
    }
    if (e.kind === 'execution.terminal' && e.terminalPhase === 'provider') {
      settle(group, e.occurredAt)
    }
    if (e.kind === 'provider.error') {
      close(group?.sending, e.occurredAt)
      close(group?.wait, e.occurredAt)
      close(group?.response, e.occurredAt)
      if (!isSupersededEvent(superseded, e)) {
        const row = add(`${key}:error:${e.seq}`, 'error', '请求失败', undefined, 'danger')
        row.error = e.error
        row.running = false
      }
    }
    if (e.kind === 'execution.retry' && (e.state === undefined || e.state === 'retrying')) {
      if (!isSupersededEvent(superseded, e)) {
        const timed = validTime(e.retryDeadlineAt) && validTime(e.occurredAt)
        const attempt = Number.isSafeInteger(e.attemptNumber) ? `第 ${e.attemptNumber} 次尝试` : undefined
        const row = add(`${key}:retry:${e.seq}`, 'retry', attempt || e.summary || '正在重试当前任务', timed ? e.occurredAt : undefined)
        row.running = timed && !finished
        if (timed) row.retryDeadlineAt = e.retryDeadlineAt
        row.error = e.error
        retries.set(executionKey(e), row)
      }
    } else if (e.kind === 'execution.retry' && e.state === 'blocked') {
      const row = retries.get(executionKey(e))
      if (row) {
        row.label = e.maxAttempts ? '自动重试已用尽' : e.summary || row.label
        row.tone = 'danger'
        close(row, e.occurredAt)
        row.error = e.error
      }
    }
  }
  for (const step of facts.steps ?? []) {
    // Unidentified steps can describe a phase, but cannot close another request.
    const key = step.requestId && step.turnId ? JSON.stringify([step.turnId, step.requestId]) : undefined
    const group = key === undefined ? undefined : models.get(key)
    if (step.kind === 'request.dispatching') {
      if (!group) model(key ?? `unpaired:${step.seq}`, step.occurredAt, true)
      if (key && !executions.has(key)) executions.set(key, add(`${key}:total`, 'total', '本次请求总耗时', step.occurredAt, 'active'))
    }
    if (step.kind === 'request.dispatched') {
      dispatch(key ?? `unpaired:${step.seq}`, step.occurredAt)
      if (key && !executions.has(key)) executions.set(key, add(`${key}:total`, 'total', '本次请求总耗时', step.occurredAt, 'active'))
    }
    if (step.kind === 'response.reasoning' || step.kind === 'response.streaming') {
      respond(group, step.occurredAt, step.kind === 'response.streaming')
    }
    if (step.kind === 'tool.started' && step.tool) respondWithTool(group, step.occurredAt, explicitToolLabel(step.tool.kind))
    if (step.kind === 'request.settled') {
      settle(group, step.occurredAt)
      if (key) close(executions.get(key), step.occurredAt)
    }
  }
  // Keep the latest model request visible with its independent wait/response
  // rows. Tool facts stay visible after the next request starts: each call has
  // its own task/operation/epoch/call identity and duration.
  const latest = [...models.values()].at(-1)
  const modelRows = new Set(latest ? [latest.sending, latest.wait, latest.response] : [])
  const toolRows = [...tools.values()]
  const visibleTools = new Set(toolRows)
  const latestTotal = rows.findLast(row => row.phase === 'total')
  const latestFinishing = [...finishing.values()].at(-1)
  const latestRetry = [...retries.values()].at(-1)
  const latestError = [...rows].reverse().find((row) => row.phase === 'error')
  const visible = rows.filter((row) => {
    if (['sending', 'model-wait', 'streaming'].includes(row.phase)) return allRequests || modelRows.has(row)
    if (row.phase === 'tool') return visibleTools.has(row)
    if (row.phase === 'total') return allRequests || row === latestTotal
    if (row.phase === 'task-settling' || row.phase === 'task-verification') return allRequests || row === latestFinishing
    if (row.phase === 'retry') return allRequests || row === latestRetry
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
  if (finished) for (const row of visible) {
    row.running = false
    if (row.phase === 'total' && row.endedAt === undefined) {
      row.label = facts.steps === undefined ? '本次执行结束时间未记录' : '本次请求结束时间未记录'
      row.tone = 'warning'
    }
  }
  return visible
}

// One controller per conversation host. Re-rendering never owns a new timer.
export function createConversationStatusClock(host, { now = Date.now, schedule = setInterval, cancel = clearInterval } = {}) {
  let timer
  let bindings = []
  const paint = () => {
    const time = now()
    for (const { row, node } of bindings) {
      const text = conversationStatusTime(row, time)
      node.textContent = text
      node.hidden = text === ''
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
