import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { CodeSearchHarnessError, type CodeSearchFileContent, type CodeSearchFileList, type CodeSearchFunctions } from '../../../runtime/src/hand/index.js';
import type { CodeSearchRequest } from '../../../contracts/src/index.js';

const DEFAULT_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);
export interface WorkspaceCodeSearchFunctionsOptions { readonly workspaceRef: string; readonly workspaceRoot: string; readonly ignoredDirectories?: ReadonlySet<string>; }

/** Filesystem function harness used internally by code.search. */
export class WorkspaceCodeSearchFunctions implements CodeSearchFunctions {
  private readonly ignoredDirectories: ReadonlySet<string>;
  constructor(private readonly options: WorkspaceCodeSearchFunctionsOptions) { this.ignoredDirectories = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES; }

  async findFiles(input: Pick<CodeSearchRequest, 'workspaceRef' | 'path'>): Promise<CodeSearchFileList> {
    this.assertWorkspace(input.workspaceRef);
    const relativePath = this.safeRelativePath(input.path);
    const absolutePath = resolve(this.options.workspaceRoot, relativePath);
    let info;
    try { info = await lstat(absolutePath); }
    catch (error) { throw new CodeSearchHarnessError('path-not-found', error instanceof Error ? error.message : 'search path does not exist', relativePath); }
    if (info.isFile()) return { paths: [relativePath], complete: true, unresolvedPaths: [] };
    const paths: string[] = []; const unresolvedPaths: string[] = []; let complete = true;
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { complete = false; unresolvedPaths.push(this.relativePath(directory)); return; }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() && this.ignoredDirectories.has(entry.name)) continue;
        const entryPath = join(directory, entry.name);
        if (entry.isFile()) paths.push(this.relativePath(entryPath)); else await visit(entryPath);
      }
    };
    await visit(absolutePath);
    return { paths: paths.sort(), complete, unresolvedPaths: [...new Set(unresolvedPaths)].sort() };
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
