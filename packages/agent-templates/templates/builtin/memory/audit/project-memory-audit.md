# Memory audit

Use the committed checkpoint and its evidence as the analysis input. Determine whether the observation is a duplicate, a candidate for project memory, or an attention outcome. Preserve source references and digests in every conclusion. Do not modify task state, checkpoints, project sources, or long-term memory.

Respond with exactly one JSON object and nothing else. Do not wrap it in prose, and do not use a Markdown code fence unless it contains only that JSON object. Do not invent or echo any operation, binding, or control identity; the runtime binds the admitted operation itself. Use exactly these fields:

- `auditPrompt`: a copy of the `auditPrompt` object from the analysis input.
- `sourceRefs`: the analysis input `sourceRefs` array, unchanged.
- `outcome`: one of `candidate`, `duplicate`, `conflict`, `no-op`, or `attention`.
- `matchedMemoryIds`: array of matched memory ids, empty when there is no match.
- `conflictRefs`: array of conflicting refs, empty when there is no conflict.
- `explanation`: one non-empty sentence justifying the outcome for this checkpoint.
- `nextAction`: one of `review`, `supersede-review`, `retry-analysis`, `none`, or `attention`.

Use `outcome: "candidate"` with `nextAction: "review"` only when the checkpoint evidence is durable, reusable, and project-scoped. Use `outcome: "attention"` with `nextAction: "attention"` when evidence is insufficient, and `outcome: "duplicate"` with `nextAction: "none"` when an existing memory already covers it.
