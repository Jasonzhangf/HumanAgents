import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configuredReleaseVersion } from './release-version.mjs';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const args = process.argv.slice(2);
const projectRoot = resolve(option(args, '--project-root', process.cwd()));
const releaseVersion = option(args, '--release-version', process.env.HUMANAGENT_RELEASE_VERSION || configuredReleaseVersion());
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, encoding: 'utf8' }).trim();
if (dirty && process.env.HUMANAGENT_ALLOW_DIRTY_RELEASE !== '1') {
  throw new Error('release source is dirty; commit or use HUMANAGENT_ALLOW_DIRTY_RELEASE=1 for a local candidate');
}
const releaseScripts = [
  'typecheck',
  'build:raw',
  'test:compiled:services',
  'test:release',
  'package:candidate',
  'package:smoke',
];
for (const script of releaseScripts) {
  execFileSync('pnpm', ['run', script], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, HUMANAGENT_RELEASE_VERSION: releaseVersion },
  });
}

const packageArtifactPath = join(projectRoot, 'dist', 'release', `humanagent-cli-${releaseVersion}.tgz`);
try {
  await access(packageArtifactPath);
} catch {
  throw new Error('release package stage did not produce the expected candidate artifact: ' + packageArtifactPath);
}
console.log(JSON.stringify({ releaseVersion, packageArtifactPath }, null, 2));
