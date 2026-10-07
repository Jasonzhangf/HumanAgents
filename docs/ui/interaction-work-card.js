import { formatTime } from './runtime-api.js'

const TASK_STATE_LABELS = Object.freeze({
  created: '已创建',
  admitted: '已准入',
  running: '运行中',
  settling: '收拢中',
  succeeded: '已完成',
  waiting: '等待决策',
  blocked: '受阻',
  failed: '失败',
  cancelled: '已取消',
  stopped: '已停止',
  unknown: '未知',
  stale: '过期',
})

// The live verdict of a running execution, reported by the runtime's own
// liveness projection. The card only names it; it never derives a timer.
const LIVENESS_STATE_LABELS = Object.freeze({
  working: '工作中',
  'no-activity': '无活动',
  'waiting-for-answer': '待回答',
  failed: '已失败',
  idle: '空闲',
  unknown: '未知',
})

// The page-local stream fact of the event stream this page holds. `settled` is
// the close the server performs once the execution reached its terminal state,
// so it is not a failure. Only `lost` is a real transport loss.
//
// This fact rides on its OWN carrier (`cardMetadata.stream`) and never on
// `cardMetadata.transport`. That field is the typed `InteractionTraceTransport`
// declared in `packages/contracts/src/tool-execution.ts` as
// `{ connected: boolean, lastSyncedAt: string, stale?, replayed?, cursor? }`.
// It has no `state` field, so the four-value fact cannot live on it without
// overloading a declared contract and failing its own validator.
const STREAM_STATE_LABELS = Object.freeze({
  connected: '已连接',
  settled: '已收拢',
  lost: '实时连接已断开',
  unknown: '未提供',
})

const TRACE_KIND_LABELS = Object.freeze({
  user: '用户',
  assistant: '助手',
  'model-request': '模型请求',
  'tool-call': '工具调用',
  'tool-result': '工具返回',
  status: '状态',
  conclusion: '结论',
  decision: '决策',
  failure: '失败',
  cancel: '取消',
})

const CONVERSATION_KIND_LABELS = Object.freeze({
  user: '用户',
  assistant: '助手',
  progress: '进展',
  draft: '草稿',
  decision: '决策',
  error: '错误',
  result: '结果',
})

const DESCRIPTOR_KIND_LABELS = Object.freeze({
  reading: '读取',
  link: '链接',
  output: '输出',
  artifact: '产物',
})

const HISTORY_FAILURE_LABELS = Object.freeze({
  'stale-cursor': '游标已过期',
  'scope-mismatch': '范围不匹配',
  'not-found': '未找到',
  unavailable: '不可用',
})

const TAB_DEFINITIONS = Object.freeze([
  { id: 'conversation', label: '对话' },
  { id: 'trace', label: '轨迹' },
])

// Grouping key for trace entries whose source reported no turn identity. It is
// an explicit no-turn state, never a fabricated turn number.
const NO_TURN_KEY = '__no-turn-identity__'

function create(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function append(target, ...children) {
  for (const child of children) {
    if (child === undefined || child === null) continue
    if (Array.isArray(child)) append(target, ...child)
    else if (typeof child === 'string') target.append(document.createTextNode(child))
    else target.append(child)
  }
  return target
}

const TECHNICAL_HUMAN_TOKENS = Object.freeze([
  'requestId',
  'turnId',
  'callId',
  'digest',
  'evidence',
  'operationId',
  'taskId',
  'executionEpoch',
  'outputRef',
  'outputDigest',
  'argumentsRef',
  'argumentsDigest',
  'toolOutputRef',
  'activityRef',
  'stepId',
])

function containsTechnicalIdentity(value) {
  const text = String(value ?? '')
  return TECHNICAL_HUMAN_TOKENS.some((token) => text.includes(token))
    || /(?:^|\s)(?:task|operation|request|turn|epoch)=/.test(text)
}

function observationHumanText(value, fallback = '未投影') {
  const text = String(value ?? '').trim()
  if (!text) return fallback
  return containsTechnicalIdentity(text) ? '该条目包含技术细节，完整内容在折叠详情中。' : text
}

function valueOrUnknown(value, fallback = '未提供') {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function formatObservationTime(value) {
  if (!value) return '时间未投影'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function boolLabel(value, trueLabel, falseLabel) {
  if (value === true) return trueLabel
  if (value === false) return falseLabel
  return '未提供'
}

function statusSeconds(millis) {
  return Number.isFinite(millis) ? Math.max(0, Math.round(millis / 1000)) : undefined
}

/**
 * Names the liveness verdict the runtime reported. The seconds figure is the
 * runtime's own `silentForMs`, so the card never runs its own clock. An absent
 * liveness fact reads as not provided instead of a definite verdict.
 */
function livenessLabel(liveness) {
  if (!liveness) return '未提供'
  const label = LIVENESS_STATE_LABELS[liveness.state]
  if (label === undefined) return '未提供'
  const seconds = statusSeconds(liveness.silentForMs)
  if (seconds === undefined) return label
  return `${label}（${seconds} 秒）`
}

/**
 * Names the page-local stream fact of the event stream this page holds.
 * `settled` and `lost` are deliberately different: the first is the expected
 * close after the execution reached its terminal state, the second is a real
 * transport failure.
 */
function streamLabel(stream) {
  if (!stream) return STREAM_STATE_LABELS.unknown
  return STREAM_STATE_LABELS[stream.state] ?? STREAM_STATE_LABELS.unknown
}

/**
 * The staleness of the page-local stream fact. A closed stream (`settled`) or a
 * lost one (`lost`) is not stale: it is not syncing at all. Only a live stream
 * has a staleness the page can report, and it reports the declared fact.
 */
function streamStale(stream) {
  if (!stream) return '未提供'
  if (stream.state === 'settled' || stream.state === 'lost') return '否'
  return boolLabel(stream.stale, '是', '否')
}

/**
 * The declared `InteractionTraceTransport.connected` fact, used only as a
 * fallback when the page holds no stream fact of its own. The two facts are
 * different: the declared one describes the trace transport the read model
 * carried, the page-local one describes the event stream this page holds.
 */
function transportConnectedLabel(transport) {
  return boolLabel(transport?.connected, '已连接', '未连接')
}

/**
 * The single transport reading the card shows. The page-local stream fact wins
 * when the page holds one, because only that page can observe a stream loss.
 * Otherwise the declared typed transport is the fact the projection carried.
 * When neither exists the card states the absence instead of a definite value.
 */
function transportDisplay(metadata) {
  const stream = metadata?.stream
  if (stream && STREAM_STATE_LABELS[stream.state] !== undefined) {
    return { label: STREAM_STATE_LABELS[stream.state], state: stream.state }
  }
  const transport = metadata?.transport
  if (typeof transport?.connected === 'boolean') {
    return transport.connected
      ? { label: '已连接', state: 'connected' }
      : { label: '未连接', state: 'disconnected' }
  }
  return { label: STREAM_STATE_LABELS.unknown, state: 'unknown' }
}

function transportStaleDisplay(metadata) {
  if (metadata?.stream) return streamStale(metadata.stream)
  return boolLabel(metadata?.transport?.stale, '是', '否')
}

function scopedValue(value) {
  return value ? `${value.scope}:${value.value}` : '未提供'
}

function isSafeLink(href) {
  try {
    const url = new URL(href, 'https://humanagent.invalid')
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

function renderInlineMarkdown(parent, source, depth = 0) {
  const text = String(source ?? '')
  if (depth > 4) {
    parent.append(document.createTextNode(text))
    return
  }
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g
  let cursor = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)))
    const token = match[0]
    if (token.startsWith('`')) {
      parent.append(create('code', 'iwc-md-code', token.slice(1, -1)))
    } else if (token.startsWith('**')) {
      const strong = create('strong')
      renderInlineMarkdown(strong, token.slice(2, -2), depth + 1)
      parent.append(strong)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      const emphasis = create('em')
      renderInlineMarkdown(emphasis, token.slice(1, -1), depth + 1)
      parent.append(emphasis)
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (!linkMatch) {
        parent.append(document.createTextNode(token))
      } else {
        const label = linkMatch[1]
        const href = linkMatch[2]
        if (isSafeLink(href)) {
          const link = create('a', 'iwc-md-link', label)
          link.href = href
          link.target = '_blank'
          link.rel = 'noopener noreferrer'
          parent.append(link)
        } else {
          const unsafe = create('span', 'iwc-md-unsafe', `${label} (${href})`)
          unsafe.title = '不安全的链接协议不会执行'
          parent.append(unsafe)
        }
      }
    }
    cursor = pattern.lastIndex
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)))
}

function isBlockStart(line) {
  return /^\s*(#{1,6}\s|```|[-*]\s+|\d+\.\s+)/.test(line)
}

function renderMarkdown(container, markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    const fence = /^\s*```([A-Za-z0-9_-]*)\s*$/.exec(line)
    if (fence) {
      const codeLines = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      const pre = create('pre', 'iwc-md-pre')
      const code = create('code', 'iwc-md-code-block', codeLines.join('\n'))
      if (fence[1]) code.dataset.language = fence[1]
      pre.append(code)
      container.append(pre)
      continue
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const tag = `h${Math.min(heading[1].length + 2, 6)}`
      const node = create(tag, 'iwc-md-heading')
      renderInlineMarkdown(node, heading[2])
      container.append(node)
      index += 1
      continue
    }
    const unordered = /^\s*[-*]\s+(.*)$/.exec(line)
    if (unordered) {
      const list = create('ul', 'iwc-md-list')
      while (index < lines.length) {
        const item = /^\s*[-*]\s+(.*)$/.exec(lines[index])
        if (!item) break
        const listItem = create('li')
        renderInlineMarkdown(listItem, item[1])
        list.append(listItem)
        index += 1
      }
      container.append(list)
      continue
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ordered) {
      const list = create('ol', 'iwc-md-list')
      while (index < lines.length) {
        const item = /^\s*\d+\.\s+(.*)$/.exec(lines[index])
        if (!item) break
        const listItem = create('li')
        renderInlineMarkdown(listItem, item[1])
        list.append(listItem)
        index += 1
      }
      container.append(list)
      continue
    }
    const paragraphLines = [line.trim()]
    index += 1
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index].trim())
      index += 1
    }
    const paragraph = create('p', 'iwc-md-paragraph')
    renderInlineMarkdown(paragraph, paragraphLines.join('\n'))
    container.append(paragraph)
  }
}

function renderFactList(target, facts) {
  const list = create('dl', 'iwc-facts')
  for (const [label, value] of facts) {
    const row = create('div', 'iwc-fact')
    row.append(create('dt', undefined, label), create('dd', undefined, valueOrUnknown(value)))
    list.append(row)
  }
  target.append(list)
}

function renderError(error) {
  if (!error) return null
  const node = create('div', 'iwc-conversation-error')
  node.append(create('strong', undefined, error.headline || '未提供错误标题'))
  if (error.nextStep) node.append(create('p', 'iwc-conversation-next', `下一步：${error.nextStep}`))
  if (error.details !== undefined) {
    const details = create('details', 'iwc-error-details')
    details.append(create('summary', undefined, '原始详情'))
    const pre = create('pre')
    pre.textContent = typeof error.details === 'string' ? error.details : JSON.stringify(error.details, null, 2)
    details.append(pre)
    node.append(details)
  }
  return node
}

function descriptorLabel(descriptor) {
  const kind = DESCRIPTOR_KIND_LABELS[descriptor.kind] || '描述符'
  return descriptor.label ? `${kind}：${descriptor.label}` : `${kind}：${descriptor.ref}`
}

function descriptorMeta(descriptor) {
  const parts = []
  if (descriptor.mediaType) parts.push(descriptor.mediaType)
  if (descriptor.digest) parts.push(descriptor.digest)
  return parts.join(' · ')
}

function renderDescriptor(descriptor, options, focusPrefix, descriptorControls) {
  const wrapper = create('div', 'iwc-descriptor')
  const button = create('button', 'iwc-descriptor-button', descriptorLabel(descriptor))
  button.type = 'button'
  button.dataset.iwcAction = 'artifact'
  button.dataset.artifactRef = descriptor.ref
  button.dataset.focusKey = `${focusPrefix}:${descriptor.ref}`
  descriptorControls.set(button, descriptor)
  if (typeof options.onArtifactDetail !== 'function') {
    button.disabled = true
    button.title = '未提供 authorized artifact-detail 回调'
  }
  wrapper.append(button)
  const meta = descriptorMeta(descriptor)
  if (meta) wrapper.append(create('span', 'iwc-descriptor-meta', meta))
  if (typeof options.onArtifactDetail !== 'function') wrapper.append(create('span', 'iwc-unavailable', '详情读取端口未提供'))
  return wrapper
}

function renderTextFact(label, fact, options) {
  const row = create('div', 'iwc-text-fact')
  row.append(create('span', 'iwc-text-fact-label', label))
  const body = create('div', 'iwc-text-fact-body')
  renderMarkdown(body, fact.text)
  const source = []
  if (fact.sourceKind) source.push(`sourceKind=${fact.sourceKind}`)
  if (fact.sourceRef) source.push(`sourceRef=${fact.sourceRef}`)
  if (source.length) body.append(create('span', 'iwc-source-ref', source.join(' · ')))
  row.append(body)
  return row
}

function renderTextFacts(label, facts, options) {
  const block = create('div', 'iwc-text-facts')
  block.append(create('span', 'iwc-text-fact-label', label))
  const list = create('ul', 'iwc-text-fact-list')
  for (const fact of facts) {
    const item = create('li')
    renderMarkdown(item, fact.text)
    const source = []
    if (fact.sourceKind) source.push(`sourceKind=${fact.sourceKind}`)
    if (fact.sourceRef) source.push(`sourceRef=${fact.sourceRef}`)
    if (source.length) item.append(create('span', 'iwc-source-ref', source.join(' · ')))
    list.append(item)
  }
  block.append(list)
  return block
}

function renderSummary(summary, options) {
  const section = create('section', 'iwc-summary')
  section.append(create('h3', undefined, options?.mode === 'observation' ? '节点公开信息' : '公开任务信息'))
  if (!summary || summary.missing) {
    section.append(create('p', 'iwc-missing', options?.mode === 'observation' ? '来源未提供节点公开信息' : '来源未提供公开任务信息'))
    return section
  }
  if (summary.goal) section.append(renderTextFact('目标', summary.goal, options))
  if (summary.scope) section.append(renderTextFact('范围', summary.scope, options))
  if (summary.constraints?.length) section.append(renderTextFacts('约束', summary.constraints, options))
  if (summary.deliverables?.length) section.append(renderTextFacts('交付物', summary.deliverables, options))
  if (summary.facts?.length) renderFactList(section, summary.facts)
  return section
}

function renderConversation(projection, options, descriptorControls) {
  const panel = create('section', 'iwc-panel iwc-panel--conversation')
  panel.id = 'iwc-panel-conversation'
  panel.setAttribute('role', 'tabpanel')
  panel.setAttribute('aria-labelledby', 'iwc-tab-conversation')
  panel.tabIndex = 0
  panel.hidden = false
  const scroller = create('div', 'iwc-scroll iwc-conversation-scroll')
  scroller.append(renderSummary(projection.conversation.summary, options))
  const turns = projection.conversation.turns || []
  if (turns.length === 0) {
    scroller.append(create('p', 'iwc-missing', '来源未提供公开对话轮次'))
  } else {
    const list = create('div', 'iwc-conversation-turns')
    turns.forEach((turn, index) => {
      const article = create('article', 'iwc-conversation-turn')
      const head = create('header', 'iwc-turn-head')
      const kind = CONVERSATION_KIND_LABELS[turn.sourceKind] || turn.sourceKind || '未知'
      head.append(create('span', 'iwc-kind-chip', kind))
      head.append(create('time', 'iwc-time', turn.occurredAt ? formatTime(turn.occurredAt) : '时间未提供'))
      article.append(head)
      const body = create('div', 'iwc-turn-body')
      if (turn.markdown) renderMarkdown(body, turn.markdown)
      if (turn.error) body.append(renderError(turn.error))
      if (turn.details?.length) {
        const details = create('details', 'iwc-turn-details')
        details.append(create('summary', undefined, '技术详情'))
        const detailBody = create('div')
        renderFactList(detailBody, turn.details)
        details.append(detailBody)
        body.append(details)
      }
      if (turn.artifacts?.length) {
        const artifacts = create('div', 'iwc-artifacts')
        artifacts.append(create('span', 'iwc-fact-label', '授权描述符'))
        for (const descriptor of turn.artifacts) artifacts.append(renderDescriptor(descriptor, options, `conversation:${index}`, descriptorControls))
        body.append(artifacts)
      }
      article.append(body)
      list.append(article)
    })
    scroller.append(list)
  }
  panel.append(scroller)
  return panel
}

function renderHistoryFailure(failure) {
  const node = create('span', 'iwc-error-inline')
  node.append(create('strong', undefined, `${HISTORY_FAILURE_LABELS[failure.code] || failure.code}：${failure.message}`))
  if (failure.retryable) node.append(document.createTextNode(' · 可重试'))
  if (failure.evidenceRefs?.length) node.append(document.createTextNode(` · evidence=${failure.evidenceRefs.length}`))
  return node
}

/**
 * A succeeded tool result must point at the returned side verifiably: either the
 * descriptor's `outputRef`+`outputDigest` pair or at least one evidence ref. This
 * is the same rule the public contract enforces. When a source reported neither,
 * the card states that the pointer is missing instead of repeating a bare
 * success claim it cannot verify.
 */
function toolEvidenceUnprojected(entry) {
  const tool = entry.tool
  if (!tool || tool.status !== 'succeeded') return false
  if (typeof tool.outputRef === 'string' && tool.outputRef.length > 0) return false
  return !Array.isArray(entry.evidenceRefs) || entry.evidenceRefs.length === 0
}

function renderTraceRow(entry, options, state, descriptorControls) {
  const row = create('article', `iwc-trace-row iwc-trace-row--${entry.kind}`)
  row.dataset.traceKey = [
    scopedValue(entry.taskId),
    scopedValue(entry.operationId),
    entry.executionEpoch,
    entry.turnId,
    entry.requestId,
    entry.seq,
    entry.kind,
    entry.tool?.callId ?? '',
  ].join('|')
  row.dataset.callId = entry.tool?.callId || ''
  row.dataset.toolPaired = entry.tool === undefined || entry.tool.paired === undefined
    ? ''
    : String(entry.tool.paired)
  row.dataset.unprojected = String(Boolean(entry.unprojected))
  const evidenceUnprojected = toolEvidenceUnprojected(entry)
  row.dataset.toolEvidence = entry.tool === undefined ? '' : evidenceUnprojected ? 'unprojected' : 'projected'
  const head = create('header', 'iwc-trace-head')
  head.append(create('span', 'iwc-kind-chip', TRACE_KIND_LABELS[entry.kind] || entry.kind))
  if (entry.tool?.toolId) head.append(create('strong', 'iwc-tool-name', entry.tool.toolId))
  const stateLabel = entry.tool?.paired === false
    ? '未返回'
    : evidenceUnprojected ? '输出证据未投影' : valueOrUnknown(entry.state)
  head.append(create('span', 'iwc-state-chip', stateLabel))
  if (entry.occurredAt) {
    head.append(create('time', 'iwc-time', state.mode === 'observation' ? formatObservationTime(entry.occurredAt) : formatTime(entry.occurredAt)))
  } else if (state.mode === 'observation') {
    head.append(create('span', 'iwc-time', '时间未投影'))
  }
  if (entry.seq !== undefined && entry.seq !== null) head.append(create('span', 'iwc-seq', `seq ${entry.seq}`))
  row.append(head)
  const summary = entry.tool
    ? entry.tool.paired === false
      ? `${entry.tool.toolId} · 调用未返回`
      : evidenceUnprojected
        ? `${entry.tool.toolId} · 返回证据未投影`
        : state.mode === 'observation'
          ? `${entry.tool.toolId} · 调用与返回已配对（${valueOrUnknown(entry.tool.statusDisplay, entry.tool.status)}）`
          : `${entry.tool.toolId} · ${valueOrUnknown(entry.tool.statusDisplay, entry.tool.status)}`
    : state.mode === 'observation'
      ? entry.summary || valueOrUnknown(entry.modelRef, '公开轨迹事件')
      : valueOrUnknown(entry.modelRef, '公开轨迹事件')
  row.append(create('p', 'iwc-trace-summary', summary))
  const details = create('details', 'iwc-trace-details')
  details.append(create('summary', undefined, '技术详情'))
  const body = create('div', 'iwc-trace-detail-body')
  const facts = state.mode === 'observation'
    ? observationTraceFacts(entry)
    : [
        ['turnId', entry.turnId],
        ['requestId', entry.requestId],
        ['parentRequestId', entry.parentRequestId],
        ['taskId', scopedValue(entry.taskId)],
        ['operationId', scopedValue(entry.operationId)],
        ['executionEpoch', entry.executionEpoch],
        ['authorization.scope', scopedValue(entry.authorization?.scope?.organId)],
        ['authorization.capabilities', entry.authorization?.requestedCapabilities?.join(', ')],
        ['authorization.toolOutputRef', entry.authorization?.toolOutputRef],
        ['lastBusiness', `${valueOrUnknown(entry.lastBusiness?.kind)} · ${valueOrUnknown(entry.lastBusiness?.at)} · ${valueOrUnknown(entry.lastBusiness?.ref)}`],
      ]
  if (state.mode !== 'observation' && entry.tool) {
    facts.splice(3, 0,
      ['tool.callId', entry.tool.callId],
      ['tool.toolId', entry.tool.toolId],
      ['tool.status', entry.tool.status],
      ['tool.argumentsRef', entry.tool.argumentsRef],
      ['tool.argumentsDigest', entry.tool.argumentsDigest],
      ['tool.outputRef', entry.tool.outputRef],
      ['tool.outputDigest', entry.tool.outputDigest],
      ['tool.error', entry.tool.error ? `${entry.tool.error.code}: ${entry.tool.error.message}${entry.tool.error.ownerId ? ` · owner=${entry.tool.error.ownerId}` : ''}` : undefined],
    )
  }
  renderFactList(body, facts)
  if (state.mode !== 'observation' && entry.tool?.error?.evidenceRefs?.length) {
    const errorEvidence = create('div', 'iwc-error-evidence')
    errorEvidence.append(create('h4', undefined, '错误证据引用'))
    for (const ref of entry.tool.error.evidenceRefs) {
      const row = create('div', 'iwc-evidence-row')
      row.append(
        create('span', undefined, `${ref.evidenceId.value} · ${ref.kind}`),
        create('span', undefined, `${ref.source} · ${ref.locator}${ref.digest ? ` · ${ref.digest}` : ''}`),
      )
      errorEvidence.append(row)
    }
    body.append(errorEvidence)
  }
  if (state.mode !== 'observation' && entry.evidenceRefs?.length) {
    const evidence = create('div', 'iwc-evidence')
    evidence.append(create('h4', undefined, '证据引用'))
    for (const ref of entry.evidenceRefs) {
      const row = create('div', 'iwc-evidence-row')
      row.append(
        create('span', undefined, `${ref.evidenceId.value} · ${ref.kind}`),
        create('span', undefined, `${ref.source} · ${ref.locator}${ref.digest ? ` · ${ref.digest}` : ''}`),
      )
      evidence.append(row)
    }
    body.append(evidence)
  }
  if (state.mode !== 'observation' && entry.tool?.outputRef) {
    body.append(renderDescriptor({ kind: 'output', ref: entry.tool.outputRef, label: `${entry.tool.toolId} 输出`, digest: entry.tool.outputDigest }, options, `trace:${entry.tool.callId}`, descriptorControls))
  }
  details.append(body)
  row.append(details)
  return row
}

function observationTraceFacts(entry) {
  const facts = [
    ['分类', TRACE_KIND_LABELS[entry.kind] || entry.kind],
    ['状态', entry.state],
    ['时间', entry.occurredAt],
  ]
  if (entry.tool) {
    facts.push(
      ['tool.callId', entry.tool.callId],
      ['tool.toolId', entry.tool.toolId],
      ['tool.status', entry.tool.status],
      ['tool.paired', entry.tool.paired ? '是' : '否'],
      ['tool.returned', entry.tool.returned],
      ['tool.callOccurredAt', entry.tool.callOccurredAt],
      ['tool.returnedAt', entry.tool.returnedAt],
    )
  }
  if (entry.sourceRef) facts.push(['sourceRef', entry.sourceRef])
  for (const [label, value] of entry.details || []) facts.push([label, value])
  return facts
}

function renderTrace(projection, options, state, descriptorControls) {
  const panel = create('section', 'iwc-panel iwc-panel--trace')
  panel.id = 'iwc-panel-trace'
  panel.setAttribute('role', 'tabpanel')
  panel.setAttribute('aria-labelledby', 'iwc-tab-trace')
  panel.tabIndex = 0
  panel.hidden = true
  const historyState = projection.history
  const items = historyState?.result === 'ok' ? historyState.items : []
  const toolbar = create('div', 'iwc-trace-toolbar')
  if (state.mode === 'observation') {
    toolbar.classList.add('iwc-trace-toolbar--readonly')
    toolbar.append(create('span', 'iwc-missing', '只读轨迹；不提供查询、重试或控制操作。'))
  } else {
    const query = projection.history?.query || { limit: 20 }
    const form = create('form', 'iwc-history-form')
    form.dataset.iwcHistoryForm = 'true'
    const searchLabel = create('label', 'iwc-field')
    searchLabel.append(create('span', undefined, '搜索轨迹'))
    const search = create('input')
    search.type = 'search'
    search.name = 'search'
    search.placeholder = '输入文本'
    search.value = state.traceSearch ?? query.search ?? ''
    search.dataset.focusKey = 'history-search'
    searchLabel.append(search)
    const kindLabel = create('label', 'iwc-field')
    kindLabel.append(create('span', undefined, '类型'))
    const kindSelect = create('select')
    kindSelect.name = 'kind'
    kindSelect.dataset.focusKey = 'history-kind'
    const allOption = create('option', undefined, '全部')
    allOption.value = ''
    kindSelect.append(allOption)
    for (const kind of Object.keys(TRACE_KIND_LABELS)) {
      const option = create('option', undefined, TRACE_KIND_LABELS[kind])
      option.value = kind
      kindSelect.append(option)
    }
    kindSelect.value = state.traceKind ?? query.filter?.kinds?.[0] ?? ''
    kindLabel.append(kindSelect)
    const submit = create('button', 'iwc-button', '查询')
    submit.type = 'submit'
    submit.dataset.focusKey = 'history-submit'
    const canQuery = typeof options.onHistoryQuery === 'function'
    submit.disabled = !canQuery || state.busy === 'history'
    if (!canQuery) {
      search.disabled = true
      kindSelect.disabled = true
      submit.title = '未提供 history query 回调'
    }
    form.append(searchLabel, kindLabel, submit)
    toolbar.append(form)
    if (!canQuery) toolbar.append(create('span', 'iwc-unavailable', '历史查询端口未提供'))
  }
  panel.append(toolbar)

  const historyMeta = create('div', 'iwc-history-meta')
  if (historyState?.result === 'failed') {
    historyMeta.append(renderHistoryFailure(historyState))
  } else if (historyState?.result === 'missing' || !historyState) {
    historyMeta.append(create('span', 'iwc-missing', '来源未提供历史记录'))
  } else if (state.mode === 'observation') {
    const categories = [...new Set(items.map((entry) => TRACE_KIND_LABELS[entry.kind] || entry.kind))].join('、')
    historyMeta.append(create('span', undefined, `只读轨迹 · ${items.length} 项${categories ? ` · 类别：${categories}` : ''}`))
    const realTurns = new Set(items.filter((entry) => entry.turnId).map((entry) => entry.turnId))
    const withoutTurn = items.filter((entry) => !entry.turnId).length
    if (realTurns.size > 0) {
      historyMeta.append(create('span', undefined, `真实轮次 ${realTurns.size} 个`))
    }
    if (withoutTurn > 0) {
      historyMeta.append(create('span', 'iwc-missing', `${withoutTurn} 项无真实轮次`))
    }
  } else {
    const cursor = historyState.cursor ? ` · cursor=${historyState.cursor}` : ''
    historyMeta.append(create('span', undefined, `${historyState.items.length} 条${cursor}${historyState.hasMore ? ' · 可加载更早记录' : ' · 已到最早记录'}`))
  }
  panel.append(historyMeta)

  const scroller = create('div', 'iwc-scroll iwc-trace-scroll')
  if (items.length === 0) {
    scroller.append(create('p', 'iwc-missing', historyState?.result === 'failed' ? '历史读取失败，当前没有可显示轨迹' : '来源未提供轨迹记录'))
  } else {
    const list = create('div', 'iwc-trace-list')
    const groups = new Map()
    for (const entry of items) {
      const key = entry.turnId || NO_TURN_KEY
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(entry)
    }
    for (const [key, groupItems] of groups) {
      const group = create('section', 'iwc-trace-group')
      group.dataset.turnKey = key
      const groupHead = create('header', 'iwc-trace-group-head')
      const hasTurnId = groupItems.some((entry) => entry.turnId)
      if (hasTurnId) {
        // The real turn id the provider binding reported. It is the literal
        // identity, never an ordinal and never a synthesized number.
        group.dataset.turnId = key
        const turnChip = create('span', 'iwc-kind-chip iwc-turn-id', `轮次 ${key}`)
        turnChip.dataset.turnId = key
        groupHead.append(turnChip)
      } else {
        groupHead.append(create('span', 'iwc-kind-chip iwc-turn-unprojected', '轮次未投影'))
      }
      const groupTime = groupItems.find((entry) => entry.occurredAt)?.occurredAt
      if (groupTime) groupHead.append(create('time', 'iwc-time', state.mode === 'observation' ? formatObservationTime(groupTime) : formatTime(groupTime)))
      if (!hasTurnId && state.mode === 'observation') groupHead.append(create('span', 'iwc-missing', '真实轮次未投影；以下按投影顺序显示'))
      group.append(groupHead)
      for (const entry of groupItems) group.append(renderTraceRow(entry, options, state, descriptorControls))
      list.append(group)
    }
    scroller.append(list)
  }
  panel.append(scroller)
  return panel
}

function renderActions(projection, options, state) {
  if (projection.mode === 'observation') return null
  const footer = create('footer', 'iwc-actions')
  footer.append(create('div', 'iwc-actions-head'))
  footer.querySelector('.iwc-actions-head').append(create('h3', undefined, '授权操作'))
  const actions = projection.actions || []
  if (actions.length === 0) {
    footer.append(create('p', 'iwc-missing', '来源未提供可执行操作'))
  } else {
    const list = create('div', 'iwc-action-list')
    for (const action of actions) {
      const item = create('div', 'iwc-action-item')
      const button = create('button', 'iwc-button iwc-button--primary', action.label)
      button.type = 'button'
      button.dataset.iwcAction = 'invoke'
      button.dataset.actionId = action.id
      button.dataset.focusKey = `action:${action.id}`
      const unavailable = action.availability !== 'executable' || typeof options.onAction !== 'function'
      button.disabled = unavailable
      if (action.availability !== 'executable') button.title = action.unavailableReason || '来源标记为不可执行'
      else if (typeof options.onAction !== 'function') button.title = '未提供 action 回调'
      item.append(button)
      if (action.availability !== 'executable') item.append(create('span', 'iwc-unavailable', action.unavailableReason || '来源标记为不可执行'))
      else if (typeof options.onAction !== 'function') item.append(create('span', 'iwc-unavailable', '操作端口未提供'))
      list.append(item)
    }
    footer.append(list)
  }
  return footer
}

function observationTurn(summary, sourceKind, occurredAt, detailLabel) {
  const text = valueOrUnknown(summary, '摘要未投影')
  const technical = containsTechnicalIdentity(text)
  return {
    sourceKind,
    occurredAt,
    markdown: technical ? '该条目包含技术细节，完整内容在折叠详情中。' : text,
    details: technical ? [[detailLabel, text]] : undefined,
  }
}

function observationTraceEntry({ kind, occurredAt, state, summary, sourceRef, tool, details, unprojected, turnId, evidenceRefs }) {
  return {
    kind,
    occurredAt,
    state,
    summary,
    sourceRef,
    tool,
    details,
    unprojected,
    // The node's own evidence pointers. They are real node-scoped facts and are
    // what makes a succeeded tool step verifiable on this read-only surface.
    evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
    ...(turnId === undefined || turnId === null ? {} : { turnId }),
  }
}

/**
 * Read-only adapter for one observation node. It preserves the shared work-card
 * projection shape while keeping every displayed fact tied to the typed node
 * detail. A node or step the provider binding stamped with a real turn id shows
 * that real id; a fact with no turn id is grouped as the explicit
 * "no turn projected" state instead of being given an invented number.
 */
export function projectObservationWorkCard(input = {}) {
  const node = input.node
  if (!node || typeof node !== 'object') throw new TypeError('observation node projection is required')
  const activity = Array.isArray(node.activity) ? node.activity : []
  const toolSteps = Array.isArray(node.toolSteps) ? node.toolSteps : []
  const turns = activity.map((item) => observationTurn(item.summary, 'progress', item.occurredAt, '活动原文'))
  if (node.summary) turns.push(observationTurn(node.summary, 'result', node.updatedAt, '节点结论原文'))
  // Every trace row on this read-only surface belongs to this node, so the node's
  // own evidence pointers are the real evidence for each row.
  const nodeEvidenceRefs = Array.isArray(node.evidenceRefs) ? node.evidenceRefs : []
  const traceEntry = (fields) => observationTraceEntry({ ...fields, evidenceRefs: nodeEvidenceRefs })

  const traceItems = activity.map((item) => traceEntry({
    kind: 'status',
    occurredAt: item.occurredAt,
    state: '已投影',
    summary: observationHumanText(item.summary, '活动摘要未投影'),
    sourceRef: item.activityRef,
    turnId: item.turnId,
    details: [['activityRef', item.activityRef], ['summary', item.summary]],
  }))

  for (const step of toolSteps) {
    const paired = step.status !== 'unknown'
    const statusDisplay = step.statusDisplay || step.status || '未知'
    traceItems.push(traceEntry({
      kind: 'tool-call',
      occurredAt: step.occurredAt,
      state: paired ? statusDisplay : '未返回',
      summary: `${valueOrUnknown(step.name, '未标注工具')} · ${paired ? '调用与返回已配对' : '未返回'}`,
      sourceRef: step.callId ?? step.stepId,
      turnId: step.turnId,
      tool: {
        callId: step.callId ?? step.stepId,
        toolId: step.name,
        status: step.status,
        statusDisplay,
        returned: step.returned,
        paired,
        callOccurredAt: step.occurredAt,
        returnedAt: step.returnedAt,
      },
      details: [
        ['callId', step.callId ?? step.stepId],
        ['toolId', step.name],
        ['status', step.status],
        ['returned', step.returned],
        ['callOccurredAt', step.occurredAt],
        ['returnedAt', step.returnedAt],
      ],
    }))
  }

  if (node.summary) {
    traceItems.push(traceEntry({
      kind: 'conclusion',
      occurredAt: node.updatedAt,
      state: node.stateDisplay || '已投影',
      summary: observationHumanText(node.summary, '结论摘要未投影'),
      sourceRef: 'summary',
      turnId: node.turnId,
      details: [['summary', node.summary]],
    }))
  }

  traceItems.push(traceEntry({
    kind: 'model-request',
    state: '未投影',
    summary: '模型请求轨迹未投影',
    unprojected: true,
    details: [['reason', 'this node reported no model-request event with a turn id']],
  }))
  if (toolSteps.length === 0) {
    traceItems.push(traceEntry({
      kind: 'tool-result',
      state: '未投影',
      summary: '工具调用与返回轨迹未投影',
      unprojected: true,
      details: [['reason', 'observation projection has no typed toolSteps for this node']],
    }))
  }

  const humanFacts = [
    ['节点', observationHumanText(node.title, '未标注节点')],
    ['类型', observationHumanText(node.kindDisplay, '未标注类型')],
    ['状态', observationHumanText(node.stateDisplay, '未知')],
    ['归属', observationHumanText(node.roleDisplay || node.ownerAgentRole, '未投影')],
    ['更新时间', node.updatedAt ? formatObservationTime(node.updatedAt) : '未投影'],
  ]

  return {
    surface: 'interaction-work-card',
    mode: 'observation',
    taskState: 'unknown',
    stateLabel: valueOrUnknown(node.stateDisplay, '未知'),
    statusbar: {
      label: '只读节点观测',
      state: 'ready',
      detail: `${observationHumanText(node.title, '未标注节点')} · ${observationHumanText(node.kindDisplay, '未标注类型')} · ${observationHumanText(node.stateDisplay, '未知')}`,
    },
    cardMetadata: {
      currentNode: observationHumanText(node.title, '未标注节点'),
      nodeKind: observationHumanText(node.kindDisplay, '未标注类型'),
      ownerId: observationHumanText(node.roleDisplay || node.ownerAgentRole, '未投影'),
      nextStep: node.stateDisplay,
      nextAction: '只读观测',
      waitingOn: undefined,
      startedAt: node.updatedAt,
      // A read-only node observation reports node facts only. It has no provider
      // connection, transport or settlement fact to state, so those stay absent
      // instead of being asserted as a definite value.
      source: {
        taskId: undefined,
        operationId: undefined,
        executionEpoch: node.iteration,
        requestId: undefined,
        ...(node.turnId === undefined || node.turnId === null ? {} : { turnId: node.turnId }),
      },
    },
    conversation: {
      summary: {
        goal: { text: observationHumanText(node.summary, '节点摘要未投影') },
        facts: humanFacts,
      },
      turns,
    },
    history: {
      query: { limit: traceItems.length },
      result: 'ok',
      items: traceItems,
      cursor: undefined,
      hasMore: false,
    },
    actions: [],
    observation: {
      nodeId: node.nodeId,
      handoffs: Array.isArray(input.handoffs) ? input.handoffs : [],
    },
  }
}

function renderStatus(projection) {
  const metadata = projection.cardMetadata
  const status = create('header', 'iwc-status')
  const observation = projection.mode === 'observation'
  status.setAttribute('aria-label', observation ? '节点状态' : '任务状态')
  const top = create('div', 'iwc-status-top')
  const lifecycle = create('div', 'iwc-lifecycle')
  // The animated dot is the card's own progress signal, so it may only run when
  // the RUNTIME reported that the execution is actually working. Gating it on
  // the lifecycle state alone animates forever during a reported `no-activity`
  // stall, which is the fabricated progress this card must never show. A state
  // the runtime did not report as `working` gets no dot.
  if (!observation && metadata.liveness?.state === 'working') {
    const dot = create('span', 'iwc-activity-dot')
    dot.setAttribute('aria-hidden', 'true')
    lifecycle.append(dot)
  }
  const stateLabel = projection.stateLabel || TASK_STATE_LABELS[projection.taskState] || '未知'
  lifecycle.append(create('strong', 'iwc-lifecycle-label', stateLabel))
  // The chip names the same localized label. A raw `LifecycleState` value must
  // never reach the human.
  lifecycle.append(create('span', 'iwc-state-chip', observation ? `节点 ${stateLabel}` : `任务 ${stateLabel}`))
  top.append(lifecycle)
  const source = projection.statusbar
  const sourceChip = create('span', 'iwc-state-chip', observation ? `来源 ${source?.label || '只读投影'}` : `来源 ${source?.label || '未提供'}`)
  sourceChip.dataset.state = source?.state || 'unknown'
  top.append(sourceChip)
  if (observation) {
    top.append(create('span', 'iwc-state-chip', `归属 ${valueOrUnknown(metadata.ownerId)}`))
  } else {
    const providerChip = create('span', 'iwc-state-chip', `Provider ${valueOrUnknown(metadata.provider?.state)}`)
    providerChip.dataset.state = metadata.provider?.state || 'unknown'
    top.append(providerChip)
    const livenessChip = create('span', 'iwc-state-chip', `活性 ${livenessLabel(metadata.liveness)}`)
    livenessChip.dataset.state = metadata.liveness?.state || 'unknown'
    top.append(livenessChip)
    const transport = transportDisplay(metadata)
    const transportChip = create('span', 'iwc-state-chip', `传输 ${transport.label}`)
    transportChip.dataset.state = transport.state
    top.append(transportChip)
  }
  status.append(top)
  if (source?.detail) status.append(create('p', 'iwc-status-detail', source.detail))
  const details = create('details', 'iwc-status-details')
  details.append(create('summary', undefined, '状态与技术身份'))
  const body = create('div')
  renderFactList(body, observation
    ? [
        ['节点', metadata.currentNode],
        ['归属', metadata.ownerId],
        ['节点状态', stateLabel],
        ['节点类型', metadata.nodeKind],
        ['迭代', metadata.source?.executionEpoch],
        ['更新时间', metadata.startedAt],
        ['nodeId', projection.observation?.nodeId],
      ]
    : [
        ['当前节点', metadata.currentNode],
        ['责任方', metadata.ownerId],
        ['活性', livenessLabel(metadata.liveness)],
        ['活性原因', metadata.liveness?.reason],
        ['下一步', metadata.nextStep],
        ['下一步操作', metadata.nextAction],
        ['等待对象', metadata.waitingOn],
        ['开始时间', metadata.startedAt],
        ['Provider 最后事件', metadata.provider?.lastEventAt],
        ['传输最后同步', metadata.transport?.lastSyncedAt],
        ['传输连接', transportConnectedLabel(metadata.transport)],
        ['传输状态', `${transportDisplay(metadata).label} · stale=${transportStaleDisplay(metadata)}`],
        ['停止状态', `providerStopped=${boolLabel(metadata.settlement?.providerStopped, '是', '否')} · checkpointCommitted=${boolLabel(metadata.settlement?.checkpointCommitted, '是', '否')}`],
        ['最后业务更新', `${valueOrUnknown(metadata.lastBusiness?.kind)} · ${valueOrUnknown(metadata.lastBusiness?.at)} · ${valueOrUnknown(metadata.lastBusiness?.ref)}`],
      ])
  body.append(create('p', 'iwc-source-ref', observation
    ? `node=${valueOrUnknown(projection.observation?.nodeId)} · epoch=${valueOrUnknown(metadata.source?.executionEpoch)}`
    : `task=${scopedValue(metadata.source?.taskId)} · operation=${scopedValue(metadata.source?.operationId)} · epoch=${valueOrUnknown(metadata.source?.executionEpoch)} · request=${valueOrUnknown(metadata.source?.requestId)} · turn=${valueOrUnknown(metadata.source?.turnId)}`))
  details.append(body)
  status.append(details)
  return status
}

function renderTabs(activeTab) {
  const tablist = create('div', 'iwc-tabs')
  tablist.setAttribute('role', 'tablist')
  tablist.setAttribute('aria-label', '工作卡视图')
  for (const definition of TAB_DEFINITIONS) {
    const tab = create('button', 'iwc-tab', definition.label)
    tab.type = 'button'
    tab.id = `iwc-tab-${definition.id}`
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-controls', `iwc-panel-${definition.id}`)
    tab.setAttribute('aria-selected', String(activeTab === definition.id))
    tab.tabIndex = activeTab === definition.id ? 0 : -1
    tab.dataset.tab = definition.id
    tab.dataset.iwcAction = 'tab'
    tab.dataset.focusKey = `tab:${definition.id}`
    tablist.append(tab)
  }
  return tablist
}

function renderPanels(projection, options, state, descriptorControls) {
  const panels = create('div', 'iwc-panels')
  const conversation = renderConversation(projection, options, descriptorControls)
  const trace = renderTrace(projection, options, state, descriptorControls)
  conversation.hidden = state.activeTab !== 'conversation'
  trace.hidden = state.activeTab !== 'trace'
  panels.append(conversation, trace)
  return panels
}

function assertProjection(projection) {
  if (!projection || projection.surface !== 'interaction-work-card' || !projection.cardMetadata || !projection.conversation) {
    throw new TypeError('interaction work card projection is required')
  }
}

// F09: every re-render replaces the card subtree. Capture the focused node's
// stable `data-focus-key` before the swap so the same control regains focus.
function activeFocusKey(root) {
  const active = document.activeElement
  if (!active || !root.contains(active) || !active.dataset) return null
  return active.dataset.focusKey || null
}

function escapeAttributeValue(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return String(value).replace(/["\\]/g, '\\$&')
}

function restoreFocus(root, focusKey) {
  if (!focusKey) return
  const target = root.querySelector(`[data-focus-key="${escapeAttributeValue(focusKey)}"]`)
  if (target && typeof target.focus === 'function') target.focus()
}

export function mountInteractionWorkCard(target, options = {}) {
  if (!target || target.nodeType !== 1) throw new TypeError('mountInteractionWorkCard requires an Element target')
  const observationMode = options.mode === 'observation'
  const root = create('section', 'iwc-card')
  root.setAttribute('aria-label', observationMode ? '只读节点工作卡' : '交互工作卡')
  if (observationMode) root.classList.add('iwc-card--observation')
  target.replaceChildren(root)
  const content = create('div', 'iwc-content')
  root.append(content)
  let projection = null
  let disposed = false
  let activeTab = 'conversation'
  let traceSearch = ''
  let traceKind = ''
  const descriptorControls = new WeakMap()

  function render() {
    if (disposed || !projection) return
    const state = { activeTab, traceSearch, traceKind, busy: null, mode: projection.mode }
    root.dataset.taskState = projection.taskState
    root.dataset.mode = projection.mode || 'interaction'
    const focusKey = activeFocusKey(root)
    const children = [
      renderStatus(projection),
      renderTabs(activeTab),
      renderPanels(projection, options, state, descriptorControls),
    ]
    const actions = renderActions(projection, options, state)
    if (actions) children.push(actions)
    content.replaceChildren(...children)
    restoreFocus(root, focusKey)
  }

  function switchTab(nextTab) {
    if (disposed || !TAB_DEFINITIONS.some((tab) => tab.id === nextTab)) return
    activeTab = nextTab
    render()
  }

  function handleClick(event) {
    const targetNode = event.target instanceof Element ? event.target.closest('[data-iwc-action]') : null
    if (!targetNode) return
    const action = targetNode.dataset.iwcAction
    if (action === 'tab') {
      event.preventDefault()
      switchTab(targetNode.dataset.tab)
    } else if (action === 'invoke' && typeof options.onAction === 'function') {
      event.preventDefault()
      const actionId = targetNode.dataset.actionId
      const action = projection?.actions?.find((candidate) => candidate.id === actionId)
      if (action?.availability === 'executable') void options.onAction(action, { projection })
    } else if (action === 'artifact' && typeof options.onArtifactDetail === 'function') {
      event.preventDefault()
      const descriptor = descriptorControls.get(targetNode)
      if (descriptor) void options.onArtifactDetail(descriptor, { projection })
    }
  }

  function handleInput(event) {
    const targetNode = event.target
    if (!(targetNode instanceof Element) || !targetNode.closest('form[data-iwc-history-form]')) return
    if (targetNode.name === 'search') traceSearch = targetNode.value
    else if (targetNode.name === 'kind') traceKind = targetNode.value
  }

  function handleSubmit(event) {
    const form = event.target instanceof Element ? event.target.closest('form[data-iwc-history-form]') : null
    if (!form) return
    event.preventDefault()
    if (typeof options.onHistoryQuery !== 'function') return
    const base = projection?.history?.query || { limit: 20 }
    const filter = { ...(base.filter || {}) }
    if (traceKind) filter.kinds = [traceKind]
    else delete filter.kinds
    void options.onHistoryQuery({
      ...base,
      cursor: undefined,
      search: traceSearch || undefined,
      filter: Object.keys(filter).length ? filter : undefined,
    }, { projection })
  }

  root.addEventListener('click', handleClick)
  root.addEventListener('input', handleInput)
  root.addEventListener('change', handleInput)
  root.addEventListener('submit', handleSubmit)

  function update(nextProjection) {
    if (disposed) return
    const normalized = observationMode ? projectObservationWorkCard(nextProjection) : nextProjection
    assertProjection(normalized)
    projection = normalized
    traceSearch = normalized.history?.query?.search || ''
    traceKind = normalized.history?.query?.filter?.kinds?.[0] || ''
    render()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    root.removeEventListener('click', handleClick)
    root.removeEventListener('input', handleInput)
    root.removeEventListener('change', handleInput)
    root.removeEventListener('submit', handleSubmit)
    root.remove()
  }

  return Object.freeze({ update, dispose })
}
