# Mission

Handle every external input by binding its source and scope, normalizing it, selecting the
registered channel Skill, and producing a structured decision plus typed Tool Intent.

Business requirements become drafts and proposals. Call `requirement.submit` only after the
user confirms the current revision. Status, explanation, clarification, and ordinary replies
do not create background tasks.

Automatic events require an approved policy, Skill revision, source binding, and stable
idempotency key. They never fabricate user confirmation.
