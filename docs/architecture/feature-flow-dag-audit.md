# HumanAgent Feature / Project Flow DAG Audit

状态：`CANDIDATE / PENDING REVIEW`
日期：2026-09-18
审计对象：`a54ff980f04d05466b92bf5f7945882ab2cc68e0`
审计树：`8bb47be7fa348e77f7c59f235b4e5c68f8b22e79`
基线：`5fb25ee0955a65ba77f90a6642921a5cf85524d5`

## 0. Method and Evidence Boundary

This audit reconstructs the As-Is DAG from evidence already present in the
repository and from the current worktree's Git history. It does not assume that
a normal software project must contain a step. A node is marked `MISSING` or
`UNKNOWN` when no implementation, verification, or evidence binding was found.

Evidence classes are kept separate:

- **Repository evidence**: committed design documents, implementation, tests,
  gate manifests, receipts, and release scripts.
- **Git evidence**: commit, tree, ancestry, branch, and worktree state.
- **Review evidence**: `.agent-collab/review/<task-id>/` receipts and controller
  status, when available in the checkout.
- **Collab evidence**: durable task and lifecycle records, when available in
  the Collab state root. It is coordination evidence, not product acceptance.

The audit does not treat a passing unit test, a candidate commit, a review
receipt, a merge, or a release as interchangeable. Each is a separate gate.

## 1. As-Is DAG

The As-Is DAG has two historical slices whose gate manifests record PASS
verdicts and one current memory slice that stops before acceptance and
delivery. The historical acceptance receipts are referenced by the manifests
but are not independently readable in this checkout, so their acceptance
status is audited as partial rather than complete.

### 1.1 Historical slice: Real single DSH agent

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `R-DSH-1` | Requirement | Run one real DSH agent through the HumanAgent runtime, with real provider/tool execution and lifecycle evidence. | `docs/goals/real-single-dsh-agent-goal.md`, `docs/goals/real-single-dsh-agent-plan.md` | Scoped single-agent acceptance criteria | none | `docs/goals/real-single-dsh-agent-plan.md` | Goal/plan review is not separately receipted in this checkout | Goal/plan documents | `COMPLETE` |
| `C-DSH-1` | Constraint | Keep DSH replaceable; preserve HumanAgent identity, checkpoint, stop/settle, and evidence ownership. | Project `AGENTS.md`, DSH baseline design | DSH lock and boundary constraints | `R-DSH-1` | `docs/architecture/dsh-baseline.md`, `packages/adapters/dsh/` | Typecheck and focused DSH tests | `docs/evidence/real-single-dsh-agent/gates.json` | `COMPLETE` |
| `D-DSH-1` | Design | Define DSH session, lifecycle, continuation, stop, and evidence boundaries. | Requirement and constraints | DSH adapter design | `C-DSH-1` | `docs/architecture/dsh-baseline.md`, `docs/architecture/dsh-entry-proof.md` | Design review is not separately receipted here | Design documents | `COMPLETE` |
| `I-DSH-1` | Implementation | Implement DSH adapter, driver, lifecycle, and CLI path. | Design and DSH source lock | DSH implementation | `D-DSH-1` | `packages/adapters/dsh/`, `packages/app/src/` | Candidate-bound DSH tests | `287a2f61cdfac79d321166b201a36b438d9d374b` | `COMPLETE` |
| `V-DSH-1` | Verification | Verify typecheck, build, focused DSH tests, full tests, lifecycle, and real CLI entry. | Implementation candidate | Candidate-bound gate results | `I-DSH-1` | `docs/evidence/real-single-dsh-agent/gates.json` commands | `gates.json` commands and artifact hashes | `docs/evidence/real-single-dsh-agent/` | `COMPLETE` |
| `E-DSH-1` | Evidence | Persist candidate-bound receipts, checkpoint, session artifact, screenshots, and gate manifest. | Verification outputs | Evidence bundle | `V-DSH-1` | `docs/evidence/real-single-dsh-agent/gates.json` | Artifact SHA-256 entries | `docs/evidence/real-single-dsh-agent/` | `COMPLETE` |
| `A-DSH-1` | Acceptance | Independent review accepts the exact candidate. | Candidate and evidence | PASS verdict and zero P0/P1 findings recorded | `E-DSH-1` | Candidate `287a2f6...` | `implementationReview` and `finalVerdict` | `gates.json` review block; receipt path is referenced as `.agent-collab/review/humanagent-real-single-dsh-agent-287a2f6/review.final.md`, but that receipt is unavailable in this checkout | `PARTIAL: verdict recorded, receipt not independently readable` |
| `M-DSH-1` | Integration | Merge the candidate into main. | Candidate, partial acceptance, and main base | Main merge commit | `A-DSH-1` | `37965991017345e690865dfae1fc46d030fa607c` | Main merge tree recorded | `gates.json` candidate block and Git history | `PARTIAL: merge is recorded, upstream acceptance receipt is unavailable` |
| `L-DSH-1` | Delivery | Release the merged capability as a production artifact. | Main merge | Production release | `M-DSH-1` | `README.md` explicitly says production release is not complete | No production release artifact found | `dist/release` absent | `MISSING` |

### 1.2 Historical slice: UI Provider Loop

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `R-UI-1` | Requirement | Connect the UI runtime to fake and real RCC provider paths with execute, stop, settle, and projection. | `docs/goals/ui-provider-loop-goal.md` | Provider loop acceptance criteria | none | Goal document | Goal-specific review receipt is not present in this checkout | `docs/goals/ui-provider-loop-goal.md` | `COMPLETE` |
| `C-UI-1` | Constraint | UI remains a typed projection; no fake fallback for real provider failure; RCC is the external provider configuration source. | Project `AGENTS.md`, provider design | Runtime/API/provider boundaries | `R-UI-1` | `docs/architecture/provider-adapters.md`, `packages/ui/` | UI and provider tests | `docs/evidence/ui-provider-loop/gates.json` | `COMPLETE` |
| `D-UI-1` | Design | Define Runtime API, SSE projection, fake/RCC mode, and stop settlement. | Requirement and constraints | UI/provider loop design | `C-UI-1` | `docs/architecture/agent-communication-and-feedback.md`, `docs/architecture/provider-adapters.md` | Design review receipt not found here | Design documents | `COMPLETE` |
| `I-UI-1` | Implementation | Implement UI runtime HTTP API, provider ports, projection, and real entry. | Design | UI/provider implementation | `D-UI-1` | `packages/app/src/ui-runtime/`, `packages/ui/`, `packages/adapters/provider/` | Candidate-bound test and proof runs | `56840b3d62d1d9db943e4d5376ff3febe99d979c` | `COMPLETE` |
| `V-UI-1` | Verification | Run typecheck, full tests, release gates, and real RCC responses/openai proof. | Implementation candidate | Verification outputs | `I-UI-1` | `gates.json` commands | Real RCC 4444 probe/execute/stop/settle/checkpoint/close | `docs/evidence/ui-provider-loop/gates.json` | `COMPLETE` |
| `E-UI-1` | Evidence | Persist proof JSON, source digest, acceptance results, and gate manifest. | Verification outputs | Evidence bundle | `V-UI-1` | `docs/evidence/ui-provider-loop/` | Artifact SHA-256 and source digest | `docs/evidence/ui-provider-loop/` | `COMPLETE` |
| `A-UI-1` | Acceptance | Independent review accepts the exact reviewed UI/provider commit. | Candidate and evidence | PASS verdict and zero P0/P1 findings recorded | `E-UI-1` | `56840b3...` | `reviewVerdict`, `reviewFindings` | `gates.json` review block; no independently readable receipt is bound in this checkout | `PARTIAL: verdict recorded, receipt not independently readable` |
| `M-UI-1` | Integration | Merge accepted candidate into main. | Acceptance and main base | Main merge commit | `A-UI-1` | README states the candidate entered main; merge SHA is not recorded in the gate file | Main merge evidence not fully bound in `gates.json` | README and Git history | `PARTIAL` |
| `L-UI-1` | Delivery | Release the merged capability as a production artifact. | Main merge | Production release | `M-UI-1` | `README.md` explicitly says production release is not complete | No production release artifact found | `dist/release` absent | `MISSING` |

### 1.3 Current slice: Memory M3

This is the current worktree's candidate. It has implementation and focused
verification, but no current-candidate independent review, acceptance receipt,
main integration, or production release.

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `R-MEM-1` | Requirement | Deliver the project/global memory system and memory agent workflow for M3. | `docs/architecture/memory-system.md`, `docs/architecture/m3-integration-plan.md` | Memory M3 acceptance criteria | none | `docs/architecture/memory-system.md` | Focused tests exist; requirement-to-test trace is partial | Design and plan documents | `COMPLETE` |
| `C-MEM-1` | Constraint | `~/.humanagent` is the only persistence root; Journal is authoritative; Index and projections are rebuildable; UI does not own memory state. | Project `AGENTS.md`, memory design | Root, ownership, and control/data boundaries | `R-MEM-1` | `docs/architecture/memory-system.md`, `packages/config/src/index.ts` | Root/path tests exist | Design, config, and tests | `COMPLETE` |
| `D-MEM-1` | Design | Define project/global namespaces, candidate/review/promotion, source updates, and injection boundaries. | Requirement and constraints | Memory system design | `C-MEM-1` | `docs/architecture/memory-system.md` | Design review receipt not found here | Design document | `COMPLETE` |
| `I-MEM-1` | Implementation | Implement memory contracts, adapter, runtime agent/events, app composition, and CLI wiring. | Design | Memory implementation | `D-MEM-1` | `packages/contracts/`, `packages/adapters/memory/`, `packages/runtime/src/memory/`, `packages/app/src/memory-composition.ts`, `packages/app/src/cli.ts` | Focused and app tests | `a54ff98` changed 34 paths relative to `5fb25ee` | `COMPLETE` for candidate `a54ff98` |
| `V-MEM-1` | Verification | Run focused memory/app/provider/UI/runtime gates and a real CLI restart-persistence entry test. | Implementation candidate | Verification outputs | `I-MEM-1` | `tests/adapters/memory/`, `tests/runtime/memory/`, `tests/app/app.test.ts`, `tests/app/ui-runtime.test.ts` | `pnpm test:app` includes `CLI serve composes rooted memory and keeps it across process restart` | Current worktree test run: 120/120 app tests PASS | `COMPLETE` for `a54ff98` |
| `E-MEM-1` | Evidence | Persist candidate-bound test output, real-entry result, and review receipt. | Verification outputs | Candidate-bound evidence bundle | `V-MEM-1` | No committed memory M3 evidence bundle exists in this worktree | No current-candidate review receipt exists in this worktree | `docs/evidence/memory-agent/verification.json` is absent from HEAD | `MISSING` |
| `A-MEM-1` | Acceptance | Independently review and accept the exact current candidate. | Candidate and evidence | PASS/FAIL receipt | `E-MEM-1` | `.agent-collab/review/humanagent-mvp-memory-2f4bb30/` reviews `2f4bb30`, not `a54ff98` | Existing review is FAIL and stale relative to `a54ff98` | Stale review status | `MISSING` for `a54ff98` |
| `M-MEM-1` | Integration | Merge the accepted memory candidate into clean main. | Acceptance and main base | Main merge commit | `A-MEM-1` | `a54ff98` is 13 commits ahead of `origin/main`; not merged | No main integration evidence for `a54ff98` | Git ancestry and branch state | `MISSING` |
| `L-MEM-1` | Delivery | Release the merged memory capability. | Main merge | Production release | `M-MEM-1` | `README.md` says production release is not complete | No release artifact | `dist/release` absent | `MISSING` |

### 1.4 Cross-cutting project nodes

| node_id | type | purpose | inputs | outputs | dependencies | implementation_binding | verification_binding | evidence | status |
|---|---|---|---|---|---|---|---|---|---|
| `X-GOV-1` | Constraint | Keep AppSDK quality gates separate from optional coordination and preserve owner boundaries. | Project rules and AppSDK governance skill | Governance constraints | project root | `.appsdk/` is not present in this candidate checkout | Governance contract task exists in Collab state but is not part of this branch | Project `AGENTS.md`; root governance worktree state | `PARTIAL` for this candidate |
| `X-REV-1` | Verification | Perform independent read-only review for runtime, shared-write, protocol, and release changes. | Candidate and evidence | Review receipt | candidate implementation | `codex-review` skill and `.agent-collab/review/` | Controller status and final JSON | Current memory candidate has no fresh receipt | `MISSING` for `a54ff98` |
| `X-REL-1` | Delivery | Rebuild release artifacts from main and verify package smoke, manifest, and hashes. | Clean main and review evidence | Production artifact | merged main | `scripts/build-release.mjs`, `scripts/check-release.mjs`, `scripts/package-release.mjs` | Release gate scripts exist | No `dist/release` artifact in current checkout | `MISSING` |

## 2. Closure Audit

### A. Orphan Requirement

The DSH and UI Provider Loop requirements have downstream implementation,
verification, and evidence, and their gate manifests record acceptance. Those
historical acceptance receipts are not independently readable in this
checkout, so their acceptance status is `PARTIAL` rather than `COMPLETE`. The
memory M3 requirement has implementation and focused verification, but no
current-candidate evidence, acceptance, integration, or delivery. The
production release requirement is explicitly unmet in `README.md`.

### B. Orphan Implementation

The memory implementation is traceable to `docs/architecture/memory-system.md`
and the M3 integration plan, so it is not an orphan. The current candidate does
contain a broader memory-agent workflow than the narrowly reviewed
`2f4bb30`; that broader scope has no current review receipt.

### C. Unverified Implementation

No current-candidate unverified implementation was found for the exact
`a54ff98` test scope: `pnpm test:app` passed 120/120, including the CLI restart
persistence test. The remaining gap is not absence of tests, but absence of a
candidate-bound evidence bundle and independent acceptance for that exact
candidate.

### D. Unbound Verification

Some historical gate files reference review receipt paths that are not present
in the current checkout. The gate manifest still records a verdict and artifact
hashes, but the referenced receipt is not independently readable here. This is
a traceability gap, not proof that the historical review did not occur.

### E. Missing Acceptance

`a54ff98` has no current independent review receipt. The existing
`.agent-collab/review/humanagent-mvp-memory-2f4bb30/` receipt is for
`2f4bb304...`, not `a54ff98`, and its verdict is `fail`.

### F. Missing Evidence

The current worktree does not contain a committed memory M3 evidence bundle
such as `docs/evidence/memory-agent/verification.json`. The test command output
exists in the execution session, but not as a candidate-bound repository
artifact.

### G. Dependency Gap

The memory slice's acceptance node depends on a current-candidate evidence
bundle that does not exist. Its integration node depends on acceptance. Its
delivery node depends on integration. Therefore the memory path cannot reach a
legal terminal delivery node.

### H. Dead Node

No dead node was found in the historical implementation and verification
slices. The historical acceptance receipts are unavailable, and the current
candidate has no acceptance or delivery node, so those are partial or missing
rather than dead.

### I. Cycle

No dependency cycle was found in the reconstructed DAG.

### J. Premature Closure

The project is not claiming production release completion. However, a memory
candidate being treated as delivered without a current-candidate review and
evidence bundle would be premature closure. The stale `2f4bb30` review must
not be reused as acceptance for `a54ff98`.

## 3. Minimal To-Be DAG

The minimal complete DAG for a non-trivial feature is:

```text
Requirement + acceptance criteria
        |
        v
Constraint / owner / forbidden-path binding
        |
        v
Design / contract (only when behavior or ownership changes)
        |
        v
Implementation + focused tests
        |
        v
Verification: focused + integration + actual entry
        |
        v
Candidate-bound evidence
        |
        v
Independent acceptance review
        |
        v
Merge to clean main
        |
        v
Rebuild release artifact from main
        |
        v
Delivery closure: install / restart / replay where applicable
```

Each node exists for one of these reasons:

- **Requirement + acceptance criteria** is necessary for correctness and
  acceptance. Removing it makes “done” undefined.
- **Constraint / owner / forbidden-path binding** is necessary for
  traceability and safety. Removing it permits cross-owner or cross-boundary
  changes.
- **Design / contract** is necessary only when behavior, protocol, ownership,
  or persistence changes. A trivial bugfix may omit it.
- **Implementation + focused tests** is necessary for correctness. Removing it
  removes the change itself.
- **Verification** is necessary for verifiability. Focused tests alone do not
  prove integration or actual entry behavior.
- **Candidate-bound evidence** is necessary for traceability and evidence
  integrity. Without it, later review cannot know what was tested.
- **Independent acceptance** is necessary for acceptance when the change
  affects runtime, shared state, protocol, security, or release behavior.
- **Merge to clean main** is necessary for integration. A candidate branch is
  not the delivery object.
- **Rebuild release artifact from main** is necessary for delivery. A
  candidate artifact is not the released artifact.
- **Delivery closure** is necessary when installation, restart, or replay is
  part of the user-visible contract.

A short bugfix DAG may omit design and independent review only when the change
is low-risk, reversible, single-owner, and fully covered by focused tests.

## 4. DAG Diff

| Difference | Classification | Evidence |
|---|---|---|
| Memory M3 has no current-candidate evidence bundle | `MISSING_EVIDENCE` | `docs/evidence/memory-agent/verification.json` absent from HEAD |
| Memory M3 has no current-candidate independent review | `MISSING_ACCEPTANCE` | Existing review is bound to `2f4bb30`, not `a54ff98` |
| Memory M3 is not merged into main | `MISSING_EDGE` | `a54ff98` is 13 commits ahead of `origin/main` |
| Production release is absent | `MISSING_NODE` / `MISSING_DELIVERY` | `README.md` says production release is not complete; `dist/release` absent |
| Historical gate files reference receipt paths not present here | `MISSING_BINDING` | `gates.json` review paths and current checkout contents |
| UI Provider Loop gate does not bind the main merge SHA | `MISSING_BINDING` | `gates.json` has no main merge field; README only says it entered main |
| No current evidence that `a54ff98` was reviewed against the exact memory interaction branch scope | `MISSING_VERIFICATION` | Review receipt for `2f4bb30`; branch divergence |

No `INVALID_CYCLE`, `REDUNDANT_NODE`, or `WRONG_DEPENDENCY` was found in the
reconstructed paths. Historical acceptance and integration nodes are
`MISSING_BINDING`/partial where their referenced receipts are unavailable.

## 5. Minimal Migration Plan

1. **Freeze the candidate**
   - Record `a54ff98` and tree `8bb47be7fa348e77f7c59f235b4e5c68f8b22e79`.
   - Keep the worktree clean and do not add the unreviewed memory interaction
     branch commits without a new scope decision.

2. **Run and persist applicable gates**
   - `pnpm typecheck`
   - `pnpm test:app`
   - `pnpm test:memory`
   - `pnpm test:runtime`
   - `pnpm test:provider`
   - `pnpm test:ui`
   - `pnpm test:release`
   - The real CLI restart-persistence entry test included in `pnpm test:app`.
   - Store the exact command, exit code, test counts, candidate SHA, tree, and
     environment identity in a committed evidence bundle.

3. **Perform independent review**
   - Review exact candidate `a54ff98` in `commit` mode with base `5fb25ee`.
   - Include the prior P1: CLI `serve` must compose rooted memory and must not
     fall back to a process-local memory backend.
   - Include owner boundaries, persistence root, control/data separation, and
     the memory evidence bundle.

4. **Fix only invalidated gates**
   - If review finds P0/P1, fix in the owned worktree, commit a new candidate,
     and rerun only the first invalidated gate and its downstream dependants.
   - Do not rewrite correct memory implementation to satisfy governance.

5. **Produce acceptance**
   - Bind the review receipt to the exact candidate SHA and tree.
   - Record P0/P1 counts and the controller verdict.

6. **Merge to clean main**
   - Integrate only after acceptance.
   - Record candidate SHA, main merge SHA, main tree, and post-merge checks.

7. **Rebuild and deliver**
   - Rebuild the release artifact from main, not from the candidate branch.
   - Run release manifest, package smoke, and hash verification.
   - Perform install/restart/replay only for the affected runtime entry.

8. **Close the loop**
   - Record main SHA, artifact version/hash, install/restart result, actual
     entry result, and any remaining limitations.
   - Mark the path `INCOMPLETE` or `UNVERIFIED` if any applicable item is
     missing.

## 6. Remaining Risks

- **Stale review reuse**: the existing memory review is a FAIL for `2f4bb30`;
  using it as acceptance for `a54ff98` would be evidence falsification.
- **Candidate/branch divergence**: `a54ff98` and the later memory interaction
  branch are not the same delivery object. Combining them without a scope
  decision would make the reviewed tree non-reproducible.
- **Missing release artifact**: the project has historical merged slices but
  no production release evidence.
- **Receipt availability**: some historical gate manifests reference review
  receipt paths that are absent from the current checkout.
- **Root worktree dirty/behind**: the protected root has unrelated dirty files
  and is behind `origin/main`; this candidate must not be merged or released
  from that root.

## 7. Final Closure Criteria

The project is closed only when, for the claimed delivery scope:

1. The requirement and acceptance criteria are identifiable.
2. Every implementation path traces to a requirement and owner.
3. Focused, integration, and actual-entry verification pass on the exact
   candidate.
4. Candidate-bound evidence exists and is reproducible.
5. Independent acceptance binds the exact candidate SHA and tree.
6. The accepted candidate is merged into clean main with a recorded merge SHA.
7. The release artifact is rebuilt from main and its manifest/hash is verified.
8. Applicable install, restart, and replay checks are recorded.
9. No path is marked complete while any required node is `MISSING`,
   `UNKNOWN`, or `PARTIAL`.

For the current memory M3 candidate, the path is not closed. The first blocking
node is `E-MEM-1` (missing candidate-bound evidence), followed by `A-MEM-1`
(missing independent acceptance for `a54ff98`).
