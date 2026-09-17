export const AGENT_TEMPLATE_API_VERSION = 1;

export const AGENT_ROLE_IDS = ['interaction', 'orchestration', 'execution', 'review', 'memory'] as const;
export type AgentRole = (typeof AGENT_ROLE_IDS)[number];

export type MemoryContextScope = 'task' | 'organ' | 'approved-global';
export type MemoryContextLayer = 'current' | 'task-recent' | 'related' | 'approved-long-term' | 'raw';

export interface AgentTemplateManifest {
  readonly kind: 'humanagent.agent-template';
  readonly templateApiVersion: number;
  readonly roleId: AgentRole;
  readonly templateVersion: string;
  readonly extends?: {
    readonly roleId: '_base';
    readonly version: string;
  };
  readonly capabilityRefs: readonly string[];
  readonly skillRefs: readonly string[];
  readonly toolCapabilityRefs: readonly string[];
  readonly promptSegmentRefs: readonly string[];
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
  readonly policyRef: string;
  readonly observationProjectionRef: string;
  readonly testFixtureRefs: readonly string[];
  readonly memoryContextPolicy: MemoryContextPolicy;
  readonly driverRequirements: DriverRequirements;
  readonly digest: string;
}

export interface MemoryContextPolicy {
  readonly allowedScopes: readonly MemoryContextScope[];
  readonly allowedLayers: readonly MemoryContextLayer[];
  readonly maxTokenBudget: number;
  readonly required: boolean;
}

export interface DriverRequirements {
  readonly allowedDriverKinds: readonly string[];
  readonly requiredCapabilities: readonly string[];
}

export interface CompiledAgentTemplate {
  readonly roleId: AgentRole;
  readonly templateVersion: string;
  readonly capabilityRefs: readonly string[];
  readonly skillRefs: readonly string[];
  readonly toolCapabilityRefs: readonly string[];
  readonly promptSegmentRefs: readonly string[];
  readonly promptSegmentDigest: string;
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
  readonly policyRef: string;
  readonly observationProjectionRef: string;
  readonly memoryContextPolicy: MemoryContextPolicy;
  readonly driverRequirements: DriverRequirements;
  readonly manifestDigest: string;
}

export interface LoadedAgentTemplate extends CompiledAgentTemplate {
  readonly driverKind: string;
  readonly driverCapabilities: readonly string[];
}

export interface AgentTemplateRegistry {
  readonly skills: readonly string[];
  readonly toolCapabilities: readonly string[];
  readonly capabilities: readonly string[];
}

export interface AgentTemplateOwner {
  readonly roleId: AgentRole;
  readonly templateVersion: string;
  readonly ownerId: string;
}

export interface AgentTemplateLoadInput {
  readonly driverKind: string;
  readonly driverCapabilities: readonly string[];
}

export interface ConfiguredAgentBinding {
  readonly roleId: AgentRole;
  readonly templateRef: string;
  readonly driverRef: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly permissions: readonly string[];
}

export interface AgentTemplateValidation {
  readonly manifest: AgentTemplateManifest;
  readonly capabilityRefs: readonly string[];
  readonly skillRefs: readonly string[];
  readonly toolCapabilityRefs: readonly string[];
}
