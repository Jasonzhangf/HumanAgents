import {
  CODE_SEARCH_CONTRACT_VERSION,
  CODE_SEARCH_SERVICE_ID,
  ContractError,
  validateCodeSearchReport,
  validateInteractionTraceEntry,
  validateToolExecutionFact,
  type CodeSearchFailure,
  type CodeSearchQueryKind,
  type CodeSearchReport,
  type InteractionTraceEntry,
  type SemanticClaim,
  type ToolExecutionFact,
  type ToolIdentity,
  type ToolTraceDescriptor,
} from '../../../contracts/src/index.js';

export type FileSearchSemanticState = 'resolved' | 'partial' | 'unresolved' | 'refused';

export interface FileSearchSemanticRequest {
  readonly workspaceRef: string;
  readonly path: string;
  readonly query: string;
  readonly queryKind: CodeSearchQueryKind;
}

export interface FileSearchInvocationEvidence {
  readonly trace: InteractionTraceEntry;
  readonly expectedToolIdentity: ToolIdentity;
  readonly request: FileSearchSemanticRequest;
}

export interface FileSearchReportEvidence {
  /** Bytes read through the public digest-checked tool-output reader. */
  readonly report: unknown;
  readonly outputRef: string;
  readonly outputDigest: string;
}

export interface FileSearchSemanticInput {
  readonly invocation?: FileSearchInvocationEvidence;
  readonly result?: ToolTraceDescriptor;
  readonly fact?: ToolExecutionFact;
  readonly report?: FileSearchReportEvidence;
}

export interface FileSearchSemanticIdentity {
  readonly taskId: InteractionTraceEntry['taskId'];
  readonly operationId: InteractionTraceEntry['operationId'];
  readonly executionEpoch: number;
  readonly seq: number;
  readonly requestRef: string;
  readonly callRef: string;
  readonly toolIdentity: ToolIdentity;
  readonly observedAt: string;
  readonly turnId?: string;
}

export interface FileSearchSemanticCounts {
  readonly filesDiscovered: number;
  readonly filesSearched: number;
  readonly matchesFound: number;
  readonly returnedMatches: number;
  readonly resultsTruncated: boolean;
  readonly searchComplete: boolean;
}

export interface FileSearchSemanticObservation {
  readonly kind: 'file.search.semantic-observation';
  readonly state: FileSearchSemanticState;
  readonly code: string;
  readonly message: string;
  readonly invocation?: FileSearchSemanticIdentity;
  readonly executorState?: ToolExecutionFact['state'];
  readonly reportStatus?: CodeSearchReport['status'];
  readonly query?: {
    readonly value: string;
    readonly kind: CodeSearchQueryKind;
  };
  readonly scope?: {
    readonly workspaceRef: string;
    readonly path: string;
  };
  readonly counts?: FileSearchSemanticCounts;
  readonly unresolvedPaths?: readonly string[];
  readonly failure?: {
    readonly code: CodeSearchFailure['code'];
    readonly path?: string;
  };
  readonly reportEvidence?: {
    readonly outputRef: string;
    readonly outputDigest: string;
    readonly serviceId: typeof CODE_SEARCH_SERVICE_ID;
    readonly contractVersion: typeof CODE_SEARCH_CONTRACT_VERSION;
  };
  readonly sourceRefs: readonly string[];
  readonly claim?: SemanticClaim;
}

const NONTERMINAL_FACT_STATES = new Set<ToolExecutionFact['state']>([
  'not-started',
  'accepted',
  'running',
]);

function uniqueRefs(refs: readonly string[]): readonly string[] {
  return [...new Set(refs.filter((ref) => ref.trim() !== ''))];
}

function observation(
  state: FileSearchSemanticState,
  code: string,
  message: string,
  sourceRefs: readonly string[] = [],
): FileSearchSemanticObservation {
  return {
    kind: 'file.search.semantic-observation',
    state,
    code,
    message,
    sourceRefs: uniqueRefs(sourceRefs),
  };
}

function identity(
  trace: InteractionTraceEntry,
  expectedToolIdentity: ToolIdentity,
): FileSearchSemanticIdentity {
  return {
    taskId: trace.taskId,
    operationId: trace.operationId,
    executionEpoch: trace.executionEpoch,
    seq: trace.seq,
    requestRef: trace.requestId!,
    callRef: trace.tool!.callId,
    toolIdentity: expectedToolIdentity,
    observedAt: trace.occurredAt,
    ...(trace.turnId === undefined ? {} : { turnId: trace.turnId }),
  };
}

function factRefs(fact: ToolExecutionFact | undefined): readonly string[] {
  return fact === undefined ? [] : uniqueRefs(fact.rawEvidenceRefs);
}

function reportRefs(
  fact: ToolExecutionFact,
  evidence: FileSearchReportEvidence,
): readonly string[] {
  return uniqueRefs([evidence.outputRef, ...factRefs(fact)]);
}

function sameToolIdentity(left: ToolIdentity, right: ToolIdentity): boolean {
  return left.surface === right.surface
    && left.toolId === right.toolId
    && left.bindingRef === right.bindingRef
    && left.route === right.route;
}

function claimFact(report: CodeSearchReport, partial: boolean): string {
  const query = JSON.stringify(report.query);
  const workspace = JSON.stringify(report.workspaceRef);
  const path = JSON.stringify(report.path);
  const counts = `searched ${report.filesSearched} of ${report.filesDiscovered} discovered file(s), matchesFound=${report.matchesFound}, returnedMatches=${report.matches.length}`;
  if (!partial) {
    if (report.matchesFound === 0) {
      return `Responses file.search report records zero matches for query ${query} (${report.queryKind}) in workspace ${workspace} path ${path}; ${counts}.`;
    }
    return `Responses file.search report records ${report.matchesFound} match(es) for query ${query} (${report.queryKind}) in workspace ${workspace} path ${path}; ${counts}.`;
  }
  return `Responses file.search report is partial for query ${query} (${report.queryKind}) in workspace ${workspace} path ${path}; ${counts}, resultsTruncated=${report.resultsTruncated}, searchComplete=${report.searchComplete}, unresolvedPaths=${JSON.stringify(report.unresolvedPaths)}.`;
}

function reportObservation(
  state: 'resolved' | 'partial',
  report: CodeSearchReport,
  evidence: FileSearchReportEvidence,
  fact: ToolExecutionFact,
  trace: InteractionTraceEntry,
  expectedToolIdentity: ToolIdentity,
): FileSearchSemanticObservation {
  const sourceRefs = reportRefs(fact, evidence);
  return {
    ...observation(
      state,
      state === 'resolved' ? 'file-search.complete' : 'file-search.partial',
      state === 'resolved'
        ? 'file.search report observation is complete'
        : 'file.search report observation is partial',
      sourceRefs,
    ),
    invocation: identity(trace, expectedToolIdentity),
    executorState: fact.state,
    reportStatus: report.status,
    query: { value: report.query, kind: report.queryKind },
    scope: { workspaceRef: report.workspaceRef, path: report.path },
    counts: {
      filesDiscovered: report.filesDiscovered,
      filesSearched: report.filesSearched,
      matchesFound: report.matchesFound,
      returnedMatches: report.matches.length,
      resultsTruncated: report.resultsTruncated,
      searchComplete: report.searchComplete,
    },
    unresolvedPaths: [...report.unresolvedPaths],
    reportEvidence: {
      outputRef: evidence.outputRef,
      outputDigest: evidence.outputDigest,
      serviceId: report.serviceId,
      contractVersion: report.contractVersion,
    },
    claim: {
      fact: claimFact(report, state === 'partial'),
      certainty: state === 'resolved' ? 'confirmed' : 'partial',
      sourceRefs,
    },
  };
}

/**
 * Pure mapping from one qualified Responses `file.search` result to a bounded
 * semantic observation. The caller owns all I/O, readback, and digest checking.
 */
export function deriveFileSearchObservation(
  input: FileSearchSemanticInput,
): FileSearchSemanticObservation {
  if (input === null || typeof input !== 'object') {
    return observation('unresolved', 'file-search.input-missing', 'file.search semantic input is missing');
  }

  const invocation = input.invocation;
  if (invocation === undefined) {
    return observation('unresolved', 'file-search.invocation-missing', 'file.search invocation identity is missing');
  }
  const trace = invocation.trace;
  if (trace === undefined) {
    return observation('unresolved', 'file-search.invocation-missing', 'file.search invocation trace is missing');
  }
  if (trace.kind !== 'tool-result') {
    return observation('refused', 'file-search.invocation-invalid', 'file.search invocation is not a tool result');
  }
  if (trace.tool === undefined || trace.requestId === undefined || !trace.tool.callId || !trace.tool.toolId) {
    return observation('unresolved', 'file-search.identity-missing', 'file.search invocation identity is incomplete');
  }
  try {
    validateInteractionTraceEntry(trace);
  } catch {
    return observation('refused', 'file-search.invocation-invalid', 'file.search invocation failed public validation');
  }

  const expectedToolIdentity = invocation.expectedToolIdentity;
  if (expectedToolIdentity === undefined) {
    return observation('unresolved', 'file-search.identity-missing', 'expected file.search tool identity is missing');
  }
  if (expectedToolIdentity.surface !== 'responses' || expectedToolIdentity.toolId !== 'file.search') {
    return observation('refused', 'file-search.identity-mismatch', 'file.search expected identity is not Responses file.search');
  }
  if (trace.tool.toolId !== expectedToolIdentity.toolId) {
    return observation('refused', 'file-search.identity-mismatch', 'file.search invocation tool identity does not match its trusted identity');
  }

  const request = invocation.request;
  if (request === undefined) {
    return observation('unresolved', 'file-search.request-missing', 'file.search request identity is missing');
  }
  if (
    typeof request.workspaceRef !== 'string'
    || typeof request.path !== 'string'
    || typeof request.query !== 'string'
    || !['literal', 'regex', 'symbol'].includes(request.queryKind)
  ) {
    return observation('refused', 'file-search.request-invalid', 'file.search request identity is invalid');
  }

  const result = input.result;
  if (result === undefined) {
    return observation('unresolved', 'file-search.result-missing', 'file.search result descriptor is missing');
  }
  if (
    typeof result.callId !== 'string'
    || typeof result.toolId !== 'string'
    || typeof result.status !== 'string'
  ) {
    return observation('refused', 'file-search.result-invalid', 'file.search result descriptor is invalid');
  }
  if (
    result.callId !== trace.tool.callId
    || result.toolId !== trace.tool.toolId
    || result.status !== trace.tool.status
    || result.outputRef !== trace.tool.outputRef
    || result.outputDigest !== trace.tool.outputDigest
  ) {
    return observation('refused', 'file-search.result-mismatch', 'file.search result descriptor does not match its invocation');
  }

  const fact = input.fact;
  if (fact === undefined) {
    return observation('unresolved', 'file-search.fact-missing', 'file.search execution fact is missing');
  }
  try {
    validateToolExecutionFact(fact, expectedToolIdentity);
  } catch {
    return observation('refused', 'file-search.fact-invalid', 'file.search execution fact failed public validation');
  }
  if (
    !sameToolIdentity(fact.identity, expectedToolIdentity)
    || fact.requestRef !== trace.requestId
    || fact.callRef !== trace.tool.callId
    || fact.operationRef !== trace.operationId.value
  ) {
    return observation('refused', 'file-search.identity-mismatch', 'file.search execution fact identity does not match its invocation');
  }

  if (fact.state !== result.status) {
    if (!(NONTERMINAL_FACT_STATES.has(fact.state) && result.status === 'running')) {
      return observation('refused', 'file-search.fact-state-mismatch', 'file.search executor fact and result states conflict');
    }
  }
  if (NONTERMINAL_FACT_STATES.has(fact.state) || result.status === 'running') {
    return {
      ...observation('unresolved', 'file-search.execution-nonterminal', 'file.search execution is not terminal', factRefs(fact)),
      invocation: identity(trace, expectedToolIdentity),
      executorState: fact.state,
    };
  }
  if (fact.state !== 'succeeded' || result.status !== 'succeeded') {
    return {
      ...observation('unresolved', 'file-search.execution-not-succeeded', 'file.search execution did not succeed', factRefs(fact)),
      invocation: identity(trace, expectedToolIdentity),
      executorState: fact.state,
    };
  }
  if (fact.resultRef === undefined || fact.resultDigest === undefined) {
    return observation('unresolved', 'file-search.fact-descriptor-missing', 'file.search execution fact has no result descriptor', factRefs(fact));
  }
  if (result.outputRef === undefined || result.outputDigest === undefined) {
    return observation('unresolved', 'file-search.result-descriptor-missing', 'file.search result has no immutable descriptor', factRefs(fact));
  }
  if (
    fact.resultRef !== result.outputRef
    || fact.resultDigest !== result.outputDigest
    || !/^sha256:[0-9a-f]{64}$/.test(fact.resultDigest)
  ) {
    return observation('refused', 'file-search.descriptor-mismatch', 'file.search execution fact result descriptor does not match its result', factRefs(fact));
  }

  const evidence = input.report;
  if (evidence === undefined) {
    return observation('unresolved', 'file-search.report-missing', 'file.search report evidence is missing', factRefs(fact));
  }
  if (evidence.report === undefined) {
    return observation('unresolved', 'file-search.report-missing', 'file.search report bytes are missing', factRefs(fact));
  }
  if (
    typeof evidence.outputRef !== 'string'
    || evidence.outputRef.trim() === ''
    || typeof evidence.outputDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(evidence.outputDigest)
  ) {
    return observation('refused', 'file-search.report-descriptor-invalid', 'file.search report descriptor is invalid', factRefs(fact));
  }
  if (evidence.outputRef !== result.outputRef || evidence.outputDigest !== result.outputDigest) {
    return observation('refused', 'file-search.descriptor-mismatch', 'file.search report descriptor does not match its result', factRefs(fact));
  }

  let report: CodeSearchReport;
  try {
    validateCodeSearchReport(evidence.report);
    report = evidence.report;
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return observation('refused', 'file-search.report-invalid', 'file.search report failed public validation', factRefs(fact));
  }

  if (
    report.workspaceRef !== request.workspaceRef
    || report.path !== request.path
    || report.query !== request.query
    || report.queryKind !== request.queryKind
  ) {
    return observation('refused', 'file-search.report-request-mismatch', 'file.search report request fields do not match its invocation', factRefs(fact));
  }

  if (report.status === 'failed') {
    return {
      ...observation('unresolved', 'file-search.business-failed', 'file.search execution succeeded but its report records a business failure', reportRefs(fact, evidence)),
      invocation: identity(trace, expectedToolIdentity),
      executorState: fact.state,
      reportStatus: report.status,
      query: { value: report.query, kind: report.queryKind },
      scope: { workspaceRef: report.workspaceRef, path: report.path },
      counts: {
        filesDiscovered: report.filesDiscovered,
        filesSearched: report.filesSearched,
        matchesFound: report.matchesFound,
        returnedMatches: report.matches.length,
        resultsTruncated: report.resultsTruncated,
        searchComplete: report.searchComplete,
      },
      unresolvedPaths: [...report.unresolvedPaths],
      failure: {
        code: report.failure!.code,
        ...(report.failure!.path === undefined ? {} : { path: report.failure!.path }),
      },
      reportEvidence: {
        outputRef: evidence.outputRef,
        outputDigest: evidence.outputDigest,
        serviceId: report.serviceId,
        contractVersion: report.contractVersion,
      },
    };
  }

  if (report.searchComplete && report.filesSearched !== report.filesDiscovered) {
    return observation('refused', 'file-search.counts-contradictory', 'file.search report completeness conflicts with its searched and discovered counts', factRefs(fact));
  }

  const partial = !report.searchComplete
    || report.unresolvedPaths.length > 0
    || report.resultsTruncated;
  return reportObservation(
    partial ? 'partial' : 'resolved',
    report,
    evidence,
    fact,
    trace,
    expectedToolIdentity,
  );
}
