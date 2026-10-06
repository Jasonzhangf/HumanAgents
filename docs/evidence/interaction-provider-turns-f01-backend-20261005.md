# T7 Provider Turn Backend Evidence

Base: `ded31c22d9fd418595ad55292be5941e82e8e54a`.

Provider-only diff is limited to:

- `packages/adapters/provider/src/adapter.ts`
- `packages/adapters/provider/src/agent-driver.ts`
- `packages/adapters/provider/src/codecs.ts`
- `packages/adapters/provider/src/index.ts`
- `tests/adapters/provider/provider-agent-driver.test.ts`
- `tests/adapters/provider/real-rcc-turn-proof.mjs`

Contracts are unchanged. `turnId` is exposed through the typed
`ProviderRequestLifecycleEvent` contract and provider events via
`ProviderRequestScopedEvent`.

Red evidence: base `ded31c22` plus the new provider lifecycle test fails
compile because `onRequestLifecycle` and scoped `occurredAt` are absent. Raw
path: `/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/interaction-provider-turns-f01-20261005-t1/raw/red-test-provider.exit`.

Green evidence: `pnpm test:provider` passes `93/93`; `pnpm test:contracts`
passes `62/62`.

Real RCC evidence: `raw/rcc-turn-proof.json` records a real request to
`http://127.0.0.1:4444/v1/responses`, model `gpt-5.5`, one stable `turnId`,
same `turnId` in lifecycle and public observed provider events, and successful
settlement.

Ablation: provider turn id generation has one owner,
`ProviderAgentDriver.nextRequest()`. `git grep` found no second provider
`requestIdentity` or turn-id producer path.

Known out-of-scope typecheck: exit `2` from P1-b fixtures in
`tests/runtime/subscriptions/public-consumer.test.ts` and
`tests/runtime/subscriptions/subscriptions.test.ts`; no provider/provider-test
typecheck failure is present in the captured output.
