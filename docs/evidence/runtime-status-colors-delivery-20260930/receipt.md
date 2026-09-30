# Runtime status color acceptance

Scope: shared task status mapping and chip CSS; no scheduling or Provider changes.
Product candidate: `3d1db0c76833f00363c97f58a2f1f35f4b4c4362`.
Base: `b097bb2b47fc25c41d459fe81fd8bc32c3b8c152`.

## Authorship and integration

Fresh GCM workers authored this change in
`orch-runtime-status-colors-20260930`. The delivery owner integrated their
three-file snapshot into an independent tree from current main. `cmp` passed
for all three files against the author tree before verification; the delivery
owner added no product behavior. The author tree's earlier missing workspace
dependency caused `ERR_MODULE_NOT_FOUND`, which was a failed attempt. Offline
dependency installation and contracts build resolved that environment issue.

The main-only MCPX session does not register this external candidate. Short
candidate Git and gate commands used the project CLI; their outputs are not
claimed as MCPX executions. No hook was bypassed.

Source SHA-256:

- `docs/ui/runtime-api.js`: `dc148ea9fb00d9bc75a6aba3a71f254703391208d6b8d4bed2e3adb36b5f4133`.
- `docs/ui/runtime.css`: `115ed60bf2368e0f268f75876341ca0a788291a7ca6e2bc19daa3463573d5a36`.
- `tests/ui/runtime-projection.test.ts`: `e45606064bd3f41803ea1a5a3b3c32caab55e08466a10b06ce840cce799a229a`.

## Development gates

In the delivery candidate, in order:

1. `node --check docs/ui/runtime-api.js`: exit 0.
2. `pnpm build:contracts`: exit 0, `contracts.log.gz`.
3. `pnpm typecheck`: exit 0, `typecheck.log.gz`.
4. `pnpm test:ui`: exit 0; 37 tests passed, 0 failed, 0 skipped, `ui-gate.log`.

The new consumer imports the actual browser module through its native file
URL, checks every declared state, and checks an unknown value. It does not
duplicate the mapper or assert source text. Earlier independent parent
verification also passed all 6 projection/mapper tests, then all 37 UI tests.
The two compressed logs preserve raw stdout bytes, including its final blank
line; decompression was checked with `cmp` before removing the task-owned
uncompressed copies. This preserves the output while satisfying Git's text
whitespace check.

## Browser acceptance

A root-owned read-only consumer serves the candidate's actual UI files and
forwards GET API responses unchanged from the canonical service on port 10086.
It rejects all other methods. Initial consumer PID96566/port62604 was stopped;
its exec exited 0 and PID/port absence was verified before replacement.
Current consumer: PID90856, port56799.

The component route `/__acceptance_status_colors.html` explicitly labels its
13 inputs as component examples, not task execution results. It imports the
actual `stateTone` and `element` functions and the candidate's actual shared
CSS. `component-colors.json` and `component-colors.jpg` retain the resulting
native-browser DOM/computed colors:

- Running/settling: green (`active`).
- Waiting/created/admitted: blue.
- Unknown/unavailable/stale/cancelled: gray.
- Failed: red (`danger`).
- Blocked, requiring attention: yellow (`warning`).
- Succeeded/stopped: the existing green completion tone.

The actual `/tasks.html` consumer then rendered the two existing canonical
tasks: blocked is yellow, completed remains green, no old resource category is
visible, and no horizontal overflow was observed. Evidence is in
`actual-list-colors.json` and `actual-list-colors.jpg`. No existing task was
created, executed, stopped, edited or deleted. No Provider success is claimed.

The native-browser tab was closed; listing returned `[]`.
This closes the color component and affected list rendering checks, not the
three complete Dashboard task scenarios or the broader orchestration.

## Pending delivery stages

Independent architecture review, canonical static asset installation, actual
installed-page verification, merge/push receipt and remaining owned-resource
cleanup follow this candidate acceptance. None is claimed by this receipt.
The source/backend server is unchanged, so a backend restart is not applicable
to these static asset changes; installed-byte equality still must be proved.
