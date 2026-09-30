Status: PASS

Scope:
- docs/ui/state-colors.css is the only CSS owner for the six state-chip tones.
- docs/ui/runtime.css imports state-colors.css once.
- docs/ui/interaction.css imports state-colors.css once.
- Page/base CSS remains unchanged apart from deleting duplicated old state-chip tone rules.

Deletions:
- docs/ui/runtime.css: 6 old .state-chip[data-tone] blocks removed.
- docs/ui/interaction.css: 4 old .state-chip[data-tone] rules removed.

Validation:
- pnpm build:contracts: exit 0; raw log: build-contracts.log
- pnpm typecheck: exit 0; raw log: typecheck.log
- pnpm test:ui: exit 0; 37 tests, 0 fail, 0 skip; raw log: test-ui.log
- pnpm install --offline was required to restore missing local node_modules in this clean worktree; raw log: pnpm-install-offline.log

Build/source SHA256 equality:
- docs/ui/state-colors.css == dist/app/ui/state-colors.css: a43804fd10058efbd833a8fd459728a029bd3c0db329412cdf0381c65f2de2c0
- docs/ui/runtime.css == dist/app/ui/runtime.css: be8868d5a8f099c53286796700cba85937d4927dbf37166eb3c5890de04f9852
- docs/ui/interaction.css == dist/app/ui/interaction.css: da690614832cae9f45b161eca36dd5c597016996b0480a37da95f4ceb4b135b1
