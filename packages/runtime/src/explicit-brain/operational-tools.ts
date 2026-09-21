import type { ToolIntent } from '../../../contracts/src/index.js';
import {
  type ExplicitBrainAdmissionReceipt,
  type ExplicitBrainAgentToolPort,
  type ExplicitBrainOperationalToolPorts,
  type ExplicitBrainRuntimeBinding,
  type ExplicitBrainWorkspaceToolPort,
} from './tool-registry.js';

export type ExplicitBrainOperationalToolResult = unknown;

export class ExplicitBrainOperationalToolError extends Error {
  readonly code: 'unsupported-tool' | 'invalid-admission-receipt';

  constructor(code: ExplicitBrainOperationalToolError['code'], message: string) {
    super(message);
    this.name = 'ExplicitBrainOperationalToolError';
    this.code = code;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'operational tool arguments must be an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringArgument(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', `${key} is required`);
  }
  return value;
}

function positiveIntegerArgument(args: Readonly<Record<string, unknown>>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', `${key} must be a positive safe integer`);
  }
  return value as number;
}

export interface ExplicitBrainOperationalToolExecutorOptions {
  readonly binding: ExplicitBrainRuntimeBinding;
  readonly ports: ExplicitBrainOperationalToolPorts;
}

/**
 * The only execution owner for the explicit brain's workspace and agent tools.
 * Ports own containment, registration, ACL, and the actual side effect/query.
 * Model arguments never supply binding or authorization identity.
 */
export class ExplicitBrainOperationalToolExecutor {
  constructor(private readonly options: ExplicitBrainOperationalToolExecutorOptions) {}

  async execute(
    intent: ToolIntent,
    receipt: ExplicitBrainAdmissionReceipt,
  ): Promise<ExplicitBrainOperationalToolResult> {
    this.assertAdmissionReceipt(intent, receipt);
    const args = record(intent.arguments);
    const { binding, ports } = this.options;
    switch (intent.toolRef) {
      case 'workspace.list': {
        const scopeRef = args.scopeRef === undefined
          ? stringArgument(args, 'pathRef')
          : stringArgument(args, 'scopeRef');
        const pathRef = args.pathRef === undefined ? undefined : stringArgument(args, 'pathRef');
        ports.workspace.authorize({ binding, toolRef: 'workspace.list', scopeRef, ...(pathRef === undefined ? {} : { pathRef }) });
        return ports.workspace.list({
          binding,
          scopeRef,
          ...(pathRef === undefined ? {} : { pathRef }),
        });
      }
      case 'file.read': {
        const scopeRef = stringArgument(args, 'scopeRef');
        const pathRef = stringArgument(args, 'pathRef');
        ports.workspace.authorize({ binding, toolRef: 'file.read', scopeRef, pathRef });
        return ports.workspace.read({ binding, scopeRef, pathRef });
      }
      case 'file.search': {
        const scopeRef = stringArgument(args, 'scopeRef');
        const query = stringArgument(args, 'query');
        const limit = positiveIntegerArgument(args, 'limit');
        ports.workspace.authorize({ binding, toolRef: 'file.search', scopeRef });
        return ports.workspace.search({
          binding,
          scopeRef,
          query,
          limit,
        });
      }
      case 'agent.query': {
        const agentRef = args.agentRef === undefined ? undefined : stringArgument(args, 'agentRef');
        const scopeRef = args.scopeRef === undefined ? undefined : stringArgument(args, 'scopeRef');
        ports.agent.authorizeQuery({ binding, ...(agentRef === undefined ? {} : { agentRef }), ...(scopeRef === undefined ? {} : { scopeRef }) });
        return ports.agent.query({
          binding,
          ...(agentRef === undefined ? {} : { agentRef }),
          ...(scopeRef === undefined ? {} : { scopeRef }),
        });
      }
      case 'agent.message': {
        const recipientRef = stringArgument(args, 'recipientRef');
        const messageRef = stringArgument(args, 'messageRef');
        const messageClass = args.messageClass as 'control' | 'data' | 'observation';
        ports.agent.authorizeMessage({ binding, recipientRef, messageClass });
        return ports.agent.message({
          binding,
          recipientRef,
          messageRef,
          messageClass,
        });
      }
      default:
        throw new ExplicitBrainOperationalToolError(
          'unsupported-tool',
          `operational tool executor does not own tool: ${intent.toolRef}`,
        );
    }
  }

  private assertAdmissionReceipt(intent: ToolIntent, receipt: ExplicitBrainAdmissionReceipt): void {
    if (
      receipt.admitted !== true
      || receipt.toolRef !== intent.toolRef
      || receipt.capabilityRef !== intent.toolRef
      || receipt.argumentsDigest !== intent.argumentsDigest
      || receipt.bindingRef !== this.options.binding.bindingRef
      || receipt.executionEpoch !== this.options.binding.executionEpoch
    ) {
      throw new ExplicitBrainOperationalToolError(
        'invalid-admission-receipt',
        'operational tool admission receipt does not match the current intent and runtime binding',
      );
    }
  }
}

export type {
  ExplicitBrainAgentToolPort,
  ExplicitBrainWorkspaceToolPort,
};
