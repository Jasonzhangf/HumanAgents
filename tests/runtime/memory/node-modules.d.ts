declare module 'node:assert/strict' {
  interface Assert {
    throws(fn: () => unknown, error?: new (...args: never[]) => Error | RegExp): void;
    doesNotThrow(fn: () => unknown): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    rejects(fn: Promise<unknown> | (() => Promise<unknown>), error?: RegExp | ((error: unknown) => boolean) | object, message?: string): Promise<void>;
    throws(fn: () => unknown, error?: RegExp | ((error: unknown) => boolean) | object, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}
declare module 'node:test' {
  const test: (name: string, fn: () => void) => void;
  export default test;
}
