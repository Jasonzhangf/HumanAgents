/**
 * Shared `WebSearchProvider` adapter — Agent Reach (Monid TinyFish).
 *
 * Design:  docs/architecture/hand-search-websearch-plan.md
 * Evidence: docs/architecture/evidence/tinyfish-search-capability.md
 * Graph:   docs/dagpipe/hand-search-websearch.graph.json (node `backend_search`)
 *
 * Single provider-invocation owner for web search. It implements the one
 * `WebSearchProvider` port owned by `packages/runtime/src/hand/web-search.ts`
 * (the same port `web-search-route.ts` already injects), and binds it to the
 * Agent Reach route, which forwards the query to Monid TinyFish
 * (`monid run -p tinyfish -e /search`). It is shared by the Hand gateway
 * `web.search` service and the Dashboard `web.search` Provider tool; neither of
 * them re-implements provider invocation, and neither of them writes the
 * other's report.
 *
 * Bounded collection contract. It pages `page` 0..pageCeiling and stops at the
 * first page shorter than the per-page bound (observed bound: 10), returning
 * the raw page entries it collected together with `pagesFetched`, `exhausted`
 * and `pageErrors`. It makes no claim of returning every match on the web,
 * because the provider exposes neither a global match count nor a completeness
 * flag. If it stops at the page ceiling with full pages, `exhausted` is false
 * so the caller knows more pages may exist. The entries are raw and
 * unvalidated: the single validator is `WebSearchService`, which owns URL
 * validation, de-duplication, rank normalization and applying `maxResults`.
 *
 * Cancellation. Aborting a local promise does not prove the remote run stopped,
 * so the adapter starts each run without waiting (`monid run ... -j`, no `-w`),
 * keeps the `runId`, calls `monid runs stop -r <runId>` on abort, and polls
 * `monid runs get` to a terminal status. A stop on an already finished run
 * returns `CONFLICT`, which is treated as already settled. A run that never
 * settles within `pollTimeoutMs` becomes a typed `provider-unsettled` failure
 * mapped to `failed`/`reconcile_required`; it is never reported as `cancelled`.
 *
 * Backend configuration is injected from the control plane — provider slug, CLI
 * path, endpoint, page ceiling and poll bounds are read from the then-current
 * source of truth at execution time and are never copied into this repository or
 * into business payloads.
 */

import { spawn } from 'node:child_process';

import type { WebSearchProvider } from '../../../runtime/src/hand/index.js';
import { WebSearchHarnessError } from '../../../runtime/src/hand/web-search.js';

/** Control-plane-injected backend configuration; never a business payload. */
export interface WebSearchProviderBackendConfig {
  readonly provider: string;
  readonly command: string;
  readonly endpoint: string;
  readonly pageCeiling: number;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  readonly purpose?: string;
}

interface MonidRunRecord {
  runId: string;
  status: string;
}

interface MonidRunDetail {
  runId: string;
  status: string;
  output?: { results?: unknown[] } | null;
  error?: { code?: string; message?: string } | null;
}

/**
 * Collect pages from 0..pageCeiling, stopping at the first short page. The
 * provider returns `additionalProperties: false`, so unknown query keys are
 * rejected by the endpoint itself; only the verified keys are sent.
 */
export function createAgentReachWebSearchProvider(
  config: WebSearchProviderBackendConfig,
): WebSearchProvider {
  const pageCeiling = Number.isSafeInteger(config.pageCeiling) && config.pageCeiling >= 0
    ? config.pageCeiling
    : 10;
  const pollIntervalMs = Math.max(100, Math.min(config.pollIntervalMs, 30_000));
  const pollTimeoutMs = Math.max(pollIntervalMs, config.pollTimeoutMs);

  return {
    async search(input) {
      const entries: unknown[] = [];
      const pageErrors: string[] = [];
      let pagesFetched = 0;
      let exhausted = false;

      for (let page = 0; page <= pageCeiling; page += 1) {
        assertSignal(input.signal);
        const pageResult = await fetchPage(config, {
          query: input.query,
          purpose: config.purpose ?? 'web search by HumanAgent',
          page,
          domains: input.domains,
          recency: input.recency,
        }, input.signal, pollIntervalMs, pollTimeoutMs);
        pagesFetched += 1;
        const results = pageResult.results;
        entries.push(...results);
        if (results.length === 0) {
          exhausted = true;
          break;
        }
        if (results.length < PER_PAGE_BOUND) {
          exhausted = true;
          break;
        }
        if (page === pageCeiling) {
          exhausted = false;
          break;
        }
      }

      return { entries, pagesFetched, exhausted, pageErrors };
    },
  };
}

/**
 * Observed per-page bound. A page shorter than this is the only observable
 * completeness signal, because the endpoint exposes no global match count.
 */
const PER_PAGE_BOUND = 10;

interface PageRequest {
  query: string;
  purpose: string;
  page: number;
  domains: readonly string[];
  recency: string;
}

async function fetchPage(
  config: WebSearchProviderBackendConfig,
  request: PageRequest,
  signal: AbortSignal,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<{ results: unknown[] }> {
  assertSignal(signal);
  const started = await startRun(config, request);
  const runId = started.runId;

  signal.addEventListener('abort', () => {
    void runMonid(config.command, ['runs', 'stop', '-r', runId, '-j'], signal)
      .catch(() => undefined);
  }, { once: true });

  const settled = await pollRun(config.command, runId, pollIntervalMs, pollTimeoutMs);
  if (settled === null) {
    throw new WebSearchHarnessError(
      'provider-unsettled',
      `provider run ${runId} did not settle within ${pollTimeoutMs}ms`,
    );
  }
  if (isTerminalFailed(settled.status)) {
    throw new WebSearchHarnessError(
      'provider-failed',
      `provider run ${runId} finished with status ${settled.status}: ${settled.error?.message ?? 'no detail'}`,
    );
  }
  return { results: resultsFromDetail(settled) };
}

async function startRun(config: WebSearchProviderBackendConfig, request: PageRequest): Promise<MonidRunRecord> {
  const queryParams: Record<string, unknown> = {
    query: request.query,
    purpose: request.purpose,
    page: request.page,
  };
  if (request.domains.length > 0) queryParams.include_domains = request.domains.join(',');
  if (request.recency && request.recency !== 'any') queryParams.recency_minutes = recencyMinutes(request.recency);

  const started = await runMonid(
    config.command,
    ['run', '-p', config.provider, '-e', config.endpoint, '--query', JSON.stringify(queryParams), '-j'],
    new AbortController().signal,
  );
  if (started.exitCode !== 0) {
    throw new WebSearchHarnessError(
      'provider-unavailable',
      `provider start failed with exit ${started.exitCode}: ${truncate(started.stderr || started.stdout)}`,
    );
  }
  const record = parseJson<MonidRunRecord>(started.stdout);
  if (!record.runId) {
    throw new WebSearchHarnessError(
      'provider-unavailable',
      `provider start returned no run id: ${truncate(started.stdout)}`,
    );
  }
  return record;
}

async function pollRun(
  command: string,
  runId: string,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<MonidRunDetail | null> {
  const deadline = Date.now() + pollTimeoutMs;
  const probeSignal = new AbortController().signal;
  for (;;) {
    const probe = await runMonid(command, ['runs', 'get', '-r', runId, '-j'], probeSignal).catch(
      () => null,
    );
    if (probe && probe.exitCode === 0) {
      const detail = parseJson<MonidRunDetail>(probe.stdout);
      if (detail.runId && isTerminal(detail.status)) return detail;
    }
    if (Date.now() > deadline) return null;
    await sleep(pollIntervalMs);
  }
}

function runMonid(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs = 180_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function resultsFromDetail(detail: MonidRunDetail): unknown[] {
  const results = detail.output?.results;
  return Array.isArray(results) ? results : [];
}

function isTerminal(status: string | undefined): boolean {
  const value = (status ?? '').toUpperCase();
  return value === 'COMPLETED' || value === 'FAILED' || value === 'CANCELLED' || value === 'STOPPED' || value === 'ERROR' || value === 'TIMEOUT';
}

function isTerminalFailed(status: string | undefined): boolean {
  const value = (status ?? '').toUpperCase();
  return value === 'FAILED' || value === 'ERROR' || value === 'TIMEOUT';
}

function recencyMinutes(recency: string): number {
  switch (recency) {
    case 'day': return 1440;
    case 'week': return 10080;
    case 'month': return 43200;
    case 'year': return 525600;
    default: return 5256000;
  }
}

function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw Object.assign(new Error('web search was stopped before admission'), { name: 'AbortError' });
  }
}

function parseJson<T>(text: string): T {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('provider returned no output');
  return JSON.parse(trimmed) as T;
}

function truncate(text: string): string {
  const value = text.trim();
  return value.length > 400 ? `${value.slice(0, 400)}...` : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}
