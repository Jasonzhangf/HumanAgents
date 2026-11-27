export type ConversationScope =
  | { readonly kind: 'alex' }
  | { readonly kind: 'project'; readonly projectKey: string }

export type ConversationScopeRole = 'ceo' | 'project-lead'

export interface ConversationScopeDescriptor {
  readonly scope: ConversationScope
  readonly scopeKey: string
  readonly canonicalAddress: string
  readonly agentId: string
  readonly role: ConversationScopeRole
  readonly projectKey?: string
  readonly workspaceCwd?: string
}

export interface LegacyConversationBinding {
  readonly legacySessionRef: string
  readonly scope: ConversationScope
  readonly preservedInteractionRefs: readonly string[]
  readonly preservedTaskRefs: readonly string[]
  readonly sourceEvidenceRef: string
}

export interface ConversationScopeResponseMetadata {
  /** The typed selector used by the public conversation API. */
  readonly scope: ConversationScope
  /** Server-owned identity resolved from that selector. */
  readonly canonicalAddress: string
  readonly agentId: string
  readonly role: ConversationScopeRole
  readonly projectKey?: string
  readonly workspaceCwd?: string
  readonly preservedInteractionRefs: readonly string[]
  readonly preservedTaskRefs: readonly string[]
  readonly legacySessionRef?: string
  readonly legacyBindingEvidenceRef?: string
}

export interface ConversationScopeRequestQuery {
  readonly scope: 'alex' | 'system' | 'project'
  readonly projectKey?: string
}

export function conversationScopeKey(scope: ConversationScope): string {
  return scope.kind === 'alex' ? 'alex' : `project:${scope.projectKey}`
}

export function isConversationScope(value: unknown): value is ConversationScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'alex') return Object.keys(candidate).every((key) => key === 'kind')
  return candidate.kind === 'project'
    && typeof candidate.projectKey === 'string'
    && candidate.projectKey.trim().length > 0
    && Object.keys(candidate).every((key) => key === 'kind' || key === 'projectKey')
}

export function assertConversationScope(value: unknown): ConversationScope {
  if (!isConversationScope(value)) throw new Error('conversation scope must be {kind: alex} or {kind: project, projectKey}')
  return value
}

export function conversationScopeFromQuery(query: ConversationScopeRequestQuery): ConversationScope {
  if ((query.scope === 'alex' || query.scope === 'system') && query.projectKey === undefined) return { kind: 'alex' }
  if (query.scope === 'project' && typeof query.projectKey === 'string' && query.projectKey.trim().length > 0) {
    return { kind: 'project', projectKey: query.projectKey.trim() }
  }
  throw new Error('scope must be alex/system or project with one projectKey')
}
