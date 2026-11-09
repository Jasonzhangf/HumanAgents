import type { EvidenceRef } from '../../../contracts/src/index.js';

/**
 * The Provider committed a terminal output that can never become a decision:
 * invalid JSON or decision-shaped objects with zero valid candidates. The
 * interpreter closes the turn honestly and rethrows this identity, so the
 * public boundary can report the exact failure, its interaction and the
 * preserved raw evidence without inspecting error text.
 */
export class ExplicitBrainTerminalOutputError extends Error {
  readonly interactionId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  /**
   * True only after the turn's durable parse-failure closure has been committed.
   * A failure without this marker must keep its recovery responsibility and must
   * never be advertised as safely resubmittable.
   */
  closed = false;

  constructor(interactionId: string, message: string, cause?: unknown, evidenceRefs: readonly EvidenceRef[] = []) {
    super(message);
    this.name = 'ExplicitBrainTerminalOutputError';
    this.interactionId = interactionId;
    this.evidenceRefs = evidenceRefs;
    if (cause !== undefined) this.cause = cause;
  }

  markClosed(): void {
    this.closed = true;
  }
}
