import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
  validateTaskCheckPolicy,
  validateTaskExecutionEvidence,
  validateTaskVerificationBinding,
  validateTaskVerificationPolicy,
  validateTaskVerificationResult,
  type EvidenceRef,
  type Scope,
  type TaskCheckEvidence,
  type TaskCheckPolicy,
  type TaskExecutionEvidence,
  type TaskVerificationBinding,
  type TaskVerificationPolicy,
  type TaskVerificationResult,
  type TaskVisualObservationReceipt,
} from '../../../contracts/src/index.js';
import type {
  TaskObservationProductionPort,
  TaskVerificationExecutionPort,
  TaskVerificationPort,
} from '../gateway/ports.js';
import { verificationPolicyDigest } from './verification-policy-compiler.js';

export class TaskVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskVerificationError';
  }
}

export class TaskVerificationIdentityConflictError extends TaskVerificationError {
  readonly code = 'identity-conflict';

  constructor(message: string) {
    super(message);
    this.name = 'TaskVerificationIdentityConflictError';
  }
}

interface SingleFlightEntry {
  readonly identity: string;
  readonly execution: Promise<TaskCheckEvidence>;
}

function sameTask(left: TaskVerificationBinding['taskId'], right: TaskExecutionEvidence['taskId']): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function sameOperation(left: TaskVerificationBinding['operationId'], right: TaskExecutionEvidence['operationId']): boolean {
  return left.scope === right.scope && left.value === right.value;
}

function attemptFor(policy: TaskVerificationPolicy, binding: TaskVerificationBinding, executionEvidence: TaskExecutionEvidence): number {
  if (!Number.isSafeInteger(binding.attempt) || binding.attempt < 1) {
    throw new TaskVerificationError('task verification binding attempt must be a positive safe integer');
  }
  if (binding.executionEvidenceRef !== `task-execution:${executionEvidence.operationId.value}`) {
    throw new TaskVerificationError('task verification binding execution evidence reference does not match');
  }
  if (binding.executionEvidenceDigest !== executionEvidence.inputArtifactDigest) {
    throw new TaskVerificationError('task verification binding execution evidence digest does not match');
  }
  if (binding.policyRef !== policy.compiledRef || binding.policyDigest !== policy.compiledDigest) {
    throw new TaskVerificationError('task verification binding policy identity does not match');
  }
  return binding.attempt;
}

function allEvidence(checks: readonly TaskCheckEvidence[], extra: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const evidence = [...extra];
  for (const check of checks) evidence.push(...check.evidenceRefs);
  return evidence;
}

function statusFor(evidence: TaskCheckEvidence): 'succeeded' | 'failed' | 'blocked' | 'cancelled' {
  return evidence.status === 'timed-out' ? 'failed' : evidence.status;
}

function artifactIdentityMatches(binding: TaskVerificationBinding, evidence: TaskCheckEvidence): boolean {
  const actual = [...evidence.artifactDigests].sort();
  const expected = binding.artifacts.map((artifact) => artifact.artifactDigest).sort();
  return actual.length === expected.length && actual.every((digest, index) => digest === expected[index]);
}

export interface TaskVerificationBridgeOptions {
  readonly execution: TaskVerificationExecutionPort;
  readonly observation?: TaskObservationProductionPort;
  readonly evidenceScope: Scope;
  readonly now?: () => string;
}

function receiptMismatch(binding: TaskVerificationBinding, receipt: TaskVisualObservationReceipt): string | undefined {
  const primary = binding.artifacts.find((artifact) => artifact.role === 'primary');
  if (receipt.taskId.scope !== binding.taskId.scope || receipt.taskId.value !== binding.taskId.value) {
    return 'observation receipt task identity does not match the immutable binding';
  }
  if (receipt.operationId.scope !== binding.operationId.scope || receipt.operationId.value !== binding.operationId.value) {
    return 'observation receipt operation identity does not match the immutable binding';
  }
  if (receipt.executionEpoch !== binding.executionEpoch) return 'observation receipt execution epoch does not match the immutable binding';
  if (receipt.attempt !== binding.attempt) return 'observation receipt attempt does not match the immutable binding';
  if (receipt.bindingRef !== binding.bindingRef || receipt.bindingDigest !== binding.bindingDigest) {
    return 'observation receipt binding identity does not match the immutable binding';
  }
  if (primary === undefined || receipt.primaryArtifactRef !== primary.artifactRef || receipt.primaryArtifactDigest !== primary.artifactDigest) {
    return 'observation receipt primary artifact does not match the immutable binding';
  }
  if (receipt.browserRelease.released !== true) return 'observation receipt does not prove browser release';
  return undefined;
}

export class TaskVerificationBridge implements TaskVerificationPort {
  private readonly executions = new Map<string, SingleFlightEntry>();

  constructor(private readonly options: TaskVerificationBridgeOptions) {
    if (this.options.evidenceScope.organId.scope !== 'organ'
      || !this.options.evidenceScope.organId.value.trim()) {
      throw new TaskVerificationError('task verification evidence scope requires an organ');
    }
  }

  async verify(input: {
    readonly policy: TaskVerificationPolicy;
    readonly binding: TaskVerificationBinding;
    readonly executionEvidence: TaskExecutionEvidence;
  }): Promise<TaskVerificationResult> {
    const { policy, binding, executionEvidence } = input;
    validateTaskVerificationPolicy(policy);
    validateTaskVerificationBinding(binding);
    validateTaskExecutionEvidence(executionEvidence);
    const attempt = attemptFor(policy, binding, executionEvidence);
    if (!sameTask(binding.taskId, executionEvidence.taskId)
      || !sameOperation(binding.operationId, executionEvidence.operationId)
      || binding.executionEpoch !== executionEvidence.executionEpoch) {
      return this.result(policy, binding, executionEvidence, 'rejected', [], 'identity-mismatch');
    }
    const actualPolicyDigest = verificationPolicyDigest(policy);
    if (actualPolicyDigest !== policy.compiledDigest) {
      throw new TaskVerificationError('task verification policy digest does not match its canonical content');
    }
    const primary = binding.artifacts.find((artifact) => artifact.role === 'primary');
    if (primary === undefined || primary.artifactDigest !== executionEvidence.inputArtifactDigest) {
      return this.result(policy, binding, executionEvidence, 'rejected', [], 'identity-mismatch');
    }
    const checks: TaskCheckEvidence[] = [];
    for (const policyCheck of policy.checks) {
      validateTaskCheckPolicy(policyCheck);
      if (!policyCheck.required) continue;
      try {
        const evidence = await this.executeOnce({
          policy,
          binding,
          check: policyCheck,
        });
        if (evidence.checkId !== policyCheck.checkId || evidence.kind !== policyCheck.kind) {
          checks.push({
            checkId: policyCheck.checkId,
            kind: policyCheck.kind,
            status: policyCheck.kind === 'process' ? 'failed' : 'blocked',
            ...(policyCheck.kind === 'process'
              ? { stdout: '', stderr: 'check evidence identity mismatched', exitCode: null }
              : { decisionRef: `verification-mismatch:${policyCheck.checkId}`, decisionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }),
            artifactDigests: binding.artifacts.map((artifact) => artifact.artifactDigest),
            evidenceRefs: [this.evidence(binding, 'identity-mismatch')],
          } as TaskCheckEvidence);
          continue;
        }
        if (!artifactIdentityMatches(binding, evidence)) {
          checks.push(this.failureEvidence(policyCheck, binding, new TaskVerificationError(
            `check ${policyCheck.checkId} evidence artifact identity does not match the immutable binding`,
          )));
          continue;
        }
        checks.push(evidence);
      } catch (error) {
        if (error instanceof TaskVerificationIdentityConflictError) throw error;
        checks.push(this.failureEvidence(policyCheck, binding, error));
      }
    }
    const requiredChecks = policy.checks.filter((check) => check.required);
    const missingCheck = requiredChecks.find((check) => !checks.some((evidence) => evidence.checkId === check.checkId));
    if (missingCheck !== undefined) {
      return this.result(policy, binding, executionEvidence, 'missing', checks);
    }
    const failed = checks.find((check) => statusFor(check) === 'failed');
    if (failed !== undefined) {
      return this.result(policy, binding, executionEvidence, 'rejected', checks, 'checker-rejected');
    }
    const cancelled = checks.find((check) => statusFor(check) === 'cancelled');
    if (cancelled !== undefined) {
      return this.result(policy, binding, executionEvidence, 'cancelled', checks);
    }
    const blocked = checks.find((check) => statusFor(check) === 'blocked');
    if (blocked !== undefined) {
      return this.result(policy, binding, executionEvidence, 'blocked', checks);
    }
    if (checks.some((check) => statusFor(check) !== 'succeeded')) {
      return this.result(policy, binding, executionEvidence, 'failed', checks);
    }
    return this.result(policy, binding, executionEvidence, 'success', checks, undefined, attempt);
  }

  private executeOnce(input: {
    readonly policy: TaskVerificationPolicy;
    readonly binding: TaskVerificationBinding;
    readonly check: TaskCheckPolicy;
  }): Promise<TaskCheckEvidence> {
    const key = `${input.binding.operationId.value}:${input.binding.executionEpoch}:${input.binding.attempt}:${input.check.checkId}`;
    const identity = canonicalJsonStringify({
      taskId: input.binding.taskId,
      operationId: input.binding.operationId,
      executionEpoch: input.binding.executionEpoch,
      attempt: input.binding.attempt,
      policyRef: input.policy.compiledRef,
      policyDigest: input.policy.compiledDigest,
      binding: input.binding,
      check: input.check,
    });
    const existing = this.executions.get(key);
    if (existing) {
      if (existing.identity !== identity) {
        throw new TaskVerificationIdentityConflictError(
          `task verification single-flight identity conflict for ${key}: requested immutable verification identity does not match the existing execution`,
        );
      }
      return existing.execution;
    }
    const execution = this.runCheck(input);
    this.executions.set(key, { identity, execution });
    return execution;
  }

  private async runCheck(input: {
    readonly policy: TaskVerificationPolicy;
    readonly binding: TaskVerificationBinding;
    readonly check: TaskCheckPolicy;
  }): Promise<TaskCheckEvidence> {
    const check = input.check;
    if (check.kind !== 'native' || check.evaluator !== 'aitest-visual-motion-v1') {
      return this.options.execution.execute(input);
    }
    if (check.visual === undefined) {
      return this.observationBlocked(check, input.binding, 'blocked', 'aitest-visual-motion-v1 requires typed visual control');
    }
    if (this.options.observation === undefined) {
      return this.observationBlocked(check, input.binding, 'blocked', 'the visual observation producer is not assembled for this bridge');
    }
    const produced = await this.options.observation.produce({ policy: check.visual, binding: input.binding });
    if (produced.status !== 'produced') {
      const status = produced.status === 'cancelled' ? 'cancelled' : 'blocked';
      const reason = produced.error?.message ?? produced.abort?.nextAction ?? `observation production ended with ${produced.status}`;
      return this.observationBlocked(check, input.binding, status, reason, produced.evidenceRefs);
    }
    const mismatch = receiptMismatch(input.binding, produced.receipt);
    if (mismatch !== undefined) {
      return this.observationBlocked(check, input.binding, 'blocked', mismatch, produced.receipt.evidenceRefs);
    }
    return this.options.execution.execute({ ...input, observation: produced.receipt });
  }

  private observationBlocked(
    check: TaskCheckPolicy,
    binding: TaskVerificationBinding,
    status: 'blocked' | 'cancelled',
    message: string,
    extraEvidence: readonly EvidenceRef[] = [],
  ): TaskCheckEvidence {
    const material = `visual-observation:${check.checkId}:${message}`;
    return {
      checkId: check.checkId,
      kind: 'native',
      status,
      decisionRef: `task-verification-observation:${check.checkId}`,
      decisionDigest: `sha256:${createHash('sha256').update(material).digest('hex')}`,
      artifactDigests: binding.artifacts.map((artifact) => artifact.artifactDigest),
      evidenceRefs: [...extraEvidence, this.evidence(binding, `observation-${status}:${check.checkId}`)],
    };
  }

  private failureEvidence(check: TaskCheckPolicy, binding: TaskVerificationBinding, error: unknown): TaskCheckEvidence {
    const material = error instanceof Error ? error.message : 'check execution failed';
    if (check.kind === 'process') {
      return {
        checkId: check.checkId,
        kind: 'process',
        status: 'failed',
        stdout: '',
        stderr: material,
        exitCode: null,
        artifactDigests: binding.artifacts.map((artifact) => artifact.artifactDigest),
        evidenceRefs: [this.evidence(binding, `execution-failed:${check.checkId}`)],
      };
    }
    return {
      checkId: check.checkId,
      kind: 'native',
      status: 'blocked',
      decisionRef: `task-verification-error:${check.checkId}`,
      decisionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      artifactDigests: binding.artifacts.map((artifact) => artifact.artifactDigest),
      evidenceRefs: [this.evidence(binding, `execution-failed:${check.checkId}`)],
    };
  }

  private result(
    policy: TaskVerificationPolicy,
    binding: TaskVerificationBinding,
    executionEvidence: TaskExecutionEvidence,
    status: TaskVerificationResult['status'],
    checks: readonly TaskCheckEvidence[],
    rejectionCode?: TaskVerificationResult['rejectionCode'],
    attempt = binding.attempt,
  ): TaskVerificationResult {
    const result: TaskVerificationResult = {
      taskId: binding.taskId,
      operationId: binding.operationId,
      executionEpoch: binding.executionEpoch,
      attempt,
      inputArtifactDigest: executionEvidence.inputArtifactDigest,
      policyRef: policy.compiledRef,
      policyDigest: policy.compiledDigest,
      status,
      ...(rejectionCode === undefined ? {} : { rejectionCode }),
      checks,
      evidenceRefs: allEvidence(checks, executionEvidence.evidenceRefs),
    };
    validateTaskVerificationResult(result);
    return result;
  }

  private evidence(binding: TaskVerificationBinding, label: string): EvidenceRef {
    return {
      evidenceId: {
        scope: 'evidence',
        value: `task-verification-${binding.operationId.value}-${label}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128),
      },
      kind: 'operation',
      source: 'humanagent.runtime.task-verification',
      locator: `runtime://task-verification/${encodeURIComponent(binding.operationId.value)}/${label}`,
      digest: binding.bindingDigest,
      scope: this.options.evidenceScope,
    };
  }
}
