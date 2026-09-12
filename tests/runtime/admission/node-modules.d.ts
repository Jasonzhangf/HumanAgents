declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: new (...args: never[]) => Error | RegExp): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}

declare module 'node:test' {
  const test: (name: string, fn: () => void) => void;
  export default test;
}
