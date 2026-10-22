import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

// Known gap: the product board/session/output reads had no public HTTP edge,
// and `/api/explicit/inputs` did not derive its actor from the paired browser
// session. Impact: the phone/desktop shell cannot read the S composition, and a
// page could label its own traffic human. Cost: one dispatcher consumer and one
// real service fixture; no Provider execution.
const scope = { projectKey: 'project-h2', mode: 'fake' };

function dispatch(listener, { method = 'GET', url, headers = {}, body }) {
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

function makeService(root) {
  const journalPath = join(root, 'state', 'ui-runtime-journal.jsonl');
  const journal = new UiRuntimeJournal(journalPath);
  const organId = id('organ', 'h2-http-organ');
  const binding = {
    bindingId: 'h2-binding',
    providerId: 'h2-provider',
    protocol: 'responses',
    endpointRef: 'fake://h2',
    modelRef: 'fake',
    configDigest: 'sha256:h2-config',
    capabilityDigest: 'sha256:h2-capability',
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
  });
  return { service, organId, journalPath };
}

test('product read API forwards only the exact scope and drops authority fields', async () => {
  const calls = [];
  const api = createRuntimeApi({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
  });
  const forged = {
    ...scope,
    taskId: 'task-a',
    owner: 'forged-owner',
    principalOwner: 'forged-principal',
    authority: { owner: 'forged-owner', grant: null },
  };

  assert.deepEqual(await api.readProductBoard(forged), { accepted: true });
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).url, '/api/product/board?projectKey=project-h2&mode=fake&taskId=task-a');

  assert.deepEqual(await api.readProductSession(scope), { accepted: true });
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).url, '/api/product/session?projectKey=project-h2&mode=fake');

  assert.deepEqual(await api.readProductOutput('task-a'), { accepted: true });
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).url, '/api/product/output?taskId=task-a');

  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.body, undefined);
    assert.equal(/owner|principal|authority/i.test(call.url), false);
  }
  assert.throws(() => api.readProductBoard({ projectKey: scope.projectKey, mode: 'invalid' }), TypeError);
  assert.throws(() => api.readProductOutput(''), TypeError);
});

test('product HTTP reads compose real facts and derive the explicit actor from the session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-product-read-http-'));
  try {
    const accessControl = await AccessControlService.open({
      credentialPath: join(root, 'security', 'web-access.json'),
      create: true,
    });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0];
    const principalOwner = accessControl.readProductPrincipalOwner();

    const { service, journalPath } = makeService(root);
    const task = service.createTask({ title: 'h2 read fixture', directive: 'hidden task input' });
    const { listener } = createUiRuntimeRequestDispatcher({
      service,
      accessControl,
      productRoot: root,
      uiRoot: root,
      isClosing: () => false,
    });
    const api = apiFor(listener, cookie);
    const anonymous = apiFor(listener, undefined);

    await assert.rejects(
      () => anonymous.readProductBoard(scope),
      (error) => error.status === 401 && error.code === 'auth.session.missing',
    );

    const beforeAnonymousInput = await snapshotFiles(root);
    await assert.rejects(
      () => anonymous.receiveExplicitInput({
        sourceRef: 'entry-anonymous',
        rawInput: 'must not persist',
        actor: { kind: 'human', sourceKind: 'forged', sourceRef: 'forged-owner' },
        owner: 'forged-owner',
        principalOwner: 'forged-principal',
        authority: { owner: 'forged-owner' },
      }),
      (error) => error.status === 401 && error.code === 'auth.session.missing',
    );
    assert.deepEqual(await snapshotFiles(root), beforeAnonymousInput,
      'an unauthenticated explicit input must not persist a 401 attempt, not even a partial interaction');

    const beforeAuthenticatedInput = await snapshotFiles(root);
    const created = await api.receiveExplicitInput({
      sourceRef: 'entry-h2',
      rawInput: 'h2 real human input',
      actor: { kind: 'human', sourceKind: 'forged', sourceRef: 'forged-owner' },
      owner: 'forged-owner',
      principalOwner: 'forged-principal',
      authority: { owner: 'forged-owner' },
    });
    assert.deepEqual(Object.keys(created), ['interactionId']);
    assert.equal(typeof created.interactionId, 'string');
    assert.deepEqual(await snapshotFiles(root).then((files) => files.map((file) => file.path)), beforeAuthenticatedInput.map((file) => file.path));
    assert.notDeepEqual(await snapshotFiles(root), beforeAuthenticatedInput,
      'the authenticated explicit input owner must persist the interaction state');

    const board = await api.readProductBoard(scope);
    assert.equal(board.boards.length, 5);
    assert.deepEqual(board.scope, { kind: 'project', projectKey: scope.projectKey });
    const interaction = board.boards.find((section) => section.board === 'interaction');
    assert.ok(interaction, 'the interaction board is missing');
    assert.ok(interaction.live.some((item) => item.title === 'h2 real human input'),
      'the board must show the real explicit input title');

    const sessionRead = await api.readProductSession(scope);
    const message = sessionRead.messages.find((entry) => entry.text === 'h2 real human input');
    assert.ok(message, 'the session must expose the real explicit input message');
    assert.equal(message.actor.kind, 'human');
    assert.equal(message.actor.sourceKind, 'product-principal');
    assert.equal(message.actor.sourceRef, principalOwner);
    assert.notEqual(message.actor.sourceRef, 'forged-owner');
    assert.equal(typeof message.occurredAt, 'string');
    assert.ok(Number.isFinite(Date.parse(message.occurredAt)),
      'the server must record an event time when the caller omits occurredAt');

    const output = await api.readProductOutput(task.taskId.value);
    assert.deepEqual(output.commits, []);
    assert.equal(output.resultAvailable, false);

    await assert.rejects(
      () => api.readProductBoard({ projectKey: scope.projectKey, mode: 'rcc' }),
      (error) => error.status === 409 && error.code === 'product-read.scope-not-bound',
    );
    await assert.rejects(
      () => api.readProductSession({ projectKey: 'project-other', mode: 'fake' }),
      (error) => error.status === 409 && error.code === 'product-read.scope-not-bound',
    );
    await assert.rejects(
      () => api.readProductOutput('task-missing'),
      (error) => error.status === 404 && error.code === 'task.not.found',
    );

    const missingMode = await dispatch(listener, {
      url: '/api/product/board?projectKey=project-h2',
      headers: { cookie },
    });
    assert.equal(missingMode.status, 400);
    assert.equal(JSON.parse(missingMode.text).error.code, 'read.scope.invalid');

    const invalidMode = await dispatch(listener, {
      url: '/api/product/session?projectKey=project-h2&mode=invalid',
      headers: { cookie },
    });
    assert.equal(invalidMode.status, 400);
    assert.equal(JSON.parse(invalidMode.text).error.code, 'read.scope.invalid');

    const beforeReads = await snapshotFiles(root);
    await api.readProductBoard(scope);
    await api.readProductSession(scope);
    await api.readProductOutput(task.taskId.value);
    await api.readProductBoard(scope);
    const afterReads = await snapshotFiles(root);
    assert.deepEqual(afterReads, beforeReads,
      'refreshing or reopening a product read must issue zero writes');

    const journalRecords = (await readFile(journalPath, 'utf8')).trim().split('\n');
    assert.ok(journalRecords.some((line) => JSON.parse(line).kind === 'explicit-brain.state'),
      'the authenticated explicit input must persist through the declared owner journal');
    assert.equal(journalRecords.filter((line) => JSON.parse(line).kind === 'explicit-brain.state').length, 1,
      'the rejected anonymous input and the product reads must not add another interaction state');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
