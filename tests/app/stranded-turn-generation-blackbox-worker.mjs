#!/usr/bin/env node
/**
 * One daemon generation of the stranded-turn generation black box.
 *
 * A generation belongs to one process start token, so every generation of this
 * black box is a real child process: `strand` owns the first generation and is
 * killed mid-Provider-stream, `crash` takes the lease over and exits without
 * releasing it, and `serve` takes the lease over again and serves the next
 * input. Nothing here is simulated: the lease, the takeover receipts, the
 * journals, the HTTP API and the Provider transport are the real ones. The only
 * controlled piece is the external Provider upstream, which lives in the parent
 * script.
 *
 * The parent reads one `BLACKBOX <json>` line from stdout per role.
 */

import { join } from 'node:path';

const role = process.env.HUMANAGENT_BLACKBOX_ROLE;
const root = process.env.HUMANAGENT_BLACKBOX_ROOT;
const upstreamUrl = process.env.HUMANAGENT_BLACKBOX_UPSTREAM;
if (!role || !root || !upstreamUrl) throw new Error('the black box worker needs role, root and upstream');

const dist = join(process.cwd(), 'dist/app');
const { startUiRuntime } = await import(join(dist, 'app/src/ui-runtime/index.js'));
const { AccessControlService } = await import(join(dist, 'app/src/ui-runtime/access-control.js'));
const { acquireDaemonLease } = await import(join(dist, 'app/src/supervisor/index.js'));
const { ensureControlLayout, resolveRuntimePaths } = await import(join(dist, 'config/src/index.js'));
const { MemoryCoordinator } = await import(join(dist, 'runtime/src/memory/index.js'));
const { DeterministicMemoryBackend } = await import(join(dist, 'adapters/memory/src/index.js'));
const { ImmutableAssetStore } = await import(join(dist, 'adapters/filesystem/src/index.js'));
const { ProviderAdapter, ResponsesProviderCodec, V3ProviderHttpTransport, filesystemProviderEvidenceSink } =
  await import(join(dist, 'adapters/provider/src/index.js'));
const { id } = await import(join(dist, 'contracts/src/index.js'));

const announce = (payload) => {
  process.stdout.write(`BLACKBOX ${JSON.stringify(payload)}\n`);
};

const paths = await resolveRuntimePaths({
  controlRoot: join(root, 'control'),
  workspace: join(root, 'workspace'),
});
await ensureControlLayout(paths);

// Generation 1 is a plain acquire. Every later generation is a real takeover of
// the recorded owner, so the lease itself writes the termination receipt.
const lease = role === 'strand'
  ? await acquireDaemonLease(paths)
  : await acquireDaemonLease(paths, {
    takeover: {
      reason: `blackbox ${role} takeover`,
      allowed: () => true,
      stop: { gracefulTimeoutMs: 5_000, pollIntervalMs: 50 },
    },
  });
const generation = lease.record.generation;

if (role === 'crash') {
  // A crashed owner: the lease stays recorded and is never released.
  announce({ role, generation, leaseId: lease.record.leaseId, pid: process.pid });
  process.exit(0);
}

const evidenceRoot = join(root, 'assets');
const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(evidenceRoot));
const binding = {
  bindingId: 'binding-stranded-generation-blackbox',
  providerId: 'provider-stranded-generation-blackbox',
  protocol: 'responses',
  endpointRef: 'http://stranded-generation-upstream',
  modelRef: 'model-stranded-generation-blackbox',
  configDigest: 'sha256:stranded-generation-blackbox-config',
  capabilityDigest: 'sha256:stranded-generation-blackbox-capability',
};
// A direct HTTP source has no RCC discovery probe, so the startup readiness read
// never claims a fabricated remote state and never calls the upstream.
const composition = () => ({
  roleId: 'interaction',
  source: 'http',
  provider: {
    source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
    model: binding.modelRef, route: 'stranded/generation-blackbox', baseUrl: upstreamUrl,
  },
  binding,
  port: new ProviderAdapter({
    binding,
    routeRef: 'stranded/generation-blackbox',
    codec: new ResponsesProviderCodec(),
    transport: new V3ProviderHttpTransport({ binding, baseUrl: upstreamUrl, source: 'http', evidence }),
    evidence,
  }),
});

const accessControl = await AccessControlService.open({
  credentialPath: paths.webAccessCredentialPath,
  create: role === 'strand',
});
const runtime = await startUiRuntime({
  mode: 'rcc',
  organId: id('organ', 'stranded-generation-blackbox'),
  binding,
  port: composition().port,
  providerSource: 'http',
  productRoot: root,
  checkpointRoot: join(root, 'checkpoints'),
  evidenceRoot,
  uiRoot: join(process.cwd(), 'docs/ui'),
  portNumber: 0,
  lease,
  accessControl,
  explicitBrainTemplateRoot: join(process.cwd(), 'packages/agent-templates/templates'),
  memory: {
    coordinator: new MemoryCoordinator(),
    backend: new DeterministicMemoryBackend(),
    projectKey: 'stranded-generation-blackbox',
  },
  runtimeComposition: {
    prepareAgentProvider: async () => composition(),
    prepareTaskAgentProvider: async () => { throw new Error('a simple answer must not prepare a Task'); },
  },
});

const challenge = await accessControl.issuePairingChallenge();
announce({
  role,
  generation,
  leaseId: lease.record.leaseId,
  pid: process.pid,
  origin: runtime.server.url,
  pairingCode: challenge.code,
});

const close = async () => {
  await runtime.close();
  await lease.release();
  process.exit(0);
};
const closeOrFail = () => { void close().catch((error) => { console.error(error); process.exit(1); }); };
process.on('SIGTERM', closeOrFail);
process.on('SIGINT', closeOrFail);
