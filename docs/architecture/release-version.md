# Release version baseline

- Current release version: `0.1.1`
- Canonical source: repository root `package.json` `version` field.
- Synchronized package metadata: `packages/app`, `packages/config`, and `packages/contracts`.
- Version bump owner: `scripts/bump-release-version.mjs`.
- Release build owner: `scripts/release-build.mjs`.
- Every release build must run the checkpointed `typecheck → compile → regression → ci → package → package-smoke` chain.
- The version bump and this architecture record are committed before the release artifact is built.
