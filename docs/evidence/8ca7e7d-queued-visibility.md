# 8ca7e7d queued visibility evidence

Task: `task-scheduler-8ca7e7d-queued-visibility-r2`

Base commit: `8b1bfd6a035c48f7539bcf9251f70ad932e9d413`

## Fix

- `packages/app/src/ui-runtime/service.ts`
  - Added `QUEUED_VISIBILITY_WINDOW_MS = 100`.
  - `scheduleImplicitConsumption()` now drains after that short window instead
    of on the next macrotask, so a second real HTTP request can observe the
    confirmed requirement as queued before the FIFO consumer dispatches it.
- `tests/app/ui-runtime.test.ts`
  - Added an HTTP regression test that confirms a requirement through the real
    `/api/explicit/*` routes, then immediately fetches `/api/runtime/status`,
    `/api/tasks`, and `/api/tasks/:id` while the queued row is still visible.

The full pending-set projection and queued task detail no-404 behavior were
already present at base; the missing piece was an HTTP-observable queued window
after confirmation when the implicit consumer is enabled.

## Gates

- `pnpm typecheck`: pass
- `pnpm build`: pass
- `node --test dist/tests/tests/app/ui-runtime.test.js`: 120/120 pass
- `node --test dist/tests/tests/app/serve-runtime.test.js`: 18/18 pass
- `node --test dist/tests/tests/app/app.test.js`: 110/110 pass

## Candidate files

- `packages/app/src/ui-runtime/service.ts`
- `tests/app/ui-runtime.test.ts`
- `docs/evidence/8ca7e7d-queued-visibility.md`
