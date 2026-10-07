// App-owned bounded identity token for one occurrence.
//
// Every occurrence-derived id (task, cycle, operation, checkpoint, evidence) is
// composed into the Organ Journal commit id by `checkpointCommitId`, and the
// journal grammar caps a commit id at 256 characters. An occurrence id embeds
// the whole subscription, requirement and draft identity, so it is unbounded in
// practice. Embedding it verbatim overflows the grammar; truncating it makes two
// sibling occurrences share one identity. A digest keeps every derived id short,
// unique and stable across restarts.
//
// The token is a digest only. A readable head would not help debugging, because
// every occurrence of one subscription shares the same leading
// `subscription:requirement:` text; the distinguishing ordinal is at the end.
// The readable half of each derived id comes from the prefix its caller adds.
import { createHash } from 'node:crypto';

const TOKEN_LENGTH = 20;

/**
 * Bounded, deterministic identity token for the given occurrence value.
 *
 * The result is always 20 lowercase hex characters, so it always satisfies the
 * contract id grammar and leaves room for the caller's prefix inside both the
 * 128-character scoped id grammar and the 256-character journal commit id.
 */
export function occurrenceIdentityToken(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, TOKEN_LENGTH);
}
