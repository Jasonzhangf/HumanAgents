/// <reference path="./node-modules.d.ts" />
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AuditPromptSnapshot,
  MemoryAuditPromptSnapshotSource,
  MemoryAuditPromptSourcePort,
  MemoryProjectSourcePort,
  MemoryProjectSourceSnapshot,
  MemorySessionEvidence,
  MemorySessionEvidenceSourcePort,
  MemorySourceSnapshot,
} from '../../../contracts/src/index.js';

export const MEMORY_SOURCE_ADAPTER_OWNER = 'memory-source-adapter';

export type MemorySourceErrorCode =
  | 'memory-source-invalid'
  | 'memory-source-unavailable'
  | 'memory-source-scope-denied'
  | 'memory-source-digest-mismatch';

export class MemorySourceError extends Error {
  constructor(
    readonly code: MemorySourceErrorCode,
    message: string,
    readonly ownerId = MEMORY_SOURCE_ADAPTER_OWNER,
    readonly nextAction = 'memory-source-ready',
  ) {
    super(message);
    this.name = 'MemorySourceError';
  }
}

export interface FilesystemMemorySourceOptions {
  readonly workspaceCwd: string;
  readonly sessionsRoot: string;
  readonly runNotesRoot: string;
  readonly projectKey: string;
  readonly localSkillRoot?: string;
  readonly localSkillName?: string;
  readonly auditPromptRoot: string;
  readonly now?: () => string;
}

interface SourceFile {
  readonly path: string;
  readonly canonicalRef: string;
  readonly content: string;
  readonly revision: string;
  readonly digest: string;
  readonly loadedAt: string;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new MemorySourceError('memory-source-invalid', `${label} is required`);
  return value;
}

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function revision(content: string): string {
  return digest(content);
}

function sourceRef(canonicalRef: string, digestValue: string): string {
  return `${canonicalRef}@${digestValue.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function requireSafeSegment(value: string, label: string): string {
  const segment = nonEmpty(value, label);
  if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
    throw new MemorySourceError('memory-source-invalid', `${label} must be a single path segment`);
  }
  return segment;
}

async function readSourceFile(input: {
  readonly root: string;
  readonly relativePath: string;
  readonly canonicalRef: string;
  readonly now: () => string;
}): Promise<SourceFile> {
  const root = await realpath(resolve(input.root)).catch(() => {
    throw new MemorySourceError('memory-source-unavailable', `memory source root is unavailable: ${input.root}`);
  });
  const candidate = resolve(root, input.relativePath);
  if (!isWithin(root, candidate)) {
    throw new MemorySourceError('memory-source-scope-denied', `memory source escapes its configured root: ${input.canonicalRef}`);
  }
  const canonical = await realpath(candidate).catch(() => {
    throw new MemorySourceError('memory-source-unavailable', `memory source is unavailable: ${input.canonicalRef}`);
  });
  if (!isWithin(root, canonical)) {
    throw new MemorySourceError('memory-source-scope-denied', `memory source resolves outside its configured root: ${input.canonicalRef}`);
  }
  const info = await lstat(canonical);
  if (!info.isFile()) {
    throw new MemorySourceError('memory-source-invalid', `memory source is not a file: ${input.canonicalRef}`);
  }
  const content = await readFile(canonical, 'utf8');
  const digestValue = digest(content);
  return {
    path: canonical,
    canonicalRef: input.canonicalRef,
    content,
    revision: revision(content),
    digest: digestValue,
    loadedAt: input.now(),
  };
}

function snapshot(source: SourceFile): MemorySourceSnapshot {
  return {
    sourceRef: sourceRef(source.canonicalRef, source.digest),
    canonicalRef: source.canonicalRef,
    revision: source.revision,
    digest: source.digest,
    loadedAt: source.loadedAt,
  };
}

export class FilesystemMemorySourceAdapter
implements MemorySessionEvidenceSourcePort, MemoryProjectSourcePort, MemoryAuditPromptSourcePort {
  private readonly now: () => string;

  constructor(private readonly options: FilesystemMemorySourceOptions) {
    nonEmpty(options.workspaceCwd, 'memory workspace');
    nonEmpty(options.sessionsRoot, 'memory sessions root');
    nonEmpty(options.runNotesRoot, 'memory run notes root');
    nonEmpty(options.projectKey, 'memory project key');
    if ((options.localSkillRoot === undefined) !== (options.localSkillName === undefined)) {
      throw new MemorySourceError('memory-source-invalid', 'memory local skill source root and name must be declared together');
    }
    if (options.localSkillRoot !== undefined) nonEmpty(options.localSkillRoot, 'memory local skill root');
    if (options.localSkillName !== undefined) requireSafeSegment(options.localSkillName, 'memory local skill name');
    nonEmpty(options.auditPromptRoot, 'memory audit prompt root');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async readSession(input: {
    readonly projectKey: string;
    readonly taskId: string;
    readonly sessionRef: string;
  }): Promise<MemorySessionEvidence> {
    if (input.projectKey !== this.options.projectKey) {
      throw new MemorySourceError('memory-source-scope-denied', 'memory session source belongs to another project');
    }
    const taskId = requireSafeSegment(input.taskId, 'memory session task id');
    const sessionRef = requireSafeSegment(input.sessionRef, 'memory session ref');
    const manifestSource = await readSourceFile({
      root: this.options.runNotesRoot,
      relativePath: `${sessionRef}.manifest.json`,
      canonicalRef: `run-manifest://${this.options.projectKey}/${sessionRef}`,
      now: this.now,
    });
    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(manifestSource.content) as unknown;
    } catch {
      throw new MemorySourceError('memory-source-invalid', `memory run manifest is invalid: ${sessionRef}`);
    }
    if (typeof parsedManifest !== 'object' || parsedManifest === null || Array.isArray(parsedManifest)) {
      throw new MemorySourceError('memory-source-invalid', `memory run manifest is invalid: ${sessionRef}`);
    }
    const manifest = parsedManifest as {
      readonly sessionId?: string;
      readonly taskId?: { readonly scope?: string; readonly value?: string };
    };
    if (
      manifest.sessionId !== sessionRef
      || typeof manifest.taskId !== 'object'
      || manifest.taskId === null
      || manifest.taskId.scope !== 'task'
      || manifest.taskId.value !== taskId
    ) {
      throw new MemorySourceError('memory-source-scope-denied', `memory session source is not bound to task ${taskId}`);
    }
    const source = await readSourceFile({
      root: this.options.sessionsRoot,
      relativePath: `${sessionRef}.jsonl`,
      canonicalRef: `session://${this.options.projectKey}/${taskId}/${sessionRef}`,
      now: this.now,
    });
    const records = source.content.split('\n').filter(Boolean).map((line, index) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('record is not an object');
        }
        return parsed as { readonly sessionId?: string; readonly projectKey?: string };
      } catch {
        throw new MemorySourceError('memory-source-invalid', `memory session source is invalid at line ${index + 1}`);
      }
    });
    if (records.length === 0) {
      throw new MemorySourceError('memory-source-invalid', `memory session source is empty: ${sessionRef}`);
    }
    for (const record of records) {
      if (record.sessionId !== sessionRef || record.projectKey !== this.options.projectKey) {
        throw new MemorySourceError('memory-source-scope-denied', `memory session source identity mismatch: ${sessionRef}`);
      }
    }
    return {
      ...snapshot(source),
      projectKey: this.options.projectKey,
      taskId,
      sessionRef,
      content: source.content,
    };
  }

  async readProject(input: {
    readonly projectKey: string;
    readonly target: 'project-agents' | 'project-local-skill';
  }): Promise<MemoryProjectSourceSnapshot> {
    if (input.projectKey !== this.options.projectKey) {
      throw new MemorySourceError('memory-source-scope-denied', 'memory project source belongs to another project');
    }
    if (input.target === 'project-agents') {
      const source = await readSourceFile({
        root: this.options.workspaceCwd,
        relativePath: 'AGENTS.md',
        canonicalRef: `project://${this.options.projectKey}/AGENTS.md`,
        now: this.now,
      });
      return { ...snapshot(source), projectKey: this.options.projectKey, target: input.target, content: source.content };
    }
    if (this.options.localSkillRoot === undefined || this.options.localSkillName === undefined) {
      throw new MemorySourceError(
        'memory-source-unavailable',
        'project local Skill source is not declared in project.json',
        MEMORY_SOURCE_ADAPTER_OWNER,
        'project.json#sources.localSkill',
      );
    }
    const source = await readSourceFile({
      root: this.options.localSkillRoot,
      relativePath: join(this.options.localSkillName, 'SKILL.md'),
      canonicalRef: `skill://project/${this.options.projectKey}/${this.options.localSkillName}/SKILL.md`,
      now: this.now,
    });
    return { ...snapshot(source), projectKey: this.options.projectKey, target: input.target, content: source.content };
  }

  async list(input: {
    readonly projectKey: string;
  }): Promise<readonly MemoryProjectSourceSnapshot[]> {
    if (input.projectKey !== this.options.projectKey) {
      throw new MemorySourceError('memory-source-scope-denied', 'memory project source belongs to another project');
    }
    const sources = await Promise.all([
      this.readProject({ projectKey: input.projectKey, target: 'project-agents' }),
      this.readProject({ projectKey: input.projectKey, target: 'project-local-skill' }),
    ]);
    return sources;
  }

  async readPrompt(input: {
    readonly projectKey: string;
    readonly promptRef: string;
  }): Promise<MemoryAuditPromptSnapshotSource> {
    if (input.projectKey !== this.options.projectKey) {
      throw new MemorySourceError('memory-source-scope-denied', 'memory audit prompt belongs to another project');
    }
    const promptRef = nonEmpty(input.promptRef, 'memory audit prompt ref');
    const source = await readSourceFile({
      root: this.options.auditPromptRoot,
      relativePath: `${promptRef}.md`,
      canonicalRef: `prompt://${this.options.projectKey}/${promptRef}`,
      now: this.now,
    });
    return { ...snapshot(source), promptRef, content: source.content };
  }
}

export function auditPromptSnapshot(input: MemoryAuditPromptSnapshotSource): AuditPromptSnapshot {
  return {
    promptRef: input.promptRef,
    canonicalRef: input.canonicalRef,
    revision: input.revision,
    digest: input.digest,
    loadedAt: input.loadedAt,
  };
}

export function projectSourceRef(input: MemoryProjectSourceSnapshot): string {
  return input.sourceRef;
}
