/**
 * Web-search scenario — real implementation.
 *
 * Owns graph nodes: web_search_entry, web_search_browser_assertion,
 * web_search_terminal (in dashboard-e2e-web-search.graph.json).
 *
 * Drives the real browser chain (input -> visible draft -> confirmation -> run
 * queue -> execution turns -> verifiable terminal), then proves from the
 * authoritative journal that the `web.search` tool actually ran: a provider.tool
 * round with a matching tool result, and at least one http(s) URL in the tool
 * evidence. A candidate without a registered `web.search` tool is a real
 * deviation and this attempt stays INCOMPLETE.
 */

import { captureScreenshot, submitDirectiveAndConfirmDraft, waitForTerminal } from '../lib/browser.mjs';
import { countTurnEvidenceFor, journalPathFor, readToolOutputReports } from '../lib/journal.mjs';

export const SCENARIO = 'web-search';

const QUERY_MARKER = 'humanagent-e2e-web-search';
const TOPIC = 'Rust async runtime tokio';
/** Responses wire name of the `web.search` tool id, per
 *  `RESPONSES_TOOL_ID_TO_WIRE_NAME` in packages/adapters/provider/src/codecs.ts.
 *  The directive names the model-facing function so the model calls the bound
 *  tool instead of RCC's own shell/server-tool surface. */
const WEB_SEARCH_FUNCTION = 'web_search';
const CLARIFY_ANSWER =
  'Do not clarify. Run the web search with the tool available now and report what you found.';

export async function runWebSearchScenario(binding) {
  const evidence = { screenshots: [] };
  const directive = [
    `Search the web for current information about "${TOPIC}" and report what you find.`,
    `Call the provided function tool \`${WEB_SEARCH_FUNCTION}\` with the query "${TOPIC}".`,
    'Run the search now; do not ask clarifying questions and do not use a shell or server-side tool.',
    'Report the result titles, URLs and the page count in your final answer.',
    `Include the string ${QUERY_MARKER} in your final answer.`,
  ].join(' ');

  await captureScreenshot(binding, '01-input-before-submit');
  evidence.screenshots.push(`${binding.screenshotsDir}/01-input-before-submit.png`);
  await submitDirectiveAndConfirmDraft(binding, directive, { clarificationAnswer: CLARIFY_ANSWER });
  await captureScreenshot(binding, '02-draft-confirmed');
  evidence.screenshots.push(`${binding.screenshotsDir}/02-draft-confirmed.png`);
  await captureScreenshot(binding, '03-run-queue');
  evidence.screenshots.push(`${binding.screenshotsDir}/03-run-queue.png`);

  const dashboard = await waitForTerminal(binding);
  await captureScreenshot(binding, '04-task-result');
  evidence.screenshots.push(`${binding.screenshotsDir}/04-task-result.png`);

  await journalPathFor(binding);
  const turnEvidence = await countTurnEvidenceFor(binding).catch(() => null);
  const events = turnEvidence?.allEvents ?? [];
  const isWebSearch = (event) => /web\.search|web_search/i.test(`${event.summary ?? ''} ${event.toolId ?? ''}`);
  const tools = events.filter((event) => event.kind === 'provider.tool' || event.kind === 'provider.tool-result');
  const calls = tools.filter((event) => event.kind === 'provider.tool' && isWebSearch(event));
  const results = tools.filter((event) => event.kind === 'provider.tool-result' && isWebSearch(event));
  const urls = urlsInEvents(tools);
  // The journal carries the tool output descriptor, not the report body: read
  // the immutable report behind each succeeded tool result through the runtime
  // tool-output route (digest re-verified there) to see the real provider pages.
  const reports = await readToolOutputReports(binding, dashboard, events);
  for (const url of urlsInReports(reports)) {
    if (!urls.includes(url)) urls.push(url);
  }

  const output = outputText(dashboard);
  const missing = [];
  if (dashboard.state !== 'succeeded') missing.push(`terminal state=${dashboard.state} (expected succeeded)`);
  if (!turnEvidence) missing.push('authoritative journal evidence could not be read');
  else if (turnEvidence.toolRounds < 1) missing.push(`journal toolRounds=${turnEvidence.toolRounds} (expected >= 1)`);
  if (calls.length === 0) missing.push('no provider.tool round used the web.search tool');
  if (results.length === 0) missing.push('no tool result was recorded for the web.search call');
  if (urls.length === 0) missing.push('no http(s) URL appeared in the tool round evidence or tool output reports');

  evidence.scenarioEvidence = {
    directive,
    topic: TOPIC,
    queryMarker: QUERY_MARKER,
    taskId: binding.taskId,
    terminalState: dashboard.state,
    executionEpoch: dashboard.executionEpoch ?? null,
    operationId: dashboard.operationId ?? null,
    checkpoint: dashboard.checkpoint ?? null,
    toolRounds: turnEvidence?.toolRounds ?? 0,
    requestStartTurns: turnEvidence?.requestStartTurns ?? 0,
    webSearchToolCalls: calls.map(pickEvent),
    webSearchToolResults: results.map(pickEvent),
    allProviderToolEvents: tools.map(pickEvent),
    toolOutputReports: reports.map((entry) => ({
      seq: entry.seq,
      toolId: entry.toolId,
      ok: entry.ok,
      status: entry.status,
      error: entry.error,
      resultCount: Array.isArray(entry.report?.results) ? entry.report.results.length : null,
      reportPreview: entry.report === null ? null : JSON.stringify(entry.report).slice(0, 2400),
    })),
    resultUrls: urls.slice(0, 24),
    outputContainsMarker: output.includes(QUERY_MARKER),
    outputPreview: output.slice(0, 1800),
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

function isToolEvent(event) {
  return event.kind === 'provider.tool' || event.kind === 'provider.tool-result';
}

function urlsInEvents(events) {
  const urls = [];
  for (const event of events) {
    if (!isToolEvent(event)) continue;
    collectUrls(JSON.stringify(event), urls);
  }
  return urls;
}

function urlsInReports(reports) {
  const urls = [];
  for (const entry of reports) {
    if (entry.report === null || entry.report === undefined) continue;
    collectUrls(JSON.stringify(entry.report), urls);
  }
  return urls;
}

function collectUrls(haystack, urls) {
  for (const match of haystack.matchAll(/https?:\/\/[^\s"'\\<>)]+/g)) {
    const url = match[0].replace(/[.,;)\]}]+$/, '');
    if (!urls.includes(url)) urls.push(url);
  }
}

function outputText(dashboard) {
  const parts = [];
  if (typeof dashboard.output === 'string') parts.push(dashboard.output);
  if (Array.isArray(dashboard.recentEvents)) {
    for (const event of dashboard.recentEvents) {
      if (typeof event.summary === 'string') parts.push(event.summary);
    }
  }
  return parts.join('\n');
}

function pickEvent(event) {
  return {
    seq: event.seq,
    kind: event.kind,
    state: event.state,
    summary: event.summary,
    callId: event.callId,
    toolId: event.toolId,
    error: event.error,
    evidenceRefs: event.evidenceRefs,
  };
}
