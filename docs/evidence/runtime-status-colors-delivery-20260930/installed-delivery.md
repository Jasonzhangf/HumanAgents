# Installed shared state color acceptance

Reviewed candidate: `2c0843a6db7f8c4a3a83ef543820a5c0c0a802cd`.
Fresh fetched main remained `b097bb2b47fc25c41d459fe81fd8bc32c3b8c152`.

Independent review `humanagent-runtime-status-colors-r2-20260930` used
`profile: oauth` and explicit `model: gpt-6.1-sol`; its actual command included
both parameters and read-only sandbox. The reviewer exited 0, returned valid
contract JSON with no findings, and controller verdict was PASS. The final
JSON is retained in `review-r2.json`. Subsequent evidence-only commits keep
all product bytes identical to the reviewed candidate.

Before installation, the three existing installed assets and their HTTP
responses matched the latest main byte for byte; see `pre-install-facts.json`.
The new state-colors.css file was absent. No preexisting local delta was
overwritten. Source and rebuilt files were compared before creating owned
staging names ending `.__ha_color_20260930_2c0843a`. Atomic rename consumed
all four staging files into the canonical `runtime/ui` directory.

`installed-asset-facts.json` proves source/build/installed/HTTP SHA256 equality
for state-colors.css, runtime.css, interaction.css and runtime-api.js. All
HTTP responses carried `cache-control: no-store`.

The canonical entry remains `/opt/homebrew/bin/humanagent`, with installed
root `/opt/homebrew/lib/node_modules/humanagent-cli`. The running server and
candidate server.js bytes are identical, digest
`5f942639a7e6e54c55c1b4a51802238a3373b3f671ed4b4cf9e8ac6497d37b12`.
PID 17515 remains the existing service, started Tue Sep 29 09:56:11 2026,
serving port 10086. Runtime status remains ready in rcc mode. Because only
static assets changed and the unchanged server reads them per request, a
backend rebuild/restart is not applicable. Package version remains 0.1.0010;
this is a scoped static asset installation, not package publication.

Two fresh native-browser tabs loaded the actual installed tasks.html and
interaction.html. Their existing task chips had identical computed values:
blocked is yellow (`warning`, background rgb(255,240,214)); succeeded is
green (`success`, background rgb(225,242,231)). Task List has no horizontal
overflow. `installed-browser-facts.json`, `installed-tasks.jpg` and
`installed-interaction.jpg` retain these results. No task was created,
executed, edited, stopped or deleted, and these existing-task render checks
are not counted as new Provider business task E2E evidence.

Earlier native-browser component evidence verifies all 13 states using the
actual shared mapper and the actual Interaction renderer. Full scheduling,
session observation, five-tool liveness and independent orchestration agent
acceptance remain separate unfinished work.

Merge/push and the remaining owned-resource cleanup are recorded separately
after their actual completion; this receipt does not claim those stages.
