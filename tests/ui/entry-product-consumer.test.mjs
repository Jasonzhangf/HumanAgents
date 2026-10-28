/*
 * W4 entry page consumer.
 *
 * Basis: the new-task form is the single authorization point for one new
 * requirement. The risky failures are a double submit creating twice, a
 * navigation or refresh re-submitting an existing task, a lost draft on
 * browser back, and a task landing URL without the exact read scope. Impact is
 * a duplicate task or a task page opened under an ambiguous scope. Cost is a
 * small pure-controller consumer over the real page seams.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  answeredSubmissionPresentation,
  createSubmissionGate,
  entryDraftFromState,
  entryDraftState,
  entryScopeFromLocation,
  readEntryQueue,
  resolveTaskLanding,
  resolveSubmittedTaskScope,
  shouldDisposeEntryPage,
  taskLandingHref,
  taskScopeFromSystemRead,
} from '../../docs/ui/entry.js'
import { encodeProductLocation } from '../../docs/ui/product-location.js'

const taskId = { scope: 'task', value: 'task-1' }
const taskScope = {
  kind: 'task',
  projectKey: 'project-a',
  mode: 'rcc',
  taskId,
}

function deferred() {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, settle }
}

test('one in-flight submission accepts one create and later allows a deliberate new one', async () => {
  const gate = createSubmissionGate()
  const hold = deferred()
  let creates = 0

  const first = gate.begin(async () => {
    creates += 1
    await hold.promise
    return 'first'
  })
  const second = gate.begin(async () => {
    creates += 1
    return 'second'
  })

  assert.equal(first.started, true)
  assert.equal(second.started, false)
  assert.equal(creates, 1)

  hold.settle()
  assert.equal(await first.result, 'first')
  assert.equal(await second.result, 'first')
  assert.equal(creates, 1)

  const third = gate.begin(async () => {
    creates += 1
    return 'third'
  })
  assert.equal(third.started, true)
  assert.equal(await third.result, 'third')
  assert.equal(creates, 2)
})

test('draft/back state keeps the user input and BFCache is not disposed', () => {
  const prior = { productLocation: { board: 'interaction' } }
  const state = entryDraftState(prior, {
    rawInput: '保留这次输入',
    execution: { executionMode: 'scheduled', timezone: 'America/Los_Angeles' },
  })

  assert.deepEqual(entryDraftFromState(state), {
    rawInput: '保留这次输入',
    execution: { executionMode: 'scheduled', timezone: 'America/Los_Angeles' },
  })
  assert.deepEqual(state.productLocation, prior.productLocation)
  assert.equal(entryDraftFromState(null), null)
  assert.equal(entryDraftFromState({}), null)
  assert.equal(shouldDisposeEntryPage({ persisted: true }), false)
  assert.equal(shouldDisposeEntryPage({}), true)
})

test('entry scope comes only from the explicit URL or product location', () => {
  assert.deepEqual(
    entryScopeFromLocation({ search: '?projectKey=project-a&mode=rcc' }),
    { projectKey: 'project-a', mode: 'rcc' },
  )
  assert.deepEqual(
    entryScopeFromLocation({ search: '?projectKey=project-a' }),
    { projectKey: 'project-a' },
  )
  assert.deepEqual(
    entryScopeFromLocation({ search: '?projectKey=&mode=unknown' }),
    {},
  )
  const hash = encodeProductLocation({
    board: 'execution',
    lane: 'live',
    focus: { kind: 'interaction', taskRef: taskId, scope: taskScope },
    scope: taskScope,
  })
  assert.deepEqual(
    entryScopeFromLocation({ hash }),
    { projectKey: 'project-a', mode: 'rcc' },
  )
})

test('a confirmed task lands on the interaction task page with exact scope', () => {
  const href = taskLandingHref(taskId, taskScope, 'interaction-1')
  const url = new URL(href, 'https://product.invalid/')

  assert.equal(url.pathname, '/task.html')
  assert.equal(url.searchParams.get('task'), 'task-1')
  assert.equal(url.searchParams.get('projectKey'), 'project-a')
  assert.equal(url.searchParams.get('mode'), 'rcc')
  assert.equal(url.searchParams.get('interaction'), 'interaction-1')
})

test('the exact task scope comes from the committed project read, never from a guess', () => {
  const read = {
    projects: [
      {
        tasks: [
          { scope: taskScope, task: { taskId } },
          { scope: { ...taskScope, taskId: { scope: 'task', value: 'task-2' } }, task: { taskId: { scope: 'task', value: 'task-2' } } },
        ],
      },
    ],
  }

  assert.deepEqual(taskScopeFromSystemRead(read, 'task-1'), taskScope)
  assert.equal(taskScopeFromSystemRead(read, 'missing-task'), null)
  assert.equal(taskScopeFromSystemRead({ projects: [] }, 'task-1'), null)
  assert.deepEqual(
    resolveSubmittedTaskScope({ taskId, hint: { projectKey: 'project-a', mode: 'rcc' } }),
    taskScope,
  )
  assert.equal(resolveSubmittedTaskScope({ taskId, hint: {} }), null)
})

test('a child execution uses only its parent row committed project scope', () => {
  const childId = { scope: 'task', value: 'task-child' }
  const read = {
    projects: [
      {
        tasks: [
          {
            scope: taskScope,
            task: {
              taskId,
              executions: [
                { taskId: { scope: 'task', value: 'task-other' } },
                { taskId: childId },
              ],
            },
          },
          {
            scope: { ...taskScope, kind: 'project', projectKey: 'project-other' },
            task: { taskId: childId, executions: [] },
          },
        ],
      },
    ],
  }

  assert.deepEqual(taskScopeFromSystemRead(read, 'task-child'), {
    ...taskScope,
    taskId: childId,
  })
  assert.equal(taskScopeFromSystemRead(read, 'task-unlisted-child'), null)
})

test('refresh and landing only read and never recreate an existing task', async () => {
  const calls = []
  const api = {
    status: async () => {
      calls.push('status')
      return { mode: 'rcc' }
    },
    listTasks: async () => {
      calls.push('listTasks')
      return { waiting: [], running: [] }
    },
    systemDashboard: async () => {
      calls.push('systemDashboard')
      return { projects: [{ tasks: [{ scope: taskScope, task: { taskId } }] }] }
    },
    receiveExplicitInput: async () => {
      calls.push('receiveExplicitInput')
      throw new Error('a refresh must not submit a new requirement')
    },
    confirmExplicitRequirement: async () => {
      calls.push('confirmExplicitRequirement')
      throw new Error('a refresh must not confirm a requirement')
    },
    createTask: async () => {
      calls.push('createTask')
      throw new Error('a refresh must not create a task')
    },
  }

  const queue = await readEntryQueue(api)
  assert.equal(queue.runtimeStatus.mode, 'rcc')
  assert.deepEqual(calls, ['status', 'listTasks'])

  const landing = await resolveTaskLanding({
    api,
    taskId,
    search: '',
    hash: '',
    statusMode: queue.runtimeStatus.mode,
    interactionId: 'interaction-1',
  })
  assert.deepEqual(calls, ['status', 'listTasks', 'systemDashboard'])
  assert.deepEqual(landing.scope, taskScope)
  assert.equal(new URL(landing.href, 'https://product.invalid/').pathname, '/task.html')
})

test('an unresolved landing scope stays an explicit failure instead of an unscoped write', async () => {
  const calls = []
  const api = {
    systemDashboard: async () => {
      calls.push('systemDashboard')
      return { projects: [] }
    },
  }

  await assert.rejects(
    resolveTaskLanding({
      api,
      taskId,
      search: '',
      hash: '',
      statusMode: 'rcc',
      interactionId: 'interaction-1',
    }),
    (error) => {
      assert.equal(error.code, 'entry.task-scope-unresolved')
      assert.equal(error.ownerId, 'humanagent.app.ui')
      return true
    },
  )
  assert.deepEqual(calls, ['systemDashboard'])
})

/*
 * The product entry must present a simple answer as the interaction's business
 * result. Failure mode: state `answered` reached the submission fallback and
 * threw `explicit-brain.state-invalid`, so the page showed "本次处理未完成" and a
 * retry action instead of the answer. The decision is a pure seam because the
 * browser-only submission closure needs a DOM; the real browser acceptance in
 * tests/ui/entry-answered-browser.mjs checks the rendered text, tone, and
 * actions on the served page.
 */
test('an answered explicit snapshot presents its reply as a visible success result', () => {
  const presentation = answeredSubmissionPresentation({
    state: 'answered',
    reply: '13 加 14 等于 27。',
    nextAction: 'present-answer',
  })
  assert.deepEqual(presentation, {
    tone: 'success',
    text: '13 加 14 等于 27。',
    retry: false,
  })
})

/*
 * A status receipt keeps its own reply wording, and an answered snapshot with no
 * reply text must stay an explicit contract failure instead of a fabricated
 * answer. Both cases decide the same status region, so they share one seam.
 */
test('answered and status receipts never fabricate the answer text', () => {
  assert.deepEqual(
    answeredSubmissionPresentation({ state: 'status-only', reply: '当前没有待执行任务。', nextAction: 'present-status' }),
    { tone: 'success', text: '当前没有待执行任务。', retry: false },
  )
  assert.deepEqual(
    answeredSubmissionPresentation({ state: 'status-only', nextAction: 'inspect-runtime' }),
    { tone: 'success', text: 'inspect-runtime', retry: false },
  )
  assert.throws(
    () => answeredSubmissionPresentation({ state: 'answered', nextAction: 'present-answer' }),
    (error) => {
      assert.equal(error.code, 'explicit-brain.reply-missing')
      assert.equal(error.ownerId, 'humanagent.app.ui')
      return true
    },
  )
  assert.equal(answeredSubmissionPresentation({ state: 'awaiting-confirmation' }), null)
})
