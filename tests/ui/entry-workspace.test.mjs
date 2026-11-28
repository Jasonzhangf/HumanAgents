import test from 'node:test'
import assert from 'node:assert/strict'
import { entryWorkspaceSelection, entryProjectHref, entryProjectRows, workspaceFolderName } from '../../docs/ui/entry-workspace.js'
import { createRuntimeApi } from '../../docs/ui/runtime-api.js'

// Failure basis: the service response must prove the requested identity. Impact:
// cross-project messages or Jenny presented as Alex. Cost: pure route consumer.
const topic = { surface: 'main-topic', projectKey: 'project-a', projectName: '真实项目', agentName: 'Jenny',
  agentId: 'agent-jenny', mode: 'rcc', scope: { kind: 'project', projectKey: 'project-a' },
  canonicalAddress: 'project-a/Jenny', role: 'project-lead' }
const alex = { surface: 'main-topic', agentName: 'Alex', agentId: 'agent-alex', canonicalAddress: 'machine.CEO',
  role: 'ceo', scope: { kind: 'alex' } }
test('the selected scope is readable only when the server projection proves that identity', () => {
  assert.equal(entryWorkspaceSelection('?scope=project&projectKey=project-a&mode=rcc', topic).available, true)
  assert.equal(entryWorkspaceSelection('?projectKey=project-a&mode=rcc', topic).available, true)
  assert.equal(entryWorkspaceSelection('', { ...topic, scope: undefined }).available, false)
  assert.equal(entryWorkspaceSelection('', alex).available, true)
  assert.equal(entryWorkspaceSelection('?scope=system', alex).available, true)
  assert.equal(entryWorkspaceSelection('', topic).available, false)
  assert.equal(entryWorkspaceSelection('?scope=system', topic).available, false)
  assert.equal(entryWorkspaceSelection('?scope=system', null).available, false)
  assert.equal(entryWorkspaceSelection('?projectKey=project-b', topic).available, false)
  assert.equal(entryWorkspaceSelection('?projectKey=project-a&mode=fake', topic).available, false)
  assert.equal(entryWorkspaceSelection('?projectKey=project-a&mode=rcc', null).available, false)
  const emptyHttpTopic = {
    surface: 'main-topic',
    agentName: 'Jenny',
    mode: 'rcc',
    interactions: [],
    tasks: [],
    turns: [],
    usage: { calls: [] },
    projectName: 'project-b',
    projectKey: 'project-b',
    workspaceCwd: '/tmp/project-b',
    scope: { kind: 'project', projectKey: 'project-b' },
    canonicalAddress: 'machine.project-b.Jenny',
    agentId: 'interaction-default',
    role: 'project-lead',
  }
  assert.deepEqual(
    {
      available: entryWorkspaceSelection('?projectKey=project-b&scope=project&mode=rcc', emptyHttpTopic).available,
      label: entryWorkspaceSelection('?projectKey=project-b&scope=project&mode=rcc', emptyHttpTopic).label,
    },
    { available: true, label: 'project-b · Jenny' },
  )
})

// Failure basis: the conversation API was created without the URL scope, so a
// page could read and write the serve-bound session. Impact: Alex turns or SSE
// events could cross into another identity. Cost: one fetch stub, no runtime.
test('one Alex runtime client carries the scope through every conversation edge', async () => {
  const requests = []
  const api = createRuntimeApi({
    baseUrl: 'http://scope.test',
    conversationScope: { kind: 'alex' },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method || 'GET' })
      return { ok: true, status: 200, json: async () => ({ interactionId: 'interaction-1', state: 'received' }) }
    },
  })
  await api.readMainTopic()
  await api.receiveExplicitInput({ sourceRef: 'ui:entry', rawInput: 'hello', inputRevision: 1 })
  await api.inspectExplicitInteraction('interaction-1')
  await api.interpretExplicitInput('interaction-1')
  await api.continueExplicitPartial('interaction-1', 'partial-1')
  await api.answerExplicitClarification('interaction-1', 'answer')
  await api.confirmExplicitRequirement('interaction-1', { draftId: 'draft-1', inputRevision: 1 })
  const stream = api.explicitEventsUrl('interaction-1')
  const executionStream = api.eventsUrl('operation-1')
  const taskStream = api.taskEventsUrl('task-1')

  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'POST', 'GET', 'POST', 'POST', 'POST', 'POST'])
  for (const request of requests) {
    const url = new URL(request.url)
    assert.equal(url.searchParams.getAll('scope').length, 1, request.url)
    assert.equal(url.searchParams.get('scope'), 'system', request.url)
  }
  const streamUrl = new URL(stream)
  assert.equal(streamUrl.pathname, '/api/explicit/interactions/interaction-1/events')
  assert.equal(streamUrl.searchParams.getAll('scope').length, 1)
  assert.equal(streamUrl.searchParams.get('scope'), 'system')
  const executionStreamUrl = new URL(executionStream)
  assert.equal(executionStreamUrl.pathname, '/api/executions/operation-1/events')
  assert.equal(executionStreamUrl.searchParams.getAll('scope').length, 1)
  assert.equal(executionStreamUrl.searchParams.get('scope'), 'system')
  const taskStreamUrl = new URL(taskStream)
  assert.equal(taskStreamUrl.pathname, '/api/tasks/task-1/events')
  assert.equal(taskStreamUrl.searchParams.getAll('scope').length, 1)
  assert.equal(taskStreamUrl.searchParams.get('scope'), 'system')
  assert.equal(taskStreamUrl.searchParams.has('projectKey'), false)
})

test('the project selector remains explicit on conversation reads and streams', async () => {
  const urls = []
  const api = createRuntimeApi({
    baseUrl: 'http://scope.test',
    conversationScope: { kind: 'project', projectKey: 'project / 中文' },
    fetchImpl: async (url) => {
      urls.push(String(url))
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  await api.readMainTopic()
  const stream = api.explicitEventsUrl('interaction-1')
  const executionStream = api.eventsUrl('operation-1')
  const taskStream = api.taskEventsUrl({ scope: 'task', value: 'task / 中文' })
  for (const value of [...urls, stream, executionStream, taskStream]) {
    const url = new URL(value)
    assert.equal(url.searchParams.getAll('scope').length, 1)
    assert.equal(url.searchParams.get('scope'), 'project')
    assert.equal(url.searchParams.getAll('projectKey').length, 1)
    assert.equal(url.searchParams.get('projectKey'), 'project / 中文')
  }
  assert.equal(new URL(taskStream).pathname, '/api/tasks/task%20%2F%20%E4%B8%AD%E6%96%87/events')
})
test('project navigation carries the public key and execution mode without inventing members', () => {
  const href = entryProjectHref('memory.html', 'project / 中文', 'rcc')
  const url = new URL(href, 'http://localhost/')
  assert.equal(url.pathname, '/memory.html')
  assert.equal(url.searchParams.get('projectKey'), 'project / 中文')
  assert.equal(url.searchParams.get('mode'), 'rcc')
  assert.equal(url.searchParams.has('sessionId'), false)
  const tasks = new URL(entryProjectHref('tasks.html', 'project-a', 'rcc'), 'http://localhost/')
  assert.equal(tasks.searchParams.get('projectKey'), 'project-a')
  assert.equal(tasks.searchParams.has('mode'), false)
  const jenny = new URL(entryProjectHref('index.html', 'project-a', 'rcc'), 'http://localhost/')
  assert.equal(jenny.pathname, '/index.html')
  assert.equal(jenny.searchParams.get('projectKey'), 'project-a')
  assert.equal(jenny.searchParams.get('mode'), 'rcc')
})

test('a filtered current project is not added back unless the URL explicitly opened it', () => {
  const current = { projectKey: 'test-project', projectName: '测试项目', mode: 'rcc' }
  const systemRead = { projects: [{ scope: { projectKey: 'real-project' }, label: '真实项目' }] }
  assert.deepEqual(entryProjectRows({ systemRead, current, search: '' }).map((row) => row.scope.projectKey), ['real-project'])
  assert.deepEqual(
    entryProjectRows({ systemRead, current, search: '?projectKey=test-project&mode=rcc' }).map((row) => row.scope.projectKey),
    ['real-project', 'test-project'],
  )
  assert.deepEqual(entryProjectRows({ systemRead: null, current, search: '' }), [])
  assert.deepEqual(
    entryProjectRows({ systemRead, current, search: '?scope=system&projectKey=test-project&mode=rcc' }).map((row) => row.scope.projectKey),
    ['real-project'],
  )
})

// Failure basis: the folder title used the path basename while the project row
// used the persisted alias, so one workspace appeared under two names. Impact:
// users cannot tell which name is authoritative after refresh. Cost: one pure
// string assertion with no browser process.
test('workspace folder title uses the Config alias and keeps the path basename fallback', () => {
  assert.equal(workspaceFolderName('/work/project-a', '产品工作区'), '产品工作区')
  assert.equal(workspaceFolderName('/work/project-a', '  '), 'project-a')
  assert.equal(workspaceFolderName('', undefined), '未关联工作区')
})
