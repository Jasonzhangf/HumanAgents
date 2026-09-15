import {
  api,
  element,
  formatTime,
  loadRuntimeStatus,
  makePageShell,
  renderRuntimeStatus,
  taskDashboardHref,
  taskDetailHref,
} from './runtime-shell.js'

const { main, status } = makePageShell(
  'Dashboard',
  'Runtime',
  '工作总览',
  '只展示当前运行、等待决策和最近结果；所有数据来自 HumanAgent Runtime API。',
)

function taskSection(title, rows, emptyText) {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', title), element('span', `${rows.length} 项`, 'section-meta'))
  const panel = element('div', undefined, 'panel')
  if (rows.length === 0) {
    panel.append(element('p', emptyText, 'empty'))
  } else {
    for (const row of rows) {
      const link = element('a', undefined, 'item')
      link.href = taskDashboardHref(row.taskId.value)
      link.append(element('h3', row.title), element('p', `${row.currentState} · 下一步：${row.nextStep}`))
      const meta = element('div', undefined, 'item-meta')
      meta.append(element('span', row.stateLabel), element('time', formatTime(row.updatedAt)))
      link.append(meta)
      panel.append(link)
    }
  }
  section.append(head, panel)
  return section
}

function recentSection(title, rows, map) {
  const section = element('section', undefined, 'section')
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', title), element('span', `${rows.length} 项`, 'section-meta'))
  const panel = element('div', undefined, 'panel')
  if (rows.length === 0) {
    panel.append(element('p', '暂无记录。', 'empty'))
  } else {
    for (const source of rows) {
      const item = map(source)
      const wrapper = item.href ? element('a', undefined, 'item') : element('div', undefined, 'item')
      if (item.href) wrapper.href = item.href
      wrapper.append(element('h3', item.title), element('p', item.body))
      wrapper.append(element('div', item.meta, 'item-meta'))
      panel.append(wrapper)
    }
  }
  section.append(head, panel)
  return section
}

async function render() {
  try {
    const [{ status: runtimeStatus, error }, dashboard, tasks] = await Promise.all([
      loadRuntimeStatus(),
      api.dashboard(),
      api.listTasks(),
    ])
    renderRuntimeStatus(status, runtimeStatus, error)

    const stats = element('section', undefined, 'stats')
    for (const [label, value] of [
      ['运行中任务', dashboard.hasRunning ? '是' : '否'],
      ['任务数量', String(dashboard.taskCount)],
      ['等待决策', String(dashboard.waitingDecisionCount)],
    ]) {
      const card = element('article', undefined, 'stat')
      card.append(element('span', label), element('strong', value))
      stats.append(card)
    }

    const layout = element('div', undefined, 'layout')
    const left = element('div')
    const right = element('div')
    left.append(
      taskSection('运行中任务', tasks.running, '当前没有运行中的任务。'),
      taskSection('等待决策', tasks.waiting, '当前没有等待用户决策的任务。'),
      recentSection('最近用户输入', dashboard.recentInputs, (item) => ({
        title: item.taskTitle || '用户输入',
        body: item.text,
        meta: formatTime(item.receivedAt),
      })),
      recentSection('最近任务输出', dashboard.recentOutputs, (item) => ({
        title: item.taskTitle,
        body: item.text,
        meta: formatTime(item.occurredAt),
        href: taskDashboardHref(item.taskId.value),
      })),
    )
    right.append(
      recentSection('最近失败', dashboard.recentFailures, (item) => ({
        title: item.taskTitle,
        body: `${item.message} · owner=${item.ownerId} · next=${item.nextAction}`,
        meta: formatTime(item.occurredAt),
        href: taskDetailHref(item.taskId.value),
      })),
      recentSection('最近完成', tasks.completed, (item) => ({
        title: item.title,
        body: `${item.currentState} · ${item.nextStep}`,
        meta: formatTime(item.updatedAt),
        href: taskDashboardHref(item.taskId.value),
      })),
    )
    layout.append(left, right)
    main.append(stats, layout)
  } catch (error) {
    status.dataset.tone = 'danger'
    status.textContent = `${error.message} · owner=${error.ownerId || 'unknown'} · next=${error.nextAction || 'check runtime'}`
  }
}

void render()
