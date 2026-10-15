import { createHash, randomUUID } from 'node:crypto';
import { canonicalJsonStringify } from '../../contracts/src/explicit-brain.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname, join, resolve, sep, relative } from 'node:path';
import {
  CODE_SEARCH_CONTRACT_VERSION,
  CODE_SEARCH_SERVICE_ID,
  fileWriteEffectId,
  id,
  validateCodeSearchReport,
  type EffectExecutionBinding,
  type EvidenceRef,
  type FileWriteEffect,
  type OperationId,
  type OperationIntent,
  type ProviderToolDefinition,
  type ProviderExecutionIdentityRef,
  type Scope,
  type ScopeRef,
  type Sha256Digest,
  type ToolRegistration,
  type WebSearchRequest,
  type WebSearchRecency,
  WEB_SEARCH_SERVICE_ID,
  WEB_SEARCH_CONTRACT_VERSION,
} from '../../contracts/src/index.js';
import { ImmutableAssetStore } from '../../adapters/filesystem/src/index.js';
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
import type {
  OperationChildAdmission,
  OperationControlBinding,
  OperationPermissionPort,
  OperationTaskBoundaryPort,
  OperationExecutorObservation,
} from '../../runtime/src/gateway/ports.js';
import type { JournalCommitRef } from '../../contracts/src/i2-history.js';
import type { ToolExecutionGateway } from '../../runtime/src/gateway/index.js';
import { OperationCompletionOwner } from '../../runtime/src/gateway/operation-completion.js';
import type { JsonlOrganJournal } from '../../adapters/jsonl/src/index.js';
import { JsonlOperationCompletionJournal } from '../../adapters/jsonl/src/operation-completion.js';
import { createJsonlOperationControlJournal } from './operation-control-journal.js';
import { createProviderToolGateway } from './tool-execution-gateway.js';

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
  /** Persist exact delivered bytes and return an immutable artifact descriptor
   *  distinct from any tool report descriptor. */
  writeArtifact(input: { readonly outputId: string; readonly bytes: Uint8Array }): Promise<{ readonly assetRef: string; readonly digest: string; readonly size: number }>;
  /** Resolve the exact delivered bytes from the immutable descriptor alone, so
   *  the read never follows the mutable workspace path. */
  readArtifact(input: { readonly assetRef: string; readonly digest: string }): Promise<Uint8Array>;
}

/**
 * The exact provider-tool report store the admitted executor writes. The UI
 * readback route binds this same store so a tool result descriptor resolves
 * against the physical report bytes without a process-local index.
 */
export function createProviderToolOutputStore(artifactRoot: string): UiRuntimeToolOutputStore {
  return new ToolOutputAssets(new ImmutableAssetStore(join(artifactRoot, 'tool-output')));
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function digest(value: string): Sha256Digest {
  return digestBytes(new TextEncoder().encode(value));
}

function requireSha256Digest(value: string, label: string): Sha256Digest {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a sha256 digest`);
  return value as Sha256Digest;
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
    operationId: request.scope.operationId ?? id('operation', safeId(`provider-tool-${request.execution.operationId.value}-${request.call.callId}`)),
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

/** Per-file bound on material handed to the reviewer. */
const PRODUCED_ARTIFACT_MAX_FILE_BYTES = 262_144;
/** Whole-artifact bound so one execution cannot consume the review prompt. */
const PRODUCED_ARTIFACT_MAX_TOTAL_BYTES = 1_048_576;

/**
 * Read back the files an execution wrote so the quality reviewer is handed the
 * artifact itself. Paths use the same workspace rule the file tools use, and a
 * path that cannot be read is reported in the body rather than dropped, so a
 * missing artifact is visible to the reviewer instead of silently absent.
 */
export async function readProducedArtifacts(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const path of paths) {
    if (total >= PRODUCED_ARTIFACT_MAX_TOTAL_BYTES) {
      files.push({ path, content: '[omitted: review material size bound reached]' });
      continue;
    }
    let target: string;
    try {
      target = await resolveWorkspacePath(workspaceRoot, path);
    } catch (cause) {
      files.push({ path, content: `[unreadable: ${cause instanceof Error ? cause.message : 'path rejected'}]` });
      continue;
    }
    let content: string;
    try {
      content = await readFile(target, 'utf8');
    } catch (cause) {
      files.push({ path, content: `[unreadable: ${cause instanceof Error ? cause.message : 'read failed'}]` });
      continue;
    }
    const limit = Math.min(PRODUCED_ARTIFACT_MAX_FILE_BYTES, PRODUCED_ARTIFACT_MAX_TOTAL_BYTES - total);
    const byteLength = new TextEncoder().encode(content).length;
    if (byteLength > limit) content = `${utf8Prefix(content, limit)}\n[truncated at ${limit} bytes]`;
    total += Math.min(byteLength, limit);
    files.push({ path, content });
  }
  return files;
}

/**
 * Cut UTF-8 content at a byte bound. `String.prototype.slice` counts UTF-16 code
 * units, so slicing the decoded string could emit more bytes than the bound it
 * reports; cut the encoded bytes instead and back off any split multi-byte
 * sequence so the bound and its label always agree.
 */
function utf8Prefix(content: string, limit: number): string {
  const bytes = new TextEncoder().encode(content).slice(0, limit);
  for (let end = bytes.length; end > 0; end -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, end));
    } catch {
      continue;
    }
  }
  return '';
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

/**
 * Immutable report store behind every succeeded provider tool result. Both the
 * producer and the task-scoped readback route share one instance, and the report
 * is located from the descriptor alone, so a runtime restart that replays the
 * event still resolves the persisted bytes instead of a process-local index.
 */
class ToolOutputAssets implements UiRuntimeToolOutputStore {
  readonly store: ImmutableAssetStore;

  constructor(store: ImmutableAssetStore) {
    this.store = store;
  }

  async writeReport(input: { readonly outputId: string; readonly report: unknown }): Promise<{ readonly outputRef: string; readonly outputDigest: string }> {
    const content = JSON.stringify(input.report);
    const reference = await this.store.write(reportAssetId(input.outputId, digest(content)), new TextEncoder().encode(content));
    return { outputRef: reportOutputRef(input.outputId), outputDigest: reference.digest };
  }

  async readReport(input: { readonly outputRef: string; readonly outputDigest: string }): Promise<unknown> {
    const outputId = outputIdFromRef(input.outputRef);
    if (outputId === undefined) throw new Error('tool output report reference is not a provider tool output');
    const data = await this.store.readByDigest(reportAssetId(outputId, input.outputDigest), input.outputDigest);
    return JSON.parse(new TextDecoder().decode(data)) as unknown;
  }

  async writeArtifact(input: { readonly outputId: string; readonly bytes: Uint8Array }): Promise<{ readonly assetRef: string; readonly digest: string; readonly size: number }> {
    const reference = await this.store.write(artifactAssetId(input.outputId, digestBytes(input.bytes)), input.bytes);
    return { assetRef: artifactOutputRef(input.outputId), digest: reference.digest, size: reference.size };
  }

  async readArtifact(input: { readonly assetRef: string; readonly digest: string }): Promise<Uint8Array> {
    const outputId = outputIdFromArtifactRef(input.assetRef);
    if (outputId === undefined) throw new Error('tool artifact reference is not a provider tool artifact');
    return this.store.readByDigest(artifactAssetId(outputId, input.digest), input.digest);
  }
}

function reportOutputRef(outputId: string): string {
  return `asset://provider-tool/output/${encodeURIComponent(outputId)}`;
}

/**
 * The asset id is derived from the descriptor (output id + content digest), so
 * the readback route can resolve a report without any in-process bookkeeping.
 */
function reportAssetId(outputId: string, contentDigest: string): string {
  return safeId(`provider-tool-output-${outputId}-${contentDigest.slice(-12)}`);
}

function outputIdFromRef(outputRef: string): string | undefined {
  const prefix = 'asset://provider-tool/output/';
  if (!outputRef.startsWith(prefix)) return undefined;
  return decodeURIComponent(outputRef.slice(prefix.length));
}

function artifactOutputRef(outputId: string): string {
  return `asset://provider-tool/artifact/${encodeURIComponent(outputId)}`;
}

function artifactAssetId(outputId: string, contentDigest: string): string {
  return safeId(`provider-tool-artifact-${outputId}-${contentDigest.slice(-12)}`);
}

function outputIdFromArtifactRef(artifactRef: string): string | undefined {
  const prefix = 'asset://provider-tool/artifact/';
  if (!artifactRef.startsWith(prefix)) return undefined;
  return decodeURIComponent(artifactRef.slice(prefix.length));
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

type ToolExecRequest = Parameters<ProviderToolExecutionPort['execute']>[0];
type ToolExecResult = ProviderToolExecutionPort['execute'] extends (input: infer _I) => Promise<infer R> ? R : never;

interface FileWriteCompletionContext {
  readonly binding: EffectExecutionBinding;
  readonly inputDigest: Sha256Digest;
  readonly completion: OperationCompletionOwner;
  readonly now: () => Date;
}

/**
 * A file.write error after its durable intent may have left an effect behind.
 * The Gateway must reconcile that exact child operation instead of treating it
 * as a clean pre-effect failure.
 */
class FileWriteEffectUncertainError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'FileWriteEffectUncertainError';
    if (cause !== undefined) Object.assign(this, { cause });
  }
}

/**
 * Every advertised tool's existing IO adapter, keyed by tool id. The Gateway
 * registers these handlers before any effect; each function stays a plain IO
 * adapter and never becomes a lifecycle owner.
 */
interface ProviderToolIo {
  readonly workspaceRef: string;
  readonly workspaceRoot: string;
  readonly artifactRoot: string;
  readonly functions: WorkspaceCodeSearchFunctions;
  readonly readRoute: FileReadRoute;
  readonly codeSearchService: CodeSearchService;
  readonly webSearchService: WebSearchService | null;
  readonly toolOutputs: ToolOutputAssets;
  readonly readAssets: FileReadAssets;
}
/** Tool ids this executor owns; surfaced to the provider when it calls a tool
 *  this Harness does not own (for example a backend harness tool such as
 *  `exec_command`) so the model can retry with an owned tool. */
const ADVERTISED_TOOL_IDS: readonly string[] = [
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

/** Gateway registrations for the advertised provider tools. Registration is a
 *  declaration only: the Gateway still owns admission, lifecycle, coverage and
 *  settlement, and each handler stays an IO adapter. */
function mutates(toolId: string): boolean {
  return ['file.write', 'file.edit', 'bash', 'todo_write', 'create_goal', 'update_goal'].includes(toolId);
}

function providerToolRegistrations(): ToolRegistration[] {
  return ADVERTISED_TOOL_IDS.map((toolId) => ({
    toolName: toolId,
    contractVersion: '1.0.0',
    supportedKinds: [mutates(toolId) ? 'apply' as const : 'inspect' as const],
    routeId: `provider-tool-${toolId}`,
    routeVersion: 'provider-tool.v1',
    mode: 'gateway' as const,
    acceptedScopes: [{}],
    inputContract: `schema://provider-tool/${toolId}.request/v1`,
    outputContract: `schema://provider-tool/${toolId}.report/v1`,
    verifier: `verifier://provider-tool/${toolId}/v1`,
    capabilities: ['io'],
    retryPolicy: mutates(toolId) ? 'retry://explicit-reconciliation/v1' : 'retry://read-only/v1',
    owner: OWNER,
  }));
}

/** Actual new-task admission provenance. A tool effect can never fabricate
 *  this: the Organ Journal, the parent Harness epoch and the admitted runtime
 *  identity come from the real caller. */
export interface ProviderToolAdmissionInput {
  /** Same-Organ Journal that already owns this task's durable history. */
  readonly organJournal: JsonlOrganJournal;
  /** Caller adapter over TaskGrantPort/projectTaskGrantAuthority for this principal. */
  readonly currentTaskGrantPort: OperationPermissionPort;
  readonly principalOwner: string;
  readonly resourceBoundary: OperationTaskBoundaryPort;
  readonly bindingFor: (request: ToolExecRequest) => Promise<OperationControlBinding>;
  /**
   * Thin child route. A registered child operation has its own execution and
   * scope, but its tool effects join the admitted parent namespace. When this
   * seam returns a match, the request is a real child tool call and the
   * returned parent binding is used; the parent's own identity assertion does
   * not apply. Returning `null` keeps the unchanged parent route.
   */
  readonly childBindingFor?: (request: ToolExecRequest) => Promise<{
    readonly execution: ProviderExecutionIdentityRef;
    readonly scope: ScopeRef;
    readonly binding: OperationControlBinding;
  } | null>;
  /**
   * Actual explicit child admission seam. It registers the child business fact
   * with typed Provider request/tool-call provenance and returns the separate
   * authority, business-registration and coverage receipts the Gateway needs.
   */
  readonly admitToolOperation: (input: {
    readonly binding: OperationControlBinding;
    readonly intent: OperationIntent;
    readonly registration: ToolRegistration;
    readonly providerRequestId: string;
    readonly toolCallId: string;
  }) => Promise<{
    readonly authorityCommitRef: JournalCommitRef;
    readonly businessRegistrationCommitRef: JournalCommitRef;
    readonly coverageCommitRef: JournalCommitRef;
    readonly childAdmission: OperationChildAdmission;
  }>;
  readonly now: () => Date;
}

export function createResponsesFileToolExecutor(input: {
  readonly workspaceRoot: string;
  readonly projectKey: string;
  readonly artifactRoot: string;
  readonly webSearchProviderConfig?: WebSearchProviderBackendConfig;
  readonly admission?: ProviderToolAdmissionInput;
}): {
  readonly executor: ResponsesFileToolExecutor;
  readonly toolOutputs: UiRuntimeToolOutputStore;
  readonly operationControl?: ToolExecutionGateway;
} {
  const workspaceRef = `workspace:${input.projectKey}`;
  const functions = new WorkspaceCodeSearchFunctions({ workspaceRef, workspaceRoot: input.workspaceRoot });
  // One report store owns every provider tool report, so the task-scoped
  // readback route can resolve a file.read report exactly like a file.search or
  // web.search report instead of only the store it happens to be bound to.
  const toolOutputs = new ToolOutputAssets(new ImmutableAssetStore(join(input.artifactRoot, 'tool-output')));
  const readAssets = new FileReadAssets(toolOutputs);
  const readRoute = new FileReadRoute({ functions, artifacts: readAssets });
  const codeSearchService = new CodeSearchService({ functions });
  const webSearchProvider: WebSearchProvider | undefined = input.webSearchProviderConfig
    ? createAgentReachWebSearchProvider(input.webSearchProviderConfig)
    : undefined;
  const webSearchService = webSearchProvider ? new WebSearchService(webSearchProvider) : null;
  const toolIo: ProviderToolIo = {
    workspaceRef,
    workspaceRoot: input.workspaceRoot,
    artifactRoot: input.artifactRoot,
    functions,
    readRoute,
    codeSearchService,
    webSearchService,
    toolOutputs,
    readAssets,
  };
  const pending = new Map<string, {
    readonly request: ToolExecRequest;
    readonly controller: AbortController;
    result?: ToolExecResult;
    settled?: Promise<OperationExecutorObservation>;
  }>();
  const admission = input.admission;
  const completion = admission === undefined
    ? undefined
    : new OperationCompletionOwner(new JsonlOperationCompletionJournal({ journal: admission.organJournal }));
  const registrations = providerToolRegistrations();
  const registrationByTool = new Map(registrations.map((registration) => [registration.toolName, registration]));
  const gateway = admission ? createProviderToolGateway({
    registrations,
    permissions: admission.currentTaskGrantPort,
    taskBoundaries: admission.resourceBoundary,
    journal: createJsonlOperationControlJournal({ journal: admission.organJournal }),
    now: admission.now,
    executor: {
      async execute({ intent, lease }) {
        const call = pending.get(intent.operationId.value);
        if (!call) throw new Error('provider tool IO request is unavailable; cold control reads never replay an effect');
        call.settled = (async (): Promise<OperationExecutorObservation> => {
          try {
            let completionContext: FileWriteCompletionContext | undefined;
            if (intent.toolName === RESPONSES_FILE_WRITE_TOOL.toolId) {
              if (completion === undefined) throw new Error('file.write completion owner is missing');
              completionContext = fileWriteCompletionContext(call.request, intent, completion, admission.now);
            }
            const result = await executeRawTool(
              { ...call.request, scope: intent.requestedScope, signal: call.controller.signal },
              toolIo,
              completionContext,
            );
            call.result = result;
            const descriptor = result.outputRef && result.outputDigest
              ? { outputRef: result.outputRef, outputDigest: result.outputDigest }
              : await toolOutputs.writeReport({ outputId: intent.operationId.value, report: JSON.parse(result.output) });
            const bashResult: unknown = intent.toolName === 'bash' ? JSON.parse(result.output) : undefined;
            const bashInterrupted = bashResult !== null && typeof bashResult === 'object'
              && ('timedOut' in bashResult && bashResult.timedOut === true || 'aborted' in bashResult && bashResult.aborted === true);
            const uncertain = mutates(intent.toolName) && (call.controller.signal.aborted || bashInterrupted);
            return {
              executionEpoch: lease.executionEpoch,
              status: uncertain ? 'reconcile_required' : 'completed',
              ...descriptor,
              owner: OWNER,
              sideEffectState: uncertain ? 'possible' : mutates(intent.toolName) ? 'confirmed' : 'none',
              evidenceRefs: result.evidenceRefs,
              ...(uncertain ? { message: 'tool settled after stop; admitted effects require reconciliation' } : {}),
            };
          } catch (error) {
            if (!mutates(intent.toolName)) throw error;
            if (intent.toolName === RESPONSES_FILE_WRITE_TOOL.toolId
              && !(error instanceof FileWriteEffectUncertainError)) {
              throw error;
            }
            // A mutation exception does not prove the write/spawn never happened.
            return {
              executionEpoch: lease.executionEpoch,
              status: 'reconcile_required',
              owner: OWNER,
              sideEffectState: 'possible',
              evidenceRefs: [evidence(intent.requestedScope, 'provider-tool-effect-unknown')],
              message: error instanceof Error ? error.message : 'provider tool mutation failed',
            };
          }
        })();
        return await call.settled;
      },
    },
    verifier: {
      async verify({ intent, observation }) {
        const call = pending.get(intent.operationId.value);
        return {
          executionEpoch: observation.executionEpoch,
          accepted: call?.result !== undefined && call.result.status !== 'failed',
          decision: call?.result?.status === 'failed' ? 'provider tool reported failure' : 'provider tool IO settled with report',
          evidenceRefs: observation.evidenceRefs,
        };
      },
    },
    stopSettlement: {
      async settle({ intent, executionEpoch, owner, lease }) {
        const call = pending.get(intent.operationId.value);
        call?.controller.abort();
        const observation = await call?.settled;
        return {
          receiptId: `provider-tool-stop-${intent.operationId.value}-${executionEpoch}`,
          operationId: intent.operationId,
          taskId: intent.taskId,
          executionEpoch,
          owner,
          ...(lease ? { leaseId: lease.leaseId } : {}),
          stopped: call !== undefined,
          sideEffectState: observation?.sideEffectState ?? (mutates(intent.toolName) && lease ? 'possible' : 'none'),
          evidenceRefs: observation?.evidenceRefs ?? [evidence(intent.requestedScope, 'provider-tool-stop')],
        };
      },
    },
  }) : undefined;

  return {
    executor: {
      async execute(request): Promise<ToolExecResult> {
        if (request.signal.aborted) throw Object.assign(new Error('provider tool was stopped before admission'), { name: 'AbortError' });
        if (!ADVERTISED_TOOL_IDS.includes(request.call.toolId)) {
          throw new Error(
            `provider tool is not registered: ${request.call.toolId}; tools this Harness owns: ${ADVERTISED_TOOL_IDS.join(', ')}`,
          );
        }
        if (!admission || !gateway) throw new Error('provider tool control source is missing: same Journal, current task grant, principal, resource boundary, admission binding and clock are required');
        if (!admission.principalOwner.trim()) throw new Error('provider tool verified principal is missing');
        if (typeof request.requestId !== 'string' || request.requestId.trim().length === 0) {
          throw new Error('provider tool execution requires the actual typed Provider request id');
        }
        const registration = registrationByTool.get(request.call.toolId);
        if (!registration) throw new Error(`provider tool is not registered: ${request.call.toolId}`);
        // A registered child operation owns a child execution and scope while
        // its tool effect joins the admitted parent namespace. Only the real
        // child route may supply that parent binding, and it must describe this
        // exact request; otherwise the parent's own identity binding applies.
        const childRoute = admission.childBindingFor === undefined
          ? null : await admission.childBindingFor(request);
        let binding: OperationControlBinding;
        if (childRoute) {
          if (canonicalJsonStringify(childRoute.execution) !== canonicalJsonStringify(request.execution)
            || canonicalJsonStringify(childRoute.scope) !== canonicalJsonStringify(request.scope)) {
            throw new Error('child provider tool binding does not match the actual child execution');
          }
          binding = childRoute.binding;
        } else {
          binding = await admission.bindingFor(request);
          if (binding.agentRuntimeId !== request.execution.runtimeId
            || binding.harnessExecutionEpoch !== request.execution.executionEpoch
            || canonicalJsonStringify(binding.parentOperationId) !== canonicalJsonStringify(request.execution.operationId)
            || canonicalJsonStringify(binding.scope.taskId) !== canonicalJsonStringify(request.execution.taskId)
            || canonicalJsonStringify(binding.scope.operationId) !== canonicalJsonStringify(request.execution.operationId)
            || canonicalJsonStringify(binding.scope) !== canonicalJsonStringify(request.scope)) {
            throw new Error('provider tool admission binding does not match the actual execution');
          }
        }
        const control = await gateway.readControl(binding);
        if (control.state !== 'complete') throw new Error(`provider tool operation control source is unknown: ${control.reason}`);
        const intent = toolIntent(request, binding);
        if (pending.has(intent.operationId.value)) throw new Error('provider tool call is already executing');
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) controller.abort();
        const call = { request, controller };
        pending.set(intent.operationId.value, call);
        try {
          const child = await admission.admitToolOperation({
            binding,
            intent,
            registration,
            providerRequestId: request.requestId,
            toolCallId: request.call.callId,
          });
          await gateway.submit(intent, binding, child.childAdmission);
          if (controller.signal.aborted) {
            await gateway.requestCancel(intent.operationId);
            await gateway.settleCancellation(intent.operationId);
            throw Object.assign(new Error('provider tool was stopped before execution'), { name: 'AbortError' });
          }
          const result = await gateway.execute(intent.operationId);
          const output = pending.get(intent.operationId.value)?.result;
          if (result.status === 'failed' && output?.status === 'failed') return output;
          if (result.status !== 'succeeded' || !output) throw new Error(result.failure?.message ?? result.reconcile?.reason ?? `provider tool ended in ${result.status}`);
          // The gateway operation completed succeeded; the result envelope must
          // carry that typed terminal status like every sibling executor
          // (standard-turn-end, child producer, web.search) instead of leaving
          // the optional field unset.
          return { ...output, status: 'succeeded' };
        } finally {
          request.signal.removeEventListener('abort', abort);
          pending.delete(intent.operationId.value);
        }
      },
    },
    toolOutputs,
    ...(gateway ? { operationControl: gateway } : {}),
  };
}

function toolIntent(request: ToolExecRequest, binding: OperationControlBinding): OperationIntent {
  const cycleId = request.scope.cycleId;
  if (!cycleId) throw new Error('provider tool current cycle scope is missing');
  const operationId = id('operation', safeId(`provider-tool-${request.execution.operationId.value}-${request.call.callId}`));
  return {
    operationId,
    taskId: request.execution.taskId,
    cycleId,
    requestedBy: OWNER,
    intentRevision: '1',
    kind: mutates(request.call.toolId) ? 'apply' : 'inspect',
    toolName: request.call.toolId,
    inputRef: `provider-tool-call:${encodeURIComponent(request.call.callId)}`,
    inputDigest: digest(JSON.stringify(request.call.arguments)),
    requestedScope: { ...binding.scope, cycleId, operationId },
    idempotencyKey: `${request.execution.executionEpoch}:${request.call.callId}`,
    expectedOutput: { schemaRef: `schema://provider-tool/${request.call.toolId}.report/v1`, requiredEvidenceKinds: ['tool'] },
  };
}

function fileWriteCompletionContext(
  request: ToolExecRequest,
  intent: OperationIntent,
  completion: OperationCompletionOwner,
  now: () => Date,
): FileWriteCompletionContext {
  const requestId = request.requestId;
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new Error('file.write requires the actual typed Provider request id');
  }
  const callId = request.call.callId;
  if (typeof callId !== 'string' || callId.trim().length === 0) {
    throw new Error('file.write requires the actual Provider tool call id');
  }
  const continuationRef = request.call.continuationRef;
  if (typeof continuationRef !== 'string' || continuationRef.trim().length === 0) {
    throw new Error('file.write requires the codec-produced continuation ref');
  }
  const scope = intent.requestedScope;
  if (scope.taskId === undefined || scope.cycleId === undefined || scope.operationId === undefined) {
    throw new Error('file.write child intent has no complete effect scope');
  }
  if (scope.operationId.value !== intent.operationId.value
    || scope.taskId.value !== intent.taskId.value
    || scope.cycleId.value !== intent.cycleId.value) {
    throw new Error('file.write child intent scope does not match the admitted operation');
  }
  if (request.execution.operationId.value === intent.operationId.value) {
    throw new Error('file.write tool operation must differ from the parent execution operation');
  }
  const expectedInputDigest = digest(JSON.stringify(request.call.arguments));
  if (intent.inputDigest !== expectedInputDigest) {
    throw new Error('file.write admitted input digest does not match the typed Provider call');
  }
  return {
    binding: {
      execution: request.execution,
      scope,
      toolOperationId: intent.operationId,
      requestId,
      callId,
      continuationRef,
    },
    inputDigest: requireSha256Digest(intent.inputDigest, 'file.write input digest'),
    completion,
    now,
  };
}

async function executeRawTool(
  request: ToolExecRequest,
  io: ProviderToolIo,
  fileWriteCompletion?: FileWriteCompletionContext,
): Promise<ToolExecResult> {
  switch (request.call.toolId) {
    case 'file.read': return executeFileRead(request, { route: io.readRoute, assets: io.readAssets, workspaceRef: io.workspaceRef });
    case 'file.list': return executeFileList(request, { functions: io.functions, workspaceRef: io.workspaceRef });
    case 'file.search': return executeFileSearch(request, { service: io.codeSearchService, workspaceRef: io.workspaceRef, assets: io.toolOutputs });
    case 'file.write': {
      if (fileWriteCompletion === undefined) throw new Error('file.write requires the admitted completion context');
      return executeFileWrite(request, {
        workspaceRef: io.workspaceRef,
        workspaceRoot: io.workspaceRoot,
        toolOutputs: io.toolOutputs,
      }, fileWriteCompletion);
    }
    case 'file.edit': return executeFileEdit(request, io);
    case 'bash': return executeBash(request, io);
    case 'todo_write': return executeTodoWrite(request, io);
    case 'get_goal': return executeGetGoal(request, io);
    case 'create_goal': return executeCreateGoal(request, io);
    case 'update_goal': return executeUpdateGoal(request, io);
    case 'present': return executePresent(request, io);
    case 'web.search': return executeWebSearch(request, { service: io.webSearchService, assets: io.toolOutputs });
    default: throw new Error(`provider tool is not registered: ${request.call.toolId}`);
  }
}

async function executeFileRead(
  request: ToolExecRequest,
  params: { readonly route: FileReadRoute; readonly assets: FileReadAssets; readonly workspaceRef: string },
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
  const observation = await params.route.execute({ intent, effectiveScope: scope, executionEpoch: request.execution.executionEpoch });
  const result = await params.route.verify({ intent, effectiveScope: scope, observation });
  if (request.signal.aborted) {
    throw Object.assign(new Error('file.read was stopped'), { name: 'AbortError' });
  }
  if (result.status !== 'succeeded' || !observation.outputRef || !observation.outputDigest) {
    throw new Error(result.failure?.message ?? `file.read ended in ${result.status}`);
  }
  const report = await params.assets.readReport({
    outputRef: observation.outputRef,
    outputDigest: observation.outputDigest,
  });
  return {
    output: JSON.stringify(report),
    outputRefs: [observation.outputRef],
    outputRef: observation.outputRef,
    outputDigest: observation.outputDigest,
    evidenceRefs: result.evidenceRefs,
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
  validateCodeSearchReport(report);
  const cycleId = request.scope.cycleId ?? id('cycle', safeId(`provider-tool-${request.execution.taskId.value}`));
  const operationId = id('operation', safeId(`provider-tool-${request.execution.operationId.value}-${request.call.callId}`));
  const scope: Scope = {
    organId: request.scope.organId,
    taskId: request.execution.taskId,
    cycleId,
    operationId,
  };
  const descriptor = await params.assets.writeReport({ outputId: operationId.value, report });
  return {
    output: JSON.stringify(report),
    outputRefs: [descriptor.outputRef],
    outputRef: descriptor.outputRef,
    outputDigest: descriptor.outputDigest,
    executorRoute: 'app.file-search.local',
    evidenceRefs: [evidence(scope, 'file-search')],
  };
}

async function executeFileWrite(
  request: ToolExecRequest,
  params: {
    readonly workspaceRef: string;
    readonly workspaceRoot: string;
    readonly toolOutputs: ToolOutputAssets;
  },
  context: FileWriteCompletionContext,
): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('file.write was stopped before admission'), { name: 'AbortError' });
  const args = request.call.arguments;
  const path = args.file_path;
  const content = args.content;
  if (typeof path !== 'string' || path.trim() === '') throw new Error('file.write requires a non-empty file_path');
  if (typeof content !== 'string') throw new Error('file.write requires string content');
  if (context.inputDigest !== digest(JSON.stringify(args))) {
    throw new Error('file.write admitted input digest does not match the actual typed request');
  }
  const target = await resolveWorkspacePath(params.workspaceRoot, path);
  const before = await readOptionalWorkspaceFile(target);
  const relativePath = workspaceRelative(params.workspaceRoot, target);
  const effect: FileWriteEffect = {
    kind: 'file.write',
    effectId: await fileWriteEffectId(context.binding),
    workspaceRef: params.workspaceRef,
    relativePath,
    inputDigest: context.inputDigest,
    expectedContentDigest: digestBytes(new TextEncoder().encode(content)),
  };
  await context.completion.begin(context.binding, effect);
  if (request.signal.aborted) {
    throw new FileWriteEffectUncertainError('file.write was stopped after durable intent; the effect requires reconciliation');
  }
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    const observedContentDigest = digestBytes(await readFile(target));
    if (observedContentDigest !== effect.expectedContentDigest) {
      throw new Error('file.write readback digest does not match the requested content');
    }
    const result = { path: relativePath, operation: before === null ? 'create' : 'update', before, after: content };
    const descriptor = await params.toolOutputs.writeReport({ outputId: context.binding.toolOperationId.value, report: result });
    const evidenceRefs = [taskEvidence(request, 'file-write')];
    await context.completion.commit(context.binding, effect, observedContentDigest, {
      operationId: context.binding.toolOperationId,
      status: 'succeeded',
      outputRef: descriptor.outputRef,
      outputDigest: requireSha256Digest(descriptor.outputDigest, 'file.write output digest'),
      evidenceRefs,
      verifier: {
        name: 'file-write-readback',
        version: '1',
        decision: 'actual target bytes matched the requested content digest',
      },
      completedAt: context.now().toISOString(),
    });
    return {
      output: JSON.stringify(result),
      outputRefs: [descriptor.outputRef],
      outputRef: descriptor.outputRef,
      outputDigest: descriptor.outputDigest,
      evidenceRefs,
    };
  } catch (error) {
    if (error instanceof FileWriteEffectUncertainError) throw error;
    throw new FileWriteEffectUncertainError(
      `file.write failed after durable intent: ${error instanceof Error ? error.message : 'unknown error'}`,
      error,
    );
  }
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
    const abort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    child.on('error', (error) => {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
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

async function executePresent(
  request: ToolExecRequest,
  params: { readonly workspaceRoot: string; readonly toolOutputs: UiRuntimeToolOutputStore },
): Promise<ToolExecResult> {
  if (request.signal.aborted) throw Object.assign(new Error('present was stopped before admission'), { name: 'AbortError' });
  const rawFiles = request.call.arguments.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) throw new Error('present requires a non-empty files array');
  if (rawFiles.length > 8) throw new Error('present accepts at most 8 files');
  const files = rawFiles.map((entry) => {
    const item = entry as { path?: unknown; description?: unknown };
    if (typeof item.path !== 'string' || item.path.trim() === '') throw new Error('present requires a non-empty file path');
    return { path: item.path, ...(typeof item.description === 'string' && item.description.length > 0 ? { description: item.description } : {}) };
  });
  // Deliver the file bytes into the shared immutable store; the report below
  // only describes the immutable descriptors, never the mutable workspace path.
  const presentOutputId = safeId(`provider-tool-present-${request.execution.taskId.value}-${request.call.callId}`);
  const artifacts: { readonly path: string; readonly assetRef: string; readonly digest: string; readonly size: number }[] = [];
  for (const [index, file] of files.entries()) {
    const target = await resolveWorkspacePath(params.workspaceRoot, file.path);
    await assertRegularWorkspaceFile(target);
    const bytes = new Uint8Array(await readFile(target));
    const descriptor = await params.toolOutputs.writeArtifact({ outputId: `${presentOutputId}-${index}`, bytes });
    artifacts.push({ path: file.path, ...descriptor });
  }
  return {
    output: JSON.stringify({ turn: request.execution.executionEpoch, files, artifacts }),
    outputRefs: artifacts.map((artifact) => artifact.assetRef),
    evidenceRefs: [taskEvidence(request, 'present')],
  };
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
