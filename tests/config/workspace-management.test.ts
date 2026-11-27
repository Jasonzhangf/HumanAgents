import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { resolveRuntimePaths } from '../../packages/config/src/index.js';
import {
  readWorkspaceManagement,
  updateWorkspaceAliases,
} from '../../packages/config/src/workspace-management.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-workspace-management-'));
  const requestedControlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  const secondWorkspace = join(root, 'second-workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(secondWorkspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot: requestedControlRoot, workspace });
  const sessionRoot = dirname(paths.projectRoot);
  const firstProject = join(sessionRoot, paths.projectKey);
  const secondPaths = await resolveRuntimePaths({ controlRoot: requestedControlRoot, workspace: secondWorkspace });
  const secondProject = join(sessionRoot, secondPaths.projectKey);
  const duplicateKey = `${paths.projectKey}--${createHash('sha256').update(paths.workspaceCwd).digest('hex').slice(0, 16)}`;
  const duplicateProject = join(sessionRoot, duplicateKey);
  await mkdir(firstProject, { recursive: true });
  await mkdir(secondProject, { recursive: true });
  await mkdir(duplicateProject, { recursive: true });
  await writeFile(join(firstProject, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: paths.projectKey,
    workspaceCwd: paths.workspaceCwd,
    displayName: '项目一',
  }));
  await writeFile(join(secondProject, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: secondPaths.projectKey,
    workspaceCwd: secondPaths.workspaceCwd,
    displayName: '旧名称',
    sources: {},
  }));
  await writeFile(join(duplicateProject, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: duplicateKey,
    workspaceCwd: paths.workspaceCwd,
    displayName: '项目二',
  }));
  return { root, paths, secondPaths, workspace, secondWorkspace, firstProject, duplicateProject, secondProject, secondKey: secondPaths.projectKey };
}

// Failure basis: older manifests have no displayName and the current catalog
// has no management write fact. Impact: renaming can lose identity or drop old
// records. Cost: local isolated filesystem fixture only.
test('workspace aliases are batch-edited per item without changing project display names', async () => {
  const item = await fixture();
  assert.deepEqual(
    (await readWorkspaceManagement(item.paths)).entries.map(({ projectKey, workspaceCwd, workspaceAlias }) => ({ projectKey, workspaceCwd, workspaceAlias })),
    [
      { projectKey: item.paths.projectKey, workspaceCwd: item.paths.workspaceCwd, workspaceAlias: undefined },
      { projectKey: item.secondKey, workspaceCwd: item.secondPaths.workspaceCwd, workspaceAlias: undefined },
    ].sort((left, right) => left.projectKey.localeCompare(right.projectKey)),
  );

  const missingWorkspace = join(item.root, 'missing-workspace');
  await mkdir(missingWorkspace, { recursive: true });
  const missingPaths = await resolveRuntimePaths({ controlRoot: item.paths.controlRoot, workspace: missingWorkspace });
  await rm(missingWorkspace, { recursive: true });
  const missingProject = join(dirname(item.paths.projectRoot), missingPaths.projectKey);
  await mkdir(missingProject, { recursive: true });
  await writeFile(join(missingProject, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: missingPaths.projectKey,
    workspaceCwd: missingWorkspace,
  }));

  const result = await updateWorkspaceAliases(item.paths, [
      { projectKey: item.paths.projectKey, workspaceCwd: item.paths.workspaceCwd, workspaceAlias: '真实工作区' },
      { projectKey: item.secondKey, workspaceCwd: item.secondPaths.workspaceCwd, workspaceAlias: '  ' },
      { projectKey: 'missing-project', workspaceCwd: '/missing/project', workspaceAlias: '不存在' },
      { projectKey: missingPaths.projectKey, workspaceCwd: missingWorkspace, workspaceAlias: '路径已失效' },
  ]);

  assert.deepEqual(result.map(({ status, projectKey }) => ({ status, projectKey })), [
    { status: 'completed', projectKey: item.paths.projectKey },
    { status: 'rejected', projectKey: item.secondKey },
    { status: 'failed', projectKey: 'missing-project' },
    { status: 'failed', projectKey: missingPaths.projectKey },
  ]);
  assert.equal(result[1]?.error?.code, 'workspace-alias-invalid');
  assert.equal(result[2]?.error?.code, 'workspace-registration-missing');
  assert.equal(result[3]?.error?.code, 'workspace-path-invalid');

  const savedManifest = JSON.parse(await readFile(join(item.firstProject, 'project.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(savedManifest.projectKey, item.paths.projectKey);
  assert.equal(savedManifest.workspaceCwd, item.paths.workspaceCwd);
  assert.equal(savedManifest.displayName, '项目一');
  assert.equal(savedManifest.workspaceAlias, '真实工作区');
  const duplicateManifest = JSON.parse(await readFile(join(item.duplicateProject, 'project.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(duplicateManifest.projectKey, `${item.paths.projectKey}--${createHash('sha256').update(item.paths.workspaceCwd).digest('hex').slice(0, 16)}`);
  assert.equal(duplicateManifest.workspaceCwd, item.paths.workspaceCwd);
  assert.equal(duplicateManifest.displayName, '项目二');
  assert.equal(duplicateManifest.workspaceAlias, '真实工作区');

  const fresh = (await readWorkspaceManagement(item.paths)).entries;
  assert.equal(fresh.find((entry) => entry.projectKey === item.paths.projectKey)?.workspaceAlias, '真实工作区');
  assert.equal(fresh.filter((entry) => entry.workspaceCwd === item.paths.workspaceCwd).length, 1);
  assert.equal(fresh.find((entry) => entry.projectKey === item.secondKey)?.workspaceAlias, undefined);
  assert.equal(fresh.some((entry) => entry.projectKey === missingPaths.projectKey), false);
});

// Failure basis: legacy registrations for one workspace may disagree on the
// alias, and directory enumeration order is not a product identity. Impact: a
// refresh can silently change the only visible workspace name. Cost: two local
// manifests in the existing fixture plus one focused cold read.
test('one workspace reads one deterministic alias and one save unifies every registration', async () => {
  const item = await fixture();
  await writeFile(join(item.firstProject, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: item.paths.projectKey,
    workspaceCwd: item.paths.workspaceCwd,
    displayName: '乙名称',
  }));
  await writeFile(join(item.duplicateProject, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectKey: `${item.paths.projectKey}--${createHash('sha256').update(item.paths.workspaceCwd).digest('hex').slice(0, 16)}`,
    workspaceCwd: item.paths.workspaceCwd,
    displayName: '甲名称',
  }));

  const rows = (await readWorkspaceManagement(item.paths)).entries
    .filter((entry) => entry.workspaceCwd === item.paths.workspaceCwd);
  assert.deepEqual(rows.map(({ projectKey, workspaceAlias }) => ({ projectKey, workspaceAlias })), [{
    projectKey: item.paths.projectKey,
    workspaceAlias: undefined,
  }]);

  await updateWorkspaceAliases(item.paths, [{
    projectKey: rows[0]!.projectKey,
    workspaceCwd: rows[0]!.workspaceCwd,
    workspaceAlias: '统一工作区',
  }]);
  const manifests = await Promise.all([
    readFile(join(item.firstProject, 'project.json'), 'utf8'),
    readFile(join(item.duplicateProject, 'project.json'), 'utf8'),
  ]);
  assert.deepEqual(manifests.map((raw) => JSON.parse(raw).displayName), ['乙名称', '甲名称']);
  assert.deepEqual(manifests.map((raw) => JSON.parse(raw).workspaceAlias), ['统一工作区', '统一工作区']);
  assert.deepEqual(
    (await readWorkspaceManagement(item.paths)).entries
      .filter((entry) => entry.workspaceCwd === item.paths.workspaceCwd)
      .map(({ projectKey, workspaceCwd, workspaceAlias }) => ({ projectKey, workspaceCwd, workspaceAlias })),
    [{ projectKey: item.paths.projectKey, workspaceCwd: item.paths.workspaceCwd, workspaceAlias: '统一工作区' }],
  );
});

