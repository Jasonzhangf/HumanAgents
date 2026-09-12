declare module 'node:assert/strict' {
  interface Assert {
    throws(fn: () => unknown, error?: new (...args: never[]) => Error | RegExp): void;
    rejects(fn: Promise<unknown> | (() => Promise<unknown>), error?: new (...args: never[]) => Error | RegExp): Promise<void>;
    doesNotThrow(fn: () => unknown): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
  }
  const assert: Assert;
  export = assert;
}
declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}
