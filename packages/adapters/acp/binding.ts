import {
  id,
  validateAcpDriverBinding,
  validateAcpServerBinding,
  type AcpAllowedSessionKind,
  type AcpDriverBinding,
  type AcpServerBinding,
  type AgentBinding,
  type EvidenceRef,
} from '../../contracts/src/index.js';
import {
  ACP_DRIVER_OWNER,
  ACP_SERVER_OWNER,
  acpError,
  capabilityUnavailable,
} from './errors.js';
import type {
  AcpDelegationProof,
  AcpPeerProof,
  AcpSessionAdmissionSubject,
} from './types.js';

function serverEvidence(binding: AcpServerBinding, locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `acp-server-${binding.bindingRef}-${locator}`),
    kind: 'external',
    source: ACP_SERVER_OWNER,
    locator: `acp/server/${binding.bindingRef}/${locator}`,
    scope: { organId: id('organ', `acp-server-${binding.bindingRef}`) },
  };
}

function driverEvidence(binding: AcpDriverBinding, locator: string): EvidenceRef {
  return {
    evidenceId: id('evidence', `acp-driver-${binding.bindingRef}-${locator}`),
    kind: 'external',
    source: ACP_DRIVER_OWNER,
    locator: `acp/driver/${binding.bindingRef}/${locator}`,
    scope: {
      organId: id('organ', `acp-driver-${binding.bindingRef}`),
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
    },
  };
}

function assertNonEmpty(value: string | undefined, label: string, ownerId: string, evidenceRefs: readonly EvidenceRef[]): asserts value is string {
  if (!value?.trim()) {
    throw acpError('binding-invalid', `${label} is required`, ownerId, { kind: 'stop', ref: `reject-${label}` }, evidenceRefs);
  }
}

function assertSame(actual: string | undefined, expected: string, label: string, ownerId: string, evidenceRefs: readonly EvidenceRef[]): void {
  assertNonEmpty(actual, label, ownerId, evidenceRefs);
  if (actual !== expected) {
    throw acpError('identity-mismatch', `${label} does not match the ACP binding`, ownerId, { kind: 'stop', ref: `reject-${label}` }, evidenceRefs);
  }
}

export function sameAgentBinding(left: AgentBinding, right: AgentBinding): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'interaction' && right.kind === 'interaction') {
    return left.interactionScopeId === right.interactionScopeId
      && left.bindingFingerprint === right.bindingFingerprint;
  }
  if (left.kind === 'task' && right.kind === 'task') {
    return left.taskId.scope === right.taskId.scope
      && left.taskId.value === right.taskId.value
      && left.assignmentId === right.assignmentId
      && left.executionEpoch === right.executionEpoch
      && left.bindingFingerprint === right.bindingFingerprint;
  }
  return false;
}

export class AcpServerBindingGuard {
  readonly binding: AcpServerBinding;

  constructor(binding: AcpServerBinding) {
    try {
      validateAcpServerBinding(binding);
    } catch (error) {
      const evidence = [serverEvidence(binding, 'invalid')];
      throw acpError(
        'binding-invalid',
        error instanceof Error ? error.message : 'ACP server binding is invalid',
        ACP_SERVER_OWNER,
        { kind: 'stop', ref: 'reject-binding' },
        evidence,
        { binding, cause: error },
      );
    }
    this.binding = {
      ...binding,
      allowedSessionKinds: [...binding.allowedSessionKinds],
      allowedCapabilities: [...binding.allowedCapabilities],
    };
  }

  assert(subject: AcpSessionAdmissionSubject): void {
    const evidence = [serverEvidence(this.binding, 'admission')];
    assertSame(subject.principalRef, this.binding.principalRef, 'principalRef', ACP_SERVER_OWNER, evidence);
    assertSame(subject.scopeRef, this.binding.scopeRef, 'scopeRef', ACP_SERVER_OWNER, evidence);
    assertSame(subject.permissionRevision, this.binding.permissionRevision, 'permissionRevision', ACP_SERVER_OWNER, evidence);
    assertSame(subject.bindingDigest, this.binding.bindingDigest, 'bindingDigest', ACP_SERVER_OWNER, evidence);
    assertNonEmpty(subject.capability, 'capability', ACP_SERVER_OWNER, evidence);
    if (!this.binding.allowedSessionKinds.includes(subject.kind)) {
      throw capabilityUnavailable(`ACP session kind is not allowed: ${subject.kind}`, ACP_SERVER_OWNER, evidence, this.binding);
    }
    if (!this.binding.allowedCapabilities.includes(subject.capability)) {
      throw capabilityUnavailable(`ACP capability is not allowed: ${subject.capability}`, ACP_SERVER_OWNER, evidence, this.binding);
    }
  }

  assertProof(proof: AcpPeerProof | undefined): asserts proof is AcpPeerProof {
    const evidence = [serverEvidence(this.binding, 'peer-proof')];
    if (!proof
      || !proof.principalRef?.trim()
      || !proof.scopeRef?.trim()
      || !proof.permissionRevision?.trim()
      || !proof.bindingDigest?.trim()) {
      throw capabilityUnavailable('ACP peer proof is unavailable', ACP_SERVER_OWNER, evidence, this.binding);
    }
    assertSame(proof.principalRef, this.binding.principalRef, 'principalRef', ACP_SERVER_OWNER, evidence);
    assertSame(proof.scopeRef, this.binding.scopeRef, 'scopeRef', ACP_SERVER_OWNER, evidence);
    assertSame(proof.permissionRevision, this.binding.permissionRevision, 'permissionRevision', ACP_SERVER_OWNER, evidence);
    assertSame(proof.bindingDigest, this.binding.bindingDigest, 'bindingDigest', ACP_SERVER_OWNER, evidence);
  }

  negotiate(requestedCapabilities: readonly string[], requestedSessionKinds: readonly AcpAllowedSessionKind[]): {
    readonly capabilities: readonly string[];
    readonly sessionKinds: readonly AcpAllowedSessionKind[];
    readonly evidenceRefs: readonly EvidenceRef[];
  } {
    const evidence = [serverEvidence(this.binding, 'capability-negotiation')];
    for (const kind of requestedSessionKinds) {
      if (kind !== 'interaction' && kind !== 'task') {
        throw capabilityUnavailable(`unknown ACP session kind: ${kind}`, ACP_SERVER_OWNER, evidence, this.binding);
      }
    }
    const capabilities = requestedCapabilities.filter((capability) => this.binding.allowedCapabilities.includes(capability));
    const sessionKinds = requestedSessionKinds.filter((kind) => this.binding.allowedSessionKinds.includes(kind));
    if (requestedCapabilities.length > 0 && capabilities.length === 0) {
      throw capabilityUnavailable('none of the requested ACP capabilities are allowed', ACP_SERVER_OWNER, evidence, this.binding);
    }
    if (requestedSessionKinds.length > 0 && sessionKinds.length === 0) {
      throw capabilityUnavailable('none of the requested ACP session kinds are allowed', ACP_SERVER_OWNER, evidence, this.binding);
    }
    return { capabilities, sessionKinds, evidenceRefs: evidence };
  }
}

export class AcpDriverBindingGuard {
  readonly binding: AcpDriverBinding;

  constructor(binding: AcpDriverBinding) {
    try {
      validateAcpDriverBinding(binding);
    } catch (error) {
      const evidence = [driverEvidence(binding, 'invalid')];
      throw acpError(
        'binding-invalid',
        error instanceof Error ? error.message : 'ACP driver binding is invalid',
        ACP_DRIVER_OWNER,
        { kind: 'stop', ref: 'invalid-driver-binding' },
        evidence,
        { binding, cause: error },
      );
    }
    this.binding = {
      ...binding,
      delegatedCapabilities: [...binding.delegatedCapabilities],
    };
  }

  assertProof(proof: AcpDelegationProof | undefined): asserts proof is AcpDelegationProof {
    const evidence = [driverEvidence(this.binding, 'delegation')];
    if (!proof
      || !proof.proofRef?.trim()
      || !proof.bindingRef?.trim()
      || !proof.externalPeerRef?.trim()
      || !proof.permissionRevision?.trim()
      || !Array.isArray(proof.delegatedCapabilities)) {
      throw capabilityUnavailable('ACP driver delegation proof is unavailable', ACP_DRIVER_OWNER, evidence, this.binding);
    }
    assertSame(proof.proofRef, this.binding.delegationProofRef, 'delegationProofRef', ACP_DRIVER_OWNER, evidence);
    assertSame(proof.bindingRef, this.binding.bindingRef, 'bindingRef', ACP_DRIVER_OWNER, evidence);
    assertSame(proof.externalPeerRef, this.binding.externalPeerRef, 'externalPeerRef', ACP_DRIVER_OWNER, evidence);
    assertSame(proof.permissionRevision, this.binding.permissionRevision, 'permissionRevision', ACP_DRIVER_OWNER, evidence);
  }

  assertDelegation(proof: AcpDelegationProof | undefined, capability: string): void {
    this.assertProof(proof);
    const evidence = [driverEvidence(this.binding, 'delegation')];
    assertNonEmpty(capability, 'capability', ACP_DRIVER_OWNER, evidence);
    if (!proof.delegatedCapabilities.includes(capability) || !this.binding.delegatedCapabilities.includes(capability)) {
      throw capabilityUnavailable(`ACP capability is not delegated: ${capability}`, ACP_DRIVER_OWNER, evidence, this.binding);
    }
  }

  assertCapability(capability: string): void {
    const evidence = [driverEvidence(this.binding, 'capability')];
    assertNonEmpty(capability, 'capability', ACP_DRIVER_OWNER, evidence);
    if (!this.binding.delegatedCapabilities.includes(capability)) {
      throw capabilityUnavailable(`ACP capability is not delegated: ${capability}`, ACP_DRIVER_OWNER, evidence, this.binding);
    }
  }

  evidence(locator: string): EvidenceRef {
    return driverEvidence(this.binding, locator);
  }
}
