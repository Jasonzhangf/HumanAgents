# User Task Explicit->Implicit->Executor E2E Goal

Status: ACTIVE
Date: 2026-09-25
Parent: explicit-brain-e2e-20260922.md

## Goal

Deliver a testable HumanAgent UI flow:
user enters a task, explicit brain understands and confirms, implicit brain
orchestrates and manages resources, executor agents do real coding/search work,
and the task is tracked until completed.

Acceptance is real-entry evidence from browser + serve + RCC/tool execution,
not source tests or theory.

## DAG

```text
user task
  -> explicit brain draft
  -> user confirm
  -> implicit queue/admission/resource
  -> executor agent tool rounds
  -> evidence/writeback
  -> Pipeline Observation
  -> complete
```

Each segment needs real-entry proof. A multi-round task must run multiple
executor steps until completion; failure must be visible and recoverable.

## Acceptance

1. UI first screen supports task input, draft, confirm, status and progress.
2. Explicit brain produces confirmable draft; nothing enters queue without confirm.
3. Confirmation enters implicit FIFO queue under resource admission.
4. Implicit brain dispatches executor agents for concrete subtasks (code.search,
   file/checkpoint work, etc) and records evidence.
5. Multi-round executions can continue; Pipeline Observation shows nodes,
   status, input/output, and evidence.
6. Real-entry `tests/app/real-explicit-implicit-e2e.mjs` proves a user task from
   input to completed, including at least one multi-round path.
7. Main stays verifiable: typecheck, focused tests, app/runtime/provider/ui/release.

## T1 E2E Design and Real Script

T1 owns the shared E2E design contract and the real-entry script that later
feature tasks must satisfy. The script must be run from a clean candidate
worktree whose app build includes the current serve runtime.

### Proof surface

The script drives the real built CLI entry:

```sh
node tests/app/real-explicit-implicit-e2e.mjs
```

It expects a live RCC endpoint on `127.0.0.1:4444`, starts `serve --mode rcc`
with a disposable workspace/control root, and calls the UI Runtime HTTP API
only. It must persist:

`dist/receipts/explicit-implicit-e2e-proof.json`

### Mandatory coverage

1. Explicit draft: `POST /api/explicit/inputs`, then
   `POST /api/explicit/interactions/{id}/interpret`. Assert the interaction
   reaches `awaiting-confirmation`, has a structured `draft`, and does not
   bypass confirmation.
2. Confirm gate: `POST /api/explicit/interactions/{id}/confirmation`.
   Assert the returned requirement has a stable requirement/draft identity.
3. Implicit FIFO: after confirmation, record the runtime status projection.
   If it still shows the confirmed requirement queued, require the positive
   `fifoSeq` on that projection. If the consumer drains before the HTTP status
   read, the proof falls back to the task list `requirementAdmission`
   projection. No direct task creation or manual dispatch is allowed; the task
   must be created by the implicit consumer.
4. Executor rounds: the task dashboard/event stream must show at least two
   `provider.tool` executions and at least one provider event with evidence.
5. Evidence and terminal: the task must reach `succeeded` and carry a
   committed checkpoint; provider/observation evidence refs must be non-empty.
6. Final completed projection: `/api/tasks` and `/api/tasks/{id}/dashboard`
   must both show the completed state.

### Anti-patterns

- No fake provider, mocked `serve`, or fabricated terminal state.
- No manual `POST /api/tasks` and `POST /api/tasks/{id}/executions` for the
  implicit execution proof; confirmed requirements must enter the queue and be
  dispatched by the runtime consumer.
- No editing of `.appsdk/**`, `note.md`, dirty main, or another worker's
  worktree.
- A provider that finishes with fewer than two tool rounds is a failed proof,
  not a skip.

## Tasks

T1 E2E design + real script: worker owner.
T2 Explicit brain UI input/confirm/status: UI worker.
T3 Implicit brain orchestration/resource/executor dispatch: runtime worker.
T4 Multi-round completion proof: acceptance worker.

Shared assembly points owned by master. Implementer and reviewer must differ.

## Non-Goals

No DSH, vector/RAG, production deployment, Harness rewrite, RCC config/credentials,
or second task truth.

## Gates

Code tasks require independent clean worktree under playground/. Real RCC 4444 and
serve must be live; otherwise record blocker, do not mock success.
