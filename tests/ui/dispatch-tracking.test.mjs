import test from 'node:test'
import assert from 'node:assert/strict'
import { taskForTurn, childExecutionIds, dispatchState, observationTools, createDispatchTracking, executionIdentity, workSessionHref, taskWorkSessionReturn, dispatchSummary } from '../../docs/ui/dispatch-tracking.js'
import { ownedMainTopicTurns } from '../../docs/ui/main-topic.js'
import { decodeProductLocation } from '../../docs/ui/product-location.js'

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
test('work session keeps the exact task scope and omits an unverified agent selection', () => {
  const href = workSessionHref({ kind: 'task', projectKey: 'p', mode: 'fake', taskId: 'child-a' })
  const url = new URL(href, 'http://humanagent.invalid/task-dashboard.html')
  assert.equal(url.pathname, '/task-dashboard.html')
  assert.equal(url.searchParams.get('task'), 'child-a')
  assert.equal(url.searchParams.get('projectKey'), 'p')
  assert.equal(url.searchParams.get('mode'), 'fake')
  assert.equal([...url.searchParams.keys()].some(key => key.startsWith('agent')), false)
  assert.equal(url.searchParams.has('control'), false)
  const location = decodeProductLocation(url.hash)
  assert.equal(location.kind, 'valid')
  assert.deepEqual(location.location.scope, { kind: 'task', projectKey: 'p', mode: 'fake', taskId: { scope: 'task', value: 'child-a' } })
  assert.deepEqual(location.location.focus, {
    kind: 'interaction', taskRef: { scope: 'task', value: 'child-a' }, scope: location.location.scope,
  })
  assert.equal(workSessionHref({ kind: 'task', projectKey: 'p', mode: 'fake', taskId: undefined }), undefined)
  const withReturn = new URL(workSessionHref({ kind: 'task', projectKey: 'p', mode: 'fake', taskId: 'child-a' }, { returnTo: 'board' }), 'http://humanagent.invalid/task-dashboard.html')
  assert.equal(withReturn.searchParams.get('returnTo'), 'board')
  assert.equal(withReturn.searchParams.get('task'), 'child-a')
  assert.equal(withReturn.hash.includes('%22taskId%22'), true)
})

test('work session return context is explicit and scoped', () => {
  const scope = { kind: 'task', projectKey: 'p', mode: 'fake', taskId: { scope: 'task', value: 'child-a' } }
  assert.deepEqual(taskWorkSessionReturn('topic', scope), { kind: 'topic', label: '返回 Jenny 话题', href: './?projectKey=p&mode=fake' })
  assert.deepEqual(taskWorkSessionReturn('board', scope), { kind: 'board', label: '返回任务板', href: './tasks.html?projectKey=p&mode=fake' })
  assert.equal(taskWorkSessionReturn('topic', { kind: 'task', projectKey: '', mode: 'fake', taskId: 'a' }), undefined)
})
test('task and turn ownership uses exact task or source interaction, never matching text', () => {
  assert.equal(taskForTurn({ interactionId: 'interaction-b', text: '检查项目' }, [task, other]), other)
  assert.equal(taskForTurn({ taskId: { value: 'parent-a' }, interactionId: 'interaction-b' }, [task, other]), task)
  assert.equal(taskForTurn({ text: '检查项目 Jenny parent-a' }, [task, other]), undefined)
  const p = { tasks: [task, other], turns: [
    { turnId: 'draft-a', taskId: task.taskId, interactionId: task.sourceInteractionId, role: 'jenny', kind: 'draft', text: '完整草案', quote: '完整输入' },
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
test('only exact-source drafts form cards and unowned task errors remain visible', () => {
  const blocked = { ...task, state: 'blocked', nextStep: '检查原执行错误后重试', error: { code: 'unknown.event', message: 'unexpected provider event' } }
  const sourceDraft = { ...other, state: 'running' }
  const projection = { tasks: [blocked, sourceDraft], turns: [
    { turnId: 'missing-source-draft', taskId: blocked.taskId, role: 'jenny', kind: 'draft', text: '旧轮草案' },
    { turnId: 'wrong-source-draft', taskId: blocked.taskId, interactionId: 'other-interaction', role: 'jenny', kind: 'draft', text: '另一轮草案' },
    { turnId: 'source-draft', taskId: sourceDraft.taskId, interactionId: sourceDraft.sourceInteractionId, role: 'jenny', kind: 'draft', text: '原交办草案' },
    { turnId: 'blocked-error', taskId: blocked.taskId, role: 'jenny', kind: 'error', text: 'raw english failure' },
    { turnId: 'card-status', taskId: sourceDraft.taskId, role: 'jenny', kind: 'status', text: '任务执行中' },
    { turnId: 'card-error', taskId: sourceDraft.taskId, role: 'jenny', kind: 'error', text: 'raw english failure' },
  ] }
  const turns = ownedMainTopicTurns(projection)
  assert.equal(turns[0], projection.turns[0])
  assert.equal(turns[1], projection.turns[1])
  assert.equal(turns[2].kind, 'dispatch')
  assert.equal(turns[2].dispatchTask, sourceDraft)
  assert.equal(turns[3].role, 'task')
  assert.match(turns[3].text, /检查项目/)
  assert.match(turns[3].text, /模型服务返回了无法识别的响应事件/)
  assert.match(turns[3].text, /unknown\.event/)
  assert.match(turns[3].text, /检查原执行错误后重试/)
  assert.equal(turns.length, 4, 'only status and error under the actual card are deduplicated')
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
test('task summary prefers scoped typed events and keeps absent results explicit', () => {
  const taskId = { scope: 'task', value: 'child-a' }
  const scope = { kind: 'task', projectKey: 'p', mode: 'fake', taskId }
  const call = { kind: 'provider.tool', scope, taskId, operationId: 'op-a', executionEpoch: 1,
    seq: 1, eventId: 'call-a', callId: 'call-a', toolId: 'file.read', arguments: { path: 'report.md' },
    occurredAt: '2026-11-23T00:00:00Z', execution: { role: 'execution' } }
  const result = { ...call, kind: 'provider.tool-result', seq: 2, eventId: 'result-a', status: 'succeeded',
    occurredAt: '2026-11-23T00:00:01Z', outputRef: 'output-a', outputDigest: 'digest-a' }
  const record = {
    task: { title: '检查报告', state: 'running' }, turn: { role: 'jenny' },
    children: [{
      scope: { ...scope, taskId: taskId.value },
      session: { toolEvents: [call, result] },
      observation: { nodes: [{ ownerAgentRole: 'unknown', toolSteps: [{
        stepId: 'legacy', name: 'bash', status: 'failed', occurredAt: '2026-11-23T01:00:00Z',
      }] }] },
    }],
  }
  const summary = dispatchSummary(record)
  assert.deepEqual(summary.roles, ['执行 Agent'])
  assert.equal(summary.latestAction.title, '读取文件')
  assert.equal(summary.latestAction.status, '已完成')
  assert.equal(summary.result, '尚无已提交结果，任务仍在执行。')
  assert.equal(dispatchSummary({ ...record, children: [{ ...record.children[0],
    session: { ...record.children[0].session, publicOutput: { state: 'committed', commits: [{ text: '报告结论' }] } } }] }).result,
  '报告结论')
})
test('task summary exposes the original error and recovery instruction', () => {
  const summary = dispatchSummary({
    task: { title: '失败任务', state: 'blocked', nextStep: '确认外部变更结果后执行恢复或停止任务',
      error: { code: 'unknown.event', message: '模型服务返回了无法识别的响应事件' } },
    turn: { role: 'jenny' }, children: [],
  })
  assert.equal(summary.delegatedBy, 'Jenny')
  assert.deepEqual(summary.roles, [])
  assert.equal(summary.latestAction, undefined)
  assert.equal(summary.result, '模型服务返回了无法识别的响应事件，任务已暂停。 · 确认外部变更结果后执行恢复或停止任务')
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
