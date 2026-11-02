# Native RCC lane bounded corrective retry — SUCCESS evidence

Status: SUCCESS. The real `--mode rcc` dashboard lane now re-dispatches one
retryable, pre-observation provider start failure with a corrective prompt,
projects `execution.retry` / `retrying`, and reaches `succeeded`, checkpoint and
settled cleanup on the second attempt.

Task: `execution-retry-visual-proof-20261101` (D17). Worktree
`/Volumes/Intel/playground/humanagent/execution-retry-visual-proof-20261101`,
branch `codex/execution-retry-visual-proof-20261101`.

## Deficit (red) and fix

Before the fix, the real native lane entered
`coordinator.ts`'s non-orchestrated `else` branch and started the composition
once with no retry: the first retryable provider failure went straight to
`execution.terminal blocked` (see `execution-retry-visual-proof-blocked-20261101.md`).

The fix keeps the retry in the native lane's `else` branch:

- `packages/runtime/src/ui-runtime/coordinator.ts` starts the admitted
  composition once and re-submits the same admitted execution with a corrective
  prompt on a clean retryable failure, hard-capped at 2 attempts.
- `retryableNativeStartFailure()` returns `retryable: true` only when the
  original error carries a `providerError` with `phase === 'start'` and a code
  matching `^http\.5\d\d$`. An error that is already flagged retryable for a
  different reason (for example an RCC transport/timeout error) is not retried
  and keeps its own retryable value.
- Retry is rejected once observation began, a tool event exists, a checkpoint
  was committed, the task is stopping, or recovery is pending, and the loop is
  gated on the typed native-driver capability `driver.standardTurn`, so a
  non-native `orchestrate:false` driver keeps its prior single-attempt path.
- On a second native HTTP 5xx start failure, the loop emits one
  `execution.retry` / `blocked` event that names the attempt cap and the first
  failure reason, sets `record.error` to the first failure with
  `retryable: false`, and routes the error through the existing terminal
  failure closure, so the task ends `execution.terminal blocked` with the
  original provider error and evidence preserved.
- `tests/app/execution-corrective-retry.test.ts` covers the native success path,
  the retryable non-`http.5xx` negative path, the native exhaustion path, and
  the non-native no-retry path using `ProviderAgentDriver` and a port whose
  `start()` throws a scripted `ProviderAdapterError`.

## Real RCC black-box acceptance (green)

`node tests/app/dashboard-e2e/retry-visual-proof.mjs` drives the real
`local-file-search` homepage entrance through the attempt-aware proxy in front of
real RCC `127.0.0.1:4444`. Run with `HUMANAGENT_UI_MODEL=gpt-5.5`,
`E2E_CONFIRM_TIMEOUT_MS=600000`, `E2E_TERMINAL_TIMEOUT_MS=900000`, using an
isolated tmp control root (never `~/.humanagent`).

- Receipt `result: SUCCESS`, `missingEvidence: []`, `deviation: null`
- `task.terminalState: succeeded`
- `checkpointCommitted: 1`
- `cleanup.branch: settled`, `cleaned: true`
- Injection: `injectedCount: 1` (`/v1/responses`), `forwardedCount: 15`,
  `errors: []` — exactly one execution turn failed once; the corrective attempt
  and every interpretation turn were served by real RCC.
- Authoritative journal retry fact (`seq: 4`):
  `kind: execution.retry`, `state: retrying`,
  summary `第 2 次尝试（重试原因：RCC v3 returned HTTP 503: ...harness_injected_retryable_failure...）`
- Requested model `gpt-5.5`, resolved `MiniMax-M3`; 4 request-start turns; 3
  provider tool rounds.

Key facts are captured in `retry-proof.json`. The full run receipt
(`evidence.json`, 12 MB) and journal stay under the isolated tmp control root and
are intentionally not committed.

## Screenshots

- `retry-step-1280x720.png` — dashboard execution trace, desktop viewport, shows
  `execution.retry · retrying`, time `11/01 21:23:38`, the HTTP 503 retry reason
  and `seq=4`.
- `retry-step-390x844.png` — same retry row at the mobile viewport.

## Gates run

- `pnpm typecheck` — exit 0
- `pnpm build:app` — exit 0
- `node --test tests/app/dashboard-e2e/retry-injection-contract.test.mjs` — 3/3 pass
- `node --test dist/tests/tests/app/execution-corrective-retry.test.js` — 7/7
  pass, including the native-lane HTTP 503 retry test, the retryable
  non-`http.5xx` negative test, the native exhaustion test, and the non-native
  no-retry test
- `node tests/app/dashboard-e2e/retry-visual-proof.mjs` — receipt SUCCESS

## Residual risk

- The classification is deliberately narrow: only provider `start` errors with
  `http.5xx` codes retry in the native lane. Other retryable classifications
  (for example a non-`start` provider failure) keep the existing disposition.
- The native loop re-submits the same admitted composition; it is not a
  cold-resume path and does not re-open a new operation.
- Each acceptance run consumes real RCC model tokens through `127.0.0.1:4444`.
