import assert from 'node:assert/strict';
import test from 'node:test';
import { createHookRegistry, type AgentLifecycleHook } from '../../../packages/runtime/src/hooks/index.js';
import type { AgentIoEvent } from '../../../packages/runtime/src/agent-io/index.js';

test('core hook failure blocks the stage result and observation hooks stay observable', async () => {
  const events: AgentIoEvent[] = [];
  const registry = createHookRegistry((event) => {
    events.push(event);
  }, () => 1, [
    {
      hookId: 'core',
      version: '1',
      mode: 'core',
      stages: ['request.created'],
      onEnter: async () => ({ status: 'waiting', diagnostics: ['blocked'], ownerId: 'core' }),
    },
    {
      hookId: 'observer',
      version: '1',
      mode: 'observation',
      stages: ['request.created'],
      onEnter: async () => {
        throw new Error('observer boom');
      },
    },
  ]);

  const results = await registry.runStage('request.created', {
    requestId: 'request-1',
    attemptId: 'attempt-1',
  }, 'enter');

  const core = results.find((result) => result.hookId === 'core');
  const observer = results.find((result) => result.hookId === 'observer');
  assert.equal(core?.blocked, true);
  assert.equal(observer?.blocked, false);
  assert.equal(events.some((event) => event.kind === 'hook.failed' && event.hookId === 'observer'), true);
  const completed = events.find((event) => event.kind === 'hook.completed' && event.hookId === 'core');
  assert.equal(completed?.ownerId, 'core');
  assert.equal(completed?.nextAction, 'inspect hook core');
});

test('core hook failed result blocks later core hooks and leaves observation hooks visible', async () => {
  const events: AgentIoEvent[] = [];
  const calls: string[] = [];
  const registry = createHookRegistry((event) => {
    events.push(event);
  }, () => 1, [
    {
      hookId: 'first-core',
      version: '1',
      mode: 'core',
      stages: ['request.admitted'],
      onEnter: async () => {
        calls.push('first-core');
        return {
          status: 'failed',
          diagnostics: ['policy failed'],
          ownerId: 'policy-owner',
          nextAction: 'review policy',
        };
      },
    },
    {
      hookId: 'later-core',
      version: '1',
      mode: 'core',
      stages: ['request.admitted'],
      onEnter: async () => {
        calls.push('later-core');
        return { status: 'observed' };
      },
    },
    {
      hookId: 'observer',
      version: '1',
      mode: 'observation',
      stages: ['request.admitted'],
      onEnter: async () => {
        calls.push('observer');
        return { status: 'observed' };
      },
    },
  ]);

  const results = await registry.runStage('request.admitted', {
    requestId: 'request-1',
    attemptId: 'attempt-1',
  }, 'enter');

  assert.deepEqual(calls, ['first-core', 'observer']);
  assert.equal(results.find((result) => result.hookId === 'first-core')?.blocked, true);
  assert.equal(results.find((result) => result.hookId === 'later-core')?.blocked, true);
  assert.equal(events.some((event) => event.kind === 'hook.started' && event.hookId === 'later-core'), false);
  assert.equal(results.find((result) => result.hookId === 'observer')?.blocked, false);
  assert.equal(events.some((event) => event.kind === 'hook.completed' && event.hookId === 'observer'), true);
  const completed = events.find((event) => event.kind === 'hook.completed' && event.hookId === 'first-core');
  assert.equal(completed?.ownerId, 'policy-owner');
  assert.equal(completed?.nextAction, 'review policy');
});

test('thrown core hook blocks later core hooks and leaves observation hooks visible', async () => {
  const events: AgentIoEvent[] = [];
  const calls: string[] = [];
  const registry = createHookRegistry((event) => {
    events.push(event);
  }, () => 1, [
    {
      hookId: 'first-core',
      version: '1',
      mode: 'core',
      stages: ['request.admitted'],
      onEnter: async () => {
        calls.push('first-core');
        throw new Error('core boom');
      },
    },
    {
      hookId: 'later-core',
      version: '1',
      mode: 'core',
      stages: ['request.admitted'],
      onEnter: async () => {
        calls.push('later-core');
        return { status: 'observed' };
      },
    },
    {
      hookId: 'observer',
      version: '1',
      mode: 'observation',
      stages: ['request.admitted'],
      onEnter: async () => {
        calls.push('observer');
        return { status: 'observed' };
      },
    },
  ]);

  const results = await registry.runStage('request.admitted', {
    requestId: 'request-1',
    attemptId: 'attempt-1',
  }, 'enter');

  assert.deepEqual(calls, ['first-core', 'observer']);
  assert.equal(results.find((result) => result.hookId === 'first-core')?.blocked, true);
  assert.equal(results.find((result) => result.hookId === 'later-core')?.blocked, true);
  assert.equal(events.some((event) => event.kind === 'hook.started' && event.hookId === 'later-core'), false);
  assert.equal(results.find((result) => result.hookId === 'observer')?.blocked, false);
  assert.equal(events.some((event) => event.kind === 'hook.completed' && event.hookId === 'observer'), true);
  const failed = events.find((event) => event.kind === 'hook.failed' && event.hookId === 'first-core');
  assert.equal(failed?.ownerId, 'first-core');
  assert.equal(failed?.nextAction, 'inspect hook first-core');
  assert.equal(failed?.error?.ownerId, 'first-core');
  assert.equal(failed?.error?.nextAction, 'inspect hook first-core');
});

test('hook events carry request, attempt, stage, hook and correlation context', async () => {
  const events: AgentIoEvent[] = [];
  const hook: AgentLifecycleHook = {
    hookId: 'trace',
    version: '1',
    mode: 'observation',
    stages: ['response.decoded'],
    onEnter: async (input) => ({ status: 'derived', outputRefs: [], ownerId: input.requestId }),
  };
  const registry = createHookRegistry((event) => {
    events.push(event);
  }, () => 10, [hook]);

  await registry.runStage('response.decoded', {
    requestId: 'request-42',
    attemptId: 'attempt-42',
    sourceRef: 'source:42',
    correlation: 'idempotency-42',
    payloadRef: 'payload:42',
  }, 'enter');

  const started = events.find((event) => event.kind === 'hook.started' && event.hookId === 'trace');
  const completed = events.find((event) => event.kind === 'hook.completed' && event.hookId === 'trace');
  assert.equal(started?.requestId, 'request-42');
  assert.equal(started?.attemptId, 'attempt-42');
  assert.equal(started?.stage, 'response.decoded');
  assert.equal(started?.hookStage, 'response.decoded');
  assert.equal(started?.hookPhase, 'enter');
  assert.equal(started?.correlation, 'idempotency-42');
  assert.equal(started?.payloadRef, 'payload:42');
  assert.equal(completed?.ownerId, 'request-42');
});

test('core hook exit failures preserve owner and next action', async () => {
  const events: AgentIoEvent[] = [];
  const registry = createHookRegistry((event) => {
    events.push(event);
  }, () => 1, [
    {
      hookId: 'settlement-gate',
      version: '1',
      mode: 'core',
      stages: ['request.settled'],
      onExit: async () => {
        throw new Error('settlement gate failed');
      },
    },
  ]);

  const results = await registry.runStage('request.settled', {
    requestId: 'request-1',
    attemptId: 'attempt-1',
  }, 'exit');
  const failure = results.find((result) => result.hookId === 'settlement-gate');

  assert.equal(failure?.blocked, true);
  assert.equal(failure?.result.status, 'failed');
  assert.equal(failure?.result.ownerId, 'settlement-gate');
  assert.equal(
    failure?.result.status === 'failed' ? failure.result.nextAction : undefined,
    'inspect hook settlement-gate',
  );
  assert.equal(events.find((event) => event.kind === 'hook.failed')?.hookPhase, 'exit');
});

test('enter and exit phases do not share blocked hook state', async () => {
  const registry = createHookRegistry(() => undefined, () => 1, [
    {
      hookId: 'enter-only-gate',
      version: '1',
      mode: 'core',
      stages: ['request.created'],
      onEnter: async () => ({ status: 'waiting', diagnostics: ['blocked'], ownerId: 'policy-owner' }),
    },
  ]);

  const enter = await registry.runStage('request.created', {
    requestId: 'request-1',
    attemptId: 'attempt-1',
  }, 'enter');
  const exit = await registry.runStage('request.created', {
    requestId: 'request-1',
    attemptId: 'attempt-1',
  }, 'exit');

  assert.equal(enter[0]?.blocked, true);
  assert.equal(exit[0]?.blocked, false);
  assert.equal(exit[0]?.result.status, 'observed');
});
