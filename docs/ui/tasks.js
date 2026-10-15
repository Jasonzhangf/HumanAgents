import {
  api,
  createScopedReadPublication,
  element,
  loadRuntimeStatus,
  makePageShell,
  projectReadScopeFromQuery,
  renderPageError,
  renderProjectRead,
  renderRuntimeStatus,
  renderSystemRead,
  systemTasksHref,
} from './runtime-shell.js'

const readScope = projectReadScopeFromQuery()
const projectView = readScope.kind === 'project'
const { main, status } = makePageShell(
  'Task List',
  '',
  projectView ? '项目任务' : '全部项目',
  projectView
    ? '这里列出这个项目本次读取返回的任务，并标明读取是否完整。'
    : '这里列出系统本次读取返回的项目，并标明读取范围是否已确认。',
  {
    scope: readScope,
    breadcrumbs: projectView
      ? [
          { label: '系统', href: './dashboard.html' },
          { label: '项目', href: systemTasksHref() },
          { label: readScope.projectKey, href: null },
        ]
      : [
          { label: '系统', href: './dashboard.html' },
          { label: '全部项目', href: null },
        ],
  },
)

const listRegion = element('div', undefined, 'task-lists')
const refreshButton = element('button', '刷新当前范围', 'button button--quiet')
refreshButton.type = 'button'
refreshButton.addEventListener('click', () => void load())
main.append(refreshButton, listRegion)

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

async function load() {
  try {
    const [read, runtime] = await Promise.all([
      readPublication.refresh(readScope),
      loadRuntimeStatus(),
    ])
    if (!read.published) return
    renderRuntimeStatus(status, runtime.status, runtime.error)
    renderReadState(read.state)
  } catch (error) {
    renderPageError(status, error)
  }
}

void load()
