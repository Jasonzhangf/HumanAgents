import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  id,
  type EvidenceRef,
  type OperationEvent,
  type OperationId,
  type OperationIntent,
  type ProviderToolDefinition,
  type Scope,
} from '../../contracts/src/index.js';
import { ImmutableAssetStore, type AssetReference } from '../../adapters/filesystem/src/index.js';
import {
  FileReadRoute,
  WorkspaceCodeSearchFunctions,
  type FileReadArtifactStore,
  type FileReadReport,
  type FileReadRequest,
} from '../../adapters/operations/src/index.js';
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

export interface ResponsesFileToolExecutor extends ProviderToolExecutionPort {}

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
    locator: `provider-tool://file.read/${encodeURIComponent(label)}`,
    scope,
  };
}

class FileReadAssets implements FileReadArtifactStore {
  private readonly requests = new Map<string, { readonly digest: string; readonly request: FileReadRequest }>();
  private readonly reports = new Map<string, AssetReference>();

  constructor(private readonly store: ImmutableAssetStore) {}

  async writeRequest(callId: string, request: FileReadRequest): Promise<{ readonly inputRef: string; readonly inputDigest: string }> {
    const content = JSON.stringify(request);
    const inputDigest = digest(content);
    const inputRef = `asset://provider-tool/input/${encodeURIComponent(callId)}`;
    this.requests.set(inputRef, { digest: inputDigest, request });
    await this.store.write(safeId(`provider-tool-input-${callId}-${inputDigest.slice(-12)}`), new TextEncoder().encode(content));
    return { inputRef, inputDigest };
  }

  async readRequest(input: { readonly inputRef: string; readonly inputDigest: string }): Promise<FileReadRequest> {
    const stored = this.requests.get(input.inputRef);
    if (!stored || stored.digest !== input.inputDigest) throw new Error('file read request artifact is missing or changed');
    return stored.request;
  }

  async writeReport(input: { readonly operationId: OperationId; readonly report: FileReadReport }): Promise<{ readonly outputRef: string; readonly outputDigest: string }> {
    const content = JSON.stringify(input.report);
    const reference = await this.store.write(
      safeId(`provider-tool-output-${input.operationId.value}-${digest(content).slice(-12)}`),
      new TextEncoder().encode(content),
    );
    const outputRef = `asset://provider-tool/output/${encodeURIComponent(input.operationId.value)}`;
    this.reports.set(outputRef, reference);
    return { outputRef, outputDigest: reference.digest };
  }

  async readReport(input: { readonly outputRef: string; readonly outputDigest: string }): Promise<FileReadReport> {
    const reference = this.reports.get(input.outputRef);
    if (!reference || reference.digest !== input.outputDigest) throw new Error('file read report artifact is missing or changed');
    return JSON.parse(new TextDecoder().decode(await this.store.read(reference))) as FileReadReport;
  }
}

class FileOperationJournal implements OperationJournalPort {
  constructor(private readonly filePath: string) {}

  async commit(event: OperationEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

export function createResponsesFileToolExecutor(input: {
  readonly workspaceRoot: string;
  readonly projectKey: string;
  readonly artifactRoot: string;
}): ResponsesFileToolExecutor {
  const workspaceRef = `workspace:${input.projectKey}`;
  const assets = new FileReadAssets(new ImmutableAssetStore(join(input.artifactRoot, 'file-read')));
  const route = new FileReadRoute({
    functions: new WorkspaceCodeSearchFunctions({ workspaceRef, workspaceRoot: input.workspaceRoot }),
    artifacts: assets,
  });
  const hand = createHandOperationRuntime({
    fileReadRoute: route,
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
    async execute(request) {
      if (request.signal.aborted) throw Object.assign(new Error('file.read was stopped before admission'), { name: 'AbortError' });
      if (request.call.toolId !== RESPONSES_FILE_READ_TOOL.toolId) throw new Error(`provider tool is not registered: ${request.call.toolId}`);
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
      const artifact = await assets.writeRequest(request.call.callId, { workspaceRef, path });
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
      const result = await hand.execute({ intent, signal: request.signal });
      if (request.signal.aborted || result.operation.status === 'cancelled') {
        throw Object.assign(new Error('file.read was stopped'), { name: 'AbortError' });
      }
      if (result.operation.status !== 'succeeded' || !result.operation.result?.outputRef || !result.operation.result.outputDigest) {
        throw new Error(result.operation.failure?.message ?? `file.read ended in ${result.operation.status}`);
      }
      const report = await assets.readReport({
        outputRef: result.operation.result.outputRef,
        outputDigest: result.operation.result.outputDigest,
      });
      return {
        output: JSON.stringify(report),
        outputRefs: [result.operation.result.outputRef],
        evidenceRefs: result.operation.result.evidenceRefs,
      };
    },
  };
}
