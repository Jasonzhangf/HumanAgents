/**
 * Local file-search scenario — real implementation.
 *
 * Owns graph nodes: local_search_entry, local_search_browser_assertion,
 * local_search_terminal (in dashboard-e2e-local-file-search.graph.json).
 *
 * Creates a fixture file in this attempt's isolated workspace, drives the real
 * browser chain (input -> visible draft -> confirmation -> run queue ->
 * execution turns -> verifiable terminal), then proves from the authoritative
 * journal that the existing `file.search` and `file.read` tools ran against the
 * same real path and that the workspace is byte-identical afterwards
 * (relative path -> SHA-256 manifest before and after).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  captureDashboardEvidence,
  captureScreenshot,
  collectDashboardEventRows,
  openTaskDashboard,
  pageBackDashboardHistory,
  probeDashboardLiveSse,
  readDashboardProbe,
  readObservationDom,
  readTaskListDom,
  sleep,
  submitDirectiveAndConfirmDraft,
  waitForTerminal,
} from '../lib/browser.mjs';
import {
  countTurnEvidenceFor,
  journalPathFor,
  manifestsIdentical,
  resolveExecutionIdentity,
  readToolOutputReports,
  workspaceManifest,
} from '../lib/journal.mjs';
import { stopTaskAndSettle } from '../lib/cleanup.mjs';

export const SCENARIO = 'local-file-search';

const CLARIFY_ANSWER =
  'Do not clarify. Search the workspace directly with the file tools available and finish with your answer.';

export async function runLocalFileSearchScenario(binding) {
  if (binding.serviceMode === 'installed-attach') {
    return observeInstalledAttachedTask(binding);
  }
  // The runner supports three real outcomes through the same scenario. The
  // success path below keeps its full assertion set; failure/cancel drive the
  // real product control/input entrances and record whatever terminal the task
  // actually reaches. A mismatch is left for the runner's settlement proof to
  // report as INCOMPLETE, never rewritten into success.
  if ((binding.outcome ?? 'success') !== 'success') {
    return runRequestedNonSuccess(binding);
  }
  const evidence = { screenshots: [] };
  const marker = `humanagent-e2e-marker-${binding.attemptId}`;
  const fixtureDir = 'e2e-fixture';
  const fixtureRel = join(fixtureDir, 'hello-agent.txt');
  await mkdir(join(binding.workspace, fixtureDir), { recursive: true });
  await writeFile(join(binding.workspace, fixtureRel), `${marker}\nsecond line for the marker probe\n`, 'utf8');

  const before = await workspaceManifest(binding.workspace);

  const directive = [
    `Find the workspace file that contains the string ${marker}.`,
    `Use the file.search tool to search the workspace for ${marker}, then use the file.read tool on the matching path.`,
    `Report the exact file path and the matching line in your final answer.`,
    'Do not create, modify, move or delete any file. Do not ask clarifying questions.',
  ].join(' ');

  // browser input -> visible draft -> user confirmation
  await captureScreenshot(binding, '01-input-before-submit');
  evidence.screenshots.push(`${binding.screenshotsDir}/01-input-before-submit.png`);
  await submitDirectiveAndConfirmDraft(binding, directive, { clarificationAnswer: CLARIFY_ANSWER });
  const draftIntent = binding.draft?.intent ?? '';
  await captureScreenshot(binding, '02-draft-confirmed');
  evidence.screenshots.push(`${binding.screenshotsDir}/02-draft-confirmed.png`);
  await captureScreenshot(binding, '03-run-queue');
  evidence.screenshots.push(`${binding.screenshotsDir}/03-run-queue.png`);

  // Observe the live dashboard's real SSE connection while the task still runs:
  // result events arrive, a network interruption shows 已断开 without faking
  // failure, and reconnect restores live freshness.
  await openTaskDashboard(binding);
  // Capture the live page snapshot while the task still runs: the real SSE
  // connection, the running state chip, and the trajectory events delivered
  // before terminal. This must happen before the task terminalizes.
  const liveSse = await probeDashboardLiveSse(binding).catch((error) => ({ error: error.message }));

  // run queue -> execution turns -> verifiable terminal
  const dashboard = await waitForTerminal(binding);
  const dashboardEvidence = await captureDashboardEvidence(binding);
  const historyPaging = await pageBackDashboardHistory(binding).catch((error) => ({ error: error.message }));
  await captureScreenshot(binding, '04-task-result');
  evidence.screenshots.push(`${binding.screenshotsDir}/04-task-result.png`);

  const after = await workspaceManifest(binding.workspace);
  const unchanged = manifestsIdentical(before, after);

  await journalPathFor(binding);
  const turnEvidence = await countTurnEvidenceFor(binding).catch(() => null);
  const events = turnEvidence?.allEvents ?? [];
  const haystack = JSON.stringify({ events, output: dashboard.output ?? null });
  const tools = events.filter((event) => event.kind === 'provider.tool' || event.kind === 'provider.tool-result');
  const isTool = (id) => (event) => new RegExp(id, 'i').test(`${event.summary ?? ''} ${event.toolId ?? ''}`);
  const searchCalls = tools.filter((event) => event.kind === 'provider.tool' && isTool('file\\.search')(event));
  const searchResults = tools.filter((event) => event.kind === 'provider.tool-result' && isTool('file\\.search')(event));
  const readCalls = tools.filter((event) => event.kind === 'provider.tool' && isTool('file\\.read')(event));

  // The journal carries the tool output descriptor, not the report body: read the
  // immutable report behind each succeeded result through the task-scoped
  // tool-output route (the route re-verifies the descriptor digest) and assert
  // the report really contains the query and the matching path/line.
  const reports = await readToolOutputReports(binding, dashboard, events);
  const searchReportEntries = reports.filter((entry) => entry.toolId === 'file.search');
  const searchReports = searchReportEntries.filter((entry) => entry.ok).map((entry) => entry.report);
  const reportHaystacks = searchReports.map((report) => JSON.stringify(report ?? null));
  const reportHasQuery = reportHaystacks.some((text) => text.includes(marker));
  const reportHasPath = reportHaystacks.some((text) => text.includes('hello-agent.txt'));
  const reportHasLine = reportHaystacks.some((text) => /"(line|lineNumber|line_number)"\s*:\s*\d+/.test(text))
    || reportHaystacks.some((text) => /"(summary|snippet|preview|text)"\s*:\s*"[^"]*humanagent-e2e-marker/.test(text));

  // The read must target the path the search hit, not a path known up front.
  const searchQueryObserved = searchCalls.some((event) => JSON.stringify(event.arguments ?? {}).includes(marker));
  const readTargets = readCalls.map((event) => readPathFromEvent(event)).filter((value) => typeof value === 'string');
  const readTargetedHit = readTargets.some((target) => target.includes('hello-agent.txt'));

  const fixtureHit = haystack.includes('hello-agent.txt');
  const markerHit = haystack.includes(marker);
  const fixtureContent = await readFile(join(binding.workspace, fixtureRel), 'utf8').catch(() => null);

  const missing = [];
  if (dashboard.state !== 'succeeded') missing.push(`terminal state=${dashboard.state} (expected succeeded)`);
  if (!turnEvidence) missing.push('authoritative journal evidence could not be read');
  else if (turnEvidence.toolRounds < 2) missing.push(`journal toolRounds=${turnEvidence.toolRounds} (expected >= 2)`);
  if (searchCalls.length === 0) missing.push('no file.search tool call was recorded');
  else if (!searchQueryObserved) missing.push(`no file.search call carried the query marker ${marker}`);
  if (searchResults.length === 0) missing.push('no file.search tool result was recorded');
  if (readCalls.length === 0) missing.push('no file.read tool call was recorded');
  if (searchReports.length === 0) missing.push('no succeeded file.search tool-output report could be read back');
  if (!reportHasQuery) missing.push(`the file.search report did not contain the query marker ${marker}`);
  if (!reportHasPath) missing.push(`the file.search report did not contain the matching path ${fixtureRel}`);
  if (!reportHasLine) missing.push('the file.search report did not contain a matching line or summary');
  if (!readTargetedHit) missing.push(`no file.read call targeted the search-hit path ${fixtureRel}`);
  if (!fixtureHit) missing.push(`workspace path ${fixtureRel} did not appear in the tool evidence`);
  if (!markerHit) missing.push(`fixture marker ${marker} did not appear in the tool evidence`);
  if (!unchanged) missing.push('workspace manifest changed during the read-only run');
  const toolStepEvidence = dashboardEvidence.toolStepEvidence ?? [];
  const pairedCallResult = toolStepEvidence.find((step) =>
    typeof step.stepId === 'string'
    && step.stepId.startsWith('call_')
    && step.status === 'succeeded'
    && typeof step.returned === 'string'
    && step.returned.includes('outputRef=')
    && step.returned.includes('arguments=')
    && step.returned.includes('durationMs=')
  );
  if (!pairedCallResult) {
    missing.push('no callId-paired succeeded tool step exposed toolId, outputRef, arguments, and duration');
  }
  if (!(historyPaging?.flipped && historyPaging?.reachedOlderEvents)) {
    missing.push('dashboard history did not page back to older typed events');
  }
  const dashboardDom = dashboardEvidence.taskDashboardDom ?? {};
  if (!Array.isArray(dashboardDom.statusLayers) || dashboardDom.statusLayers.length !== 3) {
    missing.push('dashboard did not render the business/waiting/freshness status layers');
  }
  if ((dashboardDom.duplicateEventIds ?? []).length > 0) {
    missing.push('dashboard rendered duplicate event identities');
  }
  if (!String(dashboardDom.historyGap ?? '').includes('更早还有')) {
    missing.push('dashboard did not expose the older-event gap after paging');
  }
  if (!String(dashboardDom.pageStatus ?? '').includes('任务投影已同步')) {
    missing.push('dashboard did not expose a successful projection read in the status banner');
  }
  if (!liveSse || liveSse.error) {
    missing.push(`live SSE probe failed: ${liveSse?.error ?? 'missing result'}`);
  } else {
    if (!liveSse.providerToolResultSeen) missing.push('live SSE did not deliver provider.tool-result');
    if (!String(liveSse.broken?.freshness ?? '').includes('实时连接已断开')) {
      missing.push('SSE interruption did not mark the connection freshness as disconnected');
    }
    if (liveSse.broken?.stateChip === '失败') missing.push('SSE interruption was rendered as task failure');
    if (!String(liveSse.broken?.pageStatus ?? '').includes('读取任务失败')) {
      missing.push('SSE interruption did not perform a visible projection readback');
    }
    if (!(liveSse.broken?.dashboardReads > (liveSse.connected?.dashboardReads ?? 0))) {
      missing.push('SSE interruption did not trigger a dashboard projection read');
    }
    const recoveredFreshness = String(liveSse.recovered?.freshness ?? '');
    if (!recoveredFreshness.includes('实时连接已建立') && !recoveredFreshness.includes('执行已收拢')) {
      missing.push('SSE reconnection did not restore live or settled freshness');
    }
    if (!String(liveSse.recovered?.pageStatus ?? '').includes('任务投影已同步')) {
      missing.push('SSE reconnection did not perform a visible successful projection readback');
    }
  }
  const terminalEventKinds = new Set((dashboardEvidence.sse ?? []).map((event) => event.kind));
  if (!terminalEventKinds.has('provider.tool-result')) {
    missing.push('terminal trajectory did not include provider.tool-result');
  }

  // Rendered terminal facts: the chip, the current-state fact and the
  // checkpoint fact must all state the real succeeded outcome.
  if (String(dashboardDom.stateChip ?? '') !== '已完成') {
    missing.push(`terminal dashboard state chip=${JSON.stringify(dashboardDom.stateChip ?? null)} (expected 已完成)`);
  }
  const dashboardFacts = dashboardDom.facts ?? [];
  const factValue = (label) => dashboardFacts.find((fact) => fact.label === label)?.value ?? '';
  if (factValue('当前状态') !== '已完成') {
    missing.push(`terminal dashboard 当前状态=${JSON.stringify(factValue('当前状态'))} (expected 已完成)`);
  }
  if (!factValue('Checkpoint').includes('succeeded')) {
    missing.push(`terminal dashboard Checkpoint=${JSON.stringify(factValue('Checkpoint'))} (expected a committed succeeded checkpoint)`);
  }

  // Rendered trajectory rows: tool requests keep request semantics and generic
  // provider.model rows stay hidden. The dashboard pages this history by turn,
  // so the rows are collected while paging back through the turns.
  const eventKindPrefix = (kindLabel) => String(kindLabel ?? '').split(' · ')[0];
  const isToolRequestRow = (row) => eventKindPrefix(row.kind) === 'provider.tool' && String(row.summary ?? '').startsWith('调用工具：');
  const isRequestStartRow = (row) => String(row.kind ?? '').startsWith('provider.model') && row.summary === 'provider requested model work';
  const allRows = [];
  const seenEventIds = new Set();
  for (const row of await collectDashboardEventRows(binding, () => false, 40)) {
    if (row.eventId !== null && seenEventIds.has(row.eventId)) continue;
    if (row.eventId !== null) seenEventIds.add(row.eventId);
    allRows.push(row);
  }
  const toolRequestRows = allRows.filter(isToolRequestRow);
  if (toolRequestRows.length < 2) {
    missing.push(`terminal dashboard rendered ${toolRequestRows.length} provider tool request rows (expected >= 2)`);
  }
  const genericModelRows = allRows.filter((row) => row.summary === 'model');
  if (genericModelRows.length > 0) {
    missing.push(`terminal dashboard still rendered ${genericModelRows.length} generic provider.model rows with summary=model`);
  }
  const mislabelledToolRows = allRows.filter((row) => eventKindPrefix(row.kind) === 'provider.tool-result' && String(row.summary ?? '').startsWith('调用工具：'));
  if (mislabelledToolRows.length > 0) {
    missing.push(`terminal dashboard rendered ${mislabelledToolRows.length} tool results as tool requests`);
  }
  const requestStartRows = allRows.filter(isRequestStartRow);
  if (requestStartRows.length === 0) {
    missing.push('terminal dashboard rendered no visible provider request-start row');
  }
  const journalRequestStarts = turnEvidence?.requestStartTurns ?? 0;
  if (requestStartRows.length < Math.min(journalRequestStarts, 2)) {
    missing.push(`terminal dashboard rendered ${requestStartRows.length} request-start rows, the journal recorded ${journalRequestStarts}`);
  }

  // The live snapshot captured while the task ran must show a nonterminal chip:
  // the dashboard must not claim a terminal state before the runtime reports it.
  const liveChip = String(liveSse?.connected?.stateChip ?? '');
  if (!liveSse || liveSse.error) {
    missing.push(`live dashboard snapshot could not be captured: ${liveSse?.error ?? 'missing result'}`);
  } else if (['已完成', '失败', '已停止'].includes(liveChip)) {
    missing.push(`running dashboard already claimed a terminal state chip: ${JSON.stringify(liveChip)}`);
  }

  // The draft the human confirms must be the explicit brain's new-task intent.
  if (draftIntent !== 'create') {
    missing.push(`draft intent=${JSON.stringify(draftIntent)} (expected create)`);
  }

  // Pipeline observation page: the real registry nodes and the projected page state.
  const observationDom = await readObservationDom(binding).catch((error) => ({ error: error.message }));
  if (observationDom.error) {
    missing.push(`observation page DOM could not be read: ${observationDom.error}`);
  } else {
    for (const expected of ['sensory.inbox', 'explicit.normalize', 'implicit.classify', 'interactive.queue', 'execution.queue', 'pipeline.execute', 'settle', 'task.output']) {
      if (!(observationDom.nodeIds ?? []).includes(expected)) {
        missing.push(`observation page did not render node ${expected}`);
      }
    }
    if (observationDom.metaChip !== '已完成') {
      missing.push(`observation page meta chip=${JSON.stringify(observationDom.metaChip)} (expected 已完成)`);
    }
  }

  // Task list page: the same task must be visible as a completed row.
  const taskListDom = await readTaskListDom(binding).catch((error) => ({ error: error.message }));
  if (taskListDom.error) {
    missing.push(`task list page DOM could not be read: ${taskListDom.error}`);
  } else {
    const completedRow = (taskListDom.links ?? []).find((link) => link.href.includes(binding.taskId) && link.text.includes('已完成'));
    if (!completedRow) {
      missing.push(`task list page did not show task ${binding.taskId} as a completed row`);
    }
  }

  evidence.scenarioEvidence = {
    directive,
    marker,
    fixture: { relPath: fixtureRel, absolutePath: join(binding.workspace, fixtureRel), content: fixtureContent },
    taskId: binding.taskId,
    terminalState: dashboard.state,
    executionEpoch: dashboard.executionEpoch ?? null,
    operationId: dashboard.operationId ?? null,
    checkpoint: dashboard.checkpoint ?? null,
    toolRounds: turnEvidence?.toolRounds ?? 0,
    requestStartTurns: turnEvidence?.requestStartTurns ?? 0,
    searchCalls: searchCalls.map(pickEvent),
    searchResults: searchResults.map(pickEvent),
    readCalls: readCalls.map(pickEvent),
    allProviderToolEvents: tools.map(pickEvent),
    toolOutputReports: reports.map(pickReport),
    searchReportHasQuery: reportHasQuery,
    searchReportHasPath: reportHasPath,
    searchReportHasLine: reportHasLine,
    searchQueryObserved,
    readTargets,
    readTargetedSearchHit: readTargetedHit,
    fixturePathObserved: fixtureHit,
    fixtureMarkerObserved: markerHit,
    workspaceManifestBefore: before,
    workspaceManifestAfter: after,
    workspaceUnchanged: unchanged,
    outputPreview: String(dashboard.output ?? '').slice(0, 1600),
    dashboardProbe: dashboardEvidence.dashboardProbe,
    toolStepEvidence: dashboardEvidence.toolStepEvidence,
    executeNode: dashboardEvidence.executeNode,
    observation: dashboardEvidence.observation,
    taskDashboardDom: dashboardEvidence.taskDashboardDom,
    terminalSse: dashboardEvidence.sse,
    historyPaging,
    liveSse,
    entryLayout: binding.entryLayout ?? null,
    trajectoryRows: {
      collected: allRows.length,
      toolRequests: toolRequestRows.map(pickEvent),
      requestStarts: requestStartRows.map(pickEvent),
      genericModelRows: genericModelRows.length,
    },
    observationDom: { nodeIds: observationDom.nodeIds ?? null, metaChip: observationDom.metaChip ?? null, error: observationDom.error ?? null },
    taskListDom: { groupTitles: taskListDom.groupTitles ?? null, links: taskListDom.links ?? null, error: taskListDom.error ?? null },
  };
  evidence.terminalState = dashboard.state;
  evidence.dashboardState = dashboard.state;
  evidence.toolRounds = turnEvidence?.toolRounds ?? 0;
  evidence.requestStartTurns = turnEvidence?.requestStartTurns ?? 0;
  evidence.checkpointCommitted = turnEvidence?.checkpointCommitted ?? 0;
  evidence.terminalRecord = turnEvidence?.terminalRecords.slice(-1)[0] ?? null;
  evidence.evidenceRefs = events
    .flatMap((event) => (Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []))
    .slice(0, 40);
  if (missing.length) evidence.missingEvidence = missing;
  return evidence;
}

/**
 * Installed-attach is an observation of an explicit existing task. It never
 * creates a fixture, submits a requirement, confirms a draft, or stops the
 * formal owner. The authoritative Journal supplies the execution identity; the
 * formal Dashboard is read only to verify that it exposes the same operation
 * and epoch.
 */
async function observeInstalledAttachedTask(binding) {
  const explicitTaskId = binding.taskId ?? binding.scope?.taskId ?? null;
  if (!explicitTaskId) {
    throw new Error('installed-attach observation requires an explicit existing task id');
  }
  if (!binding.attachTaskProbe) {
    throw new Error('installed-attach observation requires the verified attachment task probe');
  }

  await journalPathFor(binding);
  const resolved = await resolveExecutionIdentity(binding);
  if (!resolved.ok) {
    throw new Error(`installed-attach observation could not resolve execution identity: ${resolved.reason}`);
  }
  const identity = resolved.identity;
  if (!sameId(identity.taskId, explicitTaskId)) {
    throw new Error(
      `installed-attach journal task ${JSON.stringify(idValue(identity.taskId))} `
      + `does not match explicit task ${JSON.stringify(idValue(explicitTaskId))}`,
    );
  }
  if (!identity.operationId || !Number.isSafeInteger(identity.executionEpoch) || identity.executionEpoch <= 0) {
    throw new Error('installed-attach observation requires a complete operationId and positive executionEpoch');
  }

  await openTaskDashboard(binding, { waitNonterminal: false });
  const dashboard = await readDashboardProbe(binding);
  if (dashboard.taskId !== undefined && !sameId(dashboard.taskId, explicitTaskId)) {
    throw new Error(
      `installed-attach Dashboard task ${JSON.stringify(idValue(dashboard.taskId))} `
      + `does not match explicit task ${JSON.stringify(idValue(explicitTaskId))}`,
    );
  }
  if (!sameId(dashboard.operationId, identity.operationId)) {
    throw new Error(
      `installed-attach Dashboard operation ${JSON.stringify(idValue(dashboard.operationId))} `
      + `does not match journal operation ${JSON.stringify(idValue(identity.operationId))}`,
    );
  }
  if (dashboard.executionEpoch !== identity.executionEpoch) {
    throw new Error(
      `installed-attach Dashboard epoch ${JSON.stringify(dashboard.executionEpoch)} `
      + `does not match journal epoch ${identity.executionEpoch}`,
    );
  }

  const screenshot = await captureScreenshot(binding, '01-installed-attach-observation');
  const turnEvidence = await countTurnEvidenceFor(binding).catch(() => null);
  const events = turnEvidence?.allEvents ?? [];
  const reports = await readToolOutputReports(binding, dashboard, events);
  const evidence = {
    screenshots: [screenshot],
    terminalState: dashboard.state ?? null,
    dashboardState: dashboard.state ?? null,
    toolRounds: turnEvidence?.toolRounds ?? 0,
    requestStartTurns: turnEvidence?.requestStartTurns ?? 0,
    checkpointCommitted: turnEvidence?.checkpointCommitted ?? 0,
    terminalRecord: turnEvidence?.terminalRecords?.slice(-1)[0] ?? null,
    evidenceRefs: events
      .flatMap((event) => (Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []))
      .slice(0, 40),
    scenarioEvidence: {
      attachedObservation: true,
      taskId: explicitTaskId,
      operationId: identity.operationId,
      cycleId: identity.cycleId,
      executionEpoch: identity.executionEpoch,
      dashboardState: dashboard.state ?? null,
      dashboardProbe: {
        state: dashboard.state ?? null,
        operationId: dashboard.operationId ?? null,
        executionEpoch: dashboard.executionEpoch ?? null,
      },
      toolOutputReports: reports.map(pickReport),
      entryLayout: binding.entryLayout ?? null,
    },
    // This is an observation, not a new browser task submission. It must not
    // close the original business-task acceptance threshold.
    missingEvidence: ['installed-attach observation is not a new business-task submission'],
  };
  return evidence;
}

/**
 * Drive the real non-success outcome for this scenario. `cancel` submits a real
 * task and then requests the product task-scoped stop; `failure` submits a real
 * directive that exercises a failing tool path and records the observed
 * terminal. Neither path fabricates a terminal.
 */
async function runRequestedNonSuccess(binding) {
  const outcome = binding.outcome;
  const evidence = { screenshots: [] };
  const fixtureDir = 'e2e-fixture';
  const missingRel = join(fixtureDir, 'e2e-missing-file.txt');
  const marker = `humanagent-e2e-marker-${binding.attemptId}`;
  await mkdir(join(binding.workspace, fixtureDir), { recursive: true });
  await writeFile(join(binding.workspace, fixtureDir, 'hello-agent.txt'), `${marker}\n`, 'utf8');

  const successDirective = [
    `Find the workspace file that contains the string ${marker}.`,
    `Use the file.search tool to search the workspace for ${marker}.`,
    'Report the exact file path in your final answer. Do not create, modify, move or delete any file.',
  ].join(' ');
  const failureDirective = [
    `Use the file.read tool to read the workspace path ${missingRel}.`,
    'That path intentionally does not exist. Do not create it.',
    'Report the exact tool error you received. Do not substitute a different file.',
  ].join(' ');
  const directive = outcome === 'cancel' ? successDirective : failureDirective;

  await submitDirectiveAndConfirmDraft(binding, directive, { clarificationAnswer: CLARIFY_ANSWER });
  await captureScreenshot(binding, '01-input-submitted');
  evidence.screenshots.push(`${binding.screenshotsDir}/01-input-submitted.png`);

  await openTaskDashboard(binding, { waitNonterminal: outcome === 'cancel' });
  let stopResponse = null;
  if (outcome === 'cancel') {
    // Learn the real execution identity from the verified public journal before
    // issuing any stop. The harness never guesses cycle/epoch and never sends a
    // stop while the identity is unknown.
    const identity = await waitForExecutionIdentity(binding);
    binding.operationId = identity.operationId;
    binding.cycleId = identity.cycleId;
    binding.executionEpoch = identity.executionEpoch;
    binding.scope = identity.scope ?? {
      taskId: identity.taskId,
      cycleId: identity.cycleId,
      operationId: identity.operationId,
    };
    // Drive the cancel through the single task-scoped stop/settle owner. The
    // owner records the stop attempt separately from the settlement assessment,
    // so the runner can reassess read-only once the final journal is complete
    // without ever issuing a second stop.
    const stopSettle = await stopTaskAndSettle(binding, binding.taskId, { expectedOutcome: 'cancel' });
    binding.attemptControl = { ...(binding.attemptControl ?? {}), stopSettle };
    stopResponse = stopSettle.stopResponse ?? { status: null, body: stopSettle.reason ?? null };
  }

  const dashboard = await waitForTerminal(binding, { timeoutMs: Number(process.env.E2E_TERMINAL_TIMEOUT_MS ?? 600_000) });
  await captureScreenshot(binding, '02-outcome');
  evidence.screenshots.push(`${binding.screenshotsDir}/02-outcome.png`);

  await journalPathFor(binding);
  const turnEvidence = await countTurnEvidenceFor(binding).catch(() => null);
  const terminalIds = {
    taskId: binding.taskId,
    operationId: dashboard.operationId ?? null,
    executionEpoch: dashboard.executionEpoch ?? null,
  };
  evidence.scenarioEvidence = {
    directive,
    requestedOutcome: outcome,
    marker,
    missingRel,
    taskId: binding.taskId,
    terminalState: dashboard.state,
    operationId: dashboard.operationId ?? null,
    cycleId: binding.cycleId ?? null,
    executionEpoch: dashboard.executionEpoch ?? null,
    stopResponse,
    terminalIds,
    outputPreview: String(dashboard.output ?? '').slice(0, 1600),
    toolRounds: turnEvidence?.toolRounds ?? 0,
    requestStartTurns: turnEvidence?.requestStartTurns ?? 0,
    terminalRecords: turnEvidence?.terminalRecords ?? null,
    errorEvents: (turnEvidence?.allEvents ?? []).filter((event) => event.error || event.status === 'failed'),
  };
  evidence.terminalState = dashboard.state;
  evidence.dashboardState = dashboard.state;
  evidence.toolRounds = turnEvidence?.toolRounds ?? 0;
  evidence.requestStartTurns = turnEvidence?.requestStartTurns ?? 0;
  evidence.checkpointCommitted = turnEvidence?.checkpointCommitted ?? 0;
  evidence.terminalRecord = turnEvidence?.terminalRecords.slice(-1)[0] ?? null;
  // Do not populate missingEvidence from a non-success terminal: the runner
  // classifies the real outcome and its settlement proof decides acceptance.
  return evidence;
}

/**
 * Resolve the current execution identity from the verified public Journal,
 * cross-checking the dashboard projection when it exposes the same fields.
 * The stop is never issued before this succeeds.
 */
async function waitForExecutionIdentity(binding, timeoutMs = Number(process.env.E2E_IDENTITY_TIMEOUT_MS ?? 120_000)) {
  const deadline = Date.now() + timeoutMs;
  let last = 'identity not resolved';
  for (;;) {
    try {
      await journalPathFor(binding);
      const resolved = await resolveExecutionIdentity(binding);
      if (resolved.ok) {
        const probe = await readDashboardProbe(binding).catch(() => null);
        if (probe?.operationId && probe.operationId !== resolved.identity.operationId?.value) {
          throw new Error(`dashboard operationId ${probe.operationId} does not match verified journal operation ${resolved.identity.operationId?.value}`);
        }
        if (Number.isSafeInteger(probe?.executionEpoch) && probe.executionEpoch !== resolved.identity.executionEpoch) {
          throw new Error(`dashboard executionEpoch ${probe.executionEpoch} does not match verified journal epoch ${resolved.identity.executionEpoch}`);
        }
        return resolved.identity;
      }
      last = resolved.reason;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(`execution identity was not available before stop: ${last}`);
    }
    await sleep(250);
  }
}

function pickEvent(event) {
  return {
    seq: event.seq,
    kind: event.kind,
    state: event.state,
    summary: event.summary,
    callId: event.callId,
    toolId: event.toolId,
    arguments: event.arguments,
    error: event.error,
    evidenceRefs: event.evidenceRefs,
  };
}

function pickReport(entry) {
  return {
    seq: entry.seq,
    callId: entry.callId,
    toolId: entry.toolId,
    path: entry.path,
    ok: entry.ok,
    status: entry.status,
    error: entry.error,
    report: entry.report,
  };
}

/** The workspace path a file tool call targeted, taken from its own arguments. */
function readPathFromEvent(event) {
  const args = event.arguments;
  if (args === null || typeof args !== 'object') return null;
  for (const key of ['path', 'file_path']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key];
  }
  return null;
}

function idValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' && value !== null ? value.value : String(value);
}

function sameId(left, right) {
  const a = idValue(left);
  const b = idValue(right);
  return a !== null && b !== null && a === b;
}
