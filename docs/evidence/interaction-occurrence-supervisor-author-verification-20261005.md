# Interaction occurrence supervisor author verification evidence

Status: documentation-only evidence receipt.

This receipt makes the Task G author-stage evidence discoverable. It does not
claim independent review, merge, push, installed-runtime verification, or
overall goal completion.

## Candidate binding

| Field | Value |
| --- | --- |
| Input commit | `bc04ecb0496cf1e17a85b0d586c6be40e6425ed0` |
| Input tree | `e0f8368fd671a5aa90ce5af308707ac2f56ecf6a` |
| Input parent | `ac6460f5270f6b68053df538a3be3a67f6cface8` |
| Working branch | `codex/interaction-occurrence-supervisor-20261005` |
| Working cwd | `/Volumes/Intel/playground/humanagent/interaction-occurrence-supervisor-20261005` |

The tested source and emitted artifact hashes are:

| Artifact | SHA-256 |
| --- | --- |
| `packages/app/src/supervisor/supervisor.ts` | `2a8d0f0b703c73b0c4d647d4cbcdd5c28ffa5ce6429c27b0adc639743b1525ac` |
| `packages/app/src/supervisor/index.ts` | `5e8a2e8c6114d73dfa45758f0f46c8709d3c39d9428ffb3bc805a1c2a014be32` |
| `tests/app/supervisor/occurrence-owner-public.test.ts` | `2dfae516882fe61b96595fff07302a00bc7afd9fc25a316533631a1562e5a17b` |
| `dist/tests/packages/app/src/supervisor/supervisor.js` | `3f54a838d354ee0e5a7928336b7108beea99aa8040ff86a719e3cfc15e4c5745` |
| `dist/tests/packages/app/src/supervisor/index.js` | `4b10e2f1c64dc2f3deebbd11a067667e18e9c8a41283971ac9a1dd06de774a4f` |
| `dist/tests/tests/app/supervisor/occurrence-owner-public.test.js` | `56dbb07c0988bb08f53b7c144ccba9a41eaed0e3108c3f0674a28cd107c60126` |

The final commit SHA cannot be embedded in this receipt because it does not
exist before the commit. The worker handoff binds the final SHA and the
unchanged validation inputs after commit.

## External author records

The worker-owned notes, final handoff, and raw command evidence are:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-supervisor-owner-guard/notes.md
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-supervisor-owner-guard/handoff.md
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-supervisor-owner-guard/raw/
```

The root-created author admission path is not written by this worker:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-supervisor-author-admission-20261005.md
```

## Executed commands

All commands below ran from the working cwd above. Each command redirected
stdout and stderr to the named raw files. All listed commands exited 0.

| Command | Raw evidence | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | `raw/install.stdout`, `raw/install.stderr` | lockfile up to date; install done |
| `pnpm exec tsc -p packages/contracts/tsconfig.json` | `raw/contracts-tsc-final.stdout`, `raw/contracts-tsc-final.stderr` | empty output |
| `pnpm exec tsc -p tests/app/tsconfig.json` | `raw/app-tests-tsc-r4.stdout`, `raw/app-tests-tsc-r4.stderr` | empty output |
| `node --test dist/tests/tests/app/supervisor/supervisor.test.js dist/tests/tests/app/supervisor/occurrence-owner-public.test.js` | `raw/app-supervisor-node-r3.stdout`, `raw/app-supervisor-node-r3.stderr` | 25 tests, 25 pass, 0 fail |
| `pnpm exec tsc -p tests/contracts/tsconfig.json` | `raw/contracts-tests-tsc.stdout`, `raw/contracts-tests-tsc.stderr` | empty output |
| `node --test dist/tests/tests/contracts/contracts.test.js dist/tests/tests/contracts/interaction-contracts-public-consumer.test.js dist/tests/tests/contracts/occurrence-admission-public-consumer.test.js` | `raw/contracts-node-final.stdout`, `raw/contracts-node-final.stderr` | 67 tests, 67 pass, 0 fail |
| `pnpm exec tsc -p tests/core/tsconfig.json` | `raw/core-tests-tsc-final.stdout`, `raw/core-tests-tsc-final.stderr` | empty output |
| `node --test dist/tests/tests/core/core.test.js dist/tests/tests/core/occurrence-authority-public-consumer.test.js` | `raw/core-node-final.stdout`, `raw/core-node-final.stderr` | 30 tests, 30 pass, 0 fail |
| `pnpm typecheck` | `raw/typecheck-final.stdout`, `raw/typecheck-final.stderr` | exit 0 |
| `pnpm dagpipe:validate` | `raw/dagpipe-final.stdout`, `raw/dagpipe-final.stderr` | 9 graph files validated |
| `git diff --check` | `raw/diff-check-final.stdout`, `raw/diff-check-final.stderr` | empty output |

The first app test compile failed because this test environment's
`node:child_process` declarations did not export `ChildProcess` or the
`NodeJS` namespace. The harness was changed to infer the spawn result type.
That compile setup correction is not behavioral RED evidence.

## Real process and disk evidence

The new public test file exercises only public supervisor exports and real
acquired leases. It creates real child Node processes for copied-field,
crash-takeover, stale-A, and takeover-interleave cases.

Observed child PIDs and fixture roots from the TAP stream:

```text
copied fields: 19310 / humanagent-occurrence-owner-UXcKIK
crashed A:     19411 / humanagent-occurrence-owner-aCUyfe
live stale A:  19524 / humanagent-occurrence-owner-4GSajw
takeover race: 19639 / humanagent-occurrence-owner-crCGmc
```

The cleanup check returned:

```text
PID_ABSENT 19310
PID_ABSENT 19411
PID_ABSENT 19524
PID_ABSENT 19639
ROOT_ABSENT /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/humanagent-occurrence-owner-UXcKIK
ROOT_ABSENT /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/humanagent-occurrence-owner-aCUyfe
ROOT_ABSENT /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/humanagent-occurrence-owner-4GSajw
ROOT_ABSENT /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/humanagent-occurrence-owner-crCGmc
```

The raw cleanup output is:

```text
raw/cleanup.stdout
raw/cleanup.stderr
```

## Scope and remaining work

This bounded source change adds one public operation on the acquired
`SupervisorLease` handle. It authenticates the process-local lease under the
existing daemon transition guard. It holds that guard through the whole
asynchronous callback and settlement. It rejects copied readable fields,
fabricated authority objects, stale owners, non-local owners, disposed
handles, and invalid bindings. It passes only the three immutable domain owner
fields to the callback.

This receipt does not prove:

- Journal admission uniqueness;
- durable consumer dispatch;
- scheduler integration;
- RCC, provider, UI, browser, or network integration;
- installed runtime behavior;
- independent review, merge, or remote delivery.

The DAG command validates topology and bindings only. It does not execute
operators.
