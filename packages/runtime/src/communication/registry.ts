import {
  assertEvidenceRef,
  assertExecutionEpoch,
  type EvidenceRef,
} from '../../../contracts/src/index.js';
import { CapabilityCallError, CapabilityRegistryError } from './errors.js';
import type {
  CapabilityAuthorizationRequest,
  CapabilityCallRequest,
  CapabilityRegistration,
  RegisteredCapability,
} from './types.js';

const PRIVATE_ACCESS_KEYS = [
  'session',
  'sessionId',
  'sessionRef',
  'privateSession',
  'privateSessionRef',
  'context',
  'contextId',
  'contextRef',
  'journal',
  'journalRef',
] as const;

function requireReference(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new CapabilityRegistryError(`${label} is required`, {
    reason: 'registration-invalid',
    nextAction: { kind: 'stop', ref: 'invalid-capability-registration' },
  });
  return value;
}

function requireCallReference(value: string | undefined, label: string): string {
  if (!value?.trim()) {
    throw new CapabilityCallError(`${label} is required`, {
      reason: 'invalid-capability-call',
      nextAction: { kind: 'stop', ref: 'invalid-capability-call' },
    });
  }
  return value;
}

function validateEvidenceRefs(evidenceRefs: readonly EvidenceRef[]): void {
  try {
    for (const evidenceRef of evidenceRefs) assertEvidenceRef(evidenceRef);
  } catch (error) {
    throw new CapabilityRegistryError('capability evidence is invalid', {
      reason: 'registration-invalid',
      nextAction: { kind: 'stop', ref: 'invalid-capability-registration' },
      evidenceRefs,
      cause: error,
    });
  }
}

function registrationIdentityKey(registration: CapabilityRegistration): string {
  return `${registration.ownerRef}\u0000${registration.scopeRef}\u0000${registration.capabilityRef}`;
}

function copy(record: RegisteredCapability): RegisteredCapability {
  return Object.freeze({
    ...record,
    allowedCallerRefs: Object.freeze([...record.allowedCallerRefs]),
    evidenceRefs: Object.freeze([...record.evidenceRefs]),
  });
}

function assertRegistration(input: CapabilityRegistration): void {
  requireReference(input.capabilityId, 'capabilityId');
  requireReference(input.capabilityRef, 'capabilityRef');
  requireReference(input.ownerRef, 'ownerRef');
  requireReference(input.scopeRef, 'scopeRef');
  requireReference(input.permissionRevision, 'permissionRevision');
  try {
    assertExecutionEpoch(input.executionEpoch);
  } catch (error) {
    throw new CapabilityRegistryError('capability execution epoch is invalid', {
      ownerRef: input.ownerRef,
      reason: 'registration-invalid',
      nextAction: { kind: 'stop', ref: 'invalid-capability-registration' },
      evidenceRefs: input.evidenceRefs,
      cause: error,
    });
  }
  if (input.allowedCallerRefs.length === 0) {
    throw new CapabilityRegistryError('allowedCallerRefs must not be empty', {
      ownerRef: input.ownerRef,
      reason: 'registration-invalid',
      nextAction: { kind: 'stop', ref: 'invalid-capability-registration' },
      evidenceRefs: input.evidenceRefs,
    });
  }
  for (const callerRef of input.allowedCallerRefs) {
    requireReference(callerRef, 'allowed caller ref');
  }
  validateEvidenceRefs(input.evidenceRefs);
}

export function assertNoPrivateSessionAccess(request: CapabilityCallRequest): void {
  for (const key of PRIVATE_ACCESS_KEYS) {
    if (key in request) {
      throw new CapabilityCallError(`capability call cannot access private ${key}`, {
        reason: 'private-session-access-forbidden',
        nextAction: { kind: 'stop', ref: 'private-session-access-forbidden' },
        evidenceRefs: request.evidenceRefs,
      });
    }
  }
}

export function assertCapabilityCallRequest(request: CapabilityCallRequest): void {
  assertNoPrivateSessionAccess(request);
  requireCallReference(request.requestId, 'requestId');
  requireCallReference(request.capabilityId, 'capabilityId');
  requireCallReference(request.capabilityRef, 'capabilityRef');
  requireCallReference(request.callerRef, 'callerRef');
  requireCallReference(request.scopeRef, 'scopeRef');
  requireCallReference(request.permissionRevision, 'permissionRevision');
  requireCallReference(request.requestedAt, 'requestedAt');
  if (!Number.isSafeInteger(request.executionEpoch) || request.executionEpoch < 1) {
    throw new CapabilityCallError('executionEpoch must be a positive safe integer', {
      reason: 'invalid-capability-call',
      nextAction: { kind: 'stop', ref: 'invalid-capability-call' },
      evidenceRefs: request.evidenceRefs,
    });
  }
  if (request.assignmentId !== undefined) requireCallReference(request.assignmentId, 'assignmentId');
  for (const inputRef of request.inputRefs) requireCallReference(inputRef, 'inputRef');
  validateEvidenceRefs(request.evidenceRefs);
  if (!Number.isFinite(Date.parse(request.requestedAt))) {
    throw new CapabilityCallError('requestedAt is invalid', {
      reason: 'invalid-capability-call',
      nextAction: { kind: 'stop', ref: 'invalid-capability-call' },
      evidenceRefs: request.evidenceRefs,
    });
  }
}

export class CapabilityRegistry {
  private readonly byId = new Map<string, RegisteredCapability>();
  private readonly byOwnerScopeRef = new Map<string, string>();

  register(input: CapabilityRegistration, registeredAt = new Date().toISOString()): RegisteredCapability {
    assertRegistration(input);
    if (!Number.isFinite(Date.parse(registeredAt))) {
      throw new CapabilityRegistryError('registeredAt is invalid', {
        ownerRef: input.ownerRef,
        reason: 'registration-invalid',
        nextAction: { kind: 'stop', ref: 'invalid-capability-registration' },
        evidenceRefs: input.evidenceRefs,
      });
    }
    if (this.byId.has(input.capabilityId)) {
      throw new CapabilityRegistryError(`capability id already registered: ${input.capabilityId}`, {
        ownerRef: this.byId.get(input.capabilityId)?.ownerRef,
        reason: 'duplicate-capability-id',
        nextAction: { kind: 'stop', ref: 'duplicate-capability-id' },
        evidenceRefs: input.evidenceRefs,
      });
    }
    const ownerScopeKey = registrationIdentityKey(input);
    if (this.byOwnerScopeRef.has(ownerScopeKey)) {
      throw new CapabilityRegistryError(`capability identity already registered: ${input.capabilityRef}`, {
        ownerRef: input.ownerRef,
        reason: 'duplicate-capability-identity',
        nextAction: { kind: 'stop', ref: 'duplicate-capability-identity' },
        evidenceRefs: input.evidenceRefs,
      });
    }
    const record = copy({
      ...input,
      allowedCallerRefs: [...input.allowedCallerRefs],
      evidenceRefs: [...input.evidenceRefs],
      registeredAt,
      revoked: false,
    });
    this.byId.set(record.capabilityId, record);
    this.byOwnerScopeRef.set(ownerScopeKey, record.capabilityId);
    return copy(record);
  }

  resolve(capabilityId: string): RegisteredCapability | null {
    const record = this.byId.get(capabilityId);
    return record ? copy(record) : null;
  }

  revoke(
    capabilityId: string,
    ownerRef: string,
    evidenceRefs: readonly EvidenceRef[] = [],
  ): RegisteredCapability {
    requireReference(capabilityId, 'capabilityId');
    requireReference(ownerRef, 'ownerRef');
    validateEvidenceRefs(evidenceRefs);
    const existing = this.byId.get(capabilityId);
    if (!existing) {
      throw new CapabilityRegistryError(`capability is not registered: ${capabilityId}`, {
        ownerRef,
        reason: 'capability-not-found',
        nextAction: { kind: 'stop', ref: 'capability-not-found' },
        evidenceRefs,
      });
    }
    if (existing.ownerRef !== ownerRef) {
      throw new CapabilityRegistryError('only the registered owner can revoke a capability', {
        ownerRef: existing.ownerRef,
        reason: 'caller-denied',
        nextAction: { kind: 'stop', ref: 'capability-revoke-denied' },
        evidenceRefs,
      });
    }
    if (existing.revoked) return copy(existing);
    const revoked = copy({
      ...existing,
      revoked: true,
      evidenceRefs: [...existing.evidenceRefs, ...evidenceRefs],
    });
    this.byId.set(capabilityId, revoked);
    return copy(revoked);
  }

  authorize(request: CapabilityAuthorizationRequest): RegisteredCapability {
    const evidenceRefs = request.evidenceRefs ?? [];
    try {
      validateEvidenceRefs(evidenceRefs);
    } catch (error) {
      throw new CapabilityRegistryError('capability authorization evidence is invalid', {
        reason: 'registration-invalid',
        nextAction: { kind: 'stop', ref: 'invalid-capability-registration' },
        evidenceRefs,
        cause: error,
      });
    }
    const record = this.byId.get(request.capabilityId);
    if (!record) {
      throw new CapabilityRegistryError(`capability is not registered: ${request.capabilityId}`, {
        reason: 'capability-not-found',
        nextAction: { kind: 'stop', ref: 'capability-not-found' },
        evidenceRefs,
      });
    }
    if (record.revoked) {
      throw new CapabilityRegistryError(`capability is revoked: ${request.capabilityId}`, {
        ownerRef: record.ownerRef,
        reason: 'capability-revoked',
        nextAction: { kind: 'recover', ref: record.ownerRef },
        evidenceRefs,
      });
    }
    if (record.capabilityRef !== request.capabilityRef) {
      throw new CapabilityRegistryError('capability ref does not match registration', {
        ownerRef: record.ownerRef,
        reason: 'capability-ref-mismatch',
        nextAction: { kind: 'stop', ref: 'capability-ref-mismatch' },
        evidenceRefs,
      });
    }
    if (record.scopeRef !== request.scopeRef) {
      throw new CapabilityRegistryError('capability scope does not match registration', {
        ownerRef: record.ownerRef,
        reason: 'scope-denied',
        nextAction: { kind: 'stop', ref: 'capability-scope-denied' },
        evidenceRefs,
      });
    }
    if (record.permissionRevision !== request.permissionRevision) {
      throw new CapabilityRegistryError('capability permission revision is stale', {
        ownerRef: record.ownerRef,
        reason: 'permission-denied',
        nextAction: { kind: 'stop', ref: 'capability-permission-denied' },
        evidenceRefs,
      });
    }
    if (record.executionEpoch !== request.executionEpoch) {
      throw new CapabilityRegistryError('capability execution epoch is stale', {
        ownerRef: record.ownerRef,
        reason: 'epoch-denied',
        nextAction: { kind: 'stop', ref: 'capability-epoch-denied' },
        evidenceRefs,
      });
    }
    if (!record.allowedCallerRefs.includes(request.callerRef)) {
      throw new CapabilityRegistryError('caller is not authorized for capability', {
        ownerRef: record.ownerRef,
        reason: 'caller-denied',
        nextAction: { kind: 'stop', ref: 'capability-caller-denied' },
        evidenceRefs,
      });
    }
    return copy(record);
  }

  authorizeCapabilityCall(request: CapabilityCallRequest): RegisteredCapability {
    assertCapabilityCallRequest(request);
    return this.authorize(request);
  }
}
