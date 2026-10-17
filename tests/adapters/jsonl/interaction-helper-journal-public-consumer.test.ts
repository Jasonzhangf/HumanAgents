import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  JsonlOrganJournal,
  JournalCommitConflictError,
  JournalIntegrityError,
  type JournalAppendInput,
  type JournalRecord,
  type JournalTransactionContext,
} from '../../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import {
  type EvidenceRef,
  type ScopeRef,
  id,
} from '../../../packages/contracts/src/index.js';
import {
  type InteractionHelperAssignment,
  type InteractionHelperIdentity,
  type InteractionHelperOwnerAcceptedFact,
  type InteractionHelperResult,
  type InteractionHelperReturnedFact,
  type InteractionSemanticCheckpoint,
  type InteractionTurnIdentity,
} from '../../../packages/contracts/src/interaction-helper.js';

// Failure mode: this new typed boundary loses accepted responsibility or reports
// owner acceptance from a return/kind alone. Probability is unknown because the
// boundary is new. The impact is false recovery responsibility. The cost is one
// local Journal fixture with small files.

const fixtureRoot = process.env.HUMANAGENT_TEST_ROOT;
if (fixtureRoot === undefined || fixtureRoot.trim() === '') {
  throw new Error('HUMANAGENT_TEST_ROOT is required for interaction helper journal tests');
}
const testRoot = fixtureRoot;

const organId = id('organ', 'organ-interaction-helper-journal');
const organScope: ScopeRef = { organId };
const taskEvidenceScope: ScopeRef = {
  organId,
  taskId: id('task', 'task-interaction-helper-evidence'),
};

function evidence(label: string, scope: ScopeRef = organScope): EvidenceRef {
  return {
    evidenceId: id('evidence', label),
    kind: 'operation',
    source: 'runtime-intake',
    locator: `interaction://${label}`,
    digest: `sha256:${'a'.repeat(64)}`,
    scope,
  };
}

const assignment: InteractionHelperAssignment = {
  organId,
  interactionScopeId: 'interaction-scope-public',
  interactionId: 'interaction-public',
  inputRevision: 3,
  parentTurnId: 'turn-public',
  assignmentId: 'assignment-public',
  helperCallId: 'call-public',
  attempt: 1,
  objective: 'Return the bounded public result',
  targetRefs: ['interaction://interaction-public'],
  expectedOutputRefs: ['output://helper-public'],
  expectedArtifactDigests: ['sha256:helper-public'],
  acceptanceCriteriaDigest: 'sha256:criteria-public',
  successCriteria: ['Return the bounded result'],
  failureCriteria: ['Return no result'],
  incompleteCriteria: ['Return a partial result'],
  requiredCapabilities: ['text-generation'],
  mergeGate: 'not-required',
};

const identity: InteractionHelperIdentity = assignment;
const helperIdentity: InteractionHelperIdentity = {
  organId: assignment.organId,
  interactionScopeId: assignment.interactionScopeId,
  interactionId: assignment.interactionId,
  inputRevision: assignment.inputRevision,
  parentTurnId: assignment.parentTurnId,
  assignmentId: assignment.assignmentId,
  helperCallId: assignment.helperCallId,
  attempt: assignment.attempt,
};
const turnIdentity: InteractionTurnIdentity = {
  organId,
  interactionScopeId: assignment.interactionScopeId,
  interactionId: assignment.interactionId,
  inputRevision: assignment.inputRevision,
  turnId: assignment.parentTurnId,
};

const dispatchAccepted = {
  kind: 'dispatch-accepted' as const,
  assignment,
  dispatchAcceptedAt: '2026-10-15T00:00:01.000Z',
  evidenceRefs: [evidence('dispatch-public')],
};

const result = {
  ...identity,
  agentId: 'agent-helper-public',
  producedArtifactRefs: ['artifact://helper-public'],
  producedArtifactDigests: ['sha256:helper-public'],
  status: 'succeeded' as const,
  summary: 'The bounded public helper result',
  outputRefs: ['output://helper-public'],
  evidenceRefs: [
    evidence('returned-public'),
    evidence('task-evidence-public', taskEvidenceScope),
  ],
  nextAction: 'settle' as const,
};

const returned: InteractionHelperReturnedFact = {
  kind: 'returned',
  result,
  returnedAt: '2026-10-15T00:00:02.000Z',
  evidenceRefs: [evidence('returned-envelope-public')],
};

const ownerAccepted: InteractionHelperOwnerAcceptedFact = {
  kind: 'owner-accepted',
  result,
  refinedResult: { ref: evidence('refined-public', taskEvidenceScope), view: { kind: 'utf8-text' } },
  acceptedBy: 'runtime-intake-owner',
  acceptanceRef: 'acceptance://helper-public',
  acceptedAt: '2026-10-15T00:00:03.000Z',
  evidenceRefs: [evidence('owner-accepted-public')],
};

const returnedCheckpointDescription = 'Return the public helper conclusion and await owner adoption';
const adoptedCheckpointDescription = 'Adopt the public helper conclusion for the next turn decision';

const semanticCheckpoint: InteractionSemanticCheckpoint = {
  kind: 'semantic-checkpoint',
  ...turnIdentity,
  committedAt: '2026-10-15T00:00:04.000Z',
  claims: [
    {
      fact: 'The public helper result is committed semantic history',
      certainty: 'confirmed',
      sourceRefs: ['evidence://returned-public'],
    },
  ],
  constraints: [],
  evidenceRefs: [
    evidence('semantic-checkpoint-public'),
    evidence('task-semantic-evidence-public', taskEvidenceScope),
  ],
  semanticAssetRefs: [],
};

async function fixture(): Promise<{ readonly file: string; readonly cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(testRoot, 'interaction-helper-journal-'));
  return {
    file: join(directory, 'organ.jsonl'),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

class FailingCheckpointAppendJournal extends JsonlOrganJournal {
  failCheckpointAppend = false;
  private appendOrdinal = 0;

  override async transaction<T, R>(
    read: (context: JournalTransactionContext) => T | Promise<T>,
    apply: (
      input: T,
      append: (input: JournalAppendInput) => Promise<JournalRecord>,
    ) => Promise<R>,
  ): Promise<R> {
    return super.transaction(read, async (input, append) => {
      this.appendOrdinal = 0;
      return apply(input, async (next) => {
        this.appendOrdinal += 1;
        if (this.failCheckpointAppend && this.appendOrdinal === 2) {
          throw new Error('checkpoint append failed after durable fact');
        }
        return append(next);
      });
    });
  }
}

test('public adapter keeps dispatch, return, owner acceptance, and semantic commits exact', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));

    // Failure mode: an unreturned acceptance reports a commit receipt.
    await assert.rejects(
      () => journal.appendOwnerAccepted(ownerAccepted, { description: adoptedCheckpointDescription }),
      JournalIntegrityError,
    );
    assert.equal(await readFile(file, 'utf8').catch(() => ''), '');

    const dispatch = await journal.appendDispatchAccepted(dispatchAccepted);
    assert.equal(dispatch.commit.journalSeq, 1);
    assert.match(dispatch.commit.commitId, /^interaction-helper:dispatch-accepted:[0-9a-f]{64}$/);

    const returnedCommit = await journal.appendReturned(returned, {
      description: returnedCheckpointDescription,
    });
    assert.equal(returnedCommit.commit.journalSeq, 2);
    assert.equal(returnedCommit.checkpointCommit.commit.journalSeq, 3);
    assert.deepEqual(returnedCommit.checkpointCommit.checkpoint.recovery, {
      dispatchAcceptedCommitId: dispatch.commit.commitId,
      returnedCommitId: returnedCommit.commit.commitId,
    });
    assert.equal(
      returnedCommit.checkpointCommit.checkpoint.description,
      returnedCheckpointDescription,
    );
    assert.equal(returnedCommit.checkpointCommit.checkpoint.phase, 'returned');
    assert.equal(
      JSON.stringify(returnedCommit.checkpointCommit.checkpoint).includes(result.summary),
      false,
    );
    const bytesAfterReturn = await readFile(file, 'utf8');
    // Failure basis: the adapter can commit a returned fact without the
    // independent per-call checkpoint. Impact: cold recovery has no typed call
    // checkpoint to read. Cost: one replay of the existing fixture.
    assert.equal(
      (await new JsonlOrganJournal(file).replay())
        .filter((record) => record.payload?.kind === 'interaction-helper.call-checkpoint.v1').length,
      1,
      'returned must commit a per-call checkpoint',
    );

    const reopened = new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));
    const afterReturn = await reopened.readExact(identity);
    const returnedFactCommit = {
      fact: returnedCommit.fact,
      commit: returnedCommit.commit,
    };
    assert.deepEqual(afterReturn, {
      dispatchAccepted: dispatch,
      returned: returnedFactCommit,
      ownerAccepted: null,
      returnedCheckpoint: returnedCommit.checkpointCommit,
      adoptedCheckpoint: null,
    });
    assert.equal(await reopened.readSemanticCheckpointExact(turnIdentity), null);

    // Failure mode: owner acceptance links only the identity or kind, not the returned result.
    await assert.rejects(
      () => reopened.appendOwnerAccepted(
        {
          ...ownerAccepted,
          result: { ...result, summary: 'A different unreturned result' },
        },
        { description: adoptedCheckpointDescription },
      ),
      JournalIntegrityError,
    );
    assert.equal(await readFile(file, 'utf8'), bytesAfterReturn);
    assert.equal((await reopened.readExact(identity)).ownerAccepted, null);

    const accepted = await reopened.appendOwnerAccepted(ownerAccepted, {
      description: adoptedCheckpointDescription,
    });
    assert.equal(accepted.commit.journalSeq, 4);
    assert.equal(accepted.checkpointCommit.commit.journalSeq, 5);
    assert.deepEqual(accepted.checkpointCommit.checkpoint.recovery, {
      dispatchAcceptedCommitId: dispatch.commit.commitId,
      returnedCommitId: returnedCommit.commit.commitId,
      ownerAcceptedCommitId: accepted.commit.commitId,
    });
    const checkpointCommit = await reopened.appendSemanticCheckpoint(semanticCheckpoint);
    assert.equal(checkpointCommit.commit.journalSeq, 6);
    const bytesAfterAll = await readFile(file, 'utf8');

    const finalReader = new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));
    const acceptedFactCommit = {
      fact: accepted.fact,
      commit: accepted.commit,
    };
    assert.deepEqual(await finalReader.readExact(identity), {
      dispatchAccepted: dispatch,
      returned: returnedFactCommit,
      ownerAccepted: acceptedFactCommit,
      returnedCheckpoint: returnedCommit.checkpointCommit,
      adoptedCheckpoint: accepted.checkpointCommit,
    });
    // Failure basis: turn-scoped helper enumeration was unexposed on the adapter.
    // Impact: cold session recovery cannot discover which helpers belong to a turn.
    // Cost: one assertion reusing the existing physical journal fixture.
    assert.deepEqual(await finalReader.readTurnHelpers(turnIdentity), [
      {
        identity: helperIdentity,
        readback: {
          dispatchAccepted: dispatch,
          returned: returnedFactCommit,
          ownerAccepted: acceptedFactCommit,
          returnedCheckpoint: returnedCommit.checkpointCommit,
          adoptedCheckpoint: accepted.checkpointCommit,
        },
      },
    ]);
    assert.deepEqual(await finalReader.readSemanticCheckpointExact(turnIdentity), checkpointCommit);
    assert.deepEqual(
      await finalReader.readExact({ ...identity, helperCallId: 'call-other' }),
      {
        dispatchAccepted: null,
        returned: null,
        ownerAccepted: null,
        returnedCheckpoint: null,
        adoptedCheckpoint: null,
      },
    );
    assert.deepEqual(
      await finalReader.readExact({ ...identity, interactionScopeId: 'other-interaction-scope' }),
      {
        dispatchAccepted: null,
        returned: null,
        ownerAccepted: null,
        returnedCheckpoint: null,
        adoptedCheckpoint: null,
      },
    );

    // Failure mode: an identical command retry appends again or returns a different receipt.
    const retry = await finalReader.appendOwnerAccepted(ownerAccepted, {
      description: adoptedCheckpointDescription,
    });
    assert.deepEqual(retry, accepted);
    assert.equal(await readFile(file, 'utf8'), bytesAfterAll);

    // Failure mode: changed immutable content reuses the command identity without an explicit conflict.
    await assert.rejects(
      () => finalReader.appendOwnerAccepted(
        {
          ...ownerAccepted,
          acceptanceRef: 'acceptance://helper-public-changed',
        },
        { description: adoptedCheckpointDescription },
      ),
      JournalCommitConflictError,
    );
    assert.equal(await readFile(file, 'utf8'), bytesAfterAll);

    const physical = await new JsonlOrganJournal(file).replay();
    assert.deepEqual(
      physical.map((record) => ({
        commitId: record.commitId,
        journalSeq: record.seq,
        recordDigest: record.recordDigest,
      })),
      [
        dispatch.commit,
        returnedCommit.commit,
        returnedCommit.checkpointCommit.commit,
        accepted.commit,
        accepted.checkpointCommit.commit,
        checkpointCommit.commit,
      ],
    );
    for (const record of physical) assert.deepEqual(record.scope, organScope);

    assert.equal('taskId' in assignment, false);
    assert.equal('taskId' in result, false);
    assert.equal('entries' in semanticCheckpoint, false);

    // Failure basis: historical legacy records in the journal lack refinedResult.
    // Impact: if legacy records break decoding unconditionally, old completed
    // checkpoints cannot be read. If legacy unclosed records are accepted,
    // cold recovery invents or misses required refined semantics.
    // Cost: minimal append to the existing test journal.
    const legacyTurn: InteractionTurnIdentity = {
      ...turnIdentity,
      turnId: 'turn-legacy-unclosed',
    };
    const legacyResult: InteractionHelperResult = {
      ...result,
      parentTurnId: 'turn-legacy-unclosed',
      helperCallId: 'call-legacy',
    };
    await new JsonlOrganJournal(file).append({
      commitId: 'legacy-unclosed-accept',
      kind: 'event',
      scope: organScope,
      payload: {
        kind: 'interaction-helper.handoff.v1',
        fact: {
          kind: 'owner-accepted',
          result: legacyResult,
          acceptedBy: 'legacy-owner',
          acceptanceRef: 'acceptance://legacy',
          acceptedAt: '2026-10-15T00:00:10.000Z',
          evidenceRefs: [],
        },
      },
    });

    const legacyReader = new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));
    // Old completed checkpoints remain readable
    const scopeCheckpoints = await legacyReader.readScopeSemanticCheckpoints({
      organId,
      interactionScopeId: 'interaction-scope-public',
    });
    assert.equal(scopeCheckpoints.length, 1);
    assert.deepEqual(scopeCheckpoints[0], checkpointCommit);

    // Legacy unclosed missing refined semantics is honestly unavailable
    await assert.rejects(
      () => legacyReader.readExact(legacyResult),
      (err: unknown) => err instanceof JournalIntegrityError
        && /owner-accepted helper fact is missing refinedResult/.test((err as Error).message),
    );
    await assert.rejects(
      () => legacyReader.readTurnHelpers(legacyTurn),
      (err: unknown) => err instanceof JournalIntegrityError
        && /owner-accepted helper fact is missing refinedResult/.test((err as Error).message),
    );
  } finally {
    await cleanup();
  }
});

test('a partial checkpoint append stays missing until the real writer appends it', async () => {
  const { file, cleanup } = await fixture();
  try {
    // Failure basis: each handoff fact and its independent call checkpoint are
    // two JSONL appends, so a checkpoint append can fail after the fact is
    // durable. Impact: a reader that derives a checkpoint from the fact would
    // report recovery responsibility that was never physically recorded. Cost:
    // one existing fixture and one transaction wrapper.
    const journal = new FailingCheckpointAppendJournal(file);
    const helperJournal = new JsonlInteractionHelperJournal(journal);
    const dispatch = await helperJournal.appendDispatchAccepted(dispatchAccepted);
    journal.failCheckpointAppend = true;

    await assert.rejects(
      () => helperJournal.appendReturned(returned, {
        description: returnedCheckpointDescription,
      }),
      /checkpoint append failed after durable fact/,
    );

    const physicalAfterReturn = await new JsonlOrganJournal(file).replay();
    assert.equal(
      physicalAfterReturn.filter((record) => record.payload?.kind === 'interaction-helper.call-checkpoint.v1').length,
      0,
    );
    assert.equal(
      physicalAfterReturn.filter((record) => record.payload?.kind === 'interaction-helper.handoff.v1').length,
      2,
    );

    // The cold read is read-only: the missing checkpoint stays missing and the
    // real bytes do not change.
    const bytesBeforeReturnRead = await readFile(file, 'utf8');
    const coldReader = new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));
    const partialReturn = await coldReader.readExact(identity);
    assert.equal(partialReturn.returned?.fact.result.summary, result.summary);
    assert.equal(partialReturn.ownerAccepted, null);
    assert.equal(partialReturn.returnedCheckpoint, null);
    assert.equal(partialReturn.adoptedCheckpoint, null);
    assert.equal(await coldReader.readCallCheckpointExact(identity, 'returned'), null);
    assert.equal(await coldReader.readCallCheckpointExact(identity, 'adopted'), null);
    assert.equal(await readFile(file, 'utf8'), bytesBeforeReturnRead);

    // Repair through the real writer: the durable returned fact is reused and
    // only the missing independent checkpoint is appended.
    journal.failCheckpointAppend = false;
    const durableReturned = partialReturn.returned!;
    const retriedReturn = await helperJournal.appendReturned(durableReturned.fact, {
      description: returnedCheckpointDescription,
    });
    assert.deepEqual(retriedReturn.commit, durableReturned.commit);
    assert.equal(retriedReturn.checkpointCommit.commit.journalSeq, dispatch.commit.journalSeq + 2);
    assert.notEqual(
      retriedReturn.checkpointCommit.commit.commitId,
      retriedReturn.commit.commitId,
    );
    const physicalAfterReturnRepair = await new JsonlOrganJournal(file).replay();
    assert.equal(
      physicalAfterReturnRepair.filter((record) => record.payload?.kind === 'interaction-helper.handoff.v1').length,
      2,
    );
    const returnedCheckpointRecord = physicalAfterReturnRepair.find(
      (record) => record.commitId === retriedReturn.checkpointCommit.commit.commitId,
    );
    assert.equal(returnedCheckpointRecord?.payload?.kind, 'interaction-helper.call-checkpoint.v1');
    assert.deepEqual(
      {
        commitId: returnedCheckpointRecord!.commitId,
        journalSeq: returnedCheckpointRecord!.seq,
        recordDigest: returnedCheckpointRecord!.recordDigest,
      },
      retriedReturn.checkpointCommit.commit,
    );
    const repairedReturn = await coldReader.readExact(identity);
    assert.deepEqual(repairedReturn.returnedCheckpoint, retriedReturn.checkpointCommit);
    assert.equal(repairedReturn.adoptedCheckpoint, null);

    // The adopted phase repeats the same contract: the owner-accepted fact is
    // durable and readable, but no adopted checkpoint exists until repaired.
    journal.failCheckpointAppend = true;
    await assert.rejects(
      () => helperJournal.appendOwnerAccepted(ownerAccepted, {
        description: adoptedCheckpointDescription,
      }),
      /checkpoint append failed after durable fact/,
    );
    assert.equal(
      (await new JsonlOrganJournal(file).replay()).filter(
        (record) => record.payload?.kind === 'interaction-helper.call-checkpoint.v1',
      ).length,
      1,
    );
    const bytesBeforeAdoptedRead = await readFile(file, 'utf8');
    const partialAdopted = await coldReader.readExact(identity);
    assert.equal(partialAdopted.ownerAccepted?.fact.acceptedBy, ownerAccepted.acceptedBy);
    assert.deepEqual(partialAdopted.returnedCheckpoint, retriedReturn.checkpointCommit);
    assert.equal(partialAdopted.adoptedCheckpoint, null);
    assert.equal(await coldReader.readCallCheckpointExact(identity, 'adopted'), null);
    assert.equal(await readFile(file, 'utf8'), bytesBeforeAdoptedRead);

    journal.failCheckpointAppend = false;
    const durableAdopted = partialAdopted.ownerAccepted!;
    const retriedAdopted = await helperJournal.appendOwnerAccepted(durableAdopted.fact, {
      description: adoptedCheckpointDescription,
    });
    assert.deepEqual(retriedAdopted.commit, durableAdopted.commit);
    assert.equal(
      retriedAdopted.checkpointCommit.commit.journalSeq,
      retriedReturn.checkpointCommit.commit.journalSeq + 2,
    );
    assert.notEqual(
      retriedAdopted.checkpointCommit.commit.commitId,
      retriedAdopted.commit.commitId,
    );
    assert.notEqual(
      retriedAdopted.checkpointCommit.commit.commitId,
      retriedReturn.checkpointCommit.commit.commitId,
    );

    const physicalAfterAdoptedRepair = await new JsonlOrganJournal(file).replay();
    assert.equal(
      physicalAfterAdoptedRepair.filter((record) => record.payload?.kind === 'interaction-helper.handoff.v1').length,
      3,
    );
    assert.equal(
      physicalAfterAdoptedRepair.filter(
        (record) => record.payload?.kind === 'interaction-helper.call-checkpoint.v1',
      ).length,
      2,
    );
    const adoptedCheckpointRecord = physicalAfterAdoptedRepair.find(
      (record) => record.commitId === retriedAdopted.checkpointCommit.commit.commitId,
    );
    assert.equal(adoptedCheckpointRecord?.payload?.kind, 'interaction-helper.call-checkpoint.v1');
    assert.deepEqual(
      {
        commitId: adoptedCheckpointRecord!.commitId,
        journalSeq: adoptedCheckpointRecord!.seq,
        recordDigest: adoptedCheckpointRecord!.recordDigest,
      },
      retriedAdopted.checkpointCommit.commit,
    );

    const repairedAdopted = await coldReader.readExact(identity);
    assert.deepEqual(repairedAdopted.returnedCheckpoint, retriedReturn.checkpointCommit);
    assert.deepEqual(repairedAdopted.adoptedCheckpoint, retriedAdopted.checkpointCommit);
    assert.notEqual(
      repairedAdopted.returnedCheckpoint!.commit.commitId,
      repairedAdopted.adoptedCheckpoint!.commit.commitId,
    );
    assert.deepEqual(
      await coldReader.readCallCheckpointExact(identity, 'adopted'),
      retriedAdopted.checkpointCommit,
    );
  } finally {
    await cleanup();
  }
});
