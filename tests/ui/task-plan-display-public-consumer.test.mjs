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

const commitRef = (id, journalSeq = 1) => ({
  commitId: id,
  journalSeq,
  recordDigest: `sha256:${'0'.repeat(64)}`,
})

const incarnation = (suffix, executionEpoch = 2) => ({
  runtimeId: `runtime-${suffix}`,
  generation: 1,
  agentInstanceId: `agent-${suffix}`,
  roleId: 'execution',
  taskId: actualTaskId,
  assignmentId: `member-${suffix}`,
  executionEpoch,
})

function nativeNode(id, assignmentId, extra) {
  return {
    nodeId: id,
    taskId: actualTaskId,
    assignmentId,
    currency: 'current',
    commitRefs: [commitRef(`commit-${id}`)],
    evidenceRefs: [],
    ...extra,
  }
}

/**
 * One compact native source covering every graph node kind and the states that
 * must stay unlike success: an unacquired call, an unreturned review, a segment
 * that one business closure must not close, an orphan delivery, an unresolved
 * relation and an unavailable source.
 */
function nativeSource() {
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
      nodes: [
        nativeNode('allocation-1', 'member-main', {
          kind: 'native-allocation',
          instance: {
            kind: 'native-execution',
            execution: { runtimeId: 'native-runtime', executionEpoch: 1 },
          },
          executionEpoch: 1,
          objective: '完成主任务的原生执行分配',
          allocation: {
            runtimeId: 'native-runtime',
            operationId: { scope: 'operation', value: 'op-1' },
            executionEpoch: 1,
            assignmentId: 'member-main',
            scope: { organId: actualTaskScope.organId, taskId: actualTaskId },
            inputRefs: ['input-1'],
            ownerId: 'owner-1',
            directiveRevision: 1,
            inputRevision: 1,
            orchestrated: true,
            role: 'execution',
          },
        }),
        nativeNode('turn-active', 'member-main', {
          kind: 'active-turn',
          instance: {
            kind: 'native-execution',
            execution: { runtimeId: 'native-runtime', executionEpoch: 1 },
          },
          executionEpoch: 1,
          businessTurnId: 'turn-1',
          pipelineNodeId: 'pipeline.execute',
          objective: '完成主任务',
          binding: {
            admittedTurn: {},
            assignment: { objective: '完成主任务' },
            execution: { runtimeId: 'native-runtime', executionEpoch: 1 },
            scope: { organId: actualTaskScope.organId, taskId: actualTaskId },
          },
          bindingCommitRef: commitRef('binding-turn'),
          businessClosure: {
            status: 'recorded',
            closure: {
              identity: {},
              checkpointId: { scope: 'checkpoint', value: 'checkpoint-1' },
              closureRef: 'closure-1',
              summary: {
                goal: { text: '完成主任务', evidenceRefs: [] },
                actions: { text: '派发子任务', evidenceRefs: [] },
                result: { text: '主任务已交付', evidenceRefs: [] },
                expectedNextStep: { text: '等待用户确认', evidenceRefs: [] },
              },
              recoveryStateRef: {},
              closedAt: '2026-10-18T00:00:00.000Z',
            },
            commitRef: commitRef('closure-turn'),
          },
        }),
        nativeNode('segment-2', 'member-main', {
          kind: 'resumed-segment',
          instance: { kind: 'incarnation', incarnation: incarnation('segment') },
          executionEpoch: 2,
          businessTurnId: 'turn-1',
          segmentId: 'segment-2',
          opened: { kind: 'segment-opened', segmentId: 'segment-2' },
          openedCommitRef: commitRef('segment-2'),
          terminalCommitRefs: [],
          segmentState: { status: 'opened' },
        }),
        nativeNode('child-a', 'member-a', {
          kind: 'child-invocation',
          callKind: 'execution',
          invocationId: 'inv-a',
          childTurnId: 'child-turn-a',
          checkpointReceiptRef: 'checkpoint-a',
          record: {
            invocationId: 'inv-a',
            childTurnId: 'child-turn-a',
            checkpointReceiptRef: 'checkpoint-a',
            binding: { kind: 'execution', assignment: { objective: '整理交付说明' } },
            incarnation: incarnation('a'),
            adoptedResultSeq: 3,
          },
          invocationCommitRef: commitRef('inv-a'),
          containingLocation: {
            kind: 'active-turn',
            businessTurnId: 'turn-1',
            bindingCommitRef: commitRef('binding-turn'),
          },
          linkage: { status: 'linked', parentNodeId: 'turn-active' },
          acquisition: { status: 'acquired', incarnation: incarnation('a') },
          returnState: {
            status: 'returned',
            delivery: {
              kind: 'execution',
              seq: 3,
              invocationId: 'inv-a',
              refinedDelivery: {},
              assignment: {},
              result: { status: 'succeeded', summary: '子任务结果已返回' },
            },
            deliveryCommitRef: commitRef('delivery-a'),
          },
          adoption: { status: 'adopted', resultSeq: 3 },
        }),
        nativeNode('child-b', 'member-b', {
          kind: 'child-invocation',
          callKind: 'review',
          invocationId: 'inv-b',
          childTurnId: 'child-turn-b',
          checkpointReceiptRef: 'checkpoint-b',
          record: {
            invocationId: 'inv-b',
            childTurnId: 'child-turn-b',
            checkpointReceiptRef: 'checkpoint-b',
            binding: { kind: 'review', assignment: {} },
            incarnation: incarnation('b'),
          },
          invocationCommitRef: commitRef('inv-b'),
          containingLocation: {
            kind: 'resumed-segment',
            businessTurnId: 'turn-1',
            segmentId: 'segment-2',
            openedCommitRef: commitRef('segment-2'),
          },
          linkage: { status: 'linked', parentNodeId: 'segment-2' },
          acquisition: { status: 'acquired', incarnation: incarnation('b') },
          returnState: { status: 'unreturned' },
          adoption: { status: 'undecided' },
        }),
        nativeNode('child-c', 'member-c', {
          kind: 'child-invocation',
          missingSource: '执行池没有提供完整的调用记录。',
          callKind: 'execution',
          invocationId: 'inv-c',
          childTurnId: 'child-turn-c',
          checkpointReceiptRef: 'checkpoint-c',
          record: {
            invocationId: 'inv-c',
            childTurnId: 'child-turn-c',
            checkpointReceiptRef: 'checkpoint-c',
            binding: { kind: 'execution', assignment: { objective: '补充检查' } },
          },
          invocationCommitRef: commitRef('inv-c'),
          containingLocation: {
            kind: 'active-turn',
            businessTurnId: 'turn-1',
            bindingCommitRef: commitRef('binding-turn'),
          },
          linkage: { status: 'linked', parentNodeId: 'turn-active' },
          acquisition: { status: 'unacquired', reason: '执行池未提供实例' },
          returnState: { status: 'unreturned' },
          adoption: { status: 'undecided' },
        }),
        nativeNode('orphan-1', 'member-orphan', {
          kind: 'orphan-child-delivery',
          callKind: 'execution',
          invocationId: 'inv-orphan',
          delivery: {
            kind: 'execution',
            seq: 9,
            invocationId: 'inv-orphan',
            refinedDelivery: {},
            assignment: {},
            result: { status: 'succeeded', summary: '孤立的子任务结果' },
          },
          containingCommitRef: commitRef('envelope-orphan'),
          deliverySeq: 9,
          containingLocation: {
            kind: 'active-turn',
            businessTurnId: 'turn-1',
            bindingCommitRef: commitRef('binding-turn'),
          },
          linkage: { status: 'orphan', reason: 'invocation-not-recorded' },
        }),
        nativeNode('review-1', 'member-review', {
          kind: 'milestone-review',
          instance: { kind: 'incarnation', incarnation: incarnation('review', 3) },
          executionEpoch: 3,
          pipelineNodeId: 'child.review',
          record: {
            delivery: {
              result: { status: 'passed', findings: [{ findingId: 'finding-1' }] },
            },
          },
          reviewCommitRef: commitRef('review-1'),
        }),
        nativeNode('planner-1', 'member-plan', {
          kind: 'closed-turn-planner-call',
          stage: 'returned',
          dutyKey: 'duty-1',
          invocationId: 'inv-planner',
          scope: { organId: actualTaskScope.organId, taskId: actualTaskId },
          businessTurnId: 'turn-1',
          instance: { kind: 'incarnation', incarnation: incarnation('planner') },
          execution: { runtimeId: 'planner-runtime', executionEpoch: 1 },
          checkpointId: { scope: 'checkpoint', value: 'checkpoint-1' },
          checkpointCommitRef: commitRef('checkpoint-1'),
          closureRef: 'closure-1',
          closureCommitRef: commitRef('closure-turn'),
          grantCommitRef: commitRef('grant-1'),
          admissionCommitRef: commitRef('admission-1'),
          preparationCommitRef: commitRef('preparation-1'),
          invocationCommitRef: commitRef('planner-inv'),
          returnCommitRef: commitRef('planner-return'),
          planRevision: {
            revisionId: { scope: 'task', value: 'plan-2' },
            sequence: 2,
            decision: 'complete',
          },
        }),
      ],
      edges: [
        { edgeId: 'e-contain-a', kind: 'contains', fromNodeId: 'turn-active', toNodeId: 'child-a' },
        { edgeId: 'e-contain-c', kind: 'contains', fromNodeId: 'turn-active', toNodeId: 'child-c' },
        { edgeId: 'e-contain-b', kind: 'contains', fromNodeId: 'segment-2', toNodeId: 'child-b' },
        { edgeId: 'e-precedes', kind: 'precedes', fromNodeId: 'allocation-1', toNodeId: 'turn-active' },
        { edgeId: 'e-delegates', kind: 'delegates-child', fromNodeId: 'turn-active', toNodeId: 'child-a' },
        { edgeId: 'e-planner', kind: 'planner-duty', fromNodeId: 'turn-active', toNodeId: 'planner-1' },
      ],
      ungrouped: [{
        nodeId: 'turn-active',
        kind: 'delegates-child',
        targetRef: 'missing-child',
        reason: '调用记录未出现在已记录节点中。',
      }],
      unavailable: [{
        sourceId: 'source-1',
        ownerId: 'owner.runtime',
        message: '一条执行来源记录暂时无法读取。',
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

function openActualDetail(node, opened) {
  const button = walk(node).find((entry) => (
    entry.tagName === 'BUTTON' && entry.dataset?.actualGraphDetail === '执行记录详情'
  ))
  assert.ok(button, 'the existing actual-execution detail button must be present')
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

test('actual graph projection groups native nodes and never stamps success on unresolved facts', () => {
  const graph = projectTaskActualExecutionGraph(nativeSource())
  assert.equal(graph.surface, 'task-actual-execution-graph')
  assert.equal(graph.guidance.kindLabel, '单次交付')
  assert.equal(graph.history.status, 'recorded')
  assert.equal(graph.history.groupCount, 6)
  assert.equal(graph.history.recordCount, 9)
  assert.equal(graph.history.nodeCount, 9)
  assert.equal(graph.history.edgeCount, 6)
  assert.equal(graph.history.deliveryCount, 2)
  assert.deepEqual(
    graph.history.groups.map((group) => group.label),
    ['执行轮次', '恢复分段', '执行分配', '里程碑复核', '计划核对', '未归组记录'],
  )

  const group = (label) => graph.history.groups.find((item) => item.label === label)
  const nodesById = new Map(
    graph.history.groups.flatMap((item) => item.nodes).map((node) => [node.nodeId, node]),
  )
  const summary = (nodeId) => nodesById.get(nodeId).summary

  assert.deepEqual(
    group('执行轮次').nodes.map((node) => node.summary.roleLabel),
    ['执行轮次', '子任务执行', '子任务执行'],
  )
  assert.equal(summary('turn-active').stateLabel, '业务已收拢')
  assert.equal(summary('turn-active').resultSummary, '主任务已交付')
  assert.equal(summary('turn-active').nextActionLabel, '等待用户确认')
  assert.equal(summary('child-a').stateLabel, '已完成')
  assert.equal(summary('child-a').adoptionLabel, '结果已采用')
  assert.equal(summary('child-a').resultSummary, '子任务结果已返回')

  // The business closure must not close the physical segment, and an
  // unacquired or orphan record must not read as success.
  assert.equal(summary('segment-2').stateLabel, '进行中')
  assert.equal(summary('segment-2').stateTone, 'active')
  assert.equal(summary('segment-2').reason, '尚未记录该分段的结束。')
  assert.equal(summary('child-c').stateLabel, '未取得执行实例')
  assert.equal(summary('child-c').stateTone, 'warning')
  assert.match(summary('child-c').reason, /执行池未提供实例.*执行池没有提供完整的调用记录/)
  assert.equal(summary('child-b').stateLabel, '已派发，等待返回')
  assert.equal(summary('child-b').adoptionLabel, '采用决定尚未记录')
  assert.equal(summary('orphan-1').stateLabel, '未关联到调用记录')
  assert.equal(summary('orphan-1').stateTone, 'warning')
  assert.equal(summary('review-1').stateLabel, '复核通过')
  assert.equal(summary('review-1').resultSummary, '发现 1 项问题')
  assert.equal(summary('planner-1').decisionLabel, '完成')

  assert.deepEqual(
    graph.history.edges.map((edge) => edge.kind),
    ['contains', 'contains', 'contains', 'precedes', 'delegates-child', 'planner-duty'],
  )
  assert.equal(graph.history.edges[0].detail, '执行轮次包含子任务执行')
  assert.equal(graph.history.ungrouped[0].label, '派发子任务关系未归组')
  assert.equal(graph.history.unavailable[0].detail, '一条执行来源记录暂时无法读取。')

  // Raw identities stay out of the human summary but remain on the technical layer.
  assert.equal(graph.history.groups[0].nodes[0].technical.nodeId, 'turn-active')
  assert.equal(graph.history.groups[0].nodes[1].technical.invocationId, 'inv-a')
  assert.equal('plan' in graph, false)
  assert.equal('planContext' in graph, false)
})

test('actual graph renderer shows groups and hides ids, guidance, plan and detail separation', () => {
  const graph = projectTaskActualExecutionGraph(nativeSource())
  const opened = []
  const section = renderTaskActualExecutionGraphSection(graph, {
    onOpenDetail: (detail, button) => opened.push({ detail, button }),
  })
  const text = allText(section)
  assert.equal(byData(section, 'taskFlowGuidance', 'skeleton').length, 1)
  assert.equal(byData(section, 'actualExecutionGroup', 'turn-active').length, 1)
  assert.equal(byData(section, 'actualExecutionGroup', 'group:ungrouped').length, 1)
  assert.equal(walk(section).filter((entry) => entry.dataset?.actualExecutionNode).length, 9)
  assert.equal(byData(section, 'actualExecutionUngrouped', 'recorded').length, 1)
  assert.equal(byData(section, 'actualExecutionUnavailable', 'recorded').length, 1)
  assert.match(text, /处理方式：单次交付/)
  assert.match(text, /已记录的实际执行/)
  assert.match(text, /业务已收拢/)
  assert.match(text, /主任务已交付/)
  assert.match(text, /未取得执行实例/)
  assert.match(text, /已派发，等待返回/)
  assert.match(text, /未关联到调用记录/)
  assert.match(text, /未归组记录/)
  assert.match(text, /未归组的关系/)
  assert.match(text, /部分执行来源不可用/)
  assert.doesNotMatch(text, /当前任务计划|Plan v2|计划内容属于当前任务/)
  assert.doesNotMatch(text, /turn-active|segment-2|child-a|child-b|child-c|orphan-1|inv-a|inv-b|commit-a|member-a|owner-1|pipeline\.execute|source-1/)

  const detail = openActualDetail(section, opened)
  assert.equal(detail['节点标识'], 'turn-active')
  assert.equal(detail['记录类型'], 'active-turn')
  assert.deepEqual(opened.length, 1)
})

test('actual graph missing history stays explicit instead of becoming an empty graph', () => {
  const graph = projectTaskActualExecutionGraph({
    taskScope: actualTaskScope,
    history: {
      status: 'not-recorded',
      reason: 'no-recorded-facts',
      unavailable: [{
        sourceId: 'source-1',
        ownerId: 'owner.runtime',
        message: '一条执行来源记录暂时无法读取。',
      }],
    },
  })
  const section = renderTaskActualExecutionGraphSection(graph)
  assert.equal(section.dataset.actualExecutionGraph, 'not-recorded')
  assert.equal(byData(section, 'actualExecutionHistory', 'not-recorded').length, 1)
  assert.match(allText(section), /暂无执行过程记录/)
  assert.match(allText(section), /这里仅展示已记录的执行过程/)
  // The unavailable source stays explicit next to the missing-history copy.
  assert.equal(byData(section, 'actualExecutionUnavailable', 'recorded').length, 1)
  assert.match(allText(section), /部分执行来源不可用/)
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
