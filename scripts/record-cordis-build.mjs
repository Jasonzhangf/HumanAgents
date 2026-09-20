import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { treeDigest } from './digests.mjs';

const projectRoot = resolve(process.cwd());
const artifactPath = resolve(projectRoot, 'dist/app');
const outputPath = resolve(projectRoot, 'dist/cordis-host-build.json');
const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: projectRoot, encoding: 'utf8' }).trim();
const artifactDigest = await treeDigest(artifactPath);
await mkdir(join(projectRoot, 'dist'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, candidateCommit, candidateTree, artifactPath, artifactDigest }, null, 2)}\n`, 'utf8');
