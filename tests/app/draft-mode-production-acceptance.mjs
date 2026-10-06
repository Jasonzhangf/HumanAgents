#!/usr/bin/env node
/**
 * Public HTTP RED regression for typed draft revision projection.
 *
 * T14 is not wired yet. The real explicit-input path creates only the legacy
 * draft, so this script must fail when the public interaction snapshot has no
 * current typed revision. It uses the built CLI, the isolated serve/auth
 * helpers, and the live RCC provider. It does not use a browser or a fake
 * provider.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeProvider, startServeForAttempt } from './dashboard-e2e/lib/browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const EVIDENCE_DIR = process.env.HUMANAGENT_DRAFT_EVIDENCE_DIR
  ?? '/Users/fanzhang/.codex/visualizations/2026/10/03/01a0ff23-1b80-7f50-8087-0fd5e4819c67/interaction-redesign-run/interaction-draft-mode-acceptance-20261005-t17r2';
const RECEIPT_PATH = join(EVIDENCE_DIR, 'draft-mode-production-acceptance.receipt.json');
const RAW_LOG_PATH = join(EVIDENCE_DIR, 'draft-mode-production-acceptance.raw.log');

const logs = [];
const startedAt = new Date().toISOString();
const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const receipt = {
  proof: 'draft-mode-production-acceptance-public-http-red',
  status: 'RUNNING',
  candidateSha: null,
  startedAt,
  endedAt: null,
  evidenceDir: EVIDENCE_DIR,
  receiptPath: RECEIPT_PATH,
  rawLogPath: RAW_LOG_PATH,
  rcc: null,
  runtime: null,
  publicContracts: [],
  firstDeviation: null,
  cleanup: null,
};

let root = null;
let binding = null;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logs.push(line);
  console.error(line);
}

async function request(path, init = {}) {
  const url = new URL(path, binding.serveBaseUrl);
  const response = await binding.auth.fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 4000) };
  }
  return {
    path: url.pathname,
    method: init.method ?? 'GET',
    status: response.status,
    body,
  };
}

function record(name, response, expected) {
  receipt.publicContracts.push({ name, expected, response });
  return response;
}

function fail(code, message, affected) {
  receipt.firstDeviation = { code, message, affected };
  receipt.status = 'RED';
  throw new Error(`${code}: ${message}`);
}

async function stopOwnedServe() {
  if (binding?.serve) {
    await binding.serve.stop();
    return;
  }
  const child = binding?.serveChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  await exited;
}

async function writeEvidence() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await writeFile(RAW_LOG_PATH, `${logs.join('\n')}\n`, 'utf8');
}

async function main() {
  root = await mkdtemp(join(tmpdir(), 'humanagent-draft-mode-http-'));
  binding = {
    attemptId,
    attemptRoot: root,
    repoPath: REPO_ROOT,
    workspace: join(root, 'workspace'),
    controlRoot: join(root, 'control'),
  };
  receipt.attemptRoot = root;
  receipt.candidateSha = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).trim();

  try {
    try {
      receipt.rcc = await probeProvider(binding);
    } catch (error) {
      receipt.status = 'BLOCKED';
      throw new Error(`RCC provider is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    await startServeForAttempt(binding, { readyTimeoutMs: 90_000 });
    receipt.serve = {
      pid: binding.servePid,
      port: binding.servePort,
      baseUrl: binding.serveBaseUrl,
      controlRoot: binding.controlRoot,
      workspace: binding.workspace,
    };

    const runtime = record(
      'runtime-status',
      await request('/api/runtime/status'),
      '200 with live provider readiness',
    );
    receipt.runtime = {
      state: runtime.body?.state ?? null,
      providerState: runtime.body?.providerState ?? null,
      providerError: runtime.body?.providerError ?? null,
      route: runtime.body?.route ?? null,
    };

    const created = record(
      'create-explicit-input',
      await request('/api/explicit/inputs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'business',
          requestKind: 'new-task-preview',
          sourceRef: `draft-mode-red-${attemptId}`,
          rawInput: 'Do not clarify. Create exactly one concrete task: read the workspace marker file and return its exact contents in a short completion summary.',
        }),
      }),
      '201 with a public interaction id',
    );
    if (created.status !== 201 || typeof created.body?.interactionId !== 'string') {
      fail('explicit-input.create-failed', 'public explicit input did not return an interaction id', created);
    }

    const interactionPath = `/api/explicit/interactions/${encodeURIComponent(created.body.interactionId)}`;
    const interpreted = record(
      'interpret-explicit-input',
      await request(`${interactionPath}/interpret`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      '200 with a human task draft',
    );
    const inspected = record(
      'inspect-explicit-interaction',
      await request(interactionPath),
      '200 with the current typed draft revision',
    );

    const draft = inspected.body?.draft;
    const revision = inspected.body?.revision;
    const affected = {
      interactionKeys: inspected.body && typeof inspected.body === 'object' ? Object.keys(inspected.body) : [],
      draftKeys: draft && typeof draft === 'object' ? Object.keys(draft) : [],
      interpretedState: interpreted.body?.state ?? null,
      interpretedDraftPresent: Boolean(interpreted.body?.draft),
      interpretedRevisionPresent: Boolean(interpreted.body?.revision),
      inspectedState: inspected.body?.state ?? null,
      inspectedDraft: draft ?? null,
      inspectedRevision: revision ?? null,
    };

    if (inspected.status !== 200 || !draft) {
      fail('explicit-interaction.draft-missing', 'public interaction snapshot did not expose the human task draft', {
        ...affected,
        inspectedResponse: inspected,
      });
    }
    if (revision === undefined || revision === null) {
      fail(
        'explicit-interaction.typed-revision-missing',
        'public interaction snapshot exposed only the legacy draft; the current typed revision is absent',
        { ...affected, inspectedResponse: inspected },
      );
    }

    receipt.status = 'PASS';
  } finally {
    let cleanupError = null;
    try {
      await stopOwnedServe();
    } catch (error) {
      cleanupError = `serve stop failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (root) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupError = cleanupError
          ? `${cleanupError}; temp root removal failed: ${error instanceof Error ? error.message : String(error)}`
          : `temp root removal failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    receipt.cleanup = {
      servePid: binding?.servePid ?? null,
      serveStopped: !binding?.serveChild || binding.serveChild.exitCode !== null || binding.serveChild.signalCode !== null,
      tempRoot: root,
      tempRootRemoved: root === null || !existsSync(root),
      error: cleanupError,
    };
    receipt.endedAt = new Date().toISOString();
    await writeEvidence();
  }
}

main()
  .catch(async (error) => {
    if (receipt.status === 'RUNNING') receipt.status = 'ERROR';
    receipt.error = error instanceof Error ? error.message : String(error);
    log(receipt.error);
    await writeEvidence();
  })
  .finally(() => {
    const code = receipt.status === 'PASS' ? 0 : 1;
    receipt.exitCode = code;
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`, () => process.exit(code));
  });
