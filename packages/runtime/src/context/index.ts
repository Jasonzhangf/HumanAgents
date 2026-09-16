export class ContextIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextIndexError';
  }
}

export interface ContextIndexEntry<T> {
  readonly key: string;
  readonly value: T;
}

export class ContextIndex<T = unknown> {
  readonly limit: number;
  private readonly entries = new Map<string, T>();

  constructor(limit = 10000) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ContextIndexError('context index limit must be a positive safe integer');
    }
    this.limit = limit;
  }

  get size(): number {
    return this.entries.size;
  }

  set(key: string, value: T): void {
    this.assertKey(key);
    if (!this.entries.has(key) && this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
  }

  get(key: string): T | undefined {
    this.assertKey(key);
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as T;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: string): boolean {
    this.assertKey(key);
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    this.assertKey(key);
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): readonly string[] {
    return [...this.entries.keys()];
  }

  values(): readonly T[] {
    return [...this.entries.values()];
  }

  snapshot(): readonly ContextIndexEntry<T>[] {
    return [...this.entries].map(([key, value]) => ({ key, value }));
  }

  private assertKey(key: string): void {
    if (!key.trim()) throw new ContextIndexError('context index key is required');
  }
}

export class ContextCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextCacheError';
  }
}

export type ContextPermissionRevision = string | number;

export class ContextCache<T = unknown> {
  private readonly entries = new ContextIndex<T>();

  constructor(limit = 10000) {
    try {
      this.entries = new ContextIndex<T>(limit);
    } catch (error) {
      throw new ContextCacheError(
        error instanceof Error ? error.message : 'invalid context cache limit',
      );
    }
  }

  get size(): number {
    return this.entries.size;
  }

  key(bindingFingerprint: string, permissionRevision: ContextPermissionRevision): string {
    return ContextCache.key(bindingFingerprint, permissionRevision);
  }

  get(bindingFingerprint: string, permissionRevision: ContextPermissionRevision): T | undefined {
    return this.entries.get(this.key(bindingFingerprint, permissionRevision));
  }

  set(
    bindingFingerprint: string,
    permissionRevision: ContextPermissionRevision,
    value: T,
  ): void {
    this.entries.set(this.key(bindingFingerprint, permissionRevision), value);
  }

  delete(bindingFingerprint: string, permissionRevision: ContextPermissionRevision): boolean {
    return this.entries.delete(this.key(bindingFingerprint, permissionRevision));
  }

  clear(): void {
    this.entries.clear();
  }

  static key(bindingFingerprint: string, permissionRevision: ContextPermissionRevision): string {
    if (!bindingFingerprint.trim()) {
      throw new ContextCacheError('context cache binding fingerprint is required');
    }
    if (
      (typeof permissionRevision === 'string' && !permissionRevision.trim())
      || (typeof permissionRevision === 'number' && !Number.isFinite(permissionRevision))
    ) {
      throw new ContextCacheError('context cache permission revision is required');
    }
    return JSON.stringify([bindingFingerprint, permissionRevision]);
  }
}

export interface ContextBuildInput<T> {
  readonly stablePrefix: readonly T[];
  readonly indexRefs: readonly T[];
  readonly dynamicHead: readonly T[];
  readonly repairRefs: readonly T[];
}

export interface BuiltContext<T> extends ContextBuildInput<T> {
  readonly messages: readonly T[];
}

export function buildContext<T>(input: ContextBuildInput<T>): BuiltContext<T> {
  const stablePrefix = [...input.stablePrefix];
  const indexRefs = [...input.indexRefs];
  const dynamicHead = [...input.dynamicHead];
  const repairRefs = [...input.repairRefs];
  return {
    stablePrefix,
    indexRefs,
    dynamicHead,
    repairRefs,
    messages: [...stablePrefix, ...indexRefs, ...dynamicHead, ...repairRefs],
  };
}

function isPathWithin(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export function pruneEffectivePath(
  absoluteRefs: readonly string[],
  failedRefs: readonly string[],
  successRefs: readonly string[],
): readonly string[] {
  for (const ref of [...absoluteRefs, ...failedRefs, ...successRefs]) {
    if (!ref.startsWith('/')) {
      throw new ContextIndexError(`context path must be absolute: ${ref}`);
    }
  }

  const failed = [...new Set(failedRefs)];
  const success = [...new Set(successRefs)];
  return absoluteRefs.filter((ref) => {
    if (failed.some((failedRef) => isPathWithin(ref, failedRef))) return false;
    if (success.length === 0) return true;
    return success.some(
      (successRef) => isPathWithin(ref, successRef) || isPathWithin(successRef, ref),
    );
  });
}

export interface ToolCallMessage {
  readonly id?: string;
  readonly toolCallId?: string;
}

export interface ToolResultMessage {
  readonly id?: string;
  readonly toolCallId?: string;
}

export type ToolMessageGroup<C, R> =
  | { readonly id: string; readonly call: C; readonly result?: R }
  | { readonly id: string; readonly call?: undefined; readonly result: R };

function toolMessageId(
  message: ToolCallMessage | ToolResultMessage,
  label: string,
): string {
  const id = message.toolCallId ?? message.id;
  if (!id?.trim()) throw new ContextIndexError(`${label} tool message id is required`);
  return id;
}

export function groupToolMessages<C extends ToolCallMessage, R extends ToolResultMessage>(
  calls: readonly C[],
  results: readonly R[],
): readonly ToolMessageGroup<C, R>[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  const resultsById = new Map<string, R>();
  for (const result of results) {
    const id = toolMessageId(result, 'result');
    if (resultIds.has(id)) throw new ContextIndexError(`duplicate tool result id: ${id}`);
    resultIds.add(id);
    resultsById.set(id, result);
  }

  const groups: ToolMessageGroup<C, R>[] = [];
  const matchedResults = new Set<string>();
  for (const call of calls) {
    const id = toolMessageId(call, 'call');
    if (callIds.has(id)) throw new ContextIndexError(`duplicate tool call id: ${id}`);
    callIds.add(id);
    const result = resultsById.get(id);
    if (result) matchedResults.add(id);
    groups.push(result ? { id, call, result } : { id, call });
  }
  for (const result of results) {
    const id = toolMessageId(result, 'result');
    if (!matchedResults.has(id)) groups.push({ id, result });
  }
  return groups;
}

export interface ToolResultInput<B, C = unknown> {
  readonly business: B;
  readonly control?: C;
  readonly reason?: string;
}

export interface ToolResultMapping<B, C = unknown> {
  readonly business: B;
  readonly control?: C;
  readonly reason?: string;
  readonly failed: boolean;
}

export function mapToolResult<B, C = unknown>(
  input: ToolResultInput<B, C>,
): ToolResultMapping<B, C> {
  if (input.reason !== undefined && !input.reason.trim()) {
    throw new ContextIndexError('tool result reason must not be empty');
  }
  return {
    business: input.business,
    control: input.control,
    reason: input.reason,
    failed: input.reason !== undefined,
  };
}

export class ContextCommitterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextCommitterError';
  }
}

export class ContextPrepareError extends ContextCommitterError {
  constructor(message: string) {
    super(message);
    this.name = 'ContextPrepareError';
  }
}

export class ContextCommitError extends ContextCommitterError {
  constructor(message: string) {
    super(message);
    this.name = 'ContextCommitError';
  }
}

export class ContextPublishError extends ContextCommitterError {
  constructor(message: string) {
    super(message);
    this.name = 'ContextPublishError';
  }
}

export interface ContextPrepareInput<T> {
  readonly id?: string;
  readonly revision?: string | number;
  readonly value: T;
}

export interface PreparedContext<T> {
  readonly id: string;
  readonly revision: string | number;
  readonly value: T;
  readonly state: 'prepared';
}

export interface CommittedContext<T> extends Omit<PreparedContext<T>, 'state'> {
  readonly state: 'committed';
}

export interface PublishedContext<T> extends Omit<PreparedContext<T>, 'state'> {
  readonly state: 'published';
}

export interface ContextCommitterOptions<T> {
  readonly commit?: (context: PreparedContext<T>) => void | Promise<void>;
  readonly publish?: (context: CommittedContext<T>) => void;
}

interface PreparedRecord<T> {
  readonly context: PreparedContext<T>;
  readonly state: 'prepared';
  attempt?: Promise<CommittedContext<T>>;
}

interface CommittedRecord<T> {
  readonly context: CommittedContext<T>;
  readonly state: 'committed';
}

interface PublishedRecord<T> {
  readonly context: PublishedContext<T>;
  readonly state: 'published';
}

type CommitterState<T> =
  | PreparedRecord<T>
  | CommittedRecord<T>
  | PublishedRecord<T>;

export class ContextCommitter<T = unknown> {
  private readonly records = new Map<string, CommitterState<T>>();
  private nextId = 1;

  constructor(private readonly options: ContextCommitterOptions<T> = {}) {}

  prepare(input: ContextPrepareInput<T>): PreparedContext<T> {
    const id = input.id ?? `context-${this.nextId++}`;
    if (!id.trim()) throw new ContextPrepareError('context id is required');
    if (this.records.has(id)) throw new ContextPrepareError(`context already prepared: ${id}`);
    const context: PreparedContext<T> = {
      id,
      revision: input.revision ?? 0,
      value: input.value,
      state: 'prepared',
    };
    this.records.set(id, { context, state: 'prepared' });
    return context;
  }

  async commit(contextOrId: PreparedContext<T> | string): Promise<CommittedContext<T>> {
    const current = this.record(contextOrId, ContextCommitError);
    if (current.state === 'committed') {
      if (typeof contextOrId !== 'string') {
        this.assertCommitIdentity(current.context, contextOrId);
      }
      return current.context;
    }
    if (current.state === 'published') {
      throw new ContextCommitError(`context is not prepared: ${current.context.id}`);
    }
    if (typeof contextOrId !== 'string') {
      this.assertCommitIdentity(current.context, contextOrId);
    }
    if (current.attempt) return current.attempt;

    let resolveAttempt!: (context: CommittedContext<T>) => void;
    let rejectAttempt!: (error: unknown) => void;
    const attempt = new Promise<CommittedContext<T>>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    current.attempt = attempt;
    void (async () => {
      try {
        await this.options.commit?.(current.context);
        const context: CommittedContext<T> = { ...current.context, state: 'committed' };
        const latest = this.records.get(context.id);
        if (latest?.state === 'prepared' && latest.attempt === attempt) {
          this.records.set(context.id, { context, state: 'committed' });
          resolveAttempt(context);
          return;
        }
        rejectAttempt(
          latest?.state === 'prepared'
            ? new ContextCommitError(`context commit attempt superseded: ${context.id}`)
            : new ContextCommitError(`context commit no longer pending: ${context.id}`),
        );
      } catch (error) {
        const latest = this.records.get(current.context.id);
        if (latest?.state === 'prepared' && latest.attempt === attempt) {
          latest.attempt = undefined;
        }
        rejectAttempt(error);
      }
    })();
    return attempt;
  }

  publish(contextOrId: CommittedContext<T> | string): PublishedContext<T> {
    const current = this.record(contextOrId, ContextPublishError);
    if (current.state !== 'committed') {
      throw new ContextPublishError(`context is not committed: ${current.context.id}`);
    }
    const context: PublishedContext<T> = { ...current.context, state: 'published' };
    this.options.publish?.(current.context);
    this.records.set(context.id, { context, state: 'published' });
    return context;
  }

  state(id: string): 'prepared' | 'committed' | 'published' | undefined {
    return this.records.get(id)?.state;
  }

  private record(
    contextOrId: PreparedContext<T> | CommittedContext<T> | string,
    ErrorType: new (message: string) => ContextCommitterError,
  ): CommitterState<T> {
    const id = typeof contextOrId === 'string' ? contextOrId : contextOrId.id;
    const record = this.records.get(id);
    if (!record) throw new ErrorType(`unknown context: ${id}`);
    return record;
  }

  private assertCommitIdentity(
    current: PreparedContext<T> | CommittedContext<T> | PublishedContext<T>,
    candidate: PreparedContext<T>,
  ): void {
    if (!Object.is(current.revision, candidate.revision) || !Object.is(current.value, candidate.value)) {
      throw new ContextCommitError(`context commit identity conflict: ${current.id}`);
    }
  }
}
