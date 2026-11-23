import { element } from './runtime-api.js'

// Public execution identity only. A missing call identity never joins two facts.
function callKey(event) {
  if (!event.taskId?.value || !event.operationId || !Number.isSafeInteger(event.executionEpoch) || !event.callId) return undefined
  return JSON.stringify([event.taskId.scope, event.taskId.value, event.operationId, event.executionEpoch, event.callId])
}

export function toolPresentations(events = []) {
  const rows = new Map()
  for (const event of events) {
    if (event.kind !== 'provider.tool' && event.kind !== 'provider.tool-result') continue
    const key = callKey(event) ?? JSON.stringify(['unmatched', event.eventId, event.seq, rows.size])
    const row = rows.get(key) ?? { key }
    if (event.kind === 'provider.tool') row.call = event
    else row.result = event
    rows.set(key, row)
  }
  return [...rows.values()].map((row) => {
    const result = row.result
    return {
      ...row,
      ...(result?.status === 'succeeded' && result.outputRef && result.outputDigest && callKey(result) !== undefined
        ? { outputTarget: { taskId: result.taskId, operationId: result.operationId, executionEpoch: result.executionEpoch, seq: result.seq } }
        : {}),
    }
  })
}

export function toolOutputText(toolId, report) {
  if (toolId === 'file.read' && typeof report?.content === 'string') return report.content
  return typeof report === 'string' ? report : JSON.stringify(report, null, 2)
}

const STATUS = Object.freeze({ succeeded: '执行成功', failed: '执行失败', blocked: '执行受阻', cancelled: '已取消', unknown: '结果状态未知' })
const bodies = new WeakMap()

function toolCard(row, readOutput) {
  const card = element('section', undefined, 'tool-card')
  card.dataset.toolKey = row.key
  const toolId = row.call?.toolId ?? row.result?.toolId
  const title = toolId === 'file.read' ? '读取文件' : `工具：${toolId || '名称未提供'}`
  card.append(element('strong', title))
  if (toolId === 'file.read' && typeof row.call?.arguments?.path === 'string') {
    card.append(element('p', row.call.arguments.path, 'tool-path'))
  }
  const state = row.result ? (STATUS[row.result.status] || '结果状态未提供') : '调用未返回'
  card.append(element('p', row.call ? state : `${state} · 结果关联缺失`, 'tool-state'))
  card.dataset.status = row.result?.status || 'pending'
  if (row.result?.error) card.append(element('p', `${row.result.error.code || ''} ${row.result.error.message || ''}`.trim(), 'tool-error'))
  const details = element('details', undefined, 'tool-facts')
  details.append(element('summary', '调用参数与证据'))
  if (row.call?.arguments !== undefined) details.append(element('pre', JSON.stringify(row.call.arguments, null, 2)))
  details.append(element('pre', JSON.stringify({
    taskId: (row.call ?? row.result).taskId, operationId: (row.call ?? row.result).operationId,
    executionEpoch: (row.call ?? row.result).executionEpoch,
    callId: (row.call ?? row.result).callId, calledAt: row.call?.occurredAt,
    returnedAt: row.result?.occurredAt, outputRef: row.result?.outputRef,
    evidenceRefs: row.result?.evidenceRefs,
  }, null, 2)))
  card.append(details)
  if (row.outputTarget) {
    const button = element('button', '读取完整结果', 'tool-read-output')
    button.type = 'button'
    const feedback = element('p', '', 'tool-read-feedback')
    feedback.setAttribute('role', 'status')
    const output = element('pre', '', 'tool-output')
    output.hidden = true
    let loaded = false
    button.addEventListener('click', async () => {
      if (loaded) {
        output.hidden = !output.hidden
        button.textContent = output.hidden ? '展开完整结果' : '收起完整结果'
        return
      }
      button.disabled = true
      feedback.textContent = '正在读取完整结果…'
      try {
        const report = await readOutput(row.outputTarget)
        if (!card.isConnected) return
        output.textContent = toolOutputText(toolId, report)
        output.hidden = false
        loaded = true
        feedback.textContent = '完整结果已读取'
        button.textContent = '收起完整结果'
      } catch (error) {
        if (!card.isConnected) return
        feedback.textContent = `结果不可读：${error?.code ? `${error.code} · ` : ''}${error?.message || String(error)}`
        button.textContent = '重试读取完整结果'
      } finally {
        button.disabled = false
      }
    })
    card.append(button, feedback, output)
  } else if (row.result?.status === 'succeeded') {
    card.append(element('p', '结果正文未提供', 'tool-read-feedback'))
  }
  return card
}

// Keep open results and details through unchanged polling; no execution state.
export function renderToolBody(host, events, readOutput) {
  let previous = bodies.get(host) ?? new Map()
  const next = new Map()
  for (const row of toolPresentations(events)) {
    const signature = JSON.stringify(row)
    const old = previous.get(row.key)
    const item = old?.signature === signature ? old : { signature, node: toolCard(row, readOutput) }
    next.set(row.key, item)
    host.append(item.node)
  }
  for (const [key, item] of previous) if (next.get(key)?.node !== item.node) item.node.remove()
  bodies.set(host, next)
  host.hidden = next.size === 0
}
