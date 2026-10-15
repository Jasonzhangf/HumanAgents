/**
 * Browser display-preference controller.
 *
 * This module owns the transient reading-mode selection for the shared shell.
 * It is pure ESM with no DOM: it never reads `location`, never renders and never
 * persists on its own. It consumes two injected ports instead:
 *
 *   client  — the `/api/ui/display-preference` boundary:
 *               displayPreference()            -> GET   { preference, defaultMode }
 *               updateDisplayPreference(update) -> PUT   { preference, defaultMode }
 *               resetDisplayPreference()       -> DELETE { preference, defaultMode }
 *             P5 wires these onto the existing `createRuntimeApi` request adapter.
 *
 *   surface — the single render port:
 *               applyMode({ mode, origin }) -> Promise<
 *                 { ok: true,  mode: UiDisplayMode }
 *               | { ok: false, failure: RuntimeTaskErrorProjection }>
 *             The surface resolves success only after the requested content has
 *             been read, scope-checked and rendered. A resolved promise, a
 *             placeholder or a changed label is not success.
 *
 * Priority for the initial view is: a valid explicit `display` link, then the
 * server-resolved saved default, then the cold `current` default. `mode=fake|rcc`
 * is execution/read scope and is never read or written here.
 *
 * Origins distinguish a direct manual selection from automatic navigation
 * (init/link/tour/history/programmatic). They are transient UI events and never
 * enter a stored preference field. Only a successful direct manual transition
 * may persist, and only when the saved preference is `follow-last`.
 */

export const DISPLAY_MODES = Object.freeze(['current', 'semantic', 'actions', 'raw']);

/** Persisted preference modes. `follow-last` is a preference, not a link value. */
export const DISPLAY_PREFERENCE_MODES = Object.freeze([...DISPLAY_MODES, 'follow-last']);

export const DISPLAY_ORIGINS = Object.freeze({
  init: 'init',
  link: 'link',
  manual: 'manual',
  tour: 'tour',
  history: 'history',
  programmatic: 'programmatic',
});

const ORIGIN_VALUES = Object.freeze(Object.values(DISPLAY_ORIGINS));

export function isDisplayMode(value) {
  return typeof value === 'string' && DISPLAY_MODES.includes(value);
}

export function isDisplayPreferenceMode(value) {
  return typeof value === 'string' && DISPLAY_PREFERENCE_MODES.includes(value);
}

/**
 * Classify the raw `display` query value. `follow-last` is not a legal link
 * value: a link selects a concrete reading mode. An unknown value is returned as
 * `invalid` so the caller can show it instead of silently using a default.
 */
export function parseDisplayLink(raw) {
  if (raw === undefined || raw === null || raw === '') return { kind: 'absent' };
  if (isDisplayMode(raw)) return { kind: 'valid', mode: raw };
  return { kind: 'invalid', value: String(raw) };
}

function normalizeFailure(value, fallbackCode = 'display-preference.failed') {
  if (value && typeof value === 'object') {
    return {
      code: typeof value.code === 'string' ? value.code : fallbackCode,
      message: typeof value.message === 'string' ? value.message : String(value.message ?? fallbackCode),
      ownerId: typeof value.ownerId === 'string' ? value.ownerId : 'humanagent.ui',
      nextAction: typeof value.nextAction === 'string' ? value.nextAction : 'retry the display preference request',
    };
  }
  return {
    code: fallbackCode,
    message: String(value ?? fallbackCode),
    ownerId: 'humanagent.ui',
    nextAction: 'retry the display preference request',
  };
}

function readRequiredFailure() {
  return {
    code: 'display-preference.read-required',
    message: 'a successful preference read is required before mutation',
    ownerId: 'humanagent.ui',
    nextAction: 'refresh the display preference',
  };
}

export function createDisplayPreferenceController({ client, surface } = {}) {
  if (!client
    || typeof client.displayPreference !== 'function'
    || typeof client.updateDisplayPreference !== 'function'
    || typeof client.resetDisplayPreference !== 'function') {
    throw new Error('display preference controller requires displayPreference/updateDisplayPreference/resetDisplayPreference');
  }
  if (!surface || typeof surface.applyMode !== 'function') {
    throw new Error('display preference controller requires a surface with applyMode');
  }

  const listeners = new Set();
  let disposed = false;
  let token = 0;
  let readError = null;

  const state = {
    mode: null,
    modeOrigin: null,
    preference: null,
    defaultMode: null,
    preferenceRead: 'pending',
    pending: false,
    unsaved: false,
    error: null,
  };

  function snapshot() {
    return Object.freeze({ ...state, disposed });
  }

  function notify() {
    const current = snapshot();
    for (const listener of [...listeners]) listener(current);
  }

  function setError(value, fallbackCode) {
    state.error = value ? normalizeFailure(value, fallbackCode) : null;
  }

  function canMutate() {
    return !disposed && state.preferenceRead === 'ready';
  }

  function disposedReceipt() {
    return {
      ok: false,
      superseded: true,
      failure: normalizeFailure({
        code: 'display-preference.disposed',
        message: 'controller disposed',
        ownerId: 'humanagent.ui',
        nextAction: 'mount a new controller',
      }),
    };
  }

  function applyResource(resource) {
    if (!resource || typeof resource !== 'object' || !resource.preference || typeof resource.preference !== 'object') {
      throw new Error('display preference resource is malformed');
    }
    state.preference = resource.preference;
    state.defaultMode = isDisplayMode(resource.defaultMode) ? resource.defaultMode : 'current';
  }

  async function readPreference() {
    if (disposed) return disposedReceipt();
    try {
      const resource = await client.displayPreference();
      if (disposed) return disposedReceipt();
      applyResource(resource);
      state.preferenceRead = 'ready';
      readError = null;
      state.error = null;
      notify();
      return { ok: true, preference: state.preference, defaultMode: state.defaultMode };
    } catch (error) {
      if (disposed) return disposedReceipt();
      state.preferenceRead = 'error';
      state.preference = null;
      state.defaultMode = 'current';
      readError = normalizeFailure(error, 'display-preference.read-failed');
      state.error = readError;
      notify();
      return { ok: false, failure: state.error };
    }
  }

  async function persistManualSelection(mode, mine) {
    let resource;
    try {
      resource = await client.updateDisplayPreference({ kind: 'manual-selection', mode });
    } catch (error) {
      if (disposed || mine !== token) return { ok: false, superseded: true };
      state.unsaved = true;
      setError(error, 'display-preference.save-failed');
      notify();
      return { ok: false, failure: state.error };
    }
    if (disposed || mine !== token) return { ok: false, superseded: true };
    try {
      applyResource(resource);
    } catch (error) {
      state.unsaved = true;
      setError(error, 'display-preference.save-failed');
      notify();
      return { ok: false, failure: state.error };
    }
    state.unsaved = false;
    notify();
    return { ok: true };
  }

  async function transition(mode, origin) {
    if (disposed) return disposedReceipt();
    if (!isDisplayMode(mode)) {
      setError({
        code: 'display-preference.invalid-mode',
        message: `unsupported display mode: ${String(mode)}`,
        ownerId: 'humanagent.ui',
        nextAction: 'use current|semantic|actions|raw',
      });
      notify();
      return { ok: false, failure: state.error };
    }
    if (!ORIGIN_VALUES.includes(origin)) {
      setError({
        code: 'display-preference.invalid-origin',
        message: `unsupported transition origin: ${String(origin)}`,
        ownerId: 'humanagent.ui',
        nextAction: 'use a declared display origin',
      });
      notify();
      return { ok: false, failure: state.error };
    }

    const mine = ++token;
    state.pending = true;
    notify();

    let result;
    try {
      result = await surface.applyMode({ mode, origin });
    } catch (error) {
      result = { ok: false, failure: error };
    }

    // A newer selection or a dispose makes this completion stale: it may not
    // replace the selected state and it must not trigger a save.
    if (disposed || mine !== token) {
      return {
        ok: false,
        superseded: true,
        failure: normalizeFailure(result?.failure ?? {
          code: 'display-preference.superseded',
          message: 'a newer selection replaced this transition',
          ownerId: 'humanagent.ui',
          nextAction: 'none',
        }),
      };
    }

    if (!result || result.ok !== true || result.mode !== mode) {
      state.pending = false;
      setError(result?.failure ?? {
        code: 'display-preference.render-failed',
        message: 'display transition did not report a rendered view',
        ownerId: 'humanagent.ui',
        nextAction: 'retry the display mode',
      }, 'display-preference.render-failed');
      notify();
      return { ok: false, failure: state.error };
    }

    state.mode = result.mode;
    state.modeOrigin = origin;
    state.pending = false;
    state.error = state.preferenceRead === 'error' ? readError : null;
    state.unsaved = false;
    notify();

    if (origin === DISPLAY_ORIGINS.manual && canMutate() && state.preference?.mode === 'follow-last') {
      await persistManualSelection(mode, mine);
    }
    return { ok: true, mode: result.mode };
  }

  async function initialize({ displayParam } = {}) {
    if (disposed) return disposedReceipt();
    await readPreference();
    if (disposed) return disposedReceipt();

    const link = parseDisplayLink(displayParam);
    if (link.kind === 'invalid') {
      setError({
        code: 'display-preference.invalid-link',
        message: `unsupported display link: ${link.value}`,
        ownerId: 'humanagent.ui',
        nextAction: 'use display=current|semantic|actions|raw',
      });
      notify();
      return { ok: false, invalidLink: true, failure: state.error };
    }
    if (link.kind === 'valid') return transition(link.mode, DISPLAY_ORIGINS.link);
    return transition(isDisplayMode(state.defaultMode) ? state.defaultMode : 'current', DISPLAY_ORIGINS.init);
  }

  function applyMode(mode, { origin = DISPLAY_ORIGINS.programmatic } = {}) {
    return transition(mode, origin);
  }

  function selectMode(mode) {
    return transition(mode, DISPLAY_ORIGINS.manual);
  }

  async function saveDefault(mode) {
    if (disposed) return disposedReceipt();
    if (!isDisplayPreferenceMode(mode)) {
      setError({
        code: 'display-preference.invalid-mode',
        message: `unsupported default mode: ${String(mode)}`,
        ownerId: 'humanagent.ui',
        nextAction: 'use current|semantic|actions|raw|follow-last',
      });
      notify();
      return { ok: false, failure: state.error };
    }
    if (!canMutate()) {
      setError(readRequiredFailure(), 'display-preference.read-required');
      notify();
      return { ok: false, failure: state.error };
    }
    try {
      const resource = await client.updateDisplayPreference({ kind: 'set-default', mode });
      if (disposed) return disposedReceipt();
      applyResource(resource);
      state.unsaved = false;
      state.error = null;
      notify();
      return { ok: true, preference: state.preference, defaultMode: state.defaultMode };
    } catch (error) {
      if (disposed) return disposedReceipt();
      setError(error, 'display-preference.save-failed');
      notify();
      return { ok: false, failure: state.error };
    }
  }

  async function reset() {
    if (disposed) return disposedReceipt();
    if (!canMutate()) {
      setError(readRequiredFailure(), 'display-preference.read-required');
      notify();
      return { ok: false, failure: state.error };
    }
    try {
      const resource = await client.resetDisplayPreference();
      if (disposed) return disposedReceipt();
      applyResource(resource);
      state.unsaved = false;
      state.error = null;
      notify();
      return { ok: true, preference: state.preference, defaultMode: state.defaultMode };
    } catch (error) {
      if (disposed) return disposedReceipt();
      setError(error, 'display-preference.save-failed');
      notify();
      return { ok: false, failure: state.error };
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new Error('display preference listener must be a function');
    if (disposed) return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function getState() {
    return snapshot();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    token += 1;
    listeners.clear();
  }

  return {
    initialize,
    applyMode,
    selectMode,
    saveDefault,
    reset,
    refreshPreference: readPreference,
    subscribe,
    getState,
    dispose,
  };
}
