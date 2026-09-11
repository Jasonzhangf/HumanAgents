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
}

declare module "node:fs/promises" {
  interface FileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    close(): Promise<void>;
  }

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
  function mkdtemp(prefix: string): Promise<string>;
  function open(path: string | URL, flags?: string): Promise<FileHandle>;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}
