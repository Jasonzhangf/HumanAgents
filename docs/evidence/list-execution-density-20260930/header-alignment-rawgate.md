# Header alignment raw gate

Worktree: /Volumes/Intel/playground/humanagent/orch-list-execution-density-20260930
Branch: codex/orch-list-execution-density-20260930
Base before commit: 9842f6d91dc2d681b352feb0c84da66f83d28343

## Change

- Shared task table tracks with .page: checkbox, title, status, updated, actions.
- .task-row and .task-row--head consume the same five-track definition.
- .task-row-link spans tracks 2-5 with CSS subgrid, so title/status/time keep the same parent track sizes.
- Kept title wrapping via minmax(0, 1fr), mobile single-column behavior, 44px action tap targets, and reduced-motion reset.

## Commands

    node --check docs/ui/tasks.js
    pnpm build:contracts
    pnpm typecheck
    pnpm test:ui
    git diff --check

## Result

- Raw command log: docs/evidence/list-execution-density-20260930/rawlog.txt
- All commands above exited 0.
- pnpm test:ui: tests 36, pass 36, fail 0, cancelled 0, skipped 0, todo 0.
- git diff --check exited 0.

## Boundary

- This receipt covers local raw gate evidence only.
- Parent Browser coordinate validation remains pending outside this worker.
