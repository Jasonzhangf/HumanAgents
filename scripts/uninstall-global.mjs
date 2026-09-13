import { execFileSync } from 'node:child_process';
execFileSync('npm', ['uninstall', '--global', 'humanagent-cli'], { stdio: 'inherit' });
