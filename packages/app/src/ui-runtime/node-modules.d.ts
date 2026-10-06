declare module 'node:http' {
  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly headers: { readonly [key: string]: string | string[] | undefined };
    readonly socket: { readonly remoteAddress?: string };
    [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array>;
    on(event: 'close', listener: () => void): void;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Readonly<Record<string, string | number>>): void;
    write(chunk: string): boolean;
    end(chunk?: string | Uint8Array, callback?: () => void): void;
    end(callback: () => void): void;
    readonly writableEnded: boolean;
    once(event: 'close', listener: () => void): void;
  }
  export interface AddressInfo { readonly address: string; readonly family: string; readonly port: number; }
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: (error?: Error) => void): void;
    closeIdleConnections?(): void;
    address(): AddressInfo | string | null;
    once(event: 'error', listener: (error: Error) => void): void;
  }
  export function createServer(requestListener: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare interface Buffer extends Uint8Array {
  toString(encoding?: string): string;
}

declare const Buffer: {
  concat(chunks: readonly Uint8Array[]): Buffer;
  from(value: string | Uint8Array, encoding?: string): Buffer;
};

declare function setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setInterval> & { unref?(): void };

declare module 'node:fs/promises' {
  export interface FileHandle {
    stat(): Promise<Stats>;
    writeFile(data: string | Uint8Array, encoding?: string): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export function lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; mode: number }>;
  export function mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  export function open(path: string | URL, flags: string | number, mode?: number): Promise<FileHandle>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
}
