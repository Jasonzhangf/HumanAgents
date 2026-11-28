import { element } from './runtime-api.js'
import { fileSemantics } from './tool-file-semantics.js'
import { shellSemantics } from './tool-shell-semantics.js'
import { taskSemantics } from './tool-task-semantics.js'
import { createDetailDisclosure } from './detail-disclosure.js'
import { explainedToolErrorReason } from './task-blocker.js'
import { isSupersededEvent, supersededEventSet } from './conversation-status.js'

const FILE_TOOLS = new Set(['file.read', 'file.write', 'file.edit', 'file.search', 'file.list', 'web.search'])
const TURN_END_TOOLS = new Set(['humanagent.turn.end', 'humanagent_turn_end'])
const RAW_TEXT_TOOLS = new Set(['bash', 'file.read'])
const DIFF_TOOLS = new Set(['file.write', 'file.edit'])

// One pure interpretation supplies both the immediate call and loaded result.
export function toolSemantics(toolId, args, report) {
  const interpret = FILE_TOOLS.has(toolId) ? fileSemantics : toolId === 'bash' ? shellSemantics : taskSemantics
  return interpret(toolId, args, report)
}

// Public execution identity only. A missing call identity never joins two facts.
function callKey(event) {
  if (!event.taskId?.value || !event.operationId || !Number.isSafeInteger(event.executionEpoch) || !event.callId) return undefined
  return JSON.stringify([event.taskId.scope, event.taskId.value, event.operationId, event.executionEpoch,
    event.turnId, event.requestId, event.callId])
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
  return [...rows.values()].filter((row) =>
    !TURN_END_TOOLS.has(row.call?.toolId) && !TURN_END_TOOLS.has(row.result?.toolId)).map((row) => {
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
  if (toolId === 'file.read' && typeof report?.content === 'string') return visibleText(report.content)
  if (toolId === 'bash' && report !== null && typeof report === 'object' && !Array.isArray(report)) {
    const exit = Number.isInteger(report.exitCode) ? report.exitCode : undefined
    const interrupted = report.timedOut === true || report.aborted === true || typeof report.signal === 'string'
    const outcome = interrupted ? '命令已中断' : exit === 0 ? '命令退出成功' : exit !== undefined ? '命令退出失败' : '命令退出状态未提供'
    const flag = (value) => value === true ? '是' : value === false ? '否' : '未提供'
    return [
      outcome, `退出码：${exit ?? (report.exitCode === null ? '无（null）' : '未提供')}`,
      `超时：${flag(report.timedOut)}`, `取消：${flag(report.aborted)}`,
      `信号：${typeof report.signal === 'string' ? report.signal : report.signal === null ? '无' : '未提供'}`,
      ...['stdout', 'stderr'].map((name) => {
        const stream = report[name]
        const label = name === 'stdout' ? '标准输出（stdout）' : '标准错误（stderr）'
        const truncation = stream?.truncated === true ? ' · 已截断，仅显示保留部分' : ''
        return `${label}${truncation}\n${typeof stream?.text === 'string' ? visibleText(stream.text) : '（未提供）'}`
      }),
    ].join('\n\n')
  }
  return typeof report === 'string' ? visibleText(report) : JSON.stringify(report, null, 2) ?? '（结果正文未提供）'
}

function visibleText(value) { return value === '' ? '（空字符串）' : value }

const STATUS = Object.freeze({ succeeded: '执行成功', failed: '执行失败', blocked: '执行受阻', cancelled: '已取消', unknown: '结果状态未知' })
const ACTOR = Object.freeze({ orchestration: '编排 Agent', execution: '执行 Agent', reviewer: '审查 Agent', planner: '规划 Agent' })
const bodies = new WeakMap()
const bodyPlaceholders = new Set(['尚无结果正文', '等待结果正文'])

function explainsCompletedResult(value) {
  const usefulSummary = typeof value.summary === 'string'
    && value.summary.trim() !== '' && !bodyPlaceholders.has(value.summary)
  const usefulLine = value.lines?.some(line => line.text && !bodyPlaceholders.has(line.text)
    && !line.text.startsWith('调用参数：'))
  return usefulSummary || usefulLine
}

function toolCard(row, readOutput, previous, finished) {
  const card = previous?.node ?? element('section', undefined, 'tool-card')
  previous?.dispose()
  for (const child of [...card.children]) child.remove()
  let active = true
  let observer
  card.dataset.toolKey = row.key
  const toolId = row.call?.toolId ?? row.result?.toolId
  const argumentsValue = row.call?.arguments ?? row.result?.arguments
  const execution = row.call?.execution ?? row.result?.execution
  card.dataset.toolClass = row.call?.toolClass ?? row.result?.toolClass ?? 'execution'
  if (toolId) card.dataset.toolId = toolId
  if (execution?.runtimeId) card.dataset.runtimeId = execution.runtimeId
  const semantic = element('div', undefined, 'tool-semantic')
  let immediateSemantics
  function present(report) {
    const value = toolSemantics(toolId, argumentsValue, report)
    if (report === undefined) immediateSemantics = value
    for (const child of [...semantic.children]) child.remove()
    semantic.append(element('strong', value.title, 'tool-title'))
    if (value.subject) semantic.append(element('p', value.subject, 'tool-path'))
    if (value.workSummary && value.workSummary !== value.subject) semantic.append(element('p', '工作摘要：' + value.workSummary, 'tool-work-summary'))
    if (value.workdir) semantic.append(element('p', '工作目录：' + value.workdir, 'tool-workdir'))
    if (value.summary && report !== undefined) semantic.append(element('p', value.summary, 'tool-summary'))
    if (!RAW_TEXT_TOOLS.has(toolId) && value.lines?.length) {
      const diff = DIFF_TOOLS.has(toolId)
      const lines = value.lines.filter(line => !bodyPlaceholders.has(line.text)
        && !/^(?:调用参数|工具返回|错误)：/.test(line.text))
      if (!lines.length) return
      const preview = diff ? element('pre', undefined, 'tool-preview') : element('ul', undefined, 'tool-highlights')
      for (const line of diff ? lines : lines.slice(0, 3)) {
        const prefix = diff ? { add: '+ ', remove: '- ', context: '  ' }[line.kind] ?? '' : ''
        const node = element(diff ? 'span' : 'li', prefix + line.text, diff ? 'tool-preview-line' : undefined)
        node.dataset.kind = line.kind
        preview.append(node)
      }
      semantic.append(preview)
    }
  }
  present(undefined)
  let explainedError = false
  if (row.result?.error) {
    const error = row.result.error
    const explainedReason = explainedToolErrorReason(error)
    explainedError = row.call !== undefined && explainedReason !== undefined
    const message = explainedReason ?? (error.code === 'active-turn.non-selection.unreturned'
      ? '执行方尚未返回结果，暂时不能记录取舍。' : error.message)
    card.append(element('p', [error.code, message].filter(Boolean).join(' · '), 'tool-error'))
  }
  if (Object.hasOwn(ACTOR, execution?.role)) card.append(element('span', ACTOR[execution.role], 'tool-actor muted'))
  card.append(semantic)
  if (card.dataset.toolClass === 'internal-helper') card.append(element('span', '内部步骤', 'tool-kind-chip'))
  const state = row.result
    ? toolId === 'bash' && row.result.status === 'succeeded'
      ? row.outputTarget ? '工具已返回 · 退出码与输出见结果' : '执行成功'
      : (STATUS[row.result.status] || '结果状态未提供')
    : finished ? '结果未记录' : '执行工具等待结果'
  if (!explainedError) card.append(element('p', row.call ? state : `${state} · 结果关联缺失`, 'tool-state'))
  const elapsed = element('time', '', 'tool-elapsed')
  elapsed.hidden = true
  let elapsedTimer
  if (!row.result && !finished && typeof window !== 'undefined' && typeof window.setInterval === 'function') {
    const started = Date.parse(row.call?.occurredAt)
    if (Number.isFinite(started)) {
      const paintElapsed = () => {
        elapsed.textContent = `${Math.max(0, Math.floor((Date.now() - started) / 1000))} 秒`
        elapsed.hidden = false
      }
      paintElapsed()
      elapsedTimer = window.setInterval(paintElapsed, 1000)
    }
  }
  card.append(elapsed)
  card.dataset.status = row.result?.status || (finished ? 'unknown' : 'pending')
  const facts = createDetailDisclosure(element, '调用参数与证据', 'tool-facts')
  const details = facts.content
  facts.onFirstOpen(() => {
    if (toolId === 'bash' && (row.call || argumentsValue)) {
      const args = argumentsValue
      if (typeof args?.description === 'string') details.append(element('p', args.description, 'tool-description'))
      details.append(element('p', '命令（原文，Bash -c）', 'tool-command-label'))
      details.append(element('pre', typeof args?.command === 'string' ? visibleText(args.command) : '（命令未提供）', 'tool-command'))
      details.append(element('p', `工作目录：${typeof args?.workdir === 'string' && args.workdir.trim() !== '' ? args.workdir : '绑定项目目录（实际路径未提供）'}`, 'tool-path'))
    }
    if (argumentsValue !== undefined) details.append(element('pre', JSON.stringify(argumentsValue, null, 2), 'tool-arguments'))
    details.append(element('pre', JSON.stringify({
      taskId: (row.call ?? row.result).taskId, operationId: (row.call ?? row.result).operationId,
      executionEpoch: (row.call ?? row.result).executionEpoch,
      callId: (row.call ?? row.result).callId, calledAt: row.call?.occurredAt,
      returnedAt: row.result?.occurredAt, outputRef: row.result?.outputRef,
      outputRefs: row.result?.outputRefs,
      error: row.result?.error,
      execution,
      evidenceRefs: row.result?.evidenceRefs,
    }, null, 2)))
  })
  card.append(facts.root)
  const targetKey = JSON.stringify(row.outputTarget)
  const stateCache = previous && previous.reader === readOutput && previous.targetKey === targetKey ? previous.stateCache : {}
  if (row.outputTarget) {
    const reportDetail = createDetailDisclosure(element, '读取完整结果', 'tool-result-detail')
    const button = reportDetail.button
    button.className = 'tool-read-output'
    const feedback = element('p', '', 'tool-read-feedback')
    feedback.setAttribute('role', 'status')
    const output = element('pre', '', 'tool-output')
    output.hidden = true
    const rawDetail = createDetailDisclosure(element, '报告原文', 'tool-raw-report')
    const raw = rawDetail.root
    raw.hidden = true
    rawDetail.onFirstOpen(() => {
      rawDetail.content.append(element('pre', typeof stateCache.report === 'string' ? visibleText(stateCache.report) : JSON.stringify(stateCache.report, null, 2) ?? '（结果正文未提供）', 'tool-report-original'))
    })
    let expand = stateCache.expanded ?? false
    function showReport() {
      present(stateCache.report)
      // Structured reports have one full representation, in the raw details.
      // File and shell text keep their useful reader without a second JSON copy.
      const hasText = toolId === 'file.read' && typeof stateCache.report?.content === 'string'
        || toolId === 'bash' && (typeof stateCache.report === 'string' || stateCache.report !== null && typeof stateCache.report === 'object' && !Array.isArray(stateCache.report))
      if (expand && hasText) output.textContent = toolOutputText(toolId, stateCache.report)
      output.hidden = !expand || !hasText
      raw.hidden = !stateCache.loaded
      feedback.textContent = '完整结果已读取'
      button.textContent = '查看完整结果'
    }
    async function load() {
      if (stateCache.loaded) { showReport(); return }
      button.disabled = true
      feedback.textContent = '正在读取完整结果…'
      try {
        // Visibility and explicit expansion share the same in-flight read.
        stateCache.pending ??= Promise.resolve(readOutput(row.outputTarget)).then((report) => {
          stateCache.report = report
          stateCache.loaded = true
        }).finally(() => { stateCache.pending = undefined })
        await stateCache.pending
        if (!active || !card.isConnected) return
        showReport()
        observer?.disconnect()
      } catch (error) {
        if (!active || !card.isConnected) return
        feedback.textContent = `结果不可读：${error?.code ? `${error.code} · ` : ''}${error?.message || String(error)}${error?.nextAction ? `\n恢复提示：${error.nextAction}` : ''}`
        button.textContent = '重试读取完整结果'
      } finally {
        button.disabled = false
      }
    }
    button.addEventListener('click', async () => {
      if (stateCache.loaded) {
        expand = true
        stateCache.expanded = expand
        showReport()
        return
      }
      expand = true
      stateCache.expanded = true
      await load()
    })
    reportDetail.content.append(feedback, output, raw)
    card.append(reportDetail.root)
    if (stateCache.loaded) showReport()
    else if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        if (!active || !card.isConnected) { observer.disconnect(); return }
        if (entries.some((entry) => entry.target === card && entry.isIntersecting)) {
          observer.disconnect()
          void load()
        }
      })
      observer.observe(card)
    }
    return { node: card, targetKey, stateCache, dispose() { active = false; if (elapsedTimer !== undefined && typeof window !== 'undefined') window.clearInterval(elapsedTimer); observer?.disconnect(); rawDetail.dispose(); reportDetail.dispose(); facts.dispose() } }
  } else if (row.result?.status === 'succeeded' && !explainsCompletedResult(immediateSemantics ?? {})) {
    card.append(element('p', '结果正文未提供；历史记录未保存完整结果正文，无法显示退出码与输出节选。', 'tool-read-feedback'))
  } else if (row.result?.status === 'failed' && !row.result.error) {
    card.append(element('p', '执行失败 · 历史记录中没有错误原因。', 'tool-read-feedback'))
  }
  return { node: card, targetKey, stateCache, dispose() { active = false; if (elapsedTimer !== undefined && typeof window !== 'undefined') window.clearInterval(elapsedTimer); observer?.disconnect(); facts.dispose() } }
}

export function disposeToolBody(host) {
  for (const item of bodies.get(host)?.values() ?? []) { item.dispose(); item.node.remove() }
  bodies.delete(host)
}

// Keep open results and details through unchanged polling; no execution state.
export function renderToolBody(host, events, readOutput, { finished = false, hideTransientErrors = false, taskState, statusEvents } = {}) {
  const previous = bodies.get(host) ?? new Map()
  const next = new Map()
  const timeline = Array.isArray(statusEvents) && statusEvents.length > 0 ? statusEvents : events
  const superseded = hideTransientErrors ? supersededEventSet(timeline, taskState) : null
  const rows = toolPresentations(events).filter((row) => {
    if (!superseded || !row.result) return true
    const hasFailure = row.result.status === 'failed' || row.result.error !== undefined
    return !(hasFailure && isSupersededEvent(superseded, row.result))
  })
  for (const row of rows) {
    // Journal events are immutable; arguments need no eager JSON copy to poll.
    const signature = JSON.stringify([finished, { ...row, call: row.call && { ...row.call, arguments: undefined }, result: row.result && { ...row.result, arguments: undefined } }])
    const old = previous.get(row.key)
    const item = old?.signature === signature && old.reader === readOutput ? old : { signature, reader: readOutput, ...toolCard(row, readOutput, old, finished) }
    next.set(row.key, item)
    const atPosition = host.children[next.size - 1]
    if (atPosition && atPosition !== item.node) host.insertBefore(item.node, atPosition)
    else if (!atPosition) host.append(item.node)
  }
  for (const [key, item] of previous) if (!next.has(key)) { item.dispose(); item.node.remove() }
  bodies.set(host, next)
  host.hidden = next.size === 0
}
