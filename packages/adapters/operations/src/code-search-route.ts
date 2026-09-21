import {
  CODE_SEARCH_CONTRACT_VERSION,
  CODE_SEARCH_SERVICE_ID,
  id,
  type EvidenceRef,
  type CodeSearchReport,
  type CodeSearchRequest,
  type OperationResult,
} from '../../../contracts/src/index.js';
import { CodeSearchService, type CodeSearchFunctions } from '../../../runtime/src/hand/index.js';
import { OperationAdapterError, failureEvidence, operationFailure } from './errors.js';
import type { OperationExecutionObservation, OperationExecutionRequest, OperationExecutorPort, OperationVerificationRequest, OperationVerifierPort } from './types.js';

export const CODE_SEARCH_TOOL_NAME = 'code.search';
export const CODE_SEARCH_ROUTE_ID = 'code-search';
export const CODE_SEARCH_ROUTE_VERSION = 'code-search.v1';

export interface CodeSearchArtifactStore {
  readRequest(input: { readonly inputRef: string; readonly inputDigest: string }): Promise<CodeSearchRequest>;
  writeReport(input: { readonly operationId: OperationExecutionRequest['intent']['operationId']; readonly report: CodeSearchReport }): Promise<{ readonly outputRef: string; readonly outputDigest: string }>;
  readReport(input: { readonly outputRef: string; readonly outputDigest: string }): Promise<CodeSearchReport>;
}

export interface CodeSearchRouteOptions {
  readonly functions: CodeSearchFunctions;
  readonly artifacts: CodeSearchArtifactStore;
  readonly now?: () => string;
}

export class CodeSearchRoute implements OperationExecutorPort, OperationVerifierPort {
  readonly routeId = CODE_SEARCH_ROUTE_ID;
  readonly routeVersion = CODE_SEARCH_ROUTE_VERSION;
  readonly mode = 'gateway' as const;
  readonly toolName = CODE_SEARCH_TOOL_NAME;
  private readonly service: CodeSearchService;

  constructor(private readonly options: CodeSearchRouteOptions) { this.service = new CodeSearchService({ functions: options.functions }); }

  async execute(input: OperationExecutionRequest): Promise<OperationExecutionObservation> {
    const request = await this.readRequest(input, 'execution');
    const report = await this.service.execute(request);
    const artifact = await this.options.artifacts.writeReport({ operationId: input.intent.operationId, report });
    return {
      operationId: input.intent.operationId,
      outputRef: artifact.outputRef,
      outputDigest: artifact.outputDigest,
      evidenceRefs: [
        codeSearchEvidence(input, 'input', input.intent.inputDigest),
        codeSearchEvidence(input, report.status === 'succeeded' ? 'report' : 'report-failed', artifact.outputDigest),
      ],
    };
  }

  async verify(input: OperationVerificationRequest): Promise<OperationResult> {
    const request = await this.readRequest(input, 'verification');
    if (!input.observation.outputRef || !input.observation.outputDigest) {
      return this.failedVerification(input, 'code search produced no report artifact');
    }
    let report: CodeSearchReport;
    try {
      report = await this.options.artifacts.readReport({ outputRef: input.observation.outputRef, outputDigest: input.observation.outputDigest });
    } catch (error) {
      return this.failedVerification(input, error instanceof Error ? error.message : 'code search report could not be read');
    }
    const identityMatches = report.serviceId === CODE_SEARCH_SERVICE_ID
      && report.contractVersion === CODE_SEARCH_CONTRACT_VERSION
      && report.workspaceRef === request.workspaceRef
      && report.path === request.path
      && report.query === request.query
      && report.queryKind === request.queryKind;
    if (!identityMatches) return this.failedVerification(input, 'code search report does not match its request');
    if (report.status !== 'succeeded') return this.failedVerification(input, report.failure?.message ?? 'code search failed');
    if (request.requireComplete === true && !report.searchComplete) return this.failedVerification(input, 'code search report is incomplete');
    return {
      operationId: input.intent.operationId,
      status: 'succeeded',
      outputRef: input.observation.outputRef,
      outputDigest: input.observation.outputDigest,
      evidenceRefs: input.observation.evidenceRefs,
      verifier: { name: this.routeId, version: this.routeVersion, decision: 'code-search-report-verified' },
      completedAt: this.now(),
    };
  }

  private async readRequest(input: OperationExecutionRequest | OperationVerificationRequest, phase: 'execution' | 'verification'): Promise<CodeSearchRequest> {
    try { return await this.options.artifacts.readRequest({ inputRef: input.intent.inputRef, inputDigest: input.intent.inputDigest }); }
    catch (error) {
      throw new OperationAdapterError(operationFailure({
        errorId: `code-search-input-${input.intent.operationId.value}`,
        operationId: input.intent.operationId,
        phase,
        failureClass: 'contract',
        message: error instanceof Error ? error.message : 'code search input could not be read',
        observedAt: this.now(),
        impact: 'the code search service could not determine its requested workspace operation',
        protectiveAction: 'reject the service execution without guessing input',
        nextAction: { kind: 'recover', ref: CODE_SEARCH_ROUTE_ID },
        evidenceRefs: [failureEvidence(input.intent.operationId, input.effectiveScope, 'code-search-input-failure')],
      }), error);
    }
  }

  private failedVerification(input: OperationVerificationRequest, message: string): OperationResult {
    const failure = operationFailure({
      errorId: `code-search-verification-${input.intent.operationId.value}`,
      operationId: input.intent.operationId,
      phase: 'verification',
      failureClass: 'verifier',
      message,
      observedAt: this.now(),
      impact: 'code search did not produce a trusted report for the requested scope',
      protectiveAction: 'return the report failure without claiming a complete search',
      nextAction: { kind: 'recover', ref: CODE_SEARCH_ROUTE_ID },
      evidenceRefs: [failureEvidence(input.intent.operationId, input.effectiveScope, 'code-search-verification-failure')],
    });
    return { operationId: input.intent.operationId, status: 'failed', evidenceRefs: failure.evidenceRefs,
      verifier: { name: this.routeId, version: this.routeVersion, decision: 'code-search-report-rejected' }, failure, completedAt: this.now() };
  }

  private now(): string { return this.options.now ? this.options.now() : new Date().toISOString(); }
}

function codeSearchEvidence(input: OperationExecutionRequest, label: string, digest: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `code-search-${input.intent.operationId.value}-${label}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128)),
    kind: 'tool',
    source: 'humanagent.operations.code-search',
    locator: `operations://code-search/${encodeURIComponent(input.intent.operationId.value)}/${label}`,
    digest,
    scope: input.effectiveScope,
  };
}

export function codeSearchRegistration(): import('../../../contracts/src/index.js').ToolRegistration {
  return {
    toolName: CODE_SEARCH_TOOL_NAME,
    contractVersion: '1.0.0',
    supportedKinds: ['inspect'],
    routeId: CODE_SEARCH_ROUTE_ID,
    routeVersion: CODE_SEARCH_ROUTE_VERSION,
    mode: 'gateway',
    acceptedScopes: [{}],
    inputContract: 'schema://code.search.request/v1',
    outputContract: 'schema://code.search.report/v1',
    verifier: 'verifier://code.search/v1',
    capabilities: ['workspace.code-search'],
    retryPolicy: 'retry://read-only/v1',
    owner: 'humanagent.operations.code-search',
  };
}
