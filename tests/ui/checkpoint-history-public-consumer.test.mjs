import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHECKPOINT_QUERY_KEYS,
  checkpointSelectionFromQuery,
  checkpointQuery,
  renderCheckpointHistory,
  renderCheckpointHistoryDetail,
} from '../../docs/ui/checkpoint-history.js'

// Minimal element adapter. No DOM framework, no dependency install. It records
// real node structure, attributes and listeners so the consumer asserts rendered
// elements, not source strings.
function createElement(tag, text, className) {
  const listeners = new Map()
  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: text === undefined ? '' : String(text),
    className: className || '',
    children: [],
    attributes: {},
    dataset: {},
    type: undefined,
    append(...items) {
      for (const item of items) {
        if (item === undefined || item === null) continue
        node.children.push(item)
      }
    },
    setAttribute(name, value) { node.attributes[name] = String(value) },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, target: node })
    },
  }
  return node
}

function walk(node) {
  return [node, ...node.children.flatMap((child) => walk(child))]
}

function text(node) {
  return [node.textContent, ...node.children.map((child) => text(child))].filter(Boolean).join(' ')
}

function role(root, name) {
  return walk(root).filter((node) => node.getAttribute('data-checkpoint-role') === name)
}

function buttons(root) {
  return walk(root).filter((node) => node.tagName === 'BUTTON')
}

function click(button) { button.dispatch('click') }

const taskId = { scope: 'task', value: 'task-1' }
const evidence = {
  evidenceId: { scope: 'evidence', value: 'ev-1' },
  kind: 'execution',
  source: 'runtime',
  locator: 'journal:44',
  digest: 'sha256:ev-1',
  scope: { organId: { scope: 'organ', value: 'organ-1' } },
}

function identity({ value, seq, summary, outcome, epoch, journalSeq, previousCheckpointId = null, committedAt, committedAtUnavailableReason, next = { kind: 'continue' } }) {
  return {
    checkpointId: { scope: 'checkpoint', value },
    seq,
    previousCheckpointId,
    cycleId: { scope: 'cycle', value: 'cycle-1' },
    directiveRevision: 2,
    originalExecutionEpoch: epoch,
    outcome,
    summary,
    next,
    recoveryStateRef: evidence,
    evidenceRefs: [evidence],
    commitRef: { commitId: `commit-${journalSeq}`, journalSeq, recordDigest: `digest-${journalSeq}` },
    ...(committedAt === undefined ? {} : { committedAt }),
    ...(committedAtUnavailableReason === undefined ? {} : { committedAtUnavailableReason }),
  }
}

// Coherent historical fixture: current A (committed epoch 4, effective epoch 5)
// and viewed B (committed epoch 6). A newer checkpoint B is retained in history
// but is NOT the current position.
const A = identity({
  value: 'ck-a', seq: 3, summary: 'A 已完成阶段一', outcome: 'succeeded', epoch: 4,
  journalSeq: 31, committedAt: '2026-10-15T03:00:00.000Z',
})
const B = identity({
  value: 'ck-b', seq: 5, summary: 'B 等待审查', outcome: 'waiting', epoch: 6,
  journalSeq: 57, committedAtUnavailableReason: '旧记录没有 Harness 时间权威。',
})

const currentContext = {
  state: 'known',
  agentRuntimeId: 'runtime-1',
  contextViewRef: 'ctx-current',
  contextDigest: 'digest-current',
  executionEpoch: 5,
  activeRefs: ['ref-a', 'ref-b'],
  omittedRefs: ['ref-old'],
  durableContextDigest: 'digest-durable',
  previousContextCommitRef: { commitId: 'commit-20', journalSeq: 20, recordDigest: 'digest-20' },
  loopCheckpoint: {
    checkpointId: { scope: 'checkpoint', value: 'ck-a' },
    sequence: 3,
    digest: 'digest-loop',
    executionEpoch: 4,
    contextViewRef: 'ctx-current',
  },
  loopControl: { mode: 'orchestration', transitionSeq: 9, observationScopeId: 'obs-1' },
  replacement: {
    reason: 'recovery',
    fromContextViewRef: 'ctx-old',
    toContextViewRef: 'ctx-current',
    toContextDigest: 'digest-current',
  },
}

const semanticKnown = {
  state: 'known',
  version: 1,
  turn: { turnId: 'turn-2' },
  savedAt: '2026-10-15T03:05:00.000Z',
  description: '阶段二等待审查',
  semantics: {
    goal: '交付 C5 模块',
    actions: '实现渲染与查询',
    result: '已实现，等待审查',
    nextStep: '进入组合验收',
  },
  save: {
    checkpoint: {
      commitIdentity: 'ci-b',
      checkpointRef: 'ck-b',
      journalReceiptRef: 'jr-b',
      journalSeq: 57,
      recordDigest: 'digest-57',
      committedAt: '2026-10-15T03:05:00.000Z',
      timeAuthority: { source: 'harness', owner: 'runtime-checkpoint-control-owner', authorityRef: 'auth-1' },
    },
    contextView: {
      phase: 'context-view',
      commitIdentity: 'ci-cv',
      journalReceiptRef: 'jr-cv',
      journalSeq: 58,
      recordDigest: 'digest-58',
      committedAt: '2026-10-15T03:05:00.000Z',
      timeAuthority: { source: 'harness', owner: 'runtime-checkpoint-control-owner', authorityRef: 'auth-1' },
    },
    historyPublication: {
      phase: 'history-publication',
      commitIdentity: 'ci-hp',
      journalReceiptRef: 'jr-hp',
      journalSeq: 59,
      recordDigest: 'digest-59',
      committedAt: '2026-10-15T03:05:00.000Z',
      timeAuthority: { source: 'harness', owner: 'runtime-checkpoint-control-owner', authorityRef: 'auth-1' },
    },
  },
  evidenceRefs: [evidence],
  adoptedChildren: [],
  recovery: {
    recoveryStateRef: 'recovery-state-1',
    recoveryResponsibilityRef: 'responsibility-1',
    unresolvedOperationRefs: [],
    laterErrorRefs: [],
  },
}

const viewed = {
  identity: B,
  recoveryBinding: {
    checkpointCommitRef: B.commitRef,
    contextCommitRef: { commitId: 'commit-40', journalSeq: 40, recordDigest: 'digest-40' },
    coreClosure: {
      source: 'harness-control',
      closureReason: '等待审查',
      executionEpoch: 6,
      committed: true,
      reentryAllowed: false,
      pendingOperations: ['op-review'],
      unknownOperations: [],
      recoveryStateRef: evidence,
      nextAction: { kind: 'wait' },
      closedAt: '2026-10-15T03:05:00.000Z',
    },
    turnRecoveryRef: 'turn-recovery-1',
  },
  context: { state: 'unavailable', reason: '历史 Context 未保留。' },
  semantic: semanticKnown,
  capture: { state: 'unavailable', reason: '没有可验证的 capture 版本关联。' },
}

const read = {
  ok: true,
  value: {
    surface: 'runtime-checkpoint-history',
    scope: { kind: 'task', projectKey: 'project-1', mode: 'read', taskId },
    current: {
      state: 'known',
      identity: A,
      position: {
        checkpointCommitRef: A.commitRef,
        contextCommitRef: { commitId: 'commit-30', journalSeq: 30, recordDigest: 'digest-30' },
        controlCommitRef: { commitId: 'commit-32', journalSeq: 32, recordDigest: 'digest-32' },
        effectiveExecutionEpoch: 5,
      },
      context: currentContext,
    },
    viewed,
    checkpoints: [A, B],
    capabilities: {},
  },
}

test('main layer keeps current authority and viewed target separate and wires only supplied callbacks', () => {
  const calls = { select: [], returnCurrent: 0 }
  const options = {
    element: createElement,
    onSelect: (selection) => calls.select.push(selection),
    onReturnToCurrent: () => { calls.returnCurrent += 1 },
    onOpenReference: () => {},
  }
  const main = renderCheckpointHistory(read, options)
  const root = main.element

  const current = role(root, 'current')[0]
  const viewedNode = role(root, 'viewed')[0]
  assert.ok(current, 'current section is rendered')
  assert.ok(viewedNode, 'viewed section is rendered')

  assert.match(text(current), /检查点 3/)
  assert.match(text(current), /A 已完成阶段一/)
  assert.match(text(current), /已完成/)
  assert.match(text(current), /当前生效执行轮 5/)
  assert.match(text(current), /该检查点提交轮 4/)
  assert.doesNotMatch(text(current), /B 等待审查/)

  assert.match(text(viewedNode), /检查点 5/)
  assert.match(text(viewedNode), /B 等待审查/)
  assert.match(text(viewedNode), /等待中/)
  assert.match(text(viewedNode), /这不是当前执行位置/)
  assert.doesNotMatch(text(viewedNode), /A 已完成阶段一/)

  // Technical receipts stay in the detail layer, not the main layer.
  assert.doesNotMatch(text(root), /commit-31/)
  assert.doesNotMatch(text(root), /digest-31/)

  const entries = role(root, 'history-entry')
  assert.equal(entries.length, 2, 'retained history keeps both checkpoints')
  assert.equal(entries[0].getAttribute('data-checkpoint-journal-seq'), '31')
  assert.equal(entries[1].getAttribute('data-checkpoint-journal-seq'), '57')

  const selectButtons = buttons(entries[1])
  assert.equal(selectButtons.length, 1)
  click(selectButtons[0])
  assert.equal(calls.select.length, 1)
  assert.equal(calls.select[0].checkpointId, 'ck-b')
  assert.deepEqual(calls.select[0].commitRef, { commitId: 'commit-57', journalSeq: 57, recordDigest: 'digest-57' })

  const returnButtons = buttons(viewedNode)
  assert.equal(returnButtons.length, 1)
  click(returnButtons[0])
  assert.equal(calls.returnCurrent, 1)

  // No constructed URL for raw paths, descriptors or unsupported refs.
  assert.ok(walk(root).every((node) => node.getAttribute('href') === null && node.getAttribute('src') === null))
  assert.ok(walk(root).every((node) => node.tagName !== 'A'))

  main.dispose()
  click(selectButtons[0])
  click(returnButtons[0])
  assert.equal(calls.select.length, 1, 'dispose removes own select listener')
  assert.equal(calls.returnCurrent, 1, 'dispose removes own return listener')
})

test('detail layer renders four-part semantics, epoch facts, exact refs and explicit unavailable', () => {
  const references = []
  const detail = renderCheckpointHistoryDetail(read, {
    element: createElement,
    onOpenReference: (reference) => references.push(reference),
  })
  const root = detail.element

  assert.match(text(role(root, 'semantic-goal')[0]), /交付 C5 模块/)
  assert.match(text(role(root, 'semantic-actions')[0]), /实现渲染与查询/)
  assert.match(text(role(root, 'semantic-result')[0]), /已实现，等待审查/)
  assert.match(text(role(root, 'semantic-next-step')[0]), /进入组合验收/)

  assert.match(text(role(root, 'capture-unavailable')[0]), /没有可验证的 capture 版本关联/)
  assert.match(text(role(root, 'context-unavailable')[0]), /历史 Context 未保留/)
  assert.doesNotMatch(text(root), /捕获版本 [12]/)

  // Current effective epoch 5 is separate from A's committed epoch 4 and B's 6.
  assert.match(text(root), /当前生效执行轮 5/)
  assert.match(text(root), /该检查点提交轮 4/)
  assert.match(text(root), /该检查点提交轮 6/)
  assert.match(text(root), /旧记录没有 Harness 时间权威/, 'missing trusted time is explicit')

  // reentryAllowed is a recorded fact, never an action or implied permission.
  assert.match(text(root), /控制记录：允许重新进入/)
  assert.match(text(root), /否（仅记录事实）/)
  assert.equal(buttons(root).some((button) => /恢复|重新进入|steer|retry/.test(text(button))), false)

  const referenceButtons = buttons(root).filter((button) => text(button).includes('打开'))
  assert.ok(referenceButtons.length >= 1)
  click(referenceButtons[0])
  assert.equal(references.length, 1)
  assert.ok(['evidence', 'commit', 'asset'].includes(references[0].kind))
  assert.ok(walk(root).every((node) => node.getAttribute('href') === null))
  assert.ok(walk(root).every((node) => node.tagName !== 'A'))

  detail.dispose()
  click(referenceButtons[0])
  assert.equal(references.length, 1)
})

test('query helpers round-trip the view target only and keep parent params and duplicates', () => {
  // Omitted target keys follow the authoritative current; never the first entry.
  const omitted = checkpointSelectionFromQuery(new URLSearchParams('planRevision=7&display=list'))
  assert.equal(omitted.ok, true)
  assert.equal(omitted.value.viewed, undefined)

  const idOnly = checkpointSelectionFromQuery(new URLSearchParams('checkpointId=ck-b'))
  assert.deepEqual(idOnly.value, { viewed: { checkpointId: 'ck-b' } })

  const receiptOnly = checkpointSelectionFromQuery(new URLSearchParams({
    checkpointCommitId: B.commitRef.commitId,
    checkpointJournalSeq: String(B.commitRef.journalSeq),
    checkpointRecordDigest: B.commitRef.recordDigest,
  }))
  assert.deepEqual(receiptOnly.value, { viewed: { commitRef: { ...B.commitRef } } })

  const both = checkpointSelectionFromQuery(new URLSearchParams({
    checkpointId: 'ck-b',
    checkpointCommitId: B.commitRef.commitId,
    checkpointJournalSeq: String(B.commitRef.journalSeq),
    checkpointRecordDigest: B.commitRef.recordDigest,
  }))
  assert.deepEqual(both.value, { viewed: { checkpointId: 'ck-b', commitRef: { ...B.commitRef } } })

  for (const bad of [
    'checkpointCommitId=commit-57&checkpointJournalSeq=57',
    'checkpointCommitId=commit-57&checkpointJournalSeq=nan&checkpointRecordDigest=digest-57',
    'checkpointId=ck-a&checkpointId=ck-b',
    'checkpointId=%20',
  ]) {
    const failure = checkpointSelectionFromQuery(new URLSearchParams(bad))
    assert.equal(failure.ok, false, bad)
    assert.equal(failure.failure.code, 'checkpoint-history.invalid-selection')
    assert.equal(failure.failure.ownerId, 'humanagent.ui.checkpoint-history')
    assert.ok(failure.failure.message.length > 0)
    assert.ok(failure.failure.nextAction.length > 0)
  }

  const parent = new URLSearchParams(
    'planRevision=7&planPublication=pub-9&cycle=cycle-1&occurrence=occ-1&task=task-1&project=project-1'
    + '&agent=agent-1&display=list&scope=all&kind=a&kind=b'
    + '&checkpointId=ck-old&checkpointCommitId=commit-old&checkpointJournalSeq=9&checkpointRecordDigest=digest-old',
  )
  const moduleKeys = Object.values(CHECKPOINT_QUERY_KEYS)
  const preserved = (params) => [...params].filter(([key]) => !moduleKeys.includes(key))

  const encoded = checkpointQuery(parent, { viewed: { checkpointId: 'ck-b', commitRef: B.commitRef } })
  assert.equal(encoded.ok, true)
  assert.deepEqual(preserved(encoded.value), preserved(parent))
  assert.deepEqual(encoded.value.getAll('kind'), ['a', 'b'])
  assert.equal(encoded.value.getAll(CHECKPOINT_QUERY_KEYS.checkpointId).length, 1)
  assert.equal(encoded.value.get(CHECKPOINT_QUERY_KEYS.checkpointId), 'ck-b')
  assert.equal(encoded.value.get(CHECKPOINT_QUERY_KEYS.journalSeq), '57')
  assert.deepEqual(
    checkpointSelectionFromQuery(encoded.value).value,
    { viewed: { checkpointId: 'ck-b', commitRef: { ...B.commitRef } } },
  )

  const cleared = checkpointQuery(encoded.value, {})
  assert.deepEqual(preserved(cleared.value), preserved(parent))
  assert.equal(cleared.value.has(CHECKPOINT_QUERY_KEYS.checkpointId), false)
  assert.equal(cleared.value.has(CHECKPOINT_QUERY_KEYS.commitId), false)
  assert.equal(cleared.value.has(CHECKPOINT_QUERY_KEYS.journalSeq), false)
  assert.equal(cleared.value.has(CHECKPOINT_QUERY_KEYS.recordDigest), false)

  const invalid = checkpointQuery(parent, { viewed: { commitRef: { commitId: 'commit-57' } } })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.failure.code, 'checkpoint-history.invalid-selection')
})

test('unknown current stays unknown and optional sources show their real reasons', () => {
  const unknownRead = {
    ok: true,
    value: {
      ...read.value,
      current: { state: 'unknown', reason: '权威控制事实缺失。' },
      viewed: null,
      capabilities: {
        directiveRevision: { state: 'available' },
        executionEpoch: { state: 'available' },
        cycleId: { state: 'available' },
        occurrenceRef: {
          state: 'unavailable',
          reason: 'no occurrence binding producer exists yet',
        },
      },
    },
  }

  const selections = []
  const main = renderCheckpointHistory(unknownRead, {
    element: createElement,
    onSelect: (selection) => selections.push(selection),
    onReturnToCurrent: () => {},
  })
  const root = main.element

  const unknown = role(root, 'current-unknown')[0]
  assert.ok(unknown)
  assert.doesNotMatch(text(root), /occurrenceRef/)
  assert.doesNotMatch(text(root), /no occurrence binding producer exists yet/)
  assert.match(text(unknown), /当前执行位置未知/)
  assert.match(text(unknown), /历史检查点仍可查看/)
  assert.doesNotMatch(text(unknown), /权威控制事实缺失/)
  assert.doesNotMatch(text(unknown), /检查点 5/)
  assert.equal(role(root, 'history-entry').length, 2)
  assert.equal(role(root, 'history-empty').length, 0)
  assert.equal(selections.length, 0, 'no history entry is auto-selected as current')
  assert.equal(buttons(role(root, 'viewed')[0]).length, 0, 'no return-to-current without a viewed target')
  main.dispose()

  const detail = renderCheckpointHistoryDetail(unknownRead, { element: createElement })
  assert.match(text(role(detail.element, 'current-unknown')[0]), /权威控制事实缺失/)
  assert.match(text(detail.element), /Occurrence 关联/)
  assert.match(text(detail.element), /no occurrence binding producer exists yet/)
  detail.dispose()

  // An empty semantic field is explicit, never a fabricated empty history.
  const emptySemanticRead = {
    ok: true,
    value: {
      ...read.value,
      viewed: {
        ...read.value.viewed,
        semantic: {
          state: 'known',
          version: 1,
          semantics: { goal: '', actions: '', result: '', nextStep: '' },
          evidenceRefs: [],
          adoptedChildren: [],
          recovery: { recoveryResponsibilityRef: 'responsibility-1', unresolvedOperationRefs: [] },
        },
      },
    },
  }
  const empty = renderCheckpointHistoryDetail(emptySemanticRead, { element: createElement })
  assert.match(text(role(empty.element, 'semantic-goal')[0]), /未提供/)
  assert.match(text(role(empty.element, 'semantic-next-step')[0]), /未提供/)
  empty.dispose()
})
