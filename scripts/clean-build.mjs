import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const projectRoot = process.cwd();
for (const path of [
  join(projectRoot, 'dist', 'app'),
  join(projectRoot, 'dist', 'config'),
  join(projectRoot, 'dist', 'packages'),
  join(projectRoot, 'dist', 'tests'),
  join(projectRoot, 'dist', 'tests-runtime-intake'),
  join(projectRoot, 'packages', 'contracts', 'dist'),
  join(projectRoot, 'packages', 'config', 'dist'),
]) await rm(path, { recursive: true, force: true });
