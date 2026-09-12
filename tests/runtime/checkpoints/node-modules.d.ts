declare module 'node:assert/strict' {
  interface Assert {
    throws(fn: () => unknown, error?: new (...args: never[]) => Error | RegExp): void;
    doesNotThrow(fn: () => unknown): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, error?: new (...args: never[]) => Error | RegExp): Promise<void>;
  }
  const assert: Assert;
  export = assert;
}

declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}
