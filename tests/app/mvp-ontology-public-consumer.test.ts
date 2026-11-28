import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { id, type ProviderBinding } from '../../packages/contracts/src/index.js';
import { FakeReplayExecutionRuntimePort, startUiRuntime } from '../../packages/app/src/ui-runtime/index.js';
import { createFileControlDomainRosterStore } from '../../packages/app/src/ui-runtime/control-domain-roster-store.js';
import { ensureControlLayout, resolveRuntimePaths } from '../../packages/config/src/index.js';
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
  const controlRoot = join(root, 'control');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const paths = await resolveRuntimePaths({ controlRoot, workspace: workspaceRoot });
  await ensureControlLayout(paths);
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

  const projectKey = 'projA';
  const runtimeOptions = {
    mode: 'fake' as const,
    productRoot: root,
    controlStateRoot: root,
    maxConcurrentTasks: 1,
    agentRoster: [
      { agentId: 'Alex', roleId: 'interaction' as const, managementRole: 'ceo' as const },
      { agentId: 'interaction-default', roleId: 'interaction' as const, managementRole: 'project-lead' as const },
      { agentId: 'review-default', roleId: 'review' as const },
    ],
    organId,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1, replay: [] }),
    checkpointRoot: join(root, 'checkpoints'),
    evidenceRoot: join(root, 'evidence'),
    uiRoot: join(process.cwd(), 'packages', 'ui', 'static'),
    runtimePaths: paths,
    projectCatalog: async () => ({
      projects: [
        {
          projectKey: 'projA',
          workspaceCwd: workspaceRoot,
          projectRoot: root,
          checkpointsRoot: join(root, 'checkpoints'),
        },
        {
          projectKey: 'projB',
          workspaceCwd: workspaceRoot,
          projectRoot: root,
          checkpointsRoot: join(root, 'checkpoints'),
        },
      ],
      failures: [],
    }),
    projectKey,
    workspaceRoot,
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey,
      roleId: 'execution',
    },
    accessControl,
    explicitBrainInterpreter: { interpret: async () => { throw new Error('unused'); } },
  };
  let runtime = await startUiRuntime(runtimeOptions);

  try {
    let baseUrl = runtime.server.url;
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
    const membersBody = await initialMembers.json() as { machine: string; project: string; members: Array<{ memberId: string; name: string; role: string }> };
    assert.equal(membersBody.project, 'projA');
    assert.equal(membersBody.members[0]?.name, 'Jenny');
    assert.equal(membersBody.members[0]?.role, 'manager');
    const jennyId = membersBody.members[0]!.memberId;

    const created = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        template: { role: 'reviewer', systemPrompt: 'sys-1', rolePrompt: 'rev-1', provider: 'rcc', model: 'gpt-5' },
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { member: { memberId: string; name: string; role: string; systemPrompt: string; rolePrompt: string } };
    assert.equal(createdBody.member.name, 'Alice');
    assert.equal(createdBody.member.role, 'reviewer');
    assert.equal(createdBody.member.systemPrompt, 'sys-1');
    assert.equal(createdBody.member.rolePrompt, 'rev-1');

    // Add second member using built-in role template preset (Bob)
    const createdBob = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ role: 'executor' }),
    });
    assert.equal(createdBob.status, 201);
    const createdBobBody = await createdBob.json() as { member: { memberId: string; name: string; role: string; systemPrompt: string } };
    assert.equal(createdBobBody.member.name, 'Bob');
    assert.equal(createdBobBody.member.role, 'executor');

    // Edit Alice independently; Bob stays unchanged and Jenny role cannot be edited or removed
    const patchedAlice = await fetch(`${baseUrl}/api/product/members/${encodeURIComponent(createdBody.member.memberId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ systemPrompt: 'sys-alice-edited', model: 'gpt-6.1' }),
    });
    assert.equal(patchedAlice.status, 200);
    const patchedAliceBody = await patchedAlice.json() as { member: { systemPrompt: string; model?: string } };
    assert.equal(patchedAliceBody.member.systemPrompt, 'sys-alice-edited');
    assert.equal(patchedAliceBody.member.model, 'gpt-6.1');

    const jennyEditRejected = await fetch(`${baseUrl}/api/product/members/${encodeURIComponent(jennyId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ role: 'executor' }),
    });
    assert.equal(jennyEditRejected.status, 409);

    const jennyDeleteRejected = await fetch(`${baseUrl}/api/product/members/${encodeURIComponent(jennyId)}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(jennyDeleteRejected.status, 409);

    // Removing Bob frees Bob back into the 50-name pool
    const deleteBob = await fetch(`${baseUrl}/api/product/members/${encodeURIComponent(createdBobBody.member.memberId)}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(deleteBob.status, 200);
    const reAdded = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ role: 'architect' }),
    });
    assert.equal(reAdded.status, 201);
    const reAddedBody = await reAdded.json() as { member: { name: string; role: string } };
    assert.equal(reAddedBody.member.name, 'Bob');
    assert.equal(reAddedBody.member.role, 'architect');

    const duplicateMember = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Alice',
        template: { role: 'executor', systemPrompt: 'sys-2', rolePrompt: 'exec-2' },
      }),
    });
    assert.equal(duplicateMember.status, 409);

    // Reject reserved CEO/Alex names, manager creation bypass, and duplicate memberIds
    const badManagerRole = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ template: { role: 'manager', systemPrompt: 'sys', rolePrompt: 'role' } }),
    });
    assert.equal(badManagerRole.status, 409);

    const reservedCeoName = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'CEO', role: 'executor' }),
    });
    assert.equal(reservedCeoName.status, 400);

    const dupMemberId = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ memberId: createdBody.member.memberId, name: 'Carol', role: 'executor' }),
    });
    assert.equal(dupMemberId.status, 409);

    // Shared 50-name pool across projects: projB allocates Carol without colliding on Alice/Bob
    const projBCreated = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectKey: 'projB', role: 'executor' }),
    });
    assert.equal(projBCreated.status, 201);
    const projBBody = await projBCreated.json() as { member: { name: string } };
    assert.equal(projBBody.member.name, 'Carol');

    // Configured agentRoster member visible in projectRoster also resolves via address resolver
    const configuredAddr = await fetch(`${baseUrl}/api/product/address/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: 'projA.review-default' }),
    });
    assert.equal(configuredAddr.status, 200);
    assert.equal(
      (await configuredAddr.json() as { resolved: { canonicalAddress: string } }).resolved.canonicalAddress,
      'local.projA.review-default',
    );

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

    // 5. GET /api/projects/roster reflects dynamic persisted members first then configured members, and never leaks configured agents to projB
    const rosterRes = await fetch(`${baseUrl}/api/projects/roster?projectKey=projA`, { headers });
    assert.equal(rosterRes.status, 200);
    const rosterBody = await rosterRes.json() as { members: Array<{ memberName: string; canonicalAddress: string }> };
    assert.deepEqual(
      rosterBody.members.map((m) => ({ name: m.memberName, addr: m.canonicalAddress })),
      [
        { name: 'Jenny', addr: 'local.projA.Jenny' },
        { name: 'Alice', addr: 'local.projA.Alice' },
        { name: 'Bob', addr: 'local.projA.Bob' },
        { name: 'review-default', addr: 'local.projA.review-default' },
      ],
    );

    const dupExplicitCrossProj = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectKey: 'projB', role: 'executor', name: 'Bob' }),
    });
    assert.equal(dupExplicitCrossProj.status, 409);

    const dupConfiguredName = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectKey: 'projA', role: 'executor', name: 'review-default' }),
    });
    assert.equal(dupConfiguredName.status, 409);

    const badRoleType = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectKey: 'projA',
        template: { role: 123, systemPrompt: 's', rolePrompt: 'r' },
      }),
    });
    assert.equal(badRoleType.status, 400);

    const badNameType = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectKey: 'projA', role: 'executor', name: 123 }),
    });
    assert.equal(badNameType.status, 400);

    const blankPostPrompt = await fetch(`${baseUrl}/api/product/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectKey: 'projA',
        template: { role: 'executor', systemPrompt: '   ', rolePrompt: 'valid' },
      }),
    });
    assert.equal(blankPostPrompt.status, 400);

    const badPatchRole = await fetch(`${baseUrl}/api/product/members/${encodeURIComponent(createdBody.member.memberId)}?projectKey=projA`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ role: 123 }),
    });
    assert.equal(badPatchRole.status, 400);

    const projBRosterRes = await fetch(`${baseUrl}/api/projects/roster?projectKey=projB`, { headers });
    assert.equal(projBRosterRes.status, 200);
    const projBRosterBody = await projBRosterRes.json() as { members: Array<{ memberName: string }> };
    assert.deepEqual(
      projBRosterBody.members.map((m) => m.memberName),
      ['Jenny', 'Carol'],
    );

    // 6. Verify concurrency update overrides legacy maxConcurrentTasks=1 during admission
    const runtimeAdmissionLimit = (runtime.service as unknown as {
      effectiveExecutionConcurrencyLimit(): number | undefined;
    }).effectiveExecutionConcurrencyLimit();
    assert.equal(runtimeAdmissionLimit, 12);

    // 7. Second independent runtime on projB sharing controlStateRoot sees Alice/Bob/Carol without clobbering projA, propagates concurrency live without reading settings
    let observedCallbackLimit: number | undefined;
    const secondRuntime = await startUiRuntime({
      ...runtimeOptions,
      listen: false,
      projectKey: 'projB',
      onImplicitOrchestrationLimitChange: (limit) => {
        observedCallbackLimit = limit;
      },
      port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1, replay: [] }),
    });
    try {
      const projBMember = secondRuntime.service.addProjectMember({ projectKey: 'projB', role: 'specialist' });
      assert.equal(projBMember.name, 'David');
      assert.deepEqual(
        runtime.service.listProjectMembers('projA').members.map((m) => m.name),
        ['Jenny', 'Alice', 'Bob'],
      );
      secondRuntime.service.setImplicitOrchestrationLimit(9);
      assert.equal(observedCallbackLimit, 9);
      assert.equal(
        (runtime.service as unknown as { effectiveExecutionConcurrencyLimit(): number | undefined }).effectiveExecutionConcurrencyLimit(),
        9,
      );
      // Restore 12 for cold-restart assertion below
      secondRuntime.service.setImplicitOrchestrationLimit(12);
    } finally {
      await secondRuntime.close();
    }

    // 6. Cold restart hydrates concurrency setting and persisted project members durably
    await runtime.close();
    runtime = await startUiRuntime({
      ...runtimeOptions,
      port: new FakeReplayExecutionRuntimePort({ binding, stepDelayMs: 1, replay: [] }),
    });
    baseUrl = runtime.server.url;
    const coldConcurrency = await fetch(`${baseUrl}/api/settings/concurrency`, { headers });
    assert.equal(coldConcurrency.status, 200);
    assert.deepEqual(await coldConcurrency.json(), { implicitOrchestrationMaxRuntimes: 12 });

    const coldMembers = await fetch(`${baseUrl}/api/product/members`, { headers });
    assert.equal(coldMembers.status, 200);
    const coldMembersBody = await coldMembers.json() as { members: Array<{ name: string; systemPrompt: string }> };
    assert.deepEqual(
      coldMembersBody.members.map((m) => m.name),
      ['Jenny', 'Alice', 'Bob'],
    );
    assert.equal(coldMembersBody.members[1]?.systemPrompt, 'sys-alice-edited');

    // 8. Corrupt control-domain-roster.json fails loudly without wiping stored projects
    const storePath = join(root, 'control-domain-roster.json');
    const savedBefore = await readFile(storePath, 'utf8');
    await writeFile(storePath, '{not-valid-json', 'utf8');
    const fileStore = createFileControlDomainRosterStore(root);
    assert.throws(() => fileStore.readSnapshot());
    assert.throws(() => fileStore.update((draft) => {
      (draft as { implicitOrchestrationMaxRuntimes?: number }).implicitOrchestrationMaxRuntimes = 3;
    }));
    await writeFile(storePath, savedBefore, 'utf8');
    assert.equal(fileStore.readSnapshot().projects.projA?.length, 3);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
