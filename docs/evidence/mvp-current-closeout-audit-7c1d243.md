# HumanAgent MVP current-main closeout audit

## Verdicts

| Gate | Verdict | Evidence-bound conclusion |
|---|---|---|
| Gate 18: actual-entry fake replay equivalence | **FAIL** | Same valid input reaches `succeeded` in both entries, but output, event, checkpoint/operation evidence, and provider-close semantics diverge at entry/driver composition. The required equivalence is disproven. |
| Gate 25: operation closure | **UNVERIFIED** | The actual `serve` path closes the visible fake provider operation and checkpoint, but does not compose AgentIo, EventBus-backed runtime execution, M3/Orchestration/HarnessNodeRuntime, or supervisor lease startup. Memory analysis is reachable but the observed consumer leaves a pending retry. Rejected interaction has no live interaction-closure endpoint. |
| Gate 28: owner / no-fallback | **UNVERIFIED** | Provider/driver selection fails closed and no silent provider switch was observed. However, `serve` silently defaults omitted `--mode` to fake, the legacy checkpoint-closure read boundary has no declared version/sunset owner, and the documented Cordis Host/standalone paths do not match the current runnable `packages/app/src` composition. |

This report audits source commit `7c1d243ab7b75bcbf1c9e7dcc208e86755fa31db` only. It does not claim DSH, RCC, real-model, production, merge, push, or release completion.

## Baseline and scope

- Repository: `/Volumes/extension/code/humanagent`
- Worktree: `/Volumes/extension/code/humanagent/playground/mvp-cur-audit-r1-7c1d243`
- Branch: `codex/mvp-cur-audit-r1-7c1d243`
- Base / tested HEAD: `7c1d243ab7b75bcbf1c9e7dcc208e86755fa31db`
- Root `main`: dirty before and after audit; preserved and not edited.
- Worktree: clean before audit; this report is the only permitted write.
- Temporary runtime roots: `/tmp/humanagent-closeout-r1.SmYcyQ`; no product files were written there.

The governing closeout contract is `docs/goals/mvp-to-milestones.md:121-150`. In particular, Gate 18 requires fake replay and the actual standalone entry to agree, and Gate 25 requires the runtime stages and operations to have reachable closure evidence rather than only isolated source/tests.

## Gate 18 — actual-entry equivalence

### Compared commands

Build used by both entries:

```sh
pnpm build:app
```

Standalone entry:

```sh
node dist/app/app/src/cli.js run \
  --workspace /Volumes/extension/code/humanagent/playground/mvp-cur-audit-r1-7c1d243 \
  --control-root /tmp/humanagent-closeout-r1.SmYcyQ/run-control \
  --plan default \
  --prompt 'same valid input: produce the fixed fake replay result' \
  --session same-valid-run
```

Observed exit: `0`.

Observed high-level result:

```json
{
  "command": "run",
  "state": "stopped",
  "taskId": "same-valid-run",
  "operationId": "runtime-runtime-same-valid-run-epoch-1",
  "executionEpoch": 1,
  "outcome": "succeeded",
  "checkpointId": "same-valid-run-1-1",
  "observedKinds": ["fake.operation"]
}
```

The standalone JSONL evidence was written to:

- `/tmp/humanagent-closeout-r1.SmYcyQ/run-control/project/-Volumes-extension-code-humanagent-playground-mvp-cur-audit-r1-7c1d243/journal/checkpoints.jsonl`
- `/tmp/humanagent-closeout-r1.SmYcyQ/run-control/project/-Volumes-extension-code-humanagent-playground-mvp-cur-audit-r1-7c1d243/sessions/same-valid-run.jsonl`
- `/tmp/humanagent-closeout-r1.SmYcyQ/run-control/project/-Volumes-extension-code-humanagent-playground-mvp-cur-audit-r1-7c1d243/run-notes/same-valid-run.manifest.json`

The checkpoint outcome is `succeeded`, summary `agent operation succeeded`, with one `humanagent.fake` execution evidence reference. The session state is `stopped` because the CLI closes the session after the successful checkpoint; this is distinct from the checkpoint outcome.

Actual fake server entry:

```sh
node dist/app/app/src/cli.js serve \
  --mode fake \
  --workspace /Volumes/extension/code/humanagent/playground/mvp-cur-audit-r1-7c1d243 \
  --control-root /tmp/humanagent-closeout-r1.SmYcyQ/serve-control \
  --port 0
```

Observed launch: exit remains running as the server process; URL `http://127.0.0.1:58110`; launch JSON reported `mode=fake`, `bindingId=fake-default`, `providerId=fake-provider`, `protocol=responses`.

Through that live URL, the same input was submitted with:

```sh
curl -X POST http://127.0.0.1:58110/api/tasks \
  -H 'content-type: application/json' \
  --data '{"title":"same valid input","directive":"same valid input: produce the fixed fake replay result"}'

curl -X POST http://127.0.0.1:58110/api/tasks/ui-task-b83d4b5a-b613-4ae2-aa6a-d99f1da05e77-1/executions \
  -H 'content-type: application/json' \
  --data '{"mode":"fake","prompt":"same valid input: produce the fixed fake replay result"}'

curl http://127.0.0.1:58110/api/executions/ui-operation-1/events
curl http://127.0.0.1:58110/api/tasks/ui-task-b83d4b5a-b613-4ae2-aa6a-d99f1da05e77-1
curl http://127.0.0.1:58110/api/tasks/ui-task-b83d4b5a-b613-4ae2-aa6a-d99f1da05e77-1/observation
```

Observed server results:

- `POST /api/tasks`: `201 Created`; task id `ui-task-b83d4b5a-b613-4ae2-aa6a-d99f1da05e77-1`.
- `POST .../executions`: `202 Accepted`; operation `ui-operation-1`, epoch `1`.
- SSE event kinds: `execution.started`, `provider.model`, `provider.output`, `provider.tool`, `provider.output`, provider-terminal `execution.terminal`, `execution.settling`, `checkpoint.committed`, final `execution.terminal`.
- Final event state: `succeeded`; summary `execution succeeded; provider closed`; evidence includes `fake/settle-succeeded` and `fake/close`.
- Task detail: state `ready`, output `fake replay: draft output chunk 1fake replay: final output chunk 2`, `artifacts=[]`.
- Observation: `input.received`, `provider.execute`, and `checkpoint.commit`; provider output and close evidence are visible.
- Server checkpoint: `/tmp/humanagent-closeout-r1.SmYcyQ/serve-control/project/-Volumes-extension-code-humanagent-playground-mvp-cur-audit-r1-7c1d243/checkpoints/ui-runtime/fake/task-ui-task-b83d4b5a-b613-4ae2-aa6a-d99f1da05e77-1-cycle-ui-cycle-1.jsonl`, outcome `succeeded`.
- Server UI journal: `.../checkpoints/ui-runtime/fake/ui-runtime-journal.jsonl`, operation events 1–9, final provider close present.

### Equivalence comparison and first divergence

| Surface | `run` standalone | `serve --mode fake` | Result |
|---|---|---|---|
| Same prompt | exact same valid input | exact same valid input | equivalent |
| Epoch / high-level outcome | epoch `1`, `succeeded` | epoch `1`, `succeeded` | equivalent only at high level |
| Task output | no task-output field; checkpoint summary only | two replay chunks projected into task detail/dashboard | **not equivalent** |
| Event stream | one `fake.operation` observation kind | model/output/tool/output/provider-terminal/settling/checkpoint/final terminal | **not equivalent** |
| Checkpoint | `same-valid-run-1-1`, app run-operation checkpoint | `checkpoint-ui-task-...-1-1`, UI runtime checkpoint | **not equivalent as entry evidence** |
| Provider operation closure | standalone result does not expose provider close; one fake operation evidence ref | explicit settle plus `fake/close` in final event | **not equivalent** |
| Artifact refs | no task output/artifact projection | task output exists, `artifacts=[]` | **not equivalent** |

The first divergence is composition, before persistence: `run` calls `runAgentOperation` (`packages/app/src/cli.ts:156-205`), which selects the configured `FakeAgentDriver`; `serve` calls `buildFakeExecutionPort` and `startUiRuntime` (`packages/app/src/cli.ts:357-410`), which uses `FakeReplayExecutionRuntimePort` (`packages/app/src/ui-runtime/fake-port.ts:35-41,77-101`). The two fake drivers have different event/output contracts. This is not a persistence-only mismatch.

### Same-input error path

Standalone invalid input command:

```sh
node dist/app/app/src/cli.js run \
  --workspace /Volumes/extension/code/humanagent/playground/mvp-cur-audit-r1-7c1d243 \
  --control-root /tmp/humanagent-closeout-r1.SmYcyQ/run-error-control \
  --plan default --prompt '' --session same-invalid-run
```

Observed exit: `1`; output:

```json
{"error":{"code":"host-error","ownerId":"host","nextAction":"inspect the host error and retry after correcting the runtime environment","message":"missing --prompt"}}
```

Same invalid prompt through the live server returned `400 Bad Request`:

```json
{"error":{"code":"request.missing-field","ownerId":"humanagent.app","message":"request field prompt is required","nextAction":"provide a non-empty prompt"}}
```

The error path has different owners, codes, and next actions, so negative-path equivalence is also not demonstrated. This reinforces the Gate 18 FAIL; it is not a reason to add a fallback in this audit.

## Gate 25 — actual operation closure

### Actual `serve` composition

The actual CLI path (`packages/app/src/cli.ts:314-410`) does the following:

1. Resolves control/config roots.
2. Calls `composeMemoryRuntime` (`:332-356`).
3. Selects exactly one `buildFakeExecutionPort` or `buildRccExecutionPort` (`:357-364`).
4. Calls `startUiRuntime` (`:365-398`) and prints the server URL (`:399-410`).

It does not call `CordisHost`, `createCordisHost`, `createM3Assembly`, `runSupervisorStartup`, or `acquireDaemonLease`. The source search found `HarnessNodeRuntime` at `packages/runtime/src/nodes/node-runtime.ts:87`, `OrchestrationManager`/`M3Assembly` at `packages/app/src/m3-assembly.ts:8-21,38-48,133-173`, and supervisor startup at `packages/app/src/supervisor/supervisor.ts:459-491`, but no live `serve` composition edge to these owners. The default serve control root also contained no `daemon/lease.json` after startup.

The live UI coordinator itself declares the missing capabilities instead of claiming them:

- `packages/runtime/src/ui-runtime/coordinator.ts:435-443`: `agentIoRequestLifecycle` is `unavailable`; the reason says the UI driver exposes normalized provider events, not AgentIo raw chunks, restart budgets, or settlement sinks.
- `packages/runtime/src/ui-runtime/coordinator.ts:445-450`: `eventBus` is `unavailable`; the reason says `UiRuntimeService` does not provide EventBus journal, registry, or external-operation owner.

The visible fake operation did close its own provider path: SSE ended with `checkpoint.committed` followed by final `execution.terminal` and `fake/close`. That proves only the current UI provider coordinator path, not the full Gate 25 operation inventory.

### Memory event handler / consumer

This edge is present and was exercised, but it did not close cleanly:

- `packages/app/src/memory-runtime.ts:214-230` builds EventBus ports and publishes memory boundary events.
- `packages/app/src/memory-runtime.ts:268-276` calls `consumeEvents` with `composition.eventHandler` and `composition.barrierDriver`.
- `packages/app/src/cli.ts:379-393` publishes the checkpoint boundary and immediately calls `memoryRuntime.consume()`.
- `packages/app/src/memory-composition.ts:680-734` creates/binds `MemoryAgent`, its event handler, and barrier driver.

Actual `/tmp/.../serve-control/.../journal/events.jsonl` evidence:

1. `seq=1`: `memory.analysis.requested` for the succeeded checkpoint.
2. `seq=2`: external operation pending for memory analysis.
3. `seq=3`: barrier intent disposition `applied`.
4. `seq=4`: retry pending, owner `memory-agent`, failure `memory-agent-prompt-unavailable`, next attempt scheduled.

No prompt file existed under the temporary `memory-audit` root. Therefore the actual consumer has a durable retry obligation, not a completed memory operation closure. This is **UNVERIFIED**, not PASS and not silently upgraded to success.

### Rejected interaction and supervisor closure

`ExplicitIntake.reject()` transitions to `rejected` with next action `close-interaction` (`packages/runtime/src/intake/explicit-intake.ts:300-310`). `submitInteractionClosure` exists (`packages/runtime/src/checkpoints/submission.ts:278-313`), but the live UI server exposes no explicit interaction-reject/interaction-close route: `packages/app/src/ui-runtime/server.ts:265-360` contains input, matching, proposal, status-only, confirmation, and dispatch routes only. The service source has no call to `submitInteractionClosure`; the only `reject` route found is skill-candidate review (`packages/app/src/ui-runtime/server.ts:235-245`). A focused intake/closure test cannot substitute for this absent actual edge.

Supervisor lease/startup is implemented and tested in `packages/app/src/supervisor/supervisor.ts:365-491`, but the actual serve entry has no supervisor call and emitted no daemon lease. Its startup/lease closure is therefore not proven for the actual entry.

### Gate 25 minimal blocking repair scopes

- Runtime/UI owner: either compose AgentIo + EventBus + durable settlement through the actual entry, or explicitly remove those operations from the MVP live acceptance inventory.
- App assembly owner: decide whether M3/Orchestration/HarnessNodeRuntime is MVP live scope; if yes, connect `createM3Assembly` and prove admitted/settled/failed/waiting paths through `serve`.
- Memory/EventBus owner: provide the declared audit prompt or surface the retry as a stable waiting/attention projection and prove restart/retry closure.
- Explicit-intake owner: add a live rejection-to-`InteractionClosure` operation with durable evidence, or declare a separate durable interaction journal as the sole closure owner.
- Supervisor owner: bind lease/startup/dispose to the actual server entry, or document and test the intentional single-process exclusion.

## Gate 28 — owner and no-fallback audit

### Actual default policy

Source `packages/app/src/cli.ts:314-317` uses `option(args, '--mode') ?? 'fake'`. An actual command omitting `--mode` launched at `http://127.0.0.1:61003` and reported:

```json
{"command":"serve","mode":"fake","bindingId":"fake-default","providerId":"fake-provider","protocol":"responses"}
```

`GET /api/runtime/status` reported `mode=fake`, `state=ready`, `providerState=ready`, and `detail=固定 replay，不访问 RCC`. This is an observed implicit selection, not a provider failure fallback. The MVP goal/docs do not explicitly declare omitted CLI mode as a policy, while the API execution endpoint requires an explicit `mode` and rejects mismatches (`packages/app/src/ui-runtime/server.ts:375-385`). Keep this as **UNVERIFIED** until the owner documents and negatively tests the intended default or requires explicit mode.

### Legacy checkpoint-closure boundary

`packages/runtime/src/checkpoints/submission.ts:40-46,72-88` first reads the scoped id `checkpoint-closure:${checkpointCommitId(...)}`, then reads `checkpoint-closure:${checkpoint.id.value}` and accepts the legacy record only after validating closure kind, checkpoint identity, outcome, summary, next action, evidence scope, and evidence membership. Mismatch returns `null`; it is not a silent success path. However, no current goal/architecture contract declares the compatibility version, owner, or retirement/sunset condition. The focused test name is not sufficient to establish a project-level compatibility boundary. Required repair: document a one-version checkpoint-owner compatibility exception with sunset evidence, or remove the legacy read after proving no supported data needs it.

### Owner/path consistency

The MVP goal names `packages/app/standalone`, `packages/app/cordis-host`, `packages/ui/shell`, `packages/ui/surfaces`, and `packages/ui/kit` (`docs/goals/mvp-to-milestones.md:68-88,100-101`). Current runnable code is under `packages/app/src` and `packages/ui`; the path search found only `packages/ui/surfaces/dsh-dashboard-replay.html` among those named directory patterns. `packages/app/src/cordis-host.ts` exists, but `serve` does not load it. This is an owner/path contract mismatch requiring arbitration or a goal update; this audit does not rename or move code.

### No silent provider fallback observed

The following are explicit and PASS at their local owner boundary:

- `packages/app/src/agent-driver-composition.ts:285-308` chooses fake only for `driverRef=fake`, rejects unknown drivers, and rejects missing DSH config; it does not substitute fake for DSH.
- `packages/app/src/cli.ts:357-364` selects one fake or RCC execution port from the selected mode.
- `packages/app/src/ui-runtime/service.ts:833-846` rejects execution when readiness is not ready/degraded, preserving provider error/owner/next action.
- `packages/app/src/ui-runtime/fake-port.ts:195-207` fails when a replay has no terminal state instead of reporting success.
- `packages/app/src/agent-execution.ts:143` and orchestration `fallbackEvidenceRefs` paths normalize missing evidence; they do not select another provider. They are evidence fallbacks, not execution fallbacks.

No provider failure or RCC path was used in this MVP audit; no RCC/DSH claim is made.

## Required command gates

All commands were run from the audit worktree at the tested HEAD above:

| Command | Result |
|---|---|
| `pnpm build:app` | **PASS**, exit `0`; TypeScript app build and template asset copy completed. |
| `pnpm typecheck` | **PASS**, exit `0`; `tsc --noEmit`. |
| `pnpm test:app` | **PASS**, exit `0`; direct compiled test replay reports `1..157`, `157` pass, `0` fail, `0` skipped, `0` todo. |
| `git diff --check` | **PASS**, exit `0`, no output. |
| actual `run` valid input | **PASS execution only**; exit `0`, checkpoint outcome `succeeded`; Gate 18 equivalence still FAIL. |
| actual `serve --mode fake` valid input | **PASS execution only**; live HTTP/SSE final provider closure and checkpoint `succeeded`; Gate 18 equivalence still FAIL. |
| actual `run` empty prompt | **PASS explicit error**; exit `1`, structured `host-error`, `missing --prompt`. |
| actual `serve` empty prompt | **PASS explicit error**; `400`, `request.missing-field`, `prompt is required`; error semantics differ from `run`. |
| actual `serve` with omitted `--mode` | **OBSERVED**, launches fake/ready; policy remains Gate 28 **UNVERIFIED**. |

One shell wrapper attempt used zsh's read-only variable name `status` and failed after the already-successful typecheck (`zsh:1: read-only variable: status`). It was a wrapper error, not a project gate result; the corrected `pnpm typecheck` command returned exit `0`.

## Acceptance boundary and next action

Candidate acceptance: **INCOMPLETE**. The report proves Gate 18 FAIL, Gate 25 UNVERIFIED, and Gate 28 UNVERIFIED on current source and actual entries. Minimal next step: assign the three gate owners above to repair or explicitly narrow each live contract, then rerun this exact audit from the resulting candidate SHA. No product code, tests, maps, lockfiles, root `main`, merge, push, reset, or release was changed.

## Follow-up candidate: checkpoint compatibility owner

At candidate base `1434cda9b5d341c2754f99270541279961056c70`, the checkpoint
owner follow-up declares one compatibility boundary in
`packages/runtime/src/checkpoints/submission.ts`: v2
`checkpoint-commit-id` is the current scoped identity and v1
`checkpoint-id` is a read-only legacy exception. Persisted
`CheckpointClosureRecord.compatibilityVersion` is validated on the real
closure read path. Legacy content mismatches now fail before Journal append or
canonical fallback; unsupported persisted compatibility versions fail
explicitly. The v1 reader has a removal condition: all supported
closure stores must contain no legacy checkpoint-id records. Focused positive,
negative, and unsupported-version tests bind this contract. This follow-up
does not change the Gate 18/25 actual-entry composition or provider behavior;
the candidate still requires the normal independent review and integration
gates before changing the prior Gate 28 audit verdict.
