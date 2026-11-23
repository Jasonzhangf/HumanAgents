import { element, openTechnicalDetail } from './runtime-shell.js'

const roles = {
  interaction: { label: '交互', color: '#6554c0' },
  orchestration: { label: '编排', color: '#176b94' },
  execution: { label: '执行', color: '#23754c' },
  review: { label: '审查', color: '#966012' },
  memory: { label: '记忆', color: '#a04473' },
  manager: { label: '项目负责人', color: '#23754c' },
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
  return { read(projectKey) {
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

export function memberRosterDetail(member, projectLabel, projectKey, mainTopic) {
  const content = element('div', undefined, 'member-roster-detail')
  content.append(element('p', `项目：${projectLabel}`), roleBadge(member.roleId))
  if (mainTopic) content.append(element('p', 'manager · 项目负责人'), element('p', '主入口：当前服务主会话'))
  content.append(element('h3', '已绑定会话'))
  if (!member.sessions.length) content.append(element('p', mainTopic ? '当前服务提供主会话；暂无其他会话绑定。' : '尚未绑定会话。', 'muted'))
  for (const session of member.sessions) {
    const row = element('section', undefined, 'member-roster-session')
    row.append(element('p', memberSessionLabel(session.state)), element('code', session.sessionId))
    content.append(row)
  }
  const scope = element('section', undefined, 'member-roster-identifiers')
  scope.append(element('h3', '技术信息'), element('p', `项目：${projectKey}`))
  if (member.agentId) scope.append(element('p', `成员：${member.agentId}`))
  content.append(scope)
  return content
}

export function mountMemberRoster({ projectKey, projectLabel, reader, mainTopic, onReadIssue = () => {} }) {
  const root = element('div', undefined, 'member-roster')
  root.dataset.projectKey = projectKey
  const topic = mainTopic?.projectKey === projectKey ? mainTopic : null
  function render(members) {
    root.replaceChildren()
    const mainMember = topic && members.find((member) => member.roleId === 'interaction' && member.memberName === topic.agentName)
    const displayed = topic ? [mainMember ?? { memberName: topic.agentName, roleId: 'manager', sessions: [] },
      ...members.filter((member) => member !== mainMember)] : members
    for (const member of displayed) {
      const isMain = topic && member === displayed[0]
      const openDetail = (trigger) => openTechnicalDetail({ title: member.memberName,
        eyebrow: '成员详情', content: memberRosterDetail(member, projectLabel, projectKey, isMain ? topic : null), trigger })
      if (isMain) {
        const row = element('div', undefined, 'member-roster-main-row')
        const link = element('a', undefined, 'entry-person entry-jenny member-roster-main')
        link.href = topic.href
        link.append(element('span', member.memberName), roleBadge('manager'))
        if (topic.current) link.setAttribute('aria-current', 'page')
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
  }
  render([])
  void reader.read(projectKey).then((read) => {
    render(read.members)
    onReadIssue(read.rosterState === 'not-initialized' ? '项目名册尚未初始化。' : null)
  }).catch((error) => {
    const detail = `成员名册读取失败${error.status ? `（HTTP ${error.status}）` : ''}：${error.message}`
    render([])
    onReadIssue(detail)
  })
  return root
}
