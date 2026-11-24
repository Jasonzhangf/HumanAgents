import { element } from './runtime-api.js'

const tools = {
  'select-skills': '加载本轮技能',
  'read-task-result': '读取任务结果',
  'submit-turn': '提交本轮结果',
}
const statuses = {
  succeeded: '已完成', failed: '失败', blocked: '受阻',
  cancelled: '已取消', unknown: '状态未知',
}
const skills = { 'task-intake': '任务接单', 'project-management': '项目管理', 'agent-addressing': 'Agent 寻址', 'agent-communication': 'Agent 通信' }
const taskStates = { succeeded: '任务已完成', running: '任务执行中', waiting: '任务正在等待', blocked: '任务受阻', failed: '任务失败', stopped: '任务已停止', cancelled: '任务已取消', queued: '任务已入队' }
const publications = { committed: '已取得已发布结果', pending: '正式结果尚待发布', unavailable: '暂无已发布结果', ambiguous: '存在多个执行记录，需要确认', unknown: '结果发布状态未知' }
const decisions = { answer: '直接答复', 'status-query': '汇报任务状态', clarification: '请用户补充信息',
  create: '整理新任务', append: '整理追加要求', change: '整理变更要求', partial: '本轮部分完成，可继续' }
const label = (values, key) => Object.hasOwn(values, key) ? values[key] : undefined

function detailText(detail) {
  if (detail?.kind === 'skills') return detail.skills.map(skill => label(skills, skill)).filter(Boolean).join('、')
  if (detail?.kind === 'task-result') return [detail.title, label(taskStates, detail.taskState), label(publications, detail.publicationState)].filter(Boolean).join(' · ')
  if (detail?.kind === 'decision') return [label(decisions, detail.decision), detail.title].filter(Boolean).join(' · ')
}

export function explicitToolRows(steps = [], finished = false) {
  const rows = new Map()
  for (const step of steps) {
    const tool = step.tool
    if (!step.turnId || !step.requestId || !tool?.callId || !Object.hasOwn(tools, tool.kind)) continue
    const key = JSON.stringify([step.turnId, step.requestId, tool.callId])
    const previous = rows.get(key)
    if (step.kind === 'tool.started' && !previous) {
      rows.set(key, { label: tools[tool.kind], status: finished ? '结果未记录' : '等待工具返回', result: 'pending' })
    } else if (step.kind === 'tool.finished' && tool.status) {
      rows.set(key, { label: tools[tool.kind], status: statuses[tool.status] || '状态未知', result: tool.status, explanation: detailText(tool.detail),
        ...(tool.errorCode ? { errorCode: tool.errorCode } : {}) })
    }
  }
  return [...rows.values()]
}

const snapshots = new WeakMap()

export function renderExplicitToolActivity(host, steps, finished) {
  const rows = explicitToolRows(steps, finished)
  const previous = snapshots.get(host)
  if (!rows.length) {
    previous?.node.remove()
    snapshots.delete(host)
    return
  }
  const signature = JSON.stringify(rows)
  if (previous?.signature === signature) return
  const activity = previous?.node || element('div', undefined, 'mt-explicit-tools')
  activity.setAttribute('aria-label', 'Jenny 的工具调用')
  activity.replaceChildren(...rows.map(row => {
    const card = element('section', undefined, 'tool-card mt-explicit-tool')
    card.dataset.status = row.result
    card.setAttribute('aria-label', `${row.label}，${row.status}`)
    card.append(element('strong', row.label))
    if (row.explanation) card.append(element('span', row.explanation, 'mt-explicit-explanation'))
    if (!row.errorCode && row.result !== 'succeeded') card.append(element('span', row.status, 'muted'))
    if (row.errorCode) card.append(element('span', row.errorCode, 'conversation-status-error'))
    return card
  }))
  snapshots.set(host, { node: activity, signature })
  if (!previous) host.append(activity)
}
