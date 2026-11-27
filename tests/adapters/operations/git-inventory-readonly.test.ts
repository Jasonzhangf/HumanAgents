import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inventoryGitWorkspaceReadonly } from '../../../packages/adapters/operations/src/git-inventory-readonly.js';

declare module 'node:child_process' {
  function execFileSync(file: string, args: readonly string[], options: {
    cwd: string; encoding: 'utf8';
  }): string;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
}

test('readonly inventory reports bounded du and Git metadata without traversing external pointers', async () => {
  const fixture = await mkdtemp(join(tmpdir().replace(/^\/var(?=\/|$)/, '/private/var'), 'humanagent-git-inventory-'));
  const root = join(fixture, 'root');
  const outside = join(fixture, 'outside');
  const repo = join(root, 'alpha');
  const bare = join(root, 'bare');
  const configured = join(root, 'configured');
  const linked = join(root, 'linked');
  const escaped = join(root, 'escaped');
  const externalWorktree = join(outside, 'worktree');
  const externalGitDir = join(outside, 'DO-NOT-READ');
  const nestedLink = join(repo, 'nested', 'outside');
  try {
    await Promise.all([
      mkdir(repo, { recursive: true }),
      mkdir(configured, { recursive: true }),
      mkdir(escaped, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    git(repo, ['init', '-q', '-b', 'main']);
    await writeFile(join(repo, 'tracked.txt'), 'not inventory output\n', 'utf8');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
    git(repo, ['worktree', 'add', '-q', '-b', 'external', externalWorktree]);
    git(root, ['init', '-q', '-b', 'main', '--bare', bare]);
    await rm(join(bare, 'config'));
    // Includes must be refused without reading their target or values.
    git(configured, ['init', '-q']);
    await writeFile(join(configured, '.git', 'config'), '[include]\n path = /DO-NOT-READ/config\n', 'utf8');
    const config = await readFile(join(configured, '.git', 'config'), 'utf8');
    await writeFile(join(escaped, '.git'), `gitdir: ${externalGitDir}\n`, 'utf8');
    await symlink(outside, linked);
    await mkdir(join(repo, 'nested'));
    await symlink(outside, nestedLink);

    const inventory = await inventoryGitWorkspaceReadonly(root);
    const alpha = inventory.repositories.find((item) => item.path === repo);
    assert.ok(alpha);
    assert.equal(alpha.branch, 'refs/heads/main');
    assert.equal(inventory.gaps.some((item) => item.path === repo && item.reason === 'command-failed'), false);
    assert.equal(alpha.worktrees[0]?.scope, 'in-root');
    assert.equal(alpha.worktrees[0]?.head, 'ref: refs/heads/main');
    assert.equal(alpha.worktrees[0]?.branch, 'refs/heads/main');
    assert.equal(typeof alpha.worktrees[0]?.allocatedKiB, 'number');
    assert.equal(inventory.repositories.find((item) => item.path === bare)?.branch, 'refs/heads/main');
    assert.equal(alpha.worktrees.some((item) => item.path === externalWorktree && item.scope === 'external-reference-only'), true);
    assert.equal(inventory.gaps.some((item) => item.path === externalWorktree && item.reason === 'external-git-pointer'), true);
    assert.equal(inventory.gaps.some((item) => item.path === configured && item.reason === 'git-config-not-read'), true);
    assert.equal(inventory.gaps.some((item) => item.path === escaped && item.reason === 'external-git-pointer'), true);
    assert.equal(inventory.gaps.some((item) => item.path === externalGitDir && item.reason === 'external-git-pointer'), true);
    assert.equal(await readFile(join(configured, '.git', 'config'), 'utf8'), config);
    assert.equal(inventory.gaps.some((item) => item.path === linked && item.reason === 'symlink'), true);
    assert.equal(inventory.projects.some((item) => item.path === linked), false);
    assert.equal(inventory.gaps.some((item) => item.path === nestedLink && item.reason === 'symlink'), true);
    assert.equal(inventory.repositories.some((item) => item.path.startsWith(nestedLink)), false);
    const alphaSize = inventory.projects.find((item) => item.path === repo);
    assert.equal(typeof alphaSize?.allocatedKiB, 'number');
    assert.equal(JSON.stringify(inventory).includes('not inventory output'), false);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => inventoryGitWorkspaceReadonly(root, controller.signal), /abort/i);
    const alias = join(fixture, 'root-alias');
    await symlink(root, alias);
    await assert.rejects(() => inventoryGitWorkspaceReadonly(alias), /symlink/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('ordinary configured repo reports branch, commit time, local changes and main containment', async () => {
  const fixture = await mkdtemp(join(tmpdir().replace(/^\/var(?=\/|$)/, '/private/var'), 'humanagent-git-facts-'));
  const repo = join(fixture, 'ordinary');
  try {
    await mkdir(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    await writeFile(join(repo, 'file.txt'), 'original\n', 'utf8');
    git(repo, ['add', 'file.txt']);
    git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'topic']);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const date = git(repo, ['log', '-1', '--format=%cI']).trim();
    const configBefore = await readFile(join(repo, '.git', 'config'), 'utf8');
    const clean = (await inventoryGitWorkspaceReadonly(fixture)).repositories.find((r) => r.path === repo)?.worktrees[0];
    assert.equal(clean?.branch, 'refs/heads/topic');
    assert.equal(clean?.headCommit, head);
    assert.equal(clean?.latestCommitDate, date);
    assert.equal(clean?.dirty, false);
    assert.equal(clean?.untracked, false);
    assert.equal(clean?.includedInLocalMain, true);
    assert.equal(clean?.includedInTrackingMain, true);
    await writeFile(join(repo, 'file.txt'), 'changed\n', 'utf8');
    await writeFile(join(repo, 'new.txt'), 'untracked\n', 'utf8');
    git(repo, ['add', 'file.txt']);
    git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'topic']);
    await writeFile(join(repo, 'file.txt'), 'dirty\n', 'utf8');
    const changed = (await inventoryGitWorkspaceReadonly(fixture)).repositories.find((r) => r.path === repo)?.worktrees[0];
    assert.equal(changed?.dirty, true);
    assert.equal(changed?.untracked, true);
    assert.equal(changed?.includedInLocalMain, false);
    assert.equal(changed?.includedInTrackingMain, false);
    assert.equal(await readFile(join(repo, '.git', 'config'), 'utf8'), configBefore);
    await writeFile(join(repo, '.git', 'objects', 'info', 'alternates'), '/DO-NOT-READ/objects\n', 'utf8');
    const refused = await inventoryGitWorkspaceReadonly(fixture);
    assert.equal(refused.gaps.some((g) => g.path === repo && g.reason === 'unsupported-entry'), true);
    assert.equal(refused.repositories.find((r) => r.path === repo)?.worktrees.length, 0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
