#!/usr/bin/env node
import { ConfigurationError, ensureControlLayout, loadConfiguration, resolveRuntimePaths } from '../../config/src/index.js';
import { AppLifecycleError } from './errors.js';
import { closeRuntime, openRuntime, readRunManifest, resumeAgentOperation, resumeRuntime, runAgentOperation } from './index.js';
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
    const prompt = required(option(args, '--prompt'), '--prompt');
    const sessionId = option(args, '--session') ?? 'session-' + Date.now();
    const runtime = await openRuntime({ workspace, controlRoot, plan, sessionId });
    try {
      const running = await new SessionStore(runtime.paths).append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
      const result = await runAgentOperation({
        paths: runtime.paths,
        configuration: runtime.configuration,
        workspace: runtime.paths.workspaceCwd,
        sessionId,
        plan,
        prompt,
      });
      const terminalOutcome = result.checkpoint.outcome === 'succeeded'
        || result.checkpoint.outcome === 'stopped'
        || result.checkpoint.outcome === 'cancelled';
      if (!terminalOutcome) {
        await runtime.lock.release();
      } else {
        await closeRuntime(runtime, result.checkpoint.id.value);
      }
      console.log(JSON.stringify({
        command,
        plan,
        sessionId,
        controlCwd: runtime.paths.controlRoot,
        workspaceCwd: runtime.paths.workspaceCwd,
        projectKey: runtime.paths.projectKey,
        state: terminalOutcome ? 'stopped' : 'recoverable',
        taskId: result.taskId.value,
        operationId: result.operationId.value,
        executionEpoch: result.executionEpoch,
        outcome: result.checkpoint.outcome,
        checkpointId: result.checkpoint.id.value,
        observedKinds: result.receipt.observedKinds,
      }, null, 2));
      void running;
    } catch (error) {
      try { await runtime.lock.release(); } catch { /* preserve the execution failure */ }
      throw error;
    }
    return;
  }
  if (command === 'resume') {
    const sessionId = required(option(args, '--session'), '--session');
    const prompt = required(option(args, '--prompt'), '--prompt');
    const runtime = await resumeRuntime({ workspace, controlRoot, sessionId });
    try {
      const manifest = await readRunManifest(runtime.paths, sessionId);
      const store = new SessionStore(runtime.paths);
      if (runtime.session.state !== 'ready' && runtime.session.state !== 'running') {
        throw new Error(`session cannot resume from state: ${runtime.session.state}`);
      }
      const running = runtime.session.state === 'running'
        ? runtime.session
        : await store.append(sessionId, { type: 'session.state', state: 'running' }, runtime.lock);
      const recovered = await resumeAgentOperation({
        paths: runtime.paths,
        configuration: runtime.configuration,
        workspace: runtime.paths.workspaceCwd,
        sessionId,
        plan: runtime.session.records[0].plan,
        prompt,
        taskId: manifest.taskId,
        cycleId: manifest.cycleId,
        scope: manifest.scope,
        executionEpoch: manifest.executionEpoch,
        directiveRevision: manifest.directiveRevision,
        agentId: manifest.agentId,
        driverRef: manifest.driverRef,
      });
      let state: string;
      if (!recovered.execution) {
        state = (await store.append(sessionId, { type: 'session.state', state: 'ready' }, runtime.lock)).state;
        await runtime.lock.release();
      } else if (recovered.execution.checkpoint.outcome === 'failed') {
        await store.append(sessionId, {
          type: 'session.failed',
          state: 'failed',
          checkpointRef: recovered.execution.checkpoint.id.value,
          errorCode: 'agent-operation-failed',
          nextAction: 'resume from the failed checkpoint or start a new operation',
        }, runtime.lock);
        state = 'failed';
        await runtime.lock.release();
      } else {
        const closed = await closeRuntime(runtime, recovered.execution.checkpoint.id.value);
        state = closed.state;
      }
      console.log(JSON.stringify({
        command,
        sessionId,
        state,
        recoveredCheckpointId: recovered.recovered?.checkpoint.id.value,
        checkpointId: recovered.execution?.checkpoint.id.value,
        waitingReason: recovered.waitingReason,
        resumedExecutionEpoch: recovered.execution?.executionEpoch,
        resumedOutcome: recovered.execution?.checkpoint.outcome,
      }, null, 2));
      void running;
    } catch (error) {
      try { await runtime.lock.release(); } catch { /* preserve the recovery failure */ }
      throw error;
    }
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
