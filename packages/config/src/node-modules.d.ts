declare module 'node:fs/promises' {
  export function access(path: string): Promise<void>;
  export interface FileHandle {
    writeFile(data: string, encoding?: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function realpath(path: string): Promise<string>;
  export function stat(path: string): Promise<{ isDirectory(): boolean }>;
}
declare module 'node:fs' {
  export function lstatSync(path: string): { isSymbolicLink(): boolean };
}
declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(value: string | Uint8Array, encoding?: 'utf8'): { digest(encoding: 'hex'): string };
  };
}
declare module 'node:os' {
  export function homedir(): string;
}
declare const process: {
  readonly env: { [key: string]: string | undefined };
};
declare module 'node:path' {
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function normalize(path: string): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}
