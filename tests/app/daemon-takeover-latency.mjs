#!/usr/bin/env node
// Focused measurement harness for task-14. It reproduces the real `hm serve`
// takeover from tests/app/app.test.ts against the compiled CLI and records, per
// iteration, how long the previous owner really takes to exit after SIGTERM.
//
// Modes:
//   --mode takeover  (default) spawn a real duplicate `hm serve` that takes over,
//                    exactly like the gate test.
//   --mode direct    the harness sends SIGTERM itself. This isolates the pure
//                    shutdown latency from the takeover machinery.
//
// The number that matters is measured by the harness (child 'exit' event), never
// by the product's own processIsAlive poll, so a false liveness verdict cannot
// contaminate the distribution.
//
// Usage:
//   node tests/app/daemon-takeover-latency.mjs --iterations 10 --out <dir> \
//     [--mode takeover|direct] [--no-probe] [--no-pair] [--load N] [--exit-cap-ms 30000]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(name);

const iterations = Number(option('--iterations', '10'));
const mode = option('--mode', 'takeover');
const outDir = resolve(option('--out', 'raw/task14/iterations'));
const exitCapMs = Number(option('--exit-cap-ms', '30000'));
const loadProcesses = Number(option('--load', '0'));
const useProbe = !flag('--no-probe');
const pairFirst = !flag('--no-pair');
const cli = resolve('dist/app/app/src/cli.js');
const probePath = resolve('tests/app/daemon-shutdown-probe.mjs');
const repoRoot = process.cwd();

if (mode !== 'takeover' && mode !== 'direct') throw new Error(`unknown --mode ${mode}`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const now = () => Date.now();

function spawnServe({ workspace, controlRoot, probeFile, json = false }) {
  const args = [cli, 'serve', '--workspace', workspace, '--control-root', controlRoot];
  args.push(...(json ? ['--mode', 'fake', '--port', '0', '--json'] : ['--provider', 'fake', '--port', '0']));
  const env = { ...process.env };
  if (probeFile !== undefined) {
    env.HA_SHUTDOWN_PROBE = probeFile;
    env.HA_SHUTDOWN_PROBE_SYNC = '1';
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(probePath).href}`.trim();
  }
  return spawn(process.execPath, args, { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'], env });
}

function awaitStartup(child, budgetMs) {
  return new Promise((done) => {
    let output = '';
    let stderr = '';
    let settled = false;
    const started = now();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'startup-timeout', output, stderr, ms: now() - started }), budgetMs);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      try {
        const parsed = JSON.parse(output.trim());
        if (parsed?.url) finish({ ok: true, url: parsed.url, memoryRoot: parsed.memoryRoot, ms: now() - started, output, stderr });
      } catch {
        // Partial JSON while the CLI is still starting.
      }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish({ ok: false, reason: `spawn-error:${error.message}`, output, stderr, ms: now() - started }));
    child.once('exit', (code) => finish({ ok: false, reason: `exited-before-startup:${String(code)}`, output, stderr, ms: now() - started }));
  });
}

function awaitExit(child, capMs) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done({ exited: true, code: child.exitCode, ms: 0 });
      return;
    }
    const started = now();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    const timer = setTimeout(() => finish({ exited: false, code: null, ms: now() - started }), capMs);
    child.once('exit', (code) => finish({ exited: true, code, ms: now() - started }));
  });
}

async function runPair(workspace, controlRoot, url) {
  const pair = spawn(process.execPath, [cli, 'pair', '--workspace', workspace, '--control-root', controlRoot], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  pair.stdout.on('data', (chunk) => { stdout += String(chunk); });
  pair.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const code = await new Promise((done) => pair.once('exit', (exitCode) => done(exitCode)));
  if (code !== 0) return { ok: false, reason: `pair exited ${String(code)}: ${stderr.slice(-300)}` };
  let receipt;
  try {
    receipt = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, reason: `pair did not return JSON: ${stdout.slice(-200)}` };
  }
  const origin = new URL(url).origin;
  const response = await fetch(`${origin}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ code: receipt.code }),
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, reason: `pairing failed ${response.status}: ${text.slice(0, 300)}` };
  return { ok: true, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

async function readProbe(file) {
  try {
    const text = await (await import('node:fs/promises')).readFile(file, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function stageMs(events, from, to) {
  const a = events.find((event) => event.event === from);
  const b = events.find((event) => event.event === to);
  return a && b ? b.rel - a.rel : null;
}

const startedLoad = [];
if (loadProcesses > 0) {
  for (let index = 0; index < loadProcesses; index += 1) {
    const busy = spawn(process.execPath, ['-e', 'const t=Date.now();while(Date.now()-t<900000){for(let i=0;i<1e5;i++){Math.sqrt(i)}}'], { stdio: 'ignore' });
    startedLoad.push(busy);
  }
  await sleep(1_500);
}

await mkdir(outDir, { recursive: true });
const jsonlPath = join(outDir, `iterations-${mode}${useProbe ? '' : '-noprobe'}${loadProcesses > 0 ? `-load${loadProcesses}` : ''}.jsonl`);
await writeFile(jsonlPath, '', 'utf8');

const rows = [];
for (let index = 0; index < iterations; index += 1) {
  const root = await mkdtemp(join(tmpdir(), 'ha-takeover-latency-'));
  const controlRoot = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const probeFile = join(outDir, `probe-${mode}-${index}.jsonl`);
  if (useProbe) await writeFile(probeFile, '', 'utf8');

  const row = { index, mode, load: loadProcesses, probe: useProbe, at: { start: now() } };
  let first;
  let duplicate;
  try {
    first = spawnServe({ workspace, controlRoot, probeFile: useProbe ? probeFile : undefined });
    const startup = await awaitStartup(first, 5_000);
    row.firstStartup = { ok: startup.ok, ms: startup.ms, reason: startup.reason };
    if (!startup.ok) throw new Error(`first serve failed to start: ${startup.reason}`);
    row.url = startup.url;

    if (pairFirst) {
      const paired = await runPair(workspace, controlRoot, startup.url);
      row.pair = paired.ok ? 'ok' : paired.reason;
    }

    if (mode === 'direct') {
      row.sigtermAt = now();
      first.kill('SIGTERM');
      const exited = await awaitExit(first, exitCapMs);
      row.firstExit = { exited: exited.exited, code: exited.code, ms: exited.ms, at: now() };
      row.sigtermToFirstExitMs = row.firstExit.at - row.sigtermAt;
    } else {
      const duplicateSpawnAt = now();
      row.at.duplicateSpawn = duplicateSpawnAt;
      const duplicateProbeFile = join(outDir, `probe-takeover-duplicate-${index}.jsonl`);
      if (useProbe) await writeFile(duplicateProbeFile, '', 'utf8');
      duplicate = spawnServe({ workspace, controlRoot, json: true, probeFile: useProbe ? duplicateProbeFile : undefined });
      const duplicateStartup = await awaitStartup(duplicate, 5_000);
      row.duplicateSpawnToStartup = { ok: duplicateStartup.ok, ms: duplicateStartup.ms, reason: duplicateStartup.reason };
      row.duplicateStderr = duplicateStartup.stderr.trim().slice(-600);
      row.at.duplicateVerdict = now();
      const exited = await awaitExit(first, exitCapMs);
      row.firstExit = { exited: exited.exited, code: exited.code, ms: now() - duplicateSpawnAt, at: now() };
      if (useProbe) {
        const duplicateEvents = await readProbe(duplicateProbeFile);
        const identityStart = duplicateEvents.find((event) => event.event === 'fetch.identity-fetch.start');
        const identityResponse = duplicateEvents.find((event) => event.event === 'fetch.identity-fetch.response');
        row.taker = {
          identityFetchMs: identityStart && identityResponse ? identityResponse.rel - identityStart.rel : null,
          identityFetchStatus: identityResponse?.status ?? null,
          eventCount: duplicateEvents.length,
        };
      }
    }
  } catch (error) {
    row.harnessError = error instanceof Error ? error.message : String(error);
  } finally {
    if (first !== undefined) {
      if (first.exitCode === null) first.kill('SIGTERM');
      await awaitExit(first, 5_000);
      if (first.exitCode === null) first.kill('SIGKILL');
    }
    if (duplicate !== undefined) {
      if (duplicate.exitCode === null) duplicate.kill('SIGTERM');
      await awaitExit(duplicate, 5_000);
      if (duplicate.exitCode === null) duplicate.kill('SIGKILL');
    }
    await rm(root, { recursive: true, force: true });
  }

  if (useProbe) {
    const events = await readProbe(probeFile);
    row.probe = {
      sigtermToExit: stageMs(events, 'sigterm.received', 'process.exit'),
      sigtermToClose: stageMs(events, 'sigterm.received', 'server.close.called'),
      sigtermToCloseIdle: stageMs(events, 'sigterm.received', 'server.closeIdleConnections'),
      closeToCloseCallback: stageMs(events, 'server.close.called', 'server.close.callback'),
      closeCallbackToExit: stageMs(events, 'server.close.callback', 'process.exit'),
      closeCallbackSeen: events.some((event) => event.event === 'server.close.callback'),
      connectionsAtCloseIdle: events.find((event) => event.event === 'server.closeIdleConnections')?.connections ?? null,
      connectionsAtClose: events.find((event) => event.event === 'server.close.called')?.connections ?? null,
      beforeExitHandles: events.find((event) => event.event === 'beforeExit')?.handles ?? null,
      eventCount: events.length,
    };
  }

  rows.push(row);
  console.log(JSON.stringify(row));
  await writeFile(jsonlPath, `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[position];
}

const exitLatencies = rows.map((row) => row.firstExit?.ms).filter((value) => typeof value === 'number');
const probeLatencies = rows.map((row) => row.probe?.sigtermToExit).filter((value) => typeof value === 'number');
const summary = {
  mode,
  load: loadProcesses,
  probe: useProbe,
  iterations,
  measuredExitLatencyMs: {
    count: exitLatencies.length,
    min: exitLatencies.length ? Math.min(...exitLatencies) : null,
    median: percentile(exitLatencies, 0.5),
    p95: percentile(exitLatencies, 0.95),
    max: exitLatencies.length ? Math.max(...exitLatencies) : null,
    over2000: exitLatencies.filter((value) => value > 2_000).length,
    values: exitLatencies,
  },
  probeSigtermToExitMs: {
    count: probeLatencies.length,
    min: probeLatencies.length ? Math.min(...probeLatencies) : null,
    median: percentile(probeLatencies, 0.5),
    p95: percentile(probeLatencies, 0.95),
    max: probeLatencies.length ? Math.max(...probeLatencies) : null,
    over2000: probeLatencies.filter((value) => value > 2_000).length,
    values: probeLatencies,
  },
  takeoverFailures: rows.filter((row) => row.duplicateSpawnToStartup && row.duplicateSpawnToStartup.ok === false).length,
  harnessErrors: rows.filter((row) => row.harnessError !== undefined).length,
  jsonl: jsonlPath,
};
console.log(`SUMMARY ${JSON.stringify(summary)}`);
await writeFile(join(outDir, `summary-${mode}${useProbe ? '' : '-noprobe'}${loadProcesses > 0 ? `-load${loadProcesses}` : ''}.json`), `${JSON.stringify({ summary, rows }, null, 2)}\n`, 'utf8');

for (const busy of startedLoad) {
  if (busy.exitCode === null) busy.kill('SIGKILL');
}
