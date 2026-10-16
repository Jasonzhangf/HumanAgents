declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    ok(actual: unknown, message?: string): void;
    throws(fn: () => unknown, error?: RegExp | ((error: unknown) => boolean)): void;
    rejects(
      promise: Promise<unknown> | (() => Promise<unknown>),
      expected?: RegExp | ((error: unknown) => boolean),
    ): Promise<void>;
  }
  const assert: Assert;
  export { Assert, assert };
  export = assert;
}
declare module 'node:crypto';
declare module 'node:test';
