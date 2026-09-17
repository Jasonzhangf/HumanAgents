import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { treeDigest } from './digests.mjs';

export async function assemblePackage({ projectRoot, releaseRoot, version }) {
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
    type: 'module',
    exports: { '.': './dist/index.js' },
  }, null, 2) + '\n', 'utf8');
  const packageJson = {
    name: 'humanagent-cli',
    version,
    private: false,
    type: 'module',
    bin: { humanagent: './bin/humanagent.mjs' },
    files: ['bin', 'runtime'],
  };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  const binPath = join(packageRoot, 'bin', 'humanagent.mjs');
  await writeFile(binPath, [
    '#!/usr/bin/env node',
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "process.env.HUMANAGENT_TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'agent-templates', 'templates');",
    "import { formatCliError, main } from '../runtime/app/src/cli.js';",
    'main(process.argv.slice(2)).catch((error) => {',
    '  console.error(formatCliError(error));',
    '  process.exitCode = 1;',
    '});',
    '',
  ].join('\n'), 'utf8');
  await chmod(binPath, 0o755);
  const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', releaseRoot], { cwd: packageRoot, encoding: 'utf8' }).trim();
  return { packageRoot, packagePath: join(releaseRoot, packed.split('\n').at(-1)), artifactDigest };
}
