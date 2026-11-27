import { constants } from 'node:fs';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Keep the small Node declarations local: this package uses repository-owned
// Node shims, and this primitive must not change shared dependencies or shims.
declare module 'node:child_process' {
  function execFile(file: string, args: readonly string[], options: {
    cwd: string; env: Record<string, string>; encoding: 'utf8';
    signal?: AbortSignal; timeout: number; maxBuffer: number;
  }, callback: (error: Error | null, stdout: string, stderr: string) => void): unknown;
}

export interface GitInventoryGap {
  readonly path: string;
  readonly reason: 'symlink' | 'cross-device' | 'unreadable' | 'external-git-pointer'
    | 'git-config-not-read' | 'command-failed' | 'unsupported-entry';
}

export interface GitInventorySize {
  readonly path: string;
  readonly allocatedKiB: number | null;
}

export interface GitInventoryFacts {
  /** Resolved HEAD; the worktree's head retains the control-file representation. */
  readonly headCommit: string | null;
  readonly latestCommitDate: string | null;
  /** Tracked changes and untracked files are reported separately. */
  readonly dirty: boolean | null;
  readonly untracked: boolean | null;
  /** null means the reference or HEAD is absent, external, or not safely readable. */
  readonly includedInLocalMain: boolean | null;
  readonly includedInTrackingMain: boolean | null;
}

export interface GitInventoryWorktree extends GitInventoryFacts {
  /** Reference from Git metadata. External references are never visited. */
  readonly path: string;
  readonly gitDir: string;
  readonly scope: 'in-root' | 'external-reference-only';
  readonly head: string | null;
  readonly branch: string | null;
  readonly allocatedKiB: number | null;
}

export interface GitInventoryRepository {
  readonly path: string;
  readonly gitDir: string | null;
  readonly commonDir: string | null;
  readonly branch: string | null;
  readonly worktrees: readonly GitInventoryWorktree[];
}

export interface GitReadonlyInventory {
  readonly workspaceRoot: string;
  readonly observedAt: string;
  /** Top-level directories; sizes overlap with nested repositories/worktrees. */
  readonly projects: readonly GitInventorySize[];
  readonly repositories: readonly GitInventoryRepository[];
  readonly gaps: readonly GitInventoryGap[];
}

interface EntryInfo {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * HOST OPERATOR ONLY. workspaceRoot is the already-authorized canonical root,
 * never model/tool input. No arbitrary command, subpath or environment input.
 * The operator must keep directory/mount topology stable during this scan.
 * Node pathname APIs and du cannot confine hostile concurrent renames/mounts.
 */
export async function inventoryGitWorkspaceReadonly(
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<GitReadonlyInventory> {
  if (!isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot || workspaceRoot === sep) {
    throw new Error('inventory requires an explicit canonical workspaceRoot below filesystem root');
  }
  const gaps: GitInventoryGap[] = [];
  const gap = (path: string, reason: GitInventoryGap['reason']): void => { gaps.push({ path, reason }); };
  const checkAbort = (): void => { signal?.throwIfAborted(); };
  const info = async (path: string): Promise<EntryInfo> => await lstat(path) as unknown as EntryInfo;
  const within = (path: string): boolean => path === workspaceRoot || path.startsWith(`${workspaceRoot}${sep}`);
  // Check every ancestor. A canonical root must not contain directory aliases.
  let ancestor = sep;
  for (const part of workspaceRoot.split(sep).filter(Boolean)) {
    checkAbort();
    ancestor = join(ancestor, part);
    const entry = await info(ancestor);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('inventory root has a symlink or non-directory ancestor');
  }
  const rootInfo = await info(workspaceRoot);
  const safe = async (path: string): Promise<EntryInfo> => {
    checkAbort();
    if (!within(path)) throw new Error('external-git-pointer');
    let current = workspaceRoot;
    let entry = await info(current);
    if (entry.dev !== rootInfo.dev || entry.ino !== rootInfo.ino || entry.isSymbolicLink()) throw new Error('unreadable');
    for (const part of relative(workspaceRoot, path).split(sep).filter(Boolean)) {
      if (!entry.isDirectory()) throw new Error('unsupported-entry');
      current = join(current, part);
      entry = await info(current);
      if (entry.isSymbolicLink()) throw new Error('symlink');
      if (entry.dev !== rootInfo.dev) throw new Error('cross-device');
    }
    return entry;
  };
  const reason = (error: unknown): GitInventoryGap['reason'] => {
    checkAbort();
    const message = error instanceof Error ? error.message : '';
    return ['symlink', 'cross-device', 'external-git-pointer', 'unsupported-entry'].includes(message)
      ? message as GitInventoryGap['reason'] : 'unreadable';
  };
  const exists = async (path: string): Promise<boolean> => {
    try { await safe(path); return true; }
    catch (error) {
      checkAbort();
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  };
  const entries = async (path: string): Promise<string[]> => {
    const before = await safe(path);
    if (!before.isDirectory()) throw new Error('unsupported-entry');
    const names = (await readdir(path, { withFileTypes: true })).map((entry) => entry.name).sort();
    const after = await safe(path);
    if (before.ino !== after.ino) throw new Error('unreadable');
    return names;
  };
  // Tree traversal has already checked the parent. Under the stable-topology
  // contract, verify this directory locally instead of walking its ancestors
  // again for every regular file returned by readdir.
  const localEntries = async (path: string) => {
    checkAbort();
    if (!within(path)) throw new Error('external-git-pointer');
    const before = await info(path);
    if (before.isSymbolicLink()) throw new Error('symlink');
    if (before.dev !== rootInfo.dev) throw new Error('cross-device');
    if (!before.isDirectory()) throw new Error('unsupported-entry');
    const children = await readdir(path, { withFileTypes: true });
    const after = await info(path);
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory()) throw new Error('unreadable');
    checkAbort();
    return children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) as Array<{
      name: string; isDirectory(): boolean; isFile(): boolean;
    }>;
  };
  // Only Git control pointer files, never config values or workspace content.
  const pointer = async (path: string): Promise<string> => {
    const before = await safe(path);
    if (!before.isFile() || before.size > 16384) throw new Error('unsupported-entry');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('unreadable');
      const value = await readFile(handle, 'utf8');
      await safe(path);
      checkAbort();
      return value.trim();
    } finally { await handle.close(); }
  };
  // Sanitized environment: no inherited GIT_*, global/system config, pager,
  // credential helpers, shell or environment-based executable lookup.
  const env = {
    PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat',
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
  };
  const gitArgs = (gitDir: string, worktree: string): string[] => [
    '--no-pager', '--no-optional-locks', `--git-dir=${gitDir}`, `--work-tree=${worktree}`,
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.excludesFile=/dev/null', '-c', 'core.ignoreStat=false',
    '-c', 'diff.ignoreSubmodules=all', '-c', 'protocol.allow=never',
  ];
  const validateStorage = async (dir: string): Promise<void> => {
    for (const entry of await localEntries(dir)) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        const local = await info(child);
        if (local.isSymbolicLink()) throw new Error('symlink');
        if (local.dev !== rootInfo.dev) throw new Error('cross-device');
        await validateStorage(child);
      } else if (!entry.isFile()) {
        const local = await info(child);
        if (local.isSymbolicLink()) throw new Error('symlink');
        throw new Error('unsupported-entry');
      }
    }
  };
  const validateGit = async (gitDir: string, commonDir: string, worktree: string): Promise<boolean> => {
    // Git follows storage links independently of Node. Validate before spawning it.
    await validateStorage(commonDir);
    if (gitDir !== commonDir) await validateStorage(gitDir);
    for (const name of ['alternates', 'http-alternates']) {
      if (await exists(join(commonDir, 'objects', 'info', name))) throw new Error('unsupported-entry');
    }
    const hooks = join(commonDir, 'hooks');
    if (await exists(hooks) && (await entries(hooks)).some((name) => !name.endsWith('.sample'))) {
      throw new Error('unsupported-entry');
    }
    for (const config of new Set([join(commonDir, 'config'), join(gitDir, 'config'), join(gitDir, 'config.worktree')])) {
      if (!await exists(config)) continue;
      if (!(await safe(config)).isFile()) throw new Error('unsupported-entry');
      // Explicit file mode does not load repository config or follow includes.
      const keys = await run('/usr/bin/git', ['--no-pager', 'config', '--file', config,
        '--no-includes', '--name-only', '--list'], workspaceRoot);
      const ordinaryKey = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|user\.(?:name|email)|remote\.[^.]+\.(?:url|fetch|pushurl)|branch\..+\.(?:remote|merge|description)|extensions\.objectformat)$/i;
      if (keys.trim().split('\n').some((key) => key && !ordinaryKey.test(key))) {
        gap(worktree, 'git-config-not-read');
        return false;
      }
    }
    return true;
  };
  const run = async (file: '/usr/bin/du' | '/usr/bin/git', args: readonly string[], cwd: string): Promise<string> => {
    checkAbort();
    await safe(cwd);
    return await new Promise<string>((accept, reject) => {
      execFile(file, args, { cwd, env, encoding: 'utf8', signal, timeout: 160000, maxBuffer: 1048576 },
        (error, stdout) => error ? reject(error) : accept(stdout));
    });
  };
  const repositories: GitInventoryRepository[] = [];
  const projects: GitInventorySize[] = [];
  const found = new Map<string, boolean>();
  const sizes = new Map<string, Promise<number>>();
  const measure = (path: string): Promise<number> => {
    let pending = sizes.get(path);
    if (!pending) {
      pending = (async () => {
        const output = await run('/usr/bin/du', ['-P', '-x', '-s', '-k', path], workspaceRoot);
        const value = /^([0-9]+)\s/.exec(output)?.[1];
        if (!value || !Number.isSafeInteger(Number(value))) throw new Error('invalid du result');
        return Number(value);
      })();
      sizes.set(path, pending);
    }
    return pending;
  };
  const walk = async (path: string, discover: boolean): Promise<void> => {
    const children = await localEntries(path);
    const names = children.map((entry) => entry.name);
    if (discover && names.includes('HEAD') && names.includes('objects') && names.includes('refs')) {
      found.set(path, true);
    }
    for (const entry of children) {
      const name = entry.name;
      const child = join(path, name);
      try {
        if (discover && name === '.git') {
          await safe(child);
          found.set(path, false);
          continue;
        }
        if (entry.isDirectory()) await walk(child, discover);
        else if (entry.isFile()) continue;
        else {
          const local = await info(child);
          if (local.isSymbolicLink()) throw new Error('symlink');
          throw new Error('unsupported-entry');
        }
      } catch (error) { gap(child, reason(error)); }
    }
  };
  await walk(workspaceRoot, true);
  for (const name of await entries(workspaceRoot)) {
    const path = join(workspaceRoot, name);
    let directory = false;
    try {
      if (!(await safe(path)).isDirectory()) continue;
      directory = true;
      projects.push({ path, allocatedKiB: await measure(path) });
    } catch (error) {
      checkAbort();
      gap(path, reason(error) === 'unreadable' ? 'command-failed' : reason(error));
      if (directory) projects.push({ path, allocatedKiB: null });
    }
  }
  for (const [path, bare] of found) {
    let gitDir: string | null = null;
    let commonDir: string | null = null;
    let branch: string | null = null;
    const worktrees: GitInventoryWorktree[] = [];
    try {
      const marker = join(path, '.git');
      if (bare) gitDir = path;
      else if ((await safe(marker)).isDirectory()) gitDir = marker;
      else {
        const value = await pointer(marker);
        if (!value.startsWith('gitdir: ')) throw new Error('unsupported-entry');
        gitDir = resolve(path, value.slice(8));
      }
      if (!within(gitDir)) gap(gitDir, 'external-git-pointer');
      await safe(gitDir);
      commonDir = await exists(join(gitDir, 'commondir'))
        ? resolve(gitDir, await pointer(join(gitDir, 'commondir'))) : gitDir;
      if (!within(commonDir)) gap(commonDir, 'external-git-pointer');
      await safe(commonDir);
      const head = await pointer(join(gitDir, 'HEAD'));
      const readable = await validateGit(gitDir, commonDir, path);
      if (readable) branch = head.startsWith('ref: ') ? head.slice(5) : null;
      const addWorktree = async (
        worktreePath: string, adminDir: string, scope: GitInventoryWorktree['scope'],
        worktreeHead: string,
      ): Promise<void> => {
        let allocatedKiB: number | null = null;
        const facts: { -readonly [K in keyof GitInventoryFacts]: GitInventoryFacts[K] } = {
          headCommit: null, latestCommitDate: null, dirty: null, untracked: null,
          includedInLocalMain: null, includedInTrackingMain: null,
        };
        if (scope === 'in-root') {
          try { allocatedKiB = await measure(worktreePath); }
          catch (error) { checkAbort(); gap(worktreePath, 'command-failed'); }
          if (readable && (adminDir === gitDir || await validateGit(adminDir, commonDir!, worktreePath))) {
            const query = async (args: readonly string[]): Promise<string> =>
              await run('/usr/bin/git', [...gitArgs(adminDir, worktreePath), ...args], worktreePath);
            try {
              const resolved = (await query(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
              facts.headCommit = resolved;
              facts.latestCommitDate = (await query(['log', '-1', '--format=%cI', resolved, '--'])).trim();
              for (const [field, ref] of [
                ['includedInLocalMain', 'refs/heads/main'],
                ['includedInTrackingMain', 'refs/remotes/origin/main'],
              ] as const) {
                const refs = await query(['for-each-ref', '--format=%(refname)', ref]);
                if (!refs.split('\n').includes(ref)) continue;
                try {
                  await query(['merge-base', '--is-ancestor', resolved, ref]);
                  facts[field] = true;
                } catch (error) {
                  checkAbort();
                  if ((error as { code?: number }).code !== 1) throw error;
                  facts[field] = false;
                }
              }
            } catch (error) { checkAbort(); gap(worktreePath, 'command-failed'); }
            try {
              const status = await query(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all']);
              const records = status.split('\0');
              facts.dirty = false;
              facts.untracked = false;
              for (let i = 0; i < records.length; i++) {
                const code = records[i]!.slice(0, 2);
                if (!code) continue;
                if (code === '??') facts.untracked = true;
                else facts.dirty = true;
                if (code.includes('R') || code.includes('C')) i++;
              }
            } catch (error) { checkAbort(); gap(worktreePath, 'command-failed'); }
          }
        }
        worktrees.push({ path: worktreePath, gitDir: adminDir, scope, head: worktreeHead,
          branch: worktreeHead.startsWith('ref: ') ? worktreeHead.slice(5) : null,
          allocatedKiB, ...facts });
      };
      if (!bare) await addWorktree(path, gitDir, 'in-root', head);
      const registry = join(commonDir, 'worktrees');
      if (await exists(registry)) {
        for (const name of await entries(registry)) {
          const admin = join(registry, name);
          try {
            const target = dirname(resolve(admin, await pointer(join(admin, 'gitdir'))));
            // Do not inspect an external worktree, even to check existence.
            const scope = within(target) ? 'in-root' as const : 'external-reference-only' as const;
            if (scope === 'external-reference-only') gap(target, 'external-git-pointer');
            else await safe(target);
            await addWorktree(target, admin, scope, await pointer(join(admin, 'HEAD')));
          } catch (error) { gap(admin, reason(error)); }
        }
      }
    } catch (error) { gap(path, reason(error)); }
    repositories.push({ path, gitDir, commonDir, branch, worktrees });
  }
  checkAbort();
  await safe(workspaceRoot);
  return { workspaceRoot, observedAt: new Date().toISOString(), projects, repositories,
    gaps: gaps.filter((item, i) => gaps.findIndex((other) => other.path === item.path && other.reason === item.reason) === i) };
}
