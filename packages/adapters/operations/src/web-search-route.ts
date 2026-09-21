import {
  WEB_SEARCH_CONTRACT_VERSION,
  WEB_SEARCH_SERVICE_ID,
  id,
  validateWebSearchReport,
  type EvidenceRef,
  type OperationResult,
  type WebSearchReport,
  type WebSearchRequest,
} from '../../../contracts/src/index.js';
import { WebSearchService, type WebSearchProvider } from '../../../runtime/src/hand/index.js';
import type { OperationStopSettlementReceipt, OperationStopSettlementRequest } from '../../../runtime/src/gateway/ports.js';
import { OperationAdapterError, failureEvidence, operationFailure } from './errors.js';
import type { CancellableOperationRoute, OperationExecutionObservation, OperationExecutionRequest, OperationExecutorPort, OperationVerificationRequest, OperationVerifierPort } from './types.js';

export const WEB_SEARCH_TOOL_NAME = 'web.search';
export const WEB_SEARCH_ROUTE_ID = 'web-search';
export const WEB_SEARCH_ROUTE_VERSION = 'web-search.v1';

export interface WebSearchArtifactStore {
  readRequest(input: { readonly inputRef: string; readonly inputDigest: string }): Promise<WebSearchRequest>;
  writeReport(input: { readonly operationId: OperationExecutionRequest['intent']['operationId']; readonly report: WebSearchReport }): Promise<{ readonly outputRef: string; readonly outputDigest: string }>;
  readReport(input: { readonly outputRef: string; readonly outputDigest: string }): Promise<WebSearchReport>;
}

export interface WebSearchRouteOptions {
  readonly provider: WebSearchProvider;
  readonly artifacts: WebSearchArtifactStore;
  readonly now?: () => string;
  readonly stopDrainTimeoutMs?: number;
}

interface ActiveWebSearch {
  readonly executionEpoch: number;
  readonly controller: AbortController;
  readonly completion: Promise<OperationExecutionObservation>;
}

export class WebSearchRoute implements OperationExecutorPort, OperationVerifierPort, CancellableOperationRoute {
  readonly routeId = WEB_SEARCH_ROUTE_ID;
  readonly routeVersion = WEB_SEARCH_ROUTE_VERSION;
  readonly mode = 'gateway' as const;
  readonly toolName = WEB_SEARCH_TOOL_NAME;
  private readonly service: WebSearchService;
  private readonly active = new Map<string, ActiveWebSearch>();

  constructor(private readonly options: WebSearchRouteOptions) { this.service = new WebSearchService(options.provider); }

  async execute(input: OperationExecutionRequest): Promise<OperationExecutionObservation> {
    const controller = new AbortController();
    const completion = this.executeOnce(input, controller.signal);
    const key = input.intent.operationId.value;
    this.active.set(key, { executionEpoch: input.executionEpoch, controller, completion });
    try { return await completion; }
    finally { if (this.active.get(key)?.completion === completion) this.active.delete(key); }
  }

  async stop(input: OperationStopSettlementRequest): Promise<OperationStopSettlementReceipt> {
    const active = this.active.get(input.intent.operationId.value);
    if (active && active.executionEpoch !== input.executionEpoch) throw new Error('web search execution epoch does not match stop request');
    if (active) {
      active.controller.abort();
      const drained = await this.waitForDrain(active.completion);
      return this.stopReceipt(input, drained);
    }
    return this.stopReceipt(input, true);
  }

  async verify(input: OperationVerificationRequest): Promise<OperationResult> {
    const request = await this.readRequest(input, 'verification');
    if (!input.observation.outputRef || !input.observation.outputDigest) return this.failedVerification(input, 'web search produced no report artifact');
    let report: WebSearchReport;
    try { report = await this.options.artifacts.readReport({ outputRef: input.observation.outputRef, outputDigest: input.observation.outputDigest }); }
    catch (error) { return this.failedVerification(input, error instanceof Error ? error.message : 'web search report could not be read'); }
    try { validateWebSearchReport(report); }
    catch (error) { return this.failedVerification(input, error instanceof Error ? error.message : 'web search report is invalid'); }
    const domains = [...new Set((request.domains ?? []).map((domain) => domain.trim().toLowerCase()))].sort();
    const identityMatches = report.serviceId === WEB_SEARCH_SERVICE_ID
      && report.contractVersion === WEB_SEARCH_CONTRACT_VERSION
      && report.query === request.query.trim()
      && JSON.stringify(report.domains) === JSON.stringify(domains)
      && report.recency === (request.recency ?? 'any')
      && report.maxResults === (request.maxResults ?? 10)
      && report.requireComplete === (request.requireComplete ?? false);
    if (!identityMatches) return this.failedVerification(input, 'web search report does not match its request');
    if (report.status !== 'succeeded') return this.failedVerification(input, report.failure?.message ?? 'web search failed');
    if (request.requireComplete === true && !report.searchComplete) return this.failedVerification(input, 'web search report is incomplete');
    return {
      operationId: input.intent.operationId,
      status: 'succeeded',
      outputRef: input.observation.outputRef,
      outputDigest: input.observation.outputDigest,
      evidenceRefs: input.observation.evidenceRefs,
      verifier: { name: this.routeId, version: this.routeVersion, decision: 'web-search-report-verified' },
      completedAt: this.now(),
    };
  }

  private async executeOnce(input: OperationExecutionRequest, signal: AbortSignal): Promise<OperationExecutionObservation> {
    const request = await this.readRequest(input, 'execution');
    const report = await this.service.execute(request, { signal });
    if (signal.aborted) throw Object.assign(new Error('web search execution aborted'), { name: 'AbortError' });
    const artifact = await this.options.artifacts.writeReport({ operationId: input.intent.operationId, report });
    return {
      operationId: input.intent.operationId,
      outputRef: artifact.outputRef,
      outputDigest: artifact.outputDigest,
      evidenceRefs: [
        webSearchEvidence(input, 'input', input.intent.inputDigest),
        webSearchEvidence(input, report.status === 'succeeded' ? 'report' : 'report-failed', artifact.outputDigest),
      ],
    };
  }

  private async readRequest(input: OperationExecutionRequest | OperationVerificationRequest, phase: 'execution' | 'verification'): Promise<WebSearchRequest> {
    try { return await this.options.artifacts.readRequest({ inputRef: input.intent.inputRef, inputDigest: input.intent.inputDigest }); }
    catch (error) {
      throw new OperationAdapterError(operationFailure({
        errorId: `web-search-input-${input.intent.operationId.value}`,
        operationId: input.intent.operationId,
        phase,
        failureClass: 'contract',
        message: error instanceof Error ? error.message : 'web search input could not be read',
        observedAt: this.now(),
        impact: 'the web search service could not determine its requested query',
        protectiveAction: 'reject the service execution without guessing input',
        nextAction: { kind: 'recover', ref: WEB_SEARCH_ROUTE_ID },
        evidenceRefs: [failureEvidence(input.intent.operationId, input.effectiveScope, 'web-search-input-failure')],
      }), error);
    }
  }

  private failedVerification(input: OperationVerificationRequest, message: string): OperationResult {
    const failure = operationFailure({
      errorId: `web-search-verification-${input.intent.operationId.value}`,
      operationId: input.intent.operationId,
      phase: 'verification',
      failureClass: 'verifier',
      message,
      observedAt: this.now(),
      impact: 'web search did not produce a trusted report for the requested query constraints',
      protectiveAction: 'return the report failure without claiming a complete search',
      nextAction: { kind: 'recover', ref: WEB_SEARCH_ROUTE_ID },
      evidenceRefs: [failureEvidence(input.intent.operationId, input.effectiveScope, 'web-search-verification-failure')],
    });
    return { operationId: input.intent.operationId, status: 'failed', evidenceRefs: failure.evidenceRefs,
      verifier: { name: this.routeId, version: this.routeVersion, decision: 'web-search-report-rejected' }, failure, completedAt: this.now() };
  }

  private async waitForDrain(completion: Promise<OperationExecutionObservation>): Promise<boolean> {
    const timeoutMs = this.options.stopDrainTimeoutMs ?? 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try { return await Promise.race([completion.then(() => true, () => true), timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private stopReceipt(input: OperationStopSettlementRequest, stopped: boolean): OperationStopSettlementReceipt {
    return {
      receiptId: `web-search-stop-${input.intent.operationId.value}-${input.executionEpoch}`,
      operationId: input.intent.operationId,
      taskId: input.intent.taskId,
      executionEpoch: input.executionEpoch,
      owner: input.owner,
      ...(input.lease?.leaseId ? { leaseId: input.lease.leaseId } : {}),
      stopped,
      sideEffectState: stopped ? 'none' : 'possible',
      evidenceRefs: [failureEvidence(input.intent.operationId, input.route.effectiveScope, stopped ? 'web-search-stopped' : 'web-search-stop-unconfirmed')],
    };
  }

  private now(): string { return this.options.now ? this.options.now() : new Date().toISOString(); }
}

function webSearchEvidence(input: OperationExecutionRequest, label: string, digest: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `web-search-${input.intent.operationId.value}-${label}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128)),
    kind: 'tool',
    source: 'humanagent.operations.web-search',
    locator: `operations://web-search/${encodeURIComponent(input.intent.operationId.value)}/${label}`,
    digest,
    scope: input.effectiveScope,
  };
}

export function webSearchRegistration(): import('../../../contracts/src/index.js').ToolRegistration {
  return {
    toolName: WEB_SEARCH_TOOL_NAME,
    contractVersion: '1.0.0',
    supportedKinds: ['inspect'],
    routeId: WEB_SEARCH_ROUTE_ID,
    routeVersion: WEB_SEARCH_ROUTE_VERSION,
    mode: 'gateway',
    acceptedScopes: [{}],
    inputContract: 'schema://web.search.request/v1',
    outputContract: 'schema://web.search.report/v1',
    verifier: 'verifier://web.search/v1',
    capabilities: ['web.search'],
    retryPolicy: 'retry://read-only/v1',
    owner: 'humanagent.operations.web-search',
  };
}
