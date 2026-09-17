declare module 'node:assert/strict' {
  interface Assert {
    throws(fn: () => unknown, error?: RegExp | ((error: unknown) => boolean) | (new (...args: never[]) => Error)): void;
    rejects(fn: () => Promise<unknown>, error?: new (...args: never[]) => Error | RegExp): Promise<void>;
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
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}
