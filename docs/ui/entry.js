import {
  api,
  clearNode,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  renderRuntimeStatus,
  stateTone,
  taskDashboardHref,
} from './runtime-shell.js'

const { main, status } = makePageShell(
  'Index',
  'Explicit Input',
  '任务输入',
  '接受用户任务、展示显式草稿、确认后进入运行时队列。',
)

let interactionId
let draft
let confirmation
let pollTimer
let submitting = false

function liveArea() {
  const section = element('section', undefined, 'section')
  section.id = 'entry-live'
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '队列与任务状态'), element('span', 'Runtime', 'section-meta'))
  section.append(head, element('p', '尚未提交任务。', 'empty'))
  return section
}

function renderField(section, label, value) {
  const row = element('div', undefined, 'detail-cell')
  row.append(element('dt', label), element('dd', value || '—'))
  section.append(row)
}

function renderDraftContainer() {
  const section = element('section', undefined, 'section')
  section.id = 'entry-draft'
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '显式草稿'), element('span', '确认前不入队', 'section-meta'))
  section.append(head)
  return section
}

function renderDraft(snapshot) {
  const section = document.querySelector('#entry-draft')
  clearNode(section)
  if (snapshot.state === 'awaiting-clarification') {
    const panel = element('div', undefined, 'panel')
    const question = snapshot.clarifications?.at(-1)?.question || '需要澄清'
    panel.append(element('h3', question))
    const form = element('form', undefined, 'form-grid')
    const label = element('label')
    label.append('澄清', element('input', undefined))
    const input = label.querySelector('input')
    input.name = 'answer'
    input.required = true
    form.append(label)
    const actions = element('div', undefined, 'actions')
    const button = element('button', '提交澄清', 'button button--primary')
    button.type = 'submit'
    actions.append(button)
    form.append(actions)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void run(async () => {
        await api.answerExplicitClarification(interactionId, input.value.trim())
        const next = await api.inspectExplicitInteraction(interactionId)
        if (next.state === 'received' || next.state === 'matching') {
          const interpreted = await api.interpretExplicitInput(interactionId)
          renderDraft(interpreted)
        } else {
          renderDraft(next)
        }
      }, '已提交澄清。')
    })
    panel.append(form)
    section.append(panel)
    return
  }

  if (snapshot.state !== 'awaiting-confirmation' || !snapshot.draft) {
    section.append(element('p', `状态：${snapshot.state} · ${snapshot.nextAction}`, 'empty'))
    return
  }

  draft = snapshot.draft
  const panel = element('div', undefined, 'panel')
  const grid = element('dl', undefined, 'detail-grid')
  renderField(grid, '意图', draft.proposedIntent)
  renderField(grid, '规范化输入', draft.normalizedInput)
  renderField(grid, '已知事实', (draft.knownFacts || []).join('\n'))
  renderField(grid, '决策引用', (draft.decisionRefs || []).join('\n'))
  panel.append(grid)

  const proposal = element('section', undefined, 'section')
  proposal.append(element('h3', '建议'), element('p', draft.proposal, 'muted'))
  panel.append(proposal)

  const actions = element('div', undefined, 'actions')
  const confirmButton = element('button', '确认并进入队列', 'button button--primary')
  confirmButton.type = 'button'
  confirmButton.addEventListener('click', () => void confirmDraft(confirmButton))
  actions.append(confirmButton)
  panel.append(actions)
  section.append(panel)
}

function renderStatus(summary, rows) {
  const section = document.querySelector('#entry-live')
  clearNode(section)
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '队列与任务状态'), element('span', `${rows.length} 项`, 'section-meta'))
  section.append(head)

  const stats = element('div', undefined, 'stats')
  if (summary.implicitScheduling) {
    const queue = summary.implicitScheduling
    const card = element('article', undefined, 'stat')
    card.append(
      element('span', `FIFO · ${queue.requirementId}`),
      element('strong', String(queue.fifoSeq)),
      element('p', `${queue.state} · ${queue.code} · ${queue.nextAction}`, 'muted'),
    )
    stats.append(card)
  }
  for (const [label, value] of [
    ['已确认', confirmation ? confirmation.requirementId : '未确认'],
    ['任务数量', String(rows.length)],
  ]) {
    const card = element('article', undefined, 'stat')
    card.append(element('span', label), element('strong', value))
    stats.append(card)
  }
  section.append(stats)

  if (rows.length === 0) {
    section.append(element('p', confirmation ? '已确认，等待隐式队列创建任务。' : '尚未提交任务。', 'empty'))
    return
  }
  const list = element('div', undefined, 'panel stack')
  for (const row of rows) {
    const link = element('a', undefined, 'task-row-link')
    link.href = taskDashboardHref(row.taskId.value)
    const copy = element('div')
    copy.append(element('h3', row.title))
    copy.append(element('p', `${row.currentState} · 下一步：${row.nextStep}`))
    const stateChip = element('span', row.stateLabel, 'state-chip')
    stateChip.dataset.tone = stateTone(row.state)
    const meta = element('div', undefined, 'item-meta')
    meta.append(element('span', row.requirementAdmissionLabel || row.stateLabel), element('time', formatTime(row.updatedAt)))
    link.append(copy, stateChip, meta)
    link.style.textDecoration = 'none'
    list.append(link)
  }
  section.append(list)
}

async function refreshQueue() {
  try {
    const [runtimeStatus, tasks] = await Promise.all([api.status(), api.listTasks()])
    const rows = [
      ...tasks.draft,
      ...tasks.waiting,
      ...tasks.running,
      ...tasks.completed,
      ...tasks.failed,
    ]
    renderStatus(runtimeStatus, rows)
  } catch (error) {
    const panel = document.querySelector('#entry-live')
    if (panel) {
      clearNode(panel)
      panel.append(element('p', `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`, 'empty'))
    }
  }
}

async function confirmDraft(button) {
  if (!interactionId || !draft) return
  button.disabled = true
  try {
    const receipt = await api.confirmExplicitRequirement(interactionId, {
      draftId: draft.draftId,
      inputRevision: draft.inputRevision,
      confirmationRef: `confirmation:ui:${interactionId}`,
      confirmedBy: 'human:operator',
      confirmedAt: new Date().toISOString(),
      payloadRef: `asset://requirements/ui:${interactionId}`,
    })
    confirmation = receipt.requirement
    button.textContent = `已确认 · ${confirmation.requirementId}`
    await refreshQueue()
    pollTimer ??= setInterval(() => void refreshQueue(), 2000)
  } catch (error) {
    button.disabled = false
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`
  }
}

function renderForm() {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '用户任务'), element('span', '输入后由显式大脑整理', 'section-meta'))
  section.append(head)

  const panel = element('div', undefined, 'panel')
  const form = element('form', undefined, 'form-grid')
  const label = element('label')
  label.append('任务输入', element('textarea', undefined))
  const textarea = label.querySelector('textarea')
  textarea.name = 'rawInput'
  textarea.required = true
  textarea.placeholder = '描述要处理的一个任务'
  form.append(label)
  const actions = element('div', undefined, 'actions')
  const submitButton = element('button', '生成显式草稿', 'button button--primary')
  submitButton.type = 'submit'
  form.append(submitButton)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (submitting) return
    submitting = true
    submitButton.disabled = true
    void run(async () => {
      const received = await api.receiveExplicitInput({
        sourceRef: 'ui:entry',
        rawInput: textarea.value.trim(),
        inputRevision: 1,
      })
      interactionId = received.interactionId
      const snapshot = await api.interpretExplicitInput(interactionId)
      renderDraft(snapshot)
      await refreshQueue()
      return { interactionId }
    }, '草稿已生成。').finally(() => {
      submitting = false
      submitButton.disabled = false
    })
  })
  panel.append(form)
  section.append(panel)
  return section
}

async function run(action, successMessage) {
  try {
    const result = await action()
    if (successMessage) {
      status.dataset.tone = 'success'
      status.textContent = successMessage
    }
    return result
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`
    throw error
  }
}

async function load() {
  const { status: runtimeStatus, error } = await loadRuntimeStatus()
  renderRuntimeStatus(status, runtimeStatus, error)
  const layout = element('div', undefined, 'layout')
  const left = element('div')
  left.append(renderForm(), renderDraftContainer(), liveArea())
  layout.append(left)
  main.append(layout)
}

void load().catch((error) => {
  status.dataset.tone = 'danger'
  status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
})
