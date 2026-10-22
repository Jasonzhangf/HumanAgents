import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRuntimeApi } from '../../docs/ui/runtime-api.js';
import { id } from '../../dist/app/contracts/src/index.js';
import { AccessControlService } from '../../dist/app/app/src/ui-runtime/access-control.js';
import { createUiRuntimeRequestDispatcher } from '../../dist/app/app/src/ui-runtime/server.js';
import {
  FakeReplayExecutionRuntimePort,
  FileCheckpointStore,
  UiRuntimeJournal,
  UiRuntimeService,
} from '../../dist/app/app/src/ui-runtime/index.js';
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js';
import { MemoryCoordinator } from '../../dist/app/runtime/src/index.js';

// Failure mode: the W2 relation chain cannot load real lineage through the
// public HTTP edge, or it invents an edge for a task with no committed lineage.
// Probability: high, because the route and wrapper are absent while the page
// already calls both. Impact: the page must show relations as unavailable.
// Cost: one dispatcher consumer with real access control and a shaped service
// fixture; no Provider execution. Red evidence is the first run below.
const scope = { projectKey: 'project-h3', mode: 'fake' };
const subscriptionId = 'subscription-h3-relations';
const occurrenceId = 'occurrence-h3-child';

function dispatch(listener, { method = 'GET', url, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.url = url;
    request.headers = headers;
    const chunks = [];
    const response = {
      status: undefined,
      writableEnded: false,
      writeHead(status) {
        this.status = status;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        this.writableEnded = true;
        resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') });
      },
    };
    try {
      listener(request, response);
    } catch (error) {
      reject(error);
    }
  });
}

function apiFor(listener, cookie) {
  const origin = 'http://runtime.test';
  return createRuntimeApi({
    baseUrl: origin,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(String(url));
      const headers = {};
      new Headers(init.headers || {}).forEach((value, key) => { headers[key] = value; });
      if (cookie !== undefined) headers.cookie = cookie;
      headers.origin = origin;
      const result = await dispatch(listener, {
        method: init.method ?? 'GET',
        url: `${parsed.pathname}${parsed.search}`,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => (result.text ? JSON.parse(result.text) : {}),
        text: async () => result.text,
      };
    },
  });
}

async function snapshotFiles(root) {
  const files = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        files.push({ path: relative(root, path), content: (await readFile(path)).toString('base64') });
      }
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function identitySource(requirementId, taskId) {
  return {
    requirementId,
    inputRevision: 1,
    draftId: `draft-${taskId.value}`,
    draftRevisionVersion: 1,
    draftRevisionHash: `hash-${taskId.value}`,
    confirmationRef: `confirmation-${taskId.value}`,
  };
}

function makeService(root) {
  const journal = new UiRuntimeJournal(join(root, 'state', 'ui-runtime-journal.jsonl'));
  const organId = id('organ', 'h3-http-relations-organ');
  const binding = {
    bindingId: 'h3-binding',
    providerId: 'h3-provider',
    protocol: 'responses',
    endpointRef: 'fake://h3',
    modelRef: 'fake',
    configDigest: 'sha256:h3-config',
    capabilityDigest: 'sha256:h3-capability',
  };
  const identities = new Map();
  const claims = [];
  const subscription = {
    subscriptionId,
    goalId: 'requirement-parent',
    scheduleRevision: 1,
    state: 'active',
    busyPolicy: 'skip',
    currentOccurrenceOrdinal: 1,
  };
  const service = new UiRuntimeService({
    mode: 'fake',
    organId,
    projectKey: scope.projectKey,
    binding,
    port: new FakeReplayExecutionRuntimePort({ binding }),
    journal,
    closurePort: journal,
    providerState: 'ready',
    checkpointStoreFor: (taskId, cycleId) =>
      new FileCheckpointStore(join(root, 'checkpoints', `${taskId.value}-${cycleId.value}.jsonl`)),
    attentionPort: {
      async publish(input) { return { attentionId: input.attentionId, delivered: true }; },
      async resolve(input) { return { attentionId: input.attentionId, delivered: true }; },
    },
    memory: {
      coordinator: new MemoryCoordinator(),
      backend: new DeterministicMemoryBackend(),
      projectKey: scope.projectKey,
      roleId: 'execution',
    },
    explicitBrainInterpreter: { async interpret() { throw new Error('unused'); } },
    taskIdentity: {
      async read(taskScope) { return identities.get(taskScope.taskId.value); },
    },
    subscriptionControl: {
      async list() {
        return [{
          subscription,
          policy: {
            policyId: 'policy-h3',
            policyRevision: 1,
            timezone: 'America/Los_Angeles',
            canonicalInstant: '2026-10-21T10:00:00.000Z',
            dstMode: 'wall',
            dstMissedPolicy: 'shift-forward',
            dstAmbiguousPolicy: 'earlier-offset',
            latePolicy: 'run-once',
            busyPolicy: 'skip',
            executionMode: 'scheduled',
            startAt: '2026-10-21T10:00:00.000Z',
            maxOccurrences: 1,
          },
          policyHash: 'sha256:h3-policy',
          receipts: [],
          occurrences: [],
          claims,
          settlements: [],
          reminders: [],
        }];
      },
    },
  });
  return { service, organId, identities, claims };
}

test('runtime-api readProductRelations forwards only the exact read scope', async () => {
  const calls = [];
  const api = createRuntimeApi({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
      return { ok: true, status: 200, json: async () => ({ relations: [], gaps: [] }) };
    },
  });
  const forged = {
    ...scope,
    taskId: 'task-child',
    owner: 'forged-owner',
    principalOwner: 'forged-principal',
    authority: { owner: 'forged-owner', grant: null },
  };

  assert.deepEqual(await api.readProductRelations(forged), { relations: [], gaps: [] });
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).url,
    '/api/product/relations?projectKey=project-h3&mode=fake&taskId=task-child');
  assert.equal(calls.at(-1).body, undefined);
  assert.equal(/owner|principal|authority/i.test(calls.at(-1).url), false);
  assert.throws(
    () => api.readProductRelations({ projectKey: scope.projectKey, mode: 'invalid' }),
    TypeError,
  );
  assert.throws(
    () => api.readProductRelations({ ...scope, taskId: '' }),
    TypeError,
  );
});

test('product relations HTTP reads real lineage, not inferred edges, with typed scope errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-product-relations-http-'));
  try {
    const accessControl = await AccessControlService.open({
      credentialPath: join(root, 'security', 'web-access.json'),
      create: true,
    });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0];

    const { service, organId, identities, claims } = makeService(root);
    const parent = service.createTask({ title: 'H3 parent', directive: 'parent input' });
    const child = service.createTask({ title: 'H3 child', directive: 'child input' });
    const plain = service.createTask({ title: 'H3 plain', directive: 'plain input' });
    identities.set(parent.taskId.value, {
      scope: { organId, taskId: parent.taskId },
      source: identitySource('requirement-parent', parent.taskId),
      journalCommitRef: `journal:task-identity:${parent.taskId.value}`,
    });
    identities.set(child.taskId.value, {
      scope: { organId, taskId: child.taskId },
      source: identitySource('requirement-child', child.taskId),
      journalCommitRef: `journal:task-identity:${child.taskId.value}`,
    });
    claims.push({ taskId: child.taskId, occurrenceId });

    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: root,
      uiRoot: root,
      isClosing: () => false,
    });
    const api = apiFor(listener, cookie);
    const origin = 'http://runtime.test';
    const childScope = { ...scope, taskId: child.taskId.value };
    const plainScope = { ...scope, taskId: plain.taskId.value };

    const beforeReads = await snapshotFiles(root);
    const rawChild = await dispatch(listener, {
      url: `/api/product/relations?projectKey=${scope.projectKey}&mode=fake&taskId=${child.taskId.value}`,
      headers: { cookie, origin },
    });
    assert.equal(rawChild.status, 200, rawChild.text);
    const childRead = await api.readProductRelations(childScope);
    const plainRead = await api.readProductRelations(plainScope);
    const wrongScope = await api.readProductRelations({ projectKey: scope.projectKey, mode: 'rcc' })
      .then(() => undefined, (error) => error);
    const missingMode = await dispatch(listener, {
      url: `/api/product/relations?projectKey=${scope.projectKey}`,
      headers: { cookie, origin },
    });
    const afterReads = await snapshotFiles(root);

    assert.deepEqual(afterReads, beforeReads,
      'relation reads and typed scope failures must issue zero writes');

    assert.deepEqual(JSON.parse(rawChild.text), childRead,
      'the public route and runtime-api wrapper must return the same relation read');

    const childEdges = childRead.relations.filter((relation) => relation.kind === 'child-execution');
    assert.equal(childEdges.length, 1, JSON.stringify(childRead.gaps));
    assert.equal(childEdges[0].source.taskRef.value, parent.taskId.value);
    assert.equal(childEdges[0].target.taskRef.value, child.taskId.value);
    assert.ok(childEdges[0].evidenceRefs.some((ref) =>
      ref.locator === `journal://subscriptions/${subscriptionId}/occurrences/${occurrenceId}`),
    'the parent edge must keep the committed subscription lineage evidence');

    assert.deepEqual(plainRead.relations, [],
      'a task with no committed lineage must not gain an inferred edge');
    assert.ok(plainRead.gaps.some((gap) =>
      gap.taskId.value === plain.taskId.value
      && gap.code === 'relation.execution-lineage-absent'));

    assert.equal(wrongScope?.status, 409);
    assert.equal(wrongScope?.code, 'product-read.scope-not-bound');
    assert.equal(missingMode.status, 400, missingMode.text);
    assert.equal(JSON.parse(missingMode.text).error.code, 'read.scope.invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
