declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(fn: () => Promise<unknown>, error?: new (...args: never[]) => Error | RegExp, message?: string): Promise<void>;
  }
  const assert: Assert;
  export = assert;
}

declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}
