/**
 * Shared display-mode labels, the scoped-read commit rule and the single
 * Current/Semantic reasoning-plan renderer used by the real task reading
 * surfaces.
 *
 * The commit rule has no DOM and no persistence. A caller supplies:
 *   read()   -> the receipt from createScopedReadPublication/createRuntimeReadPublication
 *   build()  -> detached staging content for the confirmed publication
 *   commit() -> install that staged content into the mounted surface
 *
 * A failed, stale, or superseded publication never runs build/commit, so the
 * prior successful reading content stays visible.
 *
 * The plan renderer consumes only the typed `RuntimeTaskPlanHistoryProjection`
 * carried by the original Dashboard GET. It never reads raw records,
 * checkpoints or scheduling plans to reconstruct reasoning history, and it
 * never infers execution status from planned nodes. `element` comes from the
 * DOM-free API helper so this module stays out of the `runtime-shell.js` import
 * cycle (that module already imports these labels).
 */

import { element } from './runtime-api.js'

export const DISPLAY_MODE_LABELS = Object.freeze({
  current: '当前内容',
  semantic: '语义历史',
  actions: '动作轨迹',
  raw: '原始记录',
  'follow-last': '跟随上次选择',
})

export const DISPLAY_MODE_DESCRIPTIONS = Object.freeze({
  current: '这个任务当前已经发布的权威视图。',
  semantic: '按时间保留的任务计划版本与证据。',
  actions: '这次任务执行过的动作轨迹。',
  raw: '与执行相关的原始记录和引用。',
  'follow-last': '直接手动选择时，跟随上一次成功选择。',
})

export function displayModeLabel(mode) {
  return DISPLAY_MODE_LABELS[mode] || (mode ? String(mode) : '尚未选择')
}

// ── Public output publication presentation ──────────────────────────────────
// The dashboard result panel and the completed-task action copy read one view
// of the typed `PublicOutputPublicationProjection` carried by the task GET.
// The state is one of the four explicit publication states; a read without the
// carrier stays a legacy read. This module never inspects raw records, provider
// text or the task lifecycle to decide the result state. A confirmed text that
// the projection already returned stays exact in every state.
const PUBLIC_OUTPUT_CONFIRMED_LABEL = '已确认的结果'
const PUBLIC_OUTPUT_STATE_COPY = Object.freeze({
  unknown: '结果状态暂时无法确认',
  pending: '新内容待确认',
  unavailable: '结果暂时不可用',
})

function publicOutputView({ output, publication } = {}) {
  const state = publication?.state
  const confirmed = typeof output === 'string' && output.length > 0
  const confirmedText = confirmed ? output : ''
  if (state === 'unknown' || state === 'pending' || state === 'unavailable') {
    const copy = PUBLIC_OUTPUT_STATE_COPY[state]
    return {
      state,
      confirmed,
      message: copy,
      text: confirmed ? confirmedText : copy,
      status: confirmed ? `${PUBLIC_OUTPUT_CONFIRMED_LABEL} · ${copy}` : '',
    }
  }
  if (state === 'committed') {
    return {
      state,
      confirmed,
      message: '已确认',
      text: confirmed ? confirmedText : '暂无结果',
      status: confirmed ? '已确认' : '',
    }
  }
  return { state, confirmed, message: '', text: confirmed ? confirmedText : '暂无结果', status: '' }
}

/** Result panel body for the dashboard `交付结果` section. */
export function renderTaskPublicOutputPanel(input = {}) {
  const view = publicOutputView(input)
  const panel = element('div', undefined, 'panel')
  panel.append(element('p', view.text, 'business-output-text'))
  if (view.status) panel.append(element('p', view.status, 'muted'))
  return panel
}

/** Action copy for a succeeded task, driven by the same publication view. */
export function publicOutputActionCopy(input = {}) {
  const view = publicOutputView(input)
  if (view.state === 'unknown' || view.state === 'pending' || view.state === 'unavailable') {
    return `任务已完成；${view.message}。`
  }
  if (view.state === 'committed') {
    return view.confirmed ? '任务已完成，结果已确认。' : '任务已完成；当前没有合法操作。'
  }
  return view.confirmed ? '任务已完成，结果可用。' : '任务已完成；当前没有合法操作。'
}

const TASK_DESCRIPTION_FIELDS = Object.freeze([
  ['goal', '目标'],
  ['scope', '范围'],
  ['constraints', '约束'],
  ['deliverables', '交付要求'],
])

function canonicalTaskDescription(input) {
  if (typeof input !== 'string') return null
  let value
  try {
    value = JSON.parse(input)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== TASK_DESCRIPTION_FIELDS.length) return null
  const fields = new Map(TASK_DESCRIPTION_FIELDS)
  if (!keys.every((key) => fields.has(key))) return null
  if (typeof value.goal !== 'string' || typeof value.scope !== 'string') return null
  if (!Array.isArray(value.constraints) || !value.constraints.every((item) => typeof item === 'string')) return null
  if (!Array.isArray(value.deliverables) || !value.deliverables.every((item) => typeof item === 'string')) return null
  return value
}

function taskDescriptionValue(value) {
  if (!Array.isArray(value)) return element('span', value, 'business-output-text')
  const list = element('ul', undefined, 'task-description-values')
  for (const item of value) list.append(element('li', item, 'business-output-text'))
  return list
}

/**
 * Render the stored Task description for the existing shared detail drawer.
 * Only the complete four-field DraftRevision shape is expanded. Every other
 * non-empty input stays the exact original string.
 */
export function renderTaskDescriptionContent({ input } = {}) {
  const root = element('div', undefined, 'task-description')
  if (input === undefined || input === null || input === '') {
    root.dataset.taskDescription = 'empty'
    root.append(element('p', '尚未输入', 'muted'))
    return root
  }

  const canonical = canonicalTaskDescription(input)
  if (!canonical) {
    root.dataset.taskDescription = 'original'
    root.append(element('p', input, 'business-output-text'))
    return root
  }

  root.dataset.taskDescription = 'structured'
  const list = element('dl', undefined, 'record-ref task-description-fields')
  for (const [key, label] of TASK_DESCRIPTION_FIELDS) {
    const row = element('div')
    const value = element('dd', undefined, 'task-description-value')
    row.dataset.taskDescriptionField = key
    value.append(taskDescriptionValue(canonical[key]))
    row.append(element('dt', label), value)
    list.append(row)
  }
  root.append(list)
  return root
}

function normalizedFailure(value, fallbackCode = 'display-preference.transition-failed') {
  if (value && typeof value === 'object') {
    return {
      code: typeof value.code === 'string' ? value.code : fallbackCode,
      ownerId: typeof value.ownerId === 'string' ? value.ownerId : 'humanagent.ui',
      message: typeof value.message === 'string' ? value.message : String(value.message ?? fallbackCode),
      nextAction: typeof value.nextAction === 'string' ? value.nextAction : 'retry the reading mode',
    }
  }
  return {
    code: fallbackCode,
    ownerId: 'humanagent.ui',
    message: String(value ?? fallbackCode),
    nextAction: 'retry the reading mode',
  }
}

export function unavailableModeFailure(mode, reason) {
  const detail = reason || 'this surface cannot render that reading layer yet'
  return {
    code: 'display-preference.mode-unavailable',
    ownerId: 'humanagent.ui',
    message: `阅读方式「${displayModeLabel(mode)}」尚未接入：${detail}`,
    nextAction: 'use a reading mode this surface can render now',
  }
}

function supersededFailure() {
  return {
    code: 'display-preference.transition-superseded',
    ownerId: 'humanagent.ui',
    message: 'a newer reading request replaced this transition',
    nextAction: 'retry the reading mode',
  }
}

export async function commitScopedReadTransition({ read, build, commit } = {}) {
  if (typeof read !== 'function') throw new TypeError('commitScopedReadTransition requires a read function')
  if (typeof build !== 'function' || typeof commit !== 'function') {
    throw new TypeError('commitScopedReadTransition requires build and commit functions')
  }

  let receipt
  try {
    receipt = await read()
  } catch (error) {
    return { ok: false, failure: normalizedFailure(error) }
  }

  if (!receipt || receipt.published !== true) {
    return { ok: false, superseded: true, failure: supersededFailure() }
  }

  const state = receipt.state || {}
  if (state.stale === true || state.content === undefined || state.content === null) {
    return {
      ok: false,
      stale: state.stale === true,
      failure: normalizedFailure(
        state.failure || 'the scoped read did not publish confirmed content',
        'display-preference.read-failed',
      ),
    }
  }

  let staged
  try {
    staged = build(state.content)
  } catch (error) {
    return { ok: false, failure: normalizedFailure(error, 'display-preference.render-failed') }
  }
  if (staged && typeof staged === 'object' && staged.planFailure) {
    return { ok: false, failure: normalizedFailure(staged.planFailure, 'display-preference.render-failed') }
  }
  commit(staged)
  return { ok: true, content: state.content, render: staged }
}

// ── Shared Current/Semantic reasoning-plan renderer ─────────────────────────
// One renderer serves both reading modes and every task type. Every fact below
// is a typed field of the returned projection. Planned nodes are never
// executed-state facts: no status is derived from a phase name, a version
// position or an event stream.

export const TASK_PLAN_HISTORY_SURFACE = 'runtime-task-plan-history'

const PLAN_HISTORY_OWNER = 'humanagent.ui'

function planFailure(code, message, nextAction) {
  return { code, ownerId: PLAN_HISTORY_OWNER, message, nextAction }
}

function normalizePlanFailure(value, fallbackCode = 'task-plan-history.failed') {
  if (value && typeof value === 'object') {
    return {
      code: typeof value.code === 'string' && value.code ? value.code : fallbackCode,
      ownerId: typeof value.ownerId === 'string' && value.ownerId ? value.ownerId : PLAN_HISTORY_OWNER,
      message: typeof value.message === 'string' && value.message ? value.message : String(value.message ?? fallbackCode),
      nextAction: typeof value.nextAction === 'string' && value.nextAction ? value.nextAction : 'refresh the original task projection read',
    }
  }
  return planFailure(fallbackCode, String(value ?? fallbackCode), 'refresh the original task projection read')
}

/**
 * Read the released `taskPlanHistory` field without inventing a substitute.
 * A missing field, a foreign surface or an explicit failure stays an explicit
 * failure; it is never turned into an empty successful history.
 */
export function planHistoryAvailability(read) {
  if (read && read.ok === true && read.value && read.value.surface === TASK_PLAN_HISTORY_SURFACE) {
    return { ok: true, value: read.value }
  }
  if (read && read.ok === false) {
    return { ok: false, failure: normalizePlanFailure(read.failure, 'task-plan-history.unavailable') }
  }
  if (read && read.ok === true && read.value) {
    return {
      ok: false,
      failure: planFailure(
        'task-plan-history.unexpected-surface',
        `任务投影返回了 ${String(read.value.surface)}，不是权威推理计划历史。`,
        'bind the dashboard field to runtime-task-plan-history',
      ),
    }
  }
  return {
    ok: false,
    failure: planFailure(
      'task-plan-history.unavailable',
      '任务投影还没有返回权威推理计划历史。',
      'bind the original dashboard GET to the authoritative task plan history',
    ),
  }
}

/**
 * Reject an explicit scope that disagrees with the returned history scope. A
 * legacy read without an explicit scope accepts the returned scope for view
 * links, but never invents a project or mode and never overrides a conflict.
 */
export function planHistoryScopeFailure(history, explicitScope) {
  if (!explicitScope) return null
  const scope = history?.scope
  if (!scope || scope.kind !== 'task') {
    return planFailure(
      'task-plan-history.scope-mismatch',
      '权威计划历史没有返回任务级范围。',
      'read the plan history from the same canonical task scope as the dashboard',
    )
  }
  const taskId = scope.taskId?.value
  if (scope.projectKey !== explicitScope.projectKey
    || scope.mode !== explicitScope.mode
    || taskId !== explicitScope.taskId?.value) {
    return planFailure(
      'task-plan-history.scope-mismatch',
      `权威计划历史范围（项目 ${scope.projectKey} · 模式 ${scope.mode} · 任务 ${taskId}）与当前显式范围不一致。`,
      'reopen the task from the project list so the history read uses the same scope',
    )
  }
  return null
}

function planRevisions(history) {
  return Array.isArray(history?.revisions) ? history.revisions : []
}

/**
 * Current resolves only the exact accepted revision and its matching physical
 * publication identity. A later published-but-unaccepted revision is never
 * substituted for current.
 */
export function resolveCurrentPlanRevision(history, { explicitScope } = {}) {
  const scopeFailure = planHistoryScopeFailure(history, explicitScope)
  if (scopeFailure) return { ok: false, failure: scopeFailure }

  const current = history?.current
  if (!current || current.state !== 'known' || !current.value || typeof current.value.revisionId !== 'string') {
    const reason = current?.reason ? `原因：${current.reason}` : '未提供原因'
    return {
      ok: false,
      failure: planFailure(
        'task-plan-history.current-unknown',
        `当前权威计划版本未知（${reason}）。`,
        'refresh the task projection; do not treat the latest published revision as current',
      ),
    }
  }

  const receipt = current.value.revisionCommitRef
  const commitId = receipt && typeof receipt.commitId === 'string' ? receipt.commitId : ''
  if (!commitId) {
    return {
      ok: false,
      failure: planFailure(
        'task-plan-history.current-mismatch',
        `当前计划版本 ${current.value.revisionId} 缺少可核对的 Journal 提交身份。`,
        'refresh the authoritative current plan read',
      ),
    }
  }

  const revisions = planRevisions(history)
  const index = revisions.findIndex((candidate) => candidate?.revisionId === current.value.revisionId)
  if (index < 0) {
    return {
      ok: false,
      failure: planFailure(
        'task-plan-history.current-mismatch',
        `当前计划版本 ${current.value.revisionId} 不在返回的保留历史中。`,
        'restore the authoritative publication for the accepted current revision',
      ),
    }
  }
  const revision = revisions[index]
  if (revision.journalCommitRef !== `jsonl:${commitId}`) {
    return {
      ok: false,
      failure: planFailure(
        'task-plan-history.current-mismatch',
        `当前计划版本 ${current.value.revisionId} 的发布身份与接受的提交不一致。`,
        'restore the authoritative publication and receipt binding',
      ),
    }
  }
  return { ok: true, revision, index }
}

/**
 * A legal historical selection is a pair of `planRevision` and
 * `planPublication` view-state values. A partial or mismatched pair stays an
 * explicit failure instead of silently falling back to current.
 */
export function resolveViewedPlanRevision(history, selection, { explicitScope } = {}) {
  const scopeFailure = planHistoryScopeFailure(history, explicitScope)
  if (scopeFailure) return { ok: false, failure: scopeFailure }

  const hasRevision = typeof selection?.revisionId === 'string' && selection.revisionId !== ''
  const hasPublication = typeof selection?.publication === 'string' && selection.publication !== ''
  if (!hasRevision && !hasPublication) return { ok: true, revision: null, selection: null }
  if (!hasRevision || !hasPublication) {
    return {
      ok: false,
      failure: planFailure(
        'task-plan-history.selection-partial',
        'URL 里的计划版本选择不完整：planRevision 与 planPublication 必须同时出现。',
        'remove the partial plan selection or reopen the history from a task link',
      ),
    }
  }

  const revision = planRevisions(history).find((candidate) => candidate?.revisionId === selection.revisionId)
  if (!revision) {
    return {
      ok: false,
      failure: planFailure(
        'task-plan-history.selection-unknown',
        `URL 选择的计划版本 ${selection.revisionId} 不在返回的保留历史中。`,
        'select a revision the authoritative history still retains',
      ),
    }
  }
  if (revision.journalCommitRef !== selection.publication) {
    return {
      ok: false,
      failure: planFailure(
        'task-plan-history.selection-mismatch',
        `URL 选择的计划版本 ${selection.revisionId} 与发布身份 ${selection.publication} 不一致。`,
        'reopen the revision from the authoritative history link',
      ),
    }
  }
  return {
    ok: true,
    revision,
    selection: { revisionId: revision.revisionId, publication: revision.journalCommitRef },
  }
}

function planNodeSignature(node) {
  return JSON.stringify([
    node?.kind ?? null,
    node?.title ?? null,
    node?.intent ?? null,
    node?.phaseId ?? null,
    node?.definition ?? null,
  ])
}

function planPhaseSignature(phase) {
  return JSON.stringify([phase?.title ?? null, phase?.memberNodeIds ?? []])
}

function planRelationKey(relation) {
  return `${relation?.kind}\u0000${relation?.fromNodeId}\u0000${relation?.toNodeId}`
}

/**
 * Presentation-only diff of two adjacent retained typed snapshots. It compares
 * declared node, phase and relation fields and never derives execution status.
 */
export function planRevisionChanges(before, after) {
  const empty = {
    baseline: before === null || before === undefined,
    nodes: { added: [], removed: [], changed: [] },
    phases: { added: [], removed: [], changed: [] },
    relations: { added: [], removed: [] },
  }
  if (empty.baseline) return empty

  const beforeNodes = new Map((before.nodes ?? []).map((node) => [node.nodeId, node]))
  const afterNodes = new Map((after?.nodes ?? []).map((node) => [node.nodeId, node]))
  for (const [nodeId, node] of afterNodes) {
    const previous = beforeNodes.get(nodeId)
    if (!previous) {
      empty.nodes.added.push(node)
      continue
    }
    if (planNodeSignature(previous) !== planNodeSignature(node)) {
      const fields = []
      if (previous.kind !== node.kind) fields.push('kind')
      if (previous.title !== node.title) fields.push('title')
      if (previous.intent !== node.intent) fields.push('intent')
      if ((previous.phaseId ?? null) !== (node.phaseId ?? null)) fields.push('phaseId')
      if (JSON.stringify(previous.definition ?? null) !== JSON.stringify(node.definition ?? null)) fields.push('definition')
      empty.nodes.changed.push({ nodeId, fields, before: previous, after: node })
    }
  }
  for (const [nodeId, node] of beforeNodes) {
    if (!afterNodes.has(nodeId)) empty.nodes.removed.push(node)
  }

  const beforePhases = new Map((before.phases ?? []).map((phase) => [phase.phaseId, phase]))
  const afterPhases = new Map((after?.phases ?? []).map((phase) => [phase.phaseId, phase]))
  for (const [phaseId, phase] of afterPhases) {
    const previous = beforePhases.get(phaseId)
    if (!previous) {
      empty.phases.added.push(phase)
      continue
    }
    if (planPhaseSignature(previous) !== planPhaseSignature(phase)) {
      const fields = []
      if (previous.title !== phase.title) fields.push('title')
      if (JSON.stringify(previous.memberNodeIds ?? []) !== JSON.stringify(phase.memberNodeIds ?? [])) fields.push('memberNodeIds')
      empty.phases.changed.push({ phaseId, fields, before: previous, after: phase })
    }
  }
  for (const [phaseId, phase] of beforePhases) {
    if (!afterPhases.has(phaseId)) empty.phases.removed.push(phase)
  }

  const beforeRelations = new Map((before.relations ?? []).map((relation) => [planRelationKey(relation), relation]))
  const afterRelations = new Map((after?.relations ?? []).map((relation) => [planRelationKey(relation), relation]))
  for (const [key, relation] of afterRelations) {
    if (!beforeRelations.has(key)) empty.relations.added.push(relation)
  }
  for (const [key, relation] of beforeRelations) {
    if (!afterRelations.has(key)) empty.relations.removed.push(relation)
  }
  return empty
}

const PLAN_REASON_LABELS = Object.freeze({
  initial: '初始计划',
  adjustment: '计划调整',
  unrecorded: '原因未记录',
})

const PLAN_RELATION_LABELS = Object.freeze({
  'depends-on': '依赖',
  'parent-child': '父子',
  sequence: '顺序',
})

const PLAN_NODE_KIND_LABELS = Object.freeze({
  work: '工作',
  check: '检查',
})

function planReasonKindLabel(kind) {
  return PLAN_REASON_LABELS[kind] || (kind ? String(kind) : '原因未记录')
}

function planReasonText(reason) {
  const text = typeof reason?.text === 'string' ? reason.text.trim() : ''
  return text === '' ? '原因未记录' : text
}

function planRelationLabel(kind) {
  return PLAN_RELATION_LABELS[kind] || (kind ? String(kind) : '未声明关系')
}

function planCompletenessLabel(completeness) {
  if (completeness?.scope === 'whole-task' && completeness?.status === 'complete') {
    return '完整性：已声明覆盖整个任务'
  }
  return `完整性：${completeness?.status || '未声明'}（${completeness?.scope || '范围未声明'}）`
}

function planCoverageLabel(coverage) {
  if (coverage === 'complete-from-task-start') return '历史覆盖：从任务开始完整保留'
  if (coverage === 'prior-history-unavailable') return '历史覆盖：更早历史不可用'
  return `历史覆盖：${coverage || '未声明'}`
}

function planDetail(summary, pairs, options = {}) {
  if (typeof options.onOpenDetail === 'function') {
    const button = element('button', summary, 'button button--quiet plan-detail')
    button.type = 'button'
    button.addEventListener('click', () => options.onOpenDetail({ title: summary, entries: pairs }, button))
    return button
  }
  const details = element('details', undefined, 'plan-detail')
  details.append(element('summary', summary))
  const list = element('dl', undefined, 'record-ref')
  for (const [label, value] of pairs) {
    const row = element('div')
    row.append(element('dt', label), element('dd', value === undefined || value === null || value === '' ? '未提供' : String(value)))
    list.append(row)
  }
  details.append(list)
  return details
}

function planFailurePresentation(failure) {
  switch (failure.code) {
    case 'task-plan-history.current-unknown':
      return {
        title: '当前任务计划尚无法确认',
        detail: '不能将保留版本当作当前计划；请打开技术详情查看原因。',
      }
    case 'task-plan-history.read-failed':
      return {
        title: '任务计划暂时无法读取',
        detail: '任务状态不能据此判定；请打开技术详情查看原因和处理建议。',
      }
    case 'task-plan-history.current-mismatch':
      return {
        title: '当前计划版本与任务记录不一致',
        detail: '页面不会用其他版本替代当前计划；请打开技术详情查看原因。',
      }
    case 'task-plan-history.scope-mismatch':
      return {
        title: '计划内容不属于当前任务范围',
        detail: '页面不会展示其他任务范围的计划；请打开技术详情查看原因。',
      }
    case 'task-plan-history.selection-partial':
    case 'task-plan-history.selection-unknown':
    case 'task-plan-history.selection-mismatch':
      return {
        title: '无法确认所选计划版本',
        detail: '页面不会把其他版本当作所选内容；请打开技术详情查看原因。',
      }
    default:
      return {
        title: '计划内容无法显示',
        detail: '计划读取仍为失败状态；请打开技术详情查看原因和处理建议。',
      }
  }
}

function renderPlanFailure(failure, prefix, options = {}) {
  const box = element('div', undefined, 'plan-failure')
  box.planFailure = failure && typeof failure === 'object'
    ? failure
    : planFailure('task-plan-history.failed', String(failure ?? '计划读取失败'), 'refresh the task projection read')
  box.dataset.planFailure = box.planFailure.code || 'task-plan-history.failed'
  box.setAttribute('role', 'alert')
  const presentation = planFailurePresentation(box.planFailure)
  if (prefix) box.append(element('p', prefix, 'muted'))
  box.append(
    element('strong', presentation.title),
    element('p', presentation.detail, 'muted'),
    planDetail('技术详情', [
      ['code', box.planFailure.code],
      ['owner', box.planFailure.ownerId],
      ['message', box.planFailure.message],
      ['nextAction', box.planFailure.nextAction],
    ], options),
  )
  return box
}

function actualGraphDetail(summary, entries, options = {}) {
  if (typeof options.onOpenDetail !== 'function') return null
  const button = element('button', '查看记录详情', 'button button--quiet plan-detail')
  button.type = 'button'
  button.dataset.actualGraphDetail = summary
  button.addEventListener('click', () => options.onOpenDetail({ title: summary, entries }, button))
  return button
}

function actualNodeDetailEntries(technical) {
  const entries = [
    ['节点标识', technical.nodeId],
    ['记录类型', technical.nodeKind],
    ['任务标识', technical.taskIdValue],
    ['分配标识', technical.assignmentId],
    ...(technical.instance === undefined ? [] : [['执行实例', JSON.stringify(technical.instance)]]),
    ...(technical.executionEpoch === undefined ? [] : [['执行轮次序号', String(technical.executionEpoch)]]),
    ...(technical.businessTurnId === undefined ? [] : [['业务轮次标识', technical.businessTurnId]]),
    ...(technical.segmentId === undefined ? [] : [['分段标识', technical.segmentId]]),
    ...(technical.pipelineNodeId === undefined ? [] : [['流程节点', technical.pipelineNodeId]]),
    ...(technical.invocationId === undefined ? [] : [['调用标识', technical.invocationId]]),
    ...(technical.childTurnId === undefined ? [] : [['子任务轮次标识', technical.childTurnId]]),
    ...(technical.checkpointReceiptRef === undefined ? [] : [['检查点接收引用', technical.checkpointReceiptRef]]),
    ...(technical.containingLocationKind === undefined ? [] : [['所在位置', technical.containingLocationKind]]),
    ...(technical.containingLocationBusinessTurnId === undefined ? [] : [['所在业务轮次', technical.containingLocationBusinessTurnId]]),
    ...(technical.containingLocationSegmentId === undefined ? [] : [['所在分段', technical.containingLocationSegmentId]]),
    ['提交引用', JSON.stringify(technical.commitRefs ?? [])],
    ['证据引用', JSON.stringify(technical.evidenceRefs ?? [])],
  ]
  if (technical.missingSource !== undefined) entries.push(['缺失来源', technical.missingSource])
  if (technical.message !== undefined) entries.push(['原始记录', technical.message])
  return entries
}

function renderActualNode(node, options) {
  const item = element('li', undefined, 'actual-execution-node')
  item.dataset.actualExecutionNode = node.nodeId
  item.dataset.actualNodeKind = node.kind
  item.dataset.actualNodeStateTone = node.summary.stateTone
  const head = element('header', undefined, 'plan-revision-head')
  head.append(
    element('strong', node.summary.roleLabel, 'plan-node-title'),
    element('span', node.summary.stateLabel, 'plan-tag'),
  )
  item.append(head)
  if (node.summary.objective) {
    item.append(element('p', node.summary.objective, 'business-output-text actual-execution-objective'))
  }
  const outcome = node.summary.outcomeLabel
  const resultSummary = node.summary.resultSummary
  if (outcome && resultSummary) {
    item.append(element('p', `结果（${outcome}）：${resultSummary}`, 'actual-execution-result'))
  } else if (outcome) {
    item.append(element('p', `结论：${outcome}`, 'actual-execution-result'))
  } else if (resultSummary) {
    item.append(element('p', `结果：${resultSummary}`, 'actual-execution-result'))
  }
  if (node.summary.adoptionLabel) {
    item.append(element('p', `采用情况：${node.summary.adoptionLabel}`, 'muted actual-execution-adoption'))
  }
  if (node.summary.decisionLabel) {
    item.append(element('p', `判定：${node.summary.decisionLabel}`, 'muted actual-execution-decision'))
  }
  if (node.summary.nextActionLabel) {
    item.append(element('p', `下一步：${node.summary.nextActionLabel}`, 'muted actual-execution-next'))
  }
  if (node.summary.reason) {
    item.append(element('p', `说明：${node.summary.reason}`, 'muted actual-execution-reason'))
  }
  const detail = actualGraphDetail('执行记录详情', actualNodeDetailEntries(node.technical), options)
  if (detail) item.append(detail)
  return item
}

function renderActualGroup(group, options) {
  const article = element('section', undefined, 'plan-phase actual-execution-group')
  article.dataset.actualExecutionGroup = group.groupId
  article.append(
    element('h4', group.label),
    element('p', group.purpose, 'muted actual-execution-group-purpose'),
  )
  const list = element('ol', undefined, 'plan-node-list actual-execution-nodes')
  for (const node of group.nodes) list.append(renderActualNode(node, options))
  if (group.nodes.length === 0) {
    list.append(element('li', '这个分组尚无已记录的执行记录。', 'empty actual-execution-empty-group'))
  }
  article.append(list)
  return article
}

function renderActualEdges(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return null
  const section = element('section', undefined, 'actual-execution-edges-section')
  section.dataset.actualExecutionEdges = 'recorded'
  section.append(element('h4', '已记录的执行关系'))
  const list = element('ul', undefined, 'actual-execution-edges')
  for (const edge of edges) {
    const item = element('li', undefined, 'actual-execution-edge')
    item.dataset.actualExecutionEdgeKind = edge.kind
    item.append(element('span', edge.detail, 'actual-execution-edge-text'))
    list.append(item)
  }
  section.append(list)
  return section
}

function renderActualUngrouped(relations, options) {
  if (!Array.isArray(relations) || relations.length === 0) return null
  const section = element('section', undefined, 'actual-execution-ungrouped-section')
  section.dataset.actualExecutionUngrouped = 'recorded'
  section.append(element('h4', '未归组的关系'))
  const list = element('ul', undefined, 'actual-execution-ungrouped')
  for (const relation of relations) {
    const item = element('li', undefined, 'actual-execution-ungrouped-item')
    item.dataset.actualUngroupedNode = relation.nodeId
    item.append(
      element('span', relation.label, 'actual-execution-ungrouped-label'),
      element(
        'span',
        '关联目标未出现在已记录的执行节点中，原始原因可在任务详情中查看。',
        'muted actual-execution-ungrouped-detail',
      ),
    )
    const detail = actualGraphDetail('未归组关系详情', [
      ['节点标识', relation.nodeId],
      ['原始原因', relation.detail],
    ], options)
    if (detail) item.append(detail)
    list.append(item)
  }
  section.append(list)
  return section
}

function renderActualUnavailable(sources, options) {
  if (!Array.isArray(sources) || sources.length === 0) return null
  const section = element('section', undefined, 'actual-execution-unavailable-section')
  section.dataset.actualExecutionUnavailable = 'recorded'
  section.append(element('h4', '部分执行来源不可用'))
  const list = element('ul', undefined, 'actual-execution-unavailable')
  for (const source of sources) {
    const item = element('li', undefined, 'actual-execution-unavailable-item')
    item.dataset.actualUnavailableSource = source.sourceId
    item.append(
      element('span', source.label, 'actual-execution-unavailable-label'),
      element(
        'span',
        '部分执行来源记录暂时无法读取，原始信息可在任务详情中查看。',
        'muted actual-execution-unavailable-detail',
      ),
    )
    const detail = actualGraphDetail('来源不可用详情', [
      ['来源标识', source.sourceId],
      ['原始信息', source.detail],
    ], options)
    if (detail) item.append(detail)
    list.append(item)
  }
  section.append(list)
  return section
}

/**
 * Read-only shared renderer for the actual execution graph carrier.
 *
 * Guidance, recorded groups, nodes and relations come from the UI projection.
 * This function never reads a plan, registry, Journal or control surface and
 * never derives a node state from neighbours. Raw IDs stay behind the optional
 * existing technical-detail callback.
 */
export function renderTaskActualExecutionGraphSection(graph, options = {}) {
  const section = element('section', undefined, 'section actual-execution-graph-section')
  section.dataset.actualExecutionGraph = graph?.history?.status || 'missing'
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', '任务处理方式与实际执行'),
    element('span', '只读记录', 'section-meta'),
  )
  section.append(head)

  if (!graph || graph.surface !== 'task-actual-execution-graph') {
    section.append(element('p', '本次读取没有提供实际执行图记录。', 'empty actual-execution-graph-missing'))
    return section
  }

  if (graph.guidance) {
    const guidance = element('section', undefined, 'task-flow-guidance')
    guidance.dataset.taskFlowGuidance = 'skeleton'
    guidance.dataset.taskFlowKind = graph.guidance.kind
    const guidanceDetail = actualGraphDetail('处理方式详情', [
      ['kind', graph.guidance.kind],
      ['aim', graph.guidance.aim],
      ['selectionGuidance', graph.guidance.selectionGuidance],
      ['displayGroups', JSON.stringify(graph.guidance.displayGroups)],
    ], options)
    guidance.append(
      element('h3', `处理方式：${graph.guidance.kindLabel}`),
      element('p', graph.guidance.aim, 'business-output-text'),
    )
    if (guidanceDetail) guidance.append(guidanceDetail)
    section.append(guidance)
  }

  const history = graph.history
  if (history.status === 'not-recorded') {
    const missing = element('section', undefined, 'actual-execution-history-missing')
    missing.dataset.actualExecutionHistory = 'not-recorded'
    missing.append(
      element('h3', history.label),
      element('p', history.detail, 'muted'),
    )
    section.append(missing)
    const unavailable = renderActualUnavailable(history.unavailable, options)
    if (unavailable) section.append(unavailable)
    return section
  }

  const recorded = element('section', undefined, 'actual-execution-history')
  recorded.dataset.actualExecutionHistory = 'recorded'
  recorded.append(
    element('h3', '已记录的实际执行'),
    element('p', history.summary, 'muted actual-execution-summary'),
  )
  for (const group of history.groups) recorded.append(renderActualGroup(group, options))
  const edges = renderActualEdges(history.edges)
  if (edges) recorded.append(edges)
  const ungrouped = renderActualUngrouped(history.ungrouped, options)
  if (ungrouped) recorded.append(ungrouped)
  const unavailable = renderActualUnavailable(history.unavailable, options)
  if (unavailable) recorded.append(unavailable)
  section.append(recorded)
  return section
}

function renderPlanNode(node, options) {
  const item = element('li', undefined, 'plan-node')
  item.dataset.planNode = node.nodeId
  item.dataset.planNodeKind = node.kind
  const kindLabel = PLAN_NODE_KIND_LABELS[node.kind] || (node.kind ? '计划节点' : '类型未声明')
  item.append(
    element('strong', node.title || '未命名节点', 'plan-node-title'),
    element('span', kindLabel, 'plan-node-kind'),
    element('p', node.intent || '未声明意图', 'muted plan-node-intent'),
    planDetail('节点详情', [
      ['nodeId', node.nodeId],
      ['kind', node.kind],
      ['phaseId', node.phaseId ?? '未归入阶段'],
      ['definition', JSON.stringify(node.definition ?? {})],
    ], options),
  )
  return item
}

/**
 * One typed plan snapshot: summary, acceptance criteria, phases, member nodes
 * and the declared relations. This is the actual plan content, not a version
 * label or a scheduling plan.
 */
export function renderTaskPlanSnapshot(snapshot, options = {}) {
  const section = element('section', undefined, 'plan-snapshot')
  section.dataset.planSnapshot = options.revisionId ?? ''
  const head = element('header', undefined, 'section-head')
  head.append(
    element('h3', snapshot?.title || '未命名计划'),
    element('span', planCompletenessLabel(snapshot?.completeness), 'section-meta'),
  )
  section.append(head)
  if (snapshot?.summary) section.append(element('p', snapshot.summary, 'muted plan-summary'))

  const criteria = element('section', undefined, 'plan-criteria')
  criteria.append(element('h4', '验收标准'))
  const criteriaList = element('ul', undefined, 'plan-criteria-list')
  for (const criterion of snapshot?.acceptanceCriteria ?? []) {
    criteriaList.append(element('li', criterion.description || criterion.criterionId))
  }
  if (criteriaList.children.length === 0) criteriaList.append(element('li', '未声明验收标准。', 'empty'))
  criteria.append(criteriaList)
  section.append(criteria)

  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]))
  const phased = new Set()
  const graph = element('div', undefined, 'plan-graph')
  for (const phase of snapshot?.phases ?? []) {
    const phaseSection = element('section', undefined, 'plan-phase')
    phaseSection.dataset.planPhase = phase.phaseId
    phaseSection.append(element('h4', phase.title || phase.phaseId))
    const list = element('ol', undefined, 'plan-node-list')
    for (const nodeId of phase.memberNodeIds ?? []) {
      const node = nodeById.get(nodeId)
      if (!node) continue
      phased.add(nodeId)
      list.append(renderPlanNode(node, options))
    }
    if (list.children.length === 0) list.append(element('li', '这个阶段没有已声明的节点。', 'empty'))
    phaseSection.append(list)
    graph.append(phaseSection)
  }
  const unphased = nodes.filter((node) => node.phaseId === undefined && !phased.has(node.nodeId))
  if (unphased.length > 0) {
    const phaseSection = element('section', undefined, 'plan-phase')
    phaseSection.dataset.planPhase = ''
    phaseSection.append(element('h4', '未归入阶段的节点'))
    const list = element('ol', undefined, 'plan-node-list')
    for (const node of unphased) list.append(renderPlanNode(node, options))
    phaseSection.append(list)
    graph.append(phaseSection)
  }
  if (graph.children.length === 0) graph.append(element('p', '这个计划没有已声明的阶段或节点。', 'empty'))
  section.append(graph)

  const edgeSection = element('section', undefined, 'plan-edges-section')
  edgeSection.append(element('h4', '节点关系'))
  const edgeList = element('ul', undefined, 'plan-edges')
  for (const relation of snapshot?.relations ?? []) {
    const from = nodeById.get(relation.fromNodeId)
    const to = nodeById.get(relation.toNodeId)
    const item = element('li', undefined, 'plan-edge')
    item.dataset.relationKind = relation.kind
    item.dataset.fromNode = relation.fromNodeId
    item.dataset.toNode = relation.toNodeId
    item.append(
      element('span', from?.title || relation.fromNodeId, 'plan-edge-node'),
      element('span', planRelationLabel(relation.kind), 'plan-edge-kind'),
      element('span', to?.title || relation.toNodeId, 'plan-edge-node'),
    )
    edgeList.append(item)
  }
  if (edgeList.children.length === 0) edgeList.append(element('li', '这个计划没有已声明的节点关系。', 'empty'))
  edgeSection.append(edgeList)
  section.append(edgeSection)
  return section
}

function renderEvidenceList(refs, options, label) {
  const section = element('section', undefined, 'plan-evidence')
  section.append(element('h4', label))
  if (!Array.isArray(refs) || refs.length === 0) {
    section.append(element('p', '未记录证据引用。', 'muted'))
    return section
  }
  const list = element('ul', undefined, 'plan-evidence-list')
  for (const ref of refs) {
    const item = element('li', undefined, 'plan-evidence-item')
    item.dataset.evidenceKind = ref?.kind || ''
    item.dataset.evidenceSource = ref?.source || ''
    item.append(element('span', typeof options.onOpenDetail === 'function'
      ? `证据 ${list.children.length + 1}`
      : `${ref?.kind || '未声明类型'} · ${ref?.source || '未提供来源'} · ${ref?.locator || '未提供位置'}`, 'plan-evidence-ref'))
    const trigger = typeof options.onEvidenceRef === 'function' ? options.onEvidenceRef(ref) : null
    if (trigger) {
      item.append(trigger)
    } else {
      item.append(element('span', '证据读取器尚未接入', 'muted plan-evidence-unbound'))
    }
    if (typeof options.onOpenDetail !== 'function') item.append(planDetail('证据引用', [
      ['evidenceId', ref?.evidenceId?.value],
      ['kind', ref?.kind],
      ['source', ref?.source],
      ['locator', ref?.locator],
      ['digest', ref?.digest],
      ['scope.organId', ref?.scope?.organId?.value],
      ['scope.taskId', ref?.scope?.taskId?.value],
      ['scope.operationId', ref?.scope?.operationId?.value],
    ]))
    list.append(item)
  }
  section.append(list)
  return section
}

function renderPlanChanges(changes) {
  const section = element('section', undefined, 'plan-changes')
  section.append(element('h4', '与上一保留版本的变化'))
  if (changes.baseline) {
    section.append(element('p', '这是保留历史的起点，没有上一保留版本。', 'muted'))
    return section
  }
  const lines = []
  for (const node of changes.nodes.added) lines.push(`新增节点：${node.title || node.nodeId}`)
  for (const node of changes.nodes.removed) lines.push(`移除节点：${node.title || node.nodeId}`)
  for (const change of changes.nodes.changed) lines.push(`节点更新：${change.after.title || change.nodeId}（${change.fields.join('、')}）`)
  for (const phase of changes.phases.added) lines.push(`新增阶段：${phase.title || phase.phaseId}`)
  for (const phase of changes.phases.removed) lines.push(`移除阶段：${phase.title || phase.phaseId}`)
  for (const change of changes.phases.changed) lines.push(`阶段更新：${change.after.title || change.phaseId}（${change.fields.join('、')}）`)
  for (const relation of changes.relations.added) lines.push(`新增关系：${relation.fromNodeId} ${planRelationLabel(relation.kind)} ${relation.toNodeId}`)
  for (const relation of changes.relations.removed) lines.push(`移除关系：${relation.fromNodeId} ${planRelationLabel(relation.kind)} ${relation.toNodeId}`)
  if (lines.length === 0) {
    section.append(element('p', '与上一保留版本相比，没有已声明的计划变化。', 'muted'))
    return section
  }
  const list = element('ul', undefined, 'plan-change-list')
  for (const line of lines) list.append(element('li', line))
  section.append(list)
  return section
}

function renderTaskPlanRevision(revision, options = {}) {
  const article = element('article', undefined, 'plan-revision')
  article.dataset.planRevision = revision.revisionId
  article.dataset.planSequence = String(revision.sequence)
  const head = element('header', undefined, 'plan-revision-head')
  head.append(element('h3', `版本 ${revision.sequence} · ${revision.snapshot?.title || revision.revisionId}`))
  const tags = element('div', undefined, 'plan-revision-tags')
  if (options.isCurrent) tags.append(element('span', '当前权威版本', 'plan-tag plan-tag--current'))
  if (options.isViewed) tags.append(element('span', '正在查看', 'plan-tag plan-tag--viewed'))
  if (tags.children.length > 0) head.append(tags)
  article.append(head)

  const reason = revision.reason || {}
  const reasonSection = element('section', undefined, 'plan-reason')
  reasonSection.append(
    element('h4', '为什么'),
    element('p', `${planReasonKindLabel(reason.kind)}：${planReasonText(reason)}`),
  )
  reasonSection.append(renderEvidenceList(reason.basisRefs, options, '原因依据'))
  article.append(reasonSection)

  article.append(element('p', revision.predecessor
    ? `上一版本：序列 ${revision.predecessor.sequence} · ${revision.predecessor.revisionId}`
    : '上一版本：无（这是保留历史的起点）', 'muted plan-predecessor'))
  article.append(element('p', planCoverageLabel(revision.historyCoverage), 'muted plan-coverage'))
  article.append(renderPlanChanges(options.changes || planRevisionChanges(null, revision.snapshot)))
  article.append(renderTaskPlanSnapshot(revision.snapshot, { ...options, revisionId: revision.revisionId }))
  article.append(renderEvidenceList(revision.evidenceRefs, options, '来源证据'))
  article.append(planDetail('版本身份', [
    ['revisionId', revision.revisionId],
    ['sequence', String(revision.sequence)],
    ['journalCommitRef', revision.journalCommitRef],
    ['publishedAt', revision.publishedAt],
  ], options))
  return article
}

function renderPlanConflict(selection) {
  const box = element('div', undefined, 'plan-failure plan-conflict')
  box.dataset.planConflict = 'current-vs-viewed'
  box.setAttribute('role', 'alert')
  box.append(
    element('strong', 'URL 同时要求当前内容和一个旧计划版本。'),
    element('p', `当前内容只显示 Runtime 接受的当前版本；URL 里的旧版本选择（${selection?.revisionId || '未提供'}）没有被当作当前版本。`, 'muted'),
  )
  return box
}

/**
 * Current reading surface. It resolves and renders exactly one accepted
 * snapshot. An unknown current, a scope mismatch or a failed history read is
 * shown as an explicit failure, never as a substitute schedule plan.
 */
export function renderTaskPlanCurrentSection(read, options = {}) {
  const section = element('section', undefined, 'section plan-current-section')
  section.dataset.planHistory = 'current'
  const head = element('header', undefined, 'section-head')
  head.append(element('h2', '当前任务计划'), element('span', '权威推理计划', 'section-meta'))
  section.append(head)
  if (!read || read.ok !== true) {
    section.planFailure = read?.failure || planHistoryAvailability(undefined).failure
    section.append(renderPlanFailure(section.planFailure, undefined, options))
    return section
  }
  const resolved = resolveCurrentPlanRevision(read.value, { explicitScope: options.explicitScope })
  if (!resolved.ok) {
    section.planFailure = resolved.failure
    section.append(renderPlanFailure(section.planFailure, undefined, options))
    return section
  }
  if (options.conflictSelection) section.append(renderPlanConflict(options.conflictSelection))
  const revisions = planRevisions(read.value)
  const previous = resolved.index > 0 ? revisions[resolved.index - 1] : null
  const revisionOptions = {
    ...options,
    isCurrent: true,
    changes: planRevisionChanges(previous?.snapshot ?? null, resolved.revision.snapshot),
  }
  if (typeof options.onOpenDetail !== 'function') {
    section.append(renderTaskPlanRevision(resolved.revision, revisionOptions))
    return section
  }
  const revision = resolved.revision
  section.append(
    element('h3', revision.snapshot?.title || '未命名计划'),
    element('p', revision.snapshot?.summary || '未记录计划摘要', 'muted plan-summary'),
    element('p', `当前权威版本 · 版本 ${revision.sequence}`, 'plan-tag plan-tag--current'),
    element('p', planCompletenessLabel(revision.snapshot?.completeness), 'muted'),
  )
  const button = element('button', '查看计划详情', 'button button--quiet')
  button.type = 'button'
  button.dataset.planDetailTrigger = 'current'
  const openChild = (detail) => options.onOpenDetail({ ...detail, onBack: showRevision }, button)
  const showRevision = () => options.onOpenDetail({
    title: '当前任务计划详情',
    content: renderTaskPlanRevision(revision, {
      ...revisionOptions,
      onOpenDetail: openChild,
      onEvidenceRef: typeof options.onEvidenceRef === 'function'
        ? (ref) => options.onEvidenceRef(ref, { onOpenDetail: openChild })
        : undefined,
    }),
  }, button)
  button.addEventListener('click', showRevision)
  section.append(button)
  return section
}

/**
 * Semantic reading surface. It renders every returned revision in the exact
 * returned order and never sorts by timestamp or slices to a tail. Current and
 * viewed identities stay separate, and an unknown current still leaves known
 * retained history visible.
 */
export function renderTaskPlanSemanticView(read, options = {}) {
  const section = element('section', undefined, 'section plan-history-section')
  section.dataset.planHistory = 'semantic'
  if (!read || read.ok !== true) {
    section.planFailure = read?.failure || planHistoryAvailability(undefined).failure
    const head = element('header', undefined, 'section-head')
    head.append(element('h2', '任务计划历史'), element('span', '权威推理计划', 'section-meta'))
    section.append(head, renderPlanFailure(section.planFailure, undefined, options))
    return section
  }

  const history = read.value
  const revisions = planRevisions(history)
  const currentResolved = resolveCurrentPlanRevision(history, { explicitScope: options.explicitScope })
  const viewedResolved = resolveViewedPlanRevision(history, options.selection, { explicitScope: options.explicitScope })

  const head = element('header', undefined, 'section-head')
  head.append(
    element('h2', '任务计划历史'),
    element('span', `${revisions.length} 个保留版本 · 按发布顺序`, 'section-meta'),
  )
  section.append(head)

  if (currentResolved.ok) {
    section.append(element('p', `当前权威版本：序列 ${currentResolved.revision.sequence} · ${currentResolved.revision.revisionId}。`, 'muted plan-current-summary'))
  } else {
    section.planFailure = currentResolved.failure
    section.append(renderPlanFailure(currentResolved.failure, '当前权威版本未知；下面的保留历史仍然可用。', options))
  }
  if (!viewedResolved.ok) {
    section.planFailure = viewedResolved.failure
    section.append(renderPlanFailure(viewedResolved.failure, undefined, options))
  }

  if (revisions.length === 0) {
    section.append(element('p', '这个任务还没有保留的计划版本。', 'empty'))
    return section
  }

  const list = element('div', undefined, 'plan-revision-list')
  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index]
    const previous = index > 0 ? revisions[index - 1] : null
    const isCurrent = currentResolved.ok && currentResolved.revision.revisionId === revision.revisionId
    const isViewed = viewedResolved.ok
      && viewedResolved.revision !== null
      && viewedResolved.revision.revisionId === revision.revisionId
    const item = renderTaskPlanRevision(revision, {
      ...options,
      isCurrent,
      isViewed,
      changes: planRevisionChanges(previous?.snapshot ?? null, revision.snapshot),
    })
    if (typeof options.onSelectRevision === 'function') {
      const select = element('button', isViewed ? '正在查看此版本' : '查看此版本', 'button button--quiet plan-view-revision')
      select.type = 'button'
      select.disabled = isViewed
      select.addEventListener('click', () => options.onSelectRevision(revision))
      item.append(select)
    }
    list.append(item)
  }
  section.append(list)
  return section
}
