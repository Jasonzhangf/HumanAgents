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

export function explicitToolRows(steps = [], finished = false) {
  const rows = new Map()
  for (const step of steps) {
    const tool = step.tool
    if (!step.turnId || !step.requestId || !tool?.callId || !Object.hasOwn(tools, tool.kind)) continue
    const key = JSON.stringify([step.turnId, step.requestId, tool.callId])
    const previous = rows.get(key)
    if (step.kind === 'tool.started' && !previous) {
      rows.set(key, { label: tools[tool.kind], status: finished ? '结果未记录' : '等待工具返回' })
    } else if (step.kind === 'tool.finished' && tool.status) {
      rows.set(key, { label: tools[tool.kind], status: statuses[tool.status] || '状态未知',
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
    card.append(element('strong', row.label), element('span', row.status, 'muted'))
    if (row.errorCode) card.append(element('span', row.errorCode, 'conversation-status-error'))
    return card
  }))
  snapshots.set(host, { node: activity, signature })
  if (!previous) host.append(activity)
}
