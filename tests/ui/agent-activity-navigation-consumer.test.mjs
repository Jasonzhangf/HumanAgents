import test from 'node:test'
import assert from 'node:assert/strict'

import { createRuntimeApi, readScopeKey } from '../../docs/ui/runtime-api.js'
import { agentActivityQuery, agentSelectionReadFailure } from '../../docs/ui/agent-activity.js'

// Real exported seam only: the two API builders the task-dashboard and observation
// pages call, plus the scoped-read identity owner. No copied page handler, no DOM,
// no source-string assertion. This pins the two concrete ways the glue can go wrong.
function recordingApi() {
  const calls = []
  const api = createRuntimeApi({
    fetchImpl: async (url) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => ({ surface: 'runtime-read' }) }
    },
  })
  return { api, calls }
}

const taskId = { scope: 'task', value: 'task-1' }
const nativeSelection = {
  taskId,
  instance: { kind: 'native-execution', execution: { runtimeId: 'runtime-9', executionEpoch: 4 } },
  assignmentId: 'assignment-9',
  attempt: 2,
}
const incarnationSelection = {
  taskId,
  instance: {
    kind: 'incarnation',
    incarnation: {
      runtimeId: 'runtime-9', executionEpoch: 4, roleId: 'role-1', generation: 3,
      agentInstanceId: 'agent-1', taskId, assignmentId: 'assignment-9',
    },
  },
  assignmentId: 'assignment-9',
  attempt: 2,
}

function selectionQuery(selection) {
  const encoded = agentActivityQuery(new URLSearchParams(), selection)
  assert.equal(encoded.ok, true)
  return encoded.value
}

function requestParams(url) {
  return new URLSearchParams(url.split('?')[1] || '')
}

test('scoped dashboard forwards the validated instance selection after the canonical scope', async () => {
  const { api, calls } = recordingApi()
  await api.scopedTaskDashboard({
    projectKey: 'project-7', mode: 'rcc', taskId, agentQuery: selectionQuery(nativeSelection),
  })
  const params = requestParams(calls[0])
  assert.equal(params.get('projectKey'), 'project-7')
  assert.equal(params.get('mode'), 'rcc')
  assert.equal(params.get('agentKind'), 'native-execution')
  assert.equal(params.get('agentRuntimeId'), 'runtime-9')
  assert.equal(params.get('agentExecutionEpoch'), '4')
  assert.equal(params.get('agentAssignmentId'), 'assignment-9')
  assert.equal(params.get('agentAttempt'), '2')
})

test('observation forwards the same instance selection with its existing scope and node', async () => {
  const { api, calls } = recordingApi()
  await api.observation('task-1', 'scope-x', 'node-3', selectionQuery(incarnationSelection))
  const params = requestParams(calls[0])
  assert.equal(params.get('scope'), 'scope-x')
  assert.equal(params.get('node'), 'node-3')
  assert.equal(params.get('agentKind'), 'incarnation')
  assert.equal(params.get('agentGeneration'), '3')
  assert.equal(params.get('agentInstanceId'), 'agent-1')
})

test('a different instance selection is a different scoped read identity', () => {
  const catalog = { kind: 'task', projectKey: 'project-7', mode: 'rcc', taskId: { value: 'task-1' } }
  const nativeScope = { ...catalog, agentQuery: selectionQuery(nativeSelection) }
  const incarnationScope = { ...catalog, agentQuery: selectionQuery(incarnationSelection) }
  assert.deepEqual(agentSelectionReadFailure(nativeScope.agentQuery, undefined), {
    code: 'agent-activity.selection-not-confirmed',
    ownerId: 'humanagent.ui.agent-activity',
    message: '这次读取没有返回所选运行实例，不能把任务实例列表当作该选择。',
    nextAction: '重试所选实例读取，或返回任务实例列表。',
  })
  assert.equal(readScopeKey(catalog), readScopeKey({ ...catalog }))
  assert.notEqual(readScopeKey(catalog), readScopeKey(nativeScope))
  assert.notEqual(readScopeKey(nativeScope), readScopeKey(incarnationScope))
  assert.equal(readScopeKey(nativeScope), readScopeKey({ ...catalog, agentQuery: selectionQuery(nativeSelection) }))
})
