import type {
  ScopeRef,
  TaskIdentityRecord,
  TaskIdentityScope,
} from '../../../contracts/src/index.js';
import { validateTaskIdentityScope } from '../../../contracts/src/index.js';
import {
  createJsonlActiveTurnJournal,
  listTaskActiveTurnBindings,
} from '../../../adapters/jsonl/src/active-turn.js';
import {
  JournalIntegrityError,
  type JsonlOrganJournal,
} from '../../../adapters/jsonl/src/index.js';
import type {
  InspectionRuntimeResourceReader,
  InspectionTurnResources,
} from '../../../runtime/src/agent-loop/inspection-runtime-helpers.js';
import type { OperationCompletionJournalPort } from '../../../runtime/src/gateway/operation-completion.js';
import type { TaskIdentityConsumer } from '../../../runtime/src/orchestration/task-identity.js';
import type {
  ActiveTurnJournalRecord,
} from '../../../runtime/src/context/active-turn-journal.js';
import {
  createActiveTurnSegmentJournal,
} from '../native-recovery-assets.js';

export interface InspectionTurnResourceReaderInput {
  readonly filePath: string;
  readonly journal: JsonlOrganJournal;
  readonly artifactRoot: string;
  readonly taskIdentity: Pick<TaskIdentityConsumer, 'read'>;
  readonly scope: TaskIdentityScope;
  readonly completionJournalPath?: string;
  readonly completionJournal?: OperationCompletionJournalPort;
}

type LocatedTurn = {
  readonly resources: InspectionTurnResources;
  readonly initial: NonNullable<Awaited<ReturnType<
    InspectionTurnResources['segments']['readInitialSegmentSource']
  >>>;
};

function sameTaskScope(left: ScopeRef, right: TaskIdentityScope): boolean {
  return left.organId.scope === right.organId.scope
    && left.organId.value === right.organId.value
    && left.taskId?.scope === right.taskId.scope
    && left.taskId.value === right.taskId.value;
}

function recordsContainInvocation(
  records: readonly ActiveTurnJournalRecord[],
  invocationId: string,
): boolean {
  return records.some((record) => record.kind === 'child-invocation'
    ? record.record.invocationId === invocationId
    : record.kind === 'child-delivery' && record.entry.invocationId === invocationId);
}

/**
 * App-owned physical locator for exact Inspection turn resources. It reads the
 * real Organ Journal and immutable assets but leaves plan, occurrence and
 * acceptance decisions to the Runtime.
 */
export function createInspectionTurnResourceReader(
  input: InspectionTurnResourceReaderInput,
): Pick<InspectionRuntimeResourceReader, 'forTurn' | 'forInvocation'> {
  validateTaskIdentityScope(input.scope);

  async function locateTurn(logicalTurnId: string): Promise<LocatedTurn | null> {
    const journal = createJsonlActiveTurnJournal({
      filePath: input.filePath,
      journal: input.journal,
      turnId: logicalTurnId,
    });
    const segments = createActiveTurnSegmentJournal({
      journalPath: input.filePath,
      assetRoot: input.artifactRoot,
      businessTurnId: logicalTurnId,
      ...(input.completionJournal === undefined
        ? (input.completionJournalPath === undefined
            ? {}
            : { completionJournalPath: input.completionJournalPath })
        : { completionJournal: input.completionJournal }),
    });
    const initial = await segments.readInitialSegmentSource(logicalTurnId);
    if (initial === null) return null;
    const binding = initial.kind === 'captured' ? initial.body.binding : initial.binding;
    if (!sameTaskScope(binding.scope, input.scope)) return null;
    const identity: TaskIdentityRecord | undefined = await input.taskIdentity.read(input.scope);
    if (identity === undefined) return null;
    return {
      resources: { logicalTurnId, identity, journal, segments },
      initial,
    };
  }

  async function forTurn(logicalTurnId: string): Promise<InspectionTurnResources | null> {
    return (await locateTurn(logicalTurnId))?.resources ?? null;
  }

  async function forInvocation(invocationId: string): Promise<InspectionTurnResources | null> {
    const bindings = await listTaskActiveTurnBindings({
      journal: input.journal,
      scope: input.scope,
    });
    const matchingTurns = new Set<string>();

    for (const entry of bindings) {
      const logicalTurnId = entry.binding.admittedTurn.turnId;
      const located = await locateTurn(logicalTurnId);
      if (located === null) continue;

      let found = located.initial.kind === 'captured'
        && (located.initial.body.childInvocations.some((record) => record.invocationId === invocationId)
          || located.initial.body.entries.some((record) =>
            'invocationId' in record && record.invocationId === invocationId));

      if (!found) {
        found = recordsContainInvocation(await located.resources.journal.replay(), invocationId);
      }
      if (!found) {
        for (const segment of await located.resources.segments.readSegments(logicalTurnId)) {
          const records = await located.resources.segments.readSegmentRecords({
            businessTurnId: logicalTurnId,
            segmentId: segment.segmentId,
          });
          if (recordsContainInvocation(records, invocationId)) {
            found = true;
            break;
          }
        }
      }
      if (found) matchingTurns.add(logicalTurnId);
    }

    if (matchingTurns.size > 1) {
      throw new JournalIntegrityError(
        `inspection invocation ${invocationId} is bound to multiple turns: ${[...matchingTurns].join(', ')}`,
      );
    }
    const logicalTurnId = matchingTurns.values().next().value as string | undefined;
    return logicalTurnId === undefined ? null : forTurn(logicalTurnId);
  }

  return { forTurn, forInvocation };
}
