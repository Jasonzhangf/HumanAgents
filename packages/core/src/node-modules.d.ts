declare module 'node:crypto' {
  interface Hash {
    update(data: string): Hash;
    update(data: string, encoding: 'utf8'): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}
