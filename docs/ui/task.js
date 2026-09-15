import {
  api,
  clearNode,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  observationHref,
  renderRuntimeStatus,
  stateTone,
  taskDashboardHref,
  taskIdFromQuery,
} from './runtime-shell.js'

const requestedTask = taskIdFromQuery(false)
const isNew = requestedTask === 'new' || !requestedTask
const { main, status } = makePageShell(
  'Task List',
  'Task',
  isNew ? '新建任务' : '任务详情',
  '创建或选择 Task，然后进入真实 Runtime 执行。',
)

let taskId = requestedTask
let detail

function renderCreate() {
  const panel = element('section', undefined, 'panel')
  const form = element('form', undefined, 'form-grid')
  const titleLabel = element('label', '任务标题')
  const title = element('input')
  title.required = true
  title.placeholder = '例如：验证 Provider 执行'
  titleLabel.append(title)
  const directiveLabel = element('label', '任务目标')
  const directive = element('textarea')
  directive.placeholder = '说明这次任务要验证或完成什么'
  directiveLabel.append(directive)
  const button = element('button', '创建 Task', 'button button--primary')
  button.type = 'submit'
  const feedback = element('p', '创建后进入 Task Dashboard 发起 fake 或 rcc 执行。', 'muted')
  feedback.setAttribute('role', 'status')
  feedback.setAttribute('aria-live', 'polite')
  form.append(titleLabel, directiveLabel, button, feedback)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      feedback.textContent = '正在创建 Task…'
      const created = await api.createTask({ title: title.value.trim(), directive: directive.value.trim() })
      taskId = created.taskId.value
      window.location.href = taskDashboardHref(taskId)
    } catch (error) {
      feedback.textContent = `${error.message} · owner=${error.ownerId} · next=${error.nextAction}`
    }
  })
  panel.append(form)
  main.append(panel)
}

function renderTask() {
  clearNode(main)
  const heading = element('section', undefined, 'page-heading')
  const copy = element('div')
  copy.append(element('p', 'Task Detail', 'eyebrow'), element('h1', detail.taskTitle))
  const chip = element('span', detail.stateLabel, 'state-chip')
  chip.dataset.tone = stateTone(detail.state)
  copy.append(chip)
  heading.append(copy)
  main.append(heading)

  const facts = element('dl', undefined, 'detail-grid')
  for (const [label, value] of [
    ['当前状态', detail.currentState],
    ['输入', detail.priorInput || '尚未输入'],
    ['输出', detail.output?.summary || '尚无输出'],
    ['最近下一步', detail.nextAction],
    ['建议', detail.proposal],
    ['最近更新', detail.data.updatedAt ? formatTime(detail.data.updatedAt) : '尚未更新'],
  ]) {
    const cell = element('div', undefined, 'detail-cell')
    cell.append(element('dt', label), element('dd', value))
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
  detail = await api.taskDetail(taskId)
  renderTask()
}

void load().catch((error) => {
  status.dataset.tone = 'danger'
  status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
})
