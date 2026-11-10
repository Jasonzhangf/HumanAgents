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

export function localizedStepSummary(summary) {
  const text = typeof summary === 'string' ? summary.trim() : ''
  if (text === '') return ''
  const exact = INTERNAL_STEP_LABELS.get(text)
  if (exact !== undefined) return exact
  for (const [prefix, label] of INTERNAL_STEP_LABELS) {
    if (text.startsWith(`${prefix}:`)) return `${label}${text.slice(prefix.length)}`
    if (text.startsWith(`${prefix} `)) return `${label} ${text.slice(prefix.length + 1)}`
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
