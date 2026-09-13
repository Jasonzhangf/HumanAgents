import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
}

export function digest(value) {
  return 'sha256:' + createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

export async function treeDigest(root) {
  const absoluteRoot = resolve(root);
  const entries = [];

  async function visit(directory) {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const path = resolve(directory, child.name);
      if (child.isDirectory()) {
        await visit(path);
      } else if (child.isFile()) {
        entries.push({ path: relative(absoluteRoot, path), digest: digest(await readFile(path)) });
      } else {
        throw new Error('unsupported artifact entry: ' + path);
      }
    }
  }

  const info = await stat(absoluteRoot);
  if (!info.isDirectory()) throw new Error('artifact root is not a directory: ' + absoluteRoot);
  await visit(absoluteRoot);
  return digest(entries);
}
