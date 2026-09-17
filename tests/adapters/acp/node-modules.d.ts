declare module "node:assert/strict" {
  interface Assert {
    deepEqual<T>(actual: T, expected: T, message?: string): void;
    doesNotThrow(
      fn: () => unknown,
      error?: RegExp | ((err: unknown) => boolean) | object,
      message?: string
    ): void;
    equal<T>(actual: T, expected: T, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(
      promise: Promise<unknown> | (() => Promise<unknown>),
      error?: RegExp | ((err: unknown) => boolean) | object,
      message?: string
    ): Promise<void>;
    throws(
      fn: () => unknown,
      error?: RegExp | ((err: unknown) => boolean) | object,
      message?: string
    ): void;
  }

  const strict: Assert;

  export {
    Assert,
    strict,
    deepEqual,
    doesNotThrow,
    equal,
    notEqual,
    ok,
    rejects,
    throws
  };
  export = strict;
}

declare module "node:test" {
  function test(name: string, fn: () => void | Promise<void>): void;
  function test(fn: () => void | Promise<void>): void;

  export { test };
  export default test;
}
