import { createHash } from 'node:crypto';
import {
  canonicalJsonStringify,
  validateTaskVerificationPolicy,
  type AuthorizedRequirement,
  type ExecutionPolicyDefinition,
  type TaskCheckPolicy,
  type TaskNativeCheckPolicy,
  type TaskProcessCheckPolicy,
  type TaskVerificationPolicy,
  type TaskVisualCheckPolicy,
} from '../../../contracts/src/index.js';
import type { CompiledExecutionPolicy } from '../explicit-brain/router.js';

export const DEFAULT_VERIFICATION_PROFILE_REF = 'verification-profile://default/v1';
export const WEB_SEARCH_VERIFICATION_PROFILE_REF = 'verification-profile://web-search/v1';
export const LOCAL_FILE_SEARCH_VERIFICATION_PROFILE_REF = 'verification-profile://local-file-search/v1';
export const AITEST_VERIFICATION_PROFILE_REF = 'verification-profile://aitest/v1';

export interface VerificationControlInput {
  readonly evaluators?: {
    readonly defaultTaskOutput?: TypedEvaluator;
    readonly webSearchReport?: TypedEvaluator;
    readonly localFileSearchReport?: TypedEvaluator;
    readonly aitestVisual?: TypedEvaluator;
  };
  readonly defaultTaskOutput?: {
    readonly evaluatorRef: string;
    readonly evaluatorDigest: string;
    readonly timeoutMs: number;
    readonly permissionRefs: readonly string[];
  };
  readonly processChecks?: readonly TaskProcessCheckPolicy[];
  readonly visual?: TaskVisualCheckPolicy;
}

export interface TypedEvaluator {
  readonly evaluatorRef: string;
  readonly evaluatorDigest: string;
  readonly timeoutMs: number;
  readonly permissionRefs: readonly string[];
}

export interface VerificationPolicyCompilerInput {
  readonly authorized: AuthorizedRequirement;
  readonly compiledExecutionPolicy: CompiledExecutionPolicy;
  readonly control?: VerificationControlInput;
}

export class VerificationPolicyCompilerError extends Error {
  readonly code:
    | 'invalid-compiled-policy'
    | 'unknown-profile'
    | 'missing-evaluator-control'
    | 'missing-visual-control'
    | 'invalid-visual-control';

  constructor(code: VerificationPolicyCompilerError['code'], message: string) {
    super(message);
    this.name = 'VerificationPolicyCompilerError';
    this.code = code;
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) throw new VerificationPolicyCompilerError('invalid-compiled-policy', `${label} must be non-empty`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VerificationPolicyCompilerError('invalid-compiled-policy', `${label} must be a positive safe integer`);
  }
}

function assertVisualControl(visual: TaskVisualCheckPolicy | undefined): asserts visual is TaskVisualCheckPolicy {
  if (visual === undefined) {
    throw new VerificationPolicyCompilerError(
      'missing-visual-control',
      'aitest verification profile requires resolved visual check control',
    );
  }
  for (const [label, value] of Object.entries({
    providerBindingRef: visual.providerBindingRef,
    providerBindingDigest: visual.providerBindingDigest,
    routeRef: visual.routeRef,
    assertionPolicyRef: visual.assertionPolicyRef,
    assertionPolicyDigest: visual.assertionPolicyDigest,
  })) {
    if (!value || !value.trim()) {
      throw new VerificationPolicyCompilerError('invalid-visual-control', `visual check ${label} must be non-empty`);
    }
  }
  if (visual.evaluator !== 'aitest-visual-motion-v1') {
    throw new VerificationPolicyCompilerError('invalid-visual-control', 'visual check evaluator is invalid');
  }
  if (!Number.isSafeInteger(visual.timeoutMs) || visual.timeoutMs < 1) {
    throw new VerificationPolicyCompilerError('invalid-visual-control', 'visual check timeoutMs must be a positive safe integer');
  }
}

function requireEvaluator(
  evaluator: TypedEvaluator | undefined,
  label: TaskNativeCheckPolicy['evaluator'],
): TypedEvaluator {
  if (evaluator === undefined) {
    throw new VerificationPolicyCompilerError('missing-evaluator-control', `${label} requires typed evaluator identity control`);
  }
  if (!evaluator.evaluatorRef.trim() || !/^sha256:[a-f0-9]{64}$/.test(evaluator.evaluatorDigest)) {
    throw new VerificationPolicyCompilerError('invalid-compiled-policy', `${label} evaluator identity is invalid`);
  }
  if (!Number.isSafeInteger(evaluator.timeoutMs) || evaluator.timeoutMs < 1) {
    throw new VerificationPolicyCompilerError('invalid-compiled-policy', `${label} timeoutMs must be a positive safe integer`);
  }
  return evaluator;
}

function digestPolicy(policy: Omit<TaskVerificationPolicy, 'compiledRef' | 'compiledDigest'>): { readonly compiledRef: string; readonly compiledDigest: string } {
  const digest = createHash('sha256').update(canonicalJsonStringify(policy)).digest('hex');
  return {
    compiledRef: `verification-policy:${policy.policyId}:${policy.policyRevision}`,
    compiledDigest: `sha256:${digest}`,
  };
}

function nativeCheck(input: {
  readonly checkId: string;
  readonly evaluator: TaskNativeCheckPolicy['evaluator'];
  readonly evaluatorDigest: string;
  readonly timeoutMs: number;
  readonly permissionRefs: readonly string[];
  readonly visual?: TaskVisualCheckPolicy;
}): TaskNativeCheckPolicy {
  return {
    checkId: input.checkId,
    kind: 'native',
    required: true,
    evaluator: input.evaluator,
    evaluatorDigest: input.evaluatorDigest,
    timeoutMs: input.timeoutMs,
    permissionRefs: [...input.permissionRefs],
    ...(input.visual === undefined ? {} : { visual: structuredClone(input.visual) }),
  };
}

function defaultChecks(control: VerificationControlInput | undefined): readonly TaskCheckPolicy[] {
  const evaluator = requireEvaluator(
    control?.evaluators?.defaultTaskOutput ?? control?.defaultTaskOutput,
    'default-task-output-v1',
  );
  return [nativeCheck({
    checkId: 'native-default-task-output',
    evaluator: 'default-task-output-v1',
    evaluatorDigest: evaluator.evaluatorDigest,
    timeoutMs: evaluator.timeoutMs,
    permissionRefs: evaluator.permissionRefs,
  })];
}

function webSearchChecks(control: VerificationControlInput | undefined): readonly TaskCheckPolicy[] {
  const evaluator = requireEvaluator(control?.evaluators?.webSearchReport, 'web-search-report-v1');
  return [
    ...(control?.processChecks ?? []).map((check) => structuredClone(check)),
    nativeCheck({
      checkId: 'native-web-search-report',
      evaluator: 'web-search-report-v1',
      evaluatorDigest: evaluator.evaluatorDigest,
      timeoutMs: evaluator.timeoutMs,
      permissionRefs: evaluator.permissionRefs,
    }),
  ];
}

function localFileSearchChecks(control: VerificationControlInput | undefined): readonly TaskCheckPolicy[] {
  const evaluator = requireEvaluator(control?.evaluators?.localFileSearchReport, 'local-file-search-report-v1');
  return [
    ...(control?.processChecks ?? []).map((check) => structuredClone(check)),
    nativeCheck({
      checkId: 'native-local-file-search-report',
      evaluator: 'local-file-search-report-v1',
      evaluatorDigest: evaluator.evaluatorDigest,
      timeoutMs: evaluator.timeoutMs,
      permissionRefs: evaluator.permissionRefs,
    }),
  ];
}

function aitestChecks(control: VerificationControlInput | undefined): readonly TaskCheckPolicy[] {
  assertVisualControl(control?.visual);
  const evaluator = requireEvaluator(control?.evaluators?.aitestVisual, 'aitest-visual-motion-v1');
  return [
    ...(control?.processChecks ?? []).map((check) => structuredClone(check)),
    nativeCheck({
      checkId: 'native-aitest-visual-motion',
      evaluator: 'aitest-visual-motion-v1',
      evaluatorDigest: evaluator.evaluatorDigest,
      timeoutMs: evaluator.timeoutMs,
      permissionRefs: evaluator.permissionRefs,
      visual: control.visual,
    }),
  ];
}

function checksForProfile(profileRef: string, control: VerificationControlInput | undefined): readonly TaskCheckPolicy[] {
  switch (profileRef) {
    case DEFAULT_VERIFICATION_PROFILE_REF:
      return defaultChecks(control);
    case WEB_SEARCH_VERIFICATION_PROFILE_REF:
      return webSearchChecks(control);
    case LOCAL_FILE_SEARCH_VERIFICATION_PROFILE_REF:
      return localFileSearchChecks(control);
    case AITEST_VERIFICATION_PROFILE_REF:
      return aitestChecks(control);
    default:
      throw new VerificationPolicyCompilerError('unknown-profile', `unknown verification profile: ${profileRef}`);
  }
}

export class VerificationPolicyCompiler {
  compile(input: VerificationPolicyCompilerInput): TaskVerificationPolicy {
    const { authorized, compiledExecutionPolicy } = input;
    assertNonEmpty(authorized.requirementId, 'authorized requirementId');
    assertNonEmpty(authorized.draftId, 'authorized draftId');
    assertPositiveInteger(authorized.inputRevision, 'authorized inputRevision');
    assertNonEmpty(authorized.draftRevisionHash, 'authorized draftRevisionHash');
    assertNonEmpty(compiledExecutionPolicy.executionControlRef, 'compiled executionControlRef');
    assertNonEmpty(compiledExecutionPolicy.policyId, 'compiled policyId');
    assertPositiveInteger(compiledExecutionPolicy.policyRevision, 'compiled policyRevision');
    assertNonEmpty(compiledExecutionPolicy.policyHash, 'compiled policyHash');
    assertNonEmpty(compiledExecutionPolicy.definition.policyId, 'execution policy policyId');
    const profileRef = compiledExecutionPolicy.definition.verificationProfileRef ?? DEFAULT_VERIFICATION_PROFILE_REF;
    assertNonEmpty(profileRef, 'execution policy verificationProfileRef');
    const checks = checksForProfile(profileRef, input.control);
    const unsigned: Omit<TaskVerificationPolicy, 'compiledRef' | 'compiledDigest'> = {
      policyId: compiledExecutionPolicy.policyId,
      policyRevision: compiledExecutionPolicy.policyRevision,
      requirementId: authorized.requirementId,
      directiveRevision: authorized.inputRevision,
      profileRef,
      checks,
    };
    const compiled = digestPolicy(unsigned);
    const policy: TaskVerificationPolicy = {
      ...unsigned,
      ...compiled,
    };
    validateTaskVerificationPolicy(policy);
    return policy;
  }
}

export function verificationPolicyDigest(policy: TaskVerificationPolicy): string {
  const { compiledRef: _compiledRef, compiledDigest: _compiledDigest, ...content } = policy;
  return digestPolicy(content).compiledDigest;
}

export function validateVerificationPolicyBinding(
  policy: TaskVerificationPolicy,
  binding: { readonly policyRef: string; readonly policyDigest: string },
): void {
  if (binding.policyRef !== policy.compiledRef || binding.policyDigest !== policy.compiledDigest) {
    throw new VerificationPolicyCompilerError('invalid-compiled-policy', 'verification binding does not match the compiled policy identity');
  }
  const actualDigest = verificationPolicyDigest(policy);
  if (actualDigest !== policy.compiledDigest) {
    throw new VerificationPolicyCompilerError('invalid-compiled-policy', 'verification policy digest does not match its canonical content');
  }
}

export function executionPolicyForVerification(
  definition: ExecutionPolicyDefinition,
): ExecutionPolicyDefinition {
  return definition;
}
