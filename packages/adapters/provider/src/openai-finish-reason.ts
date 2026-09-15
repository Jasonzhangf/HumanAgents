import type { NextAction, ProviderTerminalState } from '../../../contracts/src/index.js';

export interface OpenAIFinishReasonMapping {
  readonly terminalState: Extract<ProviderTerminalState, 'succeeded' | 'waiting' | 'blocked'>;
  readonly nextAction: NextAction;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

const OWNER = 'humanagent.provider-adapter';

export function mapOpenAIFinishReason(reason: string): OpenAIFinishReasonMapping {
  switch (reason) {
    case 'stop':
      return { terminalState: 'succeeded', nextAction: { kind: 'continue' } };
    case 'tool_calls':
    case 'function_call':
      return { terminalState: 'waiting', nextAction: { kind: 'continue', ref: `openai-finish-${reason}` } };
    case 'length':
      return { terminalState: 'waiting', nextAction: { kind: 'wait', ref: 'openai-max-tokens' } };
    case 'content_filter':
      return {
        terminalState: 'blocked',
        nextAction: { kind: 'recover', ref: OWNER },
        errorCode: 'openai.finish_reason.content_filter',
        errorMessage: 'OpenAI chat completion was stopped by a content filter',
      };
    default:
      return {
        terminalState: 'blocked',
        nextAction: { kind: 'recover', ref: OWNER },
        errorCode: 'openai.finish_reason.unsupported',
        errorMessage: `unsupported OpenAI chat finish_reason: ${reason}`,
      };
  }
}
