import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWorkspaceNameReceipts,
  effectiveWorkspaceName,
  workspaceFailureText,
  workspaceNameEdits,
} from '../../docs/ui/workspace-management.js'

const workspaces = [
  { projectKey: 'a', workspaceCwd: '/work/a', workspaceAlias: 'a' },
  { projectKey: 'b', workspaceCwd: '/work/b', workspaceAlias: '旧名称' },
]

// Failure basis: a batch submit can report a global success while one item was
// rejected. Impact: users believe an invalid workspace was renamed. Cost: pure
// row reducer with no server or browser process.
test('workspace alias batch UI produces one exact edit per selected row', () => {
  assert.equal(effectiveWorkspaceName(workspaces[0]), 'a')
  assert.equal(effectiveWorkspaceName({ workspaceCwd: '/work/c', workspaceAlias: '  新 C  ' }), '新 C')
  assert.deepEqual(workspaceNameEdits({ workspaces, selected: new Set(['/work/a', '/work/b']), names: new Map([['/work/a', '新 A'], ['/work/b', '新 B']]) }), [
    { projectKey: 'a', workspaceCwd: '/work/a', workspaceAlias: '新 A' },
    { projectKey: 'b', workspaceCwd: '/work/b', workspaceAlias: '新 B' },
  ])
})

test('workspace batch UI merges status by stable scope', () => {
  const next = applyWorkspaceNameReceipts(workspaces, {
    receipts: [
      { projectKey: 'a', workspaceCwd: '/work/a', status: 'completed', workspaceAlias: '新 A' },
      { projectKey: 'b', workspaceCwd: '/work/b', status: 'rejected', error: { code: 'workspace-alias-invalid', message: '名称不能为空' } },
    ],
  })
  assert.equal(next[0].workspaceAlias, '新 A')
  assert.equal(next[0].status, 'completed')
  assert.equal(next[1].workspaceAlias, '旧名称')
  assert.equal(next[1].status, 'rejected')
  assert.equal(next[1].error.code, 'workspace-alias-invalid')
})

test('workspace batch UI keys rows by canonical workspace path', () => {
  const sameWorkspace = [
    { projectKey: 'a', workspaceCwd: '/work/shared', workspaceAlias: '共享名称' },
    { projectKey: 'duplicate', workspaceCwd: '/work/shared', workspaceAlias: '共享名称' },
  ]
  assert.deepEqual(workspaceNameEdits({
    workspaces: sameWorkspace,
    selected: new Set(['/work/shared']),
    names: new Map([['/work/shared', '新名称']]),
  }), [
    { projectKey: 'a', workspaceCwd: '/work/shared', workspaceAlias: '新名称' },
  ])
})

test('workspace failures keep a user-readable reason', () => {
  assert.equal(workspaceFailureText({ code: 'workspace-path-invalid' }), '工作区目录已不可用')
  assert.equal(workspaceFailureText({ code: 'workspace-scope-invalid' }), '工作区登记已变化，请重新读取')
  assert.equal(workspaceFailureText({ code: 'unexpected.internal-code' }), '未保存，请重试')
})

