declare module 'node:assert/strict' {
  interface Assert {
    throws(fn: () => unknown, error?: new (...args: never[]) => Error | RegExp): void;
    doesNotThrow(fn: () => unknown): void;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}
declare module 'node:test' {
  const test: (name: string, fn: () => void) => void;
  export default test;
}
