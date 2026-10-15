#!/usr/bin/env node

/**
 * P3 black-box proof for the browser display-preference controller.
 *
 * The controller is a pure ESM module with no DOM. These tests drive the exact
 * exported factory through two injected ports:
 *
 *   - `client`  mirrors the real `/api/ui/display-preference` boundary
 *               (GET / PUT / DELETE) and returns the frozen resource DTO;
 *   - `surface` is the single `applyMode({mode,origin})` render port and returns
 *               an explicit `{ok:true,mode}` only after the view renders.
 *
 * Every case binds to a concrete failure mode from plan section 6 (controller
 * row). The controller is not a renderer; the surface here is a controllable
 * stand-in, so a resolved promise can never be mistaken for a rendered view.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPLAY_MODES,
  DISPLAY_ORIGINS,
  createDisplayPreferenceController,
  isDisplayMode,
  isDisplayPreferenceMode,
  parseDisplayLink,
} from '../../docs/ui/display-preferences.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function preference(mode, lastManual = null) {
  return { schemaVersion: 1, mode, lastManual };
}

function resource(pref, defaultMode) {
  return { preference: pref, defaultMode };
}

/**
 * A deferred-backed API client. Each handler resolves immediately by default so
 * a test only overrides the call it needs to control. `calls.update` records the
 * exact request body sent to PUT.
 */
function makeClient() {
  const calls = { read: 0, update: [], reset: 0 };
  const handlers = {
    read: () => Promise.resolve(resource(preference('current'), 'current')),
    update: () => Promise.resolve(resource(preference('current'), 'current')),
    reset: () => Promise.resolve(resource(preference('current'), 'current')),
  };
  const client = {
    displayPreference() {
      calls.read += 1;
      return handlers.read();
    },
    updateDisplayPreference(update) {
      calls.update.push(update);
      return handlers.update(update);
    },
    resetDisplayPreference() {
      calls.reset += 1;
      return handlers.reset();
    },
  };
  return {
    client,
    calls,
    setRead(fn) { handlers.read = fn; },
    setUpdate(fn) { handlers.update = fn; },
    setReset(fn) { handlers.reset = fn; },
  };
}

/**
 * A controllable render port. In `auto` mode it resolves success with the
 * requested mode. In deferred mode the test decides when (and whether) the view
 * renders, which is how the write-ordering and stale-completion cases run.
 */
function makeSurface() {
  const calls = [];
  const deferreds = [];
  let auto = true;
  const surface = {
    applyMode(args) {
      calls.push(args);
      if (auto) return Promise.resolve({ ok: true, mode: args.mode });
      const d = deferred();
      deferreds.push(d);
      return d.promise;
    },
  };
  return { surface, calls, deferreds, setAuto(value) { auto = value; } };
}

function controllerFor() {
  const api = makeClient();
  const view = makeSurface();
  const controller = createDisplayPreferenceController({ client: api.client, surface: view.surface });
  return { api, view, controller };
}

test('display link parsing accepts the four reading modes and rejects the rest', () => {
  assert.deepEqual(parseDisplayLink(undefined), { kind: 'absent' });
  assert.deepEqual(parseDisplayLink(''), { kind: 'absent' });
  for (const mode of DISPLAY_MODES) {
    assert.deepEqual(parseDisplayLink(mode), { kind: 'valid', mode });
  }
  assert.deepEqual(parseDisplayLink('fake'), { kind: 'invalid', value: 'fake' });
  assert.deepEqual(parseDisplayLink('follow-last'), { kind: 'invalid', value: 'follow-last' });
  assert.deepEqual(parseDisplayLink('CURRENT'), { kind: 'invalid', value: 'CURRENT' });
});

test('execution mode values are never display modes', () => {
  assert.equal(isDisplayMode('fake'), false);
  assert.equal(isDisplayMode('rcc'), false);
  assert.equal(isDisplayPreferenceMode('follow-last'), true);
  assert.equal(isDisplayPreferenceMode('fake'), false);
});

test('priority: an explicit valid link wins over the server saved default', async () => {
  const { api, view, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('semantic'), 'semantic')));

  const receipt = await controller.initialize({ displayParam: 'raw' });

  assert.equal(receipt.ok, true);
  assert.deepEqual(view.calls, [{ mode: 'raw', origin: DISPLAY_ORIGINS.link }]);
  assert.equal(controller.getState().mode, 'raw');
  assert.equal(api.calls.update.length, 0);
  assert.equal(api.calls.reset, 0);
});

test('priority: without a link the server default wins (follow-last resolved)', async () => {
  const { api, view, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'actions'), 'actions')));

  const receipt = await controller.initialize({});

  assert.equal(receipt.ok, true);
  assert.deepEqual(view.calls, [{ mode: 'actions', origin: DISPLAY_ORIGINS.init }]);
  assert.equal(controller.getState().mode, 'actions');
  assert.equal(api.calls.update.length, 0);
});

test('priority: a preference read failure keeps the usable cold view and disables mutation', async () => {
  const { api, view, controller } = controllerFor();
  api.setRead(() => Promise.reject({
    code: 'ui.preference.read-failed',
    message: 'config unavailable',
    ownerId: 'humanagent.config',
    nextAction: 'retry the read',
  }));

  await controller.initialize({});

  assert.deepEqual(view.calls, [{ mode: 'current', origin: DISPLAY_ORIGINS.init }]);
  assert.equal(controller.getState().mode, 'current');
  assert.equal(controller.getState().preferenceRead, 'error');
  assert.equal(controller.getState().error.code, 'ui.preference.read-failed');

  const save = await controller.saveDefault('semantic');
  assert.equal(save.ok, false);
  assert.equal(api.calls.update.length, 0);
});

test('an invalid explicit link is visible and never silently applies a default', async () => {
  const { api, view, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('semantic'), 'semantic')));

  const receipt = await controller.initialize({ displayParam: 'fake' });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.invalidLink, true);
  assert.equal(view.calls.length, 0, 'no mode is applied for an invalid link');
  assert.equal(controller.getState().mode, null);
  assert.equal(controller.getState().error.code, 'display-preference.invalid-link');
  assert.equal(api.calls.update.length, 0);
});

test('automatic origins never save: init, link, tour, history, programmatic', async () => {
  const cases = [
    ['init', (c) => c.initialize({})],
    ['link', (c) => c.initialize({ displayParam: 'semantic' })],
    ['tour', (c) => c.applyMode('semantic', { origin: DISPLAY_ORIGINS.tour })],
    ['history', (c) => c.applyMode('raw', { origin: DISPLAY_ORIGINS.history })],
    ['programmatic', (c) => c.applyMode('actions', { origin: DISPLAY_ORIGINS.programmatic })],
  ];
  for (const [name, run] of cases) {
    const { api, controller } = controllerFor();
    api.setRead(() => Promise.resolve(resource(preference('follow-last', 'current'), 'current')));
    // A ready preference makes the write gate pass, so only the origin guard can
    // keep an automatic navigation from persisting.
    await controller.refreshPreference();
    assert.equal(controller.getState().preferenceRead, 'ready');
    const receipt = await run(controller);
    assert.equal(receipt.ok, true, `${name} transition should succeed`);
    assert.equal(api.calls.update.length, 0, `${name} must not PUT`);
    assert.equal(api.calls.reset, 0, `${name} must not DELETE`);
  }
});

test('a direct manual selection writes only after the view renders (follow-last)', async () => {
  const { api, view, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'current'), 'current')));
  api.setUpdate(() => Promise.resolve(resource(preference('follow-last', 'semantic'), 'semantic')));

  await controller.initialize({});
  assert.equal(api.calls.update.length, 0);

  view.setAuto(false);
  const pending = controller.selectMode('semantic');
  await flush();

  assert.equal(view.calls[1].origin, DISPLAY_ORIGINS.manual);
  assert.equal(api.calls.update.length, 0, 'no write before the render resolves');

  view.deferreds[0].resolve({ ok: true, mode: 'semantic' });
  const receipt = await pending;

  assert.equal(receipt.ok, true);
  assert.equal(api.calls.update.length, 1);
  assert.deepEqual(api.calls.update[0], { kind: 'manual-selection', mode: 'semantic' });
  assert.equal(controller.getState().mode, 'semantic');
  assert.equal(controller.getState().unsaved, false);
  assert.equal(controller.getState().preference.mode, 'follow-last');
  assert.equal(controller.getState().preference.lastManual, 'semantic');
});

test('a fixed default renders a manual selection without any persistence', async () => {
  const { api, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('semantic'), 'semantic')));

  await controller.initialize({});
  const receipt = await controller.selectMode('raw');

  assert.equal(receipt.ok, true);
  assert.equal(controller.getState().mode, 'raw');
  assert.equal(api.calls.update.length, 0, 'a fixed default never records a manual selection');
});

test('a failed render keeps the prior view and sends no write', async () => {
  const { api, view, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'current'), 'current')));

  await controller.initialize({});
  const before = controller.getState().mode;

  view.setAuto(false);
  const pending = controller.selectMode('semantic');
  await flush();
  view.deferreds[0].resolve({
    ok: false,
    failure: { code: 'display.mode-unavailable', message: 'no renderer', ownerId: 'humanagent.ui', nextAction: 'retry' },
  });
  const receipt = await pending;

  assert.equal(receipt.ok, false);
  assert.equal(controller.getState().mode, before);
  assert.equal(api.calls.update.length, 0);
  assert.equal(controller.getState().error.code, 'display.mode-unavailable');

  // A success-shaped receipt for a different mode is not a successful render of
  // the requested content. It must not advance the view or persist the request.
  const wrongMode = controller.selectMode('actions');
  await flush();
  view.deferreds[1].resolve({ ok: true, mode: 'raw' });
  const wrongModeReceipt = await wrongMode;

  assert.equal(wrongModeReceipt.ok, false);
  assert.equal(controller.getState().mode, before);
  assert.equal(api.calls.update.length, 0);
  assert.equal(controller.getState().error.code, 'display-preference.render-failed');
});

test('a rejected save keeps the new view, the old preference and an unsaved status', async () => {
  const { api, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'current'), 'current')));
  api.setUpdate(() => Promise.reject({
    code: 'ui.preference.save-failed',
    message: 'atomic replace failed',
    ownerId: 'humanagent.config',
    nextAction: 'retry the save',
  }));

  await controller.initialize({});
  const beforePreference = controller.getState().preference;
  const receipt = await controller.selectMode('semantic');

  assert.equal(receipt.ok, true);
  assert.equal(controller.getState().mode, 'semantic');
  assert.deepEqual(controller.getState().preference, beforePreference);
  assert.equal(controller.getState().unsaved, true);
  assert.equal(controller.getState().error.code, 'ui.preference.save-failed');
});

test('a superseded transition cannot replace the newer selection or save', async () => {
  const { api, view, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'current'), 'current')));
  api.setUpdate(() => Promise.resolve(resource(preference('follow-last', 'actions'), 'actions')));

  await controller.initialize({});
  view.setAuto(false);

  const first = controller.selectMode('semantic');
  await flush();
  const second = controller.selectMode('actions');
  await flush();

  view.deferreds[1].resolve({ ok: true, mode: 'actions' });
  await second;
  assert.equal(controller.getState().mode, 'actions');

  view.deferreds[0].resolve({ ok: true, mode: 'semantic' });
  const late = await first;

  assert.equal(late.superseded, true);
  assert.equal(controller.getState().mode, 'actions', 'late result must not replace the selection');
  assert.equal(api.calls.update.length, 1);
  assert.deepEqual(api.calls.update[0], { kind: 'manual-selection', mode: 'actions' });
});

test('a disposed controller ignores a late completion and never saves', async () => {
  const { api, view, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'current'), 'current')));

  await controller.initialize({});
  view.setAuto(false);
  const pending = controller.selectMode('semantic');
  await flush();

  controller.dispose();
  view.deferreds[0].resolve({ ok: true, mode: 'semantic' });
  const receipt = await pending;

  assert.equal(receipt.ok, false);
  assert.equal(receipt.superseded, true);
  assert.equal(api.calls.update.length, 0);
  assert.equal(controller.getState().mode, 'current');
  assert.equal(controller.getState().disposed, true);
});

test('Save sends set-default, preserves lastManual, and leaves the current view alone', async () => {
  const { api, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'raw'), 'raw')));
  api.setUpdate(() => Promise.resolve(resource(preference('semantic', 'raw'), 'semantic')));

  await controller.initialize({});
  const receipt = await controller.saveDefault('semantic');

  assert.equal(receipt.ok, true);
  assert.deepEqual(api.calls.update[0], { kind: 'set-default', mode: 'semantic' });
  assert.deepEqual(controller.getState().preference, { schemaVersion: 1, mode: 'semantic', lastManual: 'raw' });
  assert.equal(controller.getState().mode, 'raw', 'Save does not move the current view');
  assert.equal(api.calls.read, 1, 'Save does not re-read the preference');
});

test('Reset calls DELETE and never erases the explicit or current view', async () => {
  const { api, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'raw'), 'raw')));
  api.setReset(() => Promise.resolve(resource(preference('current'), 'current')));

  await controller.initialize({});
  const receipt = await controller.reset();

  assert.equal(receipt.ok, true);
  assert.equal(api.calls.reset, 1);
  assert.equal(controller.getState().mode, 'raw', 'Reset does not move the runtime current view');
  assert.deepEqual(controller.getState().preference, { schemaVersion: 1, mode: 'current', lastManual: null });
});

test('a read failure blocks dependent mutation until a successful refresh', async () => {
  const { api, controller } = controllerFor();
  api.setRead(() => Promise.reject({
    code: 'ui.preference.read-failed',
    message: 'config unavailable',
    ownerId: 'humanagent.config',
    nextAction: 'retry the read',
  }));

  await controller.initialize({});
  assert.equal(controller.getState().preferenceRead, 'error');

  assert.equal((await controller.saveDefault('semantic')).ok, false);
  assert.equal((await controller.reset()).ok, false);
  assert.equal(api.calls.update.length, 0);
  assert.equal(api.calls.reset, 0);

  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'current'), 'current')));
  assert.equal((await controller.refreshPreference()).ok, true);
  assert.equal(controller.getState().preferenceRead, 'ready');

  assert.equal((await controller.saveDefault('semantic')).ok, true);
  assert.equal(api.calls.update.length, 1);
});

test('the accepted four fixed modes and follow-last share the same consumer', async () => {
  for (const mode of [...DISPLAY_MODES, 'follow-last']) {
    const { api, view, controller } = controllerFor();
    const defaultMode = mode === 'follow-last' ? 'current' : mode;
    api.setRead(() => Promise.resolve(resource(preference(mode), defaultMode)));

    const receipt = await controller.initialize({});

    assert.equal(receipt.ok, true, mode);
    assert.deepEqual(view.calls, [{ mode: defaultMode, origin: DISPLAY_ORIGINS.init }], mode);
    assert.equal(controller.getState().mode, defaultMode, mode);
    assert.equal(api.calls.update.length, 0, mode);
  }
});

test('one subscription per mounted surface; unsubscribe and dispose stop notifications', async () => {
  const { api, controller } = controllerFor();
  api.setRead(() => Promise.resolve(resource(preference('follow-last', 'current'), 'current')));

  const seen = [];
  const unsubscribe = controller.subscribe((snapshot) => seen.push(snapshot.mode));

  await controller.initialize({});
  const afterInit = seen.length;
  assert.ok(afterInit >= 1, 'the applied mode is announced');
  assert.equal(seen.at(-1), 'current');

  unsubscribe();
  await controller.selectMode('semantic');
  assert.equal(seen.length, afterInit, 'an unsubscribed listener receives nothing');

  const late = [];
  controller.subscribe((snapshot) => late.push(snapshot.mode));
  controller.dispose();
  await controller.applyMode('raw', { origin: DISPLAY_ORIGINS.programmatic });
  assert.equal(late.length, 0, 'dispose stops notifications');
});
