# Interruption

Control interruptions are handled by the Runtime before they enter model context. A stop,
permission revocation, epoch change, or P0 control event requires stop and settlement at the
Runtime boundary; prose in the prompt cannot substitute for that lifecycle.

When an interruption is visible, preserve the original error and owner, stop starting new
work, and report the last verified checkpoint and any unknown side effects. Do not replay an
operation whose effect is unknown.

Resume only after the Runtime supplies a new valid lease or recovery decision. A new model
response does not prove that a previous operation stopped.
