import test from 'node:test'
import assert from 'node:assert/strict'

import {
  renderProductMessages,
  renderProductSessionView,
} from '../../docs/ui/product-session-view.js'

// Minimal DOM adapter. It records the real node structure so each assertion
// checks rendered elements, not renderer source text.
function createElement(tag, text, className) {
  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: text === undefined ? '' : String(text),
    className: className || '',
    children: [],
    attributes: {},
    append(...items) {
      for (const item of items) {
        if (item !== undefined && item !== null) node.children.push(item)
      }
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name)
        ? node.attributes[name]
        : null
    },
    replaceChildren(...items) {
      node.children = items.filter((item) => item !== undefined && item !== null)
    },
  }
  return node
}

function walk(node) {
  return [node, ...node.children.flatMap((child) => walk(child))]
}

function text(node) {
  return [node.textContent, ...node.children.map((child) => text(child))]
    .filter(Boolean)
    .join(' ')
}

function role(root, name) {
  return walk(root).filter((node) => node.getAttribute('data-product-role') === name)
}

function attributeText(root) {
  return walk(root)
    .map((node) => Object.values(node.attributes).join(' '))
    .join(' ')
}

const taskId = { scope: 'task', value: 'task-1' }
const scope = {
  organId: { scope: 'organ', value: 'organ-1' },
  taskId,
}
const eventRef = (eventId) => ({
  eventId,
  sourceId: 'runtime-event',
  scope,
})
const evidence = {
  evidenceId: { scope: 'evidence', value: 'ev-1' },
  kind: 'execution',
  source: 'runtime',
  locator: 'journal:1',
  scope,
}

function message(overrides = {}) {
  return {
    ref: eventRef('event-1'),
    targetRef: {
      kind: 'session',
      sessionRef: { sourceKind: 'runtime-session', sourceRef: 'session-1' },
      taskRef: taskId,
      scope: { kind: 'task', projectKey: 'demo-project', mode: 'fake', taskId },
    },
    actor: {
      kind: 'agent',
      sourceKind: 'agent-provider',
      sourceRef: 'session-a',
    },
    occurredAt: '2026-10-20T01:02:00.000Z',
    text: 'BODY',
    evidenceRefs: [evidence],
    ...overrides,
  }
}

function render(input) {
  const host = createElement('div')
  renderProductSessionView(host, input, { element: createElement })
  return host
}

test('T1 keeps agent and authenticated human actors distinct and keeps their sources', () => {
  const agent = message({
    ref: eventRef('event-agent'),
    actor: {
      kind: 'agent',
      sourceKind: 'agent-provider',
      sourceRef: 'session-a',
    },
    text: 'AGENT-BODY-SENTINEL',
  })
  const human = message({
    ref: eventRef('event-human'),
    actor: {
      kind: 'human',
      sourceKind: 'authenticated-principal',
      sourceRef: 'principal-42',
    },
    text: 'HUMAN-BODY-SENTINEL',
  })

  const host = render({ messages: [agent, human] })
  const messages = role(host, 'message')
  assert.equal(messages.length, 2)

  const agentNode = messages[0]
  assert.equal(agentNode.getAttribute('data-actor-kind'), 'agent')
  assert.match(text(role(agentNode, 'message-actor')[0]), /代理/)
  assert.doesNotMatch(text(agentNode), /人类|human/i)
  assert.match(text(agentNode), /agent-provider/)
  assert.match(text(agentNode), /session-a/)
  assert.match(text(agentNode), /AGENT-BODY-SENTINEL/)

  const humanNode = messages[1]
  assert.equal(humanNode.getAttribute('data-actor-kind'), 'human')
  assert.match(text(role(humanNode, 'message-actor')[0]), /人类/)
  assert.match(text(humanNode), /authenticated-principal/)
  assert.match(text(humanNode), /principal-42/)
  assert.match(text(humanNode), /HUMAN-BODY-SENTINEL/)

  assert.match(text(role(agentNode, 'message-diagnostics')[0]), /event-agent/)
  assert.match(text(role(agentNode, 'message-diagnostics')[0]), /ev-1/)
})

test('T1 keeps an unknown actor unknown and never labels it human', () => {
  const host = render({
    messages: [
      message({
        actor: {
          kind: 'unknown',
          sourceKind: 'runtime-event',
          sourceRef: 'evt-9',
        },
        text: 'UNKNOWN-BODY',
      }),
    ],
  })

  const node = role(host, 'message')[0]
  assert.equal(node.getAttribute('data-actor-kind'), 'unknown')
  assert.match(text(role(node, 'message-actor')[0]), /来源未知/)
  assert.doesNotMatch(text(node), /人类|human/i)
  assert.match(text(node), /runtime-event/)
  assert.match(text(node), /evt-9/)
})

test('T1 refuses a human claim without a decoded principal source', () => {
  const host = render({
    messages: [
      message({
        actor: { kind: 'human', sourceKind: 'task.input' },
        text: 'TASK-INPUT-CLAIM',
      }),
      message({
        actor: { kind: 'human', sourceKind: 'authenticated-principal' },
        text: 'NO-PRINCIPAL-CLAIM',
      }),
    ],
  })

  for (const node of role(host, 'message')) {
    assert.equal(node.getAttribute('data-actor-kind'), 'unknown')
    assert.match(text(role(node, 'message-actor')[0]), /来源未知/)
  }
})

test('T1 renders a present event time and never invents a missing one', () => {
  const occurredAt = '2026-10-20T01:02:00.000Z'
  const presentHost = render({ messages: [message({ occurredAt })] })
  const presentTime = role(role(presentHost, 'message')[0], 'message-time')[0]
  assert.ok(presentTime, 'a present event time is rendered as a time element')
  assert.equal(presentTime.getAttribute('datetime'), occurredAt)
  assert.ok(text(presentTime).length > 0)

  const updatedAtSentinel = '2031-12-31T23:59:59.000Z'
  const missingHost = render({
    messages: [
      message({
        occurredAt: undefined,
        occurredAtUnavailableReason: 'provider 未报告事件时间',
        text: 'NO-TIME-BODY',
      }),
    ],
    updatedAt: updatedAtSentinel,
  })
  const missingNode = role(missingHost, 'message')[0]
  assert.equal(role(missingNode, 'message-time').length, 0)
  const unavailable = role(missingNode, 'message-time-unavailable')[0]
  assert.ok(unavailable, 'a missing event time keeps an explicit unavailable state')
  assert.match(text(unavailable), /provider 未报告事件时间/)
  assert.equal(text(missingHost).includes(updatedAtSentinel), false)
  assert.equal(attributeText(missingHost).includes(updatedAtSentinel), false)
})

test('T8 draws no result block for missing output or empty commits', () => {
  const emptyPublications = [
    undefined,
    { state: 'committed', commits: [] },
    { state: 'pending', commits: [] },
    { state: 'unavailable', commits: [] },
    { state: 'unknown', commits: [] },
  ]

  for (const publicOutput of emptyPublications) {
    const host = render({ messages: [], publicOutput })
    assert.equal(
      role(host, 'public-result').length,
      0,
      `no result block for ${publicOutput?.state ?? 'missing'} output`,
    )
    assert.doesNotMatch(text(host), /已提交结果|提交结果/)
  }
})

test('T8 keeps confirmed commit text, order and refs while pending text stays private', () => {
  const host = render({
    messages: [],
    publicOutput: {
      state: 'pending',
      commits: [
        {
          commitId: 'commit-1',
          journalSeq: 3,
          recordDigest: 'digest-1',
          text: 'FIRST-COMMIT-BODY',
        },
        {
          commitId: 'commit-2',
          journalSeq: 5,
          recordDigest: 'digest-2',
          text: 'SECOND-COMMIT-BODY',
        },
      ],
      publicCommitWatermark: 5,
      pendingText: 'UNCOMMITTED-PRIVATE-SENTINEL',
    },
  })

  const result = role(host, 'public-result')[0]
  assert.ok(result)
  assert.equal(result.getAttribute('data-publication-state'), 'pending')

  const commits = role(host, 'public-commit')
  assert.equal(commits.length, 2)
  assert.equal(commits[0].getAttribute('data-commit-id'), 'commit-1')
  assert.equal(commits[1].getAttribute('data-commit-id'), 'commit-2')
  assert.match(text(role(commits[0], 'public-commit-text')[0]), /FIRST-COMMIT-BODY/)
  assert.match(text(role(commits[1], 'public-commit-text')[0]), /SECOND-COMMIT-BODY/)

  const firstRefs = text(role(commits[0], 'public-commit-refs')[0])
  assert.match(firstRefs, /commit-1/)
  assert.match(firstRefs, /journalSeq 3/)
  assert.match(firstRefs, /digest-1/)
  assert.equal(text(host).includes('UNCOMMITTED-PRIVATE-SENTINEL'), false)
})

test('renderProductMessages replaces the host with the message list only', () => {
  const host = createElement('div')
  host.append(createElement('p', 'STALE-HOST-CONTENT'))

  const root = renderProductMessages(
    host,
    [message({ text: 'DIRECT-MESSAGE-BODY' })],
    { element: createElement },
  )

  assert.ok(root)
  assert.equal(host.children.length, 1)
  assert.equal(text(host).includes('STALE-HOST-CONTENT'), false)
  assert.match(text(host), /DIRECT-MESSAGE-BODY/)
})
