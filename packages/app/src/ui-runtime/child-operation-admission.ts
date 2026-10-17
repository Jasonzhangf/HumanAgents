import { assertSameScope, type ToolRegistration } from '../../../contracts/src/index.js';
import type { ActiveTurnContext, ActiveTurnSegmentContext } from '../../../runtime/src/context/active-turn-context.js';
import type { OperationControlBinding } from '../../../runtime/src/gateway/ports.js';
import { APP_CHILD_CALL_TOOL, type AppChildOperationAdmissionPort } from './child-producer.js';
import type { createExecutionAdmission } from './execution-admission.js';

export interface AppChildOperationAdmissionOptions {
  readonly admission: Pick<ReturnType<typeof createExecutionAdmission>, 'admitToolOperation'>;
  readonly binding: OperationControlBinding;
  readonly parent: Pick<ActiveTurnContext | ActiveTurnSegmentContext, 'entries' | 'requests' | 'scope' | 'executionIdentity'>;
  readonly registration: ToolRegistration;
}

export function createAppChildOperationAdmission(
  options: AppChildOperationAdmissionOptions,
): AppChildOperationAdmissionPort {
  return async (call) => {
    const { binding, parent, registration, admission } = options;
    const execution = parent.executionIdentity();
    if (call.parentExecution.runtimeId !== binding.agentRuntimeId
      || call.parentExecution.executionEpoch !== binding.harnessExecutionEpoch
      || execution.runtimeId !== binding.agentRuntimeId
      || execution.executionEpoch !== binding.harnessExecutionEpoch
      || call.parentExecution.taskId.value !== binding.scope.taskId?.value
      || call.parentExecution.operationId.value !== binding.parentOperationId.value) {
      throw new Error('child admission parent execution does not match the host binding');
    }
    assertSameScope(call.scope, binding.scope);
    assertSameScope(parent.scope(), binding.scope);
    const { taskId, cycleId } = binding.scope;
    if (!taskId || !cycleId) throw new Error('child admission requires the parent task and cycle');
    if (registration.toolName !== APP_CHILD_CALL_TOOL.toolId) {
      throw new Error('child admission requires the host child.call registration');
    }
    const request = parent.requests().find((entry) => entry.request.requestId === call.providerRequestId);
    if (!request) throw new Error('child admission requires a registered parent request');
    assertSameScope(request.scope, binding.scope);
    const accepted = parent.entries().find((entry) => 'envelope' in entry
      && entry.envelope.request.requestId === request.request.requestId
      && entry.envelope.request.turnId === request.request.turnId
      && entry.envelope.fact.kind === 'tool-call'
      && entry.envelope.fact.call.callId === call.toolCallId);
    if (!accepted || !('envelope' in accepted)
      || accepted.envelope.fact.kind !== 'tool-call'
      || accepted.envelope.fact.call.toolId !== APP_CHILD_CALL_TOOL.toolId) {
      throw new Error('child admission requires the accepted parent child.call');
    }
    assertSameScope(accepted.envelope.scope, binding.scope);
    if (accepted.envelope.execution.runtimeId !== execution.runtimeId
      || accepted.envelope.execution.executionEpoch !== execution.executionEpoch) {
      throw new Error('accepted child call does not match the parent execution');
    }
    const input = accepted.envelope.fact.rawArguments.ref;
    if (!input.locator.trim() || !input.digest?.trim()) {
      throw new Error('accepted child call is missing its input reference or digest');
    }
    return admission.admitToolOperation({
      binding, registration,
      providerRequestId: call.providerRequestId,
      toolCallId: call.toolCallId,
      intent: {
        operationId: call.childOperationId, taskId, cycleId,
        requestedBy: 'humanagent.app.child-operation-admission', intentRevision: '1',
        kind: 'run', toolName: APP_CHILD_CALL_TOOL.toolId,
        inputRef: input.locator, inputDigest: input.digest,
        requestedScope: { ...binding.scope, operationId: call.childOperationId },
        idempotencyKey: call.invocationId,
        expectedOutput: { schemaRef: registration.outputContract, requiredEvidenceKinds: ['tool'] },
      },
    });
  };
}
