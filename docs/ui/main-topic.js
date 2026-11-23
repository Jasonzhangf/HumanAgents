import { api, clearNode, element, formatTime } from './runtime-shell.js'
import { conversationStatus, createConversationStatusClock } from './conversation-status.js'
import { renderToolBody } from './tool-presentation.js'

const KIND_LABELS = Object.freeze({
  message: '回答',
  draft: '整理',
  clarification: '需要确认',
  'input-request': '需要你的信息',
  status: '进展',
  result: '结果',
  error: '未完成',
})

const topicStates = new WeakMap()
const answerControls = new WeakMap()

function requestKey(turn) {
  return JSON.stringify([turn.taskId?.scope, turn.taskId?.value, turn.requestId, turn.expectedRevision])
}

function hasRequestRevision(turn) {
  return Number.isSafeInteger(turn.expectedRevision) && turn.expectedRevision >= 0
}

function turnClass(turn) {
  return `mt-turn mt-turn--${turn.role} mt-turn--${turn.kind}`
}

function quoteBlock(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const quote = element('blockquote', undefined, 'mt-quote')
  quote.append(element('span', '引用', 'mt-quote-label'), element('span', text, 'mt-quote-text'))
  return quote
}

function turnHeader(turn, label) {
  const header = element('header', undefined, 'mt-turn-head')
  header.append(
    element('strong', turn.role === 'user' ? '你' : label),
    element('span', KIND_LABELS[turn.kind] || '消息', 'mt-turn-kind'),
  )
  if (typeof turn.occurredAt === 'string' && turn.occurredAt.trim() !== '') {
    header.append(element('time', formatTime(turn.occurredAt), 'mt-turn-time'))
  }
  return header
}

function renderAnswerControls(request, onAnswer, host, topicState) {
  const form = element('div', undefined, 'mt-answer')
  const status = element('p', '', 'mt-answer-status')
  status.hidden = true
  const buttons = []
  let busy = false
  let currentRequest = request
  let currentOnAnswer = onAnswer
  const isCurrent = () => form.isConnected && host.contains(form) && topicStates.get(host) === topicState

  const submit = async (answer) => {
    if (!isCurrent()) return
    const value = String(answer ?? '').trim()
    if (value === '') {
      status.hidden = false
      status.dataset.tone = 'danger'
      status.textContent = '请选择一项或填写你的回答。'
      return
    }
    if (busy) return
    const request = currentRequest
    const onAnswer = currentOnAnswer
    busy = true
    for (const button of buttons) button.disabled = true
    custom.disabled = true
    status.hidden = false
    status.dataset.tone = 'warning'
    status.textContent = '正在提交回答…'
    try {
      const projection = await onAnswer(request, value)
      if (!isCurrent()) return
      if (!projection) throw new Error('回答已提交，但主话题回读失败；请刷新后核对该问题状态。')
      if (projection.openInputRequest && requestKey(projection.openInputRequest) === requestKey(request)) {
        throw new Error('问题仍处于待答状态；请检查当前回执后重试。')
      }
      const answeredTurn = projection.turns.some((turn) =>
        turn.turnId === `input-answer:${request.requestId}` && requestKey(turn) === requestKey(request)
        && hasRequestRevision(turn) && turn.text === value)
      if (!answeredTurn) {
        throw new Error('回答回执已接受，但主话题回读没有这条回答；请刷新后核对真实状态。')
      }
      renderMainTopic(host, projection, { onAnswer: currentOnAnswer })
    } catch (error) {
      if (!isCurrent()) return
      status.dataset.tone = 'danger'
      status.textContent = error?.message || String(error)
      busy = false
      for (const button of buttons) button.disabled = false
      custom.disabled = false
    }
  }

  const optionGroup = element('div', undefined, 'mt-options')
  form.append(optionGroup)

  const customRow = element('div', undefined, 'mt-custom-answer')
  const custom = element('input')
  custom.type = 'text'
  custom.placeholder = '或者填写自定义回答'
  custom.dataset.answerCustom = request.requestId
  const customButton = element('button', '提交自定义回答', 'mt-option mt-option--custom')
  customButton.type = 'button'
  customButton.addEventListener('click', () => void submit(custom.value))
  custom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void submit(custom.value)
  })
  buttons.push(customButton)
  customRow.append(custom, customButton)
  form.append(customRow, status)
  let optionsKey
  const update = (request, onAnswer) => {
    currentRequest = request
    currentOnAnswer = onAnswer
    const nextOptionsKey = JSON.stringify(request.options || [])
    if (optionsKey === nextOptionsKey) return
    optionsKey = nextOptionsKey
    clearNode(optionGroup)
    buttons.splice(0, buttons.length, customButton)
    for (const option of request.options || []) {
      const button = element('button', option, 'mt-option')
      button.type = 'button'
      button.dataset.answerOption = option
      button.disabled = busy
      button.addEventListener('click', () => void submit(option))
      buttons.push(button)
      optionGroup.append(button)
    }
  }
  update(request, onAnswer)
  return { form, update }
}

function updateTurn(article, turn, project, onAnswer, host, answeredRequestIds, topicState, bindings) {
  article.className = turnClass(turn)
  article.dataset.turnId = turn.turnId
  const header = turnHeader(turn, project.agentName)
  const previousHeader = article.querySelector('.mt-turn-head')
  if (previousHeader) previousHeader.replaceWith(header)
  else article.append(header)
  const previousStatus = article.querySelector('.conversation-status')
  if (turn.statusFacts) {
    const status = element('div', undefined, 'conversation-status')
    status.setAttribute('aria-label', '执行阶段与计时')
    for (const row of conversationStatus(turn.statusFacts)) {
      const line = element('div', undefined, 'conversation-status-row')
      line.dataset.phase = row.phase
      line.dataset.tone = row.tone
      line.dataset.running = String(row.running)
      const mark = element('span', row.tone === 'danger' ? '!' : row.tone === 'success' ? '✓' : '●', 'conversation-status-mark')
      mark.setAttribute('aria-hidden', 'true')
      line.append(mark, element('span', row.label))
      const time = element('span', '', 'conversation-status-time')
      line.append(time)
      bindings.push({ row, node: time })
      if (row.error) line.append(element('span', `${row.error.code || ''} ${row.error.message || ''}`.trim(), 'conversation-status-error'))
      status.append(line)
    }
    if (typeof topicState.onOpenDetail === 'function') {
      const detail = element('button', '详情', 'conversation-status-detail')
      detail.type = 'button'
      detail.addEventListener('click', () => topicState.onOpenDetail(detail, turn))
      status.append(detail)
    }
    if (previousStatus) previousStatus.replaceWith(status)
    else header.after(status)
  } else previousStatus?.remove()
  let bubble = article.querySelector('.mt-bubble')
  if (!bubble) {
    bubble = element('div', undefined, 'mt-bubble')
    bubble.append(element('p', '', 'mt-text'))
    article.append(bubble)
  }
  const previousQuote = bubble.querySelector('.mt-quote')
  const quote = quoteBlock(turn.quote)
  if (previousQuote && quote) previousQuote.replaceWith(quote)
  else if (previousQuote) previousQuote.remove()
  else if (quote) bubble.prepend(quote)
  const text = bubble.querySelector('.mt-text')
  if (text.textContent !== turn.text) text.textContent = turn.text
  let detailReadError = bubble.querySelector('.mt-detail-read-error')
  if (turn.detailReadError) {
    if (!detailReadError) {
      detailReadError = element('p', '', 'mt-detail-read-error conversation-status-error')
      bubble.append(detailReadError)
    }
    detailReadError.textContent = turn.detailReadError.message
  } else detailReadError?.remove()
  let tools = bubble.querySelector('.tool-body')
  if (turn.toolEvents?.length) {
    if (!tools) {
      tools = element('div', undefined, 'tool-body')
      bubble.append(tools)
    }
    renderToolBody(tools, turn.toolEvents, api.readToolOutput)
  } else tools?.remove()
  let control = answerControls.get(article)
  const key = requestKey(turn)
  if (turn.kind === 'input-request' && turn.requestId && turn.taskId
    && !answeredRequestIds.has(requestKey(turn))) {
    const request = {
      requestId: turn.requestId,
      taskId: turn.taskId,
      expectedRevision: turn.expectedRevision,
      question: turn.text,
      options: turn.options,
      sourceQuestion: turn.quote,
    }
    if (control?.key !== key) {
      control?.form.remove()
      control = { ...renderAnswerControls(request, onAnswer, host, topicState), key }
      answerControls.set(article, control)
      bubble.append(control.form)
    } else control.update(request, onAnswer)
  } else if (control) {
    control.form.remove()
    answerControls.delete(article)
  }
  return article
}

function renderActiveTask(task) {
  const row = element('section', undefined, 'mt-active')
  row.dataset.taskState = task.state
  const copy = element('div', undefined, 'mt-active-copy')
  const detail = task.state === 'waiting'
    ? '等待你的回答后继续原任务'
    : `${task.stateLabel} · ${task.currentStepLabel || task.nextStep || '等待真实回执'}`
  copy.append(element('strong', task.title || '当前任务'), element('span', detail, 'mt-active-detail'))
  row.append(element('span', '当前任务', 'mt-active-label'), copy)
  if (typeof task.startedAt === 'string' && task.startedAt.trim() !== '') {
    row.append(element('time', `开始于 ${formatTime(task.startedAt)}`, 'mt-active-time'))
  }
  if (task.error) {
    const failure = element('p', task.error.message, 'mt-active-error')
    if (task.error.nextAction) failure.append(element('span', `下一步：${task.error.nextAction}`, 'mt-error-next'))
    row.append(failure)
  }
  return row
}

export function disposeMainTopic(host) {
  topicStates.get(host)?.clock.dispose()
  topicStates.delete(host)
}

export function renderMainTopic(host, projection, { onAnswer, onOpenDetail } = {}) {
  if (!(host instanceof HTMLElement)) throw new Error('main topic requires a host element')
  const activeControl = host.contains(document.activeElement) ? document.activeElement : undefined
  const scope = JSON.stringify([projection.projectKey, projection.mode, projection.workspaceCwd])
  let topicState = topicStates.get(host)
  if (topicState?.scope !== scope) {
    topicState?.clock.dispose()
    clearNode(host)
    topicState = { scope, clock: createConversationStatusClock(host) }
    topicStates.set(host, topicState)
  }
  if (onOpenDetail !== undefined) topicState.onOpenDetail = onOpenDetail
  const bindings = []
  const previousTurns = new Map(
    [...host.querySelectorAll('.mt-turn[data-turn-id]')].map((turn) => [turn.dataset.turnId, turn]),
  )
  host.dataset.surface = 'main-topic'
  host.dataset.projectKey = projection.projectKey
  host.dataset.mode = projection.mode

  let section = host.querySelector('.mt-shell')
  if (!section) {
    section = element('section', undefined, 'section mt-shell')
    host.append(section)
  }
  section.id = 'main-topic'
  const head = element('header', undefined, 'mt-head')
  const identity = element('div', undefined, 'mt-identity')
  identity.append(
    element('p', `${projection.projectName} · ${projection.topicName}`, 'mt-project'),
    element('h2', projection.agentName, 'mt-agent'),
  )
  const meta = element('div', undefined, 'mt-meta')
  meta.append(
    element('span', projection.mode === 'rcc' ? '真实执行' : '固定回放', 'mt-chip'),
    element('span', '刷新后仍从同一记录恢复', 'mt-meta-copy'),
  )
  head.append(identity, meta)
  const previousHead = section.querySelector('.mt-head')
  if (previousHead) previousHead.replaceWith(head)
  else section.prepend(head)

  const previousActive = section.querySelector('.mt-active')
  if (projection.activeTask) {
    const active = renderActiveTask(projection.activeTask)
    if (previousActive) previousActive.replaceWith(active)
    else head.after(active)
  } else previousActive?.remove()

  let stream = section.querySelector('.mt-stream')
  if (!stream) {
    stream = element('div', undefined, 'mt-stream')
    section.append(stream)
  }
  stream.setAttribute('role', 'log')
  stream.setAttribute('aria-live', 'polite')
  const turns = projection.turns
  const answeredRequestIds = new Set(projection.turns.flatMap((turn) =>
    turn.kind === 'message' && turn.turnId.startsWith('input-answer:') && hasRequestRevision(turn)
      ? [requestKey(turn)]
      : []
  ))
  if (turns.length === 0) {
    if (!stream.querySelector('.mt-empty')) {
      clearNode(stream)
      stream.append(element('p', '还没有对话。直接提问，或交办一个需要读取项目材料的任务。', 'mt-empty'))
    }
  } else {
    stream.querySelector('.mt-empty')?.remove()
    const retained = new Set()
    let cursor = stream.firstElementChild
    for (const turn of turns) {
      const current = updateTurn(previousTurns.get(turn.turnId) || element('article'),
        turn, projection, onAnswer, host, answeredRequestIds, topicState, bindings)
      retained.add(current)
      if (current === cursor) cursor = cursor.nextElementSibling
      else stream.insertBefore(current, cursor)
    }
    for (const child of [...stream.children]) if (!retained.has(child)) child.remove()
  }
  topicState.clock.update(bindings)
  if (activeControl?.isConnected && document.activeElement !== activeControl) activeControl.focus({ preventScroll: true })
  const last = stream.lastElementChild
  if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'nearest' })
  return section
}
