/**
 * Authoritative journal reader + turn/tool counters + terminal assertion.
 *
 * Owns graph node: local_search_terminal (per-command graphs) and the evidence
 * step of the failure chain.
 *
 * The serve composes its journals under the attempt's control root:
 *   <controlRoot>/sessions/<projectKey>/checkpoints/<mode>/ui-runtime-journal.jsonl
 *     carries every RuntimeTaskEvent — provider request-start, provider.tool,
 *     provider.tool-result and execution.terminal;
 *   <controlRoot>/sessions/<projectKey>/checkpoints/<mode>/task-<id>-cycle-<id>.jsonl
 *     carries the committed checkpoints.
 * `<controlRoot>/main/sessions` is the memory runtime and is NOT the task
 * journal, so it must never be used as evidence.
 *
 * Counters are read from those journals, never from `dashboard.recentEvents`,
 * which is a 20-event window flooded by reasoning events (it previously reported
 * `0 provider.tool rounds` on a task that had executed 11). Every counter is
 * structurally defined below and returns zero only when the journal truly
 * contains nothing matching.
 */

import { readdir, stat, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

const KIND_PREFIX = (kind) => String(kind ?? '').split(' · ')[0];

/** Recursively collect regular files under root, newest mtime first. */
async function walkNewest(root, limit = 400) {
  const results = [];
  let entries = [];
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    // With `recursive: true` each entry's `path` is its PARENT directory and its
    // `name` is the basename, so the full path is parent + name.
    const full = entry.path && entry.name
      ? join(entry.path, entry.name)
      : join(root, entry.name ?? '');
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    results.push({ path: full, mtime: info.mtimeMs, size: info.size });
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

/** Resolve the authoritative task journal for this attempt. */
export async function journalPathFor(binding) {
  const controlRoot = binding.serveControlRoot ?? binding.controlRoot;
  const newest = await walkNewest(controlRoot, 400);
  const events = newest.filter((entry) => /ui-runtime-journal\.jsonl$/.test(entry.path));
  if (events.length === 0) {
    throw new Error(`no ui-runtime-journal.jsonl under ${controlRoot}`);
  }
  const checkpointFiles = newest
    .filter((entry) => /(^|\/)task-[^\s]+-cycle-[^\s]+\.jsonl$/.test(entry.path))
    .map((entry) => entry.path);
  binding.journalPath = events[0].path;
  binding.journalPaths = [events[0].path, ...checkpointFiles];
  return events[0].path;
}

/** Parse a JSONL journal into records, keeping file order. */
export async function readJournalEvents(journalPath) {
  const text = await readFile(journalPath, 'utf8');
  const records = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const record = JSON.parse(trimmed);
      record.__seq = record.seq ?? index;
      records.push(record);
    } catch {
      // a partial final line is ignored; a corrupt line is never fabricated
    }
  });
  return records;
}

function eventEnvelope(record) {
  if (!record || typeof record !== 'object') return null;
  // Event records carry {kind:'event', event:{kind,state,...}}; checkpoints are
  // {kind:'checkpoint', checkpoint:{...}}. Accept both nested and flat shapes.
  const inner = record.event ?? record;
  const kind = inner.kind ?? record.kind;
  if (kind === 'checkpoint') return null;
  return inner;
}

/**
 * Count turn and tool evidence from the authoritative journals.
 *
 * requestStartTurns — provider request-start rows: counted by `kind` prefix
 * `provider.request-start` when the projection carries one, otherwise by the
 * exact summary `provider requested model work`, so a projection rename still
 * counts structurally.
 *
 * toolRounds — provider tool calls paired with tool results. A round is counted
 * only when BOTH sides exist, because an unpaired call is not verifiable
 * execution evidence.
 *
 * checkpointCommitted — committed checkpoint records whose outcome is
 * `succeeded`.
 */
export async function countTurnEvidence(journalPath, options = {}) {
  const paths = (options.paths ?? (journalPath ? [journalPath] : [])).filter(Boolean);
  const records = [];
  for (const path of paths) {
    records.push(...await readJournalEvents(path).catch(() => []));
  }
  const events = records.map(eventEnvelope).filter(Boolean);
  const tools = events.filter((event) => KIND_PREFIX(event.kind) === 'provider.tool');
  const toolResults = events.filter((event) => KIND_PREFIX(event.kind) === 'provider.tool-result');
  const checkpoints = records.filter((record) => record.kind === 'checkpoint');
  const terminals = events.filter((event) => KIND_PREFIX(event.kind) === 'execution.terminal');
  const requestStarts = events.filter(
    (event) => KIND_PREFIX(event.kind) === 'provider.request-start'
      || event.summary === 'provider requested model work');

  return {
    journalPath,
    journalPaths: paths,
    recordCount: records.length,
    eventCount: events.length,
    requestStartTurns: requestStarts.length,
    providerToolCalls: tools.length,
    providerToolResults: toolResults.length,
    toolRounds: Math.min(tools.length, toolResults.length),
    checkpointCommitted: checkpoints.filter((record) => {
      const outcome = record.checkpoint?.outcome ?? record.outcome;
      return outcome === 'succeeded';
    }).length,
    terminalRecords: terminals.map((event) => ({
      seq: event.seq ?? null,
      state: event.state ?? null,
      summary: event.summary ?? null,
      owner: event.owner ?? event.ownerId ?? null,
    })),
    toolCallIds: tools.map((event) => event.callId ?? event.toolId ?? event.summary ?? null),
    toolResultIds: toolResults.map((event) => event.callId ?? event.toolId ?? event.summary ?? null),
    allEvents: events.map((event) => ({
      seq: event.seq ?? null,
      kind: event.kind ?? null,
      state: event.state ?? null,
      status: event.status ?? null,
      summary: event.summary ?? null,
      callId: event.callId ?? null,
      toolId: event.toolId ?? null,
      error: event.error ?? null,
      outputRef: event.outputRef ?? null,
      outputDigest: event.outputDigest ?? null,
      evidenceRefs: event.evidenceRefs ?? null,
    })),
  };
}

/** Count the evidence for one attempt's journal plus its checkpoint files. */
export async function countTurnEvidenceFor(binding) {
  const paths = (binding.journalPaths ?? [binding.journalPath]).filter(Boolean);
  if (paths.length === 0) return null;
  return countTurnEvidence(paths[0], { paths });
}

/** Assert a verifiable terminal from the authoritative journals. */
export async function assertVerifiableTerminal(journalPath, options = {}) {
  const evidence = await countTurnEvidence(journalPath, options);
  const terminal = evidence.terminalRecords
    .filter((entry) => entry.state && entry.state !== 'failed')
    .slice(-1)[0]
    ?? evidence.terminalRecords.slice(-1)[0]
    ?? null;
  if (!terminal && evidence.terminalRecords.length === 0) {
    throw new Error(
      `journal has no execution.terminal record (${evidence.recordCount} records, ${evidence.eventCount} events)`);
  }
  const missing = [];
  if (evidence.toolRounds < (options.minToolRounds ?? 1)) missing.push(`toolRounds=${evidence.toolRounds}`);
  if (evidence.checkpointCommitted < (options.minCheckpoints ?? 1)) missing.push('committedCheckpoints=0');
  if (missing.length) {
    throw new Error(`terminal reached but evidence is incomplete: ${missing.join(', ')}; terminal=${JSON.stringify(terminal)}`);
  }
  return {
    terminal,
    toolRounds: evidence.toolRounds,
    requestStartTurns: evidence.requestStartTurns,
    checkpointCommitted: evidence.checkpointCommitted,
    evidenceRefs: evidence.allEvents
      .flatMap((event) => (Array.isArray(event.evidenceRefs) ? event.evidenceRefs : []))
      .slice(0, 40),
    allEvents: evidence.allEvents,
  };
}

/** Assert a verifiable terminal for one attempt. */
export async function assertTerminalFor(binding, options = {}) {
  const paths = (binding.journalPaths ?? [binding.journalPath]).filter(Boolean);
  if (paths.length === 0) throw new Error('no journal path was resolved');
  return assertVerifiableTerminal(paths[0], { paths, ...options });
}

/**
 * Snapshot the workspace as a sorted list of { relPath, sha256, size }.
 * Used to prove the local-file-search run left the workspace byte-identical.
 */
export async function workspaceManifest(workspace) {
  const { createHash } = await import('node:crypto');
  const files = [];
  const walk = async (dir, rel = '') => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const path = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        await walk(path, relPath);
        continue;
      }
      if (name === '.DS_Store') continue;
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      const body = await readFile(path);
      files.push({
        relPath,
        sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        size: body.byteLength,
      });
    }
  };
  await walk(workspace);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

export function manifestsIdentical(before, after) {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i += 1) {
    if (before[i].relPath !== after[i].relPath || before[i].sha256 !== after[i].sha256) return false;
  }
  return true;
}

export { basename as baseName };
