import assert from 'node:assert/strict';
import test from 'node:test';
import {
  id,
  type PublicOutputBinding,
  type ScopeRef,
} from '../../packages/contracts/src/index.js';
import type {
  PublicOutputCommitProjection,
  PublicOutputPublicationProjection,
} from '../../packages/ui/contracts/runtime.js';
import {
  productResultText,
  selectProductOutput,
  type ProductOutputView,
} from '../../packages/app/src/ui-runtime/product-output-read.js';

// T8 failure modes and cost are recorded in plan §8 T8 and the A2 task note.
// This is a pure consumer: no Journal I/O, model call, HTTP or task execution.
const organId = id('organ', 'a2-output-organ');
const taskId = id('task', 'a2-output-task');
const cycleId = id('cycle', 'a2-output-cycle');
const operationId = id('operation', 'a2-output-operation');
const scope: ScopeRef = { organId, taskId, cycleId, operationId };
const binding: PublicOutputBinding = {
  scope,
  executionEpoch: 3,
  harnessTurnId: 'a2-output-turn-3',
};

const confirmedCommits: readonly PublicOutputCommitProjection[] = [
  {
    commitId: 'a2-commit-1',
    journalSeq: 41,
    recordDigest: 'a2-digest-1',
    text: '已提交第一段。',
  },
  {
    commitId: 'a2-commit-2',
    journalSeq: 42,
    recordDigest: 'a2-digest-2',
    text: '已提交第二段。',
  },
];

function publication(
  state: PublicOutputPublicationProjection['state'],
  commits: readonly PublicOutputCommitProjection[],
  publicCommitWatermark?: number,
): PublicOutputPublicationProjection {
  return {
    state,
    commits,
    ...(publicCommitWatermark === undefined ? {} : { publicCommitWatermark }),
  };
}

function commitRefs(view: ProductOutputView): readonly {
  readonly commitId: string;
  readonly journalSeq: number;
  readonly recordDigest: string;
  readonly text: string;
}[] {
  return view.commits.map((commit) => ({
    commitId: commit.commitId,
    journalSeq: commit.journalSeq,
    recordDigest: commit.recordDigest,
    text: commit.text,
  }));
}

test('T8: uncommitted task/provider text never becomes the public body', () => {
  const uncommittedText = '未提交的 provider / task.output 文本';
  const confirmed = publication('pending', confirmedCommits.slice(0, 1), 41);
  const withUncommittedSiblings = {
    ...confirmed,
    output: uncommittedText,
    taskOutput: uncommittedText,
    checkpoint: { summary: uncommittedText },
  } as unknown as PublicOutputPublicationProjection;

  const view = selectProductOutput(withUncommittedSiblings, binding);

  assert.equal(view.publication, withUncommittedSiblings);
  assert.equal(view.commits, withUncommittedSiblings.commits);
  assert.equal(productResultText(view), '已提交第一段。');
  assert.equal(productResultText(view).includes('未提交'), false);
  assert.equal(productResultText(view).includes('provider'), false);
  assert.equal(productResultText(view).includes('task.output'), false);
});

for (const state of ['pending', 'unknown', 'unavailable'] as const) {
  test(`T8: ${state} retains already confirmed commits`, () => {
    const source = publication(state, confirmedCommits, 42);

    const view = selectProductOutput(source, binding);

    assert.equal(view.publication, source);
    assert.equal(view.commits, source.commits);
    assert.equal(view.resultAvailable, true);
    assert.deepEqual(commitRefs(view), commitRefs(selectProductOutput(publication('committed', confirmedCommits, 42), binding)));
    assert.equal(source.publicCommitWatermark, 42);
  });
}

test('T8: no commits yields no result block even with uncommitted siblings', () => {
  for (const state of ['pending', 'committed', 'unavailable', 'unknown'] as const) {
    const empty = {
      ...publication(state, []),
      output: 'provider text must not fill an empty result',
      taskOutput: 'task.output must not fill an empty result',
    } as unknown as PublicOutputPublicationProjection;

    const view = selectProductOutput(empty, binding);

    assert.equal(view.resultAvailable, false);
    assert.deepEqual(view.commits, []);
    assert.equal(productResultText(view), '');
  }

  const missing = selectProductOutput(undefined, binding);
  assert.equal(missing.resultAvailable, false);
  assert.deepEqual(missing.commits, []);
  assert.equal(missing.publication, undefined);
  assert.equal(productResultText(missing), '');
});

test('T8: detail/dashboard/semantic/observation share one binding result', () => {
  const source = publication('committed', confirmedCommits, 42);

  // Each entry point composes from the same authoritative reader projection.
  const entries = {
    detail: selectProductOutput(source, binding),
    dashboard: selectProductOutput(source, binding),
    semantic: selectProductOutput(source, binding),
    observation: selectProductOutput(source, binding),
  } as const;
  const expected = [
    {
      commitId: 'a2-commit-1',
      journalSeq: 41,
      recordDigest: 'a2-digest-1',
      text: '已提交第一段。',
    },
    {
      commitId: 'a2-commit-2',
      journalSeq: 42,
      recordDigest: 'a2-digest-2',
      text: '已提交第二段。',
    },
  ];

  for (const [entry, view] of Object.entries(entries)) {
    assert.equal(view.binding, binding, `${entry} keeps the existing binding reference`);
    assert.equal(view.publication, source, `${entry} keeps the existing publication reference`);
    assert.equal(view.commits, source.commits, `${entry} keeps the exact commits array`);
    assert.equal(view.resultAvailable, true, `${entry} reports a renderable result`);
    assert.deepEqual(commitRefs(view), expected, `${entry} keeps committed text and refs`);
    assert.equal(productResultText(view), '已提交第一段。已提交第二段。', `${entry} keeps the committed body`);
  }
});
