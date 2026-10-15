# HumanAgent AppSDK Upgrade and Governance Plan

Date: 2026-10-10
Status: `INCOMPLETE`
Owner: project controller

## Objective

Upgrade the installed AppSDK CLI and shipped Skills to the latest AppSDK
release, then audit and improve HumanAgent governance using AppSDK 0.1.0014.
Keep HumanAgent product rules and ownership intact. Do not register a Collab
peer or make AppSDK endpoint registration part of this task.

## Acceptance

- Installed `appsdk version` matches the AppSDK source release on
  `origin/main`; installed binary bytes match that release build.
- HumanAgent `.appsdk` bundle is on the same SDK version.
- The authorized fresh reset is represented by an official reset record; old
  AppSDK local control state is handled only by an official AppSDK reset
  command.
- `appsdk verify` has an explicit result. `baseline_required` remains
  incomplete and is never reported as a pass.
- The project-rule audit records each proposed change with its owner, action,
  basis, retained safeguards, and affected entrypoints.
- No unrelated existing dirty or untracked project files are changed.
- Governance changes receive one independent review at the completed
  milestone. Document-only checks stay scoped to the changed guidance.

## Work nodes

| Node | Work | State | Evidence |
|---|---|---|---|
| G1 | Install AppSDK from current `origin/main` and verify installed version, binary identity, and the three shipped Skills. | `PASS` | AppSDK source `d1a3c267a8a31d18144967ba13fd6a2593f7c934`; `appsdk version` = `0.1.0014`; installed/build SHA-256 = `f1dc60aa28e1e7d33d14cef0995850c77c66bb33787a597deafd2150a07cb389`; all three Skill `cmp` checks exited 0. |
| G2 | Reconcile HumanAgent's reset baseline and current local AppSDK state. | `INCOMPLETE` | Reset record in the prior baseline says `fresh_init`, but the canonical workspace still reports ignored `.appsdk-control/` as present. `appsdk verify .` reports `ok:false`, `reason:baseline_required`, `stage:contract_bound`; requirements report `not_established`. Canonical fresh init was not repeated because the official flow may internally invoke App Server identity context, and the user explicitly said not to register a peer. |
| G3 | Audit project rules against AppSDK 0.1.0014, project Skills, package scripts, and actual CI/hook entrypoints. | `PASS` | Read `AGENTS.md`, AppSDK project-governance Skill, current template, package scripts, and release/CI scripts; see the entrypoint inventory below. |
| G4 | Produce a scoped GuidanceSetupProposal and make only authorized, owner-correct governance changes. | `PARTIAL` | Bootstrap returned a read-only proposal, not persisted task state. The reviewed candidate removes only the obsolete task-specific SHA from `AGENTS.md`; candidate tree `d4e435e2b4c8a63979d2971062f1998f966145cd`. |
| G5 | Run the targeted governance checks and obtain one independent review for the complete change. | `PASS` | Independent review PASS for the single `AGENTS.md` change; staged `git diff --check` passed. Commit `c5b88cfa5decb305ab09ccc6e7937e2f76b7d138` was fast-forwarded to `main` and pushed to `origin/main`. The broader upgrade remains open because G2 is incomplete. |

## Audit findings so far

1. Keep HumanAgent purpose, module ownership, semantic invariants, MVP
   boundaries, and product acceptance gates in `AGENTS.md`; they are project
   facts and are more specific than the advisory template.
2. `AGENTS.md` line 48 contained a task-specific starting SHA,
   `4ec6313cfad75c00363bbbedd6234928234121dd`. The reviewed candidate removes
   this one-off execution fact while retaining the separate clean-worktree
   requirement. Independent review used base
   `2a25f20a8195e8eda7391a20c059cf04b3c2b541` and candidate tree
   `d4e435e2b4c8a63979d2971062f1998f966145cd`; the review found no blocking
   issues. The current native-reasoning plan owns per-task base commits.
3. `AGENTS.md` includes detailed peer task and delivery procedures. Before
   moving or narrowing them, compare coverage with the installed project
   governance Skill and avoid creating duplicate procedure owners.
4. AppSDK project verification is not complete: the CLI returns
   `baseline_required`. The fresh reset record alone does not prove that the
   canonical workspace's ignored local control root was reset.
5. `appsdk guide init --task humanagent-guidance-upgrade-20261010 --mode
   bootstrap --module humanagent-governance` returned a read-only
   `GuidanceSetupProposal` intake. Its output did not persist task state or
   authorize a source edit by itself.

## Entrypoint inventory

- `package.json` declares `ci:check` as typecheck, the full `test` chain, and
  release tests. `test:release` runs release-gate and DAGPipe-binding tests.
- `scripts/run-ci.mjs` runs checkpointed stages under `~/.humanagent/build/`;
  it does not store CI checkpoints in the project workspace.
- `scripts/check-release.mjs` requires a clean source commit, passing stage
  receipts, a matching review receipt, and bound package/artifact digests.
- There is no `.github/workflows/` directory in this checkout. Git's
  `core.hooksPath` is unset and `.git/hooks/` contains only sample hooks.
- The AppSDK `humanagent-governance` module declares `pnpm run typecheck` as
  build and `pnpm run test:release` as regression, with
  `minimum_test_count: 1`. This is an AppSDK contract gate, not proof that the
  full HumanAgent test suite has passed.

## Next actions

1. Preserve the scoped audit outcome: no GitHub workflow or configured Git hook
   was found; `package.json` and project release scripts are the declared
   entrypoints. The bootstrap output itself did not persist a Guidance plan.
2. Keep the canonical workspace reset pending. The prior reset record says
   `.appsdk-control/` was removed, while the canonical workspace still reports
   that ignored path as present. The official `appsdk init --fresh` flow may
   invoke App Server identity context internally; because the user instructed
   that no peer be registered, do not repeat it unless a supported non-registering
   reset/reinitialize path is established. Never manually remove or inspect
   `.appsdk-control/`.
3. Keep `baseline_required` and requirements `not_established` explicit. Use an
   official requirements operation only for requirements directly supported by
   the user's recorded instructions; do not infer or manufacture a baseline.
4. The reviewed `AGENTS.md` candidate is integrated and pushed as
   `c5b88cfa5decb305ab09ccc6e7937e2f76b7d138`. Keep other project semantics
   unless the audit shows a concrete owner or duplication defect.
5. Run only the applicable document, AppSDK contract, and affected HumanAgent
   gates for each remaining accepted change; do not describe the single
   document review as review of the entire AppSDK upgrade.

## Boundaries

- The current project has pre-existing modified/untracked source and goal
  files. Preserve them byte-for-byte; this plan is the only new project
  document in this task.
- Do not modify Collab state, register peers, or infer communication readiness.
- Do not claim AppSDK baseline verification, governance-rule completion, or
  independent review until each has its own passing evidence.
