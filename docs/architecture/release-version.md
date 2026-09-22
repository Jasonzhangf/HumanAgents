# Release version baseline

- Current release version: `0.1.0009`
- HumanAgent release source: repository root `package.json` `releaseVersion` field.
- npm package source: repository root `package.json` `version` field; it remains SemVer-valid.
- Synchronized release metadata: `packages/app`, `packages/config`, and `packages/contracts`.
- Version bump owner: `scripts/bump-release-version.mjs`.
- Release build owner: `scripts/release-build.mjs`.
- Every release build must run the checkpointed `typecheck → compile → regression → ci → package → package-smoke` chain.
- The version bump and this architecture record are committed before the release artifact is built.
