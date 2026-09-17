import { join } from 'node:path';
import { AgentTemplateError } from './errors.js';
import { createFilePromptSource, loadAgentPromptSegments } from './prompt-loader.js';
import { validatePromptSegmentRefs } from './template.js';
import { AGENT_ROLE_IDS, type AgentRole, type LoadedAgentPromptSegments } from './types.js';

export interface BuiltinPromptRegistry {
  readonly kind: 'humanagent.prompt-registry';
  readonly schemaVersion: 1;
  readonly templateVersion: string;
  readonly roles: Readonly<Record<AgentRole, readonly string[]>>;
  readonly contentDigests: Readonly<Record<AgentRole, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadBuiltinPromptRegistry(templateRoot: string): Promise<BuiltinPromptRegistry> {
  const source = createFilePromptSource(join(templateRoot, 'builtin'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await source.read('prompt-registry.json')) as unknown;
  } catch (error) {
    if (error instanceof AgentTemplateError) throw error;
    throw new AgentTemplateError(`builtin prompt registry is invalid: ${String(error)}`);
  }
  if (!isRecord(parsed) || parsed.kind !== 'humanagent.prompt-registry' || parsed.schemaVersion !== 1
    || typeof parsed.templateVersion !== 'string' || !isRecord(parsed.roles) || !isRecord(parsed.contentDigests)) {
    throw new AgentTemplateError('builtin prompt registry has an invalid shape');
  }
  const roles = {} as Record<AgentRole, readonly string[]>;
  const contentDigests = {} as Record<AgentRole, string>;
  for (const roleId of AGENT_ROLE_IDS) {
    const refs = parsed.roles[roleId];
    if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string')) {
      throw new AgentTemplateError(`builtin prompt registry is missing role refs: ${roleId}`);
    }
    validatePromptSegmentRefs(roleId, refs);
    const contentDigest = parsed.contentDigests[roleId];
    if (typeof contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(contentDigest)) {
      throw new AgentTemplateError(`builtin prompt registry has an invalid content digest: ${roleId}`);
    }
    roles[roleId] = [...refs];
    contentDigests[roleId] = contentDigest;
  }
  const unknownRole = Object.keys(parsed.roles).find((roleId) => !(AGENT_ROLE_IDS as readonly string[]).includes(roleId));
  if (unknownRole) throw new AgentTemplateError(`builtin prompt registry has unknown role: ${unknownRole}`);
  return { kind: 'humanagent.prompt-registry', schemaVersion: 1, templateVersion: parsed.templateVersion, roles, contentDigests };
}

export async function builtinPromptSegmentRefs(templateRoot: string, roleId: AgentRole): Promise<readonly string[]> {
  const registry = await loadBuiltinPromptRegistry(templateRoot);
  if (!AGENT_ROLE_IDS.includes(roleId)) throw new AgentTemplateError(`invalid builtin prompt role: ${roleId}`);
  return [...registry.roles[roleId]];
}

export async function loadBuiltinPromptSegments(
  roleId: AgentRole,
  templateRoot: string,
  expectedTemplateVersion?: string,
): Promise<LoadedAgentPromptSegments> {
  const registry = await loadBuiltinPromptRegistry(templateRoot);
  if (expectedTemplateVersion !== undefined && registry.templateVersion !== expectedTemplateVersion) {
    throw new AgentTemplateError(`builtin prompt registry version is not locked to ${expectedTemplateVersion}`);
  }
  const loaded = await loadAgentPromptSegments(
    { promptSegmentRefs: registry.roles[roleId] },
    createFilePromptSource(join(templateRoot, 'builtin')),
  );
  if (loaded.contentDigest !== registry.contentDigests[roleId]) {
    throw new AgentTemplateError(`builtin prompt content drift detected: ${roleId}`);
  }
  return loaded;
}
