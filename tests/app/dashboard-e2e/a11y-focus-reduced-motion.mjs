import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonRequest, loadPlaywright, startServeForAttempt, waitForDom } from './lib/browser.mjs';
import { bindCandidate, prepareAttemptRoots, registerAttemptResources } from './lib/binding.mjs';
import { closeSettledAttempt, registerCleanupInventory, stopTaskAndSettle } from './lib/cleanup.mjs';
import { submitDirectiveAndConfirmDraft } from './lib/browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = join(__dirname, '..', '..', '..');
const repoPath = process.env.E2E_REPO_PATH ?? DEFAULT_REPO_PATH;

function fail(message) {
  console.error(JSON.stringify({ status: 'FAIL', error: message }, null, 2));
  process.exit(1);
}

async function capture(page, shotsDir, name) {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function activeElement(page) {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (!node) return null;
    return {
      tag: node.tagName?.toUpperCase?.() ?? String(node.tagName ?? 'null'),
      cls: node.getAttribute?.('class') ?? null,
      nodeId: node.getAttribute?.('data-node-id') ?? null,
      text: node.textContent?.trim().slice(0, 120) ?? null,
      outerHTML: node.outerHTML?.slice(0, 240) ?? null,
      connected: node.isConnected,
    };
  });
}

async function waitForNode(page, selector, label) {
  await waitForDom(page, label, () => page.$(selector), 15000);
}

async function openObservation(page, taskId) {
  const url = `${new URL(page.url()).origin}/observation.html?task=${encodeURIComponent(taskId)}`;
  // The quick-create dispatch handler in dashboard.js sets window.location.href to
  // task-dashboard.html itself once the task appears. That write races the probe's own
  // navigation, so a goto can be reported as "interrupted by another navigation". Once the
  // dashboard document is torn down by our navigation the pending handler cannot fire
  // again, so a bounded retry is enough to cross the race.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      break;
    } catch (error) {
      if (attempt === 4 || !/interrupted by another navigation/i.test(error?.message ?? '')) throw error;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
  }
  await waitForNode(page, '.flow-node', 'observation node');
}

async function openDrawer(page, method, selector = '.flow-node') {
  await waitForNode(page, selector, 'flow node trigger');
  if (method === 'keyboard') {
    await page.focus(selector);
    await page.keyboard.press('Enter');
  } else {
    await page.click(selector);
  }
  await waitForNode(page, '.node-drawer[open]', 'opened drawer');
}

async function waitForFocusRestored(page) {
  await waitForDom(page, 'focus returned to current flow-node', () => page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active?.classList?.contains('flow-node') && active.isConnected);
  }), 5000);
}

async function ensureDrawerClosed(page) {
  await page.waitForFunction(() => !document.querySelector('.node-drawer[open]'), null, { timeout: 5000 });
}

async function closeAndCapture(page, shotsDir, shotPrefix, method) {
  const before = await activeElement(page);
  const openShot = await capture(page, shotsDir, `${shotPrefix}-open`);
  const beforeClose = await page.evaluate((action) => ({
    action,
    drawerOpen: Boolean(document.querySelector('.node-drawer[open]')),
    enterVisible: Boolean(document.querySelector('.drawer-enter')),
    closeVisible: Boolean(document.querySelector('.drawer-close')),
    crumbs: [...document.querySelectorAll('.breadcrumbs button')].map((node) => node.textContent?.trim() ?? ''),
  }), method);
  if (method === 'escape') await page.keyboard.press('Escape');
  if (method === 'breadcrumb') await page.keyboard.press('Escape');
  if (method === 'close-button') await page.click('.drawer-close');
  if (method === 'enter-scope') await page.click('.drawer-enter');
  try {
    await ensureDrawerClosed(page);
    if (method === 'breadcrumb') {
      await page.click('.breadcrumbs button');
      await waitForNode(page, '.flow-node', 'flow node after breadcrumb');
    }
  } catch (error) {
    const state = await page.evaluate((action) => ({
      action,
      drawerOpen: Boolean(document.querySelector('.node-drawer[open]')),
      active: document.activeElement?.outerHTML?.slice(0, 200) ?? null,
      body: document.body.textContent?.slice(0, 500) ?? null,
    }), method);
    throw new Error(`${method} close failed: ${error.message}; state=${JSON.stringify(state)}`);
  }
  await waitForNode(page, '.flow-node', 'flow node after close');
  await waitForFocusRestored(page).catch(() => null);
  const after = await activeElement(page);
  const currentTrigger = await page.evaluate(() => {
    const card = document.querySelector('.flow-node');
    return card ? { connected: card.isConnected, nodeId: card.dataset.nodeId } : null;
  });
  const afterShot = await capture(page, shotsDir, `${shotPrefix}-closed`);
  return { before, beforeClose, after, currentTrigger, shots: [openShot, afterShot] };
}

async function spinnerProbe(page, shotsDir) {
  await page.goto(`${new URL(page.url()).origin}/dashboard.html`, { waitUntil: 'domcontentloaded' });
  await waitForNode(page, '.quick-create-form textarea[name="directive"]', 'dashboard input');
  await page.check('input[name="autoConfirm"]');
  await page.fill('.quick-create-form textarea[name="directive"]', 'Describe one local weather condition for the probe. Do not clarify.');
  await page.click('.quick-create-form button[type="submit"]');
  const styles = await waitForDom(page, 'live progress spinner', () => page.evaluate(() => {
    const progress = document.querySelector('.quick-create-progress.progress--live');
    const spinner = progress?.querySelector('.progress-spinner');
    if (!spinner) return null;
    const timer = progress.querySelector('.progress-timer');
    const phase = progress.querySelector('.progress-phase');
    const detail = progress.querySelector('.progress-detail');
    return {
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      ariaLive: progress.getAttribute('aria-live'),
      role: progress.getAttribute('role'),
      animationName: getComputedStyle(spinner).animationName,
      animationIterationCount: getComputedStyle(spinner).animationIterationCount,
      animationDuration: getComputedStyle(spinner).animationDuration,
      animationPlayState: getComputedStyle(spinner).animationPlayState,
      opacity: getComputedStyle(spinner).opacity,
      timerText: timer?.textContent?.trim() ?? null,
      timerHidden: timer?.hidden ?? null,
      timerAriaHidden: timer?.getAttribute('aria-hidden') ?? null,
      phaseText: phase?.textContent?.trim() ?? null,
      detailText: detail?.textContent?.trim() ?? null,
    };
  }), 5000);
  const shot = await capture(page, shotsDir, 'reduced-motion-spinner');
  return { styles, shot };
}

async function run() {
  const binding = bindCandidate(repoPath);
  registerAttemptResources(binding);
  await prepareAttemptRoots(binding);
  await startServeForAttempt(binding);
  registerCleanupInventory(binding);
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  binding.browser = { browser, page, context, close: async () => context.close().then(() => browser.close()) };
  const shotsDir = binding.screenshotsDir;
  await mkdir(shotsDir, { recursive: true });
  const screenshots = [];
  const result = {
    status: 'PASS',
    repoPath,
    candidateSha: binding.candidateSha,
    serveBaseUrl: binding.serveBaseUrl,
    servePid: binding.servePid,
    screenshots,
  };

  try {
    if (process.env.E2E_TASK_ID) {
      binding.taskId = process.env.E2E_TASK_ID;
    } else {
      await submitDirectiveAndConfirmDraft(binding, 'Describe one local weather condition for the probe. Do not clarify.', {
        clarificationAnswer: 'Do not clarify. Proceed directly.',
        draftTimeoutMs: 180000,
        confirmTimeoutMs: 180000,
      });
    }

    const viewports = [
      { width: 1440, height: 1000, label: '1440' },
      { width: 768, height: 720, label: '768' },
      { width: 390, height: 844, label: '390' },
    ];
    const closePaths = [];
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await openObservation(page, binding.taskId);
      await openDrawer(page, viewport.width === 768 ? 'mouse' : 'keyboard');
      const method = viewport.width === 768 ? 'close-button' : 'escape';
      closePaths.push({ viewport, method, ...(await closeAndCapture(page, shotsDir, `${viewport.label}-${method}`, method)) });
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    await openObservation(page, binding.taskId);
    await openDrawer(page, 'keyboard');
    closePaths.push({ path: 'breadcrumb-return', ...(await closeAndCapture(page, shotsDir, 'breadcrumb-return', 'breadcrumb')) });

    await openObservation(page, binding.taskId);
    await openDrawer(page, 'keyboard', '.flow-node[data-node-id="pipeline.execute"]');
    closePaths.push({ path: 'reproject-during-drawer', ...(await closeAndCapture(page, shotsDir, 'reproject-during-drawer', 'enter-scope')) });

    await page.setViewportSize({ width: 390, height: 500 });
    await openObservation(page, binding.taskId);
    await page.evaluate(() => { document.documentElement.style.zoom = '200%'; });
    await openDrawer(page, 'keyboard');
    closePaths.push({ viewport: { width: 390, height: 500, label: '390-short-200pct' }, method: 'escape', ...(await closeAndCapture(page, shotsDir, '390-short-200pct-escape', 'escape')) });

    result.closePaths = closePaths;
    result.spinner = await spinnerProbe(page, shotsDir);
    result.screenshots.push(...closePaths.flatMap((path) => path.shots), result.spinner.shot);

    const invalid = closePaths.filter((entry) => entry.after?.tag === 'BODY' || !entry.after?.connected || !entry.currentTrigger?.connected || entry.currentTrigger.nodeId !== entry.after.nodeId);
    if (invalid.length) result.missingEvidence = ['drawer focus did not return to current DOM trigger'];
    const spinner = result.spinner.styles;
    if (!spinner.reducedMotion || spinner.animationIterationCount !== '1' || !spinner.timerText || spinner.timerAriaHidden !== 'true') {
      result.missingEvidence = result.missingEvidence ?? [];
      result.missingEvidence.push('reduced motion spinner or status text assertion failed');
    }
    if (result.missingEvidence?.length) {
      result.status = 'FAIL';
    }
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) {
    result.status = 'FAIL';
    result.error = error?.message ?? String(error);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    const settle = await stopTaskAndSettle(binding, binding.taskId ?? null).catch(() => null);
    const cleanup = await closeSettledAttempt(binding, settle ?? { settled: false }).catch(() => null);
    console.error(JSON.stringify({ cleanup, servePid: binding.servePid }, null, 2));
  }
}

run().catch((error) => fail(error?.message ?? String(error)));
