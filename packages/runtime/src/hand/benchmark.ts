import type { CodeSearchReport, CodeSearchRequest } from '../../../contracts/src/index.js';
import { CodeSearchService } from './code-search.js';

export interface CodeSearchBenchmarkCase { readonly caseId: string; readonly request: CodeSearchRequest; readonly assert: (report: CodeSearchReport) => readonly string[]; }
export interface CodeSearchBenchmarkCaseResult { readonly caseId: string; readonly passed: boolean; readonly durationMs: number; readonly report: CodeSearchReport; readonly failures: readonly string[]; }
export interface CodeSearchBenchmarkResult { readonly total: number; readonly passed: number; readonly failed: number; readonly totalDurationMs: number; readonly cases: readonly CodeSearchBenchmarkCaseResult[]; }

/** Deterministic service self-check; timing is observed, not a correctness gate. */
export async function runCodeSearchBenchmark(service: CodeSearchService, cases: readonly CodeSearchBenchmarkCase[]): Promise<CodeSearchBenchmarkResult> {
  const startedAt = performance.now();
  const results: CodeSearchBenchmarkCaseResult[] = [];
  for (const benchmarkCase of cases) {
    const caseStartedAt = performance.now();
    const report = await service.execute(benchmarkCase.request);
    const failures = benchmarkCase.assert(report);
    results.push({ caseId: benchmarkCase.caseId, passed: failures.length === 0, durationMs: performance.now() - caseStartedAt, report, failures });
  }
  const passed = results.filter((result) => result.passed).length;
  return { total: results.length, passed, failed: results.length - passed, totalDurationMs: performance.now() - startedAt, cases: results };
}
