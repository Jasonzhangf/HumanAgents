import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  evaluateRelationSurface,
  evaluateResultSurface,
  taskDashboardPath,
} from './ux-product-acceptance-browser.mjs'
import * as driverModule from './ux-product-acceptance-browser.mjs'

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
    renderedCurrentCount: 0,
    renderedNodeCount: 0,
  })
  assert.equal(explicitGap.ok, true)

  assert.doesNotMatch(driverSource, /record\('T10\.relation-nodes',\s*true/)
  assert.doesNotMatch(driverSource, /task-dashboard\.html\?taskId=/)
})

const taskScope = {
  kind: 'task',
  projectKey: 'project-1',
  mode: 'fake',
  taskId: { scope: 'task', value: 'task-1' },
}
const interactionFocus = {
  kind: 'interaction',
  taskRef: { scope: 'task', value: 'task-1' },
  scope: taskScope,
}
const readySurface = {
  centerReady: true,
  focusScope: 'task:project-1:fake:task-1',
  sessionHostCount: 1,
  messageCount: 1,
  emptyCount: 0,
  unavailableCount: 0,
  unavailableCode: '',
}
const sessionBody = {
  boardIndex: { scope: taskScope },
  messages: [{ targetRef: interactionFocus, text: 'real body' }],
}

test('a session read with HTTP 500 cannot settle as a successful target body', () => {
  const evaluation = driverModule.evaluateSessionReadEvidence({
    receipts: [{ status: 500, body: { error: { code: 'product-session.read.failed' } } }],
    surface: {
      ...readySurface,
      messageCount: 0,
      unavailableCount: 1,
      unavailableCode: 'product-session.read.failed · upstream failed',
    },
    expectedScope: taskScope,
    expectedFocus: interactionFocus,
    contractUnavailable: false,
  })
  assert.equal(evaluation.ok, false)
  assert.match(evaluation.detail, /500/)
})

test('a session body from a different scope cannot pass even when the page shows messages', () => {
  const otherScope = {
    ...taskScope,
    taskId: { scope: 'task', value: 'task-old' },
  }
  const evaluation = driverModule.evaluateSessionReadEvidence({
    receipts: [{
      status: 200,
      search: { projectKey: 'project-1', mode: 'fake', taskId: 'task-1' },
      body: { boardIndex: { scope: otherScope }, messages: [sessionBody.messages[0]] },
    }],
    surface: readySurface,
    expectedScope: taskScope,
    expectedFocus: interactionFocus,
    contractUnavailable: false,
  })
  assert.equal(evaluation.ok, false)
  assert.match(evaluation.detail, /scope/i)
})

test('a rejected session center with no successful receipt cannot count as ready', () => {
  const evaluation = driverModule.evaluateSessionReadEvidence({
    receipts: [],
    surface: {
      ...readySurface,
      messageCount: 0,
      unavailableCount: 1,
      unavailableCode: 'product-session.read.failed · transport rejected',
    },
    expectedScope: taskScope,
    expectedFocus: interactionFocus,
    contractUnavailable: false,
  })
  assert.equal(evaluation.ok, false)
  assert.match(evaluation.detail, /receipt|unavailable/i)
})

test('successful session evidence must match the rendered body and focus target', () => {
  const good = driverModule.evaluateSessionReadEvidence({
    receipts: [{
      status: 200,
      search: { projectKey: 'project-1', mode: 'fake', taskId: 'task-1' },
      body: sessionBody,
    }],
    surface: readySurface,
    expectedScope: taskScope,
    expectedFocus: interactionFocus,
    contractUnavailable: false,
  })
  assert.equal(good.ok, true)

  const stale = driverModule.evaluateSessionReadEvidence({
    receipts: [{
      status: 200,
      search: { projectKey: 'project-1', mode: 'fake', taskId: 'task-1' },
      body: { boardIndex: { scope: taskScope }, messages: [] },
    }],
    surface: readySurface,
    expectedScope: taskScope,
    expectedFocus: interactionFocus,
    contractUnavailable: false,
  })
  assert.equal(stale.ok, false)

  const staleText = driverModule.evaluateSessionReadEvidence({
    receipts: [{
      status: 200,
      search: { projectKey: 'project-1', mode: 'fake', taskId: 'task-1' },
      body: sessionBody,
    }],
    surface: { ...readySurface, messageTexts: ['old body'] },
    expectedScope: taskScope,
    expectedFocus: interactionFocus,
    contractUnavailable: false,
  })
  assert.equal(staleText.ok, false)

  const wrongTarget = driverModule.evaluateSessionReadEvidence({
    receipts: [{
      status: 200,
      search: { projectKey: 'project-1', mode: 'fake', taskId: 'task-1' },
      body: {
        boardIndex: { scope: taskScope },
        messages: [{
          targetRef: { ...interactionFocus, taskRef: { scope: 'task', value: 'task-other' } },
          text: 'stale',
        }],
      },
    }],
    surface: readySurface,
    expectedScope: taskScope,
    expectedFocus: interactionFocus,
    contractUnavailable: false,
  })
  assert.equal(wrongTarget.ok, false)
})

test('a contract-unavailable target must show explicit unavailable and no stale body', () => {
  const focus = {
    kind: 'execution-instance',
    instance: {
      kind: 'native-execution',
      execution: { runtimeId: 'runtime-1', executionEpoch: 1 },
    },
    taskRef: { scope: 'task', value: 'task-1' },
    scope: taskScope,
  }
  const unavailableSurface = {
    ...readySurface,
    messageCount: 0,
    emptyCount: 0,
    unavailableCount: 1,
    unavailableCode: 'product-session.read.unavailable-target · 该执行实例暂无正文读取入口。',
  }
  const explicit = driverModule.evaluateSessionReadEvidence({
    receipts: [],
    surface: unavailableSurface,
    expectedScope: taskScope,
    expectedFocus: focus,
    contractUnavailable: true,
  })
  assert.equal(explicit.ok, true)
  assert.equal(explicit.state, 'unavailable')

  const blank = driverModule.evaluateSessionReadEvidence({
    receipts: [],
    surface: { ...unavailableSurface, unavailableCount: 0, unavailableCode: '' },
    expectedScope: taskScope,
    expectedFocus: focus,
    contractUnavailable: true,
  })
  assert.equal(blank.ok, false)
})

test('gap-only relation surface rejects fabricated relation nodes', () => {
  const fabricated = evaluateRelationSurface({
    relations: [],
    gaps: [{ code: 'relation.requirement-fact-absent', message: 'absent' }],
    renderedRelationCount: 0,
    renderedGapCount: 1,
    renderedCurrentCount: 1,
    renderedNodeCount: 1,
  })
  assert.equal(fabricated.ok, false)

  const honest = evaluateRelationSurface({
    relations: [],
    gaps: [{ code: 'relation.requirement-fact-absent', message: 'absent' }],
    renderedRelationCount: 0,
    renderedGapCount: 1,
    renderedCurrentCount: 0,
    renderedNodeCount: 0,
  })
  assert.equal(honest.ok, true)
})

test('grounded relation surface binds deduplicated relations and one current node', () => {
  const otherFocus = {
    kind: 'interaction',
    taskRef: { scope: 'task', value: 'task-2' },
    scope: { ...taskScope, taskId: { scope: 'task', value: 'task-2' } },
  }
  const relation = {
    kind: 'requirement',
    source: interactionFocus,
    target: otherFocus,
    sourceOwner: 'owner-1',
    evidenceRefs: [{}],
  }
  const base = {
    relations: [relation, relation],
    gaps: [],
    renderedRelationCount: 1,
    renderedGapCount: 0,
    renderedCurrentCount: 1,
    renderedNodeCount: 2,
  }
  assert.equal(evaluateRelationSurface(base).ok, true)
  assert.equal(evaluateRelationSurface({ ...base, renderedRelationCount: 2 }).ok, false)
  assert.equal(evaluateRelationSurface({ ...base, renderedCurrentCount: 0 }).ok, false)
})

test('T4 target must bind a real grounded relation endpoint', () => {
  const otherFocus = {
    kind: 'interaction',
    taskRef: { scope: 'task', value: 'task-2' },
    scope: { ...taskScope, taskId: { scope: 'task', value: 'task-2' } },
  }
  const relation = {
    kind: 'requirement',
    source: interactionFocus,
    target: otherFocus,
    sourceOwner: 'owner-1',
    evidenceRefs: [{}],
  }
  assert.equal(driverModule.isGroundedRelationEndpoint([relation], otherFocus), true)
  const fabricated = {
    kind: 'interaction',
    taskRef: { scope: 'task', value: 'task-9' },
    scope: { ...taskScope, taskId: { scope: 'task', value: 'task-9' } },
  }
  assert.equal(driverModule.isGroundedRelationEndpoint([relation], fabricated), false)
})
