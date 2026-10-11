/**
 * Contract + negative test for the local-file-search workspace-unchanged proof.
 *
 * Owns graph node: local_search_terminal evidence step (workspace manifest).
 *
 * The frozen local-file-search candidate produced
 * `workspaceManifestBefore: []`, `workspaceManifestAfter: []`,
 * `workspaceUnchanged: true` even though the scenario really created
 * `e2e-fixture/hello-agent.txt` in the attempt workspace. Root cause:
 * `lib/journal.mjs` dropped `stat` from its `node:fs/promises` import while
 * `workspaceManifest()` still called `stat(path)`. The resulting
 * `ReferenceError` was swallowed by the walk's `catch`, so every entry was
 * skipped, and `manifestsIdentical([], [])` is `true` — a vacuous proof.
 *
 * These tests bind the proof to a real fixture on disk:
 *   1. a real fixture yields a non-empty manifest with the exact identity;
 *   2. a read-only pass leaves that non-empty manifest unchanged;
 *   3. a real write is detected, so the "unchanged" result is not a constant;
 *   4. a stat failure is reported instead of being swallowed into an empty
 *      manifest, so the vacuous-proof class cannot return silently.
 *
 * No service, browser, provider or real E2E is started here.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { manifestsIdentical, workspaceManifest } from '../lib/journal.mjs';

const FIXTURE_REL = 'e2e-fixture/hello-agent.txt';
const MARKER = 'humanagent-e2e-marker-workspace-manifest-contract';

const tempRoots = [];

async function makeWorkspace(label) {
  const root = await mkdtemp(join(tmpdir(), `i1e-manifest-${label}-`));
  tempRoots.push(root);
  return root;
}

/** Write the same fixture the real scenario writes, and return its digest. */
async function writeFixture(workspace, body) {
  await mkdir(join(workspace, 'e2e-fixture'), { recursive: true });
  await writeFile(join(workspace, FIXTURE_REL), body, 'utf8');
  return `sha256:${createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

test.after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

test('a real fixture yields a non-empty manifest with the exact file identity', async () => {
  const workspace = await makeWorkspace('identity');
  const body = `${MARKER}\nsecond line for the marker probe\n`;
  const sha256 = await writeFixture(workspace, body);

  const manifest = await workspaceManifest(workspace);

  assert.ok(
    manifest.length > 0,
    'the manifest must not be empty for a workspace that really contains a file',
  );
  const entry = manifest.find((row) => row.relPath === FIXTURE_REL);
  assert.ok(entry, `the manifest must carry the real fixture ${FIXTURE_REL}`);
  assert.equal(entry.sha256, sha256);
  assert.equal(entry.size, Buffer.byteLength(body));
  const relPaths = manifest.map((row) => row.relPath);
  assert.deepEqual(relPaths, [...relPaths].sort((left, right) => left.localeCompare(right)));
});

test('a read-only pass leaves the real fixture manifest non-empty and unchanged', async () => {
  const workspace = await makeWorkspace('unchanged');
  await writeFixture(workspace, `${MARKER}\n`);

  const before = await workspaceManifest(workspace);
  assert.ok(before.length > 0, 'the before manifest must not be empty');

  // The scenario's read-only run: search and read the fixture, never write it.
  await readFile(join(workspace, FIXTURE_REL), 'utf8');

  const after = await workspaceManifest(workspace);
  assert.ok(after.length > 0, 'the after manifest must not be empty');
  assert.equal(manifestsIdentical(before, after), true);
});

test('a real fixture write is detected, so the unchanged proof is not vacuous', async () => {
  const workspace = await makeWorkspace('write-detected');
  await writeFixture(workspace, `${MARKER}\n`);

  const before = await workspaceManifest(workspace);
  assert.ok(before.length > 0, 'the before manifest must not be empty');

  await writeFile(join(workspace, FIXTURE_REL), `${MARKER}\nmutated\n`, 'utf8');

  const after = await workspaceManifest(workspace);
  assert.equal(manifestsIdentical(before, after), false);
});

test('a stat failure is reported, never swallowed into an empty manifest', async () => {
  const workspace = await makeWorkspace('stat-failure');
  await writeFixture(workspace, `${MARKER}\n`);

  // A dangling symlink is a real directory entry that readdir returns but stat
  // cannot follow. Skipping it silently would let a partial manifest pass as a
  // complete workspace proof.
  await symlink(join(workspace, 'missing-target'), join(workspace, 'dangling-link'), 'file');

  await assert.rejects(
    () => workspaceManifest(workspace),
    /workspace manifest could not stat dangling-link/,
  );
});
