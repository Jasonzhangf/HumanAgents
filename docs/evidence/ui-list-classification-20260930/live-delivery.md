# Installed task-list display acceptance

Date: 2026-09-30.
Product candidate and initial main fast-forward:
`7a1472d73117dff950242e61e588e90d3c41a86e`.
Latest fetched base: `081104b9ff6f779dc6366d4059a560ca7b62707b`.

## Review and source equivalence

Independent task `humanagent-ui-list-classification-20260930-r2` used OAuth
profile with explicit `gpt-6.1-sol`, exited 0, and received controller PASS.
Its valid final JSON is retained as `review-r2.json`. Subsequent additions in
this directory are evidence only; the two product files remain unchanged.

## Installation and runtime consumption

The actual canonical entry is `/opt/homebrew/bin/humanagent`, resolving to
`/opt/homebrew/lib/node_modules/humanagent-cli/bin/humanagent.mjs`.
The running server's installed `runtime/app/src/ui-runtime/server.js` and
candidate `dist/app/app/src/ui-runtime/server.js` both hash to
`5f942639a7e6e54c55c1b4a51802238a3373b3f671ed4b4cf9e8ac6497d37b12`.
Installed UI files before the patch exactly matched the fetched main files;
there was no preexisting local asset delta to overwrite.

Only the two already built and reviewed UI files were installed into the
canonical `runtime/ui` directory, using owned staging names and atomic rename.
Source, build, installed file and actual HTTP responses have matching SHA-256:

- `tasks.js`: `fa0a22dcb86919add56c8ba3604768f3993e756ab95df9ba879b6f794da21783`.
- `entry.js`: `0060a2bf10a47a52c4e3a378df8eb1631edc78351ea9c5ebb4102597f0181b7a`.

The server reads static files for each request and sends `cache-control:
no-store`. Its executable code did not change, so server restart is not
applicable to this asset installation. A new native-browser tab loaded the
installed assets from `http://127.0.0.1:10086/tasks.html`.
The runtime identity remained generation 2, PID 17515, process start token
`node:b09ffc62-f114-469e-93ff-0e2acec071e4`, lease
`57950bb6-a52d-4e64-947b-42f8df719b19`.
Package version remains `0.1.0010`; no package publication occurred.

## Actual browser result

`live-list-facts.json` and `live-list.jpg` record the installed-page result:

- No internal `interactive/execution/research/maintenance` classification.
- No extra admission column or header.
- Both actual existing tasks retain their titles, blocked/completed states,
  times, eight data cells and nonoverflowing row layouts.
- This verification did not start, stop, modify or delete either existing task.

The earlier input-page component acceptance and original 36/36 UI gate remain
valid because its source is byte-identical. This installed-list acceptance
does not add Provider, timing scheduler, child-session or full Dashboard
execution acceptance. The broader orchestration remains incomplete.

## Resource and lifecycle disposition

The native-browser acceptance tab was closed and tab listing returned `[]`.
The owned staging files were consumed by rename. No temporary server or
control root was created for this installed-page verification.
Evidence and review output are retained here before worktree removal.
Push and final owned-worktree absence must be checked by the delivery owner
after this evidence commit; those operations are not claimed by this receipt.

The earlier handoff assertion that the user prohibited updating port 10086 was
not found in the original user messages. Normal local repair delivery follows
the project's existing installation and Git authorization.
