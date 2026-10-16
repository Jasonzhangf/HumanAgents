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

