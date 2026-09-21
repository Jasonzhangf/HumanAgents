import {
  api,
  clearNode,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  observationHref,
  queryParam,
  renderRuntimeStatus,
  stateTone,
  taskDashboardHref,
  taskIdFromQuery,
} from './runtime-shell.js'

const requestedTask = taskIdFromQuery(false)
const requestedInteraction = queryParam('interaction')
const isNew = (requestedTask === 'new' || !requestedTask) && !requestedInteraction
const { main, status } = makePageShell(
  'Task List',
  'Task',
  isNew ? '新建任务' : requestedInteraction ? '确认任务' : '任务详情',
  isNew ? '用一句话告诉显式大脑你要完成什么。' : requestedInteraction ? '显式大脑会先整理，再由你确认是否提交后台。' : '查看任务状态和处理结果。',
)

let taskId = requestedTask
let detail

function readable(value, placeholder = '暂无信息') {
  if (value === undefined || value === null || value === '') return placeholder
  if (Array.isArray(value)) {
    const items = value
      .map((item) => item && typeof item === 'object' ? item.label : item)
      .filter((item) => item !== undefined && item !== null && item !== '')
    return items.length ? items.join('、') : placeholder
  }
  return String(value)
}

function renderCreate() {
  const panel = element('section', undefined, 'panel')
  const form = element('form', undefined, 'form-grid')
  const directiveLabel = element('label', '你要完成什么？')
  const directive = element('textarea')
  directive.required = true
  directive.placeholder = '直接描述目标、背景和限制，不需要填写标题或执行指令。'
  directiveLabel.append(directive)
  const button = element('button', '提交给显式大脑', 'button button--primary')
  button.type = 'submit'
  const feedback = element('p', '显式大脑会整理输入、补齐任务信息，并在需要时向你确认。', 'muted')
  feedback.setAttribute('role', 'status')
  feedback.setAttribute('aria-live', 'polite')
  form.append(directiveLabel, button, feedback)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      const rawInput = directive.value.trim()
      feedback.textContent = '正在交给显式大脑整理…'
      const received = await api.receiveExplicitInput({
        sourceRef: 'ui:new-task',
        rawInput,
        inputRevision: 1,
      })
      window.location.href = `./task.html?interaction=${encodeURIComponent(received.interactionId)}#task-interaction`
    } catch (error) {
      feedback.textContent = `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`
    }
  })
  panel.append(form)
  main.append(panel)
}

async function renderInteraction(interactionId, currentTaskId) {
  clearNode(main)
  const panel = element('section', undefined, 'panel')
  panel.append(element('p', '显式大脑', 'eyebrow'), element('h2', '先确认这次要处理的事'))
  const feedback = element('p', '正在整理你的输入…', 'muted')
  feedback.setAttribute('role', 'status')
  feedback.setAttribute('aria-live', 'polite')
  const body = element('div', undefined, 'form-grid')
  const actions = element('div', undefined, 'actions')
  panel.append(feedback, body, actions)
  main.append(panel)

  try {
    let snapshot = await api.inspectExplicitInteraction(interactionId)
    if (snapshot.state === 'received' || snapshot.state === 'matching') {
      if (snapshot.state === 'received') await api.beginExplicitMatching(interactionId)
      await api.recordExplicitMatch(interactionId, {
        normalizedInput: snapshot.rawInput,
        matchedTasks: currentTaskId ? [{ taskId: currentTaskId, relation: 'current', status: detail?.state || 'created' }] : [],
        knownFacts: [],
      })
      snapshot = await api.inspectExplicitInteraction(interactionId)
    }
    if (snapshot.state === 'awaiting-intent' && snapshot.draft) {
      await api.proposeExplicitRequirement(interactionId, {
        proposedIntent: currentTaskId ? 'append' : 'create',
        proposal: snapshot.draft.normalizedInput,
        decisionRefs: [],
      })
      snapshot = await api.inspectExplicitInteraction(interactionId)
    }
    body.append(
      element('p', '你的输入', 'eyebrow'),
      element('p', snapshot.rawInput),
      element('p', '整理后的任务', 'eyebrow'),
      element('p', snapshot.draft?.proposal || snapshot.rawInput),
    )
    if (snapshot.state === 'awaiting-confirmation' && snapshot.draft) {
      feedback.textContent = '已整理完成。确认后才会提交到后台。'
      const confirm = element('button', '确认并提交后台', 'button button--primary')
      confirm.type = 'button'
      confirm.addEventListener('click', async () => {
        confirm.disabled = true
        feedback.textContent = '正在确认并提交…'
        try {
          await api.confirmExplicitRequirement(interactionId, {
            draftId: snapshot.draft.draftId,
            inputRevision: snapshot.draft.inputRevision,
            confirmationRef: `ui:confirmation:${interactionId}`,
            confirmedBy: 'human:operator',
            confirmedAt: new Date().toISOString(),
            payloadRef: `asset://requirements/${interactionId}`,
          })
          const dispatched = await api.dispatchNextExplicitRequirement()
          if (dispatched.requirement?.draftId !== snapshot.draft.draftId) {
            feedback.textContent = '已确认，但队列前还有其他任务；当前任务仍在等待派发。'
            return
          }
          taskId = dispatched.taskId
          window.location.href = taskDashboardHref(taskId)
        } catch (error) {
          confirm.disabled = false
          feedback.textContent = `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`
        }
      })
      actions.append(confirm)
    } else {
      feedback.textContent = `当前状态：${snapshot.state}。${snapshot.nextAction}`
    }
  } catch (error) {
    feedback.textContent = `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`
  }
}

function renderTask() {
  clearNode(main)
  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', 'Task Detail', 'eyebrow'), element('h1', readable(detail.title)))
  const chip = element('span', readable(detail.currentState), 'state-chip')
  chip.dataset.tone = stateTone(detail.state)
  copy.append(chip)
  heading.append(copy)
  main.append(heading)

  const facts = element('dl', undefined, 'detail-grid')
  for (const [label, value] of [
    ['输入', detail.priorInput],
    ['调查结果', detail.investigation],
    ['建议', detail.proposal],
    ['需要你决定', detail.requiredDecisions],
    ['输出', detail.output?.summary],
    ['artifact', detail.output?.artifacts],
    ['任务观测', detail.observationRef],
    ['最近下一步', detail.nextAction],
    ['最近更新', detail.data.updatedAt ? formatTime(detail.data.updatedAt) : undefined],
  ]) {
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', readable(value)))
    facts.append(cell)
  }
  main.append(facts)

  const actions = element('section', undefined, 'actions')
  const dashboardLink = element('a', '打开 Task Dashboard', 'button button--primary')
  dashboardLink.href = taskDashboardHref(taskId)
  const observationLink = element('a', '打开只读 Observation', 'button')
  observationLink.href = observationHref(taskId)
  actions.append(dashboardLink, observationLink)
  main.append(actions)
}

async function load() {
  const { status: runtimeStatus, error } = await loadRuntimeStatus()
  renderRuntimeStatus(status, runtimeStatus, error)
  if (isNew) {
    renderCreate()
    return
  }
  if (requestedInteraction) {
    if (taskId) detail = await api.taskDetail(taskId)
    await renderInteraction(requestedInteraction, taskId)
    return
  }
  if (taskId && window.location.hash === '#task-interaction') {
    detail = await api.taskDetail(taskId)
    const received = await api.receiveExplicitInput({
      sourceRef: `ui:task:${taskId}`,
      rawInput: detail.priorInput || detail.title,
      inputRevision: 1,
    })
    window.history.replaceState(null, '', `./task.html?task=${encodeURIComponent(taskId)}&interaction=${encodeURIComponent(received.interactionId)}#task-interaction`)
    await renderInteraction(received.interactionId, taskId)
    return
  }
  detail = await api.taskDetail(taskId)
  renderTask()
}

void load().catch((error) => {
  status.dataset.tone = 'danger'
  status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
})
