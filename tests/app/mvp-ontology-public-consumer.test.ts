import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ProviderBinding } from '../../packages/contracts/src/index.js';
import { FakeReplayExecutionRuntimePort, startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { MemoryCoordinator } from '../../packages/runtime/src/memory/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';

const organId = id('organ', 'organ-mvp-ontology-http');
const binding: ProviderBinding = {
  bindingId: 'binding-mvp-ontology-http',
  providerId: 'fake',
  protocol: 'other-explicit',
  endpointRef: 'fake://mvp-ontology-http',
  modelRef: 'fake-model',
  configDigest: 'sha256:mvp-ontology-http-config',
  capabilityDigest: 'sha256:mvp-ontology-http-cap',
};

test('ui-runtime HTTP endpoints enforce 8-slot implicit concurrency, roster pool, dual-prompt copy, canonical addressing, and role dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-mvp-ontology-http-'));
  await mkdir(join(root, 'checkpoints'), { recursive: true });
  await mkdir(join(root, 'evidence'), { recursive: true });
  await mkdir(join(root, 'security'), { recursive: true, mode: 0o700 });
  await chmod(join(root, 'security'), 0o700);

  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  });
  const challenge = await accessControl.issuePairingChallenge();
  const session = await accessControl.consumePairingCode(challenge.code);

  const runtime = await startUiRuntime({
    mode: 'fake',
    productRoot: root,
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1, replay: [] }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages', 'ui', 'static'),
    projectKey: 'projA',
    workspaceRoot: root,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: 'projA',
      roleId: 'execution',
    },
    accessControl,
    explicitBrainInterpreter: { interpret: async () => { throw new Error('unused'); } },
  });

  try {
    const baseUrl = runtime.server.url;
    const headers = {
      'content-type': 'application/json',
      cookie: accessControl.sessionCookie(session).split(';')[0]!,
    };

    // 1. Implicit orchestration concurrency defaults to 8 and updates live
    const initialConcurrency = await fetch(`${baseUrl}/api/settings/concurrency`, { headers });
    assert.equal(initialConcurrency.status, 200);
    assert.deepEqual(await initialConcurrency.json(), { implicitOrchestrationMaxRuntimes: 8 });

    const updatedConcurrency = await fetch(`${baseUrl}/api/settings/concurrency`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ implicitOrchestrationMaxRuntimes: 12 }),
    });
    assert.equal(updatedConcurrency.status, 200);
    assert.deepEqual(await updatedConcurrency.json(), { implicitOrchestrationMaxRuntimes: 12 });

    const invalidConcurrency = await fetch(`${baseUrl}/api/settings/concurrency`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ implicitOrchestrationMaxRuntimes: 0 }),
    });
    assert.equal(invalidConcurrency.status, 400);

    // 2. Members start with Jenny; adding copies dual prompts from 50-name pool and rejects duplicates
    const initialMembers = await fetch(`${baseUrl}/api/product/members`, { headers });
    assert.equal(initialMembers.status, 200);
    const membersBody = await initialMembers.json() as { machine: string; project: string; members: Array<{ name: string; role: string }> };
    assert.equal(membersBody.project, 'projA');
    assert.equal(membersBody.members[0]?.name, 'Jenny');
    assert.equal(membersBody.members[0]?.role, 'manager');

    const created = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        template: { role: 'reviewer', systemPrompt: 'sys-1', rolePrompt: 'rev-1', provider: 'rcc', model: 'gpt-5' },
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { member: { name: string; role: string; systemPrompt: string; rolePrompt: string } };
    assert.equal(createdBody.member.name, 'Alice');
    assert.equal(createdBody.member.role, 'reviewer');
    assert.equal(createdBody.member.systemPrompt, 'sys-1');
    assert.equal(createdBody.member.rolePrompt, 'rev-1');

    const duplicateMember = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Alice',
        template: { role: 'executor', systemPrompt: 'sys-2', rolePrompt: 'exec-2' },
      }),
    });
    assert.equal(duplicateMember.status, 409);

    // 3. Canonical addressing resolves Alex, project Jenny, and project.member; rejects missing
    const alex = await fetch(`${baseUrl}/api/product/address/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: 'Alex' }),
    });
    assert.equal(alex.status, 200);
    assert.equal((await alex.json() as { resolved: { canonicalAddress: string } }).resolved.canonicalAddress, 'local.CEO');

    const aliceAddr = await fetch(`${baseUrl}/api/product/address/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: 'projA.Alice' }),
    });
    assert.equal(aliceAddr.status, 200);
    assert.equal((await aliceAddr.json() as { resolved: { canonicalAddress: string } }).resolved.canonicalAddress, 'local.projA.Alice');

    // 4. Role dispatch matches reviewer Alice, falls back to Jenny for tester, rejects missing explicitTarget
    const matchedDispatch = await fetch(`${baseUrl}/api/product/dispatch/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ role: 'reviewer' }),
    });
    assert.equal(matchedDispatch.status, 200);
    assert.equal((await matchedDispatch.json() as { target: { name: string }; reason: string }).target.name, 'Alice');

    const fallbackDispatch = await fetch(`${baseUrl}/api/product/dispatch/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ role: 'tester' }),
    });
    assert.equal(fallbackDispatch.status, 200);
    const fallbackBody = await fallbackDispatch.json() as { target: { name: string }; reason: string };
    assert.equal(fallbackBody.target.name, 'Jenny');
    assert.equal(fallbackBody.reason, 'jenny-fallback');

    const missingDispatch = await fetch(`${baseUrl}/api/product/dispatch/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ explicitTarget: 'projA.Ghost' }),
    });
    assert.equal(missingDispatch.status, 404);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
