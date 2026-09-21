import { chmod, cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { treeDigest } from './digests.mjs';

export async function assemblePackage({ projectRoot, releaseRoot, version, releaseVersion = version }) {
  const packageRoot = join(releaseRoot, 'package');
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await cp(join(projectRoot, 'dist', 'app'), join(packageRoot, 'runtime'), { recursive: true });
  const artifactDigest = await treeDigest(join(projectRoot, 'dist', 'app'));
  if (await treeDigest(join(packageRoot, 'runtime')) !== artifactDigest) throw new Error('packaged runtime does not match compiled artifact');
  const contractsRoot = join(packageRoot, 'runtime', 'node_modules', '@humanagent', 'contracts');
  await mkdir(contractsRoot, { recursive: true });
  await cp(join(projectRoot, 'packages', 'contracts', 'dist'), join(contractsRoot, 'dist'), { recursive: true });
  await writeFile(join(contractsRoot, 'package.json'), JSON.stringify({
    name: '@humanagent/contracts',
    version,
    releaseVersion,
    type: 'module',
    exports: { '.': './dist/index.js' },
  }, null, 2) + '\n', 'utf8');
  const packageJson = {
    name: 'humanagent-cli',
    version,
    releaseVersion,
    private: false,
    type: 'module',
    bin: {
      humanagent: './bin/humanagent.mjs',
      hm: './bin/humanagent.mjs',
    },
    files: ['bin', 'runtime'],
  };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  const binPath = join(packageRoot, 'bin', 'humanagent.mjs');
  await writeFile(binPath, [
    '#!/usr/bin/env node',
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');",
    "const packageJson = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(packageRoot, 'package.json'), 'utf8')));",
    "process.env.HUMANAGENT_RELEASE_VERSION = packageJson.releaseVersion || packageJson.version;",
    "process.env.HUMANAGENT_TEMPLATE_ROOT = join(packageRoot, 'runtime', 'agent-templates', 'templates');",
    "process.env.HUMANAGENT_UI_ROOT = join(packageRoot, 'runtime', 'ui');",
    "import { formatCliError, main } from '../runtime/app/src/cli.js';",
    'main(process.argv.slice(2)).catch((error) => {',
    '  console.error(formatCliError(error, process.argv.slice(2)));',
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n'), 'utf8');
  await chmod(binPath, 0o755);
  const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', releaseRoot], { cwd: packageRoot, encoding: 'utf8' }).trim();
  const packedPath = join(releaseRoot, packed.split('\n').at(-1));
  const packagePath = join(releaseRoot, `humanagent-cli-${releaseVersion}.tgz`);
  if (packedPath !== packagePath) await rename(packedPath, packagePath);
  return { packageRoot, packagePath, artifactDigest };
}
