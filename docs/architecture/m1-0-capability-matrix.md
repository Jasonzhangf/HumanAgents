# M1-0 Capability and Failure Matrix

Status: `M1-0-REBASELINE-CANDIDATE / REVIEW-PENDING / NOT-PASS`
Review time: `2026-09-16T16:12:51-0700` (local), `2026-09-16T23:12:51Z` (UTC)
Candidate base: `37ca6fa1ad3db70e017945f449f7b7fb99170972`
Candidate worktree: `/Volumes/extension/code/humanagent/playground/m1-0-rebaseline-20260916`
DSH input: commit `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`, tree `80b651cca20f29d587518cf07a978f2bc58bc2c1`
Source expansion rechecked: `2026-09-16T22:37:33Z` (UTC)

This is a read-only M1-0 rebaseline record. It does not implement an adapter,
install a plugin, make a provider request, or prove provider/DSH runtime
completion. Commit-bound Codex review, native Astra M1-0 review and parent
acceptance remain pending for this candidate.

The prior `c291e7961a515f6d7af9304e7fd1d257929aef26` source review remains
historical evidence only. This candidate refreshes the source and non-secret
RCC observations against the currently locked clean DSH worktree at
`/Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915`.

## Evidence Rules

| Layer | What it proves | What it does not prove |
|---|---|---|
| RCC path/config | `~/.rcc` symlink target, non-sensitive config fields, and a live `*:4444` listener | Protocol readiness, model readiness, request/stream/tool behavior, or stop/settle |
| DSH source object | APIs, package declarations, and profile seams present in the locked commit | Installed dependencies, boot success, provider reachability, or runtime behavior |
| Protocol readiness | A selected Responses or Anthropic codec accepts the declared binding | A different protocol, DSH execution, or same-entry request |
| Same-entry request | The same HumanAgent entry performs the request and records its terminal/error semantics | DSH session lifecycle unless the DSH path is used |
| Organ health | A real probe through `OrganHealthProbePort` reports a bounded capability result and evidence ref | A health snapshot inferred from logs, listener state, or config |

No provider request, DSH launch, plugin install, RCC restart, or secret read was
performed in this review.

## Commands and Exact Observations

| Time | Command / source | Result and boundary |
|---|---|---|
| 15:37:33-0700 | `pwd; git status --short --branch; git rev-parse HEAD` | Worktree is `/Volumes/extension/code/humanagent/playground/m1-0-rebaseline-20260916`; HEAD is `37ca6fa`; status clean. |
| 15:37:33-0700 | `readlink ~/.rcc; lsof -nP -iTCP:4444 -sTCP:LISTEN` | `~/.rcc -> /Volumes/extension/.rcc`; `rccv3` is listening on `*:4444` (PID observed as `58485`). Path/listener evidence only. |
| 15:37:33-0700 | `rg -n 'allowed_transports|routecodex_v3_4444' /Users/fanzhang/.rcc/config.toml; rg -n 'providerId|type\s*=' /Users/fanzhang/.rcc/provider/cc/config.v2.toml /Users/fanzhang/.rcc/provider/cc-sol/config.v2.toml /Users/fanzhang/.rcc/provider/goaichat/config.v2.toml` | `/Users/fanzhang/.rcc/config.toml` declares `routecodex_v3_4444` and `allowed_transports = ["json", "sse"]`; the provider files declare `cc`/`cc-sol` as `responses` and `goaichat` as `anthropic`. Only these non-secret matched fields were retained. |
| 15:37:33-0700 | `curl --max-time 5 -fsS http://127.0.0.1:4444/health` | RCC v3 health returned `status: ok`, `port: 4444`, `server_id: routecodex_v3_4444`, build `0.90.4789`. Health/readiness evidence only. |
| 15:37:33-0700 | `git -C /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915 status --short --branch; git -C /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915 rev-parse HEAD^{commit} HEAD^{tree}` | Clean DSH worktree at commit `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`, tree `80b651cca20f29d587518cf07a978f2bc58bc2c1`. Clean source baseline evidence. |
| 15:37:33-0700 | `git -C /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915 show 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720:package.json` | Root declares version `0.1.6-alpha.1`, MIT and `pnpm@11.7.0`; source declaration only. |
| 15:37:33-0700 | `git -C /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915 show 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720:apps/cli/package.json; git -C /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915 show 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720:apps/cli/src/bin.ts; git -C /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915 show 0d1f50007f9bca3f52b06e1c3074fa14d5fb0720:apps/cli/src/args.ts` | Public package `@deepseek-ai/dsh`, bin `dsh: lib/bin.js`; profile boot, `web`, `plugin`, config dump, `--patch` and forwarded app arguments are present. Runtime boot/install remains unverified. |
| 15:37:33-0700 | `if test -e /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915/node_modules; then echo 'present node_modules'; else echo 'absent node_modules'; fi; if test -e /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915/apps/cli/lib; then echo 'present apps/cli/lib'; else echo 'absent apps/cli/lib'; fi; if test -e /Volumes/extension/code/dsh/playground/humanagent-0.1.6-20260915/apps/cli/lib/bin.js; then echo 'present apps/cli/lib/bin.js'; else echo 'absent apps/cli/lib/bin.js'; fi` | Exact output was three lines: `present node_modules`, `absent apps/cli/lib`, `absent apps/cli/lib/bin.js`; no built CLI executable was treated as available. |
| 15:37:33-0700 | current DSH source seam scan | Confirmed current source contains `AgentRegistry.create`/`resume`, `AgentHandle.dispose`, session-controller `follow`/`cancel`, JSONL persistence `create`/`open`, and Cordis `ctx.effect`/`ctx.on` seams. Source evidence only. |

The original `/Volumes/extension/code/dsh` checkout was not used as clean
evidence. The previously recorded clean-baseline verification is the project
record for the locked commit; this review read only commit objects.

## Provider Bindings

These are three separate proposed bindings. Shared listener does not merge their
identity.

| Binding | Protocol | Current fact | Status | Owner / next action |
|---|---|---|---|---|
| `cc` | `responses` | `providerId = "cc"`, `type = "responses"` in `~/.rcc/provider/cc/config.v2.toml` | `config-seen; protocol-unverified` | Provider adapter owner: bind explicit endpoint ref and model ref; run codec fixture, then same HumanAgent entry request. |
| `cc-sol` | `responses` | `providerId = "cc-sol"`, `type = "responses"` in `~/.rcc/provider/cc-sol/config.v2.toml`; route/model examples include `cc-sol/gpt-5.6-sol` | `config-seen; protocol-unverified` | Provider adapter owner: preserve independent identity; prove Responses stream/tool/error/cancel/settle and same-entry request. |
| `goaichat` | `anthropic` | `providerId = "goaichat"`, `type = "anthropic"`; route/model examples include `goaichat/glm-5.3` | `config-seen; protocol-unverified` | Anthropic adapter owner: prove independent message/content-block stream, tool/error/cancel/settle and same-entry request. |
| RCC v3 `4444` | `json` or `sse` | Listener and `allowed_transports` declaration observed | `listener-ready only` | Provider supervisor: select a binding and verify protocol readiness without guessing from listener state. |

Endpoint, protocol, model, route and auth alias must be explicit binding facts
stored as non-secret references/digests. No auditable same-entry binding was
produced here. Secret file paths and values are intentionally omitted.

## DSH Capability Matrix

Evidence references are commit-object paths at the locked DSH commit unless
otherwise stated. `unverified` means the source did not establish a runtime
capability in this review.

| Capability | Evidence | Status | Owner / next action |
|---|---|---|---|
| Public entrypoint | `apps/cli/package.json` bin `dsh: lib/bin.js`; `apps/cli/src/bin.ts` | `source-present; runtime-unverified` | DSH adapter owner: run the approved dedicated profile entry after M1-0. |
| Dependencies | `package.json` workspace, pnpm and Node declarations; CLI dependencies include Cordis, app boot, agent/headless/session/tool/LLM packages | `declared; install-unverified` | DSH adapter owner: lock installed dependency tree and compatibility result. |
| Profile seam | `apps/cli/src/args.ts` supports `--profile`, `--from-default-profile`, ordered `--patch`; `profile-boot.ts` is the boot path | `source-present; boot-unverified` | DSH profile owner: create and lock dedicated `humanagent` profile; do not alter default profile. |
| Plugin seam | `plugin` command forwards profile plugin arguments to pnpm; CLI package exposes Cordis loader/include/HMR dependencies | `source-present; install/load-unverified` | DSH/plugin owner: identify approved bundle entry, version, digest and dispose behavior. |
| Session create | `packages/api/session-controller/src/index.ts:244-247` delegates `SessionCommandController.create`; `commands.ts:87-126` validates `workspaceId`/`cwd`, resolves workspace, calls `ensureSession`, attaches workspace, and maps failures in `commands.ts:519-539`; `core/agent/src/index.ts:388-398` requires registered factory and delegates `AgentFactory.createAgent`; `core/agent-loop/src/index.ts:764-848` runs create/setup/publish through `createAgent`/`setupAndPublish`/`initializeAgent` with rollback | `source-proven; runtime-unverified` | DSH adapter owner: run one real same-entry create receipt, then map to HumanAgent session identity. |
| Session resume | `core/agent/src/index.ts:401-413` requires factory and delegates `AgentFactory.resume`; `core/agent-loop/src/index.ts:857-939` requires `ctx.sessionPersistence`, opens persisted session for write, reads and repairs interrupted turns, then setup/publishes; missing persistence is rejected at `:858-862`, and setup/owner abort paths remain source/runtime boundaries | `source-proven; persistence-runtime-unverified` | DSH adapter owner: prove resume against a real persisted session and map only to `EvidenceRef`. |
| Events | `api/session-controller/src/index.ts:400-403` delegates `follow`; `history.ts:119-149` subscribes to `session/event` and emits a complete opening snapshot followed by durable event frames plus opted-in assistant frames; `types.ts:427-437` defines `SessionWireEvent`; `types.ts:514-526` defines `SessionFollowFrame` | `source-proven; mapping/runtime-unverified` | DSH adapter owner: record ordered model/tool/error/terminal events and epoch mapping from a real stream. |
| Tools | CLI dependencies include tool packages; filesystem, bash, web, todo, ask-user and other tool packages are declared | `declared; enabled-set-unverified` | DSH adapter owner: lock one representative tool and its permission/schema/result evidence. |
| Cancel / close / settle | `api/session-controller/src/commands.ts:497-511` requires live attached agent, rejects not-found/subagent-owner, calls `agent.cancel(..., { keepInbox: true })`, and returns only `SessionCancelValue.accepted: true` (`types.ts:356-359`); `packages/core/agent/src/index.ts:146-163` documents the `AgentHandle.dispose()` interface contract, while the concrete teardown lives at `packages/core/agent-loop/src/index.ts:573-621` with publication wait, Step A machine quiescence (`:584-600`), Step B session close drain (`:601-609`), Step C registry/bookkeeping (`:610-616`) and aggregation (`:617-621`); `:619` creates an `AggregateError` only for multiple local Step A/B failures, while `:617` rethrows one unchanged. Current create/setup/rollback uses `create` `:702-716`, `createAgent` `:764-801`, `setupAndPublish` `:803-830`, `initializeAgent` `:832-848`, and `resumeWith` `:866-939`; `createAgent` `:781` catches abandoned handle close, `resumeWith` `:896` has an uncaught fire-and-forget close, and `resumeWith` `:933-935` awaits the final handle close. `settleAssistant` at `packages/api/session-controller/src/client/contract/events.ts:177-195` is a client message-window projection only, not stop/teardown settle evidence; see "Stop / Teardown Source Seam" below | `source-proven; cancel-receipt-only; teardown-source-only; rollback-source-only; runtime-unverified` | DSH adapter error/stop mapping owner: prove cancel, settle, resource release and stopped checkpoint are independent, and that the recorded failure surface matches the locked source on a real DSH instance. |
| Persistence / session log | `session/session-persistence-jsonl/src/index.ts:87-99` requires explicit `root`; `:229-239` registers `ctx.sessionPersistence`; `:299-327` lazy `create` with `SessionAlreadyExistsError`; `:336-406` read/write `open` with `SessionPersistenceNotFoundError` and lock-release cleanup; `:495-499` requires stored log; failure classes include `SessionAlreadyOwnedError`, `SessionPersistenceCorruptionError`, and `SessionFormatUnsupportedError` | `source-proven; filesystem/replay-unverified` | DSH evidence owner: record session log path/digest, append/restore semantics and Journal separation from a real backend. |
| License | Root `LICENSE` and root/CLI package declarations state MIT; third-party notices are present | `source-verified` | Release owner: verify any selected plugin/bundle dependency licenses before use. |
| Endpoint / protocol / model binding | `llm-pi-ai/package.json:16-23` exports the package; `src/index.ts:76,82,88,145` exports `Config`, `PiAiProviderProfile`, `supportedProtocols`, and `apply`; `src/config.ts:90-109,221-227` defines provider routes with `api`, `baseURL`, `models`, `modelOverrides`; `src/provider.ts:47-51,172-191` is the auditable protocol table and provider build path; see "Locked DSH Source Seam" below | `source-proven; binding/runtime-unverified` | Provider + DSH owners: produce lock with endpoint ref, protocol, model ref, config digest and capability digest. |
| Profile/plugin compatibility | No dedicated HumanAgent profile or approved execution bundle was installed or loaded | `dependency-missing for M1 execution` | DSH profile owner: resolve approved package and compatibility evidence; do not fallback to fake. |

## Locked DSH Source Seam

This section records the endpoint/protocol/model configuration seam from locked
DSH commit objects, not from the dirty `/Volumes/extension/code/dsh` checkout.

- Package export: `packages/llm/llm-pi-ai/package.json:16-23` exports the root
  package types/default and exposes `./src/*`.
- Plugin/profile config: `packages/llm/llm-pi-ai/src/index.ts:76` exports
  `Config`, `:82` exports `PiAiProviderProfile`, `:88` exports
  `supportedProtocols`, and `:145` exports `apply(ctx, config)`. The package
  installs one generic adapter and a settings section for `providers`
  (`src/index.ts:279-291`, `:295-336`).
- Provider route shape: `packages/llm/llm-pi-ai/src/config.ts:90-109` defines
  `PiAiProviderProfile`; the `providers` dict key is the route
  (`config.ts:221-227`, `:187-188`). `api` is the wire-protocol override,
  `baseURL` is the endpoint override, `models` replaces the catalog, and
  `modelOverrides` reshapes individual catalog models.
- Default and override sources: `config.ts:97-103` says omitted `api` keeps each
  catalog model protocol and omitted `baseURL` defaults to the installed catalog
  endpoint. `catalog.ts:888` resolves model `api` as route override, then
  catalog model, then route catalog; `catalog.ts:893` resolves model `baseURL`
  as route override, then catalog model, then provider base URL. Missing api or
  base URL on an undescribed route is refused (`catalog.ts:889-895`).
- Protocol consumption: `provider.ts:47-51` contains the only protocol table for
  configured routes: `openai-completions`, `openai-responses`, and
  `anthropic-messages`. `provider.ts:172-191` reuses a catalog provider when the
  route keeps its catalog protocol and otherwise builds with `createProvider`,
  throwing `PiAiCatalogError` for unsupported protocol names.
- Explicit unavailable conclusion: the locked `llm-pi-ai` source does not name
  RCC, `cc`, `cc-sol`, `goaichat`, `~/.rcc`, or `4444`. It provides generic
  provider routes; the specific RCC endpoint/protocol/model bindings remain
  configuration/runtime evidence and are still `unverified`.

### Stop / Teardown Source Seam

The `AgentHandle.dispose()` text at `packages/core/agent/src/index.ts:146-163`
is interface/documentation semantics only. The concrete teardown is the
memoized reverse-teardown implementation that the ownership tracker and the
owner effect eventually call, located at
`packages/core/agent-loop/src/index.ts:573-621`:

- The disposer aborts the fused lifecycle (`abort.abort(...)` at `:577`),
  removes the caller and factory abort listeners (`:578-579`), and memoizes
  the single disposal promise in `disposing` so racing owners await the same
  quiescence.
- Before machine quiescence it awaits an in-flight creation publication at
  `:586` (`publication.promise`). This creation-announcement wait is part of
  the current locked source and is included in the teardown boundary.
- It uses a single local `failures: unknown[] = []` (`:583`) for collected
  errors. Only errors from two `catch` blocks enter that array.
- `Step A - machine quiescence (`:584-600`)`: after the publication wait, one `try` wraps
  `machineReady` when no machine exists (`:591`), then
  `machine.cancel({ kind: 'disposed' })` (`:594`), `await machine.whenIdle()`
  (`:595`) and `await machine.scope.dispose()` (`:596`) in that order. The
  first throw exits the `try` and is pushed into `failures`; any later
  `await` inside the same `try` is skipped on that path. When `machine` is
  `undefined` (no driver was constructed) all three calls are skipped and no
  error is recorded here.
- `Step B - session close drain (`:601-609`)`: a separate `try` awaits
  `handle?.close()` (`:606`). Any throw is pushed into `failures`. This drain
  runs after machine quiescence and is the first place a persistence
  durability failure can surface.
- `Step C - registry and bookkeeping cleanup (`:610-616`)`: a `try` runs
  `detachAgent?.()` (`:611`) then `detachSession?.()` (`:612`) with a
  `finally` that calls `untrack()` (`:614`) and, unless `ownerTriggered`,
  `await unfollowOwner()` (`:615`). Errors thrown by `detachAgent`,
  `detachSession`, `untrack` or `unfollowOwner` are NOT pushed into
  `failures` and are NOT collected into the `AggregateError`; they surface
  through normal `try`/`finally` propagation outside this boundary.
  A Step C throw will therefore also prevent the source from reaching the
  `:617-621` aggregation after that failure propagates.
- Aggregation (`:617-621`): `failures.length === 1` rethrows `failures[0]`
  directly; `failures.length > 1` throws
  `new AggregateError(failures, 'agent "<id>" disposal failed')`;
  `failures.length === 0` does not throw from this branch. The `new
  AggregateError` at `:619` only aggregates the local Step A/B `failures`
  collected by the two disposal `catch` blocks. A single `failures[0]` is
  rethrown unchanged, and that value may itself already be a lower-level
  `AggregateError` (for example a JSONL storage close or lock release
  `AggregateError`). Therefore this source does not imply a caller only
  receives an `AggregateError` when both Step A and Step B failed. Step C
  errors are never included in this local aggregation.

`createAgent` (`packages/core/agent-loop/src/index.ts:764-801`) and
`resumeWith` (`:866-939`) take a different rollback path through
`setupAndPublish` (`:803-830`) and `initializeAgent` (`:832-848`):

- The direct `create` path (`:702-716`) calls `initializeAgent`; a direct
  prepare failure closes `stored?.handle` with `await ...catch(() => {})`
  (`:709`), while initialization failure is handled by
  `initializeAgent` (`:832-848`), which cancels the prepared agent at `:839`
  and awaits `prepared.dispose().catch(() => {})` at `:846` before rethrowing
  the primary error.
- The outer `try`/`catch` around `createStoredSession` (`:773-787`) calls
  `preparation[Symbol.dispose]()` and rethrows the original error. The
  `abandoned?.handle.close().catch(() => {})` callback inside `raceAbortCall`
  (`:781`) is fire-and-forget for the abandoned handle and explicitly
  swallows any secondary close error.
- `resumeWith`'s write-handle acquisition uses a different
  `raceAbortCall` callback (`:892-897`): `(abandoned) => { void abandoned.close() }`
  at `:896` is fire-and-forget, but it has no `.catch`, no `await`, and no
  local rejection handler. An abandoned close rejection is therefore not
  explicitly swallowed by this callback and must be verified as an
  unhandled/dangling promise path separately from `createAgent`'s explicit
  catch and from `resumeWith`'s outer `finally` catch below.
- `setupAndPublish` (`:803-830`) wraps `prepare(...)` and closes
  `stored?.handle` on a direct prepare error (`:819-822`). Its setup race,
  suffix append and publish are passed to `initializeAgent` (`:824-829`);
  the shared initialization rollback cancels and then awaits
  `prepared.dispose().catch(() => {})` (`:834-847`), discarding only that
  secondary disposal error while rethrowing the primary error.
- `resumeWith`'s outer `finally` (`:933-935`) runs
  `preparation?.[Symbol.dispose]()` and
  `await handle?.close().catch(() => {})`, again swallowing the secondary
  close error. The setup error returned from `setupAndPublish` is the
  primary error the caller sees.

Across these paths the locked source therefore makes the following specific
statements:

- `machine.cancel` / `whenIdle` / `scope.dispose` share one `try` in the
  direct disposer; an early failure skips later awaits in that `try` and
  only that one error is pushed into `failures`.
- `detachAgent`, `detachSession`, `untrack` and `unfollowOwner` are NOT in
  the `failures` aggregation on the direct disposer path.
- `createAgent` / `setupAndPublish` / `resumeWith` rollback paths
  deliberately suppress secondary close/dispose errors with `.catch(() => {})`
  in the documented awaited paths; the primary prepare/setup/resume error is
  the caller-facing primary error. The `resumeWith` abandoned-handle path at
  `:896` is separate: it is fire-and-forget without `.catch`, `await`, or a
  local rejection handler.
- The `AggregateError` returned by the direct disposer is bounded to Step A
  plus Step B errors; it is not a general "all teardown errors are kept"
  envelope. This does not mean `:619` is the only `AggregateError` a caller
  could receive: the direct disposer can rethrow a single Step A/B
  `failures[0]` that is already an `AggregateError`, and primary create /
  prepare / setup / resume errors from rollback paths may also already be
  `AggregateError`s. The create/resume rollback paths do not add secondary
  close/dispose rejections back into a new outer `failures`/`AggregateError`;
  `resumeWith`'s abandoned `void abandoned.close()` also lacks the local
  catch used by the other close/dispose paths.

This chain is source-object evidence only. Resource release, persistence
close and error visibility for these paths are still
`runtime-unverified`. The next owner is the DSH adapter error/stop mapping
owner, who must observe handle close, machine quiescence, detach, untrack
and unfollowOwner, and the create/resume rollback branches, from a real
DSH instance and record what reaches the HumanAgent Journal versus what is
swallowed, including whether the `resumeWith` abandoned `void abandoned.close()`
path rejects and how the process/runtime surfaces that unhandled/dangling
promise. The `settleAssistant` function at
`packages/api/session-controller/src/client/contract/events.ts:177-195`
removes one attempt's transient rows, optionally inserts a durable assistant
entry, and publishes `kind: 'settle-assistant'`; it is client
message-window projection evidence, not evidence that the Agent is idle or
that teardown has completed.

## OrganHealthProbePort Boundary

`OrganHealthProbePort` is owned by HumanAgent runtime. A future DSH capability
probe may report only capabilities it directly proves, such as profile load,
session create/resume, selected model/tool, transport, and stop/settle. Its
result must include `checkedAt`, validity and evidence references. The probe may
not infer readiness from RCC listener/config, DSH debug logs, snapshots, or
response metadata. No real DSH probe call occurred in this review, so the DSH
health capability is `unverified` and cannot be reported as `healthy` or `ready`.

## Failure Matrix

| Failure / missing evidence | Status | Required retained evidence | Owner / next action |
|---|---|---|---|
| DSH clean source worktree executable unavailable | `dependency-missing / runtime-unverified` | Clean commit/tree is available for source review, but the worktree has no built `apps/cli/lib/bin.js` entrypoint | DSH profile owner: use an approved dedicated profile/build only after the M1-0 gate; do not treat source presence or `node_modules` as boot proof. |
| DSH dependency installation not performed | `dependency-missing` | Package manager, Node constraint and declared dependency list | DSH profile owner: install/lock only in an approved dedicated profile, then verify. |
| No approved HumanAgent DSH plugin/bundle identified | `capability-unavailable` | No package name, entrypoint, version or digest was invented | DSH/plugin owner: identify approved bundle and prove load/dispose. |
| RCC listener absent | `dependency-missing / health-blocked` | Probe error and next probe condition | Provider supervisor: start/restore RCC only under separate authorization. |
| RCC listener exists but codec not selected | `capability-unavailable` | Listener/config evidence; no guessed request | Provider adapter owner: select explicit binding and run protocol readiness. |
| Responses readiness for `cc` | `unverified` | Must retain codec result, stream terminal state, raw error classification and binding digest | Responses owner: run `cc` same-entry fixture/request without merging identity. |
| Responses readiness for `cc-sol` | `unverified` | Same as `cc`, with independent provider/route/model identity | Responses owner: run `cc-sol` same-entry fixture/request. |
| Anthropic readiness for `goaichat` | `unverified` | Message/content-block stream result, raw error classification and binding digest | Anthropic owner: run `goaichat` same-entry fixture/request. |
| Same-entry provider request | `not-run by constraint` | No request id, payload, response or secret | Provider validation owner: run only after explicit authorization and preserve evidence. |
| DSH session crash, transport close, plugin incompatibility | `unverified` | Session evidence, operation error, owner, next action and checkpoint result | DSH adapter owner: exercise recorded then real DSH path. |
| Cancel returned without settle | `unverified; must remain stopping` | Cancel receipt plus settle wait/result; never equate cancel with stopped | Stop controller owner: prove settle, resource release and stopped checkpoint. |
| Direct teardown resource release, persistence close, and error visibility | `runtime-unverified` | Real DSH evidence for the publication wait, Step A machine quiescence, Step B handle close/persistence durability, Step C detach/untrack/unfollowOwner, the local Step A/B `failures` boundary, and the `:619` `AggregateError` only as the local wrapper created for multiple Step A/B collected errors; record that a single `failures[0]` is rethrown unchanged and may itself be an `AggregateError`; distinguish skipped later Step A calls and out-of-aggregation Step C errors | DSH adapter error/stop mapping owner: instrument/observe a real teardown and map only directly observed results; do not infer release or close success from source presence. |
| Create/resume rollback resource release, persistence close, and error visibility | `runtime-unverified` | Real DSH evidence that primary prepare/setup/resume errors reach the caller, `initializeAgent` cancels before awaiting `prepared.dispose().catch(() => {})`, direct prepare failures close stored handles, and `resumeWith` `:896` abandoned `void abandoned.close()` has no catch/await/local rejection handler; verify persistence close, resource release, unhandled/dangling promise behavior, and whether primary errors are already `AggregateError`s | DSH adapter error/stop mapping owner: exercise real create/resume rollback paths and record primary outcomes, explicitly discarded secondary outcomes, and dangling abandoned-close behavior without claiming `AggregateError` preservation. |
| Journal/checkpoint failure after external settle | `unverified; expected blocked` | External result, failed commit and recovery action | Runtime/Journal owner: preserve recovery responsibility; do not report success. |
| M1-0 review gate | `pending native Astra` | Candidate SHA, this artifact, focused checks and Astra receipt | Parent: run native Astra; this worker does not claim PASS. |

## Focused Validation

Planned/required checks for this artifact:

```sh
git diff --check
git diff -- docs/architecture/m1-0-capability-matrix.md
git status --short --branch
git diff --cached --check
git diff --cached --name-only
```

The checks validate only document whitespace and scope. They do not validate
RCC protocol readiness, DSH runtime readiness, provider requests, or M1-0 PASS.
