declare module 'node:http' {
  export interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
    readonly headers: { readonly [key: string]: string | string[] | undefined };
    [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array>;
    on(event: 'close', listener: () => void): void;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Readonly<Record<string, string | number>>): void;
    write(chunk: string): boolean;
    end(chunk?: string | Uint8Array): void;
  }
  export interface AddressInfo { readonly port: number; }
  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: (error?: Error) => void): void;
    address(): AddressInfo | string | null;
    once(event: 'error', listener: (error: Error) => void): void;
  }
  export function createServer(requestListener: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare const Buffer: {
  concat(chunks: readonly Uint8Array[]): { toString(encoding: string): string };
};
