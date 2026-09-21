import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bumpReleaseVersion, configuredReleaseVersion, packageVersionForRelease } from './release-version.mjs';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const args = process.argv.slice(2);
const projectRoot = resolve(option(args, '--project-root', process.cwd()));
const kind = option(args, '--kind', 'patch');
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, encoding: 'utf8' }).trim();
if (dirty) throw new Error('release version bump requires a clean worktree');

const current = configuredReleaseVersion(process.env, projectRoot);
const next = bumpReleaseVersion(current, kind);
const packagePaths = [
  'package.json',
  'packages/app/package.json',
  'packages/config/package.json',
  'packages/contracts/package.json',
];
for (const relativePath of packagePaths) {
  const path = join(projectRoot, relativePath);
  const packageJson = JSON.parse(await readFile(path, 'utf8'));
  packageJson.version = packageVersionForRelease(next);
  packageJson.releaseVersion = next;
  await writeFile(path, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
}

const architecturePath = join(projectRoot, 'docs', 'architecture', 'release-version.md');
await writeFile(architecturePath, `# Release version baseline\n\n- Current release version: \`${next}\`\n- Canonical source: repository root \`package.json\` \`version\` field.\n- Synchronized package metadata: \`packages/app\`, \`packages/config\`, and \`packages/contracts\`.\n- Version bump owner: \`scripts/bump-release-version.mjs\`.\n- Release build owner: \`scripts/release-build.mjs\`.\n- Every release build must run the checkpointed \`typecheck → compile → regression → ci → package → package-smoke\` chain.\n- The version bump and this architecture record are committed before the release artifact is built.\n`, 'utf8');
console.log(JSON.stringify({ projectRoot, previousVersion: current, releaseVersion: next, kind, files: [...packagePaths, 'docs/architecture/release-version.md'] }, null, 2));
