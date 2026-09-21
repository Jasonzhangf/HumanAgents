import { createHash } from 'node:crypto';
import { AgentTemplateError } from './errors.js';
import {
  AGENT_ROLE_IDS,
  AGENT_TEMPLATE_API_VERSION,
  type AgentRole,
  type AgentBuiltInTool,
  type AgentTemplateLoadInput,
  type AgentTemplateManifest,
  type AgentModeCapabilityProfile,
  type AgentModeCapabilityProfiles,
  type AgentTemplateOwner,
  type AgentTemplateRegistry,
  type AgentTemplateValidation,
  type ConfiguredAgentBinding,
  type CompiledAgentTemplate,
  type DriverRequirements,
  type LoadedAgentTemplate,
  type MemoryContextLayer,
  type MemoryContextPolicy,
  type MemoryContextScope,
} from './types.js';

const INTERACTION_1_0_CAPABILITIES = ['input.receive', 'input.normalize', 'task.match', 'task.query', 'status.explain', 'intent.confirm'] as const;
const INTERACTION_1_1_CAPABILITIES = [
  'input.receive',
  'input.normalize',
  'task.match',
  'task.query',
  'status.explain',
  'intent.confirm',
  'runtime.status',
  'queue.inspect',
  'resource.query',
  'workspace.list',
  'file.read',
  'file.search',
  'agent.query',
  'agent.message',
  'bug.query',
  'bug.inspect',
  'channel.query',
  'memory.search',
  'memory.inspect',
  'memory.compare',
  'memory.save_candidate',
  'memory.operation.status',
  'interaction.ask',
  'interaction.propose',
  'interaction.approve',
  'channel.reply',
  'channel.notify',
  'requirement.submit',
  'trigger.submit',
  'route.submit',
  'resource.request',
  'subscription.request',
  'attention.list',
  'attention.inspect',
  'attention.triage',
  'attention.ack',
  'attention.defer',
  'attention.notify',
  'attention.resolve',
  'bug.report',
  'bug.propose-update',
  'bug.resolve',
  'bug.reopen',
] as const;

const ROLE_CAPABILITIES: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: [...INTERACTION_1_0_CAPABILITIES, ...INTERACTION_1_1_CAPABILITIES.slice(INTERACTION_1_0_CAPABILITIES.length)],
  orchestration: ['plan', 'resource.allocate', 'queue.query', 'task.query', 'assignment.create', 'result.submit', 'review.orchestrate'],
  execution: ['worker.execute', 'search', 'coding', 'test', 'build'],
  review: ['audit.read', 'architecture.review', 'baseline.review', 'quality.review', 'security.review', 'delivery.review'],
  memory: ['memory.search', 'memory.ask', 'task.history', 'session.history', 'recurrence', 'novelty'],
};

const INTERACTION_1_0_SKILLS = ['input-normalization', 'task-matching', 'status-explanation', 'confirmation'] as const;
const INTERACTION_1_1_SKILLS = [
  'input-normalization',
  'channel-routing',
  'task-matching',
  'status-explanation',
  'confirmation',
  'attention-triage',
  'priority-classification',
  'async-memory-feedback',
  'error-notification',
] as const;

const ROLE_SKILLS: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: [...INTERACTION_1_1_SKILLS],
  orchestration: ['stage-planning', 'resource-planning', 'result-checking', 'review-orchestration'],
  execution: ['single-capability-worker'],
  review: ['audit-standards', 'evidence-review'],
  memory: ['history-search', 'novelty-review', 'recurrence-review'],
};

const INTERACTION_1_0_TOOLS = ['input.receive', 'task.query', 'proposal.render'] as const;
const INTERACTION_1_1_TOOLS = [
  'task.query',
  'task.match',
  'runtime.status',
  'queue.inspect',
  'resource.query',
  'workspace.list',
  'file.read',
  'file.search',
  'agent.query',
  'agent.message',
  'bug.query',
  'bug.inspect',
  'channel.query',
  'memory.search',
  'memory.inspect',
  'memory.compare',
  'memory.save_candidate',
  'memory.operation.status',
  'interaction.ask',
  'interaction.propose',
  'interaction.approve',
  'channel.reply',
  'channel.notify',
  'requirement.submit',
  'trigger.submit',
  'route.submit',
  'resource.request',
  'subscription.request',
  'attention.list',
  'attention.inspect',
  'attention.triage',
  'attention.ack',
  'attention.defer',
  'attention.notify',
  'attention.resolve',
  'bug.report',
  'bug.propose-update',
  'bug.resolve',
  'bug.reopen',
] as const;

const ROLE_TOOLS: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: [...INTERACTION_1_0_TOOLS, ...INTERACTION_1_1_TOOLS.filter((tool) => !INTERACTION_1_0_TOOLS.includes(tool as never))],
  orchestration: ['task.query', 'queue.query', 'resource.query', 'assignment.create', 'result.submit', 'code.search'],
  execution: ['search', 'coding', 'test', 'build'],
  review: ['read.audit', 'test.audit', 'result.audit'],
  memory: ['memory.search', 'memory.ask', 'task.history', 'session.history'],
};

const ROLE_BUILT_IN_TOOLS: Readonly<Record<AgentRole, readonly AgentBuiltInTool[]>> = {
  interaction: ['checkpoint.inspect'],
  orchestration: ['checkpoint.inspect', 'checkpoint.recall', 'checkpoint.save', 'checkpoint.record-dead-end'],
  execution: ['checkpoint.inspect', 'checkpoint.save', 'checkpoint.record-dead-end'],
  review: ['checkpoint.inspect'],
  memory: ['checkpoint.inspect', 'checkpoint.recall'],
};
const ALL_BUILT_IN_TOOLS: readonly AgentBuiltInTool[] = [
  'checkpoint.inspect',
  'checkpoint.recall',
  'checkpoint.save',
  'checkpoint.record-dead-end',
  'checkpoint.reenter',
];

const MEMORY_SCOPES: readonly MemoryContextScope[] = ['task', 'organ', 'approved-global'];
const MEMORY_LAYERS: readonly MemoryContextLayer[] = ['current', 'task-recent', 'related', 'approved-long-term', 'raw'];
const OBSERVATION_SCOPES = ['self', 'task', 'project', 'evidence', 'memory'] as const;
const ORCHESTRATION_SCOPES = ['local', 'project'] as const;
const MODE_OBSERVATION_CAPABILITIES: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: ['read-input', 'read-task-state', 'read-related-memory'],
  orchestration: ['read-project-projection', 'read-worker-session', 'read-evidence', 'read-memory-projection'],
  execution: ['read-assignment', 'read-evidence', 'read-own-session'],
  review: ['read-candidate', 'read-acceptance', 'read-evidence'],
  memory: ['read-history', 'read-session', 'read-memory-source'],
};
const MODE_ORCHESTRATION_CAPABILITIES: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: ['route-input', 'ask-user', 'submit-confirmed-requirement'],
  orchestration: ['create-phase', 'create-assignment', 'request-review', 'request-merge'],
  execution: ['plan-own-tool-steps'],
  review: ['plan-review-checks', 'request-remediation'],
  memory: ['plan-memory-curation', 'propose-skill-candidate'],
};
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTERACTION_1_0_PERMISSIONS = ['task.read', 'task.propose'] as const;
const INTERACTION_1_1_PERMISSIONS = [
  'task.read',
  'task.propose',
  'runtime.read',
  'queue.read',
  'resource.read',
  'workspace.read',
  'agent.read',
  'agent.message',
  'bug.read',
  'bug.report',
  'bug.propose-update',
  'bug.resolve',
  'bug.reopen',
  'channel.read',
  'channel.reply',
  'channel.notify',
  'memory.read',
  'memory.propose',
  'attention.read',
  'attention.triage',
  'attention.ack',
  'attention.defer',
  'attention.notify',
  'attention.resolve',
  'requirement.submit',
  'trigger.submit',
  'route.submit',
  'resource.request',
  'subscription.request',
] as const;

const ROLE_PERMISSIONS: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: [...INTERACTION_1_0_PERMISSIONS, ...INTERACTION_1_1_PERMISSIONS.slice(INTERACTION_1_0_PERMISSIONS.length)],
  orchestration: ['task.read', 'assignment.create', 'review.schedule'],
  execution: ['task.read', 'assignment.execute', 'workspace.read', 'workspace.write'],
  review: ['task.read', 'review.read'],
  memory: ['task.read', 'memory.read', 'memory.propose'],
};

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

function assertPromptSegmentRef(value: string, roleId: AgentRole): void {
  assertNonEmpty(value, 'prompt segment ref');
  const segments = value.split('/');
  if (
    value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || !value.endsWith('.md')
  ) {
    throw new AgentTemplateError('prompt segment ref must be a safe package-relative Markdown file');
  }
  if (segments[0] !== roleId && segments[0] !== 'common') {
    throw new AgentTemplateError(`prompt segment ref must stay within the ${roleId} role directory or common directory`);
  }
}

export function validatePromptSegmentRefs(roleId: AgentRole, refs: readonly string[]): void {
  if (refs.length === 0) throw new AgentTemplateError('template requires at least one prompt segment');
  for (const ref of refs) assertPromptSegmentRef(ref, roleId);
  assertUnique(refs, 'prompt segment ref');
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

function roleCapabilities(roleId: AgentRole, version: string): readonly string[] {
  return roleId === 'interaction' && version === '1.0.0' ? INTERACTION_1_0_CAPABILITIES : ROLE_CAPABILITIES[roleId];
}

function roleSkills(roleId: AgentRole, version: string): readonly string[] {
  return roleId === 'interaction' && version === '1.0.0' ? INTERACTION_1_0_SKILLS : ROLE_SKILLS[roleId];
}

function roleTools(roleId: AgentRole, version: string): readonly string[] {
  if (roleId === 'interaction') {
    return version === '1.0.0' ? INTERACTION_1_0_TOOLS : INTERACTION_1_1_TOOLS;
  }
  return ROLE_TOOLS[roleId];
}

export function builtinAgentTemplateRegistry(
  roleId: AgentRole,
  templateVersion = '1.0.0',
): AgentTemplateRegistry {
  return {
    capabilities: [...roleCapabilities(roleId, templateVersion)],
    skills: [...roleSkills(roleId, templateVersion)],
    toolCapabilities: [...roleTools(roleId, templateVersion)],
  };
}

function roleBuiltInTools(roleId: AgentRole): readonly AgentBuiltInTool[] {
  return ROLE_BUILT_IN_TOOLS[roleId];
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

export function digestPromptSegments(promptSegmentRefs: readonly string[]): string {
  return `fnv1a:${fnv1a(stableStringify(promptSegmentRefs))}`;
}

export function digestModeCapabilityProfile(profile: AgentModeCapabilityProfile): string {
  const { capabilityDigest: _capabilityDigest, ...content } = profile;
  return `sha256:${createHash('sha256').update(stableStringify(content), 'utf8').digest('hex')}`;
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

function assertModeCapabilityProfile(roleId: AgentRole, profile: AgentModeCapabilityProfile): void {
  assertNonEmpty(profile.profileId, 'mode capability profile id');
  if (profile.role !== roleId) throw new AgentTemplateError('mode capability profile role must match the template role');
  if (profile.mode !== 'observation' && profile.mode !== 'orchestration') {
    throw new AgentTemplateError(`invalid mode capability profile mode: ${profile.mode}`);
  }
  assertUnique(profile.observationScopes, 'observation scope');
  for (const scope of profile.observationScopes) {
    if (!OBSERVATION_SCOPES.includes(scope as never)) throw new AgentTemplateError(`invalid observation scope: ${scope}`);
  }
  assertUnique(profile.observationCapabilities, 'observation capability');
  assertUnique(profile.orchestrationCapabilities, 'orchestration capability');
  for (const capability of profile.observationCapabilities) assertNonEmpty(capability, 'observation capability');
  for (const capability of profile.orchestrationCapabilities) assertNonEmpty(capability, 'orchestration capability');
  if (!ORCHESTRATION_SCOPES.includes(profile.orchestrationScope)) {
    throw new AgentTemplateError(`invalid orchestration scope: ${profile.orchestrationScope}`);
  }
  if (roleId !== 'orchestration' && profile.orchestrationScope === 'project') {
    throw new AgentTemplateError('project orchestration requires the orchestration role');
  }
  assertSubset(profile.observationCapabilities, MODE_OBSERVATION_CAPABILITIES[roleId], 'mode observation capability');
  assertSubset(profile.orchestrationCapabilities, MODE_ORCHESTRATION_CAPABILITIES[roleId], 'mode orchestration capability');
  if (profile.capabilityDigest !== digestModeCapabilityProfile(profile)) throw new AgentTemplateError('mode capability digest does not match its locked content');
}

function assertModeCapabilityProfiles(roleId: AgentRole, profiles: AgentModeCapabilityProfiles): void {
  assertModeCapabilityProfile(roleId, profiles.observation);
  assertModeCapabilityProfile(roleId, profiles.orchestration);
  if (profiles.observation.mode !== 'observation') {
    throw new AgentTemplateError('observation capability profile must use observation mode');
  }
  if (profiles.orchestration.mode !== 'orchestration') {
    throw new AgentTemplateError('orchestration capability profile must use orchestration mode');
  }
  if (profiles.observation.profileId === profiles.orchestration.profileId) {
    throw new AgentTemplateError('mode capability profiles require distinct ids');
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
  validatePromptSegmentRefs(manifest.roleId, manifest.promptSegmentRefs);
  assertSafeRef(manifest.inputSchemaRef, 'input schema ref');
  assertSafeRef(manifest.outputSchemaRef, 'output schema ref');
  assertSafeRef(manifest.policyRef, 'policy ref');
  assertSafeRef(manifest.observationProjectionRef, 'observation projection ref');
  for (const ref of manifest.testFixtureRefs) assertSafeRef(ref, 'test fixture ref');
  for (const ref of manifest.capabilityRefs) assertSafeRef(ref, 'capability ref');
  for (const ref of manifest.skillRefs) assertSafeRef(ref, 'skill ref');
  for (const ref of manifest.toolCapabilityRefs) assertSafeRef(ref, 'tool capability ref');
  for (const tool of manifest.builtInTools) assertSafeRef(tool, 'built-in tool ref');

  assertUnique(manifest.capabilityRefs, 'capability ref');
  assertUnique(manifest.skillRefs, 'skill ref');
  assertUnique(manifest.toolCapabilityRefs, 'tool capability ref');
  assertUnique(manifest.builtInTools, 'built-in tool ref');
  assertUnique(manifest.testFixtureRefs, 'test fixture ref');
  assertSubset(manifest.capabilityRefs, roleCapabilities(manifest.roleId, manifest.templateVersion), 'capability');
  assertSubset(manifest.skillRefs, roleSkills(manifest.roleId, manifest.templateVersion), 'skill');
  assertSubset(manifest.toolCapabilityRefs, roleTools(manifest.roleId, manifest.templateVersion), 'tool capability');
  assertSubset(manifest.builtInTools, roleBuiltInTools(manifest.roleId), 'built-in tool');
  assertSubset(manifest.builtInTools, ALL_BUILT_IN_TOOLS, 'built-in tool');
  assertModeCapabilityProfiles(manifest.roleId, manifest.modeCapabilityProfile);
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
    builtInTools: [...manifest.builtInTools],
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
    builtInTools: [...validation.manifest.builtInTools],
    promptSegmentRefs: [...validation.manifest.promptSegmentRefs],
    promptSegmentDigest: digestPromptSegments(validation.manifest.promptSegmentRefs),
    modeCapabilityProfile: {
      observation: {
        ...validation.manifest.modeCapabilityProfile.observation,
        observationScopes: [...validation.manifest.modeCapabilityProfile.observation.observationScopes],
        observationCapabilities: [...validation.manifest.modeCapabilityProfile.observation.observationCapabilities],
        orchestrationCapabilities: [...validation.manifest.modeCapabilityProfile.observation.orchestrationCapabilities],
      },
      orchestration: {
        ...validation.manifest.modeCapabilityProfile.orchestration,
        observationScopes: [...validation.manifest.modeCapabilityProfile.orchestration.observationScopes],
        observationCapabilities: [...validation.manifest.modeCapabilityProfile.orchestration.observationCapabilities],
        orchestrationCapabilities: [...validation.manifest.modeCapabilityProfile.orchestration.orchestrationCapabilities],
      },
    },
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
    builtInTools: [...template.builtInTools],
    promptSegmentRefs: [...template.promptSegmentRefs],
    modeCapabilityProfile: {
      observation: {
        ...template.modeCapabilityProfile.observation,
        observationScopes: [...template.modeCapabilityProfile.observation.observationScopes],
        observationCapabilities: [...template.modeCapabilityProfile.observation.observationCapabilities],
        orchestrationCapabilities: [...template.modeCapabilityProfile.observation.orchestrationCapabilities],
      },
      orchestration: {
        ...template.modeCapabilityProfile.orchestration,
        observationScopes: [...template.modeCapabilityProfile.orchestration.observationScopes],
        observationCapabilities: [...template.modeCapabilityProfile.orchestration.observationCapabilities],
        orchestrationCapabilities: [...template.modeCapabilityProfile.orchestration.orchestrationCapabilities],
      },
    },
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

export function validateConfiguredAgentBinding(binding: ConfiguredAgentBinding): void {
  if (!AGENT_ROLE_IDS.includes(binding.roleId)) throw new AgentTemplateError(`invalid configured agent role: ${binding.roleId}`);
  const expectedPrefix = `builtin/${binding.roleId}@`;
  if (binding.templateRef !== `${expectedPrefix}1.0.0` && binding.templateRef !== `${expectedPrefix}1.1.0`) {
    throw new AgentTemplateError(`template ref is not locked to the configured role: ${binding.templateRef}`);
  }
  const version = binding.templateRef.slice(expectedPrefix.length);
  if (binding.driverRef !== 'fake' && binding.driverRef !== 'dsh') {
    throw new AgentTemplateError(`driver is not enabled in the MVP host: ${binding.driverRef}`);
  }
  const skills = roleSkills(binding.roleId, version);
  const tools = roleTools(binding.roleId, version);
  const permissions = binding.roleId === 'interaction' && version === '1.0.0' ? INTERACTION_1_0_PERMISSIONS : ROLE_PERMISSIONS[binding.roleId];
  assertSubset(binding.skills, skills, 'skill');
  assertSubset(binding.tools, tools, 'tool');
  assertSubset(binding.permissions, permissions, 'permission');
  assertUnique(binding.skills, 'skill');
  assertUnique(binding.tools, 'tool');
  assertUnique(binding.permissions, 'permission');
}
