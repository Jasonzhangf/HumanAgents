# native-delivery public consumer diagnosis and resolution (2026-11-09)

Task: `p1-native-delivery-consumer-remaining-failures-grace-20261109`
Worktree: `/Volumes/Intel/playground/humanagent/p1-native-delivery-consumer-remaining-failures-grace-20261109`
Branch: `codex/p1-native-delivery-consumer-remaining-failures-grace-20261109`
Base: `94a15b00a` (in `origin/main`; main advanced later with docs-only `64442f790`)

## Baseline RED (committed pre-retirement assertions)

```
ROOT=$(mktemp -d /tmp/ha-native-fix.XXXXXX)
pnpm exec tsc -p tests/app/native-delivery.tsconfig.json
HUMANAGENT_TEST_ROOT=$ROOT node --test dist/tests-native-text/tests/app/native-delivery-public-consumer.test.js
```

Result: `tests 21`, `pass 13`, `fail 8`. The working tree was the committed
baseline; no assertion was changed for this run.

| # | test | first-deviation assertion |
|---|---|---|
| 4 | public explicit taskless helper dispatch and owner acceptance use configured native providers | response `409 !== 200`; upstream fixture `assert.ok(wire.tools?.some((tool) => tool.name === 'dispatch_helper'))` fails |
| 6 | native inspect producer and cold saved boundary preserve facts without executor replay | `assert.equal(plannerPosts().length, 1, ...)` -> `2 !== 1` |
| 7 | native parallel child calls overlap and retain ordered refined results and checkpoints | `receipt.output` = `summary result is a different material`, expected `EXACT_BODY` |
| 14 | native two.turn public CLI consumer retains adopted child context and completes the prior plan | receipt output = `The child result is adopted and the first turn is closed`, expected `EXACT_BODY` |
| 15 | native three.turn public CLI consumer retains multi-turn semantic history and adopted child context | third turn lacks ordered semantic fact `The child result is adopted and the first turn is closed` |
| 18 | native three-turn public consumer cold-resumes interrupted third turn | cold-resume child exits `1`; resume POST returns `409` `cold-execution.recovery-hold-effect-unknown` |
| 19 | native text-only delivery advertised end, independent Planner closure and exact asset readback | advertised wire `deliveryText` type `undefined`, expected `'string'` |
| 20 | default native CLI inherits top-level HTTP credential into Responses request | receipt output = `summary result is a different material`, expected `EXACT_BODY` |

## Blocking conflict and owner ruling

The committed assertions encoded the pre-W0/W1-A contract that the shipped
product has deliberately retired:

- `packages/contracts/src/standard-turn-end.ts:145` rejects top-level
  `deliveryText` by own property (`standard-turn-end.retired-delivery-text`);
  canonical public text is `summary.result.text`.
- `packages/runtime/src/ui-runtime/coordinator.ts:3620` publishes with identity
  `pub:${operationId}:${turnId}`, not `standard-turn-delivery:`.
- `docs/dagpipe/explicit-semantic-turn.graph.semantic.json:24` and
  `tests/app/explicit-brain-runtime.test.ts` keep `dispatch_helper`/`accept_helper`
  out of the explicit interpreter wire.

Master ruling `m1794221957423-401` chose option (b): keep the retirement, and
move committed tests `#4`/`#7`/`#14`/`#15`/`#19`/`#20` onto the canonical
contract. `#6` (double Planner request against a refused Planner) and `#18`
(cold-resume `409` `cold-execution.recovery-hold-effect-unknown`) stay real
product candidates outside this task, with their original failures preserved.

## Canonical-contract test update (this task)

- `#4`: the explicit taskless intake now proves the answer path carries its
  intake marker, never advertises `dispatch_helper`/`accept_helper`, and
  dispatches no helper. The obsolete helper call/return/accept fixture path and
  its receipt assertions are removed.
- `#7`/`#14`/`#15`/`#20` plus the shared fixture: `summary.result.text` is the
  one canonical result text, so the fixture no longer fabricates a separate
  `SUMMARY_RESULT`, and receipt outputs assert the canonical body.
- `#14`/`#15` shared helper: semantic checkpoint wire top-level `evidenceRefs`
  is compared with the committed `native-semantic-context-view` `evidenceRefs`,
  which is the acceptance source evidence the shipped product commits.
- `#14` inspect-locator assertion: the committed `#14` also required the
  first-turn semantic checkpoint's own `evidenceRefs` to cite the accepted
  inspect `rawOutput.ref`. Under the canonical contract that array is empty by
  construction: `projectTurnCloseSummary`
  (`packages/app/src/ui-runtime/execution-composition.ts:97`) pins each summary
  section's `evidenceRefs` to `[]`, `buildTurnCheckpoint`
  (`packages/runtime/src/agent-loop/runtime.ts:2026`) derives the checkpoint
  `evidenceRefs` from those sections, and `semantic-history.ts:1012` projects
  the context view from `acceptance.sourceEvidenceRefs`. The turn-level
  resolved inspect evidence now travels on the accepted standard-end command
  (`resolvedEvidenceRefs`) and the `operation.completed` operation-control
  result. Owner ruling `m1794228225873-737` (option A) authorized moving this
  assertion to the canonical owner without weakening it: `#14` now asserts the
  first-turn checkpoint closure's `operationControl` result `evidenceRefs`
  deep-equal the accepted inspect `rawOutput.ref` (`locator`, `evidenceId`,
  `scope`), and separately asserts the canonical checkpoint top-level
  `evidenceRefs` is empty. `assertPriorSemanticCheckpointWire` keeps pinning
  the wire `evidenceRefs` to the durable context-view refs.
- `#19`: the advertised end carries no top-level `deliveryText`, the canonical
  `summary` requires `goal`/`actions`/`result`/`nextStep`, the exact body is
  `summary.result.text`, and the publication source is
  `pub:${operationId}:${activeTurnId}`.
- orphan-recovery test: receipt output follows canonical `summary.result.text`.

No product code changed. A candidate edit in
`packages/app/src/ui-runtime/execution-composition.ts`
(`acceptedEnd.resolvedEvidenceRefs`) proved unnecessary and was reverted; the
shipped product already commits the acceptance source evidence the updated
assertions check.

## GREEN evidence

```
pnpm exec tsc -p tests/app/native-delivery.tsconfig.json
HUMANAGENT_TEST_ROOT=$(mktemp -d /tmp/ha-grace-r14-green.XXXXXX) \
  node --test dist/tests-native-text/tests/app/native-delivery-public-consumer.test.js
```

Result: `tests 21`, `pass 19`, `fail 2`.
Raw log: `.worker-runs/ruling-request-14-20261109/full21.green.stdout.log`
(exit `.worker-runs/ruling-request-14-20261109/full21.green.exit`). Isolated
`#14` GREEN: `.worker-runs/ruling-request-14-20261109/isolated14.patch.stdout.log`.

- Pass: `#4` `#7` `#14` `#15` `#19` `#20` and every other test except the two
  excluded product candidates.
- Fail (outside this task, original failures preserved): `#6` (`2 !== 1`
  Planner posts) and `#18` (cold-resume child exit `1`, resume `409`).

## Remaining failures owned elsewhere

- `#6`: an inspect delivery issues two Planner requests where the fixture
  expects one. Owner surface: `packages/app/src/ui-runtime` planner alignment.
- `#18`: cold resume of the interrupted third turn returns `409`
  `cold-execution.recovery-hold-effect-unknown`. Owner surface:
  `packages/runtime` cold-execution recovery / effect classification.

## Resource discipline

No daemon, tmux, `10086`, global install, merge, push, or close action was
taken. No requirement changed. The candidate stays committed on the task branch.
