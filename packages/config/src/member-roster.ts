export type ProjectMemberRole =
  | 'architect'
  | 'reviewer'
  | 'tester'
  | 'specialist'
  | 'manager'
  | 'executor';

export const RESERVED_MANAGER_NAME = 'Jenny' as const;

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
}): ProjectMemberRecord {
  const usedNames = new Set(input.existingMembers.map((member) => member.name));
  const chosenName = input.name?.trim() || allocateWorkerName(usedNames);
  if (chosenName === RESERVED_MANAGER_NAME) {
    throw new MemberRosterError('member.reserved-name', `${RESERVED_MANAGER_NAME} is reserved for the project manager`);
  }
  if (usedNames.has(chosenName)) {
    throw new MemberRosterError('member.duplicate-name', `member name already exists: ${chosenName}`);
  }
  if (!input.memberId.trim()) {
    throw new MemberRosterError('member.invalid-id', 'memberId is required');
  }
  return {
    memberId: input.memberId,
    name: chosenName,
    role: input.template.role ?? 'executor',
    systemPrompt: `${input.template.systemPrompt}`,
    rolePrompt: `${input.template.rolePrompt}`,
    ...(input.provider ?? input.template.provider ? { provider: input.provider ?? input.template.provider } : {}),
    ...(input.model ?? input.template.model ? { model: input.model ?? input.template.model } : {}),
  };
}
