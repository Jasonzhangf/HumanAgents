# Explicit Brain Implementation

Baseline: `origin/main@811efc03e28eeb3b3ff2bd170aeaf88ff8f310e3`
Worktree: `/Volumes/extension/code/humanagent/playground/explicit-brain-impl-20260917`
Branch: `codex/explicit-brain-impl-20260917`
Design: `playground/explicit-brain-design-20260917/docs/architecture/explicit-brain.md@6a29bee`
Gate: `explicit-brain-design-astra-20260917-r7` PASS

## Scope

Implement explicit brain interaction template, typed tool intent/admission, channel routing,
Attention triage/priority, memory operation status and bounded wakeups, git-bug operation-barrier
intake, scheduler patrol, and queryable decision traces.

## Non-goals

No second Attention state machine, Bug system, scheduler, memory runtime, task queue, or pipeline.
No DSH adapter work. No production deployment or real external channel claim without evidence.

## Ownership split

- Main: contracts, template registry/profile, interaction admission/router, integration.
- Worker A: Attention policy and decision trace owner.
- Worker B: Memory operation projection and boundary wakeup owner.
- Worker C: git-bug intake and operation-barrier owner.
- Worker D: scheduler patrol owner.

## Evidence log

- 2026-09-17: Created clean worktree from `origin/main`; design and existing contracts inspected.
- 2026-09-17: Candidate `477f31121913e7897419c76b0e4973a454e6b9f7` completed the first
  review-fix round for input revision binding, idempotent confirmation retry, serialized
  dispatch, durable explicit-brain state hydration, and typed HTTP routes. Independent review
  `explicit-brain-reviewfix-477f311` returned FAIL with two P1 findings: accepted raw input was
  not recoverable and the HTTP control channel was advertised but unsupported.
- 2026-09-17: Review-fix changes now persist `rawInput` in explicit interaction state and reject
  unsupported control requests explicitly at the HTTP boundary instead of claiming that channel
  is accepted.
- 2026-09-17: Independent review `explicit-brain-reviewfix-d8689f8b` returned FAIL with a P1
  finding in `DecisionTraceJournal`: after restart, a new append hid previously loaded durable
  traces from later queries. The journal now hydrates persisted records into its in-memory
  collection before append/query, and a regression asserts history remains visible after a new
  append.
- 2026-09-17: Independent review `explicit-brain-reviewfix-2bcdb20` returned FAIL with P1
  findings on restart idempotency. Submitted receipts are now persisted/restored with
  `RequirementSubmissionOwner`, and dispatch records a durable ledger entry with the started
  task/operation before acknowledging the FIFO envelope so restart recovery reuses the existing
  execution instead of starting another.
- Verification: `pnpm exec tsc --noEmit`, `pnpm test:explicit-brain`, `pnpm test:app`,
  `pnpm test:agent-templates`, `pnpm test:release`, full `pnpm test`, and `git diff --check`
  all PASS after the review fixes.
- Verified in current source tests: explicit confirmation is the only path to FIFO; status-only
  does not enqueue; `intent`, `taskRef`, `normalizedInput`, and `payloadRef` survive
  confirmation/submission; router errors map to typed UI API errors.
- Unverified: latest review-fix candidate SHA/review/merge/push, real Journal/EventBus wiring
  beyond the typed decision-trace port, real git-bug/channel/RCC integration, and post-merge
  runtime load or crash recovery.
