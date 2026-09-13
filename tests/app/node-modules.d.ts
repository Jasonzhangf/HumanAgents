declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    throws(fn: () => unknown, error?: (error: unknown) => boolean): void;
    rejects(fn: () => Promise<unknown>, expected?: RegExp): Promise<void>;
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
  export function appendFile(path: string, data: string, encoding?: string): Promise<void>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
}
declare module 'node:os' {
  export function tmpdir(): string;
  export function homedir(): string;
}
declare module 'node:child_process' {
  export function execFileSync(file: string, args?: readonly string[], options?: { encoding?: string; stdio?: string }): string;
}
declare const process: {
  readonly argv: readonly string[];
  readonly cwd: () => string;
  readonly execPath: string;
  readonly pid: number;
  exitCode?: number;
};
declare module 'node:path' {
  export function join(...paths: string[]): string;
}
