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
  export function readdir(path: string): Promise<string[]>;
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
  import type { EventEmitter } from 'node:events';
  interface ReadableLike extends EventEmitter {
    setEncoding(encoding: string): void;
  }
  interface ChildProcessLike extends EventEmitter {
    readonly pid?: number;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly stdout: ReadableLike;
    readonly stderr: ReadableLike;
    readonly stdin: { write(chunk: string): boolean; end(): void };
    kill(signal?: string): boolean;
  }
  export function spawn(command: string, args?: readonly string[], options?: { readonly cwd?: string; readonly env?: Record<string, string | undefined>; readonly stdio?: readonly string[] }): ChildProcessLike;
  export function execFileSync(file: string, args?: readonly string[], options?: { encoding?: string; stdio?: string; cwd?: string }): string;
}
declare module 'node:events' {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
  }
}
declare const process: {
  readonly argv: readonly string[];
  readonly cwd: () => string;
  readonly execPath: string;
  readonly pid: number;
  readonly platform: string;
  readonly env: { [key: string]: string | undefined };
  kill(pid: number, signal: 0): boolean;
  kill(pid: number, signal?: string): boolean;
  exitCode?: number;
};
declare module 'node:path' {
  export function join(...paths: string[]): string;
}
