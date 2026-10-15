declare module 'node:assert/strict' {
  interface Assert {
    throws(fn: () => unknown, error?: RegExp | ((error: unknown) => boolean) | (new (...args: never[]) => Error)): void;
    rejects(fn: () => Promise<unknown>, error?: new (...args: never[]) => Error | RegExp): Promise<void>;
    doesNotThrow(fn: () => unknown): void;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}

declare module 'node:fs/promises' {
  function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  function mkdtemp(prefix: string): Promise<string>;
  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module 'node:os' {
  function homedir(): string;
}

declare module 'node:path' {
  function join(...paths: string[]): string;
}

declare module 'node:process' {
  const process: { env: Record<string, string | undefined> };
  export default process;
}
declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}

declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): {
    update(value: string): { digest(encoding: 'hex'): string };
  };
}
