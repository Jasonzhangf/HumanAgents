import { AgentTemplateError } from './errors.js';
import type { AgentPromptSource, AgentRole } from './types.js';

export const MANAGEMENT_ROLES = ['ceo', 'project-lead'] as const;
export type ManagementRole = (typeof MANAGEMENT_ROLES)[number];

export const MANAGEMENT_PROMPT_REFS: Readonly<Record<ManagementRole, string>> = {
  ceo: 'common/management-ceo.md',
  'project-lead': 'common/management-project-lead.md',
};

export interface LoadedManagementPrompt {
  readonly agentId: string;
  readonly role: ManagementRole;
  readonly ref: string;
  readonly content: string;
}

export function managementRoleForAgent(input: {
  readonly roleId: AgentRole;
  readonly managementRole?: ManagementRole;
}): ManagementRole | undefined {
  if (input.roleId !== 'interaction') return undefined;
  return input.managementRole ?? 'project-lead';
}

export async function loadManagementPrompt(
  source: AgentPromptSource,
  role: ManagementRole,
): Promise<{ readonly ref: string; readonly content: string }> {
  const ref = MANAGEMENT_PROMPT_REFS[role];
  if (ref === undefined) throw new AgentTemplateError(`unknown management role: ${String(role)}`);
  const content = await source.read(ref);
  if (!content.trim()) throw new AgentTemplateError(`management prompt is empty: ${ref}`);
  return { ref, content };
}
