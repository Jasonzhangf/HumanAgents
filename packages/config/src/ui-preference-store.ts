/**
 * Minimal user-level writer for the UI display preference.
 *
 * It updates only the `[ui.display]` table of the control-root `config.toml`.
 * Every other byte of the file is preserved, so unrelated configuration is not
 * rebuilt or dropped. The full candidate configuration is parsed and validated
 * before the file is replaced, and the replacement is atomic, so a failed save
 * keeps the previous valid file and its value.
 *
 * This module owns preference I/O only. The value contract stays in
 * `ui-preferences.ts` and the loader stays in `index.ts`.
 */
import { chmod, open as openFile, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureControlLayout, parseToml, validateUserConfig, type RuntimePaths } from './index.js';
import { DEFAULT_UI_DISPLAY_PREFERENCE, validateUiDisplayPreference, type UiDisplayPreference } from './ui-preferences.js';

const UI_DISPLAY_HEADER = '[ui.display]';

let saveCounter = 0;

/**
 * Strip a trailing `#` comment the same way the config parser does, so a
 * header line such as `[ui.display] # note` is recognised as a table header.
 */
function stripComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === quote) quote = undefined;
    else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (char === '#' && !quote) return line.slice(0, index);
  }
  return line;
}

function isTableHeader(line: string): boolean {
  const stripped = stripComment(line).trim();
  return /^\[[A-Za-z0-9_.-]+\]$/.test(stripped) || /^\[\[[A-Za-z0-9_-]+\]\]$/.test(stripped);
}

function renderUiDisplayTable(preference: UiDisplayPreference): string {
  const lines = [UI_DISPLAY_HEADER, `schemaVersion = ${preference.schemaVersion}`, `mode = "${preference.mode}"`];
  if (preference.lastManual !== null) lines.push(`lastManual = "${preference.lastManual}"`);
  return lines.join('\n');
}

/**
 * Replace the `[ui.display]` table in `text`, or append it when absent. All
 * other lines are kept exactly as they were.
 */
function withUiDisplayTable(text: string, preference: UiDisplayPreference): string {
  const section = renderUiDisplayTable(preference);
  const lines = text.split('\n');
  const start = lines.findIndex((line) => stripComment(line).trim() === UI_DISPLAY_HEADER);
  if (start === -1) {
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
    const base = trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
    return `${base}\n${section}\n`;
  }
  let end = start + 1;
  while (end < lines.length && !isTableHeader(lines[end])) end += 1;
  const body = [...lines.slice(0, start), ...section.split('\n'), ...lines.slice(end)].join('\n');
  return text.endsWith('\n') && !body.endsWith('\n') ? `${body}\n` : body;
}

/**
 * Remove the `[ui.display]` table from `text` and keep every unrelated byte.
 * The table ends at the next TOML table header, so its keys and comments go
 * with it while later sections stay intact.
 */
function withoutUiDisplayTable(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => stripComment(line).trim() === UI_DISPLAY_HEADER);
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && !isTableHeader(lines[end])) end += 1;
  const body = [...lines.slice(0, start), ...lines.slice(end)].join('\n');
  return text.endsWith('\n') && !body.endsWith('\n') ? `${body}\n` : body;
}

async function replaceFileAtomically(filePath: string, contents: string): Promise<void> {
  let mode: number | undefined;
  try {
    mode = (await stat(filePath)).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const tempPath = join(dirname(filePath), `.config.toml.save-${Date.now()}-${saveCounter++}-${Math.random().toString(16).slice(2)}.tmp`);
  const handle = await openFile(tempPath, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (mode !== undefined) await chmod(tempPath, mode);
  await rename(tempPath, filePath);
}

/**
 * Persist a display preference to the control-root `config.toml`.
 *
 * The preference is validated, the whole candidate config is validated, and
 * only then is the file replaced atomically. On any failure the previous file
 * and value stay in place and the error is surfaced to the caller. The saved
 * value is returned so the caller only confirms a preference after a
 * successful write.
 */
export async function saveUiDisplayPreference(
  paths: RuntimePaths,
  preference: UiDisplayPreference,
): Promise<UiDisplayPreference> {
  const saved = validateUiDisplayPreference(preference);
  await ensureControlLayout(paths);
  const configPath = join(paths.controlRoot, 'config.toml');
  const current = await readFile(configPath, 'utf8');
  const candidate = withUiDisplayTable(current, saved);
  validateUserConfig(parseToml(candidate));
  await replaceFileAtomically(configPath, candidate);
  return saved;
}

/**
 * Remove the persisted display preference from the control-root `config.toml`.
 *
 * The candidate is validated before the existing atomic replacement runs.
 * An absent table is a successful no-op. On any failure the previous file and
 * preference stay in place and the error is surfaced to the caller.
 */
export async function resetUiDisplayPreference(paths: RuntimePaths): Promise<UiDisplayPreference> {
  await ensureControlLayout(paths);
  const configPath = join(paths.controlRoot, 'config.toml');
  const current = await readFile(configPath, 'utf8');
  const candidate = withoutUiDisplayTable(current);
  validateUserConfig(parseToml(candidate));
  if (candidate !== current) await replaceFileAtomically(configPath, candidate);
  return DEFAULT_UI_DISPLAY_PREFERENCE;
}
