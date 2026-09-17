import { join } from 'node:path';
import { AgentTemplateError } from './errors.js';
import { createFilePromptSource, loadAgentPromptSegments } from './prompt-loader.js';
import { builtinAgentTemplateRegistry, validateAgentTemplate, validatePromptSegmentRefs } from './template.js';
import {
  AGENT_ROLE_IDS,
  type AgentRole,
  type AgentPromptSource,
  type AgentTemplateManifest,
  type AgentTemplateRegistry,
  type LoadedAgentPromptSegments,
} from './types.js';

export interface BuiltinPromptRegistry {
  readonly kind: 'humanagent.prompt-registry';
  readonly schemaVersion: 1;
  readonly templateVersion: string;
  readonly roles: Readonly<Record<AgentRole, readonly string[]>>;
  readonly contentDigests: Readonly<Record<AgentRole, string>>;
}

export function builtinPromptRegistryRef(templateVersion: string): string {
  if (templateVersion === '1.0.0') return 'prompt-registry.json';
  if (templateVersion === '1.1.0') return 'prompt-registry-1.1.0.json';
  throw new AgentTemplateError(`unsupported builtin prompt registry version: ${templateVersion}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function assertBuiltinTemplateResources(
  source: AgentPromptSource,
  manifest: AgentTemplateManifest,
): Promise<void> {
  const refs = [
    ...manifest.promptSegmentRefs,
    manifest.inputSchemaRef,
    manifest.outputSchemaRef,
    manifest.policyRef,
    manifest.observationProjectionRef,
    ...manifest.testFixtureRefs,
  ];
  for (const ref of refs) {
    try {
      await source.read(ref);
    } catch (error) {
      throw new AgentTemplateError(`builtin template resource is missing: ${ref}: ${String(error)}`);
    }
  }
}

export async function loadBuiltinPromptRegistry(
  templateRoot: string,
  templateVersion = '1.0.0',
): Promise<BuiltinPromptRegistry> {
  const source = createFilePromptSource(join(templateRoot, 'builtin'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await source.read(builtinPromptRegistryRef(templateVersion))) as unknown;
  } catch (error) {
    if (error instanceof AgentTemplateError) throw error;
    throw new AgentTemplateError(`builtin prompt registry is invalid: ${String(error)}`);
  }
  if (!isRecord(parsed) || parsed.kind !== 'humanagent.prompt-registry' || parsed.schemaVersion !== 1
    || typeof parsed.templateVersion !== 'string' || !isRecord(parsed.roles) || !isRecord(parsed.contentDigests)) {
    throw new AgentTemplateError('builtin prompt registry has an invalid shape');
  }
  if (parsed.templateVersion !== templateVersion) {
    throw new AgentTemplateError(`builtin prompt registry version is not ${templateVersion}`);
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
  const registry = await loadBuiltinPromptRegistry(templateRoot, expectedTemplateVersion ?? '1.0.0');
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

export async function loadBuiltinAgentTemplate(
  templateRoot: string,
  roleId: AgentRole,
  templateVersion = '1.0.0',
  registry?: AgentTemplateRegistry,
): Promise<AgentTemplateManifest> {
  const source = createFilePromptSource(join(templateRoot, 'builtin'));
  const ref = templateVersion === '1.1.0'
    ? roleId === 'interaction'
      ? 'interaction/v1.1.0/manifest.json'
      : undefined
    : templateVersion === '1.0.0'
      ? `${roleId}/manifest.json`
      : undefined;
  if (!ref) throw new AgentTemplateError(`unsupported builtin template version: ${roleId}@${templateVersion}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await source.read(ref)) as unknown;
  } catch (error) {
    throw new AgentTemplateError(`builtin template manifest cannot be loaded: ${ref}: ${String(error)}`);
  }
  const manifest = parsed as AgentTemplateManifest;
  if (manifest.roleId !== roleId || manifest.templateVersion !== templateVersion) {
    throw new AgentTemplateError(`builtin template manifest does not match ${roleId}@${templateVersion}`);
  }
  await assertBuiltinTemplateResources(source, manifest);
  validateAgentTemplate(manifest, registry ?? builtinAgentTemplateRegistry(roleId, templateVersion));
  return manifest;
}
