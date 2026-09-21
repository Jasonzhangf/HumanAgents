import {
  validateCodeSearchRequest,
  type CodeSearchFailure,
  type CodeSearchMatch,
  type CodeSearchReport,
  type CodeSearchRequest,
} from '../../../contracts/src/index.js';

export interface CodeSearchFileList { readonly paths: readonly string[]; readonly complete: boolean; readonly unresolvedPaths: readonly string[]; }
export interface CodeSearchFileContent { readonly path: string; readonly content: string; }
/** Internal function harness. Hand exposes only code.search, never these calls. */
export interface CodeSearchFunctions {
  findFiles(input: Pick<CodeSearchRequest, 'workspaceRef' | 'path'>): Promise<CodeSearchFileList>;
  readFile(input: { readonly workspaceRef: string; readonly path: string }): Promise<CodeSearchFileContent>;
}

export class CodeSearchHarnessError extends Error {
  constructor(readonly code: 'path-not-found' | 'path-escape' | 'read-failed', message: string, readonly path?: string) {
    super(message); this.name = 'CodeSearchHarnessError';
  }
}

export class CodeSearchService {
  constructor(private readonly options: { readonly functions: CodeSearchFunctions }) {}

  async execute(input: CodeSearchRequest): Promise<CodeSearchReport> {
    try { validateCodeSearchRequest(input); }
    catch (error) { return this.failedReport(input, { code: 'invalid-request', message: error instanceof Error ? error.message : 'invalid code search request' }); }
    let files: CodeSearchFileList;
    try {
      files = await this.options.functions.findFiles({ workspaceRef: input.workspaceRef, path: input.path });
    } catch (error) {
      return this.failedReport(input, this.failureFrom(error, input.path, 'path-not-found'));
    }
    const unresolvedPaths = [...files.unresolvedPaths];
    const matches: CodeSearchMatch[] = [];
    let filesSearched = 0;
    let matchesFound = 0;
    let expression: RegExp;
    try {
      expression = this.expression(input);
    } catch (error) {
      return this.failedReport(input, {
        code: 'invalid-request',
        message: 'invalid search expression',
      });
    }
    for (const path of [...files.paths].sort()) {
      let content: CodeSearchFileContent;
      try { content = await this.options.functions.readFile({ workspaceRef: input.workspaceRef, path }); }
      catch { unresolvedPaths.push(path); continue; }
      filesSearched += 1;
      const lines = content.content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]!;
        const match = expression.exec(line);
        expression.lastIndex = 0;
        if (match === null) continue;
        matchesFound += 1;
        if (matches.length < (input.maxResults ?? Number.MAX_SAFE_INTEGER)) {
          const contextLines = input.contextLines ?? 2;
          matches.push({ path, line: lineIndex + 1, column: match.index + 1, text: line,
            contextBefore: lines.slice(Math.max(0, lineIndex - contextLines), lineIndex),
            contextAfter: lines.slice(lineIndex + 1, lineIndex + 1 + contextLines) });
        }
      }
    }
    const uniqueUnresolvedPaths = [...new Set(unresolvedPaths)].sort();
    const searchComplete = files.complete && uniqueUnresolvedPaths.length === 0;
    const resultsTruncated = matchesFound > matches.length;
    const base = this.baseReport(input, matches, files.paths.length, filesSearched, matchesFound, resultsTruncated, searchComplete, uniqueUnresolvedPaths);
    if (input.requireComplete === true && !searchComplete) {
      return { ...base, status: 'failed', summary: `search incomplete: ${uniqueUnresolvedPaths.length} path(s) unresolved`, failure: {
        code: 'search-incomplete', message: 'the requested search scope was not fully inspected',
        ...(uniqueUnresolvedPaths[0] ? { path: uniqueUnresolvedPaths[0] } : {}) } };
    }
    return { ...base, status: 'succeeded', summary: searchComplete
      ? `searched ${filesSearched} file(s), found ${matchesFound} match(es)`
      : `partial search: inspected ${filesSearched} file(s), found ${matchesFound} match(es)` };
  }

  private expression(input: CodeSearchRequest): RegExp {
    const escaped = input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (input.queryKind === 'regex') return new RegExp(input.query, 'm');
    return input.queryKind === 'symbol' ? new RegExp(`\\b${escaped}\\b`, 'm') : new RegExp(escaped, 'm');
  }

  private baseReport(input: CodeSearchRequest, matches: readonly CodeSearchMatch[], filesDiscovered: number, filesSearched: number, matchesFound: number, resultsTruncated: boolean, searchComplete: boolean, unresolvedPaths: readonly string[]): Omit<CodeSearchReport, 'status' | 'summary' | 'failure'> {
    return { serviceId: input.serviceId, contractVersion: input.contractVersion, workspaceRef: input.workspaceRef, path: input.path,
      query: input.query, queryKind: input.queryKind, matches, filesDiscovered, filesSearched, matchesFound, resultsTruncated, searchComplete, unresolvedPaths };
  }

  private failedReport(input: CodeSearchRequest, failure: CodeSearchFailure): CodeSearchReport {
    return { serviceId: input.serviceId ?? 'code.search', contractVersion: input.contractVersion ?? '1.0.0', status: 'failed',
      workspaceRef: input.workspaceRef ?? '', path: input.path ?? '', query: input.query ?? '', queryKind: input.queryKind ?? 'literal',
      matches: [], filesDiscovered: 0, filesSearched: 0, matchesFound: 0, resultsTruncated: false, searchComplete: false,
      unresolvedPaths: failure.path ? [failure.path] : [], summary: failure.message, failure };
  }

  private failureFrom(error: unknown, fallbackPath: string, fallbackCode: CodeSearchHarnessError['code']): CodeSearchFailure {
    if (error instanceof CodeSearchHarnessError) return { code: error.code, message: error.message, ...(error.path ? { path: error.path } : {}) };
    return { code: fallbackCode, message: error instanceof Error ? error.message : 'code search harness failed', path: fallbackPath };
  }
}
