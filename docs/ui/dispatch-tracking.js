import { element, formatTime } from './runtime-api.js'
import { renderProductSessionView, disposeProductSessionView, scopedProductToolEvents } from './product-session-view.js'
import { taskBlocker } from './task-blocker.js'

export const taskValue = id => typeof id === 'string' ? id : id?.value
const roleLabel = role => ({ orchestration: '编排 Agent', execution: '执行 Agent', planner: '规划 Agent', reviewer: '审查 Agent', interaction: '交互 Agent' }[role] || '角色未记录')
const terminal = new Set(['succeeded', 'completed', 'failed', 'blocked', 'stopped', 'cancelled', 'stale'])

// Only the task's formal source interaction can join turns; text is never a key.
export function taskForTurn(turn, tasks = []) {
  const id = taskValue(turn.taskId)
  if (id) return tasks.find(task => taskValue(task.taskId) === id)
  if (turn.interactionId) return tasks.find(task => task.sourceInteractionId === turn.interactionId)
}

export function childExecutionIds(read, scope) {
  return [...new Set((read?.relations || []).filter(edge => edge.kind === 'child-execution'
    && taskValue(edge.source?.taskRef) === scope.taskId
    && [edge.source, edge.target].every(ref => ref?.scope?.projectKey === scope.projectKey && ref.scope.mode === scope.mode))
    .map(edge => taskValue(edge.target.taskRef)).filter(Boolean))]
}

export function dispatchState(task, observation, executionObserved = false) {
  if (task.error || ['failed', 'blocked'].includes(task.state)) return '受阻'
  if (['succeeded', 'completed'].includes(task.state)) return '完成'
  if (['stopped', 'cancelled'].includes(task.state)) return '已停止'
  if (task.inputRequest) return '有新消息'
  const observed = executionObserved || observationTools(observation).length > 0
  return observed ? '跟踪中' : '等待接手'
}

export function applyTaskCardResult(card, task, observation, executionObserved) {
  const state = dispatchState(task, observation, executionObserved)
  const title = task.title || '已交办任务'
  card.dataset.result = state === '完成' ? 'success' : state === '受阻' ? 'error' : 'neutral'
  card.setAttribute('aria-label', [title, state, task.error?.code].filter(Boolean).join('，'))
  if (state === '受阻') {
    const { code, reason, next } = taskBlocker(task)
    card.append(element('span', code ? `${reason} ${code}` : reason, 'dispatch-error'))
    if (next) card.append(element('span', next, 'dispatch-next'))
  } else if (state !== '完成') {
    card.append(element('span', state, 'dispatch-state'))
  }
}

// Execution is observable independently of a receipt accepting the delivery.
export function executionIdentity(session, scope) {
  return [...new Set(scopedProductToolEvents({ ...session, toolScope: scope }).map(event => event.execution?.runtimeId).filter(Boolean))]
}

export function observationTools(observation) {
  const seen = new Set()
  return (observation?.nodes || []).flatMap(node => (node.toolSteps || []).flatMap(step => {
    const key = JSON.stringify([node.ownerAgentRole, step.turnId, step.stepId])
    if (!step.stepId || seen.has(key)) return []
    seen.add(key)
    return [{ stepId: step.stepId, turnId: step.turnId, name: step.name, status: step.status,
      occurredAt: step.occurredAt, role: node.ownerAgentRole }]
  }))
}

export function renderDispatchCard(turn, task, { onOpen, observation, executionObserved } = {}) {
  const card = element('div', undefined, 'dispatch-card')
  card.dataset.dispatchTaskId = taskValue(task.taskId)
  if (task.sourceInteractionId) card.dataset.interactionId = task.sourceInteractionId
  const copy = element('div', undefined, 'dispatch-card-copy')
  copy.append(element('strong', task.title || '已交办任务'), element('span', '已投递给 编排 Agent', 'dispatch-state'))
  applyTaskCardResult(copy, task, observation, executionObserved)
  card.dataset.result = copy.dataset.result
  const detail = element('button', '查看执行链', 'button conversation-status-detail')
  detail.type = 'button'
  detail.addEventListener('click', () => onOpen?.(detail, task, turn))
  card.append(copy, detail)
  return card
}

export function createDispatchTracking({ api, openDetail, scope, onChange = () => {} }) {
  const records = new Map()
  let disposed = false, timer, ticking = false, opened
  const keyFor = (task, selected) => JSON.stringify([selected.projectKey, selected.mode, taskValue(task.taskId)])
  const current = record => {
    const selected = scope()
    return selected?.projectKey === record.scope.projectKey && selected?.mode === record.scope.mode
  }
  const active = record => current(record) && !terminal.has(record.task.state)
  const hasExecution = record => record?.children?.some(child => scopedProductToolEvents({ ...child.session, toolScope: child.scope }).length > 0)
  function remember(task, selected = scope()) {
    if (!selected?.projectKey || !selected.mode || !taskValue(task.taskId)) return
    const key = keyFor(task, selected)
    const record = records.get(key) || { scope: { projectKey: selected.projectKey, mode: selected.mode, taskId: taskValue(task.taskId) } }
    record.task = { ...task }
    records.set(key, record)
    return record
  }
  async function read(record) {
    if (record.pending) return record.pending
    record.pending = (async () => {
      const before = JSON.stringify([record.children, record.error?.message])
      try {
        record.relations = await api.readProductRelations(record.scope)
        const children = childExecutionIds(record.relations, record.scope)
        record.children = await Promise.all((children.length ? children : [record.scope.taskId]).map(async taskId => {
          const childScope = { ...record.scope, kind: 'task', taskId }
          const reads = await Promise.allSettled([
            api.readProductSession(childScope),
            api.observation(taskId, undefined, undefined, undefined, childScope),
            api.semanticObservation(taskId, childScope),
          ])
          return { scope: childScope, session: reads[0].value, observation: reads[1].value, semantic: reads[2].value,
            failures: reads.filter(result => result.status === 'rejected').map(result => result.reason) }
        }))
        record.error = undefined
      } catch (error) { record.error = error }
      finally { record.pending = null }
      if (!disposed && current(record) && before !== JSON.stringify([record.children, record.error?.message])) {
        onChange(); if (opened?.record === record) paintDetail(opened)
      }
    })()
    return record.pending
  }
  function paintDetail(view) {
    const { record, host } = view
    const signature = JSON.stringify([record.task, record.children, record.error?.message])
    if (view.signature === signature) return
    view.signature = signature
    const disclosureKey = node => JSON.stringify([node.closest('[data-execution-task-id]')?.dataset.executionTaskId,
      node.closest('[data-step-id]')?.dataset.stepId, node.querySelector('summary')?.textContent])
    const focused = host.contains(document.activeElement) ? document.activeElement : undefined
    const focusedDisclosure = focused?.tagName === 'SUMMARY' ? disclosureKey(focused.parentElement) : undefined
    const disclosures = new Map([...host.querySelectorAll('details')].map(node => [disclosureKey(node), node.open]))
    const sessions = view.sessions || new Map()
    const nextSessions = new Map()
    const reused = new Set()
    const sessionView = (key, data, options) => {
      const signature = JSON.stringify(data)
      const previous = sessions.get(key)
      const node = previous?.node || element('div', undefined, 'dispatch-session')
      reused.add(node)
      nextSessions.set(key, { node, signature })
      if (previous?.signature !== signature) renderProductSessionView(node, data, options)
      return node
    }
    host.replaceChildren()
    applyTaskCardResult(host, record.task, record.children?.[0]?.observation, hasExecution(record))
    if (record.error) host.append(element('p', `暂时无法读取执行步骤${record.error.code ? `（${record.error.code}）` : ''}`, 'dispatch-error'))
    for (const child of record.children || []) {
      const section = element('section', undefined, 'dispatch-execution')
      section.dataset.executionTaskId = child.scope.taskId
      section.append(element('h3', '执行链'))
      const nodes = element('details')
      nodes.append(element('summary', '编排节点与状态'))
      for (const node of child.observation?.nodes || []) {
        const line = element('p', `${roleLabel(node.ownerAgentRole)} · ${node.stateDisplay || '状态未记录'}`)
        line.dataset.nodeId = node.nodeId
        nodes.append(line)
      }
      section.append(nodes)
      view.readers ??= new Map()
      const readerKey = JSON.stringify(child.scope)
      if (!view.readers.has(readerKey)) view.readers.set(readerKey, address => api.readScopedToolOutput(address, child.scope))
      const session = sessionView(`${child.scope.taskId}:tools`, { ...child.session, messages: [], toolScope: child.scope }, {
        readToolOutput: view.readers.get(readerKey),
      })
      if (child.session?.toolEvents?.length || child.session?.publicOutput) section.append(session)
      if (!child.session?.toolEvents?.length) {
        for (const step of observationTools(child.observation)) {
          const label = ({ 'file.list': '列出文件', 'file.read': '读取文件', bash: '执行命令' })[step.name] || '工具操作'
          const row = element('div', undefined, 'dispatch-tool-step')
          row.dataset.stepId = step.stepId
          if (step.turnId) row.dataset.turnId = step.turnId
          row.append(element('strong', `${roleLabel(step.role)} · ${label}`), element('span', `${({ succeeded: '已完成', failed: '失败', running: '执行中', blocked: '受阻', cancelled: '已取消', unknown: '状态未知' })[step.status] || '状态未记录'} · ${formatTime(step.occurredAt)}`))
          const detail = element('details')
          detail.append(element('summary', '操作详情'), element('p', `工具：${step.name} · stepId：${step.stepId} · turnId：${step.turnId || '未记录'}`), element('p', '旧读取接口未提供结构化参数或可读取的完整输出。'))
          row.append(detail); section.append(row)
        }
      }
      const lifecycle = element('details')
      lifecycle.append(element('summary', '模型与操作生命周期'))
      for (const event of child.semantic?.events || []) lifecycle.append(element('p', `${({ 'model.started': '模型开始处理', 'model.completed': '模型处理结束', 'operation.started': '操作开始', 'operation.completed': '操作完成', 'operation.failed': '操作失败' })[event.type] || '执行事件'} · ${formatTime(event.occurredAt)}`))
      section.append(lifecycle)
      const transcript = element('details')
      transcript.append(element('summary', '会话原文与技术记录'))
      const messages = sessionView(`${child.scope.taskId}:messages`, { messages: child.session?.messages || [] })
      transcript.append(messages); section.append(transcript)
      for (const failure of child.failures) section.append(element('p', `部分执行信息暂不可读${failure.code ? `（${failure.code}）` : ''}`))
      host.append(section)
    }
    for (const { node } of sessions.values()) if (!reused.has(node)) disposeProductSessionView(node)
    view.sessions = nextSessions
    for (const node of host.querySelectorAll('details')) if (disclosures.get(disclosureKey(node))) node.open = true
    if (focused?.isConnected) focused.focus({ preventScroll: true })
    else if (focusedDisclosure) [...host.querySelectorAll('details')].find(node => disclosureKey(node) === focusedDisclosure)?.querySelector('summary')?.focus({ preventScroll: true })
  }
  function open(trigger, task, turn) {
    const record = remember(task)
    if (!record) return
    record.turn = turn || record.turn
    const host = element('div', undefined, 'dispatch-detail')
    const view = { record, host }; opened = view
    paintDetail(view)
    const composer = document.querySelector('#entry-form textarea[name=rawInput]')
    const focused = document.activeElement?.closest?.('.entry-task-list-drawer') ? composer : document.activeElement
    openDetail({ title: task.title || '已交办任务', content: host, trigger, onClose: () => {
      for (const node of host.querySelectorAll('.dispatch-session')) disposeProductSessionView(node)
      if (opened === view) opened = undefined
      if (focused?.isConnected) focused.focus()
      else composer?.focus()
    } })
    void read(record)
  }
  function sync(tasks, turns = []) {
    tasks.forEach(task => {
      const previous = scope() && records.get(keyFor(task, scope()))
      const justFinished = previous && !terminal.has(previous.task.state) && terminal.has(task.state)
      const record = remember(task)
      const draft = turns.find(turn => turn.kind === 'draft' && taskForTurn(turn, [task]))
      if (record && draft) record.turn = draft
      if (justFinished) void Promise.resolve(record.pending).then(() => {
        if (!disposed && current(record)) return read(record)
      })
    })
    if (opened && current(opened.record)) paintDetail(opened)
    if (timer || ticking || disposed || ![...records.values()].some(active)) return
    const tick = async () => {
      timer = undefined
      ticking = true
      try { await Promise.all([...records.values()].filter(active).map(read)) }
      finally { ticking = false }
      if (!disposed && [...records.values()].some(active)) timer = setTimeout(tick, 4000)
    }
    timer = setTimeout(tick, 0)
  }
  return { sync, open, remember, records,
    dispose() { disposed = true; clearTimeout(timer); opened = undefined },
    observation(task) { return records.get(keyFor(task, scope()))?.children?.[0]?.observation },
    executionObserved(task) { return hasExecution(records.get(keyFor(task, scope()))) },
  }
}
