import { element, openTechnicalDetail } from './runtime-shell.js'
import { encodeProductLocation } from './product-location.js'
import { createProjectRosterReader, mountMemberRoster } from './member-roster.js'

// The public main-topic is serve-bound. Never relabel it as Alex or another project.
export function entryWorkspaceSelection(search, projection) {
  const params = new URLSearchParams(search)
  if (params.get('scope') === 'system') return { available: false, label: 'Alex · CEO', reason: '全局 Alex 会话尚未提供公开入口。' }
  if ((params.has('projectKey') && params.get('projectKey') !== projection?.projectKey)
    || (params.has('mode') && params.get('mode') !== projection?.mode)) {
    return { available: false, label: '所选项目', reason: '当前服务未提供所选项目的主会话入口。请从项目栏返回当前服务项目。' }
  }
  return { available: Boolean(projection), label: projection ? `${projection.projectName} · ${projection.agentName}` : '项目会话', reason: '项目会话尚未读取。' }
}

export function entryProjectHref(page, projectKey, mode) {
  const query = new URLSearchParams({ projectKey })
  // Task List's project route accepts projectKey alone; mode belongs to its
  // exact task deep link. Memory and dashboard accept the project/mode pair.
  if (page !== 'tasks.html' && (mode === 'rcc' || mode === 'fake')) query.set('mode', mode)
  return `./${page}?${query}`
}

// Only declared workspace data is a source. A project key is not a path.
export function entryWorkspaceHint(workspace) {
  if (!workspace) return ''
  const parts = workspace.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

export function mountEntryWorkspace({ root, template, api, search = window.location.search }) {
  const rosterReader = createProjectRosterReader(api)
  const rosterIssues = new Map()
  root.classList.add('entry-workspace')
  root.querySelector(':scope > .topbar')?.remove()
  const rail = element('nav', undefined, 'entry-rail')
  rail.setAttribute('aria-label', '项目与成员')
  const mobileRail = element('dialog', undefined, 'entry-rail-dialog')
  mobileRail.setAttribute('aria-label', '项目导航')
  const closeRail = element('button', '关闭菜单', 'button entry-menu-close')
  closeRail.type = 'button'
  closeRail.addEventListener('click', () => mobileRail.close())
  const saved = () => window.history.state?.entryWorkspace ?? {}
  const remember = (patch) => window.history.replaceState({ ...window.history.state,
    entryWorkspace: { ...saved(), ...patch } }, '', window.location.href)
  const brand = element('div', undefined, 'entry-brand')
  brand.append(element('span', 'H', 'entry-mark'), element('span', 'HumanAgent'))
  const ceo = element('a', 'Alex · CEO', 'entry-person entry-ceo')
  ceo.href = './?scope=system'
  if (new URLSearchParams(search).get('scope') === 'system') ceo.setAttribute('aria-current', 'page')
  const projects = element('div', undefined, 'entry-projects')
  projects.append(element('p', '正在读取项目…', 'muted entry-read-state'))
  const foot = element('div', undefined, 'entry-rail-foot')
  const scopeText = element('p', '当前范围正在读取', 'muted')
  foot.append(scopeText)
  const projectHead = element('div', undefined, 'entry-project-head')
  const newProject = element('button', '＋ 新建', 'button entry-tool')
  newProject.dataset.entryDialog = 'new-project'
  newProject.type = 'button'
  newProject.addEventListener('click', () => management(newProject))
  projectHead.append(element('h2', '项目', 'entry-kicker'), newProject)
  rail.append(closeRail, brand, ceo, projectHead, projects, foot)
  mobileRail.append(rail)
  const toolbar = element('header', undefined, 'entry-toolbar')
  const title = element('strong', '项目会话', 'entry-scope-title')
  const tools = element('div', undefined, 'entry-toolbar-tools')
  let restoreDialog = saved().dialog
  const openWorkspaceDetail = (config) => {
    remember({ dialog: config.trigger?.dataset.entryDialog ?? null })
    return openTechnicalDetail({ ...config, onClose: () => remember({ dialog: null }) })
  }
  const unavailable = (name, message, trigger) => openWorkspaceDetail({ title: name, eyebrow: name, content: element('p', message), trigger })
  function management(trigger, project) {
    const content = element('div', undefined, project ? 'entry-navigation member-roster-project-settings' : 'entry-navigation')
    content.append(element('p', project ? `项目：${project.label || current?.projectName || project.scope.projectKey}` : '当前可读取的项目'))
    if (!project) for (const row of systemRead?.projects ?? []) content.append(element('p', row.label || row.scope?.projectKey))
    if (project && current?.projectKey === project.scope?.projectKey) content.append(element('p', current.workspaceCwd))
    if (project) {
      const key = project.scope?.projectKey
      if (current?.projectKey !== key) content.append(element('p', `projectKey：${key}`, 'muted'))
      if (rosterIssues.get(key)) content.append(element('p', rosterIssues.get(key), 'muted'))
    }
    content.append(element('p', '当前公开接口支持读取项目；尚未提供新建、修改项目或管理成员的能力。'))
    openWorkspaceDetail({ title: project ? '项目设置' : '项目管理', content, trigger })
  }
  function button(label, action) {
    const node = element('button', label, 'button entry-tool')
    node.dataset.entryDialog = label
    node.type = 'button'
    node.addEventListener('click', () => action(node))
    tools.append(node)
    if (label === '任务板') node.dataset.entryBoardTrigger = 'true'
  }
  const menu = element('button', '☰', 'button entry-menu-toggle')
  menu.type = 'button'
  menu.setAttribute('aria-label', '打开项目菜单')
  menu.addEventListener('click', () => mobileRail.showModal())
  mobileRail.addEventListener('close', () => { remember({ menuOpen: false }); menu.focus() })
  const mobile = window.matchMedia('(max-width: 619px)')
  mobile.addEventListener('change', () => { if (!mobile.matches && mobileRail.open) mobileRail.close() })
  menu.addEventListener('click', () => remember({ menuOpen: true }))
  const topic = element('div', undefined, 'entry-topic-tools')
  const topicSelect = element('button', '主会话⌄', 'button entry-tool')
  topicSelect.dataset.entryDialog = 'topic'
  topicSelect.type = 'button'
  topicSelect.addEventListener('click', () => unavailable('Topic', '当前公开入口提供项目主会话；尚未提供其他 Topic 列表与切换能力。', topicSelect))
  const newTopic = element('button', '＋ 旁支 Topic', 'button entry-tool')
  newTopic.dataset.entryDialog = 'new-topic'
  newTopic.type = 'button'
  newTopic.addEventListener('click', () => unavailable('旁支 Topic', '旁支 Topic 创建尚未接入。当前消息仍属于项目主会话。', newTopic))
  topic.append(topicSelect, newTopic)
  button('任务板', (trigger) => {
    const queue = root.querySelector('[data-task-list-drawer-trigger]')
    if (queue) queue.dispatchEvent(new CustomEvent('entry-open-tasks', { detail: trigger }))
    else unavailable('当下任务', '任务列表尚未读取，请检查连接状态。', trigger)
  })
  button('定时任务', () => root.querySelector('[data-entry-schedule-trigger]')?.click())
  button('步骤详情', (trigger) => {
    const detail = root.querySelector('.mt-active .conversation-status-detail, .mt-turn .conversation-status-detail, .mt-history-round')
    if (detail) detail.click()
    else unavailable('步骤详情', '当前没有可展示的执行步骤。提交任务后可在此查看真实执行详情。', trigger)
  })
  button('···', (trigger) => {
    const content = element('div', undefined, 'entry-navigation')
    const connection = element('button', '连接状态', 'button')
    connection.type = 'button'
    connection.addEventListener('click', () => openTechnicalDetail({ title: '连接状态', content: template.hosts.status, trigger }))
    content.append(connection)
    for (const [page, label] of [['dashboard.html', '总览'], ['tasks.html', '任务板'], ['memory.html', '项目记忆']]) {
      const link = element('a', label, 'button')
      const params = new URLSearchParams(search)
      const key = params.get('scope') === 'system' ? null : params.get('projectKey') || current?.projectKey
      if (!key && page === 'memory.html') {
        const state = element('p', '项目记忆：请先选择可读取的项目。', 'muted')
        content.append(state)
        continue
      }
      link.href = key ? entryProjectHref(page, key, params.get('mode') || current?.mode)
        : page === 'tasks.html' ? './tasks.html?scope=system'
          : `./dashboard.html${encodeProductLocation({ board: 'interaction', lane: 'live', scope: { kind: 'system' } })}`
      content.append(link)
    }
    for (const [id, label] of [['scope', '工作范围'], ['view', '查看方式'], ['display', '显示设置'], ['input', '输入设置']]) {
      const control = element('button', label, 'button')
      control.type = 'button'
      control.addEventListener('click', () => {
        template.shell?.layer.addEventListener('close', () => trigger.focus(), { once: true })
        template.shell?.openShellSection(id)
      })
      content.append(control)
    }
    openWorkspaceDetail({ title: '导航与设置', content, trigger })
  })
  tools.lastElementChild.setAttribute('aria-label', '导航与设置')
  toolbar.append(menu, title, topic, tools)
  template.hosts.page.prepend(toolbar)
  root.prepend(mobileRail)
  if (mobile.matches && saved().menuOpen) mobileRail.showModal()
  let current = null
  let systemRead = null
  let disposed = false
  let projectRead
  let projectReadError
  let projectRefreshTimer
  const projectGroups = new Map()
  let renderedProjects = ''
  const detailState = (label, message) => {
    const node = element('button', label, 'entry-person entry-unavailable')
    node.dataset.entryDialog = label
    node.type = 'button'
    node.addEventListener('click', () => unavailable(label, message, node))
    return node
  }
  function updateWorkspaceHint(summary, workspace, duplicate) {
    const oldHint = summary.querySelector('.entry-project-workspace')
    if (!duplicate) {
      oldHint?.remove()
      summary.removeAttribute('title')
      return
    }
    const hint = entryWorkspaceHint(workspace) || '在项目设置中查看标识'
    if (oldHint) oldHint.textContent = hint
    else summary.append(element('small', hint, 'entry-project-workspace'))
    if (workspace) summary.title = workspace
  }
  function renderProjects() {
    if (!systemRead && !current && !projectReadError) return
    const rows = [...(systemRead?.projects ?? [])]
    if (current && !rows.some((row) => row.scope?.projectKey === current.projectKey)) {
      rows.push({ scope: { projectKey: current.projectKey }, label: current.projectName })
    }
    const signature = JSON.stringify([rows.map(row => [row.scope?.projectKey, row.label, row.workspaceCwd]), current?.projectKey,
      current?.projectName, current?.agentName, current?.workspaceCwd, current?.mode, Boolean(projectReadError)])
    if (signature === renderedProjects) return
    renderedProjects = signature
    projects.querySelector('.entry-read-state')?.remove()
    const present = new Set()
    let index = 0
    for (const project of rows) {
      const key = project.scope?.projectKey
      if (!key || present.has(key)) continue
      present.add(key)
      const isCurrent = current?.projectKey === key
      const mode = isCurrent ? current.mode : undefined
      const label = isCurrent ? current.projectName : project.label || '项目'
      const duplicate = rows.filter((row) => (row.label || (row.scope?.projectKey === current?.projectKey ? current.projectName : '项目')) === label).length > 1
      const workspace = isCurrent ? current.workspaceCwd : project.workspaceCwd
      const groupSignature = JSON.stringify([label, isCurrent, mode, workspace, isCurrent ? current.agentName : undefined])
      const previous = projectGroups.get(key)
      if (previous?.signature === groupSignature) {
        updateWorkspaceHint(previous.summary, workspace, duplicate)
        const position = projects.children[index++]
        if (position !== previous.group) projects.insertBefore(previous.group, position ?? null)
        continue
      }
      previous?.group.remove()
      const group = element('details', undefined, 'entry-project')
      group.dataset.projectKey = key
      group.open = saved().folders?.[key] ?? isCurrent
      let folderOpen = group.open
      group.addEventListener('toggle', () => {
        if (folderOpen === group.open) return
        folderOpen = group.open
        remember({ folders: { ...saved().folders, [key]: group.open } })
      })
      const summary = element('summary', undefined, 'entry-project-name')
      summary.append(element('span', label))
      updateWorkspaceHint(summary, workspace, duplicate)
      group.append(summary)
      const directory = element('div', undefined, 'entry-project-directory')
      const settings = element('button', '项目设置', 'entry-person')
      settings.dataset.entryDialog = `settings:${key}`
      settings.type = 'button'
      settings.addEventListener('click', () => management(settings, project))
      directory.append(settings)
      {
        const members = element('details', undefined, 'entry-members')
        members.open = saved().members?.[key] ?? true
        let membersOpen = members.open
        members.addEventListener('toggle', () => {
          if (membersOpen === members.open) return
          membersOpen = members.open
          remember({ members: { ...saved().members, [key]: members.open } })
        })
        members.append(element('summary', '成员'))
        members.append(mountMemberRoster({ projectKey: key, projectLabel: label, reader: rosterReader,
          mainTopic: isCurrent ? { projectKey: key, agentName: current.agentName,
            href: entryProjectHref('', key, mode), current: entryWorkspaceSelection(search, current).available } : null,
          onReadIssue: (issue) => {
            rosterIssues.set(key, issue)
            settings.title = issue ? '成员名册暂不可读，查看项目设置' : '项目设置'
          } }))
        directory.append(members)
      }
      if (isCurrent) {
        const memory = element('a', '项目记忆 Agent', 'entry-person')
        memory.href = entryProjectHref('memory.html', key, mode)
        directory.append(memory, detailState('Buglist ↗', '当前项目尚未提供公开的 Buglist 读取入口。'))
      }
      group.append(directory)
      projectGroups.set(key, { group, summary, signature: groupSignature })
      projects.insertBefore(group, projects.children[index++] ?? null)
    }
    for (const [key, entry] of projectGroups) {
      if (!present.has(key)) {
        entry.group.remove()
        projectGroups.delete(key)
      }
    }
    if (!projects.children.length) {
      projects.append(element('p', projectReadError ? '项目暂不可读，请检查连接状态。' : '暂无可读取的项目', 'entry-read-state'))
      if (projectReadError) scopeText.textContent = '项目范围读取失败'
    }
  }
  function refreshProjects() {
    if (disposed || projectRead) return projectRead
    clearTimeout(projectRefreshTimer)
    projectRead = api.systemDashboard().then(read => {
      if (disposed) return
      systemRead = read
      projectReadError = undefined
      renderProjects()
    }, error => {
      if (disposed) return
      projectReadError = error
      renderProjects()
    }).finally(() => {
      projectRead = undefined
      if (!disposed) projectRefreshTimer = setTimeout(refreshProjects, 5000)
    })
    return projectRead
  }
  function update(projection) {
    current = projection
    const selection = entryWorkspaceSelection(search, projection)
    title.textContent = projection ? `${projection.projectName}.${projection.agentName} · cwd ${projection.workspaceCwd}` : selection.label
    title.title = title.textContent
    scopeText.textContent = projection ? `当前服务项目：${projection.projectName}\n${projection.workspaceCwd}` : '项目范围尚未读取'
    renderProjects()
    if (restoreDialog) {
      const trigger = root.querySelector(`[data-entry-dialog="${CSS.escape(restoreDialog)}"]`)
      if (trigger) { restoreDialog = null; trigger.click() }
    }
    return selection
  }
  title.textContent = entryWorkspaceSelection(search, null).label
  window.addEventListener('focus', refreshProjects)
  void refreshProjects()
  return { update, dispose() {
    disposed = true
    clearTimeout(projectRefreshTimer)
    window.removeEventListener('focus', refreshProjects)
  } }
}
