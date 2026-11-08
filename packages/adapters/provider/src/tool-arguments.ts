import type { BusinessPayload } from '../../../contracts/src/index.js';

const invalidToolArgumentRaw = new WeakMap<object, string>();

export interface InvalidToolArguments {
  readonly code: 'tool.arguments.invalid-json';
  readonly rawArguments: string;
  readonly message: string;
}

/**
 * Marks a call's `arguments` object as containing malformed provider input,
 * without writing the malformed string or any control marker into the business
 * payload. The empty object remains the raw-fact `arguments`; the original
 * malformed string is kept only in this request-local sidecar.
 */
export function markInvalidToolArguments(
  argumentsValue: BusinessPayload,
  rawArguments: string,
  message: string,
): InvalidToolArguments {
  invalidToolArgumentRaw.set(argumentsValue, rawArguments);
  return {
    code: 'tool.arguments.invalid-json',
    rawArguments,
    message,
  };
}

export function invalidToolArguments(
  argumentsValue: BusinessPayload | undefined | null,
): InvalidToolArguments | undefined {
  if (argumentsValue === undefined || argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return undefined;
  }
  const rawArguments = invalidToolArgumentRaw.get(argumentsValue);
  if (rawArguments === undefined) return undefined;
  return {
    code: 'tool.arguments.invalid-json',
    rawArguments,
    message: `provider tool arguments are invalid JSON: ${rawArguments}`,
  };
}

export function invalidRawArguments(argumentsValue: BusinessPayload | undefined | null): string | undefined {
  return invalidToolArguments(argumentsValue)?.rawArguments;
}
