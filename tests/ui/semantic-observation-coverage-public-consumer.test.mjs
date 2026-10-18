import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSemanticObservationProjection } from '../../docs/ui/semantic-observation-projection.js'

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

  const raw = buildSemanticObservationProjection(envelope, { mode: 'raw' })
  const rawCoverage = coverageSection(raw)
  assert.deepEqual(rawCoverage.items.map((item) => item.title), [
    'unknown-kind',
    'correlation-unavailable',
  ])
  assert.equal(rawCoverage.items[0].meta.includes('eventRef: 未提供'), false)

  const withoutIssues = buildSemanticObservationProjection({ ...envelope, coverageIssues: [] })
  assert.equal(coverageSection(withoutIssues), undefined)
})
