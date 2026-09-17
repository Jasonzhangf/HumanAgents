declare module 'node:fs/promises' {
  interface FileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  interface Stats {
    isSymbolicLink(): boolean;
  }
  function readFile(path: string | URL, encoding: 'utf8'): Promise<string>;
  function mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<string | undefined>;
  function open(path: string | URL, flags?: string): Promise<FileHandle>;
  function lstat(path: string | URL): Promise<Stats>;
  function link(oldPath: string | URL, newPath: string | URL): Promise<void>;
  function rename(oldPath: string | URL, newPath: string | URL): Promise<void>;
  function rm(path: string | URL, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

declare module 'node:path' {
  function dirname(path: string): string;
  function isAbsolute(path: string): boolean;
  function normalize(path: string): string;
}

declare module 'node:process' {
  export const pid: number;
  export function kill(processId: number, signal: 0): void;
}
