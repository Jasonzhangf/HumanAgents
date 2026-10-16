import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  JsonlOrganJournal,
  JournalCommitConflictError,
  JournalIntegrityError,
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

test('public adapter keeps dispatch, return, owner acceptance, and semantic commits exact', async () => {
  const { file, cleanup } = await fixture();
  try {
    const journal = new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));

    // Failure mode: an unreturned acceptance reports a commit receipt.
    await assert.rejects(() => journal.appendOwnerAccepted(ownerAccepted), JournalIntegrityError);
    assert.equal(await readFile(file, 'utf8').catch(() => ''), '');

    const dispatch = await journal.appendDispatchAccepted(dispatchAccepted);
    assert.equal(dispatch.commit.journalSeq, 1);
    assert.match(dispatch.commit.commitId, /^interaction-helper:dispatch-accepted:[0-9a-f]{64}$/);

    const returnedCommit = await journal.appendReturned(returned);
    assert.equal(returnedCommit.commit.journalSeq, 2);
    const bytesAfterReturn = await readFile(file, 'utf8');

    const reopened = new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));
    const afterReturn = await reopened.readExact(identity);
    assert.deepEqual(afterReturn, {
      dispatchAccepted: dispatch,
      returned: returnedCommit,
      ownerAccepted: null,
    });
    assert.equal(await reopened.readSemanticCheckpointExact(turnIdentity), null);

    // Failure mode: owner acceptance links only the identity or kind, not the returned result.
    await assert.rejects(
      () => reopened.appendOwnerAccepted({
        ...ownerAccepted,
        result: { ...result, summary: 'A different unreturned result' },
      }),
      JournalIntegrityError,
    );
    assert.equal(await readFile(file, 'utf8'), bytesAfterReturn);
    assert.equal((await reopened.readExact(identity)).ownerAccepted, null);

    const accepted = await reopened.appendOwnerAccepted(ownerAccepted);
    assert.equal(accepted.commit.journalSeq, 3);
    const checkpointCommit = await reopened.appendSemanticCheckpoint(semanticCheckpoint);
    assert.equal(checkpointCommit.commit.journalSeq, 4);
    const bytesAfterAll = await readFile(file, 'utf8');

    const finalReader = new JsonlInteractionHelperJournal(new JsonlOrganJournal(file));
    assert.deepEqual(await finalReader.readExact(identity), {
      dispatchAccepted: dispatch,
      returned: returnedCommit,
      ownerAccepted: accepted,
    });
    // Failure basis: turn-scoped helper enumeration was unexposed on the adapter.
    // Impact: cold session recovery cannot discover which helpers belong to a turn.
    // Cost: one assertion reusing the existing physical journal fixture.
    assert.deepEqual(await finalReader.readTurnHelpers(turnIdentity), [
      {
        identity: helperIdentity,
        readback: {
          dispatchAccepted: dispatch,
          returned: returnedCommit,
          ownerAccepted: accepted,
        },
      },
    ]);
    assert.deepEqual(await finalReader.readSemanticCheckpointExact(turnIdentity), checkpointCommit);
    assert.deepEqual(
      await finalReader.readExact({ ...identity, helperCallId: 'call-other' }),
      { dispatchAccepted: null, returned: null, ownerAccepted: null },
    );
    assert.deepEqual(
      await finalReader.readExact({ ...identity, interactionScopeId: 'other-interaction-scope' }),
      { dispatchAccepted: null, returned: null, ownerAccepted: null },
    );

    // Failure mode: an identical command retry appends again or returns a different receipt.
    const retry = await finalReader.appendOwnerAccepted(ownerAccepted);
    assert.deepEqual(retry, accepted);
    assert.equal(await readFile(file, 'utf8'), bytesAfterAll);

    // Failure mode: changed immutable content reuses the command identity without an explicit conflict.
    await assert.rejects(
      () => finalReader.appendOwnerAccepted({
        ...ownerAccepted,
        acceptanceRef: 'acceptance://helper-public-changed',
      }),
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
        accepted.commit,
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
