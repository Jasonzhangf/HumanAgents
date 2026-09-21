import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { bumpReleaseVersion, configuredReleaseVersion } from './release-version.mjs';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const args = process.argv.slice(2);
const projectRoot = resolve(option(args, '--project-root', process.cwd()));
const kind = option(args, '--kind', 'patch');
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, encoding: 'utf8' }).trim();
if (dirty) throw new Error('release build requires a clean worktree before version bump');

const current = configuredReleaseVersion(process.env, projectRoot);
const next = bumpReleaseVersion(current, kind);
execFileSync(process.execPath, ['scripts/bump-release-version.mjs', '--project-root', projectRoot, '--kind', kind], { cwd: projectRoot, stdio: 'inherit' });
execFileSync('git', ['add', 'package.json', 'packages/app/package.json', 'packages/config/package.json', 'packages/contracts/package.json', 'docs/architecture/release-version.md'], { cwd: projectRoot, stdio: 'inherit' });
execFileSync('git', ['commit', '-m', `chore(release): bump version to ${next}`], { cwd: projectRoot, stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/build-release.mjs', '--project-root', projectRoot], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, HUMANAGENT_RELEASE_VERSION: next },
});
