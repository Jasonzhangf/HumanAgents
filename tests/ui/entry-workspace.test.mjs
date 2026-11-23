import test from 'node:test'
import assert from 'node:assert/strict'
import { entryWorkspaceSelection, entryProjectHref } from '../../docs/ui/entry-workspace.js'

// Failure basis: /api/main-topic is bound to one serve project. Navigation to
// Alex or another project must not display or submit into that Jenny session.
// Impact: cross-project messages. Cost: pure public route consumer, no runtime.
const topic = { projectKey: 'project-a', projectName: '真实项目', agentName: 'Jenny', mode: 'rcc' }
test('the current project is readable, but Alex and other project/mode cannot borrow its session', () => {
  assert.equal(entryWorkspaceSelection('', topic).available, true)
  assert.equal(entryWorkspaceSelection('?projectKey=project-a&mode=rcc', topic).available, true)
  assert.equal(entryWorkspaceSelection('?scope=system', topic).available, false)
  assert.equal(entryWorkspaceSelection('?projectKey=project-b', topic).available, false)
  assert.equal(entryWorkspaceSelection('?projectKey=project-a&mode=fake', topic).available, false)
  assert.equal(entryWorkspaceSelection('?projectKey=project-a&mode=rcc', null).available, false)
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
})
