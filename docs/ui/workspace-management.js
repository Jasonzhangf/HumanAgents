function fallbackWorkspaceName(workspaceCwd) {
  return typeof workspaceCwd === 'string'
    ? workspaceCwd.split('/').filter(Boolean).at(-1) || workspaceCwd
    : ''
}

export function effectiveWorkspaceName(workspace) {
  const configured = typeof workspace?.workspaceAlias === 'string' ? workspace.workspaceAlias.trim() : ''
  return configured || fallbackWorkspaceName(workspace?.workspaceCwd)
}

export function workspaceNameEdits({ workspaces, selected, names }) {
  if (!Array.isArray(workspaces)) throw new TypeError('workspaces must be an array')
  if (!(selected instanceof Set)) throw new TypeError('selected must be a Set')
  if (!(names instanceof Map)) throw new TypeError('names must be a Map')
  const seen = new Set()
  return workspaces.flatMap((workspace) => {
    const key = workspaceScopeKey(workspace.workspaceCwd)
    if (!selected.has(key) || seen.has(key)) return []
    seen.add(key)
    return [{
      projectKey: workspace.projectKey,
      workspaceCwd: workspace.workspaceCwd,
      workspaceAlias: names.get(key) ?? effectiveWorkspaceName(workspace),
    }]
  })
}

export function applyWorkspaceNameReceipts(workspaces, payload) {
  const receipts = new Map((payload?.receipts ?? []).map((receipt) => [workspaceScopeKey(receipt.workspaceCwd), receipt]))
  return workspaces.map((workspace) => {
    const receipt = receipts.get(workspaceScopeKey(workspace.workspaceCwd))
    if (!receipt) return workspace
    if (receipt.status === 'completed') {
      return { ...workspace, workspaceAlias: receipt.workspaceAlias ?? effectiveWorkspaceName(workspace), status: receipt.status }
    }
    return { ...workspace, status: receipt.status, error: receipt.error }
  })
}

export function workspaceFailureText(error) {
  const messages = {
    'workspace-alias-invalid': '工作区名称不能为空',
    'workspace-registration-missing': '找不到这条工作区登记',
    'workspace-scope-invalid': '工作区登记已变化，请重新读取',
    'workspace-path-invalid': '工作区目录已不可用',
    'project-manifest-corrupt': '项目登记文件已损坏',
    'project-manifest-unreadable': '项目登记文件无法读取',
    'workspace-alias-readback-mismatch': '保存后无法读回工作区名称',
  }
  return messages[error?.code] || '未保存，请重试'
}

function node(tag, text, className) {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}

/**
 * Mount the workspace-name editor into the existing shell drawer content.
 * The panel owns only selection and display values. Config persists each item
 * through the public resource and returns the authoritative per-item receipt.
 */
export function mountWorkspaceManagementPanel({
  host,
  api,
  projectKey,
  workspaceCwd,
  trigger,
  onSaved = () => {},
}) {
  const panel = node('section', undefined, 'workspace-management')
  panel.dataset.workspaceManagement = 'true'
  panel.append(
    node('h3', '批量编辑工作区名称'),
    node('p', '工作区路径是稳定身份。这里只修改工作区名称，不修改各项目标题，也不迁移目录。', 'muted'),
  )
  const status = node('p', '正在读取工作区…', 'workspace-management-status')
  status.setAttribute('role', 'status')
  const list = node('div', 'workspace-management-list')
  const actions = node('div', undefined, 'workspace-management-actions')
  const submit = node('button', '提交选中的名称', 'button')
  submit.type = 'button'
  submit.disabled = true
  actions.append(submit)
  panel.append(status, list, actions)
  host.append(panel)

  let workspaces = []
  const selected = new Set()
  const names = new Map()

  function selectInitialWorkspace() {
    const initial = workspaces.find((workspace) => workspaceCwd
      ? workspace.workspaceCwd === workspaceCwd
      : workspace.projectKey === projectKey)
    if (initial) selected.add(workspaceScopeKey(initial.workspaceCwd))
  }

  function renderRows() {
    list.replaceChildren()
    if (workspaces.length === 0) {
      list.append(node('p', '当前没有可编辑的工作区登记。', 'muted'))
      submit.disabled = true
      return
    }
    for (const workspace of workspaces) {
      const row = node('div', undefined, 'workspace-management-row')
      row.dataset.projectKey = workspace.projectKey
      row.dataset.status = workspace.status || 'ready'
      const checkbox = node('input')
      checkbox.type = 'checkbox'
      const key = workspaceScopeKey(workspace.workspaceCwd)
      checkbox.checked = selected.has(key)
      checkbox.setAttribute('aria-label', `选择 ${effectiveWorkspaceName(workspace)}`)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(key)
        else selected.delete(key)
        name.disabled = !checkbox.checked
        submit.disabled = selected.size === 0
      })
      const identity = node('label', undefined, 'workspace-management-identity')
      identity.append(node('strong', effectiveWorkspaceName(workspace)))
      identity.append(node('code', workspace.workspaceCwd))
      identity.prepend(checkbox)
      const name = node('input')
      name.type = 'text'
      name.value = names.get(key) ?? effectiveWorkspaceName(workspace)
      name.disabled = !checkbox.checked
      name.placeholder = '可读名称'
      name.setAttribute('aria-label', `修改 ${effectiveWorkspaceName(workspace)} 的工作区名称`)
      name.dataset.workspaceAlias = workspace.workspaceCwd
      name.addEventListener('input', () => names.set(key, name.value))
      const result = node('span', '', 'workspace-management-result')
      result.dataset.workspaceResult = workspace.workspaceCwd
      if (workspace.status === 'completed') result.textContent = '已保存'
      else if (workspace.status === 'rejected' || workspace.status === 'failed') {
        result.textContent = workspaceFailureText(workspace.error)
        result.dataset.tone = 'error'
      }
      row.append(identity, name, result)
      list.append(row)
    }
    submit.disabled = selected.size === 0
  }

  async function load() {
    try {
      const payload = await api.readWorkspaceManagement()
      workspaces = [...(payload.workspaces ?? [])]
      if (workspaceCwd && !workspaces.some((workspace) => workspace.workspaceCwd === workspaceCwd)) {
        for (const key of selected) selected.delete(key)
      } else if (projectKey && !workspaceCwd && !workspaces.some((workspace) => workspace.projectKey === projectKey)) {
        for (const key of selected) selected.delete(key)
      }
      selectInitialWorkspace()
      status.textContent = workspaces.length === 0 ? '没有可编辑的工作区。' : `可编辑 ${workspaces.length} 个工作区。`
      renderRows()
    } catch (error) {
      status.textContent = `读取失败：${error?.message || '请检查连接状态'}`
      status.dataset.tone = 'error'
    }
  }

  submit.addEventListener('click', async () => {
    submit.disabled = true
    status.textContent = '正在保存选中名称…'
    status.dataset.tone = 'pending'
    try {
      const payload = await api.updateWorkspaceAliases(workspaceNameEdits({ workspaces, selected, names }))
      workspaces = applyWorkspaceNameReceipts(workspaces, payload)
      const completed = payload.receipts.filter((receipt) => receipt.status === 'completed').length
      const failed = payload.receipts.length - completed
      status.textContent = failed === 0 ? `已保存 ${completed} 个工作区。` : `已保存 ${completed} 个，${failed} 个未保存。`
      status.dataset.tone = failed === 0 ? 'success' : 'error'
      renderRows()
      await onSaved(payload, trigger)
    } catch (error) {
      status.textContent = `保存失败：${error?.message || '请重试'}`
      status.dataset.tone = 'error'
    } finally {
      submit.disabled = selected.size === 0
    }
  })

  void load()
  return { element: panel, reload: load }
}

function workspaceScopeKey(workspaceCwd) {
  return typeof workspaceCwd === 'string' ? workspaceCwd : ''
}
