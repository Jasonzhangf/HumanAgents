import type { EvidenceRef, ProviderProtocol } from '../../../contracts/src/index.js';
import { DshAdapterError } from './errors.js';

const HEX40 = /^[0-9a-f]{40}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function nonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) throw new DshAdapterError('configuration-invalid', `${label} is required`, 'dsh-adapter');
}

function explicit(value: string, label: string): boolean {
  return value.trim().length > 0 && value !== 'default' && value !== 'implicit' && value !== 'web';
}

const GENERIC_HOME_NAMES = new Set(['HOME', 'PWD', 'TMP', 'TEMP', 'TMPDIR', 'USERPROFILE', 'DEFAULT', 'IMPLICIT', 'UNKNOWN', 'WEB']);

function explicitHomeRef(value: string): boolean {
  const homeRef = value.trim();
  if (!homeRef || homeRef === 'default' || homeRef === 'implicit' || homeRef === 'web' || homeRef === 'unknown') return false;
  if (/^(~|\.|\/|[A-Za-z]:[\\/])/.test(homeRef)) return false;
  if (/[\\/]$/.test(homeRef)) return false;
  const match = /^(env|ref|config):([A-Za-z][A-Za-z0-9._-]*)$/.exec(homeRef);
  if (!match) return false;
  const kind = match[1];
  const name = match[2].toUpperCase();
  if (GENERIC_HOME_NAMES.has(name)) return false;
  if (kind === 'env') return name === 'DSH_HOME' || name.startsWith('HUMANAGENT_') || name.startsWith('DSH_');
  return name.includes('DSH') || name.includes('HUMANAGENT');
}

export interface DshLockDescriptor {
  readonly source: string;
  readonly reference: string;
  readonly commit: string;
  readonly tree: string;
  readonly describe: string;
  readonly versionTag: string;
  readonly recordedAt: string;
}

export function assertDshLockDescriptor(lock: DshLockDescriptor): void {
  nonEmpty(lock.source, 'DSH source');
  nonEmpty(lock.reference, 'DSH reference');
  nonEmpty(lock.commit, 'DSH commit');
  if (!HEX40.test(lock.commit)) throw new DshAdapterError('configuration-invalid', 'DSH commit must be a 40-character hex object id', 'dsh-adapter');
  nonEmpty(lock.tree, 'DSH tree');
  if (!HEX40.test(lock.tree)) throw new DshAdapterError('configuration-invalid', 'DSH tree must be a 40-character hex object id', 'dsh-adapter');
  nonEmpty(lock.describe, 'DSH describe');
  nonEmpty(lock.versionTag, 'DSH version tag');
  const recordedAt = Date.parse(lock.recordedAt);
  if (!Number.isFinite(recordedAt)) throw new DshAdapterError('configuration-invalid', 'DSH recordedAt must be a valid timestamp', 'dsh-adapter');
}

export interface DshPluginLock {
  readonly bundleRef: string;
  readonly digest: string;
  readonly entry: string;
}

export function assertDshPluginLock(plugin: DshPluginLock): void {
  if (!explicit(plugin.bundleRef, 'DSH plugin bundleRef')) throw new DshAdapterError('configuration-invalid', 'DSH plugin bundle reference must be explicit (not default/implicit)', 'dsh-adapter');
  if (!SHA256_DIGEST.test(plugin.digest)) throw new DshAdapterError('configuration-invalid', 'DSH plugin digest must be a sha256:hex digest', 'dsh-adapter');
  if (!explicit(plugin.entry, 'DSH plugin entry')) throw new DshAdapterError('configuration-invalid', 'DSH plugin entry must be explicit (not default/implicit)', 'dsh-adapter');
}

export interface DshProfileDescriptor {
  readonly profileName: string;
  readonly homeRef: string;
  readonly plugin?: DshPluginLock;
  readonly routeRef: string;
  readonly patchRefs?: readonly string[];
}

export function assertDshProfileDescriptor(profile: DshProfileDescriptor): void {
  nonEmpty(profile.profileName, 'DSH profile name');
  if (profile.profileName === 'default' || profile.profileName === 'web') {
    throw new DshAdapterError('configuration-invalid', `DSH profile ${profile.profileName} is reserved; use a dedicated HumanAgent profile`, 'dsh-adapter');
  }
  if (!explicit(profile.profileName, 'DSH profile name')) {
    throw new DshAdapterError('configuration-invalid', `DSH profile name must be explicit: ${profile.profileName}`, 'dsh-adapter');
  }
  nonEmpty(profile.homeRef, 'DSH home reference');
  if (!explicitHomeRef(profile.homeRef)) {
    throw new DshAdapterError('configuration-invalid', 'DSH_HOME must be a dedicated HumanAgent env/ref/config reference, not generic HOME/PWD, default, implicit, unknown, or a path', 'dsh-adapter');
  }
  if (!profile.plugin) throw new DshAdapterError('configuration-invalid', 'DSH profile plugin lock is required', 'dsh-adapter');
  assertDshPluginLock(profile.plugin);
  nonEmpty(profile.routeRef, 'DSH route reference');
  if (!explicit(profile.routeRef, 'DSH route reference')) {
    throw new DshAdapterError('configuration-invalid', `DSH route reference must be explicit: ${profile.routeRef}`, 'dsh-adapter');
  }
  for (const patchRef of profile.patchRefs ?? []) nonEmpty(patchRef, 'DSH patch reference');
}

export interface DshProviderBinding {
  readonly bindingId: string;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly endpointRef: string;
  readonly modelRef: string;
  readonly configDigest: string;
  readonly capabilityDigest: string;
  readonly routeRef: string;
  readonly profileRef: string;
  readonly lockRef: string;
}

export function assertDshProviderBinding(binding: DshProviderBinding): void {
  nonEmpty(binding.bindingId, 'DSH bindingId');
  nonEmpty(binding.providerId, 'DSH providerId');
  if (binding.providerId === 'default' || binding.providerId === 'implicit') {
    throw new DshAdapterError('configuration-invalid', `DSH providerId must be explicit: ${binding.providerId}`, 'dsh-adapter');
  }
  if (binding.protocol !== 'responses' && binding.protocol !== 'anthropic' && binding.protocol !== 'other-explicit') {
    throw new DshAdapterError('configuration-invalid', `DSH protocol must be explicit: ${binding.protocol}`, 'dsh-adapter');
  }
  if (!explicit(binding.endpointRef, 'DSH endpointRef') || !explicit(binding.modelRef, 'DSH modelRef')) {
    throw new DshAdapterError('configuration-invalid', 'DSH endpointRef and modelRef must be explicit (not default/implicit)', 'dsh-adapter');
  }
  if (!SHA256_DIGEST.test(binding.configDigest)) throw new DshAdapterError('configuration-invalid', 'DSH configDigest must be a sha256:hex digest', 'dsh-adapter');
  if (!SHA256_DIGEST.test(binding.capabilityDigest)) throw new DshAdapterError('configuration-invalid', 'DSH capabilityDigest must be a sha256:hex digest', 'dsh-adapter');
  nonEmpty(binding.routeRef, 'DSH routeRef');
  if (!explicit(binding.routeRef, 'DSH routeRef')) {
    throw new DshAdapterError('configuration-invalid', `DSH routeRef must be explicit: ${binding.routeRef}`, 'dsh-adapter');
  }
  nonEmpty(binding.profileRef, 'DSH profileRef');
  nonEmpty(binding.lockRef, 'DSH lockRef');
}

export interface DshExternalSession {
  readonly evidenceRef: EvidenceRef;
}

export function assertDshExternalSession(session: DshExternalSession, runtimeIdValue: string): void {
  const ref = session.evidenceRef;
  if (ref.kind !== 'external') throw new DshAdapterError('configuration-invalid', 'DSH external session must be referenced by an external evidence ref', 'dsh-adapter');
  if (ref.locator === runtimeIdValue || ref.evidenceId.value === runtimeIdValue) {
    throw new DshAdapterError('identity-mismatch', 'DSH session locator must not be reused as runtime identity', 'dsh-adapter');
  }
}
