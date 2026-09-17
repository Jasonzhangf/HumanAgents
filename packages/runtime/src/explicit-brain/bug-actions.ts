import {
  validateBugProposeUpdate,
  validateBugTransition,
  type BugProposeUpdateArguments,
  type BugRecord,
  type BugState,
  type BugTransitionArguments,
} from '../../../contracts/src/index.js';

export class BugActionError extends Error {
  readonly code: 'bug-not-found' | 'revision-conflict' | 'validation-required' | 'transition-denied';

  constructor(code: BugActionError['code'], message: string) {
    super(message);
    this.name = 'BugActionError';
    this.code = code;
  }
}

export interface BugActionPort {
  read(input: { readonly bugId: string }): Promise<BugRecord | null>;
  proposeUpdate(input: BugProposeUpdateArguments): Promise<{
    readonly bugId: string;
    readonly revision: string;
    readonly proposedState: BugState;
    readonly accepted: boolean;
  }>;
  transition(input: {
    readonly bugId: string;
    readonly expectedRevision: string;
    readonly state: 'resolved' | 'reopened';
    readonly resolutionEvidenceRefs: readonly string[];
    readonly validationEvidenceRefs: readonly string[];
    readonly reason: string;
  }): Promise<{ readonly bugId: string; readonly revision: string; readonly state: BugState; readonly transitioned: boolean }>;
}

export class BugActionOwner {
  constructor(private readonly port: BugActionPort) {}

  async query(bugId: string): Promise<BugRecord> {
    if (!bugId.trim()) throw new BugActionError('bug-not-found', 'bug id is required');
    const bug = await this.port.read({ bugId });
    if (!bug) throw new BugActionError('bug-not-found', `bug not found: ${bugId}`);
    return bug;
  }

  async proposeUpdate(input: BugProposeUpdateArguments): Promise<{
    readonly bugId: string;
    readonly revision: string;
    readonly proposedState: BugState;
    readonly accepted: boolean;
  }> {
    validateBugProposeUpdate(input);
    await this.query(input.bugId);
    return this.port.proposeUpdate(input);
  }

  async resolve(input: BugTransitionArguments): Promise<BugRecord> {
    validateBugTransition(input);
    return this.transition(input, 'resolved');
  }

  async reopen(input: BugTransitionArguments): Promise<BugRecord> {
    validateBugTransition(input);
    return this.transition(input, 'reopened');
  }

  private async transition(input: BugTransitionArguments, state: 'resolved' | 'reopened'): Promise<BugRecord> {
    const current = await this.query(input.bugId);
    if (current.gitBugRevision !== input.expectedRevision) {
      throw new BugActionError('revision-conflict', 'bug revision changed before transition');
    }
    const result = await this.port.transition({
      bugId: input.bugId,
      expectedRevision: input.expectedRevision,
      state,
      resolutionEvidenceRefs: [...input.resolutionEvidenceRefs],
      validationEvidenceRefs: [...input.validationEvidenceRefs],
      reason: input.reason,
    });
    if (!result.transitioned || result.state !== state) {
      throw new BugActionError('transition-denied', `bug transition was not applied: ${state}`);
    }
    return {
      ...current,
      state: result.state,
      gitBugRevision: result.revision,
    };
  }
}
