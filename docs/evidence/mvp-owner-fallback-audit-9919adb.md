# MVP #28 owner / no-fallback audit

- Audit date: 2026-09-19
- Candidate base: `9919adbfe210d8180ce0806edcabd75ad360b4f9`
- Worktree: `/Volumes/extension/code/humanagent/playground/owner-audit-r1`
- Scope: MVP runtime surface, declared documentation/test/code owners, fallback,
  silent downgrade, and double-path behavior.
- Write scope used: this report only.

## Verdict

`UNVERIFIED` — the inspected execution paths fail closed and preserve owner/error
evidence, but complete owner consistency and no-undeclared-fallback coverage is
not directly demonstrated. Two review findings remain: the current code path is
not the path named by the MVP plan for the Host/standalone owner, and two
compatibility/default-selection paths are visible in code without a matching
design-level declaration and dedicated negative coverage.

This is not a claim that a silent provider failure fallback was observed. The
provider-failure path examined below remains explicit and does not switch to
fake.

## Declared owner inventory vs actual tree

### Declared sources of truth

| Concern | Declared owner/evidence | Status |
|---|---|---|
| Domain lifecycle, error policy, steer, recovery | `AGENTS.md:11-14` → `packages/core`, `packages/runtime` | Present |
| Journal history | `AGENTS.md:15` → `packages/adapters/jsonl` | Present; used by `packages/app/src/checkpoint-journal.ts:32` |
| Rebuildable Index | `AGENTS.md:16` → `packages/adapters/sqlite` | Expected future/M2; explicitly excluded from MVP by `docs/goals/mvp-to-milestones.md:28-31,88` |
| Filesystem assets | `AGENTS.md:17` → `packages/adapters/filesystem` | Present |
| Provider binding/codec/readiness/stop-settle | `AGENTS.md:18` → `packages/adapters/provider` | Present |
| DSH session mapping | `AGENTS.md:19` → `packages/adapters/dsh` | Present as future/M1 surface; MVP keeps DSH disabled |
| Side effects | `AGENTS.md:20` → `packages/adapters/operations` | No corresponding directory in current tree; MVP plan does not list it as an allowed MVP module |
| Config parsing and path derivation | `AGENTS.md:21` → `packages/config` | Present |
| UI projection/product shell | `AGENTS.md:22-24` → `packages/ui`, `packages/ui/projection`, `packages/app` assembly | Present, with static UI under `docs/ui` |
| Journal/Context/Plugin unique-owner model | `docs/architecture/context-contract.md:519-533` | Declared; implementation is split across typed runtime ports and app adapters as described below |

The owner registry is substantially present. The `sqlite` and `operations`
entries are not active MVP paths, so their absent directories are not counted as
MVP product defects. They remain an owner-registry completeness limitation for
future scope.

### MVP plan/code path mismatch

`docs/goals/mvp-to-milestones.md:68-86` names
`packages/app/cordis-host`, `packages/app/standalone`, `packages/ui/shell`,
`packages/ui/surfaces`, and `packages/ui/kit` as the MVP module set;
`docs/goals/mvp-to-milestones.md:88` says the Host must load the fixed Kernel
and plugins; and `docs/goals/mvp-to-milestones.md:100-101` assigns M0.7 and the
owner-consistency gate.

The actual tree instead exposes the runnable composition from
`packages/app/src/cli.ts:181-223`, app runtime code from `packages/app/src`,
and UI contracts/projection from `packages/ui`. Exact command:

```sh
rg --files packages/adapters packages/app packages/ui | sort | \
  rg '(^|/)(sqlite|operations|standalone|cordis-host|shell|surfaces|kit)(/|$)'
```

Output was one path: `packages/ui/surfaces/dsh-dashboard-replay.html`.
The candidate does contain that static replay asset under `packages/ui/surfaces`,
but it has no dedicated `packages/ui/surfaces` implementation module, and no
`packages/app/cordis-host`, `packages/app/standalone`, `packages/ui/shell`, or
`packages/ui/kit` paths. Corrected conclusion: the documented M0.7 owner/path
contract remains UNVERIFIED against the current code tree. The current
`packages/app/src` composition may be the accepted replacement, and the static
replay asset may be the intended surface handoff, but neither replacement is
declared in the cited MVP plan.

### Persistence ownership check

The apparent app-side journal paths are not a second Organ Journal:

- `packages/app/src/ui-runtime/journal.ts:19-22` explicitly identifies
  `UiRuntimeJournal` as an app-owned UI projection journal, not lifecycle state.
- `packages/app/src/ui-runtime/journal.ts:197-205` says `FileCheckpointStore`
  wraps the authoritative `JsonlOrganJournal`.
- `packages/app/src/agent-operation.ts:158-159` creates the normal checkpoint
  port with `createJsonlCheckpointJournal`.
- `packages/app/src/ui-runtime/index.ts:123-143` composes the mode-scoped
  checkpoint store and projection journal; it does not expose either to UI as
  raw Journal state.

Result: no duplicate authoritative Journal owner was proven in the inspected
path. This row is PASS.

## Fallback / double-path audit

### PASS: explicit driver composition fails closed

- `packages/app/src/agent-driver-composition.ts:285-308` selects `fake` only
  when `driverRef === 'fake'`; an unknown driver throws, and a `dsh` driver
  without DSH config throws. It does not substitute fake for DSH.
- `tests/app/app.test.ts:1145-1179` directly tests fake selection and missing
  DSH configuration failure.

### PASS: explicit UI mode mismatch does not switch providers

- `packages/app/src/cli.ts:181-206` builds exactly one port from the selected
  mode; `fake` selects `buildFakeExecutionPort`, `rcc` selects
  `buildRccExecutionPort`.
- `packages/app/src/ui-runtime/server.ts:375-385` rejects a request whose mode
  differs from the running mode.
- `tests/app/ui-runtime.test.ts:2438-2476` proves an RCC request against fake
  runtime returns `execution.mode.mismatch` and asks for restart.
- `README.md:79-81` and `docs/ui/README.md:27-35` explicitly require RCC
  failure to remain visible rather than fall back to fake.

### PASS: RCC readiness failure remains unavailable

- `packages/app/src/ui-runtime/index.ts:123-126` probes only in RCC mode and
  carries readiness/error into the service.
- `packages/app/src/ui-runtime/service.ts:830-843` rejects execution unless
  runtime state is `ready` or declared `degraded`; it raises the provider
  owner/error/next action.
- `tests/app/ui-runtime.test.ts:2694-2766` proves `dependency-missing`
  remains `unavailable`, preserves owner `humanagent.provider-adapter.rcc-v3`,
  and creates no operation.

### PASS: runtime-pool “fallback” identifiers are evidence normalization, not
execution fallback

The exact search finds `fallbackEvidenceRefs` in
`packages/runtime/src/orchestration/runtime-pool.ts:125-153,379-399` and a
`fallback` error-normalization object in
`packages/runtime/src/orchestration/manager.ts:82-109`. The call paths only
choose existing evidence or synthesize an evidence reference while returning a
blocked issue; they do not select another runtime/provider. This is confirmed by
`tests/runtime/admission/admission.test.ts:165-214` (reuse/spawn/wait/blocked)
and `tests/runtime/orchestration/orchestration.test.ts:1024-1049,1051-1070,
1274-1310,1422-1440` (blocked/attention/evidence/retry behavior).

### PASS: missing terminal/error state is not converted to success

- `packages/app/src/ui-runtime/fake-port.ts:195-207` throws when a replay has
  no terminal state.
- `tests/app/ui-runtime.test.ts:1569-1602` proves failed/blocked/waiting
  terminal states are preserved and missing terminal state becomes failed.
- `tests/app/ui-runtime.test.ts:1737-1749` proves corrupted projection journal
  records fail explicitly rather than being dropped.

### UNVERIFIED finding F1: implicit CLI fake selection

`packages/app/src/cli.ts:181` uses `option(args, '--mode') ?? 'fake'`. Thus
`serve` without `--mode` silently chooses fake. Fake is an allowed MVP backend,
and no provider failure was shown to trigger this branch; however, the CLI
documentation shows explicit `serve --mode fake` or `serve --mode rcc`
(`README.md:63-70`), while the design requires mode selection to be explicit at
the API boundary (`docs/goals/ui-provider-loop-goal.md:116-123`). There is no
negative test for omitted CLI mode in the inspected test inventory.

Required resolution: either document the default as an intentional MVP CLI
policy and add a test, or require `--mode` and fail with owner/next-action
evidence. This audit does not change product code.

### UNVERIFIED finding F2: legacy checkpoint closure read path

`packages/runtime/src/checkpoints/submission.ts:40-46,72-88` first reads the
scoped closure id, then reads the legacy id and accepts it if the closure kind,
checkpoint identity, outcome, next action, and evidence scopes match. The path is
not silent success: mismatch returns null and the caller retains the normal
closure/reconcile behavior. It is nevertheless a second compatibility read path
whose design-level owner, version boundary, and retirement condition are not
declared in the inspected architecture/goal documents.

The only direct declaration found is the test name
`tests/runtime/checkpoints/checkpoint-submission.test.ts:604`,
“legacy checkpoint closure ids remain readable for submission retries and
reentry”. That is test coverage, not a project-level compatibility contract.

Required resolution: record this as an explicit one-version compatibility
exception under the checkpoint owner, including sunset/removal evidence; or remove
the legacy read branch after proving no supported data needs it. No code change
was made in this audit.

## Exact search evidence

Commands executed in the candidate worktree:

```sh
rg -n -i "fallback|silent(ly)?|double.?path|dual.?path|degrad(e|ed|ation)?|alternate|secondary" packages/core/src packages/runtime/src packages/app/src packages/ui packages/adapters/jsonl/src packages/adapters/filesystem/src packages/adapters/memory/src packages/adapters/provider/src packages/adapters/testing/src --glob '*.ts'
```

Result: 38 matching lines. Reviewed matches were classified as explicit
failure/evidence normalization, health state, watchdog stop, or the two findings
above; no match alone was treated as a violation.

```sh
rg -n -i "catch\s*\{|catch\s*\(" packages/core/src packages/runtime/src packages/app/src packages/ui packages/adapters/{jsonl,filesystem,memory,provider,testing}/src --glob '*.ts'
```

Result: 279 matching lines. Catch blocks were not treated as fallback findings
without a call-path check; the inspected provider, journal, orchestration, and
UI paths preserve explicit error/owner/next-action results.

```sh
rg -n -i "mode ===|mode !==|driverRef|buildFake|buildRcc|providerState|readiness.state" packages/app/src packages/runtime/src packages/ui packages/adapters/provider/src --glob '*.ts'
```

Result: 64 matching lines. Relevant mode/driver paths are cited above.

Owner/source inventory command:

```sh
rg -n "packages/(core|runtime|contracts|app|ui)|adapters/(jsonl|sqlite|filesystem|provider|dsh|operations)|Organ Journal|Index|owner" AGENTS.md docs/goals/mvp-to-milestones.md docs/architecture/context-contract.md README.md
```

The output contains the owner registry, MVP module plan, and the cited
architecture references. The current-tree comparison is the `rg --files` command
above.

## Required gates

| Gate | Result |
|---|---|
| `pnpm typecheck` | PASS, exit 0 (`tsc --noEmit`) |
| `pnpm test:release` | PASS, exit 0; 31 tests, 31 pass, 0 fail |
| `git diff --check` | PASS, exit 0, no output |

These gates validate the candidate baseline/report workspace. They do not turn
the two UNVERIFIED audit findings into PASS.

## Acceptance boundary

No product code, tests, maps, lockfiles, or other evidence files were modified.
No merge or push performed. Overall MVP #28 owner/no-fallback acceptance remains
`UNVERIFIED` pending explicit documentation/coverage for F1/F2 and alignment of
the MVP plan's Host/standalone owner paths with the current composition.
