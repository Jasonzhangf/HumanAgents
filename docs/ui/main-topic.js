import { api, appendPairingEntry, clearNode, element, formatTime, taskControlHref } from './runtime-shell.js'
import { conversationStatus, createConversationStatusClock } from './conversation-status.js'
import * as callUsageFooter from './call-usage-footer.js'
import { renderToolBody, disposeToolBody } from './tool-presentation.js'
import { taskForTurn, taskValue, renderDispatchCard } from './dispatch-tracking.js'
import { renderExplicitToolActivity } from './explicit-tool-activity.js'

export function ownedMainTopicTurns(projection) {
  const turns = projection.turns || []
  const cardTasks = new Set(turns.filter(turn => turn.kind === 'draft' && taskForTurn(turn, projection.tasks)).map(turn => taskValue(taskForTurn(turn, projection.tasks).taskId)))
  return turns.filter(turn => turn.detailReadError || !(['status', 'error'].includes(turn.kind) && cardTasks.has(taskValue(turn.taskId)))).map(turn => {
    const task = taskForTurn(turn, projection.tasks)
    if (!task || turn.role === 'user' || !['draft', 'status', 'error', 'result'].includes(turn.kind)) return turn
    if (turn.kind === 'draft') return { ...turn, kind: 'dispatch', quote: undefined,
      dispatchTask: taskValue(projection.openInputRequest?.taskId) === taskValue(task.taskId) ? { ...task, inputRequest: projection.openInputRequest } : task,
      documentText: turn.text, text: '任务已交办' }
    return { ...turn, role: 'task', quote: undefined,
      text: turn.kind === 'error' ? `任务执行链受阻${task.error?.code ? `（${task.error.code}）` : ''} · 恢复状态：未读到恢复完成回执` : turn.text }
  })
}

const KIND_LABELS = Object.freeze({
  message: '回答',
  draft: '整理',
  dispatch: '交办',
  clarification: '需要确认',
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

export function mainTopicActorLabel(role, agentName = 'Jenny') {
  if (role === 'jenny') return agentName
  return ({ user: '你', task: '任务执行链', orchestration: '编排 Agent' })[role] || 'Agent'
}

function turnHeader(turn, label, answered) {
  const header = element('header', undefined, 'mt-turn-head')
  const kindLabel = turn.kind === 'input-request'
    ? (answered ? '已回答' : '等待你的回答')
    : KIND_LABELS[turn.kind] || '消息'
  header.append(
    element('strong', mainTopicActorLabel(turn.role, label)),
    element('span', kindLabel, 'mt-turn-kind'),
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
  const answered = answeredRequestIds.has(requestKey(turn))
  const header = turnHeader(turn, project.agentName, answered)
  const previousHeader = article.querySelector('.mt-turn-head')
  if (previousHeader) previousHeader.replaceWith(header)
  else article.append(header)
  const previousStatus = article.querySelector('.conversation-status')
  if (turn.statusFacts || turn.localStatus) {
    const status = element('div', undefined, `conversation-status${turn.turnId.startsWith('local-status:') ? ' mt-send-status' : ''}`)
    status.setAttribute('aria-label', '执行阶段与计时')
    for (const row of turn.localStatus || conversationStatus(turn.statusFacts)) {
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
      if (row.error) {
        line.append(element('span', `${row.error.code || ''} ${row.error.message || ''}`.trim(), 'conversation-status-error'))
        appendPairingEntry(line, row.error)
      }
      status.append(line)
    }
    if (turn.onRecover && turn.localStatus?.some(row => row.error)) {
      const recover = element('button', '重新读取本轮状态', 'conversation-status-detail')
      recover.type = 'button'
      recover.onclick = () => void turn.onRecover()
      status.append(recover)
    }
    if (turn.onContinue) {
      const resume = element('button', '继续本轮处理', 'conversation-status-detail')
      resume.type = 'button'
      resume.onclick = () => void turn.onContinue()
      status.append(resume)
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
  bubble.querySelector('.mt-task-document')?.remove()
  if (turn.documentText && !turn.dispatchTask) {
    const documentDetail = element('details', undefined, 'mt-task-document')
    documentDetail.append(element('summary', '任务文档'), element('p', turn.documentText))
    bubble.append(documentDetail)
  }
  bubble.querySelector('.mt-draft-next')?.remove()
  if (turn.kind === 'draft' && !turn.dispatchTask) {
    const draft = turn.draftReview
    const next = element('div', undefined, 'mt-draft-next')
    if (draft?.intent === 'change' || draft?.intent === 'append') {
      const target = project.tasks?.find(task => taskValue(task.taskId) === draft.taskId)
      const originalState = target?.stateLabel ? ` 原任务状态：${target.stateLabel}。` : ''
      next.append(element('p', `待处理 · 请打开原任务查看可用操作。${originalState}`))
      if (draft.taskId) {
        const link = element('a', '查看原任务', 'button conversation-status-detail')
        link.href = taskControlHref(draft.taskId, { kind: 'task', projectKey: project.projectKey, mode: project.mode })
        next.append(link)
      }
    } else {
      next.append(element('p', draft?.intent === 'create'
        ? '已整理 · 等待投递给编排 Agent'
        : '已整理 · 暂未取得任务投递回执'))
    }
    bubble.append(next)
  }
  bubble.querySelector('.dispatch-card')?.remove()
  if (turn.dispatchTask) bubble.append(renderDispatchCard(turn, turn.dispatchTask, {
    onOpen: (trigger, task) => topicState.onOpenDispatch?.(trigger, task, { ...turn, text: turn.documentText }),
    observation: topicState.dispatchObservation?.(turn.dispatchTask),
    executionObserved: topicState.dispatchExecutionObserved?.(turn.dispatchTask),
  }))
  let detailReadError = bubble.querySelector('.mt-detail-read-error')
  if (turn.detailReadError) {
    if (!detailReadError) {
      detailReadError = element('p', '', 'mt-detail-read-error conversation-status-error')
      bubble.append(detailReadError)
    }
    detailReadError.textContent = turn.detailReadError.message
  } else detailReadError?.remove()
  const events = turn.taskId || turn.dispatchTask ? undefined : turn.toolEvents
  let tools = bubble.querySelector('.tool-body')
  if (events?.length) {
    if (!tools) {
      tools = element('div', undefined, 'tool-body')
      bubble.append(tools)
    }
    renderToolBody(tools, events, api.readToolOutput)
  } else if (tools) {
    disposeToolBody(tools)
    tools.remove()
  }
  const explicitState = turn.statusFacts?.state
  renderExplicitToolActivity(bubble, turn.explicitSteps ?? turn.statusFacts?.steps,
    Boolean(turn.statusFacts?.steps && !['received', 'matching'].includes(explicitState)) ||
    Boolean(turn.localStatus?.some(row => row.error)))
  let control = answerControls.get(article)
  const key = requestKey(turn)
  if (turn.kind === 'input-request' && turn.requestId && turn.taskId
    && !answered) {
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

function renderHistoryRound(round, turns, topicState, scope, previous) {
  const row = previous || element('article', undefined, 'mt-history-round')
  row.dataset.historyRoundKey = round.roundKey
  let user = row.querySelector('.mt-history-user')
  let button = row.querySelector('.mt-history-summary-button')
  if (!user) {
    user = element('div', undefined, 'mt-history-user')
    user.append(element('p', '', 'mt-text'))
    row.append(user)
  }
  const quote = quoteBlock(turns.find(turn => turn.role === 'user')?.quote)
  const previousQuote = user.querySelector('.mt-quote')
  if (previousQuote && quote) previousQuote.replaceWith(quote)
  else if (previousQuote) previousQuote.remove()
  else if (quote) user.prepend(quote)
  user.querySelector('.mt-text').textContent = round.userText || '未记录关联的用户原文'
  if (!button) {
    button = element('button', undefined, 'mt-history-summary-button')
    button.type = 'button'
    button.setAttribute('aria-haspopup', 'dialog')
    const mark = element('span', 'H', 'mt-agent-mark')
    mark.setAttribute('aria-hidden', 'true')
    const arrow = element('span', '→', 'mt-history-open')
    arrow.setAttribute('aria-hidden', 'true')
    button.append(mark, element('span', '', 'mt-history-summary'), arrow)
    row.append(button)
  }
  button.dataset.roundKey = round.roundKey
  button.querySelector('.mt-history-summary').textContent = round.summary?.text || '本轮已结束，未记录可展示的摘要'
  button.onclick = () => {
    topicState.detail = { scope, roundKey: round.roundKey, trigger: button }
    topicState.onOpenHistoryDetail?.(button, round, turns)
  }
  return row
}

function renderActiveTurns(stream, turns, projection, onAnswer, host, answeredRequestIds, topicState, bindings, previousTurns) {
  for (const turn of turns) {
    const current = updateTurn(previousTurns.get(turn.turnId) || element('article'),
      turn, projection, onAnswer, host, answeredRequestIds, topicState, bindings)
    stream.append(current)
  }
}

export function disposeMainTopic(host) {
  for (const tools of host.querySelectorAll('.tool-body')) disposeToolBody(tools)
  topicStates.get(host)?.clock.dispose()
  topicStates.delete(host)
}

export function updateMainTopicUsage(host, usage, options = {}) {
  const footer = host.querySelector('.call-usage-footer')
  if (footer) callUsageFooter.updateCallUsageFooter(footer, usage, options)
}

// Consume the server's lanes and references once for both chat and its footer.
// Legacy read models may carry turns without any round metadata, including [].
export function mainTopicTurnGroups(projection) {
  const turns = projection?.turns || []
  if (!projection?.rounds?.length) return { history: [], activeTurns: turns }
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]))
  const resolve = (round) => round.messageRefs.map((ref) => turnsById.get(ref)).filter(Boolean)
  return {
    history: projection.rounds.filter((round) => round.lane === 'history')
      .map((round) => ({ round, turns: resolve(round) })),
    activeTurns: [...projection.rounds.filter((round) => round.lane !== 'history').flatMap(resolve),
      ...turns.filter(turn => projection.localTurnIds?.includes(turn.turnId))],
  }
}

export function renderMainTopic(host, projection, { onAnswer, onOpenDetail, onOpenHistoryDetail, onOpenDispatch, dispatchObservation, dispatchExecutionObserved } = {}) {
  projection = { ...projection, turns: ownedMainTopicTurns(projection) }
  if (!(host instanceof HTMLElement)) throw new Error('main topic requires a host element')
  const activeControl = host.contains(document.activeElement) ? document.activeElement : undefined
  const scroller = host.closest?.('.page-primary') || document.scrollingElement || host
  const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100
  const previousScroll = scroller.scrollTop
  const scope = JSON.stringify([projection.projectKey, projection.mode, projection.workspaceCwd])
  let topicState = topicStates.get(host)
  if (topicState?.scope !== scope) {
    for (const tools of host.querySelectorAll('.tool-body')) disposeToolBody(tools)
    topicState?.clock.dispose()
    clearNode(host)
    topicState = { scope, clock: createConversationStatusClock(host), detail: undefined }
    topicStates.set(host, topicState)
  }
  if (onOpenDetail !== undefined) topicState.onOpenDetail = onOpenDetail
  if (onOpenHistoryDetail !== undefined) topicState.onOpenHistoryDetail = onOpenHistoryDetail
  if (onOpenDispatch !== undefined) topicState.onOpenDispatch = onOpenDispatch
  if (dispatchObservation !== undefined) topicState.dispatchObservation = dispatchObservation
  if (dispatchExecutionObserved !== undefined) topicState.dispatchExecutionObserved = dispatchExecutionObserved
  if (topicState.detail && topicState.detail.scope !== scope) topicState.detail = undefined
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
  identity.append(element('h2', '主会话', 'mt-agent'))
  head.append(identity)
  const previousHead = section.querySelector('.mt-head')
  if (previousHead) previousHead.replaceWith(head)
  else section.prepend(head)

  const previousActive = section.querySelector('.mt-active')
  if (projection.activeTask && !projection.tasks?.some(task => taskValue(task.taskId) === taskValue(projection.activeTask.taskId))) {
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
  const { history, activeTurns } = mainTopicTurnGroups(projection)
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
    const previousHistory = new Map([...stream.querySelectorAll('.mt-history-round')]
      .map(row => [row.dataset.historyRoundKey, row]))
    clearNode(stream)
    for (const { round, turns: roundTurns } of history) {
      stream.append(renderHistoryRound(round, roundTurns, topicState, scope, previousHistory.get(round.roundKey)))
    }
    if (history.length && activeTurns.length) {
      const divider = element('hr', undefined, 'mt-conversation-divider')
      divider.setAttribute('aria-hidden', 'true')
      stream.append(divider)
    }
    renderActiveTurns(stream, activeTurns, projection, onAnswer, host, answeredRequestIds, topicState, bindings, previousTurns)
  }
  for (const article of previousTurns.values()) {
    if (!article.isConnected) for (const tools of article.querySelectorAll('.tool-body')) disposeToolBody(tools)
  }
  topicState.clock.update(bindings)
  // The page owns the exact session read. Keep the footer node (and disclosure)
  // across chat refreshes; the independent read updates it without rebuilding chat.
  if (!section.querySelector('.call-usage-footer')) section.append(callUsageFooter.renderCallUsageFooter())
  if (activeControl?.isConnected && document.activeElement !== activeControl) activeControl.focus({ preventScroll: true })
  const last = stream.lastElementChild
  if (follow && last) scroller.scrollTop = scroller.scrollHeight
  else scroller.scrollTop = previousScroll
  return section
}
