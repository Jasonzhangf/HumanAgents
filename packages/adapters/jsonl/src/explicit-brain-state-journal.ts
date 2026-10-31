import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { JournalIntegrityError } from './errors.js';

export const EXPLICIT_BRAIN_CHECKPOINT_INTERVAL = 32;
export const EXPLICIT_BRAIN_MAX_DELTA_BYTES = 256 * 1024;
export const EXPLICIT_BRAIN_DELTA_ENCODING = 'delta-v1';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { readonly [key: string]: JsonValue | undefined };

type ValueDelta =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'replace'; readonly value: JsonValue }
  | { readonly kind: 'list'; readonly value: readonly JsonValue[] }
  | { readonly kind: 'object'; readonly set: Record<string, ValueDelta>; readonly remove?: readonly string[] }
  | { readonly kind: 'keyed'; readonly updates: readonly JsonValue[]; readonly removes: readonly string[]; readonly order?: readonly string[] };

type JsonArray = JsonValue[];

export interface ExplicitBrainStateBaseline {
  readonly state: JsonObject;
  readonly stateSeq: number;
  readonly deltasSinceCheckpoint: number;
  readonly deltaBytesSinceCheckpoint: number;
}

export interface ExplicitBrainStateTailRead {
  readonly state: JsonObject;
  readonly stateSeq: number;
  readonly deltasSinceCheckpoint: number;
  readonly deltaBytesSinceCheckpoint: number;
}

export interface EncodedExplicitBrainStateRecord {
  readonly record: JsonObject;
  readonly line: string;
  readonly baseline: ExplicitBrainStateBaseline;
}

export interface ExplicitBrainStateCodecOptions {
  readonly checkpointInterval?: number;
  readonly maxDeltaBytes?: number;
}

export interface DecodedExplicitBrainStateRecord {
  readonly record: JsonObject;
  readonly baseline: ExplicitBrainStateBaseline;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is JsonArray {
  return Array.isArray(value);
}

function cloneJson(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return value !== undefined && isJsonObject(value) ? value : {};
}

function arrayValue(value: JsonValue | undefined): JsonArray {
  return value !== undefined && isJsonArray(value) ? value : [];
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function itemKey(path: string, item: JsonValue | undefined): string | undefined {
  const logicalPath = path.startsWith('state.') ? path.slice('state.'.length) : path;
  if ((logicalPath === 'inbox.pendingDraftIds' || logicalPath === 'confirmationLedger.closedDraftIds')
    && typeof item === 'string') {
    return item;
  }
  const record = isJsonObject(item) ? item : undefined;
  if (!record) return undefined;
  switch (logicalPath) {
    case 'intake.interactions':
      return typeof record.interactionId === 'string' ? record.interactionId : undefined;
    case 'inbox.envelopes':
    case 'confirmationLedger.drafts':
    case 'confirmationLedger.confirmations':
    case 'confirmationLedger.revisions':
    case 'confirmationLedger.revisionConfirmations':
      return typeof record.draftId === 'string' ? record.draftId : undefined;
    case 'inbox.terminalOutcomes':
      return typeof record.requirementId === 'string' ? record.requirementId : undefined;
    case 'confirmationLedger.finalSubmitBindings':
    case 'finalSubmissions':
      return typeof record.idempotencyKey === 'string' ? record.idempotencyKey : undefined;
    case 'dispatchLedger':
      return typeof record.draftId === 'string' ? record.draftId : undefined;
    case 'requirementAdmissions':
    case 'taskInputRevisions':
      return isJsonObject(record.taskId) && typeof record.taskId.value === 'string'
        ? record.taskId.value
        : undefined;
    case 'submittedSubmissions': {
      const interactionId = stringValue(record.interactionId);
      const draftId = stringValue(record.draftId);
      const inputRevision = typeof record.inputRevision === 'number' ? record.inputRevision : '';
      return interactionId ? `${interactionId}\u0000${draftId}\u0000${inputRevision}` : undefined;
    }
    case 'decisionTraces':
      return JSON.stringify(item);
    default:
      return undefined;
  }
}

function uniqueKeys(items: JsonArray, path: string): Map<string, JsonValue> | undefined {
  const map = new Map<string, JsonValue>();
  for (const item of items) {
    const key = itemKey(path, item);
    if (key === undefined || map.has(key)) return undefined;
    map.set(key, item);
  }
  return map;
}

function keyedDelta(path: string, previous: JsonArray, next: JsonArray): ValueDelta | undefined {
  const previousMap = uniqueKeys(previous, path);
  const nextMap = uniqueKeys(next, path);
  if (!previousMap || !nextMap) {
    return jsonEqual(previous, next) ? undefined : { kind: 'list', value: next };
  }
  const previousKeys = new Set(previousMap.keys());
  const nextKeys = new Set(nextMap.keys());
  const removes: string[] = [];
  const updates: JsonValue[] = [];
  for (const [key, previousItem] of previousMap) {
    if (!nextMap.has(key)) {
      removes.push(key);
      continue;
    }
    if (!jsonEqual(previousItem, nextMap.get(key)!)) updates.push(nextMap.get(key)!);
  }
  for (const [key, item] of nextMap) {
    if (!previousKeys.has(key)) updates.push(item);
  }
  if (removes.length === 0 && updates.length === 0) return undefined;
  const derived = [...previous.map((item) => itemKey(path, item)).filter((key): key is string => key !== undefined && nextKeys.has(key))];
  const appended = next.map((item) => itemKey(path, item)).filter((key): key is string => key !== undefined && !previousKeys.has(key));
  const derivedOrder = [...derived, ...appended];
  const nextOrder = next.map((item) => itemKey(path, item)).filter((key): key is string => key !== undefined);
  const needsOrder = derivedOrder.length !== nextOrder.length || derivedOrder.some((key, index) => key !== nextOrder[index]);
  return {
    kind: 'keyed',
    updates,
    removes,
    ...(needsOrder ? { order: nextOrder } : {}),
  };
}

function diffValue(path: string, previous: JsonValue | undefined, next: JsonValue | undefined): ValueDelta | undefined {
  if (previous === undefined) return next === undefined ? undefined : { kind: 'replace', value: next };
  if (next === undefined) return undefined;
  if (jsonEqual(previous, next)) return undefined;
  if (isJsonArray(previous) && isJsonArray(next)) {
    return keyedDelta(path, previous, next);
  }
  if (isJsonObject(previous) && isJsonObject(next)) {
    const previousObject = previous;
    const nextObject = next;
    const set: Record<string, ValueDelta> = {};
    const remove: string[] = [];
    const keys = new Set<string>([...Object.keys(previousObject), ...Object.keys(nextObject)]);
    for (const key of keys) {
      if (!(key in nextObject)) {
        remove.push(key);
        continue;
      }
      const childPath = `${path}.${key}`;
      const childDelta = diffValue(childPath, previousObject[key], nextObject[key]);
      if (childDelta) set[key] = childDelta;
    }
    if (Object.keys(set).length === 0 && remove.length === 0) return undefined;
    return { kind: 'object', set, ...(remove.length > 0 ? { remove } : {}) };
  }
  return { kind: 'replace', value: next };
}

function applyValueDelta(current: JsonValue | undefined, delta: ValueDelta, path: string): JsonValue {
  if (delta.kind === 'unchanged') return current!;
  if (delta.kind === 'replace') return cloneJson(delta.value);
  if (delta.kind === 'list') return delta.value.map(cloneJson);
  if (delta.kind === 'object') {
    const source = current !== undefined && isJsonObject(current) ? current : {};
    const result: Record<string, JsonValue | undefined> = { ...source };
    for (const key of delta.remove ?? []) delete result[key];
    for (const [key, childDelta] of Object.entries(delta.set)) {
      result[key] = applyValueDelta(result[key], childDelta, `${path}.${key}`);
    }
    return result as unknown as JsonValue;
  }
  const source = current !== undefined && isJsonArray(current) ? current : [];
  const byKey = new Map<string, JsonValue>();
  for (const item of source) {
    const key = itemKey(path, item);
    if (key !== undefined) byKey.set(key, item);
  }
  for (const key of delta.removes) byKey.delete(key);
  for (const item of delta.updates) {
    const key = itemKey(path, item);
    if (key !== undefined) byKey.set(key, cloneJson(item));
  }
  const order = delta.order ?? source
    .map((item) => itemKey(path, item))
    .filter((key): key is string => key !== undefined)
    .filter((key) => byKey.has(key))
    .concat([...byKey.keys()].filter((key) => !source.some((item) => itemKey(path, item) === key)));
  const result: JsonValue[] = [];
  for (const key of order) {
    const item = byKey.get(key);
    if (item === undefined) throw new JournalIntegrityError(`explicit-brain delta order references missing key ${key}`);
    result.push(item);
  }
  for (const key of byKey.keys()) {
    if (!order.includes(key)) result.push(byKey.get(key)!);
  }
  return result;
}

function stateSeqOf(record: JsonObject): number {
  const stateSeq = record.stateSeq;
  return Number.isSafeInteger(stateSeq) && Number(stateSeq) >= 0 ? Number(stateSeq) : 0;
}

function isDeltaRecord(record: JsonObject): boolean {
  return record.encoding === EXPLICIT_BRAIN_DELTA_ENCODING;
}

function recordState(record: JsonObject): JsonObject {
  const state = record.state;
  if (!isJsonObject(state)) throw new JournalIntegrityError('explicit-brain.state record is missing a state object');
  return state;
}

function recordLineBytes(record: JsonObject): number {
  return byteLength(JSON.stringify(record));
}

export function applyExplicitBrainStateRecord(
  record: JsonObject,
  previous: ExplicitBrainStateBaseline | undefined,
): DecodedExplicitBrainStateRecord {
  if (record.kind !== 'explicit-brain.state') {
    throw new JournalIntegrityError('record is not an explicit-brain.state record');
  }
  if (isDeltaRecord(record)) {
    if (!previous) {
      throw new JournalIntegrityError('explicit-brain delta record has no preceding state baseline');
    }
    const baseStateSeq = record.baseStateSeq;
    if (!Number.isSafeInteger(baseStateSeq) || Number(baseStateSeq) !== previous.stateSeq) {
      throw new JournalIntegrityError(
        `explicit-brain delta baseStateSeq ${String(baseStateSeq)} does not match previous stateSeq ${previous.stateSeq}`,
      );
    }
    const stateSeq = record.stateSeq;
    if (!Number.isSafeInteger(stateSeq) || Number(stateSeq) !== previous.stateSeq + 1) {
      throw new JournalIntegrityError('explicit-brain delta stateSeq is not contiguous');
    }
    if (!record.delta) throw new JournalIntegrityError('explicit-brain delta record is missing its delta payload');
    const state = applyValueDelta(previous.state, record.delta as ValueDelta, 'state') as JsonObject;
    const baseline: ExplicitBrainStateBaseline = {
      state,
      stateSeq: Number(stateSeq),
      deltasSinceCheckpoint: previous.deltasSinceCheckpoint + 1,
      deltaBytesSinceCheckpoint: previous.deltaBytesSinceCheckpoint + recordLineBytes(record),
    };
    return { record: { kind: 'explicit-brain.state', state, stateSeq: Number(stateSeq) }, baseline };
  }
  const state = cloneJson(recordState(record)) as JsonObject;
  const stateSeq = stateSeqOf(record);
  const baseline: ExplicitBrainStateBaseline = {
    state,
    stateSeq,
    deltasSinceCheckpoint: 0,
    deltaBytesSinceCheckpoint: 0,
  };
  return {
    record: {
      kind: 'explicit-brain.state',
      state,
      stateSeq,
      ...(record.checkpoint === true || stateSeq > 0 ? { checkpoint: true } : {}),
    },
    baseline,
  };
}

function lightweightStateHeader(state: JsonObject): JsonObject {
  const intake = objectValue(state.intake);
  const inbox = objectValue(state.inbox);
  return {
    intake: {
      nextInteractionSeq: intake.nextInteractionSeq,
      nextDraftSeq: intake.nextDraftSeq,
      ...(intake.nextRequestNumber === undefined ? {} : { nextRequestNumber: intake.nextRequestNumber }),
      interactions: [],
    },
    inbox: {
      nextFifoSeq: inbox.nextFifoSeq,
      pendingDraftIds: cloneJson(arrayValue(inbox.pendingDraftIds)),
      envelopes: [],
      terminalOutcomes: [],
    },
    confirmationLedger: {
      drafts: [],
      confirmations: [],
      revisions: [],
      revisionConfirmations: [],
      closedDraftIds: [],
      finalSubmitBindings: [],
    },
  };
}

function makeBaseline(state: JsonObject, stateSeq: number, deltasSinceCheckpoint: number, deltaBytesSinceCheckpoint: number): ExplicitBrainStateBaseline {
  return { state, stateSeq, deltasSinceCheckpoint, deltaBytesSinceCheckpoint };
}

export function encodeExplicitBrainStateRecord(
  input: {
    readonly state: object;
    readonly baseline?: ExplicitBrainStateBaseline | null;
  },
  options: ExplicitBrainStateCodecOptions = {},
): EncodedExplicitBrainStateRecord {
  const checkpointInterval = options.checkpointInterval ?? EXPLICIT_BRAIN_CHECKPOINT_INTERVAL;
  const maxDeltaBytes = options.maxDeltaBytes ?? EXPLICIT_BRAIN_MAX_DELTA_BYTES;
  const state = input.state as JsonObject;
  const previous = input.baseline ?? undefined;
  const stateSeq = (previous?.stateSeq ?? 0) + 1;
  const checkpointRecord: JsonObject = {
    kind: 'explicit-brain.state',
    state: cloneJson(state),
    stateSeq,
    checkpoint: true,
  };
  const checkpointBytes = recordLineBytes(checkpointRecord);

  if (previous && previous.stateSeq > 0) {
    const delta = diffValue('state', previous.state, state);
    const deltaRecord: JsonObject = {
      kind: 'explicit-brain.state',
      state: lightweightStateHeader(state),
      encoding: EXPLICIT_BRAIN_DELTA_ENCODING,
      stateSeq,
      baseStateSeq: previous.stateSeq,
      delta: (delta ?? { kind: 'unchanged' }) as unknown as JsonValue,
    };
    const deltaBytes = recordLineBytes(deltaRecord);
    const canDelta = previous.deltasSinceCheckpoint < checkpointInterval
      && previous.deltaBytesSinceCheckpoint + deltaBytes < maxDeltaBytes
      && deltaBytes < checkpointBytes * 0.7;
    if (canDelta) {
      const baseline = makeBaseline(state, stateSeq, previous.deltasSinceCheckpoint + 1, previous.deltaBytesSinceCheckpoint + deltaBytes);
      return { record: deltaRecord, line: JSON.stringify(deltaRecord), baseline };
    }
  }

  return {
    record: checkpointRecord,
    line: JSON.stringify(checkpointRecord),
    baseline: makeBaseline(cloneJson(state) as JsonObject, stateSeq, 0, 0),
  };
}

/**
 * Scan physical lines from the end of a JSONL file back to the beginning. The
 * visitor receives complete lines (without their trailing newline) in reverse
 * order. Return `false` from the visitor to stop immediately.
 */
export function scanJournalLinesBackwards(filePath: string, visit: (line: string) => boolean): void {
  if (!existsSync(filePath)) return;
  const info = statSync(filePath);
  if (info.size === 0) return;
  const fd = openSync(filePath, 'r');
  const chunk = new Uint8Array(64 * 1024);
  try {
    let pending = new Uint8Array(0);
    let position = info.size;
    while (position > 0) {
      const start = Math.max(0, position - chunk.length);
      const length = position - start;
      const read = readSync(fd, chunk, 0, length, start);
      if (read <= 0) break;
      const data = new Uint8Array(read + pending.length);
      data.set(chunk.subarray(0, read), 0);
      data.set(pending, read);
      let lineEnd = data.length;
      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 0x0a) continue;
        const line = new TextDecoder().decode(data.subarray(index + 1, lineEnd));
        pending = new Uint8Array(0);
        if (visit(line) === false) return;
        lineEnd = index;
      }
      pending = data.subarray(0, lineEnd).slice();
      position = start;
    }
    if (pending.length > 0) {
      visit(new TextDecoder().decode(pending));
    }
  } finally {
    closeSync(fd);
  }
}

export function readLatestExplicitBrainStateFromFile(filePath: string): ExplicitBrainStateTailRead | undefined {
  const deltas: JsonObject[] = [];
  let checkpoint: JsonObject | undefined;
  let stop = false;
  scanJournalLinesBackwards(filePath, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    let record: JsonObject;
    try {
      record = JSON.parse(trimmed) as JsonObject;
    } catch (error) {
      throw new JournalIntegrityError(`explicit-brain journal contains malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (record.kind !== 'explicit-brain.state') return true;
    if (isDeltaRecord(record)) {
      deltas.push(record);
      return true;
    }
    checkpoint = record;
    stop = true;
    return false;
  });
  if (!stop) {
    if (deltas.length > 0) throw new JournalIntegrityError('explicit-brain delta chain has no preceding checkpoint');
    return undefined;
  }
  if (deltas.length > EXPLICIT_BRAIN_CHECKPOINT_INTERVAL) {
    throw new JournalIntegrityError('explicit-brain delta chain exceeds the checkpoint interval');
  }
  let previous = applyExplicitBrainStateRecord(checkpoint!, undefined).baseline;
  for (const delta of deltas.reverse()) {
    previous = applyExplicitBrainStateRecord(delta, previous).baseline;
  }
  return previous;
}
