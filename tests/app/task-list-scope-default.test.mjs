/**
 * Task List default read scope (docs/ui/tasks.js).
 *
 * The Task List page must default its read scope to the live serve binding the
 * same way the Dashboard does: when the URL carries no explicit
 * projectKey/mode, `resolveTasksReadScope` uses `status.projectKey` plus
 * `status.mode` from the runtime status projection. An explicit URL scope
 * always wins, a failed runtime status read never invents a scope, and the
 * bare system scope stays reachable when the serve has no project binding.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveTasksReadScope } from '../../docs/ui/tasks.js'

const BOUND_STATUS = { status: { projectKey: 'project-a', mode: 'fake' }, error: null }

test('a bare Task List URL defaults to the serve-bound project scope', () => {
  const scope = resolveTasksReadScope('', BOUND_STATUS)
  assert.equal(scope.kind, 'project')
  assert.equal(scope.projectKey, 'project-a')
  assert.equal(scope.mode, 'fake')
})

test('an explicit URL project scope wins over the serve default', () => {
  const scope = resolveTasksReadScope('projectKey=other-project', BOUND_STATUS)
  assert.equal(scope.kind, 'project')
  assert.equal(scope.projectKey, 'other-project')
})

test('an explicit task deep link keeps its exact scope over the serve default', () => {
  const scope = resolveTasksReadScope('task=task-a&projectKey=project-a&mode=fake', BOUND_STATUS)
  assert.equal(scope.kind, 'task')
  assert.equal(scope.projectKey, 'project-a')
  assert.equal(scope.mode, 'fake')
  assert.equal(scope.taskId.value, 'task-a')
})

test('a failed runtime status read keeps the bare system scope, not a guessed one', () => {
  const failed = { status: null, error: new Error('status read failed') }
  assert.deepEqual(resolveTasksReadScope('', failed), { kind: 'system' })
})

test('a runtime with no project binding stays on the system scope', () => {
  assert.deepEqual(resolveTasksReadScope('', { status: { mode: 'fake' }, error: null }), { kind: 'system' })
})

test('the explicit system selection keeps the system list reachable when the serve is bound', () => {
  assert.deepEqual(resolveTasksReadScope('scope=system', BOUND_STATUS), { kind: 'system' })
})

test('an explicit projectKey still wins over the system selection', () => {
  const scope = resolveTasksReadScope('scope=system&projectKey=other-project', BOUND_STATUS)
  assert.equal(scope.kind, 'project')
  assert.equal(scope.projectKey, 'other-project')
})

test('a partial explicit scope stays invalid instead of borrowing the serve binding', () => {
  const scope = resolveTasksReadScope('mode=fake', BOUND_STATUS)
  assert.equal(scope.kind, 'invalid')
})