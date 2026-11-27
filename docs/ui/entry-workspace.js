import { bindDrawerLightDismiss, element, openTechnicalDetail } from './runtime-shell.js'
import { encodeProductLocation } from './product-location.js'
import { createProjectRosterReader, mountMemberRoster } from './member-roster.js'
import { effectiveWorkspaceName, mountWorkspaceManagementPanel } from './workspace-management.js'

export function entryConversationScope(search) {
  const params = new URLSearchParams(search)
  const kind = params.get('scope')
  const projectKey = params.get('projectKey')?.trim()
  if (params.getAll('scope').length > 1 || params.getAll('projectKey').length > 1) return null
  if ((kind === null || kind === 'system' || kind === 'alex') && projectKey === undefined) return { kind: 'alex' }
  if ((kind === null || kind === 'project') && projectKey) return { kind: 'project', projectKey }
  return null
}

// Navigation selects a scope; only the server projection proves its identity.
export function entryWorkspaceSelection(search, projection) {
  const params = new URLSearchParams(search)
  const requested = entryConversationScope(search)
  if (!requested) return { available: false, label: '会话不可用', reason: '会话范围不明确，请重新选择 Alex 或项目。' }
  const identified = projection?.surface === 'main-topic' && Boolean(projection.agentId)
    && Boolean(projection.canonicalAddress)
  if (requested.kind === 'alex') {
    const available = identified && projection.scope?.kind === 'alex' && projection.role === 'ceo'
      && projection.agentName === 'Alex' && projection.projectKey === undefined && projection.workspaceCwd === undefined
    return { available: Boolean(available), label: 'Alex · CEO', reason: 'Alex 会话暂不可用。当前服务尚未返回可确认的 Alex 会话，请稍后重试。' }
  }
  const available = identified && projection.scope?.kind === 'project'
    && projection.scope.projectKey === requested.projectKey && projection.projectKey === requested.projectKey
    && projection.role === 'project-lead' && projection.agentName === 'Jenny'
    && (!params.has('mode') || params.get('mode') === projection.mode)
  return { available: Boolean(available), label: available ? `${projection.projectName || '所选项目'} · ${projection.agentName}` : '所选项目',
    reason: '当前服务未提供所选项目的主会话入口。请从项目栏返回当前服务项目。' }
}

export function entryProjectHref(page, projectKey, mode) {
  const query = new URLSearchParams({ projectKey })
  if (page === '' || page === 'index.html') query.set('scope', 'project')
  // Task List's project route accepts projectKey alone; mode belongs to its
  // exact task deep link. Memory and dashboard accept the project/mode pair.
  if (page !== 'tasks.html' && (mode === 'rcc' || mode === 'fake')) query.set('mode', mode)
  return `./${page}?${query}`
}

export function entryProjectRows({ systemRead, current, search }) {
  const rows = [...(systemRead?.projects ?? [])]
  if (!current || rows.some((row) => row.scope?.projectKey === current.projectKey)) return rows
  const params = new URLSearchParams(search)
  const explicitCurrent = params.get('scope') !== 'system'
    && params.get('projectKey') === current.projectKey
    && (!params.has('mode') || params.get('mode') === current.mode)
  if (explicitCurrent) {
    rows.push({ scope: { projectKey: current.projectKey }, label: current.projectName })
  }
  return rows
}

// Only declared workspace data is a source. A project key is not a path.
function workspaceName(workspace) {
  if (!workspace) return ''
  return workspace.split('/').filter(Boolean).at(-1) || ''
}

export function workspaceFolderName(workspace, managedName) {
  const configured = typeof managedName === 'string' ? managedName.trim() : ''
  return configured || workspaceName(workspace) || '未关联工作区'
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
  bindDrawerLightDismiss(mobileRail)
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
  const alexState = element('p', '选择后读取会话', 'entry-read-state')
  const alexSection = element('section', undefined, 'entry-alex')
  alexSection.setAttribute('aria-labelledby', 'entry-alex-title')
  const alexTitle = element('h2', '独立入口', 'entry-kicker')
  alexTitle.id = 'entry-alex-title'
  alexSection.append(alexTitle, ceo, alexState)
  const projects = element('div', undefined, 'entry-projects')
  projects.append(element('p', '正在读取项目…', 'muted entry-read-state'))
  const projectHead = element('div', undefined, 'entry-project-head')
  const newProject = element('button', '＋ 新建', 'button entry-tool')
  newProject.dataset.entryDialog = 'new-project'
  newProject.type = 'button'
  newProject.addEventListener('click', () => management(newProject))
  const manageNames = element('button', '批量编辑', 'button entry-tool')
  manageNames.dataset.entryDialog = 'workspace-names'
  manageNames.type = 'button'
  manageNames.addEventListener('click', () => management(manageNames))
  projectHead.append(element('h2', '工作区', 'entry-kicker'), manageNames, newProject)
  rail.append(closeRail, brand, alexSection, projectHead, projects)
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
    const workspace = project ? (current?.projectKey === project.scope?.projectKey ? current.workspaceCwd : project.workspaceCwd) : undefined
    const projectLabel = project ? project.label || current?.projectName || project.scope.projectKey : '当前可读取的工作区'
    content.append(element('p', project ? `项目：${projectLabel}` : projectLabel))
    if (project) {
      const key = project.scope?.projectKey
      if (workspace) content.append(element('h3', '工作区路径'), element('p', workspace, 'entry-workspace-path'))
      if (current?.projectKey !== key) content.append(element('p', `projectKey：${key}`, 'muted'))
      if (rosterIssues.get(key)) content.append(element('p', rosterIssues.get(key), 'muted'))
    }
    content.append(element('p', '选择一条或多条真实登记，分别填写工作区名称后一次提交。失败项保留下方原因。'))
    mountWorkspaceManagementPanel({
      host: content,
      api,
      projectKey: project?.scope?.projectKey,
      workspaceCwd: project ? (current?.projectKey === project.scope?.projectKey ? current.workspaceCwd : project.workspaceCwd) : undefined,
      trigger,
      onSaved: async (payload) => {
        for (const workspace of payload.workspaces ?? []) managedNames.set(workspace.workspaceCwd, effectiveWorkspaceName(workspace))
        if (current) update(current)
        renderProjects()
      },
    })
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
  topicSelect.addEventListener('click', () => unavailable('Topic', '当前公开入口提供主会话；尚未提供其他 Topic 列表与切换能力。', topicSelect))
  const newTopic = element('button', '＋ 旁支 Topic', 'button entry-tool')
  newTopic.dataset.entryDialog = 'new-topic'
  newTopic.type = 'button'
  newTopic.addEventListener('click', () => unavailable('旁支 Topic', '旁支 Topic 创建尚未接入。当前消息仍属于所选主会话。', newTopic))
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
  const workspaceGroups = new Map()
  const managedNames = new Map()
  let workspaceNamesRead
  let renderedProjects = ''
  const detailState = (label, message) => {
    const node = element('button', label, 'entry-person entry-unavailable')
    node.dataset.entryDialog = label
    node.type = 'button'
    node.addEventListener('click', () => unavailable(label, message, node))
    return node
  }
  const focusCurrentConversation = () => {
    const chat = root.querySelector('.main-topic-host')
    const input = root.querySelector('#entry-form textarea, textarea[name="rawInput"]')
    chat?.scrollIntoView?.({ block: 'start' })
    if (input?.focus) input.focus({ preventScroll: true })
    else if (chat) {
      chat.setAttribute('tabindex', '-1')
      chat.focus?.({ preventScroll: true })
    }
  }
  ceo.addEventListener('click', (event) => {
    if (ceo.getAttribute('aria-current') !== 'page') return
    event.preventDefault()
    if (mobileRail.open) mobileRail.close()
    focusCurrentConversation()
  })
  function renderProjects() {
    if (!systemRead && !current && !projectReadError) return
    const rows = entryProjectRows({ systemRead, current, search })
    if (current) {
      const currentRow = rows.find((row) => row.scope?.projectKey === current.projectKey)
      title.textContent = `${currentRow?.label || current.projectName} · ${current.agentName}`
      title.title = title.textContent
    }
    const signature = JSON.stringify([rows.map(row => [row.scope?.projectKey, row.label, row.workspaceCwd,
      managedNames.get(row.scope?.projectKey === current?.projectKey ? current.workspaceCwd : row.workspaceCwd)]), current?.projectKey,
      current?.projectName, current?.agentName, current?.workspaceCwd, current?.mode, Boolean(projectReadError)])
    if (signature === renderedProjects) return
    renderedProjects = signature
    projects.querySelector('.entry-read-state')?.remove()
    const present = new Set()
    const presentWorkspaces = new Set()
    const positions = new Map()
    for (const { folder } of workspaceGroups.values()) {
      folder.classList.remove('entry-workspace-current')
      folder.querySelector(':scope > summary')?.removeAttribute('aria-current')
    }
    for (const project of rows) {
      const key = project.scope?.projectKey
      if (!key || present.has(key)) continue
      present.add(key)
      const isCurrent = current?.projectKey === key
      const mode = isCurrent ? current.mode : undefined
      const workspace = isCurrent ? current.workspaceCwd : project.workspaceCwd
      const workspaceKey = workspace || ''
      const workspaceLabel = workspaceFolderName(workspace, managedNames.get(workspaceKey))
      const label = project.label || (isCurrent ? current.projectName : '') || '项目'
      if (!workspaceGroups.has(workspaceKey)) {
        const folder = element('details', undefined, 'entry-workspace-folder')
        folder.open = saved().workspaces?.[workspaceKey] ?? true
        let wasOpen = folder.open
        folder.addEventListener('toggle', () => {
          if (wasOpen === folder.open) return
          wasOpen = folder.open
          remember({ workspaces: { ...saved().workspaces, [workspaceKey]: folder.open } })
        })
        const name = element('summary', workspaceLabel, 'entry-project-name')
        const directory = element('div', undefined, 'entry-workspace-projects')
        folder.append(name, directory)
        workspaceGroups.set(workspaceKey, { folder, directory, name, label: workspaceLabel })
      }
      const workspaceGroup = workspaceGroups.get(workspaceKey)
      const { folder, directory: workspaceProjects } = workspaceGroup
      if (workspaceGroup.label !== workspaceLabel) {
        workspaceGroup.name.textContent = workspaceLabel
        workspaceGroup.label = workspaceLabel
      }
      if (!presentWorkspaces.has(workspaceKey)) {
        const position = projects.children[presentWorkspaces.size]
        if (position !== folder) projects.insertBefore(folder, position ?? null)
        presentWorkspaces.add(workspaceKey)
      }
      if (isCurrent) {
        folder.classList.add('entry-workspace-current')
        folder.querySelector(':scope > summary')?.setAttribute('aria-current', 'page')
      }
      const index = positions.get(workspaceKey) ?? 0
      positions.set(workspaceKey, index + 1)
      const groupSignature = JSON.stringify([label, isCurrent, mode, workspace, isCurrent ? current.agentName : undefined])
      const previous = projectGroups.get(key)
      if (previous?.signature === groupSignature) {
        const position = workspaceProjects.children[index]
        if (position !== previous.group) workspaceProjects.insertBefore(previous.group, position ?? null)
        continue
      }
      previous?.group.remove()
      const group = element('details', undefined, 'entry-project')
      group.dataset.projectKey = key
      if (isCurrent) {
        group.classList.add('entry-project-current')
      }
      group.open = saved().folders?.[key] ?? isCurrent
      let folderOpen = group.open
      group.addEventListener('toggle', () => {
        if (folderOpen === group.open) return
        folderOpen = group.open
        remember({ folders: { ...saved().folders, [key]: group.open } })
      })
      const summary = element('summary', undefined, 'entry-project-name')
      if (isCurrent) summary.setAttribute('aria-current', 'page')
      summary.append(element('span', label))
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
        const memberLabel = isCurrent ? current.projectName : project.label || '项目'
        members.append(mountMemberRoster({ projectKey: key, projectLabel: memberLabel, reader: rosterReader,
          mainTopic: isCurrent ? { projectKey: key, agentName: current.agentName,
            agentId: current.agentId, href: window.location.href, current: true } : null,
          onCurrentActivate: () => {
            if (mobileRail.open) mobileRail.close()
            focusCurrentConversation()
          },
          onReadIssue: (issue) => {
            if (issue) rosterIssues.set(key, issue)
            else rosterIssues.delete(key)
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
      projectGroups.set(key, { group, signature: groupSignature })
      workspaceProjects.insertBefore(group, workspaceProjects.children[index] ?? null)
    }
    for (const [key, entry] of workspaceGroups) {
      if (!presentWorkspaces.has(key)) {
        entry.folder.remove()
        workspaceGroups.delete(key)
      }
    }
    for (const [key, entry] of projectGroups) {
      if (!present.has(key)) {
        entry.group.remove()
        projectGroups.delete(key)
      }
    }
    if (!projects.children.length) {
      projects.append(element('p', projectReadError ? '项目暂不可读，请检查连接状态。' : '暂无可读取的项目', 'entry-read-state'))
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
  function refreshWorkspaceNames() {
    if (disposed || workspaceNamesRead) return workspaceNamesRead
    workspaceNamesRead = api.readWorkspaceManagement().then((payload) => {
      if (disposed) return
      for (const workspace of payload.workspaces ?? []) {
        managedNames.set(workspace.workspaceCwd, effectiveWorkspaceName(workspace))
      }
      if (current) update(current)
      renderProjects()
    }, () => {}).finally(() => {
      workspaceNamesRead = undefined
    })
    return workspaceNamesRead
  }
  function update(projection) {
    const selection = entryWorkspaceSelection(search, projection)
    current = selection.available && projection.scope.kind === 'project' ? projection : null
    const alexSelected = entryConversationScope(search)?.kind === 'alex'
    alexState.textContent = alexSelected
      ? (selection.available ? '当前会话' : '会话暂不可用')
      : '选择后读取会话'
    if (alexSelected && selection.available) ceo.setAttribute('aria-current', 'page')
    else ceo.removeAttribute('aria-current')
    topic.hidden = !selection.available
    for (const button of tools.children) {
      if (button !== tools.lastElementChild) button.hidden = !selection.available
    }
    title.textContent = selection.label
    title.title = title.textContent
    renderProjects()
    if (restoreDialog) {
      const trigger = root.querySelector(`[data-entry-dialog="${CSS.escape(restoreDialog)}"]`)
      if (trigger) { restoreDialog = null; trigger.click() }
    }
    return selection
  }
  title.textContent = entryWorkspaceSelection(search, null).label
  window.addEventListener('focus', refreshProjects)
  window.addEventListener('focus', refreshWorkspaceNames)
  void refreshProjects()
  void refreshWorkspaceNames()
  return { update, dispose() {
    disposed = true
    clearTimeout(projectRefreshTimer)
    window.removeEventListener('focus', refreshProjects)
    window.removeEventListener('focus', refreshWorkspaceNames)
  } }
}
