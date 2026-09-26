# T8 Multi-round Completion Proof: PASSED

Status: COMPLETED
Date: 2026-09-26
Worktree: `/Volumes/extension/code/humanagent/playground/multiround-e2e-7f00515`
Branch: `codex/multiround-e2e-7f00515`
Base: `7f00515cb288dccd70b3606b457052e4782a4130`
Real provider: RCC `http://127.0.0.1:4444` (gpt-5.5, protocol `responses`, route `rcc/ui-explicit-implicit`)

## E2E design (DAG)

- Entry: explicit brain receives `sourceRef: 'explicit-implicit-e2e-round-{1,2}'`
  through `POST /api/explicit/inputs` and is interpreted via
  `POST /api/explicit/interactions/:id/interpret`.
- Dependencies: real RCC 4444, explicit-brain interpreter, implicit FIFO drain,
  task coordinator, provider adapter (responses protocol), file.read tool.
- Owner: `packages/app/src/ui-runtime/service.ts` (unchanged) owns the FIFO
  drain and the synthesis of provider.tool events. The E2E script is the test
  owner.
- Success terminal: `task.state === 'succeeded'` with a committed succeeded
  checkpoint and an `/api/tasks` row that exposes both execution epochs on the
  same task.
- Failure terminal: any non-succeeded state, missing second execution epoch,
  missing provider.tool evidence, missing file.read content, or missing receipt
  fields raises and aborts the run.
- Evidence binding: the receipt
  `dist/receipts/explicit-implicit-e2e-proof.json` records `gitSha`, `mainSha`,
  `sourceDigest`, per-round `terminalState`, `executionEpoch`, `toolCallIds`,
  and `output` (markers). The contract function `assertReceiptContract` in
  `tests/app/real-explicit-implicit-e2e.mjs` fails closed if any of those
  fields are missing or invalid.
- Resource release: the temporary serve workspace under `os.tmpdir()` is
  removed on success unless `HUMANAGENT_EI_KEEP_ROOT=1`; the spawned serve
  child is SIGTERM-terminated and awaited.

## Run

```sh
pnpm install
pnpm build:contracts
pnpm build
node tests/app/multiround-e2e-contract.test.mjs
node tests/app/real-explicit-implicit-e2e.mjs
```

## Result

Both executor rounds reached `succeeded` on the same task
`ui-task-implicit-draft-1` with two distinct execution epochs. Each round
invoked the real `file.read` tool and returned the verbatim workspace contents,
finishing with the word `COMPLETE` as the round contract requires.

Receipt fields (see `dist/receipts/explicit-implicit-e2e-proof.json`):

- `proof`: `explicit-implicit-e2e`
- `gitSha`: `5c87c76575060f28e75b2825d8b5795d430a085e` (receipt-generation commit;
  the E2E harness + contract test + this evidence doc)
- `mainSha`: `7f00515cb288dccd70b3606b457052e4782a4130`
- `sourceDigest`: `sha256:69b84e484d77c71e63777882544e3fef1c23ec47aa7e2b78ccd9b704c55b7002`
- `rounds[0]`: `terminalState: succeeded`, `executionEpoch: 1`,
  `toolCallIds: [call_01a0de95a311767dbd993ecc, call_01a0de95a311767dbd993ecd]`,
  output contains `EXPLICIT_IMPLICIT_E2E_MARKER_7A1C`, `FIRST_LINE_PROVEN_8B2D`,
  and `COMPLETE`.
- `rounds[1]`: `terminalState: succeeded`, `executionEpoch: 2`,
  `toolCallIds: [call_01a0de95a311767dbd993ecd, call_00_YXf4joKqGsnwJf4bpwRE6124]`,
  output contains `FIRST_LINE_PROVEN_8B2D` and `COMPLETE`.

## Focused contract test

`node tests/app/multiround-e2e-contract.test.mjs` exercises the exportable
`assertReceiptContract` function with a valid two-round receipt and five
intentionally broken receipts (single round, non-succeeded terminal, missing
git binding, missing tool call id, rounds on different tasks). All six subtests
pass.
