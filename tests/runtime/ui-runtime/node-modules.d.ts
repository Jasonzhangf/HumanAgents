declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    ok(actual: unknown, message?: string): void;
    throws(fn: () => unknown, error?: RegExp | ((error: unknown) => boolean), message?: string): void;
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
declare module 'node:fs' {
  export function appendFileSync(path: string, data: string, encoding: 'utf8'): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
  export function existsSync(path: string): boolean;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...paths: string[]): string;
}
declare module 'node:test';
