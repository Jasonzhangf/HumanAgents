# Review Acceptance: new-task-landing-execution-dashboard-20261101

Status: ACCEPT
Reviewer: Jenny (humanagent master)
Task: new-task-landing-execution-dashboard-20261101
Candidate: 325c0bb155071f1b3bfb5f0712b4ec0cb02224c4
Branch: codex/new-task-landing-execution-dashboard-20261101
Base: af5a2a73131284196e1146cb85fd610dc58d2cd2 (origin/main)

## Review scope

The prior candidate 0aac86906 was returned for rework because the explicit-scope
Task Dashboard branch returned before subscribing to the live execution event
stream. The reworked candidate 325c0bb15 changes `docs/ui/task-dashboard.js` and
`tests/ui/new-task-landing-dashboard-browser.mjs`.

## Verification

- `pnpm -s test:ui`: 69/69 pass.
- `pnpm -s build:app`: exit 0.
- `node tests/ui/new-task-landing-dashboard-browser.mjs`: failures 0.
- Browser assertions at both tested viewports assert the dashboard subscribes to
  `/api/executions/:id/events` and renders execution-event step updates after a
  new task submission.
- Explicit-scope branch now calls `subscribe(dashboard.operationId)` while
  running/settling and an operationId exists, instead of closing the stream and
  returning to a static projection.

## Decision

The candidate satisfies the rework finding. No new review finding applies to this
candidate.
