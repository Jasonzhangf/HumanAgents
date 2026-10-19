import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSemanticObservationProjection } from '../../docs/ui/semantic-observation-projection.js'
import { mountSemanticObservation } from '../../docs/ui/semantic-observation.js'

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

const organId = { scope: 'organ', value: 'organ-f03' }
const taskId = { scope: 'task', value: 'task-f03' }
const operationId = { scope: 'operation', value: 'operation-f03' }
const scope = { organId, taskId, operationId }
const eventRef = { eventId: 'event-correlated', sourceId: 'runtime', scope }

const unknownSource = {
  evidenceId: { scope: 'evidence', value: 'evidence-unknown' },
  kind: 'execution',
  source: 'runtime',
  locator: 'journal:task-f03:7',
  digest: 'sha256:unknown-source',
  scope,
}
const correlatedSource = {
  evidenceId: { scope: 'evidence', value: 'evidence-correlated' },
  kind: 'operation',
  source: 'runtime',
  locator: 'journal:task-f03:9',
  scope,
}

const envelope = freeze({
  scope,
  projectionVersion: 'runtime-semantic-v1',
  sourceWatermark: 9,
  events: [{
    eventId: 'event-correlated',
    sourceId: 'runtime',
    type: 'operation.started',
    scope,
    occurredAt: '2026-10-18T12:00:00.000Z',
    status: 'active',
    summary: '操作正在进行',
    payloadRef: 'context-event:event-correlated',
    dataDigest: 'sha256:event-correlated',
    evidenceRefs: [correlatedSource],
  }],
  coverageIssues: [
    { reason: 'unknown-kind', scope, sourceRef: unknownSource },
    { reason: 'correlation-unavailable', scope, sourceRef: correlatedSource, eventRef },
  ],
  pairing: [
    {
      groupId: 'group-closed',
      kind: 'operation',
      scope,
      executionEpoch: 1,
      state: 'closed',
      eventRefs: [],
    },
    {
      groupId: 'group-waiting',
      kind: 'operation',
      scope,
      executionEpoch: 2,
      state: 'waiting',
      eventRefs: [eventRef],
    },
  ],
  capabilities: [{ capability: 'runtime-task-events', state: 'available' }],
})

// An element port, not a second renderer. This case consumes the real exported
// mountSemanticObservation production module, so a projection-only flag cannot
// pass while the shared renderer still expands every coverage issue.
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
    this.tabIndex = 0
    this._text = ''
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

  get open() {
    return this.attributes.open !== undefined
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === undefined || node === null) continue
      this.children.push(node)
    }
  }

  replaceChildren(...nodes) {
    this.children = [...nodes]
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  hasAttribute(name) {
    return this.attributes[name] !== undefined
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }
}

globalThis.HTMLElement = FakeNode
globalThis.document = { createElement: (tag) => new FakeNode(tag) }

const allNodes = (root) => [root, ...root.children.flatMap(allNodes)]
const findTag = (root, tag) => allNodes(root).find((node) => node.tagName === tag)
const findSection = (root, id) => allNodes(root).find((node) =>
  node.tagName === 'SECTION' && node.dataset.sectionId === id)

function coverageSection(projection) {
  return projection.sections.find((section) => section.id === 'coverage')
}

test('coverage reasons stay human-readable while exact refs remain in read-only evidence', () => {
  const projections = Object.fromEntries(
    ['current', 'semantic', 'actions'].map((mode) => [
      mode,
      buildSemanticObservationProjection(envelope, { mode }),
    ]),
  )

  for (const [mode, projection] of Object.entries(projections)) {
    const section = coverageSection(projection)
    assert.ok(section, `${mode} mode keeps the coverage section`)
    assert.deepEqual(section.items.map((item) => item.title), [
      '有记录暂时无法归类',
      '记录缺少关联信息',
    ])
    assert.deepEqual(section.items.map((item) => item.detail), [
      '影响范围：当前操作。这条记录保持未知，不表示成功。',
      '影响范围：当前操作。这条记录保持未知，不表示成功。',
    ])
    assert.deepEqual(section.items.map((item) => [item.state, item.stateLabel]), [
      ['unknown', '未知'],
      ['unknown', '未知'],
    ])

    const primary = section.items.map(({ evidence, ...item }) => item)
    assert.doesNotMatch(JSON.stringify(primary), /unknown-kind|correlation-unavailable/)
    assert.doesNotMatch(JSON.stringify(primary), /organ-f03|task-f03|operation-f03|journal:/)
  }

  assert.equal(projections.current.state, 'waiting')
  assert.equal(projections.current.stateLabel, '等待中')
  assert.deepEqual(projections.current.summary, [
    { label: '已收拢动作', value: '1 项', tone: 'success' },
    { label: '等待中动作', value: '1 项', tone: 'warning' },
  ])

  const [unknown, correlated] = coverageSection(projections.current).items
  assert.equal(unknown.evidence.evidenceId, 'evidence-unknown')
  assert.equal(unknown.evidence.scopeLabel, '当前操作')
  assert.ok(unknown.evidence.refs.includes('reason: unknown-kind'))
  assert.ok(unknown.evidence.refs.includes('sourceRef.locator: journal:task-f03:7'))
  assert.ok(unknown.evidence.refs.includes('sourceRef.digest: sha256:unknown-source'))
  assert.equal(unknown.evidence.refs.some((entry) => entry.startsWith('eventRef.')), false)

  assert.equal(correlated.evidence.evidenceId, 'evidence-correlated')
  assert.ok(correlated.evidence.refs.includes('reason: correlation-unavailable'))
  assert.ok(correlated.evidence.refs.includes('eventRef.eventId: event-correlated'))
  assert.ok(correlated.evidence.refs.includes('eventRef.sourceId: runtime'))
  assert.match(correlated.evidence.raw.content, /eventRef\.scope: organ:organ-f03, task:task-f03, operation:operation-f03/)

  // Real shared renderer: 1,010 real issues may not expand by default. The
  // coverage section must be a native disclosure that starts closed.
  const host = new FakeNode('div')
  const mounted = mountSemanticObservation(host, {})
  mounted.update(projections.current)
  const coverageNode = findSection(host, 'coverage')
  assert.ok(coverageNode, 'shared renderer keeps the coverage section')
  const disclosure = findTag(coverageNode, 'DETAILS')
  assert.ok(disclosure, 'coverage section uses a native details disclosure')
  assert.equal(disclosure.open, false, 'coverage disclosure starts closed')
  assert.equal(disclosure.hasAttribute('open'), false, 'coverage disclosure has no open attribute')

  const summary = findTag(disclosure, 'SUMMARY')
  assert.ok(summary, 'coverage disclosure has a summary')
  assert.match(summary.textContent, /覆盖缺口/)
  assert.match(summary.textContent, /这些记录暂时无法完整归类或关联，保持未知。/)
  assert.match(summary.textContent, /2 项/)

  const renderedItems = allNodes(disclosure).filter((node) => node.tagName === 'ARTICLE')
  assert.equal(renderedItems.length, 2, 'every coverage issue stays inside the disclosure')
  assert.match(renderedItems[0].textContent, /有记录暂时无法归类/)
  assert.match(renderedItems[1].textContent, /记录缺少关联信息/)
  assert.equal(
    allNodes(disclosure).filter((node) => node.tagName === 'BUTTON' && node.textContent === '查看只读证据').length,
    2,
  )

  // Only the coverage section collapses; a normal section keeps the old layout.
  assert.equal(allNodes(host).filter((node) => node.tagName === 'DETAILS').length, 1)
  const liveSection = findSection(host, 'live')
  assert.ok(liveSection, 'non-coverage section still renders')
  assert.equal(findTag(liveSection, 'DETAILS'), undefined)
  mounted.dispose()
  assert.equal(host.children.length, 0)

  for (const [mode, projection] of Object.entries(projections)) {
    assert.equal(coverageSection(projection).collapsed, true, `${mode} mode collapses the coverage section initially`)
  }

  const raw = buildSemanticObservationProjection(envelope, { mode: 'raw' })
  const rawCoverage = coverageSection(raw)
  assert.equal(rawCoverage.collapsed, true)
  assert.deepEqual(rawCoverage.items.map((item) => item.title), [
    'unknown-kind',
    'correlation-unavailable',
  ])
  assert.equal(rawCoverage.items[0].meta.includes('eventRef: 未提供'), false)

  const withoutIssues = buildSemanticObservationProjection({ ...envelope, coverageIssues: [] })
  assert.equal(coverageSection(withoutIssues), undefined)
})

test('typed public output keeps exact committed text and states without false emptiness', () => {
  const binding = { scope, executionEpoch: 3, requestId: 'request-public' }
  const firstText = '  已确认第一段\n\n第二行保留空白  \n'
  const secondText = '\n第三段\t尾部空白  '
  const commits = [
    {
      ref: {
        binding,
        sourceId: 'provider-output-first',
        commitId: 'commit-first',
        journalSeq: 41,
        recordDigest: 'sha256:first',
      },
      text: firstText,
    },
    {
      ref: {
        binding,
        sourceId: 'provider-output-second',
        commitId: 'commit-second',
        journalSeq: 42,
        recordDigest: 'sha256:second',
      },
      text: secondText,
    },
  ]
  const publicEnvelope = (state, outputCommits = commits) => freeze({
    scope,
    projectionVersion: 'runtime-semantic-v1',
    sourceWatermark: 17,
    publicCommitWatermark: 11,
    publicOutput: { state, commits: outputCommits },
    events: [],
    coverageIssues: [],
    pairing: [],
    capabilities: [],
  })

  const pending = buildSemanticObservationProjection(publicEnvelope('pending'), { mode: 'current' })
  const stable = pending.sections.find((section) => section.id === 'stable')
  const live = pending.sections.find((section) => section.id === 'live')
  assert.ok(stable, 'pending publication still shows confirmed commits as stable')
  assert.deepEqual(stable.items.map((item) => item.detail), [firstText, secondText])
  assert.deepEqual(stable.items.map((item) => item.stateLabel), ['已确认', '已确认'])
  assert.equal(live.items[0].id, 'public-output-pending')
  assert.equal(live.items[0].detail.includes(firstText), false)
  assert.notEqual(pending.state, 'empty')

  const firstEvidence = stable.items[0].evidence
  assert.equal(firstEvidence.evidenceId, 'commit-first')
  assert.equal(firstEvidence.sourceLabel, 'provider-output-first')
  assert.equal(firstEvidence.scopeLabel, '当前操作')
  assert.ok(firstEvidence.refs.includes('commitId: commit-first'))
  assert.ok(firstEvidence.refs.includes('journalSeq: 41'))
  assert.ok(firstEvidence.refs.includes('recordDigest: sha256:first'))
  assert.ok(firstEvidence.refs.includes('scope: operation:operation-f03'))
  assert.equal('occurredAt' in firstEvidence, false)

  const host = new FakeNode('div')
  const mounted = mountSemanticObservation(host, {})
  mounted.update(pending)
  const rendered = allNodes(host).filter((node) => node.tagName === 'ARTICLE')
  assert.deepEqual(rendered.filter((node) => node.dataset.itemId?.startsWith('public-commit:'))
    .map((node) => findTag(node, 'P').textContent), [firstText, secondText])
  mounted.dispose()

  for (const state of ['unknown', 'unavailable']) {
    const projection = buildSemanticObservationProjection(publicEnvelope(state), { mode: 'current' })
    const kept = projection.sections.find((section) => section.id === 'stable')
    assert.deepEqual(kept.items.map((item) => item.detail), [firstText, secondText])
    assert.notEqual(projection.state, 'empty')
    assert.equal(
      projection.notices.some((notice) => notice.tone === state),
      true,
      `${state} stays explicit`,
    )
  }

  const noContentHost = new FakeNode('div')
  const noContentMounted = mountSemanticObservation(noContentHost, {})
  for (const state of ['unknown', 'unavailable']) {
    const uncertain = buildSemanticObservationProjection(publicEnvelope(state, []), { mode: 'current' })
    assert.notEqual(uncertain.state, 'empty')
    assert.equal(uncertain.sections.length, 0)
    noContentMounted.update(uncertain)
    assert.equal(
      allNodes(noContentHost).some((node) => node.className === 'so-empty-state'),
      false,
      `${state} without commits must not claim published content is absent`,
    )
    assert.equal(noContentHost.textContent.includes('当前范围没有已发布语义内容。'), false)
    assert.equal(
      noContentHost.textContent.includes(state === 'unknown' ? '公开结果状态未知' : '公开结果暂不可用'),
      true,
    )
  }

  const committed = buildSemanticObservationProjection(publicEnvelope('committed'), { mode: 'current' })
  assert.equal(
    committed.sections.some((section) => section.id === 'live'),
    false,
    'committed publication clears the pending live item',
  )
  assert.deepEqual(
    committed.sections.find((section) => section.id === 'stable').items.map((item) => item.detail),
    [firstText, secondText],
  )

  const empty = buildSemanticObservationProjection(publicEnvelope('committed', []), { mode: 'current' })
  assert.equal(empty.state, 'empty')
  noContentMounted.update(empty)
  assert.equal(
    allNodes(noContentHost).some((node) => node.className === 'so-empty-state'),
    true,
    'committed publication without commits keeps the genuine empty state',
  )
  noContentMounted.dispose()
})
