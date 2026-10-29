import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open as openFile, readFile, rename, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export const SESSION_COOKIE_NAME = 'HA_SESSION';

const CREDENTIAL_SCHEMA_VERSION = 1 as const;
const SESSION_PROTOCOL_VERSION = 1 as const;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PAIRING_TTL_MS = 120_000;
const PRODUCT_PRINCIPAL_DOMAIN = 'product-principal:v1' as const;
const ACCESS_CONTROL_OWNER = 'humanagent.app.access-control';
const CREDENTIAL_LOCK_RETRY_MS = 10;
const CREDENTIAL_LOCK_WAIT_MS = 5_000;
const DARWIN_O_EXLOCK = 0x20;

export interface WebAccessCredential {
  readonly schemaVersion: typeof CREDENTIAL_SCHEMA_VERSION;
  readonly secret: string;
  readonly sessionGeneration: number;
  readonly createdAt: string;
  readonly pendingPairingChallenges?: readonly PersistedPairingChallenge[];
}

export interface PersistedPairingChallenge {
  readonly code: string;
  readonly expiresAt: number;
  readonly sessionGeneration: number;
}

export interface AccessSession {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * Stable nonsecret realm identity produced only after the existing cookie and
 * session verification succeeded. It derives from the persisted credential
 * with a distinct HMAC domain, so paired sessions, logout generations and cold
 * processes with the same credential project the same owner.
 */
export interface VerifiedProductPrincipal {
  readonly owner: string;
  readonly session: AccessSession;
}

const runtimeProductIdentity: unique symbol = Symbol('RuntimeProductIdentity');

/** Product identity only: neither a verified browser session nor Task authority. */
export interface RuntimeProductIdentity {
  readonly owner: string;
  readonly [runtimeProductIdentity]: true;
}

export interface PairingChallenge {
  readonly code: string;
  readonly expiresAt: number;
}

export interface AccessControlOptions {
  readonly credentialPath: string;
  readonly create?: boolean;
  readonly sessionTtlMs?: number;
  readonly pairingTtlMs?: number;
  readonly now?: () => number;
}

export type SessionVerification =
  | { readonly state: 'valid'; readonly session: AccessSession }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid' }
  | { readonly state: 'expired'; readonly session: AccessSession }
  | { readonly state: 'generation-mismatch'; readonly session: AccessSession };

export type ProductPrincipalVerification =
  | { readonly state: 'valid'; readonly principal: VerifiedProductPrincipal }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid' }
  | { readonly state: 'expired'; readonly session: AccessSession }
  | { readonly state: 'generation-mismatch'; readonly session: AccessSession };

export class AccessControlError extends Error {
  readonly code: string;
  readonly ownerId = ACCESS_CONTROL_OWNER;
  readonly nextAction: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, nextAction: string, httpStatus: number) {
    super(message);
    this.name = 'AccessControlError';
    this.code = code;
    this.nextAction = nextAction;
    this.httpStatus = httpStatus;
  }
}

export function isAccessControlError(error: unknown): error is AccessControlError {
  if (error instanceof AccessControlError) return true;
  if (!error || typeof error !== 'object') return false;
  const value = error as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly ownerId?: unknown;
    readonly message?: unknown;
    readonly nextAction?: unknown;
    readonly httpStatus?: unknown;
  };
  return value.name === 'AccessControlError'
    && typeof value.code === 'string'
    && value.ownerId === ACCESS_CONTROL_OWNER
    && typeof value.message === 'string'
    && typeof value.nextAction === 'string'
    && Number.isSafeInteger(value.httpStatus);
}

function fail(code: string, message: string, nextAction: string, httpStatus: number): never {
  throw new AccessControlError(code, message, nextAction, httpStatus);
}

function isMissing(error: unknown): boolean {
  return (error as { readonly code?: string }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { readonly code?: string }).code === 'EEXIST';
}

function decodeSecret(value: string): Uint8Array {
  const secret = Buffer.from(value, 'base64url') as Uint8Array;
  if (secret.length < 32) {
    fail('auth.credentials.unavailable', 'web access secret is invalid', 'remove the corrupt credential file and start serve again', 503);
  }
  return secret;
}

function parseCredential(raw: string): WebAccessCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('auth.credentials.unavailable', 'web access credential is not valid JSON', 'remove the corrupt credential file and start serve again', 503);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('auth.credentials.unavailable', 'web access credential must be an object', 'remove the corrupt credential file and start serve again', 503);
  }
  const value = parsed as Partial<WebAccessCredential>;
  if (
    value.schemaVersion !== CREDENTIAL_SCHEMA_VERSION
    || typeof value.secret !== 'string'
    || !Number.isSafeInteger(value.sessionGeneration)
    || (value.sessionGeneration ?? 0) < 1
    || typeof value.createdAt !== 'string'
    || Number.isNaN(Date.parse(value.createdAt))
  ) {
    fail('auth.credentials.unavailable', 'web access credential is invalid', 'remove the corrupt credential file and start serve again', 503);
  }
  decodeSecret(value.secret);
  return {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    secret: value.secret!,
    sessionGeneration: value.sessionGeneration!,
    createdAt: value.createdAt!,
    pendingPairingChallenges: parsePendingPairingChallenges(value.pendingPairingChallenges),
  };
}

function parsePendingPairingChallenges(value: unknown): readonly PersistedPairingChallenge[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(
      'auth.credentials.unavailable',
      'web access pending pairing challenges are invalid',
      'remove the corrupt credential file and start serve again',
      503,
    );
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(
        'auth.credentials.unavailable',
        'web access pending pairing challenge is invalid',
        'remove the corrupt credential file and start serve again',
        503,
      );
    }
    const challenge = entry as Partial<PersistedPairingChallenge>;
    if (
      typeof challenge.code !== 'string'
      || !challenge.code
      || !Number.isSafeInteger(challenge.expiresAt)
      || !Number.isSafeInteger(challenge.sessionGeneration)
      || (challenge.sessionGeneration ?? 0) < 1
    ) {
      fail(
        'auth.credentials.unavailable',
        'web access pending pairing challenge is invalid',
        'remove the corrupt credential file and start serve again',
        503,
      );
    }
    return {
      code: challenge.code,
      expiresAt: challenge.expiresAt!,
      sessionGeneration: challenge.sessionGeneration!,
    };
  });
}

function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function encodeToken(payload: string, secret: Uint8Array): string {
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function decodeToken(token: string, secret: Uint8Array): string | undefined {
  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) return undefined;
  const encodedPayload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  if (!safeEqual(signature, expected)) return undefined;
  try {
    return Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

export class AccessControlService {
  private readonly credentialPath: string;
  private readonly sessionTtlMs: number;
  private readonly pairingTtlMs: number;
  private readonly now: () => number;
  private credential: WebAccessCredential;
  private credentialWatcher?: FSWatcher;
  private credentialWatchStopped = true;
  private credentialWatchPending: Promise<void> = Promise.resolve();
  // A latched watcher runtime error (for example EMFILE). It isolates the
  // post-start failure from shutdown: `closeCredentialWatch` is idempotent and
  // never rethrows it, so `server.close` stays deterministic. The error remains
  // observable for the auth layer through `credentialWatchRuntimeError`.
  private credentialWatchRuntimeFailure: unknown;

  /** Exposes a latched post-start watcher runtime error without blocking close. */
  credentialWatchRuntimeError(): unknown {
    return this.credentialWatchRuntimeFailure;
  }

  private constructor(options: AccessControlOptions, credential: WebAccessCredential) {
    this.credentialPath = options.credentialPath;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.now = options.now ?? Date.now;
    this.credential = credential;
  }

  static async open(options: AccessControlOptions): Promise<AccessControlService> {
    const credential = options.create
      ? await ensureCredential(options.credentialPath)
      : await readCredential(options.credentialPath);
    return new AccessControlService(options, credential);
  }

  supervisorToken(leaseId: string, generation: number): string {
    if (!leaseId || !Number.isSafeInteger(generation) || generation < 1) {
      fail('auth.supervisor.required', 'supervisor identity is required', 'use the active daemon lease identity', 401);
    }
    const secret = decodeSecret(this.credential.secret);
    return createHmac('sha256', secret)
      .update(`supervisor:${leaseId}:${generation}`)
      .digest('base64url');
  }

  verifySupervisorToken(token: string | undefined, leaseId: string, generation: number): boolean {
    if (!token) return false;
    const expected = this.supervisorToken(leaseId, generation);
    return safeEqual(token, expected);
  }

  /**
   * Issues a one-use challenge durably under the existing credential mutation
   * lock. The optional pending collection keeps old credentials readable while
   * making issuance survive ordinary close and restart.
   */
  async issuePairingChallenge(): Promise<PairingChallenge> {
    return withPairingCredentialMutation(this.credentialPath, async () => {
      const current = await this.readCurrentCredential();
      this.credential = current;
      const now = this.now();
      const pending = (current.pendingPairingChallenges ?? [])
        .filter((entry) => entry.expiresAt > now);
      const code = randomBytes(16).toString('base64url');
      const expiresAt = now + this.pairingTtlMs;
      const next: WebAccessCredential = {
        ...current,
        pendingPairingChallenges: [
          ...pending,
          { code, expiresAt, sessionGeneration: current.sessionGeneration },
        ],
      };
      await writeCredential(this.credentialPath, next);
      this.credential = next;
      return { code, expiresAt };
    });
  }

  async consumePairingCode(code: string): Promise<AccessSession> {
    if (!code) {
      fail('auth.pair.invalid', 'pairing code is required', 'run humanagent pair again', 401);
    }
    return withPairingCredentialMutation(this.credentialPath, async () => {
      const current = await this.readCurrentCredential();
      this.credential = current;
      const pending = current.pendingPairingChallenges ?? [];
      const found = pending.find((entry) => safeEqual(entry.code, code));
      if (found === undefined) {
        fail('auth.pair.invalid', 'pairing code is invalid or already used', 'run humanagent pair again', 401);
      }
      const next: WebAccessCredential = {
        ...current,
        pendingPairingChallenges: pending.filter((entry) => entry !== found),
      };
      await writeCredential(this.credentialPath, next);
      this.credential = next;
      if (found.sessionGeneration !== current.sessionGeneration) {
        fail('auth.pair.invalid', 'pairing code is invalid or already used', 'run humanagent pair again', 401);
      }
      if (found.expiresAt <= this.now()) {
        fail('auth.pair.expired', 'pairing code has expired', 'run humanagent pair again', 401);
      }
      return this.issueSession(current.sessionGeneration);
    });
  }

  /**
   * Issues a durable browser session for a request that arrives over the
   * local loopback interface. The local operator is the same human who runs
   * the serve process, so pairing this browser would only ask them to copy a
   * code between two processes on the same machine. The session uses the
   * existing credential generation, so logout and generation invalidation
   * keep working; only the pairing step is dropped, and only for loopback.
   */
  async issueLocalSession(): Promise<AccessSession> {
    const current = await this.readCurrentCredential();
    this.credential = current;
    return this.issueSession(current.sessionGeneration);
  }

  async verifySession(cookieHeader: string | undefined): Promise<SessionVerification> {
    const token = parseCookies(cookieHeader).get(SESSION_COOKIE_NAME);
    if (!token) return { state: 'missing' };
    const current = await this.readCurrentCredential();
    this.credential = current;
    const payload = decodeToken(token, decodeSecret(current.secret));
    if (!payload) return { state: 'invalid' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      return { state: 'invalid' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'invalid' };
    const value = parsed as Partial<{
      readonly v: number;
      readonly sid: string;
      readonly iat: number;
      readonly exp: number;
      readonly gen: number;
    }>;
    if (
      value.v !== SESSION_PROTOCOL_VERSION
      || typeof value.sid !== 'string'
      || !value.sid
      || !Number.isSafeInteger(value.iat)
      || !Number.isSafeInteger(value.exp)
      || !Number.isSafeInteger(value.gen)
    ) {
      return { state: 'invalid' };
    }
    const session: AccessSession = {
      sessionId: value.sid,
      sessionGeneration: value.gen!,
      issuedAt: value.iat!,
      expiresAt: value.exp!,
    };
    if (session.sessionGeneration !== current.sessionGeneration) {
      return { state: 'generation-mismatch', session };
    }
    if (session.expiresAt <= this.now()) return { state: 'expired', session };
    return { state: 'valid', session };
  }

  sessionCookie(session: AccessSession): string {
    const payload = JSON.stringify({
      v: SESSION_PROTOCOL_VERSION,
      sid: session.sessionId,
      iat: session.issuedAt,
      exp: session.expiresAt,
      gen: session.sessionGeneration,
    });
    const token = encodeToken(payload, decodeSecret(this.credential.secret));
    const maxAgeSeconds = Math.max(1, Math.floor((session.expiresAt - this.now()) / 1000));
    return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  clearSessionCookie(): string {
    return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0`;
  }

  async logout(): Promise<number> {
    return withCredentialMutationLock(this.credentialPath, async () => {
      const current = await this.readCurrentCredential();
      const nextGeneration = current.sessionGeneration + 1;
      await writeCredential(this.credentialPath, {
        ...current,
        sessionGeneration: nextGeneration,
        pendingPairingChallenges: [],
      });
      const next: WebAccessCredential = {
        ...current,
        sessionGeneration: nextGeneration,
        pendingPairingChallenges: [],
      };
      this.credential = next;
      return nextGeneration;
    });
  }

  async isCurrentGeneration(session: AccessSession): Promise<boolean> {
    const current = await this.readCurrentCredential();
    this.credential = current;
    return session.sessionGeneration === current.sessionGeneration;
  }

  /**
   * Produces the verified product principal only when the existing cookie and
   * session verification succeeds. The owner is the domain-separated HMAC of
   * the persisted credential secret; it is stable across paired sessions and
   * generations and is never the session token or credential itself.
   */
  async verifyProductPrincipal(cookieHeader: string | undefined): Promise<ProductPrincipalVerification> {
    const verification = await this.verifySession(cookieHeader);
    if (verification.state !== 'valid') return verification;
    return {
      state: 'valid',
      principal: {
        owner: this.productPrincipalOwner(),
        session: verification.session,
      },
    };
  }

  async readPersistedGeneration(): Promise<number> {
    const current = await this.readCurrentCredential();
    this.credential = current;
    return current.sessionGeneration;
  }

  startCredentialWatch(
    onChange: () => void | Promise<void>,
    onError: (error: unknown) => void | Promise<void>,
  ): () => Promise<boolean> {
    if (this.credentialWatcher) return () => this.closeCredentialWatch();
    const target = basename(this.credentialPath);
    let lastGeneration = this.credential.sessionGeneration;
    this.credentialWatchStopped = false;
    this.credentialWatchRuntimeFailure = undefined;
    const enqueue = (operation: () => Promise<void>): void => {
      this.credentialWatchPending = this.credentialWatchPending.then(operation).catch(async (error) => {
        if (this.credentialWatchStopped) return;
        try {
          await onError(error);
        } catch {
          // The runtime error is already isolated through the auth-unavailable
          // SSE notification. Do not propagate it into a hard shutdown failure
          // or fabricate a healthy watch. Stop the watcher but keep the error
          // latched for the auth layer to observe.
          this.credentialWatchRuntimeFailure = error;
          this.credentialWatchStopped = true;
          this.credentialWatcher?.close();
          this.credentialWatcher = undefined;
        }
      });
    };
    const watcher = fsWatch(dirname(this.credentialPath), (eventType, filename) => {
      if (this.credentialWatchStopped || (filename !== null && filename !== undefined && filename !== target)) return;
      enqueue(async () => {
        const current = await this.readCurrentCredential();
        if (this.credentialWatchStopped) return;
        this.credential = current;
        if (current.sessionGeneration === lastGeneration) return;
        lastGeneration = current.sessionGeneration;
        await onChange();
      });
    });
    watcher.on('error', (error) => {
      if (this.credentialWatchStopped) return;
      // A runtime watcher failure (for example EMFILE) means the watch is not
      // healthy. Close it immediately, latch the error for the auth layer, and
      // still deliver the auth-unavailable notification. The latched error
      // must never rethrow from `closeCredentialWatch`.
      this.credentialWatchRuntimeFailure = error;
      this.credentialWatchStopped = true;
      this.credentialWatcher?.close();
      this.credentialWatcher = undefined;
      enqueue(async () => {
        await onError(error);
      });
    });
    this.credentialWatcher = watcher;
    watcher.unref?.();
    return () => this.closeCredentialWatch();
  }

  async closeCredentialWatch(): Promise<boolean> {
    const wasWatching = this.credentialWatcher !== undefined;
    this.credentialWatchStopped = true;
    this.credentialWatcher?.close();
    this.credentialWatcher = undefined;
    await this.credentialWatchPending;
    return wasWatching;
  }

  private async readCurrentCredential(): Promise<WebAccessCredential> {
    return readCredential(this.credentialPath);
  }

  isExpired(session: AccessSession): boolean {
    return session.expiresAt <= this.now();
  }

  readRuntimeProductIdentity(): RuntimeProductIdentity {
    return { owner: this.productPrincipalOwner(), [runtimeProductIdentity]: true };
  }

  private productPrincipalOwner(): string {
    const secret = decodeSecret(this.credential.secret);
    return `${PRODUCT_PRINCIPAL_DOMAIN}:${createHmac('sha256', secret)
      .update(PRODUCT_PRINCIPAL_DOMAIN)
      .digest('base64url')}`;
  }

  /**
   * Reads the stable nonsecret product owner for the current control root
   * without requiring a request session. It delegates the existing derivation;
   * the owner is never the session token or the credential.
   */
  readProductPrincipalOwner(): string {
    return this.productPrincipalOwner();
  }

  nextExpiryDelayMs(sessions: readonly AccessSession[]): number | undefined {
    if (sessions.length === 0) return undefined;
    const now = this.now();
    return Math.max(1, Math.min(...sessions.map((session) => session.expiresAt)) - now);
  }

  private issueSession(generation: number): AccessSession {
    const issuedAt = this.now();
    return {
      sessionId: randomUUID(),
      sessionGeneration: generation,
      issuedAt,
      expiresAt: issuedAt + this.sessionTtlMs,
    };
  }

}

async function ensureCredential(path: string): Promise<WebAccessCredential> {
  try {
    return await readCredential(path);
  } catch (error) {
    if (!(error instanceof AccessControlError) || error.code !== 'auth.credentials.unavailable') throw error;
  }
  await ensureSecurityDirectory(dirname(path));
  const credential: WebAccessCredential = {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    secret: randomBytes(32).toString('base64url'),
    sessionGeneration: 1,
    createdAt: new Date().toISOString(),
  };
  try {
    const handle = await openFile(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(credential) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
    return credential;
  } catch (error) {
    if (isAlreadyExists(error)) return readCredential(path);
    throw error;
  }
}

async function ensureSecurityDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory) as unknown as {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
  };
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('auth.credentials.unavailable', 'web access security root is not a directory', 'repair the control-root security directory', 503);
  }
  if ((info.mode & 0o077) !== 0) {
    fail('auth.credentials.unavailable', 'web access security root permissions are not private', `chmod 700 ${directory}`, 503);
  }
}

export async function readWebAccessCredential(credentialPath: string): Promise<WebAccessCredential> {
  return readCredential(credentialPath);
}

export async function deriveSupervisorToken(credentialPath: string, leaseId: string, generation: number): Promise<string> {
  const credential = await readCredential(credentialPath);
  const secret = decodeSecret(credential.secret);
  return createHmac('sha256', secret)
    .update(`supervisor:${leaseId}:${generation}`)
    .digest('base64url');
}

async function readCredential(path: string): Promise<WebAccessCredential> {
  let info: {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
  };
  try {
    info = await lstat(path) as unknown as {
      isFile(): boolean;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
      mode: number;
    };
  } catch (error) {
    if (isMissing(error)) {
      fail('auth.credentials.unavailable', 'web access credential is missing', 'start humanagent serve before pairing', 503);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail('auth.credentials.unavailable', 'web access credential must be a regular file', 'repair the control-root credential path', 503);
  }
  if ((info.mode & 0o077) !== 0) {
    fail('auth.credentials.unavailable', 'web access credential permissions are not private', `chmod 600 ${path}`, 503);
  }
  const parsed = parseCredential(await readFile(path, 'utf8'));
  await ensureSecurityDirectory(dirname(path));
  return parsed;
}

async function writeCredential(path: string, credential: WebAccessCredential): Promise<void> {
  await ensureSecurityDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await openFile(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(credential) + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withPairingCredentialMutation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await withCredentialMutationLock(path, operation);
  } catch (error) {
    if (error instanceof AccessControlError) throw error;
    fail(
      'auth.pair.persist-failed',
      'pairing challenge could not be saved',
      'repair the control-root security directory and retry pairing',
      503,
    );
  }
}

async function withCredentialMutationLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  if (process.platform !== 'darwin') {
    fail(
      'auth.credentials.unavailable',
      'web access credential locking is unsupported on this platform',
      'run serve on macOS or provide a supported cross-process credential lock',
      503,
    );
  }
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + CREDENTIAL_LOCK_WAIT_MS;
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | DARWIN_O_EXLOCK | fsConstants.O_NONBLOCK;
  let lockHandle;
  for (;;) {
    try {
      lockHandle = await openFile(lockPath, flags, 0o600);
      break;
    } catch (error) {
      const code = (error as { readonly code?: string }).code;
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw error;
      if (Date.now() >= deadline) {
        fail(
          'auth.credentials.busy',
          'web access credential is locked by another process',
          'wait for the active logout to finish and retry',
          503,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, CREDENTIAL_LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await lockHandle.close();
  }
}
