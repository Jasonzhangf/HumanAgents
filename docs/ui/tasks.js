import {
  api,
  createScopedReadPublication,
  element,
  loadRuntimeStatus,
  mountPageTemplate,
  projectReadScopeFromQuery,
  renderPageError,
  renderProjectRead,
  renderRuntimeStatus,
  renderSystemRead,
  systemTasksHref,
} from './runtime-shell.js'

const readScope = projectReadScopeFromQuery()
const projectView = readScope.kind === 'project'

function projectBreadcrumbs(label) {
  return [
    { label: '系统', href: './dashboard.html' },
    { label: '项目', href: systemTasksHref() },
    { label, href: null },
  ]
}

const template = mountPageTemplate(document.getElementById('page-root'), {
  layout: 'collection',
  active: 'Task List',
  eyebrow: '',
  title: projectView ? '项目任务' : '全部项目',
  lede: projectView
    ? '这里列出这个项目本次读取返回的任务，并标明读取是否完整。'
    : '这里列出系统本次读取返回的项目，并标明读取范围是否已确认。',
  scope: readScope,
  breadcrumbs: projectView
    ? projectBreadcrumbs('当前项目')
    : [
        { label: '系统', href: './dashboard.html' },
        { label: '全部项目', href: null },
      ],
})

const { primary, status } = template.hosts
const { setBreadcrumbs } = template

const listRegion = element('div', undefined, 'task-lists')
const refreshButton = element('button', '刷新当前范围', 'button button--quiet')
refreshButton.type = 'button'
refreshButton.dataset.taskListRefresh = ''
refreshButton.addEventListener('click', () => void load())
primary.append(refreshButton, listRegion)

const readPublication = createScopedReadPublication((scope) => (
  scope.kind === 'project'
    ? api.projectDashboard({ projectKey: scope.projectKey })
    : api.systemDashboard()
))

function renderReadState(state) {
  if (!state.content) {
    renderPageError(status, state.failure || {
      message: 'scoped read failed',
      ownerId: 'humanagent.ui',
      nextAction: 'retry the same scoped read',
    })
    return
  }
  listRegion.replaceChildren()
  if (state.content.scope?.kind === 'project') {
    listRegion.append(renderProjectRead(state.content, { includeProjectLink: false }))
  } else {
    listRegion.append(renderSystemRead(state.content, { includeTasks: false }))
  }
  if (state.stale) {
    renderPageError(status, state.failure)
    status.dataset.tone = 'warning'
    status.append(element('span', ' · 上次读取失败，当前显示上次确认内容（stale）'))
  }
}

function applyProjectBreadcrumb(state) {
  if (!projectView) return
  const content = state?.content
  const label = content?.scope?.kind === 'project'
    && content.scope.projectKey === readScope.projectKey
    && typeof content.label === 'string'
    && content.label.trim() !== ''
    ? content.label
    : '当前项目'
  setBreadcrumbs(projectBreadcrumbs(label))
}

async function load() {
  try {
    const [read, runtime] = await Promise.all([
      readPublication.refresh(readScope),
      loadRuntimeStatus(),
    ])
    if (!read.published) return
    renderRuntimeStatus(status, runtime.status, runtime.error)
    renderReadState(read.state)
    applyProjectBreadcrumb(read.state)
  } catch (error) {
    renderPageError(status, error)
  }
}

window.addEventListener('pagehide', () => template.dispose(), { once: true })

void load()
