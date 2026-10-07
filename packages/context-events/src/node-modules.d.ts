/**
 * Context Events —— Node 内建模块的本地环境声明。
 *
 * 与 `packages/core` / `packages/runtime` / `packages/app` / `packages/config` /
 * `packages/agent-templates` 同构：本仓库根 `devDependencies` 不含 `@types/node`，
 * 需要 `node:*` 内建的包各自声明最小接口（既有约定，不新增依赖）。
 *
 * 本包只用到 `node:crypto` 的同步 sha256（§9.5 `dataDigest`）。
 * 注意：本文件不改变「本包不得 import `packages/runtime`」这条硬约束。
 */

declare module 'node:crypto' {
  interface Hash {
    update(data: string): Hash;
    update(data: string, encoding: 'utf8'): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}
