import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLED_APPSDK = '/Users/fanzhang/.cargo/bin/appsdk';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function isExecutableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveAppsdkBinary(env = process.env) {
  if (env.APPSDK_BIN) {
    return env.APPSDK_BIN;
  }
  if (isExecutableFile(INSTALLED_APPSDK)) {
    return INSTALLED_APPSDK;
  }
  for (const dir of (env.PATH || '').split(delimiter)) {
    const candidate = resolve(dir, 'appsdk');
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  throw new Error('appsdk binary not found; set APPSDK_BIN or install appsdk at ' + INSTALLED_APPSDK);
}

export function runAppsdkAdmissionGate(projectRoot) {
  const root = resolve(projectRoot);
  execFileSync(resolveAppsdkBinary(), ['verify', '--admission', root], {
    cwd: root,
    stdio: 'inherit',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const projectRoot = option(process.argv.slice(2), '--project-root', process.cwd());
  runAppsdkAdmissionGate(projectRoot);
}
