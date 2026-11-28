export type ProjectMemberRole =
  | 'architect'
  | 'reviewer'
  | 'tester'
  | 'specialist'
  | 'manager'
  | 'executor';

export const RESERVED_MANAGER_NAME = 'Jenny' as const;
export const ALLOWED_WORKER_ROLES = ['architect', 'reviewer', 'tester', 'specialist', 'executor'] as const;
export const RESERVED_ADDRESSING_NAMES = ['Jenny', 'Alex', 'CEO'] as const;

const ALLOWED_WORKER_ROLE_SET = new Set<string>(ALLOWED_WORKER_ROLES);
const RESERVED_ADDRESSING_NAME_SET = new Set<string>(RESERVED_ADDRESSING_NAMES);

export function isAllowedWorkerRole(role: unknown): role is Exclude<ProjectMemberRole, 'manager'> {
  return typeof role === 'string' && ALLOWED_WORKER_ROLE_SET.has(role);
}

export const DEFAULT_ROLE_TEMPLATES: Readonly<Record<Exclude<ProjectMemberRole, 'manager'>, MemberRoleTemplate>> = {
  architect: {
    role: 'architect',
    systemPrompt: 'Follow HumanAgent project rules and keep module boundaries single-owner.',
    rolePrompt: 'Design architecture, interfaces, and SESE DAG boundaries cleanly.',
  },
  reviewer: {
    role: 'reviewer',
    systemPrompt: 'Review changes independently against requirements, DAGs, and runtime evidence.',
    rolePrompt: 'Verify correctness, invariants, and minimal necessary code before acceptance.',
  },
  tester: {
    role: 'tester',
    systemPrompt: 'Verify real user-facing behavior through live entrypoints and deterministic receipts.',
    rolePrompt: 'Execute blackbox and regression checks and report concrete pass/fail evidence.',
  },
  specialist: {
    role: 'specialist',
    systemPrompt: 'Operate within assigned domain scope without inventing cross-project authority.',
    rolePrompt: 'Handle specialized investigation or targeted delivery with verifiable outputs.',
  },
  executor: {
    role: 'executor',
    systemPrompt: 'Execute scoped tasks cleanly inside exclusive worktree paths with test evidence.',
    rolePrompt: 'Implement minimal root-cause changes and verify affected tests before return.',
  },
};

export function defaultRoleTemplate(role: Exclude<ProjectMemberRole, 'manager'> = 'executor'): MemberRoleTemplate {
  const source = DEFAULT_ROLE_TEMPLATES[role] ?? DEFAULT_ROLE_TEMPLATES.executor;
  return {
    role: source.role,
    systemPrompt: `${source.systemPrompt}`,
    rolePrompt: `${source.rolePrompt}`,
  };
}

/**
 * Shared 50-name pool for ordinary project workers across the HumanAgent
 * control domain. Jenny is reserved for the single project manager and never
 * consumes a slot in this pool.
 */
export const WORKER_NAME_POOL: readonly string[] = [
  'Alice', 'Bob', 'Carol', 'David', 'Emma', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack',
  'Kate', 'Leo', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rose', 'Sam', 'Tina',
  'Uma', 'Victor', 'Wendy', 'Xavier', 'Yara', 'Zane', 'Aaron', 'Bella', 'Caleb', 'Diana',
  'Ethan', 'Fiona', 'Gavin', 'Hazel', 'Isaac', 'Julia', 'Kevin', 'Luna', 'Mason', 'Nora',
  'Owen', 'Piper', 'Ryan', 'Sofia', 'Tyler', 'Vera', 'Wyatt', 'Zoe', 'Liam', 'Chloe',
];

export class MemberRosterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MemberRosterError';
    this.code = code;
  }
}

export interface MemberRoleTemplate {
  readonly role: Exclude<ProjectMemberRole, 'manager'>;
  readonly systemPrompt: string;
  readonly rolePrompt: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface ProjectMemberRecord {
  readonly memberId: string;
  readonly name: string;
  readonly role: ProjectMemberRole;
  readonly systemPrompt: string;
  readonly rolePrompt: string;
  readonly provider?: string;
  readonly model?: string;
}

/**
 * Allocates the first available name from the shared 50-name worker pool.
 * Released names become reusable once the retired worker settles.
 */
export function allocateWorkerName(usedNames: ReadonlySet<string>): string {
  const candidate = WORKER_NAME_POOL.find((name) => !usedNames.has(name));
  if (!candidate) {
    throw new MemberRosterError('member.name-pool-exhausted', 'all 50 worker names in the control pool are currently assigned');
  }
  return candidate;
}

/**
 * Creates a new project member by independently copying the template's system
 * and role prompts. Rejects duplicate names and reserved manager names without
 * mutating the template or existing members.
 */
export function createMemberFromTemplate(input: {
  readonly existingMembers: readonly ProjectMemberRecord[];
  readonly template: MemberRoleTemplate;
  readonly name?: string;
  readonly memberId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reservedNames?: ReadonlySet<string>;
  readonly existingMemberIds?: ReadonlySet<string>;
}): ProjectMemberRecord {
  const role = (input.template.role ?? 'executor') as unknown;
  if (!isAllowedWorkerRole(role)) {
    if (role === 'manager') {
      throw new MemberRosterError('member.manager-immutable', 'only Jenny may hold the manager role');
    }
    throw new MemberRosterError('member.invalid-role', `unsupported worker role: ${String(role)}`);
  }
  const projectUsedNames = new Set(input.existingMembers.map((member) => member.name));
  const poolUsedNames = new Set<string>([
    ...projectUsedNames,
    ...(input.reservedNames ?? []),
  ]);
  const rawName = input.name?.trim();
  if (input.name !== undefined && !rawName) {
    throw new MemberRosterError('member.invalid-name', 'member name cannot be blank');
  }
  const chosenName = rawName || allocateWorkerName(poolUsedNames);
  if (RESERVED_ADDRESSING_NAME_SET.has(chosenName)) {
    throw new MemberRosterError(
      'member.reserved-name',
      chosenName === RESERVED_MANAGER_NAME
        ? `${RESERVED_MANAGER_NAME} is reserved for the project manager`
        : `${chosenName} is a reserved canonical addressing identity`,
    );
  }
  if (chosenName.includes('.') || chosenName.includes('/')) {
    throw new MemberRosterError('member.invalid-name', `member name cannot contain '.' or '/': ${chosenName}`);
  }
  if (poolUsedNames.has(chosenName)) {
    throw new MemberRosterError('member.duplicate-name', `member name already exists: ${chosenName}`);
  }
  const memberId = input.memberId.trim();
  if (!memberId) {
    throw new MemberRosterError('member.invalid-id', 'memberId is required');
  }
  if (
    input.existingMembers.some((member) => member.memberId === memberId)
    || input.existingMemberIds?.has(memberId)
  ) {
    throw new MemberRosterError('member.duplicate-id', `memberId already exists: ${memberId}`);
  }
  return {
    memberId,
    name: chosenName,
    role,
    systemPrompt: `${input.template.systemPrompt}`,
    rolePrompt: `${input.template.rolePrompt}`,
    ...(input.provider ?? input.template.provider ? { provider: input.provider ?? input.template.provider } : {}),
    ...(input.model ?? input.template.model ? { model: input.model ?? input.template.model } : {}),
  };
}

export function updateMemberRecord(input: {
  readonly existingMembers: readonly ProjectMemberRecord[];
  readonly memberId: string;
  readonly patch: {
    readonly role?: ProjectMemberRole;
    readonly systemPrompt?: string;
    readonly rolePrompt?: string;
    readonly provider?: string;
    readonly model?: string;
  };
}): { readonly members: ProjectMemberRecord[]; readonly updated: ProjectMemberRecord } {
  const index = input.existingMembers.findIndex((member) => member.memberId === input.memberId);
  if (index === -1) {
    throw new MemberRosterError('member.not-found', `member not found: ${input.memberId}`);
  }
  const current = input.existingMembers[index]!;
  if (current.role === 'manager' && input.patch.role !== undefined && input.patch.role !== 'manager') {
    throw new MemberRosterError('member.manager-immutable', 'project manager Jenny role cannot be changed');
  }
  if (current.role !== 'manager' && input.patch.role !== undefined && !isAllowedWorkerRole(input.patch.role)) {
    if (input.patch.role === 'manager') {
      throw new MemberRosterError('member.manager-immutable', 'only Jenny may hold the manager role');
    }
    throw new MemberRosterError('member.invalid-role', `unsupported worker role: ${String(input.patch.role)}`);
  }
  if (input.patch.systemPrompt !== undefined && !input.patch.systemPrompt.trim()) {
    throw new MemberRosterError('member.invalid-prompt', 'systemPrompt cannot be empty');
  }
  if (input.patch.rolePrompt !== undefined && !input.patch.rolePrompt.trim()) {
    throw new MemberRosterError('member.invalid-prompt', 'rolePrompt cannot be empty');
  }
  const nextProvider = input.patch.provider !== undefined
    ? (input.patch.provider.trim() || undefined)
    : current.provider;
  const nextModel = input.patch.model !== undefined
    ? (input.patch.model.trim() || undefined)
    : current.model;
  const updated: ProjectMemberRecord = {
    memberId: current.memberId,
    name: current.name,
    role: input.patch.role ?? current.role,
    systemPrompt: input.patch.systemPrompt !== undefined ? `${input.patch.systemPrompt}` : current.systemPrompt,
    rolePrompt: input.patch.rolePrompt !== undefined ? `${input.patch.rolePrompt}` : current.rolePrompt,
    ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    ...(nextModel !== undefined ? { model: nextModel } : {}),
  };
  const members = input.existingMembers.map((member, idx) => (idx === index ? updated : { ...member }));
  return { members, updated };
}

export function removeMemberRecord(input: {
  readonly existingMembers: readonly ProjectMemberRecord[];
  readonly memberId: string;
}): { readonly members: ProjectMemberRecord[]; readonly removed: ProjectMemberRecord } {
  const target = input.existingMembers.find((member) => member.memberId === input.memberId);
  if (!target) {
    throw new MemberRosterError('member.not-found', `member not found: ${input.memberId}`);
  }
  if (target.role === 'manager' || target.name === RESERVED_MANAGER_NAME) {
    throw new MemberRosterError('member.manager-immutable', 'project manager Jenny cannot be removed');
  }
  const members = input.existingMembers
    .filter((member) => member.memberId !== input.memberId)
    .map((member) => ({ ...member }));
  return { members, removed: { ...target } };
}
