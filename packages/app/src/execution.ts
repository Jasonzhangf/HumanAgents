import {
  validateExecutionBinding,
  type ExecutionBinding,
  type ExecutionRuntimePort,
  type ProviderReadiness,
} from '../../contracts/src/index.js';
import { AppLifecycleError } from './errors.js';

export interface RuntimeExecutionBinding {
  readonly binding: ExecutionBinding;
  readonly port: ExecutionRuntimePort;
}

export function bindExecutionRuntime(input: RuntimeExecutionBinding): RuntimeExecutionBinding {
  try {
    validateExecutionBinding(input.binding);
  } catch (error) {
    throw new AppLifecycleError(
      'execution-binding-invalid',
      error instanceof Error ? error.message : 'execution binding validation failed',
      'provide an explicit runtime and provider binding',
      'execution-runtime',
      error,
    );
  }
  if (input.port.kind !== 'humanagent.execution-runtime-port') {
    throw new AppLifecycleError(
      'execution-port-invalid',
      'execution runtime port kind is not supported',
      'bind a provider-neutral ExecutionRuntimePort implementation',
      'execution-runtime',
    );
  }
  return Object.freeze({ binding: input.binding, port: input.port });
}

export async function probeExecutionRuntime(runtime: RuntimeExecutionBinding): Promise<ProviderReadiness> {
  return runtime.port.probe(runtime.binding.provider);
}
