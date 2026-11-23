export type CallUsageInput = {
  readonly callId: string;
  readonly turnId: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly contextLimit?: number;
  readonly elapsedMs?: number;
  readonly measuredOutputMs?: number;
};

export type CallUsageProjection = {
  readonly callId: string;
  readonly turnId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly context: { readonly used: number | null; readonly limit: number | null; readonly percent: number | null };
  readonly currentCallCacheHitRate: number | null;
  readonly previousCallCacheHitRate: number | null;
  readonly previousBusinessTurnCacheHitRate: number | null;
  readonly taskCacheHitRate: number | null;
  readonly outputSpeed: { readonly tokensPerSecond: number | null; readonly basis: 'response-elapsed' | 'generation-elapsed' };
};

export type CallUsageRead = {
  readonly calls: readonly CallUsageProjection[];
  readonly coverage: { readonly calls: number; readonly callsWithKnownInput: number; readonly callsWithKnownCacheRead: number };
};

function validCount(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
}

function hitRate(rows: readonly CallUsageInput[]): number | null {
  const known = rows.filter((row) => validCount(row.inputTokens) !== null && validCount(row.cacheReadTokens) !== null);
  const input = known.reduce((sum, row) => sum + validCount(row.inputTokens)!, 0);
  const cacheRead = known.reduce((sum, row) => sum + validCount(row.cacheReadTokens)!, 0);
  return known.length === 0 ? null : ratio(cacheRead, input);
}

export function projectCallUsage(rows: readonly CallUsageInput[]): CallUsageRead {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.callId.trim() || !row.turnId.trim()) throw new Error('call usage identity must be non-empty');
    if (seen.has(row.callId)) throw new Error(`duplicate call usage identity: ${row.callId}`);
    seen.add(row.callId);
  }
  const ordered = [...rows];
  const calls = ordered.map((row, index): CallUsageProjection => {
    const inputTokens = validCount(row.inputTokens);
    const outputTokens = validCount(row.outputTokens);
    const cacheReadTokens = validCount(row.cacheReadTokens);
    const cacheWriteTokens = validCount(row.cacheWriteTokens);
    const contextLimit = validCount(row.contextLimit);
    const used = inputTokens;
    const previousCall = index === 0 ? [] : [ordered[index - 1]!];
    const previousTurnId = [...ordered.slice(0, index)].reverse().find((candidate) => candidate.turnId !== row.turnId)?.turnId;
    const previousTurn = previousTurnId === undefined ? [] : ordered.slice(0, index).filter((candidate) => candidate.turnId === previousTurnId);
    const taskRows = ordered.slice(0, index + 1);
    const elapsedMs = validCount(row.measuredOutputMs) ?? validCount(row.elapsedMs);
    return {
      callId: row.callId,
      turnId: row.turnId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      context: { used, limit: contextLimit, percent: ratio(used, contextLimit) === null ? null : ratio(used, contextLimit)! * 100 },
      currentCallCacheHitRate: hitRate([row]),
      previousCallCacheHitRate: hitRate(previousCall),
      previousBusinessTurnCacheHitRate: hitRate(previousTurn),
      taskCacheHitRate: hitRate(taskRows),
      outputSpeed: {
        tokensPerSecond: outputTokens === null || elapsedMs === null || elapsedMs === 0 ? null : outputTokens * 1000 / elapsedMs,
        basis: row.measuredOutputMs === undefined ? 'response-elapsed' : 'generation-elapsed',
      },
    };
  });
  return {
    calls,
    coverage: {
      calls: rows.length,
      callsWithKnownInput: calls.filter((call) => call.inputTokens !== null).length,
      callsWithKnownCacheRead: calls.filter((call) => call.cacheReadTokens !== null).length,
    },
  };
}
