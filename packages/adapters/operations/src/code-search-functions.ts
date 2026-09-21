import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { CodeSearchHarnessError, type CodeSearchFileContent, type CodeSearchFileList, type CodeSearchFunctions } from '../../../runtime/src/hand/index.js';
import type { CodeSearchPathTreeNode, CodeSearchRequest } from '../../../contracts/src/index.js';

const DEFAULT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'DerivedData']);
const DEFAULT_IGNORED_SUFFIXES = ['.map'];
const PATH_TREE_MAX_DEPTH = 3;
const PATH_TREE_MAX_CHILDREN = 100;
export interface WorkspaceCodeSearchFunctionsOptions { readonly workspaceRef: string; readonly workspaceRoot: string; readonly ignoredDirectories?: ReadonlySet<string>; }

/** Filesystem function harness used internally by code.search. */
export class WorkspaceCodeSearchFunctions implements CodeSearchFunctions {
  private readonly ignoredDirectories: ReadonlySet<string>;
  constructor(private readonly options: WorkspaceCodeSearchFunctionsOptions) { this.ignoredDirectories = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES; }

  async findFiles(input: Pick<CodeSearchRequest, 'workspaceRef' | 'path'> & { readonly maxFiles: number }): Promise<CodeSearchFileList> {
    this.assertWorkspace(input.workspaceRef);
    const relativePath = this.safeRelativePath(input.path);
    const absolutePath = resolve(this.options.workspaceRoot, relativePath);
    let info;
    try { info = await lstat(absolutePath); }
    catch (error) { throw new CodeSearchHarnessError('path-not-found', error instanceof Error ? error.message : 'search path does not exist', relativePath); }
    if (info.isFile()) return { paths: [relativePath], complete: true, unresolvedPaths: [], pathTree: pathTree(relativePath, [relativePath]) };
    const paths: string[] = []; const unresolvedPaths: string[] = []; let complete = true; let discoveryTruncated = false;
    const visit = async (directory: string): Promise<void> => {
      if (discoveryTruncated) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { complete = false; unresolvedPaths.push(this.relativePath(directory)); return; }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const isSymbolicLink = typeof (entry as unknown as { readonly isSymbolicLink?: () => boolean }).isSymbolicLink === 'function'
          && (entry as unknown as { readonly isSymbolicLink: () => boolean }).isSymbolicLink();
        if (isSymbolicLink) continue;
        if (!entry.isFile() && this.ignoredDirectories.has(entry.name)) continue;
        const entryPath = join(directory, entry.name);
        if (entry.isFile() && !DEFAULT_IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
          paths.push(this.relativePath(entryPath));
          if (paths.length > input.maxFiles) { discoveryTruncated = true; return; }
        } else if (!entry.isFile()) await visit(entryPath);
        if (discoveryTruncated) return;
      }
    };
    await visit(absolutePath);
    const sortedPaths = paths.sort();
    return { paths: sortedPaths, complete: complete && !discoveryTruncated, unresolvedPaths: [...new Set(unresolvedPaths)].sort(), discoveryTruncated, pathTree: pathTree(relativePath, sortedPaths, discoveryTruncated) };
  }

  async readFile(input: { readonly workspaceRef: string; readonly path: string }): Promise<CodeSearchFileContent> {
    this.assertWorkspace(input.workspaceRef); const relativePath = this.safeRelativePath(input.path);
    try { return { path: relativePath, content: await readFile(resolve(this.options.workspaceRoot, relativePath), 'utf8') }; }
    catch (error) { throw new CodeSearchHarnessError('read-failed', error instanceof Error ? error.message : 'file could not be read', relativePath); }
  }

  private assertWorkspace(workspaceRef: string): void { if (workspaceRef !== this.options.workspaceRef) throw new CodeSearchHarnessError('path-not-found', `workspace binding '${workspaceRef}' is unavailable`); }
  private safeRelativePath(value: string): string {
    const normalized = value.replaceAll('\\', '/'); const absolute = resolve(this.options.workspaceRoot, normalized); const root = resolve(this.options.workspaceRoot);
    if (normalized.startsWith('/') || (absolute !== root && !absolute.startsWith(`${root}${sep}`))) throw new CodeSearchHarnessError('path-escape', 'search path escapes the bound workspace', value);
    return normalized === '.' ? '.' : relative(root, absolute).split(sep).join('/');
  }
  private relativePath(absolutePath: string): string { return relative(resolve(this.options.workspaceRoot), absolutePath).split(sep).join('/'); }
}

interface MutablePathTreeNode {
  path: string;
  kind: 'directory' | 'file';
  fileCount: number;
  children: MutablePathTreeNode[];
  childrenByPath: Map<string, MutablePathTreeNode>;
  truncated: boolean;
}

function pathTree(rootPath: string, paths: readonly string[], truncated = false): CodeSearchPathTreeNode {
  if (paths.length === 1 && paths[0] === rootPath) return { path: rootPath, kind: 'file', fileCount: 1, children: [], truncated: false };
  const root: MutablePathTreeNode = { path: rootPath, kind: 'directory', fileCount: paths.length, children: [], childrenByPath: new Map(), truncated };
  for (const path of paths) {
    const parts = path.split('/');
    let current = root;
    for (let depth = 0; depth < Math.min(parts.length, PATH_TREE_MAX_DEPTH); depth += 1) {
      const childPath = parts.slice(0, depth + 1).join('/');
      let child = current.childrenByPath.get(childPath);
      if (!child) {
        if (current.children.length >= PATH_TREE_MAX_CHILDREN) { current.truncated = true; break; }
        child = { path: childPath, kind: depth === parts.length - 1 ? 'file' : 'directory', fileCount: 0, children: [], childrenByPath: new Map(), truncated: false };
        current.children.push(child);
        current.childrenByPath.set(childPath, child);
      }
      child.fileCount += 1;
      current = child;
    }
    if (parts.length > PATH_TREE_MAX_DEPTH) current.truncated = true;
  }
  return freezePathTree(root);
}

function freezePathTree(node: MutablePathTreeNode): CodeSearchPathTreeNode {
  return { path: node.path, kind: node.kind, fileCount: node.fileCount, truncated: node.truncated,
    children: node.children.sort((left, right) => left.path.localeCompare(right.path)).map(freezePathTree) };
}
