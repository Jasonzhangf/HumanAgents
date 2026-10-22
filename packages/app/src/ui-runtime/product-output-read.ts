import type { PublicOutputBinding } from '../../../contracts/src/index.js';
import type {
  PublicOutputCommitProjection,
  PublicOutputPublicationProjection,
} from '../../../ui/contracts/runtime.js';

/**
 * One binding's public result, composed from the exact publication projection
 * returned by the existing authoritative reader.
 *
 * This view does not own a second result source. `publication` is the reader's
 * object and `commits` is its exact array; no commit field is copied or
 * rebuilt. Callers render `commits` only, and draw no block when
 * `resultAvailable` is false.
 */
export interface ProductOutputView {
  /** Existing binding reference; never a copied or reconstructed identity. */
  readonly binding?: PublicOutputBinding;
  /** Exact reader projection, absent when the reader had none for this binding. */
  readonly publication?: PublicOutputPublicationProjection;
  /** Confirmed public commits. The reader's exact array, not a copy. */
  readonly commits: readonly PublicOutputCommitProjection[];
  /** True only when at least one confirmed commit can render. */
  readonly resultAvailable: boolean;
}

/**
 * Selects the unified public result view for one exact binding.
 *
 * `publication` must come from the existing authoritative publication reader
 * (`service.authoritativePublicOutputForTask`). This module does not read the
 * Journal and accepts no `task.output`, provider text or checkpoint fallback,
 * so uncommitted text cannot become a public result.
 *
 * `pending`, `unavailable` and `unknown` keep every confirmed commit already
 * present in `publication`. An absent or empty publication yields an empty
 * view; callers must not draw an empty result block.
 */
export function selectProductOutput(
  publication: PublicOutputPublicationProjection | undefined,
  binding?: PublicOutputBinding,
): ProductOutputView {
  const commits = publication?.commits ?? [];
  return {
    ...(binding === undefined ? {} : { binding }),
    ...(publication === undefined ? {} : { publication }),
    commits,
    resultAvailable: commits.length > 0,
  };
}

/**
 * Joins confirmed public commit text in Journal order. It never invents,
 * trims or reorders text.
 */
export function productResultText(view: ProductOutputView): string {
  return view.commits.map((commit) => commit.text).join('');
}
