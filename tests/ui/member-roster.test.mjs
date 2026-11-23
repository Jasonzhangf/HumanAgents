import test from 'node:test'
import assert from 'node:assert/strict'
import { createProjectRosterReader, memberRole, memberSessionLabel, mountMemberRoster, memberRosterDetail } from '../../docs/ui/member-roster.js'
import { createRuntimeApi } from '../../docs/ui/runtime-api.js'
import { entryWorkspaceHint } from '../../docs/ui/entry-workspace.js'

// Wrong keys mix same-name members; repeated entry polls must not reread config.
test('formal API encodes the exact project key and exposes real HTTP failures', async () => {
  let path
  const api = createRuntimeApi({ fetchImpl: async (url) => {
    path = url
    return new Response(JSON.stringify({ code: 'project.unknown', message: 'unknown project' }), { status: 404 })
  } })
  await assert.rejects(api.projectRoster('甲 / beta'), (error) => error.status === 404)
  assert.equal(new URL(path, 'http://localhost').searchParams.get('projectKey'), '甲 / beta')
})
test('same-name projects remain isolated; late reads cannot publish into another project', async () => {
  const pending = new Map()
  let calls = 0
  const reader = createProjectRosterReader({ projectRoster: (key) => {
    calls++
    return new Promise((resolve) => pending.set(key, resolve))
  } })
  const a = reader.read('a')
  assert.equal(reader.read('a'), a)
  const b = reader.read('b')
  await Promise.resolve()
  pending.get('b')({ projectKey: 'b', members: [{ memberName: 'Sam', roleId: 'review' }] })
  assert.equal((await b).members[0].roleId, 'review')
  pending.get('a')({ projectKey: 'a', members: [{ memberName: 'Sam', roleId: 'execution' }] })
  assert.equal((await a).members[0].roleId, 'execution')
  assert.equal((await reader.read('b')).projectKey, 'b')
  assert.equal(calls, 2)
})
test('mismatched scope and unavailable roster stay explicit; roles and session states are human readable', async () => {
  const reader = createProjectRosterReader({ projectRoster: async () => ({ projectKey: 'wrong', members: [] }) })
  await assert.rejects(reader.read('wanted'), /项目范围不匹配/)
  assert.equal(memberRole('review').label, '审查')
  assert.equal(memberRole('unrecognized').label, 'unrecognized')
  assert.equal(memberSessionLabel('ready'), '就绪')
  assert.equal(memberSessionLabel('unknown-state'), '状态未识别（unknown-state）')
})

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.textContent = ''; this.listeners = {} }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  addEventListener(name, action) { this.listeners[name] = action }
  setAttribute(name, value) { this[name] = value }
}
const text = (node) => [node.textContent, ...node.children.map(text)].join(' ')
test('workspace hints use declared path and never reverse a project key', () => {
  assert.equal(entryWorkspaceHint('/real/alpha/同名项目/'), 'alpha/同名项目')
  assert.equal(entryWorkspaceHint(undefined), '')
})
test('DOM keeps real names and roles, no binding is explicit, and 404 is not an empty roster', async () => {
  const previous = globalThis.document
  globalThis.document = { createElement: (tag) => new Node(tag) }
  try {
    const member = { memberName: '<Sam>', agentId: 'sam', roleId: 'execution', sessions: [] }
    const reader = createProjectRosterReader({ projectRoster: async (projectKey) => ({ projectKey, rosterState: 'configured', members: [member] }) })
    const root = mountMemberRoster({ projectKey: 'a', projectLabel: '同名项目', reader })
    await reader.read('a')
    assert.match(text(root), /<Sam> 执行/)
    assert.equal(root.children[0].tag, 'button')
    assert.match(text(memberRosterDetail(member, '同名项目', 'a')), /尚未绑定会话/)
    const bound = memberRosterDetail({ ...member, sessions: [{ sessionId: 'exact-session', state: 'running' }] }, '同名项目', 'a')
    assert.match(text(bound), /运行中.*exact-session/)
    assert.equal(bound.children.some((child) => child.tag === 'details'), false)
    assert.equal(bound.children.some((child) => child.tag === 'a'), false)
    const errorRoot = mountMemberRoster({ projectKey: 'old-service', projectLabel: '旧项目', reader: {
      read: async () => { throw Object.assign(new Error('not found'), { status: 404 }) },
    } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(errorRoot.children.length, 0)
    assert.doesNotMatch(text(errorRoot), /暂无成员|Sam|Jenny/)
  } finally { globalThis.document = previous }
})

// Seen failure: a second Jenny link was outside the roster, and HTTP 404
// became a fake member. Cost: small DOM consumer; impact: wrong navigation.
test('serve-bound Jenny is one member row with separate session and detail controls, even without roster', async () => {
  const previous = globalThis.document
  globalThis.document = { createElement: (tag) => new Node(tag) }
  try {
    const mainTopic = { projectKey: 'a', agentName: 'Jenny', href: './?projectKey=a', current: true }
    const reader = { read: async (projectKey) => ({ projectKey, rosterState: 'configured', members: [
      { memberName: 'Jenny', agentId: 'interaction-default', roleId: 'interaction', sessions: [] },
      { memberName: 'Sam', agentId: 'sam', roleId: 'review', sessions: [] },
    ] }) }
    const root = mountMemberRoster({ projectKey: 'a', projectLabel: '同名', reader, mainTopic })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(root.children.length, 2)
    const row = root.children[0]
    assert.equal(row.children[0].tag, 'a')
    assert.equal(row.children[0].href, mainTopic.href)
    assert.equal(row.children[0]['aria-current'], 'page')
    assert.match(text(row), /Jenny.*项目负责人.*成员详情/)
    assert.equal(row.children[1].tag, 'button')
    const other = mountMemberRoster({ projectKey: 'b', projectLabel: '同名', reader, mainTopic })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(other.children[0].tag, 'button')
    let issue
    const failed = mountMemberRoster({ projectKey: 'a', projectLabel: '同名', mainTopic,
      reader: { read: async () => { throw new Error('not found') } }, onReadIssue: (value) => { issue = value } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(failed.children.length, 1)
    assert.match(text(failed), /Jenny.*项目负责人/)
    assert.doesNotMatch(text(failed), /不可读|not found/)
    assert.match(issue, /not found/)
  } finally { globalThis.document = previous }
})
