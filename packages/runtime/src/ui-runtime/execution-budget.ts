import type { AgentIoEventBudget } from '../agent-io/types.js';

/**
 * The request budget the UI runtime enforces on one observed provider request.
 *
 * Two layers judge the same provider request:
 *
 * 1. The Provider transport ends real silence. `rcc-v3-transport.ts` declares a
 *    120s no-progress budget and ends the stream with the typed
 *    `stream.no-progress` error when no bytes arrive for that long. Production
 *    confirmed it: a real RCC stream that advances one delta every ~2.4s runs
 *    for minutes without ever tripping it, and a stream that stops writing is
 *    ended in bounded time.
 * 2. This budget is the final backstop for the case where the provider keeps
 *    writing but never finishes a unit, or where the observation path itself
 *    stalls. It must therefore be strictly looser than the transport judgement:
 *    a tighter value would kill a request the transport would have carried to
 *    completion, which replaced one production mis-kill with another.
 *
 * The values come from production measurements, not from the agent-io protocol
 * defaults in `DEFAULT_AGENT_IO_POLICY` (30s silence / 120s turn / 90s
 * no-progress). Those remain the declared DSH agent-io semantics and are not
 * changed here.
 */
export const DEFAULT_UI_EXECUTION_EVENT_BUDGET: AgentIoEventBudget = {
  /**
   * 300s of no provider event at all. The transport already ends a byte-silent
   * stream at 120s, so 300s leaves 2.5x of head room and can only fire when the
   * transport watchdog itself never armed or never saw the stall. A long model
   * prefill that produces no SSE bytes for a while is far below this bound.
   */
  maxSilentDurationMs: 300_000,
  /**
   * 600s without a completed content unit (an output, a tool call, a terminal
   * state or a provider error). The longest single unit observed in production
   * streamed for 119.3s, so this is more than 5x that unit and still less than
   * the per-request ceiling below. Streamed partials are activity, not
   * progress, so a unit that only ever drips bytes is still bounded, just far
   * later than any legitimate stream.
   */
  noProgressAtMs: 600_000,
  /**
   * 1800s per provider request. This is the final anti-hang ceiling only, never
   * a progress criterion: production measured a single RCC request that ran for
   * 26 minutes, and this leaves 30 minutes before the runtime gives up.
   */
  maxTurnDurationMs: 1_800_000,
};
