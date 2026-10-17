import {
  DEFAULT_UI_DISPLAY_PREFERENCE,
  UI_DISPLAY_FOLLOW_LAST,
  applyManualDisplaySelection,
  isUiDisplayMode,
  loadConfiguration,
  resolveUiDisplayMode,
  saveUiDisplayPreference,
  type RuntimePaths,
  type UiDisplayPreference,
} from '../../../config/src/index.js';
import type {
  UiDisplayPreferenceResource,
  UiDisplayPreferenceUpdate,
} from '../../../ui/contracts/display-preferences.js';
import { UiRuntimeApiError } from './errors.js';

const APP_OWNER = 'humanagent.app';
export const UI_DISPLAY_PREFERENCE_ROUTE = '/api/ui/display-preference';
export type UiDisplayPreferenceMethod = 'GET' | 'PUT' | 'DELETE';
export interface UiDisplayPreferenceReadPort {
  (paths: RuntimePaths): Promise<UiDisplayPreference>;
}
export interface UiDisplayPreferenceSavePort {
  (paths: RuntimePaths, preference: UiDisplayPreference): Promise<UiDisplayPreference>;
}
export interface UiDisplayPreferenceResetPort {
  (paths: RuntimePaths): Promise<UiDisplayPreference>;
}
export interface UiDisplayPreferencePorts {
  readonly read: UiDisplayPreferenceReadPort;
  readonly save: UiDisplayPreferenceSavePort;
  readonly reset: UiDisplayPreferenceResetPort;
}
export interface UiDisplayPreferenceResourceHandler {
  handle(method: UiDisplayPreferenceMethod, body?: unknown): Promise<UiDisplayPreferenceResource>;
}

function invalidRequest(code: string, message: string, nextAction: string): UiRuntimeApiError {
  return new UiRuntimeApiError(code, APP_OWNER, message, nextAction, 400);
}
function wrapPortFailure(error: unknown, code: string, nextAction: string): UiRuntimeApiError {
  if (error instanceof UiRuntimeApiError) return error;
  return new UiRuntimeApiError(code, APP_OWNER,
    error instanceof Error ? error.message : String(error), nextAction, 500, undefined, error);
}
function parseUiDisplayPreferenceUpdate(body: unknown): UiDisplayPreferenceUpdate {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('display-preference.invalid-request',
      'display preference update body must be a JSON object',
      'send {"kind":"set-default"|"manual-selection","mode":"..."}');
  }
  const record = body as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'set-default' && kind !== 'manual-selection') {
    throw invalidRequest('display-preference.unsupported-kind',
      `unsupported display preference update kind: ${String(kind)}`,
      'send kind "set-default" or "manual-selection"');
  }
  for (const key of Object.keys(record)) {
    if (key !== 'kind' && key !== 'mode') {
      throw invalidRequest('display-preference.invalid-request',
        `display preference update has unsupported field: ${key}`, 'send only kind and mode');
    }
  }
  const mode = record.mode;
  if (kind === 'set-default') {
    if (mode !== UI_DISPLAY_FOLLOW_LAST && !isUiDisplayMode(mode)) {
      throw invalidRequest('display-preference.invalid-mode',
        `unsupported display default mode: ${String(mode)}`,
        'send current, semantic, actions, raw or follow-last');
    }
    return { kind: 'set-default', mode };
  }
  if (!isUiDisplayMode(mode)) {
    throw invalidRequest('display-preference.invalid-mode',
      `unsupported manual display mode: ${String(mode)}`, 'send current, semantic, actions or raw');
  }
  return { kind: 'manual-selection', mode };
}

class DisplayPreferenceResource implements UiDisplayPreferenceResourceHandler {
  private sequence: Promise<unknown> = Promise.resolve();
  constructor(private readonly paths: RuntimePaths, private readonly ports: UiDisplayPreferencePorts) {}
  handle(method: UiDisplayPreferenceMethod, body?: unknown): Promise<UiDisplayPreferenceResource> {
    switch (method) {
      case 'GET': return this.read();
      case 'PUT': return this.enqueue(() => this.update(body));
      case 'DELETE': return this.enqueue(() => this.reset());
    }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(operation, operation);
    this.sequence = result.then(() => undefined, () => undefined);
    return result;
  }
  private async read(): Promise<UiDisplayPreferenceResource> {
    const preference = await this.readPreference();
    return { preference, defaultMode: resolveUiDisplayMode(preference) };
  }
  private async reset(): Promise<UiDisplayPreferenceResource> {
    let preference: UiDisplayPreference;
    try { preference = await this.ports.reset(this.paths); }
    catch (error) {
      throw wrapPortFailure(error, 'display-preference.reset-failed', 'check the configuration path and retry the reset');
    }
    return { preference, defaultMode: resolveUiDisplayMode(preference) };
  }
  private async update(body: unknown): Promise<UiDisplayPreferenceResource> {
    const update = parseUiDisplayPreferenceUpdate(body);
    const current = await this.readPreference();
    if (update.kind === 'set-default') {
      const saved = await this.savePreference({ ...current, mode: update.mode });
      return { preference: saved, defaultMode: resolveUiDisplayMode(saved) };
    }
    const candidate = applyManualDisplaySelection(current, update.mode);
    if (candidate.mode === current.mode && candidate.lastManual === current.lastManual) {
      return { preference: current, defaultMode: resolveUiDisplayMode(current) };
    }
    const saved = await this.savePreference(candidate);
    return { preference: saved, defaultMode: resolveUiDisplayMode(saved) };
  }
  private async readPreference(): Promise<UiDisplayPreference> {
    try { return await this.ports.read(this.paths); }
    catch (error) {
      throw wrapPortFailure(error, 'display-preference.read-failed', 'check the configuration path and retry the read');
    }
  }
  private async savePreference(preference: UiDisplayPreference): Promise<UiDisplayPreference> {
    try { return await this.ports.save(this.paths, preference); }
    catch (error) {
      throw wrapPortFailure(error, 'display-preference.save-failed', 'retry the save after checking the configuration path');
    }
  }
}
export function createUiDisplayPreferenceResource(
  paths: RuntimePaths, ports: UiDisplayPreferencePorts,
): UiDisplayPreferenceResourceHandler {
  return new DisplayPreferenceResource(paths, ports);
}
async function readConfigUiDisplayPreference(paths: RuntimePaths): Promise<UiDisplayPreference> {
  const loaded = await loadConfiguration(paths);
  return loaded.effective.ui?.display ?? DEFAULT_UI_DISPLAY_PREFERENCE;
}
export function bindUiDisplayPreferenceResource(
  paths: RuntimePaths, reset: UiDisplayPreferenceResetPort,
): UiDisplayPreferenceResourceHandler {
  return createUiDisplayPreferenceResource(paths, {
    read: readConfigUiDisplayPreference, save: saveUiDisplayPreference, reset,
  });
}
