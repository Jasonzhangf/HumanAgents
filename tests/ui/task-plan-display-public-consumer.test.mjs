/*
 * W3 black-box consumer for the shared Current/Semantic reasoning-plan renderer.
 *
 * Basis: the reading modes were absent and current-scope selection was
 * ambiguous, so a wrong-latest current plan or a lost retained history is
 * plausible. Impact is a false plan/orientation and a bad follow-last write.
 * Cost is one small element adapter over the real exported production
 * functions; no DOM framework and no copied renderer.
 *
 * The exported functions are the real ones used by docs/ui/task-dashboard.js.
 * Actual same-GET/browser rendering remains UNVERIFIED here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.dataset = {}
    this.attributes = {}
    this.listeners = new Map()
    this.className = ''
    this.disabled = false
    this.type = ''
    this._text = ''
  }

  get firstChild() {
    return this.children[0]
  }

  get textContent() {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join('')
      : this._text
  }

  set textContent(value) {
    this.children = []
    this._text = value === undefined ? '' : String(value)
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === undefined || node === null) continue
      this.children.push(typeof node === 'string' ? textNode(node) : node)
    }
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    return child
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }

  click() {
    for (const handler of this.listeners.get('click') || []) handler({ type: 'click' })
  }
}

function textNode(text) {
  const node = new FakeNode('#text')
  node.textContent = text
  return node
}

globalThis.document = { createElement: (tag) => new FakeNode(tag) }

const {
  TASK_PLAN_HISTORY_SURFACE,
  planHistoryAvailability,
  planHistoryScopeFailure,
  resolveCurrentPlanRevision,
  resolveViewedPlanRevision,
  planRevisionChanges,
  renderTaskPlanSnapshot,
  renderTaskPlanCurrentSection,
  renderTaskPlanSemanticView,
  renderTaskDescriptionContent,
  renderTaskActualExecutionGraphSection,
  commitScopedReadTransition,
} = await import('../../docs/ui/task-display.js')
const { projectTaskActualExecutionGraph } = await import(
  '../../dist/tests/packages/ui/projection/actual-execution-graph.js'
)

const scope = { kind: 'task', projectKey: 'proj-1', mode: 'rcc', taskId: { scope: 'task', value: 'task-1' } }
const foreignScope = { ...scope, projectKey: 'proj-2' }

function evidenceRef(id) {
  return {
    evidenceId: { scope: 'evidence', value: id },
    kind: 'execution',
    source: 'task-plan-display-test',
    locator: `test://${id}`,
    scope: { organId: { scope: 'organ', value: 'organ-1' }, taskId: { scope: 'task', value: 'task-1' } },
  }
}

function snapshot(label, { nodes, phases, relations } = {}) {
  return {
    title: `Plan ${label}`,
    summary: `Reasoning plan ${label}.`,
    completeness: { scope: 'whole-task', status: 'complete' },
    acceptanceCriteria: [{ criterionId: `${label}-criterion`, description: `Verify ${label}.` }],
    nodes: nodes ?? [
      { nodeId: `${label}-build`, kind: 'work', title: `Build ${label}`, intent: `Implement ${label}`, definition: { owner: 'runtime' }, phaseId: `${label}-phase` },
      { nodeId: `${label}-verify`, kind: 'check', title: `Verify ${label}`, intent: `Verify ${label}`, definition: { owner: 'runtime' }, phaseId: `${label}-phase` },
    ],
    phases: phases ?? [{ phaseId: `${label}-phase`, title: `Phase ${label}`, memberNodeIds: [`${label}-build`, `${label}-verify`] }],
    relations: relations ?? [{ fromNodeId: `${label}-build`, toNodeId: `${label}-verify`, kind: 'depends-on' }],
  }
}

function revision(sequence, id, { reason, snapshot: snap, coverage = 'complete-from-task-start', publishedAt = '2026-10-15T00:00:00.000Z' } = {}) {
  return {
    revisionId: id,
    sequence,
    journalCommitRef: `jsonl:commit-${sequence}`,
    predecessor: sequence === 1 ? null : { revisionId: `v${sequence - 1}`, sequence: sequence - 1 },
    snapshot: snap ?? snapshot(id),
    reason: reason ?? { kind: sequence === 1 ? 'initial' : 'adjustment', text: `reason ${id}`, basisRefs: [evidenceRef(`basis-${id}`)] },
    evidenceRefs: [evidenceRef(`source-${id}`)],
    historyCoverage: coverage,
    publishedAt,
  }
}

function history({ revisions, current, historyScope = scope }) {
  return { surface: TASK_PLAN_HISTORY_SURFACE, scope: historyScope, current, revisions }
}

const actualTaskId = { scope: 'task', value: 'task-1' }
const actualTaskScope = {
  organId: { scope: 'organ', value: 'organ-1' },
  taskId: actualTaskId,
}

function actualAssignment(assignmentId, objective) {
  return {
    assignmentId,
    taskId: actualTaskId,
    pipelineNodeId: 'pipeline.execute',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    objective,
    targetRefs: [],
    expectedOutputRefs: [],
    successCriteria: [],
    failureCriteria: [],
    incompleteCriteria: [],
    requiredCapabilities: [],
    mergeGate: 'not-required',
  }
}

function actualRecord({
  assignmentId,
  objective,
  status,
  result,
  reason,
  nextAction,
  reviewResults = [],
}) {
  return {
    key: { assignmentId, attempt: 1, executionEpoch: 1 },
    stageNodeId: 'stage-parent',
    assignment: actualAssignment(assignmentId, objective),
    status,
    ownerId: 'owner-1',
    agentId: `agent-${assignmentId}`,
    ...(result === undefined ? {} : { result }),
    reviewResults,
    reason,
    nextAction,
    evidenceRefs: [],
  }
}

function actualSource() {
  const succeededResult = {
    taskId: actualTaskId,
    pipelineNodeId: 'pipeline.execute',
    agentId: 'agent-member-a',
    assignmentId: 'member-a',
    attempt: 1,
    executionEpoch: 1,
    inputRevision: 1,
    producedArtifactRefs: [],
    status: 'succeeded',
    summary: '成员一结果',
    outputRefs: [],
    evidenceRefs: [],
    nextAction: 'continue',
  }
  return {
    taskScope: actualTaskScope,
    guidance: {
      kind: 'one-shot',
      aim: 'Return one result after the confirmed deliverable.',
      selectionGuidance: 'Select methods and roles dynamically.',
      displayGroups: ['Deliverable', 'Review', 'Closure'],
    },
    history: {
      status: 'recorded',
      streams: [{
        stream: { taskScope: actualTaskScope, ownerId: 'owner-1' },
        facts: [{ commitRef: { commitId: 'commit-1', journalSeq: 1, recordDigest: 'sha256:x' } }],
        snapshot: {
          stages: [
            {
              nodeId: 'stage-parent',
              taskId: actualTaskId,
              parentNodeId: null,
              state: 'succeeded',
              assignmentKeys: ['member-a:1:1', 'member-b:1:1'],
            },
            {
              nodeId: 'stage-empty',
              taskId: actualTaskId,
              parentNodeId: 'stage-parent',
              state: 'planned',
              assignmentKeys: [],
            },
          ],
          assignments: [
            actualRecord({
              assignmentId: 'member-a',
              objective: '成员一目标',
              status: 'succeeded',
              result: succeededResult,
              reason: '成员一已完成',
              nextAction: { kind: 'continue' },
              reviewResults: [{
                resultId: 'review-1',
                assignmentId: 'member-a',
                taskId: 'task-1',
                workerAgentId: 'reviewer-1',
                reviewKind: 'quality',
                attempt: 1,
                executionEpoch: 1,
                inputRevision: 1,
                subjectRefs: ['member-a'],
                status: 'passed',
                findings: [{ findingId: 'finding-1' }],
                evidenceRefs: [],
              }],
            }),
            actualRecord({
              assignmentId: 'member-b',
              objective: '成员二目标',
              status: 'blocked',
              reason: '等待外部输入',
              nextAction: { kind: 'wait' },
            }),
          ],
        },
      }],
    },
  }
}

function currentKnown(revisionId, sequence) {
  return {
    state: 'known',
    value: { revisionId, revisionCommitRef: { commitId: `commit-${sequence}`, journalSeq: 10 + sequence, recordDigest: `sha256:${'a'.repeat(64)}` } },
  }
}

function walk(node, out = []) {
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

function allText(node) {
  return walk(node).map((entry) => entry.textContent).join('\n')
}

function byData(node, key, value) {
  return walk(node).filter((entry) => entry.dataset?.[key] === value)
}

function openTechnicalDetail(node, opened) {
  const button = walk(node).find((entry) => (
    entry.tagName === 'BUTTON' && entry.textContent === '技术详情'
  ))
  assert.ok(button, 'the existing technical-detail button must be present')
  button.click()
  assert.equal(opened.length, 1)
  return Object.fromEntries(opened[0].detail.entries)
}

const readOk = (value) => ({ ok: true, value })

test('current resolves only the accepted revision, not a later published one', () => {
  const read = readOk(history({
    revisions: [revision(1, 'v1'), revision(2, 'v2'), revision(3, 'v3')],
    current: currentKnown('v2', 2),
  }))
  const resolved = resolveCurrentPlanRevision(read.value)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.revision.revisionId, 'v2')
  assert.equal(resolved.index, 1)

  const section = renderTaskPlanCurrentSection(read)
  const text = allText(section)
  assert.match(text, /当前权威版本|版本 2/)
  assert.match(text, /Plan v2/)
  assert.doesNotMatch(text, /Plan v3/)
  assert.equal(byData(section, 'planRevision', 'v3').length, 0)
})

test('actual graph projection preserves owner streams, empty stages, parents and repeated roles', () => {
  const graph = projectTaskActualExecutionGraph(actualSource())
  assert.equal(graph.surface, 'task-actual-execution-graph')
  assert.equal(graph.guidance.kindLabel, '单次交付')
  assert.equal(graph.history.status, 'recorded')
  assert.equal(graph.history.streamCount, 1)
  assert.equal(graph.history.stageCount, 2)
  assert.equal(graph.history.memberCount, 2)

  const [stream] = graph.history.streams
  assert.equal(stream.ownerLabel, '执行分组 1')
  assert.deepEqual(stream.stages.map((stage) => stage.label), ['阶段 1', '阶段 2'])
  assert.equal(stream.stages[0].state, 'succeeded')
  assert.equal(stream.stages[1].state, 'planned')
  assert.equal(stream.stages[1].members.length, 0)
  assert.deepEqual(stream.stages[1].parent, {
    kind: 'recorded',
    stageNodeId: 'stage-parent',
    label: '上级阶段：阶段 1',
  })
  assert.deepEqual(stream.stages[0].members.map((member) => member.roleLabel), ['执行', '执行'])
  assert.deepEqual(stream.stages[0].members.map((member) => member.statusLabel), ['已完成', '受阻'])
  assert.equal(stream.stages[0].members[0].result.summary, '成员一结果')
  assert.equal(stream.stages[0].members[1].result, undefined)
  assert.equal('plan' in graph, false)
})

test('actual graph renderer keeps guidance separate and shows empty stages and repeated members', () => {
  const graph = projectTaskActualExecutionGraph(actualSource())
  const section = renderTaskActualExecutionGraphSection(graph)
  const text = allText(section)
  assert.equal(byData(section, 'taskFlowGuidance', 'skeleton').length, 1)
  assert.equal(byData(section, 'actualStage', 'stage-parent').length, 1)
  assert.equal(byData(section, 'actualStage', 'stage-empty').length, 1)
  assert.equal(byData(section, 'actualInstance', 'member-a:1:1').length, 1)
  assert.equal(byData(section, 'actualInstance', 'member-b:1:1').length, 1)
  assert.match(text, /处理方式：单次交付/)
  assert.match(text, /上级阶段：阶段 1/)
  assert.match(text, /此阶段已记录，尚无执行成员/)
  assert.match(text, /成员一结果/)
  assert.doesNotMatch(text, /尚未记录结果|成员一已完成|等待外部输入|下一步：继续|动态选择：|展示分组：/)
  assert.doesNotMatch(text, /当前任务计划|Plan v2/)
  assert.doesNotMatch(text, /stage-parent|member-a|member-b|owner-1|pipeline\.execute/)
})

test('actual graph missing history stays explicit instead of becoming an empty graph', () => {
  const graph = projectTaskActualExecutionGraph({
    taskScope: actualTaskScope,
    history: { status: 'not-recorded', reason: 'no-recorded-facts' },
  })
  const section = renderTaskActualExecutionGraphSection(graph)
  assert.equal(section.dataset.actualExecutionGraph, 'not-recorded')
  assert.equal(byData(section, 'actualExecutionHistory', 'not-recorded').length, 1)
  assert.match(allText(section), /实际执行记录缺失/)
  assert.match(allText(section), /没有记录实际执行图事实/)
})

test('current rejects an unknown or mismatched accepted identity instead of using the latest', () => {
  const unknown = resolveCurrentPlanRevision(history({
    revisions: [revision(1, 'v1'), revision(2, 'v2')],
    current: { state: 'unknown', reason: 'runtime has not accepted a current plan' },
  }))
  assert.equal(unknown.ok, false)
  assert.equal(unknown.failure.code, 'task-plan-history.current-unknown')

  const mismatched = resolveCurrentPlanRevision(history({
    revisions: [revision(1, 'v1'), revision(2, 'v2')],
    current: { state: 'known', value: { revisionId: 'v2', revisionCommitRef: { commitId: 'commit-1', journalSeq: 11, recordDigest: 'sha256:x' } } },
  }))
  assert.equal(mismatched.ok, false)
  assert.equal(mismatched.failure.code, 'task-plan-history.current-mismatch')

  const opened = []
  const section = renderTaskPlanCurrentSection(readOk(history({
    revisions: [revision(1, 'v1')],
    current: { state: 'unknown', reason: 'not accepted yet' },
  })), {
    onOpenDetail: (detail, button) => opened.push({ detail, button }),
  })
  assert.equal(byData(section, 'planRevision', 'v1').length, 0)
  const mainText = allText(section)
  assert.match(mainText, /当前任务计划尚无法确认/)
  assert.match(mainText, /不能将保留版本当作当前计划/)
  assert.doesNotMatch(mainText, /not accepted yet|refresh the original task projection read/)
  const detail = openTechnicalDetail(section, opened)
  assert.deepEqual(detail, {
    code: section.planFailure.code,
    owner: section.planFailure.ownerId,
    message: section.planFailure.message,
    nextAction: section.planFailure.nextAction,
  })
})

test('semantic renders complete returned order with reasons, changes and coverage', () => {
  const v1 = revision(1, 'v1', { coverage: 'prior-history-unavailable', publishedAt: '2026-10-15T05:00:00.000Z' })
  const v2 = revision(2, 'v2', { publishedAt: '2026-10-15T01:00:00.000Z' })
  const v3 = revision(3, 'v3', {
    snapshot: snapshot('v3', {
      nodes: [
        { nodeId: 'v3-build', kind: 'work', title: 'Build v3', intent: 'Implement v3', definition: { owner: 'runtime' }, phaseId: 'v3-phase' },
        { nodeId: 'v3-verify', kind: 'check', title: 'Verify v3', intent: 'Verify v3', definition: { owner: 'runtime' }, phaseId: 'v3-phase' },
        { nodeId: 'v3-ship', kind: 'work', title: 'Ship v3', intent: 'Ship v3', definition: { owner: 'runtime' }, phaseId: 'v3-phase' },
      ],
      phases: [{ phaseId: 'v3-phase', title: 'Phase v3', memberNodeIds: ['v3-build', 'v3-verify', 'v3-ship'] }],
      relations: [
        { fromNodeId: 'v3-build', toNodeId: 'v3-verify', kind: 'depends-on' },
        { fromNodeId: 'v3-verify', toNodeId: 'v3-ship', kind: 'sequence' },
      ],
    }),
  })
  const read = readOk(history({ revisions: [v1, v2, v3], current: currentKnown('v2', 2) }))

  const view = renderTaskPlanSemanticView(read, {
    onEvidenceRef: (ref) => {
      const node = new FakeNode('button')
      node.textContent = `evidence:${ref.evidenceId.value}`
      return node
    },
  })
  const ordered = byData(view, 'planSequence', '1')
    .concat(byData(view, 'planSequence', '2'), byData(view, 'planSequence', '3'))
    .map((entry) => entry.dataset.planRevision)
  // The returned array order is authoritative; publishedAt is out of order and must not reorder.
  assert.deepEqual(ordered, ['v1', 'v2', 'v3'])
  assert.deepEqual(walk(view).filter((n) => n.dataset?.planRevision).map((n) => n.dataset.planRevision), ['v1', 'v2', 'v3'])

  const text = allText(view)
  assert.match(text, /原因未记录|reason v2/) // v2 carries its typed reason text
  assert.match(text, /历史覆盖：更早历史不可用/)
  assert.match(text, /上一版本：序列 1 · v1/)
  assert.match(text, /新增节点：Ship v3/)
  assert.match(text, /新增关系：v3-verify 顺序 v3-ship/)
  assert.match(text, /evidence:source-v1/)
  assert.match(text, /当前权威版本：序列 2 · v2/)
})

test('reason text that is missing stays unrecorded', () => {
  const view = renderTaskPlanSemanticView(readOk(history({
    revisions: [revision(1, 'v1', { reason: { kind: 'unrecorded', basisRefs: [] } })],
    current: currentKnown('v1', 1),
  })))
  assert.match(allText(view), /原因未记录/)
})

test('a historical selection is legal only as a matching revision/publication pair', () => {
  const read = history({ revisions: [revision(1, 'v1'), revision(2, 'v2')], current: currentKnown('v2', 2) })
  assert.equal(resolveViewedPlanRevision(read, { revisionId: 'v1', publication: 'jsonl:commit-1' }).ok, true)
  assert.equal(resolveViewedPlanRevision(read, { revisionId: 'v1', publication: 'jsonl:commit-1' }).revision.revisionId, 'v1')

  const partial = resolveViewedPlanRevision(read, { revisionId: 'v1', publication: '' })
  assert.equal(partial.ok, false)
  assert.equal(partial.failure.code, 'task-plan-history.selection-partial')

  const unknown = resolveViewedPlanRevision(read, { revisionId: 'v9', publication: 'jsonl:commit-9' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.failure.code, 'task-plan-history.selection-unknown')

  const mismatch = resolveViewedPlanRevision(read, { revisionId: 'v1', publication: 'jsonl:commit-2' })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.failure.code, 'task-plan-history.selection-mismatch')
})

test('an explicit current view plus an old selection is a visible conflict, not a relabel', () => {
  const section = renderTaskPlanCurrentSection(readOk(history({
    revisions: [revision(1, 'v1'), revision(2, 'v2')],
    current: currentKnown('v2', 2),
  })), { explicitDisplay: 'current', conflictSelection: { revisionId: 'v1', publication: 'jsonl:commit-1' } })

  const text = allText(section)
  assert.match(text, /URL 同时要求当前内容和一个旧计划版本/)
  assert.equal(byData(section, 'planConflict', 'current-vs-viewed').length, 1)
  // The current snapshot is still the accepted v2, never the old selection.
  assert.equal(byData(section, 'planRevision', 'v2').length, 1)
  assert.equal(byData(section, 'planRevision', 'v1').length, 0)
})

test('scoped and read failures stay explicit, preserve prior content and never mark success', async () => {
  const scopeFailure = planHistoryScopeFailure(history({ revisions: [], current: { state: 'unknown', reason: 'x' }, historyScope: foreignScope }), scope)
  assert.equal(scopeFailure.code, 'task-plan-history.scope-mismatch')

  const failed = planHistoryAvailability({ ok: false, failure: { code: 'task-plan-history.read-failed', ownerId: 'humanagent.app.ui-runtime.task-plan-history', message: 'journal read failed', nextAction: 'restore the read' } })
  assert.equal(failed.ok, false)
  assert.equal(failed.failure.code, 'task-plan-history.read-failed')

  const missing = planHistoryAvailability({ ok: true, value: { surface: 'runtime-task-dashboard' } })
  assert.equal(missing.ok, false)
  assert.equal(missing.failure.code, 'task-plan-history.unexpected-surface')

  const opened = []
  const failureView = renderTaskPlanSemanticView(failed, {
    onOpenDetail: (detail, button) => opened.push({ detail, button }),
  })
  const failureText = allText(failureView)
  assert.match(failureText, /任务计划暂时无法读取/)
  assert.match(failureText, /任务状态不能据此判定/)
  assert.doesNotMatch(failureText, /journal read failed|restore the read/)
  assert.deepEqual(openTechnicalDetail(failureView, opened), {
    code: 'task-plan-history.read-failed',
    owner: 'humanagent.app.ui-runtime.task-plan-history',
    message: 'journal read failed',
    nextAction: 'restore the read',
  })
  assert.equal(walk(failureView).filter((n) => n.dataset?.planRevision).length, 0)

  // The real staged transition keeps prior content and cannot report success on
  // a failed read: build/commit never run.
  let committed = 0
  const receipt = await commitScopedReadTransition({
    read: async () => ({ published: true, reason: 'read-failed', state: { content: undefined, stale: false, failure: failed.failure } }),
    build: (content) => renderTaskPlanSemanticView(content),
    commit: () => { committed += 1 },
  })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.failure.code, 'task-plan-history.read-failed')
  assert.equal(committed, 0)

  // A readable projection stages the real render and commits it exactly once.
  const okRead = readOk(history({ revisions: [revision(1, 'v1')], current: currentKnown('v1', 1) }))
  let staged = null
  const okReceipt = await commitScopedReadTransition({
    read: async () => ({ published: true, reason: 'published', state: { content: okRead, stale: false } }),
    build: (content) => renderTaskPlanSemanticView(content),
    commit: (render) => { staged = render; committed += 1 },
  })
  assert.equal(okReceipt.ok, true)
  assert.equal(committed, 1)
  assert.equal(byData(staged, 'planRevision', 'v1').length, 1)
})

test('a rendered plan failure cannot become a successful mode transition', async () => {
  const failed = readOk(history({
    revisions: [revision(1, 'v1')],
    current: { state: 'unknown', reason: 'runtime has not accepted a current plan' },
  }))

  for (const [name, build] of [
    ['semantic', (content) => renderTaskPlanSemanticView(content)],
    ['current', (content) => renderTaskPlanCurrentSection(content)],
  ]) {
    let committed = 0
    const receipt = await commitScopedReadTransition({
      read: async () => ({ published: true, reason: 'published', state: { content: failed, stale: false } }),
      build,
      commit: () => { committed += 1 },
    })

    assert.equal(receipt.ok, false, `${name} must not report success`)
    assert.equal(receipt.failure.code, 'task-plan-history.current-unknown')
    assert.equal(committed, 0, `${name} must not commit a failed render`)
  }
})

test('snapshot and change helpers stay on typed fields', () => {
  const before = snapshot('v1')
  const after = snapshot('v1', {
    nodes: [
      { nodeId: 'v1-build', kind: 'work', title: 'Build v1 (revised)', intent: 'Implement v1', definition: { owner: 'runtime' }, phaseId: 'v1-phase' },
      { nodeId: 'v1-verify', kind: 'check', title: 'Verify v1', intent: 'Verify v1', definition: { owner: 'runtime' }, phaseId: 'v1-phase' },
    ],
  })
  const changes = planRevisionChanges(before, after)
  assert.equal(changes.baseline, false)
  assert.equal(changes.nodes.changed.length, 1)
  assert.equal(changes.nodes.changed[0].nodeId, 'v1-build')
  assert.deepEqual(changes.nodes.changed[0].fields, ['title'])
  assert.equal(planRevisionChanges(null, before).baseline, true)

  const rendered = renderTaskPlanSnapshot(after)
  assert.equal(byData(rendered, 'planNode', 'v1-build').length, 1)
  assert.equal(byData(rendered, 'relationKind', 'depends-on').length, 1)
  assert.match(allText(rendered), /Build v1 \(revised\)/)
})

test('task description renders complete canonical requirements and preserves other input', () => {
  const goal = 'Write one short paragraph containing M4-CONSTRAINT-FIDELITY-OK explaining why preserving user constraints matters.'
  const scope = '/Users/fanzhang/.humanagent/test-fixtures/m4-constraint-rcc-acceptance-20261018/workspace'
  const constraints = [
    'Do not create, modify, or delete any workspace files.',
    'Do not call child agents or delegate this task.',
    'Return the paragraph directly as the final answer.',
  ]
  const deliverables = ['One short paragraph containing M4-CONSTRAINT-FIDELITY-OK']
  const canonicalInput = JSON.stringify({ constraints, deliverables, goal, scope })

  const canonical = renderTaskDescriptionContent({ taskTitle: goal, input: canonicalInput })
  assert.equal(canonical.dataset.taskDescription, 'structured')
  assert.deepEqual(
    walk(canonical).filter((node) => node.tagName === 'DT').map((node) => node.textContent),
    ['目标', '范围', '约束', '交付要求'],
  )
  const canonicalText = canonical.textContent
  assert.ok(canonicalText.indexOf(goal) < canonicalText.indexOf(scope))
  assert.ok(canonicalText.indexOf(scope) < canonicalText.indexOf(constraints[0]))
  assert.ok(canonicalText.indexOf(constraints[0]) < canonicalText.indexOf(constraints[1]))
  assert.ok(canonicalText.indexOf(constraints[1]) < canonicalText.indexOf(constraints[2]))
  assert.ok(canonicalText.indexOf(constraints[2]) < canonicalText.indexOf(deliverables[0]))
  assert.doesNotMatch(canonicalText, /"constraints"|"deliverables"|"goal"|"scope"/)

  const plaintext = 'First line.\n\nSecond line keeps its blank line.\n  Indented line.'
  assert.equal(renderTaskDescriptionContent({ input: plaintext }).textContent, plaintext)

  const unknownInput = JSON.stringify({ ...JSON.parse(canonicalInput), priority: 'keep this extra field' })
  assert.equal(renderTaskDescriptionContent({ input: unknownInput }).textContent, unknownInput)

  const partialInput = JSON.stringify({ goal, scope })
  assert.equal(renderTaskDescriptionContent({ input: partialInput }).textContent, partialInput)

  assert.equal(renderTaskDescriptionContent({ input: '' }).textContent, '尚未输入')
})
