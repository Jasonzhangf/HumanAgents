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

function extractMarkerJson(raw: string, marker: string): string | undefined {
  const start = raw.indexOf(marker);
  if (start === -1) return undefined;
  const contentStart = start + marker.length;
  const endMarker = `[[/${marker.slice(2, -2)}]]`;
  const end = raw.indexOf(endMarker, contentStart);
  if (end === -1) return raw.slice(contentStart).trim();
  return raw.slice(contentStart, end).trim();
}

function extractFencedJson(raw: string): string | undefined {
  const start = raw.indexOf('```json');
  if (start === -1) return undefined;
  const contentStart = start + '```json'.length;
  const end = raw.indexOf('```', contentStart);
  if (end === -1) return raw.slice(contentStart).trim();
  return raw.slice(contentStart, end).trim();
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
    extractMarkerJson(raw, '[[control]]'),
    extractFencedJson(raw),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!candidate.trim().startsWith('{')) continue;
    const decoded = decodeJsonObject(candidate, input.sourceRef);
    if (decoded) {
      return decoded;
    }
  }

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
