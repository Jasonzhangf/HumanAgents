import { element } from './runtime-api.js'
import { createDetailDisclosure } from './detail-disclosure.js'

const footerParts = new WeakMap()

const number = (value) => value == null ? '未知' : String(value)
const percent = (value) => value == null ? '未知' : `${Number(value.toFixed(2))}%`
const rate = (value) => percent(value == null ? null : value * 100)
const hasTokenTotals = (call) => call.inputTokens != null || call.outputTokens != null
const cacheCount = (value, call) => value == null && hasTokenTotals(call) ? '未上报' : number(value)
const currentCacheRate = (call) => call.currentCallCacheHitRate == null && hasTokenTotals(call)
  ? '无法计算'
  : rate(call.currentCallCacheHitRate)
const cacheLabel = (label, value, call) => value == null && hasTokenTotals(call) ? `${label}未上报` : `${label} ${number(value)}`
const speed = (value) => `${value?.tokensPerSecond == null ? '未知' : `${Number(value.tokensPerSecond.toFixed(2))} tokens/s`}（${value?.basis === 'generation-elapsed' ? '生成耗时' : '响应总耗时'}）`

// Consume the ordinary session reader's CallUsageRead, not debug inspection.
// The caller selects the scope and supplies its complete, ordered snapshot.
// Ratios/coverage/capacity/time measurements belong to the reader, not the UI.
function callRows(call) {
  return [
    ['输入 tokens', number(call.inputTokens)],
    ['输出 tokens', number(call.outputTokens)],
    ['缓存读取 tokens', cacheCount(call.cacheReadTokens, call)],
    ['缓存写入 tokens', cacheCount(call.cacheWriteTokens, call)],
    ['上下文已用 tokens', number(call.context.used)],
    ['上下文上限 tokens', number(call.context.limit)],
    ['上下文使用率', percent(call.context.percent)],
    ['本次调用缓存命中率', currentCacheRate(call)],
    ['上次调用缓存命中率', rate(call.previousCallCacheHitRate)],
    ['上一业务轮缓存命中率', rate(call.previousBusinessTurnCacheHitRate)],
    ['本任务缓存命中率', rate(call.taskCacheHitRate)],
    ['输出速度', speed(call.outputSpeed)],
  ]
}

/** Render the selected session/task's public usage snapshot. */
export function renderCallUsageFooter(usage, options = {}) {
  const make = options.element ?? element
  const footer = make('footer', undefined, 'call-usage-footer')
  footer.setAttribute('aria-label', '模型调用统计')
  const disclosure = createDetailDisclosure(make, '调用明细', 'call-usage-details')
  const summary = disclosure.button
  summary.className = 'call-usage-summary'
  const content = disclosure.content
  content.className = 'call-usage-content'
  footerParts.set(footer, { make, summary, content, dialog: disclosure.dialog })
  footer.append(disclosure.root)
  return updateCallUsageFooter(footer, usage, options)
}

/** Refresh in place. Keep the disclosure and summary so open/focus survive. */
export function updateCallUsageFooter(footer, usage, options = {}) {
  const parts = footerParts.get(footer)
  const { make, summary, content } = parts
  const calls = usage?.calls ?? []
  const latest = calls.at(-1)
  const measured = calls.findLast(call => [call.inputTokens, call.outputTokens, call.cacheReadTokens, call.cacheWriteTokens,
    call.context.used].some(value => value != null))
  const pending = Boolean(options.pending && usage === undefined && !options.error)
  const failure = options.error
  const errorMessage = typeof failure === 'string' ? failure : failure?.message
  const snapshot = JSON.stringify([pending, calls, usage?.coverage, failure?.code, errorMessage, failure?.ownerId, failure?.nextAction])
  if (parts.snapshot === snapshot) return footer
  parts.snapshot = snapshot
  footer.setAttribute('aria-busy', String(pending))
  const scroll = content.scrollTop
  const dialogScroll = parts.dialog?.scrollTop
  summary.replaceChildren()
  const labels = measured ? [
    latest === measured ? '最新调用' : `第 ${calls.indexOf(measured) + 1} 次调用的统计`,
    `输入 ${number(measured.inputTokens)} · 输出 ${number(measured.outputTokens)} tokens`,
    [cacheLabel('缓存读取', measured.cacheReadTokens, measured), cacheLabel('缓存写入', measured.cacheWriteTokens, measured)].join(' · '),
    measured.currentCallCacheHitRate == null && hasTokenTotals(measured)
      ? '缓存命中率无法计算'
      : `缓存命中 ${rate(measured.currentCallCacheHitRate)}`,
    `上下文 ${percent(measured.context.percent)}`,
  ] : failure || pending ? [] : ['暂无调用统计']
  if (latest && latest !== measured) labels.push('本次调用尚无统计')
  if (pending) labels.push('统计加载中…')
  labels.push('调用明细')
  if (options.error) {
    const message = errorMessage ?? '调用统计暂时无法读取。'
    const error = make('span', `统计加载失败：${failure.code ? `${failure.code} · ` : ''}${message}`, 'call-usage-error call-usage-summary-item')
    error.setAttribute('role', 'alert')
    summary.append(error)
  }
  for (const label of labels) summary.append(make('span', label, 'call-usage-summary-item'))

  // Replace the snapshot rather than append: the same callId on subsequent
  // reads updates once, and a changed/empty scope cannot retain old calls.
  content.replaceChildren()
  if (options.error) {
    if (options.error.ownerId) content.append(make('p', `统计来源：${options.error.ownerId}`, 'call-usage-note'))
    if (options.error.nextAction) content.append(make('p', options.error.nextAction, 'call-usage-note'))
  }
  if (!latest && !failure && !pending) content.append(make('p', '暂无调用统计；尚未取得调用数据。', 'call-usage-note'))
  for (const [index, call] of calls.entries()) {
    const section = make('section', undefined, 'call-usage-call')
    section.dataset.callId = call.callId
    section.append(make('h4', `第 ${index + 1} 次调用${index === calls.length - 1 ? ' · 最新' : ''}`))
    const facts = make('dl', undefined, 'call-usage-facts')
    for (const [label, value] of callRows(call)) facts.append(make('dt', label), make('dd', value))
    section.append(facts)
    content.append(section)
  }
  if (latest) {
    const coverage = usage.coverage
    content.append(make('p', `统计覆盖：共 ${number(coverage?.calls)} 次调用，输入已知 ${number(coverage?.callsWithKnownInput)} 次，缓存读取已知 ${number(coverage?.callsWithKnownCacheRead)} 次。模型服务未上报的缓存读写量保留为空。命中率需要缓存读取量和输入量。`, 'call-usage-note'))
    content.append(make('p', '输出速度按输出 tokens / 对应耗时计算：响应总耗时包含等待响应，生成耗时仅计生成时段。缓存命中率与上下文使用率分别显示。', 'call-usage-note'))
  }
  content.scrollTop = scroll
  if (parts.dialog) parts.dialog.scrollTop = dialogScroll
  return footer
}
