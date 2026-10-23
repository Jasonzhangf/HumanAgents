/**
 * Dashboard read scope defaults (docs/ui/dashboard.js).
 *
 * The Dashboard must resolve its board read scope from the live serve binding
 * first: GET /api/runtime/status carries the one `projectKey` and `mode` the
 * serve is bound to. An unparameterised entry URL must therefore open the bound
 * project instead of guessing through the configured-project read, which is
 * ambiguous with 47 configured projects and 5 stale failures. The
 * configured-project read stays as the fallback only when the runtime itself
 * has no project binding, and an ambiguous catalog stays unresolved rather
 * than guessing. A failed status read names the failure instead of inventing
 * a scope.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as runtimeShell from '../../docs/ui/runtime-shell.js'
import { resolveBoardReadDefaults } from '../../docs/ui/dashboard.js'

function boundStatus(projectKey, mode) {
  return { status: { projectKey, mode }, error: null }
}

test('a bare Dashboard URL opens the serve-bound project from runtime status', async () => {
  const defaults = await resolveBoardReadDefaults({ search: '', loadStatus: async () => boundStatus('project-a', 'rcc') })
  assert.deepEqual(defaults, { projectKey: 'project-a', mode: 'rcc' })
})

test('a status read failure names the failure instead of inventing a scope', async () => {
  const failure = Object.assign(new Error('runtime status unavailable'), { code: 'runtime.status.failed' })
  const defaults = await resolveBoardReadDefaults({ search: '', loadStatus: async () => ({ status: null, error: failure }) })
  assert.equal(defaults.failure, failure)
  assert.equal(defaults.projectKey, '')
  assert.equal(defaults.mode, undefined)
})

test('an explicit URL project and mode win over the runtime binding', async () => {
  const defaults = await resolveBoardReadDefaults({
    search: '?projectKey=project-b&mode=fake',
    loadStatus: async () => {
      throw new Error('status must not be read when the URL already resolves the scope')
    },
  })
  assert.deepEqual(defaults, { projectKey: 'project-b', mode: 'fake' })
})

test('an explicit URL project keeps its scope and borrows only the runtime mode', async () => {
  const defaults = await resolveBoardReadDefaults({ search: '?projectKey=project-b', loadStatus: async () => boundStatus('project-a', 'rcc') })
  assert.equal(defaults.projectKey, 'project-b')
  assert.equal(defaults.mode, 'rcc')
})

test('an unbound runtime falls back to the configured-project read', async () => {
  const calls = []
  const original = runtimeShell.api.systemDashboard
  runtimeShell.api.systemDashboard = async () => {
    calls.push('systemDashboard')
    return {
      runtime: { mode: 'fake' },
      projects: [{ scope: { projectKey: 'only-project' }, tasks: [{ basis: 'live-runtime' }] }],
    }
  }
  try {
    const defaults = await resolveBoardReadDefaults({ search: '', loadStatus: async () => ({ status: { mode: 'fake' }, error: null }) })
    assert.deepEqual(calls, ['systemDashboard'])
    assert.deepEqual(defaults, { projectKey: 'only-project', mode: 'fake' })
  } finally {
    runtimeShell.api.systemDashboard = original
  }
})

test('an ambiguous catalog stays unresolved instead of guessing', async () => {
  const original = runtimeShell.api.systemDashboard
  runtimeShell.api.systemDashboard = async () => ({
    runtime: { mode: 'rcc' },
    projects: [
      { scope: { projectKey: 'project-a' }, tasks: [{ basis: 'live-runtime' }] },
      { scope: { projectKey: 'project-b' }, tasks: [{ basis: 'live-runtime' }] },
    ],
  })
  try {
    const defaults = await resolveBoardReadDefaults({ search: '', loadStatus: async () => ({ status: {}, error: null }) })
    assert.equal(defaults.projectKey, '')
    assert.equal(defaults.mode, 'rcc')
  } finally {
    runtimeShell.api.systemDashboard = original
  }
})
