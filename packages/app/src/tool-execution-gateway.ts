import type { ToolRegistration } from '../../contracts/src/index.js';
import {
  DeterministicInspectRoute,
  DETERMINISTIC_INSPECT_ROUTE_VERSION,
  DETERMINISTIC_INSPECT_TOOL_NAME,
  OperationAdapterError,
  failureEvidence,
  operationFailure,
} from '../../adapters/operations/src/index.js';
import { HandOperationRuntime } from '../../runtime/src/hand/index.js';
import { ToolExecutionGateway, ToolRegistry, type GatewayOptions, type OperationExecutorPort, type OperationVerifierPort } from '../../runtime/src/gateway/index.js';

export interface ToolExecutionGatewayAssemblyInput extends Omit<GatewayOptions, 'registry' | 'executor' | 'verifier'> {
  readonly route?: DeterministicInspectRoute;
}

export function deterministicInspectRegistration(): ToolRegistration {
  return {
    toolName: DETERMINISTIC_INSPECT_TOOL_NAME,
    contractVersion: '1.0.0',
    supportedKinds: ['inspect'],
    routeId: 'deterministic-inspect',
    routeVersion: DETERMINISTIC_INSPECT_ROUTE_VERSION,
    mode: 'gateway',
    acceptedScopes: [{}],
    inputContract: 'schema://inspect-input/v1',
    outputContract: 'schema://inspect-output/v1',
    verifier: 'verifier://deterministic-inspect/v1',
    capabilities: ['inspect'],
    retryPolicy: 'retry://read-only/v1',
    owner: 'humanagent.operations-adapter',
  };
}

/** Production assembly seam: the app owns route registration; the adapter owns execution and verification. */
export function createToolExecutionGateway(input: ToolExecutionGatewayAssemblyInput): ToolExecutionGateway {
  const route = input.route ?? new DeterministicInspectRoute();
  const registry = new ToolRegistry();
  registry.load([deterministicInspectRegistration()]);
  const executor: OperationExecutorPort = {
    async execute(request) {
      const observation = await route.execute({
        intent: request.intent,
        effectiveScope: request.route.effectiveScope,
      });
      if (observation.operationId.scope !== request.intent.operationId.scope
        || observation.operationId.value !== request.intent.operationId.value) {
        throw new OperationAdapterError(operationFailure({
          errorId: `gateway-observation-${request.intent.operationId.value}-operation-id-mismatch`,
          operationId: request.intent.operationId,
          phase: 'execution',
          failureClass: 'contract',
          message: 'operations adapter returned an observation for a different operation',
          observedAt: new Date().toISOString(),
          impact: 'the gateway cannot trust the adapter observation for this operation',
          protectiveAction: 'reject the mismatched observation before verification',
          nextAction: { kind: 'recover', ref: 'deterministic-inspect' },
          evidenceRefs: [failureEvidence(request.intent.operationId, request.route.effectiveScope, 'operation-id-mismatch')],
        }));
      }
      return {
        executionEpoch: request.lease.executionEpoch,
        status: 'completed' as const,
        outputRef: observation.outputRef,
        outputDigest: observation.outputDigest,
        evidenceRefs: observation.evidenceRefs,
        owner: 'humanagent.operations-adapter',
        sideEffectState: 'none' as const,
      };
    },
  };
  const verifier: OperationVerifierPort = {
    async verify(request) {
      const result = await route.verify({
        intent: request.intent,
        effectiveScope: request.route.effectiveScope,
        observation: {
          operationId: request.intent.operationId,
          outputRef: request.observation.outputRef,
          outputDigest: request.observation.outputDigest,
          evidenceRefs: request.observation.evidenceRefs,
        },
      });
      if (result.operationId.scope !== request.intent.operationId.scope
        || result.operationId.value !== request.intent.operationId.value) {
        throw new OperationAdapterError(operationFailure({
          errorId: `gateway-verification-${request.intent.operationId.value}-operation-id-mismatch`,
          operationId: request.intent.operationId,
          phase: 'verification',
          failureClass: 'contract',
          message: 'operations adapter returned a verification result for a different operation',
          observedAt: new Date().toISOString(),
          impact: 'the gateway cannot trust the adapter verification for this operation',
          protectiveAction: 'reject the mismatched verification before terminal settlement',
          nextAction: { kind: 'recover', ref: 'deterministic-inspect' },
          evidenceRefs: [failureEvidence(request.intent.operationId, request.route.effectiveScope, 'verification-operation-id-mismatch')],
        }));
      }
      return {
        executionEpoch: request.observation.executionEpoch,
        accepted: result.status === 'succeeded',
        decision: result.verifier.decision,
        evidenceRefs: result.evidenceRefs,
        ...(result.failure ? { message: result.failure.message } : {}),
      };
    },
  };
  return new ToolExecutionGateway({
    ...input,
    registry,
    executor,
    verifier,
  });
}

/**
 * App-level seam from an implicit-brain operation intent to the semantic
 * virtual-tool gateway. Hand owns no route lifecycle or duplicate state.
 */
export function createHandOperationRuntime(input: ToolExecutionGatewayAssemblyInput): HandOperationRuntime {
  return new HandOperationRuntime(createToolExecutionGateway(input));
}
