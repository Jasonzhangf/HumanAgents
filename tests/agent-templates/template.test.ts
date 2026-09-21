import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cwd } from 'node:process';
import test from 'node:test';
import {
  AgentTemplateError,
  AGENT_ROLE_IDS,
  assertUniqueTemplateOwners,
  builtinAgentTemplateRegistry,
  compileAgentTemplate,
  createFilePromptSource,
  digestAgentTemplate,
  digestModeCapabilityProfile,
  digestPromptSegments,
  loadAgentTemplate,
  loadBuiltinAgentTemplate,
  loadBuiltinPromptRegistry,
  loadBuiltinPromptSegments,
  loadAgentPromptSegments,
  validateAgentTemplate,
  validateConfiguredAgentBinding,
  type AgentRole,
  type AgentModeCapabilityProfiles,
  type AgentTemplateManifest,
  type AgentTemplateRegistry,
} from '../../packages/agent-templates/src/index.js';

const registry: AgentTemplateRegistry = {
  capabilities: [
    'input.receive',
    'input.normalize',
    'task.match',
    'task.query',
    'status.explain',
    'intent.confirm',
    'plan',
    'resource.allocate',
    'queue.query',
    'assignment.create',
    'result.submit',
    'review.orchestrate',
    'worker.execute',
    'search',
    'coding',
    'test',
    'build',
    'audit.read',
    'architecture.review',
    'baseline.review',
    'quality.review',
    'security.review',
    'delivery.review',
    'memory.search',
    'memory.ask',
    'task.history',
    'session.history',
    'recurrence',
    'novelty',
  ],
  skills: [
    'input-normalization',
    'task-matching',
    'status-explanation',
    'confirmation',
    'stage-planning',
    'resource-planning',
    'result-checking',
    'review-orchestration',
    'single-capability-worker',
    'audit-standards',
    'evidence-review',
    'history-search',
    'novelty-review',
    'recurrence-review',
  ],
  toolCapabilities: [
    'input.receive',
    'task.query',
    'proposal.render',
    'queue.query',
    'resource.query',
    'assignment.create',
    'result.submit',
    'search',
    'coding',
    'test',
    'build',
    'read.audit',
    'test.audit',
    'result.audit',
    'memory.search',
    'memory.ask',
    'task.history',
    'session.history',
  ],
};

function modeCapabilityProfile(role: AgentRole): AgentModeCapabilityProfiles {
  const project = role === 'orchestration';
  const observation = {
    profileId: `test/${role}/observation`,
    role,
    mode: 'observation' as const,
    observationScopes: ['self', 'task', 'evidence'] as const,
    observationCapabilities: ['read-assignment'],
    orchestrationScope: project ? 'project' as const : 'local' as const,
    orchestrationCapabilities: ['plan-own-tool-steps'],
    capabilityDigest: '',
  };
  observation.capabilityDigest = digestModeCapabilityProfile(observation);
  const orchestration = {
    ...observation,
    profileId: `test/${role}/orchestration`,
    mode: 'orchestration' as const,
    capabilityDigest: '',
  };
  orchestration.capabilityDigest = digestModeCapabilityProfile(orchestration);
  return {
    observation,
    orchestration,
  };
}

function template(overrides: Partial<AgentTemplateManifest> = {}): AgentTemplateManifest {
  const manifest: AgentTemplateManifest = {
    kind: 'humanagent.agent-template',
    templateApiVersion: 1,
    roleId: 'execution',
    templateVersion: '1.0.0',
    capabilityRefs: ['worker.execute', 'test'],
    skillRefs: ['single-capability-worker'],
    toolCapabilityRefs: ['test'],
    builtInTools: [],
    promptSegmentRefs: ['execution/identity.md', 'execution/contract.md'],
    modeCapabilityProfile: modeCapabilityProfile('execution'),
    inputSchemaRef: 'execution/schemas/input.json',
    outputSchemaRef: 'execution/schemas/output.json',
    policyRef: 'execution/policies/worker.json',
    observationProjectionRef: 'execution/projection/worker.json',
    testFixtureRefs: ['execution/tests/success.json', 'execution/tests/denied.json'],
    memoryContextPolicy: {
      allowedScopes: ['task', 'organ'],
      allowedLayers: ['current', 'task-recent'],
      maxTokenBudget: 4096,
      required: true,
    },
    driverRequirements: {
      allowedDriverKinds: ['fake', 'dsh'],
      requiredCapabilities: ['execute', 'settle'],
    },
    digest: '',
    ...overrides,
  };
  return { ...manifest, digest: overrides.digest ?? digestAgentTemplate(manifest) };
}

test('valid template deterministically validates, compiles, and loads', () => {
  const manifest = template();
  assert.doesNotThrow(() => validateAgentTemplate(manifest, registry));
  const compiled = compileAgentTemplate(manifest, registry);
  assert.deepEqual(compiled, compileAgentTemplate(manifest, registry));
  assert.equal(compiled.manifestDigest, manifest.digest);
  assert.deepEqual(compiled.capabilityRefs, ['worker.execute', 'test']);
  assert.deepEqual(compiled.promptSegmentRefs, ['execution/identity.md', 'execution/contract.md']);
  assert.equal(compiled.promptSegmentDigest, digestPromptSegments(manifest.promptSegmentRefs));
  assert.deepEqual(compiled.memoryContextPolicy.allowedScopes, ['task', 'organ']);

  const loaded = loadAgentTemplate(compiled, { driverKind: 'fake', driverCapabilities: ['execute', 'settle'] });
  assert.equal(loaded.driverKind, 'fake');
  assert.deepEqual(loaded.driverCapabilities, ['execute', 'settle']);
  assert.equal(loaded.roleId, 'execution');
});

test('invalid manifest fields, paths, fixtures, and memory policy are rejected', () => {
  assert.throws(() => validateAgentTemplate(template({ templateApiVersion: 2 }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ roleId: 'worker' as AgentRole }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ templateVersion: 'latest' }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ promptSegmentRefs: [] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ promptSegmentRefs: ['execution/identity.md', 'execution/identity.md'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ promptSegmentRefs: ['../secret.md'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ promptSegmentRefs: ['/execution/identity.md'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ promptSegmentRefs: ['execution/../review.md'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ promptSegmentRefs: ['execution\\identity.md'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ promptSegmentRefs: ['execution/identity.txt'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ promptSegmentRefs: ['review/audit.md'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ testFixtureRefs: [] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({
    memoryContextPolicy: {
      allowedScopes: ['global' as 'task'],
      allowedLayers: ['current'],
      maxTokenBudget: 100,
      required: false,
    },
  }), registry), AgentTemplateError);
  const profile = modeCapabilityProfile('execution');
  assert.throws(() => validateAgentTemplate(template({
    modeCapabilityProfile: {
      ...profile,
      observation: { ...profile.observation, observationCapabilities: ['modify-control-plane'] },
    },
  }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({
    modeCapabilityProfile: {
      ...profile,
      observation: { ...profile.observation, capabilityDigest: `sha256:${'b'.repeat(64)}` },
    },
  }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ digest: 'fnv1a:stale' }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({
    modeCapabilityProfile: {
      ...modeCapabilityProfile('execution'),
      orchestration: { ...modeCapabilityProfile('execution').orchestration, orchestrationScope: 'project' },
    },
  }), registry), AgentTemplateError);
});

test('prompt segment order is part of the compiled contract without loading prompt content', () => {
  const first = template({ promptSegmentRefs: ['execution/identity.md', 'execution/contract.md'] });
  const second = template({ promptSegmentRefs: ['execution/contract.md', 'execution/identity.md'] });
  const firstCompiled = compileAgentTemplate(first, registry);
  const secondCompiled = compileAgentTemplate(second, registry);

  assert.notEqual(firstCompiled.promptSegmentDigest, secondCompiled.promptSegmentDigest);
  assert.deepEqual(firstCompiled.promptSegmentRefs, first.promptSegmentRefs);
  assert.deepEqual(secondCompiled.promptSegmentRefs, second.promptSegmentRefs);
  assert.equal('prompt' in firstCompiled, false);
});

test('undeclared capabilities, skills, tools, and role ceiling violations are rejected', () => {
  assert.throws(() => validateAgentTemplate(template({ capabilityRefs: ['worker.execute', 'inspect'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ skillRefs: ['missing-skill'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ toolCapabilityRefs: ['root.shell'] }), registry), AgentTemplateError);
  assert.throws(() => validateAgentTemplate(template({ roleId: 'review', capabilityRefs: ['worker.execute'], skillRefs: ['audit-standards'], toolCapabilityRefs: ['read.audit'] }), registry), AgentTemplateError);
});

test('duplicate template owners are rejected independently of template digests', () => {
  assert.doesNotThrow(() => assertUniqueTemplateOwners([
    { roleId: 'execution', templateVersion: '1.0.0', ownerId: 'owner-a' },
    { roleId: 'review', templateVersion: '1.0.0', ownerId: 'owner-b' },
  ]));
  assert.throws(() => assertUniqueTemplateOwners([
    { roleId: 'execution', templateVersion: '1.0.0', ownerId: 'owner-a' },
    { roleId: 'execution', templateVersion: '1.0.0', ownerId: 'owner-b' },
  ]), AgentTemplateError);
  assert.throws(() => assertUniqueTemplateOwners([
    { roleId: 'execution', templateVersion: '1.0.0', ownerId: 'owner-a' },
    { roleId: 'review', templateVersion: '1.0.0', ownerId: 'owner-a' },
  ]), AgentTemplateError);
});

test('load rejects a driver outside the template contract or missing required capabilities', () => {
  const compiled = compileAgentTemplate(template(), registry);
  assert.throws(() => loadAgentTemplate(compiled, { driverKind: 'remote', driverCapabilities: ['execute', 'settle'] }), AgentTemplateError);
  assert.throws(() => loadAgentTemplate(compiled, { driverKind: 'fake', driverCapabilities: ['execute'] }), AgentTemplateError);
  assert.throws(() => loadAgentTemplate(compiled, { driverKind: 'fake', driverCapabilities: ['execute', 'settle', 'settle'] }), AgentTemplateError);
});

test('configured agent bindings enable fake and explicit dsh drivers without implicit fallback', () => {
  assert.doesNotThrow(() => validateConfiguredAgentBinding({
    roleId: 'execution',
    templateRef: 'builtin/execution@1.0.0',
    driverRef: 'fake',
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
  }));
  assert.doesNotThrow(() => validateConfiguredAgentBinding({
    roleId: 'execution',
    templateRef: 'builtin/execution@1.0.0',
    driverRef: 'dsh',
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
  }));
  assert.throws(() => validateConfiguredAgentBinding({
    roleId: 'execution',
    templateRef: 'builtin/execution@1.0.0',
    driverRef: 'remote',
    skills: ['single-capability-worker'],
    tools: ['search'],
    permissions: ['task.read', 'workspace.read'],
  }), AgentTemplateError);
});

test('prompt segments are loaded from independent markdown files in manifest order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-prompts-'));
  await mkdir(join(root, 'execution'), { recursive: true });
  await writeFile(join(root, 'execution', 'identity.md'), '# Identity\n', 'utf8');
  await writeFile(join(root, 'execution', 'contract.md'), '# Contract\n', 'utf8');

  const compiled = compileAgentTemplate(template(), registry);
  const loaded = await loadAgentPromptSegments(compiled, createFilePromptSource(root));
  assert.deepEqual(loaded.segments.map((segment) => segment.ref), compiled.promptSegmentRefs);
  assert.deepEqual(loaded.segments.map((segment) => segment.content), ['# Identity\n', '# Contract\n']);
  assert.match(loaded.contentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(loaded.contentDigest, compiled.promptSegmentDigest);
});

test('prompt loader rejects missing markdown files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-prompts-'));
  await mkdir(join(root, 'execution'), { recursive: true });
  const compiled = compileAgentTemplate(template(), registry);
  await assert.rejects(
    () => loadAgentPromptSegments(compiled, createFilePromptSource(root)),
    AgentTemplateError,
  );
});

test('builtin roles resolve all external markdown prompt segments', async () => {
  const templateRoot = join(cwd(), 'packages', 'agent-templates', 'templates');
  const registry = await loadBuiltinPromptRegistry(templateRoot);
  for (const roleId of AGENT_ROLE_IDS) {
    const loaded = await loadBuiltinPromptSegments(roleId, templateRoot);
    assert.equal(loaded.segments.length, registry.roles[roleId].length);
    assert.ok(loaded.segments.every((segment) => segment.content.trim().length > 0));
    assert.match(loaded.contentDigest, /^sha256:[0-9a-f]{64}$/);
  }
});

test('code search Gateway is exposed to orchestration only and is prompt-preferred', async () => {
  const templateRoot = join(cwd(), 'packages', 'agent-templates', 'templates');
  const orchestration = await loadBuiltinAgentTemplate(templateRoot, 'orchestration', '1.1.0');
  assert.ok(orchestration.toolCapabilityRefs.includes('code.search'));
  assert.deepEqual(
    builtinAgentTemplateRegistry('execution', '1.1.0').toolCapabilities,
    ['search', 'coding', 'test', 'build'],
  );
  for (const roleId of ['interaction', 'execution', 'review', 'memory'] as const) {
    const manifest = await loadBuiltinAgentTemplate(templateRoot, roleId, '1.1.0');
    assert.equal(manifest.toolCapabilityRefs.includes('code.search'), false, `${roleId} must not receive code.search`);
  }

  const prompt = await loadBuiltinPromptSegments('orchestration', templateRoot, '1.1.0');
  const promptContent = prompt.segments.map((segment) => segment.content).join('\n');
  assert.match(promptContent, /优先调用 `code\.search` Gateway/);
  assert.match(promptContent, /scope-too-large/);
  assert.match(promptContent, /不得伪造 Gateway 成功/);
});

test('checkpoint built-ins are role-scoped and re-entry remains Harness-owned', async () => {
  const templateRoot = join(cwd(), 'packages', 'agent-templates', 'templates');
  const expected = {
    interaction: ['checkpoint.inspect'],
    orchestration: ['checkpoint.inspect', 'checkpoint.recall', 'checkpoint.save', 'checkpoint.record-dead-end'],
    execution: ['checkpoint.inspect', 'checkpoint.save', 'checkpoint.record-dead-end'],
    review: ['checkpoint.inspect'],
    memory: ['checkpoint.inspect', 'checkpoint.recall'],
  } as const;
  for (const roleId of AGENT_ROLE_IDS) {
    const manifest = await loadBuiltinAgentTemplate(templateRoot, roleId, '1.1.0');
    assert.deepEqual(manifest.builtInTools, expected[roleId]);
    assert.equal(manifest.builtInTools.includes('checkpoint.reenter'), false);
  }
});

test('interaction 1.1.0 exposes only its versioned model-facing tools', () => {
  const current = builtinAgentTemplateRegistry('interaction', '1.1.0');
  assert.equal(current.toolCapabilities.includes('input.receive'), false);
  assert.equal(current.toolCapabilities.includes('proposal.render'), false);
  assert.equal(current.toolCapabilities.includes('interaction.propose'), true);
  assert.equal(current.toolCapabilities.includes('requirement.submit'), true);
});

test('builtin prompt loading rejects version and content drift', async () => {
  const sourceRoot = join(cwd(), 'packages', 'agent-templates', 'templates');
  const root = await mkdtemp(join(tmpdir(), 'humanagent-builtin-prompts-'));
  execFileSync('cp', ['-R', join(sourceRoot, 'builtin'), root]);
  await assert.rejects(
    () => loadBuiltinPromptSegments('execution', root, '2.0.0'),
    /unsupported builtin prompt registry version|version is not locked/,
  );
  await writeFile(join(root, 'builtin', 'execution', 'identity.md'), '# drift\n', 'utf8');
  await assert.rejects(
    () => loadBuiltinPromptSegments('execution', root, '1.0.0'),
    /content drift detected/,
  );
});

test('builtin template loading rejects a declared resource that is missing', async () => {
  const sourceRoot = join(cwd(), 'packages', 'agent-templates', 'templates');
  const root = await mkdtemp(join(tmpdir(), 'humanagent-builtin-template-'));
  execFileSync('cp', ['-R', join(sourceRoot, 'builtin'), root]);
  execFileSync('rm', [join(root, 'builtin', 'interaction', 'v1.1.0', 'policy.json')]);

  await assert.rejects(
    () => loadBuiltinAgentTemplate(root, 'interaction', '1.1.0'),
    /builtin template resource is missing: interaction\/v1\.1\.0\/policy\.json/,
  );
});

test('builtin template loading validates the manifest even without an external registry', async () => {
  const sourceRoot = join(cwd(), 'packages', 'agent-templates', 'templates');
  const root = await mkdtemp(join(tmpdir(), 'humanagent-builtin-template-invalid-'));
  execFileSync('cp', ['-R', join(sourceRoot, 'builtin'), root]);
  const manifestPath = join(root, 'builtin', 'interaction', 'v1.1.0', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AgentTemplateManifest;
  await writeFile(manifestPath, JSON.stringify({ ...manifest, digest: 'fnv1a:forged' }, null, 2) + '\n', 'utf8');

  await assert.rejects(
    () => loadBuiltinAgentTemplate(root, 'interaction', '1.1.0'),
    /template digest does not match its locked content/,
  );
});

test('builtin template loading rejects unsupported versions and loads all 1.1.0 profiles', async () => {
  const root = join(cwd(), 'packages', 'agent-templates', 'templates');

  await assert.rejects(
    () => loadBuiltinAgentTemplate(root, 'interaction', '2.0.0'),
    /unsupported builtin template version: interaction@2\.0\.0/,
  );
  for (const roleId of AGENT_ROLE_IDS) {
    const manifest = await loadBuiltinAgentTemplate(root, roleId, '1.1.0');
    assert.equal(manifest.modeCapabilityProfile.observation.mode, 'observation');
    assert.equal(manifest.modeCapabilityProfile.orchestration.mode, 'orchestration');
    if (roleId !== 'orchestration') assert.notEqual(manifest.modeCapabilityProfile.orchestration.orchestrationScope, 'project');
  }
});
