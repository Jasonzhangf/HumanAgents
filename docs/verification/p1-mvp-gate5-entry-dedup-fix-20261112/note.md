# Gate5 Entry Dedup Verification

Task: `p1-mvp-gate5-entry-dedup-fix-20261112`
Base: `038133f3a`
Branch: `codex/p1-mvp-gate5-entry-dedup-fix-20261112`

## Goal

Remove the duplicated task-list and New Task entry surfaces while keeping task
access, the shared shell drawer, and the entry submission path usable.

## Behavior

- The entry main column shows a compact status summary and no inline task rows.
- The drawer contains only draft, waiting, and running tasks.
- The drawer links to `./tasks.html` for the complete Task List.
- The entry-page topbar does not repeat the New Task link.

## RED

The updated browser proof ran against the archived base UI at `/tmp/gate5-base-038133f3a/docs/ui`.
It failed 4/43 checks because both viewports still showed the duplicate New
Task link and the drawer had no Task List link.

Evidence: `baseline-red/checks.json`

## GREEN

The candidate passed the browser proof 43/43 against the isolated runtime at
`http://127.0.0.1:54754` at 1280x720 and 390x844. The proof covers open, close,
Escape, reopen, live task identity/state/title, no horizontal overflow, the
Task List link, and the post-close empty-form validation without mutation.

The focused product-consumer unit proof passed 7/7. The entry-flow proof passed
62/62 with `T22C_SKIP_RCC=1`; section B was skipped rather than claimed.

Evidence:

- `checks.json`
- `entry-flow/checks.json`
- `real-api-tasks.json`
- `entry-task-list-drawer-*.png`

## Boundaries

No shared 10086 or Collab daemon restart, no tmux operation, no requirements
edit, no unrelated page edit, and no merge/push/close. The isolated runtime is
PID 86702 on port 54754, owned by this task.

## Remaining Gate

Independent review by David is pending. The running Collab daemon was
unavailable during this round, so the durable notification receipt and board
delivery message could not be completed.
