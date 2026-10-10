import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticObservation, toUserNarrative } from '../../packages/context-events/src/index.js';
import type { RuntimeTaskEventLike } from '../../packages/context-events/src/index.js';

const scope = { organId: { scope: 'organ' as const, value: 'organ-1' } };
const taskId = { scope: 'task' as const, value: 'task-1' };
function source(input: Partial<RuntimeTaskEventLike> & Pick<RuntimeTaskEventLike, 'eventId' | 'kind'>): RuntimeTaskEventLike {
  return {
    eventId: input.eventId,
    kind: input.kind,
    seq: input.seq ?? 1,
    occurredAt: input.occurredAt ?? '2026-10-10T00:00:00.000Z',
    taskId: input.taskId ?? taskId,
    operationId: input.operationId ?? 'operation-1',
    executionEpoch: input.executionEpoch ?? 1,
    state: input.state ?? 'running',
    summary: input.summary ?? input.eventId,
    evidenceRefs: input.evidenceRefs ?? [],
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.callId === undefined ? {} : { callId: input.callId }),
    ...(input.toolId === undefined ? {} : { toolId: input.toolId }),
    ...(input.terminalPhase === undefined ? {} : { terminalPhase: input.terminalPhase }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
}
function observe(events: readonly RuntimeTaskEventLike[]) {
  return buildSemanticObservation({ scope, projectionVersion: 'test-v1', sourceWatermark: 1, events });
}

test('public emitted API preserves multi-opener invocation uncertainty in narrative', () => {
  const envelope = observe([
    source({ eventId: 'invoke-1', kind: 'provider.tool', requestId: 'request-1', callId: 'call-1', toolId: 'tool-1' }),
    source({ eventId: 'invoke-2', kind: 'provider.tool', requestId: 'request-1', callId: 'call-1', toolId: 'tool-1', seq: 2 }),
    source({ eventId: 'result-1', kind: 'provider.tool-result', requestId: 'request-1', callId: 'call-1', toolId: 'tool-1', status: 'succeeded', state: 'succeeded', seq: 3 }),
  ]);
  const invocation = envelope.pairing.find((group) => group.kind === 'invocation');
  assert.equal(invocation?.state, 'unknown');
  assert.equal(invocation?.eventRefs.length, 3);
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'multi-opener'), true);
  assert.equal(envelope.events.length, 3);
  assert.deepEqual(toUserNarrative(envelope.events, envelope.pairing).map((event) => event.state), ['needs-user', 'needs-user', 'needs-user']);
});

test('invocation controls distinguish missing opener, open call, succeeded close, and failed close', () => {
  const orphan = observe([
    source({ eventId: 'orphan-result', kind: 'provider.tool-result', requestId: 'request-orphan', callId: 'call-orphan', toolId: 'tool-orphan', status: 'succeeded', state: 'succeeded' }),
  ]);
  assert.equal(orphan.pairing.find((group) => group.kind === 'invocation')?.state, 'unknown');
  assert.equal(orphan.coverageIssues.some((issue) => issue.reason === 'opener-missing'), true);

  const open = observe([
    source({ eventId: 'open-call', kind: 'provider.tool', requestId: 'request-open', callId: 'call-open', toolId: 'tool-open' }),
  ]);
  assert.equal(open.pairing.find((group) => group.kind === 'invocation')?.state, 'open');
  assert.equal(toUserNarrative(open.events, open.pairing)[0].state, 'happening');

  const failed = observe([
    source({ eventId: 'failed-invoke', kind: 'provider.tool', requestId: 'request-failed', callId: 'call-failed', toolId: 'tool-failed' }),
    source({ eventId: 'failed-result', kind: 'provider.tool-result', requestId: 'request-failed', callId: 'call-failed', toolId: 'tool-failed', status: 'failed', state: 'failed', seq: 2 }),
  ]);
  assert.equal(failed.pairing.find((group) => group.kind === 'invocation')?.state, 'closed');
  assert.deepEqual(toUserNarrative(failed.events, failed.pairing).map((event) => event.state), ['happened', 'failed']);
});

test('conflicting replay keeps first canonical fact and makes its operation unknown before projection', () => {
  const first = source({ eventId: 'terminal-1', kind: 'execution.terminal', terminalPhase: 'final', status: 'succeeded', state: 'succeeded' });
  const replay = source({ eventId: 'terminal-1', kind: 'execution.terminal', terminalPhase: 'final', status: 'failed', state: 'failed', operationId: 'other-operation', summary: 'replay' });
  const envelope = observe([first, replay]);
  assert.equal(envelope.events.length, 1);
  assert.equal(envelope.events[0].summary, 'terminal-1');
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'duplicate-conflict' && issue.eventRef?.sourceId === 'terminal-1'), true);
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation')?.state, 'unknown');
  assert.equal(toUserNarrative(envelope.events, envelope.pairing)[0].state, 'needs-user');
});

test('a replay cannot add tool identity or invocation authority to the retained first result', () => {
  const first = source({ eventId: 'result-first', kind: 'provider.tool-result', requestId: 'request-5', callId: 'call-5', status: 'succeeded', state: 'succeeded' });
  const replay = source({ eventId: 'result-first', kind: 'provider.tool-result', requestId: 'request-5', callId: 'call-5', toolId: 'tool-5', status: 'succeeded', state: 'succeeded' });
  const envelope = observe([first, replay]);
  assert.equal(envelope.events.length, 1);
  assert.equal(envelope.events[0].type, 'operation.completed');
  assert.equal(envelope.pairing.some((group) => group.kind === 'invocation'), false);
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation')?.state, 'unknown');
  assert.equal(envelope.pairing.find((group) => group.kind === 'request')?.state, 'unknown');
  assert.equal(toUserNarrative(envelope.events, envelope.pairing)[0].state, 'needs-user');
});

test('missing toolId produces typed coverage and no invocation authority', () => {
  const envelope = observe([
    source({ eventId: 'invoke-no-tool', kind: 'provider.tool', requestId: 'request-2', callId: 'call-2' }),
  ]);
  assert.equal(envelope.pairing.some((group) => group.kind === 'invocation'), false);
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'correlation-unavailable'), true);
  assert.equal(envelope.events.length, 1);
});

test('missing-toolId result retains the mapped canonical and legal parent refs without an invocation', () => {
  const envelope = observe([
    source({ eventId: 'result-no-tool', kind: 'provider.tool-result', requestId: 'request-2b', callId: 'call-2b', status: 'succeeded', state: 'succeeded' }),
  ]);
  assert.equal(envelope.events[0].type, 'operation.completed');
  assert.equal(envelope.pairing.some((group) => group.kind === 'invocation'), false);
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation')?.eventRefs.length, 1);
  assert.equal(envelope.pairing.find((group) => group.kind === 'request')?.eventRefs.length, 1);
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'correlation-unavailable'), true);
});

test('a legal invocation reference outranks parent request and operation states', () => {
  const envelope = observe([
    source({ eventId: 'invoke-specific', kind: 'provider.tool', requestId: 'request-3', callId: 'call-3', toolId: 'tool-3' }),
  ]);
  const event = envelope.events[0];
  const ref = { eventId: event.eventId, sourceId: event.sourceId, scope: event.scope };
  const groups = envelope.pairing.map((group) => ({
    ...group,
    state: group.kind === 'invocation' ? 'open' as const : 'unknown' as const,
    eventRefs: [ref],
  }));
  assert.equal(toUserNarrative([event], groups)[0].state, 'happening');
});

test('a legal request reference outranks a conflicting operation state', () => {
  const envelope = observe([source({ eventId: 'request-selection', kind: 'provider.error', requestId: 'request-selection' })]);
  const event = envelope.events[0];
  const ref = { eventId: event.eventId, sourceId: event.sourceId, scope: event.scope };
  const groups = envelope.pairing.map((group) => ({
    ...group,
    state: group.kind === 'request' ? 'closed' as const : 'unknown' as const,
    eventRefs: [ref],
  }));
  assert.equal(toUserNarrative([event], groups)[0].state, 'happened');
});

test('matching groups tied at highest specificity project needs-user without choosing a winner', () => {
  const envelope = observe([source({ eventId: 'request-tie', kind: 'provider.error', requestId: 'request-tie' })]);
  const event = envelope.events[0];
  const ref = { eventId: event.eventId, sourceId: event.sourceId, scope: event.scope };
  const groups = envelope.pairing.map((group) => ({
    ...group,
    state: group.kind === 'operation' ? 'unknown' as const : 'open' as const,
    eventRefs: [ref],
  }));
  const request = groups.find((group) => group.kind === 'request')!;
  const tiedRequest = { ...request, groupId: `${request.groupId}:tie`, state: 'closed' as const };
  assert.equal(toUserNarrative([event], [...groups, tiedRequest])[0].state, 'needs-user');
});

test('same-content durable replay is idempotent and does not create conflict coverage', () => {
  const first = source({ eventId: 'stable-replay', kind: 'execution.started' });
  const envelope = observe([first, { ...first }]);
  assert.equal(envelope.events.length, 1);
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'duplicate-conflict'), false);
});

test('Provider terminal cannot change execution.started narrative; request identity remains without its ref', () => {
  const envelope = observe([
    source({ eventId: 'request-start', kind: 'execution.started', requestId: 'request-4' }),
    source({ eventId: 'provider-done', kind: 'execution.terminal', terminalPhase: 'provider', state: 'succeeded', requestId: 'request-4', seq: 2 }),
  ]);
  const start = envelope.events.find((event) => event.sourceId === 'request-start')!;
  const request = envelope.pairing.find((group) => group.kind === 'request')!;
  assert.equal(request.requestId, 'request-4');
  assert.equal(request.eventRefs.some((ref) => ref.sourceId === start.sourceId), false);
  assert.equal(envelope.pairing.some((group) => group.kind === 'invocation'), false);
  assert.equal(toUserNarrative([start], envelope.pairing)[0].state, 'happening');
});

test('checkpoint references only operation groups', () => {
  const envelope = observe([source({ eventId: 'checkpoint-only', kind: 'checkpoint.committed', requestId: 'request-checkpoint' })]);
  assert.equal(envelope.pairing.find((group) => group.kind === 'request')?.requestId, 'request-checkpoint');
  assert.equal(envelope.pairing.find((group) => group.kind === 'request')?.eventRefs.length, 0);
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation')?.eventRefs.length, 1);
});

test('contradictory Provider terminal replay retains first refs and makes operation and request unknown', () => {
  const first = source({ eventId: 'provider-replay', kind: 'execution.terminal', terminalPhase: 'provider', requestId: 'request-replay', state: 'succeeded' });
  const replay = source({ ...first, state: 'failed', status: 'failed', summary: 'contradiction', seq: 2 });
  const envelope = observe([first, replay]);
  assert.equal(envelope.events.length, 1);
  assert.equal(envelope.events[0].summary, 'provider-replay');
  for (const kind of ['operation', 'request'] as const) {
    const group = envelope.pairing.find((candidate) => candidate.kind === kind)!;
    assert.equal(group.state, 'unknown');
    assert.deepEqual(group.eventRefs.map((ref) => ref.sourceId), ['provider-replay']);
  }
  assert.equal(toUserNarrative(envelope.events, envelope.pairing)[0].state, 'needs-user');
});

test('tool invoke and result require a nonblank callId but missing toolId result remains canonical', () => {
  for (const [kind, extra] of [
    ['provider.tool', { toolId: 'tool-invalid' }],
    ['provider.tool-result', { status: 'succeeded' as const, state: 'succeeded', toolId: 'tool-invalid' }],
  ] as const) {
    const envelope = observe([source({ eventId: `missing-call-${kind}`, kind, requestId: 'request-invalid', callId: '   ', ...extra })]);
    assert.equal(envelope.events.length, 0);
    assert.equal(envelope.pairing.some((group) => group.kind === 'invocation'), false);
    assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'correlation-unavailable'), true);
  }
});

test('one final Harness terminal closes only its operation; coverage-only settling stays ref-free', () => {
  const envelope = observe([
    source({ eventId: 'operation-start', kind: 'execution.started' }),
    source({ eventId: 'operation-finish', kind: 'execution.terminal', terminalPhase: 'final', state: 'succeeded', seq: 2 }),
    source({ eventId: 'settling-only', kind: 'execution.settling', seq: 3 }),
  ]);
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation')?.state, 'closed');
  const start = envelope.events.find((event) => event.sourceId === 'operation-start')!;
  assert.equal(toUserNarrative([start], envelope.pairing)[0].state, 'happened');
  assert.equal(envelope.events.some((event) => event.sourceId === 'settling-only'), false);
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'unknown-kind'), true);
});

test('final and Provider stopped terminals retain cancelled lifecycle state', () => {
  for (const phase of ['final', 'provider'] as const) {
    const envelope = observe([source({
      eventId: `stopped-${phase}`, kind: 'execution.terminal', terminalPhase: phase,
      state: 'stopped', requestId: `request-stopped-${phase}`,
    })]);
    const event = envelope.events[0];
    assert.equal(event.type, 'operation.failed');
    assert.equal(envelope.coverageIssues.length, 0);
    assert.equal(envelope.pairing.find((group) => group.kind === 'operation')?.state, phase === 'final' ? 'cancelled' : 'open');
    assert.equal(envelope.pairing.find((group) => group.kind === 'request')?.state, phase === 'provider' ? 'cancelled' : 'open');
    assert.equal(toUserNarrative(envelope.events, envelope.pairing)[0].state, 'needs-user');
  }
});

test('terminal state cannot be repaired by status; malformed terminal state stays unknown', () => {
  for (const phase of ['final', 'provider'] as const) {
    for (const [label, state, expected] of [
      ['contradictory-cancelled', 'cancelled', 'cancelled'],
      ['malformed', 'terminal-mystery', 'unknown'],
    ] as const) {
      const eventId = `${label}-${phase}`;
      const envelope = observe([source({
        eventId, kind: 'execution.terminal', terminalPhase: phase,
        state, status: 'succeeded', requestId: `request-${eventId}`,
      })]);
      assert.equal(envelope.events[0].type, 'operation.failed');
      assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'source-facet-missing' && issue.eventRef?.sourceId === eventId), true);
      const operation = envelope.pairing.find((group) => group.kind === 'operation')!;
      const request = envelope.pairing.find((group) => group.kind === 'request')!;
      assert.equal(operation.state, phase === 'final' ? expected : 'open');
      assert.equal(request.state, phase === 'provider' ? expected : 'open');
      assert.equal(toUserNarrative(envelope.events, envelope.pairing)[0].state, 'needs-user');
    }
  }
});

test('invalid execution epoch has coverage but no canonical success; valid sibling remains intact', () => {
  const envelope = observe([
    source({ eventId: 'invalid-epoch-success', kind: 'execution.terminal', terminalPhase: 'final', state: 'succeeded', executionEpoch: 0 }),
    source({ eventId: 'valid-sibling-success', kind: 'execution.terminal', terminalPhase: 'final', state: 'succeeded', operationId: 'operation-valid', seq: 2 }),
  ]);
  assert.equal(envelope.events.some((event) => event.sourceId === 'invalid-epoch-success'), false);
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'source-facet-missing' && issue.sourceRef.locator.includes('invalid-epoch-success') && issue.eventRef === undefined), true);
  assert.equal(toUserNarrative(envelope.events, envelope.pairing).some((event) => event.eventId === 'context-event:invalid-epoch-success'), false);
  const valid = envelope.events.find((event) => event.sourceId === 'valid-sibling-success')!;
  assert.equal(valid.type, 'operation.completed');
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation' && group.scope.operationId?.value === 'operation-valid')?.state, 'closed');
  assert.equal(toUserNarrative([valid], envelope.pairing)[0].state, 'happened');
});

test('late invocation result from an older execution epoch cannot close the current invocation', () => {
  const envelope = observe([
    source({ eventId: 'old-invoke', kind: 'provider.tool', requestId: 'request-6', callId: 'call-6', toolId: 'tool-6', executionEpoch: 1 }),
    source({ eventId: 'old-result', kind: 'provider.tool-result', requestId: 'request-6', callId: 'call-6', toolId: 'tool-6', status: 'succeeded', state: 'succeeded', executionEpoch: 1, seq: 2 }),
    source({ eventId: 'current-invoke', kind: 'provider.tool', requestId: 'request-6', callId: 'call-6', toolId: 'tool-6', executionEpoch: 2, seq: 3 }),
  ]);
  const oldGroup = envelope.pairing.find((group) => group.kind === 'invocation' && group.executionEpoch === 1);
  const currentGroup = envelope.pairing.find((group) => group.kind === 'invocation' && group.executionEpoch === 2);
  assert.equal(oldGroup?.state, 'closed');
  assert.equal(currentGroup?.state, 'open');
});

test('task scope prevents same operation strings from crossing task boundaries', () => {
  const envelope = observe([
    source({ eventId: 'task-a-start', kind: 'execution.started', taskId, operationId: 'shared-operation' }),
    source({ eventId: 'task-b-start', kind: 'execution.started', taskId: { scope: 'task', value: 'task-2' }, operationId: 'shared-operation', seq: 2 }),
    source({ eventId: 'task-b-finish', kind: 'execution.terminal', terminalPhase: 'final', state: 'succeeded', taskId: { scope: 'task', value: 'task-2' }, operationId: 'shared-operation', seq: 3 }),
  ]);
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation' && group.scope.taskId?.value === 'task-1')?.state, 'open');
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation' && group.scope.taskId?.value === 'task-2')?.state, 'closed');
});

test('request and call identity isolate sibling invocations while parent conflict stays local', () => {
  const conflict = source({ eventId: 'conflicted-final', kind: 'execution.terminal', terminalPhase: 'final', state: 'succeeded', requestId: 'request-7' });
  const envelope = observe([
    source({ eventId: 'tool-a', kind: 'provider.tool', requestId: 'request-7', callId: 'call-a', toolId: 'tool-a' }),
    source({ eventId: 'tool-a-result', kind: 'provider.tool-result', requestId: 'request-7', callId: 'call-a', toolId: 'tool-a', status: 'succeeded', state: 'succeeded', seq: 2 }),
    source({ eventId: 'tool-b', kind: 'provider.tool', requestId: 'request-7', callId: 'call-b', toolId: 'tool-b', seq: 3 }),
    source({ eventId: 'tool-b-result', kind: 'provider.tool-result', requestId: 'request-7', callId: 'call-b', toolId: 'tool-b', status: 'failed', state: 'failed', seq: 4 }),
    conflict,
    source({ ...conflict, state: 'failed', status: 'failed', summary: 'contradictory replay', seq: 6 }),
  ]);
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation')?.state, 'unknown');
  assert.equal(envelope.pairing.find((group) => group.kind === 'request')?.state, 'unknown');
  assert.equal(envelope.pairing.find((group) => group.kind === 'invocation' && group.callId === 'call-a')?.state, 'closed');
  assert.equal(envelope.pairing.find((group) => group.kind === 'invocation' && group.callId === 'call-b')?.state, 'closed');
});

test('unknown legacy kinds cannot gain terminal or invocation authority from incidental fields', () => {
  const envelope = observe([
    source({ eventId: 'legacy-kind', kind: 'legacy.terminal', requestId: 'request-8', callId: 'call-8', toolId: 'tool-8', terminalPhase: 'final', status: 'succeeded', state: 'succeeded' }),
  ]);
  assert.equal(envelope.events.length, 0);
  assert.equal(envelope.pairing.find((group) => group.kind === 'operation')?.state, 'open');
  assert.equal(envelope.pairing.find((group) => group.kind === 'request')?.state, 'open');
  assert.equal(envelope.pairing.some((group) => group.kind === 'invocation'), false);
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'unknown-kind'), true);
});

test('waiting terminal and other coverage-only sources retain groups without refs or narrative', () => {
  const envelope = observe([
    source({ eventId: 'waiting-final', kind: 'execution.terminal', terminalPhase: 'final', state: 'waiting' }),
    source({ eventId: 'waiting-provider', kind: 'execution.terminal', terminalPhase: 'provider', requestId: 'request-waiting', state: 'waiting', seq: 2 }),
    source({ eventId: 'model-only', kind: 'provider.model', seq: 3 }),
    source({ eventId: 'output-only', kind: 'provider.output', seq: 4 }),
    source({ eventId: 'settle-only', kind: 'execution.settling', seq: 5 }),
  ]);
  const operation = envelope.pairing.find((group) => group.kind === 'operation')!;
  assert.equal(operation.state, 'waiting');
  assert.deepEqual(operation.eventRefs, []);
  assert.equal(envelope.events.length, 0);
  assert.deepEqual(toUserNarrative(envelope.events, envelope.pairing), []);
  assert.equal(envelope.coverageIssues.filter((issue) => issue.reason === 'unknown-kind').length, 3);
  assert.equal(envelope.coverageIssues.filter((issue) => issue.reason === 'waiting-is-not-terminal').length, 2);
  assert.equal(envelope.pairing.find((group) => group.kind === 'request')?.state, 'waiting');
  assert.equal(envelope.coverageIssues.filter((issue) => issue.reason === 'unknown-kind').every((issue) => issue.eventRef === undefined), true);
  assert.equal(envelope.coverageIssues.find((issue) => issue.reason === 'waiting-is-not-terminal')?.eventRef, undefined);
});

test('invocation cancellation, block, and unknown states remain distinct and need attention', () => {
  const expected = [
    ['cancelled', 'cancelled'],
    ['blocked', 'blocked'],
    ['unknown', 'unknown'],
  ] as const;
  for (const [status, state] of expected) {
    const envelope = observe([
      source({ eventId: `${status}-invoke`, kind: 'provider.tool', requestId: `request-${status}`, callId: `call-${status}`, toolId: `tool-${status}` }),
      source({ eventId: `${status}-result`, kind: 'provider.tool-result', requestId: `request-${status}`, callId: `call-${status}`, toolId: `tool-${status}`, status, state, seq: 2 }),
    ]);
    const invocation = envelope.pairing.find((group) => group.kind === 'invocation')!;
    assert.equal(invocation.state, state);
    assert.equal(toUserNarrative(envelope.events, envelope.pairing).every((event) => event.state === 'needs-user'), true);
  }
});

test('invocation result status is authoritative; generic state cannot close or repair it', () => {
  for (const [status, state] of [
    [undefined, 'succeeded'],
    ['cancelled', 'succeeded'],
    ['blocked', 'succeeded'],
    ['unknown', 'succeeded'],
  ] as const) {
    const envelope = observe([
      source({ eventId: `guard-invoke-${status ?? 'missing'}`, kind: 'provider.tool', requestId: 'request-guard', callId: `call-guard-${status ?? 'missing'}`, toolId: 'tool-guard' }),
      source({ eventId: `guard-result-${status ?? 'missing'}`, kind: 'provider.tool-result', requestId: 'request-guard', callId: `call-guard-${status ?? 'missing'}`, toolId: 'tool-guard', ...(status === undefined ? {} : { status }), state, seq: 2 }),
    ]);
    const invocation = envelope.pairing.find((group) => group.kind === 'invocation')!;
    assert.notEqual(invocation.state, 'closed');
    assert.equal(toUserNarrative(envelope.events, envelope.pairing).every((event) => event.state === 'needs-user'), true);
  }
});

test('conflicted tool result keeps first invocation evidence uncertain while sibling stays closed', () => {
  const traceScope = { organId: { scope: 'organ' as const, value: 'organ-A' } };
  const traceTask = { scope: 'task' as const, value: 'task-A' };
  const traceSource = (input: Partial<RuntimeTaskEventLike> & Pick<RuntimeTaskEventLike, 'eventId' | 'kind'>) => source({
    ...input, taskId: traceTask, operationId: 'op-A', executionEpoch: 1,
  });
  const envelope = buildSemanticObservation({ scope: traceScope, projectionVersion: 'test-v1', sourceWatermark: 1, events: [
    traceSource({ eventId: 'trace-U', kind: 'provider.tool', requestId: 'req-A', callId: 'call-A', toolId: 'file.search' }),
    traceSource({ eventId: 'trace-V', kind: 'provider.tool-result', requestId: 'req-A', callId: 'call-A', toolId: 'file.search', status: 'succeeded', state: 'succeeded', seq: 2 }),
    traceSource({ eventId: 'trace-V', kind: 'provider.tool-result', requestId: 'req-A', callId: 'call-A', toolId: 'file.search', status: 'failed', state: 'failed', seq: 3 }),
    traceSource({ eventId: 'sibling-U', kind: 'provider.tool', requestId: 'req-A', callId: 'call-sibling', toolId: 'file.search', seq: 4 }),
    traceSource({ eventId: 'sibling-V', kind: 'provider.tool-result', requestId: 'req-A', callId: 'call-sibling', toolId: 'file.search', status: 'succeeded', state: 'succeeded', seq: 5 }),
  ] });
  const conflicted = envelope.pairing.find((group) => group.kind === 'invocation' && group.callId === 'call-A')!;
  const operation = envelope.pairing.find((group) => group.kind === 'operation')!;
  const request = envelope.pairing.find((group) => group.kind === 'request')!;
  const sibling = envelope.pairing.find((group) => group.kind === 'invocation' && group.callId === 'call-sibling')!;
  assert.equal(conflicted.state, 'unknown');
  assert.equal(operation.state, 'unknown');
  assert.equal(request.state, 'unknown');
  assert.deepEqual(conflicted.eventRefs.map((ref) => ref.sourceId), ['trace-U', 'trace-V']);
  assert.equal(sibling.state, 'closed');
  const narrative = toUserNarrative(envelope.events, envelope.pairing);
  assert.equal(narrative.every((event) => event.state === 'needs-user'), false);
  assert.equal(narrative.find((event) => event.eventId === 'context-event:trace-U')?.state, 'needs-user');
  assert.equal(narrative.find((event) => event.eventId === 'context-event:trace-V')?.state, 'needs-user');
  assert.deepEqual(narrative.filter((event) => event.eventId === 'context-event:sibling-U' || event.eventId === 'context-event:sibling-V').map((event) => event.state), ['happened', 'happened']);
});

test('final Harness failure can pair with a recovery checkpoint in the same execution only', () => {
  const envelope = observe([
    source({ eventId: 'failed-final', kind: 'execution.terminal', terminalPhase: 'final', state: 'failed' }),
    source({ eventId: 'recovery-checkpoint', kind: 'checkpoint.committed', seq: 2 }),
    source({ eventId: 'other-execution-failure', kind: 'execution.terminal', terminalPhase: 'final', state: 'failed', executionEpoch: 2, seq: 3 }),
    source({ eventId: 'other-execution-checkpoint', kind: 'checkpoint.committed', executionEpoch: 3, seq: 4 }),
  ]);
  const failure = envelope.events.find((event) => event.sourceId === 'failed-final')!;
  const checkpoint = envelope.events.find((event) => event.sourceId === 'recovery-checkpoint')!;
  assert.equal(failure.pairing?.role, 'opened');
  assert.equal(failure.status, 'resolved');
  assert.equal(checkpoint.pairing?.relatedEventId, failure.eventId);
  const otherCheckpoint = envelope.events.find((event) => event.sourceId === 'other-execution-checkpoint')!;
  assert.equal(otherCheckpoint.status, 'completed');
  assert.equal(otherCheckpoint.pairing, undefined);
});

test('tool identity conflict cannot close either invocation', () => {
  const envelope = observe([
    source({ eventId: 'tool-identity-open', kind: 'provider.tool', requestId: 'request-tool-conflict', callId: 'call-tool-conflict', toolId: 'tool-a' }),
    source({ eventId: 'tool-identity-result', kind: 'provider.tool-result', requestId: 'request-tool-conflict', callId: 'call-tool-conflict', toolId: 'tool-b', status: 'succeeded', state: 'succeeded', seq: 2 }),
  ]);
  const invocations = envelope.pairing.filter((group) => group.kind === 'invocation');
  assert.equal(invocations.length, 2);
  assert.equal(invocations.every((group) => group.state === 'unknown'), true);
  assert.equal(envelope.coverageIssues.some((issue) => issue.reason === 'duplicate-conflict'), true);
});

test('projection ignores identity-only and cross-scope references and does not mutate frozen inputs', () => {
  const envelope = observe([source({ eventId: 'immutable-event', kind: 'execution.started' })]);
  const event = Object.freeze({ ...envelope.events[0] });
  const unrelatedScope = { ...event.scope, operationId: { scope: 'operation' as const, value: 'other-operation' } };
  const identityOnly = Object.freeze({
    ...envelope.pairing[0],
    groupId: 'identity-only',
    state: 'unknown' as const,
    eventRefs: Object.freeze([{ eventId: event.eventId, sourceId: event.sourceId, scope: unrelatedScope }]),
  });
  const events = Object.freeze([event]);
  const pairing = Object.freeze([identityOnly]);
  const before = JSON.stringify([events, pairing]);
  const first = toUserNarrative(events, pairing);
  const second = toUserNarrative(events, pairing);
  assert.equal(first[0].state, 'happening');
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify([events, pairing]), before);
});
