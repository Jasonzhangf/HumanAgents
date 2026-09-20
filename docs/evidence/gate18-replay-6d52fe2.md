# Gate 18 semantic replay on current main

- Bug: `cd8e2d77a2f9307e15003509b95e5f335131e4552e9600aba8b631227f476651`
- Previous candidate: `8d1b6cb848bb69b96edd0336d87e6e4c81670d76`
- Previous candidate tree: `6728ff711adab1114d9fb84712f49810c920d405`
- Previous candidate parent/base: `ec56133254e3ae51d1dae6731757027556ec91cc`
- Replay base / exact `origin/main`: `6d52fe2ff4c5cac8c5cbc91e20a2dafb1daef8a7`
- Replay branch: `codex/g18-replay-6d52fe2-20260919`

## Current-main baseline

Before the repair, `pnpm build:app` passed and the actual standalone command
returned `outcome=succeeded`, `providerClose.state=closed`, and the five raw
`observedKinds` values. Its JSON had no `driverRef` and no `semanticEvents`.
The actual `serve --mode fake` entry returned nine semantic events, including
the final `execution.terminal` with `provider closed`. The baseline therefore
disproved entry equivalence at the observation boundary.

The focused matrix was added before the implementation. Its first useful red
failure was:

```text
success: run driverRef
+ actual - expected

+ undefined
- 'fake'
```

## Root cause and repair

`packages/app/src/run-operation.ts` returned only the adapter receipt, while
`packages/runtime/src/ui-runtime/coordinator.ts` projected provider lifecycle
events independently for `serve`. The replay restores one provider-neutral
semantic projection in `packages/app/src/fake-execution.ts`, returns
`driverRef` plus `semanticEvents` from `runAgentOperation`, and prints those
fields from the standalone CLI. The same scenario-aware fake execution port is
used by standalone and serve.

Provider close failure remains explicit: standalone exits with
`agent-operation-recovery-required`; serve reaches a blocked terminal error
with `provider.close.failed` and does not emit a successful final terminal.

## Verification

Commands run from this worktree:

| Command | Exit | Key result |
|---|---:|---|
| `pnpm build:app` | `0` | app TypeScript build and template asset copy |
| `pnpm typecheck` | `0` | workspace TypeScript check |
| `pnpm test:app` | `0` | `177` passed, `0` failed |
| `pnpm test:runtime` | `0` | `331` passed, `0` failed |
| `pnpm test:release` | `0` | `31` passed, `0` failed |
| `git diff --check` | `0` | no whitespace errors |

Focused matrix command:

```sh
pnpm build:app \
  && pnpm exec tsc -p tests/app/tsconfig.json \
  && node --test --test-name-pattern='actual run and serve fake entries stay equivalent' dist/tests/tests/app/app.test.js
```

Exit `0`; `1` test passed. It compares two isolated roots for each of
`success`, `tool`, `error`, `cancel`, and `unknown`, including exact event
kind order, state, terminal state, output, settle evidence, and close
evidence. It also verifies `close-failure`: standalone exit `1` with typed
recovery, serve `blocked` with no successful final terminal.

Final standalone and serve evidence is recorded after the candidate commit
and is intentionally not claimed from the source tests alone.

No merge, push, install, restart, or release was performed.
