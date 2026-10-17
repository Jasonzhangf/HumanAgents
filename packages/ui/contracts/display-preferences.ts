/**
 * Public display-preference DTO for the HumanAgent UI resource.
 *
 * This module freezes the isolated HTTP/JSON shape of the single
 * `/api/ui/display-preference` resource. The value types are reused through
 * type-only imports from the Config preference contract, so the browser and
 * the resource share one schema instead of a second copy. The import is erased
 * at emit, so this module never pulls in the Config Node entry point.
 *
 * The DTO carries only display preference and resolved default mode. It never
 * carries paths, task identities, journal state or an arbitrary Config object.
 */
import type {
  UiDisplayMode,
  UiDisplayPreference,
  UiDisplayPreferenceMode,
} from '../../config/src/ui-preferences.js';

/**
 * Strict PUT body union for the resource.
 *
 * `set-default` stores a fixed or `follow-last` default and preserves the last
 * manual selection. `manual-selection` records a successful direct manual
 * selection; it accepts only a concrete display mode, never `follow-last`.
 */
export type UiDisplayPreferenceUpdate =
  | {
      readonly kind: 'set-default';
      readonly mode: UiDisplayPreferenceMode;
    }
  | {
      readonly kind: 'manual-selection';
      readonly mode: UiDisplayMode;
    };

/**
 * Response body of `GET`, `PUT` and `DELETE`.
 *
 * `preference` is the stored value after the operation. `defaultMode` is the
 * effective mode the browser should use when no explicit display link is
 * present, computed with Config's `resolveUiDisplayMode` so follow-last
 * resolution is not duplicated in the browser.
 */
export interface UiDisplayPreferenceResource {
  readonly preference: UiDisplayPreference;
  readonly defaultMode: UiDisplayMode;
}
