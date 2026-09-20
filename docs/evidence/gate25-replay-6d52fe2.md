# Gate25 replay on 6d52fe2

## Scope

- Bug: `cd8e2d77a2f9307e15003509b95e5f335131e4552e9600aba8b631227f476651`
- Old candidate: `32df7773bad2144a30b26aded653a7148eb842bf`
- Old tree: `ae3e92be7beb8c8fb8daa6379c5fe8e626f13b84`
- Old parent/base: `ec56133254e3ae51d1dae6731757027556ec91cc`
- Exact replay base: `6d52fe2ff4c5cac8c5cbc91e20a2dafb1daef8a7`
- Final candidate commit: recorded in the delivery report after this evidence was folded into it.

The old candidate was inspected directly. Its driver-factory portions were
already superseded by the current base, so this replay carried only the
builtin audit-prompt preparation semantics and adapted them to the current
memory composition.

## Root cause

On the exact base, `packages/app/src/memory-runtime.ts:192` created only the
`<controlRoot>/memory-audit` directory. `packages/runtime/src/memory/agent.ts:1112`
then read `<controlRoot>/memory-audit/<promptRef>.md`; on a fresh control root
the file did not exist, so the boundary recorded a retry obligation instead of
an applied closure.

## Pre-fix red proof

Command:

```sh
node dist/app/app/src/cli.js serve \
  --workspace /tmp/humanagent-g25-red.Mu23VN/workspace \
  --control-root /tmp/humanagent-g25-red.Mu23VN/control \
  --mode fake --port 0
```

The real HTTP entry completed the fake execution, but its durable journal
contained:

```text
seq=1 memory.analysis.requested
seq=2 external-operation pending
seq=3 barrier-intent applied
seq=4 retry pending, failureRef=memory-agent-prompt-unavailable
```

There was no `consumer-commit`. This is the preserved pre-fix red evidence.

## Candidate gates

| Command | Exit | Result |
|---|---:|---|
| `pnpm build:app` | 0 | build completed |
| `pnpm typecheck` | 0 | no diagnostics |
| `pnpm test:app` | 0 | 179 pass, 0 fail |
| `pnpm test:runtime` | 0 | 331 pass, 0 fail |
| `pnpm test:release` | 0 | 31 pass, 0 fail |
| `git diff --check` | 0 | no whitespace errors |

The focused three-case replay also passed before the full gates:

```text
CLI serve prepares the configured builtin memory audit prompt ...
CLI serve rejects an unknown configured memory audit prompt ...
memory runtime preserves an existing configured audit prompt ...
tests 3; pass 3; fail 0
```

## Final entry proof

Positive command used the final candidate build and a fresh control root:

```sh
node dist/app/app/src/cli.js serve \
  --workspace /Volumes/extension/code/humanagent/playground/g25-replay-6d52fe2-20260919 \
  --control-root /tmp/humanagent-g25-final2.IoeyMG/control \
  --mode fake --port 0
```

The HTTP task execution reached `state=ready` / `output.state=succeeded`.
The child process explicitly removed `HUMANAGENT_TEMPLATE_ROOT`, proving the
compiled CLI resolves `dist/app/agent-templates/templates` itself.
The durable journal contained six records in order:

```text
memory.analysis.requested
external-operation pending
barrier-intent applied
memory-agent-state
external-operation settled
consumer-commit applied
```

Counts from that journal:

```text
lines=6
retry=0
memory-agent-prompt-unavailable=0
consumer-commit=1
external-operation settled=1
```

The prepared prompt was copied from the builtin registry resource with digest
`sha256:488b1dd16521515737863da1791ff5c0295a4a1008b486aed547edd012357258`.
The persisted project memory snapshot referenced the same digest.

Negative command:

```sh
node dist/app/app/src/cli.js serve \
  --workspace /tmp/humanagent-g25-negative.WOAMhZ/workspace \
  --control-root /tmp/humanagent-g25-negative.WOAMhZ/control \
  --mode fake --port 0
```

With `memory.audit.prompt_ref = "unknown-memory-audit"`:

```text
exit=1
stdout-bytes=0
stderr={"error":{"code":"host-error",...,"message":"configured memory audit prompt is not a builtin resource: unknown-memory-audit"}}
journal-files=0
```

## Boundary

No merge, push, install, restart, release, or production action was performed.
The remaining risk is that the broader serve composition inventory still
reports AgentIo/EventBus, M3, and HarnessNodeRuntime unavailable; those are
outside this Gate25 memory-prompt repair.
