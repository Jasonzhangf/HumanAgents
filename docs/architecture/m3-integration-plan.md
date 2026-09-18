# Milestone 3 Integration Plan

## 1. Current baseline

Integration starts from the latest remote baseline, not the older component base:

```text
origin/main: c1ba308bbef3d013ab43b4d38afdf138c57dd08a
local main:  811efc03e28eeb3b3ff2bd170aeaf88ff8f310e3 (dirty; preserved)
```

The explicit-brain implementation is already included in `origin/main` through
`codex/explicit-brain-impl-20260917`. Its five commits are not cherry-picked again.

Accepted M3 candidates:

| Area | Candidate | Review | Focused evidence |
|---|---|---|---|
| Orchestration | `dc6ab242b21b632ee9b98eb79f35f831405c59ec` | AGY PASS | 23/23 orchestration tests; runtime build |
| Communication | `c4b737a418f48605e62928d45bffb08b3dae94eb` | AGY PASS | 10/10 communication tests; runtime typecheck |
| ACP | `9b6b404e5d8537aa943edc1c5d1d195e117a1105` | AGY PASS | 15/15 ACP tests; ACP typecheck |
| Observation UI | `b6491983b7418bf5da9168e90ad27d289a915035` | Codex PASS | 16/16 UI tests; UI typecheck |

Only these reviewed candidates enter the integration branch. Other parallel
branches remain evidence or unfinished work and are not silently merged.

## 2. Integration sequence

```text
latest origin/main
  -> reviewed candidate merge
  -> public exports and formal gates
  -> typed cross-module composition check
  -> integration tests and release gates
  -> independent integration review
  -> Astra M3 gate
  -> merge to main
  -> rebuild, verify main, push origin/main
```

The integration owner may modify only composition, public exports, root gates,
integration tests, and this plan. Module owners remain responsible for their
implementation files.

## 3. Required integration changes

1. Export communication through the runtime public entry point.
2. Add ACP and communication compile/test paths to the root checkpointed gates.
3. Preserve the explicit-brain gate and its recovery/idempotency tests.
4. Add one integration test proving the public runtime surface can assemble
   orchestration, communication feedback, ACP bindings, and UI projection
   without importing DSH identities into the domain surface.
5. Keep ACP as an adapter; ACP ids, transport receipts, and session records must
   not become HumanAgent task or journal identities.

## 4. Gate and lifecycle policy

- Reuse unchanged candidate focused-review checkpoints.
- Re-run from the first invalidated checkpoint after cherry-pick or composition
  changes: public typecheck -> module compile/tests -> integration tests -> CI
  and release checks.
- A failed integration gate owns the failure at the integration boundary with
  reason, next action, and evidence; it does not rewrite module state.
- UI remains read-only projection. Commands continue through runtime ports.
- Journal/EventBus remain state and delivery owners; UI and ACP never become
  alternate state sources.
- Merge is allowed only after integration review and Astra M3 PASS.

## 5. Integration review corrections

The first integration candidate `e63433e` was rejected by Codex review because
the ACP driver did not enforce `session.open` and `session.load` delegation.
Candidate `4532ef0` added those checks and negative tests, but the follow-up
review also found that remote capability negotiation was returned without
constraining later driver operations. The final candidate `04e0602` persists
the negotiated intersection, lazily negotiates before proof-bound operations,
and rejects operations absent from the remote capability set. ACP focused
tests and the full runtime gate were rerun after both corrections.

## 6. Delivery evidence

The final report must separately record:

- candidate SHAs and source branches;
- integration commit and review receipts;
- gate checkpoints reused and rerun;
- Astra M3 result;
- main merge SHA and clean-state verification;
- rebuilt artifact and test evidence;
- remote `origin/main` push result;
- remaining runtime/live limitations.
