declare module 'node:assert/strict' {
  interface Assert {
    equal<T>(actual: T, expected: T, message?: string): void;
    deepEqual<T>(actual: T, expected: T, message?: string): void;
    notEqual<T>(actual: T, expected: T, message?: string): void;
    throws(fn: () => unknown, error?: RegExp | ((err: unknown) => boolean) | object, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}

declare module 'node:test' {
  function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): {
    update(value: string): { digest(encoding: 'hex'): string };
  };
}
