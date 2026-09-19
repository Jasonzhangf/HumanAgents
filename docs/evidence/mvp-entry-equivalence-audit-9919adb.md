# MVP Gate #18：fake replay / standalone entry 等价审计

## Verdict

**FAIL（不是 PASS）**。

同一输入下，两条路径都得到 `succeeded` 与已提交 checkpoint；但实际可观测的
output 与 event 语义不等价：`serve --mode fake` 的 fixed provider replay 产生
完整 provider lifecycle 和 output projection，`run` standalone entry 使用的
`FakeAgentDriver` 只产生一个 `fake.operation`，CLI 结果也不暴露对应 output。
Gate #18 要求 output/state/events 语义对照，因此只能判 FAIL。

## Baseline / scope

- Repository: `/Volumes/extension/code/humanagent`
- Worktree: `/Volumes/extension/code/humanagent/playground/equiv-audit-r1`
- Branch: `codex/mvp-entry-equivalence-audit-20260919`
- Base / tested HEAD: `9919adbfe210d8180ce0806edcabd75ad360b4f9`
- Base tree: `34f10b5bc6b18ebf96bd71c97fac721ceab277e4`
- Worktree: clean before audit；本报告是本轮唯一允许写入文件
- Environment: macOS, Node/pnpm workspace, package manager `pnpm@10.31.0`

本审计没有修改 product code、tests、maps、lockfiles。运行时临时目录位于本
worktree，审计后已移除。

## Compared paths

### Fake replay path

Actual entry:

```sh
node dist/app/app/src/cli.js serve \
  --mode fake --protocol responses \
  --binding fake-equivalence --provider fake --model fake.model \
  --workspace <temp>/workspace --control-root <temp>/control --port 0
```

通过实际 HTTP Runtime API 创建 task，并以同一 prompt 启动：

```json
{
  "title": "equivalence audit",
  "directive": "verify equivalent lifecycle",
  "mode": "fake",
  "prompt": "verify equivalent lifecycle"
}
```

该 entry 在 `packages/app/src/cli.ts:181-223` 组装
`FakeReplayExecutionRuntimePort`；fixed replay 定义在
`packages/app/src/ui-runtime/fake-port.ts:35-41`。

### Standalone path

Actual entry:

```sh
node dist/app/app/src/cli.js run \
  --plan default --prompt 'verify equivalent lifecycle' \
  --session equiv-same-input \
  --workspace <temp>/workspace --control-root <temp>/control
```

`packages/app/src/cli.ts:62-92` 调用 `runAgentOperation`，默认配置选择
`interaction-default` 的 `driverRef = fake`。该路径实际由
`packages/adapters/testing/src/index.ts:43-109` 的 `FakeAgentDriver` 执行，
不是 UI fake replay port。

## Positive same-input replay

### Fake replay output

实际 standalone `serve --mode fake` HTTP/SSE 结果：

```json
{
  "launch": {
    "mode": "fake",
    "bindingId": "fake-equivalence",
    "providerId": "fake",
    "protocol": "responses"
  },
  "input": {
    "title": "equivalence audit",
    "directive": "verify equivalent lifecycle",
    "mode": "fake",
    "prompt": "verify equivalent lifecycle"
  },
  "eventKinds": [
    "execution.started",
    "provider.model",
    "provider.output",
    "provider.tool",
    "provider.output",
    "execution.terminal",
    "execution.settling",
    "checkpoint.committed",
    "execution.terminal"
  ],
  "eventStates": [
    "running", "model", "output", "tool", "output",
    "succeeded", "settling", "succeeded", "succeeded"
  ],
  "eventTerminalPhases": [
    null, null, null, null, null, "provider", null, null, "final"
  ],
  "dashboard": {
    "mode": "fake",
    "state": "succeeded",
    "output": "fake replay: draft output chunk 1fake replay: final output chunk 2",
    "checkpointOutcome": "succeeded",
    "error": null,
    "allowedActions": ["start"]
  }
}
```

The final event also carries provider-close evidence (`fake/close`). This matches the
focused assertion in `tests/app/ui-runtime.test.ts:1152-1187`.

### Standalone output

实际 `run` CLI 结果：

```json
{
  "command": "run",
  "plan": "default",
  "sessionId": "equiv-same-input",
  "state": "stopped",
  "taskId": "equiv-same-input",
  "operationId": "runtime-runtime-equiv-same-input-epoch-1",
  "executionEpoch": 1,
  "outcome": "succeeded",
  "checkpointId": "equiv-same-input-1-1",
  "observedKinds": ["fake.operation"]
}
```

其 JSONL checkpoint 实际记录：

```json
{
  "outcome": "succeeded",
  "summary": "agent operation succeeded",
  "executionEpoch": 1,
  "next": {"kind": "continue", "ref": "humanagent://session/equiv-same-input/next"}
}
```

`state = stopped` 是 CLI session close 状态；同一结果的 task/checkpoint outcome
是 `succeeded`。因此 state/checkpoint 的高层成功语义一致，但 standalone 没有
fake replay 的 provider output 文本，也没有 model/output/tool/terminal 分层事件。

## Equivalence comparison

| Semantic surface | Fake replay (`serve --mode fake`) | Standalone (`run`) | Result |
|---|---|---|---|
| Same input | `verify equivalent lifecycle` | `verify equivalent lifecycle` | same |
| Execution epoch | `1` | `1` | equivalent |
| Terminal outcome | `succeeded` | `succeeded` | equivalent |
| Durable checkpoint | `checkpoint.committed`, outcome `succeeded` | JSONL checkpoint, outcome `succeeded` | equivalent at high level |
| Output | two fake replay output chunks projected to dashboard | no output field; checkpoint summary only | **not equivalent** |
| Event stream | 9 events: provider model/output/tool/terminal + settle/checkpoint/close | one `fake.operation` observation | **not equivalent** |
| Provider close evidence | final `provider closed` / `fake/close` | no provider-close event in CLI result | **not equivalent** |
| Session/UI state | dashboard `succeeded`; session close is not UI state | CLI session `stopped` after close | different surfaces; not directly interchangeable |

The first divergence is the driver/entry composition, not persistence: UI fake uses
`FakeReplayExecutionRuntimePort`, while standalone uses `FakeAgentDriver`. The two
drivers intentionally expose different contracts (`ProviderEvent` stream versus one
`AgentEvent` observation), so same high-level outcome does not prove gate equivalence.

## Negative/error-path evidence

The required app gate passed all focused error coverage, including:

- `fake replay without a terminal event fails explicitly instead of reporting success`:
  failed task and failed checkpoint (`tests/app/ui-runtime.test.ts:1589-1602`).
- `fake replay terminal state drives settlement instead of defaulting to success`:
  waiting/blocked/failed states remain their declared checkpoint outcome
  (`tests/app/ui-runtime.test.ts:1569-1587`).
- `app stop does not commit stopped when settle fails` and structured CLI/config
  failures also passed in `pnpm test:app`.

There is no standalone CLI fixture/configuration that injects a missing terminal or
declared failed `FakeAgentDriver` outcome for the same input. The CLI default fake
driver always resolves an unconfigured assignment to `succeeded`
(`packages/adapters/testing/src/index.ts:99-106`). Therefore negative-path equivalence
is **not demonstrated**; adding a hidden fallback or treating unit-only injected
outcomes as standalone-entry evidence would be invalid.

## Commands and gates

All commands ran from the audit worktree at the tested HEAD above.

| Command | Result |
|---|---|
| `collab task register ...` | task registered to this worktree |
| `collab task update task-humanagent-mvp-equiv-audit-r1-20260919 --status working --next "audit exact fake replay vs standalone entry"` | working |
| `pnpm build:app` | PASS |
| `node dist/app/app/src/cli.js run ...` with exact prompt above | PASS execution; `outcome=succeeded`, checkpoint committed |
| actual `node dist/app/app/src/cli.js serve --mode fake ...` HTTP/SSE harness with exact prompt above | PASS execution; dashboard/checkpoint `succeeded` |
| `pnpm typecheck` | PASS |
| `pnpm test:app` | PASS: 140 tests, 0 failed |
| `git diff --check` | run after report creation; required PASS before delivery |

## Gate disposition

Gate #18 remains open. State/checkpoint success is proven on both entries, but output
and event equivalence is disproven by the same-input replay above. Resolution requires
one owner to define or implement a shared standalone/provider-neutral semantic event
and output contract, then rerun this audit with positive and negative fixtures. This
audit intentionally does not modify that contract or product code.
