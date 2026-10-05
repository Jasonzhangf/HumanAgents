/// <reference path="./node-modules.d.ts" />
import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  validateDraftConfirmation,
  validateDraftRevision,
  validateDraftRevisionInput,
  validateExecutionPolicyDefinition,
  type DraftConfirmation,
  type DraftRevision,
  type DraftRevisionFailure,
  type DraftRevisionFailureCode,
  type DraftRevisionInput,
  type DraftRevisionRef,
  type ExecutionPolicyDefinition,
  type FinalSubmit,
  type RequirementIntent,
} from '../../contracts/src/index.js';
import { CoreError } from './errors.js';

/**
 * Domain failure for the explicit draft lifecycle. The typed `code` is the
 * contract-level DraftRevisionFailureCode; callers surface
 * {@link DraftRevisionError.toFailure} to the public boundary instead of
 * re-deriving the reason from message text.
 */
export class DraftRevisionError extends CoreError {
  readonly code: DraftRevisionFailureCode;
  readonly draftId: string;
  readonly expectedRevisionVersion?: number;
  readonly expectedRevisionHash?: string;
  readonly actualRevisionVersion?: number;
  readonly actualRevisionHash?: string;

  constructor(failure: DraftRevisionFailure) {
    super(failure.message);
    this.name = 'DraftRevisionError';
    this.code = failure.code;
    this.draftId = failure.draftId;
    this.expectedRevisionVersion = failure.expectedRevisionVersion;
    this.expectedRevisionHash = failure.expectedRevisionHash;
    this.actualRevisionVersion = failure.actualRevisionVersion;
    this.actualRevisionHash = failure.actualRevisionHash;
  }

  toFailure(): DraftRevisionFailure {
    return {
      code: this.code,
      message: this.message,
      draftId: this.draftId,
      ...(this.expectedRevisionVersion === undefined ? {} : { expectedRevisionVersion: this.expectedRevisionVersion }),
      ...(this.expectedRevisionHash === undefined ? {} : { expectedRevisionHash: this.expectedRevisionHash }),
      ...(this.actualRevisionVersion === undefined ? {} : { actualRevisionVersion: this.actualRevisionVersion }),
      ...(this.actualRevisionHash === undefined ? {} : { actualRevisionHash: this.actualRevisionHash }),
    };
  }
}

/**
 * The only fields a refinement may edit. `normalizedInput` is the execution
 * input and must change with every accepted refinement; revision version,
 * revision hash, history, previous ref, state and the immutable original are
 * derived here and can never be edited directly.
 */
const REFINABLE_FIELDS = [
  'goal',
  'scope',
  'constraints',
  'deliverables',
  'normalizedInput',
  'proposedIntent',
  'proposal',
  'knownFacts',
  'executionPolicy',
] as const;

type RefinableField = (typeof REFINABLE_FIELDS)[number];

const REFINABLE = new Set<string>(REFINABLE_FIELDS);

/**
 * The revision hash covers the immutable *content* of a revision only. Derived
 * lifecycle metadata (`state`, `history`, `previousRevisionRef`, `supersededBy`,
 * `staleReason`) is deliberately excluded: a confirmation binds the content
 * hash, so transitioning draft → confirmed → submitted must not invalidate an
 * already valid confirmation.
 */
function hashableContent(revision: DraftRevision | Omit<DraftRevision, 'revisionHash'>): Record<string, unknown> {
  return {
    draftId: revision.draftId,
    revisionVersion: revision.revisionVersion,
    inputRevision: revision.inputRevision,
    goal: revision.goal,
    scope: revision.scope,
    constraints: revision.constraints,
    deliverables: revision.deliverables,
    normalizedInput: revision.normalizedInput,
    proposedIntent: revision.proposedIntent,
    proposal: revision.proposal,
    matchedTasks: revision.matchedTasks,
    knownFacts: revision.knownFacts,
    decisionRefs: revision.decisionRefs,
    immutableOriginalRef: revision.immutableOriginalRef,
    ...(revision.executionPolicy === undefined ? {} : { executionPolicy: revision.executionPolicy }),
    ...(revision.executionControlRef === undefined ? {} : { executionControlRef: revision.executionControlRef }),
  };
}

export function draftRevisionHash(revision: DraftRevision | Omit<DraftRevision, 'revisionHash'>): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(hashableContent(revision))).digest('hex')}`;
}

export function draftRevisionRef(revision: DraftRevision): DraftRevisionRef {
  return {
    draftId: revision.draftId,
    revisionVersion: revision.revisionVersion,
    revisionHash: revision.revisionHash,
  };
}

export interface CreateDraftRevisionInput {
  readonly draftId: string;
  readonly inputRevision: number;
  readonly goal: string;
  readonly scope: string;
  readonly constraints?: readonly string[];
  readonly deliverables?: readonly string[];
  readonly normalizedInput: string;
  readonly proposedIntent: RequirementIntent;
  readonly proposal: string;
  readonly matchedTasks?: readonly string[];
  readonly knownFacts?: readonly string[];
  readonly decisionRefs?: readonly string[];
  readonly executionPolicy?: ExecutionPolicyDefinition;
  readonly executionControlRef?: string;
  readonly immutableOriginalRef: string;
}

/**
 * Build the first immutable revision of a draft. The immutable original input
 * is referenced (never copied) so later refinements keep pointing at the raw
 * user input that started the interaction.
 */
export function createDraftRevision(input: CreateDraftRevisionInput): DraftRevision {
  const revision: Omit<DraftRevision, 'revisionHash'> = {
    draftId: input.draftId,
    revisionVersion: 1,
    inputRevision: input.inputRevision,
    goal: input.goal,
    scope: input.scope,
    constraints: [...(input.constraints ?? [])],
    deliverables: [...(input.deliverables ?? [])],
    normalizedInput: input.normalizedInput,
    proposedIntent: input.proposedIntent,
    proposal: input.proposal,
    matchedTasks: [...(input.matchedTasks ?? [])],
    knownFacts: [...(input.knownFacts ?? [])],
    decisionRefs: [...(input.decisionRefs ?? [])],
    state: 'draft',
    history: [],
    immutableOriginalRef: input.immutableOriginalRef,
    ...(input.executionPolicy === undefined ? {} : { executionPolicy: input.executionPolicy }),
    ...(input.executionControlRef ? { executionControlRef: input.executionControlRef } : {}),
  };
  const created: DraftRevision = { ...revision, revisionHash: draftRevisionHash(revision) };
  validateDraftRevision(created);
  return created;
}

function fail(code: DraftRevisionFailureCode, draftId: string, message: string, extra: Partial<DraftRevisionFailure> = {}): never {
  throw new DraftRevisionError({ code, draftId, message, ...extra });
}

function requireString(draftId: string, field: RefinableField, value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid-refinement', draftId, `draft refinement ${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(draftId: string, field: RefinableField, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    fail('invalid-refinement', draftId, `draft refinement ${field} must be a non-empty string array`);
  }
  return [...value];
}

function requireIntent(draftId: string, value: unknown): RequirementIntent {
  if (value !== 'create' && value !== 'append' && value !== 'change') {
    fail('invalid-refinement', draftId, 'draft refinement proposedIntent is invalid');
  }
  return value;
}

function requireExecutionPolicy(draftId: string, value: unknown): ExecutionPolicyDefinition {
  try {
    validateExecutionPolicyDefinition(value as ExecutionPolicyDefinition);
    return structuredClone(value as ExecutionPolicyDefinition);
  } catch {
    fail('invalid-refinement', draftId, 'draft refinement executionPolicy is invalid');
  }
}

function applyFields(current: DraftRevision, fields: Readonly<Record<string, unknown>>): DraftRevision {
  const draftId = current.draftId;
  return {
    ...current,
    goal: fields.goal === undefined ? current.goal : requireString(draftId, 'goal', fields.goal),
    scope: fields.scope === undefined ? current.scope : requireString(draftId, 'scope', fields.scope),
    constraints: fields.constraints === undefined ? current.constraints : requireStringArray(draftId, 'constraints', fields.constraints),
    deliverables: fields.deliverables === undefined ? current.deliverables : requireStringArray(draftId, 'deliverables', fields.deliverables),
    normalizedInput: fields.normalizedInput === undefined ? current.normalizedInput : requireString(draftId, 'normalizedInput', fields.normalizedInput),
    proposedIntent: fields.proposedIntent === undefined ? current.proposedIntent : requireIntent(draftId, fields.proposedIntent),
    proposal: fields.proposal === undefined ? current.proposal : requireString(draftId, 'proposal', fields.proposal),
    knownFacts: fields.knownFacts === undefined ? current.knownFacts : requireStringArray(draftId, 'knownFacts', fields.knownFacts),
    ...(fields.executionPolicy === undefined
      ? {}
      : { executionPolicy: requireExecutionPolicy(draftId, fields.executionPolicy) }),
  };
}

/**
 * Produce the next revision of a draft from an explicit typed edit. The caller
 * must name the base revision version and hash; a stale base is rejected
 * without touching the current revision. Every accepted refinement must change
 * both the revision hash and the normalized execution input.
 */
export function refineDraftRevision(current: DraftRevision, input: DraftRevisionInput): DraftRevision {
  validateDraftRevision(current);
  validateDraftRevisionInput(input);
  if (input.draftId !== current.draftId) {
    fail('stale-revision', current.draftId, 'draft refinement addresses a different draft', {
      expectedRevisionVersion: current.revisionVersion,
      expectedRevisionHash: current.revisionHash,
    });
  }
  if (current.state !== 'draft') {
    fail('stale-revision', current.draftId, `cannot refine draft from state ${current.state}`, {
      actualRevisionVersion: current.revisionVersion,
      actualRevisionHash: current.revisionHash,
    });
  }
  if (input.baseRevisionVersion !== current.revisionVersion) {
    fail('stale-revision', current.draftId, `draft refinement expected version ${input.baseRevisionVersion}, current is ${current.revisionVersion}`, {
      expectedRevisionVersion: input.baseRevisionVersion,
      actualRevisionVersion: current.revisionVersion,
      actualRevisionHash: current.revisionHash,
    });
  }
  if (input.requestedRevisionHash !== current.revisionHash) {
    fail('revision-hash-mismatch', current.draftId, 'draft refinement hash does not match the current revision', {
      expectedRevisionHash: input.requestedRevisionHash,
      actualRevisionHash: current.revisionHash,
      actualRevisionVersion: current.revisionVersion,
    });
  }

  const fields = input.fields;
  for (const field of Object.keys(fields)) {
    if (!REFINABLE.has(field)) {
      fail('invalid-refinement', current.draftId, `draft refinement cannot change ${field}`);
    }
  }
  if (Object.keys(fields).length === 0) {
    fail('invalid-refinement', current.draftId, 'draft refinement must change at least one field');
  }
  if (fields.normalizedInput === undefined) {
    fail('invalid-refinement', current.draftId, 'draft refinement must update normalized execution input');
  }

  const applied = applyFields(current, fields);
  if (applied.normalizedInput === current.normalizedInput) {
    fail('invalid-refinement', current.draftId, 'draft refinement did not update normalized execution input');
  }

  const { revisionHash: _previousHash, ...appliedContent } = applied;
  const next: Omit<DraftRevision, 'revisionHash'> = {
    ...appliedContent,
    revisionVersion: current.revisionVersion + 1,
    state: 'draft',
    previousRevisionRef: current.revisionHash,
    history: [...current.history, draftRevisionRef(current)],
  };
  const updated: DraftRevision = { ...next, revisionHash: draftRevisionHash(next) };
  validateDraftRevision(updated);
  if (updated.revisionHash === current.revisionHash) {
    fail('invalid-refinement', current.draftId, 'draft refinement did not produce a new revision hash');
  }
  return updated;
}

/**
 * Supersede a draft revision. The superseded revision is retained (it is the
 * only record of the earlier user edit) and marked stale with a reason.
 */
export function supersedeDraftRevision(current: DraftRevision, reason: string, supersededBy: string): DraftRevision {
  validateDraftRevision(current);
  if (!reason.trim()) fail('stale-revision', current.draftId, 'supersede reason is required');
  if (!supersededBy.trim()) fail('stale-revision', current.draftId, 'superseding draft reference is required');
  const { revisionHash: _previousHash, ...currentContent } = current;
  const next: Omit<DraftRevision, 'revisionHash'> = {
    ...currentContent,
    state: 'stale',
    staleReason: reason,
    supersededBy,
  };
  const updated: DraftRevision = { ...next, revisionHash: draftRevisionHash(next) };
  validateDraftRevision(updated);
  return updated;
}

export function assertDraftRevisionHash(revision: DraftRevision): void {
  validateDraftRevision(revision);
  const { revisionHash, ...hashable } = revision;
  if (revisionHash !== draftRevisionHash(hashable)) {
    fail('revision-hash-mismatch', revision.draftId, 'draft revision hash does not match its content', {
      actualRevisionVersion: revision.revisionVersion,
      actualRevisionHash: revisionHash,
    });
  }
}

export function assertDraftRevisionCurrent(
  current: DraftRevision,
  expected: { readonly revisionVersion: number; readonly revisionHash: string },
): void {
  assertDraftRevisionHash(current);
  if (current.revisionVersion !== expected.revisionVersion) {
    fail('stale-revision', current.draftId, 'draft confirmation is stale', {
      expectedRevisionVersion: expected.revisionVersion,
      actualRevisionVersion: current.revisionVersion,
      actualRevisionHash: current.revisionHash,
    });
  }
  if (current.revisionHash !== expected.revisionHash) {
    fail('confirmation-stale', current.draftId, 'confirmation hash does not match the current draft revision', {
      expectedRevisionHash: expected.revisionHash,
      actualRevisionHash: current.revisionHash,
      actualRevisionVersion: current.revisionVersion,
    });
  }
}

/**
 * A confirmation is only valid for the exact draft revision it names. This is
 * the invariant that prevents an old confirmation from authorizing a newer
 * (edited) revision.
 */
export function assertDraftConfirmation(draft: DraftRevision, confirmation: DraftConfirmation): void {
  assertDraftRevisionHash(draft);
  validateDraftConfirmation(confirmation);
  if (confirmation.draftId !== draft.draftId) {
    fail('confirmation-stale', draft.draftId, 'confirmation addresses a different draft');
  }
  if (confirmation.draftRevisionVersion !== draft.revisionVersion) {
    fail('stale-revision', draft.draftId, `confirmation is for revision ${confirmation.draftRevisionVersion}, current is ${draft.revisionVersion}`, {
      expectedRevisionVersion: confirmation.draftRevisionVersion,
      actualRevisionVersion: draft.revisionVersion,
      actualRevisionHash: draft.revisionHash,
    });
  }
  if (confirmation.draftRevisionHash !== draft.revisionHash) {
    fail('confirmation-stale', draft.draftId, 'confirmation hash does not match the current draft revision', {
      expectedRevisionHash: confirmation.draftRevisionHash,
      actualRevisionHash: draft.revisionHash,
      actualRevisionVersion: draft.revisionVersion,
    });
  }
}

/**
 * Exact-submit invariant: the final new-task-create submit is the only
 * authorization point and must name the confirmed revision. A preview, a
 * rejected/stale draft, or a mismatched confirmation can never authorize.
 */
export function assertFinalSubmit(
  draft: DraftRevision,
  confirmation: DraftConfirmation,
  submit: FinalSubmit,
): void {
  if (submit.requestKind !== 'new-task-create') {
    fail('unauthorized-final-submit', draft.draftId, 'only new-task-create may authorize a new task');
  }
  if (draft.state === 'rejected' || draft.state === 'stale') {
    fail('unauthorized-final-submit', draft.draftId, `cannot authorize a ${draft.state} draft`);
  }
  assertDraftConfirmation(draft, confirmation);
  if (submit.draftId !== draft.draftId) {
    fail('stale-revision', draft.draftId, 'final submit addresses a different draft');
  }
  if (submit.draftRevisionVersion !== draft.revisionVersion) {
    fail('stale-revision', draft.draftId, `final submit is for revision ${submit.draftRevisionVersion}, current is ${draft.revisionVersion}`, {
      expectedRevisionVersion: submit.draftRevisionVersion,
      actualRevisionVersion: draft.revisionVersion,
      actualRevisionHash: draft.revisionHash,
    });
  }
  if (submit.draftRevisionHash !== draft.revisionHash) {
    fail('confirmation-stale', draft.draftId, 'final submit hash does not match the current draft revision', {
      expectedRevisionHash: submit.draftRevisionHash,
      actualRevisionHash: draft.revisionHash,
      actualRevisionVersion: draft.revisionVersion,
    });
  }
  if (submit.confirmationRef !== confirmation.confirmationRef) {
    fail('unauthorized-final-submit', draft.draftId, 'final submit does not carry the confirmed confirmation');
  }
}

/**
 * Field-level diff between two revisions of the same draft, used to keep the
 * user-visible edit history honest (the diff is derived from the two immutable
 * revisions, not from mutable session state).
 */
export function draftRevisionDiff(previous: DraftRevision, current: DraftRevision): readonly string[] {
  const changed: string[] = [];
  for (const field of REFINABLE_FIELDS) {
    const before = previous[field];
    const after = current[field];
    const same = Array.isArray(before) && Array.isArray(after)
      ? before.length === after.length && before.every((entry, index) => entry === after[index])
      : canonicalJsonStringify(before ?? null) === canonicalJsonStringify(after ?? null);
    if (!same) changed.push(field);
  }
  return changed;
}
