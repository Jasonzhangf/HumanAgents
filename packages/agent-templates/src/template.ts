import { AgentTemplateError } from './errors.js';
import {
  AGENT_ROLE_IDS,
  AGENT_TEMPLATE_API_VERSION,
  type AgentRole,
  type AgentTemplateLoadInput,
  type AgentTemplateManifest,
  type AgentTemplateOwner,
  type AgentTemplateRegistry,
  type AgentTemplateValidation,
  type CompiledAgentTemplate,
  type DriverRequirements,
  type LoadedAgentTemplate,
  type MemoryContextLayer,
  type MemoryContextPolicy,
  type MemoryContextScope,
} from './types.js';

const ROLE_CAPABILITIES: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: ['input.receive', 'input.normalize', 'task.match', 'task.query', 'status.explain', 'intent.confirm'],
  orchestration: ['plan', 'resource.allocate', 'queue.query', 'task.query', 'assignment.create', 'result.submit', 'review.orchestrate'],
  execution: ['worker.execute', 'search', 'coding', 'test', 'build'],
  review: ['audit.read', 'architecture.review', 'baseline.review', 'quality.review', 'security.review', 'delivery.review'],
  memory: ['memory.search', 'memory.ask', 'task.history', 'session.history', 'recurrence', 'novelty'],
};

const ROLE_SKILLS: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: ['input-normalization', 'task-matching', 'status-explanation', 'confirmation'],
  orchestration: ['stage-planning', 'resource-planning', 'result-checking', 'review-orchestration'],
  execution: ['single-capability-worker'],
  review: ['audit-standards', 'evidence-review'],
  memory: ['history-search', 'novelty-review', 'recurrence-review'],
};

const ROLE_TOOLS: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: ['input.receive', 'task.query', 'proposal.render'],
  orchestration: ['task.query', 'queue.query', 'resource.query', 'assignment.create', 'result.submit'],
  execution: ['search', 'coding', 'test', 'build'],
  review: ['read.audit', 'test.audit', 'result.audit'],
  memory: ['memory.search', 'memory.ask', 'task.history', 'session.history'],
};

const MEMORY_SCOPES: readonly MemoryContextScope[] = ['task', 'organ', 'approved-global'];
const MEMORY_LAYERS: readonly MemoryContextLayer[] = ['current', 'task-recent', 'related', 'approved-long-term', 'raw'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function assertNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) throw new AgentTemplateError(`${label} is required`);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new AgentTemplateError(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertSafeRef(value: string, label: string): void {
  assertNonEmpty(value, label);
  if (value.startsWith('/') || value.startsWith('\\') || value.split('/').includes('..') || value.includes('\0')) {
    throw new AgentTemplateError(`${label} must be a safe package-relative reference or registered id`);
  }
}

function assertSubset(values: readonly string[], allowed: readonly string[], label: string): void {
  for (const value of values) {
    if (!allowed.includes(value)) throw new AgentTemplateError(`${label} is not allowed for this role: ${value}`);
  }
}

function assertDeclared(values: readonly string[], declared: readonly string[], label: string): void {
  for (const value of values) {
    if (!declared.includes(value)) throw new AgentTemplateError(`undeclared ${label}: ${value}`);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function digestAgentTemplate(manifest: AgentTemplateManifest): string {
  const { digest: _digest, ...content } = manifest;
  return `fnv1a:${fnv1a(stableStringify(content))}`;
}

function assertMemoryPolicy(policy: MemoryContextPolicy): void {
  assertSubset(policy.allowedScopes, MEMORY_SCOPES, 'memory scope');
  assertSubset(policy.allowedLayers, MEMORY_LAYERS, 'memory context layer');
  assertUnique(policy.allowedScopes, 'memory scope');
  assertUnique(policy.allowedLayers, 'memory context layer');
  if (policy.allowedScopes.length === 0) throw new AgentTemplateError('memory context policy requires at least one scope');
  if (policy.allowedLayers.length === 0) throw new AgentTemplateError('memory context policy requires at least one layer');
  if (!Number.isSafeInteger(policy.maxTokenBudget) || policy.maxTokenBudget < 1) {
    throw new AgentTemplateError('memory context token budget must be a positive safe integer');
  }
}

function assertDriverRequirements(requirements: DriverRequirements): void {
  assertUnique(requirements.allowedDriverKinds, 'driver kind');
  assertUnique(requirements.requiredCapabilities, 'driver capability');
  assertNonEmpty(requirements.allowedDriverKinds.join(','), 'driver requirements');
  for (const kind of requirements.allowedDriverKinds) assertNonEmpty(kind, 'driver kind');
  for (const capability of requirements.requiredCapabilities) assertNonEmpty(capability, 'driver capability');
}

export function validateAgentTemplate(
  manifest: AgentTemplateManifest,
  registry: AgentTemplateRegistry,
): AgentTemplateValidation {
  if (manifest.kind !== 'humanagent.agent-template') throw new AgentTemplateError('invalid template kind');
  if (manifest.templateApiVersion !== AGENT_TEMPLATE_API_VERSION) {
    throw new AgentTemplateError(`unsupported template api version: ${manifest.templateApiVersion}`);
  }
  if (!AGENT_ROLE_IDS.includes(manifest.roleId)) throw new AgentTemplateError(`invalid role: ${manifest.roleId}`);
  if (!VERSION_PATTERN.test(manifest.templateVersion)) throw new AgentTemplateError('template version must be semver');
  if (manifest.extends && (manifest.extends.roleId !== '_base' || !VERSION_PATTERN.test(manifest.extends.version))) {
    throw new AgentTemplateError('template may only extend the _base role');
  }
  assertSafeRef(manifest.systemPromptRef, 'system prompt ref');
  assertSafeRef(manifest.inputSchemaRef, 'input schema ref');
  assertSafeRef(manifest.outputSchemaRef, 'output schema ref');
  assertSafeRef(manifest.policyRef, 'policy ref');
  assertSafeRef(manifest.observationProjectionRef, 'observation projection ref');
  for (const ref of manifest.testFixtureRefs) assertSafeRef(ref, 'test fixture ref');
  for (const ref of manifest.capabilityRefs) assertSafeRef(ref, 'capability ref');
  for (const ref of manifest.skillRefs) assertSafeRef(ref, 'skill ref');
  for (const ref of manifest.toolCapabilityRefs) assertSafeRef(ref, 'tool capability ref');

  assertUnique(manifest.capabilityRefs, 'capability ref');
  assertUnique(manifest.skillRefs, 'skill ref');
  assertUnique(manifest.toolCapabilityRefs, 'tool capability ref');
  assertUnique(manifest.testFixtureRefs, 'test fixture ref');
  assertSubset(manifest.capabilityRefs, ROLE_CAPABILITIES[manifest.roleId], 'capability');
  assertSubset(manifest.skillRefs, ROLE_SKILLS[manifest.roleId], 'skill');
  assertSubset(manifest.toolCapabilityRefs, ROLE_TOOLS[manifest.roleId], 'tool capability');
  assertDeclared(manifest.capabilityRefs, registry.capabilities, 'capability');
  assertDeclared(manifest.skillRefs, registry.skills, 'skill');
  assertDeclared(manifest.toolCapabilityRefs, registry.toolCapabilities, 'tool capability');
  assertMemoryPolicy(manifest.memoryContextPolicy);
  assertDriverRequirements(manifest.driverRequirements);
  if (manifest.testFixtureRefs.length === 0) throw new AgentTemplateError('template requires at least one test fixture');
  const expectedDigest = digestAgentTemplate(manifest);
  if (manifest.digest !== expectedDigest) throw new AgentTemplateError('template digest does not match its locked content');
  return {
    manifest,
    capabilityRefs: [...manifest.capabilityRefs],
    skillRefs: [...manifest.skillRefs],
    toolCapabilityRefs: [...manifest.toolCapabilityRefs],
  };
}

export function compileAgentTemplate(
  manifest: AgentTemplateManifest,
  registry: AgentTemplateRegistry,
): CompiledAgentTemplate {
  const validation = validateAgentTemplate(manifest, registry);
  return {
    roleId: validation.manifest.roleId,
    templateVersion: validation.manifest.templateVersion,
    capabilityRefs: [...validation.capabilityRefs],
    skillRefs: [...validation.skillRefs],
    toolCapabilityRefs: [...validation.toolCapabilityRefs],
    systemPromptRef: validation.manifest.systemPromptRef,
    inputSchemaRef: validation.manifest.inputSchemaRef,
    outputSchemaRef: validation.manifest.outputSchemaRef,
    policyRef: validation.manifest.policyRef,
    observationProjectionRef: validation.manifest.observationProjectionRef,
    memoryContextPolicy: {
      allowedScopes: [...validation.manifest.memoryContextPolicy.allowedScopes],
      allowedLayers: [...validation.manifest.memoryContextPolicy.allowedLayers],
      maxTokenBudget: validation.manifest.memoryContextPolicy.maxTokenBudget,
      required: validation.manifest.memoryContextPolicy.required,
    },
    driverRequirements: {
      allowedDriverKinds: [...validation.manifest.driverRequirements.allowedDriverKinds],
      requiredCapabilities: [...validation.manifest.driverRequirements.requiredCapabilities],
    },
    manifestDigest: validation.manifest.digest,
  };
}

export function loadAgentTemplate(
  template: CompiledAgentTemplate,
  input: AgentTemplateLoadInput,
): LoadedAgentTemplate {
  assertNonEmpty(input.driverKind, 'driver kind');
  assertUnique(input.driverCapabilities, 'driver capability');
  if (!template.driverRequirements.allowedDriverKinds.includes(input.driverKind)) {
    throw new AgentTemplateError(`driver is not allowed by template: ${input.driverKind}`);
  }
  for (const capability of template.driverRequirements.requiredCapabilities) {
    if (!input.driverCapabilities.includes(capability)) {
      throw new AgentTemplateError(`driver capability is missing: ${capability}`);
    }
  }
  return {
    ...template,
    capabilityRefs: [...template.capabilityRefs],
    skillRefs: [...template.skillRefs],
    toolCapabilityRefs: [...template.toolCapabilityRefs],
    memoryContextPolicy: {
      allowedScopes: [...template.memoryContextPolicy.allowedScopes],
      allowedLayers: [...template.memoryContextPolicy.allowedLayers],
      maxTokenBudget: template.memoryContextPolicy.maxTokenBudget,
      required: template.memoryContextPolicy.required,
    },
    driverRequirements: {
      allowedDriverKinds: [...template.driverRequirements.allowedDriverKinds],
      requiredCapabilities: [...template.driverRequirements.requiredCapabilities],
    },
    driverKind: input.driverKind,
    driverCapabilities: [...input.driverCapabilities],
  };
}

export function assertUniqueTemplateOwners(owners: readonly AgentTemplateOwner[]): void {
  const roleVersions = new Set<string>();
  const ownerIds = new Set<string>();
  for (const owner of owners) {
    assertNonEmpty(owner.ownerId, 'template owner id');
    const roleVersion = `${owner.roleId}@${owner.templateVersion}`;
    if (roleVersions.has(roleVersion)) throw new AgentTemplateError(`duplicate template owner: ${roleVersion}`);
    if (ownerIds.has(owner.ownerId)) throw new AgentTemplateError(`duplicate owner id: ${owner.ownerId}`);
    roleVersions.add(roleVersion);
    ownerIds.add(owner.ownerId);
  }
}
