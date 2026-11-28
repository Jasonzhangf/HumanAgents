import { api, appendPairingEntry, clearNode, element, formatTime, taskControlHref } from './runtime-shell.js'
import { conversationStatus, createConversationStatusClock } from './conversation-status.js'
import * as callUsageFooter from './call-usage-footer.js'
import { renderToolBody, disposeToolBody } from './tool-presentation.js'
import { taskForTurn, taskValue, renderDispatchCard } from './dispatch-tracking.js'
import { explicitRequestMetadata, explicitStepsWithToolEvents, explicitToolActivityFinished } from './explicit-tool-activity.js'
import { taskBlocker, userFacingErrorReason } from './task-blocker.js'
import { disposeMainTopicTaskBar, renderMainTopicTaskBar } from './main-topic-task-bar.js'

export function ownedMainTopicTurns(projection) {
  const turns = projection.turns || []
  const dispatchTask = turn => {
    const task = turn.kind === 'draft' && taskForTurn(turn, projection.tasks)
    return task?.sourceInteractionId && turn.interactionId === task.sourceInteractionId ? task : undefined
  }
  const cardTasks = new Set(turns.map(dispatchTask).filter(Boolean).map(task => taskValue(task.taskId)))
  const trackedExecution = turn => ['status', 'error'].includes(turn.kind) && cardTasks.has(taskValue(turn.taskId))
  const executionFacts = turn => (turn.statusFacts?.events?.length ?? 0) > 0 || (turn.toolEvents?.length ?? 0) > 0
  return turns.filter(turn => turn.detailReadError || !trackedExecution(turn) || executionFacts(turn)).map(turn => {
    const task = taskForTurn(turn, projection.tasks)
    if (!task || turn.role === 'user' || !['draft', 'status', 'error', 'result'].includes(turn.kind)) return turn
    if (turn.kind === 'draft' && !dispatchTask(turn)) return turn
    if (turn.kind === 'draft') return { ...turn, kind: 'dispatch', quote: undefined,
      dispatchTask: taskValue(projection.openInputRequest?.taskId) === taskValue(task.taskId) ? { ...task, inputRequest: projection.openInputRequest } : task,
      documentText: turn.text, text: '任务已交办' }
    if (trackedExecution(turn) && !turn.detailReadError) return { ...turn, role: 'task', quote: undefined, text: '' }
    if (turn.kind === 'error') {
      const blocker = taskBlocker(task) || taskBlocker({ ...task, state: 'blocked' })
      return { ...turn, role: 'task', quote: undefined,
        text: [task.title, blocker.reason, blocker.code, blocker.next].filter(Boolean).join(' · ') }
    }
    return { ...turn, role: 'task', quote: undefined,
      text: turn.text }
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
const clarificationControls = new WeakMap()

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

export function mainTopicActorLabel(role, agentName = '助手') {
  if (role === 'jenny') return agentName
  return ({ user: '你', task: '任务执行链', orchestration: '编排 Agent' })[role] || 'Agent'
}

function turnHeader(turn, label, answered, removableRound, onRemoveHistory) {
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
  if (removableRound && typeof onRemoveHistory === 'function') {
    const removeButton = element('button', '移除记录', 'mt-history-remove')
    removeButton.type = 'button'
    removeButton.dataset.removeRoundKey = removableRound.roundKey
    removeButton.setAttribute('aria-label', '从当前会话移除此轮记录')
    removeButton.onclick = async () => {
      removeButton.disabled = true
      try {
        await onRemoveHistory({ roundKey: removableRound.roundKey })
      } finally {
        if (removeButton.isConnected) removeButton.disabled = false
      }
    }
    header.append(removeButton)
  }
  return header
}

function renderTaskActionControls(task, onTaskAction) {
  if (!task || typeof onTaskAction !== 'function') return undefined
  if (['succeeded', 'completed'].includes(task.state)) return undefined
  const allowed = Array.isArray(task.allowedActions) ? task.allowedActions : []
  const actions = []
  if (allowed.includes('recover')) actions.push({ action: 'recover', label: '恢复继续', primary: true })
  else if (allowed.includes('resume') && task.operationId?.value) actions.push({ action: 'resume', label: '继续执行', primary: true })
  if (allowed.includes('stop') && ['running', 'waiting', 'settling', 'blocked', 'failed', 'admitted', 'created'].includes(task.state)) {
    actions.push({ action: 'stop', label: '停止任务', primary: false })
  }
  if (actions.length === 0) return undefined
  const bar = element('div', undefined, 'mt-task-actions')
  bar.dataset.taskId = taskValue(task.taskId) || ''
  const feedback = element('span', '', 'mt-task-action-status muted')
  feedback.hidden = true
  const buttons = []
  for (const item of actions) {
    const button = element('button', item.label, item.primary ? 'button button--primary mt-task-action' : 'button mt-task-action')
    button.type = 'button'
    button.dataset.taskAction = item.action
    button.onclick = async () => {
      for (const candidate of buttons) candidate.disabled = true
      feedback.hidden = false
      feedback.dataset.tone = 'warning'
      feedback.textContent = item.action === 'stop' ? '正在停止任务…' : '正在恢复执行…'
      try {
        await onTaskAction(item.action, task)
        if (feedback.isConnected) feedback.hidden = true
      } catch (error) {
        if (feedback.isConnected) {
          feedback.hidden = false
          feedback.dataset.tone = 'danger'
          feedback.textContent = error?.message || String(error)
        }
      } finally {
        for (const candidate of buttons) if (candidate.isConnected) candidate.disabled = false
      }
    }
    buttons.push(button)
    bar.append(button)
  }
  bar.append(feedback)
  return bar
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

function renderClarification(article, bubble, clarification) {
  const previous = clarificationControls.get(article)
  const signature = JSON.stringify([clarification?.question, clarification?.options])
  if (!clarification) {
    previous?.form.remove()
    clarificationControls.delete(article)
    return
  }
  if (previous?.signature === signature) return
  previous?.form.remove()
  const form = element('form', undefined, 'mt-clarification')
  form.setAttribute('aria-label', '补充本次输入')
  form.append(element('p', clarification.question || '请补充信息'))
  const input = element('input')
  input.name = 'clarification-answer'
  input.required = true
  input.placeholder = '填写后继续本次输入'
  const submit = element('button', '继续本次输入', 'button button--sm')
  submit.type = 'submit'
  const status = element('p', '', 'muted')
  status.setAttribute('role', 'status')
  const answer = async value => {
    const text = String(value ?? '').trim()
    if (!text) {
      status.textContent = '请先填写补充信息。'
      input.focus()
      return
    }
    submit.disabled = true
    status.textContent = '正在继续本次输入…'
    try {
      await clarification.submit?.(text)
      status.textContent = '已提交补充信息。'
    } catch (error) {
      submit.disabled = false
      status.textContent = error?.message || '补充信息未提交，请重试。'
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    void answer(input.value)
  })
  form.append(input, submit, status)
  if (clarification.options?.length) {
    const options = element('div', undefined, 'mt-options')
    for (const option of clarification.options) {
      const button = element('button', option, 'mt-option')
      button.type = 'button'
      button.addEventListener('click', () => void answer(option))
      options.append(button)
    }
    form.append(options)
  }
  bubble.append(form)
  clarificationControls.set(article, { signature, form })
}

function updateTurn(article, turn, project, onAnswer, host, answeredRequestIds, topicState, bindings, readToolOutput, actionTask, removableRound) {
  article.className = turnClass(turn)
  article.dataset.turnId = turn.turnId
  const answered = answeredRequestIds.has(requestKey(turn))
  const header = turnHeader(turn, project.agentName, answered, removableRound, topicState.onRemoveHistory)
  const previousHeader = article.querySelector('.mt-turn-head')
  if (previousHeader) previousHeader.replaceWith(header)
  else article.append(header)
  const explicitSteps = turn.explicitSteps ?? turn.statusFacts?.steps
  const metadata = explicitRequestMetadata(explicitSteps)
  let requestMetadata = article.querySelector('.mt-request-metadata')
  if (metadata) {
    if (!requestMetadata) requestMetadata = element('p', '', 'mt-request-metadata')
    requestMetadata.dataset.running = String(metadata.running)
    requestMetadata.textContent = metadata.label
    header.after(requestMetadata)
  } else requestMetadata?.remove()
  const previousStatus = article.querySelector('.conversation-status')
  if (turn.statusFacts || turn.localStatus) {
    // Provider tool facts have a dedicated semantic card below. Keeping their
    // generic phase row here duplicates the action and hides its result details.
    const rows = (turn.localStatus || conversationStatus(turn.statusFacts)).filter((row) => row.phase !== 'tool')
    const signature = JSON.stringify([rows, Boolean(turn.onRecover), Boolean(turn.onContinue)])
    if (previousStatus?.dataset.signature === signature) {
      const lines = [...previousStatus.querySelectorAll('.conversation-status-row')]
      for (const [index, row] of rows.entries()) {
        const time = lines[index]?.querySelector('.conversation-status-time')
        if (time) bindings.push({ row, node: time })
      }
      const detail = previousStatus.querySelector('[data-open-turn-detail]')
      if (detail) detail.onclick = () => topicState.onOpenDetail(detail, turn)
    } else {
      const status = element('div', undefined, `conversation-status${turn.turnId.startsWith('local-status:') ? ' mt-send-status' : ''}`)
      status.setAttribute('aria-label', '执行阶段与计时')
      status.dataset.signature = signature
      for (const row of rows) {
        const line = element('div', undefined, 'conversation-status-row')
        line.dataset.phase = row.phase
        line.dataset.tone = row.tone
        line.dataset.running = String(row.running)
        const mark = element('span', row.tone === 'danger' ? '!' : row.tone === 'success' ? '✓' : '●', 'conversation-status-mark')
        mark.setAttribute('aria-hidden', 'true')
        line.append(mark, element('span', row.label))
        if (row.statusLabel) line.append(element('span', row.statusLabel, 'muted'))
        const time = element('span', '', 'conversation-status-time')
        line.append(time)
        bindings.push({ row, node: time })
        if (row.error) {
          const errorText = [userFacingErrorReason(row.error), row.error.code].filter(Boolean).join(' · ')
          line.append(element('span', errorText, 'conversation-status-error'))
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
        detail.dataset.openTurnDetail = ''
        detail.onclick = () => topicState.onOpenDetail(detail, turn)
        status.append(detail)
      }
      if (previousStatus) previousStatus.replaceWith(status)
      else header.after(status)
    }
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
      : turn.dispatchError ? `未能投递 · ${turn.dispatchError.message || '请重试'}${turn.dispatchError.nextAction ? ` 下一步：${turn.dispatchError.nextAction}` : ''}`
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
  // A relay question owns the decision, not the task's concurrent tools.
  // Those remain on the task bar and in the task execution drawer.
  const events = turn.kind === 'input-request' ? undefined : [
    ...(turn.toolEvents ?? []), ...explicitStepsWithToolEvents(explicitSteps, turn.interactionId),
  ]
  let tools = bubble.querySelector('.tool-body')
  let toolDetails = bubble.querySelector('.mt-tool-details')
  const toolTask = turn.dispatchTask ?? (turn.taskId ? project.tasks?.find(task => taskValue(task.taskId) === taskValue(turn.taskId)) : undefined)
  const currentTaskState = toolTask?.state ?? turn.statusFacts?.state
  if (events?.length) {
    if (!tools) {
      tools = element('div', undefined, 'tool-body')
    }
    const finished = explicitToolActivityFinished(turn)
    renderToolBody(tools, events, readToolOutput, {
      finished,
      hideTransientErrors: true,
      taskState: currentTaskState,
      statusEvents: turn.statusFacts?.events,
    })
    if (tools.hidden || tools.children.length === 0) {
      disposeToolBody(tools)
      tools.remove()
      toolDetails?.remove()
    } else if (finished) {
      if (!toolDetails) {
        toolDetails = element('details', undefined, 'mt-tool-details')
        toolDetails.append(element('summary', '查看执行步骤'))
        bubble.append(toolDetails)
      }
      if (tools.parentElement !== toolDetails) toolDetails.append(tools)
    } else {
      if (tools.parentElement !== bubble) bubble.append(tools)
      toolDetails?.remove()
    }
  } else if (tools) {
    disposeToolBody(tools)
    tools.remove()
    toolDetails?.remove()
  }
  bubble.querySelector('.mt-task-actions')?.remove()
  const actionControls = renderTaskActionControls(actionTask, topicState.onTaskAction)
  if (actionControls) bubble.append(actionControls)
  renderClarification(article, bubble, turn.clarification)
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
      if (topicState.onOpenDecision) {
        const form = element('button', '回答原问题', 'button mt-option')
        form.type = 'button'
        form.addEventListener('click', () => topicState.onOpenDecision(request))
        control = { form, update() {}, key }
      } else {
        control = { ...renderAnswerControls(request, onAnswer, host, topicState), key }
      }
      answerControls.set(article, control)
      bubble.append(control.form)
    } else control.update(request, onAnswer)
  } else if (control) {
    control.form.remove()
    answerControls.delete(article)
  }
  text.hidden = text.textContent === ''
  bubble.hidden = text.hidden && bubble.childElementCount === 1
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
  const previousActions = row.querySelector('.mt-history-round-actions')
  if (round.removable && typeof topicState.onRemoveHistory === 'function') {
    const actions = previousActions || element('div', undefined, 'mt-history-round-actions')
    let removeButton = actions.querySelector('.mt-history-remove')
    if (!removeButton) {
      removeButton = element('button', '移除', 'mt-history-remove')
      removeButton.type = 'button'
      actions.append(removeButton)
    }
    removeButton.dataset.removeRoundKey = round.roundKey
    removeButton.setAttribute('aria-label', '从当前会话移除此轮历史')
    removeButton.onclick = async () => {
      removeButton.disabled = true
      try {
        await topicState.onRemoveHistory?.({ roundKey: round.roundKey })
      } finally {
        if (removeButton.isConnected) removeButton.disabled = false
      }
    }
    if (!previousActions) row.append(actions)
  } else {
    previousActions?.remove()
  }
  return row
}

function syncStreamChildren(stream, next) {
  if (typeof stream.insertBefore !== 'function') {
    stream.replaceChildren(...next)
    return
  }
  for (const [index, node] of next.entries()) {
    if (stream.children[index] !== node) stream.insertBefore(node, stream.children[index] ?? null)
  }
  while (stream.children.length > next.length) stream.lastElementChild.remove()
}

export function disposeMainTopic(host) {
  disposeMainTopicTaskBar(host)
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
  const resolve = (round) => [...new Set(round.messageRefs)].map((ref) => turnsById.get(ref)).filter(Boolean)
  return {
    history: projection.rounds.filter((round) => round.lane === 'history')
      .map((round) => ({ round, turns: resolve(round) })),
    activeTurns: [...projection.rounds.filter((round) => round.lane !== 'history').flatMap(resolve),
      ...turns.filter(turn => projection.localTurnIds?.includes(turn.turnId))],
  }
}

export function renderMainTopic(host, projection, { onAnswer, onOpenDecision, onOpenDetail, onOpenHistoryDetail, onOpenDispatch, onRemoveHistory, onTaskAction, dispatchObservation, dispatchExecutionObserved, readToolOutput: readToolOutputOption } = {}) {
  projection = { ...projection, turns: ownedMainTopicTurns(projection) }
  if (!(host instanceof HTMLElement)) throw new Error('main topic requires a host element')
  const activeControl = host.contains(document.activeElement) ? document.activeElement : undefined
  const scroller = host.closest?.('.page-primary') || document.scrollingElement || host
  const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100
  const previousScroll = scroller.scrollTop
  const scope = JSON.stringify([projection.projectKey, projection.mode, projection.workspaceCwd])
  let topicState = topicStates.get(host)
  if (topicState?.scope !== scope) {
    disposeMainTopicTaskBar(host)
    for (const tools of host.querySelectorAll('.tool-body')) disposeToolBody(tools)
    topicState?.clock.dispose()
    clearNode(host)
    topicState = { scope, clock: createConversationStatusClock(host), detail: undefined }
    topicStates.set(host, topicState)
  }
  if (onOpenDetail !== undefined) topicState.onOpenDetail = onOpenDetail
  if (onOpenDecision !== undefined) topicState.onOpenDecision = onOpenDecision
  if (onOpenHistoryDetail !== undefined) topicState.onOpenHistoryDetail = onOpenHistoryDetail
  if (onOpenDispatch !== undefined) topicState.onOpenDispatch = onOpenDispatch
  if (onRemoveHistory !== undefined) topicState.onRemoveHistory = onRemoveHistory
  if (onTaskAction !== undefined) topicState.onTaskAction = onTaskAction
  if (dispatchObservation !== undefined) topicState.dispatchObservation = dispatchObservation
  if (dispatchExecutionObserved !== undefined) topicState.dispatchExecutionObserved = dispatchExecutionObserved
  if (readToolOutputOption !== undefined) topicState.readToolOutput = readToolOutputOption
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
  renderMainTopicTaskBar(host, projection, {
    onOpenDispatch: topicState.onOpenDispatch,
    readToolOutput: api.readToolOutput,
    bindings,
  })
  section.id = 'main-topic'
  const head = element('header', undefined, 'mt-head')
  const identity = element('div', undefined, 'mt-identity')
  identity.append(element('h2', '主会话', 'mt-agent'))
  head.append(identity)
  const hasRemovableHistory = (projection.rounds || []).some((round) => round.removable === true)
  if (hasRemovableHistory && typeof topicState.onRemoveHistory === 'function') {
    const headActions = element('div', undefined, 'mt-head-actions')
    const clearButton = element('button', '清空历史', 'button mt-history-clear')
    clearButton.type = 'button'
    clearButton.dataset.clearMainTopicHistory = 'true'
    clearButton.onclick = async () => {
      clearButton.disabled = true
      try {
        await topicState.onRemoveHistory?.({ action: 'clear-history' })
      } finally {
        if (clearButton.isConnected) clearButton.disabled = false
      }
    }
    headActions.append(clearButton)
    head.append(headActions)
  }
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
    const next = history.map(({ round, turns: roundTurns }) =>
      renderHistoryRound(round, roundTurns, topicState, scope, previousHistory.get(round.roundKey)))
    if (history.length && activeTurns.length) {
      const divider = stream.querySelector('.mt-conversation-divider') ?? element('hr', undefined, 'mt-conversation-divider')
      divider.setAttribute('aria-hidden', 'true')
      next.push(divider)
    }
    const tasksById = new Map((projection.tasks || []).map((task) => [taskValue(task.taskId), task]))
    const lastActionTurnIdByTask = new Map()
    for (const turn of activeTurns) {
      const id = taskValue(turn.dispatchTask?.taskId ?? turn.taskId)
      if (id && tasksById.has(id)) lastActionTurnIdByTask.set(id, turn.turnId)
    }
    const removableRoundByLastTurnId = new Map()
    for (const round of projection.rounds || []) {
      if (round.lane === 'history' || round.removable !== true) continue
      const visibleRefs = (round.messageRefs || []).filter((ref) => activeTurns.some((turn) => turn.turnId === ref))
      const lastRef = visibleRefs.at(-1)
      if (lastRef) removableRoundByLastTurnId.set(lastRef, round)
    }
    for (const turn of activeTurns) {
      const id = taskValue(turn.dispatchTask?.taskId ?? turn.taskId)
      const actionTask = id && lastActionTurnIdByTask.get(id) === turn.turnId ? tasksById.get(id) : undefined
      const removableRound = removableRoundByLastTurnId.get(turn.turnId)
      next.push(updateTurn(previousTurns.get(turn.turnId) || element('article'),
        turn, projection, onAnswer, host, answeredRequestIds, topicState, bindings, topicState.readToolOutput ?? api.readToolOutput, actionTask, removableRound))
    }
    syncStreamChildren(stream, next)
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
