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
  openTaskDashboard,
  pageBackDashboardHistory,
  probeDashboardLiveSse,
  submitDirectiveAndConfirmDraft,
  waitForTerminal,
} from '../lib/browser.mjs';
import {
  countTurnEvidenceFor,
  journalPathFor,
  manifestsIdentical,
  readToolOutputReports,
  workspaceManifest,
} from '../lib/journal.mjs';

export const SCENARIO = 'local-file-search';

const CLARIFY_ANSWER =
  'Do not clarify. Search the workspace directly with the file tools available and finish with your answer.';

export async function runLocalFileSearchScenario(binding) {
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
  await captureScreenshot(binding, '02-draft-confirmed');
  evidence.screenshots.push(`${binding.screenshotsDir}/02-draft-confirmed.png`);
  await captureScreenshot(binding, '03-run-queue');
  evidence.screenshots.push(`${binding.screenshotsDir}/03-run-queue.png`);

  // Observe the live dashboard's real SSE connection while the task still runs:
  // result events arrive, a network interruption shows 已断开 without faking
  // failure, and reconnect restores live freshness.
  await openTaskDashboard(binding);
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
