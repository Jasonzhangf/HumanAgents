# Gate 28 Cordis Host Red Evidence

## Baseline

- Worktree: `/Volumes/extension/code/humanagent/playground/g28-replay-6d52fe2-20260919`
- Exact baseline commit: `6d52fe2ff4c5cac8c5cbc91e20a2dafb1daef8a7`
- Baseline tree: `6b832688fcde33963df1687aa955f777f34baf74`
- Command: `pnpm build:app`, then:

```text
node dist/app/app/src/cli.js serve \
  --workspace <isolated-temp-root>/workspace \
  --control-root <isolated-temp-root>/control \
  --mode fake \
  --port 0
```

The harness parsed the real launch JSON and asserted the exact five-plugin set
plus `composition.complete === true`.

## Result

- Harness exit: `1`
- Observed `plugins`: `undefined`
- Observed `composition.complete`: `false`
- Expected plugins: `humanagent.harness-kernel`,
  `humanagent.fake-provider`, `humanagent.agent-templates`,
  `humanagent.memory`, `humanagent.ui`

The baseline launch JSON had no `plugins` field. Its composition inventory
reported the Cordis host and fixed kernel as composed without reading live
plugin state, while deferred components kept `complete` false.

## Root Cause

- `packages/app/src/cli.ts:466` called `createCordisHost([])`, so `serve`
  loaded only the unconditional fixed kernel and none of the explicit
  fake/template/memory/UI plugins.
- `packages/app/src/entry-composition.ts:49-59` hard-coded `cordis-host` and
  `fixed-harness-kernel` as composed instead of projecting the live host.

The candidate constructs the five-plugin serve composition, validates its
manifests before construction and its owners after startup, consumes the
execution port through the host, and reports the live plugin inventory.
