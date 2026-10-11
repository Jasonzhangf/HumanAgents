#!/usr/bin/env node
/**
 * AItest scenario contract tests.
 *
 * Deterministic contract tests over the PUBLIC helpers exported by
 * `scenarios/aitest.mjs`. They feed explicit temp-dir fixtures and synthetic
 * checker JSON and never start a service, browser, provider, port or the real
 * Dashboard. Fixtures live in the OS temp dir; nothing under the AItest repo is
 * written.
 *
 * They prove:
 *   - the five current task inputs are read with hashes and the prompt comes
 *     from prompts/original.txt (not a hardcoded constant);
 *   - the isolated copy is byte-identical with exclusive create and refuses a
 *     pre-existing output/collision;
 *   - the structural checker's exit code is never enough: an empty file and an
 *     external reference both exit 0 yet fail the field check;
 *   - a mismatched inline/standalone SVG, a missing/empty file, a non-JSON or
 *     nonzero checker, and a missing/mismatched visual observation all fail.
 *
 * These are NOT real AItest acceptance. A real SUCCESS still requires one real
 * Dashboard run, the real checker, a real browser open and a bound observation.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  CHECKER_REL,
  REQUIRED_TASK_READS,
  REQUIRED_WRITES,
  TASK_INPUT_FILES,
  artifactPageIssues,
  assessCheckerOutput,
  assessOutputFiles,
  assertFreshAttemptReceiptDir,
  buildDirective,
  createIsolatedTaskCopy,
  extractInlineSvg,
  isExternalArtifactRequest,
  preserveFullResponse,
  readExternalChecker,
  readTaskInputs,
  readVisualObservation,
  responseLooksLikeProse,
  runExternalChecker,
  validateTaskContract,
  validateVisualObservation,
} from './aitest.mjs';

const AITEST_ROOT = process.env.E2E_AITEST_ROOT ?? '/Volumes/extension/code/AItest';
const REAL_CHECKER = join(AITEST_ROOT, CHECKER_REL);
const realCheckerAvailable = existsSync(REAL_CHECKER);

const tempRoots = [];
async function makeTempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), `aitest-contract-${label}-`));
  tempRoots.push(root);
  return root;
}
test.after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {});
});

const PROMPT = '生成一只熊猫在马路上骑单车的 svg 动画，用 html 渲染出来';
const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10">'
  + '<animate attributeName="x" values="0;10;0" dur="1s" repeatCount="indefinite"/></rect></svg>';
const VALID_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>panda</title></head><body>${VALID_SVG}</body></html>`;
const GOOD_CHECKER = {
  empty: false,
  has_html_root: true,
  inline_svg_count: 1,
  animation: { present: true, smil_elements: 1, css_keyframes: 0, css_animation_references: 0, loops_forever: true },
  external_references: [],
};

const DEFAULT_TASK_FILES = {
  'AGENTS.md': '# 执行边界\n',
  'task.md': '# panda-bicycle\n\n## Delivery\n- Create `output/result.html` (standalone HTML).\n- Save `output/artifact.svg`.\n',
  'prompts/agent-test.md': '# panda-bicycle\n',
  'prompts/original.txt': `${PROMPT}\n`,
  'prompts/start-agent.md': '# 开始 panda-bicycle\n',
};

async function writeTaskFixture(root, overrides = {}) {
  const files = { ...DEFAULT_TASK_FILES, ...overrides };
  for (const [rel, body] of Object.entries(files)) {
    if (body === null || body === undefined) continue;
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
  }
}

const DISALLOWED_DIRECTIVE_READS = ['prompts/agent-test.md', 'prompts/start-agent.md'];

function directiveProblems(directive) {
  const text = String(directive ?? '');
  const problems = [];
  const readLine = text.split('\n').find((line) => line.includes('file.read')) ?? '';
  for (const rel of REQUIRED_TASK_READS) {
    if (!readLine.includes(rel)) problems.push(`missing required read ${rel}`);
  }
  for (const rel of DISALLOWED_DIRECTIVE_READS) {
    if (readLine.includes(rel)) problems.push(`requires repeated instruction read ${rel}`);
  }
  for (const rel of REQUIRED_WRITES) {
    if (!text.includes(rel)) problems.push(`missing required write ${rel}`);
  }
  if (!text.includes('320x220 viewBox')) problems.push('does not bound the SVG viewBox');
  if (!text.includes('简单、可辨认的基础图形')) problems.push('does not require simple recognizable primitives');
  if (!text.includes('两个车轮必须明显旋转')) problems.push('does not require two visibly rotating wheels');
  if (!text.includes('移动标记')) problems.push('does not require a moving road mark');
  if (!text.includes('不要添加装饰性细节')) problems.push('does not forbid decorative detail');
  if (!text.includes('不使用任何外部资源')) problems.push('does not forbid external assets');
  if (!text.includes('完全相同的动画 SVG')) problems.push('does not require identical animated HTML/SVG content');
  if (!text.includes('直接完成')) problems.push('does not require direct completion without exploration');
  if (!text.includes('不要先探索环境')) problems.push('does not forbid exploration before writing');
  if (!text.includes('不要运行 bash')) problems.push('does not forbid bash environment inspection');
  if (!text.includes('file.list')) problems.push('does not forbid file.list exploration');
  if (!text.includes('todo_write')) problems.push('does not forbid todo planning');
  if (!text.includes('不要尝试自行打开浏览器')) problems.push('does not keep the browser open with the harness');
  if (!text.includes('harness 在任务结束后打开 result.html')) {
    problems.push('does not state the harness owns the browser open');
  }
  if (!text.includes('agent 不执行 browser/checker')) problems.push('does not state the agent must not open/check');
  if (!text.includes('file.write 会自动创建 output/')) problems.push('does not state file.write creates output/');
  if (!text.includes('file_path')) problems.push('does not name the required file.write file_path argument');
  if (!text.includes('content')) problems.push('does not name the file.write content argument');
  if (!text.includes('两次 file.write 必须依次进行')) problems.push('does not require the two file.write calls to run sequentially');
  if (!text.includes('不要并行')) problems.push('does not forbid parallel file.write calls');
  if (/已成功|PASS|passed/i.test(text)) problems.push('claims success before external verification');
  return problems;
}

test('positive: directive requires one focused pass with three reads, compact animation and both writes', () => {
  const directive = buildDirective();
  assert.deepEqual(directiveProblems(directive), []);
  assert.match(directive, /file\.write/);
  assert.match(directive, /output\/result\.html/);
  assert.match(directive, /output\/artifact\.svg/);
});

test('negative: directive contract rejects environment probing, todo planning and false success', () => {
  const directive = buildDirective();
  assert.ok(directiveProblems(directive.replace('不要运行 bash，', '')).some((p) => /bash/.test(p)));
  assert.ok(directiveProblems(directive.replace('todo_write', '')).some((p) => /todo/.test(p)));
  assert.ok(directiveProblems(directive.replace('output/artifact.svg', '')).some((p) => /artifact\.svg/.test(p)));
  assert.ok(directiveProblems(`${directive}\n任务已成功完成`).some((p) => /success/.test(p)));
});

test('negative: directive rejects repeated instruction reads and missing compact animation bounds', () => {
  const directive = buildDirective();
  const extraRead = directive.replace(
    'AGENTS.md、task.md、prompts/original.txt；',
    'AGENTS.md、task.md、prompts/original.txt、prompts/agent-test.md；',
  );
  assert.ok(directiveProblems(extraRead).some((p) => /repeated instruction read/.test(p)));
  assert.ok(directiveProblems(directive.replace('320x220 viewBox', 'viewBox')).some((p) => /viewBox/.test(p)));
  assert.ok(directiveProblems(directive.replace('两个车轮必须明显旋转', '')).some((p) => /rotating wheels/.test(p)));
  assert.ok(directiveProblems(directive.replace('不要添加装饰性细节', '')).some((p) => /decorative detail/.test(p)));
});

test('negative: directive must name file.write file_path/content and require sequential writes', () => {
  const directive = buildDirective();
  // The real file.write schema requires file_path (not path); a renamed field must fail.
  assert.ok(directiveProblems(directive.replace(/file_path/g, 'path')).some((p) => /file_path argument/.test(p)));
  assert.ok(directiveProblems(directive.replace('两次 file.write 必须依次进行', '')).some((p) => /run sequentially/.test(p)));
  assert.ok(directiveProblems(directive.replace('不要并行', '')).some((p) => /forbid parallel/.test(p)));
});

test('positive: the five inputs are read with hashes and the prompt is dynamic', async () => {
  const root = await makeTempRoot('inputs');
  await writeTaskFixture(root);
  const inputs = await readTaskInputs(root);
  assert.deepEqual(Object.keys(inputs).sort(), [...TASK_INPUT_FILES].sort());
  for (const rel of TASK_INPUT_FILES) {
    assert.match(inputs[rel].sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(inputs[rel].size > 0, true);
  }
  const { prompt } = validateTaskContract(inputs);
  assert.equal(prompt, PROMPT);
  // The prompt is read, not a constant: a different original.txt yields it.
  await writeTaskFixture(root, { 'prompts/original.txt': 'draw a cat on a skateboard\n' });
  assert.equal(validateTaskContract(await readTaskInputs(root)).prompt, 'draw a cat on a skateboard');
});

test('positive: the isolated copy is byte-identical with no pre-existing output', async () => {
  const taskRoot = await makeTempRoot('src');
  await writeTaskFixture(taskRoot);
  const inputs = await readTaskInputs(taskRoot);
  const copyRoot = join(await makeTempRoot('copy'), 'workspace');
  await mkdir(copyRoot, { recursive: true });
  const copied = await createIsolatedTaskCopy({ copyRoot, files: inputs });
  for (const rel of TASK_INPUT_FILES) {
    assert.equal(copied[rel].sha256, inputs[rel].sha256);
    assert.equal(await readFile(join(copyRoot, rel), 'utf8'), inputs[rel].bytes.toString('utf8'));
  }
  assert.equal(existsSync(join(copyRoot, 'output')), false);
  // The original task tree is untouched.
  assert.equal(await readFile(join(taskRoot, 'task.md'), 'utf8'), DEFAULT_TASK_FILES['task.md']);
});

test('positive: matching HTML + artifact passes output assessment', async () => {
  const dir = await makeTempRoot('out-ok');
  await writeFile(join(dir, 'result.html'), VALID_HTML, 'utf8');
  await writeFile(join(dir, 'artifact.svg'), VALID_SVG, 'utf8');
  const { facts, problems } = await assessOutputFiles({
    resultPath: join(dir, 'result.html'),
    artifactPath: join(dir, 'artifact.svg'),
  });
  assert.deepEqual(problems, []);
  assert.equal(facts.inlineSvgMatchesArtifact, true);
  assert.match(facts.htmlSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(extractInlineSvg(VALID_HTML), VALID_SVG);
});

test('positive: a checker JSON with all required fields passes', () => {
  assert.deepEqual(assessCheckerOutput({ parsed: GOOD_CHECKER, exitCode: 0 }).problems, []);
});

test('positive: a fully bound visual observation is accepted', () => {
  const context = {
    candidateSha: 'a'.repeat(40),
    attemptId: 'aitest-1',
    taskId: 'task-1',
    htmlSha256: `sha256:${'1'.repeat(64)}`,
    svgSha256: `sha256:${'2'.repeat(64)}`,
    screenshotPaths: ['/r/shots/aitest-artifact-1.png', '/r/shots/aitest-artifact-2.png'],
  };
  const observation = {
    observer: 'Jason',
    observerType: 'human',
    observedAt: '2026-10-10T20:00:00Z',
    candidateSha: context.candidateSha,
    attemptId: context.attemptId,
    taskId: context.taskId,
    htmlSha256: context.htmlSha256,
    svgSha256: context.svgSha256,
    screenshots: [...context.screenshotPaths],
    panda: true,
    bicycle: true,
    road: true,
    animationVisible: true,
    renderingOk: true,
    uncertainty: 'none',
    conclusion: 'pass',
  };
  assert.deepEqual(validateVisualObservation(observation, context), { ok: true, reasons: [] });
});

test('negative: a missing input is refused with its exact path', async () => {
  const root = await makeTempRoot('missing');
  await writeTaskFixture(root, { 'task.md': null });
  await assert.rejects(() => readTaskInputs(root), (error) => {
    assert.match(error.message, /AItest task input unavailable/);
    assert.ok(error.message.includes(join(root, 'task.md')));
    return true;
  });
});

test('negative: an empty input and an empty prompt are refused', async () => {
  const root = await makeTempRoot('empty');
  await writeTaskFixture(root, { 'prompts/original.txt': '' });
  await assert.rejects(() => readTaskInputs(root), /AItest task input is empty/);
  await writeTaskFixture(root, { 'prompts/original.txt': '   \n' });
  const inputs = await readTaskInputs(root);
  assert.throws(() => validateTaskContract(inputs), /unknown\/unsupported/);
});

test('negative: a symlinked input is refused', async () => {
  const root = await makeTempRoot('symlink');
  await writeTaskFixture(root);
  await rm(join(root, 'AGENTS.md'));
  await symlink('/etc/hosts', join(root, 'AGENTS.md'));
  await assert.rejects(() => readTaskInputs(root), /symlink/);
});

test('negative: an unknown delivery layout is refused', async () => {
  const root = await makeTempRoot('layout');
  await writeTaskFixture(root, { 'task.md': '# a different task with no declared deliverables\n' });
  const inputs = await readTaskInputs(root);
  assert.throws(() => validateTaskContract(inputs), /unknown\/unsupported/);
});

test('negative: the isolated copy refuses a pre-existing output or collision', async () => {
  const taskRoot = await makeTempRoot('copy-src');
  await writeTaskFixture(taskRoot);
  const inputs = await readTaskInputs(taskRoot);
  const existingOutput = join(await makeTempRoot('copy-out'), 'workspace');
  await mkdir(join(existingOutput, 'output'), { recursive: true });
  await assert.rejects(() => createIsolatedTaskCopy({ copyRoot: existingOutput, files: inputs }), /already exists/);
  const collision = join(await makeTempRoot('copy-collision'), 'workspace');
  await mkdir(collision, { recursive: true });
  await writeFile(join(collision, 'task.md'), 'pre-existing', 'utf8');
  await assert.rejects(() => createIsolatedTaskCopy({ copyRoot: collision, files: inputs }), /collision/);
});

test('negative: a reused attempt receipt directory is refused', async () => {
  const fresh = await makeTempRoot('receipt-fresh');
  await assert.doesNotReject(() => assertFreshAttemptReceiptDir(fresh));
  const prepared = await makeTempRoot('receipt-prepared');
  await mkdir(join(prepared, 'shots'), { recursive: true });
  await assert.doesNotReject(() => assertFreshAttemptReceiptDir(prepared));
  const reused = await makeTempRoot('receipt-reused');
  await writeFile(join(reused, 'evidence.json'), '{}', 'utf8');
  await assert.rejects(() => assertFreshAttemptReceiptDir(reused), /reused attempt\/receiptDir/);
  const partialShots = await makeTempRoot('receipt-partial-shots');
  await mkdir(join(partialShots, 'shots'), { recursive: true });
  await writeFile(join(partialShots, 'shots', 'aitest-artifact-1.png'), 'png', 'utf8');
  await assert.rejects(() => assertFreshAttemptReceiptDir(partialShots), /already contains evidence/);
  const partialOutput = await makeTempRoot('receipt-partial-output');
  await mkdir(join(partialOutput, 'aitest-output'), { recursive: true });
  await assert.rejects(() => assertFreshAttemptReceiptDir(partialOutput), /already exists/);
});

test('negative: missing/empty output files and a mismatched SVG are refused', async () => {
  const dir = await makeTempRoot('out-bad');
  const missing = await assessOutputFiles({ resultPath: join(dir, 'result.html'), artifactPath: join(dir, 'artifact.svg') });
  assert.ok(missing.problems.some((entry) => /missing/.test(entry)));
  await writeFile(join(dir, 'result.html'), '', 'utf8');
  await writeFile(join(dir, 'artifact.svg'), VALID_SVG, 'utf8');
  const empty = await assessOutputFiles({ resultPath: join(dir, 'result.html'), artifactPath: join(dir, 'artifact.svg') });
  assert.ok(empty.problems.some((entry) => /empty/.test(entry)));
  await writeFile(join(dir, 'result.html'), VALID_HTML, 'utf8');
  await writeFile(join(dir, 'artifact.svg'), VALID_SVG.replace('repeatCount="indefinite"', ''), 'utf8');
  const mismatch = await assessOutputFiles({ resultPath: join(dir, 'result.html'), artifactPath: join(dir, 'artifact.svg') });
  assert.ok(mismatch.problems.some((entry) => /does not match/.test(entry)));
});

test('negative: the checker field check rejects empty, external, non-JSON and nonzero', () => {
  assert.ok(assessCheckerOutput({ parsed: { ...GOOD_CHECKER, empty: true }, exitCode: 0 }).problems.some((p) => /empty/.test(p)));
  assert.ok(assessCheckerOutput({
    parsed: { ...GOOD_CHECKER, external_references: ['https://cdn.example.com/x.png'] },
    exitCode: 0,
  }).problems.some((p) => /external/.test(p)));
  assert.ok(assessCheckerOutput({ parsed: { _parseError: true, raw: 'not json' }, exitCode: 0 }).problems.some((p) => /parseable JSON/.test(p)));
  assert.ok(assessCheckerOutput({ parsed: GOOD_CHECKER, exitCode: 1 }).problems.some((p) => /exited with code 1/.test(p)));
  assert.ok(assessCheckerOutput({ parsed: { ...GOOD_CHECKER, animation: { present: false } }, exitCode: 0 }).problems.some((p) => /no animation/.test(p)));
  assert.ok(assessCheckerOutput({ parsed: { ...GOOD_CHECKER, inline_svg_count: 2 }, exitCode: 0 }).problems.some((p) => /inline_svg_count/.test(p)));
});

test('negative: artifact page dependencies, failures and page errors are refused', () => {
  const main = 'file:///tmp/aitest/output/result.html';
  assert.equal(isExternalArtifactRequest(main, main), false);
  assert.equal(isExternalArtifactRequest('data:image/svg+xml;base64,AA', main), false);
  assert.equal(isExternalArtifactRequest('blob:file:///tmp/aitest/output/frame', main), false);
  assert.equal(isExternalArtifactRequest('about:blank', main), false);
  assert.equal(isExternalArtifactRequest('file:///tmp/aitest/output/artifact.svg', main), true);
  assert.equal(isExternalArtifactRequest('file:///etc/passwd', main), true);
  assert.equal(isExternalArtifactRequest('https://cdn.example.com/x.png', main), true);

  const good = {
    navigationError: null,
    externalRequests: [],
    requestFailures: [],
    consoleErrors: [],
    screenshots: ['/r/shots/aitest-artifact-1.png', '/r/shots/aitest-artifact-2.png'],
  };
  assert.deepEqual(artifactPageIssues(good), []);
  assert.ok(artifactPageIssues({ ...good, navigationError: 'net::ERR_FILE_NOT_FOUND' })
    .some((problem) => /navigation failed/.test(problem)));
  assert.ok(artifactPageIssues({ ...good, externalRequests: [{ url: 'https://cdn.example.com/x.png' }] })
    .some((problem) => /external resources/.test(problem)));
  assert.ok(artifactPageIssues({
    ...good,
    requestFailures: [{ url: 'file:///tmp/aitest/output/artifact.svg', error: 'net::ERR_FILE_NOT_FOUND' }],
  }).some((problem) => /failed resource requests/.test(problem)));
  assert.ok(artifactPageIssues({ ...good, consoleErrors: ['pageerror: broken render'] })
    .some((problem) => /page\/console errors/.test(problem)));
  assert.ok(artifactPageIssues({ ...good, screenshots: ['/r/shots/aitest-artifact-1.png'] })
    .some((problem) => /fewer than two/.test(problem)));
  assert.ok(artifactPageIssues({ error: 'browser launch failed' }).some((problem) => /could not be opened/.test(problem)));
});

test('negative: a missing/mismatched/failed visual observation is refused', () => {
  const context = {
    candidateSha: 'a'.repeat(40),
    attemptId: 'aitest-1',
    taskId: 'task-1',
    htmlSha256: `sha256:${'1'.repeat(64)}`,
    svgSha256: `sha256:${'2'.repeat(64)}`,
    screenshotPaths: ['/r/shots/aitest-artifact-1.png', '/r/shots/aitest-artifact-2.png'],
  };
  const base = {
    observer: 'Jason',
    observerType: 'human',
    observedAt: '2026-10-10T20:00:00Z',
    candidateSha: context.candidateSha,
    attemptId: context.attemptId,
    taskId: context.taskId,
    htmlSha256: context.htmlSha256,
    svgSha256: context.svgSha256,
    screenshots: [...context.screenshotPaths],
    panda: true,
    bicycle: true,
    road: true,
    animationVisible: true,
    renderingOk: true,
    uncertainty: 'none',
    conclusion: 'pass',
  };
  assert.equal(validateVisualObservation(null, context).ok, false);
  assert.equal(validateVisualObservation({ ...base, htmlSha256: `sha256:${'9'.repeat(64)}` }, context).ok, false);
  assert.equal(validateVisualObservation({ ...base, candidateSha: 'b'.repeat(40) }, context).ok, false);
  assert.equal(validateVisualObservation({ ...base, screenshots: [context.screenshotPaths[0]] }, context).ok, false);
  assert.equal(validateVisualObservation({ ...base, road: false }, context).ok, false);
  assert.equal(validateVisualObservation({ ...base, uncertainty: 'not sure about the bicycle' }, context).ok, false);
  assert.equal(validateVisualObservation({ ...base, conclusion: 'fail' }, context).ok, false);
  assert.equal(validateVisualObservation({ ...base, observerType: 'robot' }, context).ok, false);
});

test('positive: the full response is preserved only when it carries prose/fences', async () => {
  assert.equal(responseLooksLikeProse(VALID_HTML), false);
  assert.equal(responseLooksLikeProse('Here is the SVG:\n```svg\n<svg/>\n```'), true);
  const copyRoot = await makeTempRoot('source');
  await mkdir(copyRoot, { recursive: true });
  const rawHtml = await preserveFullResponse({ copyRoot, fullResponse: VALID_HTML });
  assert.equal(rawHtml.present, false);
  const prose = await preserveFullResponse({ copyRoot, fullResponse: 'Done.\n```\n<svg/>\n```\n' });
  assert.equal(prose.present, true);
  assert.equal(prose.writtenByHarness, true);
  assert.equal(await readFile(prose.path, 'utf8'), 'Done.\n```\n<svg/>\n```\n');
  // An agent-written source.txt is preserved, not overwritten.
  const copyRoot2 = await makeTempRoot('source2');
  await mkdir(join(copyRoot2, 'output'), { recursive: true });
  await writeFile(join(copyRoot2, 'output', 'source.txt'), 'agent wrote this', 'utf8');
  const kept = await preserveFullResponse({ copyRoot: copyRoot2, fullResponse: 'harness response' });
  assert.equal(kept.writtenByHarness, false);
  assert.equal(await readFile(kept.path, 'utf8'), 'agent wrote this');
});

test('positive: an injected observation is returned unchanged', async () => {
  const injected = { observer: 'x', conclusion: 'pass' };
  assert.equal(await readVisualObservation({ injected }), injected);
});

test('negative: a missing external checker is refused with its path', async () => {
  const missing = join(await makeTempRoot('checker'), 'nope', 'inspect-result.mjs');
  await assert.rejects(() => readExternalChecker(missing), /external checker unavailable/);
});

test('real checker: exit 0 for empty HTML does not pass the field check', { skip: !realCheckerAvailable }, async () => {
  const dir = await makeTempRoot('checker-empty');
  const resultPath = join(dir, 'result.html');
  await writeFile(resultPath, '', 'utf8');
  const run = await runExternalChecker({ checkerPath: REAL_CHECKER, resultPath });
  assert.equal(run.exitCode, 0);
  assert.equal(run.parsed.empty, true);
  assert.ok(assessCheckerOutput(run).problems.some((p) => /empty/.test(p)));
});

test('real checker: exit 0 with external references does not pass the field check', { skip: !realCheckerAvailable }, async () => {
  const dir = await makeTempRoot('checker-external');
  const resultPath = join(dir, 'result.html');
  await writeFile(resultPath, VALID_HTML.replace('<body>', '<body><img src="https://cdn.example.com/x.png">'), 'utf8');
  const run = await runExternalChecker({ checkerPath: REAL_CHECKER, resultPath });
  assert.equal(run.exitCode, 0);
  assert.ok(run.parsed.external_references.length >= 1);
  assert.ok(assessCheckerOutput(run).problems.some((p) => /external/.test(p)));
});

test('real checker: a static SVG exits nonzero and a good HTML passes', { skip: !realCheckerAvailable }, async () => {
  const dir = await makeTempRoot('checker-static');
  const resultPath = join(dir, 'result.html');
  const staticHtml = '<!DOCTYPE html><html lang="en"><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg></body></html>';
  await writeFile(resultPath, staticHtml, 'utf8');
  const staticRun = await runExternalChecker({ checkerPath: REAL_CHECKER, resultPath });
  assert.equal(staticRun.exitCode, 1);
  assert.ok(assessCheckerOutput(staticRun).problems.length >= 1);
  await writeFile(resultPath, VALID_HTML, 'utf8');
  const goodRun = await runExternalChecker({ checkerPath: REAL_CHECKER, resultPath });
  assert.equal(goodRun.exitCode, 0);
  assert.deepEqual(assessCheckerOutput(goodRun).problems, []);
});
