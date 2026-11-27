import { mkdir, open as openFile, readFile, realpath, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listConfiguredProjects, type RuntimePaths } from './index.js';

export interface WorkspaceManagementEntry {
  readonly projectKey: string;
  readonly workspaceCwd: string;
  readonly projectRoot: string;
  readonly workspaceAlias?: string;
}

export interface WorkspaceManagementFailure {
  readonly code: string;
  readonly message: string;
  readonly nextAction: string;
}

export interface WorkspaceManagementCatalog {
  readonly entries: readonly WorkspaceManagementEntry[];
  readonly failures: readonly WorkspaceManagementFailure[];
}

export interface WorkspaceAliasUpdate {
  readonly projectKey: string;
  readonly workspaceCwd: string;
  readonly workspaceAlias: string;
}

export interface WorkspaceAliasReceipt {
  readonly projectKey: string;
  readonly workspaceCwd: string;
  readonly status: 'completed' | 'rejected' | 'failed';
  readonly workspaceAlias?: string;
  readonly error?: WorkspaceManagementFailure;
}

/**
 * Read one editable row per canonical workspace. Several project registrations
 * can share a workspace; the path is the identity and therefore yields one
 * alias. Registration discovery and manifest validation stay in Config's
 * project catalog.
 */
export async function readWorkspaceManagement(paths: RuntimePaths): Promise<WorkspaceManagementCatalog> {
  const catalog = await listConfiguredProjects(paths);
  const byWorkspace = new Map<string, WorkspaceManagementEntry>();
  // A workspace has one visible alias even when old manifests disagree. Sort
  // by stable project key so directory enumeration order cannot change it.
  const projects = [...catalog.projects].sort((left, right) =>
    compareText(left.projectKey, right.projectKey) || compareText(left.workspaceCwd, right.workspaceCwd));
  for (const project of projects) {
    const current = byWorkspace.get(project.workspaceCwd);
    if (current === undefined) {
      byWorkspace.set(project.workspaceCwd, {
        projectKey: project.projectKey,
        workspaceCwd: project.workspaceCwd,
        projectRoot: project.projectRoot,
        ...(project.workspaceAlias === undefined ? {} : { workspaceAlias: project.workspaceAlias }),
      });
      continue;
    }
    if (current.workspaceAlias === undefined && project.workspaceAlias !== undefined) {
      byWorkspace.set(project.workspaceCwd, { ...current, workspaceAlias: project.workspaceAlias });
    }
  }
  return {
    entries: [...byWorkspace.values()].sort((left, right) => left.workspaceCwd.localeCompare(right.workspaceCwd)),
    failures: catalog.failures.map(({ code, message, nextAction }) => ({ code, message, nextAction })),
  };
}

/**
 * Apply one workspace alias to every project registration for the same canonical
 * workspace without changing any project's displayName. The catalog is read once for scope validation and once after all
 * writes. Every input gets its own receipt; one failure does not stop the rest.
 */
export async function updateWorkspaceAliases(
  paths: RuntimePaths,
  updates: readonly WorkspaceAliasUpdate[],
): Promise<readonly WorkspaceAliasReceipt[]> {
  const initial = await listConfiguredProjects(paths);
  const prepared: Array<{
      readonly update: WorkspaceAliasUpdate;
    readonly manifestPaths: readonly string[];
    failure?: WorkspaceManagementFailure;
  }> = [];

  for (const update of updates) {
    try {
      const workspaceAlias = update.workspaceAlias.trim();
      if (workspaceAlias === '') throw managementError('workspace-alias-invalid', 'workspace alias must not be empty', '填写可读名称后重试');
      const selected = initial.projects.find((project) => project.projectKey === update.projectKey);
      if (selected === undefined) {
        throw await diagnoseMissingRegistration(paths, update);
      }
      if (selected.workspaceCwd !== update.workspaceCwd) {
        throw managementError('workspace-scope-invalid', 'workspace registration does not match the requested scope', '重新读取项目目录后重试');
      }
      const manifestPaths = initial.projects
        .filter((project) => project.workspaceCwd === update.workspaceCwd)
        .map((project) => join(project.projectRoot, 'project.json'));
      prepared.push({ update: { ...update, workspaceAlias }, manifestPaths });
    } catch (error) {
      prepared.push({ update, manifestPaths: [], failure: failureFrom(error) });
    }
  }

  for (const item of prepared) {
    if (item.failure !== undefined) continue;
    try {
      for (const manifestPath of item.manifestPaths) {
        const parsed = parseManifest(await readFile(manifestPath, 'utf8'), manifestPath);
        if (parsed.workspaceCwd !== item.update.workspaceCwd) {
          throw managementError('workspace-scope-invalid', 'workspace registration changed during save', '重新读取项目目录后重试');
        }
        const next = { ...parsed, workspaceAlias: item.update.workspaceAlias.trim() };
        await writeManifestAtomically(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
      }
    } catch (error) {
      item.failure = failureFrom(error);
    }
  }

  const needsReadBack = prepared.some((item) => item.failure === undefined && item.manifestPaths.length > 0);
  const refreshed = needsReadBack ? await listConfiguredProjects(paths) : initial;
  return prepared.map((item) => {
    if (item.failure !== undefined) {
      return {
        projectKey: item.update.projectKey,
        workspaceCwd: item.update.workspaceCwd,
        status: item.failure.code === 'workspace-alias-invalid' || item.failure.code === 'workspace-scope-invalid'
          ? 'rejected'
          : 'failed',
        error: item.failure,
      };
    }
    const expected = item.update.workspaceAlias.trim();
    const saved = refreshed.projects.filter((project) => project.workspaceCwd === item.update.workspaceCwd);
    if (saved.length > 0 && saved.every((project) => project.workspaceAlias === expected)) {
      return {
        projectKey: item.update.projectKey,
        workspaceCwd: item.update.workspaceCwd,
        status: 'completed',
        workspaceAlias: expected,
      };
    }
    return {
      projectKey: item.update.projectKey,
      workspaceCwd: item.update.workspaceCwd,
      status: 'failed',
      error: {
        code: 'workspace-alias-readback-mismatch',
        message: 'the saved workspace alias could not be read back for every project in this workspace',
        nextAction: '重新读取工作区登记并重试',
      },
    };
  });
}

interface ParsedManifest { projectKey: string; workspaceCwd: string; displayName?: string; workspaceAlias?: string; [key: string]: unknown }

class WorkspaceManagementError extends Error {
  constructor(readonly code: string, message: string, readonly nextAction: string) { super(message); }
}

function managementError(code: string, message: string, nextAction: string): WorkspaceManagementError {
  return new WorkspaceManagementError(code, message, nextAction);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failureFrom(error: unknown): WorkspaceManagementFailure {
  return error instanceof WorkspaceManagementError
    ? { code: error.code, message: error.message, nextAction: error.nextAction }
    : {
        code: 'workspace-management-failed',
        message: error instanceof Error ? error.message : String(error),
        nextAction: '检查 runtime project 记录后重试',
      };
}

async function diagnoseMissingRegistration(
  paths: RuntimePaths,
  update: WorkspaceAliasUpdate,
): Promise<WorkspaceManagementError> {
  if (update.projectKey === '' || update.projectKey === '.' || update.projectKey === '..'
    || update.projectKey.includes('/') || update.projectKey.includes('\\')) {
    return managementError('workspace-registration-missing', 'workspace registration is missing', '重新读取项目目录后重试');
  }
  const manifestPath = join(dirname(paths.projectRoot), update.projectKey, 'project.json');
  let manifest: ParsedManifest;
  try {
    manifest = parseManifest(await readFile(manifestPath, 'utf8'), manifestPath);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return managementError('workspace-registration-missing', 'workspace registration is missing', '重新读取项目目录后重试');
    }
    return error instanceof WorkspaceManagementError
      ? error
      : managementError('project-manifest-unreadable', `project manifest is unavailable: ${manifestPath}`, '修复或移除该 project 记录后重试');
  }
  if (manifest.projectKey !== update.projectKey || manifest.workspaceCwd !== update.workspaceCwd) {
    return managementError('workspace-scope-invalid', 'workspace registration does not match the requested scope', '重新读取项目目录后重试');
  }
  try {
    const actualWorkspace = await realpath(manifest.workspaceCwd);
    if (!(await stat(actualWorkspace)).isDirectory() || actualWorkspace !== manifest.workspaceCwd) {
      return managementError('workspace-path-invalid', `workspace path is invalid: ${manifest.workspaceCwd}`, '修复 workspace 路径后重试');
    }
  } catch {
    return managementError('workspace-path-invalid', `workspace path is unavailable: ${manifest.workspaceCwd}`, '修复 workspace 路径后重试');
  }
  return managementError('workspace-registration-missing', 'workspace registration is missing', '重新读取项目目录后重试');
}

function parseManifest(raw: string, manifestPath: string): ParsedManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw managementError('project-manifest-corrupt', `project manifest is not valid JSON: ${manifestPath}`, '修复 project.json 后重试'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw managementError('project-manifest-corrupt', `project manifest must be an object: ${manifestPath}`, '修复 project.json 后重试');
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.projectKey !== 'string' || typeof value.workspaceCwd !== 'string' || value.projectKey === '' || value.workspaceCwd === '') throw managementError('project-manifest-corrupt', `project manifest identity is invalid: ${manifestPath}`, '修复 project.json 后重试');
  if (value.displayName !== undefined && (typeof value.displayName !== 'string' || value.displayName.trim() === '')) throw managementError('display-name-invalid', `project displayName is invalid: ${manifestPath}`, '修复 displayName 后重试');
  if (value.workspaceAlias !== undefined && (typeof value.workspaceAlias !== 'string' || value.workspaceAlias.trim() === '')) throw managementError('workspace-alias-invalid', `project workspaceAlias is invalid: ${manifestPath}`, '修复 workspaceAlias 后重试');
  return value as ParsedManifest;
}

async function writeManifestAtomically(manifestPath: string, contents: string): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.workspace-management-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  const handle = await openFile(tempPath, 'wx');
  try { await handle.writeFile(contents, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(tempPath, manifestPath);
}
