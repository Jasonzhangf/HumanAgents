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
const selectedTaskIds = new Set()

function selectedRows() {
  return rows.filter((row) => selectedTaskIds.has(row.taskId.value))
}

function renderBulkActions() {
  main.querySelector('[data-bulk-actions]')?.remove()
  const bar = element('section', undefined, 'bulk-actions')
  bar.dataset.bulkActions = ''
  const label = element('span', `${selectedTaskIds.size} 项已选择`, 'section-meta')
  const stop = element('button', '停止选中', 'button')
  stop.type = 'button'
  stop.disabled = selectedTaskIds.size === 0
  stop.addEventListener('click', async () => {
    await runBulkAction('stop')
  })
  const remove = element('button', '删除选中', 'button button--danger')
  remove.type = 'button'
  remove.disabled = selectedTaskIds.size === 0
  remove.addEventListener('click', async () => {
    if (!window.confirm('删除选中的任务？运行中的任务不会被删除。')) return
    await runBulkAction('delete')
  })
  const clear = element('button', '清除选择', 'button button--quiet')
  clear.type = 'button'
  clear.disabled = selectedTaskIds.size === 0
  clear.addEventListener('click', () => {
    selectedTaskIds.clear()
    renderBulkActions()
    renderTasks()
  })
  bar.append(label, stop, remove, clear)
  main.append(bar)
}

async function runBulkAction(action) {
  const ids = selectedRows().map((row) => row.taskId.value)
  if (ids.length === 0) return
  try {
    const result = await api.bulkTaskAction(ids, action)
    const failed = result.results.filter((item) => item.state === 'failed')
    const succeeded = result.results.length - failed.length
    status.textContent = failed.length === 0
      ? `${succeeded} 项已${action === 'delete' ? '删除' : '停止'}。`
      : `${succeeded} 项已处理，${failed.length} 项未处理：${failed[0].error.message}`
    selectedTaskIds.clear()
    await loadTasks()
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'inspect the task action'}`
  }
}

async function editTask(row) {
  try {
    const detail = await api.taskDetail(row.taskId.value)
    const dialog = element('dialog', undefined, 'task-editor')
    const form = element('form', undefined, 'form-grid')
    form.method = 'dialog'
    const titleLabel = element('label', '任务名称')
    const title = element('input')
    title.value = detail.title
    title.required = true
    titleLabel.append(title)
    const actions = element('div', undefined, 'actions')
    const cancel = element('button', '取消', 'button button--quiet')
    cancel.type = 'button'
    cancel.addEventListener('click', () => dialog.close())
    const save = element('button', '保存修改', 'button button--primary')
    save.type = 'submit'
    actions.append(cancel, save)
    form.append(titleLabel, actions)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      save.disabled = true
      try {
        await api.updateTask(row.taskId.value, { title: title.value.trim() })
        dialog.close()
        await loadTasks()
      } catch (error) {
        save.disabled = false
        status.dataset.tone = 'danger'
        status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'inspect the task update'}`
      }
    })
    dialog.append(form)
    document.body.append(dialog)
    dialog.addEventListener('close', () => dialog.remove(), { once: true })
    dialog.showModal()
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'inspect the task'}`
  }
}

async function deleteTask(row) {
  if (!window.confirm(`删除任务“${row.title}”？`)) return
  try {
    await api.deleteTask(row.taskId.value)
    selectedTaskIds.delete(row.taskId.value)
    await loadTasks()
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'inspect the task deletion'}`
  }
}

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
        const item = element('article', undefined, 'task-row')
        const checkbox = element('input')
        checkbox.type = 'checkbox'
        checkbox.checked = selectedTaskIds.has(row.taskId.value)
        checkbox.setAttribute('aria-label', `选择任务 ${row.title}`)
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedTaskIds.add(row.taskId.value)
          else selectedTaskIds.delete(row.taskId.value)
          renderBulkActions()
        })
        const link = element('a', undefined, 'task-row-link')
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
        const actions = element('div', undefined, 'task-row-actions')
        const edit = element('button', '编辑', 'button button--quiet')
        edit.type = 'button'
        edit.addEventListener('click', () => void editTask(row))
        const remove = element('button', '删除', 'button button--quiet')
        remove.type = 'button'
        remove.addEventListener('click', () => void deleteTask(row))
        actions.append(edit, remove)
        item.append(checkbox, link, actions)
        panel.append(item)
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
      renderBulkActions()
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
    for (const taskId of selectedTaskIds) {
      if (!rows.some((row) => row.taskId.value === taskId)) selectedTaskIds.delete(taskId)
    }
    renderTasks()
    renderBulkActions()
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
  }
}

async function loadTasks() {
  const taskList = await api.listTasks()
  rows = [
    ...taskList.running.map((row) => ({ ...row, group: 'running' })),
    ...taskList.waiting.map((row) => ({ ...row, group: 'waiting' })),
    ...taskList.completed.map((row) => ({ ...row, group: 'completed' })),
    ...taskList.stopped.map((row) => ({ ...row, group: 'stopped' })),
    ...taskList.draft.map((row) => ({ ...row, group: 'draft' })),
    ...taskList.failed.map((row) => ({ ...row, group: 'failed' })),
  ]
  for (const taskId of selectedTaskIds) {
    if (!rows.some((row) => row.taskId.value === taskId)) selectedTaskIds.delete(taskId)
  }
  renderTasks()
  renderBulkActions()
}

addFilters()
void load()
