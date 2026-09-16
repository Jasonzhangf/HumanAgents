import type { AgentControlBlock, ControlDecodeResult } from './types.js';

const BINDING_KEYS = new Set([
  'provider',
  'model',
  'providerId',
  'modelRef',
  'protocol',
  'bindingId',
  'endpointRef',
  'providerBinding',
  'bindingFingerprint',
  'permissionRevision',
  'idempotencyKey',
  'contextViewRef',
  'configDigest',
  'capabilityDigest',
  'owner',
  'taskId',
  'assignmentId',
]);
const CONTROL_FIELDS = new Set([
  'summary',
  'schemaVersion',
  'turnRef',
  'phase',
  'disposition',
  'goal',
  'blocked',
  'next',
  'checkpoint',
  'completion',
  'memory',
  'repair',
]);

const DISPOSITIONS = new Set([
  'continue',
  'checkpoint-proposed',
  'waiting-user',
  'waiting-operation',
  'blocked',
  'failed',
  'completion-proposed',
  'stop-ack',
]);

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return nonEmpty(value) ? value : undefined;
}

function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(nonEmpty);
  return values.length > 0 ? values : undefined;
}

function cleanBlock(value: unknown): Partial<AgentControlBlock> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const block: Record<string, unknown> = {};
  for (const key of CONTROL_FIELDS) {
    if (key in raw) block[key] = raw[key];
  }
  return block as Partial<AgentControlBlock>;
}

function validateBlockShape(block: Partial<AgentControlBlock>): string | undefined {
  if (block.summary !== undefined && !nonEmpty(block.summary)) return 'summary must be a non-empty string';
  if (block.turnRef !== undefined && !nonEmpty(block.turnRef)) return 'turnRef must be a non-empty string';
  if (block.phase !== undefined && !nonEmpty(block.phase)) return 'phase must be a non-empty string';
  if (block.disposition !== undefined && !DISPOSITIONS.has(block.disposition)) return `unknown disposition: ${String(block.disposition)}`;
  if (block.goal !== undefined) {
    if (!block.goal || typeof block.goal !== 'object' || Array.isArray(block.goal)) return 'goal must be an object';
    if (!['in-progress', 'complete', 'blocked', 'unknown'].includes(block.goal.status)) return `unknown goal status: ${String(block.goal.status)}`;
  }
  if (block.next !== undefined) {
    if (!block.next || typeof block.next !== 'object' || Array.isArray(block.next)) return 'next must be an object';
    if (!nonEmpty(block.next.objective)) return 'next.objective must be a non-empty string';
    if (!['reason', 'tool', 'wait', 'ask-user', 'review', 'stop', 'close'].includes(block.next.kind)) {
      return `unknown next kind: ${String(block.next.kind)}`;
    }
  }
  return undefined;
}

function absentFields(block: Partial<AgentControlBlock>): string[] {
  const absent: string[] = [];
  if (block.summary === undefined) absent.push('summary');
  if (block.turnRef === undefined) absent.push('turnRef');
  if (block.phase === undefined) absent.push('phase');
  if (block.disposition === undefined) absent.push('disposition');
  if (block.goal === undefined) absent.push('goal');
  if (block.next === undefined) absent.push('next');
  return absent;
}

function decodeJsonObject(json: string, sourceRef: string): ControlDecodeResult | undefined {
  if (!json || !json.trim().startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const object = parsed as Record<string, unknown>;
  const rejected: string[] = [];
  const bindingKeys = new Set<string>();
  for (const key of Object.keys(object)) {
    if (BINDING_KEYS.has(key)) bindingKeys.add(key);
  }
  const nested = typeof object.control === 'object' && object.control !== null ? object.control as unknown : object;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    return {
      status: 'missing',
      sourceRef,
      completeness: 'absent',
      absentFields: ['control'],
      diagnostics: ['response is JSON but does not contain a control object'],
      rejectedBindings: rejected,
    };
  }
  for (const key of Object.keys(nested as Record<string, unknown>)) {
    if (BINDING_KEYS.has(key)) bindingKeys.add(key);
  }
  rejected.push(...bindingKeys);
  const block = cleanBlock(nested) ?? {};
  const shapeError = validateBlockShape(block);
  if (shapeError) {
    return {
      status: 'malformed',
      sourceRef,
      completeness: 'partial',
      absentFields: absentFields(block),
      diagnostics: [`control block shape is invalid: ${shapeError}`],
      block,
      partialRaw: json,
    };
  }
  if (rejected.length > 0) {
    return {
      status: 'malformed',
      sourceRef,
      completeness: 'partial',
      absentFields: absentFields(block),
      diagnostics: [`control block contains forbidden binding fields: ${rejected.join(', ')}`],
      block,
      partialRaw: json,
      rejectedBindings: rejected,
    };
  }
  return {
    status: 'valid',
    sourceRef,
    completeness: absentFields(block).length === 0 ? 'complete' : 'partial',
    absentFields: absentFields(block),
    diagnostics: [],
    block,
  };
}

function extractMarkerJson(raw: string, marker: string): string[] {
  const candidates: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(marker, cursor);
    if (start === -1) break;
    const contentStart = start + marker.length;
    const endMarker = `[[/${marker.slice(2, -2)}]]`;
    const end = raw.indexOf(endMarker, contentStart);
    candidates.push((end === -1 ? raw.slice(contentStart) : raw.slice(contentStart, end)).trim());
    cursor = end === -1 ? raw.length : end + endMarker.length;
  }
  return candidates;
}

function extractFencedJson(raw: string): string[] {
  const candidates: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf('```json', cursor);
    if (start === -1) break;
    const contentStart = start + '```json'.length;
    const end = raw.indexOf('```', contentStart);
    candidates.push((end === -1 ? raw.slice(contentStart) : raw.slice(contentStart, end)).trim());
    cursor = end === -1 ? raw.length : end + 3;
  }
  return candidates;
}

export function decodeControlBlock(input: {
  readonly sourceRef: string;
  readonly raw: string;
}): ControlDecodeResult {
  const raw = input.raw.trim();
  if (!raw) {
    return {
      status: 'missing',
      sourceRef: input.sourceRef,
      completeness: 'absent',
      absentFields: ['control', 'summary'],
      diagnostics: ['response is empty; EOF is not completion'],
    };
  }

  const candidates: string[] = [
    raw,
    ...extractMarkerJson(raw, '[[control]]'),
    ...extractFencedJson(raw),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const decodedCandidates: ControlDecodeResult[] = [];
  for (const candidate of candidates) {
    if (!candidate.trim().startsWith('{')) continue;
    const decoded = decodeJsonObject(candidate, input.sourceRef);
    if (decoded?.status === 'valid') {
      decodedCandidates.push(decoded);
    } else if (decoded?.status === 'malformed') {
      return decoded;
    }
  }
  if (decodedCandidates.length > 1) {
    const first = JSON.stringify(decodedCandidates[0]?.block);
    const conflict = decodedCandidates.some((candidate) => JSON.stringify(candidate.block) !== first);
    if (conflict) {
      return {
        status: 'multiple-conflicting',
        sourceRef: input.sourceRef,
        completeness: 'complete',
        absentFields: [],
        diagnostics: ['response contains multiple conflicting control blocks'],
      };
    }
    return decodedCandidates[0]!;
  }
  if (decodedCandidates.length === 1) return decodedCandidates[0]!;

  const summary = extractSummary(raw);
  if (summary) {
    return {
      status: 'missing',
      sourceRef: input.sourceRef,
      completeness: 'partial',
      absentFields: ['control'],
      diagnostics: ['plain response has no parsed control block; summary is not accepted as a control block'],
      block: { summary },
    };
  }

  const controlStart = raw.lastIndexOf('"summary"');
  if (controlStart !== -1) {
    return {
      status: 'partial',
      sourceRef: input.sourceRef,
      completeness: 'partial',
      absentFields: ['control'],
      diagnostics: ['partial control block detected but not parseable yet'],
      partialRaw: raw,
    };
  }

  return {
    status: 'missing',
    sourceRef: input.sourceRef,
    completeness: 'absent',
    absentFields: ['control', 'summary'],
    diagnostics: ['response contains no control block'],
  };
}

function extractSummary(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('summary:') || line.startsWith('Summary:')) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      if (value) return value;
    }
  }
  return undefined;
}
