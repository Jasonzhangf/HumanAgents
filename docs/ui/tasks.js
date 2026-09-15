import {
  api,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  renderRuntimeStatus,
  stateTone,
  taskDashboardHref,
  taskDetailHref,
} from './runtime-shell.js'

const { main, status } = makePageShell(
  'Task List',
  'Runtime',
  '任务列表',
  '运行中、等待决策、已完成和失败任务都来自 Runtime projection。',
)

let currentFilter = 'all'
let rows = []

function visibleGroups() {
  const filtered = rows.filter((row) => currentFilter === 'all' || row.group === currentFilter)
  return [
    ['running', '运行中任务', filtered.filter((row) => row.group === 'running'), '当前没有运行中的任务。'],
    ['waiting', '等待决策任务', filtered.filter((row) => row.group === 'waiting'), '当前没有等待决策的任务。'],
    ['completed', '已完成任务', filtered.filter((row) => row.group === 'completed'), '当前没有已完成的任务。'],
    ['stopped', '已停止任务', filtered.filter((row) => row.group === 'stopped'), '当前没有已停止的任务。'],
    ['draft', '未启动任务', filtered.filter((row) => row.group === 'draft'), '当前没有未启动的任务。'],
    ['failed', '失败任务', filtered.filter((row) => row.group === 'failed'), '当前没有失败的任务。'],
  ]
}

function renderTasks() {
  const groups = element('section', undefined, 'stack')
  for (const [, title, groupRows, emptyText] of visibleGroups()) {
    const section = element('section', undefined, 'section')
    const head = element('header', undefined, 'section-head')
    head.append(element('h2', title), element('span', `${groupRows.length} 项`, 'section-meta'))
    const panel = element('div', undefined, 'panel')
    if (groupRows.length === 0) {
      panel.append(element('p', emptyText, 'empty'))
    } else {
      for (const row of groupRows) {
        const link = element('a', undefined, 'task-row')
        link.href = row.state === 'waiting' || row.state === 'blocked'
          ? taskDetailHref(row.taskId.value)
          : taskDashboardHref(row.taskId.value)
        const copy = element('div')
        copy.append(element('h3', row.title), element('p', row.currentState))
        const next = element('div')
        const chip = element('span', row.stateLabel, 'state-chip')
        chip.dataset.tone = stateTone(row.state)
        next.append(chip, element('p', `下一步：${row.nextStep}`))
        link.append(copy, next, element('time', formatTime(row.updatedAt)))
        panel.append(link)
      }
    }
    section.append(head, panel)
    groups.append(section)
  }
  main.querySelector('[data-task-groups]')?.remove()
  groups.dataset.taskGroups = ''
  main.append(groups)
}

function addFilters() {
  const bar = element('section', undefined, 'filterbar')
  const segments = element('div', undefined, 'segments')
  for (const [value, label] of [
    ['all', '全部'],
    ['running', '运行中'],
    ['waiting', '等待决策'],
    ['completed', '已完成'],
    ['stopped', '已停止'],
    ['draft', '未启动'],
    ['failed', '失败'],
  ]) {
    const button = element('button', label, 'segment')
    button.type = 'button'
    button.setAttribute('aria-pressed', String(value === currentFilter))
    button.addEventListener('click', () => {
      currentFilter = value
      for (const candidate of segments.querySelectorAll('button')) {
        candidate.setAttribute('aria-pressed', String(candidate === button))
      }
      renderTasks()
    })
    segments.append(button)
  }
  bar.append(segments)
  main.append(bar)
}

async function load() {
  try {
    const [{ status: runtimeStatus, error }, taskList] = await Promise.all([loadRuntimeStatus(), api.listTasks()])
    renderRuntimeStatus(status, runtimeStatus, error)
    rows = [
      ...taskList.running.map((row) => ({ ...row, group: 'running' })),
      ...taskList.waiting.map((row) => ({ ...row, group: 'waiting' })),
      ...taskList.completed.map((row) => ({ ...row, group: 'completed' })),
      ...taskList.stopped.map((row) => ({ ...row, group: 'stopped' })),
      ...taskList.draft.map((row) => ({ ...row, group: 'draft' })),
      ...taskList.failed.map((row) => ({ ...row, group: 'failed' })),
    ]
    renderTasks()
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
  }
}

addFilters()
void load()
