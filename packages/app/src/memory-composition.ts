import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  EvidenceRef,
  MemoryActorContext,
  MemoryInteractionPort,
  MemoryProjectSourceSnapshot,
  MemoryScope,
  ProjectSourceUpdateProposal,
} from '../../contracts/src/index.js';
import { id } from '../../contracts/src/index.js';
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
  readonly mainAgentId?: string;
  readonly assignmentId?: string;
  readonly agentRuntimeId?: string;
  readonly roleId?: string;
  readonly evidenceSource?: MemoryEvidenceSourcePort;
  readonly patchReader?: MemoryProjectPatchReader;
  readonly externalOperations?: EventExternalOperationPort & {
    commitExternalOperation?(operation: EventExternalOperation): Promise<unknown>;
  };
  readonly state?: import('../../contracts/src/index.js').MemoryAgentStatePort;
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
  await mkdir(auditPromptRoot, { recursive: true });
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
    auditPromptRef: input.configuration.effective.memory?.audit.promptRef ?? 'project-memory-audit',
    autoUpdate: input.configuration.effective.memory?.update.auto ?? false,
    binding: {
      bindingRef: `memory-binding:${projectKey}`,
      projectKey,
      executionEpoch: 1,
      scope: { kind: 'organ', organId: id('organ', 'humanagent-ui') },
      interactionScopeId: `runtime:${projectKey}`,
      mainAgentId: 'humanagent-ui',
      actor,
    },
  });
}

function digest(value: string): string {
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

export function createProjectSourceUpdateOwner(input: {
  readonly workspaceCwd: string;
  readonly localSkillRoot?: string;
  readonly localSkillName?: string;
  readonly projectKey: string;
  readonly locksRoot: string;
  readonly patchReader?: MemoryProjectPatchReader;
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
        const targetRoot = proposal.target === 'project-agents' ? input.workspaceCwd : input.localSkillRoot!;
        const relativePath = proposal.target === 'project-agents'
          ? 'AGENTS.md'
          : join(input.localSkillName!, 'SKILL.md');
        const path = await resolveProjectSourcePath(targetRoot, relativePath, 'project source update');
        const before = await readFile(path, 'utf8');
        if (digest(before) !== current.digest) {
          throw new AppLifecycleError('memory-update-conflict', 'project source digest changed before compare-and-commit', 'refresh the proposal before retrying', OWNER);
        }
        const patch = await input.patchReader.read({ proposal, current });
        if (!patch.content.trim()) {
          throw new AppLifecycleError('memory-update-invalid', 'project source patch reader returned empty content', 'produce a non-empty source update', OWNER);
        }
        const nextDigest = digest(patch.content);
        await mkdir(dirname(path), { recursive: true });
        const verifiedPath = await resolveProjectSourcePath(targetRoot, relativePath, 'project source update');
        if (verifiedPath !== path) {
          throw new AppLifecycleError('memory-update-conflict', 'project source path changed before compare-and-commit', 'refresh the proposal before retrying', OWNER);
        }
        const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
        try {
          const handle = await open(temp, 'wx');
          try {
            await handle.writeFile(patch.content, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          const committedPath = await resolveProjectSourcePath(targetRoot, relativePath, 'project source update');
          if (committedPath !== path) {
            throw new AppLifecycleError('memory-update-conflict', 'project source path changed before commit', 'refresh the proposal before retrying', OWNER);
          }
          const currentBeforeCommit = await readFile(path, 'utf8');
          if (digest(currentBeforeCommit) !== current.digest) {
            throw new AppLifecycleError('memory-update-conflict', 'project source changed before commit', 'refresh the proposal before retrying', OWNER);
          }
          await rename(temp, path);
          const directory = await open(dirname(path), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
        const committed = await readFile(path, 'utf8');
        const committedDigest = digest(committed);
        if (committedDigest !== nextDigest) {
          throw new AppLifecycleError('memory-update-verification-failed', 'project source verification failed after commit', 'preserve the original source and inspect the update', OWNER);
        }
        return {
          target: proposal.target,
          sourceRef: current.sourceRef,
          previousRevision: current.revision,
          previousDigest: current.digest,
          nextRevision: nextDigest,
          nextDigest,
          updated: true,
          evidenceRefs: [...proposal.evidenceRefs],
        };
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
              error instanceof Error ? error.message : `memory evidence is unavailable: ${evidence.locator}`,
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
          scope: request.scope,
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
      scope: input.binding.scope,
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
    throw new AppLifecycleError(
      'memory-update-unavailable',
      'memory auto update requires a typed project source patch reader',
      'configure a typed patch reader before enabling memory auto update',
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
    }),
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
      const outcome = await coordinator.submitCandidate(submission);
      if (outcome.status === 'ready') return outcome.value;
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
