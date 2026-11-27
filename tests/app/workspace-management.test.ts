import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { resolveRuntimePaths } from '../../packages/config/src/index.js';
import {
  bindWorkspaceManagementResource,
  WORKSPACE_MANAGEMENT_ROUTE,
} from '../../packages/app/src/ui-runtime/workspace-management.js';

test('workspace management resource validates each requested scope and returns the persisted result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-workspace-api-'));
  const workspace = join(root, 'workspace');
  const otherWorkspace = join(root, 'other-workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  const otherPaths = await resolveRuntimePaths({ controlRoot: paths.controlRoot, workspace: otherWorkspace });
  const sessionRoot = dirname(paths.projectRoot);
  const firstProject = join(sessionRoot, paths.projectKey);
  const secondProject = join(sessionRoot, otherPaths.projectKey);
  const duplicateKey = `${paths.projectKey}--${createHash('sha256').update(paths.workspaceCwd).digest('hex').slice(0, 16)}`;
  const duplicateProject = join(sessionRoot, duplicateKey);
  await mkdir(firstProject, { recursive: true });
  await mkdir(secondProject, { recursive: true });
  await mkdir(duplicateProject, { recursive: true });
  await writeFile(join(firstProject, 'project.json'), JSON.stringify({ schemaVersion: 1, projectKey: paths.projectKey, workspaceCwd: paths.workspaceCwd, displayName: '项目甲' }));
  await writeFile(join(secondProject, 'project.json'), JSON.stringify({ schemaVersion: 1, projectKey: otherPaths.projectKey, workspaceCwd: otherPaths.workspaceCwd }));
  await writeFile(join(duplicateProject, 'project.json'), JSON.stringify({ schemaVersion: 1, projectKey: duplicateKey, workspaceCwd: paths.workspaceCwd, displayName: '项目乙' }));
  const handler = bindWorkspaceManagementResource(paths);

  const read = await handler.handle('GET');
  assert.equal(read.workspaces.length, 2, 'two canonical workspaces produce two editable rows');
  assert.equal(read.workspaces.filter((workspace) => workspace.workspaceCwd === paths.workspaceCwd).length, 1);
  assert.equal(WORKSPACE_MANAGEMENT_ROUTE, '/api/workspaces/management');

  const receipt = await handler.handle('PUT', {
    updates: [
      { projectKey: paths.projectKey, workspaceCwd: paths.workspaceCwd, workspaceAlias: '产品主工作区' },
      { projectKey: otherPaths.projectKey, workspaceCwd: `${otherPaths.workspaceCwd}/wrong`, workspaceAlias: '错误路径' },
      { projectKey: paths.projectKey, workspaceCwd: paths.workspaceCwd, displayName: '不能改写项目标题' },
    ],
  });
  if (receipt.receipts === undefined) throw new Error('workspace update must return receipts');
  assert.deepEqual(receipt.receipts.map(({ status, projectKey }) => ({ status, projectKey })), [
    { status: 'completed', projectKey: paths.projectKey },
    { status: 'rejected', projectKey: otherPaths.projectKey },
    { status: 'rejected', projectKey: paths.projectKey },
  ]);
  assert.equal(receipt.receipts[1]?.error?.code, 'workspace-scope-invalid');
  assert.equal(receipt.receipts[2]?.error?.code, 'workspace-management.invalid-item');
  assert.equal(receipt.workspaces.find((workspace) => workspace.workspaceCwd === paths.workspaceCwd)?.workspaceAlias, '产品主工作区');
  const saved = await Promise.all([firstProject, duplicateProject].map(async (dir) =>
    JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as Record<string, unknown>));
  assert.deepEqual(saved.map((manifest) => manifest.displayName), ['项目甲', '项目乙']);
  assert.deepEqual(saved.map((manifest) => manifest.workspaceAlias), ['产品主工作区', '产品主工作区']);
});

