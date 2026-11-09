#!/usr/bin/env node

/**
 * Real-browser proof for the entry task-list drawer (requirement v33
 * `humanagent-entry-task-list-in-drawer`).
 *
 * It drives the real served entry page (`index.html`) in headless Chromium
 * against a scripted public runtime API. No listening socket is required: the
 * static UI modules and the JSON reads are served through Playwright request
 * interception, so the deterministic browser proof still runs in a sandbox
 * that denies TCP/UDP bind.
 *
 * It proves, in the real DOM:
 *   - the entry main column does not render the inline task-list rows;
 *   - a 任务列表 trigger opens the shared shell-layer drawer with the list;
 *   - the drawer rows carry the real task id, status and title from the
 *     existing task source (`/api/tasks`);
 *   - the drawer toggles closed again and the entry form stays usable;
 *   - the page produces no runtime errors.
 *
 * Set `ENTRY_DRAWER_EVIDENCE` to the execution-owned evidence root. Optional:
 *   ENTRY_DRAWER_UI_ROOT    default dist/app/ui (the built served UI)
 *   ENTRY_DRAWER_PLAYWRIGHT default /opt/homebrew/lib/node_modules/playwright/index.js
 *   ENTRY_DRAWER_BROWSER_ARGS default --single-process,--no-zygote
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = resolve(process.env.ENTRY_DRAWER_UI_ROOT ?? join(repoRoot, 'dist', 'app', 'ui'));
const evidenceRoot = process.env.ENTRY_DRAWER_EVIDENCE?.trim();

if (!evidenceRoot) {
  throw new Error('ENTRY_DRAWER_EVIDENCE is required; point it at an execution-owned directory');
}

const playwrightModule = await import(
  process.env.ENTRY_DRAWER_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
);
const playwright = playwrightModule.default ?? playwrightModule;

const proofOrigin = 'http://humanagent.entry-task-list-drawer.test';
const browserArgs = (process.env.ENTRY_DRAWER_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const checks = [];
const observations = [];
let failures = 0;

function record(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail });
  if (!pass) failures += 1;
}

function observe(name, value) {
  observations.push({ name, value });
}

// The existing task source (`/api/tasks`) carries id, committed status and the
// committed semantic title. These rows are read-only evidence, never invented.
const tasks = [
  {
    taskId: { scope: 'task', value: 'task-1' },
    title: '读取 README 并汇报 (规范化)',
    semanticTitle: '读取 README 并汇报',
    state: 'running',
    stateLabel: '执行中',
    nextStep: '等待模型',
    updatedAt: '2026-11-08T12:00:00.000Z',
  },
  {
    taskId: { scope: 'task', value: 'task-2' },
    title: '整理发布说明 (规范化)',
    semanticTitle: '整理发布说明',
    state: 'waiting',
    stateLabel: '排队中',
    nextStep: '等待执行',
    updatedAt: '2026-11-08T12:05:00.000Z',
  },
];

function mimeType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

async function installRoutes(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== proofOrigin) {
      await route.continue();
      return;
    }
    if (url.pathname === '/api/runtime/status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ mode: 'fake', state: 'ready', providerState: 'ready', connected: true }),
      });
      return;
    }
    if (url.pathname === '/api/tasks') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          surface: 'runtime-task-list',
          mode: 'fake',
          draft: [],
          waiting: tasks.filter((task) => task.state === 'waiting'),
          running: tasks.filter((task) => task.state === 'running'),
          completed: [],
          stopped: [],
          failed: [],
          counts: { running: 1, waiting: 1, completed: 0, stopped: 0, draft: 0, failed: 0, total: tasks.length },
        }),
      });
      return;
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
    if (!relative || relative.split('/').includes('..')) {
      await route.fulfill({ status: 400, body: 'bad path' });
      return;
    }
    const filePath = resolve(uiRoot, relative);
    if (!filePath.startsWith(`${uiRoot}${sep}`)) {
      await route.fulfill({ status: 403, body: 'forbidden' });
      return;
    }
    try {
      const file = await readFile(filePath);
      await route.fulfill({ status: 200, contentType: mimeType(filePath), body: file });
    } catch {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
}

function readMainColumn() {
  const section = document.querySelector('#entry-live');
  const trigger = section?.querySelector('button[data-task-list-drawer-trigger="true"]') ?? null;
  return {
    inlineRows: section ? section.querySelectorAll('a.task-row-link').length : -1,
    hasTrigger: Boolean(trigger),
    triggerLabel: (trigger?.textContent || '').trim(),
    triggerHaspopup: trigger?.getAttribute('aria-haspopup') ?? null,
    summaryText: (section?.textContent || '').replace(/\s+/g, ' ').trim(),
  };
}

function readDrawerRows() {
  const body = document.querySelector('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]');
  if (!body) return null;
  return [...body.querySelectorAll('a.task-row-link')].map((link) => ({
    taskId: link.dataset.taskId,
    status: link.dataset.taskStatus,
    heading: (link.querySelector('h3')?.textContent || '').trim(),
    href: link.getAttribute('href'),
  }));
}

await mkdir(evidenceRoot, { recursive: true });

const VIEWPORTS = [
  { label: 'desktop-1440', viewport: { width: 1440, height: 1000 } },
  { label: 'mobile-390', viewport: { width: 390, height: 844 } },
];

async function runScenario({ label, viewport }) {
  const browser = await playwright.chromium.launch({ headless: true, args: browserArgs });
  const context = await browser.newContext({ viewport });
  await installRoutes(context);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${proofOrigin}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#entry-form textarea[name="rawInput"]');
    // Wait until the compact summary has read the task source and published its count.
    await page.waitForFunction(() => {
      const section = document.querySelector('#entry-live');
      return Boolean(section && section.textContent && section.textContent.includes('任务数量'));
    }, undefined, { timeout: 10_000 });

    const main = await page.evaluate(readMainColumn);
    observe(`${label} entry main column`, main);
    record(`${label} entry main column exposes the task-list trigger`, main.hasTrigger === true, main);
    record(`${label} entry main column does not render the inline task list rows`, main.inlineRows === 0, main.inlineRows);
    record(`${label} entry main column keeps the compact task count`, main.summaryText.includes('任务数量') && main.summaryText.includes('2'), main.summaryText);
    record(`${label} the task-list trigger advertises a dialog`, main.triggerHaspopup === 'dialog', main.triggerHaspopup);

    // Open the drawer.
    await page.click('button[data-task-list-drawer-trigger="true"]');
    await page
      .locator('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });
    const rows = await page.evaluate(readDrawerRows);
    observe(`${label} drawer rows`, rows);
    record(`${label} the drawer opens with the task list`, Array.isArray(rows) && rows.length === tasks.length, rows);
    const ids = (rows ?? []).map((row) => row.taskId);
    record(`${label} drawer rows carry the real task ids from the task source`, tasks.every((task) => ids.includes(task.taskId.value)), ids);
    const statuses = (rows ?? []).map((row) => row.status);
    record(`${label} drawer rows carry the real task status`, statuses.includes('执行中') && statuses.includes('排队中'), statuses);
    const headings = (rows ?? []).map((row) => row.heading);
    record(`${label} drawer rows carry the committed semantic title`, headings.includes('读取 README 并汇报') && headings.includes('整理发布说明'), headings);
    record(`${label} drawer rows link to the task dashboard`, (rows ?? []).every((row) => typeof row.href === 'string' && row.href.includes('task-dashboard.html')), (rows ?? []).map((row) => row.href));

    // The drawer content must fit its own width without horizontal overflow.
    const overflow = await page.evaluate(() => {
      const body = document.querySelector('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]');
      if (!body) return null;
      return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, overflowX: body.scrollWidth > body.clientWidth + 1 };
    });
    observe(`${label} drawer overflow`, overflow);
    record(`${label} drawer content has no horizontal overflow`, overflow !== null && overflow.overflowX === false, overflow);
    await page.screenshot({ path: join(evidenceRoot, `entry-task-list-drawer-open-${label}.png`) });

    // Close the drawer.
    await page.locator('dialog[data-technical-detail="true"][open] button.shell-layer-close').first().click();
    await page.locator('dialog[data-technical-detail="true"]').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    const afterClose = {
      openDrawers: await page.evaluate(() => document.querySelectorAll('dialog[data-technical-detail="true"][open]').length),
      ...(await page.evaluate(readMainColumn)),
      inputPresent: await page.evaluate(() => Boolean(document.querySelector('#entry-form textarea[name="rawInput"]'))),
    };
    observe(`${label} after close`, afterClose);
    record(`${label} closing the drawer hides it again`, afterClose.openDrawers === 0, afterClose.openDrawers);
    record(`${label} the task-list trigger remains on the entry page`, afterClose.hasTrigger === true, afterClose.hasTrigger);
    record(`${label} the entry form stays usable after the drawer closes`, afterClose.inputPresent === true, afterClose.inputPresent);
    record(`${label} closing the drawer does not navigate away`, new URL(page.url()).pathname === '/index.html', page.url());
    await page.screenshot({ path: join(evidenceRoot, `entry-task-list-drawer-closed-${label}.png`) });

    // Toggle once more: open, then close again, so the drawer is genuinely a toggle.
    await page.click('button[data-task-list-drawer-trigger="true"]');
    await page
      .locator('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });
    const reopened = await page.evaluate(() => document.querySelectorAll('dialog[data-technical-detail="true"][open] [data-task-list-drawer="true"] a.task-row-link').length);
    record(`${label} the drawer reopens with the same task list`, reopened === tasks.length, reopened);
    await page.keyboard.press('Escape');
    await page.locator('dialog[data-technical-detail="true"]').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    record(`${label} Escape closes the drawer back to the entry page`, await page.locator('dialog[data-technical-detail="true"][open]').count() === 0, null);

    record(`${label} entry page produced no runtime errors`, pageErrors.length === 0, pageErrors);
  } catch (error) {
    record(`${label} entry task-list drawer proof completed`, false, error.message);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

for (const run of VIEWPORTS) {
  await runScenario(run);
}

const result = { uiRoot, checks, observations };
await writeFile(join(evidenceRoot, 'checks.json'), `${JSON.stringify(result, null, 2)}\n`);

console.log(`entry task-list drawer checks: ${checks.length - failures}/${checks.length} passed`);
for (const check of checks) {
  if (!check.pass) console.log(`FAIL: ${check.name} :: ${JSON.stringify(check.detail)}`);
}
console.log(failures === 0 ? 'entry task-list drawer checks passed' : 'entry task-list drawer checks FAILED');
process.exit(failures === 0 ? 0 : 1);
