/**
 * Attempt-private authentication control for Dashboard E2E.
 *
 * The pairing code, browser cookie and derived supervisor token stay in memory.
 * Nothing in this module writes credentials into the binding, receipt, journal,
 * URL, console output or repository.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { jsonRequest } from './browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_PATH = resolve(__dirname, '..', '..', '..', '..');

function mutationHeaders(auth, existing) {
  const headers = new Headers(existing ?? {});
  if (auth.cookie) headers.set('cookie', auth.cookie);
  for (const [name, value] of Object.entries(auth.mutationOriginHeaders)) {
    if (value) headers.set(name, value);
  }
  return headers;
}

export function createAttemptAuth(binding) {
  const repoPath = binding.repoPath ?? DEFAULT_REPO_PATH;
  const cli = resolve(repoPath, 'dist/app/app/src/cli.js');
  const auth = {
    cookie: null,
    mutationOriginHeaders: {},
    pairPid: null,
    pairExitCode: null,
    paired: false,
    fetch(input, init = {}) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, binding.serveBaseUrl);
      const method = String(init.method ?? 'GET').toUpperCase();
      const headers = mutationHeaders(auth, init.headers);
      if (method !== 'GET' && method !== 'HEAD' && url.origin === new URL(binding.serveBaseUrl).origin) {
        headers.set('origin', url.origin);
      }
      return fetch(url, { ...init, headers });
    },
    async json(path, init = {}) {
      const url = new URL(path, binding.serveBaseUrl);
      const response = await auth.fetch(url, init);
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { _raw: text.slice(0, 800) };
      }
      if (!response.ok) {
        throw new Error(`authenticated request failed ${response.status} ${url.pathname}: ${JSON.stringify(body).slice(0, 600)}`);
      }
      return body;
    },
    async pair() {
      const pair = spawn(process.execPath, [
        cli,
        'pair',
        '--workspace', binding.workspace,
        '--control-root', binding.controlRoot,
      ], {
        cwd: repoPath,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      auth.pairPid = pair.pid ?? null;
      let stdout = '';
      let stderr = '';
      const code = await new Promise((resolveExit, reject) => {
        pair.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        pair.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        pair.once('error', reject);
        pair.once('exit', (exitCode) => resolveExit(exitCode));
      });
      auth.pairExitCode = code;
      if (code !== 0) throw new Error(`humanagent pair exited ${String(code)}; stderr=${stderr.slice(-1200)}`);
      let receipt;
      try {
        receipt = JSON.parse(stdout.trim());
      } catch {
        throw new Error('humanagent pair did not return a JSON challenge');
      }
      if (typeof receipt.code !== 'string' || !receipt.code) {
        throw new Error('humanagent pair returned no pairing code');
      }
      const response = await fetch(`${binding.serveBaseUrl}/api/auth/pair`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: new URL(binding.serveBaseUrl).origin,
        },
        body: JSON.stringify({ code: receipt.code }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`pairing exchange failed ${response.status}: ${JSON.stringify(body).slice(0, 600)}`);
      }
      const setCookie = response.headers.get('set-cookie');
      if (!setCookie) throw new Error('pairing exchange did not set a session cookie');
      auth.cookie = setCookie.split(';')[0];
      auth.mutationOriginHeaders.origin = new URL(binding.serveBaseUrl).origin;
      auth.paired = true;
      return { expiresAt: body.expiresAt ?? null };
    },
    installBrowserContext(context) {
      if (!auth.cookie) throw new Error('cannot install browser session before pairing');
      return context.addCookies([{
        name: 'HA_SESSION',
        value: auth.cookie.slice(auth.cookie.indexOf('=') + 1),
        url: binding.serveBaseUrl,
        httpOnly: true,
        sameSite: 'Strict',
      }]);
    },
  };
  binding.auth = auth;
  return auth;
}
