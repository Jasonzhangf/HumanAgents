declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    rejects(
      fn: Promise<unknown> | (() => Promise<unknown>),
      error?: RegExp | ((error: unknown) => boolean) | (new (...args: never[]) => Error),
    ): Promise<void>;
  }
  const assert: Assert;
  export = assert;
}
declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}
