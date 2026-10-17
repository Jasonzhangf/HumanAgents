import test from 'node:test'
import assert from 'node:assert/strict'
import {
  renderAgentActivity, renderAgentActivityDetail,
  agentActivitySelectionFromQuery, agentActivityQuery,
} from '../../docs/ui/agent-activity.js'

// An element port, not a second renderer. Tests consume actual exported UI code.
class Element {
  constructor(tag, text, className) {
    this.tag = tag
    this.textContent = text ?? ''
    this.className = className ?? ''
    this.children = []
    this.attributes = {}
    this.listeners = new Map()
  }
  append(...children) { this.children.push(...children) }
  setAttribute(key, value) { this.attributes[key] = value }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(callback)
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback) }
  click() { for (const callback of this.listeners.get('click') ?? []) callback() }
}
const element = (tag, text, className) => new Element(tag, text, className)
const nodes = (root) => [root, ...root.children.flatMap(nodes)]
const text = (root) => nodes(root).map((node) => node.textContent).join('\n')
const buttons = (root, label) => nodes(root).filter((node) => node.tag === 'button' && node.textContent === label)
const section = (root, title) => nodes(root).find((node) =>
  node.tag === 'section' && node.children[0]?.textContent === title)
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const taskId = freeze({ scope: 'task', value: 'task-exact' })
const instance = (id, epoch) => ({
  kind: 'incarnation', label: '运行实例', runtimeId: `runtime-${id}`,
  executionEpoch: epoch, roleId: 'same-role', generation: epoch, agentInstanceId: `agent-${id}`,
})
const evidenceRef = {
  evidenceId: { scope: 'evidence', value: 'evidence-old' }, kind: 'external',
  source: 'journal-source', locator: 'unsupported:opaque-receipt', digest: 'digest-old',
  scope: { organId: { scope: 'organ', value: 'organ-exact' }, taskId },
}
const entry = (id, currency, epoch) => ({
  taskId, instance: instance(id, epoch), assignmentId: `assignment-${id}`, attempt: 7,
  executionEpoch: epoch, objective: '核对同一目标', businessTurnId: `turn-${id}`,
  segmentId: `segment-${id}`, nodeId: `node-${id}`, sourceKind: 'incarnation',
  sourceKindLabel: '运行实例记录', currency,
  currencyLabel: { current: '当前运行', historical: '历史记录', unknown: '当前归属未知' }[currency],
  commitRefs: [{ commitId: `commit-${id}`, journalSeq: epoch, recordDigest: `digest-${id}` }],
  evidenceRefs: [evidenceRef],
})
const first = entry('first', 'current', 3)
const second = entry('second', 'current', 4)
const old = entry('old', 'historical', 1)
const native = {
  ...entry('native', 'unknown', 2),
  instance: { kind: 'native-execution', label: '原生执行', runtimeId: 'runtime-native', executionEpoch: 2 },
  sourceKind: 'active-turn', sourceKindLabel: '原生执行记录',
  missingSource: '缺少当前归属来源',
}
const catalog = freeze({ ok: true, value: {
  surface: 'runtime-agent-activity', scope: { kind: 'task', projectKey: 'project-exact', mode: 'fake', taskId },
  taskId, mode: 'catalog', current: [first, second], historical: [old], unknown: [native],
  unavailableSources: [{ sourceId: 'cold', ownerId: 'journal', message: '历史来源暂不可用' }],
} })
const selected = freeze({ ok: true, value: {
  ...catalog.value, mode: 'selected', selectedInstance: old.instance, selected: [old],
} })
// Explicit expected public references; no implementation of the selection mapper.
const firstSelection = {
  taskId, instance: { kind: 'incarnation', incarnation: {
    runtimeId: 'runtime-first', executionEpoch: 3, roleId: 'same-role', generation: 3,
    agentInstanceId: 'agent-first', taskId, assignmentId: 'assignment-first',
  } },
  assignmentId: 'assignment-first', attempt: 7, businessTurnId: 'turn-first',
  segmentId: 'segment-first', nodeId: 'node-first',
}
const secondSelection = {
  taskId, instance: { kind: 'incarnation', incarnation: {
    runtimeId: 'runtime-second', executionEpoch: 4, roleId: 'same-role', generation: 4,
    agentInstanceId: 'agent-second', taskId, assignmentId: 'assignment-second',
  } },
  assignmentId: 'assignment-second', attempt: 7, businessTurnId: 'turn-second',
  segmentId: 'segment-second', nodeId: 'node-second',
}
const oldSelection = {
  taskId, instance: { kind: 'incarnation', incarnation: {
    runtimeId: 'runtime-old', executionEpoch: 1, roleId: 'same-role', generation: 1,
    agentInstanceId: 'agent-old', taskId, assignmentId: 'assignment-old',
  } },
  assignmentId: 'assignment-old', attempt: 7, businessTurnId: 'turn-old',
  segmentId: 'segment-old', nodeId: 'node-old',
}
const nativeSelection = {
  taskId, instance: { kind: 'native-execution', execution: { runtimeId: 'runtime-native', executionEpoch: 2 } },
  assignmentId: 'assignment-native', attempt: 7, businessTurnId: 'turn-native',
  segmentId: 'segment-native', nodeId: 'node-native',
}

// Failure basis: same-role collapse / viewed-current ambiguity can navigate to
// the wrong execution. Probability unknown; exported consumer cost is low.
test('catalog keeps both same-role instances and every historical/unknown entry with exact actions', () => {
  const selections = []
  const details = []
  const view = renderAgentActivity(catalog, { element, onSelect: (value) => selections.push(value), onOpenDetail: (value) => details.push(value) })
  const current = section(view.element, '当前运行')
  assert.equal(nodes(current).filter((node) => node.tag === 'article').length, 2)
  assert.equal(nodes(view.element).filter((node) => node.tag === 'article').length, 4)
  assert.equal(section(view.element, '正在查看的实例'), undefined)
  assert.match(text(view.element), /历史来源暂不可用/)
  assert.match(text(view.element), /缺少当前归属来源/)
  assert.match(text(view.element), /核对同一目标/)
  assert.doesNotMatch(text(view.element), /runtime-first|agent-first|same-role|assignment-first|node-first/)
  const select = buttons(view.element, '查看此实例')
  select.forEach((button) => button.click())
  assert.deepEqual(selections, [firstSelection, secondSelection, oldSelection, nativeSelection])
  buttons(view.element, '查看记录详情')[1].click()
  assert.deepEqual(details[0].selection, secondSelection)
  assert.equal(details[0].entry, second)
  view.dispose()
  view.dispose()
  select[0].click()
  buttons(view.element, '查看记录详情')[1].click()
  assert.equal(selections.length, 4)
  assert.equal(details.length, 1)
  assert.equal(nodes(view.element).reduce((count, node) => count + [...node.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0), 0)
})

test('historical selected detail keeps current facts and exact node/commit/evidence refs', () => {
  const details = []
  const view = renderAgentActivity(selected, { element })
  const viewed = section(view.element, '正在查看的实例')
  assert.match(text(viewed), /历史记录/)
  assert.doesNotMatch(text(viewed), /当前运行/)
  assert.equal(nodes(section(view.element, '当前运行')).filter((node) => node.tag === 'article').length, 2)
  assert.equal(buttons(view.element, '查看此实例').length, 0)
  assert.equal(buttons(view.element, '查看记录详情').length, 0)
  const detail = renderAgentActivityDetail(selected, { element, onOpenDetail: (value) => details.push(value) })
  for (const value of ['runtime-old', 'agent-old', 'same-role', 'assignment-old', 'turn-old', 'segment-old', 'node-old', 'commit-old', 'digest-old', 'evidence-old', 'unsupported:opaque-receipt', '7']) {
    assert.ok(text(detail.element).includes(value), `detail includes ${value}`)
  }
  buttons(detail.element, '查看关联节点')[0].click()
  buttons(detail.element, '查看提交凭据')[0].click()
  buttons(detail.element, '查看证据引用')[0].click()
  assert.deepEqual(details.map((value) => value.kind), ['node', 'commit', 'evidence'])
  for (const detail of details) assert.deepEqual(detail.selection, oldSelection)
  assert.equal(details[0].nodeId, old.nodeId)
  assert.equal(details[1].commitRef, old.commitRefs[0])
  assert.equal(details[2].evidenceRef, old.evidenceRefs[0])
  assert.equal(nodes(detail.element).some((node) => node.tag === 'a' || 'href' in node.attributes), false)
  const passive = renderAgentActivityDetail(selected, { element })
  assert.equal(nodes(passive.element).filter((node) => node.tag === 'button').length, 0)
  detail.dispose()
  buttons(detail.element, '查看关联节点')[0].click()
  assert.equal(details.length, 3)
  view.dispose()
  passive.dispose()
  assert.equal(selected.value.selected[0].currency, 'historical')
  assert.equal(catalog.value.current[0], first)
})

test('query roundtrip preserves parent parameters and distinguishes tagged identities without confirming them', () => {
  const parent = new URLSearchParams('task=task-exact&project=p&mode=live&display=compact&planRevision=r&planPublication=pub&checkpoint=c&cycle=cy&occurrence=o&other=one&other=two&projectKey=original&view=activity')
  const original = parent.toString()
  assert.deepEqual(agentActivitySelectionFromQuery(parent, taskId), { ok: true, value: { taskId } })
  for (const selection of [oldSelection, nativeSelection,
    { taskId, instance: nativeSelection.instance, assignmentId: 'assignment-native' },
    { taskId, instance: nativeSelection.instance, attempt: 7 },
  ]) {
    const encoded = agentActivityQuery(parent, selection)
    assert.equal(encoded.ok, true, encoded.failure?.message)
    assert.notEqual(encoded.value, parent)
    assert.deepEqual(agentActivitySelectionFromQuery(encoded.value, taskId), { ok: true, value: selection })
    const stripped = new URLSearchParams([...encoded.value].filter(([key]) => !key.startsWith('agent')))
    assert.equal(stripped.toString(), original)
    const cleared = agentActivityQuery(encoded.value, { taskId })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.value.toString(), original)
  }
  const incarnation = { taskId, instance: oldSelection.instance }
  const encoded = agentActivityQuery(parent, incarnation)
  assert.equal(encoded.ok, true, encoded.failure?.message)
  assert.deepEqual(agentActivitySelectionFromQuery(encoded.value, taskId), {
    ok: true, value: { ...incarnation, assignmentId: 'assignment-old' },
  })
  assert.equal(encoded.value.has('agentAttempt'), false)
  const unknownParent = new URLSearchParams('agentFoo=1&projectKey=original&mode=rcc&view=activity')
  const unknownOriginal = unknownParent.toString()
  const decoded = agentActivitySelectionFromQuery(unknownParent, taskId)
  assert.equal(decoded.ok, false)
  assert.equal(decoded.failure.code, 'agent-activity.invalid-selection')
  const unknownEncoded = agentActivityQuery(unknownParent, nativeSelection)
  assert.equal(unknownEncoded.ok, false)
  assert.equal(unknownEncoded.failure.code, 'agent-activity.invalid-selection')
  assert.equal(unknownParent.toString(), unknownOriginal)
  assert.equal(parent.toString(), original)
})

test('partial, malformed and contradictory explicit selection fails visibly; source failure stays failure', () => {
  const partial = agentActivitySelectionFromQuery(new URLSearchParams('agentRuntimeId=runtime-old'), taskId)
  assert.equal(partial.ok, false)
  assert.equal(partial.failure.code, 'agent-activity.invalid-selection')
  assert.equal(agentActivitySelectionFromQuery(new URLSearchParams('agentKind=native-execution&agentRuntimeId=r&agentExecutionEpoch=1&agentRoleId=role'), taskId).ok, false)
  assert.equal(agentActivitySelectionFromQuery(new URLSearchParams('agentKind=native-execution&agentRuntimeId=r&agentExecutionEpoch=01'), taskId).ok, false)
  assert.equal(agentActivitySelectionFromQuery(new URLSearchParams('agentKind=native-execution&agentRuntimeId=r&agentExecutionEpoch=1&agentRuntimeId=s'), taskId).ok, false)
  const conflict = { ...oldSelection, instance: { ...oldSelection.instance } }
  conflict.instance.incarnation = { ...conflict.instance.incarnation, assignmentId: 'foreign' }
  assert.equal(agentActivityQuery(new URLSearchParams(), conflict).ok, false)
  const failure = { ok: false, failure: { code: 'source-conflict', ownerId: 'runtime-observation', message: '记录身份不一致', nextAction: '检查来源绑定' } }
  for (const renderer of [renderAgentActivity, renderAgentActivityDetail]) {
    const view = renderer(failure, { element })
    assert.match(text(view.element), /记录身份不一致/)
    assert.match(text(view.element), /检查来源绑定/)
    if (renderer === renderAgentActivity) {
      assert.doesNotMatch(text(view.element), /source-conflict|runtime-observation/)
    } else {
      assert.match(text(view.element), /source-conflict/)
      assert.match(text(view.element), /runtime-observation/)
    }
    assert.equal(nodes(view.element).filter((node) => node.attributes.role === 'alert').length, 1)
    assert.equal(nodes(view.element).filter((node) => node.tag === 'article').length, 0)
    view.dispose()
  }
  const empty = renderAgentActivity({ ok: true, value: { ...catalog.value, current: [], historical: [], unknown: [], unavailableSources: [] } }, { element })
  assert.match(text(empty.element), /本次读取未提供此类记录/)
  assert.doesNotMatch(text(empty.element), /没有历史|读取成功/)
  empty.dispose()
})
