import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentTemplateError,
  assertUniqueTemplateOwners,
  compileAgentTemplate,
  digestAgentTemplate,
  digestPromptSegments,
  loadAgentTemplate,
  validateAgentTemplate,
  validateConfiguredAgentBinding,
  type AgentRole,
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

function template(overrides: Partial<AgentTemplateManifest> = {}): AgentTemplateManifest {
  const manifest: AgentTemplateManifest = {
    kind: 'humanagent.agent-template',
    templateApiVersion: 1,
    roleId: 'execution',
    templateVersion: '1.0.0',
    capabilityRefs: ['worker.execute', 'test'],
    skillRefs: ['single-capability-worker'],
    toolCapabilityRefs: ['test'],
    promptSegmentRefs: ['execution/identity.md', 'execution/contract.md'],
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
  assert.throws(() => validateAgentTemplate(template({ digest: 'fnv1a:stale' }), registry), AgentTemplateError);
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
