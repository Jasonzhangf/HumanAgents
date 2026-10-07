# Interaction occurrence author verification evidence receipt

Status: documentation-only evidence receipt.

This receipt makes the existing author-stage evidence discoverable. It does not
rerun product tests, and it does not claim R4 PASS, merge, push, installation,
or overall cleanup.

## Tested source binding

The tested source is the unchanged commit below. This receipt is added after
that commit and does not change the tested product.

| Field | Value |
| --- | --- |
| Tested source commit | `a3f3c93abb65b96473e95c7adcbdcd5dc7f86206` |
| Full review base | `a56c08a068424f80d3648079364e955c21c03622` |
| Source tree | `c811c41ac27756243ca4e8a098a611c53dd47def` |
| Source parent | `66b7822b61df3fe9757ef70819f62a918c0d6921` |
| Original author branch | `codex/interaction-terminal-recovery-20261005` |
| Original author cwd | `/Volumes/Intel/playground/humanagent/interaction-terminal-recovery-20261005` |

The tested source commit changes exactly:

```text
packages/core/src/subscription.ts
tests/core/occurrence-authority-public-consumer.test.ts
```

Source and emitted hashes verified from the original admitted tree:

| Artifact | SHA-256 |
| --- | --- |
| `packages/core/src/subscription.ts` | `5c428cb9759a8aba7ec962fb8c62ac7170b2d607be393a4bd8241b223e728a2b` |
| `tests/core/occurrence-authority-public-consumer.test.ts` | `016ab56a231f6546723d538a20d518ca0bfb51ece235666f9c58c5745bd0b25e` |
| `dist/tests/packages/core/src/subscription.js` | `2fb5510f0e3b593618f86d237670a33395865e5c41aac11ef464255b3da7f52c` |
| `dist/tests/tests/core/occurrence-authority-public-consumer.test.js` | `c9f356b3a87f13a85e6f00a3a5ef8ec6eb1a11627e1d116cea77207b5d925f5f` |

The base `a56c08a068424f80d3648079364e955c21c03622` is an ancestor of the
tested source commit. The tested source commit is the third commit in the
bounded core correction series: `988ea9b` then `66b7822` then `a3f3c93`.

## Author evidence index

The original author-stage notes and handoff are:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/notes.md
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/handoff.md
```

The root admissions and prior correction admissions are:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-author-admission-20261005.md
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-claim-correction-author-verification-admission-20261005.md
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-first-admission-expiry-author-admission-20261005.md
```

The R4 review final is:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/reviews/occurrence-authority-core-r4/review.final.md
```

The immutable raw evidence directory is:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/
```

The original author's public command execution event source is:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction.events.jsonl
```

The executed commands below come from completed public `command_execution`
records in that event file. Those records also contain the raw stdout/stderr
redirect paths and exit status. This receipt does not use reviewer-private
events or logs.

RED evidence:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/red-contracts-tsc.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/red-contracts-tsc.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/red-core-tsc.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/red-core-tsc.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/red-core-node.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/red-core-node.stderr
```

GREEN core evidence:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-core-tsc.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-core-tsc.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-core-node.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-core-node.stderr
```

GREEN contracts, intake, explicit-brain, and policy evidence:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-contracts-tests-tsc.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-contracts-tests-tsc.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-contracts-node.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-contracts-node.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-intake-tsc.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-intake-tsc.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-intake-node.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-intake-node.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-explicit-brain-tsc.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-explicit-brain-tsc.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-explicit-brain-node.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-explicit-brain-node.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-policy-tsc.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-policy-tsc.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-policy-node.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-policy-node.stderr
```

Static and commit evidence:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/install.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/install.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-typecheck.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-typecheck.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-dagpipe.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-dagpipe.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-diff-check.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/green-diff-check.stderr
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/commit.stdout
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-terminal-recovery-correction/raw/commit.stderr
```

## Chronology and commands

The original author's public `command_execution` events are the authoritative
source for the executed commands, raw redirect paths, and exit status. The
event records do not contain wall-clock timestamps. The root author admission
at `2026-10-05 04:09:31 UTC` is an actual stage boundary. The root
command-mismatch observation at `2026-10-05 04:22:07 UTC` bounds this
documentation correction. Individual command order below follows the public
event order, not raw file modification times or original author note guesses.
Raw file modification times are retained only as filesystem observations. The
Git commit timestamp remains commit metadata.

The commands below are copied from completed public `command_execution` events.
The three corrected rows use events `item_40`, `item_67`, and `item_68`. Each
has `exit_code` 0 and redirects to the named raw files. All other listed command
events also have `exit_code` 0. The tests were not rerun for this receipt.

| Raw mtime (UTC observation only) | Node | Executed command from public event | Observed evidence |
| --- | --- | --- | --- |
| 2026-10-05T04:03:56Z | install | `pnpm install --frozen-lockfile` | `install.stdout` shows pnpm `10.31.0`, lockfile up to date, install done |
| 2026-10-05T04:04:18Z | RED contracts compile | `pnpm exec tsc -p packages/contracts/tsconfig.json` | `red-contracts-tsc.stdout` and `.stderr` are empty; public event `item_40` has `exit_code` 0 |
| 2026-10-05T04:04:52Z | RED core compile | `pnpm exec tsc -p tests/core/tsconfig.json` | `red-core-tsc.stdout` and `.stderr` are empty; public event has `exit_code` 0 |
| 2026-10-05T04:04:57Z | RED core TAP | `node --test dist/tests/tests/core/core.test.js dist/tests/tests/core/occurrence-authority-public-consumer.test.js` | `red-core-node.stdout` has `1..30`, `# tests 30`, `# pass 28`, `# fail 2`, zero cancelled/skipped/todo; failures 27 and 28 expect `recoveryRequired=true` and observe `false` |
| 2026-10-05T04:05:21Z | GREEN core compile | `pnpm exec tsc -p tests/core/tsconfig.json` | `green-core-tsc.stdout` and `.stderr` are empty; public event has `exit_code` 0 |
| 2026-10-05T04:05:27Z | GREEN core TAP | `node --test dist/tests/tests/core/core.test.js dist/tests/tests/core/occurrence-authority-public-consumer.test.js` | `green-core-node.stdout` has `# tests 30`, `# pass 30`, `# fail 0`, zero cancelled/skipped/todo |
| 2026-10-05T04:05:48Z | GREEN contracts, intake, explicit-brain, policy compile | `pnpm exec tsc -p tests/contracts/tsconfig.json`; `pnpm exec tsc -p tests/runtime/intake/tsconfig.json`; `pnpm exec tsc -p tests/runtime/explicit-brain/tsconfig.json`; `pnpm exec tsc -p tests/runtime/verification-policy-compiler/tsconfig.json` | all eight raw compiler stdout/stderr files are empty; public events have `exit_code` 0 |
| 2026-10-05T04:06:00Z to 04:06:01Z | GREEN contracts, intake, explicit-brain, policy TAP | `node --test dist/tests/tests/contracts/contracts.test.js dist/tests/tests/contracts/interaction-contracts-public-consumer.test.js dist/tests/tests/contracts/occurrence-admission-public-consumer.test.js`; `node --test dist/tests-runtime-intake/tests/runtime/intake/draft-public.test.js`; `node --test dist/tests-explicit-brain/tests/runtime/explicit-brain/explicit-brain.test.js`; `node --test dist/tests/runtime/verification-policy-compiler/tests/runtime/verification-policy-compiler/verification-policy-compiler.test.js` | contracts `67/67`; intake `35/35`; explicit-brain `46/46`; policy `8/8`; each has `# fail 0`, zero cancelled/skipped/todo |
| 2026-10-05T04:06:13Z to 04:06:14Z | typecheck, DAG, diff | `pnpm typecheck`; `pnpm dagpipe:validate`; `git diff --check` | typecheck output shows `tsc --noEmit` and empty stderr; DAG output says `validated 9 DAGpipe graph(s)`; diff stdout/stderr are empty; public events have `exit_code` 0 |
| 2026-10-05T04:07:45Z | commit | ordinary Git CLI commit, normal hooks, no bypass recorded | `commit.stdout` shows `a3f3c93` and `2 files changed, 89 insertions(+), 16 deletions(-)`; `commit.stderr` is empty |

The author notes also record one setup failure before product evidence: the
first `pnpm install --frozen-lockfile` redirection failed because the raw
output directory did not exist. This setup error is not product evidence, and
the install command was rerun after the directory was created.

The author notes record MCPX `runtime_read(view="capabilities")` as failed with
empty context/data. The author then used ordinary Git CLI with normal hooks.

## Test totals and environment

The four GREEN public-consumer groups and the core group produce:

```text
core            30/30
contracts       67/67
intake          35/35
explicit-brain  46/46
policy           8/8
total          186/186
```

Each raw TAP summary has `# fail 0`, `# cancelled 0`, `# skipped 0`, and
`# todo 0`. The RED core TAP summary has `30 tests`, `28 pass`, `2 fail`, and
the same zero cancelled/skipped/todo values.

The current host reports Node `v22.22.2` and pnpm `10.31.0`. The pnpm version
is also visible in `install.stdout`. The R4 review final independently records
Node `v22.22.2`. The original raw TAP files do not contain a `node --version`
line, so the Node version here is current-derived and corroborated by the R4
review, not an encoded raw command result.

## Evidence scope and admission

For this bounded domain, the public contracts/core consumer tests are the
applicable functional admission evidence. They exercise the public contracts
and core exports and assert external behavior. This is not a claim that the
whole HumanAgent integration is complete.

This receipt does not prove:

- supervisor caller authentication or OS process authentication;
- Journal durability or checkpoint transaction behavior outside the tested
  contracts;
- a durable `ServeTaskConsumerPort`;
- scheduler integration or receipt replay;
- RCC, provider, UI, browser, or network behavior;
- installed resource release or live side-effect release;
- merge, push, installation, restart, or overall cleanup.

The DAG result is topology validation only. `pnpm dagpipe:validate` says the
nine graph files are valid and that operator bindings are syntactically
present. It does not execute operators. Project `compile()` remains the
authoritative registry, schema, and effect gate.

## R4 review context

R4 used base
`a56c08a068424f80d3648079364e955c21c03622` and reviewed tested source
`a3f3c93abb65b96473e95c7adcbdcd5dc7f86206`.

The R4 final has one P1 finding at `note.md:1`. The reviewer could not find the
author-bound development and public-consumer evidence. The reviewer did not
find a new product defect. The reviewer's own 19 public-consumer tests, type
check, and graph validation do not replace the author verification required
before architecture review.

R4 remains FAIL. This receipt does not convert R4 to PASS, does not reset the
round cap, and does not activate G. The root owns the same-series R5 review
after this documentation correction.

## Docs-only equivalence

This receipt changes documentation only. It does not change product source,
tests, configuration, dependencies, package metadata, or graph files. The
tested source and all validation inputs remain byte-identical to
`a3f3c93abb65b96473e95c7adcbdcd5dc7f86206`.

A reviewer can verify the equivalence from the receipt commit:

```sh
git diff --name-status a3f3c93abb65b96473e95c7adcbdcd5dc7f86206..HEAD
git diff --quiet a3f3c93abb65b96473e95c7adcbdcd5dc7f86206..HEAD -- packages tests scripts docs/dagpipe package.json pnpm-lock.yaml
git diff --check
```

The first command must list only this receipt. The second command must exit 0.
The third command must exit 0. This receipt intentionally does not contain its
own final commit SHA. The root binds the final receipt candidate SHA externally
in the worker handoff.

## Current status

The author-stage evidence is now discoverable in this committed receipt. The
bounded public contracts/core verification is reusable for the R5 base review
because the tested product bytes are unchanged. R4 remains a real FAIL.
Independent review, composition, merge, push, installation, live verification,
and cleanup remain root-owned and unproven.
