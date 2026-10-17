import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { id, type ActiveTurnBinding, type ProviderBinding } from '../../packages/contracts/src/index.js';
import { resolveRuntimePaths } from '../../packages/config/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { createJsonlActiveTurnJournal } from '../../packages/adapters/jsonl/src/active-turn.js';
import { JsonlTaskIdentityJournal } from '../../packages/adapters/jsonl/src/task-identities.js';
import { activeTurnCommitId } from '../../packages/runtime/src/context/active-turn-journal.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import { UiRuntimeService, buildFakeExecutionPort } from '../../packages/app/src/ui-runtime/index.js';
import { createUiRuntimeRequestDispatcher } from '../../packages/app/src/ui-runtime/server.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import { UiRuntimeJournal, uiRuntimeJournalPath, uiRuntimeControlJournalPath, uiRuntimeModeRoot } from '../../packages/app/src/ui-runtime/journal.js';
import type { RuntimeAgentActivityProjection, RuntimeReadResult } from '../../packages/ui/contracts/runtime.js';

// Known missing HTTP edge; likelihood unknown. Impact: missing catalog, lost
// exact selection or cold/live scope confusion. One temporary public consumer
// covers the connected request sequence without executing a Task or Provider.
test('agent activity public HTTP preserves exact selection, cold scope and read-only ownership', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-agent-http-');
  let server: ReturnType<typeof createServer> | undefined;
  let listening = false;
  try {
    const workspace = join(root, 'workspace');
    const coldWorkspace = join(root, 'cold-workspace');
    await mkdir(workspace);
    await mkdir(coldWorkspace);
    const paths = await resolveRuntimePaths({ workspace, controlRoot: join(root, 'control') });
    const coldPaths = await resolveRuntimePaths({ workspace: coldWorkspace, controlRoot: join(root, 'control') });
    const organId = id('organ', 'http-organ');
    const taskId = id('task', 'http-task');
    const operationId = id('operation', 'http-operation');
    const cycleId = id('cycle', 'http-cycle');
    const scope = { organId, taskId, operationId, cycleId };
    const boundTurnId = 'http-turn';
    const boundRuntimeId = 'http-runtime';
    const boundAssignmentId = 'http-assignment';
    const boundObjective = 'observe this exact assignment';
    const coldTurnId = 'http-cold-turn';
    const coldRuntimeId = 'http-cold-runtime';
    const coldAssignmentId = 'http-cold-assignment';
    const coldObjective = 'observe this cold assignment';
    const fixtures = [
      { source: paths, turnId: boundTurnId, runtimeId: boundRuntimeId, assignmentId: boundAssignmentId,
        objective: boundObjective, inputRef: 'task://http-task/input', targetRef: 'task://http-task',
        expectedOutputRef: 'task://http-task/output', title: 'HTTP fixture' },
      { source: coldPaths, turnId: coldTurnId, runtimeId: coldRuntimeId, assignmentId: coldAssignmentId,
        objective: coldObjective, inputRef: 'task://http-task/cold/input', targetRef: 'task://http-task/cold',
        expectedOutputRef: 'task://http-task/cold/output', title: 'Cold HTTP fixture' },
    ];
    const activeBindingFor = (fixture: typeof fixtures[number]): ActiveTurnBinding => ({
      scope, execution: { runtimeId: fixture.runtimeId, executionEpoch: 1 },
      assignment: {
        assignmentId: fixture.assignmentId, taskId, pipelineNodeId: 'http-node', attempt: 1,
        executionEpoch: 1, inputRevision: 1, objective: fixture.objective,
        targetRefs: [fixture.targetRef], expectedOutputRefs: [fixture.expectedOutputRef],
        acceptanceCriteriaDigest: 'sha256:http-fixture', successCriteria: ['read only'],
        failureCriteria: ['mutation'], incompleteCriteria: ['missing facts'],
        requiredCapabilities: [], mergeGate: 'not-required',
      },
      admittedTurn: {
        turnId: fixture.turnId, workAssignmentRef: fixture.assignmentId, taskRef: taskId, scopeRef: scope,
        cycleRef: cycleId, inputRevision: 1, directiveRevision: 1, executionEpoch: 1,
        runtimeBindingRef: fixture.runtimeId, permissionRevision: 'http-permission', admissionEvidenceRefs: [],
        currentTurnRef: `active-turn://${fixture.turnId}`, recoveryStateRef: `recovery://${fixture.turnId}`,
      },
    });
    const journalPaths: string[] = [];
    for (const fixture of fixtures) {
      const taskPath = uiRuntimeJournalPath(fixture.source.checkpointsRoot, 'fake');
      const journal = new UiRuntimeJournal(taskPath);
      journal.append({ kind: 'task.created', taskId, title: fixture.title,
        directive: fixture.objective, directiveRevision: 1,
        createdAt: '2026-10-16T00:00:00.000Z', taskCounter: 1 });
      journal.append({ kind: 'operation.prepared', allocation: {
        runtimeId: fixture.runtimeId, taskId, operationId, executionEpoch: 1, assignmentId: fixture.assignmentId, scope,
        inputRefs: [fixture.inputRef], ownerId: 'http-fixture', directiveRevision: 1, inputRevision: 1, orchestrated: false,
      }, input: fixture.objective, operationCounter: 1, cycleCounter: 1 });
      const controlPath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(fixture.source.checkpointsRoot, 'fake'));
      const control = new JsonlOrganJournal(controlPath);
      await new JsonlTaskIdentityJournal(control).append({ scope: { organId, taskId }, source: {
        requirementId: 'http-requirement', inputRevision: 1,
        draftId: 'http-draft', draftRevisionVersion: 1, draftRevisionHash: 'sha256:http-fixture',
        confirmationRef: 'http-confirmation',
      } });
      const activeBinding = activeBindingFor(fixture);
      await createJsonlActiveTurnJournal({ journal: control, turnId: fixture.turnId }).append({
        commitId: activeTurnCommitId(fixture.turnId, 'binding-opened'),
        record: { kind: 'binding-opened', binding: activeBinding,
          currentTurnRef: activeBinding.admittedTurn.currentTurnRef },
      });
      journalPaths.push(taskPath, controlPath);
    }
    const accessControl = await AccessControlService.open({ credentialPath: paths.webAccessCredentialPath, create: true });
    const challenge = accessControl.createPairingChallenge('http-fixture', 1);
    const session = await accessControl.consumePairingCode(challenge.code);
    const binding: ProviderBinding = { bindingId: 'http-binding', providerId: 'http-provider',
      protocol: 'responses', endpointRef: 'fake://http', modelRef: 'fake',
      configDigest: 'sha256:http-fixture', capabilityDigest: 'sha256:http-fixture' };
    const journal = new UiRuntimeJournal(uiRuntimeJournalPath(paths.checkpointsRoot, 'fake'));
    const forbidden = (): never => { throw new Error('GET must not execute side effects'); };
    const service = new UiRuntimeService({ mode: 'fake', organId, binding,
      port: buildFakeExecutionPort(binding), journal, closurePort: journal,
      checkpointStoreFor: forbidden, attentionPort: { publish: forbidden, resolve: forbidden },
      providerState: 'ready',
      now: () => new Date('2026-10-16T00:01:00.000Z'),
      runtimeComposition: { createTaskAssembly: forbidden },
      i2History: { journal: createJsonlI2JournalPort({
        filePath: uiRuntimeControlJournalPath(uiRuntimeModeRoot(paths.checkpointsRoot, 'fake')),
      }) },
      projectKey: paths.projectKey, workspaceRoot: workspace, runtimePaths: paths,
      projectCatalog: async () => ({ projects: [paths, coldPaths], failures: [] }),
      explicitBrainInterpreter: { interpret: async () => { throw new Error('GET must not interpret'); } },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(),
        projectKey: paths.projectKey, roleId: 'execution' },
    });
    const { listener } = createUiRuntimeRequestDispatcher({ service, accessControl,
      uiRoot: join(process.cwd(), 'docs/ui'), isClosing: () => false });
    const taskView = () => JSON.stringify(service.taskDashboard(taskId));
    const before = { task: taskView(), journals: await Promise.all(journalPaths.map((path) => readFile(path, 'utf8'))) };
    server = createServer(listener);
    const httpServer = server;
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { listening = true; resolve(); });
    });
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('HTTP consumer did not bind a socket');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const get = async (query = '') => {
      const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId.value)}/dashboard${query}`, {
        headers: { cookie: accessControl.sessionCookie(session).split(';')[0]! },
      });
      const payload = await response.text();
      assert.equal(response.status, 200, payload);
      return JSON.parse(payload) as { agentActivity: RuntimeReadResult<RuntimeAgentActivityProjection> };
    };
    const catalog = (await get()).agentActivity;
    assert.ok(catalog, 'dashboard must expose the activity reader');
    assert.equal(catalog.ok, true, JSON.stringify(catalog));
    if (!catalog.ok) throw new Error('catalog unavailable');
    assert.equal(catalog.value.mode, 'catalog');
    const catalogEntries = [...catalog.value.current, ...catalog.value.historical, ...catalog.value.unknown];
    assert.ok(catalogEntries.some((entry) => entry.instance.kind === 'native-execution'
      && entry.instance.runtimeId === boundRuntimeId && entry.assignmentId === boundAssignmentId
      && entry.objective === boundObjective), JSON.stringify(catalog));
    assert.equal(catalogEntries.some((entry) => entry.instance.runtimeId === coldRuntimeId
      || entry.assignmentId === coldAssignmentId || entry.objective === coldObjective), false,
    'bound catalog must not include cold facts');
    const selected = (await get(`?agentKind=native-execution&agentRuntimeId=${boundRuntimeId}&agentExecutionEpoch=1&agentAssignmentId=${boundAssignmentId}`)).agentActivity;
    assert.equal(selected.ok, true, JSON.stringify(selected));
    if (!selected.ok) throw new Error('selection unavailable');
    assert.equal(selected.value.mode, 'selected');
    assert.ok(selected.value.selected!.length > 0);
    assert.ok(selected.value.selected!.every((entry) => entry.instance.kind === 'native-execution'
      && entry.instance.runtimeId === boundRuntimeId && entry.executionEpoch === 1 && entry.assignmentId === boundAssignmentId));
    for (const query of ['?agentUnknown=x', '?agentKind=native-execution']) {
      const invalid = (await get(query)).agentActivity;
      assert.equal(invalid.ok, false);
      if (!invalid.ok) assert.equal(invalid.failure.code, 'agent-activity.invalid-selection');
    }
    const cold = (await get(`?projectKey=${coldPaths.projectKey}&mode=fake`)).agentActivity;
    assert.equal(cold.ok, true, JSON.stringify(cold));
    if (!cold.ok) throw new Error('cold catalog unavailable');
    assert.deepEqual(cold.value.current, []);
    assert.ok(cold.value.unavailableSources.length > 0);
    const coldEntries = [...cold.value.current, ...cold.value.historical, ...cold.value.unknown];
    assert.ok(coldEntries.some((entry) => entry.instance.kind === 'native-execution'
      && entry.instance.runtimeId === coldRuntimeId && entry.assignmentId === coldAssignmentId
      && entry.objective === coldObjective), JSON.stringify(cold));
    assert.equal(coldEntries.some((entry) => entry.instance.runtimeId === boundRuntimeId
      || entry.assignmentId === boundAssignmentId || entry.objective === boundObjective), false,
    'cold catalog must not include bound facts');
    assert.deepEqual({ task: taskView(), journals: await Promise.all(journalPaths.map((path) => readFile(path, 'utf8'))) }, before);
  } finally {
    const httpServer = server;
    if (httpServer !== undefined && listening) {
      httpServer.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
