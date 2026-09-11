import type { LifecycleState } from '../../contracts/src/index.js';
import { LifecycleError } from './errors.js';

export type OrganRuntimeState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export const TERMINAL_LIFECYCLE_STATES: readonly LifecycleState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'stopped',
];

const WORK_TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  created: ['admitted', 'cancelled', 'failed'],
  admitted: ['running', 'settling', 'waiting', 'blocked', 'cancelled', 'failed', 'unknown'],
  running: ['settling'],
  settling: ['succeeded', 'waiting', 'blocked', 'failed', 'cancelled', 'stopped', 'unknown'],
  waiting: ['admitted', 'running', 'settling', 'blocked', 'cancelled', 'failed', 'stopped'],
  blocked: ['admitted', 'waiting', 'settling', 'failed', 'cancelled', 'stopped'],
  succeeded: [],
  failed: [],
  cancelled: [],
  stopped: [],
  unknown: ['admitted', 'waiting', 'blocked', 'failed', 'cancelled', 'stopped'],
  stale: [],
};

const ORGAN_TRANSITIONS: Readonly<Record<OrganRuntimeState, readonly OrganRuntimeState[]>> = {
  starting: ['ready', 'failed'],
  ready: ['stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: [],
  failed: [],
};

export function isTerminalLifecycleState(state: LifecycleState): boolean {
  return TERMINAL_LIFECYCLE_STATES.includes(state);
}

export function canTransitionLifecycle(from: LifecycleState, to: LifecycleState): boolean {
  return WORK_TRANSITIONS[from].includes(to);
}

export function assertTransitionLifecycle(from: LifecycleState, to: LifecycleState): void {
  if (!canTransitionLifecycle(from, to)) {
    throw new LifecycleError(`illegal lifecycle transition: ${from} -> ${to}`);
  }
}

export function transitionLifecycle(from: LifecycleState, to: LifecycleState): LifecycleState {
  assertTransitionLifecycle(from, to);
  return to;
}

export function canTransitionOrgan(from: OrganRuntimeState, to: OrganRuntimeState): boolean {
  return ORGAN_TRANSITIONS[from].includes(to);
}

export function assertTransitionOrgan(from: OrganRuntimeState, to: OrganRuntimeState): void {
  if (!canTransitionOrgan(from, to)) {
    throw new LifecycleError(`illegal organ transition: ${from} -> ${to}`);
  }
}
