#!/usr/bin/env node
/**
 * Isolated-root HTTP black box for bug 12c0721 (parent turn wedged by an
 * unclosed owner reconciliation).
 *
 * What is real: the same HTTP entry the product uses
 * (`POST /api/explicit/interactions/:interactionId/interpret`), the real
 * `UiRuntimeService`, the real provider explicit-brain interpreter, the real
 * parent-turn journal (a byte copy of the wedged production turn), the real
 * supervisor lease with its durable termination receipts, and the real
 * filesystem/journal/evidence adapters.
 *
 * What is a controlled sample: the Provider upstream is a recorded SSE stub,
 * because the production RCC endpoint would be a live external call. The stub
 * answers one requirement frame, which is all the new input needs.
 *
 * What never happens: the production control root is only read. Every write
 * lands in a temp copy, and the copied lease's pid is neutralized before any
 * takeover so no signal can reach the live daemon.
 *
 * Usage (defaults read the production session root read-only):
 *   node tests/app/parent-turn-owner-reconciliation-blackbox.mjs
 * Optional arguments: [compiledDistRoot] [sourceSessionRoot] [sourceRepo]
 *
 * Pre-fix expectation: interpret answers HTTP 500 with
 *   "requires its exact prior input before new input; it cannot be discharged:
 *    an owner reconciliation is committed"
 * Post-fix expectation: interpret answers HTTP 200 with an awaiting-confirmation
 * draft, and the copy's journal shows the wedged turn closed by its own
 * committed `turn-execution-failure` for the continuation epoch.
 */
import { cp, rm, writeFile, readFile, mkdir, mkdtemp, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const compiledRoot = process.argv[2] ?? join(process.cwd(), 'dist', 'app');
const sourceCopy = process.argv[3]
  ?? join(process.env.HOME ?? '', '.humanagent', 'sessions', '-Users-fanzhang-.humanagent-workspace');
const sourceRepo = process.argv[4] ?? process.cwd();
const mod = (p) => new URL(`file://${join(compiledRoot, p)}`).href;

const { startUiRuntime } = await import(mod('app/src/ui-runtime/index.js'));
const { AccessControlService } = await import(mod('app/src/ui-runtime/access-control.js'));
const { createProviderExplicitBrainInterpreter } = await import(mod('app/src/explicit-brain-runtime.js'));
const { JsonlInteractionParentTurnJournal } = await import(mod('adapters/jsonl/src/interaction-parent-turn-journal.js'));
const { JsonlInteractionHelperJournal } = await import(mod('adapters/jsonl/src/interaction-helper-journal.js'));
const { JsonlOrganJournal } = await import(mod('adapters/jsonl/src/index.js'));
const { ImmutableAssetStore } = await import(mod('adapters/filesystem/src/index.js'));
const { filesystemProviderEvidenceSink } = await import(mod('adapters/provider/src/index.js'));
const { providerRawContentReader } = await import(mod('adapters/provider/src/evidence.js'));
const { acquireDaemonLease } = await import(mod('app/src/supervisor/index.js'));
const { resolveRuntimePaths } = await import(mod('config/src/index.js'));
const { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport } = await import(mod('adapters/provider/src/index.js'));
const { id } = await import(mod('contracts/src/index.js'));
const { MemoryCoordinator } = await import(mod('runtime/src/memory/index.js'));
const { DeterministicMemoryBackend } = await import(mod('adapters/memory/src/index.js'));

const projectKey = '-Users-fanzhang-.humanagent-workspace';
const workspace = '/Users/fanzhang/.humanagent/workspace';
const tmp = await realpath(await mkdtemp(join(tmpdir(), 'ptor-blackbox-')));
const controlRoot = join(tmp, 'control');
const projectRoot = join(controlRoot, 'sessions', projectKey);
await mkdir(join(controlRoot, 'sessions'), { recursive: true });
await cp(sourceCopy, projectRoot, { recursive: true });
await writeFile(join(controlRoot, 'internal.toml'), [
  'schemaVersion = 1',
  `controlRoot = "${controlRoot}"`,
  `agentCwd = "${controlRoot}"`,
  `sessionRoot = "${join(controlRoot, 'sessions')}"`,
  `pluginManifest = "${join(controlRoot, 'plugins', 'manifest.json')}"`,
  'releaseChannel = "stable"',
  'configPolicy = "internal-overrides-user"',
  '',
].join('\n'));

// The copied lease names the production pid. Neutralize it so a takeover in the
// copy can never signal the live production daemon.
const leasePath = join(projectRoot, 'daemon', 'lease.json');
const originalLease = JSON.parse(await readFile(leasePath, 'utf8'));
await writeFile(leasePath, JSON.stringify({ ...originalLease, pid: 999999, controlEndpoint: undefined }, null, 2));
console.log(JSON.stringify({ stage: 'copy', projectRoot, neutralizedPid: originalLease.pid }));

// mode 'fake' resolves its journal at <checkpointRoot>/fake, so point that at
// the copied production rcc journal instead of duplicating 66MB.
const checkpointRoot = join(tmp, 'checkpoints');
await mkdir(join(checkpointRoot), { recursive: true });
await symlink(join(projectRoot, 'checkpoints', 'ui-runtime', 'rcc'), join(checkpointRoot, 'fake'), 'dir');
const journal = new JsonlOrganJournal(join(projectRoot, 'checkpoints', 'ui-runtime', 'rcc', 'task-control.jsonl'));
const parentJournal = new JsonlInteractionParentTurnJournal(journal);
const helperJournal = new JsonlInteractionHelperJournal(journal);
// The copied journal carries absolute production locators. Redirect those reads
// at the copied asset directory; every write still lands in the copy.
const copyEvidenceRoot = join(projectRoot, 'artifacts', 'ui-provider-evidence');
const productionEvidenceRoot = '/Users/fanzhang/.humanagent/sessions/-Users-fanzhang-.humanagent-workspace/artifacts/ui-provider-evidence';
const store = new ImmutableAssetStore(copyEvidenceRoot);
const innerSink = filesystemProviderEvidenceSink(store);
const evidence = {
  write: innerSink.write,
  read: (ref) => innerSink.read(ref.locator.startsWith(productionEvidenceRoot)
    ? { ...ref, locator: join(copyEvidenceRoot, ref.evidenceId.value) }
    : ref),
};
const rawContent = providerRawContentReader(evidence);

const binding = {
  bindingId: 'rcc-entry', providerId: 'rcc', protocol: 'responses',
  endpointRef: 'rcc-v3:127.0.0.1:4444', modelRef: 'MiniMax-M3',
  configDigest: 'sha256:9510e383543a4943f038dd897299343e47709dd72d0da01499c9c3d79dc770c2',
  capabilityDigest: 'sha256:a9b236604ab6276abd46474191b23033a312add823',
};

class RecordedPort extends ProviderAdapter {
  constructor() {
    const transport = new V3ProviderHttpTransport({
      binding, baseUrl: 'http://recorded.test', source: 'http', evidence,
      fetch: async () => ({ status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: (async function* () {
          const enc = new TextEncoder();
          const frame = (v) => enc.encode(`data: ${JSON.stringify(v)}\n\n`);
          const decision = JSON.stringify({
            kind: 'requirement', normalizedInput: '黑盒复现输入', knownFacts: [],
            proposal: { revision: 1, intent: 'create', title: '黑盒复现输入', objective: '黑盒复现输入',
              deliverable: '结果', deliveryConditions: [], evidenceRefs: [], blockingGaps: [] },
            decisionRefs: [],
          });
          yield frame({ type: 'response.created', response: { id: 'recorded' } });
          yield frame({ type: 'response.output_text.done', item_id: 'text-0', text: decision });
          yield frame({ type: 'response.completed', response: { id: 'recorded', status: 'completed',
            usage: { input_tokens: 1, output_tokens: 1 } } });
        })(), text: async () => '' }),
    });
    super({ binding, routeRef: 'recorded', codec: new ResponsesProviderCodec(), transport, evidence });
  }
}

const paths = await resolveRuntimePaths({ controlRoot, workspace });
console.log(JSON.stringify({ stage: 'paths', projectRoot: paths.projectRoot, projectKey: paths.projectKey }));
const lease = await acquireDaemonLease(paths, { takeover: {
  reason: 'isolated 12c0721 blackbox takeover of copied root', allowed: () => true,
  stop: { gracefulTimeoutMs: 2_000, pollIntervalMs: 20 },
} });
console.log(JSON.stringify({ stage: 'lease', generation: lease.record.generation,
  takeoverTermination: lease.record.takeover?.termination,
  terminations: (lease.record.terminations ?? []).map((t) => t.previousGeneration) }));

const accessControl = await AccessControlService.open({
  credentialPath: join(projectRoot, 'security', 'web-access.json'), create: true,
});
const session = await accessControl.consumePairingCode((await accessControl.issuePairingChallenge()).code);
const cookie = accessControl.sessionCookie(session).split(';')[0];

const interpreter = createProviderExplicitBrainInterpreter({
  lease, binding, templateRoot: join(sourceRepo, 'packages', 'agent-templates', 'templates'),
  organId: id('organ', 'humanagent-ui'),
  interactionScopeId: `runtime:${projectKey}`,
  parentJournal, helperJournal, turnHelperJournal: helperJournal, checkpointJournal: helperJournal,
  rawEvidence: evidence, rawContent, clock: { now: () => new Date().toISOString() },
  helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
  port: new RecordedPort(),
});

const runtime = await startUiRuntime({
  mode: 'fake', organId: id('organ', 'humanagent-ui'), binding,
  port: new RecordedPort(), checkpointRoot, evidenceRoot: join(projectRoot, 'artifacts', 'ui-provider-evidence'),
  uiRoot: join(sourceRepo, 'docs', 'ui'), host: '127.0.0.1', portNumber: 0,
  productRoot: controlRoot, accessControl, lease, explicitBrainInterpreter: interpreter,
  projectKey,
  memory: { coordinator: new MemoryCoordinator(), backend: new DeterministicMemoryBackend(),
    projectKey: 'ptor-blackbox', roleId: 'execution' },
});
const base = runtime.server.url;
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, { method,
    headers: { cookie, origin: new URL(base).origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 700) };
};

const received = await call('POST', '/api/explicit/inputs', {
  sourceRef: 'blackbox:12c0721', rawInput: '修复后应当不被卡死的新输入', channel: 'business',
});
console.log(JSON.stringify({ stage: 'receive', ...received }));
if (received.status !== 201) { await runtime.server.close(); await lease.release(); await rm(tmp, { recursive: true, force: true }); process.exit(1); }
const interactionId = JSON.parse(received.body).interactionId;

const interpreted = await call('POST', `/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {});
console.log(JSON.stringify({ stage: 'interpret', interactionId, ...interpreted }));

const failures = await parentJournal.readScopeExecutionFailures({
  organId: id('organ', 'humanagent-ui'), interactionScopeId: `runtime:${projectKey}`,
});
console.log(JSON.stringify({ stage: 'closure', executionFailures: failures.map((f) => ({
  turnId: f.fact.turn.turnId, epoch: f.fact.execution.executionEpoch,
})) }));

await runtime.server.close();
await lease.release();
if (process.env.PTOR_KEEP === '1') {
  console.log(JSON.stringify({ stage: 'kept', root: tmp }));
} else {
  await rm(tmp, { recursive: true, force: true });
  console.log(JSON.stringify({ stage: 'cleaned' }));
}
