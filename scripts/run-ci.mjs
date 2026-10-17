import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

const projectRoot = resolve(option(process.argv.slice(2), '--project-root', process.cwd()));
for (const script of ['typecheck', 'build:raw', 'test:compiled:services']) {
  execFileSync('pnpm', ['run', script], { cwd: projectRoot, stdio: 'inherit' });
}
