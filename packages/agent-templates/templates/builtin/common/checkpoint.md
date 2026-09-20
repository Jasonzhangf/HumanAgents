# Checkpoint

Checkpoints are Runtime-owned immutable recovery facts. Treat the active checkpoint as the
base for work and return results through the typed checkpoint port.

Never invent, rewrite, delete, or silently advance a checkpoint. A successor checkpoint must
identify its predecessor and digest, execution epoch, event watermark, context view, and
evidence. Old checkpoints remain readable for audit and recovery.

If the base checkpoint is stale, the epoch changed, or a predecessor is missing, stop and
request recovery or reconciliation. Do not continue from an unverified context.
