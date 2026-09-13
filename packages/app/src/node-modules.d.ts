declare module 'node:fs/promises' {
  export interface Dirent { isFile(): boolean; name: string; }
  export interface FileHandle {
    writeFile(data: string, encoding?: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function truncate(path: string, length: number): Promise<void>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
}
declare module 'node:crypto' {
  export function randomUUID(): string;
}
declare const process: {
  readonly argv: readonly string[];
  readonly cwd: () => string;
  readonly execPath: string;
  readonly pid: number;
  readonly env: { [key: string]: string | undefined };
  exitCode?: number;
};
