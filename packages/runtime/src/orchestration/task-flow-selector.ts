import type { EvidenceRef } from '../../../contracts/src/index.js';
import type { AssignmentStatus } from './types.js';

/**
 * The refined, bounded result of one accepted child call. It carries only the
 * summary and the references the next selection may inspect. Child transcripts and
 * produced artifact bodies are deliberately excluded.
 */
export interface TaskFlowRefinedResult {
  readonly role: string;
  readonly assignmentId: string;
  readonly attempt: number;
  readonly status: AssignmentStatus;
  readonly summary: string;
  readonly outputRefs: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
}
