# GCM Worker Prompt — Remove Missing Gateway Plan Reference

## Task

- task_id: `design-gateway-reference-fix-20260920`
- role: documentation maintainer
- base_sha: `9ac38bed5ac8df443ca9ac2447c3f06d8789eb3d`
- worktree: `/Volumes/extension/code/humanagent/playground/integrate-agent-framework-design-20260920`

## Objective

Close the Codex review P1 caused by references to the absent
`docs/architecture/tool-execution-gateway-implementation-plan.md`. The existing
`agent-framework-next-phase-plan.md` and `agent-framework-task-graph.md` are the
single dispatch contract for Gateway implementation; do not add a duplicate plan.

## Allowed paths

- `docs/architecture/tool-execution-gateway.md`
- `docs/architecture/agent-framework-stable-baseline.md`
- `docs/goals/tool-execution-gateway-m1.md`
- `docs/goals/tool-execution-gateway-g5.md`
- this prompt file

## Forbidden paths

- all `packages/` and `tests/`
- `.appsdk/`, `README.md`, `note.md`
- any other worktree or canonical dirty main
- runtime, DSH, RCC, provider, memory, UI, or orchestration implementation

## Required changes

1. Replace each active reference to the missing implementation-plan file with
   the existing Gateway contract plus the Agent Framework phase plan/task graph.
2. Remove or rewrite historical wording that becomes false after the active
   references are corrected.
3. Preserve the G0 → G2/G3/G4 → G5 dependency, ownership, gate, re-entry,
   legacy-route, and non-goal semantics. Do not add a second plan.
4. Verify all relative Markdown links in the changed documents still resolve.

## Completion iff

- No active document claims that the missing file is an input or source of truth.
- The existing phase plan and task graph are explicitly the unique dispatch
  contract for this work.
- `git diff --check` passes and only allowed paths change.
- Report changed paths, checks, exit codes, and remaining risks.

## Lifecycle and recovery

This task is re-enterable. Do not commit; the parent owns candidate commit,
review, and delivery. Do not modify any worker implementation.
