import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ImmutableAssetStore } from '../../adapters/filesystem/src/index.js';
import type {
  AgentDriver,
  EvidenceRef,
  MemoryCandidateCategory,
  MemoryActorContext,
  MemoryInteractionPort,
  MemoryProjectSourcePort,
  MemoryProjectSourceSnapshot,
  CanonicalMemoryScope,
  MemoryScope,
  ProjectSourcePatchArtifact,
  ProjectSourceUpdateProposal,
  ScopeRef,
} from '../../contracts/src/index.js';
import {
  MEMORY_SCOPE_COMPATIBILITY_VERSION,
  canonicalMemoryScopeToLegacy,
  id,
  legacyMemoryScopeToCanonical,
  validateProjectSourcePatchArtifact,
} from '../../contracts/src/index.js';
import type { LoadedConfiguration, RuntimePaths } from '../../config/src/index.js';
import {
  DeterministicMemoryBackend,
  FilesystemMemorySourceAdapter,
  RootedMemoryPersistence,
  type MemoryPersistencePort,
} from '../../adapters/memory/src/index.js';
import {
  MemoryAgent,
  MemoryCoordinator,
  createMemoryInteractionPort,
  createMemoryAnalysisEventHandler,
  memoryAnalysisBarrierDriver,
  memoryAgentIssue,
  type MemoryAnalysisAdmissionPort,
  type MemoryAnalysisAdmissionReceipt,
  type MemoryAnalysisWakeBinding,
  type MemoryAgentOutcome,
  type MemoryProjectUpdateOwnerPort,
  type MemorySourceUpdateReceipt,
} from '../../runtime/src/memory/index.js';
import { prepareBuiltinAuditPrompt } from '../../agent-templates/src/index.js';
import type { MemorySubmissionPort } from '../../runtime/src/explicit-brain/index.js';
import type {
  EventConsumerHandler,
  EventExternalOperation,
  EventExternalOperationPort,
  EventOperationBarrierDriver,
} from '../../runtime/src/events/index.js';
import { AppLifecycleError } from './errors.js';

const OWNER = 'humanagent.app.memory-composition';
const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 5_000;

export interface MemoryEvidenceSnapshot {
  readonly sourceRef: string;
  readonly sourceDigest: string;
  readonly text: string;
}

export interface MemoryEvidenceSourcePort {
  read(input: {
    readonly projectKey: string;
    readonly scope: MemoryScope;
    readonly evidence: EvidenceRef;
  }): Promise<MemoryEvidenceSnapshot>;
}

export interface MemoryProjectPatchReader {
  read(input: {
    readonly proposal: ProjectSourceUpdateProposal;
    readonly current: MemoryProjectSourceSnapshot;
  }): Promise<{ readonly content: string }>;
}

export interface MemoryProjectSourceUpdatePublisher {
  publish(input: {
    readonly receipt: MemorySourceUpdateReceipt;
    readonly scope: ScopeRef;
    readonly executionEpoch: number;
    readonly occurredAt: string;
  }): Promise<void>;
}

export function createTypedProjectPatchReader(artifactsRoot: string): MemoryProjectPatchReader {
  const store = new ImmutableAssetStore(artifactsRoot);
  return {
    async read({ proposal, current }): Promise<{ readonly content: string }> {
      try {
        const bytes = await store.readByDigest(proposal.patchRef, proposal.patchDigest);
        const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as ProjectSourcePatchArtifact;
        validateProjectSourcePatchArtifact(envelope);
        if (envelope.target !== proposal.target) throw new Error('project source patch target does not match proposal');
        if (envelope.evidenceRefs.length !== proposal.evidenceRefs.length
          || envelope.evidenceRefs.some((ref, index) => ref !== proposal.evidenceRefs[index])) {
          throw new Error('project source patch evidence does not match proposal');
        }
        if (envelope.payload.type !== 'memory-entry') {
          throw new Error('project source patch payload is not auto-applicable');
        }
        const entry = `\n\n## Memory Agent ${envelope.kind}\n\n- Evidence: ${envelope.evidenceRefs.join(', ')}\n`;
        return {
          content: current.content.endsWith('\n') ? `${current.content}${entry.slice(1)}` : `${current.content}${entry}`,
        };
      } catch (error) {
        throw new AppLifecycleError(
          'memory-update-validation-failed',
          `project source patch artifact is unavailable or drifted: ${error instanceof Error ? error.message : String(error)}`,
          'regenerate the typed project source patch artifact',
          OWNER,
        );
      }
    },
  };
}

export interface MemoryBoundaryPatchReference {
  readonly patchRef: string;
  readonly patchDigest: string;
}

export function createMemoryBoundaryPatchProducer(input: {
  readonly autoUpdate: boolean;
  readonly artifactsRoot: string;
  readonly projectKey: string;
  readonly sources: MemoryProjectSourcePort;
}): (input: {
  readonly messageId: string;
  readonly summary: string;
  readonly candidateCategory: MemoryCandidateCategory;
  readonly evidenceRefs: readonly string[];
}) => Promise<MemoryBoundaryPatchReference | undefined> {
  const store = new ImmutableAssetStore(input.artifactsRoot);
  return async ({ messageId, candidateCategory, evidenceRefs }) => {
    if (!input.autoUpdate) return undefined;
    const target = candidateCategory === 'local-skill-update' ? 'project-local-skill' :
      candidateCategory === 'project-experience' ? 'project-agents' : undefined;
    if (!target) return undefined;
    await input.sources.readProject({ projectKey: input.projectKey, target });
    const kind: ProjectSourcePatchArtifact['kind'] = candidateCategory === 'local-skill-update'
      ? 'local-skill-update'
      : 'project-experience';
    const artifact: ProjectSourcePatchArtifact = {
      schemaVersion: 1,
      kind,
      target,
      payload: { type: 'memory-entry' },
      evidenceRefs: [...evidenceRefs],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(artifact));
    const reference = await store.write(`memory-project-patch-${createHash('sha256').update(messageId).digest('hex')}`, bytes);
    return { patchRef: reference.assetId, patchDigest: reference.digest };
  };
}

export interface MemoryCompositionInput {
  readonly paths: RuntimePaths;
  readonly projectKey: string;
  readonly workspaceCwd: string;
  readonly sessionsRoot: string;
  readonly runNotesRoot: string;
  readonly localSkillRoot?: string;
  readonly localSkillName?: string;
  readonly auditPromptRoot: string;
  readonly auditPromptRef: string;
  readonly autoUpdate: boolean;
  readonly binding: MemoryAnalysisWakeBinding;
  readonly taskScope?: CanonicalMemoryScope;
  readonly mainAgentId?: string;
  readonly assignmentId?: string;
  readonly agentRuntimeId?: string;
  readonly roleId?: string;
  readonly evidenceSource?: MemoryEvidenceSourcePort;
  readonly patchReader?: MemoryProjectPatchReader;
  readonly projectSourceUpdatePublisher?: MemoryProjectSourceUpdatePublisher;
  readonly driver?: AgentDriver;
  readonly driverFor?: (input: {
    readonly taskId: import('../../contracts/src/index.js').TaskId;
    readonly operationId: import('../../contracts/src/index.js').OperationId;
    readonly executionEpoch: number;
    readonly assignmentId: string;
    readonly scope: CanonicalMemoryScope;
  }) => AgentDriver;
  readonly externalOperations?: EventExternalOperationPort & {
    commitExternalOperation?(operation: EventExternalOperation): Promise<unknown>;
  };
  readonly feedbackPublisher?: {
    publish(event: import('../../runtime/src/events/index.js').EventEnvelope): Promise<void>;
  };
  readonly explicitSubmissionPublisher?: (input: {
    readonly submission: import('../../contracts/src/index.js').MemorySubmission;
    readonly receipt: import('../../contracts/src/index.js').MemorySubmissionReceipt;
  }) => Promise<void>;
  readonly explicitSubmissionPreparer?: (
    submission: import('../../contracts/src/index.js').MemorySubmission,
  ) => Promise<void>;
  readonly explicitSubmissionAborter?: (
    submission: import('../../contracts/src/index.js').MemorySubmission,
  ) => Promise<void>;
  readonly state?: import('../../contracts/src/index.js').MemoryAgentStatePort;
}

interface PendingProjectSourceUpdate {
  readonly schemaVersion: 1;
  readonly receipt: MemorySourceUpdateReceipt;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly occurredAt: string;
}

const PROJECT_SOURCE_UPDATE_PENDING = 'memory-project-source-update.pending.json';

function pendingProjectSourceUpdatePath(locksRoot: string): string {
  return join(locksRoot, PROJECT_SOURCE_UPDATE_PENDING);
}

function validatePendingProjectSourceUpdate(value: unknown): PendingProjectSourceUpdate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppLifecycleError(
      'memory-update-recovery-invalid',
      'pending project source update is invalid',
      'preserve the pending update and inspect its durable record',
      OWNER,
    );
  }
  const pending = value as Partial<PendingProjectSourceUpdate>;
  const receipt = pending.receipt;
  const scope = pending.scope;
  const validScopeId = (candidate: unknown, kind: string): boolean => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
    const scoped = candidate as { readonly scope?: unknown; readonly value?: unknown };
    return scoped.scope === kind && typeof scoped.value === 'string' && scoped.value.trim().length > 0;
  };
  const validScope = typeof scope === 'object'
    && scope !== null
    && !Array.isArray(scope)
    && validScopeId((scope as ScopeRef).organId, 'organ')
    && ((scope as ScopeRef).taskId === undefined || validScopeId((scope as ScopeRef).taskId, 'task'))
    && ((scope as ScopeRef).cycleId === undefined || validScopeId((scope as ScopeRef).cycleId, 'cycle'))
    && ((scope as ScopeRef).operationId === undefined || validScopeId((scope as ScopeRef).operationId, 'operation'));
  const validReceipt = typeof receipt === 'object'
    && receipt !== null
    && !Array.isArray(receipt)
    && ((receipt as MemorySourceUpdateReceipt).target === 'project-agents'
      || (receipt as MemorySourceUpdateReceipt).target === 'project-local-skill')
    && typeof (receipt as MemorySourceUpdateReceipt).sourceRef === 'string'
    && (receipt as MemorySourceUpdateReceipt).sourceRef.trim().length > 0
    && typeof (receipt as MemorySourceUpdateReceipt).previousRevision === 'string'
    && (receipt as MemorySourceUpdateReceipt).previousRevision.trim().length > 0
    && typeof (receipt as MemorySourceUpdateReceipt).previousDigest === 'string'
    && (receipt as MemorySourceUpdateReceipt).previousDigest.trim().length > 0
    && typeof (receipt as MemorySourceUpdateReceipt).nextRevision === 'string'
    && (receipt as MemorySourceUpdateReceipt).nextRevision.trim().length > 0
    && typeof (receipt as MemorySourceUpdateReceipt).nextDigest === 'string'
    && (receipt as MemorySourceUpdateReceipt).nextDigest.trim().length > 0
    && typeof (receipt as MemorySourceUpdateReceipt).patchRef === 'string'
    && (receipt as MemorySourceUpdateReceipt).patchRef.trim().length > 0
    && typeof (receipt as MemorySourceUpdateReceipt).patchDigest === 'string'
    && (receipt as MemorySourceUpdateReceipt).patchDigest.trim().length > 0
    && Array.isArray((receipt as MemorySourceUpdateReceipt).evidenceRefs)
    && (receipt as MemorySourceUpdateReceipt).evidenceRefs.every(
      (ref) => typeof ref === 'string' && ref.trim().length > 0,
    );
  if (
    pending.schemaVersion !== 1
    || !validReceipt
    || (receipt as MemorySourceUpdateReceipt).updated !== true
    || !validScope
    || !Number.isSafeInteger(pending.executionEpoch)
    || pending.executionEpoch! < 1
    || typeof pending.occurredAt !== 'string'
    || !Number.isFinite(Date.parse(pending.occurredAt))
  ) {
    throw new AppLifecycleError(
      'memory-update-recovery-invalid',
      'pending project source update is incomplete',
      'preserve the pending update and inspect its durable record',
      OWNER,
    );
  }
  return pending as PendingProjectSourceUpdate;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function persistPendingProjectSourceUpdate(
  locksRoot: string,
  pending: PendingProjectSourceUpdate,
): Promise<void> {
  await mkdir(locksRoot, { recursive: true });
  const path = pendingProjectSourceUpdatePath(locksRoot);
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(pending)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
    await syncDirectory(locksRoot);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function clearPendingProjectSourceUpdate(locksRoot: string): Promise<void> {
  await rm(pendingProjectSourceUpdatePath(locksRoot));
  await syncDirectory(locksRoot);
}

async function readPendingProjectSourceUpdate(
  locksRoot: string,
): Promise<PendingProjectSourceUpdate | undefined> {
  try {
    return validatePendingProjectSourceUpdate(
      JSON.parse(await readFile(pendingProjectSourceUpdatePath(locksRoot), 'utf8')),
    );
  } catch (error) {
    if ((error as { readonly code?: string }).code === 'ENOENT') return undefined;
    if (error instanceof AppLifecycleError) throw error;
    throw new AppLifecycleError(
      'memory-update-recovery-invalid',
      `pending project source update cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      'preserve the pending update and inspect its durable record',
      OWNER,
    );
  }
}

export interface MemoryComposition {
  readonly backend: DeterministicMemoryBackend;
  readonly coordinator: MemoryCoordinator;
  readonly interaction: MemoryInteractionPort;
  readonly submissions: MemorySubmissionPort;
  readonly bindingRef: string;
  readonly persistence: MemoryPersistencePort;
  readonly sources: FilesystemMemorySourceAdapter;
  readonly agent: MemoryAgent;
  readonly admission: MemoryAnalysisAdmissionPort;
  readonly eventHandler: EventConsumerHandler;
  readonly barrierDriver: EventOperationBarrierDriver;
}

export interface RuntimeMemoryCompositionInput {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
}

export async function composeRuntimeMemory(
  input: RuntimeMemoryCompositionInput,
): Promise<MemoryComposition> {
  const projectKey = input.paths.projectKey;
  const workspaceCwd = input.paths.workspaceCwd;
  const auditPromptRoot = join(input.paths.controlRoot, 'memory-audit');
  const auditPromptRef = input.configuration.effective.memory?.audit.promptRef ?? 'project-memory-audit';
  const templateRoot = (globalThis as {
    readonly process?: { readonly env?: { readonly HUMANAGENT_TEMPLATE_ROOT?: string } };
  }).process?.env?.HUMANAGENT_TEMPLATE_ROOT;
  if (!templateRoot) {
    throw new AppLifecycleError(
      'memory-audit-prompt-unavailable',
      'builtin template root is not configured',
      'configure the locked builtin template root before composing memory',
      OWNER,
    );
  }
  await prepareBuiltinAuditPrompt({ templateRoot, promptRef: auditPromptRef, destinationRoot: auditPromptRoot });
  const actor: MemoryActorContext = {
    actorId: 'memory-agent',
    roleId: 'memory',
    permissions: ['memory.read', 'memory.propose'],
    projectKey,
  };
  return composeMemory({
    paths: input.paths,
    projectKey,
    workspaceCwd,
    sessionsRoot: input.paths.sessionsRoot,
    runNotesRoot: input.paths.runNotesRoot,
    localSkillRoot: input.configuration.projectSourceManifest.sources?.localSkill?.root,
    localSkillName: input.configuration.projectSourceManifest.sources?.localSkill?.name,
    auditPromptRoot,
    auditPromptRef,
    autoUpdate: input.configuration.effective.memory?.update.auto ?? false,
    binding: {
      bindingRef: `memory-binding:${projectKey}`,
      projectKey,
      executionEpoch: 1,
      scope: {
        namespace: 'project',
        projectKey,
        organId: id('organ', 'humanagent-ui'),
      },
      interactionScopeId: `runtime:${projectKey}`,
      mainAgentId: 'humanagent-ui',
      actor,
    },
  });
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(): string {
  return createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex');
}

function processAlive(pid: number): boolean {
  try {
    (process as unknown as { kill(pid: number, signal: number): void }).kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

interface SourceUpdateLockOwner {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

async function readSourceUpdateLockOwner(ownerPath: string): Promise<SourceUpdateLockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(ownerPath, 'utf8')) as Partial<SourceUpdateLockOwner>;
    if (
      typeof parsed.pid === 'number'
      && typeof parsed.token === 'string'
      && parsed.token.length > 0
      && typeof parsed.startedAt === 'string'
    ) {
      return { pid: parsed.pid, token: parsed.token, startedAt: parsed.startedAt };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function evictDeadSourceUpdateLock(lockPath: string, expected: SourceUpdateLockOwner): Promise<boolean> {
  const guardPath = `${lockPath}.evict`;
  try {
    await mkdir(guardPath);
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const current = await readSourceUpdateLockOwner(join(lockPath, 'owner.json'));
    if (!current || current.pid !== expected.pid || current.token !== expected.token) return false;
    const stalePath = `${lockPath}.stale-${process.pid}-${Date.now().toString(36)}-${randomToken()}`;
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return true;
      throw error;
    }
    await rm(stalePath, { recursive: true, force: true });
    return true;
  } finally {
    await rm(guardPath, { recursive: true, force: true });
  }
}

async function acquireSourceUpdateLock(lockRoot: string, label: string): Promise<{ readonly path: string; readonly token: string }> {
  const lockPath = join(lockRoot, 'memory-project-source-update.lock');
  const ownerPath = join(lockPath, 'owner.json');
  const token = randomToken();
  const deadline = Date.now() + LOCK_WAIT_MS;
  await mkdir(lockRoot, { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, 'utf8');
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return { path: lockPath, token };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      const owner = await readSourceUpdateLockOwner(ownerPath);
      if (owner && !processAlive(owner.pid)) {
        if (await evictDeadSourceUpdateLock(lockPath, owner)) continue;
      }
      if (Date.now() >= deadline) {
        throw new AppLifecycleError('memory-update-conflict', `${label} is locked by another memory update`, 'wait for the other memory update to finish and retry', OWNER);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function releaseSourceUpdateLock(lock: { readonly path: string; readonly token: string }): Promise<void> {
  const owner = await readSourceUpdateLockOwner(join(lock.path, 'owner.json'));
  if (owner?.pid === process.pid && owner.token === lock.token) {
    await rm(lock.path, { recursive: true, force: true });
  }
}

function assertRoot(root: string, candidate: string, label: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new AppLifecycleError(
      'memory-path-invalid',
      `${label} escapes its configured root`,
      'keep memory persistence under the HumanAgent control root',
      OWNER,
    );
  }
}

async function assertNoSymlinkBelow(root: string, candidate: string, label: string): Promise<void> {
  try {
    if ((await lstat(root)).isSymbolicLink()) {
      throw new AppLifecycleError(
        'memory-path-invalid',
        `${label} root is a symlink: ${root}`,
        'use a real project source path without symlinks',
        OWNER,
      );
    }
  } catch (error) {
    if (error instanceof AppLifecycleError) throw error;
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const relativePath = relative(root, candidate);
  if (relativePath === '') return;
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new AppLifecycleError(
          'memory-path-invalid',
          `${label} contains a symlink: ${current}`,
          'use a real project source path without symlinks',
          OWNER,
        );
      }
    } catch (error) {
      if (error instanceof AppLifecycleError) throw error;
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      return;
    }
  }
}

async function resolveProjectSourcePath(root: string, relativePath: string, label: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, relativePath);
  assertRoot(absoluteRoot, candidate, label);
  await assertNoSymlinkBelow(absoluteRoot, candidate, label);
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(absoluteRoot),
    realpath(candidate),
  ]).catch((error: unknown) => {
    throw new AppLifecycleError(
      'memory-update-conflict',
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'refresh the proposal from the configured project source',
      OWNER,
    );
  });
  assertRoot(canonicalRoot, canonicalCandidate, label);
  return canonicalCandidate;
}

async function assertCompositionPath(root: string, candidate: string, label: string): Promise<void> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    realpath(root),
    realpath(candidate),
  ]);
  assertRoot(canonicalRoot, canonicalCandidate, label);
}

async function assertCompositionPathEquals(actual: string, expected: string, label: string): Promise<void> {
  const [canonicalActual, canonicalExpected] = await Promise.all([realpath(actual), realpath(expected)]);
  if (canonicalActual !== canonicalExpected) {
    throw new AppLifecycleError(
      'memory-path-invalid',
      `${label} does not match the resolved runtime path`,
      'compose memory from the resolved runtime paths',
      OWNER,
    );
  }
}

async function projectSourcePath(input: {
  readonly target: ProjectSourceUpdateProposal['target'];
  readonly workspaceCwd: string;
  readonly localSkillRoot?: string;
  readonly localSkillName?: string;
}): Promise<string> {
  const targetRoot = input.target === 'project-agents' ? input.workspaceCwd : input.localSkillRoot;
  if (!targetRoot || (input.target === 'project-local-skill' && !input.localSkillName)) {
    throw new AppLifecycleError(
      'memory-update-unavailable',
      'project local Skill source is not declared in project.json',
      '补全 project.json sources.localSkill 后重试',
      OWNER,
    );
  }
  return resolveProjectSourcePath(
    targetRoot,
    input.target === 'project-agents' ? 'AGENTS.md' : join(input.localSkillName!, 'SKILL.md'),
    'project source update',
  );
}

async function reconcilePendingProjectSourceUpdate(input: {
  readonly workspaceCwd: string;
  readonly localSkillRoot?: string;
  readonly localSkillName?: string;
  readonly locksRoot: string;
  readonly publisher: MemoryProjectSourceUpdatePublisher;
}): Promise<void> {
  const pending = await readPendingProjectSourceUpdate(input.locksRoot);
  if (!pending) return;
  const path = await projectSourcePath({
    target: pending.receipt.target,
    workspaceCwd: input.workspaceCwd,
    localSkillRoot: input.localSkillRoot,
    localSkillName: input.localSkillName,
  });
  const currentDigest = digest(await readFile(path, 'utf8'));
  if (currentDigest === pending.receipt.previousDigest) {
    await clearPendingProjectSourceUpdate(input.locksRoot);
    return;
  }
  if (currentDigest !== pending.receipt.nextDigest) {
    throw new AppLifecycleError(
      'memory-update-recovery-conflict',
      'project source changed while a durable update fact was pending',
      'preserve the pending update and reconcile the project source before retrying',
      OWNER,
    );
  }
  await input.publisher.publish({
    receipt: pending.receipt,
    scope: pending.scope,
    executionEpoch: pending.executionEpoch,
    occurredAt: pending.occurredAt,
  });
  await clearPendingProjectSourceUpdate(input.locksRoot);
}

async function recoverPendingProjectSourceUpdate(input: {
  readonly workspaceCwd: string;
  readonly localSkillRoot?: string;
  readonly localSkillName?: string;
  readonly locksRoot: string;
  readonly publisher: MemoryProjectSourceUpdatePublisher;
}): Promise<void> {
  const lock = await acquireSourceUpdateLock(input.locksRoot, 'project source update recovery');
  try {
    await reconcilePendingProjectSourceUpdate(input);
  } finally {
    await releaseSourceUpdateLock(lock);
  }
}

export function createProjectSourceUpdateOwner(input: {
  readonly workspaceCwd: string;
  readonly localSkillRoot?: string;
  readonly localSkillName?: string;
  readonly projectKey: string;
  readonly locksRoot: string;
  readonly patchReader?: MemoryProjectPatchReader;
  readonly projectSourceUpdatePublisher?: MemoryProjectSourceUpdatePublisher;
  readonly sourceScope?: ScopeRef;
  readonly executionEpoch?: number;
}): MemoryProjectUpdateOwnerPort {
  return {
    async apply({ proposal, current, auto }): Promise<MemorySourceUpdateReceipt> {
      if (!auto) throw new AppLifecycleError('memory-update-disabled', 'memory project auto update is disabled', 'keep the proposal for owner review', OWNER);
      if (proposal.target !== 'project-agents' && proposal.target !== 'project-local-skill') {
        throw new AppLifecycleError('memory-update-target-denied', 'memory update target is not project-scoped', 'use project AGENTS.md or the cwd-named local Skill', OWNER);
      }
      if (current.projectKey !== input.projectKey || current.target !== proposal.target) {
        throw new AppLifecycleError('memory-update-conflict', 'project source identity does not match the configured owner', 'refresh the proposal from the configured project source', OWNER);
      }
      if (proposal.target === 'project-local-skill' && (!input.localSkillRoot || !input.localSkillName)) {
        throw new AppLifecycleError(
          'memory-update-unavailable',
          'project local Skill source is not declared in project.json',
          '补全 project.json sources.localSkill 后重试',
          OWNER,
        );
      }
      if (proposal.sourceRef !== current.sourceRef
        || proposal.expectedRevision !== current.revision
        || proposal.expectedDigest !== current.digest) {
        throw new AppLifecycleError('memory-update-conflict', 'project source changed before compare-and-commit', 'refresh the proposal before retrying', OWNER);
      }
      if (!input.patchReader) {
        throw new AppLifecycleError(
          'memory-update-unavailable',
          'project source patch reader is not configured',
          'configure a typed patch reader before enabling memory auto update',
          OWNER,
        );
      }
      const lock = await acquireSourceUpdateLock(input.locksRoot, 'project source update');
      try {
        if (input.projectSourceUpdatePublisher) {
          await reconcilePendingProjectSourceUpdate({
            workspaceCwd: input.workspaceCwd,
            localSkillRoot: input.localSkillRoot,
            localSkillName: input.localSkillName,
            locksRoot: input.locksRoot,
            publisher: input.projectSourceUpdatePublisher,
          });
        }
        const path = await projectSourcePath({
          target: proposal.target,
          workspaceCwd: input.workspaceCwd,
          localSkillRoot: input.localSkillRoot,
          localSkillName: input.localSkillName,
        });
        const before = await readFile(path, 'utf8');
        if (digest(before) !== current.digest) {
          throw new AppLifecycleError('memory-update-conflict', 'project source digest changed before compare-and-commit', 'refresh the proposal before retrying', OWNER);
        }
        const patch = await input.patchReader.read({ proposal, current });
        if (!patch.content.trim()) {
          throw new AppLifecycleError('memory-update-invalid', 'project source patch reader returned empty content', 'produce a non-empty source update', OWNER);
        }
        const nextDigest = digest(patch.content);
        if (!input.projectSourceUpdatePublisher || !input.sourceScope || input.executionEpoch === undefined) {
          throw new AppLifecycleError(
            'memory-update-publication-unavailable',
            'project source auto update requires a durable update publisher',
            'compose the project source owner from the runtime-bound memory composition',
            OWNER,
          );
        }
        const receipt: MemorySourceUpdateReceipt = {
          target: proposal.target,
          sourceRef: current.sourceRef,
          previousRevision: current.revision,
          previousDigest: current.digest,
          nextRevision: nextDigest,
          nextDigest,
          patchRef: proposal.patchRef,
          patchDigest: proposal.patchDigest,
          updated: true,
          evidenceRefs: [...proposal.evidenceRefs],
        };
        const pending: PendingProjectSourceUpdate = {
          schemaVersion: 1,
          receipt,
          scope: input.sourceScope,
          executionEpoch: input.executionEpoch,
          occurredAt: new Date().toISOString(),
        };
        await persistPendingProjectSourceUpdate(input.locksRoot, pending);
        await mkdir(dirname(path), { recursive: true });
        const verifiedPath = await projectSourcePath({
          target: proposal.target,
          workspaceCwd: input.workspaceCwd,
          localSkillRoot: input.localSkillRoot,
          localSkillName: input.localSkillName,
        });
        if (verifiedPath !== path) {
          throw new AppLifecycleError('memory-update-conflict', 'project source path changed before compare-and-commit', 'refresh the proposal before retrying', OWNER);
        }
        const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
        let renameCommitted = false;
        try {
          const handle = await open(temp, 'wx');
          try {
            await handle.writeFile(patch.content, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          const committedPath = await projectSourcePath({
            target: proposal.target,
            workspaceCwd: input.workspaceCwd,
            localSkillRoot: input.localSkillRoot,
            localSkillName: input.localSkillName,
          });
          if (committedPath !== path) {
            throw new AppLifecycleError('memory-update-conflict', 'project source path changed before commit', 'refresh the proposal before retrying', OWNER);
          }
          const currentBeforeCommit = await readFile(path, 'utf8');
          if (digest(currentBeforeCommit) !== current.digest) {
            throw new AppLifecycleError('memory-update-conflict', 'project source changed before commit', 'refresh the proposal before retrying', OWNER);
          }
          await rename(temp, path);
          renameCommitted = true;
          await syncDirectory(dirname(path));
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          if (!renameCommitted) {
            await clearPendingProjectSourceUpdate(input.locksRoot).catch(() => undefined);
          }
          throw error;
        }
        const committed = await readFile(path, 'utf8');
        const committedDigest = digest(committed);
        if (committedDigest !== nextDigest) {
          throw new AppLifecycleError('memory-update-verification-failed', 'project source verification failed after commit', 'preserve the original source and inspect the update', OWNER);
        }
        try {
          await input.projectSourceUpdatePublisher.publish({
            receipt,
            scope: input.sourceScope,
            executionEpoch: input.executionEpoch,
            occurredAt: pending.occurredAt,
          });
          await clearPendingProjectSourceUpdate(input.locksRoot);
        } catch (error) {
          throw new AppLifecycleError(
            'memory-update-publication-failed',
            `project source update committed with a durable recovery record, but its event was not published: ${error instanceof Error ? error.message : String(error)}`,
            'restart the runtime to reconcile memory.project-source.updated',
            OWNER,
          );
        }
        return receipt;
      } finally {
        await releaseSourceUpdateLock(lock);
      }
    },
  };
}

function createAdmission(
  agent: MemoryAgent,
  backend: DeterministicMemoryBackend,
  evidenceSource?: MemoryEvidenceSourcePort,
): MemoryAnalysisAdmissionPort {
  return {
    async admit({ request, event }): Promise<MemoryAgentOutcome<MemoryAnalysisAdmissionReceipt>> {
      for (const evidence of event.evidenceRefs) {
        if (!evidenceSource) {
          return {
            status: 'attention',
            issue: memoryAgentIssue(
              'memory-agent-source-invalid',
              'attention',
              `memory evidence reader is not configured: ${evidence.locator}`,
              'memory-evidence-reader',
            ),
          };
        }
        if (!evidence.digest?.trim()) {
          return {
            status: 'attention',
            issue: memoryAgentIssue(
              'memory-agent-source-invalid',
              'attention',
              `memory evidence digest is missing: ${evidence.locator}`,
              'memory-source-integrity',
            ),
          };
        }
        let source: MemoryEvidenceSnapshot;
        try {
          const evidenceScope: MemoryScope = evidence.scope.taskId
            ? { kind: 'task', organId: evidence.scope.organId, taskId: evidence.scope.taskId }
            : { kind: 'organ', organId: evidence.scope.organId };
          source = await evidenceSource.read({
            projectKey: request.projectKey,
            scope: evidenceScope,
            evidence,
          });
        } catch (error) {
          return {
            status: 'attention',
            issue: memoryAgentIssue(
              'memory-agent-source-unavailable',
              'attention',
              error instanceof Error
                ? `${error.message}: ${evidence.locator}`
                : `memory evidence is unavailable: ${evidence.locator}`,
              'memory-evidence-ready',
            ),
          };
        }
        const textDigest = digest(source.text);
        if (
          source.sourceRef !== evidence.locator
          || source.sourceDigest !== evidence.digest
          || textDigest !== source.sourceDigest
          || textDigest !== evidence.digest
          || !source.text.trim()
        ) {
          return {
            status: 'attention',
            issue: memoryAgentIssue(
              'memory-agent-source-invalid',
              'attention',
              `memory evidence digest or identity drifted: ${evidence.locator}`,
              'memory-source-integrity',
            ),
          };
        }
        await backend.ingest({
          scope: canonicalMemoryScopeToLegacy({
            compatibilityVersion: MEMORY_SCOPE_COMPATIBILITY_VERSION,
            scope: request.scope,
          }),
          sourceRef: source.sourceRef,
          sourceDigest: source.sourceDigest,
          text: source.text,
        });
      }
      const result = await agent.analyze(request);
      if (result.status !== 'ready') return result;
      return {
        status: 'ready',
        value: {
          admissionRef: `memory-analysis:${request.operationId.value}`,
          result: result.value,
          effectRefs: result.value.submission?.candidateId === undefined
            ? []
            : [`memory-candidate:${result.value.submission.candidateId}`],
        },
      };
    },
  };
}

function bindCoordinator(
  coordinator: MemoryCoordinator,
  input: MemoryCompositionInput,
  backend: DeterministicMemoryBackend,
): { readonly interactionBindingRef?: string } {
  const taskId = input.binding.taskId;
  const hasRuntimeBinding = input.agentRuntimeId !== undefined || input.roleId !== undefined;
  if (input.binding.interactionScopeId !== undefined && (
    taskId !== undefined
    || input.assignmentId !== undefined
    || hasRuntimeBinding
  )) {
    throw new AppLifecycleError(
      'memory-binding-invalid',
      'interaction binding cannot also use a task binding',
      'use exactly one memory binding kind',
      OWNER,
    );
  }
  if (input.assignmentId !== undefined && taskId === undefined) {
    throw new AppLifecycleError(
      'memory-binding-incomplete',
      'memory assignment requires a task binding',
      'provide the task id or omit the assignment binding',
      OWNER,
    );
  }
  if (hasRuntimeBinding && (
    taskId === undefined
    || input.assignmentId === undefined
    || input.agentRuntimeId === undefined
    || input.roleId === undefined
  )) {
    throw new AppLifecycleError(
      'memory-binding-incomplete',
      'memory runtime binding requires taskId, assignmentId, agentRuntimeId, and roleId',
      'provide all runtime binding fields or omit the runtime binding',
      OWNER,
    );
  }
  if (taskId !== undefined && input.assignmentId !== undefined) {
    coordinator.bindTask({
      bindingRef: input.binding.bindingRef,
      taskId,
      assignmentId: input.assignmentId,
      executionEpoch: input.binding.executionEpoch,
      projectKey: input.projectKey,
      scope: input.taskScope ?? input.binding.scope,
      backendRef: 'memory://deterministic',
      indexVersion: backend.indexVersion,
      operations: backend,
      injection: backend,
    });
  }
  if (input.binding.interactionScopeId !== undefined) {
    const interaction = coordinator.bindInteraction({
      interactionScopeId: input.binding.interactionScopeId,
      projectKey: input.projectKey,
      backendRef: 'memory://deterministic',
      indexVersion: backend.indexVersion,
      operations: backend,
      injection: backend,
    });
    return { interactionBindingRef: interaction.bindingId };
  }
  if (hasRuntimeBinding) {
    const outcome = coordinator.bindRuntime({
      agentRuntimeId: input.agentRuntimeId!,
      taskId: taskId!,
      assignmentId: input.assignmentId!,
      roleId: input.roleId!,
      executionEpoch: input.binding.executionEpoch,
    });
    if (outcome.status !== 'ready') {
      throw new AppLifecycleError(
        'memory-binding-invalid',
        outcome.issue.message,
        outcome.issue.nextAction.ref ?? 'memory-binding',
        OWNER,
      );
    }
  }
  return {};
}

export async function composeMemory(input: MemoryCompositionInput): Promise<MemoryComposition> {
  if (input.projectKey !== input.paths.projectKey || input.binding.projectKey !== input.paths.projectKey) {
    throw new AppLifecycleError(
      'memory-project-mismatch',
      'memory composition project identity does not match the configured runtime paths',
      'compose memory with the project key bound to the resolved runtime paths',
      OWNER,
    );
  }
  if (input.autoUpdate && !input.patchReader) {
    input = {
      ...input,
      patchReader: createTypedProjectPatchReader(input.paths.artifactsRoot),
    };
  }
  if (input.autoUpdate && !input.projectSourceUpdatePublisher) {
    throw new AppLifecycleError(
      'memory-update-publication-unavailable',
      'memory auto update requires a durable project source update publisher',
      'compose memory through the runtime Event Journal owner',
      OWNER,
    );
  }
  try {
    await assertCompositionPathEquals(input.workspaceCwd, input.paths.workspaceCwd, 'memory workspace');
    await assertCompositionPathEquals(input.sessionsRoot, input.paths.sessionsRoot, 'memory sessions root');
    await assertCompositionPathEquals(input.runNotesRoot, input.paths.runNotesRoot, 'memory run notes root');
    if (input.localSkillRoot !== undefined && input.localSkillName === undefined) {
      throw new AppLifecycleError(
        'memory-path-invalid',
        'memory local skill name is missing for the declared source root',
        'resolve project.json sources.localSkill before composing memory',
        OWNER,
      );
    }
    if (input.localSkillRoot !== undefined) await realpath(input.localSkillRoot);
    await assertCompositionPath(input.paths.controlRoot, input.auditPromptRoot, 'memory audit prompt root');
  } catch (error) {
    if (error instanceof AppLifecycleError) throw error;
    throw new AppLifecycleError(
      'memory-path-invalid',
      `memory composition path is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'resolve the configured project roots before composing memory',
      OWNER,
    );
  }
  if (input.projectSourceUpdatePublisher) {
    await recoverPendingProjectSourceUpdate({
      workspaceCwd: input.workspaceCwd,
      localSkillRoot: input.localSkillRoot,
      localSkillName: input.localSkillName,
      locksRoot: input.paths.locksRoot,
      publisher: input.projectSourceUpdatePublisher,
    });
  }
  const persistence = new RootedMemoryPersistence({
    project: join(input.paths.memoryRoot, 'project'),
    global: input.paths.globalMemoryRoot,
  });
  const backend = await DeterministicMemoryBackend.fromPersistence(persistence);
  const sources = new FilesystemMemorySourceAdapter({
    workspaceCwd: input.workspaceCwd,
    sessionsRoot: input.sessionsRoot,
    runNotesRoot: input.runNotesRoot,
    projectKey: input.projectKey,
    localSkillRoot: input.localSkillRoot,
    localSkillName: input.localSkillName,
    auditPromptRoot: input.auditPromptRoot,
  });
  const agent = new MemoryAgent({
    projectKey: input.projectKey,
    auditPromptRef: input.auditPromptRef,
    autoUpdate: input.autoUpdate,
    sessions: sources,
    projectSources: sources,
    auditPrompts: sources,
    projectUpdateOwner: createProjectSourceUpdateOwner({
      workspaceCwd: input.workspaceCwd,
      localSkillRoot: input.localSkillRoot,
      localSkillName: input.localSkillName,
      projectKey: input.projectKey,
      locksRoot: input.paths.locksRoot,
      ...(input.patchReader === undefined ? {} : { patchReader: input.patchReader }),
      ...(input.projectSourceUpdatePublisher === undefined ? {} : {
        projectSourceUpdatePublisher: input.projectSourceUpdatePublisher,
        sourceScope: input.taskScope
          ? {
              organId: input.taskScope.namespace === 'project' ? input.taskScope.organId : { scope: 'organ' as const, value: 'global' },
              ...(input.taskScope.namespace === 'project' && input.taskScope.taskId ? { taskId: input.taskScope.taskId } : {}),
            }
          : {
              organId: input.binding.scope.namespace === 'project'
                ? input.binding.scope.organId
                : { scope: 'organ' as const, value: 'global' },
              ...(input.binding.scope.namespace === 'project' && input.binding.scope.taskId
                ? { taskId: input.binding.scope.taskId }
                : {}),
            },
        executionEpoch: input.binding.executionEpoch,
      }),
    }),
    ...(input.driver === undefined ? {} : { driver: input.driver }),
    ...(input.driverFor === undefined ? {} : { driverFor: input.driverFor }),
    ...(input.state === undefined ? {} : { state: input.state }),
  });
  agent.bind({
    bindingRef: input.binding.bindingRef,
    projectKey: input.binding.projectKey,
    scope: input.binding.scope,
    ...(input.binding.taskId === undefined ? {} : { taskId: input.binding.taskId }),
    ...(input.binding.interactionScopeId === undefined ? {} : { interactionScopeId: input.binding.interactionScopeId }),
    mainAgentId: input.mainAgentId ?? input.binding.mainAgentId,
    executionEpoch: input.binding.executionEpoch,
    ownerId: 'memory-agent',
    operations: backend,
  });
  const admission = createAdmission(agent, backend, input.evidenceSource);
  const eventHandler = createMemoryAnalysisEventHandler({
    binding: input.binding,
    admission,
  });
  const barrierDriver = memoryAnalysisBarrierDriver({
    binding: input.binding,
    admission,
    externalOperations: input.externalOperations ?? {
      readExternalOperation: async () => {
        throw new AppLifecycleError(
          'memory-external-operation-owner-missing',
          'memory analysis external operation owner is not configured',
          'compose memory with the durable EventBus external operation port',
          OWNER,
        );
      },
      commitExternalOperation: async () => {
        throw new AppLifecycleError(
          'memory-external-operation-owner-missing',
          'memory analysis external operation owner is not configured',
          'compose memory with the durable EventBus external operation port',
          OWNER,
        );
      },
    },
    ...(input.feedbackPublisher === undefined
      ? {}
      : { publishFeedback: (event) => input.feedbackPublisher!.publish(event) }),
  });
  const coordinator = new MemoryCoordinator();
  const coordinatorBindings = bindCoordinator(coordinator, input, backend);
  const interaction = createMemoryInteractionPort({
    coordinator,
    bindingFor: ({ projectKey, namespace }) => {
      if (projectKey !== input.projectKey) return undefined;
      if (coordinatorBindings.interactionBindingRef !== undefined) {
        return {
          projectKey,
          namespace,
          bindingRef: coordinatorBindings.interactionBindingRef,
        };
      }
      if (input.binding.taskId === undefined) return undefined;
      return {
        projectKey,
        namespace,
        taskId: input.binding.taskId,
        bindingRef: input.binding.bindingRef,
      };
    },
  });
  const submissions: MemorySubmissionPort = {
    async submitCandidate(submission) {
      await input.explicitSubmissionPreparer?.(submission);
      let outcome: Awaited<ReturnType<MemoryCoordinator['submitCandidate']>>;
      try {
        outcome = await coordinator.submitCandidate(submission);
      } catch (error) {
        await input.explicitSubmissionAborter?.(submission);
        throw error;
      }
      if (outcome.status === 'ready') {
        if (input.explicitSubmissionPublisher) {
          await input.explicitSubmissionPublisher({
            submission,
            receipt: outcome.value,
          });
        }
        return outcome.value;
      }
      await input.explicitSubmissionAborter?.(submission);
      throw new AppLifecycleError(
        outcome.issue.code,
        outcome.issue.message,
        outcome.issue.nextAction.ref ?? 'memory-submission',
        outcome.issue.ownerId,
      );
    },
  };
  return {
    backend,
    coordinator,
    interaction,
    submissions,
    bindingRef: coordinatorBindings.interactionBindingRef ?? input.binding.bindingRef,
    persistence,
    sources,
    agent,
    admission,
    eventHandler,
    barrierDriver,
  };
}
