/**
 * W6 page consumer: task collection and read-only observation entry.
 *
 * These are page-seam assertions over the real exported helpers from tasks.js
 * and observation.js, plus the canonical product-location codec. The risky
 * failures are a legacy deep link that loses the exact task ref, a return that
 * drops projectKey/mode, and a read-only observation surface that reaches a
 * write. Browser/Back-Forward and install-level acceptance remain with V.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LEGACY_TASK_FOCUS_PAGE,
  legacyTaskFocusHref,
  legacyTasksDeepLink,
  taskFocusHref,
  taskFocusLocation,
} from '../../docs/ui/tasks.js'
import {
  observationRead,
  observationScopeFromSearch,
  observationScopeSearch,
} from '../../docs/ui/observation.js'
import { decodeProductLocation, encodeProductLocation } from '../../docs/ui/product-location.js'

const TASK_ID = { scope: 'task', value: 'task-a' }
const TASK_SCOPE = { kind: 'task', projectKey: 'project-a', mode: 'fake', taskId: TASK_ID }
const INTERACTION_FOCUS = { kind: 'interaction', taskRef: TASK_ID, scope: TASK_SCOPE }

test('a legacy task deep link resolves the exact task scope and interaction ref', () => {
  const deep = legacyTasksDeepLink('task=task-a&projectKey=project-a&mode=fake')

  assert.equal(deep.kind, 'task')
  assert.deepEqual(deep.scope, TASK_SCOPE)
  assert.deepEqual(deep.focus, INTERACTION_FOCUS)
  assert.deepEqual(deep.location, {
    board: 'interaction',
    lane: 'live',
    scope: TASK_SCOPE,
    focus: INTERACTION_FOCUS,
  })
  assert.ok(deep.href.startsWith(LEGACY_TASK_FOCUS_PAGE))

  const decoded = decodeProductLocation(deep.href)
  assert.equal(decoded.kind, 'valid')
  assert.deepEqual(decoded.location.scope, TASK_SCOPE)
  assert.deepEqual(decoded.location.focus, INTERACTION_FOCUS)
})

test('a legacy project link keeps the exact project scope and a partial task link fails explicitly', () => {
  const project = legacyTasksDeepLink('projectKey=project-a')
  assert.equal(project.kind, 'project')
  assert.deepEqual(project.scope, { kind: 'project', projectKey: 'project-a' })

  assert.deepEqual(legacyTasksDeepLink('').scope, { kind: 'system' })

  const partial = legacyTasksDeepLink('task=task-a&projectKey=project-a')
  assert.equal(partial.kind, 'invalid')
  assert.equal(partial.failure.code, 'read.scope.invalid')

  const badMode = legacyTasksDeepLink('task=task-a&projectKey=project-a&mode=dsh')
  assert.equal(badMode.kind, 'invalid')
  assert.equal(badMode.failure.code, 'read.scope.invalid')
})

test('a task-row scope and an old task-dashboard href produce the same exact focus route', () => {
  const location = taskFocusLocation(TASK_SCOPE)
  assert.deepEqual(location, {
    board: 'interaction',
    lane: 'live',
    scope: TASK_SCOPE,
    focus: INTERACTION_FOCUS,
  })

  const href = taskFocusHref(TASK_SCOPE)
  assert.equal(href, `${LEGACY_TASK_FOCUS_PAGE}?task=task-a&projectKey=project-a&mode=fake${encodeProductLocation(location)}`)

  const decoded = decodeProductLocation(href)
  assert.equal(decoded.kind, 'valid')
  assert.deepEqual(decoded.location.focus.taskRef, TASK_ID)
  assert.deepEqual(decoded.location.scope, TASK_SCOPE)

  assert.equal(
    legacyTaskFocusHref('./task-dashboard.html?task=task-a&projectKey=project-a&mode=fake'),
    href,
  )
  assert.equal(legacyTaskFocusHref('./task.html?task=task-a'), null)

  // Same input yields the same canonical route; there is no page-local
  // navigation accumulator to diverge from.
  assert.equal(taskFocusHref(TASK_SCOPE), href)
  assert.equal(legacyTasksDeepLink('task=task-a&projectKey=project-a&mode=fake').href, href)
})

test('observation return keeps the exact read scope and only edits the subtree param', () => {
  const current = new URLSearchParams('task=task-a&projectKey=project-a&mode=fake&scope=task%3A%2F%2Ftask-a%2Fobservation%2Fchild')
  assert.equal(observationScopeFromSearch(current), 'task://task-a/observation/child')

  const returned = observationScopeSearch(current, undefined)
  assert.equal(returned.get('task'), 'task-a')
  assert.equal(returned.get('projectKey'), 'project-a')
  assert.equal(returned.get('mode'), 'fake')
  assert.equal(returned.has('scope'), false)

  const descended = observationScopeSearch(
    new URLSearchParams('task=task-a&projectKey=project-a&mode=fake'),
    'task://task-a/observation/child',
  )
  assert.equal(descended.get('task'), 'task-a')
  assert.equal(descended.get('projectKey'), 'project-a')
  assert.equal(descended.get('mode'), 'fake')
  assert.equal(descended.get('scope'), 'task://task-a/observation/child')

  // Pure projection: the caller's params object is not mutated.
  assert.equal(current.get('scope'), 'task://task-a/observation/child')
})

test('observation read is read-only and never reaches a write surface', async () => {
  const reads = []
  const writes = []
  const transport = {
    observation: async () => {
      reads.push('observation')
      return { nodes: [] }
    },
    grantTaskControl: async () => { writes.push('grantTaskControl') },
    revokeTaskGrant: async () => { writes.push('revokeTaskGrant') },
    stop: async () => { writes.push('stop') },
    interveneTask: async () => { writes.push('interveneTask') },
    reviewSkill: async () => { writes.push('reviewSkill') },
    submitInput: async () => { writes.push('submitInput') },
    confirmDraft: async () => { writes.push('confirmDraft') },
  }

  const result = await observationRead(transport, {
    taskId: 'task-a',
    scopeRef: 'task://task-a/observation/child',
    selectedNodeId: undefined,
    agentQuery: undefined,
    scope: TASK_SCOPE,
  })

  assert.deepEqual(result, { nodes: [] })
  assert.deepEqual(reads, ['observation'])
  assert.deepEqual(writes, [])
})
