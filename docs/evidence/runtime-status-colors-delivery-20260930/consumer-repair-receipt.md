# Shared state color consumer repair acceptance

## Candidate and scope

GCM author candidate: `854e34d9802d7df366686a108eb0553834363a84`, based on
the previously verified color candidate `afc7eb0` and current main `b097bb2`.
The root delivery worktree fast-forwarded to the author commit. Product files
were not edited during integration. Evidence additions and lossless log
compression do not change the product bytes.

The previous independent review rejected the Interaction consumer: it loaded
only interaction.css, whose active color was blue and which lacked blue/gray
tone rules. The GCM repair deletes six runtime and four Interaction rules,
imports state-colors.css from both stylesheets, and preserves each page's
base styling. One file now owns all six tone definitions.

## Direct development gates

The root ran each command directly with stdout/stderr redirected, without a
pipeline. Process exit codes were observed separately:

- `pnpm build:contracts`: exit 0, `contracts-r2.log.gz`.
- `pnpm typecheck`: exit 0, `typecheck-r2.log.gz`.
- `pnpm test:ui`: exit 0, 37 passed, 0 failed, 0 skipped, `ui-gate-r2.log`.

The two short logs retain their original trailing blank lines in gzip files.
Gunzip output was compared byte for byte before the plain copies were removed.
The author's corresponding two raw logs were preserved the same way to avoid
Git whitespace warnings without changing the original output.

MCPX capability/workspace discovery was performed. The main repository has an
active MCPX session; this external candidate worktree is not registered and
the exposed workspace API provides no registration action. Candidate gates
and its evidence-only commit use short local CLI commands, not MCPX evidence.

## Native browser consumer evidence

The read-only Interaction consumer on port 50060 serves the actual candidate
interaction.html/interaction.js and stylesheet. Its GET tasks response supplies
13 explicitly labeled CSS sample states; all writes return HTTP 405. It forwards
runtime status from canonical port 10086. These samples are component inputs,
not successful business executions.

`interaction-red-facts.json` records the reproduced old colors. Following the
repair, `interaction-green-facts.json` and `interaction-green.jpg` show the real
Interaction renderer's green running/settling, blue waiting/created/admitted,
gray cancelled/unknown/stale/unavailable, red failed, yellow blocked, and green
succeeded/stopped colors.

The second consumer on port 56799 uses the actual stateTone/element functions
and runtime.css. All 13 computed foreground/background/border/tone values
match their Interaction counterparts. See `runtime-shared-green-facts.json`
and `runtime-shared-green.jpg`.

That consumer's actual tasks.html renders unmodified GET task projections from
canonical port 10086. The existing blocked task remains blocked and appears
yellow; the completed task remains completed and appears green. There is no
horizontal overflow. See `live-shared-green-facts.json` and
`live-shared-green.jpg`. No existing task was executed or mutated.

## Byte identity and applicability

- state-colors.css source/build SHA256:
  `a43804fd10058efbd833a8fd459728a029bd3c0db329412cdf0381c65f2de2c0`.
- runtime.css source/build SHA256:
  `be8868d5a8f099c53286796700cba85937d4927dbf37166eb3c5890de04f9852`.
- interaction.css source/build SHA256:
  `da690614832cae9f45b161eca36dd5c597016996b0480a37da95f4ceb4b135b1`.
- runtime-api.js retains the previously verified shared mapper SHA256:
  `dc148ea9fb00d9bc75a6aba3a71f254703391208d6b8d4bed2e3adb36b5f4133`.

This verifies affected color rendering. Three real Dashboard task scenarios,
five-tool liveness, task scheduling and full orchestration remain separate
mandatory acceptance work. Neither CSS samples nor rendering existing tasks
are counted as new Provider execution evidence.

The backend server code is unchanged; static assets are read per request with
no-store. A backend restart is not applicable to this narrow installation.
New independent review, canonical asset installation/HTTP hash verification,
fresh installed-page verification, merge/push and resource cleanup remain
pending and are not claimed here.
