declare module 'node:crypto' {
  interface Hash {
    update(data: string, encoding: 'utf8'): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function realpath(path: string): Promise<string>;
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:process' {
  export function cwd(): string;
}

declare module 'node:path' {
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}
