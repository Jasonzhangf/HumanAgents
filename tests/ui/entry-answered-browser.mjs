#!/usr/bin/env node
/**
 * Real RCC/browser proof for the direct explicit answer on the new-task entry.
 * The serve process, RCC endpoint, HTTP API, and Chromium page are real. The
 * control root and workspace are execution-owned temporary paths.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateInteractionProviderSettlementReceipt,
  validateProviderSettlement,
} from '../../dist/app/contracts/src/index.js';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const evidenceRoot = process.env.ENTRY_ANSWERED_EVIDENCE?.trim();
if (!evidenceRoot) throw new Error('ENTRY_ANSWERED_EVIDENCE is required');
const port = Number(process.env.ENTRY_ANSWERED_PORT ?? 10099);
const controlRoot = process.env.ENTRY_ANSWERED_CONTROL_ROOT?.trim()
  ?? '/Volumes/Intel/playground/humanagent/.entry-answered-e2e/control';
const workspace = process.env.ENTRY_ANSWERED_WORKSPACE?.trim()
  ?? '/Volumes/Intel/playground/humanagent/.entry-answered-e2e/workspace';
const rccBaseUrl = (process.env.ENTRY_ANSWERED_RCC_BASE_URL ?? 'http://127.0.0.1:4444').replace(/\/$/, '');
const model = process.env.ENTRY_ANSWERED_MODEL ?? 'gpt-5.5';
const route = process.env.ENTRY_ANSWERED_ROUTE ?? 'rcc/ui-responses';
const binding = process.env.ENTRY_ANSWERED_BINDING ?? 'ui-rcc-responses';
const cliPath = resolve(repoRoot, 'dist/app/app/src/cli.js');
const playwrightModule = await import(process.env.ENTRY_ANSWERED_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js');
const playwright = playwrightModule.default ?? playwrightModule;

await mkdir(evidenceRoot, { recursive: true });
await mkdir(controlRoot, { recursive: true });
await mkdir(workspace, { recursive: true });

async function findTaskControlJournal(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findTaskControlJournal(fullPath);
      if (found) return found;
    } else if (entry.isFile() && entry.name === 'task-control.jsonl') {
      return fullPath;
    }
  }
  return null;
}

function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
function assertThat(condition, message, details) {
  if (!condition) throw new Error(`${message}${details === undefined ? '' : `: ${JSON.stringify(details)}`}`);
}
async function runCli(args) {
  return await new Promise((resolveCli, rejectCli) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', rejectCli);
    child.once('exit', (code) => code === 0
      ? resolveCli(stdout.trim())
      : rejectCli(new Error(`cli ${args.join(' ')} exited ${code}: ${stderr}`)));
  });
}
async function startServe() {
  const child = spawn(process.execPath, [
    cliPath, 'serve',
    '--mode', 'rcc',
    '--protocol', 'responses',
    '--binding', binding,
    '--provider', 'rcc',
    '--model', model,
    '--route', route,
    '--rcc-base-url', rccBaseUrl,
    '--control-root', controlRoot,
    '--workspace', workspace,
    '--port', String(port),
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`serve ready timeout: ${stderr}`)), 60_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/\{[\s\S]*?\n\}/);
      if (!match) return;
      try {
        clearTimeout(timer);
        resolveReady(JSON.parse(match[0]));
      } catch {
        // Wait for the complete JSON object.
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', rejectReady);
    child.once('exit', (code) => rejectReady(new Error(`serve exited early (${code}): ${stderr}`)));
  });
  return {
    child,
    ready,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolveStop) => {
        child.once('exit', resolveStop);
        child.kill('SIGTERM');
      });
    },
  };
}

let serve;
let browser;
let failure = null;
const pageErrors = [];
const receipt = {
  base: `http://127.0.0.1:${port}`,
  port,
  controlRoot,
  workspace,
  model,
  route,
  binding,
  checks: [],
};
try {
  serve = await startServe();
  const base = serve.ready.url ?? `http://127.0.0.1:${port}`;
  receipt.base = base;
  const pairCode = JSON.parse(await runCli(['pair', '--workspace', workspace, '--control-root', controlRoot])).code;
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const pair = await fetch(`${base}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, host: new URL(base).host },
    body: JSON.stringify({ code: pairCode }),
  });
  assertThat(pair.ok, 'isolated serve pairing succeeds', { status: pair.status });
  const cookie = pair.headers.get('set-cookie')?.split(';')[0];
  assertThat(cookie?.includes('='), 'pairing returns a session cookie');
  const [cookieName, cookieValue] = cookie.split('=');
  await context.addCookies([{ name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' }]);

  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  let interactionId;
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/explicit/inputs') && response.request().method() === 'POST' && response.status() === 201) {
      try { interactionId = (await response.json()).interactionId; } catch { /* assertion below reports a missing id */ }
    }
  });
  const taskCount = async () => {
    const response = await context.request.get(`${base}/api/tasks`);
    if (!response.ok()) return null;
    const body = await response.json();
    if (Array.isArray(body)) return body.length;
    const rows = [...(body?.waiting ?? []), ...(body?.running ?? [])];
    return rows.length;
  };
  const tasksBefore = await taskCount();

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#entry-form textarea[name="rawInput"]', { timeout: 30_000 });
  await page.fill('#entry-form textarea[name="rawInput"]', '13 加 14 等于多少？');
  await page.click('#entry-form button[type="submit"]');

  const answerDeadline = Date.now() + 180_000;
  let snapshot;
  while (Date.now() < answerDeadline) {
    if (interactionId) {
      const response = await context.request.get(`${base}/api/explicit/interactions/${encodeURIComponent(interactionId)}`);
      if (response.ok()) {
        snapshot = await response.json();
        if (snapshot.state === 'answered') break;
      }
    }
    await sleep(500);
  }
  assertThat(interactionId, 'the real submit creates one explicit interaction');
  assertThat(snapshot?.state === 'answered', 'the real interaction reaches answered', snapshot);
  assertThat(typeof snapshot.reply === 'string' && snapshot.reply.trim() !== '', 'answered snapshot carries a reply', snapshot);
  receipt.interactionId = interactionId;
  receipt.reply = snapshot.reply;
  receipt.state = snapshot.state;
  receipt.nextAction = snapshot.nextAction;

  const taskControlPath = await findTaskControlJournal(controlRoot);
  assertThat(taskControlPath, 'task-control.jsonl exists in control root', { controlRoot });
  const journalContent = await readFile(taskControlPath, 'utf8');
  const journalLines = journalContent.split('\n').filter((line) => line.trim().length > 0);
  const parentTurnRecords = [];
  for (const line of journalLines) {
    try {
      const record = JSON.parse(line);
      const payload = record.payload;
      if (payload && payload.kind === 'interaction-parent.turn-raw.v1' && payload.turn?.interactionId === interactionId) {
        parentTurnRecords.push({ record, payload });
      }
    } catch {
      // skip unparseable lines
    }
  }
  assertThat(parentTurnRecords.length > 0, 'parent-turn records exist for interactionId', { interactionId, taskControlPath });

  const settlementRecords = parentTurnRecords.filter(
    (entry) => entry.payload.discriminant === 'provider-settlement',
  );

  let turnIdentity;
  if (settlementRecords.length === 1) {
    turnIdentity = settlementRecords[0].payload.turn;
  } else if (settlementRecords.length > 1) {
    const succeededSettlements = settlementRecords.filter(
      (entry) => entry.payload.fact?.settlement?.state === 'succeeded',
    );
    if (succeededSettlements.length === 1) {
      turnIdentity = succeededSettlements[0].payload.turn;
    } else {
      throw new Error(
        `Cannot unambiguously identify answered turn identity: found ${settlementRecords.length} settlements (${succeededSettlements.length} succeeded): ${JSON.stringify(settlementRecords.map((r) => r.payload))}`,
      );
    }
  } else {
    const turnsMap = new Map();
    for (const entry of parentTurnRecords) {
      const t = entry.payload.turn;
      const key = `${t.inputRevision}:${t.turnId}`;
      turnsMap.set(key, t);
    }
    const turns = Array.from(turnsMap.values());
    if (turns.length === 1) {
      turnIdentity = turns[0];
    } else {
      throw new Error(
        `Cannot unambiguously identify answered turn identity from multiple turns without provider settlement: ${JSON.stringify(turns)}`,
      );
    }
  }
  assertThat(turnIdentity && typeof turnIdentity.turnId === 'string' && turnIdentity.turnId.trim() !== '', 'resolved turnId is a non-empty string', turnIdentity);
  assertThat(Number.isSafeInteger(turnIdentity.inputRevision) && turnIdentity.inputRevision >= 1, 'resolved inputRevision is positive integer', turnIdentity);

  const settlementUrl = new URL(`${base}/api/explicit/interactions/${encodeURIComponent(interactionId)}/control/provider-settlement`);
  settlementUrl.searchParams.set('inputRevision', String(turnIdentity.inputRevision));
  settlementUrl.searchParams.set('turnId', turnIdentity.turnId);
  const settlementResponse = await context.request.get(settlementUrl.toString());
  const settlementStatus = settlementResponse.status();
  const settlementBodyText = await settlementResponse.text();
  let settlementBody;
  try {
    settlementBody = JSON.parse(settlementBodyText);
  } catch {
    settlementBody = settlementBodyText;
  }
  assertThat(settlementStatus === 200, 'GET explicit provider settlement returns 200', {
    status: settlementStatus,
    body: settlementBody,
    url: settlementUrl.toString(),
  });
  assertThat(settlementBody && typeof settlementBody === 'object', 'settlement response is an object', settlementBody);
  assertThat(settlementBody.commit !== undefined, 'settlement response carries commit', settlementBody);
  assertThat(settlementBody.fact !== undefined, 'settlement response carries fact', settlementBody);

  validateProviderSettlement(settlementBody.fact.settlement);
  validateInteractionProviderSettlementReceipt(settlementBody.fact);

  assertThat(settlementBody.fact.settlement.state === 'succeeded', 'fact.settlement.state is succeeded', settlementBody.fact.settlement);
  assertThat(settlementBody.fact.interactionId === interactionId, 'fact interactionId matches answered interaction', {
    expected: interactionId,
    actual: settlementBody.fact.interactionId,
  });
  assertThat(settlementBody.fact.inputRevision === turnIdentity.inputRevision, 'fact inputRevision matches read turn', {
    expected: turnIdentity.inputRevision,
    actual: settlementBody.fact.inputRevision,
  });
  assertThat(settlementBody.fact.settlement?.interactionTurn?.turnId === turnIdentity.turnId, 'settlement turnId matches read turn', {
    expected: turnIdentity.turnId,
    actual: settlementBody.fact.settlement?.interactionTurn?.turnId,
  });
  assertThat(settlementBody.fact.request?.turnId === settlementBody.fact.settlement?.turnId, 'fact request turnId matches settlement turnId', {
    expected: settlementBody.fact.settlement?.turnId,
    actual: settlementBody.fact.request?.turnId,
  });
  assertThat(settlementBody.fact.settlement?.interactionTurn?.interactionId === interactionId, 'settlement interactionId matches', {
    expected: interactionId,
    actual: settlementBody.fact.settlement?.interactionTurn?.interactionId,
  });
  assertThat(settlementBody.fact.settlement?.interactionTurn?.inputRevision === turnIdentity.inputRevision, 'settlement inputRevision matches', {
    expected: turnIdentity.inputRevision,
    actual: settlementBody.fact.settlement?.interactionTurn?.inputRevision,
  });

  receipt.providerSettlement = {
    request: {
      interactionId,
      inputRevision: turnIdentity.inputRevision,
      turnId: turnIdentity.turnId,
    },
    commit: settlementBody.commit,
    fact: settlementBody.fact,
  };
  receipt.checks.push('typed provider settlement validated state=succeeded');

  const readVisible = () => page.evaluate(() => {
    const status = document.querySelector('[role="status"]');
    const retryText = [...document.querySelectorAll('button')].map((button) => (button.textContent || '').trim());
    const dialog = document.querySelector('dialog[data-technical-detail="true"]');
    return {
      statusText: (status?.textContent || '').trim(),
      tone: status?.dataset?.tone ?? null,
      retryLabels: retryText,
      hasRetrySubmission: retryText.some((text) => text.includes('重试本次提交')),
      visiblePageText: document.body.innerText,
      technicalDetailOpen: Boolean(dialog?.open),
      url: location.href,
    };
  });
  // Wait for the page to settle on a success result. The failure message must
  // carry what the page actually showed, so a regression reads as the user's
  // symptom instead of an opaque timeout.
  let visible;
  const settleDeadline = Date.now() + 30_000;
  while (Date.now() < settleDeadline) {
    visible = await readVisible();
    if (visible.tone === 'success' && visible.statusText !== '') break;
    await sleep(250);
  }
  visible ??= await readVisible();
  receipt.visible = visible;
  await page.screenshot({ path: join(evidenceRoot, 'entry-answered-page.png'), fullPage: true });
  assertThat(visible.tone === 'success', 'answer uses success tone', visible);
  assertThat(visible.statusText.includes(snapshot.reply), 'reply is visible in the main status region', { visible, reply: snapshot.reply });
  assertThat(visible.visiblePageText.includes(snapshot.reply), 'reply is visible in page text', { visibleText: visible.visiblePageText, reply: snapshot.reply });
  assertThat(!visible.hasRetrySubmission, 'answered result has no retry-submission action', visible);
  assertThat(!visible.technicalDetailOpen, 'answer is not hidden in an open technical detail dialog');
  assertThat(!visible.visiblePageText.includes('状态：answered'), 'raw interaction state is not exposed as page text', { pageText: visible.visiblePageText });
  assertThat(visible.url.endsWith('/') || visible.url.endsWith('/index.html'), 'simple answer stays on entry page', visible.url);
  assertThat(pageErrors.length === 0, 'browser reports zero page errors', pageErrors);
  const tasksAfter = await taskCount();
  assertThat(tasksBefore !== null && tasksAfter !== null, 'the isolated task list is readable before and after', { tasksBefore, tasksAfter });
  assertThat(tasksAfter === tasksBefore && tasksAfter === 0, 'simple answer does not create a task', { tasksBefore, tasksAfter });
  assertThat(snapshot.draft === undefined, 'an answered interaction carries no draft', snapshot.draft);
  assertThat(visible.visiblePageText.includes('尚未提交任务'), 'the queue area still reports no submitted task', { pageText: visible.visiblePageText });
  receipt.pageErrors = pageErrors;
  receipt.checks.push(
    'state=answered',
    'reply is visible in main status and page text',
    'success tone',
    'no retry action',
    'no landing navigation',
    'zero pageerror',
    'no draft, no task, no queue entry',
  );
  await page.screenshot({ path: join(evidenceRoot, 'entry-answered.png'), fullPage: true });
  await context.close();
} catch (error) {
  failure = error;
  receipt.failure = error instanceof Error ? error.message : String(error);
} finally {
  await browser?.close().catch(() => {});
  await serve?.stop().catch(() => {});
}
if (failure) {
  receipt.status = 'FAIL';
  await writeFile(join(evidenceRoot, 'entry-answered-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.error(JSON.stringify(receipt, null, 2));
  throw failure;
}
receipt.status = 'PASS';
await writeFile(join(evidenceRoot, 'entry-answered-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(receipt, null, 2));
