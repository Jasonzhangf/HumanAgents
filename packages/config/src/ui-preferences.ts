/**
 * UI display-preference contract.
 *
 * This module owns the user's display/reading preference and its priority.
 * It stores only versioned display fields. It never carries task, organ,
 * checkpoint, session, journal or runtime-lock state.
 *
 * The module is pure: it validates and resolves values but never reads or
 * writes files. Persistence stays with the config loader, which owns
 * `~/.humanagent` paths and TOML parsing.
 */

export const UI_DISPLAY_MODES = ['current', 'semantic', 'actions', 'raw'] as const;
export type UiDisplayMode = (typeof UI_DISPLAY_MODES)[number];

/** Persisted mode that tracks the last direct manual selection. */
export const UI_DISPLAY_FOLLOW_LAST = 'follow-last' as const;
export type UiDisplayPreferenceMode = UiDisplayMode | typeof UI_DISPLAY_FOLLOW_LAST;

export const UI_DISPLAY_PREFERENCE_SCHEMA_VERSION = 1;

export interface UiDisplayPreference {
  readonly schemaVersion: number;
  readonly mode: UiDisplayPreferenceMode;
  readonly lastManual: UiDisplayMode | null;
}

export const DEFAULT_UI_DISPLAY_PREFERENCE: UiDisplayPreference = {
  schemaVersion: UI_DISPLAY_PREFERENCE_SCHEMA_VERSION,
  mode: 'current',
  lastManual: null,
};

export class UiPreferenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UiPreferenceError';
    this.code = code;
  }
}

export function isUiDisplayMode(value: unknown): value is UiDisplayMode {
  return typeof value === 'string' && (UI_DISPLAY_MODES as readonly string[]).includes(value);
}

function isUiDisplayPreferenceMode(value: unknown): value is UiDisplayPreferenceMode {
  return value === UI_DISPLAY_FOLLOW_LAST || isUiDisplayMode(value);
}

/**
 * Validate a persisted display preference. Unknown keys, an unsupported
 * schema version and an unknown display mode are all rejected so a corrupt or
 * drifted value fails visibly instead of silently selecting another view.
 */
export function validateUiDisplayPreference(value: unknown): UiDisplayPreference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UiPreferenceError('ui-preference-invalid', 'ui.display must be a table');
  }
  const table = value as Record<string, unknown>;
  const unknownKey = Object.keys(table).find((key) => !['schemaVersion', 'mode', 'lastManual'].includes(key));
  if (unknownKey !== undefined) {
    throw new UiPreferenceError('ui-preference-invalid', `ui.display contains unsupported key: ${unknownKey}`);
  }
  if (table.schemaVersion !== UI_DISPLAY_PREFERENCE_SCHEMA_VERSION) {
    throw new UiPreferenceError('ui-preference-version', `unsupported ui.display schema: ${String(table.schemaVersion)}`);
  }
  if (!isUiDisplayPreferenceMode(table.mode)) {
    throw new UiPreferenceError('ui-preference-invalid', `ui.display.mode is not a supported display mode: ${String(table.mode)}`);
  }
  const lastManual = table.lastManual === undefined ? null : table.lastManual;
  if (lastManual !== null && !isUiDisplayMode(lastManual)) {
    throw new UiPreferenceError('ui-preference-invalid', `ui.display.lastManual is not a supported display mode: ${String(lastManual)}`);
  }
  return { schemaVersion: UI_DISPLAY_PREFERENCE_SCHEMA_VERSION, mode: table.mode, lastManual };
}

/**
 * Resolve the effective display mode.
 *
 * Priority is explicit link selection, then the saved preference, then the
 * cold-start `current` default. A `follow-last` preference resolves to the
 * last successful manual selection, or `current` when none is recorded.
 */
export function resolveUiDisplayMode(preference: UiDisplayPreference, explicitMode?: UiDisplayMode): UiDisplayMode {
  if (explicitMode !== undefined) {
    if (!isUiDisplayMode(explicitMode)) {
      throw new UiPreferenceError('ui-preference-invalid', `explicit display mode is not supported: ${String(explicitMode)}`);
    }
    return explicitMode;
  }
  if (preference.mode === UI_DISPLAY_FOLLOW_LAST) return preference.lastManual ?? 'current';
  return preference.mode;
}

/**
 * Apply a direct manual selection.
 *
 * Only a `follow-last` preference records the last manual selection; a fixed
 * preference is returned unchanged. An unsupported selection is rejected with
 * a visible error, so a failed selection never overwrites a valid preference.
 */
export function applyManualDisplaySelection(preference: UiDisplayPreference, selected: UiDisplayMode): UiDisplayPreference {
  if (!isUiDisplayMode(selected)) {
    throw new UiPreferenceError('ui-preference-invalid', `manual display selection is not supported: ${String(selected)}`);
  }
  if (preference.mode !== UI_DISPLAY_FOLLOW_LAST) return preference;
  return { ...preference, lastManual: selected };
}
