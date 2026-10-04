# Interaction Scheduler Author Evidence (2026-10-04)

Scope: HumanAgent W2 interaction-scheduler author correction. This revision records the
R3 correction of three independent R3 behavior findings on top of the committed R2
candidate `d37a0ff29ba50a6bc540b4287b76d2dfaf3c5629`, followed by the R3 lineage
admission correction on top of `046664ac871da6e555c2e4f0dee1f4ac6b0dd0d0`. It is
candidate evidence only; W3 real serve-task execution remains pending.

## Source Input

- Worktree: `/Volumes/Intel/playground/humanagent/interaction-scheduler-implementation-20261003`
- Branch: `codex/interaction-scheduler-implementation-20261003`
- R3 input HEAD: `d37a0ff29ba50a6bc540b4287b76d2dfaf3c5629`
- R3 input tree: `65de543f65378b4c9df9165a4117f39531a4965f`
- Lineage correction input HEAD: `046664ac871da6e555c2e4f0dee1f4ac6b0dd0d0`
- Lineage correction input tree: `a85bb58d889fa52aef3f79a87674cec007c7f630`
- Parent origin/main at transfer: `0020ab4f4442ea59bf4b9fc02416a8a77c6c68ed`
- Node: `v22.22.2`; pnpm: `10.31.0`
- Correction window: input bound `2026-10-04T10:26:26Z`; final gate pass `2026-10-04T11:26:38Z`
- Lineage correction window: input bound `2026-10-04T11:43:10Z`; final compiled gate pass
  `2026-10-04T12:13:43Z`

## Changed Files (current candidate)

- `packages/core/src/subscription.ts`
- `packages/runtime/src/subscriptions/index.ts`
- `tests/runtime/subscriptions/public-consumer.test.ts`
- `docs/verification/interaction-scheduler-author-evidence-2026-10-04.md` (this receipt)

## R3 Findings Addressed

1. Same-policy pause/resume lost deterministic slot progress. Pause invalidated the
   current-revision due/reminder-pending unclaimed occurrence but kept
   `currentOccurrenceOrdinal`, so resume plus `nextOccurrence` regenerated the superseded
   slot under a new `scheduleRevision`. Core now advances `currentOccurrenceOrdinal` past
   the invalidated unclaimed occurrences of the unchanged policy on pause
   (`preserveSamePolicyControlProgress`); `modify` keeps its distinct replacement reset.
2. Same-policy in-flight settlement lost progress across pause/resume. Settlement advanced
   progress only when `claim.scheduleRevision` equalled the current revision, so pause and
   resume (which bump the revision without replacing the policy) dropped consumed progress
   and could duplicate or fail to exhaust a `maxOccurrences` policy. Core now compares the
   claim `policyHash` to the current policy hash (`preserveSamePolicyClaimProgress`):
   same-policy in-flight completion preserves progress and limits, while a claim from
   before a replacement `modify` cannot advance the replacement policy.
3. `consumeExecution` corrupted committed slot input by reconstructing the occurrence with
   `dueAt = claim.acquiredAt`. The runtime now reads the persisted occurrence from the
   already located snapshot and passes its committed fields (with `state: 'claimed'`),
   preserving `dueAt` and occurrence identity through late claim and restart replay.

The lifecycle decision for (1) and (2) lives in `packages/core`; the runtime persists the
core result and dispatches the committed occurrence. No second progress counter, log or
payload heuristic was added.

## Source And Compiled Hashes (historical R3 commit 046664a)

Source:

- `packages/core/src/subscription.ts`: `131cade849819c86ae74f690183e8ca09427ff956b69ca23cd284cd211a7cbfd`
- `packages/runtime/src/subscriptions/index.ts`: `a4c85f37124a27a8097e6f21f6bd5c123404034c1ae9572394379b373cfc1dba`
- `tests/runtime/subscriptions/public-consumer.test.ts`: `639b42c15efdcbe420cf3c0610d88848668afdab07e79435032eade63f01ac4e`
- `tests/runtime/subscriptions/subscriptions.test.ts` (unchanged in R3): `ed015843070df6f39f256d437a71486efecac15de585b6aad46fe7f1db0f5781`
- `packages/core/src/index.ts` (unchanged in R3): `54a3005a83b30ca53378767ba27f00e22c6e8bb8a22e26a7942548b125dad402`

Compiled (after `pnpm build`):

- `dist/tests-runtime-subscriptions/packages/core/src/subscription.js`: `0d1b29b922c19dfcbc9686f9f00a6695493165c738317dbd0a496698ea9ff52b`
- `dist/tests-runtime-subscriptions/packages/runtime/src/subscriptions/index.js`: `7709ebd0b263e8555ce0d8db1d6f82c4b30bdd1696236c2adf6ebbc99085ecd3`
- `dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js`: `ce8bfce1212e9076c9062a3b833793e60beda641805b4cbc5d3e8a6b13870fe3`
- `dist/tests-runtime-subscriptions/tests/runtime/subscriptions/subscriptions.test.js`: `ce2a71d48fe1ebfc9484d02494899d038bf4a7704803ac0058887992d488ba6b`
- `dist/tests-explicit-brain/packages/runtime/src/explicit-brain/scheduler-patrol.js`: `a05b1ea7ccf168388dd31b7873fb6c7036cc91cd394710844b0cbd1d418d166d`
- `dist/tests-explicit-brain/tests/runtime/explicit-brain/explicit-brain.test.js`: `b40e4bc149f80a141507107b97d7cf00825f78fe1ae830d13dc86e437377723f`

### Lineage admission correction hashes (precommit candidate)

Source:

- `packages/core/src/subscription.ts`: `691c846ab7001f4b0faf7903bf1044c7d17b583131113caf3e7a7ddbfe57d7f8`
- `packages/runtime/src/subscriptions/index.ts`: `5b7ada3ece9d6ddc0e7cd50d466913a18ceec4634717a3336355d08e6deff398`
- `tests/runtime/subscriptions/public-consumer.test.ts`: `7a93e92eb76a4bddfd841d1bf4a72e99ff94669a7f63a35199c9b3f63de300d7`
- `tests/runtime/subscriptions/subscriptions.test.ts` (unchanged): `ed015843070df6f39f256d437a71486efecac15de585b6aad46fe7f1db0f5781`
- `packages/core/src/index.ts` (unchanged): `54a3005a83b30ca53378767ba27f00e22c6e8bb8a22e26a7942548b125dad402`

Compiled after `pnpm exec tsc -p tests/runtime/subscriptions/tsconfig.json` and the
maintained build:

- `dist/tests-runtime-subscriptions/packages/core/src/subscription.js`: `603d4decd1d5eb25eb91a5fe2347928fdda53a5145a0295739663210d7ba0170`
- `dist/tests-runtime-subscriptions/packages/runtime/src/subscriptions/index.js`: `e31012c2847ef547533b42a801ccd40c3bd5e3ba749c9e913b68ee5f8f7fccaf`
- `dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js`: `d4321d5aaeeb9bea6e04a07376543e13f73e748a9b079b9a40ec963077bdd2c4`
- `dist/tests-runtime-subscriptions/tests/runtime/subscriptions/subscriptions.test.js` (unchanged): `ce2a71d48fe1ebfc9484d02494899d038bf4a7704803ac0058887992d488ba6b`

## Public RED (R3)

- Command actually executed: `pnpm exec tsc -p tests/runtime/subscriptions/tsconfig.json`
  then `node --test dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js`
  (the public-consumer suite only).
- Result: exit 1; 29 tests, 26 pass, 3 fail, 0 cancelled, 0 skipped, 0 todo.
- Failures map one-to-one to the R3 findings:
  - `public late execution receives the committed occurrence due time` (finding 3),
  - `public same-policy pause and resume preserve in-flight settlement progress` (finding 2),
  - `public pause and resume preserve deterministic progress for superseded slots` (finding 1).
- Raw: `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r3-author-correction/raw/red-public-2.log`
- Raw compile boundary: `.../scheduler-r3-author-correction/raw/red-compile-2.log`

Predecessor R2 RED documentation correction: the earlier receipt prose listed both the
public-consumer and subscriptions suites as the R2 RED command, but the command actually
executed for R2 ran `public-consumer.test.js` only (26 tests, 20 pass, 6 fail, exit 1;
raw `.../scheduler-r2-author-correction/raw/red-public.log`). This receipt states the
commands actually executed and does not claim any additional run.

## Focused GREEN (R3)

- Command: `pnpm exec tsc -p tests/runtime/subscriptions/tsconfig.json` then
  `node --test dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js dist/tests-runtime-subscriptions/tests/runtime/subscriptions/subscriptions.test.js`.
- Result: exit 0; 47 tests, 47 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo
  (29 public-consumer plus 18 direct subscription tests).
- Raw: `.../scheduler-r3-author-correction/raw/final-focused-run.log`
- Raw compile boundary: `.../scheduler-r3-author-correction/raw/final-focused-compile.log`

Public behavior covered by R3: a late claim acquired at `03:30` for a `03:00` slot reaches
the execution consumer with the committed `dueAt = 03:00` and the same value after reopen;
`claim -> pause -> settle -> resume` keeps `currentOccurrenceOrdinal` at 1 and advances the
next slot to ordinal 2; `claim -> pause -> resume -> settle` on a `maxOccurrences=1` policy
exhausts the subscription, rejects regenerating the consumed ordinal, and survives restart;
`pause -> resume` after a materialized due slot and a `reminder-pending` slot advances
progress past both, rejects rescheduling the superseded ordinal, and yields the next legal
slot after restart. Existing busy/late/DST/bounded-policy/replace-policy/max/end/
claim-fence/replay/cancel tests are retained unchanged.

## R3 Lineage Admission Correction

The predecessor's public reproduction is retained as failure evidence. Two executions of
the same 48-test focused set each exited 1 with 48 tests, 47 pass, 1 fail, 0 skipped:

- `.../scheduler-r3-author-correction/raw/green-focused-2.log`
- `.../scheduler-r3-author-correction/raw/green-focused-3.log`

Both executions failed only
`public old-policy settlement cannot advance replacement progress when policy hash is identical`
with actual `2` versus expected `1`. A later 47-test run that omitted the failing case is
not treated as proof of correction.

The root cause was that `preserveSamePolicyClaimProgress` compared the claim
`policyHash` to the current policy hash only. `modify` and same-policy pause/resume both
bump `scheduleRevision`, and the existing contract did not require `newPolicy.policyRevision`
to increase for `modify`; therefore an identical complete policy replacement could not be
distinguished from pause/resume by hash alone. The correction uses the already persisted
typed `SubscriptionControlReceipt` ledger: core ignores old-claim progress when an applied
`modify` receipt exists after the claim's `scheduleRevision` and at or before the current
revision. Runtime passes `snapshot.receipts` into that core decision. This is the existing
durable control receipt owner; no new counter, payload field, metadata, diagnostic log, or
contract change was introduced.

Public RED on the final lineage input: compile succeeded, then
`node --test dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js`
exited 1 with 31 tests, 29 pass, 2 fail, 0 skipped, 0 todo. The failures were the
identical-complete-policy replacement and returning-to-an-earlier-policy cases. Raw:
`.../scheduler-r3-lineage-admission-correction/raw/red-compile.log` and `red-public.log`.

Public GREEN after the core/runtime correction: 31 tests, 31 pass, 0 fail, 0 skipped, exit
0. Raw: `.../raw/green-public-compile.log` and `green-public.log`. The identical-policy case
restarts the `SubscriptionControlPort` from the same `JsonlOrganJournal` before settling
the old claim, verifies the applied `modify` receipt is still readable, and then proves the
old claim cannot advance replacement progress. It also claims and settles the replacement
occurrence to prove valid replacement execution still advances progress. The returning-to-
an-earlier-policy case retains the older claim across two replacements and proves the
restored policy's new claim still executes.

Focused final GREEN after the replay-retention assertion was added: compile plus both
subscription suites, 49 tests, 49 pass, 0 fail, 0 skipped, exit 0. Raw:
`.../raw/focused-final-compile.log` and `focused-final.log`. Existing same-policy
pause/resume, original R3 dueAt, in-flight authority, restart, max-limit, and all prior
assertions remain present.

## Maintained Gates (R3 candidate, final pass)

All commands ran from the worktree root with normal hooks; each records its direct exit
code in the raw log tail. This is the single authoritative final pass on the settled
source; the earlier partial pass produced matching counts without persisted exit codes.

- `pnpm test:explicit-brain`: exit 0; 46 tests, 46 pass, 0 fail. Raw `final-gate-01-explicit-brain.log`.
- `pnpm test:runtime`: exit 0; 469 tests, 469 pass, 0 fail; gateway 22 tests, 22 pass, 0 fail. Raw `final-gate-02-runtime.log`.
- `pnpm test:journal`: exit 0; 19 tests, 19 pass, 0 fail. Raw `final-gate-03-journal.log`.
- `pnpm typecheck`: exit 0. Raw `final-gate-04-typecheck.log`.
- `pnpm build:app`: exit 0. Raw `final-gate-05-build-app.log`.
- `pnpm build`: exit 0. Raw `final-gate-06-build.log`.
- `pnpm test:compiled`: exit 0; 731 tests, 731 pass, 0 fail. Raw `final-gate-07-compiled.log`.
- `pnpm dagpipe:validate`: exit 0; 11 graphs validated. Raw `final-gate-08-dagpipe.log`.
- `git diff --check`: exit 0. Raw `final-gate-09-diff-check.log`.

Raw gate logs live under
`/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r3-author-correction/raw/`.

### Final maintained gates (lineage admission candidate)

All commands ran from the worktree root with normal hooks and direct pipefail exit
reporting. The product source hashes above are the same core/runtime source exercised by
these gates.

- `pnpm test:explicit-brain`: exit 0; 46 tests, 46 pass, 0 fail, 0 skipped.
  Raw `raw/gate-01-explicit-brain.log`.
- `pnpm test:runtime`: exit 0; 471 tests, 471 pass, 0 fail, 0 skipped; gateway 22 tests,
  22 pass, 0 fail. Raw `raw/gate-02-runtime-final.log`.
- `pnpm test:journal`: exit 0; 19 tests, 19 pass, 0 fail, 0 skipped.
  Raw `raw/gate-03-journal.log`.
- `pnpm typecheck`: exit 0 after the final test-only restart assertion.
  Raw `raw/gate-04-typecheck-final.log`.
- `pnpm build:app`: exit 0. Raw `raw/gate-05-build-app.log`.
- `pnpm build`: exit 0; build manifest stage pass. Raw `raw/gate-06-build.log`.
- `pnpm test:compiled`: final candidate exit 0; 733 tests, 733 pass, 0 fail, 0 skipped.
  Raw `raw/gate-07-compiled-final.log`. The first compiled run exited 1 with 733 tests,
  732 pass, 1 fail, 0 skipped; its sole failure was case 292,
  `CLI serve takes over the previous owner and keeps rooted memory across restart` in
  `tests/app/app.test.ts`. The observed memory context remained task-detail/running with
  `等待 Provider 事件`, while diagnostics included provider-terminal, settling,
  checkpoint-committed, and final terminal events. The case uses the fake Provider. The
  first failure's cause is UNCONFIRMED. The immediate rerun passed 733/733 before the
  final replay-retention assertion, and the final compiled run passed 733/733 with that
  assertion included; those passing executions prove command success at their respective
  versions, not causality, defect closure, formal business acceptance, or that the first
  run should have exited 0.
- `pnpm dagpipe:validate`: exit 0; 11 graphs validated. Raw `raw/gate-08-dagpipe.log`.
- `git diff --check`: exit 0 after the receipt update. Raw `raw/gate-09-diff-check-final.log`.

Raw gate logs live under
`/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r3-lineage-admission-correction/raw/`.

## Boundaries

The submission journal root is derived from runtime config/environment by the existing
tests; no product business data is written under the project tree. This receipt records
only public-interface behavior with the real `JsonlOrganJournal`. The `subscription-control`
and `scheduled-occurrence` graph bindings already name `packages/core/src/subscription.ts`,
`packages/runtime/src/subscriptions/index.ts` and the runtime scheduler as owners, so no
binding correction was required.

W3 real `humanagent-serve-task@2` execution/verification/checkpoint/settlement remains
pending. Existing `serve-task-pending` behavior is the typed blocker; synthetic terminal
receipts in these tests are contract fixtures, not actual provider or scheduled business
success.

R3 review archive (authoritative failure evidence):

- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r3/status.json`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r3/review.final.md`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r3/review.exit`

R2 failure archive (unchanged):

- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r2/status.json`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r2/review.final.md`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r2/review.exit`

R1 evidence (unchanged):

- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r1-author-correction/notes.md`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r1-author-correction/handoff.md`
