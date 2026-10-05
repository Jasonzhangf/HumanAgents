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

const TRACE_KIND_LABELS = Object.freeze({
  user: '用户',
  assistant: '助手',
  'tool-call': '工具调用',
  'tool-result': '工具返回',
  status: '状态',
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

function valueOrUnknown(value, fallback = '未提供') {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

function boolLabel(value, trueLabel, falseLabel) {
  if (value === true) return trueLabel
  if (value === false) return falseLabel
  return '未提供'
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
  section.append(create('h3', undefined, '公开任务信息'))
  if (!summary || summary.missing) {
    section.append(create('p', 'iwc-missing', '来源未提供公开任务信息'))
    return section
  }
  if (summary.goal) section.append(renderTextFact('目标', summary.goal, options))
  if (summary.scope) section.append(renderTextFact('范围', summary.scope, options))
  if (summary.constraints?.length) section.append(renderTextFacts('约束', summary.constraints, options))
  if (summary.deliverables?.length) section.append(renderTextFacts('交付物', summary.deliverables, options))
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
      article.dataset.turnIndex = String(index)
      const head = create('header', 'iwc-turn-head')
      const kind = CONVERSATION_KIND_LABELS[turn.sourceKind] || turn.sourceKind || '未知'
      head.append(create('span', 'iwc-kind-chip', kind))
      head.append(create('time', 'iwc-time', turn.occurredAt ? formatTime(turn.occurredAt) : '时间未提供'))
      article.append(head)
      const body = create('div', 'iwc-turn-body')
      if (turn.markdown) renderMarkdown(body, turn.markdown)
      if (turn.error) body.append(renderError(turn.error))
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
  const head = create('header', 'iwc-trace-head')
  head.append(create('span', 'iwc-kind-chip', TRACE_KIND_LABELS[entry.kind] || entry.kind))
  if (entry.tool?.toolId) head.append(create('strong', 'iwc-tool-name', entry.tool.toolId))
  head.append(create('span', 'iwc-state-chip', valueOrUnknown(entry.state)))
  head.append(create('time', 'iwc-time', formatTime(entry.occurredAt)))
  head.append(create('span', 'iwc-seq', `seq ${entry.seq}`))
  row.append(head)
  const summary = entry.tool
    ? `${entry.tool.toolId} · ${entry.tool.status}`
    : valueOrUnknown(entry.modelRef, '公开轨迹事件')
  row.append(create('p', 'iwc-trace-summary', summary))
  const details = create('details', 'iwc-trace-details')
  details.append(create('summary', undefined, '技术详情'))
  const body = create('div', 'iwc-trace-detail-body')
  const facts = [
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
  if (entry.tool) {
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
  if (entry.tool?.error?.evidenceRefs?.length) {
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
  if (entry.evidenceRefs?.length) {
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
  if (entry.tool?.outputRef) {
    body.append(renderDescriptor({ kind: 'output', ref: entry.tool.outputRef, label: `${entry.tool.toolId} 输出`, digest: entry.tool.outputDigest }, options, `trace:${entry.tool.callId}`, descriptorControls))
  }
  details.append(body)
  row.append(details)
  return row
}

function renderTrace(projection, options, state, descriptorControls) {
  const panel = create('section', 'iwc-panel iwc-panel--trace')
  panel.id = 'iwc-panel-trace'
  panel.setAttribute('role', 'tabpanel')
  panel.setAttribute('aria-labelledby', 'iwc-tab-trace')
  panel.tabIndex = 0
  panel.hidden = true
  const toolbar = create('div', 'iwc-trace-toolbar')
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
  panel.append(toolbar)

  const historyState = projection.history
  const historyMeta = create('div', 'iwc-history-meta')
  if (historyState?.result === 'failed') {
    historyMeta.append(renderHistoryFailure(historyState))
  } else if (historyState?.result === 'missing' || !historyState) {
    historyMeta.append(create('span', 'iwc-missing', '来源未提供历史记录'))
  } else {
    const cursor = historyState.cursor ? ` · cursor=${historyState.cursor}` : ''
    historyMeta.append(create('span', undefined, `${historyState.items.length} 条${cursor}${historyState.hasMore ? ' · 可加载更早记录' : ' · 已到最早记录'}`))
  }
  panel.append(historyMeta)

  const scroller = create('div', 'iwc-scroll iwc-trace-scroll')
  const items = historyState?.result === 'ok' ? historyState.items : []
  if (items.length === 0) {
    scroller.append(create('p', 'iwc-missing', historyState?.result === 'failed' ? '历史读取失败，当前没有可显示轨迹' : '来源未提供轨迹记录'))
  } else {
    const list = create('div', 'iwc-trace-list')
    for (const entry of items) list.append(renderTraceRow(entry, options, state, descriptorControls))
    scroller.append(list)
  }
  panel.append(scroller)
  return panel
}

function renderActions(projection, options, state) {
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

function renderStatus(projection) {
  const metadata = projection.cardMetadata
  const status = create('header', 'iwc-status')
  status.setAttribute('aria-label', '任务状态')
  const top = create('div', 'iwc-status-top')
  const lifecycle = create('div', 'iwc-lifecycle')
  if (projection.taskState === 'running' || projection.taskState === 'settling') {
    const dot = create('span', 'iwc-activity-dot')
    dot.setAttribute('aria-hidden', 'true')
    lifecycle.append(dot)
  }
  lifecycle.append(create('strong', 'iwc-lifecycle-label', TASK_STATE_LABELS[projection.taskState] || '未知'))
  lifecycle.append(create('span', 'iwc-state-chip', `任务 ${valueOrUnknown(projection.taskState)}`))
  top.append(lifecycle)
  const source = projection.statusbar
  const sourceChip = create('span', 'iwc-state-chip', `来源 ${source?.label || '未提供'}`)
  sourceChip.dataset.state = source?.state || 'unknown'
  top.append(sourceChip)
  const providerChip = create('span', 'iwc-state-chip', `Provider ${valueOrUnknown(metadata.provider?.state)}`)
  providerChip.dataset.state = metadata.provider?.state || 'unknown'
  top.append(providerChip)
  const transportChip = create('span', 'iwc-state-chip', `传输 ${metadata.transport?.connected ? '已连接' : '未连接'}`)
  transportChip.dataset.state = metadata.transport?.connected ? 'connected' : 'disconnected'
  top.append(transportChip)
  status.append(top)
  if (source?.detail) status.append(create('p', 'iwc-status-detail', source.detail))
  const details = create('details', 'iwc-status-details')
  details.append(create('summary', undefined, '状态与技术身份'))
  const body = create('div')
  renderFactList(body, [
    ['当前节点', metadata.currentNode],
    ['责任方', metadata.ownerId],
    ['下一步', metadata.nextStep],
    ['下一步操作', metadata.nextAction],
    ['等待对象', metadata.waitingOn],
    ['开始时间', metadata.startedAt],
    ['Provider 最后事件', metadata.provider?.lastEventAt],
    ['传输最后同步', metadata.transport?.lastSyncedAt],
    ['传输状态', `${boolLabel(metadata.transport?.connected, '已连接', '未连接')} · stale=${boolLabel(metadata.transport?.stale, '是', '否')}`],
    ['停止状态', `providerStopped=${boolLabel(metadata.settlement?.providerStopped, '是', '否')} · checkpointCommitted=${boolLabel(metadata.settlement?.checkpointCommitted, '是', '否')}`],
    ['最后业务更新', `${valueOrUnknown(metadata.lastBusiness?.kind)} · ${valueOrUnknown(metadata.lastBusiness?.at)} · ${valueOrUnknown(metadata.lastBusiness?.ref)}`],
  ])
  body.append(create('p', 'iwc-source-ref', `task=${scopedValue(metadata.source?.taskId)} · operation=${scopedValue(metadata.source?.operationId)} · epoch=${valueOrUnknown(metadata.source?.executionEpoch)} · request=${valueOrUnknown(metadata.source?.requestId)} · turn=${valueOrUnknown(metadata.source?.turnId)}`))
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

export function mountInteractionWorkCard(target, options = {}) {
  if (!target || target.nodeType !== 1) throw new TypeError('mountInteractionWorkCard requires an Element target')
  const root = create('section', 'iwc-card')
  root.setAttribute('aria-label', '交互工作卡')
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
    const state = { activeTab, traceSearch, traceKind, busy: null }
    root.dataset.taskState = projection.taskState
    content.replaceChildren(
      renderStatus(projection),
      renderTabs(activeTab),
      renderPanels(projection, options, state, descriptorControls),
      renderActions(projection, options, state),
    )
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
    assertProjection(nextProjection)
    projection = nextProjection
    traceSearch = nextProjection.history?.query?.search || ''
    traceKind = nextProjection.history?.query?.filter?.kinds?.[0] || ''
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
