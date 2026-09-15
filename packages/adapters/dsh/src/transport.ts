import type {
  ProviderBinding,
  ProviderCapabilities,
  ProviderCloseResult,
  ProviderEvent,
  ProviderObserveInput,
  ProviderReadiness,
  ProviderRecoveryResult,
  ProviderResumeInput,
  ProviderSettleInput,
  ProviderSettlement,
  ProviderStartInput,
  ProviderStartReceipt,
  ProviderStopReceipt,
  ProviderStopRequest,
  ProviderSubmitInput,
  ProviderSubmitResult,
} from '../../../contracts/src/index.js';
import type { DshLockDescriptor, DshProfileDescriptor } from './types.js';

export interface DshTransportContext {
  readonly binding: ProviderBinding;
  readonly lock: DshLockDescriptor;
  readonly profile: DshProfileDescriptor;
}

export interface DshTransport {
  probe(context: DshTransportContext): Promise<ProviderReadiness>;
  capabilities(context: DshTransportContext): Promise<ProviderCapabilities>;
  start(input: ProviderStartInput): Promise<ProviderStartReceipt>;
  /** Release a runtime already opened by start when bridge-side receipt validation fails. */
  abortStart?(input: ProviderStartInput): Promise<void>;
  resume(input: ProviderResumeInput): Promise<ProviderRecoveryResult>;
  submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult>;
  observe(input: ProviderObserveInput): AsyncIterable<ProviderEvent>;
  requestStop(input: ProviderStopRequest): Promise<ProviderStopReceipt>;
  settle(input: ProviderSettleInput): Promise<ProviderSettlement>;
  close(context: DshTransportContext): Promise<ProviderCloseResult>;
}
