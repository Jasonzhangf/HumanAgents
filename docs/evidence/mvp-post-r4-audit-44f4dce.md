# HumanAgent MVP post-R4 audit at 44f4dce

## Verdicts

| Gate | Verdict | Evidence-bound conclusion |
|---|---|---|
| Gate 18: actual-entry fake replay equivalence | **PASS** | Standalone `run` and the actual `serve --mode fake` entry produced the same ordered semantic events, the same provider output, `succeeded` in both outcome projections, and `providerClose.state=closed` with `fake/close`. The focused five-scenario matrix also passed. |
| Gate 25: operation closure on the real serve path | **PASS** | The live fake serve entry committed a `succeeded` checkpoint, emitted provider settle plus `fake-close` terminal evidence, applied the durable memory consumer commit, exposed deterministic memory analysis as `succeeded`, and released the supervisor lease with `disposedAt`. |
| Gate 28: owner / no-fallback | **PASS** | Omitted `--mode` now selects the configured provider (`rcc`), explicit `--provider fake` selects fake, and conflicting, invalid, or unknown provider selections fail closed with typed `provider.invalid` errors owned by `humanagent.config`. No silent provider switch was observed. |

This report audits source commit
`44f4dce865fd1a1d5795b74be0b106c50dc8e342` only. It does not claim MVP
completion, merge, push, install, restart, release, production readiness, DSH
completion, or RCC real-provider completion.

## Baseline and scope

- Repository: `/Volumes/extension/code/humanagent`
- Worktree: `/Volumes/extension/code/humanagent/playground/cd8e2d7-mvp-gates-audit`
- Branch: `codex/cd8e2d7-mvp-gates-audit`
- Tested HEAD: `44f4dce865fd1a1d5795b74be0b106c50dc8e342`
- `origin/main` at audit time: `44f4dce865fd1a1d5795b74be0b106c50dc8e342`
- Root `main`: not edited by this audit.
- Allowed tracked write: this document only.
- Temporary audit root: `/tmp/humanagent-gates-audit-44f4dce.brPwJO`
  (also resolved as
  `/private/tmp/humanagent-gates-audit-44f4dce.brPwJO`)

The governing closeout contract is `docs/goals/mvp-to-milestones.md`. This
audit rechecks the three post-R4 gates against the current mainline rather than
reusing the old `7c1d243` FAIL/UNVERIFIED result.

## Gate 18 - actual-entry fake replay equivalence

### Build

```sh
pnpm install --frozen-lockfile
pnpm build:contracts
pnpm build:app
```

Observed exits: `0`, `0`, `0`.

### Standalone entry

```sh
node dist/app/app/src/cli.js run \
  --plan default \
  --prompt 'same valid input: produce the fixed fake replay result' \
  --session gate18-standalone \
  --workspace /tmp/humanagent-gates-audit-44f4dce.brPwJO/workspace \
  --control-root /tmp/humanagent-gates-audit-44f4dce.brPwJO/run-control \
  --fake-scenario success \
  --fake-step-delay-ms 0 --json
```

Observed exit `0`. Raw result:
`/tmp/humanagent-gates-audit-44f4dce.brPwJO/standalone-run.json`

Key observed fields:

```json
{
  "state": "stopped",
  "outcome": "succeeded",
  "driverRef": "fake",
  "output": {
    "mode": "provider",
    "status": "accepted",
    "output": "fake replay: draft output chunk 1fake replay: final output chunk 2"
  },
  "providerClose": {
    "state": "closed"
  }
}
```

The standalone `providerClose` evidence includes locator `fake/close`.

### Actual serve entry

```sh
node dist/app/app/src/cli.js serve \
  --mode fake --protocol responses \
  --binding fake-default --provider fake-provider \
  --model fake.model \
  --workspace /tmp/humanagent-gates-audit-44f4dce.brPwJO/workspace \
  --control-root /tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-control-b \
  --port 0 \
  --fake-scenario success \
  --fake-step-delay-ms 0 --json
```

The live entry launched at a loopback URL and was driven through the real HTTP
API. Raw artifacts:

- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-launch-b.json`
- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-create-task-b.json`
- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-start-execution-b.json`
- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-events-b.json`
- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-dashboard-b.json`
- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-task-b.json`
- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-observation-b.json`
- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-task-list-b.json`
- `/tmp/humanagent-gates-audit-44f4dce.brPwJO/serve-summary-b.txt`

Observed serve result:

- Task: `ui-task-52e7c973-2648-477b-a30e-22d8b181d930-1`
- Operation: `ui-operation-1`
- Dashboard state: `succeeded`
- Output: `fake replay: draft output chunk 1fake replay: final output chunk 2`
- Final terminal summary: `execution succeeded; provider closed`
- Final terminal evidence locators: `fake/settle-succeeded`, `fake/close`

Event kinds from the live serve entry:

```text
execution.started
provider.model
provider.output
provider.tool
provider.output
execution.terminal
execution.settling
checkpoint.committed
execution.terminal
```

### Comparison

The comparison normalized checkpoint summaries and checkpoint-owned evidence
locators, as the project contract does, and compared all remaining event
fields. It also compared the standalone `outcome` against the serve dashboard
state, the standalone output envelope against the dashboard output, and the
standalone provider-close state against the final serve terminal.

```text
eventEquality=true
eventKinds=execution.started,provider.model,provider.output,provider.tool,provider.output,execution.terminal,execution.settling,checkpoint.committed,execution.terminal
expectedKindsOk=true
outcomeVsDashboard=true
outputEnvelope=provider
outputStatus=accepted
output=true
providerCloseState=closed
providerCloseLocator=fake/close
finalTerminalSummary=execution succeeded; provider closed
terminalState=succeeded
```

No first divergence was observed for this success scenario.

### Focused matrix

```sh
pnpm exec tsc -p tests/app/tsconfig.json
node --test \
  --test-name-pattern='actual run and serve fake entries stay equivalent' \
  dist/tests/tests/app/app.test.js
```

Observed exit `0`; `1` test passed, `0` failed. The focused test covers
`success`, `tool`, `error`, `cancel`, `unknown`, and `close-failure` on
isolated roots. This supports the live success-path comparison above.

Gate 18 verdict: **PASS**.

## Gate 25 - operation closure on the real serve path

The existing `pnpm proof:cordis-host-closeout` script fails on current
`44f4dce` before writing its receipt:

```text
Error: event-journal is missing barrier-intent: event,memory-agent-state,consumer-commit
```

That assertion expects the older `barrier-intent` journal shape. Current
`packages/app/src/event-journal.ts` still supports `barrier-intent`, but the
live memory closure now records `consumer-commit` and `memory-agent-state`.
This audit therefore uses an independent live probe against the built CLI
rather than treating the stale script assertion as proof of a product failure.

### Live probe

```sh
node /tmp/gate25-live-probe.mjs
```

The probe starts the built `serve --mode fake` entry with an isolated
workspace and control root, creates a task over HTTP, starts an execution,
consumes the SSE stream to the final terminal, then reads the durable journal,
checkpoint, UI journal, memory summary, and supervisor lease. Raw record:

`/tmp/humanagent-gates-audit-44f4dce.brPwJO/gate25-live-probe.json`

Temporary runtime root from that record:

`/tmp/humanagent-gates-audit-44f4dce.brPwJO/gate25-live-UawWcv`

Observed launch and composition:

- `mode=fake`, `provider=fake`, `driverRef=fake`
- Supervisor stages:
  `cordis-host`, `serve-runtime`, `ui-runtime`
- `composition.complete=true`
- `memoryAnalysisMode=deterministic`
- Live plugin inventory includes the fixed harness kernel, agent templates,
  fake provider, memory, and UI plugins.

Observed task and event closure:

```text
task=ui-task-5a6e77a8-1696-43e0-ab4f-2396d83c8cea-1
operation=ui-operation-1
dashboard=succeeded
output=fake replay: draft output chunk 1fake replay: final output chunk 2
eventKinds=execution.started,provider.model,provider.output,provider.tool,provider.output,execution.terminal,execution.settling,checkpoint.committed,execution.terminal
terminalSummary=execution succeeded; provider closed
terminalEvidence=fake-settle-succeeded,fake-close
```

Observed durable closure:

```text
checkpointOutcome=succeeded
eventJournalTypes=event,memory-agent-state,consumer-commit
consumerCommitDisposition=applied
memoryAnalysis={mode: deterministic, state: succeeded,
  operationRef: memory-analysis:memory-binding:ui-task-...:checkpoint-checkpoint-ui-task-...-1-1-completion}
leaseDisposedAt=2026-09-26T08:51:14.590Z
```

The live memory API returned the same analysis:

```json
{
  "mode": "deterministic",
  "state": "succeeded",
  "operationRef": "memory-analysis:memory-binding:ui-task-5a6e77a8-1696-43e0-ab4f-2396d83c8cea-1:checkpoint-checkpoint-ui-task-5a6e77a8-1696-43e0-ab4f-2396d83c8cea-1-1-completion"
}
```

No pending retry was present in the live journal for this run.

### Non-blocking finding: stale Cordis proof assertion

`pnpm proof:cordis-host-closeout` currently fails because
`tests/app/real-cordis-host-closeout.mjs` requires `barrier-intent` in the
event journal. That is a stale proof-carrier assertion, not a Gate 25 product
regression: the live run reached `consumer-commit applied`, deterministic
memory analysis `succeeded`, and lease disposal. Repair is out of this audit's
scope because this audit may only create the evidence document.

Proposed repair task:

- Owner: `humanagent.app.event-journal` for the persisted closure contract;
  `tests/app/real-cordis-host-closeout.mjs` for the proof assertion.
- Missing/incorrect behavior: the proof script hard-requires
  `barrier-intent` and does not accept the current `consumer-commit` plus
  `memory-agent-state` closure shape.
- Why out of scope: the task forbids editing tests, scripts, or product code;
  this audit records the live closure evidence instead.

Gate 25 verdict: **PASS** for the live fake serve path, with the stale proof
assertion recorded as a non-blocking evidence-carrier defect.

## Gate 28 - owner / no-fallback

### Probe

```sh
node /tmp/gate28-provider-probe.mjs
```

Raw record:

`/tmp/humanagent-gates-audit-44f4dce.brPwJO/gate28-provider-probe.json`

Observed selections:

```text
omitted --mode, no --provider -> provider=rcc, mode=rcc
omitted --mode, --provider fake -> provider=fake, mode=fake
```

Observed fail-closed errors:

```json
{"error":{"code":"provider.invalid","ownerId":"humanagent.config","nextAction":"use one provider selection, or make --mode and --provider agree","message":"conflicting provider options: --mode fake and --provider rcc"}}
{"error":{"code":"provider.invalid","ownerId":"humanagent.config","nextAction":"choose fake or rcc for --mode, or omit the deprecated option","message":"unknown legacy mode: fak"}}
{"error":{"code":"provider.invalid","ownerId":"humanagent.config","nextAction":"choose a configured provider such as rcc, or use fake only for internal tests","message":"unknown provider: unknown"}}
```

No silent provider switch or fallback was observed. The omitted-mode behavior
now follows the configured provider, and explicit fake selection remains
internal-test-only.

Gate 28 verdict: **PASS** for provider selection, owner, and no-fallback on
the audited entry.

## Main verifiability gates

| Command | Exit | Observed result |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | install completed |
| `pnpm build:contracts` | 0 | contracts build completed |
| `pnpm build:app` | 0 | app build and asset copy completed |
| `pnpm typecheck` | 0 | no diagnostics |
| `pnpm test:runtime` | 0 | 382 runtime tests passed; 22 gateway tests passed |
| `pnpm test:app` first run | 1 | 293 passed, 2 failed (`settling` timing failures) |
| isolated rerun of the 2 failures | 0 | 2 passed, 0 failed |
| `pnpm test:app` second full run | 0 | 295 passed, 0 failed |
| Gate 18 focused matrix | 0 | 1 passed, 0 failed |

### Non-blocking finding: app-suite timing sensitivity

The first full `pnpm test:app` run failed two tests:

- `CLI serve takes over the previous owner and keeps rooted memory across restart`
- `serve entry publishes a task-scoped checkpoint through the task-bound consumer`

Both failures were timeout/state-race shaped: one waited on a memory context
receipt while the provider was still projecting events, and one observed
`settling` instead of `succeeded`. Both tests passed in an isolated rerun, and
the second full suite run passed 295/295. This is a test determinism risk, not
a proven product defect from the audit.

Proposed repair task:

- Owner: `tests/app/app.test.ts` for the restart/memory-context wait and the
  task-bound consumer wait.
- Missing/incorrect behavior: both assertions use fixed waits that can race
  provider settlement under load; they need event-driven synchronization or a
  bounded wait for the actual terminal condition.
- Why out of scope: the audit may only create this evidence document; no test
  or product code may be edited here.

## Boundary

This audit closes only the exact-SHA Gate 18/25/28 questions on `44f4dce`.
The live Gate 25 evidence is fake-entry evidence; it does not claim RCC,
real-model, DSH, release, deployment, or production completion. The stale
Cordis proof assertion and the app-suite timing sensitivity remain explicit
follow-up items rather than being folded into a PASS.
