import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname, join, resolve, sep, relative } from 'node:path';
import {
  CODE_SEARCH_CONTRACT_VERSION,
  CODE_SEARCH_SERVICE_ID,
  id,
  type EvidenceRef,
  type OperationEvent,
  type OperationId,
  type OperationIntent,
  type ProviderToolDefinition,
  type Scope,
  type WebSearchRequest,
  type WebSearchRecency,
  WEB_SEARCH_SERVICE_ID,
  WEB_SEARCH_CONTRACT_VERSION,
} from '../../contracts/src/index.js';
import { ImmutableAssetStore, type AssetReference } from '../../adapters/filesystem/src/index.js';
import {
  FileReadRoute,
  WorkspaceCodeSearchFunctions,
  createAgentReachWebSearchProvider,
  type FileReadArtifactStore,
  type FileReadReport,
  type FileReadRequest,
  type WebSearchProviderBackendConfig,
} from '../../adapters/operations/src/index.js';
import { CodeSearchService, WebSearchService, type WebSearchProvider } from '../../runtime/src/hand/index.js';
import type { ProviderToolExecutionPort } from '../../adapters/provider/src/index.js';
import type { OperationJournalPort } from '../../runtime/src/gateway/index.js';
import { createHandOperationRuntime } from './tool-execution-gateway.js';

const OWNER = 'humanagent.app.provider-tool-execution';

export const RESPONSES_FILE_READ_TOOL: ProviderToolDefinition = {
  toolId: 'file.read',
  description: 'Read one UTF-8 text file from the bound project workspace. Use the returned path and content as the source for file-specific answers.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};

export const RESPONSES_FILE_WRITE_TOOL: ProviderToolDefinition = {
  toolId: 'file.write',
  description: 'Create or fully replace a UTF-8 text file in the bound project workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
};

export const RESPONSES_FILE_EDIT_TOOL: ProviderToolDefinition = {
  toolId: 'file.edit',
  description: 'Edit an existing UTF-8 text file by replacing literal text.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
};

export const RESPONSES_BASH_TOOL: ProviderToolDefinition = {
  toolId: 'bash',
  description: 'Execute a foreground bash command in the bound project workspace and return stdout/stderr.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      workdir: { type: 'string' },
    },
    required: ['command', 'description'],
    additionalProperties: false,
  },
};

export const RESPONSES_TODO_WRITE_TOOL: ProviderToolDefinition = {
  toolId: 'todo_write',
  description: 'Record the complete task list for the current task. This replaces the previous list.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
};

export const RESPONSES_GET_GOAL_TOOL: ProviderToolDefinition = {
  toolId: 'get_goal',
  description: 'Read the current task goal.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export const RESPONSES_CREATE_GOAL_TOOL: ProviderToolDefinition = {
  toolId: 'create_goal',
  description: 'Create a persisted task goal.',
  inputSchema: {
    type: 'object',
    properties: {
      objective: { type: 'string' },
      token_budget: { type: 'integer', minimum: 1 },
    },
    required: ['objective'],
    additionalProperties: false,
  },
};

export const RESPONSES_UPDATE_GOAL_TOOL: ProviderToolDefinition = {
  toolId: 'update_goal',
  description: 'Update the exact current goal revision.',
  inputSchema: {
    type: 'object',
    properties: {
      goal_id: { type: 'string' },
      revision: { type: 'integer', minimum: 1 },
      action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
      objective: { type: 'string' },
      token_budget: { type: 'integer', minimum: 1 },
      blocked_reason: { type: 'string' },
    },
    required: ['goal_id', 'revision', 'action'],
    additionalProperties: false,
  },
};

export const RESPONSES_PRESENT_TOOL: ProviderToolDefinition = {
  toolId: 'present',
  description: 'Declare existing workspace files as deliverables for the user.',
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    required: ['files'],
    additionalProperties: false,
  },
};

export const RESPONSES_FILE_LIST_TOOL: ProviderToolDefinition = {
  toolId: 'file.list',
  description: 'List files under a path in the bound project workspace. Returns file paths relative to the workspace root.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      maxFiles: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

export const RESPONSES_FILE_SEARCH_TOOL: ProviderToolDefinition = {
  toolId: 'file.search',
  description: 'Search file contents under a path in the bound project workspace. Use literal for substring, regex for regexes, or symbol for identifiers.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      query: { type: 'string' },
      queryKind: { type: 'string', enum: ['literal', 'regex', 'symbol'] },
      contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 2 },
      maxResults: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
    required: ['path', 'query', 'queryKind'],
    additionalProperties: false,
  },
};

export const RESPONSES_WEB_SEARCH_TOOL: ProviderToolDefinition = {
  toolId: 'web.search',
  description: 'Search the public web for current sources via the bound search provider. Use it for live references, news, or facts that are not present in the bound workspace. Pass `query`; optionally narrow by `domains` or `recency`. The returned results carry `url`, `title`, `snippet`, and `sourceName` so you can cite them directly.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text query; the adapter pages pages 0..pageCeiling and stops at the first short page.' },
      domains: { type: 'array', items: { type: 'string' }, description: 'Optional include_domains; passed through to the provider as `include_domains`.' },
      recency: { type: 'string', enum: ['day', 'week', 'month', 'year', 'any'], description: 'Recency window; defaults to "any".' },
      maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'Cap on the validated result list returned to the model; defaults to 10.' },
      requireComplete: { type: 'boolean', description: 'If true, the call fails when any page error is unresolved or the provider did not exhaust its pages.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export interface ResponsesFileToolExecutor extends ProviderToolExecutionPort {}

/** Read-only view over persisted provider tool reports, addressed by the typed
 *  `{ outputRef, outputDigest }` descriptor carried on a tool result event.
 *  Reports are stored as JSON documents under `ImmutableAssetStore`, so the
 *  store never exposes host file paths. */
export interface UiRuntimeToolOutputStore {
  readonly store: ImmutableAssetStore;
  writeReport(input: { readonly outputId: string; readonly report: unknown }): Promise<{ readonly outputRef: string; readonly outputDigest: string }>;
  readReport(input: { readonly outputRef: string; readonly outputDigest: string }): Promise<unknown>;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);
}

function evidence(scope: Scope, label: string): EvidenceRef {
  return {
    evidenceId: id('evidence', safeId(`provider-file-tool-${label}`)),
    kind: 'tool',
    source: OWNER,
    locator: `provider-tool://${label}/${encodeURIComponent(label)}`,
    scope,
  };
}

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface GoalState {
  id: string;
  revision: number;
  objective: string;
  phase: 'active' | 'paused' | 'complete' | 'blocked';
  roundsStarted: number;
  maxGoalRounds?: number;
  blockedReason?: string;
}

interface TaskState {
  todos?: TodoItem[];
  goal?: GoalState;
}

function taskEvidence(request: ToolExecRequest, label: string): EvidenceRef {
  const cycleId = request.scope.cycleId ?? id('cycle', safeId(`provider-tool-${request.execution.taskId.value}`));
  return evidence({
    organId: request.scope.organId,
    taskId: request.execution.taskId,
    cycleId,
    operationId: request.execution.operationId,
  }, `${request.call.callId}-${label}`);
}

async function resolveWorkspacePath(root: string, inputPath: string): Promise<string> {
  const resolvedRoot = await Promise.resolve(root);
  const candidate = resolve(resolvedRoot, inputPath);
  const relativeRoot = relative(resolvedRoot, candidate);
  if (relativeRoot.startsWith('..') || relativeRoot.startsWith(sep)) {
    throw new Error(`path escapes workspace: ${inputPath}`);
  }
  return candidate;
}

function workspaceRelative(root: string, target: string): string {
  const rel = relative(root, target);
  if (rel === '') return '.';
  if (rel.startsWith('..') || rel.startsWith(sep)) throw new Error(`path escapes workspace: ${target}`);
  return rel;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 'ENOENT';
}

async function readOptionalWorkspaceFile(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function readRequiredWorkspaceFile(target: string): Promise<string> {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    throw Object.assign(new Error(`file.edit target is not a readable text file: ${target}`), { cause: error });
  }
}

async function assertRegularWorkspaceFile(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile()) throw new Error(`not a regular file: ${target}`);
  } catch (error) {
    if (isEnoent(error)) throw new Error(`present target file does not exist: ${target}`);
    throw error;
  }
}

async function readProviderTaskState(root: string, request: ToolExecRequest): Promise<TaskState> {
  const filePath = providerTaskStatePath(root, request);
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as TaskState;
  } catch (error) {
    if (isEnoent(error)) return {};
    throw Object.assign(new Error('provider task state is unreadable'), { cause: error });
  }
}

async function writeProviderTaskState(root: string, request: ToolExecRequest, state: TaskState): Promise<void> {
  const filePath = providerTaskStatePath(root, request);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state), 'utf8');
}

function providerTaskStatePath(root: string, request: ToolExecRequest): string {
  return join(root, 'task-state', `${request.execution.taskId.value}.json`);
}

class ToolOutputAssets implements UiRuntimeToolOutputStore {
  readonly store: ImmutableAssetStore;
  private readonly reports = new Map<string, AssetReference>();

  constructor(store: ImmutableAssetStore) {
    this.store = store;
  }

  async writeReport(input: { readonly outputId: string; readonly report: unknown }): Promise<{ readonly outputRef: string; readonly outputDigest: string }> {
    const content = JSON.stringify(input.report);
    const reference = await this.store.write(
      safeId(`provider-tool-output-${input.outputId}-${digest(content).slice(-12)}`),
      new TextEncoder().encode(content),
    );
    const outputRef = `asset://provider-tool/output/${encodeURIComponent(input.outputId)}`;
    this.reports.set(outputRef, reference);
    return { outputRef, outputDigest: reference.digest };
  }

  async readReport(input: { readonly outputRef: string; readonly outputDigest: string }): Promise<unknown> {
    const reference = this.reports.get(input.outputRef);
    if (!reference || reference.digest !== input.outputDigest) throw new Error('tool output report is missing or changed');
    return JSON.parse(new TextDecoder().decode(await this.store.read(reference))) as unknown;
  }
}

class FileReadAssets implements FileReadArtifactStore {
  private readonly requests = new Map<string, { readonly digest: string; readonly request: FileReadRequest }>();

  constructor(private readonly output: ToolOutputAssets) {}

  async writeRequest(callId: string, request: FileReadRequest): Promise<{ readonly inputRef: string; readonly inputDigest: string }> {
    const content = JSON.stringify(request);
    const inputDigest = digest(content);
    const inputRef = `asset://provider-tool/input/${encodeURIComponent(callId)}`;
    this.requests.set(inputRef, { digest: inputDigest, request });
    await this.output.store.write(safeId(`provider-tool-input-${callId}-${inputDigest.slice(-12)}`), new TextEncoder().encode(content));
    return { inputRef, inputDigest };
  }

  async readRequest(input: { readonly inputRef: string; readonly inputDigest: string }): Promise<FileReadRequest> {
    const stored = this.requests.get(input.inputRef);
    if (!stored || stored.digest !== input.inputDigest) throw new Error('file read request artifact is missing or changed');
    return stored.request;
  }

  async writeReport(input: { readonly operationId: OperationId; readonly report: FileReadReport }): Promise<{ readonly outputRef: string; readonly outputDigest: string }> {
    return this.output.writeReport({ outputId: input.operationId.value, report: input.report });
  }

  async readReport(input: { readonly outputRef: string; readonly outputDigest: string }): Promise<FileReadReport> {
    return (await this.output.readReport(input)) as FileReadReport;
  }
}

class FileOperationJournal implements OperationJournalPort {
  constructor(private readonly filePath: string) {}

  async commit(event: OperationEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

type ToolExecRequest = Parameters<ProviderToolExecutionPort['execute']>[0];
type ToolExecResult = ProviderToolExecutionPort['execute'] extends (input: infer _I) => Promise<infer R> ? R : never;

/** Tool ids this executor owns; surfaced to the provider when it calls a tool
 *  this Harness does not own (for example a backend harness tool such as
 *  `exec_command`) so the model can retry with an owned tool. */
const REGISTERED_TOOL_IDS: readonly string[] = [
  RESPONSES_FILE_READ_TOOL.toolId,
  RESPONSES_FILE_LIST_TOOL.toolId,
  RESPONSES_FILE_SEARCH_TOOL.toolId,
  RESPONSES_FILE_WRITE_TOOL.toolId,
  RESPONSES_FILE_EDIT_TOOL.toolId,
  RESPONSES_BASH_TOOL.toolId,
  RESPONSES_TODO_WRITE_TOOL.toolId,
  RESPONSES_GET_GOAL_TOOL.toolId,
  RESPONSES_CREATE_GOAL_TOOL.toolId,
  RESPONSES_UPDATE_GOAL_TOOL.toolId,
  RESPONSES_PRESENT_TOOL.toolId,
  RESPONSES_WEB_SEARCH_TOOL.toolId,
];

export function createResponsesFileToolExecutor(input: {
  readonly workspaceRoot: string;
  readonly projectKey: string;
  readonly artifactRoot: string;
  readonly webSearchProviderConfig?: WebSearchProviderBackendConfig;
}): { readonly executor: ResponsesFileToolExecutor; readonly searchReports: UiRuntimeToolOutputStore } {
  const workspaceRef = `workspace:${input.projectKey}`;
  const functions = new WorkspaceCodeSearchFunctions({ workspaceRef, workspaceRoot: input.workspaceRoot });
  const readAssets = new FileReadAssets(new ToolOutputAssets(new ImmutableAssetStore(join(input.artifactRoot, 'file-read'))));
  const readRoute = new FileReadRoute({ functions, artifacts: readAssets });
  const codeSearchService = new CodeSearchService({ functions });
  const searchReports = new ToolOutputAssets(new ImmutableAssetStore(join(input.artifactRoot, 'tool-output')));
  const webSearchProvider: WebSearchProvider | undefined = input.webSearchProviderConfig
    ? createAgentReachWebSearchProvider(input.webSearchProviderConfig)
    : undefined;
  const webSearchService = webSearchProvider ? new WebSearchService(webSearchProvider) : null;
  const hand = createHandOperationRuntime({
    fileReadRoute: readRoute,
    permissions: {
      async readGrant({ intent }) {
        return { scope: intent.requestedScope, revoked: false, evidenceRefs: [evidence(intent.requestedScope, `${intent.operationId.value}-permission`)] };
      },
    },
    taskBoundaries: {
      async readBoundary({ intent }) {
        return { scope: intent.requestedScope, evidenceRefs: [evidence(intent.requestedScope, `${intent.operationId.value}-boundary`)] };
      },
    },
    journal: new FileOperationJournal(join(input.artifactRoot, 'operation-journal.jsonl')),
  });

  return {
    executor: {
      async execute(request): Promise<ToolExecResult> {
        if (request.signal.aborted) throw Object.assign(new Error('provider tool was stopped before admission'), { name: 'AbortError' });
        switch (request.call.toolId) {
          case RESPONSES_FILE_READ_TOOL.toolId:
            return await executeFileRead(request, { hand, assets: readAssets, workspaceRef });
          case RESPONSES_FILE_LIST_TOOL.toolId:
            return await executeFileList(request, { functions, workspaceRef });
          case RESPONSES_FILE_SEARCH_TOOL.toolId:
            return await executeFileSearch(request, { service: codeSearchService, workspaceRef, assets: searchReports });
          case RESPONSES_FILE_WRITE_TOOL.toolId:
            return await executeFileWrite(request, { workspaceRoot: input.workspaceRoot });
          case RESPONSES_FILE_EDIT_TOOL.toolId:
            return await executeFileEdit(request, { workspaceRoot: input.workspaceRoot });
          case RESPONSES_BASH_TOOL.toolId:
            return await executeBash(request, { workspaceRoot: input.workspaceRoot });
          case RESPONSES_TODO_WRITE_TOOL.toolId:
            return await executeTodoWrite(request, { artifactRoot: input.artifactRoot });
          case RESPONSES_GET_GOAL_TOOL.toolId:
            return await executeGetGoal(request, { artifactRoot: input.artifactRoot });
          case RESPONSES_CREATE_GOAL_TOOL.toolId:
            return await executeCreateGoal(request, { artifactRoot: input.artifactRoot });
          case RESPONSES_UPDATE_GOAL_TOOL.toolId:
            return await executeUpdateGoal(request, { artifactRoot: input.artifactRoot });
          case RESPONSES_PRESENT_TOOL.toolId:
            return await executePresent(request, { workspaceRoot: input.workspaceRoot });
          case RESPONSES_WEB_SEARCH_TOOL.toolId:
            return await executeWebSearch(request, { service: webSearchService, assets: searchReports });
          default:
            throw new Error(
              `provider tool is not registered: ${request.call.toolId}; tools this Harness owns: ${REGISTERED_TOOL_IDS.join(', ')}`,
            );
        }
      },
    },
    searchReports,
  };
}

async function executeFileRead(
  request: ToolExecRequest,
  params: { readonly hand: ReturnType<typeof createHandOperationRuntime>; readonly assets: FileReadAssets; readonly workspaceRef: string },
): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('file.read was stopped before admission'), { name: 'AbortError' });
  const path = request.call.arguments.path;
  if (typeof path !== 'string' || path.trim() === '') throw new Error('file.read requires a non-empty path');
  const cycleId = request.scope.cycleId ?? id('cycle', safeId(`provider-tool-${request.execution.taskId.value}`));
  const operationId = id('operation', safeId(`provider-tool-${request.execution.operationId.value}-${request.call.callId}`));
  const scope: Scope = {
    organId: request.scope.organId,
    taskId: request.execution.taskId,
    cycleId,
    operationId,
  };
  const artifact = await params.assets.writeRequest(request.call.callId, { workspaceRef: params.workspaceRef, path });
  const intent: OperationIntent = {
    operationId,
    taskId: request.execution.taskId,
    cycleId,
    requestedBy: OWNER,
    intentRevision: '1',
    kind: 'inspect',
    toolName: RESPONSES_FILE_READ_TOOL.toolId,
    inputRef: artifact.inputRef,
    inputDigest: artifact.inputDigest,
    requestedScope: scope,
    idempotencyKey: `${request.execution.executionEpoch}:${request.call.callId}`,
    expectedOutput: { schemaRef: 'schema://file.read.report/v1', requiredEvidenceKinds: ['tool'] },
  };
  if (request.signal.aborted) throw Object.assign(new Error('file.read was stopped before admission'), { name: 'AbortError' });
  const result = await params.hand.execute({ intent, signal: request.signal });
  if (request.signal.aborted || result.operation.status === 'cancelled') {
    throw Object.assign(new Error('file.read was stopped'), { name: 'AbortError' });
  }
  if (result.operation.status !== 'succeeded' || !result.operation.result?.outputRef || !result.operation.result.outputDigest) {
    throw new Error(result.operation.failure?.message ?? `file.read ended in ${result.operation.status}`);
  }
  const report = await params.assets.readReport({
    outputRef: result.operation.result.outputRef,
    outputDigest: result.operation.result.outputDigest,
  });
  return {
    output: JSON.stringify(report),
    outputRefs: [result.operation.result.outputRef],
    outputRef: result.operation.result.outputRef,
    outputDigest: result.operation.result.outputDigest,
    evidenceRefs: result.operation.result.evidenceRefs,
  };
}

async function executeFileList(
  request: ToolExecRequest,
  params: { readonly functions: WorkspaceCodeSearchFunctions; readonly workspaceRef: string },
): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('file.list was stopped before admission'), { name: 'AbortError' });
  const args = request.call.arguments;
  const path = args.path;
  if (typeof path !== 'string' || path.trim() === '') throw new Error('file.list requires a non-empty path');
  const maxFiles = typeof args.maxFiles === 'number' && Number.isInteger(args.maxFiles) && args.maxFiles >= 1
    ? Math.min(args.maxFiles, 500)
    : 100;
  const cycleId = request.scope.cycleId ?? id('cycle', safeId(`provider-tool-${request.execution.taskId.value}`));
  const operationId = id('operation', safeId(`provider-tool-${request.execution.operationId.value}-${request.call.callId}`));
  const scope: Scope = {
    organId: request.scope.organId,
    taskId: request.execution.taskId,
    cycleId,
    operationId,
  };
  const discovered = await params.functions.findFiles({
    workspaceRef: params.workspaceRef,
    path,
    maxFiles,
    signal: request.signal,
  });
  const entries = discovered.paths.map((entry) => ({ path: entry, kind: 'file' as const }));
  const report = {
    workspaceRef: params.workspaceRef,
    path,
    entries: entries.length > maxFiles ? entries.slice(0, maxFiles) : entries,
    truncated: discovered.discoveryTruncated === true || entries.length > maxFiles,
    unresolvedPaths: discovered.unresolvedPaths,
  };
  return {
    output: JSON.stringify(report),
    outputRefs: [],
    evidenceRefs: [evidence(scope, 'file-list')],
  };
}

async function executeFileSearch(
  request: ToolExecRequest,
  params: { readonly service: CodeSearchService; readonly workspaceRef: string; readonly assets: ToolOutputAssets },
): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('file.search was stopped before admission'), { name: 'AbortError' });
  const args = request.call.arguments;
  const path = args.path;
  const query = args.query;
  const queryKind = args.queryKind;
  if (typeof path !== 'string' || path.trim() === '') throw new Error('file.search requires a non-empty path');
  if (typeof query !== 'string' || query.trim() === '') throw new Error('file.search requires a non-empty query');
  if (queryKind !== 'literal' && queryKind !== 'regex' && queryKind !== 'symbol') {
    throw new Error('file.search queryKind must be one of: literal, regex, symbol');
  }
  const searchRequest = {
    serviceId: CODE_SEARCH_SERVICE_ID,
    contractVersion: CODE_SEARCH_CONTRACT_VERSION,
    workspaceRef: params.workspaceRef,
    path,
    query,
    queryKind: queryKind as 'literal' | 'regex' | 'symbol',
    contextLines: typeof args.contextLines === 'number' ? args.contextLines : 2,
    maxResults: typeof args.maxResults === 'number' ? args.maxResults : 50,
  };
  const report = await params.service.execute(searchRequest, { signal: request.signal });
  const reportRecord = report as unknown as Record<string, unknown>;
  const rawMatches = Array.isArray(reportRecord.matches) ? (reportRecord.matches as readonly unknown[]) : [];
  const matched = rawMatches.map((match) => {
    const m = match as { path?: string; line?: number; column?: number; text?: string; contextBefore?: readonly string[]; contextAfter?: readonly string[] };
    return {
      path: m.path ?? '',
      line: m.line ?? 0,
      column: m.column ?? 0,
      text: m.text ?? '',
      contextBefore: m.contextBefore ?? [],
      contextAfter: m.contextAfter ?? [],
    };
  });
  const output = {
    serviceId: searchRequest.serviceId,
    status: reportRecord.status,
    workspaceRef: searchRequest.workspaceRef,
    path: searchRequest.path,
    query: searchRequest.query,
    queryKind: searchRequest.queryKind,
    filesDiscovered: reportRecord.filesDiscovered,
    filesSearched: reportRecord.filesSearched,
    matchesFound: reportRecord.matchesFound,
    resultsTruncated: reportRecord.resultsTruncated,
    searchComplete: reportRecord.searchComplete,
    unresolvedPaths: reportRecord.unresolvedPaths ?? [],
    matches: matched,
    summary: `found ${reportRecord.matchesFound ?? 0} matches across ${reportRecord.filesSearched ?? 0} files`,
    ...(reportRecord.failure === undefined ? {} : { failure: reportRecord.failure }),
  };
  const cycleId = request.scope.cycleId ?? id('cycle', safeId(`provider-tool-${request.execution.taskId.value}`));
  const operationId = id('operation', safeId(`provider-tool-${request.execution.operationId.value}-${request.call.callId}`));
  const scope: Scope = {
    organId: request.scope.organId,
    taskId: request.execution.taskId,
    cycleId,
    operationId,
  };
  const descriptor = await params.assets.writeReport({ outputId: operationId.value, report: output });
  return {
    output: JSON.stringify(output),
    outputRefs: [descriptor.outputRef],
    outputRef: descriptor.outputRef,
    outputDigest: descriptor.outputDigest,
    evidenceRefs: [evidence(scope, 'file-search')],
  };
}

async function executeFileWrite(request: ToolExecRequest, params: { readonly workspaceRoot: string }): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('file.write was stopped before admission'), { name: 'AbortError' });
  const args = request.call.arguments;
  const path = args.file_path;
  const content = args.content;
  if (typeof path !== 'string' || path.trim() === '') throw new Error('file.write requires a non-empty file_path');
  if (typeof content !== 'string') throw new Error('file.write requires string content');
  const target = await resolveWorkspacePath(params.workspaceRoot, path);
  const before = await readOptionalWorkspaceFile(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  const result = { path: workspaceRelative(params.workspaceRoot, target), operation: before === null ? 'create' : 'update', before, after: content };
  return { output: JSON.stringify(result), outputRefs: [], evidenceRefs: [taskEvidence(request, 'file-write')] };
}

async function executeFileEdit(request: ToolExecRequest, params: { readonly workspaceRoot: string }): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('file.edit was stopped before admission'), { name: 'AbortError' });
  const args = request.call.arguments;
  const path = args.file_path;
  const oldString = args.old_string;
  const newString = args.new_string;
  if (typeof path !== 'string' || path.trim() === '') throw new Error('file.edit requires a non-empty file_path');
  if (typeof oldString !== 'string' || oldString.length === 0) throw new Error('file.edit requires a non-empty old_string');
  if (typeof newString !== 'string') throw new Error('file.edit requires string new_string');
  if (oldString === newString) throw new Error('file.edit old_string and new_string must differ');
  const target = await resolveWorkspacePath(params.workspaceRoot, path);
  const before = await readRequiredWorkspaceFile(target);
  const count = before.split(oldString).length - 1;
  if (count === 0) throw new Error(`file.edit old_string was not found in ${path}`);
  if (count > 1 && args.replace_all !== true) throw new Error(`file.edit old_string must appear exactly once or set replace_all: ${count} matches`);
  const after = args.replace_all === true ? before.split(oldString).join(newString) : before.replace(oldString, newString);
  await writeFile(target, after, 'utf8');
  const result = { path: workspaceRelative(params.workspaceRoot, target), before, after };
  return { output: JSON.stringify(result), outputRefs: [], evidenceRefs: [taskEvidence(request, 'file-edit')] };
}

async function executeBash(request: ToolExecRequest, params: { readonly workspaceRoot: string }): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('bash was stopped before admission'), { name: 'AbortError' });
  const args = request.call.arguments;
  if (typeof args.command !== 'string' || args.command.trim() === '') throw new Error('bash requires a non-empty command');
  if (typeof args.description !== 'string' || args.description.trim() === '') throw new Error('bash requires a non-empty description');
  const timeoutMs = typeof args.timeoutMs === 'number' && Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
    ? Math.min(args.timeoutMs, 120000)
    : 30000;
  const workdir = await resolveWorkspacePath(params.workspaceRoot, typeof args.workdir === 'string' && args.workdir.trim() !== '' ? args.workdir : '.');
  const command = args.command;
  const result = await new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean; aborted: boolean; stdout: { text: string; truncated: boolean }; stderr: { text: string; truncated: boolean } }>((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { cwd: workdir, env: process.env });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    const appendCapped = (current: string, chunk: string) => {
      let next = current + chunk;
      let truncated = false;
      if (next.length > 64 * 1024) {
        next = next.slice(-64 * 1024);
        truncated = true;
      }
      return { text: next, truncated };
    };
    child.stdout.on('data', (chunk) => {
      const append = appendCapped(stdout, chunk.toString());
      stdout = append.text;
      stdoutTruncated = stdoutTruncated || append.truncated;
    });
    child.stderr.on('data', (chunk) => {
      const append = appendCapped(stderr, chunk.toString());
      stderr = append.text;
      stderrTruncated = stderrTruncated || append.truncated;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    request.signal.addEventListener('abort', () => {
      aborted = true;
      child.kill('SIGTERM');
    }, { once: true });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, timedOut, aborted, stdout: { text: stdout, truncated: stdoutTruncated }, stderr: { text: stderr, truncated: stderrTruncated } });
    });
  });
  return { output: JSON.stringify(result), outputRefs: [], evidenceRefs: [taskEvidence(request, 'bash')] };
}

async function executeTodoWrite(request: ToolExecRequest, params: { readonly artifactRoot: string }): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('todo_write was stopped before admission'), { name: 'AbortError' });
  const rawTodos = request.call.arguments.todos;
  if (!Array.isArray(rawTodos)) throw new Error('todo_write requires an array todos');
  const seen = new Set<string>();
  let active = 0;
  const todos: TodoItem[] = rawTodos.map((entry) => {
    const item = entry as { content?: unknown; status?: unknown };
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    const status = item.status;
    if (content.length === 0) throw new Error('todo_write item content must be a non-empty string');
    if (seen.has(content)) throw new Error(`todo_write duplicate content: ${content}`);
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') throw new Error('todo_write item status must be pending, in_progress, or completed');
    seen.add(content);
    if (status === 'in_progress') active += 1;
    if (active > 1) throw new Error('todo_write allows at most one in_progress item');
    return { content, status };
  });
  const state = await readProviderTaskState(params.artifactRoot, request);
  state.todos = todos;
  await writeProviderTaskState(params.artifactRoot, request, state);
  const counts = { pending: 0, inProgress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status === 'in_progress' ? 'inProgress' : todo.status] += 1;
  return { output: JSON.stringify({ todos, counts }), outputRefs: [], evidenceRefs: [taskEvidence(request, 'todo-write')] };
}

async function executeGetGoal(request: ToolExecRequest, params: { readonly artifactRoot: string }): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('get_goal was stopped before admission'), { name: 'AbortError' });
  const state = await readProviderTaskState(params.artifactRoot, request);
  return { output: JSON.stringify({ goal: state.goal ?? null }), outputRefs: [], evidenceRefs: [taskEvidence(request, 'get-goal')] };
}

async function executeCreateGoal(request: ToolExecRequest, params: { readonly artifactRoot: string }): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('create_goal was stopped before admission'), { name: 'AbortError' });
  const objective = request.call.arguments.objective;
  if (typeof objective !== 'string' || objective.trim() === '') throw new Error('create_goal requires a non-empty objective');
  const state = await readProviderTaskState(params.artifactRoot, request);
  if (state.goal !== undefined && state.goal.phase !== 'complete') throw new Error('create_goal rejected: active goal already exists');
  const budget = request.call.arguments.token_budget;
  state.goal = { id: randomUUID(), revision: 1, objective: objective.trim(), phase: 'active', roundsStarted: 0, maxGoalRounds: typeof budget === 'number' && Number.isInteger(budget) ? budget : undefined };
  await writeProviderTaskState(params.artifactRoot, request, state);
  return { output: JSON.stringify({ goal: state.goal }), outputRefs: [], evidenceRefs: [taskEvidence(request, 'create-goal')] };
}

async function executeUpdateGoal(request: ToolExecRequest, params: { readonly artifactRoot: string }): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('update_goal was stopped before admission'), { name: 'AbortError' });
  const args = request.call.arguments;
  const state = await readProviderTaskState(params.artifactRoot, request);
  if (state.goal === undefined) throw new Error('update_goal requires an existing goal');
  if (args.goal_id !== state.goal.id || args.revision !== state.goal.revision) throw new Error('update_goal goal_id and revision do not match the current goal');
  if (args.action !== 'edit' && args.action !== 'pause' && args.action !== 'resume' && args.action !== 'complete' && args.action !== 'blocked') {
    throw new Error('update_goal action is unsupported');
  }
  const updated: TaskState['goal'] = { ...state.goal, revision: state.goal.revision + 1 };
  if (args.action === 'edit') {
    if (typeof args.objective === 'string' && args.objective.trim() !== '') updated.objective = args.objective.trim();
    if (typeof args.token_budget === 'number' && Number.isInteger(args.token_budget)) updated.maxGoalRounds = args.token_budget;
  } else if (args.action === 'pause') {
    updated.phase = 'paused';
  } else if (args.action === 'resume') {
    updated.phase = 'active';
  } else if (args.action === 'complete') {
    updated.phase = 'complete';
  } else {
    if (typeof args.blocked_reason !== 'string' || args.blocked_reason.trim() === '') throw new Error('update_goal blocked requires blocked_reason');
    updated.phase = 'blocked';
    updated.blockedReason = args.blocked_reason.trim();
  }
  state.goal = updated;
  await writeProviderTaskState(params.artifactRoot, request, state);
  return { output: JSON.stringify({ goal: state.goal }), outputRefs: [], evidenceRefs: [taskEvidence(request, 'update-goal')] };
}

async function executePresent(request: ToolExecRequest, params: { readonly workspaceRoot: string }): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('present was stopped before admission'), { name: 'AbortError' });
  const rawFiles = request.call.arguments.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) throw new Error('present requires a non-empty files array');
  if (rawFiles.length > 8) throw new Error('present accepts at most 8 files');
  const files = rawFiles.map((entry) => {
    const item = entry as { path?: unknown; description?: unknown };
    if (typeof item.path !== 'string' || item.path.trim() === '') throw new Error('present requires a non-empty file path');
    return { path: item.path, ...(typeof item.description === 'string' && item.description.length > 0 ? { description: item.description } : {}) };
  });
  for (const file of files) {
    const target = await resolveWorkspacePath(params.workspaceRoot, file.path);
    await assertRegularWorkspaceFile(target);
  }
  return { output: JSON.stringify({ turn: request.execution.executionEpoch, files }), outputRefs: [], evidenceRefs: [taskEvidence(request, 'present')] };
}

async function executeWebSearch(
  request: ToolExecRequest,
  params: {
    readonly service: WebSearchService | null;
    readonly assets: UiRuntimeToolOutputStore;
  },
): Promise<ToolExecResult> {
  if (!params.service) throw new Error('web.search is not configured for this serve: provider adapter was not injected');
  if (request.signal.aborted) throw Object.assign(new Error('web.search was stopped before admission'), { name: 'AbortError' });
  const args = request.call.arguments;
  if (typeof args.query !== 'string' || args.query.trim() === '') throw new Error('web.search requires a non-empty query');
  const input: WebSearchRequest = {
    serviceId: WEB_SEARCH_SERVICE_ID,
    contractVersion: WEB_SEARCH_CONTRACT_VERSION,
    query: args.query,
    ...(Array.isArray(args.domains) ? { domains: args.domains.filter((domain): domain is string => typeof domain === 'string' && domain.trim() !== '') } : {}),
    ...(typeof args.recency === 'string' ? { recency: args.recency as WebSearchRecency } : {}),
    ...(typeof args.maxResults === 'number' && Number.isInteger(args.maxResults) && args.maxResults > 0
      ? { maxResults: Math.min(args.maxResults, 50) }
      : {}),
    ...(typeof args.requireComplete === 'boolean' ? { requireComplete: args.requireComplete } : {}),
  };
  const report = await params.service.execute(input, { signal: request.signal });
  const outputId = safeId(`provider-tool-web-search-${request.execution.taskId.value}-${request.call.callId}`);
  const { outputRef, outputDigest } = await params.assets.writeReport({ outputId, report });
  const summary = {
    status: report.status,
    resultsFound: report.resultsFound,
    providerPagesFetched: report.providerPagesFetched,
    resultsScope: report.resultsScope,
    searchComplete: report.searchComplete,
    unresolvedSources: report.unresolvedSources,
    summary: report.summary,
  };
  const top = report.results.slice(0, 5).map((result) => ({
    url: result.url,
    title: result.title,
    snippet: result.snippet,
    sourceName: result.sourceName ?? null,
  }));
  const evidenceRefs = [taskEvidence(request, 'web-search')];
  if (report.status === 'succeeded') {
    return {
      output: JSON.stringify({ ...summary, top }),
      outputRefs: [outputRef],
      evidenceRefs,
      status: 'succeeded',
      outputRef,
      outputDigest,
    };
  }
  return {
    output: JSON.stringify({ ...summary, top }),
    outputRefs: [outputRef],
    evidenceRefs,
    status: 'failed',
    outputRef,
    outputDigest,
    error: {
      errorId: `provider-tool-web-search-${request.call.callId}`,
      code: report.failure?.code ?? 'provider-failed',
      category: webSearchErrorCategory(report.failure?.code),
      phase: 'tool',
      message: report.failure?.message ?? report.summary,
      ownerId: OWNER,
      retryable: report.failure?.code === 'provider-unsettled' ? 'manual' : 'retryable',
      attention: 'foreground',
      evidenceRefs,
      nextAction: { kind: 'recover', ref: RESPONSES_WEB_SEARCH_TOOL.toolId },
    },
  };
}

function webSearchErrorCategory(code: string | undefined): 'provider' | 'transport' | 'timeout' | 'validation' | 'runtime' {
  switch (code) {
    case 'provider-unavailable': return 'transport';
    case 'provider-unsettled': return 'timeout';
    case 'invalid-request':
    case 'invalid-result': return 'validation';
    case 'provider-failed': return 'provider';
    default: return 'runtime';
  }
}
