# Semantic live tool cards

## Goal and acceptance

Goal: repair the WebUI live-turn presentation without changing the backend or the formal runtime at port 10088. The user must see typed shell and file tool activity while the durable Main Topic projection is still stale. The same semantic card must settle in place, expose input and result evidence through `tool-presentation.js`, and keep normal dispatch receipts while replacing a waiting message with one actionable failure when dispatch cannot proceed.

Acceptance:

- Every explicit interaction read, write, and SSE request carries the selected conversation scope exactly once.
- A real typed `provider.tool` SSE event creates a visible semantic preview before its result arrives, with a running clock based on the event timestamp.
- The matching `provider.tool-result` updates the same DOM card; duplicates do not create another card and late events from another request cannot update the active card.
- Bash, file read, empty output, failed result, input/path, raw evidence, and unknown values use the existing `tool-presentation.js` renderer.
- Skill selection appears only as request-stage metadata. The end tool is represented by lifecycle state and does not create a tool card. Internal helper tools are visibly distinct from execution tools.
- A failed confirmation renders a concise actionable failure in place of `已整理 · 等待投递`, while a valid confirmation keeps the normal dispatch receipt.

## Plan and action items

1. WebUI owner: validate the affected explicit-turn and conversation-scope DAGs, then add a failing browser fixture. Evidence: red Chromium receipt and screenshots under this directory. Status: in progress.
2. WebUI owner: fix scoped explicit SSE and correlate events by interaction/request/call identity. Evidence: focused unit checks plus browser request log. Status: pending.
3. WebUI owner: stream typed execution tool events into the active Main Topic turn and preserve card identity/timing through settlement. Evidence: browser DOM identity and timer assertions. Status: pending.
4. WebUI owner: separate request-stage Skill metadata, end lifecycle, internal helper tools, and real execution tools. Evidence: focused renderer test and accessible DOM assertions. Status: pending.
5. WebUI owner: render actionable confirmation/dispatch failures without changing successful receipt semantics. Evidence: failed and valid browser scenarios. Status: pending.
6. WebUI owner: run focused Node tests and the real Chromium fixture, record artifacts, and release only test-owned resources. Status: pending.

## DAG check

- `docs/dagpipe/explicit-interpret-observable-turn.graph.json` is closed at `turn_result`; `project_submission_progress` binds to `docs/ui` and requires real `explicit.step` facts only. No graph topology change is needed for live execution tool overlay because it is an existing `project_turn_result` presentation input, not a new lifecycle owner.
- `../alex-conversation-scope-20261123/docs/dagpipe/conversation-scope-entry.graph.json` requires every read, submit, explicit turn, SSE, and durable state edge to use the same typed scope. The missing-scope explicit EventSource is a concrete UI binding gap and will be fixed through the existing `explicitEventsUrl` edge.

## Progress

- Baseline preserved: shared dirty and untracked work in the existing worktree is not reverted or normalized.
- Formal port 10088 is outside this task. All browser evidence will use an isolated loopback fixture.

## Evidence

Pending.

## Cleanup

Pending.
