import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createRuntimeApi,
  createRuntimeReadPublication,
  readScopeKey,
} from '../../docs/ui/runtime-api.js'
import { checkpointQuery } from '../../docs/ui/checkpoint-history.js'

// Real exported seam only: the production builders task-dashboard.js calls
// (api.taskCheckpointHistory and the frozen four-key checkpointQuery helper) plus
// the scoped-read identity owner. No copied page handler, no DOM, no
// source-string assertion. This pins the concrete ways the glue can go wrong.

function recordingApi() {
  const calls = []
  const api = createRuntimeApi({
    fetchImpl: async (url) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => ({ surface: 'runtime-checkpoint-history' }) }
    },
  })
  return { api, calls }
}

const taskId = { scope: 'task', value: 'task-1' }
const CATALOG_SCOPE = {
  kind: 'task', projectKey: 'project-7', mode: 'rcc',
  taskId: { value: 'task-1' }, view: 'checkpoint-history',
}
const RECEIPT_B = { commitId: 'commit-57', journalSeq: 57, recordDigest: 'digest-57' }
function requestParams(url) {
  return new URLSearchParams(url.split('?')[1] || '')
}

// The exact four-key selection an asset body read must address. A body read is
// the same checkpoint target as the history read, so it uses the frozen helper
// output rather than a second encoding.
function bodyCheckpointSelection() {
  return encodeViewed({ checkpointId: 'ck-b', commitRef: RECEIPT_B })
}

function encodeViewed(viewed) {
  const encoded = checkpointQuery(new URLSearchParams(), viewed === undefined ? {} : { viewed })
  assert.equal(encoded.ok, true)
  return encoded.value
}

test('F1 the checkpoint GET forwards the validated four-key selection and filters, never the old viewed key', async () => {
  const { api, calls } = recordingApi()
  const selection = encodeViewed({ checkpointId: 'ck-b', commitRef: RECEIPT_B })
  await api.taskCheckpointHistory(taskId, {
    projectKey: 'project-7',
    mode: 'rcc',
    checkpointQuery: selection,
    directiveRevision: 2,
    executionEpoch: 6,
    cycleId: 'cycle-1',
    occurrenceRef: 'occ-9',
    cursor: 'cursor-1',
  })
  const params = requestParams(calls[0])
  assert.equal(params.get('projectKey'), 'project-7')
  assert.equal(params.get('mode'), 'rcc')
  assert.equal(params.get('checkpointId'), 'ck-b')
  assert.equal(params.get('checkpointCommitId'), 'commit-57')
  assert.equal(params.get('checkpointJournalSeq'), '57')
  assert.equal(params.get('checkpointRecordDigest'), 'digest-57')
  assert.equal(params.get('directiveRevision'), '2')
  assert.equal(params.get('executionEpoch'), '6')
  assert.equal(params.get('cycleId'), 'cycle-1')
  assert.equal(params.get('occurrenceRef'), 'occ-9')
  assert.equal(params.get('cursor'), 'cursor-1')
  assert.equal(params.has('viewed'), false, 'the old single-key viewed selection must be gone')

  // A no-selection read follows the authoritative current: no checkpoint key at all.
  const none = recordingApi()
  await none.api.taskCheckpointHistory(taskId, { projectKey: 'project-7', mode: 'rcc' })
  const empty = requestParams(none.calls[0])
  assert.equal(empty.has('checkpointId'), false)
  assert.equal(empty.has('checkpointCommitId'), false)
})

test('F2 a different checkpoint selection is a different read identity and a failed re-selection keeps no prior content', async () => {
  const selectionA = encodeViewed({ checkpointId: 'ck-a' })
  const selectionB = encodeViewed({ checkpointId: 'ck-b' })
  assert.equal(readScopeKey(CATALOG_SCOPE), readScopeKey({ ...CATALOG_SCOPE }))
  assert.notEqual(
    readScopeKey(CATALOG_SCOPE),
    readScopeKey({ ...CATALOG_SCOPE, checkpointQuery: selectionA }),
    'an explicit selection is a different read than the current read',
  )
  assert.notEqual(
    readScopeKey({ ...CATALOG_SCOPE, checkpointQuery: selectionA }),
    readScopeKey({ ...CATALOG_SCOPE, checkpointQuery: selectionB }),
    'two different checkpoint selections are two different reads',
  )
  assert.equal(
    readScopeKey({ ...CATALOG_SCOPE, checkpointQuery: selectionA }),
    readScopeKey({ ...CATALOG_SCOPE, checkpointQuery: encodeViewed({ checkpointId: 'ck-a' }) }),
  )

  // The publication owner the page renders through must never re-publish the
  // previous selection's content for a failed new selection.
  let mode = 'ck-a'
  const publication = createRuntimeReadPublication({
    read: async () => {
      if (mode === 'ck-a') {
        return { ok: true, value: { surface: 'runtime-checkpoint-history', marker: 'ck-a' } }
      }
      return {
        ok: false,
        failure: {
          code: 'checkpoint.read.failed',
          ownerId: 'humanagent.app',
          message: 'no such checkpoint',
          nextAction: 'choose an existing checkpoint',
        },
      }
    },
  })
  const first = await publication.refresh({ ...CATALOG_SCOPE, checkpointQuery: selectionA })
  assert.equal(first.published, true)
  assert.equal(publication.state().content.marker, 'ck-a')

  mode = 'ck-b'
  const second = await publication.refresh({ ...CATALOG_SCOPE, checkpointQuery: selectionB })
  assert.equal(second.published, true)
  assert.equal(second.reason, 'read-failed')
  assert.equal(publication.state().content, undefined, 'a failed new selection must not fall back to ck-a content')
  assert.equal(publication.state().stale, false)
  assert.equal(publication.state().failure.code, 'checkpoint.read.failed')
})

// Failure mode: a scoped publication exposes mutable nested content, so one
// consumer can rewrite another consumer and the current publication without a
// new request. Basis: the public factory currently shares the exact value it
// received and only freezes the outer snapshot. Impact: confirmed business
// content changes without a version or request serial change. Cost: low, this
// reuses the existing Node publication consumer and adds no framework.
test('G12 shared publication content blocks nested and array writes while preserving identity and old versions', async () => {
  let version = 1
  const publication = createRuntimeReadPublication({
    read: async () => {
      if (version === 2) {
        return {
          ok: true,
          value: {
            surface: 'runtime-checkpoint-history',
            version: 2,
            statusSections: { business: 'new-business', technical: 'new-technical' },
            evidence: ['new-one', 'new-two'],
          },
        }
      }
      if (version === 'failed') {
        return {
          ok: false,
          failure: {
            code: 'checkpoint.read.failed',
            ownerId: 'humanagent.app',
            message: 'same-scope refresh failed',
            nextAction: 'retry the same checkpoint read',
          },
        }
      }
      return {
        ok: true,
        value: {
          surface: 'runtime-checkpoint-history',
          version: 1,
          statusSections: { business: 'confirmed-business', technical: 'confirmed-technical' },
          evidence: ['confirmed-one', 'confirmed-two'],
        },
      }
    },
  })

  await publication.refresh(CATALOG_SCOPE)
  const first = publication.state()
  const second = publication.state()
  assert.equal(first.content, second.content, 'consumers of one publication must share the same content object')
  assert.equal(first.content.statusSections, second.content.statusSections)
  assert.equal(first.content.evidence, second.content.evidence)

  function mutationBlocked(mutate) {
    try {
      mutate()
      return false
    } catch (error) {
      return error instanceof TypeError
    }
  }

  const propertyBlocked = mutationBlocked(() => {
    first.content.statusSections.business = 'consumer-mutated'
  })
  const arrayPushBlocked = mutationBlocked(() => {
    first.content.evidence.push('consumer-mutated')
  })
  const arrayIndexBlocked = mutationBlocked(() => {
    first.content.evidence[0] = 'consumer-mutated'
  })
  assert.deepEqual(
    { propertyBlocked, arrayPushBlocked, arrayIndexBlocked },
    { propertyBlocked: true, arrayPushBlocked: true, arrayIndexBlocked: true },
  )
  assert.equal(second.content.statusSections.business, 'confirmed-business')
  assert.deepEqual(second.content.evidence, ['confirmed-one', 'confirmed-two'])
  assert.equal(publication.state().content.statusSections.business, 'confirmed-business')
  assert.equal(publication.state().requestSerial, 1)

  version = 2
  await publication.refresh(CATALOG_SCOPE)
  const next = publication.state()
  assert.notEqual(next.content, first.content, 'a new version must replace the shared content reference')
  assert.equal(next.content.version, 2)
  assert.equal(first.content.version, 1)
  assert.equal(first.content.statusSections.business, 'confirmed-business')
  assert.deepEqual(first.content.evidence, ['confirmed-one', 'confirmed-two'])

  version = 'failed'
  await publication.refresh(CATALOG_SCOPE)
  const stale = publication.state()
  assert.equal(stale.stale, true)
  assert.equal(stale.content, next.content, 'same-scope failure must keep the latest confirmed object by identity')
  assert.equal(mutationBlocked(() => {
    stale.content.statusSections.business = 'stale-consumer-mutated'
  }), true)
  assert.equal(stale.content.statusSections.business, 'new-business')
})

// Failure mode: a body read sends the descriptor, scope, locator or an invented
// control key as authority, or addresses a different checkpoint than the one the
// user opened. Basis: the frozen route takes projectKey/mode plus the same four
// checkpoint selection keys and names the asset only by role or by the exact
// adopted-child triple. Impact: the read would resolve the wrong durable
// artifact; high. Cost: low, the real recording fetch seam already used by F1.
test('G14 the asset body GET addresses the exact checkpoint and selector, never the descriptor', async () => {
  const { api, calls } = recordingApi()
  await api.taskCheckpointAssetBody(taskId, {
    projectKey: 'project-7',
    mode: 'rcc',
    checkpointQuery: bodyCheckpointSelection(),
    selector: { kind: 'capture' },
  })
  const capture = calls[0]
  assert.match(capture, /\/api\/tasks\/task-1\/checkpoints\/assets\/capture\?/)
  const captureParams = requestParams(capture)
  assert.equal(captureParams.get('projectKey'), 'project-7')
  assert.equal(captureParams.get('mode'), 'rcc')
  assert.equal(captureParams.get('checkpointId'), 'ck-b')
  assert.equal(captureParams.get('checkpointCommitId'), 'commit-57')
  assert.equal(captureParams.get('checkpointJournalSeq'), '57')
  assert.equal(captureParams.get('checkpointRecordDigest'), 'digest-57')

  const child = recordingApi()
  await child.api.taskCheckpointAssetBody(taskId, {
    projectKey: 'project-7',
    mode: 'rcc',
    checkpointQuery: bodyCheckpointSelection(),
    selector: { kind: 'adopted-child', invocationId: 'inv 9/x', childTurnId: 'child/9', deliverySeq: 2 },
  })
  const adopted = child.calls[0]
  assert.match(adopted, /\/api\/tasks\/task-1\/checkpoints\/assets\/adopted-child\/[^?]+\?/)
  const childPath = adopted.split('?')[0]
  // The triple is percent-encoded, so a separator inside an id can never change
  // which child the path names.
  assert.equal(decodeURIComponent(childPath.split('/adopted-child/')[1]), 'inv 9/x/child/9/2')
  const childParams = requestParams(adopted)
  assert.equal(childParams.get('checkpointId'), 'ck-b')
  assert.equal(childParams.get('checkpointCommitId'), 'commit-57')
  assert.equal(childParams.get('checkpointJournalSeq'), '57')
  assert.equal(childParams.get('checkpointRecordDigest'), 'digest-57')

  // Neither body read carries a descriptor, scope, locator, digest or control key.
  for (const url of [capture, adopted]) {
    const params = requestParams(url)
    for (const key of params.keys()) {
      assert.equal(
        ['projectKey', 'mode', 'checkpointId', 'checkpointCommitId', 'checkpointJournalSeq', 'checkpointRecordDigest'].includes(key),
        true,
        `${url} must not send ${key}`,
      )
    }
    assert.equal(params.getAll('checkpointId').length, 1, 'the checkpoint identity is sent exactly once')
    assert.equal(params.has('viewed'), false)
    // The path names the asset only by role or triple, and no query key carries
    // descriptor, scope, locator or control authority.
    assert.doesNotMatch(url.split('?')[0], /locator|evidenceId|digest|steer|stop|retry|descriptor|content/)
    for (const key of params.keys()) {
      assert.doesNotMatch(key, /locator|evidenceId|view|scope|digest|steer|stop|retry|descriptor|content/)
    }
  }
})
