#!/usr/bin/env node
import { ConfigurationError, ensureControlLayout, loadConfiguration, resolveRuntimePaths } from '../../config/src/index.js';
import { id, type ProviderBinding } from '../../contracts/src/index.js';
import { AppLifecycleError } from './errors.js';
import { openRuntime, resumeRuntime } from './index.js';
import { SessionStore } from './session-store.js';
import { buildFakeExecutionPort, buildRccExecutionPort, startUiRuntime } from './ui-runtime/index.js';
import { join } from 'node:path';

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error('missing ' + name);
  return value;
}

function loopbackHost(value: string): string {
  if (value !== '127.0.0.1' && value !== '::1') {
    throw new Error('serve --host must be a loopback address (127.0.0.1 or ::1) until the control API has authentication');
  }
  return value;
}

type UiProviderProtocol = 'responses' | 'openai' | 'anthropic';

function providerBindingFromOptions(
  args: readonly string[],
  protocol: UiProviderProtocol,
  mode: 'fake' | 'rcc',
): ProviderBinding & { readonly protocol: UiProviderProtocol } {
  const fake = mode === 'fake';
  return {
    bindingId: fake ? (option(args, '--binding') ?? 'fake-default') : required(option(args, '--binding'), '--binding'),
    providerId: fake ? (option(args, '--provider') ?? 'fake-provider') : required(option(args, '--provider'), '--provider'),
    protocol,
    endpointRef: option(args, '--endpoint') ?? (fake ? 'fake:replay' : 'rcc-v3:127.0.0.1:4444'),
    modelRef: fake ? (option(args, '--model') ?? 'fake.model') : required(option(args, '--model'), '--model'),
    configDigest: option(args, '--config-digest') ?? (fake ? 'sha256:fake-ui-config' : 'sha256:ui-runtime-config'),
    capabilityDigest: option(args, '--capability-digest') ?? (fake ? 'sha256:fake-ui-capability' : 'sha256:ui-runtime-capability'),
  };
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
  if (command === 'serve') {
    const mode = option(args, '--mode') ?? 'fake';
    if (mode !== 'fake' && mode !== 'rcc') {
      throw new Error('serve --mode must be fake or rcc (dsh is not open in this phase)');
    }
    const paths = await resolveRuntimePaths({ workspace, controlRoot });
    await ensureControlLayout(paths);
    await loadConfiguration(paths);
    const protocol = (option(args, '--protocol') ?? 'responses') as UiProviderProtocol;
    if (protocol !== 'responses' && protocol !== 'openai' && protocol !== 'anthropic') {
      throw new Error('serve --protocol must be responses, openai, or anthropic');
    }
    const binding = providerBindingFromOptions(args, protocol, mode);
    const uiRoot = option(args, '--ui-root') ?? join(process.cwd(), 'docs', 'ui');
    const checkpointRoot = join(paths.checkpointsRoot, 'ui-runtime');
    const evidenceRoot = join(paths.artifactsRoot, 'ui-provider-evidence');
    const portNumber = option(args, '--port') ? Number(required(option(args, '--port'), '--port')) : 0;
    const port = mode === 'rcc'
      ? buildRccExecutionPort({
          binding,
          routeRef: required(option(args, '--route'), '--route'),
          baseUrl: option(args, '--rcc-base-url') ?? 'http://127.0.0.1:4444',
          maxTokens: option(args, '--max-tokens') ? Number(option(args, '--max-tokens')) : undefined,
        }, evidenceRoot)
      : buildFakeExecutionPort(binding, option(args, '--fake-step-delay-ms') ? Number(option(args, '--fake-step-delay-ms')) : undefined);
    const runtime = await startUiRuntime({
      mode,
      organId: id('organ', 'humanagent-ui'),
      binding,
      port,
      checkpointRoot,
      evidenceRoot,
      uiRoot,
      host: loopbackHost(option(args, '--host') ?? '127.0.0.1'),
      portNumber,
    });
    console.log(JSON.stringify({ command, mode, url: runtime.server.url, bindingId: binding.bindingId, providerId: binding.providerId, protocol: binding.protocol, uiRoot, checkpointRoot }, null, 2));
    return;
  }
  throw new Error('usage: humanagent init|doctor|run|resume|session|serve --workspace <path> [--plan <name>] [--session <id>]');
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
