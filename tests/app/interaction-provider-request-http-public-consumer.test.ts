import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type AnyProviderExecutionIdentityRef, type ProviderExecutionIdentityRef } from '../../packages/contracts/src/index.js';
import type { AgentRole, EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { createAgentProviderPort, prepareAgentProvider, prepareExecutionAgentProvider } from '../../packages/app/src/agent-driver-composition.js';
import { startUiRuntime, type UiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { acquireDaemonLease } from '../../packages/app/src/supervisor/index.js';

test('public interaction request read resolves the exact no-Task request and rejects foreign identities', async () => {
  const base = process.env.HUMANAGENT_TEST_ROOT ?? join(homedir(), '.humanagent', 'test-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'interaction-request-http-'));
  let runtime: UiRuntime | undefined;
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace });
  await ensureControlLayout(paths);
  const lease = await acquireDaemonLease(paths, { ownerId: 'interaction-request-http' });
  const { createServer } = await import('node:http');
  let providerRequests = 0;
  const provider = await new Promise<{ server: import('node:http').Server; url: string }>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) void _chunk;
      const round = providerRequests++;
      assert.ok(round < 3, 'the fixture must finish after Skill selection, end submission and drain');
      const tool = round === 0 ? {
        type: 'function_call', call_id: 'http-select-skills', name: 'interaction_select_skills',
        arguments: JSON.stringify({ skillIds: ['task-intake'] }),
      } : {
        type: 'function_call', call_id: 'http-explicit-end', name: 'humanagent_turn_end',
        arguments: JSON.stringify({ kind: 'simple', decision: {
          kind: 'answer', normalizedInput: 'hello', knownFacts: [], answer: 'hello from provider', decisionRefs: [],
        }, checkpointRecord: { index: { action: '回答问候', result: '已回答' } } }),
      };
      const frames = [
        { type: 'response.created', response: { id: `http-wire-response-${round}` } },
        ...(round === 2 ? [] : [{ type: 'response.output_item.done', output_index: 0, item: tool }]),
        { type: 'response.completed', response: { id: `http-wire-response-${round}` } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('provider did not bind'));
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
  try {
    const bindings: EffectiveAgentProviderBinding[] = [{ agentId: 'interaction-read', roleId: 'interaction', source: 'agent',
      provider: { source: 'http', provider: 'http', binding: 'interaction-read', protocol: 'responses', model: 'test-model', route: 'test-route', baseUrl: provider.url } }];
    const evidenceRoot = join(paths.artifactsRoot, 'ui-provider-evidence');
    const prepare = async <T extends AnyProviderExecutionIdentityRef = ProviderExecutionIdentityRef>(selection: { roleId: AgentRole; configuredAgentId?: string }) => prepareAgentProvider<T>({ ...selection, agentProviderBindings: bindings, evidenceRoot });
    const launch = await prepare({ roleId: 'interaction' });
    const access = await AccessControlService.open({ credentialPath: join(root, 'security/web-access.json'), create: true });
    const challenge = await access.issuePairingChallenge();
    const session = await access.consumePairingCode(challenge.code);
    const cookie = access.sessionCookie(session).split(';')[0]!;
    runtime = await startUiRuntime({ mode: 'rcc', organId: id('organ', 'interaction-request-http'), binding: launch.binding,
      port: launch.port, providerSource: launch.source, productRoot: paths.controlRoot,
      checkpointRoot: join(paths.checkpointsRoot, 'ui-runtime'), evidenceRoot, interactionRoot: paths.mainRoot,
      workspaceRoot: paths.workspaceCwd, projectKey: paths.projectKey, uiRoot: join(process.cwd(), 'packages/ui/static'),
      portNumber: 0, accessControl: access, explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
      lease: () => lease, runtimePaths: paths,
      runtimeComposition: { prepareAgentProvider: prepare, prepareTaskAgentProvider: (selection, owner, taskLease) => prepareExecutionAgentProvider({
        roleId: selection.roleId, ...(selection.configuredAgentId === undefined ? {} : { agentId: selection.configuredAgentId }),
        agentProviderBindings: bindings, createPort: (selected) => createAgentProviderPort(selected, evidenceRoot),
      }, owner, taskLease) },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(), projectKey: paths.projectKey },
    });
    await runtime.service.quiesceImplicitConsumption();
    const post = await fetch(`${runtime.server.url}/api/explicit/inputs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: runtime.server.url },
      body: JSON.stringify({ sourceRef: 'ui:request-observation', rawInput: 'hello', channel: 'business' }) });
    assert.equal(post.status, 201);
    const input = await post.json() as { interactionId: string };
    const interpret = await fetch(`${runtime.server.url}/api/explicit/interactions/${input.interactionId}/interpret`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: runtime.server.url }, body: '{}' });
    assert.equal(interpret.status, 200);
    assert.equal(providerRequests, 3);
    const rawJournal = await import('../../packages/adapters/jsonl/src/index.js');
    const journalPaths = await import('../../packages/app/src/ui-runtime/journal.js');
    const control = new rawJournal.JsonlOrganJournal(journalPaths.uiRuntimeControlJournalPath(journalPaths.uiRuntimeModeRoot(paths.checkpointsRoot, 'rcc')));
    const records = await control.replay();
    const turns = records.map((record) => record.kind === 'event' ? record.payload as { kind?: string; discriminant?: string; turn?: { interactionId?: string; inputRevision?: number; turnId?: string }; execution?: { executionEpoch?: number }; record?: { request?: { requestId?: string } } } : undefined)
      .filter((entry) => entry?.kind === 'interaction-parent.turn-raw.v1' && entry.discriminant === 'request' && entry.turn?.interactionId === input.interactionId);
    const identity = turns[0]!;
    const url = `${runtime.server.url}/api/explicit/interactions/${input.interactionId}/revisions/${identity.turn!.inputRevision}/turns/${identity.turn!.turnId}/epochs/${identity.execution!.executionEpoch}/requests/${identity.record!.request!.requestId}?projectKey=${encodeURIComponent(paths.projectKey)}&mode=rcc`;
    const read = await fetch(url, { headers: { cookie } });
    const readText = await read.text();
    assert.equal(read.status, 200, readText);
    const result = JSON.parse(readText) as { scope: { kind: string; interactionId: string }; content: unknown[]; evidenceRefs: { evidenceId: { value: string } }[] };
    assert.equal(result.scope.kind, 'interaction');
    assert.equal(result.scope.interactionId, input.interactionId);
    assert.ok(result.content.length > 0);
    assert.ok(result.evidenceRefs.length > 0);
    const wireReceipt = result.content.find((entry) => entry !== null && typeof entry === 'object' && 'requestReceipt' in entry) as { requestReceipt?: { body?: string }; model?: string } | undefined;
    if (wireReceipt?.requestReceipt?.body === undefined) throw new Error('the read must retain the exact serialized request body');
    const wireBody = JSON.parse(wireReceipt.requestReceipt.body) as { model?: string; input?: unknown };
    assert.equal(wireBody.model, 'test-model');
    assert.match(JSON.stringify(wireBody.input), /hello/);
    const selectedRef = result.evidenceRefs[0]!.evidenceId.value;
    const selected = await fetch(url + '&evidenceId=' + encodeURIComponent(selectedRef), { headers: { cookie } });
    const selectedText = await selected.text();
    assert.equal(selected.status, 200, selectedText);
    assert.deepEqual((JSON.parse(selectedText) as { evidenceRefs: { evidenceId: { value: string } }[] }).evidenceRefs.map((ref) => ref.evidenceId.value), [selectedRef]);
    const epoch = identity.execution!.executionEpoch!;
    const wrongEpoch = await fetch(url.replace(`/epochs/${epoch}/`, `/epochs/${epoch + 1}/`), { headers: { cookie } });
    const wrongEpochText = await wrongEpoch.text();
    assert.equal(wrongEpoch.status, 409, wrongEpochText);
    assert.match(wrongEpochText, /epoch-mismatch/);
    assert.equal(wrongEpochText.includes('http-wire-response') || wrongEpochText.includes('hello'), false);
    const foreign = await fetch(url.replace(`/requests/${identity.record!.request!.requestId}`, '/requests/not-this-request'), { headers: { cookie } });
    assert.equal(foreign.status, 409);
    const wrongEvidence = await fetch(url + '&evidenceId=not-attached', { headers: { cookie } });
    assert.equal(wrongEvidence.status, 409);
    const wrongTurn = await fetch(url.replace(`/revisions/${identity.turn!.inputRevision}`, '/revisions/999'), { headers: { cookie } });
    assert.equal(wrongTurn.status, 409);
    assert.equal(records.filter((record) => record.kind === 'event' && record.payload !== null && typeof record.payload === 'object' && (record.payload as { kind?: string }).kind === 'task.created').length, 0);
  } finally {
    await runtime?.close();
    await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    await lease.release();
    await rm(root, { recursive: true, force: true });
  }
});
