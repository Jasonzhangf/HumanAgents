import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateExecutionProgress,
  evaluateGrantDecision,
  evaluateNavigationState,
  summarizeChecks,
} from './ux-rcc-approval-acceptance-browser.mjs'

const taskScope = {
  kind: 'task',
  projectKey: 'project-1',
  mode: 'rcc',
  taskId: { scope: 'task', value: 'task-1' },
}

const target = {
  kind: 'interaction',
  taskRef: { scope: 'task', value: 'task-1' },
  scope: taskScope,
}

function productUrl(focus = target) {
  const location = {
    board: 'interaction',
    lane: 'live',
    focus,
    scope: taskScope,
  }
  return `http://127.0.0.1:49000/task-dashboard.html?task=task-1&projectKey=project-1&mode=rcc#${encodeURIComponent('')}`
    .replace(/#$/, `#/boards/interaction/live?scope=${encodeURIComponent(JSON.stringify(location.scope))}&focus=${encodeURIComponent(JSON.stringify(location.focus))}`)
}

test('receipt evaluation refuses an empty run and a green check without evidence', () => {
  const empty = summarizeChecks([])
  assert.equal(empty.status, 'INCOMPLETE')

  const noEvidence = summarizeChecks([
    { id: 'fake-pass', status: 'PASS', detail: 'looks good', evidenceFiles: [] },
  ])
  assert.notEqual(noEvidence.status, 'PASS')
  assert.deepEqual(noEvidence.missingEvidence, ['fake-pass'])

  const realPass = summarizeChecks([
    { id: 'real-pass', status: 'PASS', detail: 'observed', evidenceFiles: ['receipt.json'] },
  ])
  assert.equal(realPass.status, 'PASS')

  const failure = summarizeChecks([
    { id: 'real-fail', status: 'FAIL', detail: 'observed failure', evidenceFiles: ['error.json'] },
  ])
  assert.equal(failure.status, 'FAIL')
})

test('grant evaluation requires the exact waiting task and a formal grant action', () => {
  const waiting = {
    kind: 'task-grant',
    state: 'waiting',
    actions: ['grant'],
    target,
    readback: { grant: null, commit: null },
  }
  assert.equal(evaluateGrantDecision({ decision: waiting, taskId: 'task-1' }).ok, true)
  assert.equal(evaluateGrantDecision({ decision: null, taskId: 'task-1' }).ok, false)
  assert.equal(evaluateGrantDecision({
    decision: { ...waiting, target: { ...target, taskRef: { scope: 'task', value: 'task-2' } } },
    taskId: 'task-1',
  }).ok, false)
  assert.equal(evaluateGrantDecision({ decision: { ...waiting, actions: ['revoke'] }, taskId: 'task-1' }).ok, false)
})

test('execution progress must leave waiting and expose a real execution or result signal', () => {
  assert.equal(evaluateExecutionProgress({
    dashboard: { state: 'waiting' },
    output: { resultAvailable: false, commits: [] },
    session: { messages: [] },
  }).ok, false)

  assert.equal(evaluateExecutionProgress({
    dashboard: { state: 'running', execution: { state: 'running' } },
    output: { resultAvailable: false, commits: [] },
    session: { messages: [] },
  }).ok, true)

  assert.equal(evaluateExecutionProgress({
    dashboard: { state: 'succeeded' },
    output: { resultAvailable: true, commits: [{ text: 'done' }] },
    session: { messages: [] },
  }).ok, true)
})

test('navigation evaluation checks URL, hash focus, scope and the real session response', () => {
  const url = productUrl()
  const good = evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    sessionStatus: 200,
    sessionBodyText: '真实执行正文',
  })
  assert.equal(good.ok, true)

  const wrongTask = {
    ...target,
    taskRef: { scope: 'task', value: 'task-2' },
    scope: { ...taskScope, taskId: { scope: 'task', value: 'task-2' } },
  }
  assert.equal(evaluateNavigationState({
    actualUrl: url,
    expectedTarget: wrongTask,
    expectedScope: taskScope,
    sessionStatus: 200,
    sessionBodyText: '真实执行正文',
  }).ok, false)

  assert.equal(evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    sessionStatus: 500,
    sessionBodyText: '真实执行正文',
  }).ok, false)

  assert.equal(evaluateNavigationState({
    actualUrl: url,
    expectedTarget: target,
    expectedScope: taskScope,
    sessionStatus: 200,
    sessionBodyText: '   ',
  }).ok, false)
})
