export class AddressingError extends Error {
  readonly code:
    | 'addressing.invalid'
    | 'addressing.missing'
    | 'addressing.ambiguous'
    | 'addressing.duplicate-ceo'
    | 'addressing.cross-project-forbidden'
    | 'addressing.remote-disconnected';

  constructor(code: AddressingError['code'], message: string) {
    super(message);
    this.name = 'AddressingError';
    this.code = code;
  }
}

export interface CanonicalAddressEntry {
  readonly canonicalAddress: string;
  readonly machine: string;
  readonly project?: string;
  readonly name: string;
  readonly role: 'ceo' | 'manager' | 'architect' | 'reviewer' | 'tester' | 'specialist' | 'executor';
  readonly connected?: boolean;
}

export function formatCanonicalAgentAddress(input: {
  readonly machine: string;
  readonly project?: string;
  readonly name: string;
}): string {
  const machine = input.machine.trim();
  const name = input.name.trim();
  if (!machine || !name) {
    throw new AddressingError('addressing.invalid', 'machine and name are required for canonical address');
  }
  if (name === 'CEO') {
    return `${machine}.CEO`;
  }
  const project = input.project?.trim();
  if (!project) {
    throw new AddressingError('addressing.invalid', 'project is required for non-CEO canonical address');
  }
  return `${machine}.${project}.${name}`;
}

export function resolveAgentAddress(input: {
  readonly token: string;
  readonly currentMachine: string;
  readonly currentProject?: string;
  readonly entries: readonly CanonicalAddressEntry[];
  readonly connectedMachines?: ReadonlySet<string>;
}): CanonicalAddressEntry {
  const token = input.token.trim();
  if (!token) {
    throw new AddressingError('addressing.invalid', 'address token cannot be empty');
  }

  const ceoEntries = input.entries.filter((entry) => entry.role === 'ceo' || entry.name === 'CEO');
  if (ceoEntries.length > 1) {
    throw new AddressingError('addressing.duplicate-ceo', 'multiple CEO entries are forbidden in the control domain');
  }

  // Exact canonical CEO: machine.CEO or alias Alex / CEO
  if (token === 'Alex' || token === 'CEO' || token === `${input.currentMachine}.CEO`) {
    const ceo = ceoEntries.find((entry) => entry.machine === input.currentMachine) ?? ceoEntries[0];
    if (!ceo) {
      throw new AddressingError('addressing.missing', `CEO address is not registered on ${input.currentMachine}`);
    }
    if (ceo.machine !== input.currentMachine && input.connectedMachines && !input.connectedMachines.has(ceo.machine)) {
      throw new AddressingError('addressing.remote-disconnected', `remote machine ${ceo.machine} is disconnected`);
    }
    return ceo;
  }

  const parts = token.split('.');
  // machine.CEO (remote)
  if (parts.length === 2 && parts[1] === 'CEO') {
    const targetMachine = parts[0]!;
    if (targetMachine !== input.currentMachine && input.connectedMachines && !input.connectedMachines.has(targetMachine)) {
      throw new AddressingError('addressing.remote-disconnected', `remote machine ${targetMachine} is disconnected`);
    }
    const ceo = ceoEntries.find((entry) => entry.machine === targetMachine);
    if (!ceo) {
      throw new AddressingError('addressing.missing', `remote CEO ${token} is not found`);
    }
    return ceo;
  }

  // Exact canonical machine.project.name
  if (parts.length === 3) {
    const [machine, project, name] = parts as [string, string, string];
    if (machine !== input.currentMachine && input.connectedMachines && !input.connectedMachines.has(machine)) {
      throw new AddressingError(
        'addressing.remote-disconnected',
        `remote machine ${machine} is disconnected; local fallback to ${name} is forbidden`,
      );
    }
    const exact = input.entries.find(
      (entry) => entry.canonicalAddress === token || (entry.machine === machine && entry.project === project && entry.name === name),
    );
    if (!exact) {
      throw new AddressingError('addressing.missing', `canonical address ${token} is not found`);
    }
    return exact;
  }

  // Two-part token: either remote machine.project (-> Jenny) or local project.member
  if (parts.length === 2) {
    const [first, second] = parts as [string, string];
    const remoteManager = input.entries.find(
      (entry) => entry.machine === first && entry.project === second && entry.name === 'Jenny',
    );
    const localMember = input.entries.find(
      (entry) => entry.machine === input.currentMachine && entry.project === first && entry.name === second,
    );
    if (remoteManager && localMember) {
      throw new AddressingError('addressing.ambiguous', `address ${token} is ambiguous between remote project and local member`);
    }
    if (remoteManager) {
      if (first !== input.currentMachine && input.connectedMachines && !input.connectedMachines.has(first)) {
        throw new AddressingError(
          'addressing.remote-disconnected',
          `remote machine ${first} is disconnected; local fallback is forbidden`,
        );
      }
      return remoteManager;
    }
    if (localMember) {
      return localMember;
    }
    // Check if first is a known disconnected remote machine
    if (first !== input.currentMachine && input.connectedMachines && !input.connectedMachines.has(first)) {
      const knownRemote = input.entries.some((entry) => entry.machine === first);
      if (knownRemote) {
        throw new AddressingError('addressing.remote-disconnected', `remote machine ${first} is disconnected`);
      }
    }
    throw new AddressingError('addressing.missing', `address ${token} does not resolve to any registered member`);
  }

  // Single-part token: project name -> project's Jenny, or member short alias within currentProject only
  if (parts.length === 1) {
    const projectJenny = input.entries.find(
      (entry) => entry.machine === input.currentMachine && entry.project === token && entry.name === 'Jenny',
    );
    const currentProjectMember = input.currentProject
      ? input.entries.find(
          (entry) => entry.machine === input.currentMachine && entry.project === input.currentProject && entry.name === token,
        )
      : undefined;
    if (projectJenny && currentProjectMember) {
      throw new AddressingError('addressing.ambiguous', `address ${token} is ambiguous between project Jenny and local member`);
    }
    if (projectJenny) return projectJenny;
    if (currentProjectMember) return currentProjectMember;

    // Never misdeliver across projects when missing in currentProject
    const otherProjectMatches = input.entries.filter(
      (entry) => entry.machine === input.currentMachine && entry.name === token && entry.project !== input.currentProject,
    );
    if (otherProjectMatches.length > 0) {
      throw new AddressingError(
        'addressing.cross-project-forbidden',
        `member ${token} does not exist in current project; cross-project misdelivery is forbidden`,
      );
    }
    throw new AddressingError('addressing.missing', `address ${token} does not resolve in current scope`);
  }

  throw new AddressingError('addressing.invalid', `malformed address token: ${token}`);
}

/**
 * Dispatches work by role within the current project's real roster, falling
 * back to the project's single Jenny manager when no role matches. Explicit
 * target tokens must resolve strictly and never silently reroute.
 */
export function dispatchByRole(input: {
  readonly currentMachine: string;
  readonly currentProject: string;
  readonly entries: readonly CanonicalAddressEntry[];
  readonly role?: CanonicalAddressEntry['role'];
  readonly explicitTarget?: string;
  readonly connectedMachines?: ReadonlySet<string>;
}): { readonly target: CanonicalAddressEntry; readonly reason: 'explicit' | 'role-match' | 'jenny-fallback' } {
  if (input.explicitTarget !== undefined) {
    const target = resolveAgentAddress({
      token: input.explicitTarget,
      currentMachine: input.currentMachine,
      currentProject: input.currentProject,
      entries: input.entries,
      ...(input.connectedMachines ? { connectedMachines: input.connectedMachines } : {}),
    });
    return { target, reason: 'explicit' };
  }

  const projectRoster = input.entries.filter(
    (entry) => entry.machine === input.currentMachine && entry.project === input.currentProject,
  );
  if (input.role) {
    const matched = projectRoster.find((entry) => entry.role === input.role);
    if (matched) {
      return { target: matched, reason: 'role-match' };
    }
  }
  const jenny = projectRoster.find((entry) => entry.name === 'Jenny' && entry.role === 'manager');
  if (!jenny) {
    throw new AddressingError('addressing.missing', `project ${input.currentProject} has no Jenny manager for fallback dispatch`);
  }
  return { target: jenny, reason: 'jenny-fallback' };
}
