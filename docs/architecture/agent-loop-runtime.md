# Agent Loop Runtime Primitive

## Scope of this candidate

This candidate fixes the reusable runtime loop primitive for one agent runtime:

```text
root checkpoint
  -> observation scope
  -> observation batch cursor
  -> observation delta
  -> context replacement and successor checkpoint
  -> mode transition with a new lease
```

`packages/runtime/src/agent-loop` owns the in-memory lifecycle and fences. It
consumes the typed contracts from `packages/contracts/src/agent-loop.ts` and
the invariant checks from `packages/core/src/agent-loop.ts`.

The candidate intentionally does not claim application delivery. Journal
persistence, EventBus inbox delivery, app assembly, provider execution, ACP,
and UI projection are separate follow-up owners. Until those owners are wired,
the focused runtime tests are the acceptance boundary for this primitive; no
in-memory checkpoint is treated as durable task state.

## Re-entry rules

- A successor checkpoint is created before a context replacement is accepted.
- The inbox and delta cursors advance with the same successor checkpoint.
- A live observation scope is updated to that checkpoint, or is closed by an
  observation delta.
- A closed scope identity can never be reopened. A later observation scope gets
  a fresh identity and lease, so old batch references remain fenced.
- A stale lease or unknown runtime owner cannot mutate the loop.

The next integration candidate may attach this primitive to the existing
Journal and EventBus ports. That work must add durable restart and out-of-order
evidence before the primitive is used as a product execution path.
