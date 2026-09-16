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
  assert.equal(events.some((event) => event.kind === 'hook.completed' && event.hookId === 'core'), true);
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
  assert.equal(started?.correlation, 'idempotency-42');
  assert.equal(started?.payloadRef, 'payload:42');
  assert.equal(completed?.ownerId, 'request-42');
});
