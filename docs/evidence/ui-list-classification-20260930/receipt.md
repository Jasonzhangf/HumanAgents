# Task-list resource classification presentation receipt

## Scope and candidate identity

The source candidate is `846ec4af5c0d71e50f5bb21bf57d7add4eadf123`, composed
onto fetched main `081104b9ff6f779dc6366d4059a560ca7b62707b`. The GCM author
candidate is `b8dc37d`. Product changes consist only of removing the internal
admission label from `docs/ui/tasks.js` and `docs/ui/entry.js`. No CSS, API,
Provider, task dispatch, confirmation or timing logic changes are included.

This receipt, logs and screenshots are subsequent evidence-only additions.
The product source remains byte-identical to the source candidate:

- `tasks.js`: `fa0a22dcb86919add56c8ba3604768f3993e756ab95df9ba879b6f794da21783`.
- `entry.js`: `0060a2bf10a47a52c4e3a378df8eb1631edc78351ea9c5ebb4102597f0181b7a`.

The rebuilt files in `dist/app/ui` and HTTP-served candidate assets have these
same hashes. No shared port 10086 asset or runtime was installed or modified.

## Development gates

- `node --check docs/ui/tasks.js`: exit 0.
- `node --check docs/ui/entry.js`: exit 0.
- `pnpm typecheck`: exit 0; raw output in `typecheck.log`.
- `pnpm build:app`: exit 0; also rerun by `pnpm test:ui`.
- `pnpm build:contracts`: exit 0. The first clean-worktree UI run failed with
  `ERR_MODULE_NOT_FOUND` before contracts were built; it is not counted as a
  passing gate.
- `pnpm test:ui`: 36 passed, 0 failed, 0 skipped, exit 0. Raw output in
  `ui-gate.log`. The existing suite covers retained typed API flow, confirmation
  and error handling; none of those behaviors changed in this presentation fix.

## Native browser: task-list entry

The owned read-only renderer consumer served candidate assets on port 49425,
PID 73323. API GET responses were passed through without modification from the
existing runtime on port 10086; writes were rejected by this consumer.

`tasks.html` rendered the actual existing blocked and completed tasks. Native
browser assertions confirmed:

- No `research/maintenance/interactive/execution` resource queue label is visible.
- The extra admission column and its header are absent.
- Both rows preserve actual title, task state and update time; each contains
  eight data cells, matching the unchanged eight-column stylesheet.
- Both row grids have `scrollWidth == clientWidth` at the inspected desktop
  viewport. CSS and its existing responsive rules are unchanged.
- Selecting all changes the selected count to 2; clearing restores it to 0.
  No stop, delete or execution operation was submitted to the shared runtime.

See `list.jpg` and `browser-facts.json`. This verifies the affected renderer
against actual runtime data; it does not verify a new Provider execution.

## Native browser: input-page status-rendering entry

The second entry was verified using the actual public `startUiRuntime` service
and its durable journals, candidate assets and native browser on port 56074,
PID 9033. Its isolated control root was
`~/.humanagent/ui-verification/list-entry-20260930-hsB7m8`.

This consumer explicitly used fake mode and a deterministic status-query
interpreter. One real service task was created, but no task execution or
Provider request was started. Through the visible input form, the browser
submitted a status query; the service returned `status-only`, and the page
rendered the public task list through `renderStatus`.

The resulting row retained title, `已创建`, next step and time. The
`item-meta` contained zero spans and retained its time element. Internal
resource classification was absent. See `entry.jpg` and
`entry-retry-facts.json`. This is component renderer evidence, not real RCC,
explicit-Brain intelligence, five-tool, or task-execution acceptance.

## Applicability and remaining work

The WebUI input/confirmation/turn/result delivery gate in
`docs/ui/dashboard-e2e-acceptance.md` remains mandatory for that full delivery.
This candidate changes two display fragments only: no input contract,
confirmation, tools, turns, results, retry or Provider behavior is added or
modified. Existing tests for those unchanged branches are reused; this receipt
does not grant full Dashboard, web-search, local-search or AItest acceptance.
Scheduled and recurring execution are still unimplemented separately. The full
orchestration work remains INCOMPLETE and is not being merged with this patch.

## Verification-resource disposition

- The component task `ui-task-29762931-4264-4c68-a633-737a8b0d5feb-1` was
  deleted through its owned service API: HTTP 200, `deleted: true`. The service
  subsequently reported all task counts and total equal to 0. Since execution
  never started, no Provider stop/settle or checkpoint operation was applicable.
- The first component attempt exposed a temporary consumer shutdown-handler
  error (`stopImplicitConsumer` is not a service method). It exited with code 1;
  its PID 2068 and port 54458 were confirmed absent/closed. Its task had already
  been deleted and total was 0. The consumer handler was corrected before the
  complete second entry attempt; the first attempt is not cleanup-success proof.
- Corrected component PID 9033 stopped with exact `kill -TERM 9033`, and its
  execution session returned exit 0. PID checks show no PID; curl to port 56074
  returns connection refused, exit 7.
- Read-only consumer PID 73323 stopped with exact TERM; session exit 0, no PID,
  port 49425 connection refused, exit 7. The earlier read-only PID 17753 and
  port 60117 were also closed during candidate composition.
- All browser tabs created for this verification were closed; native
  `browser.tabs.list()` returned an empty list.
- Both owned component control directories were removed; `test ! -e` succeeded
  for `list-entry-20260930-rSq7dU` and `list-entry-20260930-hsB7m8`.
- Both temporary consumer `.mjs` files were removed and absence was checked.
  No shared runtime, existing task, main-tree untracked file or other process
  was removed.
- Candidate worktrees and these receipts are deliberately retained pending
  review and delivery disposition. Worktree cleanup is not yet complete and
  no final merge/push/install/cleanup claim is made.

The earlier review of source candidate 846ec4a failed because these validation
receipts were absent from its review input. Its finding was missing evidence;
no product behavior finding was reported. A new review must consume this
receipt and the associated actual outputs before a PASS can be claimed.
