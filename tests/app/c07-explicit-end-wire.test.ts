import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { id, type InteractionParentProviderExecutionIdentityRef, type ProviderBinding } from '../../packages/contracts/src/index.js';
import { createProviderExplicitBrainInterpreter, normalizeTaskTitle,
  type ExplicitBrainInterpretationInput } from '../../packages/app/src/explicit-brain-runtime.js';
import { UiRuntimeApiError } from '../../packages/app/src/ui-runtime/errors.js';
import { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { resolveRuntimePaths, ensureControlLayout } from '../../packages/config/src/index.js';
import { acquireDaemonLease } from '../../packages/app/src/supervisor/index.js';
import { RuntimeTaskControlError } from '../../packages/runtime/src/ui-runtime/coordinator.js';
import { beginExplicitEndAttempt, readExplicitEndRecovery } from '../../packages/runtime/src/explicit-brain/explicit-turn-end.js';
import type { ExplicitInteractionStepInput } from '../../packages/runtime/src/intake/explicit-intake.js';

// Failure basis: the live interpreter accepted plain terminal text, skipped the
// end contract and checkpointed it. Wrong end continuation also loses tools or
// dispatches a fourth request after the third accepted end. Impact: wrong task
// routing / false success. Cost: isolated HTTP SSE requests and JSONL round trip.
const answer = { kind: 'simple', decision: {
  kind: 'answer', normalizedInput: '你好', knownFacts: [], decisionRefs: [], answer: '你好。',
}, checkpointRecord: { index: { action: '回答用户问题', result: '已回答' } } };
const requirement = { kind: 'complex', decision: {
  kind: 'requirement', normalizedInput: '整理报告', knownFacts: [], decisionRefs: [],
  taskFlow: { kind: 'one-shot', definitionVersion: 1 },
  proposal: { revision: 1, intent: 'create', title: '报告', objective: '整理报告', deliverable: '报告文件',
    deliveryConditions: ['报告可读'], evidenceRefs: [], blockingGaps: [] },
}, checkpointRecord: { index: { action: '整理用户需求', result: '已准备好执行' } }, capsule: { summary: '已整理报告需求', goal: '交付报告', process: ['识别用户需求'], findings: [], nextStep: '交给隐式大脑执行' } };

async function runWire(attempts: readonly unknown[], options: {
  textFirst?: boolean; skills?: boolean | readonly string[]; malformed?: readonly number[];
  correctedEndAt?: number;
  coldAccepted?: boolean; coldPartial?: boolean; resume?: boolean;
  readTaskResult?: (taskId: string) => Promise<unknown>;
  readReply?: unknown;
  resumeWriter?: (taskId: string) => Promise<unknown>;
  readArguments?: unknown;
  correctRead?: boolean;
  projectSnapshot?: (members?: readonly string[]) => Promise<unknown>;
  snapshotActor?: 'ceo' | 'project-lead';
  projectSnapshotCalls?: readonly unknown[];
  failedDrain?: boolean;
  failedDrains?: number;
  failSubmitAt?: number;
  interruptResume?: boolean;
  failStartAt?: number;
} = {}) {
  const fixtureRoot = join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'c07-explicit-wire-'));
  const wires: any[] = [];
  let modelRequestCount = 0;
  let drainCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'controlled' }], status: 'ok' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const wire = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    wires.push(wire);
    if (wire.tools === undefined) {
      drainCount++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        { type: 'response.created', response: { id: 'drain' } },
        { type: 'response.output_text.done', item_id: 'drain-text', text: 'transport drained; this text is not an intake decision' },
        ...((options.failedDrain || options.failedDrains) && drainCount <= (options.failedDrains ?? 1)
          ? [{ type: 'interaction5.unrecognized-drain-frame' }]
          : [{ type: 'response.completed', response: { id: 'drain' } }]),
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
      return;
    }
    const index = modelRequestCount++;
    const snapshotCalls = !options.projectSnapshot || options.snapshotActor === 'ceo'
      ? [] : options.projectSnapshotCalls ?? [{}];
    const readStart = (options.skills ? 1 : 0) + snapshotCalls.length;
    const readRound = options.readTaskResult !== undefined
      && (index === readStart || (options.correctRead === true && index === readStart + 1));
    const skillRound = options.skills && index === 0;
    const snapshotStart = options.skills ? 1 : 0;
    const snapshotRound = index >= snapshotStart && index < snapshotStart + snapshotCalls.length;
    const snapshotIndex = index - snapshotStart;
    const toolRoundCount = (options.skills ? 1 : 0)
      + snapshotCalls.length
      + (options.readTaskResult === undefined ? 0 : options.correctRead ? 2 : 1);
    let argument = attempts[index - toolRoundCount];
    if (options.readTaskResult && index >= toolRoundCount) {
      const result = wire.input.find((entry: any) => entry.type === 'function_call_output'
        && entry.call_id === `call-${readStart + (options.correctRead ? 1 : 0)}`);
      argument = options.readReply ?? { ...answer, decision: { ...answer.decision, answer: result?.output ?? 'missing result' } };
    }
    // A runaway request is an explicit test failure, never an endless fixture.
    if (!readRound && !snapshotRound && !skillRound && argument === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'unexpected extra model request' } }));
      return;
    }
    const frames = [
      { type: 'response.created', response: { id: `c07-${index}` } },
      ...(options.textFirst && index === 0 ? [{ type: 'response.output_text.done', item_id: `text-${index}`, text: JSON.stringify(argument) }]
        : [{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: `item-${index}`,
          call_id: `call-${index}`, name: readRound ? 'task_read_result'
            : snapshotRound ? 'project_snapshot'
            : skillRound ? 'interaction_select_skills' : 'humanagent_turn_end',
          arguments: options.malformed?.includes(index) ? '{' : JSON.stringify(readRound
            ? (index === readStart ? options.readArguments : undefined) ?? { taskId: 'published-parent' }
            : snapshotRound ? snapshotCalls[snapshotIndex]
            : skillRound ? { skillIds: options.skills === true ? ['task-intake'] : options.skills } : argument) } }]),
      ...(options.correctedEndAt === index ? [{ type: 'response.output_item.done', output_index: 1,
        item: { type: 'function_call', id: 'item-corrected', call_id: 'call-corrected', name: 'humanagent_turn_end',
          arguments: JSON.stringify(answer) } }] : []),
      { type: 'response.completed', response: { id: `c07-${index}` } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test HTTP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const binding: ProviderBinding = { bindingId: 'c07-wire', providerId: 'controlled', protocol: 'responses',
    endpointRef: baseUrl, modelRef: 'controlled', configDigest: 'test:config', capabilityDigest: 'test:capability' };
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(root, 'assets')));
  const journalPath = join(root, 'organ.jsonl');
  const journal = new JsonlOrganJournal(journalPath);
  const parentJournal = new JsonlInteractionParentTurnJournal(journal);
  const helpers = new JsonlInteractionHelperJournal(journal);
  const organId = id('organ', 'c07-wire');
  const interactionScopeId = 'c07-wire';
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
  await ensureControlLayout(paths);
  const lease = options.resume || options.failedDrain || options.failedDrains || options.failSubmitAt ? await acquireDaemonLease(paths) : undefined;
  const transport = new V3ProviderHttpTransport<InteractionParentProviderExecutionIdentityRef>({ binding, baseUrl, source: 'http', evidence });
  const submit = transport.submit.bind(transport);
  const start = transport.start.bind(transport);
  let starts = 0;
  transport.start = async (...args) => {
    starts++;
    if (starts > 1 && (options.failSubmitAt || options.failStartAt)) {
      const turn = args[0].interactionTurn;
      const before = await parentJournal.readTurnSnapshot(turn);
      const attempt = before.endControls?.map(entry => entry.fact).filter(f => f.kind === 'attempt').at(-1)?.attempt;
      if (!attempt) throw new Error('expected admitted recovery attempt');
      assert.deepEqual(await beginExplicitEndAttempt({ journal: parentJournal, turn, execution: attempt.execution,
        ...(attempt.resumePartialRef === undefined ? {} : { resumePartialRef: attempt.resumePartialRef }) }), attempt);
      assert.equal((await parentJournal.readTurnSnapshot(turn)).endControls?.length, before.endControls?.length);
      if (attempt.resumePartialRef) assert.deepEqual((await readExplicitEndRecovery({ journal: parentJournal, turn,
        partialRef: attempt.resumePartialRef })).resumedAttempt, attempt);
    }
    if (starts === options.failStartAt) throw new Error('controlled zero-fact first dispatch failure');
    return start(...args);
  };
  let submits = 0;
  transport.submit = async (...args) => {
    if (++submits === options.failSubmitAt) throw new Error('controlled zero-fact submit failure');
    return submit(...args);
  };
  const port = new ProviderAdapter<InteractionParentProviderExecutionIdentityRef>({ binding, routeRef: 'controlled',
    codec: new ResponsesProviderCodec(), evidence,
    transport,
  });
  try {
  const createInterpreter = (overrides: Partial<Parameters<typeof createProviderExplicitBrainInterpreter>[0]> = {}) => createProviderExplicitBrainInterpreter({
    organId, interactionScopeId, binding, port, parentJournal, checkpointJournal: helpers, helperJournal: helpers,
    ...(lease === undefined ? {} : { lease }),
    turnHelperJournal: helpers, rawEvidence: evidence, rawContent: providerRawContentReader(evidence),
    clock: { now: () => new Date().toISOString() }, helperFactory: async () => { throw new Error('business execution is forbidden'); },
    templateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
    agentRoster: [{ agentId: 'intake', roleId: 'interaction', managementRole: options.snapshotActor ?? 'project-lead' }],
    prepareAgentProvider: async () => ({ roleId: 'interaction', configuredAgentId: 'intake', source: 'http', binding, port,
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'controlled', baseUrl } }),
    ...overrides,
  });
  const steps: ExplicitInteractionStepInput[] = [];
  const request: ExplicitBrainInterpretationInput & { readonly resumeTask?: (taskId: string) => Promise<unknown> } = {
    interactionId: 'c07-interaction', inputRevision: 1,
    sourceRef: 'test:c07', rawInput: '你好', clarifications: [], taskCandidates: [],
    onStep: (step: ExplicitInteractionStepInput) => { steps.push(step); },
    ...(options.readTaskResult === undefined ? {} : { readTaskResult: options.readTaskResult }),
    ...(options.resumeWriter === undefined ? {} : { resumeTask: options.resumeWriter }),
    ...(options.projectSnapshot === undefined ? {} : { readProjectSnapshot: options.projectSnapshot }) };
  const interpreter = createInterpreter();
  const append = helpers.appendSemanticCheckpoint.bind(helpers);
  if (options.coldAccepted) helpers.appendSemanticCheckpoint = async () => { throw new Error('controlled checkpoint write interruption'); };
  let result;
  if (options.failedDrain || options.failedDrains || (options.failSubmitAt && !options.interruptResume)) {
    await assert.rejects(() => interpreter.interpret(request));
    const opened = await parentJournal.readScopeOpenedTurns({ organId, interactionScopeId });
    const failed = await parentJournal.readTurnSnapshot(opened[0]!.fact.turn);
    assert.equal(failed.resourceClose?.fact.result.state, 'closed');
    assert.ok(failed.requests.some(entry => entry.fact.phase === 'failed'));
    assert.equal(failed.providerSettlements.length, 0, 'failed drain cannot publish successful settlement');
    assert.equal((await helpers.readScopeSemanticCheckpoints({ organId, interactionScopeId })).length, 0);
  } else if (options.coldAccepted) {
    await assert.rejects(() => interpreter.interpret(request), /controlled checkpoint write interruption/);
    helpers.appendSemanticCheckpoint = append;
  } else result = await interpreter.interpret(request);
  const cold = new JsonlInteractionParentTurnJournal(new JsonlOrganJournal(journalPath));
  const coldHelpers = new JsonlInteractionHelperJournal(new JsonlOrganJournal(journalPath));
  const recovered = createInterpreter({ parentJournal: cold, helperJournal: coldHelpers,
    checkpointJournal: coldHelpers, turnHelperJournal: coldHelpers });
  if (options.coldAccepted) result = await recovered.interpret(request);
  if (options.failedDrain || (options.failSubmitAt && !options.interruptResume)) result = await recovered.interpret(request);
  if (options.failedDrains) {
    const partial = await recovered.interpret(request);
    assert.equal(partial.kind, 'partial');
    if (partial.kind !== 'partial') throw new Error('expected cold partial');
    const resumeRequest = { ...request, resumePartialRef: partial.partialRef };
    const beforeInvalidResume = wires.length;
    await assert.rejects(() => recovered.interpret({ ...request, resumePartialRef: 'foreign-partial' }), /current partial recovery reference/);
    assert.equal(wires.length, beforeInvalidResume, 'wrong partial ref cannot start even a drain');
    for (let index = 1; index < options.failedDrains; index++) {
      await assert.rejects(() => createInterpreter({ parentJournal: cold }).interpret(resumeRequest));
      assert.deepEqual(await recovered.interpret(request), partial);
      assert.equal(await helpers.readSemanticCheckpointExact((await cold.readScopeOpenedTurns({ organId, interactionScopeId }))[0]!.fact.turn), null);
    }
    assert.deepEqual(await createInterpreter({ parentJournal: cold }).interpret(resumeRequest), partial,
      'drain completion still returns partial, never a successful decision');
    assert.equal(await helpers.readSemanticCheckpointExact((await cold.readScopeOpenedTurns({ organId, interactionScopeId }))[0]!.fact.turn), null);
    result = await createInterpreter({ parentJournal: cold }).interpret(resumeRequest);
  }
  if (options.coldPartial) assert.deepEqual(await recovered.interpret(request), result);
  if (options.resume) {
    if (result?.kind !== 'partial') throw new Error('expected partial before explicit resume');
    const resumeRequest = { ...request, resumePartialRef: result.partialRef };
    if (options.interruptResume) {
      await assert.rejects(() => recovered.interpret(resumeRequest), /controlled zero-fact first dispatch failure/);
      const failed = await cold.readTurnSnapshot((await cold.readScopeOpenedTurns({ organId, interactionScopeId }))[0]!.fact.turn);
      assert.equal(failed.resourceClose?.fact.execution.executionEpoch, 2);
    }
    result = await createInterpreter({ parentJournal: cold }).interpret(resumeRequest);
  }
  if (result === undefined) throw new Error('missing explicit result');
  if (options.failSubmitAt || options.failStartAt || options.failedDrains) {
    assert.equal((await helpers.readScopeSemanticCheckpoints({ organId, interactionScopeId })).length, 1);
  }
  const turns = await cold.readScopeOpenedTurns({ organId, interactionScopeId });
  assert.equal(turns.length, 1, 'all requests remain in the original turn');
  const snapshot = await cold.readTurnSnapshot(turns[0]!.fact.turn);
  const checkpoint = await helpers.readSemanticCheckpointExact(turns[0]!.fact.turn);
  if (options.failSubmitAt || options.failStartAt || options.failedDrains) {
    console.log(JSON.stringify({ endRecovery: { failSubmitAt: options.failSubmitAt, failStartAt: options.failStartAt,
      failedDrains: options.failedDrains, turnId: turns[0]!.fact.turn.turnId,
      epochs: snapshot.ownerReconciliations.map(entry => entry.fact.effectiveExecutionEpoch),
      endResults: snapshot.endControls?.map(entry => entry.fact).filter(f => f.kind === 'submission').map(f => f.result),
      modelRequests: wires.filter(w => w.tools !== undefined).length,
      drainRequests: wires.filter(w => w.tools === undefined).length,
      closeEpoch: snapshot.resourceClose?.fact.execution.executionEpoch,
      settlementEpoch: snapshot.providerSettlements.at(-1)?.fact.settlement.executionEpoch,
      checkpointCommitted: checkpoint !== null } }));
  }
  for (const wire of wires) {
    if (wire.tools === undefined) {
      assert.equal(wire.instructions?.includes('call humanagent_turn_end'), false);
      assert.equal(wire.instructions?.includes('Registered tools'), false);
      continue;
    }
    assert.equal(wire.instructions.includes('Dispatch a helper only'), false);
    assert.equal(wire.instructions.includes('read them only to match'), false);
    assert.deepEqual(wire.tools.map((tool: any) => tool.name).sort(),
      ['humanagent_turn_end', 'interaction_select_skills', ...(options.readTaskResult ? ['task_read_result'] : []),
        ...(options.projectSnapshot && options.snapshotActor !== 'ceo' ? ['project_snapshot'] : [])].sort());
    if (options.readTaskResult) {
      assert.deepEqual(wire.tools.find((tool: any) => tool.name === 'task_read_result').parameters,
        { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string', minLength: 1 } } });
    }
    if (options.projectSnapshot && options.snapshotActor !== 'ceo') {
      assert.deepEqual(wire.tools.find((tool: any) => tool.name === 'project_snapshot').parameters, {
        type: 'object', additionalProperties: false,
        properties: { members: { type: 'array', minItems: 1, uniqueItems: true,
          items: { type: 'string', minLength: 1 } } },
      });
    }
    assert.equal(wire.tools.some((tool: any) => /execute|dispatch|shell/.test(tool.name)), false);
  }
    return { result, wires, snapshot, checkpoint, steps };
  } finally {
    try { await port.close(binding); } finally {
      await lease?.release();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
      assert.equal(server.address(), null);
      await assert.rejects(() => stat(root), error => (error as { code?: string }).code === 'ENOENT');
      if (options.failSubmitAt || options.failStartAt || options.failedDrains) {
        console.log(JSON.stringify({ endRecoveryCleanup: { root, endpoint: baseUrl, serverClosed: true, fixtureRemoved: true, leaseReleased: true } }));
      }
    }
  }
}

test('rejected end survives a zero-fact continuation failure without resetting its rejection budget', async () => {
  for (const failSubmitAt of [1, 2]) {
  const { result, snapshot, checkpoint, wires } = await runWire([{}, {}, {}, answer], { failSubmitAt, resume: true });
  assert.equal(result.kind, 'answer');
  assert.ok(checkpoint);
  const submissions = snapshot.endControls?.map(entry => entry.fact).filter(f => f.kind === 'submission');
  assert.deepEqual(submissions?.map(f => f.result.kind), ['rejected', 'rejected', 'partial', 'accepted']);
  assert.deepEqual(submissions?.slice(0, 2).map(f => f.result.kind === 'rejected' && f.result.failedAttempt), [1, 2]);
  assert.equal(new Set(submissions?.slice(0, 3).map(f => f.attempt.attemptRef)).size, 1);
  assert.equal(wires.filter(w => w.tools !== undefined).length, 4);
  }
});

test('partial recovery binding survives its first dispatch failure in the original turn', async () => {
  const { result, snapshot, checkpoint, wires } = await runWire([{}, {}, {}, {}, answer], {
    resume: true, interruptResume: true, failStartAt: 2,
  });
  assert.equal(result.kind, 'answer');
  assert.ok(checkpoint);
  const submissions = snapshot.endControls?.map(entry => entry.fact).filter(f => f.kind === 'submission');
  assert.deepEqual(submissions?.map(f => f.result.kind), ['rejected', 'rejected', 'partial', 'rejected', 'accepted']);
  const reset = submissions?.[3]?.result;
  assert.equal(reset?.kind === 'rejected' && reset.failedAttempt, 1);
  assert.equal(wires.filter(w => w.tools !== undefined).length, 5);
  assert.ok(wires.at(-2).instructions.includes('上次结束校验失败记忆'));
});

test('partial failed text drain cold reads and repeated resumes only drain before the next correction', async () => {
  const { result, snapshot, checkpoint, wires } = await runWire([{}, {}, {}, answer], { failedDrains: 2 });
  assert.equal(result.kind, 'answer');
  assert.ok(checkpoint);
  assert.equal(wires.filter(w => w.tools !== undefined).length, 4);
  assert.equal(wires.filter(w => w.tools === undefined).length, 4);
  assert.deepEqual(snapshot.endControls?.map(entry => entry.fact).filter(f => f.kind === 'submission').map(f => f.result.kind),
    ['rejected', 'rejected', 'partial', 'accepted']);
  assert.equal(snapshot.providerSettlements.at(-1)?.fact.settlement.state, 'succeeded');
  assert.equal(snapshot.resourceClose?.fact.execution.executionEpoch, snapshot.providerSettlements.at(-1)?.fact.settlement.executionEpoch);
});

test('accepted end with a closed failed text drain recovers only transport in the same turn', async () => {
  let reads = 0;
  const { result, wires, checkpoint, snapshot } = await runWire([answer], {
    failedDrain: true,
    readTaskResult: async () => { reads++; return { publicationState: 'committed', units: 42, rows: 2 }; },
  });
  assert.equal(result.kind, 'answer');
  if (result.kind === 'answer') assert.match(result.answer, /42/);
  assert.equal(reads, 1, 'recovery never replays the committed result read');
  assert.equal(wires.filter(wire => wire.tools !== undefined).length, 2, 'read and end execute once');
  assert.equal(wires.filter(wire => wire.tools === undefined).length, 2, 'only failed drain is resumed');
  assert.ok(checkpoint);
  assert.equal(snapshot.endControls?.filter(entry => entry.fact.kind === 'submission' && entry.fact.result.kind === 'accepted').length, 1);
  assert.equal(snapshot.ownerReconciliations.at(-1)?.fact.mode, 'continue');
  assert.equal(snapshot.resourceClose?.fact.execution.executionEpoch, 2);
  assert.equal(snapshot.providerSettlements.at(-1)?.fact.settlement.executionEpoch, 2);
  assert.equal(snapshot.providerSettlements.at(-1)?.fact.settlement.state, 'succeeded');
  const resumed = wires.at(-1);
  assert.ok(resumed.input.some((entry: any) => entry.type === 'function_call_output' && /accepted/.test(entry.output)),
    'the resumed no-tools request consumes the original accepted end result');
});

// Live failure: completed execution was visible but the following explicit turn
// could not read its report. High impact on follow-up answers; reuses this small
// HTTP/Journal fixture, with no execution or external provider side effects.
test('published task result enters the real next wire and survives cold accepted-end recovery', async () => {
  let reads = 0;
  const publication = { taskId: 'published-parent', executionTaskId: 'published-child', status: 'succeeded',
    publication: { state: 'committed', commits: [{ text: 'units 42; rows 2; consistent', journalSeq: 9948 }] } };
  const { result, wires, checkpoint } = await runWire([answer], {
    coldAccepted: true,
    readTaskResult: async taskId => { assert.equal(taskId, 'published-parent'); reads++; return publication; },
  });
  assert.equal(result.kind, 'answer');
  if (result.kind !== 'answer') throw new Error('expected answer');
  assert.deepEqual(JSON.parse(result.answer), publication, 'answer must depend on the real paired tool output');
  assert.equal(reads, 1, 'cold recovery must reuse committed result, never reread a later publication');
  assert.equal(wires.length, 3);
  const pair = wires[1].input.filter((entry: any) => entry.call_id === 'call-0');
  assert.deepEqual(pair.map((entry: any) => entry.type), ['function_call', 'function_call_output']);
  assert.equal(JSON.stringify(wires[0].input).includes('units 42'), false);
  assert.equal(JSON.stringify(wires[0].input).includes('readTaskResult'), false);
  console.log(JSON.stringify({ pairedRead: pair, answer: result.answer, readerCallsAfterRecovery: reads }));
  assert.ok(checkpoint);
});

test('scoped task result reads pair direct and lineage scope results while foreign content stays outside the model wire', async () => {
  const cases = [
    { label: 'same-project direct', taskId: 'project-direct', code: undefined,
      value: { taskId: 'project-direct', title: 'direct result', executionTaskId: 'project-direct',
        publicationState: 'committed', marker: 'same-project-direct-content' } },
    { label: 'same-project lineage', taskId: 'project-lineage-parent', code: undefined,
      value: { taskId: 'project-lineage-parent', title: 'lineage result', executionTaskId: 'project-lineage-child',
        publicationState: 'committed', marker: 'same-project-lineage-content' } },
    { label: 'foreign project direct', taskId: 'foreign-direct', code: 'explicit-brain.task-outside-serve-scope',
      secret: 'foreign-direct-private-content' },
    { label: 'foreign project lineage', taskId: 'cross-board-parent', code: 'explicit-brain.task-outside-serve-scope',
      secret: 'cross-board-lineage-private-content' },
  ] as const;

  for (const scenario of cases) {
    const { result, wires } = await runWire([answer], {
      readArguments: { taskId: scenario.taskId },
      readTaskResult: async taskId => {
        assert.equal(taskId, scenario.taskId);
        if (scenario.code !== undefined) {
          throw new UiRuntimeApiError(scenario.code, 'humanagent.app', scenario.secret,
            'select a task from this conversation project', 403);
        }
        return scenario.value;
      },
      readReply: answer,
    });
    assert.equal(result.kind, 'answer', `${scenario.label} rejection cannot end the whole model turn`);
    assert.equal(wires.filter((wire: any) => wire.tools !== undefined).length, 2,
      `${scenario.label} tool result must enter a continued model request`);

    const pair = wires[1].input.filter((entry: any) => entry.call_id === 'call-0');
    assert.deepEqual(pair.map((entry: any) => entry.type), ['function_call', 'function_call_output']);
    assert.equal(pair[0].call_id, 'call-0');
    assert.equal(pair[1].call_id, 'call-0');
    assert.equal(pair[0].name, 'task_read_result');
    assert.deepEqual(JSON.parse(pair[0].arguments), { taskId: scenario.taskId });
    const output = JSON.parse(pair[1].output);
    if (scenario.code === undefined) {
      assert.deepEqual(output, scenario.value);
    } else {
      assert.equal(output.status, 'failed');
      assert.equal(output.code, scenario.code);
      assert.equal(output.callId, 'call-0');
      assert.equal(output.toolId, 'task.read_result');
      assert.equal(output.recoverable, true);
      assert.equal(JSON.stringify(output).includes(scenario.secret), false,
        `${scenario.label} must not expose out-of-scope content`);
      assert.equal(JSON.stringify(wires).includes(scenario.secret), false,
        `${scenario.label} must not leak the hidden foreign task through any wire`);
    }
  }
});

test('blocked task read keeps its original blocker in the paired public tool step', async () => {
  const blocker = {
    code: 'unknown.event',
    reason: 'unknown responses wire event type',
    nextStep: '确认外部变更结果后执行恢复或停止任务',
  };
  const publication = {
    taskId: 'published-parent',
    executionTaskId: 'published-child',
    title: '受阻原任务',
    status: 'blocked',
    publicationState: 'committed',
    resultAvailable: false,
    blocker,
  };
  const { result, wires, steps } = await runWire([answer], {
    readTaskResult: async taskId => {
      assert.equal(taskId, 'published-parent');
      return publication;
    },
    readReply: answer,
  });
  assert.equal(result.kind, 'answer');
  if (result.kind !== 'answer') throw new Error('expected answer');
  assert.equal(result.answer, answer.decision.answer, 'the model answer omits the task blocker');
  assert.deepEqual(JSON.parse(wires[1].input.find((entry: any) =>
    entry.type === 'function_call_output' && entry.call_id === 'call-0').output), publication);
  const step = steps.find(candidate => candidate.kind === 'tool.finished'
    && candidate.tool?.kind === 'read-task-result'
    && candidate.tool.callId === 'call-0');
  if (step?.turnId === undefined || step.requestId === undefined || step.tool?.detail?.kind !== 'task-result') {
    throw new Error('the exact task read did not reach its model request and public tool step');
  }
  assert.ok(step.turnId.length > 0);
  assert.ok(step.requestId.length > 0);
  assert.deepEqual(step.tool.detail.blocker, blocker);
});

test('ordinary explicit wire neither advertises nor invokes a resume writer', async () => {
  let resumes = 0;
  const { result, wires } = await runWire([answer], {
    resumeWriter: async () => {
      resumes += 1;
      return { continuation: 'released' };
    },
  });
  assert.equal(result.kind, 'answer');
  assert.equal(resumes, 0);
  assert.equal(wires.filter((wire: any) => wire.tools !== undefined).length, 1);
  assert.equal(wires.filter((wire: any) => wire.tools === undefined).length, 1);
  assert.equal(wires[0].tools.some((tool: any) => tool.name === 'task_resume'), false);
  assert.equal(/task\.resume|needsRecoveryConfirmation=true/.test(wires[0].instructions), false);
});

test('explicit result read pairs correctable argument and missing-task errors then continues the same turn', async () => {
  for (const readArguments of [{ path: '/etc/passwd' }, { taskId: 'published-parent', projectKey: 'foreign' }, { taskId: '' }, { taskId: 'missing' }]) {
    let reads = 0;
    const { wires, checkpoint } = await runWire([answer], { readArguments, correctRead: true,
      readTaskResult: async taskId => {
        reads++;
        if (taskId === 'missing') throw new RuntimeTaskControlError('task.not.found', 'humanagent.runtime', 'no such task', 'select a current task');
        return { publicationState: 'committed', text: 'units 42; rows 2' };
      } });
    assert.equal(reads, 'taskId' in readArguments && readArguments.taskId === 'missing' ? 2 : 1);
    const pair = wires[1].input.filter((entry: any) => entry.call_id === 'call-0');
    assert.deepEqual(pair.map((entry: any) => entry.type), ['function_call', 'function_call_output']);
    const failure = JSON.parse(pair[1].output);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.callId, 'call-0');
    assert.equal(failure.recoverable, true);
    assert.match(failure.code, /task.read_result.(invalid-arguments|task-not-found)/);
    const corrected = wires[2].input.find((entry: any) => entry.call_id === 'call-1' && entry.type === 'function_call_output');
    assert.match(corrected.output, /units 42/);
    assert.ok(checkpoint);
  }
});

test('explicit result read preserves publication failures instead of making them correctable', async () => {
  await assert.rejects(() => runWire([answer], {
    readTaskResult: async () => { throw new Error('controlled publication read failure'); },
  }), /controlled publication read failure/);
});

test('Manager snapshot is absent without a reader and follows the real selected Skill wire with its reader', async () => {
  const withoutReader = await runWire([answer]);
  const wrongActor = await runWire([answer], { snapshotActor: 'ceo',
    projectSnapshot: async () => { throw new Error('CEO must not use the project Manager reader'); } });
  for (const wire of [...withoutReader.wires, ...wrongActor.wires].filter(wire => wire.tools !== undefined)) {
    assert.equal(wire.tools.some((tool: any) => tool.name === 'project_snapshot'), false);
  }

  const full = { roster: [{ agentRef: 'Alice', role: 'manager' }], boards: { Alice: [{ taskId: 't1', state: 'working' }] },
    sessions: { Alice: { state: 'present', generation: 3 } }, gaps: [] };
  const batch = { roster: [{ agentRef: 'Alice' }, { agentRef: 'Bob' }], boards: {},
    sessions: {}, gaps: [{ member: 'Bob', source: 'runtime', state: 'unknown' }] };
  const reads: (readonly string[] | undefined)[] = [];
  const { result, wires, checkpoint, steps } = await runWire([answer], {
    skills: ['project-management'],
    projectSnapshot: async members => { reads.push(members); return reads.length === 1 ? full : batch; },
    projectSnapshotCalls: [{}, { members: ['Alice', 'Bob'] }],
  });

  assert.equal(result.kind, 'answer');
  assert.ok(checkpoint);
  assert.deepEqual(reads, [undefined, ['Alice', 'Bob']]);
  assert.deepEqual(wires[0].tools.map((tool: any) => tool.name).sort(),
    ['humanagent_turn_end', 'interaction_select_skills', 'project_snapshot']);
  assert.match(wires[0].instructions, /# Project leader/);
  assert.match(wires[1].instructions, /Selected Skill: project-management/);
  assert.match(wires[1].instructions, /project\.snapshot\(\{\}\)/,
    'the selected Skill text must come from the registered template loader');
  assert.equal(JSON.stringify(wires[0].input).includes('readProjectSnapshot'), false,
    'the host reader is authority, not business input');

  const firstPair = wires[2].input.filter((entry: any) => entry.call_id === 'call-1');
  assert.deepEqual(firstPair.map((entry: any) => entry.type), ['function_call', 'function_call_output']);
  assert.deepEqual(JSON.parse(firstPair[1].output), full);
  const secondPair = wires[3].input.filter((entry: any) => entry.call_id === 'call-2');
  assert.deepEqual(secondPair.map((entry: any) => entry.type), ['function_call', 'function_call_output']);
  assert.deepEqual(JSON.parse(secondPair[1].output), batch);
  for (const callId of ['call-1', 'call-2']) {
    const activities = steps.filter(step => step.tool?.callId === callId);
    assert.deepEqual(activities.map(step => [step.kind, step.tool?.kind]), [
      ['tool.started', 'project-snapshot'], ['tool.finished', 'project-snapshot'],
    ]);
    assert.ok(activities[0]?.requestId);
    assert.equal(activities[0]?.requestId, activities[1]?.requestId);
    assert.equal(activities[1]?.tool?.status, 'succeeded');
  }
});

test('project snapshot rejects unauthorized or invalid arguments and allows correction in the same turn', async () => {
  const invalid = [
    { project: 'foreign' },
    { members: ['Alice'], path: '/tmp/foreign' },
    { members: [''] },
    { members: ['Alice', 'Alice'] },
    { members: ['Unavailable'] },
  ];
  let reads = 0;
  const { result, wires, checkpoint } = await runWire([answer], {
    projectSnapshot: async members => {
      reads++;
      if (members?.[0] === 'Unavailable') throw new UiRuntimeApiError(
        'project.snapshot.member-unavailable', 'humanagent.app', 'member unavailable', 'choose an available member', 404);
      assert.deepEqual(members, ['Alice', 'Bob']);
      return { roster: [{ agentRef: 'Alice' }, { agentRef: 'Bob' }], gaps: [] };
    },
    projectSnapshotCalls: [...invalid, { members: ['Alice', 'Bob'] }],
  });

  assert.equal(reads, 2);
  assert.equal(result.kind, 'answer');
  assert.ok(checkpoint);
  for (let index = 0; index < invalid.length; index++) {
    const pair = wires[index + 1].input.filter((entry: any) => entry.call_id === `call-${index}`);
    assert.deepEqual(pair.map((entry: any) => entry.type), ['function_call', 'function_call_output']);
    const failure = JSON.parse(pair[1].output);
    assert.equal(failure.status, 'failed');
    assert.equal(failure.callId, `call-${index}`);
    assert.equal(failure.code, index === invalid.length - 1
      ? 'project.snapshot.member-unavailable' : 'project.snapshot.invalid-arguments');
    assert.equal(failure.recoverable, true);
    assert.deepEqual(failure.nextAction, { kind: 'continue', ref: 'project.snapshot' });
  }
  const corrected = wires[invalid.length + 1].input.find((entry: any) =>
    entry.call_id === `call-${invalid.length}` && entry.type === 'function_call_output');
  assert.match(corrected.output, /Alice/);
  assert.match(corrected.output, /Bob/);
});

test('Manager can submit a task decision without reading the optional project snapshot', async () => {
  const { result, checkpoint } = await runWire([requirement], {
    projectSnapshot: async () => { throw new Error('no snapshot read is needed for this decision'); },
    projectSnapshotCalls: [],
  });
  assert.equal(result.kind, 'requirement');
  assert.ok(checkpoint);
});

test('C07 actual wire accepts a simple end and ignores transport drain text', async () => {
  const { result, wires, snapshot, checkpoint } = await runWire([answer]);
  assert.equal(result.kind, 'answer');
  assert.equal(wires.length, 2);
  assert.equal(wires[1].tools, undefined);
  assert.equal(snapshot.endControls?.at(-1)?.fact.kind, 'submission');
  assert.ok(checkpoint);
});

test('C07 actual wire corrects twice and accepts the third end with paired error history', async () => {
  const { result, wires, checkpoint } = await runWire([{ kind: 'simple' }, { kind: 'complex' }, answer]);
  assert.equal(result.kind, 'answer');
  assert.equal(wires.length, 4);
  for (let index = 1; index < 3; index++) {
    const outputs = wires[index].input.filter((entry: any) => entry.type === 'function_call_output');
    assert.equal(JSON.parse(outputs.at(-1).output).kind, 'rejected');
    assert.equal(JSON.parse(outputs.at(-1).output).failedAttempt, index);
  }
  assert.ok(checkpoint);
});

test('C07 counts malformed arguments before a corrected end in the same response', async () => {
  const { result, wires, snapshot, checkpoint } = await runWire([{}], { malformed: [0], correctedEndAt: 0 });
  assert.equal(result.kind, 'answer');
  assert.equal(wires.length, 2);
  const outcomes = snapshot.endControls?.map(entry => entry.fact).filter(fact => fact.kind === 'submission');
  assert.deepEqual(outcomes?.map(fact => [fact.callId, fact.result.kind]), [['call-0', 'rejected'], ['call-corrected', 'accepted']]);
  const outputs = wires[1].input.filter((entry: any) => entry.type === 'function_call_output');
  assert.deepEqual(outputs.map((entry: any) => entry.call_id), ['call-0', 'call-corrected']);
  assert.equal(JSON.parse(outputs[0].output.split('\n', 1)[0]).code, 'tool.arguments.invalid-json');
  assert.equal(JSON.parse(outputs[1].output).kind, 'accepted');
  assert.ok(checkpoint);
});

test('C07 keeps partial when a valid end follows the third malformed call in the same response', async () => {
  const { result, wires, snapshot, checkpoint } = await runWire([{}, {}, {}], { malformed: [0, 1, 2], correctedEndAt: 2 });
  assert.equal(result.kind, 'partial');
  const outcomes = snapshot.endControls?.map(entry => entry.fact).filter(fact => fact.kind === 'submission');
  assert.deepEqual(outcomes?.map(fact => fact.result.kind), ['rejected', 'rejected', 'partial']);
  const outputs = wires.at(-1).input.filter((entry: any) => entry.type === 'function_call_output');
  assert.equal(outputs.at(-1).call_id, 'call-corrected');
  assert.equal(JSON.parse(outputs.at(-1).output).code, 'explicit.end.already-concluded');
  assert.equal(checkpoint, null);
});

test('C07 actual wire rejects invalid matchedTaskId values before acceptance and corrects in the same turn', async () => {
  const invalid = [
    { ...requirement, decision: { ...requirement.decision, matchedTaskId: '' } },
    { ...requirement, decision: { ...requirement.decision, matchedTaskId: 'ui-task-existing' } },
  ];
  for (const invalidRequirement of invalid) {
    const { result, wires, snapshot, checkpoint } = await runWire([invalidRequirement, requirement]);
    assert.equal(result.kind, 'requirement');
    assert.equal(wires.length, 3, 'the corrected end continues in the original turn before transport drain');
    const rejected = JSON.parse(wires[1].input.find((entry: any) =>
      entry.type === 'function_call_output' && entry.call_id === 'call-0').output);
    assert.equal(rejected.kind, 'rejected');
    assert.equal(rejected.failedAttempt, 1);
    assert.match(rejected.errors[0].path, /matched-task-id/);
    const submissions = snapshot.endControls?.map(entry => entry.fact)
      .filter(entry => entry.kind === 'submission');
    assert.deepEqual(submissions?.map(entry => entry.result.kind), ['rejected', 'accepted']);
    const accepted = submissions?.at(-1);
    const acceptedDecision = accepted?.kind === 'submission' && accepted.result.kind === 'accepted'
      ? accepted.result.decision : undefined;
    if (acceptedDecision?.kind !== 'requirement') throw new Error('unexpected accepted decision');
    assert.equal(acceptedDecision.matchedTaskId, undefined);
    assert.ok(checkpoint);
  }
});

test('C07 actual wire returns durable typed partial on the third bad end without checkpoint', async () => {
  const { result, wires, snapshot, checkpoint } = await runWire([{}, {}, {}]);
  if (result.kind !== 'partial') throw new Error('expected typed partial');
  assert.equal(wires.length, 4);
  assert.equal(checkpoint, null);
  const last = snapshot.endControls?.at(-1)?.fact;
  if (last?.kind !== 'submission') throw new Error('missing durable end submission');
  assert.deepEqual(last.result, result);
});

test('C07 actual wire Skill selection precedes the complex end and executes no business task', async () => {
  const { result, wires, checkpoint, steps } = await runWire([requirement], { skills: true });
  assert.equal(result.kind, 'requirement');
  assert.equal(wires.length, 3);
  const stableSections = ['# Explicit Brain', '# Mission', '# Boundaries', '# Input and Output',
    '# Failure Handling', '# Registered tools', '# Explicit end-tool protocol', '# Registered Skills'];
  for (const { instructions } of wires.slice(0, 2)) {
    const positions = stableSections.map(section => instructions.indexOf(section));
    assert.ok(positions.every(at => at >= 0));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
    assert.equal(instructions.split('# Failure Handling').length - 1, 1);
  }
  assert.equal(/# Selected Skill|# Task handoff/.test(wires[0].instructions), false);
  assert.match(wires[1].instructions, /Selected Skill: task-intake/);
  assert.match(wires[1].instructions, /# Skill rule reference: rules\/requirement-template\.md\s+# Task handoff/);
  assert.equal(/# Follow through on an existing task/.test(wires[1].instructions), false);
  assert.equal(wires[2].tools, undefined);
  assert.equal(/# Mission|# Registered Skills|# Task handoff/.test(wires[2].instructions ?? ''), false);
  assert.ok(checkpoint);
  const tools = steps.filter(step => step.kind.startsWith('tool.'));
  assert.equal(tools.length, 4);
  assert.deepEqual(tools.map(step => step.kind), ['tool.started', 'tool.finished', 'tool.started', 'tool.finished']);
  assert.equal(tools[0]!.requestId, tools[1]!.requestId);
  assert.equal(tools[2]!.requestId, tools[3]!.requestId);
  assert.deepEqual(tools.map(step => step.tool), [
    { callId: 'call-0', kind: 'select-skills' },
    { callId: 'call-0', kind: 'select-skills', status: 'succeeded', detail: { kind: 'skills', skills: ['task-intake'] } },
    { callId: 'call-1', kind: 'submit-turn' },
    { callId: 'call-1', kind: 'submit-turn', status: 'succeeded', detail: { kind: 'decision', decision: 'create', title: '报告' } },
  ]);
  assert.equal(/整理报告|Selected Skill|blockingGaps|skillIds/.test(JSON.stringify(tools)), false);
});

test('C07 loads follow-through guidance independently of the intake template', async () => {
  const { wires, steps } = await runWire([answer], { skills: ['task-follow-through'] });
  assert.equal(wires[0].instructions.includes('# Follow through on an existing task'), false);
  assert.match(wires[1].instructions, /# Selected Skill: task-follow-through/);
  assert.match(wires[1].instructions, /# Follow through on an existing task/);
  assert.equal(wires[1].instructions.includes('# Task handoff'), false);
  assert.deepEqual(steps.find(step => step.kind === 'tool.finished' && step.tool?.kind === 'select-skills')?.tool?.detail,
    { kind: 'skills', skills: ['task-follow-through'] });
});

test('C07 actual wire text-only decision needs a real end and does not consume a format attempt', async () => {
  const { result, wires, snapshot, checkpoint } = await runWire([answer.decision, answer], { textFirst: true });
  assert.equal(result.kind, 'answer');
  assert.equal(wires.length, 3);
  assert.equal(snapshot.endControls?.filter(entry => entry.fact.kind === 'submission').length, 1);
  assert.ok(checkpoint);
});

test('C07 actual wire malformed JSON counts its real call and accepts a third corrected end', async () => {
  const { result, wires, snapshot, checkpoint } = await runWire([{}, {}, answer], { malformed: [0, 1] });
  assert.equal(result.kind, 'answer');
  assert.equal(wires.length, 4);
  const submissions = snapshot.endControls?.map(entry => entry.fact).filter(entry => entry.kind === 'submission');
  assert.deepEqual(submissions?.map(entry => entry.result.kind), ['rejected', 'rejected', 'accepted']);
  assert.ok(checkpoint);
});

test('C07 actual wire three malformed JSON calls return partial and drain without tools', async () => {
  const { result, wires, checkpoint } = await runWire([{}, {}, {}], { malformed: [0, 1, 2] });
  assert.equal(result.kind, 'partial');
  assert.equal(wires.length, 4);
  assert.equal(wires[3].tools, undefined);
  assert.equal(checkpoint, null);
});

test('C07 cold accepted end reads the durable decision without replaying the model', async () => {
  const { result, wires, checkpoint } = await runWire([requirement], { coldAccepted: true });
  assert.equal(result.kind, 'requirement');
  assert.equal(wires.length, 2);
  assert.ok(checkpoint);
});

test('C07 cold partial read returns the same receipt without another provider request', async () => {
  const { result, wires, checkpoint } = await runWire([{}, {}, {}], { coldPartial: true });
  assert.equal(result.kind, 'partial');
  assert.equal(wires.length, 4);
  assert.equal(checkpoint, null);
});

test('C07 partial resumes the same interaction in a new epoch with failure memory', async () => {
  const { result, wires, snapshot, checkpoint } = await runWire([{}, {}, {}, answer], { resume: true });
  assert.equal(result.kind, 'answer');
  assert.equal(wires.length, 6);
  assert.match(wires[4].instructions, /上次结束校验失败记忆/);
  assert.equal(snapshot.ownerReconciliations.at(-1)?.fact.effectiveExecutionEpoch, 2);
  assert.ok(checkpoint);
});

test('explicit task title normalization collapses whitespace and caps at 50 Unicode characters', () => {
  assert.equal(normalizeTaskTitle('  alpha\n\tbeta  '), 'alpha beta');
  const fortyNineAndEmoji = '任'.repeat(49) + '🙂';
  assert.equal(normalizeTaskTitle(fortyNineAndEmoji), fortyNineAndEmoji);
  assert.equal(normalizeTaskTitle('任'.repeat(50) + '🙂'), '任'.repeat(50));
  assert.throws(() => normalizeTaskTitle('   '), /non-empty/);
});

test('C07 actual wire normalizes an overlong model title at interpretation without truncating content', async () => {
  const longTitle = '  任'.repeat(30) + '\n尾🙂';
  const body = '完整需求正文必须保留'.repeat(20);
  const longRequirement = {
    ...requirement,
    decision: {
      ...requirement.decision,
      normalizedInput: body,
      proposal: {
        ...requirement.decision.proposal,
        title: longTitle,
        objective: body,
        deliverable: body,
      },
    },
  };
  const { result, snapshot, wires } = await runWire([longRequirement]);
  assert.equal(result.kind, 'requirement');
  if (result.kind !== 'requirement') throw new Error('expected requirement interpretation');
  const expectedTitle = Array.from(longTitle.replace(/\s+/gu, ' ').trim()).slice(0, 50).join('');
  assert.equal(result.structuredProposal.title, expectedTitle);
  assert.equal(Array.from(result.structuredProposal.title).length, 50);
  assert.equal(result.structuredProposal.objective, body, 'objective is not truncated');
  assert.equal(result.structuredProposal.deliverable, body, 'deliverable is not truncated');
  assert.ok(result.normalizedInput.includes(body), 'full request text stays in normalizedInput');
  assert.ok(snapshot.endControls?.some((entry) => entry.fact.kind === 'submission'
    && entry.fact.result.kind === 'accepted'), 'accepted end remains a real durable receipt');
  const endTool = wires[0].tools.find((tool: any) => tool.name === 'humanagent_turn_end');
  const titleSchema = endTool.parameters.properties.decision.properties.proposal.properties.title;
  assert.equal(titleSchema.type, 'string');
  assert.equal(titleSchema.minLength, 1);
  assert.equal(titleSchema.maxLength, undefined, 'schema does not reject an overlong model title');
  assert.match(titleSchema.description, /at most 50 characters/);
  assert.match(wires[0].instructions, /at most 50 characters/);
  assert.match(wires[0].instructions,
    /another Topic or Project.*preserve the original interaction, task and Topic/);
});
