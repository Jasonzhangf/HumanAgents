# Native Agent Task Handoff Semantics

Status: `DESIGN-RULES / F1-H-D1 / SOURCE-ONLY`. This document defines the semantic interpretation of the existing Task-bound handoff contract. It adds no public field, status, queue, event, or second state machine. Receipt fields not proven by current source are marked `UNKNOWN`; the receipt-boundary observation is recorded separately before any contract change.

## Existing identity and source of truth

The existing contract is `WorkAssignment` / `WorkResult` in `packages/contracts/src/index.ts`. Assignment identity is the tuple:

`taskId + pipelineNodeId + assignmentId + attempt + executionEpoch + inputRevision`.

`validateWorkResult(result, assignment)` checks that identity against the assignment, checks artifact refs/digests, and for a `succeeded` result checks that output refs match the assignment's expected outputs. A failed result needs `failureRef`; a `wait` next action needs `conditionRef`. Do not replace this identity with a Provider session, route, model, or prose summary.

`WorkResult.status` reports the worker's result (`succeeded`, `failed`, `incomplete`, `blocked`, or `cancelled`). It does not encode owner acceptance. The existing turn observation contract `TurnExecutionFacts` in `packages/contracts/src/native-reasoning.ts` has separate `dispatchState` (`accepted`, `running`, `returned`, etc.) and `workResultState` (`reported`, `accepted`, `rejected`, `incomplete`, `unknown`). These values describe distinct evidence about the same task-bound assignment; they do not create additional `WorkResult.status` values.

## Four distinct handoff facts

1. **Dispatch accepted** — the dispatch owner has evidence that the assignment was accepted for dispatch. This does not prove that work started.
2. **Running** — the execution owner has evidence that the assigned work began. It does not prove that it returned.
3. **Returned** — a matching `WorkResult` was received and its assignment identity validated. A worker-reported `succeeded` is still only a reported result.
4. **Owner accepted** — the designated owner reviewed the returned artifacts and semantic evidence under the assignment's acceptance criteria and recorded acceptance. A returned result, `status: succeeded`, expected refs, or a free-text summary alone does not prove this.

Use the existing dispatch/result observations where available. If the current producer does not expose a stage receipt, record that stage as `UNKNOWN`; do not synthesize it from the next stage. In particular, dispatch acceptance cannot be inferred from a result, running cannot be inferred from dispatch acceptance, return cannot be inferred from a message ACK, and owner acceptance cannot be inferred from worker success.

## Semantic artifact carried by the handoff

The `summary` field is a short index for a human or orchestrator. It is not the semantic handoff. The result must reference an artifact that carries the evidence needed to continue without replaying old raw tool transcripts into the orchestrator's history. Until a typed semantic artifact contract is approved, this is a content requirement for a referenced artifact, not a new `WorkResult` field.

The artifact should state:

- the assignment identity and the source tool facts it covers, using surface-qualified tool identity and the call/operation evidence actually available;
- each proven conclusion and its certainty (`confirmed`, `partial`, `unknown`, or `corrected`), with source refs that can be read and verified;
- conditions and scope under which each conclusion holds;
- incomplete work, unresolved questions, truncation, missing receipt fields, and any blocked dependency;
- corrections as new claims that cite both the new evidence and the superseded claim; preserve the earlier record instead of rewriting it;
- output artifact refs and digests, the semantic rule/extractor version, and evidence needed for owner acceptance.

No artifact may claim more than its evidence supports. An unreadable ref, digest mismatch, absent tool result, or unknown callback phase keeps the affected claim unknown and the acceptance decision unresolved. Retain raw tool results at their existing immutable owner location; the handoff carries semantic claims and evidence refs, not copies of historical raw output into the orchestrator's context.

## Owner boundaries

- The tool executor/adapter that owns an operation produces its execution facts, raw evidence, and result references. It must not label an unobserved business outcome as accepted or complete.
- The F-S / Context owner at `packages/runtime/src/context/` owns the only pure semantic mapper and checkpoint-history assembly. It maps verified typed receipts to semantic claims; it does not execute or repeat tools.
- `packages/agent-templates` may state the handoff instructions and required sections, but must not implement an extractor or determine acceptance.
- `packages/app` may assemble the existing executor and storage ports. It must not duplicate semantic extraction rules.
- The designated task/pipeline owner owns acceptance against the matching `WorkAssignment` criteria. A `WorkResult` is not accepted merely because a child produced it.

The current contracts provide only part of the required typed shape. `SemanticClaim` has `fact`, `certainty`, and `sourceRefs`; it has no explicit condition or correction linkage. `SemanticClosureCandidate` has claims, constraints, unresolved questions, semantic/raw refs, and requested outcome. `WorkResult` has output/evidence refs and optional bodies, but does not define a semantic bundle or per-claim evidence map. Any new typed shape belongs to a future contracts-owned plan after the receipt boundary is observed and reviewed; this document does not prescribe field names or alter the contract.

## No-Task interaction helper

A helper for an agent interaction that has no HumanAgent `Task`/`WorkAssignment` is **UNKNOWN / not implemented** in the current Task-bound contract. This is future N3 contracts work. Do not fabricate a task ID, reuse a Provider session as task identity, or treat the helper as available in current handoffs. The N3 design must preserve an explicit no-task scope and evidence identity without weakening Task-bound validation.

## Receipt evidence and gaps deliberately left open

F1-H-O1 source/public-consumer observation is complete. Its observation is `/Volumes/Intel/playground/humanagent/.worker-runs/native-reasoning-d0-20261008/f1-h-o1/observation.md` (SHA-256 `eb3bea8e61eb7a5a0deceb07cd0bae4fc177fb1671389efebecf56f013e9fab9`); its result is `result.md` in the same directory (SHA-256 `c10d74ef80e99dff7977da1ef7817985a162f1e037801f14910601cd7fc58a1f`). The authorized app TypeScript compile passed, and after the authorized frozen workspace install the two specified public-consumer test files passed **15/15**. These are source/local-consumer evidence only, not live Provider evidence.

H-O1 establishes these current boundaries:

- Successful executor output bodies remain in the Provider driver's in-memory continuation history, but the persisted Provider tool event projection removes the inline body.
- `file.read`, `file.search`, and `web.search` produce immutable report refs/digests, and the inspected public readback path verifies the stored content digest for eligible successful events. `web.search` also retains its report ref/digest on service-reported failure, but the current public readback path requires event status `succeeded`; save/transport failure can leave no descriptor.
- The other nine Responses tool bodies have no durable report descriptor in the inspected readback path. Their persisted event does not retain the inline body, so that API cannot recover those outputs.
- The inspected production app composition has callback injection slots for Explicit Brain `agent.query` and `agent.message`, but no production callback producer. Without external injection, the ports report a not-configured error. Test callbacks are test evidence only.

Still `UNKNOWN`:

- whether a live Provider actually receives or invokes these tools, and any live tool receipt;
- whether an external caller injects the Explicit callbacks, its exact result envelope, and whether any callback result means `accepted`, `queued`, `delivered`, `read`, `executed`, or `completed`;
- the real external-side-effect state and recovery owner when work succeeds but report/event persistence fails;
- whether owner acceptance has a durable receipt at a production boundary;
- endpoint authorization/deployment behavior outside the inspected app source.

These facts update the source and local consumer evidence, but do not change the semantic rule: absent evidence for a phase or outcome, keep it unknown. `WorkResult` identity/output validation remains distinct from orchestration review/merge and owner acceptance.

## Evidence references

- Tool-by-tool source boundaries and prohibitions: [native-tool-semantics-plan-2026-10-08.md](native-tool-semantics-plan-2026-10-08.md).
- `WorkAssignment`, `WorkResult`, and validation: `packages/contracts/src/index.ts:729-735,848-877`.
- Turn dispatch/result observations and semantic claim contracts: `packages/contracts/src/native-reasoning.ts:37-78`.
- Acceptance/review decision boundary: `packages/runtime/src/orchestration/manager.ts:526-535`.
- F-S sole mapper location: `packages/runtime/src/context/` as assigned by the F1 plan; no mapper implementation or runtime behavior is claimed here.
