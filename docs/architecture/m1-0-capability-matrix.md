# M1-0 Capability and Failure Matrix

Status: `M1-0-REVIEW-RECORDED / NOT-PASS`
Review time: `2026-09-13T07:14:30-0700` (local), `2026-09-13T14:14:30Z` (UTC)
Candidate base: `41adc33e62629ae56c7b4eba667d13bd6cb358b8`
DSH input: commit `c291e7961a515f6d7af9304e7fd1d257929aef26`, tree `e482b49bef64726be8f79380bb35bae569dc3c48`

This is a read-only M1-0 record. It does not implement an adapter, install a
plugin, make a provider request, or prove M1-0 PASS. Native Astra review and
parent acceptance remain pending.

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
| 07:14:30-0700 | `pwd; git status --short --branch; git rev-parse HEAD` | Worktree is `/Volumes/extension/code/humanagent/playground/m1-0-capability-review`; HEAD is the requested base; status clean. |
| 07:14:30-0700 | `ls -ld ~/.rcc /Volumes/extension/.rcc` | `~/.rcc -> /Volumes/extension/.rcc`; target is a directory. Path evidence only. |
| 07:14:30-0700 | `lsof -nP -iTCP:4444 -sTCP:LISTEN` | `rccv3` PID `22700`, TCP `*:4444 (LISTEN)`. Listener evidence only. |
| 07:14:30-0700 | `rg -n 'allowed_transports|cc-sol|goaichat|providerId|type\s*=' ~/.rcc/config.toml ~/.rcc/provider/{cc,cc-sol,goaichat}/config.v2.toml` | `allowed_transports = ["json", "sse"]`; `cc` and `cc-sol` declare `type = "responses"`; `goaichat` declares `type = "anthropic"`; routes include `cc-sol` and `goaichat`. Non-sensitive field evidence only. |
| 07:14:30-0700 | `git -C /Volumes/extension/code/dsh rev-parse c291...^{tree}; git -C /Volumes/extension/code/dsh ls-tree c291...` | Locked DSH commit is a commit and resolves to tree `e482b49...`. Object inspection, not dirty checkout evidence. |
| 07:14:30-0700 | `git -C /Volumes/extension/code/dsh show c291...:package.json` | Root declares version `0.1.5-rc.2`, MIT, `pnpm@11.7.0`, Node `^22.19.0 || >=24.0.0`, workspaces, and host build/test scripts. Source declaration only. |
| 07:14:30-0700 | `git -C /Volumes/extension/code/dsh show c291...:apps/cli/package.json` | Public package `@deepseek-ai/dsh`, bin `dsh: lib/bin.js`, MIT, and workspace dependencies including Cordis, app boot, agent, headless, session, tool, and LLM packages. Dependency installation is unverified. |
| 07:14:30-0700 | `git -C /Volumes/extension/code/dsh show c291...:apps/cli/src/bin.ts` and `src/args.ts` | Public launcher has profile boot, `web` alias, `plugin`, and config dump modes; inner app args are passed to the booted profile. `--resume` is an app argument, not a HumanAgent contract. |

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
| Session create | DSH CLI profile boot and agent/session packages are declared; no adapter-facing create API was locked in this review | `unverified` | DSH adapter owner: identify public create/session API and record a receipt. |
| Session resume | `args.ts` passes `--resume` to the booted app; no HumanAgent-compatible resume receipt verified | `partial-source; runtime-unverified` | DSH adapter owner: prove resume against persisted session and map only to `EvidenceRef`. |
| Events | Agent/session packages and session event test inventory exist in the commit; event-to-HumanAgent mapping not verified | `unverified` | DSH adapter owner: record ordered model/tool/error/terminal events and epoch mapping. |
| Tools | CLI dependencies include tool packages; filesystem, bash, web, todo, ask-user and other tool packages are declared | `declared; enabled-set-unverified` | DSH adapter owner: lock one representative tool and its permission/schema/result evidence. |
| Cancel / close / settle | Process shutdown and session/checkpoint packages are present; no verified public DSH cancel-close-settle contract or real receipt | `unverified` | Stop controller owner: prove cancel request is distinct from settle and stopped checkpoint. |
| Persistence / session log | Session persistence, session-log and JSONL-related packages are declared in CLI devDependencies; no runtime file or replay was run | `declared; persistence-unverified` | DSH evidence owner: record session log path/digest, append/restore semantics and Journal separation. |
| License | Root `LICENSE` and root/CLI package declarations state MIT; third-party notices are present | `source-verified` | Release owner: verify any selected plugin/bundle dependency licenses before use. |
| Endpoint / protocol / model binding | DSH source shows configurable profile/plugin layers, but no audited binding to RCC endpoint/protocol/model was produced | `unverified` | Provider + DSH owners: produce lock with endpoint ref, protocol, model ref, config digest and capability digest. |
| Profile/plugin compatibility | No dedicated HumanAgent profile or approved execution bundle was installed or loaded | `dependency-missing for M1 execution` | DSH profile owner: resolve approved package and compatibility evidence; do not fallback to fake. |

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
| DSH clean source worktree unavailable in this workspace | `evidence-limited` | Locked commit/tree and object-read commands; do not call dirty checkout clean | Parent/DSH owner: use the separately verified clean baseline for any execution gate. |
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
| Journal/checkpoint failure after external settle | `unverified; expected blocked` | External result, failed commit and recovery action | Runtime/Journal owner: preserve recovery responsibility; do not report success. |
| M1-0 review gate | `pending native Astra` | Candidate SHA, this artifact, focused checks and Astra receipt | Parent: run native Astra; this worker does not claim PASS. |

## Focused Validation

Planned/required checks for this artifact:

```sh
git diff --check
git diff -- docs/architecture/m1-0-capability-matrix.md
```

The checks validate only document whitespace and scope. They do not validate
RCC protocol readiness, DSH runtime readiness, provider requests, or M1-0 PASS.
