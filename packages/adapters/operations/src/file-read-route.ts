import {
  id,
  type EvidenceRef,
  type OperationResult,
} from '../../../contracts/src/index.js';
import type { CodeSearchFunctions } from '../../../runtime/src/hand/index.js';
import type { OperationStopSettlementReceipt, OperationStopSettlementRequest } from '../../../runtime/src/gateway/ports.js';
import { OperationAdapterError, failureEvidence, operationFailure } from './errors.js';
import type {
  OperationExecutionObservation,
  OperationExecutionRequest,
  OperationExecutorPort,
  OperationVerificationRequest,
  OperationVerifierPort,
  CancellableOperationRoute,
} from './types.js';

export const FILE_READ_TOOL_NAME = 'file.read';
export const FILE_READ_ROUTE_ID = 'file-read';
export const FILE_READ_ROUTE_VERSION = 'file-read.v1';

export interface FileReadRequest {
  readonly workspaceRef: string;
  readonly path: string;
}

export interface FileReadReport extends FileReadRequest {
  readonly content: string;
}

export interface FileReadArtifactStore {
  readRequest(input: { readonly inputRef: string; readonly inputDigest: string }): Promise<FileReadRequest>;
  writeReport(input: {
    readonly operationId: OperationExecutionRequest['intent']['operationId'];
    readonly report: FileReadReport;
  }): Promise<{ readonly outputRef: string; readonly outputDigest: string }>;
  readReport(input: { readonly outputRef: string; readonly outputDigest: string }): Promise<FileReadReport>;
}

export class FileReadRoute implements OperationExecutorPort, OperationVerifierPort, CancellableOperationRoute {
  readonly routeId = FILE_READ_ROUTE_ID;
  readonly routeVersion = FILE_READ_ROUTE_VERSION;
  readonly mode = 'gateway' as const;
  readonly toolName = FILE_READ_TOOL_NAME;
  private readonly active = new Map<string, { readonly executionEpoch: number; readonly controller: AbortController; readonly completion: Promise<OperationExecutionObservation> }>();

  constructor(private readonly options: {
    readonly functions: Pick<CodeSearchFunctions, 'readFile'> & {
      normalizePath(input: { readonly workspaceRef: string; readonly path: string }): string;
    };
    readonly artifacts: FileReadArtifactStore;
    readonly now?: () => string;
  }) {}

  async execute(input: OperationExecutionRequest): Promise<OperationExecutionObservation> {
    const controller = new AbortController();
    const completion = this.executeOnce(input, controller.signal);
    this.active.set(input.intent.operationId.value, { executionEpoch: input.executionEpoch, controller, completion });
    try {
      return await completion;
    } finally {
      if (this.active.get(input.intent.operationId.value)?.completion === completion) this.active.delete(input.intent.operationId.value);
    }
  }

  async stop(input: OperationStopSettlementRequest): Promise<OperationStopSettlementReceipt> {
    const active = this.active.get(input.intent.operationId.value);
    if (active && active.executionEpoch !== input.executionEpoch) throw new Error('file read execution epoch does not match stop request');
    active?.controller.abort();
    if (active) await active.completion.catch(() => undefined);
    return {
      receiptId: `file-read-stop-${input.intent.operationId.value}-${input.executionEpoch}`,
      operationId: input.intent.operationId,
      taskId: input.intent.taskId,
      executionEpoch: input.executionEpoch,
      owner: input.owner,
      ...(input.lease?.leaseId ? { leaseId: input.lease.leaseId } : {}),
      stopped: true,
      sideEffectState: 'none',
      evidenceRefs: [failureEvidence(input.intent.operationId, input.route.effectiveScope, 'file-read-stopped')],
    };
  }

  private async executeOnce(input: OperationExecutionRequest, signal: AbortSignal): Promise<OperationExecutionObservation> {
    const request = await this.readRequest(input, 'execution');
    const normalizedPath = this.options.functions.normalizePath(request);
    const file = await this.options.functions.readFile({
      workspaceRef: request.workspaceRef,
      path: normalizedPath,
      signal,
    });
    if (signal.aborted) throw Object.assign(new Error('file read execution aborted'), { name: 'AbortError' });
    const artifact = await this.options.artifacts.writeReport({
      operationId: input.intent.operationId,
      report: { workspaceRef: request.workspaceRef, path: file.path, content: file.content },
    });
    return {
      operationId: input.intent.operationId,
      outputRef: artifact.outputRef,
      outputDigest: artifact.outputDigest,
      evidenceRefs: [this.evidence(input, 'file', artifact.outputDigest)],
    };
  }

  async verify(input: OperationVerificationRequest): Promise<OperationResult> {
    const request = await this.readRequest(input, 'verification');
    if (!input.observation.outputRef || !input.observation.outputDigest) {
      return this.failedVerification(input, 'file read produced no report artifact');
    }
    let report: FileReadReport;
    try {
      report = await this.options.artifacts.readReport({
        outputRef: input.observation.outputRef,
        outputDigest: input.observation.outputDigest,
      });
    } catch (error) {
      return this.failedVerification(input, error instanceof Error ? error.message : 'file read report could not be read');
    }
    const normalizedPath = this.options.functions.normalizePath(request);
    if (report.workspaceRef !== request.workspaceRef || report.path !== normalizedPath) {
      return this.failedVerification(input, 'file read report does not match its request');
    }
    return {
      operationId: input.intent.operationId,
      status: 'succeeded',
      outputRef: input.observation.outputRef,
      outputDigest: input.observation.outputDigest,
      evidenceRefs: input.observation.evidenceRefs,
      verifier: { name: this.routeId, version: this.routeVersion, decision: 'file-read-report-verified' },
      completedAt: this.now(),
    };
  }

  private async readRequest(
    input: OperationExecutionRequest | OperationVerificationRequest,
    phase: 'execution' | 'verification',
  ): Promise<FileReadRequest> {
    try {
      return await this.options.artifacts.readRequest({
        inputRef: input.intent.inputRef,
        inputDigest: input.intent.inputDigest,
      });
    } catch (error) {
      throw new OperationAdapterError(operationFailure({
        errorId: `file-read-input-${input.intent.operationId.value}`,
        operationId: input.intent.operationId,
        phase,
        failureClass: 'contract',
        message: error instanceof Error ? error.message : 'file read input could not be read',
        observedAt: this.now(),
        impact: 'the file read route could not determine its requested workspace operation',
        protectiveAction: 'reject the read without guessing a path or content',
        nextAction: { kind: 'recover', ref: FILE_READ_ROUTE_ID },
        evidenceRefs: [failureEvidence(input.intent.operationId, input.effectiveScope, 'file-read-input-failure')],
      }), error);
    }
  }

  private failedVerification(input: OperationVerificationRequest, message: string): OperationResult {
    const failure = operationFailure({
      errorId: `file-read-verification-${input.intent.operationId.value}`,
      operationId: input.intent.operationId,
      phase: 'verification',
      failureClass: 'verifier',
      message,
      observedAt: this.now(),
      impact: 'the provider cannot trust the file content',
      protectiveAction: 'reject the tool result without continuing the model',
      nextAction: { kind: 'recover', ref: FILE_READ_ROUTE_ID },
      evidenceRefs: [failureEvidence(input.intent.operationId, input.effectiveScope, 'file-read-verification-failure')],
    });
    return {
      operationId: input.intent.operationId,
      status: 'failed',
      evidenceRefs: failure.evidenceRefs,
      verifier: { name: this.routeId, version: this.routeVersion, decision: 'file-read-report-rejected' },
      failure,
      completedAt: this.now(),
    };
  }

  private evidence(input: OperationExecutionRequest, label: string, digest: string): EvidenceRef {
    return {
      evidenceId: id('evidence', `file-read-${input.intent.operationId.value}-${label}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128)),
      kind: 'tool',
      source: 'humanagent.operations.file-read',
      locator: `operations://file-read/${encodeURIComponent(input.intent.operationId.value)}/${label}`,
      digest,
      scope: input.effectiveScope,
    };
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString();
  }
}

export function fileReadRegistration(): import('../../../contracts/src/index.js').ToolRegistration {
  return {
    toolName: FILE_READ_TOOL_NAME,
    contractVersion: '1.0.0',
    supportedKinds: ['inspect'],
    routeId: FILE_READ_ROUTE_ID,
    routeVersion: FILE_READ_ROUTE_VERSION,
    mode: 'gateway',
    acceptedScopes: [{}],
    inputContract: 'schema://file.read.request/v1',
    outputContract: 'schema://file.read.report/v1',
    verifier: 'verifier://file.read/v1',
    capabilities: ['workspace.read'],
    retryPolicy: 'retry://read-only/v1',
    owner: 'humanagent.operations.file-read',
  };
}
