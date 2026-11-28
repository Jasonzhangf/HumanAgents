import { element, openTechnicalDetail } from './runtime-shell.js'

const roles = {
  interaction: { label: '交互', color: '#6554c0' },
  orchestration: { label: '编排', color: '#176b94' },
  execution: { label: '执行', color: '#23754c' },
  review: { label: '审查', color: '#966012' },
  memory: { label: '记忆', color: '#a04473' },
  manager: { label: '项目负责人', color: '#23754c' },
  architect: { label: '架构', color: '#4c51bf' },
  reviewer: { label: '审查', color: '#966012' },
  tester: { label: '测试', color: '#0f766e' },
  specialist: { label: '专家', color: '#7e22ce' },
  executor: { label: '执行', color: '#23754c' },
}
export function memberRole(roleId) {
  return roles[roleId] ?? { label: roleId, color: '#626975' }
}
export function memberSessionLabel(state) {
  return ({ created: '已创建', opening: '启动中', ready: '就绪', running: '运行中', stopping: '停止中',
    stopped: '已停止', failed: '失败', closed: '已关闭', succeeded: '已完成' })[state]
    ?? `状态未识别（${state}）`
}

// Page-lifetime read cache. Each project owns its promise and DOM destination;
// neither entry polling nor an older project's completion can replace another.
export function createProjectRosterReader(api) {
  const reads = new Map()
  return { read(projectKey, { retry = false } = {}) {
    if (retry) reads.delete(projectKey)
    if (!reads.has(projectKey)) reads.set(projectKey, Promise.resolve().then(() => api.projectRoster(projectKey)).then((read) => {
      if (read.projectKey !== projectKey) throw new Error('成员名册项目范围不匹配')
      return read
    }))
    return reads.get(projectKey)
  } }
}

function roleBadge(roleId) {
  const role = memberRole(roleId)
  const badge = element('span', role.label, 'member-roster-role')
  badge.style.color = role.color
  badge.style.border = `1px solid ${role.color}`
  badge.style.borderRadius = '4px'
  badge.style.padding = '1px 5px'
  badge.style.fontSize = '11px'
  return badge
}

export function memberRosterDetail(member, projectLabel, projectKey, mainTopic, actions) {
  const content = element('div', undefined, 'member-roster-detail')
  content.append(element('p', `项目：${projectLabel}`), roleBadge(member.roleId))
  if (mainTopic) content.append(element('p', '项目负责人'), element('p', '主入口：当前服务主会话'))
  content.append(element('h3', '已绑定会话'))
  if (!member.sessions.length) content.append(element('p', mainTopic ? '当前服务提供主会话；暂无其他会话绑定。' : '尚未绑定会话。', 'muted'))
  for (const session of member.sessions) {
    const row = element('section', undefined, 'member-roster-session')
    row.append(element('p', memberSessionLabel(session.state)), element('code', session.sessionId))
    content.append(row)
  }
  const scope = element('section', undefined, 'member-roster-identifiers')
  scope.append(element('h3', '技术信息'), element('p', `项目：${projectKey}`))
  if (member.canonicalAddress) scope.append(element('p', `规范地址：${member.canonicalAddress}`))
  if (member.agentId) scope.append(element('p', `成员：${member.agentId}`))
  if (member.provider || member.model) {
    scope.append(element('p', `模型配置：${[member.provider, member.model].filter(Boolean).join(' / ')}`))
  }
  content.append(scope)
  if (actions && member.memberId && member.roleId !== 'manager') {
    const editSection = element('section', undefined, 'member-roster-edit')
    editSection.append(element('h3', '独立成员配置'))
    const form = element('div', undefined, 'member-roster-form')
    const roleLabel = element('label', '职责')
    const roleSelect = element('select')
    for (const [value, text] of [['executor', '执行'], ['architect', '架构'], ['reviewer', '审查'], ['tester', '测试'], ['specialist', '专家']]) {
      const opt = element('option', text)
      opt.value = value
      if (member.roleId === value) opt.selected = true
      roleSelect.append(opt)
    }
    roleLabel.append(roleSelect)
    const providerLabel = element('label', 'Provider（可选）')
    const providerInput = element('input')
    providerInput.type = 'text'
    providerInput.value = member.provider || ''
    providerLabel.append(providerInput)
    const modelLabel = element('label', 'Model（可选）')
    const modelInput = element('input')
    modelInput.type = 'text'
    modelInput.value = member.model || ''
    modelLabel.append(modelInput)
    const sysLabel = element('label', '系统提示词（独立副本）')
    const sysInput = element('textarea')
    sysInput.rows = 3
    sysInput.value = member.systemPrompt || ''
    sysLabel.append(sysInput)
    const rolePromptLabel = element('label', '角色提示词（独立副本）')
    const rolePromptInput = element('textarea')
    rolePromptInput.rows = 3
    rolePromptInput.value = member.rolePrompt || ''
    rolePromptLabel.append(rolePromptInput)
    const status = element('p', '', 'muted')
    const btns = element('div', undefined, 'member-roster-actions')
    const saveBtn = element('button', '保存配置', 'button button--primary')
    saveBtn.type = 'button'
    saveBtn.dataset.saveMember = member.memberId
    saveBtn.addEventListener('click', async () => {
      status.textContent = '正在保存…'
      try {
        await actions.onSave?.({
          memberId: member.memberId,
          role: roleSelect.value,
          provider: providerInput.value,
          model: modelInput.value,
          systemPrompt: sysInput.value,
          rolePrompt: rolePromptInput.value,
        })
        status.textContent = '已保存独立成员配置。'
      } catch (err) {
        status.textContent = err?.message || '保存失败'
      }
    })
    btns.append(saveBtn)
    if (actions.onRemove) {
      const removeBtn = element('button', '移除成员', 'button button--quiet')
      removeBtn.type = 'button'
      removeBtn.dataset.removeMember = member.memberId
      removeBtn.addEventListener('click', async () => {
        status.textContent = '正在移除…'
        try {
          await actions.onRemove(member)
        } catch (err) {
          status.textContent = err?.message || '移除失败'
        }
      })
      btns.append(removeBtn)
    }
    form.append(roleLabel, providerLabel, modelLabel, sysLabel, rolePromptLabel, btns, status)
    editSection.append(form)
    content.append(editSection)
  }
  return content
}

export function mountMemberRoster({ projectKey, projectLabel, reader, mainTopic, onReadIssue = () => {}, onCurrentActivate, onAddMember, memberActions }) {
  const root = element('div', undefined, 'member-roster')
  root.dataset.projectKey = projectKey
  const topic = mainTopic?.projectKey === projectKey ? mainTopic : null
  function render(members, issue) {
    root.replaceChildren()
    const mainMember = topic
      ? ((topic.agentId && members.find((member) => member.agentId === topic.agentId))
          || members.find((member) => member.roleId === 'manager' || member.memberName === (topic.agentName || 'Jenny')))
      : null
    const displayed = topic ? [mainMember ?? { memberName: topic.agentName, roleId: 'manager', sessions: [] },
      ...members.filter((member) => member !== mainMember)] : members
    if (!topic) {
      const unavailable = element('button', undefined, 'entry-person member-roster-default-unavailable')
      unavailable.type = 'button'
      unavailable.append(element('span', 'Jenny'), roleBadge('manager'),
        element('span', '会话入口尚未接入', 'member-roster-entry-state'))
      unavailable.addEventListener('click', () => {
        const content = element('div', undefined, 'member-roster-detail')
        content.append(element('p', `项目：${projectLabel}`),
          element('p', '此项目的默认 Jenny 会话入口尚未接入当前服务。'),
          element('p', '当前仅能查看此项目的登记与名册状态，无法在此打开历史或发送消息。'))
        openTechnicalDetail({ title: `${projectLabel} · Jenny`, eyebrow: '会话状态', content, trigger: unavailable })
      })
      root.append(unavailable)
    }
    for (const member of displayed) {
      const isMain = topic && member === displayed[0]
      const openDetail = (trigger) => openTechnicalDetail({ title: member.memberName,
        eyebrow: '成员详情', content: memberRosterDetail(member, projectLabel, projectKey, isMain ? topic : null, memberActions?.(member, () => readRoster(true))), trigger })
      if (isMain) {
        const row = element('div', undefined, 'member-roster-main-row')
        const link = element('a', undefined, 'entry-person entry-jenny member-roster-main')
        link.href = topic.href
        link.append(element('span', member.memberName), roleBadge('manager'))
        if (topic.current) {
          link.setAttribute('aria-current', 'page')
          link.addEventListener('click', (event) => {
            event.preventDefault()
            onCurrentActivate?.(link)
          })
        }
        const detail = element('button', '成员详情', 'member-roster-detail-trigger')
        detail.type = 'button'
        detail.setAttribute('aria-label', `${member.memberName} 成员详情`)
        detail.addEventListener('click', () => openDetail(detail))
        row.append(link, detail)
        root.append(row)
        continue
      }
      const button = element('button', undefined, 'entry-person member-roster-member')
      button.type = 'button'
      button.style.display = 'flex'
      button.style.gap = '8px'
      button.style.alignItems = 'center'
      button.append(element('span', member.memberName), roleBadge(member.roleId))
      button.addEventListener('click', () => openDetail(button))
      root.append(button)
    }
    if (issue) root.append(element('p', issue, 'member-roster-state'))
    if (onAddMember) {
      const addBtn = element('button', '＋ 添加成员', 'entry-person member-roster-add')
      addBtn.type = 'button'
      addBtn.dataset.addMemberProject = projectKey
      addBtn.addEventListener('click', () => onAddMember(addBtn, () => readRoster(true)))
      root.append(addBtn)
    }
  }
  function readRoster(retry = false) {
    render([], '正在读取成员名册…')
    return reader.read(projectKey, { retry }).then((read) => {
      const empty = read.members.length === 0
      const state = read.rosterState === 'not-initialized'
        ? '成员名册尚未初始化。'
        : empty ? '暂无历史成员。' : null
      render(read.members, state)
      onReadIssue(null)
    }).catch((error) => {
      const detail = `成员名册读取失败${error.status ? `（HTTP ${error.status}）` : ''}：${error.message}`
      render([], detail)
      onReadIssue(detail)
      const retry = element('button', '重试读取名册', 'member-roster-detail-trigger')
      retry.type = 'button'
      retry.addEventListener('click', () => { void readRoster(true) })
      root.append(retry)
    })
  }
  void readRoster()
  return root
}
