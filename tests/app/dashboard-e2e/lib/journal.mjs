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

import { readdir, stat, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { taskIdValue } from './binding.mjs';

const KIND_PREFIX = (kind) => String(kind ?? '').split(' · ')[0];
const RUNNER_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CHECKPOINT_FILE_NAME = /^task-[^\s]+-cycle-[^\s]+\.jsonl$/;
const OPERATION_LOCATOR = /^operation\/([^/]+)\/checkpoint$/;
const CHECKPOINT_RECOVERY_LOCATOR = /^operation\/([^/]+)\/checkpoint-recovery$/;

let authoritativeClasses;

/**
 * Load the two existing public validation owners from the built candidate:
 * `JsonlOrganJournal` for authoritative checkpoint records and
 * `UiRuntimeJournal` for the UI projection / tool-fact chain. The runner never
 * reimplements either validator and fails closed when the build output is
 * missing.
 */
async function loadAuthoritativeClasses(repoPath = RUNNER_REPO) {
  if (authoritativeClasses && authoritativeClasses.repoPath === resolve(repoPath)) return authoritativeClasses;
  const jsonlPath = join(resolve(repoPath), 'dist', 'app', 'adapters', 'jsonl', 'src', 'index.js');
  const uiPath = join(resolve(repoPath), 'dist', 'app', 'app', 'src', 'ui-runtime', 'journal.js');
  const [jsonl, ui] = await Promise.all([
    import(pathToFileURL(jsonlPath).href),
    import(pathToFileURL(uiPath).href),
  ]);
  if (typeof jsonl.JsonlOrganJournal !== 'function') {
    throw new Error(`${jsonlPath} does not export JsonlOrganJournal`);
  }
  if (typeof ui.UiRuntimeJournal !== 'function') {
    throw new Error(`${uiPath} does not export UiRuntimeJournal`);
  }
  authoritativeClasses = {
    repoPath: resolve(repoPath),
    JsonlOrganJournal: jsonl.JsonlOrganJournal,
    UiRuntimeJournal: ui.UiRuntimeJournal,
  };
  return authoritativeClasses;
}

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
  const attached = binding.serviceMode === 'installed-attach';
  const controlRoot = binding.serveControlRoot
    ?? (attached ? (binding.journalControlRoot ?? binding.formalPaths?.controlRoot) : binding.controlRoot);
  if (!controlRoot) throw new Error('journalPathFor requires a resolved control root');
  const projectKey = attached
    ? (binding.journalProjectKey ?? binding.formalPaths?.projectKey ?? null)
    : (binding.projectKey ?? binding.runtimePaths?.projectKey ?? null);
  const taskId = binding.taskId ?? binding.scope?.taskId ?? null;
  if (!projectKey) throw new Error('journalPathFor requires the config-derived projectKey');
  const mode = binding.journalMode ?? 'rcc';
  if (taskId) {
    const exact = join(controlRoot, 'sessions', projectKey, 'checkpoints', mode, 'ui-runtime-journal.jsonl');
    const checkpointDir = join(controlRoot, 'sessions', projectKey, 'checkpoints', mode);
    let checkpointFiles = [];
    try {
      checkpointFiles = (await readdir(checkpointDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^task-[^\s]+-cycle-[^\s]+\.jsonl$/.test(entry.name))
        .map((entry) => join(checkpointDir, entry.name));
    } catch {
      checkpointFiles = [];
    }
    try {
      await readFile(exact, 'utf8');
      binding.journalPath = exact;
      binding.journalPaths = [exact, ...checkpointFiles];
      return exact;
    } catch (error) {
      throw new Error(`no same-project ui-runtime-journal.jsonl at ${exact}: ${error.message}`);
    }
  }
  const journalRoot = join(controlRoot, 'sessions', projectKey, 'checkpoints', mode, 'ui-runtime-journal.jsonl');
  const newest = await walkNewest(controlRoot, 400);
  const events = newest.filter((entry) => entry.path === journalRoot);
  if (events.length === 0) {
    throw new Error(`no ui-runtime-journal.jsonl for project ${projectKey} under ${controlRoot}`);
  }
  const checkpointFiles = newest
    .filter((entry) => (
      entry.path.startsWith(join(controlRoot, 'sessions', projectKey, 'checkpoints', mode))
      && /(^|\/)task-[^\s]+-cycle-[^\s]+\.jsonl$/.test(entry.path)
    ))
    .map((entry) => entry.path);
  binding.journalPath = events[0].path;
  binding.journalPaths = [events[0].path, ...checkpointFiles];
  return events[0].path;
}

/** The project-scoped journal root the serve writes for one mode. */
export function journalRootFor(binding, mode = 'rcc') {
  const attached = binding.serviceMode === 'installed-attach';
  const controlRoot = binding.serveControlRoot
    ?? (attached ? (binding.journalControlRoot ?? binding.formalPaths?.controlRoot) : binding.controlRoot);
  const projectKey = attached
    ? (binding.journalProjectKey ?? binding.formalPaths?.projectKey ?? null)
    : (binding.projectKey ?? binding.runtimePaths?.projectKey ?? null);
  if (!controlRoot || !projectKey) return null;
  return join(controlRoot, 'sessions', projectKey, 'checkpoints', mode);
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

/** The authoritative checkpoint journal files the config-derived path resolver listed. */
export function isCheckpointJournalFile(path) {
  return CHECKPOINT_FILE_NAME.test(basename(String(path ?? '')));
}

function parseLooseJournal(text, path) {
  const records = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record === 'object' && record.__position === undefined) {
        record.__position = index;
      }
      records.push(record);
    } catch (error) {
      throw new Error(`${path}: damaged journal record at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return records;
}

function withPosition(record, index) {
  if (record && typeof record === 'object' && record.__position === undefined) {
    Object.defineProperty(record, '__position', { value: index, enumerable: false, configurable: true });
  }
  return record;
}

/**
 * Strict read used by the settlement proof.
 *
 * The UI projection journal is validated by `UiRuntimeJournal.replay()` and the
 * authoritative checkpoint files by `JsonlOrganJournal.verify()`. Only records
 * from a `valid=true` verification are consumed; an unreadable/missing file, a
 * damaged line, a broken digest/predecessor link or a corrupt UI operation/tool
 * fact is returned as an explicit error. No validator logic is reimplemented
 * here. The tolerant historical counter (`readJournalEvents`) is unchanged.
 */
export async function readJournalStrict(paths, options = {}) {
  const list = [...new Set((Array.isArray(paths) ? paths : [paths]).filter(Boolean).map((path) => resolve(path)))];
  if (list.length === 0) return { ok: false, records: [], error: 'no journal path was resolved' };
  let classes;
  try {
    classes = await loadAuthoritativeClasses(options.repoPath);
  } catch (error) {
    return { ok: false, records: [], error: `public Journal validators unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }

  const uiPaths = [];
  const checkpointPaths = [];
  for (const path of list) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      return { ok: false, records: [], error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    let parsed;
    try {
      parsed = parseLooseJournal(text, path);
    } catch (error) {
      return { ok: false, records: [], error: error instanceof Error ? error.message : String(error) };
    }
    if (isCheckpointJournalFile(path)) {
      checkpointPaths.push(path);
    } else if (basename(path) === 'ui-runtime-journal.jsonl') {
      uiPaths.push(path);
    } else if (parsed.some((record) => record?.kind === 'checkpoint')) {
      // A caller may point the settlement proof at a checkpoint journal without
      // the canonical task-cycle file name; classify it by its real record kind.
      checkpointPaths.push(path);
    } else {
      uiPaths.push(path);
    }
  }

  const records = [];
  const checkpointRecords = [];
  for (const path of uiPaths) {
    let uiRecords;
    try {
      uiRecords = new classes.UiRuntimeJournal(path).replay();
    } catch (error) {
      return { ok: false, records: [], error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    uiRecords.forEach((record, index) => records.push(withPosition(record, index)));
  }
  for (const path of checkpointPaths) {
    let verification;
    try {
      verification = await new classes.JsonlOrganJournal(path).verify();
    } catch (error) {
      return { ok: false, records: [], error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!verification.valid) {
      return { ok: false, records: [], error: `${path}: ${verification.error ?? 'journal is invalid'}` };
    }
    verification.records.forEach((record, index) => {
      records.push(withPosition(record, index));
      if (record.kind === 'checkpoint' && record.checkpoint) checkpointRecords.push(record);
    });
  }
  return { ok: true, records, checkpointRecords, error: null };
}

function eventEnvelope(record) {
  if (!record || typeof record !== 'object') return null;
  // Event records carry {kind:'event', event:{kind,state,...}}; checkpoints are
  // {kind:'checkpoint', checkpoint:{...}}. Accept both nested and flat shapes.
  const inner = record.event ?? record;
  const kind = inner.kind ?? record.kind;
  if (kind === 'checkpoint') return null;
  if (record.kind === 'operation.event' && record.event && typeof record.event === 'object') {
    return {
      ...record.event,
      __outerTaskId: record.taskId,
      __outerOperationId: record.operationId,
      __outerExecutionEpoch: record.executionEpoch,
    };
  }
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
  return countTurnEvidenceFromRecords(records, paths, journalPath);
}

/** Pure counter over already-parsed journal records (shared by strict reads). */
export function countTurnEvidenceFromRecords(records, paths, journalPath = paths?.[0] ?? null) {
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
      arguments: event.arguments ?? null,
      error: event.error ?? null,
      outputRef: event.outputRef ?? null,
      outputDigest: event.outputDigest ?? null,
      evidenceRefs: event.evidenceRefs ?? null,
    })),
  };
}

function idValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' && value !== null ? value.value : String(value);
}

function sameIdOrString(left, right) {
  const a = idValue(left);
  const b = idValue(right);
  return a !== null && b !== null && a === b;
}

function eventScopeOf(event) {
  const taskId = event.taskId ?? event.__outerTaskId ?? event.scope?.taskId ?? null;
  const cycleId = event.cycleId ?? event.scope?.cycleId ?? null;
  const operationId = event.operationId ?? event.__outerOperationId ?? event.scope?.operationId ?? null;
  const organId = event.organId ?? event.scope?.organId ?? null;
  const executionEpoch = event.executionEpoch ?? event.__outerExecutionEpoch ?? event.scope?.executionEpoch ?? null;
  return {
    organId,
    taskId,
    ...(cycleId ? { cycleId } : {}),
    ...(operationId ? { operationId } : {}),
    ...(executionEpoch !== null ? { executionEpoch } : {}),
  };
}

function expectedScopeOf(binding) {
  const scope = binding.scope ?? null;
  return {
    organId: binding.organId ?? scope?.organId ?? null,
    taskId: binding.taskId ?? scope?.taskId ?? null,
    operationId: binding.operationId ?? scope?.operationId ?? null,
    cycleId: binding.cycleId ?? scope?.cycleId ?? null,
    executionEpoch: binding.executionEpoch ?? scope?.executionEpoch ?? null,
  };
}

function hasRequiredScope(scope) {
  return scope.taskId !== null
    && scope.operationId !== null
    && Number.isSafeInteger(scope.executionEpoch)
    && scope.executionEpoch > 0;
}

function matchesExpectedScope(actual, expected, options = {}) {
  if (expected.taskId !== null && !sameIdOrString(actual.taskId, expected.taskId)) return false;
  if (expected.operationId !== null && !sameIdOrString(actual.operationId, expected.operationId)) return false;
  if (options.requireCycle !== false && expected.cycleId !== null && !sameIdOrString(actual.cycleId, expected.cycleId)) return false;
  if (expected.executionEpoch !== null && actual.executionEpoch !== expected.executionEpoch) return false;
  return true;
}

function sameOperationScope(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  const leftTask = idValue(left.taskId);
  const rightTask = idValue(right.taskId);
  const leftOperation = idValue(left.operationId);
  const rightOperation = idValue(right.operationId);
  if (!leftTask || !rightTask || leftTask !== rightTask) return false;
  if (leftOperation !== rightOperation) return false;
  if (left.executionEpoch !== undefined && right.executionEpoch !== undefined
    && left.executionEpoch !== right.executionEpoch) return false;
  return true;
}

/**
 * Resolve the real execution identity from verified `operation.started`
 * records. This is the only allowed source of organ/cycle identity: it is never
 * guessed from operation names, checkpoint ids, summaries or file names.
 */
export function executionIdentityFromRecords(records, binding) {
  const expected = expectedScopeOf(binding);
  const starts = records.filter((record) => record?.kind === 'operation.started');
  const matches = starts.filter((record) => {
    if (expected.taskId !== null && !sameIdOrString(record.taskId, expected.taskId)) return false;
    if (expected.operationId !== null && !sameIdOrString(record.operationId, expected.operationId)) return false;
    if (expected.cycleId !== null && !sameIdOrString(record.cycleId, expected.cycleId)) return false;
    if (expected.organId !== null && !sameIdOrString(record.scope?.organId, expected.organId)) return false;
    if (expected.executionEpoch !== null && record.executionEpoch !== expected.executionEpoch) return false;
    return true;
  });
  if (matches.length === 0) {
    return { ok: false, reason: 'no verified operation.started record matches the attempt task/operation' };
  }
  if (matches.length > 1 && expected.operationId === null) {
    return { ok: false, reason: 'ambiguous verified operation.started records for the attempt task; operationId is required to disambiguate' };
  }
  const record = matches[matches.length - 1];
  return {
    ok: true,
    identity: {
      organId: record.scope?.organId ?? null,
      taskId: record.taskId ?? null,
      cycleId: record.cycleId ?? null,
      operationId: record.operationId ?? null,
      executionEpoch: record.executionEpoch ?? null,
      scope: record.scope ?? null,
    },
  };
}

/**
 * Resolve the attempt's execution identity from the verified public journals.
 * Used before a stop is issued so the harness never guesses cycle/epoch and
 * never sends a stop while the identity is still unknown.
 */
export async function resolveExecutionIdentity(binding, options = {}) {
  const paths = (binding.journalPaths ?? [binding.journalPath]).filter(Boolean);
  const read = await readJournalStrict(paths, { repoPath: options.repoPath ?? binding.repoPath });
  if (!read.ok) return { ok: false, reason: read.error };
  return executionIdentityFromRecords(read.records, binding);
}

function checkpointScopeOf(checkpoint) {
  const scope = checkpoint?.scope ?? {};
  return {
    organId: scope.organId ?? null,
    taskId: scope.taskId ?? null,
    cycleId: scope.cycleId ?? checkpoint?.cycleId ?? null,
    operationId: scope.operationId ?? null,
    executionEpoch: checkpoint?.executionEpoch ?? null,
  };
}

function sameScopedScope(left, right) {
  if (!left || !right) return left === right;
  for (const key of ['organId', 'taskId', 'cycleId', 'operationId']) {
    const a = idValue(left[key]);
    const b = idValue(right[key]);
    if ((a === null) !== (b === null)) return false;
    if (a !== null && a !== b) return false;
  }
  return true;
}

function sameEvidenceRef(left, right) {
  if (!left || !right) return false;
  if (idValue(left.evidenceId) !== idValue(right.evidenceId)) return false;
  if (left.kind !== right.kind || left.source !== right.source || left.locator !== right.locator) return false;
  return sameScopedScope(left.scope, right.scope);
}

/**
 * A business checkpoint may be committed with a scope that has no
 * `operationId`. The runtime still links it to the owning operation through the
 * recovery state ref and the operation checkpoint evidence ref; accept exactly
 * that shape instead of requiring an operation id the runtime never wrote.
 */
function checkpointOperationLink(checkpoint, expectedOperation) {
  const scopeOperation = idValue(checkpoint.scope?.operationId);
  const expected = idValue(expectedOperation);
  if (scopeOperation !== null) return scopeOperation === expected;
  const recovery = checkpoint.recoveryStateRef;
  if (!recovery || recovery.kind !== 'operation' || recovery.source !== 'humanagent.runtime') return false;
  const recoveryMatch = CHECKPOINT_RECOVERY_LOCATOR.exec(String(recovery.locator ?? ''));
  if (!recoveryMatch || recoveryMatch[1] !== expected) return false;
  const evidenceRefs = Array.isArray(checkpoint.evidenceRefs) ? checkpoint.evidenceRefs : [];
  return evidenceRefs.some((ref) => {
    if (!ref || ref.kind !== 'operation' || ref.source !== 'humanagent.runtime') return false;
    const match = OPERATION_LOCATOR.exec(String(ref.locator ?? ''));
    return match !== null && match[1] === expected;
  });
}

function checkpointProjectionOperationMatches(checkpoint, operationEvents, expectedOperation) {
  // The runtime's business checkpoint deliberately carries the operation only in
  // its evidence refs. The matching projection event is the authoritative
  // operation boundary, so a foreign operation's identical evidence refs cannot
  // be used to claim this checkpoint.
  const expectedRefs = Array.isArray(checkpoint.evidenceRefs) ? checkpoint.evidenceRefs : [];
  if (expectedRefs.length === 0) return false;
  const committed = operationEvents.filter((event) => KIND_PREFIX(event.kind) === 'checkpoint.committed');
  return committed.some((event) => {
    const operationId = event.operationId ?? event.__outerOperationId ?? null;
    if (!sameIdOrString(operationId, expectedOperation)) return false;
    const projected = Array.isArray(event.evidenceRefs) ? event.evidenceRefs : [];
    if (projected.length === 0) return false;
    return expectedRefs.every((expected) => projected.some((candidate) => sameEvidenceRef(candidate, expected)));
  });
}

function checkpointMatchesExecution(checkpoint, identity, operationEvents) {
  const scope = checkpointScopeOf(checkpoint);
  if (scope.executionEpoch !== identity.executionEpoch) return false;
  if (!sameIdOrString(scope.organId, identity.organId)) return false;
  if (!sameIdOrString(scope.taskId, identity.taskId)) return false;
  if (!sameIdOrString(scope.cycleId, identity.cycleId)) return false;
  if (!checkpointOperationLink(checkpoint, identity.operationId)) return false;
  return checkpointProjectionOperationMatches(checkpoint, operationEvents, identity.operationId);
}

/**
 * The scoped fact projection for the current attempt. The execution identity
 * comes from a verified `operation.started` record; a tool result from a
 * different task/operation/epoch is not current evidence, even when its callId
 * matches. `checkpoints` contains only authoritative records from a
 * `JsonlOrganJournal.verify()` result whose committed projection is compatible
 * with this execution.
 */
export function scopeFactsFromRecords(records, binding, options = {}) {
  const expected = expectedScopeOf(binding);
  const events = records.map(eventEnvelope).filter(Boolean);
  const identityResult = options.execution
    ? { ok: true, identity: options.execution }
    : executionIdentityFromRecords(records, binding);
  const identity = identityResult.ok ? identityResult.identity : null;
  const scopedIdentity = identity ?? expected;
  const inScopeEvents = events.filter((event) => matchesExpectedScope(eventScopeOf(event), {
    taskId: scopedIdentity.taskId ?? expected.taskId,
    operationId: scopedIdentity.operationId ?? expected.operationId,
    cycleId: scopedIdentity.cycleId ?? expected.cycleId,
    executionEpoch: scopedIdentity.executionEpoch ?? expected.executionEpoch,
  }, { requireCycle: false }));
  const operationEvents = identity
    ? inScopeEvents.filter((event) => sameIdOrString(event.operationId ?? event.__outerOperationId, identity.operationId))
    : inScopeEvents;
  const tools = operationEvents.filter((event) => KIND_PREFIX(event.kind) === 'provider.tool');
  const toolResults = operationEvents.filter((event) => KIND_PREFIX(event.kind) === 'provider.tool-result');
  const toolIds = new Map();
  for (const event of tools) {
    const id = event.callId ?? event.toolId ?? event.summary ?? null;
    if (id === null) continue;
    toolIds.set(String(id), event);
  }
  const toolRounds = [];
  for (const result of toolResults) {
    const id = result.callId ?? result.toolId ?? result.summary ?? null;
    if (id === null) continue;
    const call = toolIds.get(String(id));
    if (!call) continue;
    const callScope = eventScopeOf(call);
    const resultScope = eventScopeOf(result);
    if (callScope && resultScope && !sameOperationScope(callScope, resultScope)) continue;
    toolRounds.push({ call, result });
  }
  const authoritativeCheckpoints = options.checkpointRecords ?? [];
  const checkpoints = authoritativeCheckpoints
    .map((record) => record.checkpoint)
    .filter((checkpoint) => identity && checkpointMatchesExecution(checkpoint, identity, operationEvents));
  const terminals = operationEvents.filter((event) => KIND_PREFIX(event.kind) === 'execution.terminal');
  const finalTerminals = terminals.filter((event) => event.terminalPhase === 'final');
  const providerTerminals = terminals.filter((event) => event.terminalPhase === 'provider');
  // Every terminal in the journal, regardless of scope. Used only to tell a
  // genuinely missing terminal apart from one that exists but belongs to
  // another task/operation/epoch, so the failure reason stays accurate.
  const allTerminals = events.filter((event) => KIND_PREFIX(event.kind) === 'execution.terminal');
  const requestStarts = operationEvents.filter(
    (event) => KIND_PREFIX(event.kind) === 'provider.request-start'
      || event.summary === 'provider requested model work');
  return {
    identity,
    identityResult,
    events: operationEvents,
    toolCalls: tools,
    toolResults,
    toolRounds,
    checkpoints,
    terminals,
    finalTerminals,
    providerTerminals,
    allTerminals,
    requestStarts,
  };
}

const SETTLE_TERMINAL_STATES = Object.freeze({
  // Domain terminal states only. The outcome names success/failure/cancel are
  // runner-facing and are NOT terminal states; the domain uses succeeded/failed/
  // stopped/cancelled, so no success/failure alias is accepted.
  success: ['succeeded'],
  failure: ['failed'],
  cancel: ['stopped', 'cancelled', 'canceled'],
});

/** True when a runtime state is a legal authoritative terminal for settlement. */
export function isLegalTerminalState(state) {
  return Object.values(SETTLE_TERMINAL_STATES).some((states) => states.includes(state));
}

/**
 * The single settlement proof. `settled` requires an authoritative Journal
 * terminal, a compatible committed checkpoint/operation closure, real effect
 * results (or explicit unresolved obligations) and the relevant error/close
 * evidence. A missing/corrupt Journal, an unreadable required output, or a
 * swallowed read error can never become `settled`.
 *
 * `expectedOutcome` selects which real terminal the attempt must have reached:
 * success | failure | cancel. Any other terminal leaves the attempt unsettled.
 */
export async function assessSettlement(binding, options = {}) {
  const expectedOutcome = options.expectedOutcome ?? binding.outcome ?? 'success';
  const expectedStates = SETTLE_TERMINAL_STATES[expectedOutcome] ?? SETTLE_TERMINAL_STATES.success;
  const paths = (binding.journalPaths ?? [binding.journalPath]).filter(Boolean);
  const read = await readJournalStrict(paths, { repoPath: options.repoPath ?? binding.repoPath });
  if (!read.ok) {
    return { settled: false, reason: `authoritative journal unavailable: ${read.error}`, terminal: null, evidence: null };
  }
  const identityResult = executionIdentityFromRecords(read.records, binding);
  if (!identityResult.ok) {
    return {
      settled: false,
      reason: `attempt execution identity is unavailable: ${identityResult.reason}`,
      terminal: null,
      evidence: null,
    };
  }
  const identity = identityResult.identity;
  if (!hasRequiredScope({
    taskId: identity.taskId,
    operationId: identity.operationId,
    executionEpoch: identity.executionEpoch,
  })) {
    return {
      settled: false,
      reason: 'attempt scope is incomplete: verified operation.started lacks taskId, operationId or executionEpoch',
      terminal: null,
      evidence: null,
    };
  }
  const scoped = scopeFactsFromRecords(read.records, binding, {
    execution: identity,
    checkpointRecords: read.checkpointRecords ?? [],
  });
  const terminal = scoped.finalTerminals.slice(-1)[0] ?? null;
  const finalTerminalReached = terminal !== null;
  const providerPhaseOnly = !finalTerminalReached && scoped.providerTerminals.length > 0;
  const compatibleCheckpoints = scoped.checkpoints.filter((checkpoint) => expectedStates.includes(checkpoint.outcome));
  const baseEvidence = countTurnEvidenceFromRecords(read.records, paths, paths[0] ?? null);
  const evidence = {
    ...baseEvidence,
    requestStartTurns: scoped.requestStarts.length,
    providerToolCalls: scoped.toolCalls.length,
    providerToolResults: scoped.toolResults.length,
    toolRounds: scoped.toolRounds.length,
    checkpointCommitted: compatibleCheckpoints.length,
    terminalRecords: scoped.terminals.map((event) => ({
      seq: event.seq ?? null,
      state: event.state ?? null,
      summary: event.summary ?? null,
      owner: event.owner ?? event.ownerId ?? null,
    })),
    allEvents: scoped.events.map((event) => ({
      seq: event.seq ?? null,
      kind: event.kind ?? null,
      state: event.state ?? null,
      status: event.status ?? null,
      summary: event.summary ?? null,
      callId: event.callId ?? null,
      toolId: event.toolId ?? null,
      arguments: event.arguments ?? null,
      error: event.error ?? null,
      outputRef: event.outputRef ?? null,
      outputDigest: event.outputDigest ?? null,
      evidenceRefs: event.evidenceRefs ?? null,
    })),
    toolCallIds: scoped.toolCalls.map((event) => event.callId ?? event.toolId ?? event.summary ?? null),
    toolResultIds: scoped.toolResults.map((event) => event.callId ?? event.toolId ?? event.summary ?? null),
    executionIdentity: identity,
  };
  if (!terminal) {
    return {
      settled: false,
      reason: providerPhaseOnly
        ? `journal has only a provider-phase execution.terminal; the final barrier was not reached`
        : scoped.allTerminals.length > 0
          ? `journal has no same-scope final execution.terminal record (${evidence.recordCount} records, ${evidence.eventCount} events)`
          : `journal has no execution.terminal record (${evidence.recordCount} records, ${evidence.eventCount} events)`,
      terminal: null,
      evidence,
    };
  }
  if (!expectedStates.includes(terminal.state)) {
    return {
      settled: false,
      reason: `terminal state ${JSON.stringify(terminal.state)} does not match the expected ${expectedOutcome} outcome`,
      terminal,
      evidence,
    };
  }
  const minCheckpoints = options.minCheckpoints ?? 1;
  const minToolRounds = options.minToolRounds ?? (expectedOutcome === 'success' ? 1 : 0);
  const missing = [];
  if (compatibleCheckpoints.length < minCheckpoints) {
    missing.push(`sameExecutionAuthoritativeCheckpoints=${compatibleCheckpoints.length}`);
  }
  if (evidence.toolRounds < minToolRounds) missing.push(`sameScopePairedToolRounds=${evidence.toolRounds}`);
  if (expectedOutcome === 'success' && evidence.providerToolResults < 1 && !options.explicitUnresolvedObligations) {
    missing.push('no provider tool result / explicit unresolved obligation');
  }
  if (expectedOutcome === 'failure') {
    const hasError = evidence.allEvents.some((event) => event.status === 'failed' || event.status === 'error' || event.error)
      || Boolean(terminal.error);
    if (!hasError) missing.push('no failure error evidence in the journal');
  }
  if (missing.length > 0) {
    return {
      settled: false,
      reason: `terminal reached but settlement evidence is incomplete: ${missing.join(', ')}`,
      terminal,
      evidence,
    };
  }
  return {
    settled: true,
    reason: `authoritative same-scope journal terminal ${terminal.state} with compatible checkpoint/operation closure`,
    terminal,
    evidence,
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

/**
 * Read the immutable report behind every succeeded tool result.
 *
 * The authoritative journal records the tool output descriptor (`outputRef` +
 * `outputDigest`), not the report body. The body is read back through the
 * runtime's task-scoped tool-output route, which re-verifies the digest before
 * returning it, so a report returned here is the one the execution produced.
 * The route is addressed by task/operation/epoch/seq, never by `callId` alone.
 */
export async function readToolOutputReports(binding, dashboard, events) {
  const operationId = dashboard?.operationId;
  const executionEpoch = dashboard?.executionEpoch;
  if (typeof operationId !== 'string' || typeof executionEpoch !== 'number') return [];
  const reports = [];
  for (const event of events) {
    if (event.kind !== 'provider.tool-result' || event.status !== 'succeeded') continue;
    if (typeof event.outputRef !== 'string' || typeof event.seq !== 'number') continue;
    const path = `/api/tasks/${encodeURIComponent(taskIdValue(binding.taskId))}/operations/${encodeURIComponent(operationId)}`
      + `/executions/${executionEpoch}/events/${event.seq}/tool-output`;
    try {
      const response = await (binding.auth?.fetch ?? fetch)(`${binding.serveBaseUrl}${path}`);
      const body = await response.json().catch(() => null);
      reports.push({
        seq: event.seq,
        callId: event.callId ?? null,
        toolId: event.toolId ?? null,
        path,
        ok: response.ok,
        status: response.status,
        report: response.ok ? body : null,
        error: response.ok ? null : (body?.error?.message ?? `HTTP ${response.status}`),
      });
    } catch (error) {
      reports.push({
        seq: event.seq,
        callId: event.callId ?? null,
        toolId: event.toolId ?? null,
        path,
        ok: false,
        status: null,
        report: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return reports;
}
