/**
 * AItest scenario — real implementation.
 *
 * Owns graph nodes: aitest_entry, aitest_capability, aitest_checker
 * (in dashboard-e2e-aitest.graph.json).
 *
 * Locates the AItest repo, verifies the target task and its applicable checker,
 * creates ONE fresh run directory with the task's own `prepare-run.sh` (which
 * refuses to overwrite anything that already exists), drives one bounded real
 * attempt through the served Dashboard, then runs the task's own
 * `inspect-result.mjs` against the produced `result.html`.
 *
 * The provider `file.write` tool is workspace-scoped, so the agent writes to a
 * mirror path inside this attempt's isolated workspace and this scenario places
 * the bytes into the AItest run directory. The AItest repo is never modified by
 * this runner: `task.md`, `prompts/` and `scripts/` are read only.
 */

import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { captureDashboardEvidence, captureScreenshot, submitDirectiveAndConfirmDraft, waitForTerminal } from '../lib/browser.mjs';
import { countTurnEvidenceFor, journalPathFor } from '../lib/journal.mjs';

export const SCENARIO = 'aitest';

const TASK_REL = 'tasks/pelican-bicycle';
const REQUIRED_TASK_FILES = [
  'task.md',
  'prompts/agent-test.md',
  'scripts/prepare-run.sh',
  'scripts/inspect-result.mjs',
];
const CAPABILITY_PROMPT = 'Generate an animated SVG of a pelican riding a bicycle.';
const CLARIFY_ANSWER =
  'Use the two file.write calls named in the confirmed requirement: file_path "result.html" with the HTML, then file_path "artifact.svg" with the SVG. Do not explore or run anything else.';

export async function runAitestScenario(binding) {
  const evidence = { screenshots: [] };
  const aitestRoot = process.env.E2E_AITEST_ROOT ?? '/Volumes/extension/code/AItest';
  const taskRoot = join(aitestRoot, TASK_REL);
  const runsMirror = binding.workspace;

  // 1. Locate and verify the AItest repo, target task and applicable checker.
  const verification = verifyAitestRepo({ taskRoot, files: REQUIRED_TASK_FILES });
  if (verification.missing.length) {
    throw new Error(`AItest task entry verification failed: missing ${verification.missing.join(', ')}`);
  }
  const taskMd = await readFile(join(taskRoot, 'task.md'), 'utf8');
  if (!taskMd.includes(CAPABILITY_PROMPT)) {
    throw new Error('AItest task.md does not declare the expected capability prompt');
  }

  // 2. One fresh run directory, created by the task's own script, which refuses
  // to overwrite anything that already exists. Snapshot the runs directory
  // before the script runs so "gained only its own run" is actually observable.
  const runsRoot = join(taskRoot, 'runs');
  const runsDirBefore = await listRunsDir(runsRoot);
  const runId = `DASH_E2E_${binding.attemptId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const prepare = execFileSync('bash', [join(taskRoot, 'scripts/prepare-run.sh'), runId], {
    cwd: dirname(taskRoot),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const prepareLines = prepare.split('\n').filter(Boolean);
  // prepare-run.sh prints, in order: run_dir, result_path, artifact_path.
  const runDir = prepareLines[0];
  if (!runDir || !/\/runs\//.test(runDir)) throw new Error(`prepare-run.sh returned no run directory: ${prepare}`);
  const resultPath = join(runDir, 'result.html');
  const artifactPath = join(runDir, 'artifact.svg');
  // The executor's prompt is the explicit-Brain `normalizedInput` (a rewritten
  // requirement), not the verbatim typed directive, so the contract must be
  // stated in the simplest possible terms and use the plain workspace-relative
  // names the task itself uses.
  const mirrorResultRel = 'result.html';
  const mirrorArtifactRel = 'artifact.svg';
  const mirrorResult = join(runsMirror, mirrorResultRel);
  const mirrorArtifact = join(runsMirror, mirrorArtifactRel);
  await mkdir(dirname(mirrorResult), { recursive: true });

  const directive = [
    `目标：Generate an animated SVG of a pelican riding a bicycle. Capability prompt, verbatim: "${CAPABILITY_PROMPT}"`,
    '交付物：result.html and artifact.svg in the workspace root.',
    '交付条件：',
    '- The deliverable is produced by exactly two file.write tool calls: first file_path "result.html" with the complete HTML document, then file_path "artifact.svg" with the animated SVG alone.',
    '- No other tool is part of the deliverable: do not call bash, file.list, file.read, file.search, file.edit, todo_write, present, web.search or a goal tool, and do not explore the filesystem.',
    '- result.html is a standalone HTML document that embeds the animated SVG inline, shaped <!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Pelican bicycle</title></head><body> with the <svg> inline, then </body></html>.',
    '- The SVG animates with SMIL repeatCount="indefinite" or CSS animation-iteration-count: infinite, with no external assets.',
    '证据：the two file.write tool results, each reporting the written relative path.',
    'After the second file.write returns, output your final answer text and stop; an external checker validates the files.',
  ].join('\n');

  await captureScreenshot(binding, '01-aitest-input');
  evidence.screenshots.push(`${binding.screenshotsDir}/01-aitest-input.png`);
  await submitDirectiveAndConfirmDraft(binding, directive, { clarificationAnswer: CLARIFY_ANSWER });
  await captureScreenshot(binding, '02-aitest-draft-confirmed');
  evidence.screenshots.push(`${binding.screenshotsDir}/02-aitest-draft-confirmed.png`);
  await captureScreenshot(binding, '03-aitest-run-queue');
  evidence.screenshots.push(`${binding.screenshotsDir}/03-aitest-run-queue.png`);

  const dashboard = await waitForTerminal(binding, { timeoutMs: 1_200_000 });
  const dashboardEvidence = await captureDashboardEvidence(binding);
  await captureScreenshot(binding, '04-aitest-task-result');
  evidence.screenshots.push(`${binding.screenshotsDir}/04-aitest-task-result.png`);

  // 3. Place the produced bytes into the AItest run directory, then run the
  // task's own checker.
  const placed = await placeResult({ mirrorResult, mirrorArtifact, resultPath, artifactPath });
  const checker = runChecker({ taskRoot, resultPath });
  const runsDirAfter = await listRunsDir(runsRoot);
  const newEntries = runsDirAfter.filter((entry) => !runsDirBefore.includes(entry));
  const removedEntries = runsDirBefore.filter((entry) => !runsDirAfter.includes(entry));
  const onlyOwnRun = newEntries.length === 1 && newEntries[0] === runId && removedEntries.length === 0;

  await journalPathFor(binding);
  const turnEvidence = await countTurnEvidenceFor(binding).catch(() => null);
  const events = turnEvidence?.allEvents ?? [];
  const tools = events.filter((event) => event.kind === 'provider.tool' || event.kind === 'provider.tool-result');
  const writeCalls = tools.filter(
    (event) => event.kind === 'provider.tool' && /file\.write/i.test(`${event.summary ?? ''} ${event.toolId ?? ''}`));

  const resultExists = await isNonEmptyFile(resultPath);
  const artifactExists = await isNonEmptyFile(artifactPath);

  const missing = [];
  if (dashboard.state !== 'succeeded') missing.push(`terminal state=${dashboard.state} (expected succeeded)`);
  if (!turnEvidence) missing.push('authoritative journal evidence could not be read');
  else if (turnEvidence.toolRounds < 1) missing.push(`journal toolRounds=${turnEvidence.toolRounds} (expected >= 1)`);
  if (writeCalls.length === 0) missing.push('no file.write tool call was recorded');
  if (!placed.result) missing.push(`result.html was not produced at the mirror path ${mirrorResult}`);
  if (!placed.artifact) missing.push(`artifact.svg was not produced at the mirror path ${mirrorArtifact}`);
  if (!resultExists) missing.push(`result.html missing or empty at ${resultPath}`);
  if (!artifactExists) missing.push(`artifact.svg missing or empty at ${artifactPath}`);
  if (checker.exitCode !== 0) missing.push(`checker exit=${checker.exitCode}: ${String(checker.stderr || checker.stdout).slice(0, 300)}`);
  // The task's own checker reports `empty` but exits 0 for an empty file, so
  // the acceptance criteria must be asserted field-by-field, not by exit code.
  if (checker.empty) missing.push('checker reports the result file is empty');
  if (!checker.animation.present) missing.push('checker reports no animation in the inline SVG');
  if (checker.inline_svg_count !== 1) missing.push(`checker reports inline_svg_count=${checker.inline_svg_count}`);
  if (!checker.has_html_root) missing.push('checker reports no <html> root');
  if (!onlyOwnRun) {
    missing.push(
      `AItest runs dir did not gain exactly its own run ${runId} (new: ${newEntries.join(', ') || '(none)'}; removed: ${removedEntries.join(', ') || '(none)'})`,
    );
  }

  evidence.scenarioEvidence = {
    aitestRoot,
    taskRoot,
    verification: {
      repoLocated: true,
      targetTask: TASK_REL,
      requiredFiles: REQUIRED_TASK_FILES,
      capabilityPrompt: CAPABILITY_PROMPT,
    },
    runId,
    runDir,
    resultPath,
    artifactPath,
    mirrorResult,
    mirrorArtifact,
    mirrorResultRel,
    mirrorArtifactRel,
    taskId: binding.taskId,
    terminalState: dashboard.state,
    executionEpoch: dashboard.executionEpoch ?? null,
    operationId: dashboard.operationId ?? null,
    checkpoint: dashboard.checkpoint ?? null,
    toolRounds: turnEvidence?.toolRounds ?? 0,
    requestStartTurns: turnEvidence?.requestStartTurns ?? 0,
    writeCalls: writeCalls.map(pickEvent),
    allProviderToolEvents: tools.map(pickEvent),
    resultExistsAndNonEmpty: resultExists,
    artifactExistsAndNonEmpty: artifactExists,
    runsDirBefore: runsDirBefore,
    runsDirAfter: runsDirAfter,
    runsDirNewEntries: newEntries,
    runsDirRemovedEntries: removedEntries,
    onlyOwnRunCreated: onlyOwnRun,
    checker: {
      checkerPath: checker.checkerPath,
      exitCode: checker.exitCode,
      stdout: checker.stdout.slice(0, 2000),
      stderr: checker.stderr,
      inline_svg_count: checker.inline_svg_count,
      has_html_root: checker.has_html_root,
      empty: checker.empty,
      animation: checker.animation,
    },
    outputPreview: String(dashboard.output ?? '').slice(0, 1800),
    dashboardProbe: dashboardEvidence.dashboardProbe,
    toolStepEvidence: dashboardEvidence.toolStepEvidence,
    executeNode: dashboardEvidence.executeNode,
    observation: dashboardEvidence.observation,
    taskDashboardDom: dashboardEvidence.taskDashboardDom,
    terminalSse: dashboardEvidence.sse,
    humanObservation:
      `result.html is a standalone document embedding one inline SVG; checker animation=${JSON.stringify(checker.animation)}.`,
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

function verifyAitestRepo({ taskRoot, files }) {
  const missing = [];
  for (const rel of files) {
    try {
      execFileSync('test', ['-f', join(taskRoot, rel)]);
    } catch {
      missing.push(rel);
    }
  }
  return { taskRoot, missing };
}

async function listRunsDir(runsRoot) {
  try {
    return (await readdir(runsRoot, { encoding: 'utf8' })).sort();
  } catch {
    return [];
  }
}

async function isNonEmptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function placeResult({ mirrorResult, mirrorArtifact, resultPath, artifactPath }) {
  const place = async (from, to) => {
    if (!await isNonEmptyFile(from)) return false;
    await mkdir(dirname(to), { recursive: true });
    cpSync(from, to);
    return true;
  };
  return {
    result: await place(mirrorResult, resultPath),
    artifact: await place(mirrorArtifact, artifactPath),
  };
}

function runChecker({ taskRoot, resultPath }) {
  const checkerPath = join(taskRoot, 'scripts/inspect-result.mjs');
  let stdout = '';
  let stderr = '';
  let exitCode = 1;
  try {
    stdout = execFileSync('node', [checkerPath, resultPath], { encoding: 'utf8' });
    exitCode = 0;
  } catch (error) {
    stdout = String(error.stdout ?? '');
    stderr = String(error.stderr ?? error.message);
    exitCode = typeof error.status === 'number' ? error.status : 1;
  }
  let parsed = {};
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = { _parseError: true, raw: stdout.slice(0, 800) };
  }
  return {
    checkerPath,
    exitCode,
    stdout,
    stderr,
    inline_svg_count: parsed.inline_svg_count ?? -1,
    has_html_root: parsed.has_html_root ?? false,
    empty: parsed.empty ?? true,
    animation: parsed.animation ?? {
      present: false,
      smil_elements: 0,
      css_keyframes: 0,
      css_animation_references: 0,
      loops_forever: false,
    },
  };
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

export { resolve };
