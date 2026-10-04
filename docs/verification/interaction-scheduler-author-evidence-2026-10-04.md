# Interaction Scheduler Author Evidence (2026-10-04)

Scope: HumanAgent W2 interaction-scheduler author correction for three independent R2
behavior findings. This receipt is candidate evidence only; W3 real serve-task execution
remains pending.

## Source Input

- Worktree: `/Volumes/Intel/playground/humanagent/interaction-scheduler-implementation-20261003`
- Branch: `codex/interaction-scheduler-implementation-20261003`
- Input HEAD: `9f5ec13a6c9f4e2a4b1635c419efd33f276d0f7b`
- Input tree: `253669a42b2d53928fe8fcf4e69b3efb68a15c9d`
- Parent origin/main at transfer: `0020ab4f4442ea59bf4b9fc02416a8a77c6c68ed`
- Node: `v22.22.2`; pnpm: `10.31.0`
- Correction timestamp: `2026-10-04T09:40:13Z` (gates)

## Changed Files

- `packages/core/src/subscription.ts`
- `packages/runtime/src/subscriptions/index.ts`
- `tests/runtime/subscriptions/subscriptions.test.ts`
- `tests/runtime/subscriptions/public-consumer.test.ts`
- `docs/verification/interaction-scheduler-author-evidence-2026-10-04.md` (this receipt)

## Source And Compiled Hashes

Source (precommit candidate):

- `packages/core/src/subscription.ts`: `e36e9ad548fe7a1ae3d64c76070e510e2f20c7a3ed2310bf7d9917ea7f33ae72`
- `packages/runtime/src/subscriptions/index.ts`: `84b505ab41b06cd24c553643675c98e12bbf037ce1a55bb10bc32721c1ed480a`
- `tests/runtime/subscriptions/subscriptions.test.ts`: `ed015843070df6f39f256d437a71486efecac15de585b6aad46fe7f1db0f5781`
- `tests/runtime/subscriptions/public-consumer.test.ts`: `e4f8f279ffde5856848c970bbc9ed64c060ab575ba20a0d487383fcb56cc90cb`

Compiled:

- `dist/tests-runtime-subscriptions/packages/runtime/src/subscriptions/index.js`: `6c5332448b23952feee5e294b294e6a5ab72edc0027c87a5432cc1aa1987789f`
- `dist/tests-runtime-subscriptions/tests/runtime/subscriptions/subscriptions.test.js`: `ce2a71d48fe1ebfc9484d02494899d038bf4a7704803ac0058887992d488ba6b`
- `dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js`: `a864c441277e1927b0a184d96ac35c8adcd7b8a44b60b0842a5db5a483ca6f8f`
- `dist/tests-explicit-brain/packages/runtime/src/explicit-brain/scheduler-patrol.js`: `a05b1ea7ccf168388dd31b7873fb6c7036cc91cd394710844b0cbd1d418d166d`
- `dist/tests-explicit-brain/tests/runtime/explicit-brain/explicit-brain.test.js`: `b40e4bc149f80a141507107b97d7cf00825f78fe1ae830d13dc86e437377723f`

## Public RED

- Command: `node --test dist/tests-runtime-subscriptions/tests/runtime/subscriptions/public-consumer.test.js dist/tests-runtime-subscriptions/tests/runtime/subscriptions/subscriptions.test.js`
- Result: exit 1; 26 tests, 20 pass, 6 fail, 0 cancelled, 0 skipped, 0 todo.
- Failures: stable reminder identity, replacement-policy progress, old-policy settlement
  after replacement, idle-reminder coalescing, latest run-once recovery, and latest
  `dueTimes` selection.
- Raw: `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/red-public.log`
- Raw compile boundary: `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/red-compile.log`

## Focused GREEN

- Command: same focused public-consumer and subscriptions suites after owner correction.
- Result: exit 0; 44 tests, 44 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo.
  This is 26 public tests plus 18 direct subscription tests.
- Raw: `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/green-focused.log`

Public behavior covered: modify resets progress for a replacement policy and survives
restart; settlement of an old-revision in-flight claim cannot advance or exhaust the
replacement policy; pause/resume preserve progress and limits for the same policy;
multiple busy idle-reminder slots preserve occurrence evidence while keeping one pending
reminder through restart; hourly run-once recovery at `03:30` catches up only `03:00`,
settles, reopens without older backlog, and keeps `04:00` valid; `dueTimes` selects the
latest eligible slots before applying `count`. Existing busy/late/exhaustion/cancellation/
revision behavior remains covered by the same suites.

## Maintained Gates

All commands ran from the worktree root on the corrected candidate with normal hooks.

- `pnpm test:explicit-brain`: exit 0; 46 tests, 46 pass, 0 fail.
- `pnpm test:runtime`: exit 0; 466 tests, 466 pass, 0 fail; gateway 22 tests, 22 pass, 0 fail.
- `pnpm test:journal`: exit 0; 19 tests, 19 pass, 0 fail.
- `pnpm typecheck`: exit 0.
- `pnpm build:app`: exit 0.
- `pnpm build`: exit 0.
- `pnpm test:compiled`: exit 0; 728 tests, 728 pass, 0 fail.
- `pnpm dagpipe:validate`: exit 0; 11 graphs validated.
- `git diff --check`: exit 0.

Raw logs:

- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-01-explicit-brain.log`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-02-runtime.log`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-03-journal.log`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-04-typecheck.log`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-05-build-app.log`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-06-build.log`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-07-compiled.log`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-08-dagpipe.log`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r2-author-correction/raw/gate-09-diff-check.log`

R2 failure archive (unchanged):

- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r2/status.json`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r2/review.final.md`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/scheduler-implementation-r2/review.exit`

R1 evidence (unchanged):

- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r1-author-correction/notes.md`
- `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/scheduler-r1-author-correction/handoff.md`

## Boundaries

The submission journal root is derived from runtime config/environment by the existing
tests; no product business data is written under the project tree. This receipt records
only public-interface behavior with the real `JsonlOrganJournal`.

W3 real `humanagent-serve-task@2` execution/verification/checkpoint/settlement remains
pending. Existing `serve-task-pending` behavior is the typed blocker; synthetic terminal
receipts in these tests are contract fixtures, not actual provider or scheduled business
success.
