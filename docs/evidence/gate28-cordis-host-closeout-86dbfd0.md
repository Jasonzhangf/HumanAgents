# Gate 28 Cordis Host Closeout at c75e518

## Scope

- Bug: `cd8e2d77a2f9307e15003509b95e5f335131e4552e9600aba8b631227f476651`
- Exact tested commit: `c75e5181f3ba0f44453d2954ee87b9e482da5c21`
- Exact tested tree: `006eee296bb3fd6f7b6f3f2de92e6b45ec17a9f4`
- Worktree: `playground/mvp-cordis-host-closeout-r3-86dbfd0`
- Baseline: clean detached worktree from `86dbfd0` on `origin/main`

This closeout verifies the Cordis Host portion of Gate 28 on the current
mainline. It does not claim completion of the broader Gate 18, Gate 25, or
whole-MVP closeout.

## Focused Evidence

| Command | Exit | Result |
|---|---:|---|
| `pnpm build:contracts && pnpm build:app && pnpm exec tsc -p tests/app/tsconfig.json && node --test dist/tests/tests/app/cordis-host.test.js` | 0 | 9 passed, 0 failed |
| `pnpm typecheck` | 0 | no diagnostics |
| `pnpm test:app` | 0 | 185 passed, 0 failed |
| `pnpm test:release` | 0 | 31 passed, 0 failed |
| `git diff --check` | 0 | no whitespace errors |

The Cordis Host suite proves deterministic manifest ordering, fixed-kernel
ownership, duplicate-owner and undeclared-capability rejection, required-port
ownership, reverse disposal after failure, explicit provider-readiness failure,
and artifact digest rejection before import.

## Actual Serve Entry

Deterministic replay entry:

```sh
pnpm build:contracts
pnpm build:app
pnpm proof:cordis-host-closeout
```

The proof starts the built `serve --mode fake` entry on an isolated temporary
workspace and control root, captures the live launch JSON, runs the task over
HTTP/SSE, verifies the task projection and shutdown lease, and writes the
bound receipt to `dist/receipts/cordis-host-closeout.json`. The receipt binds
the implementation commit/tree `c75e518` / `006eee2`, a digest of all
non-evidence tracked source and the built app artifact, and copied launch, request, SSE, task,
event-journal, checkpoint-journal, and lease artifacts. The receipt is
generated from that proof source and committed as an evidence-only carrier;
the receipt does not claim to bind the hash of the commit that contains it.

Command:

```sh
node dist/app/app/src/cli.js serve \
  --workspace <isolated-temp-root>/workspace \
  --control-root <isolated-temp-root>/control \
  --mode fake \
  --port 0
```

Observed launch evidence:

- `plugins` contained exactly `humanagent.harness-kernel`,
  `humanagent.agent-templates`, `humanagent.fake-provider`,
  `humanagent.memory`, and `humanagent.ui`.
- `composition.complete` was `true`.
- Every live composition component, including `cordis-host`,
  `fixed-harness-kernel`, provider, template, memory, UI, supervisor lease, and
  rejected-interaction closure, reported `composed`.
- Supervisor stages were `cordis-host` then `ui-runtime`; the proof waits for
  graceful shutdown and requires the captured daemon lease to contain
  `disposedAt`.

The proof requires the live server to produce this exact ordered event sequence:
`execution.started`, provider model/output/tool/output events, provider
terminal, `execution.settling`, `checkpoint.committed`, and the final terminal.
It requires the final terminal to report `succeeded; provider closed` with
`fake/settle-succeeded` and `fake/close` evidence, and task detail to report
`state=ready` and `output.state=succeeded`. The receipt copies the durable
launch, runtime status, task requests, SSE events, task projection, event
journal, checkpoint journal, and lease artifact.

## Boundary

This evidence closes the Cordis Host Gate 28 red case at `6d52fe2`: the actual
serve entry now loads and projects the live five-plugin composition and
executes through the registered execution port. It does not by itself mark the
broader Gate 18, Gate 25, or MVP closeout complete, and it does not claim DSH,
RCC, release, deployment, or production completion.
