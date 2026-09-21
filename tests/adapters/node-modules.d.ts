declare module "node:assert/strict" {
  interface Assert {
    throws(
      fn: () => unknown,
      error?: RegExp | ((err: unknown) => boolean) | object,
      message?: string
    ): void;
    doesNotThrow(
      fn: () => unknown,
      error?: RegExp | ((err: unknown) => boolean) | object,
      message?: string
    ): void;
    deepEqual<T>(actual: T, expected: T, message?: string): void;
    equal<T>(actual: T, expected: T, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(
      promise: Promise<unknown> | (() => Promise<unknown>),
      error?: RegExp | ((err: unknown) => boolean) | object,
      message?: string
    ): Promise<void>;
    match(value: string, regexp: RegExp, message?: string): void;
  }

  function throws(
    fn: () => unknown,
    error?: RegExp | ((err: unknown) => boolean) | object,
    message?: string
  ): void;
  function doesNotThrow(
    fn: () => unknown,
    error?: RegExp | ((err: unknown) => boolean) | object,
    message?: string
  ): void;
  function deepEqual<T>(actual: T, expected: T, message?: string): void;
  function equal<T>(actual: T, expected: T, message?: string): void;
  function ok(value: unknown, message?: string): asserts value;
  function rejects(
    promise: Promise<unknown> | (() => Promise<unknown>),
    error?: RegExp | ((err: unknown) => boolean) | object,
    message?: string
  ): Promise<void>;
  function match(value: string, regexp: RegExp, message?: string): void;

  const strict: Assert;

  export {
    Assert,
    strict,
    throws,
    doesNotThrow,
    deepEqual,
    equal,
    ok,
    rejects,
    match
  };
  export = strict;
}

declare module "node:test" {
  function test(name: string, fn: () => void | Promise<void>): void;
  function test(fn: () => void | Promise<void>): void;

  export { test };
  export default test;
}

declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array, encoding?: string): Hash;
    digest(encoding?: string): string | Uint8Array;
  }

  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}

declare module "node:fs/promises" {
  interface FileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    close(): Promise<void>;
  }
  interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  interface Stats {
    isFile(): boolean;
  }

  function lstat(path: string | URL): Promise<Stats>;

  function readFile(
    path: string | URL | FileHandle,
    encoding: "utf8"
  ): Promise<string>;
  function readFile(path: string | URL | FileHandle): Promise<Uint8Array>;
  function writeFile(
    path: string | URL | FileHandle,
    data: string | Uint8Array,
    encoding?: string
  ): Promise<void>;
  function appendFile(
    path: string | URL | FileHandle,
    data: string | Uint8Array,
    encoding?: string
  ): Promise<void>;
  function mkdir(
    path: string | URL,
    options?: { recursive?: boolean }
  ): Promise<string | undefined>;
  function symlink(target: string | URL, path: string | URL, type?: string): Promise<void>;
  function mkdtemp(prefix: string): Promise<string>;
  function open(path: string | URL, flags?: string): Promise<FileHandle>;
  function readdir(path: string | URL, options: { withFileTypes: true }): Promise<Dirent[]>;
  function rm(path: string | URL, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module "node:zlib" {
  function zstdCompressSync(input: string | Uint8Array): Uint8Array;
  function zstdDecompressSync(input: Uint8Array): Uint8Array;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}

declare module "node:events" {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }
}

declare module "node:child_process" {
  import type { EventEmitter } from "node:events";

  interface ReadableLike extends EventEmitter {
    setEncoding(encoding: string): void;
  }

  interface WritableLike {
    write(chunk: string): boolean;
    end(): void;
  }

  interface ChildProcessLike extends EventEmitter {
    readonly pid?: number;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly stdin: WritableLike;
    readonly stdout: ReadableLike;
    readonly stderr: ReadableLike;
    kill(signal?: string): boolean;
  }

  interface SpawnOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly stdio?: readonly string[];
  }

  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcessLike;
}

declare const process: {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly execPath: string;
  readonly pid: number;
  exitCode?: number;
};
