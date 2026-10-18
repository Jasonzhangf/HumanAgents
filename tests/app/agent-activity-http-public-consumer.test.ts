import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { id, type ActiveTurnBinding, type ProviderBinding } from '../../packages/contracts/src/index.js';
import { ensureControlLayout, listConfiguredProjects, resolveRuntimePaths } from '../../packages/config/src/index.js';
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
import { FileCheckpointStore, UiRuntimeJournal, uiRuntimeJournalPath, uiRuntimeControlJournalPath, uiRuntimeModeRoot } from '../../packages/app/src/ui-runtime/journal.js';
import type {
  RuntimeAgentActivityProjection,
  RuntimeProjectReadProjection,
  RuntimeReadResult,
  RuntimeSystemReadProjection,
  RuntimeTaskDashboardProjection,
} from '../../packages/ui/contracts/runtime.js';

interface FixtureFile {
  readonly path: string;
  readonly content: Uint8Array;
}

async function readFixtureFiles(root: string): Promise<readonly FixtureFile[]> {
  const files: FixtureFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push({ path: relative(root, path), content: await readFile(path) });
      }
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function assertFixtureFilesUnchanged(before: readonly FixtureFile[], after: readonly FixtureFile[]): void {
  assert.deepEqual(after.map((file) => file.path), before.map((file) => file.path), 'GET changed the fixture file set');
  for (const file of before) {
    const current = after.find((candidate) => candidate.path === file.path);
    if (current === undefined) throw new Error(`GET removed fixture file ${file.path}`);
    assert.equal(sameBytes(current.content, file.content), true, `GET changed fixture file ${file.path}`);
  }
}

function requireAgentActivity(
  dashboard: RuntimeTaskDashboardProjection,
): RuntimeReadResult<RuntimeAgentActivityProjection> {
  const activity = dashboard.agentActivity;
  if (activity === undefined) throw new Error('dashboard must expose the activity reader');
  return activity;
}

// Known missing HTTP edge; likelihood unknown. Impact: missing catalog, lost
// exact selection or cold/live scope confusion. One temporary public consumer
// covers the connected request sequence without executing a Task or Provider.
// Cross-project output/semantic failure was observed in the installed browser.
// Frequency unknown; impact: project data leakage and lost committed results.
// Cost: one existing consumer/fixture; execution time is recorded in run notes.
test('agent activity public HTTP preserves exact selection, cold scope and read-only ownership', async () => {
  const root = await mkdtemp('/private/tmp/humanagent-agent-http-');
  let server: ReturnType<typeof createServer> | undefined;
  let listening = false;
  try {
    const workspace = join(root, 'workspace-b');
    const coldWorkspace = join(root, 'workspace-a');
    await mkdir(workspace);
    await mkdir(coldWorkspace);
    const paths = await resolveRuntimePaths({ workspace, controlRoot: join(root, 'control') });
    const coldPaths = await resolveRuntimePaths({ workspace: coldWorkspace, controlRoot: join(root, 'control') });
    await ensureControlLayout(paths);
    await ensureControlLayout(coldPaths);
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
    const markerA = 'M4-HTTP-SEMANTIC-PROJECT-A';
    const markerB = 'M4-HTTP-SEMANTIC-PROJECT-B';
    const committedTextA = 'M4-HTTP-COMMITTED-PROJECT-A: durable public result';
    const fixtures = [
      { source: paths, turnId: boundTurnId, runtimeId: boundRuntimeId, assignmentId: boundAssignmentId,
        objective: boundObjective, inputRef: 'task://http-task/input', targetRef: 'task://http-task',
        expectedOutputRef: 'task://http-task/output', title: 'HTTP fixture', identity: {
          requirementId: 'http-requirement-a', inputRevision: 1, draftId: 'http-draft-a',
          draftRevisionVersion: 1, draftRevisionHash: 'sha256:http-fixture-a',
          confirmationRef: 'http-confirmation-a',
        } },
      { source: coldPaths, turnId: coldTurnId, runtimeId: coldRuntimeId, assignmentId: coldAssignmentId,
        objective: coldObjective, inputRef: 'task://http-task/cold/input', targetRef: 'task://http-task/cold',
        expectedOutputRef: 'task://http-task/cold/output', title: 'Cold HTTP fixture', identity: {
          requirementId: 'http-requirement-b', inputRevision: 1, draftId: 'http-draft-b',
          draftRevisionVersion: 1, draftRevisionHash: 'sha256:http-fixture-b',
          confirmationRef: 'http-confirmation-b',
        } },
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
      journal.append({ kind: 'operation.started', operationId, taskId, cycleId, scope,
        executionEpoch: 1, operationCounter: 1, cycleCounter: 1,
        startedAt: '2026-10-16T00:00:01.000Z', input: fixture.objective });
      const isA = fixture.source.projectKey === coldPaths.projectKey;
      const sourceId = `${fixture.runtimeId}-accepted-output`;
      journal.append({ kind: 'operation.event', operationId, event: {
        eventId: sourceId, seq: 1, occurredAt: '2026-10-16T00:00:02.000Z',
        taskId, operationId: operationId.value, executionEpoch: 1,
        kind: 'execution.terminal', state: isA ? 'succeeded' : 'blocked',
        terminalPhase: 'final', status: isA ? 'succeeded' : 'blocked',
        summary: isA ? markerA : markerB, evidenceRefs: [],
      } });
      const controlPath = uiRuntimeControlJournalPath(uiRuntimeModeRoot(fixture.source.checkpointsRoot, 'fake'));
      const control = new JsonlOrganJournal(controlPath);
      const store = new FileCheckpointStore(controlPath);
      await store.commit({ id: id('checkpoint', `${fixture.runtimeId}-checkpoint`),
        scope, cycleId, seq: 1, previousCheckpointId: null, directiveRevision: 1,
        executionEpoch: 1, outcome: isA ? 'succeeded' : 'blocked',
        summary: isA ? markerA : markerB, recoveryStateRef: {
          evidenceId: id('evidence', `${fixture.runtimeId}-recovery`), kind: 'execution',
          source: 'http-fixture', locator: `recovery://${fixture.runtimeId}`, scope,
        },
        evidenceRefs: [], next: { kind: 'continue' } });
      if (isA) {
        const binding = { scope, executionEpoch: 1 };
        const ref = await store.commitPublicOutput({ binding, sourceId, text: committedTextA });
        const publication = await store.readPublicOutputs(binding);
        assert.equal(publication.state, 'committed', 'fixture publication must be durable');
        assert.deepEqual(publication.commits, [{ ref, text: committedTextA }]);
      }
      await new JsonlTaskIdentityJournal(control).append({ scope: { organId, taskId }, source: fixture.identity });
      const activeBinding = activeBindingFor(fixture);
      await createJsonlActiveTurnJournal({ journal: control, turnId: fixture.turnId }).append({
        commitId: activeTurnCommitId(fixture.turnId, 'binding-opened'),
        record: { kind: 'binding-opened', binding: activeBinding,
          currentTurnRef: activeBinding.admittedTurn.currentTurnRef },
      });
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
      checkpointStoreFor: () => new FileCheckpointStore(
        uiRuntimeControlJournalPath(uiRuntimeModeRoot(paths.checkpointsRoot, 'fake'))),
      attentionPort: { publish: forbidden, resolve: forbidden },
      providerState: 'ready',
      now: () => new Date('2026-10-16T00:01:00.000Z'),
      runtimeComposition: { createTaskAssembly: forbidden },
      i2History: { journal: createJsonlI2JournalPort({
        filePath: uiRuntimeControlJournalPath(uiRuntimeModeRoot(paths.checkpointsRoot, 'fake')),
      }) },
      projectKey: paths.projectKey, workspaceRoot: workspace, runtimePaths: paths,
      projectCatalog: () => listConfiguredProjects(paths),
      explicitBrainInterpreter: { interpret: async () => { throw new Error('GET must not interpret'); } },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(),
        projectKey: paths.projectKey, roleId: 'execution' },
    });
    const { listener } = createUiRuntimeRequestDispatcher({ service, accessControl,
      uiRoot: join(process.cwd(), 'docs/ui'), isClosing: () => false });
    const taskView = () => JSON.stringify(service.taskDashboard(taskId));
    const before = { task: taskView(), files: await readFixtureFiles(root) };
    server = createServer(listener);
    const httpServer = server;
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => { listening = true; resolve(); });
    });
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('HTTP consumer did not bind a socket');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cookie = accessControl.sessionCookie(session).split(';')[0]!;
    const request = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      const payload = await response.text();
      return { response, payload };
    };
    const get = async (query = ''): Promise<RuntimeTaskDashboardProjection> => {
      const { response, payload } = await request(`/api/tasks/${encodeURIComponent(taskId.value)}/dashboard${query}`);
      assert.equal(response.status, 200, payload);
      return JSON.parse(payload) as RuntimeTaskDashboardProjection;
    };
    const getDashboard = async (query: string): Promise<RuntimeProjectReadProjection | RuntimeSystemReadProjection> => {
      const { response, payload } = await request(`/api/dashboard?${query}`);
      assert.equal(response.status, 200, payload);
      return JSON.parse(payload) as RuntimeProjectReadProjection | RuntimeSystemReadProjection;
    };
    const system = await getDashboard('scope=system') as RuntimeSystemReadProjection;
    assert.equal(system.surface, 'runtime-system');
    assert.equal(system.scope.kind, 'system');
    assert.equal(system.coverage, 'configured-projects-in-current-control-root');
    assert.equal(system.projects.length, 2, JSON.stringify(system));
    assert.equal(system.taskCount, 2, JSON.stringify(system));
    assert.equal(system.complete, true, JSON.stringify(system.failures));
    assert.deepEqual(system.failures, []);
    const systemProjects = new Map(system.projects.map((project) => [project.scope.projectKey, project]));
    assert.deepEqual([...systemProjects.keys()].sort(), fixtures.map((fixture) => fixture.source.projectKey).sort());
    for (const fixture of fixtures) {
      const project = systemProjects.get(fixture.source.projectKey);
      if (project === undefined) throw new Error(`system omitted project ${fixture.source.projectKey}`);
      assert.equal(project.taskCount, 1, `${fixture.source.projectKey} task count`);
      assert.equal(project.tasks.length, 1, `${fixture.source.projectKey} task rows`);
    }

    const projectReads = new Map<string, RuntimeProjectReadProjection>();
    for (const fixture of fixtures) {
      const project = await getDashboard(`scope=project&projectKey=${encodeURIComponent(fixture.source.projectKey)}`) as RuntimeProjectReadProjection;
      projectReads.set(fixture.source.projectKey, project);
      assert.equal(project.surface, 'runtime-project');
      assert.equal(project.scope.kind, 'project');
      assert.equal(project.scope.projectKey, fixture.source.projectKey);
      assert.equal(project.label, basename(fixture.source.workspaceCwd));
      assert.equal(project.taskCount, 1, JSON.stringify(project));
      assert.equal(project.complete, true, JSON.stringify(project.failures));
      assert.deepEqual(project.failures, []);
      assert.equal(project.tasks.length, 1, JSON.stringify(project));
      const row = project.tasks[0]!;
      assert.deepEqual(row.scope, { kind: 'task', projectKey: fixture.source.projectKey, mode: 'fake', taskId });
      assert.equal(row.task.taskId.value, taskId.value);
      assert.equal(row.task.title, fixture.title);
      assert.deepEqual(row.task.identitySource, fixture.identity);
      for (const other of fixtures) {
        if (other.source.projectKey !== fixture.source.projectKey) {
          assert.equal(row.task.title === other.title, false, 'project row borrowed another project title');
          assert.equal(row.task.identitySource?.requirementId === other.identity.requirementId, false,
            'project row borrowed another project identity');
        }
      }
      const systemProject = systemProjects.get(fixture.source.projectKey);
      if (systemProject === undefined) throw new Error(`system omitted project ${fixture.source.projectKey}`);
      assert.deepEqual(project.tasks, systemProject.tasks, 'project row must match its system row');
    }

    const assertTaskA = (body: RuntimeTaskDashboardProjection): void => {
      assert.equal(body.taskTitle, fixtures[0]!.title, 'scope A title mismatch');
      assert.equal(body.input, fixtures[0]!.objective, 'scope A input mismatch');
    };
    const taskA = await get(`?projectKey=${encodeURIComponent(paths.projectKey)}&mode=fake`);
    assertTaskA(taskA);
    assert.equal(taskA.taskId.value, taskId.value);
    assert.equal(taskA.mode, 'fake');

    const catalog = requireAgentActivity(await get());
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
    const selected = requireAgentActivity(await get(`?agentKind=native-execution&agentRuntimeId=${boundRuntimeId}&agentExecutionEpoch=1&agentAssignmentId=${boundAssignmentId}`));
    assert.equal(selected.ok, true, JSON.stringify(selected));
    if (!selected.ok) throw new Error('selection unavailable');
    assert.equal(selected.value.mode, 'selected');
    assert.ok(selected.value.selected!.length > 0);
    assert.ok(selected.value.selected!.every((entry) => entry.instance.kind === 'native-execution'
      && entry.instance.runtimeId === boundRuntimeId && entry.executionEpoch === 1 && entry.assignmentId === boundAssignmentId));
    for (const query of ['?agentUnknown=x', '?agentKind=native-execution']) {
      const invalid = requireAgentActivity(await get(query));
      assert.equal(invalid.ok, false);
      if (!invalid.ok) assert.equal(invalid.failure.code, 'agent-activity.invalid-selection');
    }
    const coldTask = await get(`?projectKey=${encodeURIComponent(coldPaths.projectKey)}&mode=fake`);
    assert.equal(coldTask.taskTitle, fixtures[1]!.title);
    assert.equal(coldTask.input, fixtures[1]!.objective);
    const cold = requireAgentActivity(coldTask);
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
    await assert.rejects(async () => assertTaskA(coldTask), /scope A title mismatch/);
    console.log(JSON.stringify({ event: 'cross-scope-assertion-rejected', assertion: 'scope A title mismatch' }));

    const unknown = await request(`/api/dashboard?scope=project&projectKey=${encodeURIComponent('unknown-project')}`);
    assert.equal(unknown.response.status, 404, unknown.payload);
    const unknownBody = JSON.parse(unknown.payload) as { readonly error?: { readonly code?: string } };
    assert.equal(unknownBody.error?.code, 'project.unknown');
    assert.equal(Object.hasOwn(unknownBody, 'projects'), false, 'unknown project must not return a success body');

    // Service is bound to B. All three public reads explicitly select A's
    // Config key, the same typed TaskId and fake mode; titles do not select scope.
    const queryA = `?projectKey=${encodeURIComponent(coldPaths.projectKey)}&mode=fake`;
    const semanticPath = `/api/tasks/${encodeURIComponent(taskId.value)}/semantic`;
    const assertSemanticA = (payload: string): void => {
      assert.ok(payload.includes(markerA), `A semantic marker missing: ${payload}`);
      assert.equal(payload.includes(markerB), false, `A semantic read leaked B: ${payload}`);
    };
    const scopedReads = await Promise.allSettled([
      (async () => {
        const dashboard = await get(queryA);
        assert.equal(dashboard.state, 'succeeded');
        assert.equal(
          dashboard.output,
          committedTextA,
          `foreign A dashboard lost committed public output: ${JSON.stringify(dashboard.publicOutput)}`,
        );
        assert.equal(dashboard.publicOutput?.state, 'committed');
      })(),
      (async () => {
        const { response, payload } = await request(`${semanticPath}${queryA}`);
        assert.equal(response.status, 200, payload);
        assertSemanticA(payload);
      })(),
      (async () => {
        const response = await fetch(`${baseUrl}${semanticPath}/stream${queryA}`, { headers: { cookie } });
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let payload = '';
        let eof = false;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
              eof = true;
              break;
            }
            payload += decoder.decode(chunk.value, { stream: true });
          }
          payload += decoder.decode();
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        assert.equal(eof, true, 'finite semantic stream must reach EOF');
        const frames = payload.split('\n\n').filter((frame) => frame.length > 0);
        assert.equal(frames.length, 2, payload);
        assert.match(frames[0]!, /^id: semantic-\d+\nevent: semantic\.observation\ndata: /);
        assertSemanticA(frames[0]!);
        assert.equal(frames[1], 'event: semantic-complete\ndata: {}');
        assert.equal(payload.endsWith('\n\n'), true);
      })(),
    ]);

    const after = { task: taskView(), files: await readFixtureFiles(root) };
    assert.equal(after.task, before.task, 'GET changed the task view');
    assertFixtureFilesUnchanged(before.files, after.files);
    console.log(JSON.stringify({ event: 'read-only-fixture-unchanged', files: before.files.length }));
    const failures = scopedReads.flatMap((result, index) => result.status === 'rejected'
      ? [`${['dashboard', 'semantic GET', 'semantic SSE'][index]}: ${String(result.reason)}`] : []);
    assert.equal(failures.length, 0, failures.join('\n'));
  } finally {
    const httpServer = server;
    if (httpServer !== undefined && listening) {
      httpServer.closeIdleConnections?.();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ event: 'http-fixture-cleaned', root, listening: false }));
  }
});
