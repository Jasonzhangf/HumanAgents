import { lstatSync } from 'node:fs';
import { mkdir, open as openFile, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { loadBuiltinPromptSegments, validateConfiguredAgentBinding, type AgentRole as TemplateAgentRole, type LoadedAgentPromptSegments } from '../../agent-templates/src/index.js';

export const CONFIG_SCHEMA_VERSION = 1;
export const INTERNAL_CONFIG_KEYS = ['controlRoot', 'agentCwd', 'sessionRoot', 'pluginManifest', 'configPolicy'] as const;
export const AGENT_DRIVER_REFS = ['fake', 'dsh'] as const;
export type AgentDriverRef = (typeof AGENT_DRIVER_REFS)[number];
export const AGENT_ROLES = ['interaction', 'orchestration', 'execution', 'review', 'memory'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentConfig {
  readonly agentId: string;
  readonly roleId: AgentRole;
  readonly templateRef: string;
  readonly driverRef: AgentDriverRef;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly permissions: readonly string[];
  readonly memoryScopes: readonly ('task' | 'organ' | 'approved-global')[];
  readonly resourceClass: string;
  readonly model?: string;
}

export interface DshExecutionConfig {
  readonly sourceRoot: string;
  readonly home: string;
  readonly profile: string;
  readonly provider: string;
  readonly model: string;
  readonly workspace?: string;
  readonly patchFiles?: readonly string[];
  readonly permissionMode?: string;
  readonly turnTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface UserConfig {
  readonly schemaVersion: number;
  readonly agents: readonly AgentConfig[];
  readonly project?: {
    readonly defaultAgent?: string;
    readonly reviewRequired?: boolean;
  };
  readonly memory?: {
    readonly update: {
      readonly auto: boolean;
    };
    readonly audit: {
      readonly promptRef: string;
    };
  };
  readonly execution?: {
    readonly maxConcurrentTasks?: number;
    readonly stopTimeoutMs?: number;
    readonly dsh?: DshExecutionConfig;
  };
}

export interface InternalConfig {
  readonly schemaVersion: number;
  readonly controlRoot: string;
  readonly agentCwd: string;
  readonly sessionRoot: string;
  readonly pluginManifest: string;
  readonly releaseChannel: string;
  readonly configPolicy: 'internal-overrides-user';
}

export interface RuntimePaths {
  readonly controlRoot: string;
  readonly agentCwd: string;
  readonly workspaceCwd: string;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly projectManifest: string;
  readonly sessionsRoot: string;
  readonly journalRoot: string;
  readonly checkpointsRoot: string;
  readonly indexRoot: string;
  readonly artifactsRoot: string;
  readonly memoryRoot: string;
  readonly userRoot: string;
  readonly globalMemoryRoot: string;
  readonly locksRoot: string;
  readonly runNotesRoot: string;
}

export interface ProjectLocalSkillSource {
  readonly root: string;
  readonly name: string;
}

export interface LoadedConfiguration {
  readonly paths: RuntimePaths;
  readonly internal: InternalConfig;
  readonly user: UserConfig;
  readonly projectOverride?: Partial<UserConfig>;
  readonly effective: UserConfig;
  readonly agentRoster: readonly AgentConfig[];
  readonly promptCatalog: Partial<Record<AgentRole, LoadedAgentPromptSegments>>;
}

export class ConfigurationError extends Error {
  readonly code: string;
  readonly ownerId: string;
  readonly nextAction: string;

  constructor(code: string, message: string, nextAction: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code;
    this.ownerId = 'config-loader';
    this.nextAction = nextAction;
  }
}

export const DEFAULT_MEMORY_AUDIT_PROMPT_REF = 'project-memory-audit';

function fail(code: string, message: string, nextAction = '修正配置后重新运行'): never {
  throw new ConfigurationError(code, message, nextAction);
}

function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === quote) quote = undefined;
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (char === '#' && !quote) return line.slice(0, index);
  }
  return line;
}

function splitArray(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === quote) quote = undefined;
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && char === '[') depth += 1;
    else if (!quote && char === ']') depth -= 1;
    else if (!quote && char === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function parseValue(raw: string, line: number): unknown {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { fail('config-parse', `invalid string at line ${line}`); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.length === 2 ? [] : splitArray(value.slice(1, -1)).map((item) => parseValue(item, line));
  }
  fail('config-parse', `unsupported TOML value at line ${line}`);
}

function assign(target: Record<string, unknown>, path: readonly string[], key: string, value: unknown): void {
  const section = path.reduce<Record<string, unknown>>((current, part) => {
    const existing = current[part];
    if (existing !== undefined && (typeof existing !== 'object' || Array.isArray(existing) || existing === null)) {
      fail('config-parse', `section conflicts with value: ${path.join('.')}`);
    }
    if (existing === undefined) current[part] = {};
    return current[part] as Record<string, unknown>;
  }, target);
  if (Object.prototype.hasOwnProperty.call(section, key)) fail('config-parse', `duplicate key: ${[...path, key].join('.')}`);
  section[key] = value;
}

function declareTable(target: Record<string, unknown>, path: readonly string[]): void {
  const key = path.at(-1);
  if (!key) fail('config-parse', 'table name cannot be empty');
  const parent = path.slice(0, -1).reduce<Record<string, unknown>>((current, part) => {
    const existing = current[part];
    if (existing === undefined) current[part] = {};
    else if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) fail('config-parse', `section conflicts with value: ${path.join('.')}`);
    return current[part] as Record<string, unknown>;
  }, target);
  if (Object.prototype.hasOwnProperty.call(parent, key)) fail('config-parse', `duplicate table: ${path.join('.')}`);
  parent[key] = {};
}

export function parseToml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section: string[] = [];
  let arrayTable: Record<string, unknown> | undefined;
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index]).trim();
    if (!line) continue;
    const arrayHeader = line.match(/^\[\[([A-Za-z0-9_-]+)\]\]$/);
    if (arrayHeader) {
      const key = arrayHeader[1];
      const existing = root[key];
      if (existing !== undefined && !Array.isArray(existing)) fail('config-parse', `array table conflicts with value: ${key}`);
      const tables = Array.isArray(existing) ? existing as Record<string, unknown>[] : [];
      tables.push({});
      root[key] = tables;
      const table = tables.at(-1)!;
      arrayTable = table;
      section = [];
      continue;
    }
    const tableHeader = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (tableHeader) {
      section = tableHeader[1].split('.');
      arrayTable = undefined;
      declareTable(root, section);
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) fail('config-parse', `expected key/value at line ${lineNumber}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) fail('config-parse', `invalid key at line ${lineNumber}`);
    const value = parseValue(line.slice(separator + 1), lineNumber);
    if (arrayTable) {
      if (Object.prototype.hasOwnProperty.call(arrayTable, key)) fail('config-parse', `duplicate key: ${key}`);
      arrayTable[key] = value;
    }
    else assign(root, section, key, value);
  }
  return root;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('config-invalid', `${label} must be a table`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail('config-invalid', `${label} must be a non-empty string`);
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    fail('config-invalid', `${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) fail('config-invalid', `${label} contains unsupported key: ${unknown}`);
}

function validateAgent(value: unknown, index: number): AgentConfig {
  const agent = asRecord(value, `agents[${index}]`);
  rejectUnknownKeys(agent, ['agentId', 'roleId', 'templateRef', 'driverRef', 'skills', 'tools', 'permissions', 'memoryScopes', 'resourceClass', 'model'], `agents[${index}]`);
  const role = asString(agent.roleId, `agents[${index}].roleId`);
  if (!(AGENT_ROLES as readonly string[]).includes(role)) fail('config-invalid', `unknown agent role: ${role}`);
  const driverRef = asString(agent.driverRef, `agents[${index}].driverRef`);
  if (!(AGENT_DRIVER_REFS as readonly string[]).includes(driverRef)) {
    fail('config-capability', `unknown agent driver: ${driverRef}`, 'choose an explicitly supported driverRef');
  }
  const memoryScopes = asStringArray(agent.memoryScopes, `agents[${index}].memoryScopes`);
  if (memoryScopes.some((scope) => !['task', 'organ', 'approved-global'].includes(scope))) {
    fail('config-invalid', `invalid memory scope for agents[${index}]`);
  }
  try {
    validateConfiguredAgentBinding({
      roleId: role as TemplateAgentRole,
      templateRef: asString(agent.templateRef, `agents[${index}].templateRef`),
      driverRef,
      skills: asStringArray(agent.skills, `agents[${index}].skills`),
      tools: asStringArray(agent.tools, `agents[${index}].tools`),
      permissions: asStringArray(agent.permissions, `agents[${index}].permissions`),
    });
  } catch (error) {
    fail('config-capability', error instanceof Error ? error.message : String(error), '修正 Agent template、driver、skill、tool 或 permission 后重试');
  }
  return {
    agentId: asString(agent.agentId, `agents[${index}].agentId`),
    roleId: role as AgentRole,
    templateRef: asString(agent.templateRef, `agents[${index}].templateRef`),
    driverRef: driverRef as AgentDriverRef,
    skills: asStringArray(agent.skills, `agents[${index}].skills`),
    tools: asStringArray(agent.tools, `agents[${index}].tools`),
    permissions: asStringArray(agent.permissions, `agents[${index}].permissions`),
    memoryScopes: memoryScopes as AgentConfig['memoryScopes'],
    resourceClass: asString(agent.resourceClass, `agents[${index}].resourceClass`),
    ...(agent.model === undefined ? {} : { model: asString(agent.model, `agents[${index}].model`) }),
  };
}

function validateDshExecution(value: unknown, label: string): DshExecutionConfig {
  const dsh = asRecord(value, label);
  rejectUnknownKeys(dsh, ['sourceRoot', 'home', 'profile', 'provider', 'model', 'workspace', 'patchFiles', 'permissionMode', 'turnTimeoutMs', 'shutdownTimeoutMs'], label);
  const timeout = (candidate: unknown, field: string): number | undefined => {
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) fail('config-invalid', `${label}.${field} must be positive`);
    return candidate;
  };
  const patchFiles = dsh.patchFiles === undefined ? undefined : asStringArray(dsh.patchFiles, `${label}.patchFiles`);
  const turnTimeoutMs = timeout(dsh.turnTimeoutMs, 'turnTimeoutMs');
  const shutdownTimeoutMs = timeout(dsh.shutdownTimeoutMs, 'shutdownTimeoutMs');
  return {
    sourceRoot: asString(dsh.sourceRoot, `${label}.sourceRoot`),
    home: asString(dsh.home, `${label}.home`),
    profile: asString(dsh.profile, `${label}.profile`),
    provider: asString(dsh.provider, `${label}.provider`),
    model: asString(dsh.model, `${label}.model`),
    ...(dsh.workspace === undefined ? {} : { workspace: asString(dsh.workspace, `${label}.workspace`) }),
    ...(patchFiles === undefined ? {} : { patchFiles }),
    ...(dsh.permissionMode === undefined ? {} : { permissionMode: asString(dsh.permissionMode, `${label}.permissionMode`) }),
    ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }),
    ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
  };
}

function validateMemoryConfig(value: unknown): NonNullable<UserConfig['memory']> {
  const memory = asRecord(value, 'memory');
  rejectUnknownKeys(memory, ['update', 'audit'], 'memory config');
  const update = memory.update === undefined ? {} : asRecord(memory.update, 'memory.update');
  const audit = memory.audit === undefined ? {} : asRecord(memory.audit, 'memory.audit');
  rejectUnknownKeys(update, ['auto'], 'memory.update');
  rejectUnknownKeys(audit, ['prompt_ref'], 'memory.audit');
  const auto = update.auto === undefined ? false : update.auto;
  if (typeof auto !== 'boolean') fail('config-invalid', 'memory.update.auto must be boolean');
  const promptRef = audit.prompt_ref === undefined
    ? DEFAULT_MEMORY_AUDIT_PROMPT_REF
    : asString(audit.prompt_ref, 'memory.audit.prompt_ref');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(promptRef) || promptRef.split('/').includes('..')) {
    fail('config-invalid', 'memory.audit.prompt_ref must be a typed source reference');
  }
  return { update: { auto }, audit: { promptRef } };
}

export function validateUserConfig(value: Record<string, unknown>): UserConfig {
  for (const key of INTERNAL_CONFIG_KEYS) if (key in value) fail('config-policy', `user config cannot define internal key: ${key}`);
  rejectUnknownKeys(value, ['schemaVersion', 'agents', 'project', 'memory', 'execution'], 'user config');
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) fail('config-version', `unsupported user config schema: ${String(value.schemaVersion)}`);
  if (!Array.isArray(value.agents) || value.agents.length === 0) fail('config-invalid', 'at least one agent is required');
  const agents = value.agents.map(validateAgent);
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.agentId)) fail('config-invalid', `duplicate agent id: ${agent.agentId}`);
    ids.add(agent.agentId);
  }
  const project = value.project === undefined ? undefined : asRecord(value.project, 'project');
  const memory = value.memory === undefined ? undefined : validateMemoryConfig(value.memory);
  const execution = value.execution === undefined ? undefined : asRecord(value.execution, 'execution');
  if (project) rejectUnknownKeys(project, ['defaultAgent', 'reviewRequired'], 'user project config');
  if (execution) rejectUnknownKeys(execution, ['maxConcurrentTasks', 'stopTimeoutMs', 'dsh'], 'user execution config');
  const maxConcurrentTasks = execution?.maxConcurrentTasks as unknown;
  const stopTimeoutMs = execution?.stopTimeoutMs as unknown;
  if (maxConcurrentTasks !== undefined && (typeof maxConcurrentTasks !== 'number' || !Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1)) fail('config-invalid', 'execution.maxConcurrentTasks must be positive');
  if (stopTimeoutMs !== undefined && (typeof stopTimeoutMs !== 'number' || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1)) fail('config-invalid', 'execution.stopTimeoutMs must be positive');
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    agents,
    ...(project === undefined ? {} : { project: {
      ...(project.defaultAgent === undefined ? {} : { defaultAgent: asString(project.defaultAgent, 'project.defaultAgent') }),
      ...(project.reviewRequired === undefined ? {} : { reviewRequired: project.reviewRequired === true || project.reviewRequired === false ? project.reviewRequired : fail('config-invalid', 'project.reviewRequired must be boolean') }),
    }}),
    ...(memory === undefined ? {} : { memory }),
    ...(execution === undefined ? {} : { execution: {
      ...(maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks: maxConcurrentTasks as number }),
      ...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs: stopTimeoutMs as number }),
      ...(execution.dsh === undefined ? {} : { dsh: validateDshExecution(execution.dsh, 'execution.dsh') }),
    }}),
  };
}

export function validateProjectOverride(value: Record<string, unknown>): Partial<UserConfig> {
  for (const key of INTERNAL_CONFIG_KEYS) if (key in value) fail('config-policy', 'project config cannot define internal key: ' + key);
  const unknownKeys = Object.keys(value).filter((key) => key !== 'project' && key !== 'memory' && key !== 'execution');
  if (unknownKeys.length > 0) fail('config-policy', 'project config contains unsupported key: ' + unknownKeys[0]);
  const project = value.project === undefined ? undefined : asRecord(value.project, 'project');
  const memory = value.memory === undefined ? undefined : validateMemoryConfig(value.memory);
  const execution = value.execution === undefined ? undefined : asRecord(value.execution, 'execution');
  if (project) rejectUnknownKeys(project, ['defaultAgent', 'reviewRequired'], 'project project config');
  if (execution) rejectUnknownKeys(execution, ['maxConcurrentTasks', 'stopTimeoutMs'], 'project execution config');
  const maxConcurrentTasks = execution?.maxConcurrentTasks as unknown;
  const stopTimeoutMs = execution?.stopTimeoutMs as unknown;
  if (maxConcurrentTasks !== undefined && (typeof maxConcurrentTasks !== 'number' || !Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1)) fail('config-invalid', 'project execution.maxConcurrentTasks must be positive');
  if (stopTimeoutMs !== undefined && (typeof stopTimeoutMs !== 'number' || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1)) fail('config-invalid', 'project execution.stopTimeoutMs must be positive');
  return {
    ...(project === undefined ? {} : { project: {
      ...(project.defaultAgent === undefined ? {} : { defaultAgent: asString(project.defaultAgent, 'project.defaultAgent') }),
      ...(project.reviewRequired === undefined ? {} : { reviewRequired: project.reviewRequired === true || project.reviewRequired === false ? project.reviewRequired : fail('config-invalid', 'project.reviewRequired must be boolean') }),
    }}),
    ...(memory === undefined ? {} : { memory }),
    ...(execution === undefined ? {} : { execution: {
      ...(maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks: maxConcurrentTasks as number }),
      ...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs: stopTimeoutMs as number }),
    }}),
  };
}

function validateProjectPolicy(user: UserConfig, override: Partial<UserConfig>): void {
  if (user.project?.reviewRequired === true && override.project?.reviewRequired === false) {
    fail('config-policy', 'project reviewRequired cannot disable the user review requirement');
  }
  const projectExecution = override.execution;
  if (projectExecution?.maxConcurrentTasks !== undefined) {
    const userMax = user.execution?.maxConcurrentTasks;
    if (userMax === undefined || projectExecution.maxConcurrentTasks > userMax) {
      fail('config-policy', 'project maxConcurrentTasks cannot exceed the user limit');
    }
  }
  if (projectExecution?.stopTimeoutMs !== undefined) {
    const userTimeout = user.execution?.stopTimeoutMs;
    if (userTimeout === undefined || projectExecution.stopTimeoutMs !== userTimeout) {
      fail('config-policy', 'project stopTimeoutMs must preserve the user stop timeout');
    }
  }
}

export function validateInternalConfig(value: Record<string, unknown>, controlRoot: string): InternalConfig {
  rejectUnknownKeys(value, ['schemaVersion', ...INTERNAL_CONFIG_KEYS, 'releaseChannel'], 'internal config');
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) fail('config-version', `unsupported internal config schema: ${String(value.schemaVersion)}`);
  const expectedRoot = normalize(controlRoot);
  const configuredRoot = expandControlPath(asString(value.controlRoot, 'controlRoot'), controlRoot);
  const configuredAgentCwd = expandControlPath(asString(value.agentCwd, 'agentCwd'), controlRoot);
  const sessionRoot = expandControlPath(asString(value.sessionRoot, 'sessionRoot'), controlRoot);
  if (normalize(configuredRoot) !== expectedRoot || normalize(configuredAgentCwd) !== expectedRoot) fail('config-policy', 'internal controlRoot and agentCwd must equal resolved control root');
  const rootPrefix = expectedRoot.endsWith(sep) ? expectedRoot : `${expectedRoot}${sep}`;
  if (normalize(sessionRoot) !== expectedRoot && !normalize(sessionRoot).startsWith(rootPrefix)) fail('config-policy', 'internal sessionRoot must remain below resolved control root');
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    controlRoot: expectedRoot,
    agentCwd: expectedRoot,
    sessionRoot,
    pluginManifest: expandControlPath(asString(value.pluginManifest, 'pluginManifest'), controlRoot),
    releaseChannel: asString(value.releaseChannel, 'releaseChannel'),
    configPolicy: value.configPolicy === 'internal-overrides-user' ? value.configPolicy : fail('config-policy', 'unsupported config policy'),
  };
}

function expandControlPath(value: string, controlRoot: string): string {
  if (value === '~/.humanagent') return controlRoot;
  if (value.startsWith('~/.humanagent/')) return join(controlRoot, value.slice('~/.humanagent/'.length));
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  if (isAbsolute(value)) return normalize(value);
  return normalize(join(controlRoot, value));
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(prefix);
}

async function canonicalizeControlRoot(requestedRoot: string): Promise<string> {
  try {
    const info = lstatSync(requestedRoot);
    if (info.isSymbolicLink()) fail('path-policy', 'control root cannot be a symlink', 'choose a real ~/.humanagent control root');
    return await realpath(requestedRoot);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    return canonicalizeMissingPath(requestedRoot);
  }
}

async function canonicalizeMissingPath(requested: string): Promise<string> {
  const parent = dirname(requested);
  if (parent === requested) return requested;
  try {
    const info = lstatSync(parent);
    if (info.isSymbolicLink()) fail('path-policy', `controlled path cannot traverse a symlink: ${parent}`, '移除 control root 下的 symlink 后重试');
    return join(await realpath(parent), requested.slice(parent.length + 1));
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    return join(await canonicalizeMissingPath(parent), requested.slice(parent.length + 1));
  }
}

async function canonicalizeControlledPath(value: string, controlRoot: string, label: string): Promise<string> {
  const requested = resolve(value);
  let canonical: string;
  try {
    const info = lstatSync(requested);
    if (info.isSymbolicLink()) fail('path-policy', `${label} cannot be a symlink`, `choose a real path below ${controlRoot}`);
    canonical = await realpath(requested);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    canonical = await canonicalizeMissingPath(requested);
  }
  if (!isWithin(controlRoot, canonical)) fail('path-policy', `${label} resolves outside control root`, `choose a path below ${controlRoot}`);
  return canonical;
}

function defaultInternalToml(): string {
  return [
    'schemaVersion = 1',
    'controlRoot = "~/.humanagent"',
    'agentCwd = "~/.humanagent"',
    'sessionRoot = "~/.humanagent/project"',
    'pluginManifest = "~/.humanagent/plugins/manifest.json"',
    'releaseChannel = "stable"',
    'configPolicy = "internal-overrides-user"',
    '',
  ].join('\n');
}

function defaultUserToml(): string {
  return [
    'schemaVersion = 1',
    '',
    '[[agents]]',
    'agentId = "interaction-default"',
    'roleId = "interaction"',
    'templateRef = "builtin/interaction@1.0.0"',
    'driverRef = "fake"',
    'skills = ["input-normalization", "task-matching", "confirmation"]',
    'tools = ["input.receive", "task.query", "proposal.render"]',
    'permissions = ["task.read", "task.propose"]',
    'memoryScopes = ["task", "organ", "approved-global"]',
    'resourceClass = "foreground"',
    '',
    '[[agents]]',
    'agentId = "orchestration-default"',
    'roleId = "orchestration"',
    'templateRef = "builtin/orchestration@1.0.0"',
    'driverRef = "fake"',
    'skills = ["stage-planning", "resource-planning", "result-checking"]',
    'tools = ["task.query", "queue.query", "assignment.create", "result.submit"]',
    'permissions = ["task.read", "assignment.create", "review.schedule"]',
    'memoryScopes = ["task", "organ", "approved-global"]',
    'resourceClass = "background"',
    '',
    '[project]',
    'defaultAgent = "interaction-default"',
    'reviewRequired = true',
    '',
    '[execution]',
    'maxConcurrentTasks = 1',
    'stopTimeoutMs = 30000',
    '',
  ].join('\n');
}

function configuredTemplateRoot(): string | undefined {
  const value = (globalThis as { process?: { env?: { HUMANAGENT_TEMPLATE_ROOT?: string } } }).process?.env?.HUMANAGENT_TEMPLATE_ROOT;
  return value && value.trim() ? value : undefined;
}

export async function resolveRuntimePaths(options: { readonly workspace: string; readonly controlRoot?: string }): Promise<RuntimePaths> {
  const environmentHome = (globalThis as { process?: { env?: { HUMANAGENT_HOME?: string } } }).process?.env?.HUMANAGENT_HOME;
  const controlRoot = await canonicalizeControlRoot(resolve(options.controlRoot ?? environmentHome ?? join(homedir(), '.humanagent')));
  const internalPath = join(controlRoot, 'internal.toml');
  rejectManagedFile(internalPath);
  const configuredInternal = validateInternalConfig(parseToml(await readRequired(internalPath, defaultInternalToml())), controlRoot);
  const sessionRoot = await canonicalizeControlledPath(configuredInternal.sessionRoot, controlRoot, 'sessionRoot');
  const pluginManifest = await canonicalizeControlledPath(configuredInternal.pluginManifest, controlRoot, 'pluginManifest');
  const workspaceInput = resolve(options.workspace);
  let workspaceCwd: string;
  try {
    workspaceCwd = await realpath(workspaceInput);
    if (!(await stat(workspaceCwd)).isDirectory()) fail('workspace-invalid', `workspace is not a directory: ${workspaceInput}`, '指定一个目录作为 --workspace');
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    fail('workspace-invalid', `workspace does not exist or is inaccessible: ${workspaceInput}`, '指定一个可访问的 workspace 目录');
  }
  const readableProjectKey = workspaceCwd.replaceAll(sep, '/').replaceAll('/', '-') || '-';
  const projectKey = await resolveProjectKey(sessionRoot, controlRoot, readableProjectKey, workspaceCwd);
  const projectRoot = join(sessionRoot, projectKey);
  return {
    controlRoot,
    agentCwd: controlRoot,
    workspaceCwd,
    projectKey,
    projectRoot,
    projectManifest: join(projectRoot, 'project.json'),
    sessionsRoot: join(projectRoot, 'sessions'),
    journalRoot: join(projectRoot, 'journal'),
    checkpointsRoot: join(projectRoot, 'checkpoints'),
    indexRoot: join(projectRoot, 'index'),
    artifactsRoot: join(projectRoot, 'artifacts'),
    memoryRoot: join(projectRoot, 'memory'),
    userRoot: join(controlRoot, 'user'),
    globalMemoryRoot: join(controlRoot, 'memory', 'global'),
    locksRoot: join(projectRoot, 'locks'),
    runNotesRoot: join(projectRoot, 'run-notes'),
  };
}

async function resolveProjectKey(sessionRoot: string, controlRoot: string, readableProjectKey: string, workspaceCwd: string): Promise<string> {
  const manifestPath = join(sessionRoot, readableProjectKey, 'project.json');
  rejectSymlinkComponents(manifestPath, controlRoot);
  let existing: { workspaceCwd?: string };
  try {
    existing = JSON.parse(await readFile(manifestPath, 'utf8')) as { workspaceCwd?: string };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return readableProjectKey;
    return readableProjectKey;
  }
  if (existing.workspaceCwd === workspaceCwd) return readableProjectKey;
  const suffix = createHash('sha256').update(workspaceCwd).digest('hex').slice(0, 16);
  return `${readableProjectKey}--${suffix}`;
}

export async function ensureControlLayout(paths: RuntimePaths): Promise<void> {
  if (!isAbsolute(paths.controlRoot) || !isAbsolute(paths.workspaceCwd) || paths.agentCwd !== paths.controlRoot) {
    fail('path-policy', 'control root and workspace must be absolute and agent cwd must equal control root');
  }
  const forbidden = normalize(paths.workspaceCwd) === normalize(paths.controlRoot);
  if (forbidden) fail('path-policy', 'control root must not be used as project workspace');
  const rootPrefix = normalize(paths.controlRoot).endsWith(sep) ? normalize(paths.controlRoot) : `${normalize(paths.controlRoot)}${sep}`;
  if (!normalize(paths.projectRoot).startsWith(rootPrefix)) fail('path-policy', 'project storage escaped control root');
  const directories = [
    paths.projectRoot, paths.sessionsRoot, paths.journalRoot, paths.checkpointsRoot, paths.indexRoot,
    paths.artifactsRoot, paths.memoryRoot, join(paths.memoryRoot, 'project'), join(paths.memoryRoot, 'tasks'),
    paths.userRoot, paths.globalMemoryRoot, join(paths.globalMemoryRoot, 'index'), join(paths.globalMemoryRoot, 'artifacts'),
    join(paths.globalMemoryRoot, 'summaries'), paths.locksRoot, paths.runNotesRoot, join(paths.controlRoot, 'plugins'),
  ];
  const files = [
    paths.projectManifest,
    join(paths.controlRoot, 'internal.toml'),
    join(paths.controlRoot, 'config.toml'),
    join(paths.userRoot, 'profile.toml'),
    join(paths.globalMemoryRoot, 'journal.jsonl'),
  ];
  for (const managedPath of [...directories, ...files]) {
    if (!isWithin(paths.controlRoot, managedPath)) fail('path-policy', `persistence path escaped control root: ${managedPath}`);
    rejectSymlinkComponents(managedPath, paths.controlRoot);
  }
  for (const directory of directories) await mkdir(directory, { recursive: true });
  await writeIfMissing(join(paths.controlRoot, 'internal.toml'), defaultInternalToml());
  await writeIfMissing(join(paths.controlRoot, 'config.toml'), defaultUserToml());
  await writeIfMissing(join(paths.userRoot, 'profile.toml'), 'schemaVersion = 1\n');
  await writeIfMissing(join(paths.globalMemoryRoot, 'journal.jsonl'), '');
  const project = JSON.stringify({ schemaVersion: 1, projectKey: paths.projectKey, workspaceCwd: paths.workspaceCwd }, null, 2) + '\n';
  let projectContents: string;
  try {
    rejectManagedFile(paths.projectManifest);
    projectContents = await readFile(paths.projectManifest, 'utf8');
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if ((error as { code?: string }).code !== 'ENOENT') fail('project-manifest-corrupt', 'project manifest is not valid JSON', '保留原文件并修复 project.json 后重试');
    await writeIfMissing(paths.projectManifest, project);
    projectContents = await readFile(paths.projectManifest, 'utf8');
  }
  let existing: { projectKey?: string; workspaceCwd?: string };
  try { existing = JSON.parse(projectContents) as { projectKey?: string; workspaceCwd?: string }; }
  catch { fail('project-manifest-corrupt', 'project manifest is not valid JSON', '保留原文件并修复 project.json 后重试'); }
  if (existing.projectKey !== paths.projectKey || existing.workspaceCwd !== paths.workspaceCwd) fail('project-identity-mismatch', 'project manifest does not match canonical workspace');
}

export async function resolveProjectLocalSkillSource(paths: RuntimePaths): Promise<ProjectLocalSkillSource> {
  rejectManagedFile(paths.projectManifest);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(paths.projectManifest, 'utf8')) as unknown;
  } catch (error) {
    fail('project-source-manifest-invalid', `project source manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, '修复 project.json 后重试');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('project-source-manifest-invalid', 'project source manifest must be an object', '修复 project.json 后重试');
  }
  const manifest = parsed as {
    readonly schemaVersion?: unknown;
    readonly projectKey?: unknown;
    readonly workspaceCwd?: unknown;
    readonly sources?: unknown;
  };
  if (manifest.schemaVersion !== 1 || manifest.projectKey !== paths.projectKey || manifest.workspaceCwd !== paths.workspaceCwd) {
    fail('project-source-manifest-invalid', 'project source manifest identity does not match resolved runtime paths', '重新解析 runtime paths 后修复 project.json');
  }
  const sources = manifest.sources;
  if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) {
    fail('project-source-missing', 'project source manifest does not declare a local Skill', 'declare sources.localSkill in project.json');
  }
  const localSkill = (sources as { readonly localSkill?: unknown }).localSkill;
  if (typeof localSkill !== 'object' || localSkill === null || Array.isArray(localSkill)) {
    fail('project-source-missing', 'project source manifest does not declare a local Skill', 'declare sources.localSkill in project.json');
  }
  const root = (localSkill as { readonly root?: unknown }).root;
  const name = (localSkill as { readonly name?: unknown }).name;
  if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) {
    fail('project-source-manifest-invalid', 'project local Skill root must be an absolute path', 'declare an absolute sources.localSkill.root in project.json');
  }
  const workspaceName = paths.workspaceCwd.split(/[\\/]/u).at(-1);
  if (typeof name !== 'string' || !name.trim() || name !== workspaceName) {
    fail('project-source-manifest-invalid', 'project local Skill name must equal the workspace basename', 'declare the unique cwd-named Skill in project.json');
  }
  return { root, name };
}

function rejectSymlinkComponents(candidate: string, controlRoot: string): void {
  let current = normalize(candidate);
  const normalizedRoot = normalize(controlRoot);
  while (isWithin(normalizedRoot, current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) fail('path-policy', `persistence path cannot contain a symlink: ${current}`, '移除 control root 下的 symlink 后重试');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    if (current === normalizedRoot) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  fail('path-policy', `persistence path escaped control root: ${candidate}`);
}

async function writeIfMissing(filePath: string, contents: string): Promise<void> {
  rejectManagedFile(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  try {
    const handle = await openFile(filePath, 'wx');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    rejectManagedFile(filePath);
  }
}

async function readRequired(filePath: string, fallback: string): Promise<string> {
  rejectManagedFile(filePath);
  try { return await readFile(filePath, 'utf8'); } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    await writeIfMissing(filePath, fallback);
    return readFile(filePath, 'utf8');
  }
}

function rejectManagedFile(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) fail('path-policy', `managed file cannot be a symlink: ${filePath}`, '移除 control root 下的 symlink 后重试');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}

export async function loadConfiguration(paths: RuntimePaths): Promise<LoadedConfiguration> {
  await ensureControlLayout(paths);
  const configuredInternal = validateInternalConfig(parseToml(await readRequired(join(paths.controlRoot, 'internal.toml'), defaultInternalToml())), paths.controlRoot);
  const internal = {
    ...configuredInternal,
    sessionRoot: await canonicalizeControlledPath(configuredInternal.sessionRoot, paths.controlRoot, 'sessionRoot'),
    pluginManifest: await canonicalizeControlledPath(configuredInternal.pluginManifest, paths.controlRoot, 'pluginManifest'),
  };
  if (normalize(paths.projectRoot) !== normalize(join(internal.sessionRoot, paths.projectKey))) fail('config-path-stale', 'runtime paths do not match internal sessionRoot', '重新解析 runtime paths 后重试');
  const user = validateUserConfig(parseToml(await readRequired(join(paths.controlRoot, 'config.toml'), defaultUserToml())));
  const projectConfigPath = join(paths.projectRoot, 'config.toml');
  let projectOverride: Partial<UserConfig> | undefined;
  try {
    rejectManagedFile(projectConfigPath);
    projectOverride = validateProjectOverride(parseToml(await readFile(projectConfigPath, 'utf8')));
  } catch (error) {
    if (!(error instanceof Error && (error as { code?: string }).code === 'ENOENT')) throw error;
  }
  if (projectOverride) validateProjectPolicy(user, projectOverride);
  const defaultAgent = user.project?.defaultAgent;
  if (defaultAgent !== undefined && !user.agents.some((agent) => agent.agentId === defaultAgent)) fail('config-invalid', `default agent not found: ${defaultAgent}`);
  const projectDefaultAgent = projectOverride?.project?.defaultAgent;
  if (projectDefaultAgent !== undefined && !user.agents.some((agent) => agent.agentId === projectDefaultAgent)) fail('config-invalid', 'project default agent not found: ' + projectDefaultAgent);
  const effective: UserConfig = {
    schemaVersion: user.schemaVersion,
    agents: [...user.agents],
    project: { ...user.project, ...projectOverride?.project },
    memory: projectOverride?.memory ?? user.memory,
    execution: { ...user.execution, ...projectOverride?.execution },
  };
  const templateRoot = configuredTemplateRoot();
  const promptCatalog: Partial<Record<AgentRole, LoadedAgentPromptSegments>> = {};
  if (templateRoot) {
    for (const roleId of AGENT_ROLES) {
      try {
        const agent = effective.agents.find((candidate) => candidate.roleId === roleId);
        const templateVersion = agent?.templateRef.slice(`builtin/${roleId}@`.length) ?? '1.0.0';
        promptCatalog[roleId] = await loadBuiltinPromptSegments(roleId, templateRoot, templateVersion);
      } catch (error) {
        fail('template-invalid', error instanceof Error ? error.message : String(error), '修复已安装 Agent prompt 文件后重试');
      }
    }
  }
  return { paths, internal, user, projectOverride, effective, agentRoster: [...effective.agents], promptCatalog };
}
