import type { AgentIoEventBudget } from '../agent-io/types.js';
import type { ProviderEvent, ProviderRequestLifecycleEvent } from '../../../contracts/src/index.js';

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

/**
 * Provider event kinds that represent a completed content unit, a tool call, a
 * provider terminal state or a provider error. Streamed partials are `model`
 * activity and never progress, so a content unit that only ever streams stays
 * outside the progress clock.
 */
const PROGRESS_PROVIDER_EVENT_KINDS: ReadonlySet<ProviderEvent['kind']> = new Set([
  'output',
  'tool',
  'terminal',
  'error',
]);

function isProgressProviderEvent(event: Pick<ProviderEvent, 'kind'>): boolean {
  return PROGRESS_PROVIDER_EVENT_KINDS.has(event.kind);
}

/** The concrete declared timer an attempt exhausted, for honest diagnostics. */
function budgetExhaustionReason(
  budget: AgentIoEventBudget,
  turnStartedAtMs: number,
  lastActivityAtMs: number,
  lastProgressAtMs: number,
  nowMs: number,
): string | undefined {
  if (budget.noProgressAtMs !== undefined && nowMs - lastProgressAtMs >= budget.noProgressAtMs) {
    return `no completed content unit within ${budget.noProgressAtMs}ms while the request kept streaming`;
  }
  if (nowMs - lastActivityAtMs >= budget.maxSilentDurationMs) {
    return `no provider event within ${budget.maxSilentDurationMs}ms`;
  }
  if (nowMs - turnStartedAtMs >= budget.maxTurnDurationMs) {
    return `request exceeded the ${budget.maxTurnDurationMs}ms turn duration`;
  }
  return undefined;
}

/**
 * Wraps one provider observation stream with the declared request budget. The
 * declared timers are bounded by the real Provider request/turn identity the
 * Provider binding reports on each event, not by the whole composition observe
 * stream: a task that issues several confirmed requests, each inside its own
 * budget, is never stopped for their cumulative wall time. The typed
 * `dispatching`/`dispatched` lifecycle opens a request budget and the terminal
 * phases close it; inter-request tool or orchestration waits are not provider
 * silence. Until the first identity arrives the submitted request owns the
 * clock, so a silent stream is still stopped. Events without a reported
 * identity never restart the clock, so a single open request still exhausts
 * the turn/no-progress timers.
 *
 * The pending iterator step is kept across deadlines, so waiting for a
 * deadline never starts a second concurrent read on the same stream.
 */
export class BudgetedProviderObservations<TObservation> {
  private pending: Promise<IteratorResult<TObservation>> | undefined;
  /** Provider-reported request identity (`requestId`, else `turnId`). */
  private requestBoundary: string | undefined;
  private requestStartedAtMs: number;
  private requestOpen: boolean;
  private lastActivityAtMs: number;
  private lastProgressAtMs: number;
  /**
   * Resolves when the typed Provider request lifecycle changes. A closed
   * request has no armed deadline, so a later dispatch must wake the pending
   * observation wait instead of leaving it blocked until the next delta.
   */
  private lifecycleWaiter: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;

  constructor(
    private readonly iterator: AsyncIterator<TObservation>,
    private readonly budget: AgentIoEventBudget,
    private readonly nowMs: () => number,
  ) {
    const now = nowMs();
    // The submitted request owns this clock until a Provider event reports its
    // own request identity; a silent stream must still be stopped by silence.
    this.requestStartedAtMs = now;
    this.requestOpen = true;
    this.lastActivityAtMs = now;
    this.lastProgressAtMs = now;
  }

  exhausted(): string | undefined {
    // No request is open between a Provider-reported terminal and the next
    // typed dispatch. A real tool or orchestration wait belongs to neither
    // request, so it must not be charged to the previous request's silence.
    if (!this.requestOpen) return undefined;
    const now = this.nowMs();
    return budgetExhaustionReason(
      this.budget,
      this.requestStartedAtMs,
      this.lastActivityAtMs,
      this.lastProgressAtMs,
      now,
    );
  }

  async next(): Promise<
    | { readonly kind: 'observation'; readonly step: IteratorResult<TObservation> }
    | { readonly kind: 'deadline' }
  > {
    this.pending ??= this.iterator.next();
    const now = this.nowMs();
    const latestDeadline = this.requestOpen
      ? Math.min(
          this.lastActivityAtMs + this.budget.maxSilentDurationMs,
          this.requestStartedAtMs + this.budget.maxTurnDurationMs,
          ...(this.budget.noProgressAtMs === undefined
            ? []
            : [this.lastProgressAtMs + this.budget.noProgressAtMs]),
        )
      : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = latestDeadline === undefined
      ? undefined
      : new Promise<{ readonly kind: 'deadline' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'deadline' }), Math.max(1, latestDeadline - now));
        });
    try {
      const step = await Promise.race([
        this.pending.then((result) => ({ kind: 'observation' as const, step: result })),
        this.lifecycleChanged().then(() => ({ kind: 'deadline' as const })),
        ...(deadline === undefined ? [] : [deadline]),
      ]);
      if (step.kind === 'observation') this.pending = undefined;
      return step;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  note(event: Pick<ProviderEvent, 'kind' | 'requestId' | 'turnId'>): void {
    const now = this.nowMs();
    const boundary = event.requestId ?? event.turnId;
    if (boundary !== undefined && boundary !== this.requestBoundary) {
      // A confirmed new Provider request opens its own budget window. The
      // first boundary keeps the submitted-request start, so a first request
      // that only stays silent is still charged to the declared silence timer.
      const firstBoundary = this.requestBoundary === undefined;
      this.requestBoundary = boundary;
      this.requestOpen = true;
      if (!firstBoundary) {
        this.requestStartedAtMs = now;
        this.lastProgressAtMs = now;
      }
    }
    this.lastActivityAtMs = now;
    if (isProgressProviderEvent(event)) this.lastProgressAtMs = this.lastActivityAtMs;
    // A terminal state closes the reported request. The next typed dispatch,
    // or a new event identity when lifecycle reporting is unavailable, starts
    // a fresh window.
    if (event.kind === 'terminal') this.requestOpen = false;
  }

  /**
   * Applies the typed Provider request lifecycle. `dispatching` and
   * `dispatched` are open; every terminal phase closes the request. A new
   * request identity, or a dispatch after a closed window, opens a fresh
   * budget. This is the same report the runtime exposes as
   * `requestIdentity`, never a log or summary inference.
   */
  noteLifecycle(event: Pick<ProviderRequestLifecycleEvent, 'requestId' | 'phase'>): void {
    const now = this.nowMs();
    const newIdentity = event.requestId !== this.requestBoundary;
    if (newIdentity) this.requestBoundary = event.requestId;
    if (event.phase === 'dispatching' || event.phase === 'dispatched') {
      if (newIdentity || !this.requestOpen) {
        this.requestStartedAtMs = now;
        this.lastActivityAtMs = now;
        this.lastProgressAtMs = now;
      }
      this.requestOpen = true;
    } else {
      this.requestOpen = false;
    }
    this.signalLifecycleChanged();
  }

  private lifecycleChanged(): Promise<void> {
    if (this.lifecycleWaiter === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((settle) => { resolve = settle; });
      this.lifecycleWaiter = { promise, resolve };
    }
    return this.lifecycleWaiter.promise;
  }

  private signalLifecycleChanged(): void {
    const waiter = this.lifecycleWaiter;
    this.lifecycleWaiter = undefined;
    waiter?.resolve();
  }

  async close(): Promise<void> {
    this.signalLifecycleChanged();
    if (this.pending === undefined) return;
    const pending = this.pending;
    this.pending = undefined;
    // A stalled provider stream may never resume its pending read, so closing
    // the stream must never block the stop that is already settling it.
    pending.catch(() => undefined);
    void this.iterator.return?.(undefined).catch(() => undefined);
  }
}
