declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(actual: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    throws(fn: () => unknown, error?: RegExp | ((error: unknown) => boolean)): void;
    rejects(fn: () => Promise<unknown>, expected?: RegExp | ((error: unknown) => boolean)): Promise<void>;
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
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
  export function realpath(path: string): Promise<string>;
  export function symlink(existingPath: string, newPath: string): Promise<void>;
}
declare module 'node:os' {
  export function tmpdir(): string;
  export function homedir(): string;
}
declare module 'node:child_process' {
  export function execFileSync(file: string, args?: readonly string[], options?: { encoding?: string; stdio?: string; cwd?: string }): string;
}
declare const process: {
  readonly argv: readonly string[];
  readonly cwd: () => string;
  readonly execPath: string;
  readonly pid: number;
  readonly env: { [key: string]: string | undefined };
  exitCode?: number;
};
declare module 'node:path' {
  export function join(...paths: string[]): string;
}
