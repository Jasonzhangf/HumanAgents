import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeApi, RuntimeApiError } from '../../docs/ui/runtime-api.js'
import { createScopedReadPublication } from '../../docs/ui/runtime-shell.js'
import { createDisplayPreferenceController } from '../../docs/ui/display-preferences.js'
import {
  commitScopedReadTransition,
  unavailableModeFailure,
} from '../../docs/ui/task-display.js'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function resource(mode, defaultMode = 'current') {
  return {
    preference: { schemaVersion: 1, mode, lastManual: null },
    defaultMode,
  }
}

function publication({
  published = true,
  reason = 'published',
  content,
  stale = false,
  failure,
} = {}) {
  return {
    published,
    reason,
    state: { content, stale, failure },
  }
}

test('runtime API exposes the exact display-preference request boundary', async () => {
  const calls = []
  const api = createRuntimeApi({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init })
      return jsonResponse(resource('current'))
    },
  })

  await api.displayPreference()
  assert.equal(calls[0].url, '/api/ui/display-preference')
  assert.equal(calls[0].init.method ?? 'GET', 'GET')

  await api.updateDisplayPreference({ kind: 'set-default', mode: 'follow-last' })
  assert.equal(calls[1].url, '/api/ui/display-preference')
  assert.equal(calls[1].init.method, 'PUT')
  assert.equal(calls[1].init.headers.get('content-type'), 'application/json')
  assert.deepEqual(JSON.parse(calls[1].init.body), { kind: 'set-default', mode: 'follow-last' })

  await api.updateDisplayPreference({ kind: 'manual-selection', mode: 'raw' })
  assert.equal(calls[2].init.method, 'PUT')
  assert.deepEqual(JSON.parse(calls[2].init.body), { kind: 'manual-selection', mode: 'raw' })

  await api.resetDisplayPreference()
  assert.equal(calls[3].url, '/api/ui/display-preference')
  assert.equal(calls[3].init.method, 'DELETE')
  assert.equal(calls[3].init.body, undefined)
})

test('runtime API keeps the existing typed error shape on a failed preference read', async () => {
  const api = createRuntimeApi({
    fetchImpl: async () => jsonResponse({
      error: {
        code: 'config.invalid',
        ownerId: 'humanagent.config',
        message: 'display preference is invalid',
        nextAction: 'fix the user configuration',
      },
    }, 500),
  })

  await assert.rejects(
    () => api.displayPreference(),
    (error) => {
      assert.equal(error instanceof RuntimeApiError, true)
      assert.equal(error.code, 'config.invalid')
      assert.equal(error.ownerId, 'humanagent.config')
      assert.equal(error.nextAction, 'fix the user configuration')
      assert.equal(error.status, 500)
      return true
    },
  )
})

test('a successful scoped read commits staged content exactly once', async () => {
  const committed = []
  const receipt = await commitScopedReadTransition({
    read: async () => publication({ content: { actions: [{ id: 'action-1' }] } }),
    build: (content) => ({ kind: 'staged', content }),
    commit: (staged) => committed.push(staged),
  })

  assert.deepEqual(receipt, {
    ok: true,
    content: { actions: [{ id: 'action-1' }] },
    render: { kind: 'staged', content: { actions: [{ id: 'action-1' }] } },
  })
  assert.deepEqual(committed, [{ kind: 'staged', content: { actions: [{ id: 'action-1' }] } }])
})

test('a failed or stale scoped read never commits over prior content', async () => {
  let committed = false
  const failed = await commitScopedReadTransition({
    read: async () => publication({
      published: true,
      reason: 'read-failed',
      content: undefined,
      stale: false,
      failure: {
        code: 'records.read.failed',
        ownerId: 'humanagent.runtime',
        message: 'records are unavailable',
        nextAction: 'retry the records read',
      },
    }),
    build: () => ({ kind: 'must-not-build' }),
    commit: () => { committed = true },
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.failure.code, 'records.read.failed')
  assert.equal(committed, false)

  const stale = await commitScopedReadTransition({
    read: async () => publication({
      published: true,
      reason: 'read-failed',
      content: { actions: [{ id: 'previous' }] },
      stale: true,
      failure: {
        code: 'records.read.failed',
        ownerId: 'humanagent.runtime',
        message: 'refresh failed',
        nextAction: 'retry the same scoped read',
      },
    }),
    build: () => ({ kind: 'must-not-build' }),
    commit: () => { committed = true },
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.stale, true)
  assert.equal(committed, false)

  const superseded = await commitScopedReadTransition({
    read: async () => publication({ published: false, reason: 'discarded-late' }),
    build: () => ({ kind: 'must-not-build' }),
    commit: () => { committed = true },
  })
  assert.equal(superseded.ok, false)
  assert.equal(superseded.superseded, true)
  assert.equal(committed, false)
})

function modeSurface(order, updates, view) {
  return {
    applyMode: async ({ mode }) => {
      const receipt = await commitScopedReadTransition({
        read: async () => view.receipt(mode),
        build: (content) => ({ mode, content }),
        commit: (staged) => {
          view.content = staged.mode
          order.push('commit')
        },
      })
      return receipt.ok ? { ok: true, mode } : { ok: false, failure: receipt.failure }
    },
  }
}

test('a successful Actions render commits before a follow-last manual receipt', async () => {
  const order = []
  const updates = []
  const view = {
    content: 'dashboard',
    receipt: (mode) => publication({ content: { actions: [{ id: `${mode}-action` }] } }),
  }
  const controller = createDisplayPreferenceController({
    client: {
      displayPreference: async () => resource('follow-last', 'current'),
      updateDisplayPreference: async (update) => {
        order.push('manual-receipt')
        updates.push(update)
        return resource('follow-last', 'actions')
      },
      resetDisplayPreference: async () => {
        throw new Error('reset is not used in this case')
      },
    },
    surface: modeSurface(order, updates, view),
  })

  const initialized = await controller.initialize({ displayParam: undefined })
  assert.equal(initialized.ok, true)
  order.length = 0
  const selected = await controller.selectMode('actions')

  assert.equal(selected.ok, true)
  assert.deepEqual(order, ['commit', 'manual-receipt'])
  assert.deepEqual(updates, [{ kind: 'manual-selection', mode: 'actions' }])
  assert.equal(view.content, 'actions')
})

test('a stale or failed Actions render keeps prior content and sends no manual receipt', async () => {
  const order = []
  const updates = []
  const view = {
    content: 'dashboard',
    receipt: () => publication({
      published: true,
      reason: 'read-failed',
      content: undefined,
      stale: true,
      failure: {
        code: 'records.read.failed',
        ownerId: 'humanagent.runtime',
        message: 'the scoped records read did not succeed',
        nextAction: 'retry the same scoped records read',
      },
    }),
  }
  const controller = createDisplayPreferenceController({
    client: {
      displayPreference: async () => resource('follow-last', 'current'),
      updateDisplayPreference: async (update) => {
        updates.push(update)
        throw new Error('a failed read must never persist')
      },
      resetDisplayPreference: async () => {
        throw new Error('reset is not used in this case')
      },
    },
    surface: modeSurface(order, updates, view),
  })

  await controller.initialize({ displayParam: undefined })
  updates.length = 0
  const selected = await controller.selectMode('actions')

  assert.equal(selected.ok, false)
  assert.equal(selected.failure.code, 'records.read.failed')
  assert.equal(view.content, 'dashboard')
  assert.equal(order.length, 0)
  assert.deepEqual(updates, [])
})

test('a save rejection keeps the rendered view and the previous persisted preference', async () => {
  const order = []
  const updates = []
  const view = {
    content: 'dashboard',
    receipt: (mode) => publication({ content: { actions: [{ id: `${mode}-action` }] } }),
  }
  const controller = createDisplayPreferenceController({
    client: {
      displayPreference: async () => resource('follow-last', 'current'),
      updateDisplayPreference: async (update) => {
        updates.push(update)
        throw new Error('preference read is required before mutation')
      },
      resetDisplayPreference: async () => {
        throw new Error('reset is not used in this case')
      },
    },
    surface: modeSurface(order, updates, view),
  })

  await controller.initialize({ displayParam: undefined })
  updates.length = 0
  const selected = await controller.selectMode('actions')

  assert.equal(selected.ok, true)
  assert.equal(view.content, 'actions')
  assert.equal(controller.getState().unsaved, true)
  assert.equal(controller.getState().preference.mode, 'follow-last')
})

test('default Save/Reset use the controller and a draft change alone sends no write', async () => {
  const updates = []
  let resets = 0
  const controller = createDisplayPreferenceController({
    client: {
      displayPreference: async () => resource('current', 'current'),
      updateDisplayPreference: async (update) => {
        updates.push(update)
        return resource(update.mode, update.mode === 'follow-last' ? 'current' : update.mode)
      },
      resetDisplayPreference: async () => {
        resets += 1
        return resource('current', 'current')
      },
    },
    surface: {
      applyMode: async ({ mode }) => ({ ok: true, mode }),
    },
  })

  await controller.initialize({ displayParam: undefined })
  assert.deepEqual(updates, [])

  const saved = await controller.saveDefault('raw')
  assert.equal(saved.ok, true)
  assert.deepEqual(updates, [{ kind: 'set-default', mode: 'raw' }])

  const reset = await controller.reset()
  assert.equal(reset.ok, true)
  assert.equal(resets, 1)
})

test('semantic stays an explicit unavailable receipt instead of a rendered mode', async () => {
  const failure = unavailableModeFailure('semantic', '权威当前与历史发布接口尚未接入')
  assert.equal(failure.code, 'display-preference.mode-unavailable')
  assert.equal(failure.ownerId, 'humanagent.ui')
  assert.match(failure.message, /权威当前与历史/)
})

test('real scoped publication keeps prior content on a same-scope refresh failure', async () => {
  let calls = 0
  const read = createScopedReadPublication(async () => {
    calls += 1
    if (calls === 1) return { rows: [{ id: 'confirmed-action' }] }
    const failure = new Error('records refresh failed')
    failure.code = 'records.read.failed'
    failure.ownerId = 'humanagent.runtime'
    failure.nextAction = 'retry the same scoped read'
    throw failure
  })
  const scope = { kind: 'task', projectKey: 'p1', mode: 'rcc', taskId: { value: 't1' }, view: 'actions' }
  const log = []

  const first = await commitScopedReadTransition({
    read: async () => read.refresh(scope),
    build: (content) => {
      log.push('build-1')
      return { staged: content }
    },
    commit: () => log.push('commit-1'),
  })
  assert.equal(first.ok, true)
  assert.deepEqual(log, ['build-1', 'commit-1'])

  log.length = 0
  const second = await commitScopedReadTransition({
    read: async () => read.refresh(scope),
    build: () => log.push('build-2'),
    commit: () => log.push('commit-2'),
  })
  assert.equal(second.ok, false)
  assert.equal(second.stale, true)
  assert.equal(second.failure.code, 'records.read.failed')
  assert.deepEqual(log, [])
})

test('a late publication is superseded and never commits over a newer scope', async () => {
  let resolveFirst
  const firstRequest = new Promise((resolve) => { resolveFirst = resolve })
  let calls = 0
  const read = createScopedReadPublication(async (scope) => {
    calls += 1
    if (calls === 1) return firstRequest
    return { rows: [{ id: `${scope.view}-confirmed` }] }
  })
  const firstScope = { kind: 'task', projectKey: 'p1', mode: 'rcc', taskId: { value: 't1' }, view: 'actions' }
  const newerScope = { ...firstScope, view: 'raw' }

  const firstPending = read.refresh(firstScope)
  const newer = await read.refresh(newerScope)
  assert.equal(newer.published, true)
  resolveFirst({ rows: [{ id: 'late-actions' }] })
  const late = await firstPending
  assert.equal(late.published, false)
  assert.equal(late.reason, 'discarded-late')

  const transition = await commitScopedReadTransition({
    read: async () => late,
    build: () => { throw new Error('a late publication must not build') },
    commit: () => { throw new Error('a late publication must not commit') },
  })
  assert.equal(transition.ok, false)
  assert.equal(transition.superseded, true)
})
