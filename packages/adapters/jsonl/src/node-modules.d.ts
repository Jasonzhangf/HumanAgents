declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(value: string | Uint8Array): { digest(encoding: 'hex'): string };
  };
}

declare module 'node:path' {
  export function dirname(path: string): string;
}

declare module 'node:fs' {
  export function closeSync(fd: number): void;
  export function existsSync(path: string): boolean;
  export function openSync(path: string, flags: string): number;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position?: number): number;
  export function statSync(path: string): { readonly size: number };
}

declare module 'node:process' {
  export const pid: number;
  export function kill(processId: number, signal: 0): void;
}

declare module 'node:fs/promises' {
  interface FileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  function link(oldPath: string, newPath: string): Promise<void>;
  function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  function open(path: string, flags: string): Promise<FileHandle>;
  function readFile(path: string): Promise<Uint8Array>;
  function readFile(path: string, encoding: 'utf8'): Promise<string>;
  function rename(oldPath: string, newPath: string): Promise<void>;
  function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
}
