import { element } from './runtime-api.js'
import { elapsedSeconds, explicitToolLabel } from './conversation-status.js'
import { taskBlocker } from './task-blocker.js'

const statuses = {
  succeeded: '已完成', failed: '失败', blocked: '受阻',
  cancelled: '已取消', unknown: '状态未知',
}
const skills = { 'task-intake': '任务接单', 'task-follow-through': '任务跟进', 'project-management': '项目管理', 'agent-addressing': 'Agent 寻址', 'agent-communication': 'Agent 通信' }
const taskStates = { succeeded: '任务已完成', running: '任务执行中', waiting: '任务正在等待', blocked: '任务受阻', failed: '任务失败', stopped: '任务已停止', cancelled: '任务已取消', queued: '任务已入队' }
const publications = { pending: '正式结果尚待发布', unavailable: '暂无已发布结果', ambiguous: '存在多个执行记录，需要确认', unknown: '结果发布状态未知' }
const continuations = { released: '已恢复原任务执行', 'in-progress': '原任务正在推进', complete: '原任务已完成', blocked: '原任务待处理' }
const decisions = { answer: '直接答复', 'status-query': '汇报任务状态', clarification: '请用户补充信息',
  create: '整理新任务', append: '整理追加要求', change: '整理变更要求', partial: '本轮部分完成，可继续' }
const label = (values, key) => Object.hasOwn(values, key) ? values[key] : undefined

function detailText(detail) {
  if (detail?.kind === 'skills') return detail.skills.map(skill => label(skills, skill)).filter(Boolean).join('、') || '已选择本轮技能'
  if (detail?.kind === 'task-result') {
    const publication = detail.publicationState === 'committed'
      ? detail.resultAvailable === true ? '已取得已发布结果' : '暂无可显示的已发布结果'
      : label(publications, detail.publicationState)
    return [detail.title, label(continuations, detail.continuation) || label(taskStates, detail.taskState), publication].filter(Boolean).join(' · ')
  }
  if (detail?.kind === 'decision') return [label(decisions, detail.decision), detail.title].filter(Boolean).join(' · ')
}

export function explicitToolRows(steps = [], finished = false) {
  const rows = new Map()
  for (const step of steps) {
    const tool = step.tool
    const action = explicitToolLabel(tool?.kind)
    if (!step.turnId || !step.requestId || !tool?.callId || !action) continue
    const key = JSON.stringify([step.turnId, step.requestId, tool.callId])
    const row = rows.get(key) || { label: action, result: 'pending' }
    if (step.kind === 'tool.started' && row.startedAt === undefined) row.startedAt = step.occurredAt
    if (step.kind === 'tool.finished') {
      row.endedAt = step.occurredAt
      row.result = tool.detail?.continuation === 'blocked' ? 'blocked' : tool.status || 'unknown'
      row.status = statuses[row.result] || '状态未知'
      const explanation = detailText(tool.detail)
      if (explanation) row.explanation = explanation
      if (tool.detail?.blocker) {
        const { code, reason, nextStep } = tool.detail.blocker
        row.blocker = taskBlocker({ state: 'blocked', error: { code, message: reason }, nextStep })
      }
      if (tool.errorCode) row.errorCode = tool.errorCode
    }
    rows.set(key, row)
  }
  return [...rows.values()].map(row => {
    const missingResult = finished && row.endedAt === undefined
    return {
      ...row,
      status: missingResult ? '结果未记录' : row.status || '等待工具返回',
      running: !missingResult && row.result === 'pending',
    }
  })
}

// The message card and this detail are two views of the same turn. A call is
// still live only while its own request is received or matching; once the turn
// has advanced, a recorded call without a result is missing evidence.
export function explicitToolActivityFinished(turn = {}) {
  const state = turn.statusFacts?.state
  return Boolean(turn.statusFacts?.steps && !['received', 'matching'].includes(state))
    || Boolean(turn.localStatus?.some(row => row.error))
}

const snapshots = new WeakMap()

export function renderExplicitToolActivity(host, steps, finished, bindings = []) {
  const rows = explicitToolRows(steps, finished)
  const previous = snapshots.get(host)
  if (!rows.length) {
    previous?.node.remove()
    snapshots.delete(host)
    return
  }
  const signature = JSON.stringify([finished, rows])
  if (previous?.signature === signature) {
    bindExplicitToolActivity(host, bindings)
    return
  }
  const activity = previous?.node || element('div', undefined, 'mt-explicit-tools')
  activity.setAttribute('aria-label', 'Jenny 的工具调用')
  const times = new Map()
  activity.replaceChildren(...rows.map(row => {
    const card = element('section', undefined, 'tool-card mt-explicit-tool')
    card.dataset.status = row.result
    card.setAttribute('aria-label', `${row.label}，${row.status}`)
    card.append(element('strong', row.label))
    if (row.explanation) card.append(element('span', row.explanation, 'mt-explicit-explanation'))
    card.append(element('span', row.status, 'muted'))
    if (row.errorCode) card.append(element('span', row.errorCode, 'conversation-status-error'))
    if (row.blocker) card.append(element('span', [row.blocker.reason, row.blocker.code, row.blocker.next].filter(Boolean).join(' · '), 'mt-explicit-explanation'))
    const time = element('time', '', 'conversation-status-time mt-explicit-time')
    const seconds = elapsedSeconds(row)
    time.textContent = seconds === undefined ? '' : `${seconds} 秒`
    time.hidden = seconds === undefined
    card.append(time)
    times.set(row, time)
    return card
  }))
  snapshots.set(host, { node: activity, signature, times })
  bindExplicitToolActivity(host, bindings)
  if (!previous) host.append(activity)
}

// Polling reuses completed cards. The caller supplies the shared clock bindings
// so a running call advances its own duration without resetting model timing.
export function bindExplicitToolActivity(host, bindings = []) {
  for (const [row, node] of snapshots.get(host)?.times ?? []) bindings.push({ row, node })
}
