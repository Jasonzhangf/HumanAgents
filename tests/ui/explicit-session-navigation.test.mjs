import test from 'node:test'
import assert from 'node:assert/strict'
import { cardSelection } from '../../docs/ui/dashboard.js'
import { decodeProductLocation } from '../../docs/ui/product-location.js'

// Observed failure: a real project session card only changed the board hash.
// This cheap consumer test must fail if task context is invented or mode lost.
test('project explicit session opens the focus page with exact identity and service mode', () => {
  const scope = { kind: 'project', projectKey: 'project-exact' }
  const ref = { kind: 'session', sessionRef: { sourceKind: 'explicit-intake', sourceRef: 'interaction-1' }, scope }
  const selected = cardSelection({ lane: 'live', ref }, { board: 'interaction', mode: 'rcc' })
  assert.ok(selected.href, 'explicit session needs a real focus page')
  const url = new URL(selected.href, 'http://localhost/')
  assert.equal(url.pathname, '/task-dashboard.html')
  assert.equal(url.searchParams.get('mode'), 'rcc')
  assert.equal(url.searchParams.get('projectKey'), scope.projectKey)
  assert.equal(url.searchParams.has('task'), false)
  assert.deepEqual(decodeProductLocation(url.hash).location.focus, ref)
  assert.equal(cardSelection({ lane: 'history', ref: { ...ref, sessionRef: { sourceKind: 'memory', sourceRef: 'other' } } }, { board: 'memory', mode: 'rcc' }).href, null)
})
