#!/usr/bin/env node
/**
 * Existing-task change scenario contract tests.
 *
 * Deterministic contract tests over the PUBLIC helpers exported by
 * `scenarios/existing-task-change.mjs` and the reused input-stage contract in
 * `lib/browser.mjs`. They feed a fake browser page and synthetic observation
 * and Journal records. They never start a service, browser, provider or port.
 *
 * They prove:
 *   - the reused input-stage contract accepts the served interaction entry only
 *     with the real path, the filled directive, a positive layout box, the
 *     required attribute, an enabled single submit and no second confirmation
 *     control, and still refuses every relaxed form;
 *   - one complete existing-change observation is green, and each single
 *     deviation (unsaved-edit gate, rejected stale save, task-reference
 *     correction, superseded revision, FIFO order, retirement, appended but
 *     unconsumed revision, missing execution cycle, missing Journal terminal,
 *     stale rendered state, changed source identity) turns it red;
 *   - an unreachable provider (no execution cycle at all) can never become a
 *     green observation;
 *   - the FIFO/inbox/task-input-revision facts are read from the persisted
 *     runtime state, and a pending or retired requirement is reported as such;
 *   - the change's journal file list is refreshed after its terminal: a change
 *     checkpoint committed after dispatch is then read, the change settles, and
 *     the seed cycle's checkpoint is neither borrowed nor enough on its own.
 *
 * These fake contract tests are NOT real acceptance. A real SUCCESS still needs
 * one real candidate run: a real explicit-brain interpretation, one real
 * confirmation, the runtime FIFO consumption, a real execution cycle, a real
 * Journal terminal and the runner's settlement proof.
 *
 * Precondition for the refresh/settlement tests: the candidate is built
 * (`pnpm build:app`), because the settlement proof reads the built public
 * Journal validators and the built contracts id constructor. Those tests fail
 * closed with an explicit message when the build output is missing.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  CONFIRM_SELECTOR,
  INTAKE_SELECTOR,
  INTERACTION_PATH,
  STALE_EDIT_REFUSAL,
  STALE_REVISION_CODE,
  UNSAVED_EDIT_REFUSAL,
  changeObservationProblems,
  consumptionFacts,
  interactionJournalPath,
  parseRevisionLabel,
  refreshChangeJournalPaths,
  runExistingTaskChangeScenario,
} from './existing-task-change.mjs';
import { assertEntryInputStage } from '../lib/browser.mjs';
import {
  assessSettlement,
  executionIdentityFromRecords,
  journalPathFor,
  readJournalStrict,
  scopeFactsFromRecords,
} from '../lib/journal.mjs';

const TASK_ID = 'task-existing-change-1';
const DRAFT_ID = 'draft-existing-change-1';
const REQUIREMENT_ID = 'requirement-existing-change-1';
const CHANGE_INPUT = 'change the deliverable of the existing task';
const REVISION_MARKER = 'revision-marker';
const V1_HASH = `sha256:${'a'.repeat(64)}`;
const V2_HASH = `sha256:${'b'.repeat(64)}`;

/** One complete, internally consistent observation, as the real reads build it. */
function validObservation(overrides = {}) {
  return withOverrides({
    taskId: TASK_ID,
    scenarioMarkers: { seedMarker: 'seed-marker', revisionMarker: REVISION_MARKER, changeInput: CHANGE_INPUT },
    seed: { state: 'succeeded', operationId: 'ui-operation-seed', executionEpoch: 1 },
    inputStage: {
      pathname: INTERACTION_PATH,
      value: CHANGE_INPUT,
      visible: true,
      bbox: { x: 12, y: 24, width: 360, height: 140 },
      required: true,
      submitEnabled: true,
      secondConfirmationControls: 0,
      screenshot: '/tmp/receipts/02-existing-change-input-before-confirm.png',
      url: `http://127.0.0.1:1${INTERACTION_PATH}?task=${TASK_ID}`,
    },
    screen: {
      organized: {
        state: 'awaiting-confirmation',
        proposalHidden: false,
        taskLabel: `任务 ${TASK_ID}`,
        revisionLabel: `修订 v1 · ${V1_HASH}`,
        changeInput: CHANGE_INPUT,
        errorHidden: true,
        errorCode: null,
        confirmDisabled: true,
        fields: { goal: 'goal v1', scope: 'scope v1', proposal: 'proposal v1' },
      },
      afterEdit: { confirmDisabled: true },
      afterUnsavedRefusal: { errorCode: UNSAVED_EDIT_REFUSAL },
      afterStale: { confirmDisabled: true, errorCode: STALE_REVISION_CODE },
      afterCorrection: { confirmDisabled: true },
      afterCorrectionRefusal: { errorCode: STALE_EDIT_REFUSAL },
      afterSave: {
        confirmDisabled: false,
        errorHidden: true,
        revisionLabel: `修订 v2 · ${V2_HASH}`,
        fields: { goal: 'goal v2', scope: 'scope v2', proposal: 'proposal v2' },
      },
    },
    gate: {
      unsavedEditConfirmDisabled: true,
      unsavedEditRefusalCode: UNSAVED_EDIT_REFUSAL,
      confirmationPostsAfterUnsavedEdit: 0,
      staleSaveStatus: 409,
      staleSaveCode: STALE_REVISION_CODE,
      staleInjectedVersion: 8,
      staleCurrentVersion: 1,
      staleSaveConfirmDisabled: true,
      staleCorrectionConfirmDisabled: true,
      staleCorrectionRefusalCode: STALE_EDIT_REFUSAL,
      confirmationPostsAfterCorrection: 0,
    },
    revisionChain: {
      superseded: { version: 1, hash: V1_HASH },
      server: { draftId: DRAFT_ID, version: 2, hash: V2_HASH },
      screen: { version: 2, hash: V2_HASH },
      refine: { realStatus: 200, realDraftId: DRAFT_ID, realBaseVersion: 1, realBaseHash: V1_HASH },
      confirmationRequest: {
        requestKind: 'existing-task-change',
        taskRef: { scope: 'task', value: TASK_ID },
        draftId: DRAFT_ID,
        draftRevisionVersion: 2,
        draftRevisionHash: V2_HASH,
      },
      confirmationResponse: {
        status: 200,
        requirement: { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, inputRevision: 1 },
      },
      confirmationPosts: 1,
    },
    consumption: {
      found: true,
      envelope: {
        requirementId: REQUIREMENT_ID,
        draftId: DRAFT_ID,
        fifoSeq: 2,
        taskRef: { scope: 'task', value: TASK_ID },
        intent: 'change',
        normalizedInput: `{"goal":"${REVISION_MARKER}"}`,
      },
      stillPending: false,
      earlierStillPending: 0,
      earlierCount: 1,
      retired: false,
      retiredCode: null,
      taskInputRevision: 1,
      consumedInputRevision: 1,
      revisionRequirementId: REQUIREMENT_ID,
      nextFifoSeq: 3,
      dispatchLedgerDraftIds: [],
    },
    execution: {
      operationId: `ui-operation-implicit-${DRAFT_ID}`,
      cycleId: 'ui-cycle-2',
      executionEpoch: 2,
      input: `{"goal":"${REVISION_MARKER}"}`,
      newExecutionCount: 1,
      dashboardOperationId: `ui-operation-implicit-${DRAFT_ID}`,
    },
    journalFacts: { toolRounds: 1, requestStarts: 2, checkpoints: 1, terminal: 'succeeded' },
    terminal: {
      state: 'succeeded',
      rendered: {
        stateChip: '已完成',
        facts: [
          { label: '当前状态', value: '已完成' },
          { label: 'Checkpoint', value: 'succeeded · seq=1 · settled' },
          { label: '输入', value: `{"goal":"${REVISION_MARKER}"}` },
        ],
      },
    },
    sourceIdentity: { stable: true, changedPaths: [], sidecarPath: '/tmp/source-identity.json' },
  }, overrides);
}

function withOverrides(base, overrides) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base?.[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    ) {
      out[key] = withOverrides(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function problemsFor(overrides) {
  return changeObservationProblems(validObservation(overrides));
}

function expectProblem(overrides, pattern) {
  const problems = problemsFor(overrides);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}; got ${JSON.stringify(problems, null, 2)}`,
  );
  return problems;
}

/** A fake page: `readEntryInputStage` only needs `page.evaluate`. */
function fakeBrowser(dom) {
  const binding = {
    serveBaseUrl: 'http://127.0.0.1:43210',
    browser: {
      page: {
        evaluate: async () => dom,
      },
    },
  };
  return binding;
}

function validInputStageDom(overrides = {}) {
  return {
    url: `http://127.0.0.1:43210${INTERACTION_PATH}?task=${TASK_ID}`,
    pathname: INTERACTION_PATH,
    value: CHANGE_INPUT,
    visible: true,
    bbox: { x: 8, y: 16, width: 320, height: 120 },
    readOnly: false,
    required: true,
    submitId: null,
    submitLabel: '整理变更提案',
    submitEnabled: true,
    secondConfirmationControls: 0,
    ...overrides,
  };
}

test('the reused input-stage contract accepts the served interaction entry with the filled directive', async () => {
  const binding = fakeBrowser(validInputStageDom());
  const dom = await assertEntryInputStage(binding, {
    entry: 'interaction',
    inputSelector: INTAKE_SELECTOR,
    directive: CHANGE_INPUT,
  });
  assert.equal(dom.pathname, INTERACTION_PATH);
  assert.equal(dom.value, CHANGE_INPUT);
});

test('the reused input-stage contract still refuses every relaxed interaction stage', async () => {
  const cases = [
    [{ pathname: '/dashboard.html' }, /entry URL path/],
    [{ pathname: '/' }, /entry URL path/],
    [{ value: 'something else' }, /does not match the submitted directive/],
    [{ visible: false }, /not visible with a positive layout box/],
    [{ bbox: { x: 0, y: 0, width: 0, height: 120 } }, /not visible with a positive layout box/],
    [{ required: false }, /not a required input/],
    [{ submitEnabled: false }, /submit control is missing or disabled/],
    [{ secondConfirmationControls: 1 }, /second-confirmation control/],
  ];
  for (const [overrides, pattern] of cases) {
    const binding = fakeBrowser(validInputStageDom(overrides));
    await assert.rejects(
      () => assertEntryInputStage(binding, { entry: 'interaction', inputSelector: INTAKE_SELECTOR, directive: CHANGE_INPUT }),
      pattern,
      `expected ${JSON.stringify(overrides)} to be refused`,
    );
  }
});

test('the new-task entry paths are unchanged by the interaction entry', async () => {
  const dashboard = fakeBrowser(validInputStageDom({ pathname: '/dashboard.html' }));
  await assert.doesNotReject(() => assertEntryInputStage(dashboard, {
    entry: 'dashboard',
    inputSelector: INTAKE_SELECTOR,
    directive: CHANGE_INPUT,
  }));
  await assert.rejects(
    () => assertEntryInputStage(fakeBrowser(validInputStageDom({ pathname: '/' })), {
      entry: 'dashboard',
      inputSelector: INTAKE_SELECTOR,
      directive: CHANGE_INPUT,
    }),
    /entry URL path/,
  );
  const homepage = fakeBrowser(validInputStageDom({ pathname: '/' }));
  await assert.doesNotReject(() => assertEntryInputStage(homepage, {
    entry: 'homepage',
    inputSelector: INTAKE_SELECTOR,
    directive: CHANGE_INPUT,
  }));
});

test('one complete existing-change observation has no problems', () => {
  assert.deepEqual(changeObservationProblems(validObservation()), []);
});

test('the input-stage and organize preconditions fail closed', () => {
  expectProblem({ inputStage: { pathname: '/dashboard.html' } }, /input-stage screenshot was not taken on the served interaction entry/);
  expectProblem({ inputStage: { value: 'other' } }, /did not show the submitted change input/);
  expectProblem({ inputStage: { visible: false } }, /not visible with a positive layout box/);
  expectProblem({ inputStage: { required: false } }, /not a required input/);
  expectProblem({ inputStage: { submitEnabled: false } }, /organize submit control was not enabled/);
  expectProblem({ inputStage: { secondConfirmationControls: 1 } }, /second-confirmation control/);
  expectProblem({ inputStage: { screenshot: null } }, /input-stage screenshot was not captured before the organize submit/);
  expectProblem({ seed: { state: 'running' } }, /was not a settled existing task first/);
  expectProblem({ screen: { organized: { state: 'awaiting-clarification' } } }, /did not reach awaiting-confirmation/);
  expectProblem({ screen: { organized: { proposalHidden: true } } }, /did not render the reviewable proposal/);
  expectProblem({ screen: { organized: { taskLabel: '任务 task-something-else' } } }, /did not bind the exact task/);
  expectProblem({ screen: { organized: { errorHidden: false, errorCode: 'explicit-brain.task-match-required' } } }, /rendered an error instead of a proposal/);
});

test('the confirmation gate cannot be opened by an unsaved edit, a rejected save or a corrected task reference', () => {
  expectProblem({ gate: { unsavedEditConfirmDisabled: false } }, /confirmation stayed available after an unsaved edit/);
  expectProblem({ gate: { unsavedEditRefusalCode: null } }, /unsaved-edit confirmation refusal was not the typed UI refusal/);
  expectProblem({ gate: { staleSaveStatus: 200 } }, /stale save was not refused by the runtime/);
  expectProblem({ gate: { staleSaveCode: 'explicit-draft.invalid-refinement' } }, /did not report the runtime stale-revision code/);
  expectProblem({ gate: { staleInjectedVersion: 1 } }, /did not address a superseded revision version/);
  expectProblem({ gate: { staleSaveConfirmDisabled: false } }, /confirmation stayed available after a rejected \(stale\) save/);
  expectProblem({ gate: { staleCorrectionConfirmDisabled: false } }, /re-armed the confirmation after a rejected save/);
  expectProblem({ gate: { staleCorrectionRefusalCode: null } }, /stale confirmation refusal was not the typed UI refusal/);
});

test('the confirmation must send exactly the revision the screen shows', () => {
  expectProblem({ revisionChain: { screen: { version: 1, hash: V1_HASH } } }, /screen revision .* does not match the revision the runtime returned/);
  expectProblem({ revisionChain: { confirmationRequest: { draftRevisionVersion: 1, draftRevisionHash: V1_HASH } } }, /did not send the current revision/);
  expectProblem({ revisionChain: { confirmationRequest: { draftRevisionHash: V1_HASH } } }, /sent the superseded revision hash/);
  expectProblem({ revisionChain: { confirmationRequest: { requestKind: 'new-task-create' } } }, /did not declare the existing-task-change kind/);
  expectProblem({ revisionChain: { confirmationRequest: { taskRef: { scope: 'task', value: 'task-other' } } } }, /did not carry the exact task reference/);
  expectProblem({ revisionChain: { confirmationRequest: { draftId: 'draft-other' } } }, /confirmation addressed a different draft/);
  expectProblem({ revisionChain: { confirmationPosts: 2 } }, /sent 2 confirmation requests \(expected exactly 1\)/);
  expectProblem({ revisionChain: { confirmationResponse: { status: 409 } } }, /single confirmation was not accepted/);
  expectProblem({ revisionChain: { confirmationResponse: { requirement: { requirementId: null } } } }, /did not identify one submitted requirement/);
  expectProblem({ revisionChain: { confirmationResponse: { requirement: { draftId: 'draft-other' } } } }, /belongs to a different draft/);
  expectProblem({ revisionChain: { refine: { realBaseVersion: 0 } } }, /the accepted save did not address the current revision/);
  expectProblem({ revisionChain: { superseded: { version: 3 } } }, /did not write a newer revision/);
  expectProblem({ revisionChain: { server: { hash: V1_HASH } } }, /did not mint a different revision hash/);
});

test('the requirement must be consumed from the FIFO in order and appended to the task', () => {
  expectProblem({ consumption: { envelope: null, found: false } }, /never entered the runtime FIFO/);
  expectProblem({ consumption: { stillPending: true } }, /never consumed the confirmed requirement from the FIFO queue/);
  expectProblem({ consumption: { earlierStillPending: 1 } }, /earlier FIFO requirement\(s\) are still pending/);
  expectProblem({ consumption: { retired: true, retiredCode: 'task.not.found' } }, /retired the confirmed requirement instead of consuming it/);
  expectProblem({ consumption: { envelope: { taskRef: { scope: 'task', value: 'task-other' } } } }, /does not name the exact target task/);
  expectProblem({ consumption: { envelope: { intent: 'create' } } }, /is not an existing-task change/);
  expectProblem({ consumption: { envelope: { draftId: 'draft-other' } } }, /does not belong to the confirmed draft revision/);
  expectProblem({ consumption: { envelope: { fifoSeq: 0 } } }, /no FIFO sequence/);
  expectProblem({ consumption: { taskInputRevision: null } }, /was not appended as a new task input revision/);
  expectProblem({ consumption: { consumedInputRevision: null } }, /was not consumed by an execution cycle/);
  expectProblem({ consumption: { taskInputRevision: 2, consumedInputRevision: 1 } }, /was not consumed by an execution cycle/);
  expectProblem({ consumption: { revisionRequirementId: 'requirement-other' } }, /does not carry the confirmed requirement/);
});

test('the change must start exactly one new execution cycle that runs the confirmed revision', () => {
  expectProblem({ execution: { operationId: null } }, /did not start a new execution operation/);
  expectProblem({ execution: { executionEpoch: 1 } }, /did not start a new execution epoch/);
  expectProblem({ execution: { newExecutionCount: 2 } }, /started 2 execution cycles/);
  expectProblem({ execution: { input: '{"goal":"seed-marker"}' } }, /did not run the confirmed revision input/);
  expectProblem({ execution: { dashboardOperationId: 'ui-operation-seed' } }, /task projection did not move to the change execution/);
});

test('the task state and the Journal terminal must prove the change settled', () => {
  expectProblem({ journalFacts: { terminal: null } }, /journal has no succeeded terminal for the change execution/);
  expectProblem({ journalFacts: { terminal: 'failed' } }, /journal has no succeeded terminal for the change execution/);
  expectProblem({ journalFacts: { checkpoints: 0 } }, /committed no checkpoint/);
  expectProblem({ journalFacts: { toolRounds: 0 } }, /ran no paired provider tool round/);
  expectProblem({ terminal: { state: 'running' } }, /did not reach a real succeeded terminal/);
  expectProblem({ terminal: { rendered: { stateChip: '运行中' } } }, /dashboard chip="运行中"/);
  expectProblem({ terminal: { rendered: { facts: [{ label: '当前状态', value: '运行中' }] } } }, /当前状态="运行中"/);
  expectProblem({ terminal: { rendered: { facts: [{ label: 'Checkpoint', value: '本任务尚无 checkpoint' }] } } }, /expected a committed succeeded checkpoint/);
  expectProblem({ terminal: { rendered: { facts: [{ label: '输入', value: '{"goal":"seed-marker"}' }] } } }, /did not show the confirmed revision as the current input/);
});

test('a changed candidate source identity fails the observation', () => {
  expectProblem({ sourceIdentity: { stable: false, changedPaths: ['packages/ui/projection/runtime.ts'] } }, /candidate source identity changed during the run/);
});

test('an unreachable provider (no execution cycle) can never become a green observation', () => {
  const problems = changeObservationProblems(validObservation({
    consumption: { stillPending: true, taskInputRevision: null, consumedInputRevision: null, revisionRequirementId: null },
    execution: {
      operationId: null,
      cycleId: null,
      executionEpoch: null,
      input: null,
      newExecutionCount: 0,
      dashboardOperationId: 'ui-operation-seed',
    },
    journalFacts: { toolRounds: 0, requestStarts: 0, checkpoints: 0, terminal: null },
    terminal: {
      state: 'succeeded',
      rendered: {
        stateChip: '已完成',
        facts: [
          { label: '当前状态', value: '已完成' },
          { label: 'Checkpoint', value: 'succeeded · seq=1 · settled' },
          { label: '输入', value: '{"goal":"seed-marker"}' },
        ],
      },
    },
  }));
  const joined = problems.join(' | ');
  assert.match(joined, /never consumed the confirmed requirement from the FIFO queue/);
  assert.match(joined, /was not appended as a new task input revision/);
  assert.match(joined, /did not start a new execution operation/);
  assert.match(joined, /journal has no succeeded terminal for the change execution/);
  assert.match(joined, /did not show the confirmed revision as the current input/);
  assert.ok(problems.length >= 6, `expected several problems, got ${JSON.stringify(problems, null, 2)}`);
});

test('the scenario refuses the service modes and outcomes it cannot really exercise', async () => {
  await assert.rejects(
    () => runExistingTaskChangeScenario({ serviceMode: 'installed-attach', outcome: 'success' }),
    /installed-attach is not implemented/,
  );
  await assert.rejects(
    () => runExistingTaskChangeScenario({ serviceMode: 'candidate', outcome: 'cancel' }),
    /only the real success path/,
  );
  await assert.rejects(
    () => runExistingTaskChangeScenario({ serviceMode: 'candidate', outcome: 'failure' }),
    /only the real success path/,
  );
});

test('consumptionFacts reads the persisted FIFO, inbox and task input revision state', () => {
  const records = [
    { kind: 'explicit-brain.state', state: { inbox: { nextFifoSeq: 3, pendingDraftIds: ['draft-seed'], envelopes: [
      { requirementId: 'requirement-seed', draftId: 'draft-seed', fifoSeq: 1, taskRef: { scope: 'task', value: TASK_ID }, intent: 'change' },
      { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, fifoSeq: 2, taskRef: { scope: 'task', value: TASK_ID }, intent: 'change', normalizedInput: `{"goal":"${REVISION_MARKER}"}` },
    ], terminalOutcomes: [] } } },
    { kind: 'explicit-brain.state', state: {
      inbox: {
        nextFifoSeq: 3,
        pendingDraftIds: [],
        envelopes: [
          { requirementId: 'requirement-seed', draftId: 'draft-seed', fifoSeq: 1, taskRef: { scope: 'task', value: TASK_ID }, intent: 'change' },
          { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, fifoSeq: 2, taskRef: { scope: 'task', value: TASK_ID }, intent: 'change', normalizedInput: `{"goal":"${REVISION_MARKER}"}` },
        ],
        terminalOutcomes: [],
      },
      dispatchLedger: [],
      taskInputRevisions: [{
        taskId: { scope: 'task', value: TASK_ID },
        state: { taskId: { scope: 'task', value: TASK_ID }, revisions: [
          { inputRevision: 1, taskId: { scope: 'task', value: TASK_ID }, envelope: { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID } },
        ] },
        consumedInputRevision: 1,
      }],
    } },
  ];
  const facts = consumptionFacts(records, { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, taskId: TASK_ID });
  assert.equal(facts.found, true);
  assert.equal(facts.envelope.fifoSeq, 2);
  assert.equal(facts.envelope.intent, 'change');
  assert.equal(facts.stillPending, false);
  assert.equal(facts.earlierStillPending, 0);
  assert.equal(facts.retired, false);
  assert.equal(facts.taskInputRevision, 1);
  assert.equal(facts.consumedInputRevision, 1);
  assert.equal(facts.revisionRequirementId, REQUIREMENT_ID);

  const pendingFacts = consumptionFacts([{ kind: 'explicit-brain.state', state: {
    inbox: { nextFifoSeq: 3, pendingDraftIds: ['draft-seed', DRAFT_ID], envelopes: [
      { requirementId: 'requirement-seed', draftId: 'draft-seed', fifoSeq: 1, taskRef: { scope: 'task', value: TASK_ID }, intent: 'change' },
      { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, fifoSeq: 2, taskRef: { scope: 'task', value: TASK_ID }, intent: 'change' },
    ], terminalOutcomes: [] },
  } }], { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, taskId: TASK_ID });
  assert.equal(pendingFacts.stillPending, true);
  assert.equal(pendingFacts.earlierStillPending, 1);
  assert.equal(pendingFacts.taskInputRevision, null);

  const retiredFacts = consumptionFacts([{ kind: 'explicit-brain.state', state: {
    inbox: { nextFifoSeq: 3, pendingDraftIds: [], envelopes: [
      { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, fifoSeq: 2, taskRef: { scope: 'task', value: TASK_ID }, intent: 'change' },
    ], terminalOutcomes: [{ requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, fifoSeq: 2, outcome: 'retired', code: 'task.not.found', message: 'x', retiredAt: '2026-10-10T00:00:00.000Z' }] },
  } }], { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, taskId: TASK_ID });
  assert.equal(retiredFacts.retired, true);
  assert.equal(retiredFacts.retiredCode, 'task.not.found');
  assert.deepEqual(changeObservationProblems(validObservation({
    consumption: { retired: true, retiredCode: 'task.not.found' },
  })).filter((problem) => /retired/.test(problem)), [
    'the runtime retired the confirmed requirement instead of consuming it: "task.not.found"',
  ]);

  const missingFacts = consumptionFacts([{ kind: 'task.created' }], { requirementId: REQUIREMENT_ID, draftId: DRAFT_ID, taskId: TASK_ID });
  assert.equal(missingFacts.found, false);
  assert.equal(missingFacts.envelope, null);
});

test('the runtime interaction journal is derived from the candidate control root only', () => {
  assert.equal(
    interactionJournalPath({ runtimePaths: { mainRoot: '/tmp/control/main' } }),
    '/tmp/control/main/sessions/explicit-brain.jsonl',
  );
  assert.equal(
    interactionJournalPath({ controlRoot: '/tmp/control' }),
    '/tmp/control/main/sessions/explicit-brain.jsonl',
  );
  assert.equal(
    interactionJournalPath({ formalPaths: { mainRoot: '/formal/main' } }),
    '/formal/main/sessions/explicit-brain.jsonl',
  );
  assert.equal(interactionJournalPath({}), null);
});

test('parseRevisionLabel accepts only the served revision label', () => {
  assert.deepEqual(parseRevisionLabel(`修订 v7 · ${V2_HASH}`), { version: 7, hash: V2_HASH });
  assert.equal(parseRevisionLabel('尚未整理'), null);
  assert.equal(parseRevisionLabel(`修订 v7 ${V2_HASH}`), null);
  assert.equal(parseRevisionLabel(`revision v7 · ${V2_HASH}`), null);
  assert.equal(parseRevisionLabel(null), null);
});

test('the scenario control selectors stay bound to the served interaction entry', () => {
  assert.equal(INTAKE_SELECTOR, '[data-existing-change-intake] textarea[name="changeInput"]');
  assert.equal(CONFIRM_SELECTOR, '[data-action="confirm-existing-change"]');
  assert.equal(INTERACTION_PATH, '/interaction.html');
});

/* -------------------------------------------------------------------------
 * Journal-path refresh after the change terminal.
 *
 * These tests write real project-root files with the built public Journal
 * owners (`UiRuntimeJournal` for the projection, `FileCheckpointStore` ->
 * `JsonlOrganJournal` for the checkpoints), then drive the scenario's exported
 * `refreshChangeJournalPaths` and the runner's own settlement proof over them.
 * No service, browser, provider or port is started.
 * ---------------------------------------------------------------------- */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TASK_REF = Object.freeze({ scope: 'task', value: TASK_ID });
const ORGAN_ID = Object.freeze({ scope: 'organ', value: 'humanagent-ui' });
const SEED_CYCLE = Object.freeze({ scope: 'cycle', value: 'ui-cycle-1' });
const CHANGE_CYCLE = Object.freeze({ scope: 'cycle', value: 'ui-cycle-2' });
const SEED_OPERATION = Object.freeze({ scope: 'operation', value: 'ui-operation-seed' });
const CHANGE_OPERATION = Object.freeze({ scope: 'operation', value: 'ui-operation-change' });
const SEED_SCOPE = Object.freeze({
  organId: ORGAN_ID, taskId: TASK_REF, cycleId: SEED_CYCLE, operationId: SEED_OPERATION, executionEpoch: 1,
});
const CHANGE_SCOPE = Object.freeze({
  organId: ORGAN_ID, taskId: TASK_REF, cycleId: CHANGE_CYCLE, operationId: CHANGE_OPERATION, executionEpoch: 2,
});

const tempRoots = [];
test.after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** A typed id or a plain string, projected to its string value. */
const idText = (value) => (value && typeof value === 'object' ? value.value : value);

/** The built public Journal owners; a missing build fails closed, never skips. */
let journalOwners;
async function loadJournalOwners() {
  if (journalOwners) return journalOwners;
  const jsonlPath = join(REPO, 'dist', 'app', 'adapters', 'jsonl', 'src', 'index.js');
  const uiPath = join(REPO, 'dist', 'app', 'app', 'src', 'ui-runtime', 'journal.js');
  let jsonl;
  let ui;
  try {
    [jsonl, ui] = await Promise.all([
      import(pathToFileURL(jsonlPath).href),
      import(pathToFileURL(uiPath).href),
    ]);
  } catch (error) {
    throw new Error(`the built candidate journals are required (run \`pnpm build:app\`): ${error.message}`);
  }
  journalOwners = {
    JsonlOrganJournal: jsonl.JsonlOrganJournal,
    UiRuntimeJournal: ui.UiRuntimeJournal,
    FileCheckpointStore: ui.FileCheckpointStore,
  };
  return journalOwners;
}

let fixtureSeq = 0;
function operationEvent(record, scope) {
  fixtureSeq += 1;
  const seq = fixtureSeq;
  return {
    eventId: `${scope.operationId.value}-${seq}`,
    seq,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    taskId: scope.taskId,
    operationId: scope.operationId.value,
    executionEpoch: scope.executionEpoch,
    kind: 'provider.model',
    state: 'running',
    summary: 'fixture event',
    evidenceRefs: [],
    ...record,
  };
}

function eventRecord(event, scope) {
  return { kind: 'operation.event', operationId: scope.operationId, event };
}

function operationStartedEvent(scope, operationCounter = 1) {
  return {
    kind: 'operation.started',
    operationId: scope.operationId,
    taskId: scope.taskId,
    cycleId: scope.cycleId,
    scope: {
      organId: scope.organId,
      taskId: scope.taskId,
      cycleId: scope.cycleId,
      operationId: scope.operationId,
    },
    executionEpoch: scope.executionEpoch,
    operationCounter,
    cycleCounter: operationCounter,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)).toISOString(),
    input: 'fixture directive',
  };
}

function makeEvidenceRef(scope, suffix, locator) {
  return {
    evidenceId: { scope: 'evidence', value: `evidence-${suffix}` },
    kind: 'operation',
    source: 'humanagent.runtime',
    locator,
    scope,
  };
}

/**
 * A runtime business checkpoint: its scope carries no operationId, and the
 * operation link lives in `recoveryStateRef` and `evidenceRefs`.
 */
function makeCheckpoint(scope, outcome, seq, overrides = {}) {
  const checkpointScope = {
    organId: scope.organId,
    taskId: scope.taskId,
    cycleId: scope.cycleId,
  };
  const operationValue = scope.operationId.value;
  return {
    id: overrides.id ?? { scope: 'checkpoint', value: `checkpoint-${scope.taskId.value}-${scope.executionEpoch}-${seq}` },
    scope: checkpointScope,
    cycleId: scope.cycleId,
    seq,
    previousCheckpointId: null,
    directiveRevision: 1,
    executionEpoch: overrides.executionEpoch ?? scope.executionEpoch,
    outcome,
    summary: `execution ${outcome}`,
    recoveryStateRef: makeEvidenceRef(checkpointScope, `recovery-${operationValue}-${seq}`, `operation/${operationValue}/checkpoint-recovery`),
    evidenceRefs: [makeEvidenceRef(checkpointScope, `checkpoint-${operationValue}-${seq}`, `operation/${operationValue}/checkpoint`)],
    next: { kind: 'continue', ref: `task://${scope.taskId.value}/next` },
  };
}

/**
 * Write the real file order of one existing-task change:
 *   1. the seed cycle settled and committed its cycle-1 checkpoint;
 *   2. the change operation started and ran its provider round, with no change
 *      checkpoint yet — the state `waitForChangeDispatch` observes;
 *   3. the change checkpoint is committed, then the final terminal is appended.
 * The dispatch-time resolution therefore lists only the seed cycle's file.
 */
async function writeChangeRefreshFixture(label, options = {}) {
  const owners = await loadJournalOwners();
  const projectRoot = await mkdtemp(join(tmpdir(), `existing-change-refresh-${label}-`));
  tempRoots.push(projectRoot);
  const journalRoot = join(projectRoot, 'checkpoints', 'ui-runtime', 'rcc');
  await mkdir(journalRoot, { recursive: true });
  const uiPath = join(journalRoot, 'ui-runtime-journal.jsonl');
  const seedCheckpointPath = join(journalRoot, `task-${TASK_ID}-cycle-ui-cycle-1.jsonl`);
  const changeCheckpointPath = join(journalRoot, `task-${TASK_ID}-cycle-ui-cycle-2.jsonl`);

  // 1. The seed cycle settled first.
  const seedStore = new owners.FileCheckpointStore(seedCheckpointPath);
  await seedStore.commit(makeCheckpoint(SEED_SCOPE, 'succeeded', 1));
  const seedCommitted = (await new owners.JsonlOrganJournal(seedCheckpointPath).verify()).records.at(-1);

  fixtureSeq = 0;
  const ui = new owners.UiRuntimeJournal(uiPath);
  ui.append(operationStartedEvent(SEED_SCOPE));
  ui.append(eventRecord(operationEvent({ kind: 'provider.request-start', summary: 'provider requested model work' }, SEED_SCOPE), SEED_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'provider.tool', summary: 'file.search seed', callId: 'call_seed', toolId: 'file.search',
  }, SEED_SCOPE), SEED_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'provider.tool-result', summary: 'file.search seed -> hit', callId: 'call_seed', toolId: 'file.search',
    status: 'succeeded', outputRef: 'asset://seed', outputDigest: 'sha256:seed',
  }, SEED_SCOPE), SEED_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'checkpoint.committed', state: 'succeeded', summary: 'execution succeeded',
    evidenceRefs: seedCommitted.checkpoint.evidenceRefs,
  }, SEED_SCOPE), SEED_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'execution.terminal', state: 'succeeded', summary: 'execution succeeded; provider closed', terminalPhase: 'final',
  }, SEED_SCOPE), SEED_SCOPE));

  // 2. The change is dispatched and runs its provider round; no checkpoint yet.
  ui.append(operationStartedEvent(CHANGE_SCOPE, 2));
  ui.append(eventRecord(operationEvent({ kind: 'provider.request-start', summary: 'provider requested model work' }, CHANGE_SCOPE), CHANGE_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'provider.tool', summary: `file.search ${REVISION_MARKER}`, callId: 'call_change', toolId: 'file.search',
  }, CHANGE_SCOPE), CHANGE_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'provider.tool-result', summary: `file.search ${REVISION_MARKER} -> hit`, callId: 'call_change', toolId: 'file.search',
    status: 'succeeded', outputRef: 'asset://change', outputDigest: 'sha256:change',
  }, CHANGE_SCOPE), CHANGE_SCOPE));

  // The dispatch-time resolution: the change cycle is not bound yet, so the
  // exact resolver lists only the seed cycle's checkpoint file.
  const binding = {
    outcome: 'success',
    repoPath: REPO,
    runtimePaths: { projectRoot, projectKey: 'project-contract' },
    projectKey: 'project-contract',
    journalMode: 'rcc',
    taskId: TASK_REF,
    cycleId: null,
    operationId: null,
    executionEpoch: null,
    scope: null,
  };
  await journalPathFor(binding);
  const dispatchPaths = [...binding.journalPaths];
  assert.deepEqual(dispatchPaths, [uiPath, seedCheckpointPath], 'dispatch-time list must hold only the seed checkpoint');

  // 3. The change identity is bound and the change checkpoint is committed.
  binding.operationId = CHANGE_OPERATION;
  binding.cycleId = CHANGE_CYCLE;
  binding.executionEpoch = CHANGE_SCOPE.executionEpoch;
  binding.scope = {
    taskId: TASK_REF,
    operationId: CHANGE_OPERATION,
    cycleId: CHANGE_CYCLE,
    executionEpoch: CHANGE_SCOPE.executionEpoch,
  };
  const changeStore = new owners.FileCheckpointStore(changeCheckpointPath);
  await changeStore.commit(makeCheckpoint(CHANGE_SCOPE, 'succeeded', 1, options.checkpointOverrides));
  const changeCommitted = (await new owners.JsonlOrganJournal(changeCheckpointPath).verify()).records.at(-1);
  if (options.damageChangeCheckpoint === true) {
    await writeFile(changeCheckpointPath, '{"kind":"checkpoint","checkpoint":\n', { flag: 'a' });
  }
  ui.append(eventRecord(operationEvent({
    kind: 'checkpoint.committed', state: 'succeeded', summary: 'execution succeeded',
    evidenceRefs: changeCommitted.checkpoint.evidenceRefs,
  }, CHANGE_SCOPE), CHANGE_SCOPE));
  ui.append(eventRecord(operationEvent({
    kind: 'execution.terminal', state: 'succeeded', summary: 'execution succeeded; provider closed', terminalPhase: 'final',
  }, CHANGE_SCOPE), CHANGE_SCOPE));

  return { binding, dispatchPaths, uiPath, seedCheckpointPath, changeCheckpointPath, projectRoot };
}

test('the scenario refreshes the change journal list after the terminal and before the strict read', async () => {
  // The bug was the order, not the resolver: the scenario read the dispatch-time
  // file list after the terminal. This guards the real call site, because the
  // fixture tests above drive the exported refresh directly.
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'existing-task-change.mjs'), 'utf8');
  const lines = source.split('\n');
  const terminalAt = lines.findIndex((line) => /^\s*const dashboard = await waitForChangeTerminal\(binding/.test(line));
  const refreshAt = lines.findIndex((line) => /^\s*await refreshChangeJournalPaths\(binding\);\s*$/.test(line));
  const strictAt = lines.findIndex((line) => /^\s*const journal = await readJournalStrict\(binding\.journalPaths/.test(line));
  assert.ok(terminalAt > 0, 'the scenario must wait for the change terminal');
  assert.ok(refreshAt > terminalAt, 'the refresh must follow the change terminal');
  assert.ok(strictAt > refreshAt, 'the refresh must precede the strict journal read');
});

test('the change journal list is refreshed after the terminal so the change checkpoint settles', async () => {
  const { binding, dispatchPaths, uiPath, seedCheckpointPath, changeCheckpointPath } =
    await writeChangeRefreshFixture('refresh');

  // The stale dispatch-time list holds only the seed checkpoint. The change
  // reached its terminal, but this list still reports zero same-execution
  // checkpoints: the original failure, reproduced exactly.
  const stale = await assessSettlement(binding, { repoPath: REPO });
  assert.equal(stale.settled, false, 'a stale dispatch-time list must not settle the change');
  assert.match(stale.reason, /sameExecutionAuthoritativeCheckpoints=0/);

  // The refresh re-resolves the exact change file list: the seed cycle's file is
  // not borrowed, and the checkpoint committed after dispatch is included.
  const refreshed = await refreshChangeJournalPaths(binding);
  assert.deepEqual(refreshed, [uiPath, changeCheckpointPath]);
  assert.equal(refreshed.includes(seedCheckpointPath), false, 'the refresh must not keep the seed checkpoint');
  assert.notDeepEqual(refreshed, dispatchPaths);

  const read = await readJournalStrict(binding.journalPaths, { repoPath: REPO });
  assert.equal(read.ok, true, read.error ?? 'strict read failed');
  assert.equal(read.checkpointRecords.length, 1);
  const identity = executionIdentityFromRecords(read.records, binding);
  assert.equal(identity.ok, true, identity.reason);
  assert.equal(idText(identity.identity.operationId), CHANGE_OPERATION.value);
  assert.equal(idText(identity.identity.cycleId), CHANGE_CYCLE.value);
  assert.equal(identity.identity.executionEpoch, CHANGE_SCOPE.executionEpoch);
  const scoped = scopeFactsFromRecords(read.records, binding, {
    execution: identity.identity,
    checkpointRecords: read.checkpointRecords,
  });
  assert.equal(scoped.checkpoints.length, 1);
  assert.equal(scoped.checkpoints[0].outcome, 'succeeded');

  const settlement = await assessSettlement(binding, { repoPath: REPO });
  assert.equal(settlement.settled, true, settlement.reason);
  assert.equal(settlement.evidence.checkpointCommitted, 1);
  assert.equal(settlement.terminal.state, 'succeeded');
  assert.equal(settlement.terminal.terminalPhase, 'final');
});

test('a damaged change checkpoint still fails after the refresh', async () => {
  const { binding } = await writeChangeRefreshFixture('damaged', { damageChangeCheckpoint: true });
  const refreshed = await refreshChangeJournalPaths(binding);
  assert.equal(refreshed.length, 2, 'the exact resolver still lists the damaged change file');

  const read = await readJournalStrict(binding.journalPaths, { repoPath: REPO });
  assert.equal(read.ok, false, 'a damaged checkpoint must fail the strict read');
  assert.match(String(read.error), /damaged|invalid|corrupt/i);

  const settlement = await assessSettlement(binding, { repoPath: REPO });
  assert.equal(settlement.settled, false);
  assert.match(settlement.reason, /journal unavailable/);
});

test('a change checkpoint from a foreign execution epoch still fails after the refresh', async () => {
  const { binding } = await writeChangeRefreshFixture('foreign-epoch', {
    checkpointOverrides: { executionEpoch: 1 },
  });
  const refreshed = await refreshChangeJournalPaths(binding);
  assert.equal(refreshed.length, 2, 'the resolver lists the file by the exact cycle name');

  const read = await readJournalStrict(binding.journalPaths, { repoPath: REPO });
  assert.equal(read.ok, true, read.error ?? 'strict read failed');
  assert.equal(read.checkpointRecords.length, 1);
  const identity = executionIdentityFromRecords(read.records, binding);
  assert.equal(identity.ok, true, identity.reason);
  const scoped = scopeFactsFromRecords(read.records, binding, {
    execution: identity.identity,
    checkpointRecords: read.checkpointRecords,
  });
  assert.equal(scoped.checkpoints.length, 0, 'a foreign epoch checkpoint is not this execution evidence');

  const settlement = await assessSettlement(binding, { repoPath: REPO });
  assert.equal(settlement.settled, false);
  assert.match(settlement.reason, /sameExecutionAuthoritativeCheckpoints=0/);
});
