import type { ToolRegistration } from '../../contracts/src/index.js';
import { DeterministicInspectRoute, DETERMINISTIC_INSPECT_ROUTE_VERSION, DETERMINISTIC_INSPECT_TOOL_NAME } from '../../adapters/operations/src/index.js';
import { ToolExecutionGateway, ToolRegistry, type GatewayOptions } from '../../runtime/src/gateway/index.js';

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
  return new ToolExecutionGateway({
    ...input,
    registry,
    executor: route,
    verifier: route,
  });
}
