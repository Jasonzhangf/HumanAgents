# New Task Landing Dashboard Review: Rework

Task: `new-task-landing-execution-dashboard-20261101`
Reviewer: Jenny
Date: 2026-11-01
Candidate: `0aac86906`

## Finding

The delivered change fixes the first navigation problem: entry.js now lands a
confirmed new task on `task-dashboard.html` instead of the static
`task.html?interaction=...` page.

The delivery does not satisfy the contract requirement that the submission
enters the live dashboard with the real execution event stream.

Evidence:

- `docs/ui/task-dashboard.js:3880-3916` enters the explicit-scope branch,
  calls `closeStream()`, sets `subscribedOperationId = undefined`, calls
  `stopObserving()`, reads the scoped projection, and returns before the
  common execution subscription block at `docs/ui/task-dashboard.js:3950-3963`.
- Because of that early return, the landed `task-dashboard.html?task=...&projectKey=...&mode=...`
  page never opens `api.eventsUrl(operationId)` and never subscribes to the
  `execution.*` events for the newly submitted task.
- `tests/ui/new-task-landing-dashboard-browser.mjs:128-138` only mocks
  `/api/explicit/interactions/:id/events` and asserts the entry phase
  `explicit.step` stream at line 315. It never mocks or asserts
  `/api/executions/:id/events` after the landing page loads.

The current browser screenshots can therefore show a static first projection
that happens to contain the text `执行中`, but do not prove that the landed
dashboard keeps updating from the real execution stream.

## Required Rework

1. In the explicit-scope refresh path, when the scoped projection has an
   `operationId` and state is `running` or `settling`, connect the same
   execution event stream used by the unscoped path. Do not leave the landed
   dashboard without a live observation stream.
2. Extend `tests/ui/new-task-landing-dashboard-browser.mjs` to mock
   `/api/executions/:id/events`, assert the dashboard subscribes after landing,
   and assert at least one real execution event updates the displayed
   step/progress/timer state.
3. Keep the existing new-task navigation and abandon controls intact.
