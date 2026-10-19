# Pairing and workspace foundation contract

Status: foundation candidate. The ledger and DAG contracts are ready; no runtime source or behavior in this document is implemented. Root accepted the default-product selection supplement and the complete owner-entry plan on 2026-10-19; this record adds no ledger row and does not relax the persistence boundary.

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

export interface DefaultProductSelection {
  readonly schemaVersion: 1;
  readonly controlRoot: string;
}

export async function readDefaultProductSelection(): Promise<DefaultProductSelection | undefined>;
export async function declareDefaultProduct(controlRoot: string): Promise<DefaultProductSelection>;
```

Control-root precedence is explicit `--control-root`, then `HUMANAGENT_HOME`, then the fixed default-product declaration, then `~/.humanagent`. `resolveProductPaths` does not resolve a workspace or read a lease. Workspace precedence is explicit `--workspace`, then product `[project].workspace`, then a typed `workspace-selection-missing` failure. There is no cwd fallback. An explicit invocation selection does not write product config; a declared workspace must already be absolute.

`formatPairingCommand` is the only command formatter. It always returns `humanagent pair --control-root <POSIX-shell-quoted-absolute-root>`, including for the canonical root. The browser command names the exact product root because a persistent default selection may point to a different product. Pairing never adds a workspace option.

## Default product selection

Bare `humanagent` and bare `humanagent pair` must adopt one already selected product across terminals without terminal exports or cwd inference. The only mechanism is one fixed bootstrap declaration:

```text
~/.humanagent/default-product.toml
```

Its content is exactly:

```toml
schemaVersion = 1
controlRoot = "/absolute/path/to/the/selected/product"
```

This file is the user default product selector. It stores no workspace, port, PID, lease, credential, session, product copy, or run state. Its location always derives from `os.homedir()` and never follows cwd, `HUMANAGENT_HOME`, or the selected product, so selection cannot form a cycle. The file is bootstrap selection, not product persistence; product persistence still lives only under the selected control root.

`packages/config/src/index.ts` is the single owner for reading, validating, writing, and ordering this declaration. The proposal above is not implemented yet. No product registry or run-instance directory is added.

The CLI exposes one explicit adoption entry:

```sh
humanagent product use --control-root "/known/current/product"
```

This command calls the config owner only. It validates that the target is an existing, accessible absolute directory that satisfies the existing path policy, then atomically writes the default declaration. It does not load a provider, start a runtime, initialize a product, issue a pairing code, or change the product workspace. A successful receipt contains only the declaration location and the selected root. Bare `serve`, `pair`, `restart`, or any `--control-root` call never rewrites the declaration, so a temporary visit to another product cannot change later terminals.

### Selection precedence and failure semantics

The resolver reads from highest to lowest priority:

```text
explicit --control-root
  → HUMANAGENT_HOME
  → ~/.humanagent/default-product.toml declaration
  → ~/.humanagent
```

An explicit `--control-root` or `HUMANAGENT_HOME` selection must short-circuit. When a higher-priority selection exists, the resolver does not read or validate a lower-priority declaration, so an invalid lower selection cannot block that call. The declaration is read only when neither the flag nor the environment variable is present.

- A missing declaration keeps the original `~/.humanagent` default. It does not make a custom root discoverable.
- A declaration with invalid format, invalid version, or an invalid path returns a typed `default-product-selection-invalid` failure.
- A declaration whose directory no longer exists returns an explicit failure.
- The resolver never falls back to another product and never creates an empty product.
- The resolver never scans owners, processes, or data directories to find a product.

The selected root does not imply a runnable runtime. Workspace still resolves as `--workspace → selected product [project].workspace → typed workspace-selection-missing`. `pair` consumes only the resolved product root; it adds no workspace, lease, or owner lookup. The declaration changes only the root for later calls without a higher-priority selection. It does not change product identity, migrate data, or merge products. Every journal, checkpoint, credential, and session stays under the selected root with its existing owner.

The `formatPairingCommand` signature stays unchanged. It produces `humanagent pair --control-root <POSIX-shell-quoted-absolute-root>` in the browser for every root, including the canonical root. This is page-specific product binding; the naked CLI still follows the default-product declaration.

### Restart retains the resolved product

The existing typed `SupervisorStartupDeclaration` keeps its owner and `args` field. When a launch is bare, its original args may omit root and workspace, so C1 must write the already resolved canonical control root and workspace as explicit arguments into the retained `args`. No restart config file and no selection state in a business payload is added. This keeps a formal restart on the same product even if the default declaration changes later. Caller cwd stays the process start context and no longer decides product or workspace. This contract records the requirement; CLI composition is C1 and is not implemented here.

## Ordinary launch and explicit restart

`packages/app/src/supervisor/supervisor.ts` remains the sole owner of the serve lease decision. A normal `humanagent` or `humanagent serve` invocation supplies launch intent and renders the result. It does not decide ownership outside the existing guard. Ordinary serve removes the unconditional takeover option; a normal launch must not supply `takeover.stop`.

Inside the guard, an ordinary launch behaves as follows:

| Selected lease state | Result |
|---|---|
| No lease, or a cleanly disposed lease | Commit one new lease, then invoke the lazy preparation factory and start the existing stages. |
| Live `humanagent.app.serve` owner, ready, published `controlEndpoint`, no pending restart | Return `already-running` with the owner's endpoint URL and the formatter-produced pairing command. Exit 0. Do not write a lease, prepare a runtime, open a listener, install shutdown handlers, or attach ownership. |
| Owner still starting, or ready without a published endpoint | Return a typed not-ready failure and ask the caller to retry after startup completes. |
| Pending restart transition | Return a typed transition-in-progress failure. Do not compete with the replacement. |
| Undisposed lease whose recorded process has exited | Return a typed recovery-required failure and use the existing formal restart recovery path. |
| Wrong owner, corrupt lease, or unresolved cleanup failure | Return the existing applicable typed failure. Do not continue or take over. |

The lazy factory runs only after acquisition. The `already-running` receipt contains `command: 'serve'`, `status: 'already-running'`, `controlRoot`, `workspace`, `projectKey`, `url`, and `pairingCommand`. The URL comes from the published `controlEndpoint` through the existing IPv6-aware helper, never from the duplicate invocation's requested port or a default port. The pairing command comes from `formatPairingCommand`. The guard serializes the ownership decision; it does not promise the owner will stay alive after the receipt. If the owner stops later, the browser reports the connection failure. The CLI adds no retry or takeover for that possibility.

An ordinary duplicate launch never signals, replaces, restarts, or acquires runtime ownership from a live same-target owner. Only a formal restart may replace an owner. `spawnReplacement` appends a one-shot internal `--restart-request <recorded-request-id>` argument tied to the already recorded `SupervisorRestartTransition`. The supervisor verifies the marker against the selected lease's pending restart request, its previous lease ID, generation, process-start token, and the declared target entry before stopping the previous owner and again at replacement commit. The marker is a control argument for that child invocation. It is not a business field, credential, persistent startup option, or new configuration source, and it is excluded from `SERVE_STARTUP_OPTIONS`. A missing marker means normal launch even when a transition exists. An invalid or stale marker fails explicitly and never falls through to takeover.

The normal-launch and replacement paths reuse the existing startup-failure recording, reverse disposal, lease release, process-identity checks, graceful stop, already-dead recovery classification, and ready completion. No second lock, parser, lease reader, or state source is added. `serve-task` begins with an authorized execution plan and does not own process launch.

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
| `serve-launch` | selected product/workspace plus launch intent to one started/already-running/typed-failure result | `cli.ts`, supervisor lease guard and lazy startup; existing topology retained | candidate; not implemented |
| `pair-issuance` | pair request to one code receipt or typed failure | `cli.ts`, `config/src/index.ts`, `access-control.ts` | candidate; not implemented |
| `default-product-adoption` | explicit adoption request to one declaration receipt or typed failure | `cli.ts`, `config/src/index.ts` | candidate; not implemented |
| `humanagent-auth-session` | browser public entry to one auth terminal view | login/runtime shell and access control; existing topology retained | partial current behavior; recovery contract pending |
| `daemon-restart` | restart request to one restart result; replacement marker validated against the recorded transition | existing supervisor/code-handoff owners; topology retained | current restart flow; product-auth preservation and request-marker validation pending |

After foundation acceptance, these writers may start in parallel with disjoint files:

- C0 config foundation and formatter: `packages/config/src/index.ts`, config tests.
- D default-product declaration and precedence: `packages/config/src/index.ts`, config tests, after C0 in the same tree.
- P pair core and session projection: `access-control.ts`, `server.ts`, and existing auth test callers needed for the async issuer migration.
- U UI recovery: `docs/ui/login.html`, `docs/ui/login.js`, `docs/ui/login.css` only if needed, and the existing login browser proof.

P may implement against the frozen `formatPairingCommand` signature while C0 is in flight. P must import that function and must not copy formatting logic. Server composition and compile are checked after C0 is merged.

C1 CLI composition waits for D and P. It owns `cli.ts` adoption/launch/pair wiring, the supervisor and code-handoff changes needed by the owner-entry plan, necessary exports, and affected CLI/app/supervisor tests. It must not recreate durable issuance, session projection, default-product selection, workspace selection, the lease guard, or restart transition recording inside CLI. No full config/supervisor/typecheck matrix is a foundation gate, and no latency/load matrix is added.

## Installed naked CLI acceptance

The installed global entry must be usable before delivery. Root acceptance uses `/opt/homebrew/bin/humanagent` with no `HUMANAGENT_HOME`, from a fresh terminal and an unrelated cwd, after one explicit `humanagent product use --control-root <known-current-product>` adoption. Bare `humanagent` and bare `humanagent pair` must select the declared product and its declared workspace; the default home product must not gain a second empty service, credential, project manifest, or lease. A second isolated browser session must pair while the first session stays valid. Formal `humanagent restart` from the same environment must retain the resolved product and workspace, and an explicit `--control-root` for an isolated product B must not change the default declaration.

With the intended product already running, the installed naked launch from an unrelated cwd and without `HUMANAGENT_HOME` must exit 0 with `already-running`. The receipt names the declared product/workspace and the existing browser entry. The original owner's lease identity and endpoint remain unchanged; no replacement, disposal, or restart event occurs. Following the returned URL reaches the usable product, an already paired browser remains usable, and the returned pairing command addresses the same product so a second independent browser can pair while the first remains valid. Formal `humanagent restart` is verified separately and must retain the same product/workspace.

The source/sink and binding checks are static only. Runtime behavior, default-product adoption, installed naked CLI selection, ordinary duplicate-launch continuation, lazy preparation, restart-marker validation, real browser recovery, pair-before-serve, restart persistence, and independent-session acceptance remain `UNVERIFIED` until their named implementation owners provide focused tests and Root runs the real entry.
