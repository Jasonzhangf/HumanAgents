#!/usr/bin/env node
import { ConfigurationError, ensureControlLayout, loadConfiguration, resolveRuntimePaths } from '../../config/src/index.js';
import { AppLifecycleError } from './errors.js';
import { openRuntime, resumeRuntime } from './index.js';
import { SessionStore } from './session-store.js';

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error('missing ' + name);
  return value;
}

export async function main(args: readonly string[]): Promise<void> {
  const command = args[0] ?? 'help';
  const workspace = option(args, '--workspace') ?? process.cwd();
  const controlRoot = option(args, '--control-root');
  if (command === '--version' || command === 'version') {
    console.log('0.1.0');
    return;
  }
  if (command === 'init' || command === 'doctor') {
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    const config = await loadConfiguration(paths);
    console.log(JSON.stringify({ command, controlRoot: paths.controlRoot, agentCwd: paths.agentCwd, workspaceCwd: paths.workspaceCwd, projectKey: paths.projectKey, agents: config.agentRoster.map((agent) => agent.agentId) }, null, 2));
    return;
  }
  if (command === 'run') {
    const plan = required(option(args, '--plan'), '--plan');
    const sessionId = option(args, '--session') ?? 'session-' + Date.now();
    const runtime = await openRuntime({ workspace, controlRoot, plan, sessionId });
    console.log(JSON.stringify({ command, plan, sessionId, controlCwd: runtime.paths.controlRoot, agentCwd: runtime.paths.agentCwd, workspaceCwd: runtime.paths.workspaceCwd, projectKey: runtime.paths.projectKey, state: runtime.session.state }, null, 2));
    await runtime.lock.release();
    return;
  }
  if (command === 'resume') {
    const sessionId = required(option(args, '--session'), '--session');
    const runtime = await resumeRuntime({ workspace, controlRoot, sessionId });
    console.log(JSON.stringify({ command, sessionId, controlCwd: runtime.paths.controlRoot, agentCwd: runtime.paths.agentCwd, workspaceCwd: runtime.paths.workspaceCwd, projectKey: runtime.paths.projectKey, state: runtime.session.state }, null, 2));
    await runtime.lock.release();
    return;
  }
  if (command === 'session') {
    const action = args[1] ?? 'list';
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    await loadConfiguration(paths);
    const store = new SessionStore(paths);
    if (action === 'list') {
      const sessions = await store.list();
      console.log(JSON.stringify(sessions.map((session) => ({ sessionId: session.sessionId, state: session.state, path: session.path, recoverableTail: session.recoverableTail })), null, 2));
      return;
    }
    if (action === 'inspect') {
      const sessionId = required(option(args, '--session'), '--session');
      console.log(JSON.stringify(await store.open(sessionId), null, 2));
      return;
    }
    throw new Error('usage: humanagent session list|inspect --session <id> --workspace <path>');
  }
  throw new Error('usage: humanagent init|doctor|run|resume|session --workspace <path> [--plan <name>] [--session <id>]');
}

export function formatCliError(error: unknown): string {
  if (error instanceof AppLifecycleError || error instanceof ConfigurationError) {
    return JSON.stringify({ error: { code: error.code, ownerId: error.ownerId, nextAction: error.nextAction, message: error.message } });
  }
  return JSON.stringify({
    error: {
      code: 'host-error',
      ownerId: 'host',
      nextAction: 'inspect the host error and retry after correcting the runtime environment',
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatCliError(error));
    process.exitCode = 1;
  });
}
