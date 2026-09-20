import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  readonly auditPrompts?: Readonly<Record<string, string>>;
}

export interface PreparedBuiltinAuditPrompt {
  readonly promptRef: string;
  readonly sourceRef: string;
  readonly destinationPath: string;
  readonly contentDigest: string;
}

export function builtinPromptRegistryRef(templateVersion: string): string {
  if (templateVersion === '1.0.0') return 'prompt-registry.json';
  if (templateVersion === '1.1.0') return 'prompt-registry-1.1.0.json';
  throw new AgentTemplateError(`unsupported builtin prompt registry version: ${templateVersion}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function assertSafeAuditPromptRef(promptRef: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(promptRef)) {
    throw new AgentTemplateError(`invalid builtin audit prompt ref: ${promptRef}`);
  }
}

export async function prepareBuiltinAuditPrompt(input: {
  readonly templateRoot: string;
  readonly promptRef: string;
  readonly destinationRoot: string;
  readonly expectedTemplateVersion?: string;
}): Promise<PreparedBuiltinAuditPrompt> {
  assertSafeAuditPromptRef(input.promptRef);
  const registry = await loadBuiltinPromptRegistry(
    input.templateRoot,
    input.expectedTemplateVersion ?? '1.0.0',
  );
  const sourceRef = registry.auditPrompts?.[input.promptRef];
  if (!sourceRef) {
    throw new AgentTemplateError(
      `configured memory audit prompt is not a builtin resource: ${input.promptRef}`,
    );
  }
  const source = createFilePromptSource(join(input.templateRoot, 'builtin'));
  const content = await source.read(sourceRef);
  if (!content.trim()) throw new AgentTemplateError(`builtin audit prompt is empty: ${sourceRef}`);
  const destinationPath = join(input.destinationRoot, `${input.promptRef}.md`);
  await mkdir(input.destinationRoot, { recursive: true });
  let existing = false;
  try {
    const current = await lstat(destinationPath);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new AgentTemplateError(`builtin audit prompt destination is not a regular file: ${destinationPath}`);
    }
    existing = true;
  } catch (error) {
    if ((error as { readonly code?: string }).code !== 'ENOENT') throw error;
    await writeFile(destinationPath, content, 'utf8');
  }
  const written = existing ? await readFile(destinationPath, 'utf8') : content;
  if (!written.trim()) throw new AgentTemplateError(`builtin audit prompt destination is empty: ${destinationPath}`);
  return {
    promptRef: input.promptRef,
    sourceRef,
    destinationPath,
    contentDigest: contentDigest(written),
  };
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
    || typeof parsed.templateVersion !== 'string' || !isRecord(parsed.roles) || !isRecord(parsed.contentDigests)
    || (parsed.auditPrompts !== undefined && !isRecord(parsed.auditPrompts))) {
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
  const auditPrompts: Record<string, string> = {};
  for (const [promptRef, sourceRef] of Object.entries(parsed.auditPrompts ?? {})) {
    assertSafeAuditPromptRef(promptRef);
    if (typeof sourceRef !== 'string' || !sourceRef.startsWith('memory/') || !sourceRef.endsWith('.md')) {
      throw new AgentTemplateError(`builtin audit prompt has an invalid resource ref: ${promptRef}`);
    }
    auditPrompts[promptRef] = sourceRef;
  }
  return {
    kind: 'humanagent.prompt-registry',
    schemaVersion: 1,
    templateVersion: parsed.templateVersion,
    roles,
    contentDigests,
    ...(Object.keys(auditPrompts).length === 0 ? {} : { auditPrompts }),
  };
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
    ? `${roleId}/v1.1.0/manifest.json`
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
  if (templateVersion === '1.1.0') {
    const promptRegistry = await loadBuiltinPromptRegistry(templateRoot, templateVersion);
    const registryRefs = promptRegistry.roles[roleId];
    if (
      manifest.promptSegmentRefs.length !== registryRefs.length
      || manifest.promptSegmentRefs.some((ref, index) => ref !== registryRefs[index])
    ) {
      throw new AgentTemplateError(`builtin prompt registry refs do not match manifest: ${roleId}`);
    }
    await loadBuiltinPromptSegments(roleId, templateRoot, templateVersion);
  }
  return manifest;
}
