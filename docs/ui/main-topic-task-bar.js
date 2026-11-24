import { element } from './runtime-api.js'
import { conversationStatus } from './conversation-status.js'
import { taskBlocker } from './task-blocker.js'
import { sanitizeUserVisibleText } from './step-labels.js'

const terminal = new Set(['succeeded', 'completed', 'failed', 'blocked', 'stopped', 'cancelled', 'stale'])
const success = new Set(['succeeded', 'completed'])
const danger = new Set(['failed', 'blocked'])
const waiting = new Set(['waiting'])
const states = new WeakMap()
let nextId = 0

const taskValue = id => typeof id === 'string' ? id : id?.value

function latestTask(projection = {}) {
  const tasks = projection.tasks ?? []
  const activeId = taskValue(projection.activeTask?.taskId)
  return tasks.find(task => taskValue(task.taskId) === activeId) ?? [...tasks]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0]
}

function taskTurn(turns = [], task) {
  const id = taskValue(task?.taskId)
  if (!id) return undefined
  return [...turns].reverse().find(turn => taskValue(turn.taskId) === id
    && (turn.statusFacts || turn.toolEvents || turn.kind === 'draft'))
}

function rowsFor(task, turn) {
  const facts = turn?.statusFacts ?? { state: task?.state, events: turn?.toolEvents ?? [],
    waitingForUser: task?.state === 'waiting' }
  const rows = conversationStatus(facts)
  if (!terminal.has(task?.state)) return rows
  return [...rows.filter(row => row.phase !== 'terminal').map(row => ({ ...row, running: false })), {
    key: `terminal:${task.state}`,
    phase: 'terminal',
    label: task.state === 'succeeded' || task.state === 'completed' ? '任务已完成' : '任务已停止或受阻',
    tone: success.has(task.state) ? 'success' : danger.has(task.state) ? 'danger' : 'warning',
    running: false,
    ...(task.error === undefined ? {} : { error: task.error }),
  }]
}

function nextStepText(value, rows) {
  const text = sanitizeUserVisibleText(value)
  const rawProviderWait = /\bprovider\b|provider\s*事件|等待\s*provider\s*事件/iu.test(text)
  if (text === '' || rawProviderWait || rows.some(row => text === row.label.trim())) return ''
  return text
}

function currentRow(rows) {
  const visible = rows.filter(row => row.phase !== 'total')
  const terminalRow = [...visible].reverse().find(row => row.phase === 'terminal')
  return [...visible].reverse().find(row => row.running) ?? terminalRow
    ?? [...visible].reverse().find(row => row.phase !== 'terminal') ?? visible.at(-1)
}

function phaseText(row, task) {
  if (!row) return task.currentStepLabel || task.stateLabel
  if (row.phase === 'state') return task.currentStepLabel || row.label || task.stateLabel
  if (row.phase === 'terminal') return success.has(task.state) ? '结果已交付'
    : danger.has(task.state) ? '执行受阻' : '执行已结束'
  if (row.phase === 'tool') {
    return row.running ? `${row.label} · 等待工具结果` : `${row.label}${row.statusLabel ? ` · ${row.statusLabel}` : ''}`
  }
  if (row.phase === 'retry' && row.running) return `${row.label} · 等待重试`
  return row.label || task.currentStepLabel
}

function tone(task) {
  if (success.has(task.state)) return 'success'
  if (danger.has(task.state)) return 'danger'
  if (waiting.has(task.state)) return 'warning'
  if (terminal.has(task.state)) return 'neutral'
  return 'active'
}

function create(host) {
  const id = `jenny-task-detail-${++nextId}`
  const root = element('section', undefined, 'jenny-task-bar')
  root.setAttribute('aria-label', 'Jenny 最近交办任务')
  const toggle = element('button', undefined, 'jenny-task-bar-toggle')
  toggle.type = 'button'
  toggle.setAttribute('aria-controls', id)
  toggle.setAttribute('aria-expanded', 'false')
  const mark = element('span', '', 'jenny-task-bar-mark')
  mark.setAttribute('aria-hidden', 'true')
  const title = element('span', '', 'jenny-task-bar-title')
  const phase = element('span', '', 'jenny-task-bar-phase')
  phase.setAttribute('aria-live', 'polite')
  const chevron = element('span', '展开', 'jenny-task-bar-chevron')
  chevron.setAttribute('aria-hidden', 'true')
  toggle.append(mark, title, phase, chevron)

  const detail = element('div', undefined, 'jenny-task-bar-detail')
  detail.id = id
  detail.hidden = true
  const heading = element('header', undefined, 'jenny-task-bar-detail-head')
  const detailTitle = element('strong')
  heading.append(detailTitle)
  const route = element('p', '', 'jenny-task-bar-route')
  const blocker = element('div', undefined, 'jenny-task-bar-blocker')
  blocker.hidden = true
  const reason = element('p', '', 'jenny-task-bar-reason')
  blocker.append(reason)
  const next = element('p', '', 'jenny-task-bar-next')
  const open = element('button', '查看完整执行链', 'button jenny-task-bar-open')
  open.type = 'button'
  detail.append(heading, route, blocker, next, open)
  root.append(toggle, detail)

  const state = { root, toggle, detail, title, phase, chevron, detailTitle, route,
    blocker, reason, next, open: false, taskKey: undefined, scopeKey: undefined, context: undefined }
  toggle.addEventListener('click', () => {
    state.open = !state.open
    toggle.setAttribute('aria-expanded', String(state.open))
    detail.hidden = !state.open
    root.dataset.expanded = String(state.open)
    chevron.textContent = state.open ? '收起' : '展开'
  })
  open.addEventListener('click', () => state.context?.onOpenDispatch?.(open, state.context.task, state.context.turn))
  states.set(host, state)
  return state
}

export function renderMainTopicTaskBar(host, projection, { onOpenDispatch } = {}) {
  if (!(host instanceof HTMLElement)) throw new Error('main topic task bar requires a host element')
  const state = states.get(host) ?? create(host)
  const scopeKey = JSON.stringify([projection.projectKey, projection.mode, projection.workspaceCwd])
  if (state.scopeKey !== scopeKey) {
    state.scopeKey = scopeKey
    state.taskKey = undefined
  }
  const task = latestTask(projection)
  if (!task) {
    state.root.hidden = true
    return state.root
  }
  const turn = taskTurn(projection.turns ?? [], task)
  const taskKey = taskValue(task.taskId)
  if (state.taskKey !== taskKey) {
    state.taskKey = taskKey
    state.open = false
    state.toggle.setAttribute('aria-expanded', 'false')
    state.detail.hidden = true
    state.root.dataset.expanded = 'false'
    state.chevron.textContent = '展开'
  }
  state.context = { task, turn, onOpenDispatch }
  state.root.hidden = false
  state.root.dataset.tone = tone(task)
  const rows = rowsFor(task, turn)
  const row = currentRow(rows)
  const phase = phaseText(row, task)
  const blocker = danger.has(task.state) ? taskBlocker(task) : null
  const scope = projection.projectName || projection.projectKey || '当前项目'
  const title = task.semanticTitle || task.title || '已交办任务'
  state.title.textContent = title
  state.phase.textContent = phase
  state.toggle.setAttribute('aria-label', `${scope}，Jenny 交办：${title}，${phase}`)
  state.detailTitle.textContent = '执行摘要'
  state.route.textContent = `Jenny 交办 · 编排 Agent 执行 · ${scope} / 主会话`
  state.blocker.hidden = !blocker?.reason
  state.reason.textContent = blocker?.reason || ''
  const nextText = blocker?.next || (terminal.has(task.state) ? '' : nextStepText(task.nextStep, rows))
  state.next.hidden = nextText === ''
  state.next.textContent = nextText === '' ? '' : `下一步：${nextText}`
  state.root.dataset.active = String(rows.some(item => item.running))
  if (host.firstElementChild !== state.root) host.prepend(state.root)
  return state.root
}

export function disposeMainTopicTaskBar(host) {
  const state = states.get(host)
  if (!state) return
  state.root.remove()
  states.delete(host)
}
