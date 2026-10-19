# Pairing and workspace foundation contract

Status: foundation candidate. The ledger and DAG contracts are ready; no runtime source or behavior in this document is implemented.

## Requirements and authority

The sole AppSDK ledger now appends:

- v15 `humanagent-launch-cwd-independent-declared-workspace`
- v16 `humanagent-pairing-cwd-and-startup-order-independent`

Both entries preserve this user original text:

```text
1. 用户可以在任意目录启动 humanagent，不影响显式大脑工作路径
2. 任何 pair 之类的逻辑不应该和启动路径和顺序绑定，只应该和是否已经配对，是否允许多个配对终端同时运行绑定
```

The UI recovery provenance is `你需要提供一个退出错误的机制，当前先进行页面进入后要求配对，于是去配对，提示错误`. Pair-before-serve and ordinary-restart durability are accepted product derivations. They are not represented as user-verbatim ledger text.

## Typed foundation

`packages/config/src/index.ts` owns these contracts:

```ts
export interface ProductPaths {
  readonly controlRoot: string;
  readonly securityRoot: string;
  readonly webAccessCredentialPath: string;
}

export async function resolveProductPaths(options: {
  readonly controlRoot?: string;
}): Promise<ProductPaths>;

export interface UserConfig {
  // existing fields omitted
  readonly project?: {
    readonly defaultAgent?: string;
    readonly reviewRequired?: boolean;
    readonly workspace?: string; // absolute; product config only
  };
}

export async function resolveRuntimePaths(options: {
  readonly workspace?: string;
  readonly controlRoot?: string;
}): Promise<RuntimePaths>;

export function formatPairingCommand(
  paths: Pick<ProductPaths, 'controlRoot'>,
): string;
```

Control-root precedence remains explicit `--control-root`, then `HUMANAGENT_HOME`, then `~/.humanagent`. `resolveProductPaths` does not resolve a workspace or read a lease. Workspace precedence is explicit `--workspace`, then product `[project].workspace`, then a typed `workspace-selection-missing` failure. There is no cwd fallback. An explicit invocation selection does not write product config; a declared workspace must already be absolute.

`formatPairingCommand` is the only command formatter. It returns `humanagent pair` for the canonical root and `humanagent pair --control-root <POSIX-shell-quoted-absolute-root>` for a custom root. Pairing never adds a workspace option.

## Pair issuance

`packages/app/src/ui-runtime/access-control.ts` owns the durable challenge mutation:

```ts
export interface PersistedPairingChallenge {
  readonly code: string;
  readonly expiresAt: number;
  readonly sessionGeneration: number;
}

export interface WebAccessCredential {
  readonly schemaVersion: 1;
  readonly secret: string;
  readonly sessionGeneration: number;
  readonly createdAt: string;
  readonly pendingPairingChallenges?: readonly PersistedPairingChallenge[];
}

export interface PairingChallenge {
  readonly code: string;
  readonly expiresAt: number;
}

class AccessControlService {
  async issuePairingChallenge(): Promise<PairingChallenge>;
  async consumePairingCode(code: string): Promise<AccessSession>;
}
```

The optional collection means an old credential is valid with an empty pending set. Issue and consume run under the existing cross-process credential mutation lock. Issue prunes expired entries and commits before returning. Consume checks code, expiry and credential generation, durably removes the entry, and then issues a session without incrementing `sessionGeneration`. The default TTL remains 120 seconds. A failed write returns a typed failure and neither a code nor a session.

Ordinary close and restart do not clear pending challenges. Existing logout still increments `sessionGeneration` and clears pending challenges inside the same owner. The retained supervisor challenge endpoint performs its existing supervisor checks and awaits `issuePairingChallenge`; it does not own a second challenge store. CLI `pair` opens `AccessControlService` directly from `resolveProductPaths`.

The public CLI receipt remains:

```ts
interface PairIssueReceipt {
  readonly command: 'pair';
  readonly code: string;
  readonly expiresAt: string; // ISO timestamp
}
```

## Public session projection

The existing public `GET /api/auth/session` response adds one field:

```ts
type AuthSessionResponse =
  | { authenticated: true; expiresAt: string; pairingCommand: string }
  | { authenticated: false; pairingCommand: string };
```

`pairingCommand: string` is available without authentication in both states. The producer is `formatPairingCommand` called by `packages/app/src/ui-runtime/server.ts`; the consumer is `docs/ui/login.js`. It contains no workspace flag, credential path or content, token, challenge, lease, or project selection. The UI does not parse TOML or infer the control root.

For `auth.pair.invalid`, `auth.pair.expired`, and request failure, the login surface retains the entered code and offers return-to-input, retry, and explicit return to the normalized same-origin `entryTarget`. Return-to-input hides the error and focuses the preserved value. Explicit return does not submit, mint or clear a session, or enter an automatic login redirect loop.

## Graph ownership and parallel work

| Graph | Source to sink | Owner files | Status |
|---|---|---|---|
| `workspace-selection` | launch request to one typed selected/missing/invalid result | `cli.ts`, `config/src/index.ts` | candidate; not implemented |
| `pair-issuance` | pair request to one code receipt or typed failure | `cli.ts`, `config/src/index.ts`, `access-control.ts` | candidate; not implemented |
| `humanagent-auth-session` | browser public entry to one auth terminal view | login/runtime shell and access control; existing topology retained | partial current behavior; recovery contract pending |
| `daemon-restart` | restart request to one restart result | existing supervisor/code-handoff owners; topology retained | current restart flow; product-auth preservation pending |

After foundation acceptance, these writers may start in parallel with disjoint files:

- C0 config foundation and formatter: `packages/config/src/index.ts`, config tests.
- P pair core and session projection: `access-control.ts`, `server.ts`, and existing auth test callers needed for the async issuer migration.
- U UI recovery: `docs/ui/login.html`, `docs/ui/login.js`, `docs/ui/login.css` only if needed, and the existing login browser proof.

P may implement against the frozen `formatPairingCommand` signature while C0 is in flight. P must import that function and must not copy formatting logic. Server composition and compile are checked after C0 is merged.

C1 CLI composition waits for C0 and P to merge. It owns `cli.ts` launch/pair wiring and affected CLI tests. It must not recreate durable issuance, session projection, or workspace selection inside CLI. No full config/supervisor/typecheck matrix is a foundation gate.

The source/sink and binding checks are static only. Runtime behavior, real browser recovery, pair-before-serve, restart persistence and independent-session acceptance remain `UNVERIFIED` until their named implementation owners provide focused tests and Root runs the real entry.
