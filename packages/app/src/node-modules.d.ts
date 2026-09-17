declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array, encoding?: string): Hash;
    digest(encoding?: string): string | Uint8Array;
  }
  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}

declare module 'node:path' {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function normalize(path: string): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const sep: string;
}

declare module 'node:os' {
  export function homedir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:child_process' {
  import type { EventEmitter } from 'node:events';

  interface ReadableLike extends EventEmitter {
    setEncoding(encoding: string): void;
  }

  interface WritableLike {
    write(chunk: string): boolean;
    end(): void;
  }

  interface ChildProcessLike extends EventEmitter {
    readonly pid?: number;
    readonly exitCode: number | null;
    readonly signalCode: string | null;
    readonly stdin: WritableLike;
    readonly stdout: ReadableLike;
    readonly stderr: ReadableLike;
    kill(signal?: string): boolean;
  }

  interface SpawnOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly stdio?: readonly string[];
  }

  export function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcessLike;
  export function execFileSync(file: string, args?: readonly string[], options?: { encoding?: string; stdio?: string }): string;
}

declare module 'node:events' {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
  }
}

declare module 'node:fs/promises' {
  export interface FileHandle {
    writeFile(data: string | Uint8Array, encoding?: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function appendFile(path: string, data: string, encoding?: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function truncate(path: string, length: number): Promise<void>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
  export function realpath(path: string): Promise<string>;
}
declare module 'node:fs' {
  export function appendFileSync(path: string, data: string, encoding?: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function readFileSync(path: string): string;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function realpathSync(path: string): string;
}

declare module 'node:zlib' {
  export function zstdDecompressSync(input: Uint8Array): Uint8Array;
}

declare const process: {
  readonly argv: readonly string[];
  readonly cwd: () => string;
  readonly env: { [key: string]: string | undefined };
  readonly execPath: string;
  readonly pid: number;
  exitCode?: number;
};
