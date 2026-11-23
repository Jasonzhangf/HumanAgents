import test from 'node:test'
import assert from 'node:assert/strict'
import { taskForTurn, childExecutionIds, dispatchState, observationTools, createDispatchTracking, executionIdentity } from '../../docs/ui/dispatch-tracking.js'
import { ownedMainTopicTurns } from '../../docs/ui/main-topic.js'

const task = { taskId: { scope: 'task', value: 'parent-a' }, sourceInteractionId: 'interaction-a', title: '检查项目', state: 'running' }
const other = { ...task, taskId: { scope: 'task', value: 'parent-b' }, sourceInteractionId: 'interaction-b' }
test('an undelivered draft keeps its original readable text and old round data', () => {
  const draft = { kind: 'draft', role: 'jenny', text: '用户必须能读到的完整任务', quote: '原始输入', interactionId: 'draft-only' }
  assert.equal(ownedMainTopicTurns({ turns: [draft], tasks: [] })[0], draft)
})
test('runtime identity comes only from actual tool execution records', () => {
  const scope = { projectKey: 'p', mode: 'fake', taskId: 't' }
  const eventScope = { ...scope, taskId: { value: 't' } }
  assert.deepEqual(executionIdentity({ toolEvents: [
    { execution: { runtimeId: 'runtime-a', assignmentId: 'assignment-a' } },
    { execution: { runtimeId: 'runtime-a' } }, { execution: { runtimeId: 'runtime-b' } },
    { actor: { name: 'Invented Member' } },
  ].map((event, seq) => ({ ...event, seq, scope: eventScope })) }, scope), ['runtime-a', 'runtime-b'])
  assert.deepEqual(executionIdentity({ toolEvents: [{ scope: { ...eventScope, projectKey: 'foreign' }, execution: { runtimeId: 'foreign' } }] }, scope), [])
})
test('task and turn ownership uses exact task or source interaction, never matching text', () => {
  assert.equal(taskForTurn({ interactionId: 'interaction-b', text: '检查项目' }, [task, other]), other)
  assert.equal(taskForTurn({ taskId: { value: 'parent-a' }, interactionId: 'interaction-b' }, [task, other]), task)
  assert.equal(taskForTurn({ text: '检查项目 Jenny parent-a' }, [task, other]), undefined)
  const p = { tasks: [task, other], turns: [
    { turnId: 'draft-a', taskId: task.taskId, role: 'jenny', kind: 'draft', text: '完整草案', quote: '完整输入' },
    { turnId: 'error-b', taskId: other.taskId, role: 'jenny', kind: 'error', text: 'raw english failure', quote: '完整输入' },
    { turnId: 'reply-c', interactionId: 'interaction-c', role: 'jenny', kind: 'message', text: '2' },
  ] }
  const turns = ownedMainTopicTurns(p)
  assert.equal(turns[0].dispatchTask, task)
  assert.equal(turns[0].quote, undefined)
  assert.equal(turns[0].text, '任务已交办')
  assert.equal(turns[1].role, 'task')
  assert.doesNotMatch(turns[1].text, /raw english/)
  assert.equal(turns[2], p.turns[2])
})
test('child action follows only scoped formal relation; dispatch does not prove takeover', () => {
  const scope = { projectKey: 'p', mode: 'fake', taskId: 'parent-a' }
  const ref = id => ({ taskRef: { value: id }, scope })
  const edge = { kind: 'child-execution', source: ref('parent-a'), target: ref('child-a') }
  assert.deepEqual(childExecutionIds({ relations: [edge, { ...edge, source: ref('parent-b') }, { ...edge, target: { ...ref('wrong'), scope: { ...scope, projectKey: 'other' } } }] }, scope), ['child-a'])
  assert.equal(dispatchState(task), '等待接手')
  assert.equal(dispatchState(task, { nodes: [{ ownerAgentRole: 'execution', toolSteps: [{ stepId: 'actual-step' }] }] }), '跟踪中')
  assert.equal(dispatchState(task, { nodes: [{ ownerAgentRole: 'execution', stateDisplay: '已完成' }] }), '等待接手', 'an unprojected planned node is not an executed step')
  assert.equal(dispatchState(task, undefined, true), '跟踪中', 'scoped typed execution events do not require a legacy observation node')
  assert.equal(dispatchState({ ...task, state: 'succeeded' }), '完成')
  assert.equal(dispatchState({ ...task, error: { code: 'unknown.event' } }), '受阻')
})
test('legacy steps use structured role, name, turn and status; returned is never decoded', () => {
  const step = { stepId: 'step-a', turnId: 'turn-a', name: 'bash', status: 'succeeded', occurredAt: '2026-11-23T00:00:00Z', returned: 'owner=Jenny arguments=secret outputRef=fake' }
  const tools = observationTools({ nodes: [{ ownerAgentRole: 'execution', toolSteps: [step, step, { ...step, turnId: 'turn-b' }] }] })
  assert.equal(tools.length, 2)
  assert.equal(tools[0].role, 'execution')
  assert.equal(tools[0].status, 'succeeded')
  assert.equal(tools[0].returned, undefined)
})
test('tracking retains separate terminal tasks and never performs a dispatch write', async () => {
  const calls = []
  const api = { readProductRelations: async scope => { calls.push(scope); return { relations: [] } }, readProductSession: async () => ({}), observation: async () => ({}), semanticObservation: async () => ({}) }
  const tracker = createDispatchTracking({ api, scope: () => ({ projectKey: 'p', mode: 'fake' }), openDetail() {} })
  tracker.sync([{ ...task, state: 'blocked' }, { ...other, state: 'succeeded' }])
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(tracker.records.size, 2)
  tracker.sync([])
  assert.equal(tracker.records.size, 2)
  tracker.remember({ ...task, state: 'blocked', error: { code: 'old-error' } })
  const recovered = tracker.remember({ ...task, state: 'succeeded' })
  assert.equal(recovered.task.error, undefined, 'an omitted resolved error cannot survive a new authoritative task read')
  assert.equal(dispatchState(recovered.task), '完成')
  assert.equal(calls.length, 0)
  tracker.dispose()
})

test('in-flight sync reserves one timer and polls only active records in the current scope', async () => {
  const calls = [], scheduled = []
  let selected = { projectKey: 'old', mode: 'fake' }, release
  const gate = new Promise(resolve => { release = resolve })
  const api = { readProductRelations: async scope => { calls.push(scope); await gate; return { relations: [] } }, readProductSession: async () => ({}), observation: async () => ({}), semanticObservation: async () => ({}) }
  const tracker = createDispatchTracking({ api, scope: () => selected, openDetail() {} })
  tracker.remember(other)
  selected = { projectKey: 'current', mode: 'fake' }
  const original = globalThis.setTimeout
  globalThis.setTimeout = (fn, delay, ...args) => { scheduled.push(delay); return original(fn, delay, ...args) }
  try {
    tracker.sync([task, ...['succeeded', 'failed', 'blocked', 'stopped', 'cancelled'].map(state => ({ ...other, taskId: { value: state }, state }))])
    await new Promise(resolve => original(resolve, 10))
    for (let i = 0; i < 20; i++) tracker.sync([task])
    assert.deepEqual(scheduled, [0], 'sync during a pending read must not queue additional timers')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].projectKey, 'current')
    assert.equal(calls[0].taskId, 'parent-a')
    release()
    await new Promise(resolve => original(resolve, 10))
    assert.deepEqual(scheduled, [0, 4000])
  } finally { release(); tracker.dispose(); globalThis.setTimeout = original }
})
