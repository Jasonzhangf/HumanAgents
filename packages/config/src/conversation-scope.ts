import type {
  ConversationScope,
  ConversationScopeDescriptor,
  LegacyConversationBinding,
} from '../../contracts/src/conversation-scope.js';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { ConfiguredProjectReadSource, InternalConfig, LoadedConfiguration, RuntimePaths, UserConfig } from './index.js';

export class ConversationScopeResolutionError extends Error {
  readonly code: 'alex-unconfigured' | 'project-unknown' | 'project-ambiguous' | 'project-agent-missing' | 'legacy-binding-invalid' | 'inventory-root-invalid';

  constructor(code: ConversationScopeResolutionError['code'], message: string) {
    super(message);
    this.name = 'ConversationScopeResolutionError';
    this.code = code;
  }
}

export interface ConversationScopeResolutionInput {
  readonly internal: Pick<InternalConfig, 'ceoAgentId'>;
  readonly user: {
    readonly agents: readonly Pick<UserConfig['agents'][number], 'agentId' | 'roleId' | 'managementRole'>[];
    readonly project?: Pick<NonNullable<UserConfig['project']>, 'defaultAgent'>;
  };
  readonly projects: readonly ConfiguredProjectReadSource[];
  readonly machineName?: string;
}

/**
 * Resolve only the operator's explicit startup resource. Omission grants no
 * inventory capability. The provider cannot choose or override this path.
 */
export async function resolveOptionalAlexReadonlyInventoryRoot(suppliedRoot?: string): Promise<string | undefined> {
  if (suppliedRoot === undefined) return undefined;
  if (!isAbsolute(suppliedRoot)) {
    throw new ConversationScopeResolutionError('inventory-root-invalid', 'Alex inventory root must be an explicit absolute directory');
  }
  try {
    const canonicalRoot = await realpath(suppliedRoot);
    if (canonicalRoot === dirname(canonicalRoot) || !(await stat(canonicalRoot)).isDirectory()) {
      throw new Error('expected a directory below filesystem root');
    }
    return canonicalRoot;
  } catch (error) {
    throw new ConversationScopeResolutionError('inventory-root-invalid', `invalid Alex inventory root: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveConfiguredConversationScopes(input: {
  readonly config: Pick<LoadedConfiguration, 'internal' | 'user'>;
  readonly projects: readonly ConfiguredProjectReadSource[];
  readonly machineName?: string;
}): readonly ConversationScopeDescriptor[] {
  const descriptors: ConversationScopeDescriptor[] = [];
  try {
    descriptors.push(resolveConversationScope({ kind: 'alex' }, {
      internal: input.config.internal,
      user: input.config.user,
      projects: input.projects,
      ...(input.machineName === undefined ? {} : { machineName: input.machineName }),
    }));
  } catch (error) {
    if (!(error instanceof ConversationScopeResolutionError) || error.code !== 'alex-unconfigured') throw error;
  }
  for (const project of input.projects) {
    try {
      descriptors.push(resolveConversationScope({ kind: 'project', projectKey: project.projectKey }, {
        internal: input.config.internal,
        user: { ...input.config.user, project: { ...input.config.user.project } },
        projects: input.projects,
        ...(input.machineName === undefined ? {} : { machineName: input.machineName }),
      }));
    } catch (error) {
      if (!(error instanceof ConversationScopeResolutionError) || error.code !== 'project-agent-missing') throw error;
    }
  }
  return descriptors;
}

export function runtimePathsForConversationProject(paths: RuntimePaths, project: ConfiguredProjectReadSource): RuntimePaths {
  return {
    ...paths,
    workspaceCwd: project.workspaceCwd,
    projectKey: project.projectKey,
    projectRoot: project.projectRoot,
    projectManifest: `${project.projectRoot}/project.json`,
    sessionsRoot: project.projectRoot,
    journalRoot: `${project.projectRoot}/journal`,
    checkpointsRoot: project.checkpointsRoot,
    indexRoot: `${project.projectRoot}/index`,
    artifactsRoot: `${project.projectRoot}/artifacts`,
    memoryRoot: `${project.projectRoot}/memory`,
    locksRoot: `${project.projectRoot}/locks`,
    runNotesRoot: `${project.projectRoot}/run-notes`,
  };
}

function machine(input: ConversationScopeResolutionInput): string {
  return input.machineName?.trim() || process.env.HOSTNAME?.trim() || 'local';
}

function projectAgentId(input: ConversationScopeResolutionInput): string {
  const configured = input.user.project?.defaultAgent;
  if (configured !== undefined) {
    const configuredAgent = input.user.agents.find((agent) => agent.agentId === configured);
    if (configuredAgent === undefined || configuredAgent.roleId !== 'interaction' || configuredAgent.managementRole === 'ceo') {
      throw new ConversationScopeResolutionError('project-agent-missing', `configured project Agent is not a project interaction Agent: ${configured}`);
    }
    return configured;
  }
  const leads = input.user.agents.filter((agent) => agent.roleId === 'interaction'
    && agent.managementRole !== 'ceo'
    && agent.agentId !== input.internal.ceoAgentId);
  if (leads.length === 1) return leads[0]!.agentId;
  if (leads.length > 1) throw new ConversationScopeResolutionError('project-ambiguous', 'multiple project interaction Agents are configured; set one project.defaultAgent');
  throw new ConversationScopeResolutionError('project-agent-missing', 'no interaction Agent is configured for the project scope');
}

export function resolveConversationScope(
  scope: ConversationScope,
  input: ConversationScopeResolutionInput,
): ConversationScopeDescriptor {
  const agentIds = new Set<string>();
  for (const agent of input.user.agents) {
    if (agentIds.has(agent.agentId)) throw new ConversationScopeResolutionError('project-ambiguous', `Agent identity is declared more than once: ${agent.agentId}`);
    agentIds.add(agent.agentId);
  }
  if (scope.kind === 'alex') {
    const agentId = input.internal.ceoAgentId;
    const ceoAgents = input.user.agents.filter((agent) => agent.roleId === 'interaction' && agent.managementRole === 'ceo');
    if (!agentId || ceoAgents.length !== 1 || ceoAgents[0]!.agentId !== agentId) {
      throw new ConversationScopeResolutionError('alex-unconfigured', 'Alex CEO is not configured as one unique interaction Agent');
    }
    return { scope, scopeKey: 'alex', canonicalAddress: `${machine(input)}.CEO`, agentId, role: 'ceo' };
  }
  const matches = input.projects.filter((project) => project.projectKey === scope.projectKey);
  if (matches.length === 0) throw new ConversationScopeResolutionError('project-unknown', `project scope is not declared: ${scope.projectKey}`);
  if (matches.length > 1) throw new ConversationScopeResolutionError('project-ambiguous', `project scope is ambiguous: ${scope.projectKey}`);
  const project = matches[0]!;
  return {
    scope,
    scopeKey: `project:${project.projectKey}`,
    canonicalAddress: `${machine(input)}.${project.projectKey}.Jenny`,
    agentId: projectAgentId(input),
    role: 'project-lead',
    projectKey: project.projectKey,
    workspaceCwd: project.workspaceCwd,
  };
}

export function validateLegacyAlexBinding(binding: LegacyConversationBinding): LegacyConversationBinding {
  if (binding.legacySessionRef !== '50661') {
    throw new ConversationScopeResolutionError('legacy-binding-invalid', 'only the confirmed legacy session 50661 may be bound in this delivery');
  }
  if (binding.scope.kind !== 'alex') {
    throw new ConversationScopeResolutionError('legacy-binding-invalid', 'legacy session 50661 must be bound to the Alex scope');
  }
  if (!binding.sourceEvidenceRef.trim()) {
    throw new ConversationScopeResolutionError('legacy-binding-invalid', 'legacy Alex binding requires a source evidence reference');
  }
  const preservedInteractionRefs = [...new Set(binding.preservedInteractionRefs.map((ref) => ref.trim()).filter(Boolean))];
  if (preservedInteractionRefs.length === 0) {
    throw new ConversationScopeResolutionError('legacy-binding-invalid', 'legacy Alex binding requires at least one preserved interaction reference');
  }
  const preservedTaskRefs = [...new Set(binding.preservedTaskRefs.map((ref) => ref.trim()).filter(Boolean))];
  if (preservedTaskRefs.length === 0) {
    throw new ConversationScopeResolutionError('legacy-binding-invalid', 'legacy Alex binding requires at least one preserved Task reference');
  }
  return {
    ...binding,
    preservedInteractionRefs,
    preservedTaskRefs,
    sourceEvidenceRef: binding.sourceEvidenceRef.trim(),
  };
}

/** The user-confirmed, source-backed binding for the single legacy Alex carrier. */
export const CONFIRMED_LEGACY_ALEX_BINDING: LegacyConversationBinding = {
  legacySessionRef: '50661',
  scope: { kind: 'alex' },
  preservedInteractionRefs: ['interaction-1', 'interaction-2'],
  preservedTaskRefs: ['ui-task-implicit-draft-2', 'scheduled-task-665227213af5adf02045'],
  sourceEvidenceRef: '../mvp-delivery-audit-20261122/50661实际执行者回执.md',
};
