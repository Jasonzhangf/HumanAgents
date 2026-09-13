declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    throws(fn: () => unknown, error?: RegExp): void;
    rejects(fn: () => Promise<unknown>, error?: RegExp): Promise<void>;
  }
  const assert: Assert;
  export = assert;
}
declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}
declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function realpath(path: string): Promise<string>;
  export function stat(path: string): Promise<{ isDirectory(): boolean }>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
}
declare module 'node:fs' {
  export function symlinkSync(target: string, path: string): void;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...paths: string[]): string;
}
