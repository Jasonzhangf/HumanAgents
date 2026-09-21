import { configuredReleaseVersion } from './release-version.mjs';

export function checkpointStages({ includePackaging = false, releaseVersion = configuredReleaseVersion() } = {}) {
  const stages = [
    { name: 'typecheck', owner: 'compile', command: ['pnpm', 'run', 'typecheck'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: 'tsconfig.json' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'tests' }, { kind: 'path', value: 'scripts' }] },
    { name: 'compile', owner: 'compile', dependsOn: ['typecheck'], command: ['pnpm', 'run', 'build:raw'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'tests' }, { kind: 'path', value: 'scripts' }], outputs: [
      { kind: 'path', value: 'dist/app' },
      { kind: 'path', value: 'dist/config' },
      { kind: 'path', value: 'dist/tests' },
      { kind: 'path', value: 'dist/tests-runtime-intake' },
      { kind: 'path', value: 'dist/tests-acp' },
      { kind: 'path', value: 'packages/contracts/dist' },
    ] },
    { name: 'regression', owner: 'regression', dependsOn: ['compile'], command: ['pnpm', 'run', 'test:compiled:services'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'tests' }, { kind: 'path', value: 'scripts' }] },
    { name: 'ci', owner: 'ci', dependsOn: ['regression'], command: ['pnpm', 'run', 'test:release'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: '.gitignore' }, { kind: 'path', value: 'scripts' }, { kind: 'path', value: 'tests/release' }] },
  ];
  if (includePackaging) {
    stages.push(
      { name: 'package', owner: 'release-packager', dependsOn: ['ci'], command: ['pnpm', 'run', 'package:candidate'], inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'pnpm-lock.yaml' }, { kind: 'path', value: 'packages' }, { kind: 'path', value: 'scripts' }, { kind: 'path', value: 'dist/app' }], outputs: [{ kind: 'path', value: `dist/release/humanagent-cli-${releaseVersion}.tgz` }] },
      { name: 'package-smoke', owner: 'release-smoke', dependsOn: ['package'], command: ['pnpm', 'run', 'package:smoke'], env: { HUMANAGENT_RELEASE_VERSION: releaseVersion }, inputs: [{ kind: 'path', value: 'package.json' }, { kind: 'path', value: 'scripts' }] },
    );
  }
  return stages;
}
