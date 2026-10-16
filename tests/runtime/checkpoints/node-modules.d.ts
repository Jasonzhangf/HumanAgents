declare module 'node:assert/strict' {
  interface Assert {
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, error?: (new (...args: never[]) => Error) | RegExp): void;
    doesNotThrow(fn: () => unknown): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, error?: (new (...args: never[]) => Error) | RegExp): Promise<void>;
  }
  const assert: Assert;
  export = assert;
}

declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: Uint8Array): Hash;
  }
}

declare module 'node:fs/promises' {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function stat(path: string): Promise<Stats>;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
}

declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly pid: number;
};
