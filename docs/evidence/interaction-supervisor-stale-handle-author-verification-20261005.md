# Interaction supervisor stale-handle author verification

Status: bounded source evidence receipt. It does not claim independent review,
merge, push, installed-runtime verification, or goal completion.

## Candidate

Input commit: `9254e5ad27a06d86ec452738619fa36877a13411`

Changed source:

- `packages/app/src/supervisor/supervisor.ts`
- `tests/app/supervisor/occurrence-owner-public.test.ts`

## RED and GREEN

The real two-process stale-A public test copied B's readable lease identity into
stale A. Before the fix, stale A's `setControlEndpoint` returned `null`, so the
test failed with `1..25`, `pass 24`, `fail 1`. The public TAP child event and
assertion are in:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-supervisor-stale-handle-correction/raw/app-supervisor-node-red.stdout
```

Exit codes are recorded in the matching `*.exit` files.

The owner fix uses the captured immutable `leaseIdentity` for `update`,
`refresh`, and `assertActive`. The unused `assertLeaseActive` alias was removed.
After the fix, stale A receives typed `daemon-lease-stale` from
`withCurrentDaemonOwner`, `setControlEndpoint`, `release`, `refresh`, and
`assertActive`. B's durable `disposedAt` and `controlEndpoint` stay unchanged,
and B's subsequent guarded write succeeds.

The GREEN run recorded 25 tests, 25 pass, 0 fail. The app test compile,
`pnpm typecheck`, and `git diff --check` each exited 0. Raw records are in:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-supervisor-stale-handle-correction/raw/
```

## Cleanup and handoff

The GREEN child PIDs and fixture roots are absent. The check is recorded in
`raw/cleanup-green.stdout`.

The final candidate SHA, changed-file list, and residual scope are bound in the
external handoff:

```text
/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/occurrence-supervisor-stale-handle-correction/handoff.md
```

This receipt does not rerun unchanged contracts/core tests or DAG validation.
Their prior valid evidence remains outside this correction.
