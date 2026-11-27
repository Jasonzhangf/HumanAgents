import assert from 'node:assert/strict'
import test from 'node:test'
import { liveToolEvent, mergeLiveExplicitToolEvents } from '../../docs/ui/entry.js'
import { explicitRequestMetadata } from '../../docs/ui/explicit-tool-activity.js'
import { toolPresentations } from '../../docs/ui/tool-presentation.js'

const base = {
  taskId: { scope: 'interaction', value: 'interaction-1' },
  operationId: 'request-1', executionEpoch: 1, turnId: 'turn-1', requestId: 'request-1', callId: 'call-1',
  occurredAt: '2026-11-25T20:00:00.000Z',
}

test('typed live tool events retain their exact request identity and deduplicate', () => {
  const call = liveToolEvent({ ...base, eventId: 'e1', kind: 'tool.started', seq: 1,
    tool: { kind: 'read-task-result', callId: 'call-1' } })
  const result = liveToolEvent({ ...base, eventId: 'e2', kind: 'tool.finished', seq: 2,
    tool: { kind: 'read-task-result', callId: 'call-1', status: 'succeeded' } })
  const duplicate = { ...call, eventId: 'e3', seq: 3 }
  assert.equal(call.kind, 'provider.tool')
  assert.equal(call.toolClass, 'internal-helper')
  assert.equal(mergeLiveExplicitToolEvents([], [call, duplicate, result]).length, 2)
  assert.equal(toolPresentations([call, result])[0].result.status, 'succeeded')
  assert.equal(liveToolEvent({ ...base, kind: 'provider.tool', toolId: 'bash' }), undefined,
    'provider execution facts do not enter through the explicit interaction stream')
})

test('skill loading is request metadata and internal helper calls are not protocol execution cards', () => {
  const metadata = explicitRequestMetadata([
    { ...base, seq: 1, kind: 'tool.started', tool: { kind: 'select-skills', callId: 'skills' } },
    { ...base, seq: 2, kind: 'tool.finished', tool: { kind: 'select-skills', callId: 'skills', status: 'succeeded', detail: { kind: 'skills', skills: ['task-intake'] } } },
  ])
  assert.match(metadata.label, /任务接单/)
  assert.equal(liveToolEvent({ ...base, kind: 'provider.tool', toolId: 'humanagent.turn.end' }), undefined,
    'execution facts never enter the explicit interaction stream')
})
