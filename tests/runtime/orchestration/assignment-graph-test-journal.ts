import {
  canonicalJsonStringify,
  type AssignmentGraphCommitRequest,
  type AssignmentGraphResumeSource,
  type AssignmentGraphStream,
  type CommittedAssignmentGraphFact,
  type JournalCommitRef,
  type OrganId,
  type TaskId,
} from '../../../packages/contracts/src/index.js';
import {
  AssignmentGraph,
  type AssignmentGraphJournalPort,
  OrchestrationManager,
  type OrchestrationManagerOptions,
} from '../../../packages/runtime/src/orchestration/index.js';

export interface TestAssignmentGraphJournal extends AssignmentGraphJournalPort {
  readonly graph: AssignmentGraph;
  readonly entries: CommittedAssignmentGraphFact[];
  failNextCommitAfterWrite(): void;
  failNextCommitBeforeWrite(): void;
  registerResumeSource(ref: JournalCommitRef, source: AssignmentGraphResumeSource): void;
}

export function createTestAssignmentGraphJournal(input: {
  readonly ownerId: string;
  readonly taskId: TaskId;
  readonly organId: OrganId;
  readonly holdReplay?: Promise<void>;
  readonly markReplayStarted?: () => void;
}): TestAssignmentGraphJournal {
  const stream: AssignmentGraphStream = {
    taskScope: { organId: input.organId, taskId: input.taskId },
    ownerId: input.ownerId,
  };
  const entries: CommittedAssignmentGraphFact[] = [];
  const resumeSources = new Map<string, AssignmentGraphResumeSource>();
  let failAfterWrite = false;
  let failBeforeWrite = false;
  const graph = new AssignmentGraph({ ownerId: input.ownerId, stream });

  return {
    graph,
    entries,
    async replay() {
      input.markReplayStarted?.();
      if (input.holdReplay) await input.holdReplay;
      return structuredClone(entries);
    },
    async readResumeSource(openedCommitRef) {
      const source = resumeSources.get(openedCommitRef.commitId);
      if (!source) throw new Error(`missing test resume source: ${openedCommitRef.commitId}`);
      return structuredClone(source);
    },
    async commit(request: AssignmentGraphCommitRequest) {
      const duplicate = entries.find((entry) => entry.commitRef.commitId === request.commitId);
      if (duplicate) {
        if (canonicalJsonStringify(duplicate.fact) !== canonicalJsonStringify(request.fact)) {
          throw new Error('test journal commit id conflict');
        }
        return structuredClone(duplicate);
      }
      if (failBeforeWrite) {
        failBeforeWrite = false;
        throw new Error('test journal commit failed before write');
      }
      if (canonicalJsonStringify(request.fact.stream) !== canonicalJsonStringify(stream)) {
        throw new Error('test journal stream mismatch');
      }
      if (request.expectedRevision !== entries.length || request.fact.revision !== entries.length + 1) {
        throw new Error('test journal revision conflict');
      }
      const committed: CommittedAssignmentGraphFact = {
        fact: structuredClone(request.fact),
        commitRef: {
          commitId: request.commitId,
          journalSeq: request.fact.revision,
          recordDigest: `test-digest-${request.fact.revision}`,
        },
      };
      entries.push(committed);
      if (failAfterWrite) {
        failAfterWrite = false;
        throw new Error('test journal receipt failed after durable write');
      }
      return structuredClone(committed);
    },
    failNextCommitAfterWrite() {
      failAfterWrite = true;
    },
    failNextCommitBeforeWrite() {
      failBeforeWrite = true;
    },
    registerResumeSource(ref, source) {
      resumeSources.set(ref.commitId, structuredClone(source));
    },
  };
}

export function createTestOrchestrationManager(
  options: Omit<OrchestrationManagerOptions, 'graph' | 'graphJournal'>
    & { readonly taskId: TaskId; readonly organId: OrganId },
): OrchestrationManager {
  const { taskId, organId, ...managerOptions } = options;
  const fixture = createTestAssignmentGraphJournal({
    ownerId: options.ownerId,
    taskId,
    organId,
  });
  return new OrchestrationManager({
    ...managerOptions,
    graph: fixture.graph,
    graphJournal: fixture,
  });
}
