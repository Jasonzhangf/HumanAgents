/**
 * Existing-task change scenario — real implementation.
 *
 * Owns the real chain for a change of an existing task's goal, scope or way of
 * working. The chain is the product's own:
 *
 *   served interaction page -> 整理 (organize) -> edit -> 保存修订 (save a new
 *   server revision) -> one 确认 (single confirmation) -> runtime consumes the
 *   RequirementEnvelope through its FIFO -> the task appends a new input
 *   revision and starts the next execution cycle -> the task reaches a real
 *   terminal -> the runner proves settlement and the Journal terminal.
 *
 * The scenario never creates a second lifecycle. Candidate binding, resource
 * registration, provider probe, serve start, browser session, stop/settle,
 * cleanup and the receipt sink stay with the official runner branches. This
 * module only drives the real browser and reads the real runtime evidence.
 *
 * Evidence that this file asserts:
 *   - the change targets one exact task id, and that task really existed and had
 *     already reached a real terminal before the change was appended;
 *   - the input-stage screenshot exists only for the served interaction page
 *     with the filled directive, before the single confirmation click;
 *   - an unsaved edit cannot confirm, and a rejected (stale) save cannot be
 *     re-armed by correcting the task reference;
 *   - the confirmation sends exactly the revision the screen shows, and the
 *     runtime consumes that revision (not the superseded one);
 *   - the requirement leaves the FIFO queue in order, is not retired, is
 *     appended to the task's input revision state and is consumed by a new
 *     execution cycle whose input carries the confirmed revision;
 *   - the task state updates and the Journal holds the new execution's terminal.
 *   - the receipt captures the committed public-output read-back and the
 *     rendered product focus body that prove the changed fixture path.
 *   - the settlement proof reads the change execution's own checkpoint: the file
 *     list is re-resolved after the change terminal, so a checkpoint committed
 *     after dispatch is included and the seed cycle's file is never borrowed.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  approvePendingTaskGrant,
  assertEntryInputStage,
  captureScreenshot,
  readDashboardProbe,
  readExistingChangeDom,
  readTaskDashboardDom,
  resolveExecutionTaskId,
  sleep,
  submitDirectiveAndConfirmDraft,
  waitForDom,
  waitForProductFocusRead,
  waitForTerminal,
} from '../lib/browser.mjs';
import { taskIdValue } from '../lib/binding.mjs';
import { journalPathFor, readJournalStrict, scopeFactsFromRecords, OBSERVED_TERMINAL_STATES } from '../lib/journal.mjs';

export const SCENARIO = 'existing-task-change';

/** The served entry this scenario drives, and its real controls. */
export const INTERACTION_PATH = '/interaction.html';
export const TASK_REF_SELECTOR = '[data-existing-change-intake] input[name="taskRef"]';
export const INTAKE_SELECTOR = '[data-existing-change-intake] textarea[name="changeInput"]';
export const ORGANIZE_SELECTOR = '[data-action="organize-existing-change"]';
export const EDIT_SELECTOR = '[data-existing-change-edit] textarea[name="goal"]';
export const SAVE_SELECTOR = '[data-action="save-existing-change"]';
export const CONFIRM_SELECTOR = '[data-action="confirm-existing-change"]';
export const REFINE_URL_GLOB = '**/api/explicit/interactions/*/refine';

/** The two typed UI refusals the confirmation boundary must produce. */
export const UNSAVED_EDIT_REFUSAL = 'ui.existing-change.unsaved-edit';
export const STALE_EDIT_REFUSAL = 'ui.existing-change.stale-edit';
/** The runtime's own stale-revision code, surfaced unchanged by the UI. */
export const STALE_REVISION_CODE = 'explicit-draft.stale-revision';

/** The changed fixture path the public output and rendered body must prove. */
export const CHANGE_FIXTURE_PATH = 'e2e-change-fixture/change.txt';

export const DEFAULT_CHANGE_TIMEOUT_MS = Number(process.env.E2E_CHANGE_TIMEOUT_MS ?? 240_000);

const CLARIFY_ANSWER =
  'Do not clarify. Proceed directly with the tools available in the workspace and finish.';

export async function runExistingTaskChangeScenario(binding) {
  if (binding.serviceMode === 'installed-attach') {
    throw new Error(
      'existing-task-change drives a candidate-owned change requirement and its own execution cycle; '
      + 'installed-attach is not implemented for this scenario',
    );
  }
  if ((binding.outcome ?? 'success') !== 'success') {
    throw new Error(
      `existing-task-change implements only the real success path; the runner must not select the `
      + `${JSON.stringify(binding.outcome)} outcome for it`,
    );
  }

  const attempt = binding.attemptId ?? 'attempt';
  const seedMarker = `humanagent-e2e-seed-${attempt}`;
  const revisionMarker = `humanagent-e2e-change-revision-${attempt}`;
  const fixtureDir = 'e2e-change-fixture';
  const seedFixture = join(fixtureDir, 'seed.txt');
  const changeFixture = join(fixtureDir, 'change.txt');
  await mkdir(join(binding.workspace, fixtureDir), { recursive: true });
  await writeFile(join(binding.workspace, seedFixture), `${seedMarker}\n`, 'utf8');

  const evidence = { screenshots: [] };

  // 1. The change targets an existing task, so that task must really exist. It is
  //    created through the served new-task entry and must reach a real terminal
  //    first: a change is appended to a settled task and runs as its next cycle.
  const seedDirective = [
    `Find the workspace file that contains the string ${seedMarker}.`,
    `Use the file.search tool to search the workspace for ${seedMarker}.`,
    'Report the exact file path in your final answer.',
    'Do not create, modify, move or delete any file. Do not ask clarifying questions.',
  ].join(' ');
  await submitSeedTask(binding, seedDirective, evidence);
  const seedDashboard = await waitForSeedTerminal(binding);
  binding.taskId = resolveExecutionTaskId(binding);
  const existingTaskId = taskIdValue(binding.taskId);
  if (!existingTaskId) {
    throw new Error('the new-task entry did not bind the exact task the change must target');
  }
  if (seedDashboard.state !== 'succeeded') {
    throw new Error(
      `the task targeted by the change did not reach a real succeeded terminal first: `
      + `${JSON.stringify(seedDashboard.state)}`,
    );
  }
  const seedOperationId = seedDashboard.operationId ?? null;
  const seedEpoch = seedDashboard.executionEpoch ?? null;

  // 2. The change input is typed into the served interaction page. The single
  //    organize submit is the only action taken at this stage.
  const changeInput = [
    `Change the existing task ${existingTaskId}.`,
    'Its deliverable must change to reporting exactly one file path.',
    'Keep the change inside this one task; do not create a new task.',
    'Do not ask clarifying questions.',
  ].join(' ');
  const revisedGoal = [
    'Change the deliverable of this task:',
    `use the file.search tool to search the workspace for ${revisionMarker}`,
    'and report the exact matching file path in your final answer.',
    'Do not create, modify, move or delete any file.',
  ].join(' ');

  await writeFile(join(binding.workspace, changeFixture), `${revisionMarker}\n`, 'utf8');

  const { page } = binding.browser;
  const traffic = { refine: [], confirmation: [] };
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/api/explicit/interactions/')) return;
    const entry = { url, method: request.method(), body: readJsonBody(request) };
    if (url.endsWith('/refine')) traffic.refine.push(entry);
    if (url.endsWith('/confirmation')) traffic.confirmation.push(entry);
  });

  const interactionUrl = `${binding.serveBaseUrl}${INTERACTION_PATH}?task=${encodeURIComponent(existingTaskId)}`;
  const entryResponse = await page.goto(interactionUrl, { waitUntil: 'domcontentloaded' });
  if (!entryResponse || !entryResponse.ok()) {
    throw new Error(`the served existing-change entry did not load: ${interactionUrl} status=${entryResponse?.status()}`);
  }
  await page.waitForSelector(TASK_REF_SELECTOR, { timeout: 30_000 });
  await page.fill(TASK_REF_SELECTOR, existingTaskId);
  await page.fill(INTAKE_SELECTOR, changeInput);

  // Input-stage evidence: the served interaction page really shows the filled
  // directive and its single organize control, and this is captured before the
  // organize submit. The same strict contract as the new-task entry is reused.
  const inputStage = await captureInteractionInputStage(binding, changeInput);
  evidence.screenshots.push(inputStage.screenshot);

  await page.click(ORGANIZE_SELECTOR);
  const organized = await waitForOrganized(binding, { taskId: existingTaskId });
  const v1 = {
    version: Number(organized.revision.version),
    hash: organized.revision.hash,
  };

  // 3. An unsaved edit closes the confirmation gate at once, and the gate is the
  //    exact revision, not the disabled attribute: the confirmation action
  //    re-checks the screen and refuses without sending a request.
  await page.fill(EDIT_SELECTOR, revisedGoal);
  const afterEdit = await readExistingChangeDom(binding);
  if (afterEdit.confirmDisabled !== true) {
    throw new Error('the confirmation stayed available after an unsaved edit of the reviewable revision');
  }
  const postsBeforeUnsavedRefusal = traffic.confirmation.length;
  await dispatchSyntheticClick(binding, CONFIRM_SELECTOR);
  const afterUnsavedRefusal = await waitForDom(page, 'unsaved-edit confirmation refusal', async () => {
    const dom = await readExistingChangeDom(binding);
    return dom.errorCode === UNSAVED_EDIT_REFUSAL ? dom : null;
  }, 30_000);
  if (traffic.confirmation.length !== postsBeforeUnsavedRefusal) {
    throw new Error('a refused unsaved-edit confirmation still sent a confirmation request');
  }

  // 4. A save the runtime really rejects (stale revision) must not leave the old
  //    confirmation usable, and correcting the task reference must not re-arm it.
  const stale = await driveStaleSave(binding, page, traffic);
  const afterStale = await waitForDom(page, 'stale save refusal', async () => {
    const dom = await readExistingChangeDom(binding);
    return dom.confirmDisabled === true && Boolean(dom.errorCode) ? dom : null;
  }, 30_000);
  if (afterStale.errorCode !== STALE_REVISION_CODE) {
    throw new Error(`the rejected save did not surface the runtime stale-revision code: ${JSON.stringify(afterStale.errorCode)}`);
  }

  await page.fill(TASK_REF_SELECTOR, 'task-not-the-change-target');
  await page.fill(TASK_REF_SELECTOR, existingTaskId);
  const afterCorrection = await readExistingChangeDom(binding);
  if (afterCorrection.confirmDisabled !== true) {
    throw new Error('correcting the task reference released the stale gate after a rejected save');
  }
  const postsBeforeCorrectionRefusal = traffic.confirmation.length;
  await dispatchSyntheticClick(binding, CONFIRM_SELECTOR);
  const afterCorrectionRefusal = await waitForDom(page, 'stale-edit confirmation refusal', async () => {
    const dom = await readExistingChangeDom(binding);
    return dom.errorCode === STALE_EDIT_REFUSAL ? dom : null;
  }, 30_000);
  if (traffic.confirmation.length !== postsBeforeCorrectionRefusal) {
    throw new Error('a refused stale-edit confirmation still sent a confirmation request');
  }

  // 5. The real save mints the new server revision and re-arms the confirmation
  //    for exactly that revision.
  const savedRefine = await driveRealSave(binding, page, traffic);
  const afterSave = await waitForDom(page, 'saved revision re-arms the confirmation', async () => {
    const dom = await readExistingChangeDom(binding);
    return dom.confirmDisabled === false && dom.errorHidden === true && Boolean(dom.revisionLabel) ? dom : null;
  }, 30_000);
  const serverRevision = {
    draftId: savedRefine.revision.draftId,
    version: savedRefine.revision.revisionVersion,
    hash: savedRefine.revision.revisionHash,
  };
  const screenRevision = parseRevisionLabel(afterSave.revisionLabel);
  if (!screenRevision) {
    throw new Error(`the served page did not show a parseable revision: ${JSON.stringify(afterSave.revisionLabel)}`);
  }

  // The input-stage screenshot for the confirmed revision is captured here: the
  // screen shows the saved revision, the confirmation is available, and no
  // confirmation click has happened yet.
  const beforeConfirmShot = await captureScreenshot(binding, '03-existing-change-revision-before-confirm');
  evidence.screenshots.push(beforeConfirmShot);

  const confirmationResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/confirmation') && response.request().method() === 'POST',
  { timeout: 120_000 });
  await page.click(CONFIRM_SELECTOR);
  const confirmationResponse = await confirmationResponsePromise;
  const confirmationStatus = confirmationResponse.status();
  const confirmationBody = await confirmationResponse.json().catch(() => null);
  const requirement = confirmationBody?.requirement ?? null;
  if (!requirement?.requirementId || !requirement?.draftId || !Number.isInteger(requirement?.inputRevision)) {
    throw new Error(`the single confirmation did not return one requirement identity: ${JSON.stringify(confirmationBody).slice(0, 800)}`);
  }
  binding.requirementReceipt = requirement;
  binding.confirmStatus = confirmationStatus;
  binding.draft = {
    intent: 'change',
    proposal: afterSave.fields.proposal ?? '',
    metaRows: [],
    entry: 'interaction',
    submittedOnce: true,
  };
  binding.explicitInteractionId = decodeURIComponent(new URL(confirmationResponse.url()).pathname.split('/').at(-2));

  // From here the runtime owns the next step. The attempt identity is cleared
  // until the changed requirement really starts a new execution cycle, so a
  // failure in this window cannot be mistaken for the seed execution.
  binding.operationId = null;
  binding.cycleId = null;
  binding.executionEpoch = null;
  binding.scope = null;

  const changeOperation = await waitForChangeDispatch(binding, {
    taskId: existingTaskId,
    marker: revisionMarker,
    afterEpoch: seedEpoch,
  });
  binding.operationId = changeOperation.record.operationId;
  binding.cycleId = changeOperation.record.cycleId;
  binding.executionEpoch = changeOperation.record.executionEpoch;
  binding.scope = {
    taskId: binding.taskId,
    operationId: changeOperation.record.operationId,
    cycleId: changeOperation.record.cycleId,
    executionEpoch: changeOperation.record.executionEpoch,
  };

  const dashboard = await waitForChangeTerminal(binding, changeOperation.record.operationId);
  const rendered = await readTaskDashboardDom(binding).catch((error) => ({ error: error.message }));
  const productFocus = await waitForProductFocusRead(binding, {
    requiredSessionText: CHANGE_FIXTURE_PATH,
  });
  const taskShot = await captureScreenshot(binding, '04-existing-change-task-updated');
  evidence.screenshots.push(taskShot);

  // The change execution reached its terminal, so the runtime has committed the
  // change cycle's checkpoint by now. The file list cached while the change was
  // still dispatching was resolved before that commit and holds only the seed
  // cycle's files. Re-resolve the exact task/operation/cycle/epoch list with the
  // existing precise resolver, so the strict read and the settlement proof read
  // the change's own checkpoint instead of the seed's.
  await refreshChangeJournalPaths(binding);

  // 6. The authoritative Journal: the change execution's own terminal and the
  //    runtime's own FIFO/inbox state. The task journal proves the execution; the
  //    explicit-brain state lives in the runtime's own interaction journal, so it
  //    is read as a second, named source instead of being guessed from the task
  //    journal. One strict read per source is the single truth.
  const journal = await readJournalStrict(binding.journalPaths, { repoPath: binding.repoPath });
  if (!journal.ok) {
    throw new Error(`the authoritative journal could not be read after the change: ${journal.error}`);
  }
  const brainJournalPath = interactionJournalPath(binding);
  if (!brainJournalPath) {
    throw new Error(
      'the runtime interaction journal could not be located from the candidate control root; '
      + 'the FIFO consumption of the confirmed requirement cannot be proven',
    );
  }
  const brainJournal = await readJournalStrict([brainJournalPath], { repoPath: binding.repoPath });
  if (!brainJournal.ok) {
    throw new Error(`the runtime interaction journal could not be read after the change: ${brainJournal.error}`);
  }
  const changeIdentity = {
    organId: changeOperation.record.scope?.organId ?? null,
    taskId: changeOperation.record.taskId ?? null,
    cycleId: changeOperation.record.cycleId ?? null,
    operationId: changeOperation.record.operationId ?? null,
    executionEpoch: changeOperation.record.executionEpoch ?? null,
    scope: changeOperation.record.scope ?? null,
  };
  const facts = scopeFactsFromRecords(journal.records, binding, {
    execution: changeIdentity,
    checkpointRecords: journal.checkpointRecords ?? [],
  });
  const consumption = consumptionFacts([...journal.records, ...brainJournal.records], {
    requirementId: requirement.requirementId,
    draftId: requirement.draftId,
    taskId: existingTaskId,
  });

  const observation = {
    taskId: existingTaskId,
    scenarioMarkers: { seedMarker, revisionMarker, changeInput },
    seed: { state: seedDashboard.state, operationId: seedOperationId, executionEpoch: seedEpoch },
    inputStage: {
      pathname: inputStage.dom.pathname,
      value: inputStage.dom.value,
      visible: inputStage.dom.visible,
      bbox: inputStage.dom.bbox,
      required: inputStage.dom.required,
      submitEnabled: inputStage.dom.submitEnabled,
      secondConfirmationControls: inputStage.dom.secondConfirmationControls,
      screenshot: inputStage.screenshot,
      url: inputStage.dom.url,
    },
    screen: { organized, afterEdit, afterUnsavedRefusal, afterStale, afterCorrection, afterCorrectionRefusal, afterSave },
    gate: {
      unsavedEditConfirmDisabled: afterEdit.confirmDisabled === true,
      unsavedEditRefusalCode: afterUnsavedRefusal.errorCode,
      confirmationPostsAfterUnsavedEdit: postsBeforeUnsavedRefusal,
      staleSaveStatus: stale.status,
      staleSaveCode: stale.code,
      staleInjectedVersion: stale.injectedVersion,
      staleCurrentVersion: v1.version,
      staleSaveConfirmDisabled: afterStale.confirmDisabled === true,
      staleCorrectionConfirmDisabled: afterCorrection.confirmDisabled === true,
      staleCorrectionRefusalCode: afterCorrectionRefusal.errorCode,
      confirmationPostsAfterCorrection: postsBeforeCorrectionRefusal,
    },
    revisionChain: {
      superseded: v1,
      server: serverRevision,
      screen: screenRevision,
      refine: {
        realStatus: savedRefine.status,
        realDraftId: savedRefine.request?.draftId ?? null,
        realBaseVersion: savedRefine.request?.baseRevisionVersion ?? null,
        realBaseHash: savedRefine.request?.requestedRevisionHash ?? null,
      },
      confirmationRequest: traffic.confirmation[0]?.body ?? null,
      confirmationResponse: { status: confirmationStatus, requirement },
      confirmationPosts: traffic.confirmation.length,
    },
    consumption,
    execution: {
      operationId: idValue(changeIdentity.operationId),
      cycleId: idValue(changeIdentity.cycleId),
      executionEpoch: changeIdentity.executionEpoch,
      input: changeOperation.record.input ?? null,
      newExecutionCount: changeOperation.newExecutionCount,
      dashboardOperationId: dashboard.operationId ?? null,
    },
    journalFacts: {
      toolRounds: facts.toolRounds.length,
      requestStarts: facts.requestStarts.length,
      checkpoints: facts.checkpoints.length,
      terminal: facts.finalTerminals.slice(-1)[0]?.state ?? null,
    },
    dashboardProbe: binding.dashboardProbe ?? null,
    productFocus,
    terminal: { state: dashboard.state ?? null, rendered },
  };

  const missing = changeObservationProblems(observation);
  evidence.scenarioEvidence = {
    taskId: existingTaskId,
    operationId: idValue(changeIdentity.operationId),
    cycleId: idValue(changeIdentity.cycleId),
    executionEpoch: changeIdentity.executionEpoch,
    change: {
      taskId: existingTaskId,
      seed: observation.seed,
      directive: changeInput,
      revisedGoal,
      seedMarker,
      revisionMarker,
      fixtures: { seed: seedFixture, change: changeFixture },
      inputStage: observation.inputStage,
      gate: observation.gate,
      revisionChain: observation.revisionChain,
      consumption: observation.consumption,
      journalPaths: binding.journalPaths ?? [],
      interactionJournalPath: brainJournalPath,
      execution: observation.execution,
      journalFacts: observation.journalFacts,
      dashboardProbe: observation.dashboardProbe,
      productFocus: observation.productFocus,
      terminal: observation.terminal,
      confirmation: {
        status: confirmationStatus,
        request: traffic.confirmation[0]?.body ?? null,
        response: confirmationBody,
        requirement,
        interactionId: binding.explicitInteractionId ?? null,
      },
    },
  };
  evidence.terminalState = dashboard.state ?? null;
  evidence.dashboardState = dashboard.state ?? null;
  evidence.toolRounds = facts.toolRounds.length;
  evidence.requestStartTurns = facts.requestStarts.length;
  evidence.checkpointCommitted = facts.checkpoints.length;
  evidence.terminalRecord = facts.finalTerminals.slice(-1)[0] ?? null;
  evidence.evidenceRefs = facts.events
    .flatMap((event) => (Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []))
    .slice(0, 40);
  if (missing.length) evidence.missingEvidence = missing;
  return evidence;
}

/**
 * The complete assertion set for one existing-change observation. It is a pure
 * function over real reads, so the contract tests can drive every branch with
 * synthetic observations and never need a service, browser or provider.
 */
export function changeObservationProblems(observation) {
  const missing = [];
  const stage = observation.inputStage ?? {};
  if (stage.pathname !== INTERACTION_PATH) {
    missing.push(`the input-stage screenshot was not taken on the served interaction entry: path=${JSON.stringify(stage.pathname ?? null)}`);
  }
  if (stage.value !== observation.screen?.organized?.changeInput) {
    missing.push('the input-stage screenshot did not show the submitted change input');
  }
  if (stage.visible !== true || !stage.bbox || stage.bbox.width <= 0 || stage.bbox.height <= 0) {
    missing.push('the change input control was not visible with a positive layout box');
  }
  if (stage.required !== true) missing.push('the change input control is not a required input');
  if (stage.submitEnabled !== true) missing.push('the single organize submit control was not enabled');
  if (stage.secondConfirmationControls !== 0) {
    missing.push(`the intake stage rendered ${stage.secondConfirmationControls} second-confirmation control(s)`);
  }
  if (typeof stage.screenshot !== 'string' || !stage.screenshot) {
    missing.push('the input-stage screenshot was not captured before the organize submit');
  }

  const seed = observation.seed ?? {};
  if (seed.state !== 'succeeded') {
    missing.push(`the change target task was not a settled existing task first: state=${JSON.stringify(seed.state ?? null)}`);
  }
  if (!observation.taskId) missing.push('the change was not bound to an exact task id');

  const organized = observation.screen?.organized ?? {};
  if (organized.state !== 'awaiting-confirmation') {
    missing.push(`the served interaction page did not reach awaiting-confirmation: state=${JSON.stringify(organized.state ?? null)}`);
  }
  if (organized.proposalHidden !== false) {
    missing.push('the served interaction page did not render the reviewable proposal');
  }
  if (!String(organized.taskLabel ?? '').includes(String(observation.taskId))) {
    missing.push(`the served proposal did not bind the exact task: ${JSON.stringify(organized.taskLabel ?? null)}`);
  }
  if (organized.errorHidden !== true) {
    missing.push(`the organize step rendered an error instead of a proposal: ${JSON.stringify(organized.errorCode ?? null)}`);
  }

  const gate = observation.gate ?? {};
  if (gate.unsavedEditConfirmDisabled !== true) {
    missing.push('the confirmation stayed available after an unsaved edit');
  }
  if (gate.unsavedEditRefusalCode !== UNSAVED_EDIT_REFUSAL) {
    missing.push(`the unsaved-edit confirmation refusal was not the typed UI refusal: ${JSON.stringify(gate.unsavedEditRefusalCode ?? null)}`);
  }
  if (gate.staleSaveStatus !== 409) {
    missing.push(`the stale save was not refused by the runtime: status=${JSON.stringify(gate.staleSaveStatus ?? null)}`);
  }
  if (gate.staleSaveCode !== STALE_REVISION_CODE) {
    missing.push(`the stale save did not report the runtime stale-revision code: ${JSON.stringify(gate.staleSaveCode ?? null)}`);
  }
  if (!Number.isInteger(gate.staleInjectedVersion) || gate.staleInjectedVersion === gate.staleCurrentVersion) {
    missing.push('the injected stale save did not address a superseded revision version');
  }
  if (gate.staleSaveConfirmDisabled !== true) {
    missing.push('the confirmation stayed available after a rejected (stale) save');
  }
  if (gate.staleCorrectionConfirmDisabled !== true) {
    missing.push('correcting the task reference re-armed the confirmation after a rejected save');
  }
  if (gate.staleCorrectionRefusalCode !== STALE_EDIT_REFUSAL) {
    missing.push(`the stale confirmation refusal was not the typed UI refusal: ${JSON.stringify(gate.staleCorrectionRefusalCode ?? null)}`);
  }

  const chain = observation.revisionChain ?? {};
  const superseded = chain.superseded ?? {};
  const server = chain.server ?? {};
  const screen = chain.screen ?? {};
  const request = chain.confirmationRequest ?? {};
  const response = chain.confirmationResponse ?? {};
  const requirement = response.requirement ?? {};
  if (!Number.isInteger(server.version) || server.version <= Number(superseded.version ?? 0)) {
    missing.push(`the save did not write a newer revision: v${JSON.stringify(superseded.version ?? null)} -> v${JSON.stringify(server.version ?? null)}`);
  }
  if (!server.hash || server.hash === superseded.hash) {
    missing.push('the new revision did not mint a different revision hash');
  }
  if (screen.version !== server.version || screen.hash !== server.hash) {
    missing.push(
      `the screen revision (v${JSON.stringify(screen.version ?? null)}, ${JSON.stringify(screen.hash ?? null)}) `
      + `does not match the revision the runtime returned (v${JSON.stringify(server.version ?? null)}, ${JSON.stringify(server.hash ?? null)})`,
    );
  }
  if (request.requestKind !== 'existing-task-change') {
    missing.push(`the confirmation did not declare the existing-task-change kind: ${JSON.stringify(request.requestKind ?? null)}`);
  }
  if (idValue(request.taskRef) !== observation.taskId) {
    missing.push(`the confirmation did not carry the exact task reference: ${JSON.stringify(request.taskRef ?? null)}`);
  }
  if (request.draftId !== server.draftId) {
    missing.push(`the confirmation addressed a different draft: ${JSON.stringify(request.draftId ?? null)}`);
  }
  if (request.draftRevisionVersion !== server.version || request.draftRevisionHash !== server.hash) {
    missing.push(
      `the confirmation did not send the current revision: `
      + `v${JSON.stringify(request.draftRevisionVersion ?? null)}/${JSON.stringify(request.draftRevisionHash ?? null)}`,
    );
  }
  if (request.draftRevisionHash === superseded.hash) {
    missing.push('the confirmation sent the superseded revision hash');
  }
  if (chain.confirmationPosts !== 1) {
    missing.push(`the change flow sent ${JSON.stringify(chain.confirmationPosts ?? null)} confirmation requests (expected exactly 1)`);
  }
  if (!(Number.isInteger(response.status) && response.status >= 200 && response.status < 300)) {
    missing.push(`the single confirmation was not accepted: status=${JSON.stringify(response.status ?? null)}`);
  }
  if (!requirement.requirementId || !requirement.draftId || !Number.isInteger(requirement.inputRevision)) {
    missing.push('the confirmation response did not identify one submitted requirement');
  } else if (requirement.draftId !== server.draftId) {
    missing.push('the confirmed requirement belongs to a different draft than the revision the human confirmed');
  }
  if (Number.isInteger(chain.refine?.realBaseVersion) && chain.refine.realBaseVersion !== superseded.version) {
    missing.push(
      `the accepted save did not address the current revision: base v${JSON.stringify(chain.refine.realBaseVersion)} `
      + `vs current v${JSON.stringify(superseded.version ?? null)}`,
    );
  }

  const consumption = observation.consumption ?? {};
  const envelope = consumption.envelope ?? {};
  if (!envelope.requirementId) {
    missing.push('the confirmed requirement never entered the runtime FIFO');
  } else {
    if (envelope.draftId !== server.draftId) {
      missing.push('the queued requirement does not belong to the confirmed draft revision');
    }
    if (idValue(envelope.taskRef) !== observation.taskId) {
      missing.push(`the queued requirement does not name the exact target task: ${JSON.stringify(envelope.taskRef ?? null)}`);
    }
    if (envelope.intent !== 'change' && envelope.intent !== 'append') {
      missing.push(`the queued requirement is not an existing-task change: intent=${JSON.stringify(envelope.intent ?? null)}`);
    }
    if (!Number.isInteger(envelope.fifoSeq) || envelope.fifoSeq < 1) {
      missing.push(`the queued requirement has no FIFO sequence: ${JSON.stringify(envelope.fifoSeq ?? null)}`);
    }
  }
  if (consumption.stillPending === true) {
    missing.push('the runtime never consumed the confirmed requirement from the FIFO queue');
  }
  if (Number.isInteger(consumption.earlierStillPending) && consumption.earlierStillPending > 0) {
    missing.push(`${consumption.earlierStillPending} earlier FIFO requirement(s) are still pending behind the consumed one`);
  }
  if (consumption.retired === true) {
    missing.push(`the runtime retired the confirmed requirement instead of consuming it: ${JSON.stringify(consumption.retiredCode ?? null)}`);
  }
  if (!consumption.taskInputRevision || consumption.taskInputRevision < 1) {
    missing.push('the change was not appended as a new task input revision');
  }
  if (!Number.isInteger(consumption.consumedInputRevision)
    || !Number.isInteger(consumption.taskInputRevision)
    || consumption.consumedInputRevision < consumption.taskInputRevision) {
    missing.push(
      `the new task input revision was not consumed by an execution cycle: `
      + `consumed=${JSON.stringify(consumption.consumedInputRevision ?? null)} `
      + `appended=${JSON.stringify(consumption.taskInputRevision ?? null)}`,
    );
  }
  if (consumption.revisionRequirementId && consumption.revisionRequirementId !== envelope.requirementId) {
    missing.push('the appended task input revision does not carry the confirmed requirement');
  }

  const execution = observation.execution ?? {};
  if (!execution.operationId) missing.push('the change did not start a new execution operation');
  if (!Number.isInteger(execution.executionEpoch) || execution.executionEpoch <= Number(seed.executionEpoch ?? 0)) {
    missing.push(`the change did not start a new execution epoch: ${JSON.stringify(execution.executionEpoch ?? null)}`);
  }
  if (execution.newExecutionCount !== 1) {
    missing.push(`the change started ${JSON.stringify(execution.newExecutionCount ?? null)} execution cycles (expected exactly 1)`);
  }
  if (!String(execution.input ?? '').includes(observation.scenarioMarkers?.revisionMarker ?? '\u0000')) {
    missing.push('the new execution cycle did not run the confirmed revision input');
  }
  if (idValue(execution.dashboardOperationId) !== idValue(execution.operationId)) {
    missing.push(
      `the task projection did not move to the change execution: `
      + `${JSON.stringify(execution.dashboardOperationId ?? null)} vs ${JSON.stringify(execution.operationId ?? null)}`,
    );
  }

  const journalFacts = observation.journalFacts ?? {};
  if (journalFacts.terminal !== 'succeeded') {
    missing.push(`the journal has no succeeded terminal for the change execution: ${JSON.stringify(journalFacts.terminal ?? null)}`);
  }
  if (!Number.isInteger(journalFacts.checkpoints) || journalFacts.checkpoints < 1) {
    missing.push(`the change execution committed no checkpoint: ${JSON.stringify(journalFacts.checkpoints ?? null)}`);
  }
  if (!Number.isInteger(journalFacts.toolRounds) || journalFacts.toolRounds < 1) {
    missing.push(`the change execution ran no paired provider tool round: ${JSON.stringify(journalFacts.toolRounds ?? null)}`);
  }

  const terminal = observation.terminal ?? {};
  if (terminal.state !== 'succeeded') {
    missing.push(`the changed task did not reach a real succeeded terminal: ${JSON.stringify(terminal.state ?? null)}`);
  }
  const rendered = terminal.rendered ?? {};
  if (String(rendered.stateChip ?? '') !== '已完成') {
    missing.push(`the changed task dashboard chip=${JSON.stringify(rendered.stateChip ?? null)} (expected 已完成)`);
  }
  const renderedFacts = Array.isArray(rendered.facts) ? rendered.facts : [];
  const factValue = (label) => renderedFacts.find((fact) => fact.label === label)?.value ?? '';
  if (factValue('当前状态') !== '已完成') {
    missing.push(`the changed task dashboard 当前状态=${JSON.stringify(factValue('当前状态'))} (expected 已完成)`);
  }
  if (!factValue('Checkpoint').includes('succeeded')) {
    missing.push(`the changed task dashboard Checkpoint=${JSON.stringify(factValue('Checkpoint'))} (expected a committed succeeded checkpoint)`);
  }
  const renderedInput = factValue('输入');
  if (!String(renderedInput).includes(observation.scenarioMarkers?.revisionMarker ?? '\u0000')) {
    missing.push('the changed task dashboard did not show the confirmed revision as the current input');
  }

  const dashboardProbe = observation.dashboardProbe;
  if (dashboardProbe === null || dashboardProbe === undefined) {
    missing.push('the change dashboard read-back was not captured');
  } else if (typeof dashboardProbe !== 'object' || Array.isArray(dashboardProbe)) {
    missing.push(`the change dashboard read-back was malformed: ${JSON.stringify(dashboardProbe)}`);
  } else if (dashboardProbe.error) {
    missing.push(`the change dashboard read-back failed: ${String(dashboardProbe.error)}`);
  } else {
    const publicOutput = dashboardProbe.publicOutput;
    if (publicOutput === null || publicOutput === undefined || typeof publicOutput !== 'object' || Array.isArray(publicOutput)) {
      missing.push('the change dashboard read-back returned no public output');
    } else {
      if (publicOutput.state !== 'committed') {
        missing.push(`the change public output was not committed: state=${JSON.stringify(publicOutput.state ?? null)}`);
      }
      if (!Array.isArray(publicOutput.commits)) {
        missing.push(`the change public output commits were malformed: ${JSON.stringify(publicOutput.commits ?? null)}`);
      } else if (publicOutput.commits.length === 0) {
        missing.push('the committed change public output has no commits');
      } else if (!publicOutput.commits.some((commit) => String(commit?.text ?? '').includes(CHANGE_FIXTURE_PATH))) {
        missing.push(
          `the committed change public output did not reference the changed fixture ${CHANGE_FIXTURE_PATH}: `
          + `${JSON.stringify(publicOutput.commits.map((commit) => commit?.text ?? null))}`,
        );
      }
    }
  }

  const productFocus = observation.productFocus;
  if (productFocus === null || productFocus === undefined || typeof productFocus !== 'object' || Array.isArray(productFocus)) {
    missing.push('the product focus read-back was not captured');
  } else if (productFocus.timedOut === true) {
    missing.push(
      `the product focus read timed out before proving ${CHANGE_FIXTURE_PATH}: `
      + `state=${JSON.stringify(productFocus.state ?? null)}`,
    );
  } else if (productFocus.found !== true) {
    missing.push('the product focus center was not rendered on the change task dashboard');
  } else if (productFocus.hasFailure === true) {
    missing.push(`the product focus read the committed result as a failure: ${JSON.stringify(productFocus.failureText ?? null)}`);
  } else if (productFocus.state !== 'ready') {
    missing.push(`the product focus did not reach a ready state: state=${JSON.stringify(productFocus.state ?? null)}`);
  } else if (productFocus.visible !== true) {
    missing.push('the product focus session was not visible');
  } else {
    const sessionText = String(productFocus.sessionText ?? '').trim();
    if (!sessionText) {
      missing.push('the product focus session text was empty');
    } else if (!sessionText.includes(CHANGE_FIXTURE_PATH)) {
      missing.push(
        `the product focus session did not render the changed fixture ${CHANGE_FIXTURE_PATH}: `
        + `${JSON.stringify(sessionText.slice(0, 300))}`,
      );
    }
  }

  return missing;
}

/** Read the FIFO, inbox and task-input-revision facts the runtime persisted. */
export function consumptionFacts(records, { requirementId, draftId, taskId }) {
  const states = records.filter((record) => record?.kind === 'explicit-brain.state');
  const state = states.at(-1)?.state ?? null;
  if (!state) {
    return {
      found: false,
      envelope: null,
      stillPending: null,
      earlierStillPending: null,
      retired: null,
      retiredCode: null,
      taskInputRevision: null,
      consumedInputRevision: null,
      revisionRequirementId: null,
      nextFifoSeq: null,
    };
  }
  const inbox = state.inbox ?? {};
  const envelopes = Array.isArray(inbox.envelopes) ? inbox.envelopes : [];
  const pendingDraftIds = Array.isArray(inbox.pendingDraftIds) ? inbox.pendingDraftIds : [];
  const terminalOutcomes = Array.isArray(inbox.terminalOutcomes) ? inbox.terminalOutcomes : [];
  const envelope = envelopes.find((entry) => entry?.requirementId === requirementId)
    ?? envelopes.find((entry) => entry?.draftId === draftId)
    ?? null;
  const earlier = envelope
    ? envelopes.filter((entry) => Number(entry?.fifoSeq) < Number(envelope.fifoSeq))
    : [];
  const retired = terminalOutcomes.find((entry) => entry?.requirementId === requirementId) ?? null;
  const revisionEntry = (Array.isArray(state.taskInputRevisions) ? state.taskInputRevisions : [])
    .find((entry) => idValue(entry?.taskId) === String(taskId)) ?? null;
  const revision = (Array.isArray(revisionEntry?.state?.revisions) ? revisionEntry.state.revisions : [])
    .find((candidate) => candidate?.envelope?.requirementId === requirementId) ?? null;
  const pendingDraftSet = new Set(pendingDraftIds);
  return {
    found: true,
    envelope: envelope
      ? {
          requirementId: envelope.requirementId,
          draftId: envelope.draftId,
          fifoSeq: envelope.fifoSeq,
          taskRef: envelope.taskRef ?? null,
          intent: envelope.intent ?? null,
          normalizedInput: envelope.normalizedInput ?? null,
        }
      : null,
    stillPending: envelope ? pendingDraftSet.has(envelope.draftId) : null,
    earlierStillPending: envelope
      ? earlier.filter((entry) => pendingDraftSet.has(entry.draftId)).length
      : null,
    earlierCount: earlier.length,
    retired: retired !== null,
    retiredCode: retired?.code ?? null,
    taskInputRevision: revision?.inputRevision ?? null,
    consumedInputRevision: revisionEntry?.consumedInputRevision ?? null,
    revisionRequirementId: revision?.envelope?.requirementId ?? null,
    nextFifoSeq: inbox.nextFifoSeq ?? null,
    dispatchLedgerDraftIds: (Array.isArray(state.dispatchLedger) ? state.dispatchLedger : [])
      .map((entry) => entry?.draftId ?? null)
      .filter(Boolean),
  };
}

/** Parse the served revision label `修订 v<n> · <hash>`. */
export function parseRevisionLabel(label) {
  const match = /^修订\s*v(\d+)\s*·\s*(sha256:[0-9a-f]+)$/.exec(String(label ?? '').trim());
  if (!match) return null;
  return { version: Number(match[1]), hash: match[2] };
}

/**
 * The runtime's own interaction journal. The serve writes the explicit-brain
 * state (`inbox`, `taskInputRevisions`, `dispatchLedger`) through its
 * interaction journal under the control root's `main/sessions` directory, not
 * through the task journal. It is derived from the candidate's own control root;
 * it is never guessed from a name.
 */
export function interactionJournalPath(binding) {
  const mainRoot = binding?.runtimePaths?.mainRoot
    ?? (binding?.controlRoot ? join(binding.controlRoot, 'main') : null)
    ?? binding?.formalPaths?.mainRoot
    ?? null;
  return mainRoot ? join(mainRoot, 'sessions', 'explicit-brain.jsonl') : null;
}

async function submitSeedTask(binding, directive, evidence) {
  await submitDirectiveAndConfirmDraft(binding, directive, {
    clarificationAnswer: CLARIFY_ANSWER,
    onDirectiveFilled: async (stage) => {
      const dom = await assertEntryInputStage(binding, {
        entry: stage.entry,
        inputSelector: stage.inputSelector,
        directive,
      });
      const screenshot = await captureScreenshot(binding, '01-seed-task-input-before-submit');
      binding.inputStage = { entry: stage.entry, url: dom.url, directive, dom, screenshot, capturedAt: new Date().toISOString() };
      evidence.screenshots.push(screenshot);
    },
  });
  await approvePendingTaskGrant(binding);
}

async function captureInteractionInputStage(binding, directive) {
  const dom = await assertEntryInputStage(binding, {
    entry: 'interaction',
    inputSelector: INTAKE_SELECTOR,
    directive,
  });
  const screenshot = await captureScreenshot(binding, '02-existing-change-input-before-confirm');
  binding.inputStage = { entry: 'interaction', url: dom.url, directive, dom, screenshot, capturedAt: new Date().toISOString() };
  return binding.inputStage;
}

async function waitForSeedTerminal(binding) {
  return waitForTerminal(binding, { timeoutMs: Number(process.env.E2E_TERMINAL_TIMEOUT_MS ?? 600_000) });
}

async function waitForOrganized(binding, { taskId }) {
  const { page } = binding.browser;
  const outcome = await waitForDom(page, 'existing-change proposal awaiting confirmation', async () => {
    const dom = await readExistingChangeDom(binding);
    if (dom.state === 'awaiting-confirmation' && dom.proposalHidden === false && parseRevisionLabel(dom.revisionLabel)) {
      return { kind: 'revision', dom };
    }
    if (dom.errorCode) return { kind: 'refused', dom };
    if (['awaiting-clarification', 'rejected', 'dispatched', 'confirmed'].includes(String(dom.state))) {
      return { kind: 'state', dom };
    }
    return null;
  }, DEFAULT_CHANGE_TIMEOUT_MS);
  if (outcome.kind !== 'revision') {
    throw new Error(
      `the served interaction page did not organize the change into a reviewable revision `
      + `(${outcome.kind}): state=${JSON.stringify(outcome.dom.state)} `
      + `error=${JSON.stringify(outcome.dom.errorCode)} feedback=${JSON.stringify(outcome.dom.feedback)}`,
    );
  }
  const dom = outcome.dom;
  if (!String(dom.taskLabel ?? '').includes(String(taskId))) {
    throw new Error(`the organized proposal did not bind the exact task ${taskId}: ${JSON.stringify(dom.taskLabel)}`);
  }
  const revision = parseRevisionLabel(dom.revisionLabel);
  return { ...dom, revision };
}

/**
 * A rejected save: the real refine request is sent with a superseded base
 * revision version, so the runtime itself refuses it with its typed stale code.
 */
async function driveStaleSave(binding, page, traffic) {
  await page.route(REFINE_URL_GLOB, async (route) => {
    const request = route.request();
    const body = readJsonBody(request);
    const injected = { ...body, baseRevisionVersion: Number(body.baseRevisionVersion) + 7 };
    traffic.staleRefine = { url: request.url(), original: body, injected };
    await route.continue({ postData: JSON.stringify(injected) });
  });
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/refine') && response.request().method() === 'POST',
  { timeout: 60_000 });
  await page.click(SAVE_SELECTOR);
  const response = await responsePromise;
  const status = response.status();
  const body = await response.json().catch(() => null);
  await page.unroute(REFINE_URL_GLOB);
  return {
    status,
    code: body?.error?.code ?? body?.code ?? null,
    injectedVersion: traffic.staleRefine?.injected?.baseRevisionVersion ?? null,
    body,
  };
}

/** The accepted save: the real refine request is sent unchanged. */
async function driveRealSave(binding, page, traffic) {
  const refineCountBefore = traffic.refine.length;
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/refine') && response.request().method() === 'POST',
  { timeout: 60_000 });
  await page.click(SAVE_SELECTOR);
  const response = await responsePromise;
  const status = response.status();
  const body = await response.json().catch(() => null);
  if (status < 200 || status >= 300) {
    throw new Error(`the real revision save was refused: status=${status} body=${JSON.stringify(body).slice(0, 600)}`);
  }
  if (!body?.revision?.revisionHash || !Number.isInteger(body?.revision?.revisionVersion)) {
    throw new Error(`the revision save did not return a typed revision: ${JSON.stringify(body).slice(0, 600)}`);
  }
  const request = traffic.refine.slice(refineCountBefore).at(-1)?.body ?? null;
  return { status, body, revision: body.revision, request };
}

/**
 * Re-resolve the change execution's exact journal file list after its terminal.
 *
 * `waitForChangeDispatch` resolves the list while the change is still
 * dispatching. At that moment the runtime has not committed the change cycle's
 * checkpoint, so the cached list only holds the seed cycle's files. Once the
 * change reached its terminal, the change checkpoint exists, and the settlement
 * proof must read it.
 *
 * This calls the existing precise resolver again. The resolver selects the exact
 * config-derived project root, task, operation, cycle and epoch, so the refresh
 * cannot search the control root, cannot fall back to the newest file and
 * cannot borrow the seed cycle's checkpoint.
 */
export async function refreshChangeJournalPaths(binding) {
  await journalPathFor(binding);
  return binding.journalPaths;
}

/**
 * Wait for the changed requirement to start its own execution cycle. The
 * verified `operation.started` record is the only identity source: the cycle is
 * named by its own input, never guessed from a name or a counter.
 */
async function waitForChangeDispatch(binding, { taskId, marker, afterEpoch }) {
  const deadline = Date.now() + DEFAULT_CHANGE_TIMEOUT_MS;
  let last = 'the journal has no new execution for the changed task';
  for (;;) {
    await journalPathFor(binding);
    const read = await readJournalStrict(binding.journalPaths, { repoPath: binding.repoPath });
    if (!read.ok) {
      last = `authoritative journal unavailable: ${read.error}`;
    } else {
      const starts = read.records.filter((record) => record?.kind === 'operation.started'
        && idValue(record.taskId) === String(taskId)
        && Number.isSafeInteger(record.executionEpoch)
        && record.executionEpoch > Number(afterEpoch ?? 0));
      const matching = starts.filter((record) => String(record.input ?? '').includes(marker));
      if (matching.length > 1) {
        throw new Error(`the changed requirement started ${matching.length} execution cycles instead of one`);
      }
      if (matching.length === 1) {
        return { record: matching[0], newExecutionCount: starts.length };
      }
      last = starts.length
        ? `a new execution started without the confirmed revision input: ${JSON.stringify(starts.map((record) => String(record.input ?? '').slice(0, 120)))}`
        : 'no new execution cycle was started for the changed task';
    }
    if (Date.now() > deadline) {
      throw new Error(`the changed requirement was not dispatched: ${last}`);
    }
    await sleep(500);
  }
}

/**
 * Wait for the changed task to reach its own terminal. The probe must name the
 * change operation: the targeted task already had a settled terminal before the
 * change, so a terminal state alone would let the seed cycle masquerade as the
 * change.
 */
async function waitForChangeTerminal(binding, operationId) {
  const { page } = binding.browser;
  const expected = idValue(operationId);
  const probe = await waitForDom(page, 'changed task terminal', async () => {
    const dashboard = await readDashboardProbe(binding).catch(() => null);
    if (!dashboard) return null;
    // blocked/not-applicable are real final terminals: record and return instead
    // of waiting out the change timeout on a task that will never advance.
    if (OBSERVED_TERMINAL_STATES.includes(dashboard.state)) {
      if (!expected || idValue(dashboard.operationId) !== expected) return null;
      return dashboard;
    }
    return null;
  }, Number(process.env.E2E_TERMINAL_TIMEOUT_MS ?? 600_000));
  binding.terminalState = probe.state;
  binding.dashboardProbe = probe;
  return probe;
}

/**
 * Fire the confirmation click on a control the UI disabled. The disabled
 * attribute is not the authorization boundary: the confirmation action
 * re-checks the exact revision, so a synthetic activation must be refused and
 * must send nothing.
 */
async function dispatchSyntheticClick(binding, selector) {
  const { page } = binding.browser;
  await page.evaluate((target) => {
    const button = document.querySelector(target);
    if (!button) throw new Error(`missing control ${target}`);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, selector);
}

function readJsonBody(request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

function idValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' && value !== null ? value.value : String(value);
}
