// The runtime publishes its real execution step summaries as internal English
// phase names. Both the entry live-progress card and the task dashboard trace
// share this mapping so a Chinese surface never leaks `request to the model`-
// style internal copy.
export const INTERNAL_STEP_LABELS = new Map([
  ['Dispatching request to the model', '正在派发模型请求'],
  ['Model request dispatched', '模型请求已派发'],
  ['Model request settled', '模型请求已收拢'],
  ['provider requested model work', '已向模型请求工作'],
  ['provider request dispatching', '正在派发模型请求'],
  ['provider request dispatched', '模型请求已派发'],
  ['provider request waiting', '等待模型请求返回'],
  ['provider prepared model output', '模型正在准备输出'],
  ['Model is streaming output', '模型正在输出'],
  ['provider provided model reasoning', '模型正在推理'],
  ['provider completed tool request details', '模型已生成工具调用'],
  ['Closed turn planner aligned: complete', '回合计划已对齐：完成'],
  ['durable closure and planner alignment end the task with decision: complete', '执行已完成（决策：完成）'],
  ['provider request settled', '模型请求已收束'],
  ['provider requested model work settled', '模型工作已收束'],
  ['execution started', '执行已开始'],
  ['execution admitted and released', '已准入并启动执行'],
  ['execution admitted', '执行已准入'],
  ['execution succeeded', '执行成功'],
  ['execution failed', '执行失败'],
  ['execution cancelled', '执行已取消'],
  ['execution settling', '执行正在收拢'],
  ['execution retry', '执行重试'],
  ['execution terminal', '执行已结束'],
  ['checkpoint committed', '检查点已提交'],
  ['stopped checkpoint committed', '停止检查点已提交'],
  ['provider tool', '调用工具'],
  ['provider tool-result', '工具返回'],
  ['attention opened', '需要关注'],
  ['attention resolved', '关注已处理'],
])

const EVENT_KIND_LABELS = new Map([
  ['runtime-task-event', '执行进程'],
  ['execution.started', '开始执行'],
  ['provider.model', '模型处理'],
  ['provider.output', '模型输出'],
  ['provider.tool', '调用工具'],
  ['provider.tool-result', '工具返回'],
  ['provider.error', '模型请求失败'],
  ['execution.settling', '收拢执行'],
  ['execution.retry', '执行重试'],
  ['checkpoint.committed', '检查点提交'],
  ['execution.terminal', '执行结束'],
  ['attention.opened', '需要关注'],
  ['attention.resolved', '关注已处理'],
])

const EVENT_STATE_LABELS = new Map([
  ['created', '已创建'],
  ['admitted', '已准入'],
  ['running', '进行中'],
  ['waiting', '等待中'],
  ['settling', '收拢中'],
  ['succeeded', '已完成'],
  ['failed', '失败'],
  ['blocked', '受阻'],
  ['cancelled', '已取消'],
  ['stopped', '已停止'],
  ['unknown', '未知'],
])

const THINKING_TAG_PATTERN = /<\/?think(?:ing)?(?:\s[^>]*)?>/giu
const TOOL_RESULT_ID_PATTERN = /\bprovider-[a-z0-9]+-tool-result-output-provider-tool-result-call-[a-z0-9-]+\b/giu
const MECHANICAL_STEP_PATTERN = /(?:^|[\s·])步骤\s*\d+(?:\s*\/\s*\d+)?(?:[\s·]*)?/giu
const ANSWER_MARKER_LINE_PATTERN = /^[ \t]*回答[ \t]*$/gmu

export function localizedEventKind(kind) {
  const text = typeof kind === 'string' ? kind.trim() : ''
  return EVENT_KIND_LABELS.get(text) ?? text
}

export function localizedEventState(state) {
  const text = typeof state === 'string' ? state.trim() : ''
  return EVENT_STATE_LABELS.get(text) ?? (text === '' ? '未知' : text)
}

/**
 * Remove process-only markers from text that is rendered for a person.
 * Failure wording is deliberately not translated or replaced here.
 */
export function sanitizeUserVisibleText(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return ''
  const cleaned = text
    .replace(THINKING_TAG_PATTERN, '')
    .replace(TOOL_RESULT_ID_PATTERN, '')
    .replace(MECHANICAL_STEP_PATTERN, '')
    .replace(ANSWER_MARKER_LINE_PATTERN, '')
  const lines = cleaned
    .split(/\r?\n/u)
    .map((line) => {
      const trimmed = line.replace(/[ \t]+$/u, '')
      return /^证据[：:]\s*$/u.test(trimmed.trim()) ? '' : trimmed
    })
  while (lines[0]?.trim() === '') lines.shift()
  while (lines.at(-1)?.trim() === '') lines.pop()
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

export function localizedStepPhase(event) {
  const kind = typeof event?.kind === 'string' ? event.kind.trim() : ''
  const state = typeof event?.state === 'string' ? event.state.trim() : ''
  if (kind === 'execution.terminal') {
    if (state === 'failed') return '执行失败'
    if (state === 'cancelled') return '执行已取消'
    if (state === 'blocked') return '执行受阻'
    return '执行结束'
  }
  if (kind === 'execution.settling') return '执行正在收拢'
  const label = EVENT_KIND_LABELS.get(kind)
  if (label !== undefined) return label
  const summary = localizedStepSummary(event?.summary)
  return summary === '' ? '执行进度' : summary
}

export function localizedStepSummary(summary) {
  const text = typeof summary === 'string' ? summary.trim() : ''
  if (text === '') return ''
  const exact = INTERNAL_STEP_LABELS.get(text)
  if (exact !== undefined) return exact
  for (const [prefix, label] of INTERNAL_STEP_LABELS) {
    if (text.startsWith(`${prefix}:`) || text.startsWith(`${prefix}：`)) {
      return `${label}：${text.slice(prefix.length + 1).trimStart()}`
    }
    if (text.startsWith(`${prefix} `)) {
      return `${label} ${text.slice(prefix.length + 1).trimStart()}`
    }
  }
  // Unmapped text: keep a runtime-rendered Chinese step so real steps stay
  // distinguishable, but never surface raw provider English or JSON payloads.
  if (/^[\[{]/.test(text)) return '执行进度'
  // Tool results arrive as `<toolId> succeeded|failed|blocked` (for example
  // `file.read succeeded`). The tool id is a product identifier the page already
  // surfaces as `调用工具：file.read`; only the outcome needs a Chinese word.
  const toolOutcome = text.match(/^([^\s:]+) (succeeded|failed|blocked)$/)
  if (toolOutcome) {
    const outcome = toolOutcome[2] === 'succeeded' ? '已完成' : toolOutcome[2] === 'failed' ? '已失败' : '已阻塞'
    return `工具 ${toolOutcome[1]} ${outcome}`
  }
  if (/[\u4e00-\u9fff]/.test(text)) return text
  return '执行进度'
}
