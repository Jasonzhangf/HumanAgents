/**
 * Real-browser proof for the interaction work card.
 *
 * Serves the already-built `dist/app/ui` from a loopback port bound to 0. It
 * mounts the shared `mountInteractionWorkCard` component into an isolated
 * harness page and asserts public DOM structure, markdown rendering, and the
 * separation of human summary from technical detail. It then loads the real
 * `dashboard.html` and `task.html` pages and records whether the static
 * component mount point survives page initialisation.
 *
 * The page-to-component wiring owned by `dashboard.js`, `entry.js` and
 * `task.js` is out of this task's write scope, so those pages are checked as a
 * static contract plus an honest survival record rather than driven end to end.
 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiRoot = join(repoRoot, 'dist', 'app', 'ui');
const contractsEntry = pathToFileURL(join(repoRoot, 'dist', 'app', 'contracts', 'src', 'index.js')).href;
const projectionEntry = pathToFileURL(join(repoRoot, 'dist', 'app', 'ui', 'projection', 'interaction-work-card.js')).href;
const evidenceRoot = process.env.INTERACTION_CARD_EVIDENCE;

if (!evidenceRoot?.trim()) {
  throw new Error(
    'INTERACTION_CARD_EVIDENCE is required; set it to an execution-owned directory before running the work-card browser proof',
  );
}

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === '@humanagent/contracts') {
        return { url: ${JSON.stringify(contractsEntry)}, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    }
  `)}`,
  import.meta.url,
)

const { projectInteractionWorkCard } = await import(projectionEntry);
const playwrightModule = await import(process.env.INTERACTION_CARD_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js');
const playwright = playwrightModule.default ?? playwrightModule;

const ORGAN = { scope: 'organ', value: 'organ-card-proof' };
const TASK = { scope: 'task', value: 'task-card-proof' };
const OPERATION = { scope: 'operation', value: 'operation-card-proof' };
const SCOPE = { organId: ORGAN, taskId: TASK, operationId: OPERATION };
const TIME = '2026-10-03T12:00:00Z';

function evidenceRef(ref, digest) {
  return {
    evidenceId: { scope: 'evidence', value: ref },
    kind: 'tool',
    source: 'interaction-card-proof',
    locator: `proof://${ref}`,
    digest,
    scope: SCOPE,
  };
}

function traceEntry({ seq, kind, callId, toolId, toolStatus, error, outputRef, state }) {
  const tool = kind === 'tool-call' || kind === 'tool-result' || error
    ? {
        callId,
        toolId,
        argumentsRef: `asset://arguments/${callId}`,
        argumentsDigest: `sha256:arguments-${callId}`,
        status: toolStatus,
        outputRef,
        outputDigest: outputRef ? `sha256:output-${callId}` : undefined,
        error,
        startedAt: TIME,
        durationMs: 420,
      }
    : undefined;

  return {
    turnId: `turn-${seq}`,
    requestId: `request-${seq}`,
    seq,
    occurredAt: new Date(Date.UTC(2026, 9, 3, 12, seq, 0)).toISOString(),
    kind,
    modelRef: 'model-card-proof',
    taskId: TASK,
    operationId: OPERATION,
    executionEpoch: 1,
    tool,
    authorization: {
      scope: SCOPE,
      taskId: TASK,
      operationId: OPERATION,
      executionEpoch: 1,
      requestedCapabilities: [kind],
      permissionRefs: ['permission://card-proof'],
      toolOutputRef: tool?.outputRef ?? `trace://no-output-${seq}`,
    },
    evidenceRefs: [evidenceRef(`evidence-${seq}`, `sha256:evidence-${seq}`)],
    state,
    allowedActions: [],
    provider: { state: 'ready', lastEventAt: TIME },
    transport: { connected: true, lastSyncedAt: TIME, cursor: 'cursor-card-proof-3' },
    settlement: { providerStopped: false, checkpointCommitted: false },
    lastBusiness: { kind, at: TIME, ref: callId ?? `trace-${seq}` },
  };
}

function makeProjection() {
  const items = [
    traceEntry({ seq: 1, kind: 'user', state: 'observed', toolId: 'none', toolStatus: 'unknown' }),
    traceEntry({
      seq: 2,
      kind: 'tool-call',
      callId: 'call-memory-curate',
      toolId: 'memory.curate',
      toolStatus: 'failed',
      state: 'failed',
      error: {
        code: 'memory-agent-source-invalid',
        message: 'memory source reference is not authorized for this operation',
        ownerId: 'adapters.memory',
        evidenceRefs: [evidenceRef('evidence-memory-source', 'sha256:evidence-memory-source')],
      },
    }),
    traceEntry({
      seq: 3,
      kind: 'tool-result',
      callId: 'call-asset-read',
      toolId: 'asset.read',
      toolStatus: 'succeeded',
      state: 'succeeded',
      outputRef: 'asset://output/call-asset-read',
    }),
  ];

  return projectInteractionWorkCard({
    taskState: 'running',
    source: {
      state: 'ready',
      label: '交互卡片',
      detail: '来源：实时投影',
      updatedAt: TIME,
    },
    card: {
      source: {
        taskId: TASK,
        operationId: OPERATION,
        executionEpoch: 1,
        requestId: 'request-card-proof',
        turnId: 'turn-card-proof',
      },
      currentNode: 'provider.tool',
      ownerId: 'runtime.card-proof',
      nextStep: '读取授权描述符',
      nextAction: 'review-trace',
      waitingOn: 'provider',
      startedAt: TIME,
      provider: { state: 'ready', lastEventAt: TIME },
      transport: { connected: true, lastSyncedAt: TIME, cursor: 'cursor-card-proof-3' },
      settlement: { providerStopped: false, checkpointCommitted: false },
      lastBusiness: { kind: 'tool-result', at: TIME, ref: 'call-asset-read' },
    },
    conversation: {
      goal: { text: '整理工作区记忆并交付摘要' },
      scope: { text: '只读取授权来源' },
      constraints: [{ text: '不复制未授权正文' }],
      deliverables: [{ text: '结构化摘要一份' }],
      turns: [
        {
          sourceKind: 'user',
          occurredAt: TIME,
          markdown: '# 目标\n\n整理工作区记忆，**只读取授权来源**，输出 `summary.md`。\n\n- 保留原始结论\n- 标记不可用来源',
        },
        { sourceKind: 'progress', occurredAt: TIME, markdown: '正在读取授权来源，已等待 18.5 秒' },
        {
          sourceKind: 'error',
          occurredAt: TIME,
          markdown: '一个记忆来源不可用，其余来源继续处理。',
          error: {
            headline: '记忆来源不可用',
            nextStep: '等待 checkpoint 收拢后重试',
            details: { code: 'memory-agent-source-invalid', nextStep: '等待 checkpoint 收拢后重试' },
          },
        },
        {
          sourceKind: 'result',
          occurredAt: TIME,
          markdown: '## 结果\n\n- 已整理 **12** 条记忆\n- 已标记 1 个不可用来源',
          artifacts: [{ kind: 'output', ref: 'asset://output/summary', label: 'summary.md', mediaType: 'text/markdown' }],
        },
      ],
    },
    actions: [
      { id: 'review-trace', label: '查看轨迹', executable: true },
      { id: 'stop', label: '停止', executable: false, unavailableReason: '当前来源未授权停止' },
    ],
    history: {
      query: { filter: { taskId: TASK, operationId: OPERATION }, limit: 30, replay: true },
      result: {
        ok: true,
        page: {
          cursor: 'cursor-card-proof-older',
          hasMore: true,
          filter: { taskId: TASK, operationId: OPERATION },
          replay: true,
          items,
        },
      },
    },
    nodeCards: [{
      nodeId: 'memory.curation',
      title: '记忆整理',
      state: 'running',
      stateLabel: '运行中',
      readOnly: true,
      summary: '保留已授权来源的结论',
      inputDescriptors: [{ kind: 'reading', ref: 'asset://memory-source', label: 'memory-source.json' }],
      outputDescriptors: [],
    }],
  });
}

const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HumanAgent interaction work card proof</title>
  <link rel="stylesheet" href="/interaction-work-card.css">
</head>
<body>
  <main style="padding: 16px;">
    <div id="host" style="height: calc(100vh - 32px);"></div>
  </main>
  <script type="module">
    import { mountInteractionWorkCard } from '/interaction-work-card.js'
    window.__mountInteractionWorkCard = mountInteractionWorkCard
    window.__iwcReady = true
  </script>
</body>
</html>`;

/** Identifiers that must never appear in a human-facing surface. */
const TECHNICAL_TOKENS = Object.freeze([
  'request-card-proof',
  'turn-card-proof',
  'call-memory-curate',
  'call-asset-read',
  'sha256:',
  'asset://output/call-asset-read',
  'asset://arguments/',
  'evidenceId',
  'requestId',
  'turnId',
  'operation-card-proof',
  'task-card-proof',
]);

function mimeType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}

async function startServer() {
  const server = createServer(async (request, response) => {
    request.socket.setKeepAlive(false);
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/' || url.pathname === '/proof.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(HARNESS_HTML);
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!relative || relative.split('/').includes('..')) {
        response.writeHead(400);
        response.end('bad path');
        return;
      }
      const filePath = resolve(uiRoot, relative);
      if (!filePath.startsWith(`${uiRoot}${sep}`)) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': mimeType(filePath), 'content-length': body.byteLength });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('static server did not expose a TCP port');
  server.unref();
  return { server, port: address.port, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

const projection = makeProjection();
const artifactDir = join(evidenceRoot, 'artifacts');

await mkdir(artifactDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
let server;
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

try {
  server = await startServer();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));

  // --- isolated harness: three-part structure, markdown, separation --------
  await page.goto(`${server.url}/proof.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__iwcReady === true, undefined, { timeout: 15_000 });
  await page.evaluate((input) => {
    window.__mountInteractionWorkCard(document.querySelector('#host'), {}).update(input);
  }, projection);
  await page.screenshot({ path: join(artifactDir, 'harness.png'), fullPage: true });

  const card = await page.evaluate(() => {
    const panel = document.querySelector('#iwc-panel-conversation');
    const conversation = panel?.querySelector('.iwc-conversation-scroll');
    const details = [...document.querySelectorAll('.iwc-trace-details')].map((node) => node.innerText ?? '');
    return {
      card: Boolean(document.querySelector('.iwc-card')),
      status: document.querySelector('.iwc-status')?.innerText ?? '',
      tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
        id: tab.dataset.tab,
        label: tab.textContent,
        selected: tab.getAttribute('aria-selected'),
      })),
      conversationPanel: Boolean(panel),
      conversationVisible: panel?.hidden === false,
      summary: document.querySelector('.iwc-summary')?.innerText ?? '',
      conversationHtml: conversation?.innerHTML ?? '',
      conversationText: conversation?.innerText ?? '',
      markdown: {
        heading: panel?.querySelector('h3.iwc-md-heading, h4.iwc-md-heading, h5.iwc-md-heading, h6.iwc-md-heading')?.textContent ?? '',
        strong: panel?.querySelector('.iwc-md-paragraph strong')?.textContent ?? '',
        code: panel?.querySelector('.iwc-md-code')?.textContent ?? '',
        listItems: panel?.querySelectorAll('.iwc-md-list > li').length ?? 0,
        paragraph: panel?.querySelector('.iwc-md-paragraph')?.textContent ?? '',
      },
      traces: document.querySelectorAll('[data-trace-key]').length,
      detailBlocks: details.length,
      detailText: details.join('\n'),
      pageText: document.body.innerText,
    };
  });

  await writeFile(join(evidenceRoot, 'harness-text.txt'), card.pageText, 'utf8');

  if (pageErrors.length) {
    await writeFile(join(evidenceRoot, 'browser-errors.txt'), pageErrors.join('\n'), 'utf8');
    throw new Error(`harness page raised errors:\n${pageErrors.join('\n')}`);
  }

  record('card mounts', card.card);
  record('status bar renders lifecycle and source', card.status.includes('运行中') && card.status.includes('来源 交互卡片'), card.status.slice(0, 200));
  record('status bar is a distinct section from conversation and trace', card.status && card.conversationPanel && card.conversationVisible && card.traces >= 3, { traces: card.traces });
  record('status bar keeps the technical identity in a collapsed details block', card.pageText.includes('状态与技术身份'), card.status.slice(0, 120));
  record('conversation is the active of two semantic tabs', card.conversationPanel && card.conversationVisible && card.tabs.length === 2 && card.tabs[0]?.selected === 'true' && card.tabs[1]?.selected === 'false', card.tabs);
  record('conversation summary is human readable', card.summary.includes('整理工作区记忆并交付摘要') && card.summary.includes('只读取授权来源'), card.summary.slice(0, 200));
  record('markdown renders to structured elements', Boolean(card.markdown.heading)
    && card.markdown.strong.length > 0
    && card.markdown.code.length > 0
    && card.markdown.listItems >= 2
    && card.markdown.paragraph.length > 0, card.markdown);
  record('markdown is not shown as literal text', !card.conversationText.includes('**只读取授权来源**') && !card.conversationText.includes('# 目标') && !card.conversationText.includes('## 结果'), card.conversationText.slice(0, 300));
  record('trace panel renders one technical detail block per entry', card.traces >= 3 && card.detailBlocks === card.traces, { traces: card.traces, details: card.detailBlocks });
  record('human error semantics survive in the conversation', card.conversationText.includes('记忆来源不可用') && card.conversationText.includes('等待 checkpoint 收拢后重试'));
  record('progress turn reports elapsed wait time', card.conversationText.includes('已等待 18.5 秒'));
  record('unsupported action stays visible and non-executable', card.pageText.includes('当前来源未授权停止'));

  const leaks = [];
  for (const token of TECHNICAL_TOKENS) {
    if (card.conversationText.includes(token)) leaks.push({ surface: 'conversation', token });
    if (card.summary.includes(token)) leaks.push({ surface: 'summary', token });
    if (card.status.includes(token)) leaks.push({ surface: 'statusbar', token });
  }
  record('no technical identifier leaks into the human surfaces', leaks.length === 0, leaks);
  record('technical identifiers are retained in the trace detail blocks', card.detailText.includes('requestId') && card.detailText.includes('tool.callId') && card.detailText.includes('tool.outputDigest'), card.detailText.slice(0, 300));
  record('raw error semantics and evidence stay in the details', card.detailText.includes('memory-agent-source-invalid') && card.detailText.includes('sha256:evidence-memory-source') && card.detailText.includes('adapters.memory'), card.detailText.slice(0, 400));

  // --- real page static contract -------------------------------------------
  pageErrors.length = 0;
  for (const target of [
    { page: 'dashboard.html', entry: 'dashboard', artifact: 'dashboard' },
    { page: 'task.html', entry: 'task', artifact: 'task' },
  ]) {
    const rawHtml = await readFile(join(uiRoot, target.page), 'utf8');
    const staticContract = {
      mountMarker: rawHtml.includes('data-interaction-work-card'),
      entryMarker: rawHtml.includes(`data-entry="${target.entry}"`),
      stylesheet: rawHtml.includes('./interaction-work-card.css'),
    };
    observe(`${target.page} static contract`, staticContract);
    record(`static mount point exists in ${target.page}`, staticContract.mountMarker && staticContract.entryMarker, staticContract);
    record(`component stylesheet is linked in ${target.page}`, staticContract.stylesheet, staticContract);

    pageErrors.length = 0;
    await page.goto(`${server.url}/${target.page}`, { waitUntil: 'domcontentloaded' });
    const servedContract = await page.evaluate(() => ({
      stylesheet: [...document.querySelectorAll('link[rel="stylesheet"]')].map((node) => node.getAttribute('href')),
      scripts: [...document.querySelectorAll('script[type="module"]')].map((node) => node.getAttribute('src')),
    }));
    observe(`${target.page} served contract`, servedContract);
    record(`component stylesheet is served for ${target.page}`, servedContract.stylesheet.includes('./interaction-work-card.css'), servedContract.stylesheet);

    // Let the page's own module graph finish initialising.
    await page.waitForTimeout(3_000);
    observe(`${target.page} runtime page errors`, [...pageErrors]);
    const postInit = await page.evaluate((entry) => {
      const host = document.querySelector(`[data-interaction-work-card-host][data-entry="${entry}"]`);
      return {
        mountPointSurvived: Boolean(host),
        cardMounted: Boolean(document.querySelector('.iwc-card')),
        bodyChildren: document.body.childElementCount,
      };
    }, target.entry);
    observe(`${target.page} post-init`, {
      ...postInit,
      note: postInit.cardMounted
        ? 'page JS mounted the shared card component'
        : 'BLOCKED: page JS does not mount the shared card component and the static mount point does not survive page init',
    });
    await page.screenshot({ path: join(artifactDir, `${target.artifact}.png`), fullPage: true });
  }

  await writeFile(join(evidenceRoot, 'browser-checks.json'), JSON.stringify({ checks, observations }, null, 2), 'utf8');
  if (checks.length === 0) throw new Error('browser proof recorded no checks');
  if (failures > 0) {
    throw new Error(
      `interaction work card browser proof failed ${failures}/${checks.length}:\n${checks.filter((check) => !check.pass).map((check) => `  - ${check.name}: ${JSON.stringify(check.detail)}`).join('\n')}`,
    );
  }

  console.log(`interaction work card browser proof: ${checks.length} checks passed`);
  for (const check of checks) console.log(`  - ${check.name}`);
} finally {
  await browser.close().catch(() => {});
  await closeServer(server).catch(() => {});
}
