import {
  canonicalJsonStringify,
  type AcceptedRawFact,
  type AcceptedTurnEntry,
  type ActiveTurnCaptureBody,
  type CompletionReadInput,
  type CompletionReadback,
  type DurableCompletionReceipt,
  type EvidenceRef,
  type ProviderExecutionIdentityRef,
  type ProviderRawFact,
  type RawAsset,
  type RawContentReadPort,
  type ScopeRef,
  type StandardTurnEndCommand,
  isStandardTurnEndToolId,
  type WorkAssignment,
} from '../../../contracts/src/index.js';
import type { ActiveTurnSegmentCaptureV2 } from '../../../contracts/src/active-turn-segments.js';
import type { OperationCompletionJournalPort } from '../gateway/operation-completion.js';

const OWNER = 'humanagent.runtime.standard-turn-delivery';

export type StandardTurnDeliveryErrorCode =
  | 'standard-turn-delivery.end-unbound'
  | 'standard-turn-delivery.evidence-unresolved'
  | 'standard-turn-delivery.evidence-ambiguous'
  | 'standard-turn-delivery.completion-unknown'
  | 'standard-turn-delivery.completion-conflict'
  | 'standard-turn-delivery.artifact-conflict'
  | 'standard-turn-delivery.body-utf8'
  | 'standard-turn-delivery.text-source-missing'
  | 'standard-turn-delivery.end-call-unresolved'
  | 'standard-turn-delivery.text-arguments-invalid'
  | 'standard-turn-delivery.text-mismatch'
  | 'standard-turn-delivery.binding-invalid';

export class StandardTurnDeliveryError extends Error {
  constructor(readonly code: StandardTurnDeliveryErrorCode, message: string, readonly ownerId: string = OWNER, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StandardTurnDeliveryError';
  }
}

/**
 * One accepted tool-report material: an accepted tool result with the exact
 * completion receipt that proved its effect. The bytes are the accepted raw
 * output and the artifact identity comes from the confirmed completion.
 */
export interface StandardTurnDeliveryReportMaterial {
  readonly kind: 'tool-report';
  readonly deliveryEvidence: EvidenceRef;
  readonly acceptedToolResult: AcceptedRawFact;
  readonly completion: DurableCompletionReceipt;
  readonly rawOutput: RawAsset;
  readonly bytes: Uint8Array;
  /** Evidence carried by the accepted source itself, kept for the bundle. */
  readonly sourceEvidence: readonly EvidenceRef[];
}

/**
 * One accepted pure-text material: the standard end's own `deliveryText`, read
 * back byte-exact from the actual accepted end call's persisted raw arguments
 * and from the immutable body asset the App wrote through the existing asset
 * owner. It carries no completion receipt: a text delivery produces no file
 * effect and never fakes one. `digest` is the SHA-256 of the exact body bytes.
 */
export interface StandardTurnDeliveryTextMaterial {
  readonly kind: 'delivery-text';
  readonly deliveryEvidence: EvidenceRef;
  readonly acceptedEndCall: AcceptedRawFact;
  readonly rawArguments: RawAsset;
  readonly bodyAsset: RawAsset;
  readonly bytes: Uint8Array;
  readonly digest: string;
  /** Evidence carried by the accepted source itself, kept for the bundle. */
  readonly sourceEvidence: readonly EvidenceRef[];
}

/** One accepted delivery material, resolved from exact sources only. */
export type StandardTurnDeliveryMaterial =
  | StandardTurnDeliveryReportMaterial
  | StandardTurnDeliveryTextMaterial;

export interface StandardTurnDeliveryReadback {
  readonly assignment: WorkAssignment;
  readonly acceptedEnd: StandardTurnEndCommand;
  readonly materials: readonly StandardTurnDeliveryMaterial[];
}

export interface StandardTurnDeliveryBinding {
  readonly assignment: WorkAssignment;
  readonly outputRefs: readonly string[];
  readonly producedArtifactRefs: readonly string[];
  readonly producedArtifactDigests: readonly string[];
  readonly producedArtifactBodies: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly readback: StandardTurnDeliveryReadback;
}

/**
 * The exact sources App binds. `entries` is the live accepted prefix;
 * `exactSegments` are the immutable exact prepared capture bodies for the
 * original and any successor segments (`resume.source.captures[].source.prepared.body`
 * reused through their real types). `completionLookups` are the typed exact
 * lookup descriptors the capture owner already resolved; the Runtime never
 * derives a lookup from a label, a sibling turn or an array position.
 */
export interface StandardTurnDeliveryReadInput {
  readonly assignment: WorkAssignment;
  readonly acceptedEnd: StandardTurnEndCommand;
  readonly entries: readonly AcceptedRawFact[];
  readonly completionLookups: readonly CompletionReadInput[];
  readonly initialInput?: RawAsset;
  readonly exactSegments?: readonly (ActiveTurnCaptureBody | ActiveTurnSegmentCaptureV2)[];
  /**
   * The exact immutable body for a text-only delivery. The App writes the
   * exact accepted `deliveryText` bytes through the existing immutable asset
   store and supplies the descriptor here. It is never a new control source of
   truth: the Runtime proves it equals the accepted text read back from the
   original end call arguments.
   */
  readonly deliveryTextBody?: RawAsset;
}

export interface StandardTurnDeliveryReaderPort {
  readonly completion: OperationCompletionJournalPort;
  readonly rawContent: RawContentReadPort;
}

export interface StandardTurnDeliveryBindInput {
  readonly assignment: WorkAssignment;
  readonly readback: StandardTurnDeliveryReadback;
}

function sameEvidenceIdentity(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.evidenceId.value === right.evidenceId.value
    && left.evidenceId.scope === right.evidenceId.scope
    && left.kind === right.kind
    && left.source === right.source
    && left.locator === right.locator
    && left.digest === right.digest
    && canonicalJsonStringify(left.scope) === canonicalJsonStringify(right.scope);
}

type ToolResultFact = AcceptedRawFact & {
  readonly envelope: { readonly fact: Extract<ProviderRawFact, { kind: 'tool-result' }> };
};

type ToolCallFact = AcceptedRawFact & {
  readonly envelope: { readonly fact: Extract<ProviderRawFact, { kind: 'tool-call' }> };
};

function isToolCallFact(value: AcceptedRawFact): value is ToolCallFact {
  return value.envelope.fact.kind === 'tool-call';
}

function isToolResultFact(value: AcceptedRawFact): value is ToolResultFact {
  return value.envelope.fact.kind === 'tool-result';
}

function carriesEvidence(fact: ToolResultFact, delivery: EvidenceRef): boolean {
  return fact.envelope.fact.result.evidenceRefs.some((evidence) => sameEvidenceIdentity(evidence, delivery))
    || sameEvidenceIdentity(fact.envelope.fact.rawOutput.ref, delivery);
}

/**
 * Collects accepted tool-result facts from the live prefix and the exact
 * captures. Overlapping captures that name the same exact source merge by
 * deterministic envelope identity; no other deduplication is allowed.
 */
function collectAcceptedToolResults(input: StandardTurnDeliveryReadInput): readonly ToolResultFact[] {
  const collected: ToolResultFact[] = [];
  const seen = new Set<string>();
  const add = (entry: AcceptedTurnEntry): void => {
    if (!('envelope' in entry)) return;
    if (!isToolResultFact(entry)) return;
    const key = canonicalJsonStringify(entry.envelope);
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(entry);
  };
  for (const entry of input.entries) add(entry);
  for (const segment of input.exactSegments ?? []) {
    for (const entry of segment.entries) add(entry);
  }
  return collected;
}

/**
 * Collects accepted tool-call facts from the live prefix and the exact
 * captures, deduplicating by deterministic envelope identity only. It is the
 * accepted source set a text end call must actually belong to.
 */
function collectAcceptedToolCalls(input: StandardTurnDeliveryReadInput): readonly ToolCallFact[] {
  const collected: ToolCallFact[] = [];
  const seen = new Set<string>();
  const add = (entry: AcceptedTurnEntry): void => {
    if (!('envelope' in entry)) return;
    if (!isToolCallFact(entry)) return;
    const key = canonicalJsonStringify(entry.envelope);
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(entry);
  };
  for (const entry of input.entries) add(entry);
  for (const segment of input.exactSegments ?? []) {
    for (const entry of segment.entries) add(entry);
  }
  return collected;
}

function requireStringField(value: unknown, field: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.text-arguments-invalid',
      'the persisted standard-turn end arguments are not a JSON object');
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  if (typeof fieldValue !== 'string') {
    throw new StandardTurnDeliveryError('standard-turn-delivery.text-arguments-invalid',
      `the persisted standard-turn end arguments carry no string ${field}`);
  }
  return fieldValue;
}

/** Reads the model-persisted `deliveryText` from the accepted end call arguments. */
function persistedDeliveryText(argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch (cause) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.text-arguments-invalid',
      'the persisted standard-turn end arguments are not valid JSON', OWNER, { cause });
  }
  return requireStringField(parsed, 'deliveryText');
}

/**
 * The physical execution identity this accepted fact is bound to. It is read
 * from the fact itself: the envelope's `execution` is the real parent
 * `ActiveTurnProviderExecutionIdentityRef`, and the tool result extends
 * `ProviderExecutionIdentityRef` with the real execution provenance. The result
 * is the authoritative full identity; the envelope runtimeId/epoch must agree.
 * The fact carries no separate child `toolOperationId` field, so the tool
 * operation stays a typed dependency on the lookup binding's own tool operation.
 */
function factExecution(fact: ToolResultFact): ProviderExecutionIdentityRef {
  const result = fact.envelope.fact.result;
  if (result.runtimeId !== fact.envelope.execution.runtimeId
    || result.executionEpoch !== fact.envelope.execution.executionEpoch) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.completion-conflict',
      `the accepted tool result identity disagrees with its envelope for call ${fact.envelope.fact.callId}`);
  }
  return {
    runtimeId: result.runtimeId,
    taskId: result.taskId,
    operationId: result.operationId,
    ...(result.organId === undefined ? {} : { organId: result.organId }),
    ...(result.cycleId === undefined ? {} : { cycleId: result.cycleId }),
    executionEpoch: result.executionEpoch,
  };
}

/**
 * The artifact references the matched accepted tool-result actually returned.
 * A confirmed completion's outputRef must be one of these; a non-empty string
 * or equal bytes digest does not prove artifact identity.
 */
function actualArtifactRefs(fact: ToolResultFact): readonly string[] {
  const result = fact.envelope.fact.result;
  const refs = new Set<string>(result.outputRefs);
  if (result.outputRef !== undefined) refs.add(result.outputRef);
  return [...refs];
}

/**
 * The exact completion lookup for one accepted fact. The lookup descriptors are
 * typed and the capture owner already resolved them; the fact side is built
 * from the fact's real physical execution and source provenance. The parent
 * execution, the shared organ/task/cycle scope and the request/call/continuation
 * are verified against the fact. The accepted fact's `envelope.scope.operationId`
 * is the parent operation, while the binding's scope/toolOperationId are the
 * child tool operation; those two scopes must not be forced equal. The tool
 * operation id is not carried by the fact, so it stays a typed dependency on the
 * capture owner's committed lookup and is never fabricated or self-proven here.
 */
function lookupForFact(fact: ToolResultFact, lookups: readonly CompletionReadInput[]): CompletionReadInput {
  const source = factExecution(fact);
  const matches = lookups.filter((lookup) => {
    const binding = lookup.binding;
    const sameExecution =
      binding.execution.runtimeId === source.runtimeId
      && binding.execution.taskId.value === source.taskId.value
      && binding.execution.operationId.value === source.operationId.value
      && binding.execution.organId?.value === source.organId?.value
      && binding.execution.cycleId?.value === source.cycleId?.value
      && binding.execution.executionEpoch === source.executionEpoch;
    // Only the shared organ/task/cycle of the tool scope is proven from the
    // fact; the tool operation id differs from the parent scope by contract.
    const sameScope =
      binding.scope.organId.value === fact.envelope.scope.organId.value
      && binding.scope.taskId?.value === fact.envelope.scope.taskId?.value
      && binding.scope.cycleId?.value === fact.envelope.scope.cycleId?.value;
    const sameCall =
      binding.requestId === fact.envelope.request.requestId
      && binding.callId === fact.envelope.fact.callId
      && binding.continuationRef === fact.envelope.fact.continuationRef;
    return sameExecution && sameScope && sameCall;
  });
  if (matches.length === 0) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.completion-unknown',
      `the accepted call ${fact.envelope.fact.callId} has no exact committed completion lookup`);
  }
  if (matches.length > 1) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.completion-conflict',
      `the accepted call ${fact.envelope.fact.callId} matches ${matches.length} committed completion lookups`);
  }
  return matches[0]!;
}

async function readAssetBytes(reader: StandardTurnDeliveryReaderPort, scope: ScopeRef, content: RawAsset): Promise<Uint8Array> {
  return await reader.rawContent.read({ scope, content });
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.body-utf8',
      `${label} raw bytes do not decode as UTF-8`, OWNER, { cause });
  }
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The produced-artifact reference for one pure-text delivery: a stable URI over
 * the immutable body asset's evidence identity. It names the real durable body
 * and never depends on the local store root. The App side that writes the body
 * asset mirrors this exact form when it reads an output back.
 */
function textArtifactRef(bodyAsset: RawAsset): string {
  return `humanagent://standard-turn-delivery/text/${bodyAsset.ref.evidenceId.value}`;
}

/**
 * Resolves the accepted end call a text delivery is bound to. The App stamps
 * the trusted end control edge with the actual Provider request/call,
 * execution and scope; the Runtime binds by that exact reference and never
 * selects a call by tool name. A text delivery with no trusted reference is an
 * explicit unresolved end call: there is no unique, latest or name fallback.
 */
function resolveAcceptedEndCall(
  input: StandardTurnDeliveryReadInput,
  acceptedEnd: StandardTurnEndCommand,
): ToolCallFact {
  const reference = acceptedEnd.acceptedEndCall;
  if (reference === undefined) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.end-call-unresolved',
      'the accepted text delivery carries no trusted end call reference');
  }
  const matches = collectAcceptedToolCalls(input).filter((call) =>
    call.envelope.request.requestId === reference.requestId
    && call.envelope.fact.call.callId === reference.callId
    && call.envelope.execution.runtimeId === reference.execution.runtimeId
    && call.envelope.execution.executionEpoch === reference.execution.executionEpoch
    && canonicalJsonStringify(call.envelope.scope) === canonicalJsonStringify(reference.scope)
    && isStandardTurnEndToolId(call.envelope.fact.call.toolId));
  if (matches.length === 0) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.end-call-unresolved',
      'the accepted text delivery has no accepted standard-turn end call at its trusted reference');
  }
  if (matches.length > 1) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.end-call-unresolved',
      `the accepted text delivery resolves to ${matches.length} accepted standard-turn end calls`);
  }
  return matches[0]!;
}

export async function readStandardTurnDelivery(
  input: StandardTurnDeliveryReadInput,
  reader: StandardTurnDeliveryReaderPort,
): Promise<StandardTurnDeliveryReadback> {
  const { assignment, acceptedEnd } = input;
  if (acceptedEnd.kind !== 'standard-turn-end') {
    throw new StandardTurnDeliveryError('standard-turn-delivery.end-unbound',
      'the accepted command is not a standard turn end');
  }
  if (acceptedEnd.identity.taskRef.value !== assignment.taskId.value
    || acceptedEnd.identity.workAssignmentRef !== assignment.assignmentId
    || acceptedEnd.identity.inputRevision !== assignment.inputRevision) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.end-unbound',
      'the accepted end identity does not match the assignment business turn');
  }
  const facts = collectAcceptedToolResults(input);
  const materials: StandardTurnDeliveryMaterial[] = [];
  for (const delivery of acceptedEnd.resolvedEvidenceRefs) {
    const matches = facts.filter((fact) => carriesEvidence(fact, delivery)
      && !isStandardTurnEndToolId(fact.envelope.fact.result.toolId));
    if (matches.length > 1) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.evidence-ambiguous',
        `delivery evidence ${delivery.locator} resolves to ${matches.length} accepted tool results`);
    }
    const fact = matches[0];
    if (fact === undefined) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.evidence-unresolved',
        `delivery evidence ${delivery.locator} does not resolve to an accepted tool result`);
    }
    const rawOutput = fact.envelope.fact.rawOutput;
    const bytes = await readAssetBytes(reader, fact.envelope.scope, rawOutput);
    decodeUtf8(bytes, `delivery ${delivery.locator}`);
    const lookup = lookupForFact(fact, input.completionLookups);
    const readback: CompletionReadback = await reader.completion.readExact(lookup);
    if (readback.state !== 'confirmed') {
      throw new StandardTurnDeliveryError('standard-turn-delivery.completion-unknown',
        `completion for effect ${lookup.effectId} is ${readback.state}`);
    }
    const completion = readback.receipt;
    if (completion.fact.effect.effectId !== lookup.effectId) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.completion-conflict',
        `completion effect id does not match the exact lookup for ${lookup.effectId}`);
    }
    if (completion.fact.result.status !== 'succeeded') {
      throw new StandardTurnDeliveryError('standard-turn-delivery.completion-conflict',
        `completion for ${lookup.effectId} is not succeeded`);
    }
    if (completion.fact.confirmation.method !== 'file-readback-digest') {
      throw new StandardTurnDeliveryError('standard-turn-delivery.completion-conflict',
        `completion for ${lookup.effectId} does not carry file-readback-digest confirmation`);
    }
    const bytesDigest = await digestOf(bytes);
    if (bytesDigest !== completion.fact.result.outputDigest) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.artifact-conflict',
        `raw asset bytes digest does not match the completion output digest for ${lookup.effectId}`);
    }
    if (rawOutput.ref.digest !== undefined && rawOutput.ref.digest !== bytesDigest) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.artifact-conflict',
        `raw asset reference digest does not match the read bytes for ${lookup.effectId}`);
    }
    const artifactRef = completion.fact.result.outputRef;
    if (artifactRef === '' ) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.artifact-conflict',
        `completion for ${lookup.effectId} has no artifact reference`);
    }
    const actualRefs = actualArtifactRefs(fact);
    if (!actualRefs.includes(artifactRef)) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.artifact-conflict',
        `completion artifact reference ${artifactRef} is not one the accepted tool result actually returned: ${actualRefs.join(', ')}`);
    }
    materials.push({
      kind: 'tool-report',
      deliveryEvidence: delivery,
      acceptedToolResult: fact,
      completion,
      rawOutput,
      bytes,
      sourceEvidence: [...fact.envelope.fact.result.evidenceRefs],
    });
  }
  if (acceptedEnd.deliveryText !== undefined) {
    const endCall = resolveAcceptedEndCall(input, acceptedEnd);
    const rawArguments = endCall.envelope.fact.rawArguments;
    // The Provider codec persists the wire `arguments` string under the
    // `arguments` view, so the reader already returns the model arguments JSON.
    // The exact text body is the `deliveryText` field of that object.
    const argumentsJson = decodeUtf8(
      await readAssetBytes(reader, endCall.envelope.scope, rawArguments),
      'standard-turn end arguments',
    );
    if (persistedDeliveryText(argumentsJson) !== acceptedEnd.deliveryText) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.text-mismatch',
        'the persisted raw end arguments do not carry the accepted delivery text');
    }
    if (input.deliveryTextBody === undefined) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.text-source-missing',
        'the accepted text delivery has no immutable body asset');
    }
    const bodyAsset = input.deliveryTextBody;
    const bytes = await readAssetBytes(reader, endCall.envelope.scope, bodyAsset);
    const bytesDigest = await digestOf(bytes);
    if (bodyAsset.ref.digest !== undefined && bodyAsset.ref.digest !== bytesDigest) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.artifact-conflict',
        'the immutable delivery text body reference digest does not match its read bytes');
    }
    if (decodeUtf8(bytes, 'bound delivery text') !== acceptedEnd.deliveryText) {
      throw new StandardTurnDeliveryError('standard-turn-delivery.text-mismatch',
        'the immutable delivery text body does not equal the accepted delivery text');
    }
    const deliveryEvidence = endCall.envelope.fact.rawArguments.ref;
    materials.push({
      kind: 'delivery-text',
      deliveryEvidence,
      acceptedEndCall: endCall,
      rawArguments,
      bodyAsset,
      bytes,
      digest: bytesDigest,
      sourceEvidence: [bodyAsset.ref],
    });
  }
  return { assignment, acceptedEnd, materials };
}

export function bindAssignmentDelivery(input: StandardTurnDeliveryBindInput): StandardTurnDeliveryBinding {
  const { assignment, readback } = input;
  if (assignment.expectedOutputRefs.length !== 1) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.binding-invalid',
      'this increment binds exactly one assignment-level logical output');
  }
  if (canonicalJsonStringify(readback.assignment) !== canonicalJsonStringify(assignment)) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.binding-invalid',
      'the readback assignment does not match the caller assignment');
  }
  if (readback.acceptedEnd.kind !== 'standard-turn-end'
    || readback.acceptedEnd.identity.taskRef.value !== assignment.taskId.value
    || readback.acceptedEnd.identity.workAssignmentRef !== assignment.assignmentId
    || readback.acceptedEnd.identity.inputRevision !== assignment.inputRevision) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.binding-invalid',
      'the readback accepted end does not match the assignment business turn');
  }
  if (readback.materials.length === 0) {
    throw new StandardTurnDeliveryError('standard-turn-delivery.binding-invalid',
      'the readback has no delivery material');
  }
  const evidenceRefs: EvidenceRef[] = [];
  for (const material of readback.materials) {
    if (!evidenceRefs.some((existing) => sameEvidenceIdentity(existing, material.deliveryEvidence))) {
      evidenceRefs.push(material.deliveryEvidence);
    }
    for (const evidence of material.sourceEvidence) {
      if (!evidenceRefs.some((existing) => sameEvidenceIdentity(existing, evidence))) evidenceRefs.push(evidence);
    }
  }

  // One material is exactly one produced artifact. A text delivery emits the
  // immutable body asset as its single artifact with the digest of the exact
  // bytes; a tool report emits its confirmed completion identity. The two
  // sources stay separate by construction: no text material carries a
  // completion receipt and no report material carries a text body.
  const producedArtifactRefs = readback.materials.map((material) => material.kind === 'delivery-text'
    ? textArtifactRef(material.bodyAsset)
    : material.completion.fact.result.outputRef);
  const producedArtifactDigests = readback.materials.map((material) => material.kind === 'delivery-text'
    ? material.digest
    : material.completion.fact.result.outputDigest);
  return {
    assignment,
    outputRefs: [...assignment.expectedOutputRefs],
    producedArtifactRefs,
    producedArtifactDigests,
    producedArtifactBodies: readback.materials.map((material) => decodeUtf8(material.bytes, 'bound delivery body')),
    evidenceRefs,
    readback,
  };
}
