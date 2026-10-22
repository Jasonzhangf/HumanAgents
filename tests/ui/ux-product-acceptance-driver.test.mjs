import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  evaluateRelationSurface,
  evaluateResultSurface,
  taskDashboardPath,
} from './ux-product-acceptance-browser.mjs'

const driverSource = await readFile(new URL('./ux-product-acceptance-browser.mjs', import.meta.url), 'utf8')

test('task dashboard navigation uses the product task query parameter', () => {
  const path = taskDashboardPath('task-1', { projectKey: 'project-1', mode: 'fake' })
  const url = new URL(path, 'http://product.invalid')

  assert.equal(url.searchParams.get('task'), 'task-1')
  assert.equal(url.searchParams.has('taskId'), false)
  assert.equal(url.searchParams.get('projectKey'), 'project-1')
  assert.equal(url.searchParams.get('mode'), 'fake')
})

test('missing result container cannot pass as an empty committed result', () => {
  const noContainer = evaluateResultSurface({
    focusReady: false,
    sessionViewCount: 0,
    resultBlockCount: 0,
    commitNodeCount: 0,
    output: { commits: [], resultAvailable: false },
  })
  assert.equal(noContainer.ok, false)

  const explicitEmpty = evaluateResultSurface({
    focusReady: true,
    sessionViewCount: 1,
    resultBlockCount: 0,
    commitNodeCount: 0,
    output: { commits: [], resultAvailable: false },
  })
  assert.equal(explicitEmpty.ok, true)
  assert.match(explicitEmpty.detail, /no committed result/i)

  const mountedBlocked = evaluateResultSurface({
    focusReady: true,
    sessionViewCount: 1,
    resultBlockCount: 1,
    commitNodeCount: 1,
    output: { commits: [{ text: 'committed' }], resultAvailable: true },
  })
  assert.equal(mountedBlocked.ok, true)

  const missingCommit = evaluateResultSurface({
    focusReady: true,
    sessionViewCount: 1,
    resultBlockCount: 0,
    commitNodeCount: 0,
    output: { commits: [{ text: 'committed' }], resultAvailable: true },
  })
  assert.equal(missingCommit.ok, false)
})

test('relation acceptance is derived from real relations or gaps, never a fixed true', () => {
  const missing = evaluateRelationSurface({
    relations: [],
    gaps: [],
    renderedRelationCount: 0,
    renderedGapCount: 0,
    renderedCurrentCount: 1,
    renderedNodeCount: 1,
  })
  assert.equal(missing.ok, null)

  const explicitGap = evaluateRelationSurface({
    relations: [],
    gaps: [{ code: 'relation.requirement-fact-absent', message: 'absent' }],
    renderedRelationCount: 0,
    renderedGapCount: 1,
    renderedCurrentCount: 1,
    renderedNodeCount: 1,
  })
  assert.equal(explicitGap.ok, true)

  assert.doesNotMatch(driverSource, /record\('T10\.relation-nodes',\s*true/)
  assert.doesNotMatch(driverSource, /task-dashboard\.html\?taskId=/)
})
