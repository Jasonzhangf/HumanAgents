# Durable occurrence consumer — author verification (2026-10-05)

Status: **AUTHOR VERIFICATION — candidate handed to parent for independent review
and composition.** This is not a self-review, not a merge, and not an
independent PASS.

## Identity and inputs

- task/worker: `durable-occurrence-consumer-completion-20261005`
- cwd: `/Volumes/Intel/playground/humanagent/interaction-durable-consumer-correction-20261005`
- branch: `codex/interaction-durable-consumer-correction-20261005`
- clean input HEAD: `5d14d3df557e0253279baad55a357634d7968e4b`
- admitted inputs already in history: fresh `origin/main` `22d8268`, admitted G
  `16c4d19` (`22d8268` is an ancestor of the input HEAD; ordinary merge, exit 0).
- candidate: the commit that adds this document on top of the input HEAD.
- record root:
  `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/durable-occurrence-consumer-completion-20261005`

## Changed files

- `packages/runtime/src/subscriptions/ports.ts` — minimal public
  `ServeTaskConsumerPort` / `OccurrenceClaimRecord` typed boundary.
- `packages/app/src/ui-runtime/occurrence-consumer.ts` — the single app-owned
  durable consumer implementation.
- `tests/app/durable-occurrence-consumer-public.test.ts` — public real-disk /
  real-process acceptance harness (10 tests).
- `tests/app/durable-occurrence-consumer-rcc-e2e.mjs` — real RCC 4444 provider
  consumer acceptance (success + real stop).

## Owner and contract decisions

- Authoritative binding is derived from the persisted `OccurrenceClaimRecord`
  (claim + policy); the requested binding is derived from the `Occurrence`.
  Both are passed to core `decideOccurrenceAuthority`, so a caller self-reported
  binding is never reused as authority.
- `SupervisorLease.withCurrentDaemonOwner` is the only caller authentication.
  Admission, terminal, and recovery Journal mutations all happen inside that
  guard. Public record/claim/PID/log fields are never treated as authority.
- Domain decisions reuse core `decideOccurrenceAuthority` and
  `decideOccurrenceTerminalReceipt`; the consumer adds no second registry,
  lease, token, or store.
- Persistence uses the real `JsonlOrganJournal` and `FileCheckpointStore` on the
  same task-cycle file. The receipt key is only
  `occurrenceTerminalReceiptCommitId(binding)`; result/release proofs stay inside
  the committed fact, so a different receipt fact under the same key is rejected
  by `JournalCommitConflictError`.
- Checkpoint is lifecycle truth and the typed receipt is the verification fact.
  The checkpoint commits first; a crash between the two leaves a visible
  recovery-pending window and never returns verified success.

## Author commands (real exits)

Raw outputs: record root `raw/`.

| command | exit | evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | run once to populate `node_modules`; not captured as raw (`node_modules` is the observable proof) |
| `pnpm exec tsc -p packages/contracts/tsconfig.json` | 0 | `raw/contracts.{stdout,stderr,exit}` |
| `pnpm exec tsc -p tests/app/tsconfig.json` | 0 | `raw/compiler.{stdout,stderr,exit}` |
| `node --test dist/tests/tests/app/durable-occurrence-consumer-public.test.js` | 0 | `raw/public-test.*` — TAP `1..10`, `# pass 10`, `# fail 0` |
| `node tests/app/durable-occurrence-consumer-rcc-e2e.mjs` | 0 | `raw/rcc-e2e.*` |
| `pnpm typecheck` | 0 | `raw/typecheck.{stdout,stderr,exit}` |
| `git diff --check` | 0 | no output |

## Public black-box coverage (`tests/app/durable-occurrence-consumer-public.test.ts`)

Real consumer entry, real on-disk `JsonlOrganJournal` / `FileCheckpointStore`,
real `SupervisorLease`, real OS child processes, and a real file side effect. No
private-map or source-string assertions.

1. First admission dispatches exactly once and commits one paired checkpoint +
   typed receipt with the admitted owner bound to the live lease.
2. A mismatched requested occurrence cannot mutate or dispatch against the
   authoritative claim.
3. Replay on the same port, a new port, and a new OS process never dispatches
   again; the replayed receipt equals the committed receipt.
4. Admission append failure leaves no admission record and dispatches zero
   times.
5. Receipt append failure stays `durable-unverified-recovery-pending`; the
   checkpoint is committed, no receipt is committed, and success is never
   returned.
6. A different receipt fact under the same binding key is rejected by
   `JournalCommitConflictError`; the first record is preserved and replay still
   returns it.
7. A second process cannot turn copied readable owner fields into authority and
   writes nothing.
8. A crashed owner is replaced and the committed replacement writes one blocked
   recovery receipt without redispatch or rebind.
9. Live stale A after a committed replacement cannot write; B recovers without
   rebind or dispatch.
10. Success, failed, rejected, missing, blocked, and cancelled terminals each
    persist a paired receipt; non-success terminals carry a recovery inventory.

## Real RCC 4444 provider evidence (`tests/app/durable-occurrence-consumer-rcc-e2e.mjs`)

The harness drives the public consumer over the existing provider/business seam
(`buildRccExecutionPort` = `ProviderAdapter` + `V3ProviderHttpTransport`, driven
by the real `ProviderAgentDriver`) against the live RCC endpoint. Provider
evidence is projected onto the consumer task scope with the same re-scope pattern
the serve orchestration seam uses; source/locator/digest are preserved.

- RCC health: `GET http://127.0.0.1:4444/health` → HTTP 200, `status=ok`,
  `build_version=0.90.4832` (liveness only, not business acceptance).
- success case (`model=gpt-5.5`): provider settlement `succeeded` → receipt
  `status=success`, `terminalOutcome=succeeded`; `admissionCount=1`,
  `checkpointCount=1`, `receiptCount=1`, `evidenceFileCount=8` real provider
  evidence artifacts on disk.
- non-success case (real operator stop): the live RCC stream is requested to
  stop and then settled; provider settlement `cancelled` → receipt
  `status=cancelled`, `terminalOutcome=cancelled`; `admissionCount=1`,
  `checkpointCount=1`, `receiptCount=1`, `evidenceFileCount=9`. The non-success
  terminal is never rewritten into a success.
- both cases delete their own fixture root and assert physical absence.

Note: the live RCC endpoint routes an unknown model to a default model and
returns 200, so an unknown model is not a real failure. The non-success path is
therefore a real stop/settle terminal, which is the contract-required cancel
path.

## Cleanup and resource ownership

- The harness removes its own temp fixture roots and asserts absence.
- No daemon install, restart, or lifecycle action was taken; no merge or push
  was performed.
- The candidate worktree, build output, and raw evidence are retained for
  parent review and composition.

## Not claimed

- No independent architecture review, no merge, no push, no scheduler
  integration, no installed runtime, and no formal UI/browser acceptance.
- Provider auto-resume is still unsupported; replacement recovery writes a
  blocked recovery receipt, not a resumed execution.
