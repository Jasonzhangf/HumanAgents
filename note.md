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
- 2026-09-17: Candidate `35c7939b9b97dc64a67cce0a41cd504b73774172` completed review-fix
  changes for input revision binding, idempotent confirmation retry, serialized dispatch,
  durable explicit-brain state hydration, and typed HTTP routes.
- Verification: `pnpm exec tsc --noEmit`, `pnpm test:explicit-brain`, `pnpm test:app`,
  `pnpm test:agent-templates`, `pnpm test:release`, full `pnpm test`, and `git diff --check`
  all PASS after the review fixes.
- Verified in current source tests: explicit confirmation is the only path to FIFO; status-only
  does not enqueue; `intent`, `taskRef`, `normalizedInput`, and `payloadRef` survive
  confirmation/submission; router errors map to typed UI API errors.
- Unverified: review-fix candidate SHA/review/merge/push, real Journal/EventBus wiring for
  `DecisionTraceJournal`, real git-bug/channel/RCC integration, and post-merge runtime load or
  crash recovery.
