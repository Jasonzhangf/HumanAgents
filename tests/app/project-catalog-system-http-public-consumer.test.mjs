import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ensureControlLayout, listConfiguredProjects, resolveRuntimePaths } from '../../dist/app/config/src/index.js';
import { id } from '../../dist/app/contracts/src/index.js';
import { DeterministicMemoryBackend } from '../../dist/app/adapters/memory/src/index.js';
import { MemoryCoordinator } from '../../dist/app/runtime/src/index.js';
import { FakeReplayExecutionRuntimePort, FileCheckpointStore, UiRuntimeJournal, UiRuntimeService } from '../../dist/app/app/src/ui-runtime/index.js';
import { AccessControlService } from '../../dist/app/app/src/ui-runtime/access-control.js';
import { createUiRuntimeRequestDispatcher } from '../../dist/app/app/src/ui-runtime/server.js';

function dispatch(listener, { url, cookie }) {
  return new Promise((resolve, reject) => {
    const request = Readable.from([]);
    request.method = 'GET';
    request.url = url;
    request.headers = { cookie };
    const chunks = [];
    const response = {
      status: undefined,
      writableEnded: false,
      writeHead(status) { this.status = status; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk));
        this.writableEnded = true;
        resolve({ status: this.status, text: Buffer.concat(chunks).toString('utf8') });
      },
    };
    try { listener(request, response); } catch (error) { reject(error); }
  });
}

// Failure basis: deduplicating the catalog by workspace dropped a valid project
// that shares a directory with another project. Impact: that project disappears
// from the system sidebar. Cost: isolated manifests and one HTTP consumer.
test('system dashboard filters inactive workspaces and keeps projects that share a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-project-catalog-http-'));
  try {
    const boundWorkspace = join(root, 'bound-workspace');
    const otherWorkspace = join(root, 'other-workspace');
    await mkdir(boundWorkspace, { recursive: true });
    await mkdir(otherWorkspace, { recursive: true });
    const boundPaths = await resolveRuntimePaths({ controlRoot: join(root, 'control'), workspace: boundWorkspace });
    const otherPaths = await resolveRuntimePaths({ controlRoot: boundPaths.controlRoot, workspace: otherWorkspace });
    await ensureControlLayout(boundPaths);
    await ensureControlLayout(otherPaths);
    await writeFile(boundPaths.projectManifest, JSON.stringify({
      schemaVersion: 1, projectKey: boundPaths.projectKey, workspaceCwd: boundPaths.workspaceCwd, displayName: '正式侧栏项目',
    }), 'utf8');

    const sessionRoot = dirname(boundPaths.projectRoot);
    const duplicateKey = `${otherPaths.projectKey}--${createHash('sha256').update(otherPaths.workspaceCwd).digest('hex').slice(0, 16)}`;
    await mkdir(join(sessionRoot, duplicateKey), { recursive: true });
    await writeFile(join(sessionRoot, duplicateKey, 'project.json'), JSON.stringify({
      schemaVersion: 1,
      projectKey: duplicateKey,
      workspaceCwd: otherPaths.workspaceCwd,
    }), 'utf8');
    const staleWorkspace = join('/private/tmp', `humanagent-project-catalog-stale-${process.pid}`, 'workspace');
    const staleKey = staleWorkspace.split(sep).join('-');
    await mkdir(join(sessionRoot, staleKey), { recursive: true });
    await writeFile(join(sessionRoot, staleKey, 'project.json'), JSON.stringify({
      schemaVersion: 1,
      projectKey: staleKey,
      workspaceCwd: staleWorkspace,
    }), 'utf8');
    const staleSystemWorkspace = join('/private/var/folders/jm', `catalog-${process.pid}`, 'T', `humanagent-e2e-catalog-${process.pid}`, 'workspace');
    const staleSystemKey = staleSystemWorkspace.split(sep).join('-');
    await mkdir(join(sessionRoot, staleSystemKey), { recursive: true });
    await writeFile(join(sessionRoot, staleSystemKey, 'project.json'), JSON.stringify({
      schemaVersion: 1,
      projectKey: staleSystemKey,
      workspaceCwd: staleSystemWorkspace,
    }), 'utf8');
    let catalog = await listConfiguredProjects(boundPaths);
    const binding = {
      bindingId: 'project-catalog-http-binding', providerId: 'fake', protocol: 'responses',
      endpointRef: 'fake://project-catalog-http', modelRef: 'fake',
      configDigest: 'sha256:project-catalog-http', capabilityDigest: 'sha256:project-catalog-http',
    };
    const journal = new UiRuntimeJournal(join(root, 'ui-runtime-journal.jsonl'));
    const forbidden = () => { throw new Error('GET must not execute side effects'); };
    const service = new UiRuntimeService({
      mode: 'fake', organId: id('organ', 'project-catalog-http-organ'), binding,
      port: new FakeReplayExecutionRuntimePort({ binding }), journal, closurePort: journal,
      checkpointStoreFor: (taskId, cycleId) => new FileCheckpointStore(join(root, 'checkpoints', `${taskId.value}-${cycleId.value}.jsonl`)),
      attentionPort: { publish: forbidden, resolve: forbidden }, providerState: 'ready',
      runtimeComposition: { createTaskAssembly: forbidden },
      projectKey: boundPaths.projectKey, workspaceRoot: boundPaths.workspaceCwd, runtimePaths: boundPaths,
      projectCatalog: async () => catalog,
      explicitBrainInterpreter: { async interpret() { throw new Error('GET must not interpret'); } },
      memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(),
        projectKey: boundPaths.projectKey, roleId: 'execution' },
    });
    const accessControl = await AccessControlService.open({ credentialPath: join(root, 'security', 'web-access.json'), create: true });
    const challenge = await accessControl.issuePairingChallenge();
    const session = await accessControl.consumePairingCode(challenge.code);
    const cookie = accessControl.sessionCookie(session).split(';')[0];
    const { listener } = createUiRuntimeRequestDispatcher({
      service, accessControl, productRoot: boundPaths.controlRoot, uiRoot: join(process.cwd(), 'docs/ui'), isClosing: () => false,
    });

    const first = await dispatch(listener, { url: '/api/dashboard?scope=system', cookie });
    assert.equal(first.status, 200, first.text);
    const read = JSON.parse(first.text);
    assert.equal(read.projects.length, 3, 'the stale manifest is omitted, while two projects may share one workspace');
    assert.equal(new Set(read.projects.map((project) => project.scope.projectKey)).size, 3);
    assert.equal(new Set(read.projects.map((project) => project.workspaceCwd)).size, 2);
    assert.equal(read.projects.some((project) => project.scope.projectKey === boundPaths.projectKey), true);
    assert.equal(read.projects.some((project) => project.scope.projectKey === otherPaths.projectKey), true);
    assert.equal(read.projects.some((project) => project.scope.projectKey === duplicateKey), true);
    assert.equal(read.projects.find((project) => project.scope.projectKey === boundPaths.projectKey)?.label, '正式侧栏项目');
    assert.equal(read.projects.some((project) => project.scope.projectKey === staleKey), false);
    assert.equal(read.projects.some((project) => project.scope.projectKey === staleSystemKey), false);

    catalog = { projects: [], failures: [] };
    const second = await dispatch(listener, { url: '/api/dashboard?scope=system', cookie });
    assert.equal(second.status, 200, second.text);
    const empty = JSON.parse(second.text);
    assert.deepEqual(empty.projects, []);

    const explicit = await dispatch(listener, {
      url: `/api/dashboard?scope=project&projectKey=${encodeURIComponent(boundPaths.projectKey)}`,
      cookie,
    });
    assert.equal(explicit.status, 200, explicit.text);
    assert.equal(JSON.parse(explicit.text).scope.projectKey, boundPaths.projectKey);
    assert.equal(JSON.parse(explicit.text).label, '正式侧栏项目');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

