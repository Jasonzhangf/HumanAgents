import { cp } from 'node:fs/promises';
import { join } from 'node:path';

const projectRoot = process.cwd();
await cp(
  join(projectRoot, 'packages', 'agent-templates', 'templates'),
  join(projectRoot, 'dist', 'app', 'agent-templates', 'templates'),
  { recursive: true },
);
