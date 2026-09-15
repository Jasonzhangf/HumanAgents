declare module 'node:fs/promises' {
  export interface Dirent { isFile(): boolean; name: string; }
  export interface FileHandle {
    writeFile(data: string | Uint8Array, encoding?: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function appendFile(path: string, data: string, encoding?: string): Promise<void>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function truncate(path: string, length: number): Promise<void>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
  export function realpath(path: string): Promise<string>;
}
declare module 'node:fs' {
  export function appendFileSync(path: string, data: string, encoding?: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:crypto' {
  export function randomUUID(): string;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function join(...paths: string[]): string;
  export function normalize(path: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
}
declare const process: {
  readonly argv: readonly string[];
  readonly cwd: () => string;
  readonly execPath: string;
  readonly pid: number;
  readonly env: { [key: string]: string | undefined };
  exitCode?: number;
};
