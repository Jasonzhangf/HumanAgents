import { api, clearNode, element, formatTime } from './runtime-shell.js'

const KIND_LABELS = Object.freeze({
  message: '回答',
  draft: '整理',
  clarification: '需要确认',
  'input-request': '需要你的信息',
  status: '进展',
  result: '结果',
  error: '未完成',
})

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

function renderAnswerControls(request, onAnswer, host) {
  const form = element('div', undefined, 'mt-answer')
  const status = element('p', '', 'mt-answer-status')
  status.hidden = true
  const buttons = []
  let busy = false

  const submit = async (answer) => {
    const value = String(answer ?? '').trim()
    if (value === '') {
      status.hidden = false
      status.dataset.tone = 'danger'
      status.textContent = '请选择一项或填写你的回答。'
      return
    }
    if (busy) return
    busy = true
    for (const button of buttons) button.disabled = true
    custom.disabled = true
    status.hidden = false
    status.dataset.tone = 'warning'
    status.textContent = '正在提交回答…'
    try {
      const projection = await onAnswer(request, value)
      if (!projection) throw new Error('回答已提交，但主话题回读失败；请刷新后核对该问题状态。')
      if (projection?.openInputRequest?.requestId === request.requestId
        && projection.openInputRequest?.taskId?.value === request.taskId?.value) {
        throw new Error('问题仍处于待答状态；请检查当前回执后重试。')
      }
      const answeredTurn = projection.turns.some((turn) =>
        turn.turnId === `input-answer:${request.requestId}` && turn.text === value)
      if (!answeredTurn) {
        throw new Error('回答回执已接受，但主话题回读没有这条回答；请刷新后核对真实状态。')
      }
      renderMainTopic(host, projection, { onAnswer })
    } catch (error) {
      status.dataset.tone = 'danger'
      status.textContent = error?.message || String(error)
      busy = false
      for (const button of buttons) button.disabled = false
      custom.disabled = false
    }
  }

  const optionGroup = element('div', undefined, 'mt-options')
  for (const option of request.options || []) {
    const button = element('button', option, 'mt-option')
    button.type = 'button'
    button.dataset.answerOption = option
    button.addEventListener('click', () => void submit(option))
    buttons.push(button)
    optionGroup.append(button)
  }
  if (buttons.length > 0) form.append(optionGroup)

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
  return form
}

function renderTurn(turn, project, handlers, host, answeredRequestIds) {
  const article = element('article', undefined, turnClass(turn))
  article.dataset.turnId = turn.turnId
  article.append(turnHeader(turn, project.agentName))
  const bubble = element('div', undefined, 'mt-bubble')
  const quote = quoteBlock(turn.quote)
  if (quote) bubble.append(quote)
  bubble.append(element('p', turn.text, 'mt-text'))
  if (turn.kind === 'input-request' && turn.requestId && turn.taskId
    && !answeredRequestIds.has(turn.requestId)) {
    bubble.append(renderAnswerControls({
      requestId: turn.requestId,
      taskId: turn.taskId,
      expectedRevision: turn.expectedRevision,
      question: turn.text,
      options: turn.options,
      sourceQuestion: turn.quote,
    }, handlers.onAnswer, host))
  }
  article.append(bubble)
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

export function renderMainTopic(host, projection, { onAnswer } = {}) {
  if (!(host instanceof HTMLElement)) throw new Error('main topic requires a host element')
  const activeControl = document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
    ? document.activeElement
    : undefined
  const previousTurns = new Map(
    [...host.querySelectorAll('.mt-turn[data-turn-id]')].map((turn) => [turn.dataset.turnId, turn]),
  )
  const handlers = { onAnswer }
  clearNode(host)
  host.dataset.surface = 'main-topic'
  host.dataset.projectKey = projection.projectKey
  host.dataset.mode = projection.mode

  const section = element('section', undefined, 'section mt-shell')
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
  section.append(head)

  if (projection.activeTask) section.append(renderActiveTask(projection.activeTask))

  const stream = element('div', undefined, 'mt-stream')
  stream.setAttribute('role', 'log')
  stream.setAttribute('aria-live', 'polite')
  const turns = projection.turns
  const answeredRequestIds = new Set(projection.turns.flatMap((turn) =>
    turn.kind === 'message' && turn.turnId.startsWith('input-answer:')
      ? [turn.requestId].filter(Boolean)
      : []
  ))
  if (turns.length === 0) {
    stream.append(element('p', '还没有对话。直接提问，或交办一个需要读取项目材料的任务。', 'mt-empty'))
  } else {
    for (const turn of turns) {
      const previous = turn.kind === 'input-request' && answeredRequestIds.has(turn.requestId)
        ? undefined
        : previousTurns.get(turn.turnId)
      const current = previous
      stream.append(current || renderTurn(turn, projection, handlers, host, answeredRequestIds))
    }
  }
  section.append(stream)
  host.append(section)
  if (activeControl?.isConnected) activeControl.focus({ preventScroll: true })
  const last = stream.lastElementChild
  if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'nearest' })
  return section
}
