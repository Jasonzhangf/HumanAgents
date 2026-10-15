import { element } from './runtime-api.js'

// These keys describe view state only. The runtime must confirm every identity.
const QUERY_FIELDS = Object.freeze({
  kind: 'agentKind', runtimeId: 'agentRuntimeId', executionEpoch: 'agentExecutionEpoch',
  roleId: 'agentRoleId', generation: 'agentGeneration', agentInstanceId: 'agentInstanceId',
  assignmentId: 'agentAssignmentId', attempt: 'agentAttempt',
  businessTurnId: 'agentBusinessTurnId', segmentId: 'agentSegmentId', nodeId: 'agentNodeId',
})
const IDENTITY_FIELDS = ['runtimeId', 'executionEpoch', 'roleId', 'generation', 'agentInstanceId']
const DETAIL_FIELDS = ['assignmentId', 'attempt', 'businessTurnId', 'segmentId', 'nodeId']
const NUMBERS = ['executionEpoch', 'generation', 'attempt']

function invalid(message) {
  return { ok: false, failure: {
    code: 'agent-activity.invalid-selection', ownerId: 'humanagent.ui.agent-activity',
    message, nextAction: '重新选择完整的运行实例，或返回任务实例列表。',
  } }
}

/** Return the explicit-selection failure when no selected read confirms it. */
export function agentSelectionReadFailure(agentQuery, read) {
  if (!agentQuery) return undefined
  if (read !== undefined && !read?.ok) return undefined
  if (read?.value?.mode === 'selected') return undefined
  return {
    code: 'agent-activity.selection-not-confirmed',
    ownerId: 'humanagent.ui.agent-activity',
    message: '这次读取没有返回所选运行实例，不能把任务实例列表当作该选择。',
    nextAction: '重试所选实例读取，或返回任务实例列表。',
  }
}

/** Decode syntax only; taskId comes from the caller's canonical task scope. */
export function agentActivitySelectionFromQuery(params, taskId) {
  const fields = {}
  for (const [field, key] of Object.entries(QUERY_FIELDS)) {
    const values = params.getAll(key)
    if (values.length > 1) return invalid(`实例选择参数重复：${key}`)
    if (values.length === 0) continue
    const value = values[0]
    if (!value.trim()) return invalid(`实例选择参数为空：${key}`)
    if (NUMBERS.includes(field)) {
      if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
        return invalid(`实例选择数字无效：${key}`)
      }
      fields[field] = Number(value)
    } else fields[field] = value
  }
  if (Object.keys(fields).length === 0) return { ok: true, value: { taskId } }
  if (fields.kind !== 'native-execution' && fields.kind !== 'incarnation') {
    return invalid('实例选择缺少有效的身份类型。')
  }
  const required = fields.kind === 'incarnation'
    ? IDENTITY_FIELDS : ['runtimeId', 'executionEpoch']
  if (required.some((key) => fields[key] === undefined)) return invalid('实例身份不完整。')
  if (fields.kind === 'native-execution'
      && ['roleId', 'generation', 'agentInstanceId'].some((key) => fields[key] !== undefined)) {
    return invalid('原生执行选择包含了运行实例身份。')
  }
  if (fields.kind === 'incarnation' && fields.assignmentId === undefined) {
    return invalid('运行实例身份缺少工作分配。')
  }
  const identity = Object.fromEntries(required.map((key) => [key, fields[key]]))
  const instance = fields.kind === 'native-execution'
    ? { kind: fields.kind, execution: identity }
    : { kind: fields.kind, incarnation: { ...identity, taskId, assignmentId: fields.assignmentId } }
  const value = { taskId, instance }
  for (const key of DETAIL_FIELDS) if (fields[key] !== undefined) value[key] = fields[key]
  return { ok: true, value }
}

/** Copy all parent view parameters; edit only this module's documented keys. */
export function agentActivityQuery(params, query) {
  const result = new URLSearchParams(params)
  for (const key of Object.values(QUERY_FIELDS)) result.delete(key)
  const fields = {}
  if (query.instance !== undefined) {
    const { instance } = query
    if (instance.kind === 'native-execution') {
      if (instance.incarnation !== undefined) return invalid('原生执行选择包含了运行实例身份。')
      Object.assign(fields, instance.execution)
    } else if (instance.kind === 'incarnation') {
      if (instance.execution !== undefined) return invalid('运行实例选择包含了原生执行身份。')
      const identity = instance.incarnation
      if (identity?.taskId?.scope !== query.taskId.scope || identity?.taskId?.value !== query.taskId.value
          || identity?.assignmentId === undefined
          || (query.assignmentId !== undefined && identity.assignmentId !== query.assignmentId)) {
        return invalid('实例与任务或工作分配不一致。')
      }
      Object.assign(fields, identity)
    } else return invalid('实例身份类型无效。')
    fields.kind = instance.kind
  }
  for (const key of DETAIL_FIELDS) if (query[key] !== undefined) fields[key] = query[key]
  for (const [field, key] of Object.entries(QUERY_FIELDS)) {
    if (fields[field] === undefined) continue
    if (NUMBERS.includes(field) && (!Number.isSafeInteger(fields[field]) || fields[field] < 0)) {
      return invalid(`实例选择数字无效：${key}`)
    }
    if (!NUMBERS.includes(field) && typeof fields[field] !== 'string') {
      return invalid(`实例选择文本无效：${key}`)
    }
    result.set(key, String(fields[field]))
  }
  const decoded = agentActivitySelectionFromQuery(result, query.taskId)
  return decoded.ok ? { ok: true, value: result } : decoded
}

function selectionFor(entry) {
  const projected = entry.instance
  const execution = { runtimeId: projected.runtimeId, executionEpoch: projected.executionEpoch }
  const instance = projected.kind === 'native-execution'
    ? { kind: projected.kind, execution }
    : { kind: projected.kind, incarnation: {
      ...execution, roleId: projected.roleId, generation: projected.generation,
      agentInstanceId: projected.agentInstanceId, taskId: entry.taskId, assignmentId: entry.assignmentId,
    } }
  const selection = {
    taskId: entry.taskId, instance, assignmentId: entry.assignmentId,
    attempt: entry.attempt, nodeId: entry.nodeId,
  }
  for (const key of ['businessTurnId', 'segmentId']) {
    if (entry[key] !== undefined) selection[key] = entry[key]
  }
  return selection
}

function rendering(options, title) {
  const make = options.element || element
  const root = make('section', undefined, 'panel')
  root.setAttribute('aria-label', title)
  root.append(make('h2', title))
  const listeners = []
  function action(parent, label, callback, payload) {
    if (typeof callback !== 'function') return
    const button = make('button', label, 'button')
    button.type = 'button'
    const listener = () => callback(payload)
    button.addEventListener('click', listener)
    listeners.push(() => button.removeEventListener('click', listener))
    parent.append(button)
  }
  function failure(failure, detail) {
    const block = make('div', undefined, 'error')
    block.setAttribute('role', 'alert')
    block.append(make('p', failure.message), make('p', failure.nextAction))
    if (detail) block.append(make('p', `${failure.code} · ${failure.ownerId}`, 'muted'))
    root.append(block)
  }
  function unavailable(value, detail) {
    if (value.unavailableSources.length === 0) return
    const block = make('section')
    block.append(make('h3', '部分记录来源不可用'))
    for (const source of value.unavailableSources) {
      block.append(make('p', source.message))
      if (detail) block.append(make('p', `${source.sourceId} · ${source.ownerId}`, 'muted'))
    }
    root.append(block)
  }
  return { make, root, action, failure, unavailable, result: {
    element: root,
    dispose() { for (const remove of listeners.splice(0)) remove() },
  } }
}

function summary(ui, entry, options) {
  const card = ui.make('article', undefined, 'card')
  card.append(ui.make('h4', entry.instance.label), ui.make('p', entry.objective),
    ui.make('p', `${entry.currencyLabel} · ${entry.sourceKindLabel}`, 'muted'))
  if (entry.missingSource !== undefined) card.append(ui.make('p', entry.missingSource, 'muted'))
  const selection = selectionFor(entry)
  ui.action(card, '查看此实例', options.onSelect, selection)
  ui.action(card, '查看记录详情', options.onOpenDetail, { kind: 'activity', selection, entry })
  return card
}

/** Render all supplied activity entries. Never choose or reclassify an instance. */
export function renderAgentActivity(read, options = {}) {
  const ui = rendering(options, '运行实例')
  if (!read.ok) { ui.failure(read.failure, false); return ui.result }
  const value = read.value
  if (value.mode === 'selected') {
    const viewed = ui.make('section')
    viewed.append(ui.make('h3', '正在查看的实例'), ui.make('p', value.selectedInstance.label))
    for (const entry of value.selected) viewed.append(summary(ui, entry, options))
    if (value.selected.length === 0) viewed.append(ui.make('p', '此选择未提供活动记录。', 'muted'))
    ui.root.append(viewed)
  }
  for (const [key, title] of [['current', '当前运行'], ['historical', '历史记录'], ['unknown', '当前归属未知']]) {
    const section = ui.make('section')
    section.append(ui.make('h3', title))
    for (const entry of value[key]) section.append(summary(ui, entry, options))
    if (value[key].length === 0) section.append(ui.make('p', '本次读取未提供此类记录。', 'muted'))
    ui.root.append(section)
  }
  ui.unavailable(value, false)
  return ui.result
}

// Detail values are text, including evidence locators. Capability routing belongs
// to the injected shell callback, so unsupported evidence never gains a URL.
function reference(ui, parent, title, value) {
  const block = ui.make('section')
  block.append(ui.make('h4', title))
  const list = ui.make('dl')
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    list.append(ui.make('dt', key))
    const description = ui.make('dd')
    if (item !== null && typeof item === 'object') reference(ui, description, key, item)
    else description.append(ui.make('span', String(item)))
    list.append(description)
  }
  block.append(list)
  parent.append(block)
}

/** Content for the shell-owned side panel / bottom drawer; no overlay or I/O. */
export function renderAgentActivityDetail(read, options = {}) {
  const ui = rendering(options, '运行实例详情')
  if (!read.ok) { ui.failure(read.failure, true); return ui.result }
  const value = read.value
  if (value.mode === 'catalog') {
    ui.root.append(ui.make('p', '请先选择要查看的运行实例。'))
  } else {
    reference(ui, ui.root, '正在查看的实例身份', value.selectedInstance)
    for (const entry of value.selected) {
      const card = summary(ui, entry, options)
      const selection = selectionFor(entry)
      reference(ui, card, '精确记录', {
        taskId: entry.taskId, instance: entry.instance, assignmentId: entry.assignmentId,
        attempt: entry.attempt, executionEpoch: entry.executionEpoch,
        businessTurnId: entry.businessTurnId, segmentId: entry.segmentId, nodeId: entry.nodeId,
      })
      if (entry.nodeId) ui.action(card, '查看关联节点', options.onOpenDetail, {
        kind: 'node', selection, nodeId: entry.nodeId,
      })
      else card.append(ui.make('p', '未提供关联节点。', 'muted'))
      for (const commitRef of entry.commitRefs) {
        reference(ui, card, '提交凭据', commitRef)
        ui.action(card, '查看提交凭据', options.onOpenDetail, { kind: 'commit', selection, commitRef })
      }
      for (const evidenceRef of entry.evidenceRefs) {
        reference(ui, card, '证据引用', evidenceRef)
        ui.action(card, '查看证据引用', options.onOpenDetail, { kind: 'evidence', selection, evidenceRef })
      }
      ui.root.append(card)
    }
    if (value.selected.length === 0) ui.root.append(ui.make('p', '此选择未提供活动记录。', 'muted'))
  }
  ui.unavailable(value, true)
  return ui.result
}
