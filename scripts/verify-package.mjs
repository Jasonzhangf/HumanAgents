import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredReleaseVersion } from './release-version.mjs';

const projectRoot = process.cwd();
const releaseRoot = join(projectRoot, 'dist', 'release');
const releaseVersion = configuredReleaseVersion();
const packagePath = join(releaseRoot, `humanagent-cli-${releaseVersion}.tgz`);
const root = await mkdtemp(join(tmpdir(), 'humanagent-package-smoke-'));
const prefix = join(root, 'prefix');
const workspace = join(root, 'workspace');
const controlRoot = join(root, 'control');
await mkdir(workspace, { recursive: true });
execFileSync('npm', ['install', '--prefix', prefix, '--ignore-scripts', packagePath], { stdio: 'inherit' });
const cli = join(prefix, 'node_modules', '.bin', 'humanagent');
execFileSync(cli, ['doctor', '--workspace', workspace, '--control-root', controlRoot], { stdio: 'inherit' });
const runArgs = ['run', '--workspace', workspace, '--control-root', controlRoot, '--plan', 'default', '--session', 'package-smoke', '--prompt', 'package smoke'];
execFileSync(cli, runArgs, { stdio: 'inherit' });
let lifecycleError = '';
try {
  execFileSync(cli, runArgs, { encoding: 'utf8' });
} catch (error) {
  lifecycleError = `${error.stdout || ''}${error.stderr || ''}`;
}
if (!lifecycleError.includes('"code":"session-exists"') || !lifecycleError.includes('"ownerId":"session-store"') || !lifecycleError.includes('"nextAction"')) {
  throw new Error('package smoke did not preserve structured lifecycle error evidence');
}
execFileSync(cli, ['session', 'inspect', '--workspace', workspace, '--control-root', controlRoot, '--session', 'package-smoke'], { stdio: 'inherit' });
console.log(JSON.stringify({ package: packagePath, workspace, controlRoot, lifecycleError: 'structured' }, null, 2));
