import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import type { RuntimePaths, LoadedConfiguration } from '../../config/src/index.js';
import type {
  EventConsumerBinding,
  EventBusPorts,
  TrustedEventPublisher,
} from '../../runtime/src/events/index.js';
import { consumeEvents, publishEvent } from '../../runtime/src/events/index.js';
import {
  id,
  validateMemorySubmission,
  type Checkpoint,
  type EvidenceRef,
  type MemorySubmission,
  type ScopeRef,
} from '../../contracts/src/index.js';
import {
  createMemoryAnalysisRequestedEvent,
  createMemoryProjectSourceUpdatedEvent,
  type MemoryAnalysisTrigger,
  type MemoryAnalysisWakeBinding,
} from '../../runtime/src/memory/index.js';
import { createJsonlEventJournal, type JsonlEventJournal } from './event-journal.js';
import {
  checkpointClosureEvidenceDigest,
  checkpointClosureEvidenceLocator,
  checkpointEvidenceDigest,
  checkpointEvidenceLocator,
  readCheckpointEvidence,
  readCommittedCheckpoint,
} from './checkpoint-journal.js';
import type { ClosureRecord } from '../../runtime/src/checkpoints/closure.js';
import type { MemoryRewindChain } from '../../runtime/src/memory/index.js';
import {
  composeMemory,
  createMemoryBoundaryPatchProducer,
  type MemoryComposition,
  type MemoryCompositionInput,
  type MemoryEvidenceSourcePort,
} from './memory-composition.js';
import { AppLifecycleError } from './errors.js';
import { prepareBuiltinAuditPrompt } from '../../agent-templates/src/index.js';

const OWNER = 'humanagent.app.memory-runtime';
const PUBLISHER_ID = 'memory-boundary-publisher';
const EXPLICIT_SUBMISSION_PENDING_ROOT = 'memory-explicit-submissions';

interface PendingExplicitSubmission {
  readonly schemaVersion: 1;
  readonly submission: MemorySubmission;
  readonly bindingRef: string;
  readonly consumerKey: string;
  readonly streamId: string;
  readonly scope: ScopeRef;
  readonly executionEpoch: number;
  readonly occurredAt: string;
}

export interface MemoryRuntimeInput extends Omit<MemoryCompositionInput, 'paths' | 'projectKey'> {
  readonly paths: RuntimePaths;
  readonly configuration: LoadedConfiguration;
  readonly checkpointEvidence?: MemoryRuntimeCheckpointEvidencePort;
}

export interface MemoryRuntimeCheckpointEvidencePort {
  readCommitted(input: {
    readonly checkpoint: Checkpoint;
  }): Promise<{ readonly checkpoint: Checkpoint; readonly recordDigest: string }>;
  readEvidence(input: {
    readonly evidence: EvidenceRef;
  }): Promise<{ readonly sourceRef: string; readonly sourceDigest: string; readonly text: string }>;
}

export interface MemoryRuntimeBoundaryPublisher {
  publish(input: {
    readonly checkpoint: Checkpoint;
    readonly recordDigest: string;
    readonly trigger: MemoryAnalysisTrigger;
    readonly relatedCheckpoints?: readonly Checkpoint[];
    readonly rewind?: {
      readonly failedCheckpoint: Checkpoint;
      readonly failedCheckpointRecordDigest: string;
      readonly recoveryCheckpoint: Checkpoint;
      readonly recoveryCheckpointRecordDigest: string;
      readonly reentry: ClosureRecord;
    };
  }): Promise<void>;
}

export interface MemoryRuntimeEventConsumer {
  consume(input?: { readonly limit?: number }): Promise<Awaited<ReturnType<typeof consumeEvents>>>;
}

export interface MemoryAnalysisStatus {
  readonly mode: 'model' | 'deterministic';
  readonly state: 'idle' | 'running' | 'succeeded' | 'waiting' | 'failed' | 'unknown';
  readonly operationRef?: string;
  readonly failureRef?: string;
}

export interface MemoryReviewCandidateState {
  readonly candidateId: string;
  readonly state: 'candidate' | 'approved' | 'rejected';
  readonly namespace: 'project' | 'global';
  readonly projectKey: string;
  readonly taskId?: string;
  readonly category: import('../../contracts/src/index.js').MemoryCandidateCategory;
  readonly kind: import('../../contracts/src/index.js').MemoryKind;
  readonly summary: string;
  readonly sourceRefs: readonly string[];
  readonly sourceDigests: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface MemoryReviewState {
  readonly analysis: MemoryAnalysisStatus;
  readonly autoUpdate: boolean;
  readonly candidates: readonly MemoryReviewCandidateState[];
}

export interface MemoryRuntime {
  readonly composition: MemoryComposition;
  readonly journal: JsonlEventJournal;
  readonly ports: EventBusPorts;
  readonly publisher: {
    prepareProjectPatch(input: {
      readonly event: ReturnType<typeof createMemoryAnalysisRequestedEvent>;
      readonly checkpoint: Checkpoint;
    }): Promise<ReturnType<typeof createMemoryAnalysisRequestedEvent>>;
    publish(input: {
      readonly event: ReturnType<typeof createMemoryAnalysisRequestedEvent>;
      readonly checkpoint: Checkpoint;
      readonly recordDigest: string;
    }): Promise<void>;
  };
  readonly boundaryPublisher: MemoryRuntimeBoundaryPublisher;
  readonly consume: MemoryRuntimeEventConsumer['consume'];
  readonly reviewState: () => Promise<MemoryReviewState>;
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.organId.value === right.organId.value
    && left.taskId?.value === right.taskId?.value
    && left.cycleId?.value === right.cycleId?.value
    && left.operationId?.value === right.operationId?.value;
}

function bindingScope(binding: MemoryAnalysisWakeBinding): ScopeRef {
  if (binding.scope.namespace !== 'project') {
    throw new AppLifecycleError(
      'memory-boundary-scope-invalid',
      'memory boundary events require a project-scoped binding',
      'configure the memory binding with project scope',
      OWNER,
    );
  }
  return {
    organId: binding.scope.organId,
    ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }),
  };
}

function sameEvidence(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.locator === right.locator
    && left.digest === right.digest
    && sameScope(left.scope, right.scope);
}

function isScopedId(value: unknown, kind: string): value is { readonly scope: string; readonly value: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly scope?: unknown; readonly value?: unknown };
  return candidate.scope === kind && typeof candidate.value === 'string' && candidate.value.trim().length > 0;
}

function isScopeRef(value: unknown): value is ScopeRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as {
    readonly organId?: unknown;
    readonly taskId?: unknown;
    readonly cycleId?: unknown;
    readonly operationId?: unknown;
  };
  return isScopedId(candidate.organId, 'organ')
    && (candidate.taskId === undefined || isScopedId(candidate.taskId, 'task'))
    && (candidate.cycleId === undefined || isScopedId(candidate.cycleId, 'cycle'))
    && (candidate.operationId === undefined || isScopedId(candidate.operationId, 'operation'));
}

function explicitSubmissionPendingRoot(locksRoot: string, bindingRef: string): string {
  return join(
    locksRoot,
    EXPLICIT_SUBMISSION_PENDING_ROOT,
    createHash('sha256').update(bindingRef).digest('hex'),
  );
}

function explicitSubmissionPendingPath(input: {
  readonly locksRoot: string;
  readonly bindingRef: string;
  readonly submissionId: string;
}): string {
  return join(
    explicitSubmissionPendingRoot(input.locksRoot, input.bindingRef),
    `${createHash('sha256').update(input.submissionId).digest('hex')}.json`,
  );
}

function validatePendingExplicitSubmission(value: unknown): PendingExplicitSubmission {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppLifecycleError(
      'memory-explicit-submission-recovery-invalid',
      'pending explicit memory submission is invalid',
      'preserve the pending submission and inspect its durable record',
      OWNER,
    );
  }
  const pending = value as Partial<PendingExplicitSubmission>;
  try {
    if (pending.schemaVersion !== 1) throw new Error('schema version is invalid');
    validateMemorySubmission(pending.submission as MemorySubmission);
    if (typeof pending.bindingRef !== 'string' || !pending.bindingRef.trim()) throw new Error('bindingRef is required');
    if (typeof pending.consumerKey !== 'string' || !pending.consumerKey.trim()) throw new Error('consumerKey is required');
    if (typeof pending.streamId !== 'string' || !pending.streamId.trim()) throw new Error('streamId is required');
    if (!isScopeRef(pending.scope)) throw new Error('scope is invalid');
    if (!Number.isSafeInteger(pending.executionEpoch) || pending.executionEpoch! < 1) throw new Error('executionEpoch is invalid');
    if (typeof pending.occurredAt !== 'string' || !Number.isFinite(Date.parse(pending.occurredAt))) {
      throw new Error('occurredAt is invalid');
    }
  } catch (error) {
    throw new AppLifecycleError(
      'memory-explicit-submission-recovery-invalid',
      `pending explicit memory submission is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'preserve the pending submission and inspect its durable record',
      OWNER,
    );
  }
  return pending as PendingExplicitSubmission;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function persistPendingExplicitSubmission(input: {
  readonly locksRoot: string;
  readonly pending: PendingExplicitSubmission;
}): Promise<PendingExplicitSubmission> {
  const root = explicitSubmissionPendingRoot(input.locksRoot, input.pending.bindingRef);
  await mkdir(root, { recursive: true });
  const path = explicitSubmissionPendingPath({
    locksRoot: input.locksRoot,
    bindingRef: input.pending.bindingRef,
    submissionId: input.pending.submission.submissionId,
  });
  const existing = await loadPendingExplicitSubmission(path);
  if (existing) {
    const sameIntent = existing.schemaVersion === input.pending.schemaVersion
      && existing.bindingRef === input.pending.bindingRef
      && existing.consumerKey === input.pending.consumerKey
      && existing.streamId === input.pending.streamId
      && existing.executionEpoch === input.pending.executionEpoch
      && sameScope(existing.scope, input.pending.scope)
      && JSON.stringify(existing.submission) === JSON.stringify(input.pending.submission);
    if (!sameIntent) {
      throw new AppLifecycleError(
        'memory-explicit-submission-recovery-conflict',
        `pending explicit memory submission identity conflicts with durable state: ${input.pending.submission.submissionId}`,
        'preserve the pending submission and inspect its durable record',
        OWNER,
      );
    }
    return existing;
  }
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(input.pending)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, path);
    await rm(temp);
    await syncDirectory(root);
    return input.pending;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    if ((error as { readonly code?: string }).code === 'EEXIST') {
      const raced = await loadPendingExplicitSubmission(path);
      if (raced) return raced;
    }
    throw error;
  }
}

async function loadPendingExplicitSubmission(path: string): Promise<PendingExplicitSubmission | undefined> {
  try {
    return validatePendingExplicitSubmission(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as { readonly code?: string }).code === 'ENOENT') return undefined;
    if (error instanceof AppLifecycleError) throw error;
    throw new AppLifecycleError(
      'memory-explicit-submission-recovery-invalid',
      `pending explicit memory submission cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      'preserve the pending submission and inspect its durable record',
      OWNER,
    );
  }
}

async function readPendingExplicitSubmission(path: string): Promise<PendingExplicitSubmission> {
  const pending = await loadPendingExplicitSubmission(path);
  if (!pending) {
    throw new AppLifecycleError(
      'memory-explicit-submission-recovery-missing',
      `pending explicit memory submission is missing: ${path}`,
      'preserve the accepted submission and inspect its durable record',
      OWNER,
    );
  }
  return pending;
}

async function clearPendingExplicitSubmission(input: {
  readonly locksRoot: string;
  readonly bindingRef: string;
  readonly submissionId: string;
}): Promise<void> {
  const root = explicitSubmissionPendingRoot(input.locksRoot, input.bindingRef);
  const path = explicitSubmissionPendingPath(input);
  try {
    await rm(path);
    await syncDirectory(root);
  } catch (error) {
    if ((error as { readonly code?: string }).code === 'ENOENT') return;
    throw error;
  }
}

function assertPendingExplicitSubmissionBinding(input: {
  readonly pending: PendingExplicitSubmission;
  readonly binding: MemoryRuntimeInput['binding'];
  readonly consumer: EventConsumerBinding;
}): void {
  if (
    input.pending.bindingRef !== input.binding.bindingRef
    || input.pending.consumerKey !== input.consumer.consumerKey
    || input.pending.streamId !== input.consumer.streamIds[0]
    || input.pending.executionEpoch !== input.binding.executionEpoch
    || !sameScope(input.pending.scope, input.consumer.scope)
  ) {
    throw new AppLifecycleError(
      'memory-explicit-submission-recovery-binding-mismatch',
      'pending explicit memory submission does not match the active wake binding',
      'recover the submission with its original memory binding',
      OWNER,
    );
  }
}

async function publishPendingExplicitSubmission(input: {
  readonly pending: PendingExplicitSubmission;
  readonly evidenceSource: MemoryEvidenceSourcePort;
  readonly ports: EventBusPorts;
}): Promise<void> {
  const { submission, scope, executionEpoch, occurredAt, streamId } = input.pending;
  const unsupportedEvidence = submission.evidenceRefs.find((ref) => ref !== submission.contentRef);
  if (unsupportedEvidence !== undefined) {
    throw new AppLifecycleError(
      'memory-explicit-submission-evidence-unsupported',
      `explicit submission evidence cannot be verified without a digest: ${unsupportedEvidence}`,
      'submit only the verified contentRef until the evidence source can provide a digest',
      OWNER,
    );
  }
  const contentEvidence: EvidenceRef = {
    evidenceId: id('evidence', `memory-submission-${createHash('sha256').update(submission.submissionId).digest('hex')}`),
    kind: 'operation',
    source: OWNER,
    locator: submission.contentRef,
    digest: submission.contentDigest,
    scope,
  };
  const content = await input.evidenceSource.read({
    projectKey: submission.projectKey,
    scope: scope.taskId === undefined
      ? { kind: 'organ', organId: scope.organId }
      : { kind: 'task', organId: scope.organId, taskId: scope.taskId },
    evidence: contentEvidence,
  });
  if (
    content.sourceRef !== submission.contentRef
    || content.sourceDigest !== submission.contentDigest
    || `sha256:${createHash('sha256').update(content.text).digest('hex')}` !== submission.contentDigest
    || !content.text.trim()
  ) {
    throw new AppLifecycleError(
      'memory-explicit-submission-evidence-invalid',
      `explicit submission content digest or identity drifted: ${submission.contentRef}`,
      'refresh the submitted content evidence before requesting memory analysis',
      OWNER,
    );
  }
  const event = createMemoryAnalysisRequestedEvent({
    messageId: `memory-submission-${createHash('sha256').update(submission.submissionId).digest('hex')}`,
    streamId,
    scope,
    occurredAt,
    summary: submission.observation,
    evidenceRefs: [contentEvidence],
    executionEpoch,
    trigger: 'explicit-submission',
    requestedKind: submission.requestedKind,
    candidateCategory: submission.candidateCategory,
  });
  await publishEvent(input.ports, { publisherId: PUBLISHER_ID, event });
}

async function validateExplicitSubmissionEvidence(input: {
  readonly submission: MemorySubmission;
  readonly scope: ScopeRef;
  readonly evidenceSource: MemoryEvidenceSourcePort;
}): Promise<void> {
  const unsupportedEvidence = input.submission.evidenceRefs.find((ref) => ref !== input.submission.contentRef);
  if (unsupportedEvidence !== undefined) {
    throw new AppLifecycleError(
      'memory-explicit-submission-evidence-unsupported',
      `explicit submission evidence cannot be verified without a digest: ${unsupportedEvidence}`,
      'submit only the verified contentRef until the evidence source can provide a digest',
      OWNER,
    );
  }
  const contentEvidence: EvidenceRef = {
    evidenceId: id('evidence', `memory-submission-${createHash('sha256').update(input.submission.submissionId).digest('hex')}`),
    kind: 'operation',
    source: OWNER,
    locator: input.submission.contentRef,
    digest: input.submission.contentDigest,
    scope: input.scope,
  };
  const content = await input.evidenceSource.read({
    projectKey: input.submission.projectKey,
    scope: input.scope.taskId === undefined
      ? { kind: 'organ', organId: input.scope.organId }
      : { kind: 'task', organId: input.scope.organId, taskId: input.scope.taskId },
    evidence: contentEvidence,
  });
  if (
    content.sourceRef !== input.submission.contentRef
    || content.sourceDigest !== input.submission.contentDigest
    || `sha256:${createHash('sha256').update(content.text).digest('hex')}` !== input.submission.contentDigest
    || !content.text.trim()
  ) {
    throw new AppLifecycleError(
      'memory-explicit-submission-evidence-invalid',
      `explicit submission content digest or identity drifted: ${input.submission.contentRef}`,
      'refresh the submitted content evidence before requesting memory analysis',
      OWNER,
    );
  }
}

function explicitSubmissionScope(input: {
  readonly binding: MemoryRuntimeInput['binding'];
  readonly submission: MemorySubmission;
  readonly consumer: EventConsumerBinding;
}): ScopeRef {
  if (input.binding.interactionScopeId === undefined && input.submission.taskId === undefined) {
    throw new AppLifecycleError(
      'memory-explicit-submission-scope-missing',
      'task-bound memory submission is missing its task identity',
      'refresh the trusted task binding before submitting memory',
      OWNER,
    );
  }
  if (input.binding.interactionScopeId === undefined && input.submission.taskId?.value !== input.binding.taskId?.value) {
    throw new AppLifecycleError(
      'memory-explicit-submission-scope-mismatch',
      'memory submission task does not match the wake binding',
      'submit through the trusted task binding',
      OWNER,
    );
  }
  return input.consumer.scope;
}

function createPendingExplicitSubmission(input: {
  readonly binding: MemoryRuntimeInput['binding'];
  readonly submission: MemorySubmission;
  readonly consumer: EventConsumerBinding;
}): PendingExplicitSubmission {
  return {
    schemaVersion: 1,
    submission: input.submission,
    bindingRef: input.binding.bindingRef,
    consumerKey: input.consumer.consumerKey,
    streamId: input.consumer.streamIds[0]!,
    scope: explicitSubmissionScope(input),
    executionEpoch: input.binding.executionEpoch,
    occurredAt: new Date().toISOString(),
  };
}

async function recoverPendingExplicitSubmissions(input: {
  readonly locksRoot: string;
  readonly binding: MemoryRuntimeInput['binding'];
  readonly consumer: EventConsumerBinding;
  readonly submit: (pending: PendingExplicitSubmission) => Promise<unknown>;
}): Promise<void> {
  const root = explicitSubmissionPendingRoot(input.locksRoot, input.binding.bindingRef);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as { readonly code?: string }).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const pending = await readPendingExplicitSubmission(join(root, entry.name));
    assertPendingExplicitSubmissionBinding({
      pending,
      binding: input.binding,
      consumer: input.consumer,
    });
    await input.submit(pending);
  }
}

function checkpointEvidenceRef(checkpoint: Checkpoint): EvidenceRef {
  return {
    evidenceId: id('evidence', `checkpoint-${checkpoint.id.value}`),
    kind: 'operation',
    source: OWNER,
    locator: checkpointEvidenceLocator(checkpoint),
    digest: checkpointEvidenceDigest(checkpoint),
    scope: checkpoint.scope,
  };
}

function closureEvidenceRef(closure: ClosureRecord, scope: ScopeRef): EvidenceRef {
  const closureId = 'closureId' in closure ? closure.closureId : closure.deadEndRef;
  const evidenceId = `checkpoint-closure-${createHash('sha256').update(closureId).digest('hex').slice(0, 24)}`;
  return {
    evidenceId: id('evidence', evidenceId),
    kind: 'operation',
    source: OWNER,
    locator: checkpointClosureEvidenceLocator(closureId),
    digest: checkpointClosureEvidenceDigest(closure),
    scope,
  };
}

function rewindAnalysisInputs(input: {
  readonly failedCheckpoint: Checkpoint;
  readonly recoveryCheckpoint: Checkpoint;
  readonly reentry: ClosureRecord;
}): MemoryRewindChain {
  if (!('closureKind' in input.reentry) || input.reentry.closureKind !== 'reentry') {
    throw new AppLifecycleError(
      'memory-boundary-reentry-invalid',
      'rewind boundary requires a committed reentry closure',
      'commit the reentry fact before publishing the rewind boundary',
      OWNER,
    );
  }
  const reentryId = input.reentry.closureId;
  return {
    failedBranchRef: checkpointEvidenceLocator(input.failedCheckpoint),
    rewindCheckpointRef: checkpointEvidenceLocator(input.failedCheckpoint),
    recoveryCheckpointRef: checkpointEvidenceLocator(input.recoveryCheckpoint),
    reentryFactRef: checkpointClosureEvidenceLocator(reentryId),
    successfulBranchRefs: [checkpointEvidenceLocator(input.recoveryCheckpoint)],
    successEvidenceRefs: input.recoveryCheckpoint.evidenceRefs.map((evidence) => evidence.locator),
    absoluteJournalRefs: [
      checkpointEvidenceLocator(input.failedCheckpoint),
      checkpointEvidenceLocator(input.recoveryCheckpoint),
      checkpointClosureEvidenceLocator(reentryId),
    ],
  };
}

function containsScope(container: ScopeRef, candidate: ScopeRef): boolean {
  return container.organId.value === candidate.organId.value
    && (container.taskId === undefined || container.taskId.value === candidate.taskId?.value)
    && (container.cycleId === undefined || container.cycleId.value === candidate.cycleId?.value)
    && (container.operationId === undefined || container.operationId.value === candidate.operationId?.value);
}

function validateMemoryBoundary(input: {
  readonly event: ReturnType<typeof createMemoryAnalysisRequestedEvent>;
  readonly recordDigest: string;
  readonly committed: { readonly checkpoint: Checkpoint; readonly recordDigest: string };
}): void {
  const expectedEvidence: EvidenceRef = {
    evidenceId: input.event.evidenceRefs[0]!.evidenceId,
    kind: 'operation',
    source: input.event.evidenceRefs[0]!.source,
    locator: checkpointEvidenceLocator(input.committed.checkpoint),
    digest: checkpointEvidenceDigest(input.committed.checkpoint),
    scope: input.committed.checkpoint.scope,
  };
  if (!sameScope(input.event.scope, input.committed.checkpoint.scope)
    && !containsScope(input.event.scope, input.committed.checkpoint.scope)) {
    throw new AppLifecycleError(
      'memory-boundary-scope-mismatch',
      'memory analysis event scope does not match the committed checkpoint',
      'publish the boundary from the authoritative checkpoint owner',
      OWNER,
    );
  }
  if (input.event.evidenceRefs.length !== 1 || !sameEvidence(input.event.evidenceRefs[0]!, expectedEvidence)) {
    throw new AppLifecycleError(
      'memory-boundary-evidence-mismatch',
      'memory analysis event evidence does not match the committed checkpoint',
      'rebuild the event from the committed checkpoint evidence',
      OWNER,
    );
  }
  if (input.recordDigest !== input.committed.recordDigest) {
    throw new AppLifecycleError(
      'memory-boundary-digest-mismatch',
      'memory analysis record digest does not match the committed checkpoint record',
      'publish the boundary with the authoritative checkpoint record digest',
      OWNER,
    );
  }
}

function consumerBinding(binding: MemoryAnalysisWakeBinding): EventConsumerBinding {
  const scope = bindingScope(binding);
  const scopeRef = binding.interactionScopeId === undefined
    ? `memory:${binding.projectKey}:${scope.organId.value}:${binding.taskId!.value}`
    : `memory:${binding.projectKey}:interaction:${binding.interactionScopeId}`;
  const streamId = binding.interactionScopeId === undefined
    ? `memory-boundaries:${binding.taskId!.value}`
    : `memory-boundaries:interaction:${binding.interactionScopeId}`;
  return {
    consumerKey: binding.bindingRef,
    consumerOwner: 'memory-agent',
    scopeRef,
    contractVersion: 'memory-analysis-v1',
    scope,
    streamIds: [streamId],
    allowedClasses: ['data'],
    retryLimit: 3,
    ...(binding.interactionScopeId === undefined ? { currentEpoch: binding.executionEpoch } : {}),
  };
}

function publisherBinding(binding: MemoryAnalysisWakeBinding): TrustedEventPublisher {
  const scope = bindingScope(binding);
  return {
    publisherId: PUBLISHER_ID,
    kind: 'harness',
    ownerId: OWNER,
    scope,
    allowedClasses: ['data'],
    capabilities: [
      'memory.analysis.requested',
      'memory.candidate.created',
      'memory.candidate.review-required',
      'memory.feedback',
      'memory.attention',
      'memory.project-source.updated',
    ],
  };
}

export async function composeMemoryRuntime(input: MemoryRuntimeInput): Promise<MemoryRuntime> {
  let analysis: MemoryAnalysisStatus = {
    mode: input.driver !== undefined || input.driverFor !== undefined ? 'model' : 'deterministic',
    state: 'idle',
  };
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
  await prepareBuiltinAuditPrompt({
    templateRoot,
    promptRef: input.auditPromptRef,
    destinationRoot: input.auditPromptRoot,
  });
  const checkpointFile = join(input.paths.journalRoot, 'checkpoints.jsonl');
  const checkpointEvidence: MemoryRuntimeCheckpointEvidencePort = input.checkpointEvidence ?? {
    readCommitted: ({ checkpoint }) => readCommittedCheckpoint({
      filePath: checkpointFile,
      scope: checkpoint.scope,
      checkpointId: checkpoint.id,
    }),
    readEvidence: ({ evidence }) => readCheckpointEvidence({
      filePath: checkpointFile,
      scope: evidence.scope,
      evidence,
    }),
  };
  const journal = createJsonlEventJournal({
    filePath: join(input.paths.journalRoot, 'events.jsonl'),
  });
  const publisher = publisherBinding(input.binding);
  const consumer = consumerBinding(input.binding);
  const registry = {
    resolvePublisher: async (publisherId: string) => publisherId === publisher.publisherId ? publisher : null,
    resolveConsumer: async (consumerKey: string) => consumerKey === consumer.consumerKey ? consumer : null,
  };
  const ports: EventBusPorts = {
    journal,
    publishers: registry,
    consumers: registry,
    externalOperations: journal,
    barrierIntents: journal,
  };
  const explicitSubmissionEvidenceSource: MemoryEvidenceSourcePort = input.evidenceSource ?? {
    read: async ({ evidence }) => checkpointEvidence.readEvidence({ evidence }),
  };
  let recoverPendingSubmissions: (() => Promise<void>) | undefined;
  const projectSourceUpdatePublisher = {
    publish: async (update: {
      readonly receipt: import('../../runtime/src/memory/index.js').MemorySourceUpdateReceipt;
      readonly scope: ScopeRef;
      readonly executionEpoch: number;
      readonly occurredAt: string;
    }) => {
      const identity = JSON.stringify({
        projectKey: input.paths.projectKey,
        target: update.receipt.target,
        previousDigest: update.receipt.previousDigest,
        nextDigest: update.receipt.nextDigest,
        patchRef: update.receipt.patchRef,
        patchDigest: update.receipt.patchDigest,
      });
      const messageId = `memory-project-source-update-${createHash('sha256').update(identity).digest('hex')}`;
      const event = createMemoryProjectSourceUpdatedEvent({
        messageId,
        streamId: `memory-project-source-updates:${input.paths.projectKey}`,
        scope: update.scope,
        occurredAt: update.occurredAt,
        executionEpoch: update.executionEpoch,
        target: update.receipt.target,
        sourceRef: update.receipt.sourceRef,
        previousRevision: update.receipt.previousRevision,
        previousDigest: update.receipt.previousDigest,
        nextRevision: update.receipt.nextRevision,
        nextDigest: update.receipt.nextDigest,
        patchRef: update.receipt.patchRef,
        patchDigest: update.receipt.patchDigest,
        sourceEvidenceRefs: update.receipt.evidenceRefs,
      });
      await publishEvent(ports, { publisherId: PUBLISHER_ID, event });
    },
  };
  const composition = await composeMemory({
    ...input,
    paths: input.paths,
    projectKey: input.paths.projectKey,
    feedbackPublisher: {
      publish: async (event) => {
        await publishEvent(ports, { publisherId: PUBLISHER_ID, event });
      },
    },
    evidenceSource: input.evidenceSource ?? {
      read: async ({ evidence }) => checkpointEvidence.readEvidence({ evidence }),
    },
    externalOperations: journal,
    state: journal,
    projectSourceUpdatePublisher,
    explicitSubmissionPublisher: async ({ submission }) => {
      if (!recoverPendingSubmissions) {
        throw new AppLifecycleError(
          'memory-explicit-submission-recovery-unavailable',
          'explicit submission recovery owner is not initialized',
          'compose the runtime memory recovery owner before submitting memory',
          OWNER,
        );
      }
      const pending = await readPendingExplicitSubmission(explicitSubmissionPendingPath({
        locksRoot: input.paths.locksRoot,
        bindingRef: input.binding.bindingRef,
        submissionId: submission.submissionId,
      }));
      assertPendingExplicitSubmissionBinding({
        pending,
        binding: input.binding,
        consumer,
      });
      try {
        await publishPendingExplicitSubmission({
          pending,
          evidenceSource: explicitSubmissionEvidenceSource,
          ports,
        });
      } catch (error) {
        throw new AppLifecycleError(
          error instanceof AppLifecycleError ? error.code : 'memory-explicit-submission-publication-failed',
          `explicit memory submission was accepted with a durable recovery record, but analysis was not requested: ${error instanceof Error ? error.message : String(error)}`,
          'restart the runtime to reconcile the explicit memory submission',
          OWNER,
        );
      }
      await clearPendingExplicitSubmission({
        locksRoot: input.paths.locksRoot,
        bindingRef: input.binding.bindingRef,
        submissionId: submission.submissionId,
      });
    },
    explicitSubmissionPreparer: async (submission) => {
      const pending = createPendingExplicitSubmission({
        binding: input.binding,
        submission,
        consumer,
      });
      await validateExplicitSubmissionEvidence({
        submission,
        scope: pending.scope,
        evidenceSource: explicitSubmissionEvidenceSource,
      });
      await persistPendingExplicitSubmission({
        locksRoot: input.paths.locksRoot,
        pending,
      });
    },
    explicitSubmissionAborter: async (submission) => {
      await clearPendingExplicitSubmission({
        locksRoot: input.paths.locksRoot,
        bindingRef: input.binding.bindingRef,
        submissionId: submission.submissionId,
      });
    },
  });
  recoverPendingSubmissions = async () => {
    await recoverPendingExplicitSubmissions({
      locksRoot: input.paths.locksRoot,
      binding: input.binding,
      consumer,
      submit: (pending) => composition.submissions.submitCandidate(pending.submission),
    });
  };
  await recoverPendingSubmissions();
  const produceBoundaryPatch = createMemoryBoundaryPatchProducer({
    autoUpdate: input.autoUpdate,
    artifactsRoot: input.paths.artifactsRoot,
    projectKey: input.paths.projectKey,
    sources: composition.sources,
  });
  const prepareBoundaryEvent = async (event: ReturnType<typeof createMemoryAnalysisRequestedEvent>) => {
    const payload = event.payload as {
      readonly trigger: MemoryAnalysisTrigger;
      readonly requestedKind?: 'episodic' | 'semantic' | 'procedural';
      readonly candidateCategory: import('../../contracts/src/index.js').MemoryCandidateCategory;
      readonly sessionRef?: string;
    };
    const patch = await produceBoundaryPatch({
      messageId: event.messageId,
      summary: event.summary,
      candidateCategory: payload.candidateCategory,
      evidenceRefs: event.evidenceRefs.map((evidence) => evidence.locator),
    });
    if (!patch) return event;
    return createMemoryAnalysisRequestedEvent({
      messageId: event.messageId,
      streamId: event.streamId,
      scope: event.scope,
      occurredAt: event.occurredAt,
      summary: event.summary,
      evidenceRefs: event.evidenceRefs,
      executionEpoch: event.executionEpoch!,
      trigger: payload.trigger,
      requestedKind: payload.requestedKind,
      candidateCategory: payload.candidateCategory,
      ...(payload.sessionRef === undefined ? {} : { sessionRef: payload.sessionRef }),
      projectPatch: patch,
    });
  };
  return {
    composition,
    journal,
    ports,
    publisher: {
      prepareProjectPatch: async ({ event }) => prepareBoundaryEvent(event),
      publish: async ({ event, checkpoint, recordDigest }) => {
        const committed = await checkpointEvidence.readCommitted({ checkpoint });
        validateMemoryBoundary({ event, recordDigest, committed });
        await publishEvent(ports, { publisherId: PUBLISHER_ID, event });
        analysis = {
          mode: analysis.mode,
          state: 'running',
          operationRef: `memory-analysis:${input.binding.bindingRef}:${event.messageId}`,
        };
      },
    },
    boundaryPublisher: {
      publish: async ({ checkpoint, recordDigest, trigger, relatedCheckpoints = [], rewind }) => {
        const committed = await checkpointEvidence.readCommitted({ checkpoint });
        const related = await Promise.all(relatedCheckpoints.map((candidate) =>
          checkpointEvidence.readCommitted({ checkpoint: candidate })));
        const primaryEvidence = checkpointEvidenceRef(committed.checkpoint);
        if (trigger === 'rewind' && rewind === undefined) {
          throw new AppLifecycleError(
            'memory-boundary-rewind-incomplete',
            'rewind boundary is missing the committed failed/recovery/reentry chain',
            'publish the rewind boundary from the checkpoint and reentry owners',
            OWNER,
          );
        }
        const rewindChain = rewind === undefined
          ? undefined
          : rewindAnalysisInputs({
              failedCheckpoint: rewind.failedCheckpoint,
              recoveryCheckpoint: rewind.recoveryCheckpoint,
              reentry: rewind.reentry,
            });
        const reentryEvidence = rewind === undefined
          ? undefined
          : closureEvidenceRef(rewind.reentry, rewind.failedCheckpoint.scope);
        const event = createMemoryAnalysisRequestedEvent({
          messageId: `checkpoint-${committed.checkpoint.id.value}-${trigger}`,
          streamId: consumer.streamIds[0]!,
          scope: consumer.scope,
          occurredAt: new Date().toISOString(),
          summary: trigger === 'rewind' && related.length > 0
            ? `checkpoint ${committed.checkpoint.id.value} reentered at ${related[0]!.checkpoint.id.value}`
            : `checkpoint ${committed.checkpoint.outcome} for task ${committed.checkpoint.scope.taskId?.value ?? 'unknown'}`,
          evidenceRefs: [
            primaryEvidence,
            ...related.map((candidate) => checkpointEvidenceRef(candidate.checkpoint)),
            ...(reentryEvidence === undefined ? [] : [reentryEvidence]),
          ],
          executionEpoch: committed.checkpoint.executionEpoch,
          trigger,
          requestedKind: trigger === 'rewind' ? 'procedural' : 'semantic',
          candidateCategory: trigger === 'completion' || trigger === 'rewind' ? 'project-experience' : 'project-fact',
          ...(rewindChain === undefined
            ? {}
            : {
                analysisInputs: {
                  corrections: [],
                  errors: [],
                  rewindChains: [rewindChain],
                  actualPathRefs: [],
                  declaredPathRefs: [],
                },
              }),
          ...(trigger !== 'rewind'
            && input.binding.interactionScopeId === undefined
            && committed.checkpoint.scope.taskId
            ? { sessionRef: committed.checkpoint.scope.taskId.value }
            : {}),
        });
        const preparedEvent = await prepareBoundaryEvent(event);
        validateMemoryBoundary({
          event: { ...preparedEvent, evidenceRefs: [primaryEvidence] },
          recordDigest,
          committed,
        });
        await publishEvent(ports, { publisherId: PUBLISHER_ID, event: preparedEvent });
        analysis = {
          mode: analysis.mode,
          state: 'running',
          operationRef: `memory-analysis:${input.binding.bindingRef}:${preparedEvent.messageId}`,
        };
      },
    },
    consume: async (consumeInput = {}) => {
      const result = await consumeEvents(
        ports,
        {
          consumerKey: input.binding.bindingRef,
          limit: consumeInput.limit ?? 10,
        },
        composition.eventHandler,
        composition.barrierDriver,
      );
      const terminal = result.committed.at(-1);
      const retry = result.retries.at(-1);
      const blocked = result.blocked.at(-1);
      if (terminal !== undefined) {
        analysis = terminal.disposition === 'applied'
          ? { ...analysis, state: 'succeeded' }
          : {
              ...analysis,
              state: 'failed',
              ...(terminal.failureRef === undefined ? {} : { failureRef: terminal.failureRef }),
            };
      } else if (retry !== undefined) {
        analysis = { ...analysis, state: 'waiting', failureRef: retry.failureRef };
      } else if (blocked !== undefined) {
        analysis = { ...analysis, state: 'unknown', failureRef: blocked.reason };
      }
      return result;
    },
    reviewState: async () => {
      const snapshot = await composition.persistence.load();
      return {
        analysis: { ...analysis },
        autoUpdate: input.autoUpdate,
        candidates: (snapshot?.candidates ?? []).map((candidate) => ({
          candidateId: candidate.candidateId ?? candidate.submission.submissionId,
          state: candidate.state,
          namespace: candidate.submission.desiredScope,
          projectKey: candidate.submission.projectKey,
          ...(candidate.submission.taskId === undefined ? {} : { taskId: candidate.submission.taskId.value }),
          category: candidate.submission.candidateCategory,
          kind: candidate.submission.requestedKind,
          summary: candidate.submission.observation,
          sourceRefs: [candidate.submission.contentRef],
          sourceDigests: [candidate.submission.contentDigest],
          evidenceRefs: [...candidate.submission.evidenceRefs],
        })),
      };
    },
  };
}
