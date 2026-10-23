declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): {
    update(value: string): { digest(encoding: 'hex'): string };
  };
  export function randomUUID(): string;
}

declare module 'node:path' {
  export function isAbsolute(path: string): boolean;
}
