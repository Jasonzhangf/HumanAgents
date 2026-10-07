# Production scheduled/recurring occurrence execution wiring

Task: `scheduler-production-wiring-20261006`

Candidate commit: `bfdda7eb90017881123c36f01ed80c6d51c63259`
(branch `codex/interaction-scheduler-production-wiring-20261006`, base merge `b082203`)

## Problem closed

Production persisted a confirmed `scheduled`/`recurring` execution policy and acknowledged the
requirement out of the implicit FIFO inbox, but no production assembly ever executed the plan:
`startUiRuntime` constructed `SubscriptionControlPort` without the `serveTask` argument, so
`consumeExecution` always threw `serve-task-pending`. A plan submitted through the real form was
persisted and never ran when `startAt` arrived.

## Wiring delivered

- `packages/app/src/ui-runtime/scheduler.ts` (new) — `UiRuntimeScheduler`: real-clock due-time
  patrol. One tick resolves the supervisor lease (else the typed `scheduler.lease.unavailable`
  projection), computes `busy` from `listTasks().running`, enumerates active plans, resumes
  `claimed`-but-unsettled occurrences from the persisted claim, schedules the due slot, claims it
  with a fresh deterministic task identity (`executionEpoch: 1`), drives
  `consumeExecution` and settles. Single-flight ticks, unref'd timer, injectable clock/interval.
- `packages/app/src/ui-runtime/occurrence-router.ts` (new) — `OccurrenceConsumerRouter implements
  ServeTaskConsumerPort` with `ownsFirstAdmissionAuthority = true`; memoizes
  `DurableOccurrenceConsumer.forTaskCycle` per immutable binding identity. It resolves the lease
  first and throws `owner-live-unproven` when no lease is active. No fake lease exists.
- `packages/app/src/ui-runtime/occurrence-identity.ts` (new) — the single owner of the bounded
  occurrence identity token (`sha256(value).hex.slice(0, 20)`).
- `packages/app/src/ui-runtime/occurrence-terminal.ts` (new) — verification derived from the really
  committed coordinator checkpoint outcome; throws `checkpoint-missing` /
  `checkpoint-outcome-unknown` instead of inventing a status.
- `packages/app/src/ui-runtime/index.ts` — assembles the router, the `serveTask` argument and the
  scheduler after `hydrate()`; starts the loop only with a lease; stops it first in `close()`.
- `packages/app/src/cli.ts` — passes `lease: () => supervisor?.lease` to the `ui-runtime` stage.
- `packages/app/src/ui-runtime/server.ts` — public `GET /api/runtime/scheduler`; a runtime started
  without a patrol answers the typed `scheduler.unsupported` 501.
- `packages/core/src/subscription.ts` — `assertSettleableTerminalReceipt` accepts verified
  non-success terminals; `assertVerifiedTerminalReceipt` (success path) is byte-identical.
- `packages/runtime/src/subscriptions/index.ts` — `SubscriptionControlPort.list()` reads the same
  snapshot truth; both settlement call sites use the new assertion.

## Two real defects found and fixed

1. **Journal `commitId` overflow.** `checkpointCommitId()` composes
   `checkpoint:<organ>:<task>:<cycle>:<operation>:<checkpointId>` and the JSONL journal validates it
   against a 256-character grammar. The first implementation composed readable ids from the raw
   occurrence id (which contains `::` and a full draft UUID); measured lengths were 269, 409 and 409.
   The admission committed, the terminal checkpoint commit always threw
   `JournalIntegrityError('invalid journal commitId')`, and later ticks failed with `in-progress`.
   Fix: one owner for a 20-hex token. Measured on the real run: the committed commitId is
   `checkpoint:humanagent-ui:scheduled-task-6a62d3276682e472be52:8cd56b4ca07f69575ca5:scheduled-operation-6a62d3276682e472be52:4582d3a847e2b6204622`
   = 143 characters, and it is identical across independent runs because the token is a pure
   function of the occurrence identity.
2. **Stale-snapshot double consume.** `patrolPlan` reads the snapshot once per tick; step 1 consumed
   and settled a claimed occurrence, then step 2 re-consumed the same stale `claimed` occurrence and
   inflated the `executed`/`settled` counters (provider starts and settlements stayed correct because
   both port calls are idempotent). Fix: a tick-local `consumed` set checked in step 2.

## Gates (candidate `bfdda7eb90017881123c36f01ed80c6d51c63259`)

| Command | Result |
| --- | --- |
| `pnpm build:app` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test:app` | 347 tests / 347 pass / 0 fail, exit 0 |
| `pnpm test:runtime` | 482 / 482 pass and 22 / 22 pass, exit 0 |
| `pnpm test:ui` | 45 / 45 pass, exit 0 |
| `pnpm test:release` | 43 / 43 pass, exit 0 |
| `pnpm dagpipe:validate` | exit 0, 12 graphs validated |
| `git diff --check` | exit 0 |
| `node --test dist/tests/tests/app/scheduler-production-wiring.test.js` | 6 / 6 pass, exit 0 (3 consecutive runs) |
| `node tests/app/scheduler-production-wiring-rcc-e2e.mjs` | exit 0 |

### Black-box acceptance cases

`tests/app/scheduler-production-wiring.test.ts` drives the real HTTP entry, the real supervisor
lease, the real `DurableOccurrenceConsumer`, the real journal and the real clock; only the provider
port is the sanctioned fake-mode replay port.

1. scheduled plan fires only at `startAt` (no claim, execution or settlement before it; exactly one
   after; dashboard `succeeded`; journal exactly 1 admission + 1 checkpoint + 1 receipt);
2. non-success terminal (`blocked`) settles as `blocked` without weakening the success path;
3. restart over the same control root replays and never dispatches a second execution;
4. recurring `intervalMinutes: 1` plan executes 2 distinct occurrences, each exactly once;
5. no lease → no loop, typed fail-closed reason, zero dispatches;
6. busy runtime + `busyPolicy: 'skip'` → occurrence `skipped-busy`, never claimed, never settled,
   no second provider start.

### Real RCC 4444 same-entry E2E

`node tests/app/scheduler-production-wiring-rcc-e2e.mjs` spawns the built CLI `serve --mode rcc`
(the supervisor-owned serve entry), pairs through the real `pair` command, confirms a `scheduled`
policy through the public HTTP form, and proves the due-time execution end to end.
Receipt: `dist/receipts/scheduler-production-wiring-rcc-proof.json`.

- RCC `http://127.0.0.1:4444` health `ok`, version 3, build `0.90.4837`; serve stages
  `cordis-host`, `serve-runtime`, `ui-runtime`.
- No execution before `startAt` (zero settlements, zero executed, no `scheduled-task-*` task).
- Plan `subscription:requirement:draft-2:1` active; occurrence
  `subscription:requirement:draft-2:1::1::1` settled with `verificationStatus: success` and
  `settlementReceiptRef: occurrence-settlement/v1:subscription:requirement:draft-2:1::1::1:1`.
- Patrol projection `claimed 1 / executed 1 / settled 1 / skipped 2`.
- Task `scheduled-task-6a62d3276682e472be52` listed publicly, dashboard `succeeded`, checkpoint
  outcome `succeeded`; 41 real provider evidence files on disk.
- Consumer journal (3 records, replayed through `JsonlOrganJournal`):
  1 admission (`occurrence-execution-admission`), 1 checkpoint (outcome `succeeded`) and 1 receipt
  (`occurrence-terminal-receipt`, verification `success`).

## What is NOT proven

1. `pnpm test:app` does not include the 6 new cases: `package.json` is outside this task's allowed
   write paths. They are run as their own command (exit 0, 6/6). One-line follow-up for an owner with
   that scope: add `tests/app/scheduler-production-wiring.test.js` to the hardcoded `test:app` list.
2. Non-success settlement is proven for `blocked` only. `failed`, `rejected`, `cancelled` and
   `missing` settlement paths are not exercised end-to-end.
3. Restart duplication is proven for a settled occurrence. A claimed but never settled occurrence
   whose owner is still live is rejected as `in-progress` and deliberately not re-dispatched, so an
   in-process unknown-outcome stall never self-heals.
4. A patrol interval greater than about one second can miss `latePolicy: 'skip'` slots because the
   port's due grace is one second. The default 1000 ms is correct; other intervals are a design gap.
5. `dueTimes`/`policySlotOrdinal` are O(total slots) per tick: a performance risk for long-running
   recurring plans, not a correctness gap.
6. `packages/runtime/src/explicit-brain/scheduler-patrol.ts` still exists with overlapping
   single-`dueAt`/`serve-task-pending` semantics and is unused by production; it needs a separate
   ablation (outside this task's write scope).
7. No subscription control (pause/resume/cancel-future) HTTP entry exists. The
   `subscription-control` graph records `PARTIAL` and leaves `accept_subscription_control_request`
   honestly pending.
