import type { AgentBinding, AgentProviderBinding, RuntimeBinding } from '../../contracts/src/index.js';
import {
  assertPermissionRevisionMatches,
  validateAgentBinding,
  validateAgentProviderBinding,
  validateRuntimeBinding,
} from '../../contracts/src/index.js';
import { EpochError, PermissionError } from './errors.js';

function sameScopedTask(left: RuntimeBinding['taskId'], right: AgentBinding): boolean {
  if (right.kind === 'interaction') return false;
  return left?.scope === right.taskId.scope && left.value === right.taskId.value;
}

export function assertRuntimeBindingPermission(binding: RuntimeBinding, expectedPermissionRevision: string): void {
  try {
    assertPermissionRevisionMatches(binding.permissionRevision, expectedPermissionRevision);
  } catch (error) {
    if (error instanceof Error) throw new PermissionError(error.message);
    throw error;
  }
}

export function assertRuntimeBindingEpoch(binding: RuntimeBinding, expectedEpoch: number): void {
  validateRuntimeBinding(binding);
  if (binding.executionEpoch !== expectedEpoch) {
    throw new EpochError(`runtime binding epoch mismatch: ${binding.executionEpoch} != ${expectedEpoch}`);
  }
}

export function assertAgentBindingMatchesRuntime(runtime: RuntimeBinding, agentBinding: AgentBinding): void {
  validateRuntimeBinding(runtime);
  validateAgentBinding(agentBinding);
  if (agentBinding.kind === 'interaction') {
    if (runtime.taskId !== undefined || runtime.assignmentId !== undefined) {
      throw new PermissionError('interaction request cannot use a task-bound runtime');
    }
    if (runtime.interactionScopeId !== agentBinding.interactionScopeId) {
      throw new PermissionError('interaction binding scope mismatch');
    }
    if (runtime.bindingDigest !== agentBinding.bindingFingerprint) {
      throw new PermissionError('interaction binding fingerprint mismatch');
    }
    return;
  }

  if (runtime.taskId === undefined || runtime.assignmentId === undefined) {
    throw new PermissionError('task request requires a task-bound runtime');
  }
  if (!sameScopedTask(runtime.taskId, agentBinding)) {
    throw new PermissionError('task request task mismatch');
  }
  if (runtime.assignmentId !== agentBinding.assignmentId) {
    throw new PermissionError('task request assignment mismatch');
  }
  if (runtime.executionEpoch !== agentBinding.executionEpoch) {
    throw new PermissionError('task request epoch mismatch');
  }
  if (runtime.bindingDigest !== agentBinding.bindingFingerprint) {
    throw new PermissionError('task binding fingerprint mismatch');
  }
}

export function assertRuntimeProviderBindingLocked(runtime: RuntimeBinding, providerBinding: AgentProviderBinding): void {
  validateRuntimeBinding(runtime);
  validateAgentProviderBinding(providerBinding);
  if (runtime.capabilityDigest !== providerBinding.capabilityDigest) {
    throw new PermissionError('runtime capability digest does not match provider binding');
  }
}
