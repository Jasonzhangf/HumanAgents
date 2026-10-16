declare module 'node:assert/strict' {
  const assert: {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(value: string, pattern: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
  };
  export default assert;
}

declare module 'node:test' {
  const test: (name: string, fn: () => void | Promise<void>) => void;
  export default test;
}

declare module 'node:process' {
  const process: { env: Record<string, string | undefined> };
  export default process;
  export function cwd(): string;
}

declare module 'node:os' {
  function homedir(): string;
  function tmpdir(): string;
}

declare module 'node:fs/promises' {
  function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  function mkdtemp(prefix: string): Promise<string>;
  function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
