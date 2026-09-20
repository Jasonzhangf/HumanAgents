declare module 'node:assert/strict' {
  interface Assert {
    equal<T>(actual: T, expected: T, message?: string): void;
    deepEqual<T>(actual: T, expected: T, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(promise: Promise<unknown> | (() => Promise<unknown>), error?: RegExp | ((err: unknown) => boolean) | object, message?: string): Promise<void>;
    throws(fn: () => unknown, error?: RegExp | ((err: unknown) => boolean) | object, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}

declare module 'node:test' {
  function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}
