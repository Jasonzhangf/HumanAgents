import assert from 'node:assert/strict';
import test from 'node:test';

import {
  id,
  type AuthorizedRequirement,
  type ExecutionPolicyDefinition,
} from '../../../packages/contracts/src/index.js';
import { ExecutionPolicyCompiler } from '../../../packages/runtime/src/explicit-brain/router.js';
import {
  AITEST_VERIFICATION_PROFILE_REF,
  DEFAULT_VERIFICATION_PROFILE_REF,
  LOCAL_FILE_SEARCH_VERIFICATION_PROFILE_REF,
  WEB_SEARCH_VERIFICATION_PROFILE_REF,
  VerificationPolicyCompiler,
  VerificationPolicyCompilerError,
  validateVerificationPolicyBinding,
  verificationPolicyDigest,
} from '../../../packages/runtime/src/ui-runtime/verification-policy-compiler.js';

const authorized: AuthorizedRequirement = {
  requirementId: 'requirement:verification-policy-a',
  draftId: 'draft-verification-policy-a',
  inputRevision: 3,
  draftRevisionVersion: 2,
  draftRevisionHash: 'sha256:draft-verification-policy-a',
  confirmationRef: 'confirmation:verification-policy-a',
  fifoSeq: 1,
  payloadRef: 'artifact://requirements/verification-policy-a',
};

const SHA256_HEX = `sha256:${'a'.repeat(64)}`;

function policy(verificationProfileRef?: string): ExecutionPolicyDefinition {
  return {
    policyId: 'policy-verification-a',
    policyRevision: 4,
    ...(verificationProfileRef === undefined ? {} : { verificationProfileRef }),
    executionMode: 'once',
    timezone: 'America/Los_Angeles',
    canonicalInstant: '2026-10-03T12:00:00.000Z',
    dstMode: 'wall',
    dstMissedPolicy: 'shift-forward',
    dstAmbiguousPolicy: 'earlier-offset',
    latePolicy: 'run-once',
    busyPolicy: 'skip',
    dueAt: '2026-10-03T12:00:00.000Z',
  };
}

test('compiler emits the default profile from compiled execution policy without live identity', () => {
  const compiled = new ExecutionPolicyCompiler().compile(authorized, policy());
  const verification = new VerificationPolicyCompiler().compile({
    authorized,
    compiledExecutionPolicy: compiled,
    control: {
      defaultTaskOutput: {
        evaluatorRef: 'evaluator://default-task-output/v1',
        evaluatorDigest: SHA256_HEX,
        timeoutMs: 5_000,
        permissionRefs: ['permission://task-output/read'],
      },
    },
  });

  assert.equal(verification.profileRef, DEFAULT_VERIFICATION_PROFILE_REF);
  assert.equal(verification.policyId, compiled.policyId);
  assert.equal(verification.policyRevision, compiled.policyRevision);
  assert.equal(verification.requirementId, authorized.requirementId);
  assert.equal(verification.directiveRevision, authorized.inputRevision);
  assert.deepEqual(verification.checks.map((check) => check.checkId), ['native-default-task-output']);
  assert.equal(verification.compiledRef, 'verification-policy:policy-verification-a:4');
  assert.equal(verification.compiledDigest, verificationPolicyDigest(verification));
  assert.doesNotThrow(() => validateVerificationPolicyBinding(verification, {
    policyRef: verification.compiledRef,
    policyDigest: verification.compiledDigest,
  }));
});

test('aitest profile carries exact visual control and rejects missing or mismatched control', () => {
  const compiled = new ExecutionPolicyCompiler().compile(authorized, policy(AITEST_VERIFICATION_PROFILE_REF));
  const visual = {
    evaluator: 'aitest-visual-motion-v1' as const,
    providerBindingRef: 'provider-binding://rcc/multimodal',
    providerBindingDigest: SHA256_HEX,
    routeRef: 'route://rcc/multimodal',
    assertionPolicyRef: 'assertion-policy://aitest/pelican-bicycle/v1',
    assertionPolicyDigest: SHA256_HEX,
    timeoutMs: 30_000,
    permissionRefs: ['permission://browser/capture'],
  };
  const verification = new VerificationPolicyCompiler().compile({
    authorized,
    compiledExecutionPolicy: compiled,
    control: {
      evaluators: {
        aitestVisual: {
          evaluatorRef: 'evaluator://aitest-visual-motion/v1',
          evaluatorDigest: SHA256_HEX,
          timeoutMs: 30_000,
          permissionRefs: ['permission://browser/capture'],
        },
      },
      visual,
      processChecks: [{
        checkId: 'structural-checker',
        kind: 'process',
        required: true,
        executableRef: 'executable://node',
        executableDigest: SHA256_HEX,
        programRef: 'program://aitest/inspect-result',
        programDigest: SHA256_HEX,
        argvSlots: ['primary-artifact-path'],
        cwdRef: 'control',
        envAllowlist: ['PATH'],
        timeoutMs: 10_000,
        permissionRefs: ['permission://process/spawn'],
      }],
    },
  });

  assert.deepEqual(verification.checks.map((check) => check.checkId), ['structural-checker', 'native-aitest-visual-motion']);
  const visualCheck = verification.checks[1];
  assert.equal(visualCheck?.kind, 'native');
  assert.deepEqual(visualCheck?.kind === 'native' ? visualCheck.visual : undefined, visual);
  assert.throws(
    () => new VerificationPolicyCompiler().compile({ authorized, compiledExecutionPolicy: compiled }),
    (error: unknown) => error instanceof VerificationPolicyCompilerError && error.code === 'missing-visual-control',
  );
  assert.throws(
    () => new VerificationPolicyCompiler().compile({
      authorized,
      compiledExecutionPolicy: compiled,
      control: { visual },
    }),
    (error: unknown) => error instanceof VerificationPolicyCompilerError && error.code === 'missing-evaluator-control',
  );
  assert.throws(
    () => validateVerificationPolicyBinding(verification, {
      policyRef: verification.compiledRef,
      policyDigest: 'b'.repeat(64),
    }),
    (error: unknown) => error instanceof VerificationPolicyCompilerError && error.code === 'invalid-compiled-policy',
  );
});

test('unknown profiles fail typed instead of falling back', () => {
  const compiled = new ExecutionPolicyCompiler().compile(authorized, policy('verification-profile://unknown/v1'));
  assert.throws(
    () => new VerificationPolicyCompiler().compile({ authorized, compiledExecutionPolicy: compiled }),
    (error: unknown) => error instanceof VerificationPolicyCompilerError && error.code === 'unknown-profile',
  );
});

test('compiler output has stable canonical digest independent of object insertion order', () => {
  const compiled = new ExecutionPolicyCompiler().compile(authorized, policy());
  const control = {
    defaultTaskOutput: {
      evaluatorRef: 'evaluator://default-task-output/v1',
      evaluatorDigest: SHA256_HEX,
      timeoutMs: 5_000,
      permissionRefs: ['permission://task-output/read'],
    },
  };
  const first = new VerificationPolicyCompiler().compile({ authorized, compiledExecutionPolicy: compiled, control });
  const second = new VerificationPolicyCompiler().compile({
    compiledExecutionPolicy: compiled,
    control: {
      defaultTaskOutput: {
        permissionRefs: ['permission://task-output/read'],
        timeoutMs: 5_000,
        evaluatorDigest: SHA256_HEX,
        evaluatorRef: 'evaluator://default-task-output/v1',
      },
    },
    authorized: structuredClone(authorized),
  });
  assert.deepEqual(second, first);
});

test('compiler is pure and returns no TaskId, OperationId, epoch, attempt, or artifact identity', () => {
  const compiled = new ExecutionPolicyCompiler().compile(authorized, policy());
  const verification = new VerificationPolicyCompiler().compile({
    authorized,
    compiledExecutionPolicy: compiled,
    control: {
      defaultTaskOutput: {
        evaluatorRef: 'evaluator://default-task-output/v1',
        evaluatorDigest: SHA256_HEX,
        timeoutMs: 5_000,
        permissionRefs: [],
      },
    },
  });
const serialized = JSON.stringify(verification);
  assert.equal(serialized.includes('operation'), false);
  assert.equal(serialized.includes('executionEpoch'), false);
  assert.equal(serialized.includes('attempt'), false);
  assert.equal(serialized.includes('"task-a"'), false);
  assert.equal(serialized.includes('artifact://'), false);
});

test('web-search profile requires its typed evaluator control and rejects when it is missing', () => {
  const compiled = new ExecutionPolicyCompiler().compile(authorized, policy(WEB_SEARCH_VERIFICATION_PROFILE_REF));
  const verification = new VerificationPolicyCompiler().compile({
    authorized,
    compiledExecutionPolicy: compiled,
    control: {
      evaluators: {
        webSearchReport: {
          evaluatorRef: 'evaluator://web-search-report/v1',
          evaluatorDigest: SHA256_HEX,
          timeoutMs: 5_000,
          permissionRefs: ['permission://web-search/report'],
        },
      },
    },
  });
  assert.equal(verification.profileRef, WEB_SEARCH_VERIFICATION_PROFILE_REF);
  assert.ok(verification.checks.some((check) => check.kind === 'native' && check.evaluator === 'web-search-report-v1'));
  assert.throws(
    () => new VerificationPolicyCompiler().compile({ authorized, compiledExecutionPolicy: compiled }),
    (error: unknown) => error instanceof VerificationPolicyCompilerError && error.code === 'missing-evaluator-control',
  );
});

test('local-file-search profile requires its typed evaluator control and rejects when it is missing', () => {
  const compiled = new ExecutionPolicyCompiler().compile(authorized, policy(LOCAL_FILE_SEARCH_VERIFICATION_PROFILE_REF));
  const verification = new VerificationPolicyCompiler().compile({
    authorized,
    compiledExecutionPolicy: compiled,
    control: {
      evaluators: {
        localFileSearchReport: {
          evaluatorRef: 'evaluator://local-file-search-report/v1',
          evaluatorDigest: SHA256_HEX,
          timeoutMs: 5_000,
          permissionRefs: ['permission://local-file-search/report'],
        },
      },
    },
  });
  assert.equal(verification.profileRef, LOCAL_FILE_SEARCH_VERIFICATION_PROFILE_REF);
  assert.ok(verification.checks.some((check) => check.kind === 'native' && check.evaluator === 'local-file-search-report-v1'));
  assert.throws(
    () => new VerificationPolicyCompiler().compile({ authorized, compiledExecutionPolicy: compiled }),
    (error: unknown) => error instanceof VerificationPolicyCompilerError && error.code === 'missing-evaluator-control',
  );
});

test('default profile rejects missing typed evaluator control', () => {
  const compiled = new ExecutionPolicyCompiler().compile(authorized, policy());
  assert.throws(
    () => new VerificationPolicyCompiler().compile({ authorized, compiledExecutionPolicy: compiled }),
    (error: unknown) => error instanceof VerificationPolicyCompilerError && error.code === 'missing-evaluator-control',
  );
});
