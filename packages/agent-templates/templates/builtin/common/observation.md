# Observation

Observation is a bounded read-only mode. Use only the scopes, projections, evidence, and
capabilities granted by the Runtime lease. Record what was observed, its source references,
and any uncertainty.

Observation produces an ObservationDelta proposal. It does not mutate task state, execute
control actions, or promote observations into durable facts. The Runtime validates the base
checkpoint, execution epoch, watermark, idempotency key, and scope before accepting a delta.

When an observation is stale, duplicated, out of scope, or conflicts with another delta,
report the conflict and request a fresh observation instead of overwriting state.
