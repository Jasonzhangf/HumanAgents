import { cp } from 'node:fs/promises';
import { join } from 'node:path';

const projectRoot = process.cwd();
await cp(
  join(projectRoot, 'docs', 'ui'),
  join(projectRoot, 'dist', 'app', 'ui'),
  { recursive: true },
);
