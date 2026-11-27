/**
 * Authenticated product resource for editing workspace aliases.
 *
 * The stable workspace path remains the identity. Config owns registration
 * discovery, manifest validation and atomic persistence; this module only
 * validates the public request shape and serializes mutations on one resource.
 */
import {
  readWorkspaceManagement,
  updateWorkspaceAliases,
  type RuntimePaths,
  type WorkspaceAliasReceipt,
  type WorkspaceAliasUpdate,
  type WorkspaceManagementCatalog,
} from '../../../config/src/index.js';
import { UiRuntimeApiError } from './errors.js';

const APP_OWNER = 'humanagent.app';

export const WORKSPACE_MANAGEMENT_ROUTE = '/api/workspaces/management';

export type WorkspaceManagementMethod = 'GET' | 'PUT';

export interface WorkspaceManagementPayload {
  readonly workspaces: WorkspaceManagementCatalog['entries'];
  readonly failures?: WorkspaceManagementCatalog['failures'];
  readonly receipts?: readonly WorkspaceAliasReceipt[];
}

export interface WorkspaceManagementPorts {
  readonly read: (paths: RuntimePaths) => Promise<WorkspaceManagementCatalog>;
  readonly update: (
    paths: RuntimePaths,
    updates: readonly WorkspaceAliasUpdate[],
  ) => Promise<readonly WorkspaceAliasReceipt[]>;
}

export interface WorkspaceManagementResourceHandler {
  handle(method: WorkspaceManagementMethod, body?: unknown): Promise<WorkspaceManagementPayload>;
}

function invalidRequest(code: string, message: string, nextAction: string): UiRuntimeApiError {
  return new UiRuntimeApiError(code, APP_OWNER, message, nextAction, 400);
}

function parseUpdates(body: unknown): readonly (WorkspaceAliasUpdate | WorkspaceAliasReceipt)[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('workspace-management.invalid-request', 'workspace management body must be an object', 'send {updates:[{projectKey,workspaceCwd,workspaceAlias}]}');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'updates') {
      throw invalidRequest('workspace-management.invalid-request', `workspace management has unsupported field: ${key}`, 'send only updates');
    }
  }
  if (!Array.isArray(record.updates) || record.updates.length === 0) {
    throw invalidRequest('workspace-management.invalid-updates', 'updates must contain at least one workspace edit', 'select one or more workspaces and submit their names');
  }
  return record.updates.map((value, index) => {
    const fallback = {
      projectKey: typeof value === 'object' && value !== null && !Array.isArray(value)
        ? String((value as Record<string, unknown>).projectKey ?? '')
        : '',
      workspaceCwd: typeof value === 'object' && value !== null && !Array.isArray(value)
        ? String((value as Record<string, unknown>).workspaceCwd ?? '')
        : '',
    };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return rejectedItem(fallback, 'workspace-management.invalid-item', `updates[${index}] must be an object`, 'send projectKey, workspaceCwd and workspaceAlias');
    }
    const item = value as Record<string, unknown>;
    const unknown = Object.keys(item).find((key) => key !== 'projectKey' && key !== 'workspaceCwd' && key !== 'workspaceAlias');
    if (unknown !== undefined) {
      return rejectedItem(fallback, 'workspace-management.invalid-item', `updates[${index}] has unsupported field: ${unknown}`, 'send only projectKey, workspaceCwd and workspaceAlias');
    }
    if (typeof item.projectKey !== 'string' || item.projectKey.trim() === '') {
      return rejectedItem(fallback, 'workspace-management.invalid-item', `updates[${index}].projectKey must be non-empty`, 'select an existing workspace registration');
    }
    if (typeof item.workspaceCwd !== 'string' || item.workspaceCwd.trim() === '') {
      return rejectedItem({ ...fallback, projectKey: item.projectKey.trim() }, 'workspace-management.invalid-item', `updates[${index}].workspaceCwd must be non-empty`, 'reselect the workspace registration');
    }
    if (typeof item.workspaceAlias !== 'string') {
      return rejectedItem({ projectKey: item.projectKey.trim(), workspaceCwd: item.workspaceCwd.trim() }, 'workspace-management.invalid-item', `updates[${index}].workspaceAlias must be a string`, 'enter a readable workspace name');
    }
    return {
      projectKey: item.projectKey.trim(),
      workspaceCwd: item.workspaceCwd.trim(),
      workspaceAlias: item.workspaceAlias,
    };
  });
}

function rejectedItem(
  scope: { readonly projectKey: string; readonly workspaceCwd: string },
  code: string,
  message: string,
  nextAction: string,
): WorkspaceAliasReceipt {
  return {
    ...scope,
    status: 'rejected',
    error: { code, message, nextAction },
  };
}

class WorkspaceManagementResource implements WorkspaceManagementResourceHandler {
  private sequence: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly paths: RuntimePaths,
    private readonly ports: WorkspaceManagementPorts,
  ) {}

  handle(method: WorkspaceManagementMethod, body?: unknown): Promise<WorkspaceManagementPayload> {
    if (method === 'GET') return this.read();
    return this.enqueue(() => this.update(body));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(operation, operation);
    this.sequence = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<WorkspaceManagementPayload> {
    try {
      const catalog = await this.ports.read(this.paths);
      return { workspaces: catalog.entries, failures: catalog.failures };
    } catch (error) {
      throw this.wrap(error, 'workspace-management.read-failed', 'check the control root and retry');
    }
  }

  private async update(body: unknown): Promise<WorkspaceManagementPayload> {
    const parsed = parseUpdates(body);
    const updates = parsed.filter((item): item is WorkspaceAliasUpdate => 'workspaceAlias' in item && typeof item.workspaceAlias === 'string');
    let saved: readonly WorkspaceAliasReceipt[] = [];
    try {
      saved = updates.length === 0 ? [] : await this.ports.update(this.paths, updates);
    } catch (error) {
      throw this.wrap(error, 'workspace-management.save-failed', 'check the control root and retry');
    }
    const receiptByKey = new Map(saved.map((receipt) => [workspaceScopeKey(receipt), receipt]));
    const receipts = parsed.map((item) => {
      if (!('workspaceAlias' in item)) return item;
      return receiptByKey.get(workspaceScopeKey(item)) ?? {
        projectKey: item.projectKey,
        workspaceCwd: item.workspaceCwd,
        status: 'failed' as const,
        error: {
          code: 'workspace-management.receipt-missing',
          message: 'the Config save did not return a receipt for this workspace',
          nextAction: 'refresh workspace registrations before retrying',
        },
      };
    });
    const catalog = await this.read();
    return { ...catalog, receipts };
  }

  private wrap(error: unknown, code: string, nextAction: string): UiRuntimeApiError {
    if (error instanceof UiRuntimeApiError) return error;
    return new UiRuntimeApiError(
      code,
      APP_OWNER,
      error instanceof Error ? error.message : String(error),
      nextAction,
      500,
      undefined,
      error,
    );
  }
}

function workspaceScopeKey(value: { readonly projectKey: string; readonly workspaceCwd: string }): string {
  return JSON.stringify([value.projectKey, value.workspaceCwd]);
}

export function createWorkspaceManagementResource(
  paths: RuntimePaths,
  ports: WorkspaceManagementPorts,
): WorkspaceManagementResourceHandler {
  return new WorkspaceManagementResource(paths, ports);
}

export function bindWorkspaceManagementResource(paths: RuntimePaths): WorkspaceManagementResourceHandler {
  return createWorkspaceManagementResource(paths, {
    read: readWorkspaceManagement,
    update: updateWorkspaceAliases,
  });
}
