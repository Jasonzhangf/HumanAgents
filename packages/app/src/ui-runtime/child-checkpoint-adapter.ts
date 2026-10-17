import {
  assertSameScope, canonicalJsonStringify, id, type AdmittedTurn, type Checkpoint, type EvidenceRef, type WorkAssignment,
} from '../../../contracts/src/index.js';
import type { ActiveTurnContext, ActiveTurnSegmentContext } from '../../../runtime/src/context/active-turn-context.js';
import { completeCheckpoint, recallCheckpoint, sameCheckpoint } from '../../../runtime/src/checkpoints/coordinator.js';
import type { CheckpointJournalPort, CommittedCheckpointRecord } from '../../../runtime/src/checkpoints/ports.js';
import type { RegisteredParentChildCall } from '../../../runtime/src/orchestration/types.js';
import type { AppChildCheckpointPort } from './child-producer.js';

export interface AppChildCheckpointAdapterInput {
  readonly store: CheckpointJournalPort;
  readonly parent: ActiveTurnContext | ActiveTurnSegmentContext;
  readonly originalAdmittedTurn: AdmittedTurn;
  readonly recoveryStateRef: EvidenceRef;
}

/** Maps child-call facts; checkpoint validation and native persistence stay with their owners. */
export function createAppChildCheckpointAdapter(input: AppChildCheckpointAdapterInput): AppChildCheckpointPort {
  const ownerId = 'humanagent.app.child-checkpoint';

  function purpose(worker: WorkAssignment): string {
    return `目的：${worker.objective}\n验收：成功—${worker.successCriteria.join('；') || '未列明'}；失败—${worker.failureCriteria.join('；') || '未列明'}；未完成—${worker.incompleteCriteria.join('；') || '未列明'}`;
  }

  async function commit(
    call: RegisteredParentChildCall,
    invocationId: string,
    phase: 'child-call' | 'review-result',
    summary: string,
    nextRef: string,
  ): Promise<CommittedCheckpointRecord> {
    const scope = input.parent.scope();
    const execution = input.parent.executionIdentity();
    assertSameScope(scope, {
      organId: call.parentExecution.organId ?? scope.organId,
      taskId: call.parentExecution.taskId,
      cycleId: call.parentExecution.cycleId ?? scope.cycleId,
      operationId: call.parentExecution.operationId,
    });
    if (call.invocationId !== invocationId
      || call.parentExecution.runtimeId !== execution.runtimeId
      || call.parentExecution.executionEpoch !== execution.executionEpoch
      || input.originalAdmittedTurn.taskRef.value !== scope.taskId?.value) {
      throw new Error('child checkpoint call does not match the parent execution');
    }
    if (!scope.cycleId) throw new Error('child checkpoint requires the current parent cycle');
    const checkpointId = id('checkpoint', `${phase}-${Buffer.from(invocationId, 'utf8').toString('base64url')}`);
    const existing = await input.store.readCommitted(scope, checkpointId);
    const previous = existing ? existing.previous : (await recallCheckpoint(input.store, { ownerId, scope }))?.checkpoint ?? null;
    const checkpoint: Checkpoint = {
      id: checkpointId, scope, cycleId: scope.cycleId,
      seq: existing ? existing.checkpoint.seq : (previous?.seq ?? 0) + 1,
      previousCheckpointId: existing ? existing.checkpoint.previousCheckpointId : previous?.id ?? null,
      directiveRevision: input.originalAdmittedTurn.directiveRevision,
      executionEpoch: execution.executionEpoch,
      outcome: 'waiting', summary, recoveryStateRef: input.recoveryStateRef,
      evidenceRefs: [{
        evidenceId: id('evidence', checkpointId.value),
        kind: 'operation', source: 'child-business-registration',
        locator: call.businessRegistrationCommitRef.commitId, scope,
      }],
      next: { kind: 'wait', ref: nextRef },
    };
    if (existing) {
      if (!sameCheckpoint(existing.checkpoint, checkpoint)) throw new Error('child checkpoint replay conflicts with the committed call');
      return existing;
    }
    await completeCheckpoint(input.store, {
      ownerId, context: { scope, cycleId: scope.cycleId, executionEpoch: execution.executionEpoch,
        directiveRevision: input.originalAdmittedTurn.directiveRevision },
      previous, checkpoint,
    });
    const committed = await input.store.readCommitted(scope, checkpointId);
    if (!committed || !sameCheckpoint(committed.checkpoint, checkpoint)) {
      throw new Error('child checkpoint exact committed readback is missing or different');
    }
    return committed;
  }

  return {
    async pre({ call, selected, worker }) {
      assertSameScope(input.parent.scope(), selected.scope);
      return commit(call, selected.invocationId, 'child-call',
        `${purpose(worker)}${selected.kind === 'review' ? `\n审查类型：${selected.assignment.reviewKind}` : ''}\n当前：准备调用${selected.kind === 'review' ? '审查' : '执行'} child；尚未取得该 child 的返回结果。\n下一步：等待该 child 返回，由编排者判断结果及后续动作。`,
        selected.invocationId);
    },
    async post({ call, returned, worker }) {
      assertSameScope(input.parent.scope(), returned.scope);
      const retained = input.parent.entries().find((entry) => (
        !('envelope' in entry) && entry.kind === 'review' && entry.invocationId === returned.invocationId
      ));
      if (!retained || 'envelope' in retained || retained.kind !== 'review'
        || canonicalJsonStringify(retained.assignment) !== canonicalJsonStringify(returned.assignment)
        || canonicalJsonStringify(retained.result) !== canonicalJsonStringify(returned.result)) {
        throw new Error('child review checkpoint requires the exact durable review return');
      }
      const nextStep = {
        passed: '由编排者核对验收依据并决定是否接纳及继续。',
        failed: '由编排者根据所列发现决定修正工作，修正后再判断是否需要审查。',
        inconclusive: '由编排者补足判断依据，再决定后续动作。',
      }[returned.result.status];
      const findings = returned.result.findings.map((finding) => (
        `${finding.severity}；位置：${finding.locationRef}；问题：${finding.problem}；期望：${finding.expected}`
      )).join('\n') || '本次审查未报告发现';
      return commit(call, returned.invocationId, 'review-result',
        `${purpose(worker)}\n已做：已收到并核对持久化的 ${returned.assignment.reviewKind} 审查返回。\n当前结果：${returned.result.status}。\n发现：${findings}\n下一步：${nextStep}`,
        returned.result.resultId);
    },
  };
}
