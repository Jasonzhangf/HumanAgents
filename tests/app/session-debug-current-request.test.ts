import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createProviderExplicitBrainInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import { id, type InteractionParentProviderExecutionIdentityRef, type ProviderBinding } from '../../packages/contracts/src/index.js';
import {
  ProviderAdapter,
  ResponsesProviderCodec,
  V3ProviderHttpTransport,
  filesystemProviderEvidenceSink,
} from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { uiRuntimeControlJournalPath } from '../../packages/app/src/ui-runtime/journal.js';
import type { AgentProviderComposition } from '../../packages/app/src/agent-driver-composition.js';

type Wire = {
  readonly input?: readonly {
    readonly type?: string;
    readonly role?: string;
    readonly call_id?: string;
    readonly name?: string;
    readonly arguments?: string;
    readonly output?: string;
    readonly content?: readonly { readonly text?: string }[];
  }[];
};

test('product session debug reads the current request and stays closed by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-session-debug-'));
  const firstMarker = `debug-session-${randomUUID()}`;
  const secondMarker = `debug-next-${randomUUID()}`;
  const wires: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'controlled' }], status: 'ok' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    wires.push(body);
    const wire = JSON.parse(body) as Wire;
    const drained = wire.input?.some((item) => item.type === 'function_call_output' && item.call_id === 'session-debug-end') === true;
    const userText = wire.input
      ?.filter((item) => item.type === 'message' && item.role === 'user')
      .flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? '')
      .join('') ?? '';
    let rawInput = '';
    try {
      rawInput = (JSON.parse(userText) as { readonly rawInput?: string }).rawInput ?? userText;
    } catch {
      rawInput = userText;
    }
    const marker = rawInput.includes(secondMarker) ? secondMarker : firstMarker;
    const responseId = `session-debug-${wires.length}`;
    const output = drained
      ? { type: 'response.output_text.done', item_id: 'drain', text: 'transport drained after the accepted end call' }
      : {
        type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', id: `end-${wires.length}`, call_id: 'session-debug-end',
          name: 'humanagent_turn_end', arguments: JSON.stringify({
            kind: 'simple',
            decision: {
              kind: 'answer', normalizedInput: rawInput, knownFacts: [], decisionRefs: [],
              answer: `answered ${marker}`,
            },
            checkpointRecord: { index: { action: `record ${marker}`, result: 'answered' } },
          }),
        },
      };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { type: 'response.created', response: { id: responseId } },
      output,
      { type: 'response.completed', response: { id: responseId, model: 'controlled',
        usage: { input_tokens: drained ? 200 : 100, output_tokens: 15,
          input_tokens_details: { cached_tokens: drained ? 100 : 0 } } } },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing controlled Provider address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let runtime: Awaited<ReturnType<typeof startUiRuntime>> | undefined;
  try {
    const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: process.cwd() });
    await ensureControlLayout(paths);
    const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(paths.artifactsRoot, 'ui-provider-evidence')));
    const binding: ProviderBinding = {
      bindingId: 'binding-session-debug', providerId: 'provider-session-debug', protocol: 'responses',
      endpointRef: baseUrl, modelRef: 'model-session-debug', configDigest: 'test:session-debug-config',
      capabilityDigest: 'test:session-debug-capability',
    };
    const port = new ProviderAdapter<InteractionParentProviderExecutionIdentityRef>({
      binding, routeRef: 'session-debug', codec: new ResponsesProviderCodec(),
      transport: new V3ProviderHttpTransport({ binding, baseUrl, source: 'http', evidence }), evidence,
    });
    const journalPath = uiRuntimeControlJournalPath(join(paths.checkpointsRoot, 'rcc'));
    const organJournal = new JsonlOrganJournal(journalPath);
    const parentJournal = new JsonlInteractionParentTurnJournal(organJournal);
    const helperJournal = new JsonlInteractionHelperJournal(organJournal);
    const organId = id('organ', 'session-debug');
    const interactionScopeId = `runtime:${paths.projectKey}`;
    const composition = {
      roleId: 'interaction' as const, source: 'http' as const,
      provider: {
        source: 'http' as const, provider: 'http', binding: binding.bindingId, protocol: 'responses' as const,
        model: binding.modelRef, route: 'session-debug', baseUrl,
      }, binding, port,
    } as unknown as AgentProviderComposition<InteractionParentProviderExecutionIdentityRef>;
    const interpreter = createProviderExplicitBrainInterpreter({
      organId, interactionScopeId, binding, parentJournal,
      checkpointJournal: helperJournal, helperJournal, turnHelperJournal: helperJournal,
      rawEvidence: evidence, rawContent: providerRawContentReader(evidence),
      clock: { now: () => new Date().toISOString() },
      helperFactory: async () => { throw new Error('business helper execution is forbidden'); },
      templateRoot: join(process.cwd(), 'packages', 'agent-templates', 'templates'),
      prepareAgentProvider: async () => composition,
    });
    const accessControl = await AccessControlService.open({
      credentialPath: join(paths.securityRoot, 'web-access.json'), create: true,
    });
    (accessControl as unknown as {
      startCredentialWatch: AccessControlService['startCredentialWatch'];
    }).startCredentialWatch = () => () => Promise.resolve(false);
    runtime = await startUiRuntime({
      mode: 'rcc', organId, binding, port: port as unknown as Parameters<typeof startUiRuntime>[0]['port'],
      productRoot: paths.controlRoot, checkpointRoot: paths.checkpointsRoot, evidenceRoot: paths.artifactsRoot,
      uiRoot: join(process.cwd(), 'docs', 'ui'), portNumber: 0, runtimePaths: paths,
      projectKey: paths.projectKey, workspaceRoot: paths.workspaceCwd, accessControl,
      explicitBrainInterpreter: interpreter,
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: paths.projectKey },
      runtimeComposition: {
        prepareAgentProvider: async () => composition,
        prepareTaskAgentProvider: async () => { throw new Error('this intake must not prepare a Task'); },
      } as unknown as Parameters<typeof startUiRuntime>[0]['runtimeComposition'],
    });
    const session = await accessControl.consumePairingCode((await accessControl.issuePairingChallenge()).code);
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const origin = runtime.server.url;
    const receive = async (rawInput: string): Promise<string> => {
      const response = await fetch(`${origin}/api/explicit/inputs`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'business', sourceRef: `ui:${rawInput}`, rawInput }),
      });
      const text = await response.text();
      assert.equal(response.status, 201, text);
      return (JSON.parse(text) as { readonly interactionId: string }).interactionId;
    };
    const interpret = async (interactionId: string): Promise<void> => {
      const response = await fetch(`${origin}/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}',
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.equal((JSON.parse(text) as { readonly state?: string }).state, 'answered');
    };

    const first = await receive(`use the debug tool and report ${firstMarker}`);
    await interpret(first);
    assert.equal(wires.length, 2, 'the accepted tool result must be sent on the immediately following request');
    const continuation = JSON.parse(wires[1]!) as Wire;
    const call = continuation.input?.find((item) => item.type === 'function_call' && item.call_id === 'session-debug-end');
    const result = continuation.input?.find((item) => item.type === 'function_call_output' && item.call_id === 'session-debug-end');
    assert.ok(call, 'the following request must retain the tool call');
    assert.ok(result, 'the following request must retain the tool result');
    if (call === undefined || result === undefined) throw new Error('controlled tool pair is incomplete');
    assert.equal(JSON.parse(call.arguments!).checkpointRecord.index.action, `record ${firstMarker}`);
    assert.equal((JSON.parse(result.output!) as { readonly interactionId?: string }).interactionId, first);

    const debugResponse = await fetch(`${origin}/api/product/session?projectKey=${encodeURIComponent(paths.projectKey)}&mode=rcc&sessionId=${encodeURIComponent(first)}&debug=request`, {
      headers: { cookie, origin },
    });
    const debugText = await debugResponse.text();
    assert.equal(debugResponse.status, 200, debugText);
    const debugPayload = JSON.parse(debugText) as {
      readonly debug?: { readonly request?: { readonly ok?: boolean; readonly value?: { readonly content?: readonly { readonly requestReceipt?: { readonly body?: string } }[] } } };
    };
    assert.ok(debugPayload.debug?.request?.ok, debugText);
    const actualRequest = debugPayload.debug?.request?.value?.content?.[0]?.requestReceipt?.body;
    assert.ok(actualRequest);
    assert.deepEqual(JSON.parse(actualRequest!), JSON.parse(wires[1]!));
    const firstTurn = (await parentJournal.readScopeOpenedTurns({ organId, interactionScopeId: `runtime:${paths.projectKey}` }))
      .find(({ fact }) => fact.turn.interactionId === first);
    assert.ok(firstTurn);
    const firstTurnId = firstTurn?.fact.turn.turnId;
    assert.ok(firstTurnId);
    assert.ok(await helperJournal.readSemanticCheckpointExact({
      organId, interactionScopeId, interactionId: first, inputRevision: 1, turnId: firstTurnId!,
    }), 'the completed round must publish one checkpoint');

    const normalResponse = await fetch(`${origin}/api/product/session?projectKey=${encodeURIComponent(paths.projectKey)}&mode=rcc&sessionId=${encodeURIComponent(first)}`, {
      headers: { cookie, origin },
    });
    const normalText = await normalResponse.text();
    assert.equal(normalResponse.status, 200, normalText);
    assert.equal('debug' in JSON.parse(normalText), false, 'debug is closed when the parameter is omitted');
    const { usage } = JSON.parse(normalText);
    assert.deepEqual(usage.calls.map((call: { inputTokens: number }) => call.inputTokens), [100, 200]);
    assert.equal(usage.calls[0].currentCallCacheHitRate, 0);
    assert.equal(usage.calls[1].currentCallCacheHitRate, 0.5);
    assert.equal(usage.calls[1].previousCallCacheHitRate, 0);
    assert.equal(usage.calls[1].taskCacheHitRate, 100 / 300);
    console.log('ordinary session GET', normalResponse.status, JSON.stringify(usage));
    const invalid = await fetch(`${origin}/api/product/session?projectKey=${encodeURIComponent(paths.projectKey)}&mode=rcc&sessionId=${encodeURIComponent(first)}&debug=off`, {
      headers: { cookie, origin },
    });
    assert.equal(invalid.status, 400);

    const second = await receive(`continue from the checkpoint with ${secondMarker}`);
    await interpret(second);
    assert.equal(wires.length, 4, 'each round sends its end call and then the paired result');
    const nextRound = JSON.parse(wires[2]!) as Wire;
    const history = nextRound.input?.[0];
    assert.equal(history?.type, 'message');
    assert.equal(history?.role, 'assistant');
    const checkpoint = JSON.parse(history?.content?.[0]?.text ?? '{}') as {
      readonly interactionId?: string; readonly turnId?: string;
    };
    assert.equal(checkpoint.interactionId, first);
    assert.equal(checkpoint.turnId, firstTurnId);
    const nextUser = nextRound.input?.find((item) => item.type === 'message' && item.role === 'user');
    assert.match(nextUser?.content?.[0]?.text ?? '', new RegExp(secondMarker));
    assert.equal(nextRound.input?.some((item) => item.type === 'function_call' || item.type === 'function_call_output'), false,
      'the completed round enters the next request as checkpoint history, not as a duplicate live tool record');
  } finally {
    await runtime?.close();
    server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(root, { recursive: true, force: true });
  }
});
