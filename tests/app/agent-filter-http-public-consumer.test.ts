import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  id,
  type ProviderBinding,
  type TaskId,
} from '../../packages/contracts/src/index.js';
import { ensureControlLayout, listConfiguredProjects, resolveRuntimePaths } from '../../packages/config/src/index.js';
import { MemoryCoordinator } from '../../packages/runtime/src/index.js';
import { DeterministicMemoryBackend } from '../../packages/adapters/memory/src/index.js';
import {
  UiRuntimeService,
  buildFakeExecutionPort,
} from '../../packages/app/src/ui-runtime/index.js';
import { createUiRuntimeRequestDispatcher } from '../../packages/app/src/ui-runtime/server.js';
import { createJsonlI2JournalPort } from '../../packages/app/src/i2-journal.js';
import { AccessControlService } from '../../packages/app/src/ui-runtime/access-control.js';
import {
  FileCheckpointStore,
  UiRuntimeJournal,
  uiRuntimeJournalPath,
  uiRuntimeControlJournalPath,
  uiRuntimeModeRoot,
} from '../../packages/app/src/ui-runtime/journal.js';
import type { PipelineObservationWithDebugProjection } from '../../packages/ui/projection/index.js';

const CANONICAL_DEBUG_ROLES = [
  'interaction',
  'orchestration',
  'execution',
  'review',
  'memory',
] as const;

interface ObservationHttpFixture {
  readonly taskId: TaskId;
  readonly roleRuntimeId: string;
  readonly roleExecutionEpoch: number;
  readonly roleAssignmentId: string;
  readonly unroledRuntimeId: string;
  readonly unroledExecutionEpoch: number;
  readonly unroledAssignmentId: string;
  readonly request: (query: string) => Promise<{ readonly status: number; readonly payload: string }>;
  readonly close: () => Promise<void>;
}

async function createObservationHttpFixture(): Promise<ObservationHttpFixture> {
  const root = await mkdtemp('/private/tmp/humanagent-agent-filter-http-');
  let server: ReturnType<typeof createServer> | undefined;
  let listening = false;
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const paths = await resolveRuntimePaths({ workspace, controlRoot: join(root, 'control') });
    await ensureControlLayout(paths);
    const organId = id('organ', 'agent-filter-http-organ');
    const taskId = id('task', 'agent-filter-http-task');
    const cycleId = id('cycle', 'agent-filter-http-cycle');
    const roleRuntimeId = 'role-native-runtime';
    const roleAssignmentId = 'role-native-assignment';
    const reviewRuntimeId = roleRuntimeId;
    const reviewAssignmentId = 'review-native-assignment';
    const unroledRuntimeId = 'unroled-native-runtime';
    const unroledAssignmentId = 'unroled-native-assignment';
    const directive = 'observe the selected agent role';
    const journal = new UiRuntimeJournal(uiRuntimeJournalPath(paths.checkpointsRoot, 'fake'));
    journal.append({
      kind: 'task.created',
      taskId,
      title: 'Agent filter HTTP fixture',
      directive,
      directiveRevision: 1,
      createdAt: '2026-10-16T00:00:00.000Z',
      taskCounter: 1,
    });
    const allocationFor = (
      operationIdValue: string,
      runtimeId: string,
      assignmentId: string,
      role?: 'execution' | 'review',
    ) => {
      const operationId = id('operation', operationIdValue);
      return {
        runtimeId,
        taskId,
        operationId,
        executionEpoch: 1,
        assignmentId,
        scope: { organId, taskId, cycleId, operationId },
        inputRefs: [`task://${taskId.value}/input`],
        ownerId: 'agent-filter-http-consumer',
        directiveRevision: 1,
        inputRevision: 1,
        orchestrated: false,
        ...(role === undefined ? {} : { role }),
      };
    };
    journal.append({
      kind: 'operation.prepared',
      allocation: allocationFor('agent-filter-role-op', roleRuntimeId, roleAssignmentId, 'execution'),
      input: directive,
      operationCounter: 1,
      cycleCounter: 1,
    });
    journal.append({
      kind: 'operation.prepared',
      allocation: allocationFor('agent-filter-review-op', reviewRuntimeId, reviewAssignmentId, 'review'),
      input: directive,
      operationCounter: 2,
      cycleCounter: 1,
    });
    journal.append({
      kind: 'operation.prepared',
      allocation: allocationFor('agent-filter-unroled-op', unroledRuntimeId, unroledAssignmentId),
      input: directive,
      operationCounter: 3,
      cycleCounter: 1,
    });
    journal.append({
      kind: 'operation.started',
      operationId: id('operation', 'agent-filter-role-op'),
      taskId,
      cycleId,
      scope: { organId, taskId, cycleId, operationId: id('operation', 'agent-filter-role-op') },
      executionEpoch: 1,
      operationCounter: 1,
      cycleCounter: 1,
      startedAt: '2026-10-16T00:00:01.000Z',
      input: directive,
    });
    journal.append({
      kind: 'operation.event',
      operationId: id('operation', 'agent-filter-role-op'),
      event: {
        eventId: 'agent-filter-role-terminal',
        seq: 1,
        occurredAt: '2026-10-16T00:00:02.000Z',
        taskId,
        operationId: 'agent-filter-role-op',
        executionEpoch: 1,
        kind: 'execution.terminal',
        state: 'succeeded',
        terminalPhase: 'final',
        status: 'succeeded',
        summary: 'role native allocation succeeded',
        evidenceRefs: [],
      },
    });
    const binding: ProviderBinding = {
      bindingId: 'agent-filter-http-binding',
      providerId: 'agent-filter-http-provider',
      protocol: 'responses',
      endpointRef: 'fake://agent-filter-http',
      modelRef: 'fake',
      configDigest: 'sha256:agent-filter-http',
      capabilityDigest: 'sha256:agent-filter-http',
    };
    const forbidden = (): never => { throw new Error('GET must not execute side effects'); };
    const service = new UiRuntimeService({
      mode: 'fake',
      organId,
      binding,
      port: buildFakeExecutionPort(binding),
      journal,
      closurePort: journal,
      checkpointStoreFor: () => new FileCheckpointStore(
        uiRuntimeControlJournalPath(uiRuntimeModeRoot(paths.checkpointsRoot, 'fake')),
      ),
      attentionPort: { publish: forbidden, resolve: forbidden },
      providerState: 'ready',
      now: () => new Date('2026-10-16T00:01:00.000Z'),
      runtimeComposition: { createTaskAssembly: forbidden },
      i2History: {
        journal: createJsonlI2JournalPort({
          filePath: uiRuntimeControlJournalPath(uiRuntimeModeRoot(paths.checkpointsRoot, 'fake')),
        }),
      },
      projectKey: paths.projectKey,
      workspaceRoot: workspace,
      runtimePaths: paths,
      projectCatalog: () => listConfiguredProjects(paths),
      explicitBrainInterpreter: { interpret: async () => { throw new Error('GET must not interpret'); } },
      memory: {
        coordinator: new MemoryCoordinator(),
        backend: new DeterministicMemoryBackend(),
        projectKey: paths.projectKey,
        roleId: 'execution',
      },
    });
    const accessControl = await AccessControlService.open({
      credentialPath: paths.webAccessCredentialPath,
      create: true,
    });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: paths.controlRoot,
      uiRoot: join(process.cwd(), 'docs/ui'),
      isClosing: () => false,
    });
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
    const request = async (query: string) => {
      const response = await fetch(
        `${baseUrl}/api/tasks/${encodeURIComponent(taskId.value)}/observation${query}`,
        { headers: { cookie } },
      );
      const payload = await response.text();
      return { status: response.status, payload };
    };
    const close = async (): Promise<void> => {
      if (listening) {
        httpServer.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      }
      await rm(root, { recursive: true, force: true });
    };
    return {
      taskId,
      roleRuntimeId,
      roleExecutionEpoch: 1,
      roleAssignmentId,
      unroledRuntimeId,
      unroledExecutionEpoch: 1,
      unroledAssignmentId,
      request,
      close,
    };
  } catch (error) {
    if (listening && server !== undefined) {
      server.closeIdleConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function observationRoles(payload: string): readonly string[] {
  const observation = JSON.parse(payload) as PipelineObservationWithDebugProjection;
  return observation.agentDebugInspections.map((inspection) => inspection.agentRole);
}

// Failure mode: a valid instance selection still renders the five-role catalog
// instead of only the selected canonical role. Frequency: observed in the real
// front end for every selection. Impact: the debug card grid ignores the user
// choice. Cost: one HTTP consumer fixture with a role-bearing native allocation.
test('observation narrows the debug card grid to a matched native allocation role', async () => {
  const fixture = await createObservationHttpFixture();
  try {
    const catalog = await fixture.request('');
    assert.equal(catalog.status, 200, catalog.payload);
    assert.deepEqual(observationRoles(catalog.payload), [...CANONICAL_DEBUG_ROLES]);

    const selected = await fixture.request(
      `?agentKind=native-execution`
      + `&agentRuntimeId=${fixture.roleRuntimeId}`
      + `&agentExecutionEpoch=${fixture.roleExecutionEpoch}`
      + `&agentAssignmentId=${fixture.roleAssignmentId}`,
    );
    assert.equal(selected.status, 200, selected.payload);
    assert.deepEqual(
      observationRoles(selected.payload),
      ['execution'],
      `selected native role must narrow the grid to one card: ${selected.payload}`,
    );
    const selectedBody = JSON.parse(selected.payload) as {
      readonly agentActivity?: {
        readonly ok?: boolean;
        readonly value?: { readonly mode?: string; readonly selectedRole?: string };
      };
    };
    assert.equal(selectedBody.agentActivity?.ok, true, selected.payload);
    assert.equal(selectedBody.agentActivity?.value?.mode, 'selected', selected.payload);
    assert.equal(selectedBody.agentActivity?.value?.selectedRole, 'execution', selected.payload);

    const ambiguous = await fixture.request(
      `?agentKind=native-execution`
      + `&agentRuntimeId=${fixture.roleRuntimeId}`
      + `&agentExecutionEpoch=${fixture.roleExecutionEpoch}`,
    );
    assert.equal(ambiguous.status, 400, ambiguous.payload);
    const ambiguousBody = JSON.parse(ambiguous.payload) as {
      readonly error?: { readonly code?: string };
    };
    assert.equal(
      ambiguousBody.error?.code,
      'agent-activity.invalid-agent-role-selection',
      ambiguous.payload,
    );
  } finally {
    await fixture.close();
  }
});

// Failure mode: a native allocation with no recorded role is narrowed or
// rejected. Frequency: known reachable control state. Impact: the five-role
// catalog is lost or a legal selection is hidden. Cost: same fixture, no new
// sources.
test('observation keeps the five-role catalog for a native allocation with no role', async () => {
  const fixture = await createObservationHttpFixture();
  try {
    const selected = await fixture.request(
      `?agentKind=native-execution`
      + `&agentRuntimeId=${fixture.unroledRuntimeId}`
      + `&agentExecutionEpoch=${fixture.unroledExecutionEpoch}`
      + `&agentAssignmentId=${fixture.unroledAssignmentId}`,
    );
    assert.equal(selected.status, 200, selected.payload);
    assert.deepEqual(observationRoles(selected.payload), [...CANONICAL_DEBUG_ROLES]);
    const selectedBody = JSON.parse(selected.payload) as {
      readonly agentActivity?: {
        readonly ok?: boolean;
        readonly value?: { readonly mode?: string; readonly selectedRole?: string };
      };
    };
    assert.equal(selectedBody.agentActivity?.ok, true, selected.payload);
    assert.equal(selectedBody.agentActivity?.value?.mode, 'selected', selected.payload);
    assert.equal(selectedBody.agentActivity?.value?.selectedRole, undefined, selected.payload);
  } finally {
    await fixture.close();
  }
});

// Failure mode: an incomplete selection is reported as a successful catalog read
// instead of an explicit 400. Impact: a broken selection silently looks like a
// valid overview. Cost: one request on the same fixture.
test('observation reports an incomplete agent selection as a typed 400', async () => {
  const fixture = await createObservationHttpFixture();
  try {
    const incomplete = await fixture.request(
      `?agentKind=incarnation&agentRuntimeId=${fixture.roleRuntimeId}`,
    );
    assert.equal(incomplete.status, 400, incomplete.payload);
    const body = JSON.parse(incomplete.payload) as {
      readonly error?: {
        readonly code?: string;
      };
    };
    assert.equal(
      body.error?.code,
      'agent-activity.invalid-agent-role-selection',
      incomplete.payload,
    );
  } finally {
    await fixture.close();
  }
});
