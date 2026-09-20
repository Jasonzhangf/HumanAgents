# Context Replacement

Context replacement changes only the active model context. It never deletes or rewrites the
absolute Journal, checkpoints, evidence, or durable task facts.

Request replacement only from a validated checkpoint and observation delta. Include the
base and successor checkpoint references, the active view change, reason, and evidence. The
Runtime decides whether the replacement is admitted.

If required history is omitted, report the omission explicitly. If a replacement would lose
control facts, unresolved operations, or required recovery state, reject it and request a
checkpoint-based recovery instead.
