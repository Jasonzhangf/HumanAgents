/**
 * AItest scenario — real implementation.
 *
 * Owns graph nodes: aitest_entry, aitest_capability, aitest_checker
 * (in docs/dagpipe/dashboard-e2e-aitest.graph.json).
 *
 * Runs the CURRENT read-only AItest task (`tasks/panda-bicycle`) through the
 * served Dashboard. Each attempt:
 *   1. reads the five current task inputs and the external checker from the
 *      AItest repo (harness side, read only) and hashes them;
 *   2. creates an attempt-scoped independent COPY of those five inputs inside
 *      this attempt's bound `workspace` (exclusive create, byte-for-byte), whose
 *      `output/` must not already exist;
 *   3. drives the real browser input -> visible draft -> confirmation -> run
 *      queue -> execution turns -> verifiable terminal;
 *   4. validates the produced `output/result.html` and `output/artifact.svg`,
 *      runs the external checker with argv (no shell), opens the produced HTML
 *      in the same real browser context and captures two animation frames;
 *   5. records a separately supplied structured visual observation and stages
 *      the artifacts into the canonical `receiptDir/aitest-output/`.
 *
 * The AItest repo is never written: the task prompts are read, the original
 * `output/` is only observed, and the produced bytes live in this attempt's
 * workspace copy and then in the persistent receipt directory. The structural
 * checker does not prove that the picture is a panda on a bicycle on a road, so
 * the attempt is only complete with a bound visual observation, and it never
 * rewrites a real Dashboard terminal.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  captureDashboardEvidence,
  captureScreenshot,
  submitDirectiveAndConfirmDraft,
  waitForTerminal,
} from '../lib/browser.mjs';
import { countTurnEvidenceFor, journalPathFor } from '../lib/journal.mjs';

export const SCENARIO = 'aitest';

/** The one current AItest task this scenario runs. No discovery, no fallback. */
export const TASK_REL = 'tasks/panda-bicycle';
/** The external evaluation checker (a sibling of the task dir, not a task script). */
export const CHECKER_REL = 'evaluation/panda-bicycle/inspect-result.mjs';
/** The five read-only task inputs this attempt copies and hashes as evidence. */
export const TASK_INPUT_FILES = Object.freeze([
  'AGENTS.md',
  'task.md',
  'prompts/agent-test.md',
  'prompts/original.txt',
  'prompts/start-agent.md',
]);
/** The local task inputs the task itself asks the agent to read. */
export const REQUIRED_TASK_READS = Object.freeze(['AGENTS.md', 'task.md', 'prompts/original.txt']);
/** The relative deliverable paths task.md declares. */
export const REQUIRED_WRITES = Object.freeze(['output/result.html', 'output/artifact.svg']);
/** The canonical workspace copy paths the attempt produces and stages. */
const COPY_RESULT_REL = 'output/result.html';
const COPY_ARTIFACT_REL = 'output/artifact.svg';
const COPY_SOURCE_REL = 'output/source.txt';

const CHECKER_TIMEOUT_MS = Number(process.env.E2E_AITEST_CHECKER_TIMEOUT_MS ?? 60_000);
const OBSERVATION_TIMEOUT_MS = Number(process.env.E2E_AITEST_OBSERVATION_TIMEOUT_MS ?? 600_000);

const CLARIFY_ANSWER = [
  '不要反问。请在本工作目录内直接完成任务：',
  '用 file.read 读取 AGENTS.md、task.md、prompts/original.txt，',
  '不要读取重复说明副本 prompts/agent-test.md、prompts/start-agent.md。',
  '然后用 file.write 依次写 output/result.html（独立 HTML，内联 320x220 viewBox 的动画 SVG）',
  '再写 output/artifact.svg（与内联 SVG 完全相同的动画 SVG）；两次 file.write 的参数名固定为 file_path 与 content，不要并行。',
  '不要运行 bash、file.list、todo_write 或浏览器；写完输出简短最终回答并停止。',
].join(' ');

/** The directive typed into the real Dashboard input (does not restate the prompt). */
export function buildDirective() {
  return [
    '请在本工作目录内直接完成，不要先探索环境、检查工具或制定待办计划。',
    '先依次用 file.read 读取本地文件：AGENTS.md、task.md、prompts/original.txt；',
    '不要读取重复说明副本 prompts/agent-test.md、prompts/start-agent.md。',
    '然后严格按 task.md 的交付要求执行（任务内容就在 prompts/original.txt 中）。',
    '不要运行 bash，不要调用 file.list 或 todo_write，不要检查 python3/open/uname 等环境，也不要尝试自行打开浏览器；',
    'harness 在任务结束后打开 result.html 并运行外部 checker；agent 不执行 browser/checker。',
    '交付要求：',
    '- file.write 的参数名固定为 file_path（目标路径）与 content（文件内容）；不要用 path 或其它名字。',
    '- 用 file.write 写 output/result.html：file_path 为 "output/result.html"，content 为一个 320x220 viewBox 的独立 HTML，内联动画 SVG；只使用简单、可辨认的基础图形表现熊猫、单车和道路；两个车轮必须明显旋转，道路上至少有一个移动标记；不要添加装饰性细节，不使用任何外部资源（无外链、无远程字体/图片/脚本）。',
    '- 用 file.write 写 output/artifact.svg：file_path 用该路径，content 为与 result.html 内联 SVG 完全相同的动画 SVG。',
    '- 两次 file.write 必须依次进行：先写 result.html，再写 artifact.svg，不要并行调用。',
    '- 如最终回答包含说明文字或 Markdown 代码块，用 file.write 把完整回答保存为 output/source.txt。',
    '- file.write 会自动创建 output/ 目录，不需要先执行 mkdir。',
    '- 只读取本工作目录内的三个指定文件，不读取父目录、绝对路径或其他文件，不修改任务文件。',
    '完成两个核心交付的 file.write 后，输出简短状态：两个输出路径，以及未完成项或不确定性；不要添加长篇说明。',
  ].join('\n');
}

/** sha256:<64 lowercase hex> of raw bytes. */
export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function pathExists(path) {
  return (await lstatOrNull(path)) !== null;
}

function manifestOf(entries) {
  const manifest = {};
  for (const [rel, entry] of Object.entries(entries)) manifest[rel] = entry.sha256;
  return manifest;
}

function manifestsEqual(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    if (left[leftKeys[index]] !== right[rightKeys[index]]) return false;
  }
  return true;
}

/**
 * Read the five current task inputs, each attempt, with strict layout rules:
 * every input must be a real, non-empty, non-symlink regular file. A missing,
 * empty, symlinked or non-regular input is refused with its exact path/errno.
 */
export async function readTaskInputs(taskRoot) {
  const files = {};
  for (const rel of TASK_INPUT_FILES) {
    const path = join(taskRoot, rel);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      throw new Error(`AItest task input unavailable: ${path} (${error.code ?? error.message})`);
    }
    if (info.isSymbolicLink()) {
      throw new Error(`AItest task input is a symlink and is refused: ${path}`);
    }
    if (!info.isFile()) {
      throw new Error(`AItest task input is not a regular file: ${path}`);
    }
    const bytes = await readFile(path);
    if (bytes.byteLength === 0) {
      throw new Error(`AItest task input is empty: ${path}`);
    }
    files[rel] = { rel, path, bytes, sha256: sha256Bytes(bytes), size: bytes.byteLength };
  }
  return files;
}

/**
 * Accept only the current panda task contract: a non-empty prompt and the exact
 * relative deliverables task.md declares. A task that declares a different or
 * conflicting delivery layout is refused, never silently executed.
 */
export function validateTaskContract(files) {
  const taskMd = files['task.md'].bytes.toString('utf8');
  const prompt = files['prompts/original.txt'].bytes.toString('utf8').trim();
  const missing = [];
  for (const rel of REQUIRED_WRITES) {
    if (!taskMd.includes(rel)) missing.push(rel);
  }
  if (prompt.length === 0) missing.push('a non-empty prompts/original.txt prompt');
  if (missing.length > 0) {
    throw new Error(`AItest task contract is unknown/unsupported: task.md does not declare ${missing.join(', ')}`);
  }
  return { prompt };
}

/** Load and hash the external checker (read only; never run by the agent). */
export async function readExternalChecker(checkerPath) {
  let info;
  try {
    info = await lstat(checkerPath);
  } catch (error) {
    throw new Error(`AItest external checker unavailable: ${checkerPath} (${error.code ?? error.message})`);
  }
  if (info.isSymbolicLink()) throw new Error(`AItest external checker is a symlink and is refused: ${checkerPath}`);
  if (!info.isFile()) throw new Error(`AItest external checker is not a regular file: ${checkerPath}`);
  const bytes = await readFile(checkerPath);
  return { path: checkerPath, bytes, sha256: sha256Bytes(bytes), size: bytes.byteLength };
}

/**
 * Create the attempt-scoped independent copy of the five inputs inside this
 * attempt's bound workspace. Bytes are copied unchanged with exclusive create,
 * the copy is hash-verified, and the copy's `output/` must not already exist.
 */
export async function createIsolatedTaskCopy({ copyRoot, files }) {
  const outputDir = join(copyRoot, 'output');
  if (await pathExists(outputDir)) {
    throw new Error(`AItest isolated task copy refused: an output directory already exists at ${outputDir}`);
  }
  const copied = {};
  for (const rel of TASK_INPUT_FILES) {
    const dest = join(copyRoot, rel);
    if (await pathExists(dest)) {
      throw new Error(`AItest isolated task copy collision: ${dest} already exists`);
    }
    await mkdir(dirname(dest), { recursive: true });
    // Exclusive create ('wx'): never overwrite a pre-existing file.
    await writeFile(dest, files[rel].bytes, { flag: 'wx' });
    const written = await readFile(dest);
    const sha256 = sha256Bytes(written);
    if (sha256 !== files[rel].sha256) {
      throw new Error(`AItest isolated task copy hash mismatch for ${dest}`);
    }
    copied[rel] = { rel, path: dest, sha256, size: written.byteLength };
  }
  return copied;
}

/** Extract the first inline `<svg>...</svg>` block from an HTML document. */
export function extractInlineSvg(html) {
  const match = html.match(/<svg\b[\s\S]*?<\/svg>/i);
  return match ? match[0] : null;
}

/**
 * Validate the produced output files: both are regular non-empty files and the
 * inline SVG in result.html matches the standalone artifact.svg. Nothing is
 * written, renamed or repaired here.
 */
export async function assessOutputFiles({ resultPath, artifactPath }) {
  const problems = [];
  const facts = {
    resultPath,
    artifactPath,
    resultExists: false,
    resultNonEmpty: false,
    artifactExists: false,
    artifactNonEmpty: false,
    inlineSvgMatchesArtifact: false,
    hasInlineSvg: false,
    htmlSha256: null,
    svgSha256: null,
  };
  const resultInfo = await lstatOrNull(resultPath);
  const artifactInfo = await lstatOrNull(artifactPath);
  facts.resultExists = Boolean(resultInfo?.isFile());
  facts.resultNonEmpty = facts.resultExists && resultInfo.size > 0;
  facts.artifactExists = Boolean(artifactInfo?.isFile());
  facts.artifactNonEmpty = facts.artifactExists && artifactInfo.size > 0;
  if (!facts.resultExists) problems.push(`output/result.html is missing or not a regular file at ${resultPath}`);
  else if (!facts.resultNonEmpty) problems.push(`output/result.html is empty at ${resultPath}`);
  if (!facts.artifactExists) problems.push(`output/artifact.svg is missing or not a regular file at ${artifactPath}`);
  else if (!facts.artifactNonEmpty) problems.push(`output/artifact.svg is empty at ${artifactPath}`);
  if (facts.resultNonEmpty && facts.artifactNonEmpty) {
    const htmlBytes = await readFile(resultPath);
    const svgBytes = await readFile(artifactPath);
    const html = htmlBytes.toString('utf8');
    const svg = svgBytes.toString('utf8');
    facts.htmlSha256 = sha256Bytes(htmlBytes);
    facts.svgSha256 = sha256Bytes(svgBytes);
    const inline = extractInlineSvg(html);
    facts.hasInlineSvg = inline !== null;
    facts.inlineSvgMatchesArtifact = inline !== null && inline.trim() === svg.trim();
    if (!facts.hasInlineSvg) problems.push('output/result.html has no inline <svg> to match output/artifact.svg');
    else if (!facts.inlineSvgMatchesArtifact) {
      problems.push('the inline SVG in output/result.html does not match output/artifact.svg');
    }
  }
  return { facts, problems };
}

/**
 * Run only the named external checker with argv (no interpolated shell). The
 * raw stdout/stderr, exit code and parsed JSON are preserved as evidence.
 */
export function runExternalChecker({ checkerPath, resultPath, timeoutMs = CHECKER_TIMEOUT_MS }) {
  return new Promise((settle) => {
    execFile('node', [checkerPath, resultPath], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        const rawStdout = String(stdout ?? '');
        let parsed;
        try {
          parsed = JSON.parse(rawStdout);
        } catch {
          parsed = { _parseError: true, raw: rawStdout.slice(0, 800) };
        }
        settle({
          checkerPath,
          exitCode,
          stdout: rawStdout,
          stderr: String(stderr ?? ''),
          timedOut: Boolean(error?.killed),
          parsed,
        });
      });
  });
}

/**
 * Assert the checker's structured fields directly. The checker exits 0 for an
 * empty file and reports (but does not gate on) external references, so exit
 * code alone never proves a deliverable; each required field is checked.
 */
export function assessCheckerOutput({ parsed, exitCode, timedOut = false }) {
  const problems = [];
  if (timedOut) problems.push('the external checker timed out');
  if (exitCode !== 0) problems.push(`the external checker exited with code ${exitCode}`);
  if (!parsed || typeof parsed !== 'object' || parsed._parseError === true) {
    problems.push('the external checker did not emit parseable JSON');
    return { problems };
  }
  if (parsed.empty !== false) problems.push('the external checker reports result.html is empty');
  if (parsed.has_html_root !== true) problems.push('the external checker reports no <html> root');
  if (parsed.inline_svg_count !== 1) problems.push(`the external checker reports inline_svg_count=${parsed.inline_svg_count}`);
  if (!parsed.animation || parsed.animation.present !== true) problems.push('the external checker reports no animation');
  if (!Array.isArray(parsed.external_references) || parsed.external_references.length !== 0) {
    problems.push(`the external checker reports external references: ${JSON.stringify(parsed.external_references)}`);
  }
  return { problems };
}

/** Does the full final response carry prose or Markdown fences (not raw HTML)? */
export function responseLooksLikeProse(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('```')) return true;
  return !/^<!DOCTYPE\s+html/i.test(trimmed) && !/^<html[\s>]/i.test(trimmed);
}

/**
 * Preserve the complete model final response when it carries prose or fences.
 * The agent may have written output/source.txt itself; when it has not, the
 * harness records the full response (never the truncated preview) and marks
 * itself as the owner. HTML/SVG are never synthesized here.
 */
export async function preserveFullResponse({ copyRoot, fullResponse }) {
  const sourcePath = join(copyRoot, COPY_SOURCE_REL);
  const existing = await lstatOrNull(sourcePath);
  if (existing?.isFile() && existing.size > 0) {
    return { path: sourcePath, present: true, writtenByHarness: false, sha256: await sha256File(sourcePath) };
  }
  if (!responseLooksLikeProse(fullResponse)) {
    return { path: null, present: false, writtenByHarness: false, sha256: null };
  }
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, fullResponse, 'utf8');
  return { path: sourcePath, present: true, writtenByHarness: true, sha256: await sha256File(sourcePath) };
}

/**
 * Open the produced result.html in the same real browser context on a separate
 * artifact page, record navigation/errors/local network requests, and capture
 * at least two frames at different animation times. The page is always closed.
 */
export async function captureArtifactEvidence(binding, { resultPath }) {
  const context = binding.browser?.context;
  if (!context) throw new Error('captureArtifactEvidence requires a live browser context');
  const page = await context.newPage();
  const fileUrl = pathToFileURL(resultPath).href;
  const requests = [];
  const externalRequests = [];
  const requestFailures = [];
  const consoleErrors = [];
  page.on('request', (request) => {
    const url = request.url();
    requests.push({ url, resourceType: request.resourceType() });
    if (isExternalArtifactRequest(url, fileUrl)) {
      externalRequests.push({ url, resourceType: request.resourceType() });
    }
  });
  page.on('requestfailed', (request) => {
    requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? null });
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
  const screenshots = [];
  let navigation = null;
  let navigationError = null;
  try {
    const response = await page.goto(fileUrl, { waitUntil: 'load' });
    navigation = { url: page.url(), status: response ? response.status() : null, ok: response ? response.ok() : null };
    await mkdir(binding.screenshotsDir, { recursive: true });
    const frames = [
      { name: 'aitest-artifact-1', delayMs: 500 },
      { name: 'aitest-artifact-2', delayMs: 1500 },
    ];
    for (const frame of frames) {
      await page.waitForTimeout(frame.delayMs);
      const path = join(binding.screenshotsDir, `${frame.name}.png`);
      await page.screenshot({ path, fullPage: true });
      screenshots.push(path);
    }
  } catch (error) {
    navigationError = error.message;
  } finally {
    await page.close().catch(() => {});
  }
  return { fileUrl, navigation, navigationError, requests, externalRequests, requestFailures, consoleErrors, screenshots };
}

/**
 * A standalone artifact page may request only its own main document, plus
 * inert inline/data/about schemes. A relative file asset or any absolute
 * file:// dependency is still a resource dependency and must fail the guard.
 */
export function isExternalArtifactRequest(url, mainFileUrl) {
  if (url === mainFileUrl) return false;
  return !/^(data|blob|about):/i.test(String(url));
}

/** Turn recorded artifact-page facts into the exact acceptance problems. */
export function artifactPageIssues(artifact = {}) {
  if (artifact.error) {
    return [`the produced HTML could not be opened in a real browser: ${artifact.error}`];
  }
  const problems = [];
  if (artifact.navigationError) {
    problems.push(`the produced HTML navigation failed: ${artifact.navigationError}`);
  }
  const externalRequests = artifact.externalRequests ?? [];
  if (externalRequests.length > 0) {
    problems.push(`the produced HTML requested external resources: ${externalRequests.map((entry) => entry.url).join(', ')}`);
  }
  const requestFailures = artifact.requestFailures ?? [];
  if (requestFailures.length > 0) {
    problems.push(
      `the produced HTML had failed resource requests: ${requestFailures
        .map((entry) => `${entry.url} (${entry.error ?? 'unknown'})`)
        .join(', ')}`,
    );
  }
  const consoleErrors = artifact.consoleErrors ?? [];
  if (consoleErrors.length > 0) {
    problems.push(`the produced HTML reported page/console errors: ${consoleErrors.join(' | ')}`);
  }
  if ((artifact.screenshots ?? []).length < 2) {
    problems.push('fewer than two artifact frames were captured');
  }
  return problems;
}

/**
 * Validate a separately supplied structured visual observation. It must be
 * bound to the observer identity/time, the bound candidate, this attempt/task,
 * the produced HTML/SVG hashes and the captured screenshot paths, and it must
 * affirm the semantics (panda on a bicycle on a road) with no open uncertainty.
 */
export function validateVisualObservation(observation, context) {
  if (!observation || typeof observation !== 'object') {
    return { ok: false, reasons: ['no structured visual observation was supplied'] };
  }
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const reasons = [];
  if (text(observation.observer) === '') reasons.push('observation.observer is missing');
  if (!['human', 'visual-agent'].includes(observation.observerType)) {
    reasons.push('observation.observerType must be "human" or "visual-agent"');
  }
  if (!Number.isFinite(Date.parse(text(observation.observedAt)))) {
    reasons.push('observation.observedAt is missing or not a parseable time');
  }
  if (text(observation.candidateSha) !== context.candidateSha) {
    reasons.push('observation.candidateSha does not match the bound candidate');
  }
  if (text(observation.attemptId) !== context.attemptId) {
    reasons.push('observation.attemptId does not match this attempt');
  }
  if (context.taskId !== null && context.taskId !== undefined && text(observation.taskId) !== String(context.taskId)) {
    reasons.push('observation.taskId does not match this attempt');
  }
  if (context.htmlSha256 && text(observation.htmlSha256) !== context.htmlSha256) {
    reasons.push('observation.htmlSha256 does not match the produced result.html');
  }
  if (context.svgSha256 && text(observation.svgSha256) !== context.svgSha256) {
    reasons.push('observation.svgSha256 does not match the produced artifact.svg');
  }
  const shots = Array.isArray(observation.screenshots) ? observation.screenshots.map((entry) => String(entry)) : [];
  for (const required of context.screenshotPaths ?? []) {
    if (!shots.includes(required)) reasons.push(`observation.screenshots is missing ${required}`);
  }
  if (shots.length < 2) reasons.push('observation.screenshots must reference at least two captured frames');
  for (const key of ['panda', 'bicycle', 'road', 'animationVisible', 'renderingOk']) {
    if (observation[key] !== true) reasons.push(`observation.${key} is not true`);
  }
  const uncertainty = text(observation.uncertainty).toLowerCase();
  if (uncertainty !== '' && !['none', '无', 'n/a', 'nil', 'null'].includes(uncertainty)) {
    reasons.push(`observation.uncertainty is unresolved: ${observation.uncertainty}`);
  }
  if (observation.conclusion !== 'pass') {
    reasons.push(`observation.conclusion=${JSON.stringify(observation.conclusion)} (expected "pass")`);
  }
  return { ok: reasons.length === 0, reasons };
}

function readStdinJson(timeoutMs) {
  return new Promise((settle, fail) => {
    let data = '';
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.pause();
      fn(arg);
    };
    const onData = (chunk) => { data += chunk.toString(); };
    const onEnd = () => {
      try {
        finish(settle, JSON.parse(data));
      } catch (error) {
        finish(fail, new Error(`the visual observation on stdin was not valid JSON: ${error.message}`));
      }
    };
    const timer = setTimeout(
      () => finish(fail, new Error('timed out waiting for the structured visual observation on stdin')),
      timeoutMs,
    );
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

/**
 * Obtain the structured visual observation for this attempt. Order: an injected
 * value (contract tests), an explicit file (`E2E_AITEST_OBSERVATION_FILE`), then
 * this attempt's terminal stdin within a bounded timeout. Nothing is defaulted
 * to a pass.
 */
export async function readVisualObservation({ injected = null, timeoutMs = OBSERVATION_TIMEOUT_MS } = {}) {
  if (injected && typeof injected === 'object') return injected;
  const file = process.env.E2E_AITEST_OBSERVATION_FILE;
  if (file) {
    const text = await readFile(file, 'utf8');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`E2E_AITEST_OBSERVATION_FILE ${file} was not valid JSON: ${error.message}`);
    }
  }
  if (process.stdin.isTTY) {
    process.stderr.write(
      '\n[aitest] Paste the structured visual observation JSON for this attempt, then press Ctrl-D:\n',
    );
  }
  return readStdinJson(timeoutMs);
}

/** Collect observed read/write paths that do not stay inside the copy root. */
function checkPathsLocalOnly(paths, copyRoot) {
  const bad = [];
  for (const value of paths) {
    if (typeof value !== 'string') continue;
    const normalized = value.replace(/^\.\//, '');
    if (normalized.startsWith('/') || normalized.includes('..') || normalized.startsWith('~')) {
      bad.push(value);
      continue;
    }
    const resolved = join(copyRoot, normalized);
    if (!resolved.startsWith(`${copyRoot}/`)) bad.push(value);
  }
  return bad;
}

/**
 * Refuse to reuse an attempt receipt directory that already carries evidence.
 * `prepareAttemptRoots()` creates an empty `shots/` directory before the
 * scenario runs, so that one empty directory is the only allowed pre-existing
 * entry. A prior partial attempt's screenshots or staged artifacts therefore
 * fail closed instead of being mixed with this attempt.
 */
export async function assertFreshAttemptReceiptDir(receiptDir) {
  if (!receiptDir) return;
  const entries = await readdir(receiptDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(receiptDir, entry.name);
    if (entry.isDirectory() && entry.name === 'shots') {
      const shots = await readdir(path, { withFileTypes: true }).catch(() => []);
      if (shots.length === 0) continue;
      throw new Error(`AItest attempt refused: ${path} already contains evidence (reused attempt/receiptDir)`);
    }
    throw new Error(`AItest attempt refused: ${path} already exists (reused attempt/receiptDir)`);
  }
}

export async function runAitestScenario(binding) {
  const evidence = { screenshots: [] };
  const aitestRoot = process.env.E2E_AITEST_ROOT ?? '/Volumes/extension/code/AItest';
  const taskRoot = join(aitestRoot, TASK_REL);
  const checkerPath = join(aitestRoot, CHECKER_REL);
  const copyRoot = binding.workspace;
  const runId = `DASH_E2E_${String(binding.attemptId).replace(/[^A-Za-z0-9._-]/g, '_')}`;

  // Refuse a reused attempt/receiptDir before touching anything.
  await assertFreshAttemptReceiptDir(binding.receiptDir);

  // 1. Read + hash the five current inputs and the external checker; observe the
  // original output. Nothing under the AItest repo is written.
  const inputs = await readTaskInputs(taskRoot);
  const { prompt } = validateTaskContract(inputs);
  const checker = await readExternalChecker(checkerPath);
  const inputManifestBefore = manifestOf(inputs);
  const originalOutputPath = join(taskRoot, 'output');
  const originalOutputBefore = await lstatOrNull(originalOutputPath);

  // 2. Attempt-scoped independent copy (exclusive create, hash equality, no
  // pre-existing output), then the real Dashboard run.
  const copied = await createIsolatedTaskCopy({ copyRoot, files: inputs });
  const resultPath = join(copyRoot, COPY_RESULT_REL);
  const artifactPath = join(copyRoot, COPY_ARTIFACT_REL);

  const directive = buildDirective();
  await captureScreenshot(binding, '01-aitest-input');
  evidence.screenshots.push(join(binding.screenshotsDir, '01-aitest-input.png'));
  await submitDirectiveAndConfirmDraft(binding, directive, { clarificationAnswer: CLARIFY_ANSWER });
  await captureScreenshot(binding, '02-aitest-draft-confirmed');
  evidence.screenshots.push(join(binding.screenshotsDir, '02-aitest-draft-confirmed.png'));
  await captureScreenshot(binding, '03-aitest-run-queue');
  evidence.screenshots.push(join(binding.screenshotsDir, '03-aitest-run-queue.png'));

  const dashboard = await waitForTerminal(binding, { timeoutMs: 1_200_000 });
  const dashboardEvidence = await captureDashboardEvidence(binding);
  await captureScreenshot(binding, '04-aitest-task-result');
  evidence.screenshots.push(join(binding.screenshotsDir, '04-aitest-task-result.png'));

  // 3. Journal tool evidence: real local reads and real writes to the contract
  // output paths, plus the full final response.
  await journalPathFor(binding);
  const turnEvidence = await countTurnEvidenceFor(binding).catch(() => null);
  const events = turnEvidence?.allEvents ?? [];
  const toolEvents = events.filter((event) => event.kind === 'provider.tool' || event.kind === 'provider.tool-result');
  const isTool = (id) => (event) => new RegExp(id, 'i').test(`${event.summary ?? ''} ${event.toolId ?? ''}`);
  const readCalls = toolEvents.filter((event) => event.kind === 'provider.tool' && isTool('file\\.read')(event));
  const writeCalls = toolEvents.filter((event) => event.kind === 'provider.tool' && isTool('file\\.write')(event));
  const readTargets = readCalls.map((event) => readPathFromEvent(event)).filter((value) => typeof value === 'string');
  const writeTargets = writeCalls.map((event) => readPathFromEvent(event)).filter((value) => typeof value === 'string');
  const normalize = (value) => String(value).replace(/^\.\//, '');
  const readLocalSet = new Set(readTargets.map(normalize));
  const writeLocalSet = new Set(writeTargets.map(normalize));
  const readRequired = REQUIRED_TASK_READS.filter((rel) => readLocalSet.has(rel));
  const escapedReads = checkPathsLocalOnly(readTargets, copyRoot);
  const escapedWrites = checkPathsLocalOnly(writeTargets, copyRoot);

  const fullResponse = String(dashboard.output ?? '');
  const source = await preserveFullResponse({ copyRoot, fullResponse });

  // 4. Output validation + external checker (argv) + unchanged input/checker.
  const output = await assessOutputFiles({ resultPath, artifactPath });
  const checkerRun = await runExternalChecker({ checkerPath, resultPath });
  const checkerAssessment = assessCheckerOutput(checkerRun);
  const checkerHashAfter = await readExternalChecker(checkerPath).then((value) => value.sha256).catch(() => null);
  const inputManifestAfter = await readTaskInputs(taskRoot).then(manifestOf).catch(() => null);
  const manifestUnchanged = inputManifestAfter !== null && manifestsEqual(inputManifestBefore, inputManifestAfter);
  const checkerUnchanged = checkerHashAfter === checker.sha256;
  const originalOutputAfter = await lstatOrNull(originalOutputPath);
  const originalOutputUnchanged = (originalOutputBefore === null) === (originalOutputAfter === null);

  // 5. Real browser opens the produced HTML on a separate artifact page and
  // captures two frames; then the artifacts are staged into the receipt dir.
  const artifact = await captureArtifactEvidence(binding, { resultPath })
    .catch((error) => ({
      error: error.message,
      screenshots: [],
      externalRequests: [],
      requestFailures: [],
      consoleErrors: [],
    }));
  if (Array.isArray(artifact.screenshots)) evidence.screenshots.push(...artifact.screenshots);
  const staged = await stageArtifacts({ binding, resultPath, artifactPath, sourcePath: source.path });

  // 6. Structured visual observation, bound to this attempt's identity/hashes.
  const observationContext = {
    candidateSha: binding.candidateSha,
    attemptId: binding.attemptId,
    taskId: binding.taskId,
    htmlSha256: output.facts.htmlSha256,
    svgSha256: output.facts.svgSha256,
    screenshotPaths: artifact.screenshots ?? [],
  };
  let observation = null;
  let observationResult = { ok: false, reasons: ['the structured visual observation could not be read'] };
  try {
    observation = await readVisualObservation({ injected: binding.visualObservation ?? null });
    observationResult = validateVisualObservation(observation, observationContext);
  } catch (error) {
    observationResult = { ok: false, reasons: [error.message] };
  }
  const humanObservation = observationResult.ok
    ? {
        observer: observation.observer,
        observerType: observation.observerType,
        observedAt: observation.observedAt,
        conclusion: observation.conclusion,
        panda: observation.panda,
        bicycle: observation.bicycle,
        road: observation.road,
        animationVisible: observation.animationVisible,
        renderingOk: observation.renderingOk,
        uncertainty: observation.uncertainty ?? null,
      }
    : null;

  const missing = [];
  if (dashboard.state !== 'succeeded') missing.push(`terminal state=${dashboard.state} (expected succeeded)`);
  if (!turnEvidence) missing.push('authoritative journal evidence could not be read');
  else if (turnEvidence.toolRounds < 1) missing.push(`journal toolRounds=${turnEvidence.toolRounds} (expected >= 1)`);
  if (readRequired.length !== REQUIRED_TASK_READS.length) {
    const absent = REQUIRED_TASK_READS.filter((rel) => !readLocalSet.has(rel)).join(', ');
    missing.push(`the agent did not file.read the required local inputs: missing ${absent || '(none)'}`);
  }
  if (escapedReads.length > 0) missing.push(`file.read targeted non-local/absolute paths: ${escapedReads.join(', ')}`);
  for (const rel of REQUIRED_WRITES) {
    if (!writeLocalSet.has(rel)) missing.push(`no file.write tool call targeted ${rel}`);
  }
  if (escapedWrites.length > 0) missing.push(`file.write targeted non-local/absolute paths: ${escapedWrites.join(', ')}`);
  missing.push(...output.problems);
  if (checkerHashAfter === null) missing.push('the external checker could not be re-hashed after the run');
  else if (!checkerUnchanged) missing.push('the external checker changed during the attempt');
  missing.push(...checkerAssessment.problems);
  if (!manifestUnchanged) missing.push('the AItest source inputs changed during the attempt');
  if (!originalOutputUnchanged) missing.push('the original AItest task output appeared or changed during the attempt');
  missing.push(...artifactPageIssues(artifact));
  for (const entry of Object.values(staged)) {
    if (!entry.matchesSource) missing.push(`staged artifact ${entry.dest} does not match its source`);
  }
  if (!staged['result.html']) missing.push('output/result.html was not staged into the receipt directory');
  if (!staged['artifact.svg']) missing.push('output/artifact.svg was not staged into the receipt directory');
  if (!observationResult.ok) missing.push(`visual observation not accepted: ${observationResult.reasons.join('; ')}`);

  evidence.scenarioEvidence = {
    aitestRoot,
    taskRoot,
    checkerPath,
    copyRoot,
    runId,
    attemptId: binding.attemptId,
    taskId: binding.taskId ?? null,
    inputFiles: TASK_INPUT_FILES,
    inputManifestBefore,
    inputManifestAfter,
    inputManifestUnchanged: manifestUnchanged,
    prompt,
    copy: Object.fromEntries(Object.entries(copied).map(([rel, entry]) => [rel, { path: entry.path, sha256: entry.sha256, size: entry.size }])),
    checker: {
      path: checker.path,
      sha256: checker.sha256,
      sha256After: checkerHashAfter,
      unchanged: checkerUnchanged,
      exitCode: checkerRun.exitCode,
      timedOut: checkerRun.timedOut,
      stdout: checkerRun.stdout,
      stderr: checkerRun.stderr,
      parsed: checkerRun.parsed,
    },
    output: output.facts,
    outputProblems: output.problems,
    checkerProblems: checkerAssessment.problems,
    originalOutputPresentBefore: originalOutputBefore !== null,
    originalOutputPresentAfter: originalOutputAfter !== null,
    originalOutputUnchanged,
    resultPath,
    artifactPath,
    sourceTxt: source,
    fullFinalResponse: fullResponse,
    stagedArtifacts: staged,
    artifactPage: {
      fileUrl: artifact.fileUrl ?? null,
      navigation: artifact.navigation ?? null,
      navigationError: artifact.navigationError ?? null,
      requests: artifact.requests ?? null,
      externalRequests: artifact.externalRequests ?? null,
      requestFailures: artifact.requestFailures ?? null,
      consoleErrors: artifact.consoleErrors ?? null,
      screenshots: artifact.screenshots ?? [],
    },
    toolEvidence: {
      readCalls: readCalls.map(pickEvent),
      writeCalls: writeCalls.map(pickEvent),
      readTargets,
      writeTargets,
      requiredReadsSeen: readRequired,
      escapedReads,
      escapedWrites,
    },
    terminalState: dashboard.state,
    executionEpoch: dashboard.executionEpoch ?? null,
    operationId: dashboard.operationId ?? null,
    checkpoint: dashboard.checkpoint ?? null,
    toolRounds: turnEvidence?.toolRounds ?? 0,
    requestStartTurns: turnEvidence?.requestStartTurns ?? 0,
    dashboardProbe: dashboardEvidence.dashboardProbe,
    toolStepEvidence: dashboardEvidence.toolStepEvidence,
    executeNode: dashboardEvidence.executeNode,
    observation: dashboardEvidence.observation,
    taskDashboardDom: dashboardEvidence.taskDashboardDom,
    terminalSse: dashboardEvidence.sse,
    visualObservation: observation,
    visualObservationContext: observationContext,
    visualObservationAccepted: observationResult.ok,
    visualObservationProblems: observationResult.reasons,
    humanObservation,
    // Not a substitute for the observed terminal: the structural checker plus a
    // browser open does not prove the panda/bicycle/road semantics.
    observationContractNote:
      'humanObservation is populated only from a separately supplied structured visual observation; a structural checker PASS is not semantic proof.',
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
  if (missing.length) evidence.missingEvidence = [...new Set(missing)];
  return evidence;
}

/** Copy the produced artifacts into the canonical receiptDir and verify hashes. */
export async function stageArtifacts({ binding, resultPath, artifactPath, sourcePath = null }) {
  const destDir = join(binding.receiptDir, 'aitest-output');
  await mkdir(destDir, { recursive: true });
  const plan = [['result.html', resultPath], ['artifact.svg', artifactPath]];
  if (sourcePath) plan.push(['source.txt', sourcePath]);
  const staged = {};
  for (const [name, from] of plan) {
    const info = await lstatOrNull(from);
    if (!info?.isFile() || info.size === 0) continue;
    const dest = join(destDir, name);
    await copyFile(from, dest);
    const sourceSha = await sha256File(from);
    const destSha = await sha256File(dest);
    staged[name] = { source: from, dest, sha256: destSha, matchesSource: sourceSha === destSha };
  }
  return staged;
}

function readPathFromEvent(event) {
  const args = event.arguments;
  if (args === null || typeof args !== 'object') return null;
  for (const key of ['path', 'file_path', 'filePath']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key];
  }
  return null;
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
