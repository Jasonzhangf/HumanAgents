import type {
  MemoryComparisonView,
  MemoryDetailView,
  MemoryInteractionPort,
  MemorySaveCandidateArguments,
  MemorySubmissionReceipt,
  MemoryView,
  ToolIntent,
} from '../../../contracts/src/index.js';
import type {
  ExplicitBrainAdmissionReceipt,
  ExplicitBrainRuntimeBinding,
} from './tool-registry.js';
import {
  submitMemorySaveCandidate,
  type ExplicitBrainMemoryRuntimeContext,
  type MemorySubmissionPort,
} from './memory-submission.js';

export type ExplicitBrainMemoryToolResult =
  | MemoryView
  | MemoryDetailView
  | MemoryComparisonView
  | MemorySubmissionReceipt;

export interface ExplicitBrainMemoryToolExecutorOptions {
  readonly binding: ExplicitBrainRuntimeBinding;
  readonly interaction: MemoryInteractionPort;
  readonly submissions: MemorySubmissionPort;
  readonly context: ExplicitBrainMemoryRuntimeContext;
}

export class ExplicitBrainMemoryToolError extends Error {
  readonly code: 'unsupported-tool' | 'invalid-tool-arguments' | 'invalid-admission-receipt';

  constructor(code: ExplicitBrainMemoryToolError['code'], message: string) {
    super(message);
    this.name = 'ExplicitBrainMemoryToolError';
    this.code = code;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExplicitBrainMemoryToolError('invalid-tool-arguments', 'memory tool arguments must be an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringArgument(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExplicitBrainMemoryToolError('invalid-tool-arguments', `${key} is required`);
  }
  return value;
}

function positiveIntegerArgument(args: Readonly<Record<string, unknown>>, key: string): number {
  const value = args[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ExplicitBrainMemoryToolError('invalid-tool-arguments', `${key} must be a positive safe integer`);
  }
  return value as number;
}

/**
 * Executes admitted Explicit Brain memory capabilities through the typed
 * Memory interaction and submission owners. It never accepts model-supplied
 * binding, actor, project, epoch, or digest identity.
 */
export class ExplicitBrainMemoryToolExecutor {
  constructor(private readonly options: ExplicitBrainMemoryToolExecutorOptions) {}

  async execute(
    intent: ToolIntent,
    receipt: ExplicitBrainAdmissionReceipt,
  ): Promise<ExplicitBrainMemoryToolResult> {
    this.assertAdmissionReceipt(intent, receipt);
    const args = record(intent.arguments);
    const actor = this.options.context.actor;
    switch (intent.toolRef) {
      case 'memory.search':
        return this.options.interaction.query({
          actor,
          projectKey: this.options.context.projectKey,
          namespace: 'project',
          query: stringArgument(args, 'query'),
          limit: positiveIntegerArgument(args, 'limit'),
        });
      case 'memory.inspect':
        return this.inspect(args);
      case 'memory.compare':
        return this.options.interaction.compare({
          actor,
          leftRef: stringArgument(args, 'leftRef'),
          rightRef: stringArgument(args, 'rightRef'),
        });
      case 'memory.save_candidate':
        return submitMemorySaveCandidate({
          binding: this.options.binding,
          intentArguments: args as unknown as MemorySaveCandidateArguments,
          argumentsDigest: intent.argumentsDigest,
          context: this.options.context,
          port: this.options.submissions,
        });
      default:
        throw new ExplicitBrainMemoryToolError(
          'unsupported-tool',
          `memory tool executor does not own tool: ${intent.toolRef}`,
        );
    }
  }

  private async inspect(args: Readonly<Record<string, unknown>>): Promise<MemoryDetailView> {
    const sourceRef = stringArgument(args, 'sourceRef');
    const resolved = await this.options.interaction.resolveSource({
      actor: this.options.context.actor,
      projectKey: this.options.context.projectKey,
      sourceRef,
    });
    return this.options.interaction.inspect({
      actor: this.options.context.actor,
      sourceRef,
      sourceDigest: resolved.sourceDigest,
    });
  }

  private assertAdmissionReceipt(
    intent: ToolIntent,
    receipt: ExplicitBrainAdmissionReceipt,
  ): void {
    if (
      receipt.admitted !== true
      || receipt.toolRef !== intent.toolRef
      || receipt.capabilityRef !== intent.toolRef
      || receipt.argumentsDigest !== intent.argumentsDigest
      || receipt.bindingRef !== this.options.binding.bindingRef
      || receipt.executionEpoch !== this.options.binding.executionEpoch
    ) {
      throw new ExplicitBrainMemoryToolError(
        'invalid-admission-receipt',
        'memory tool admission receipt does not match the current intent and runtime binding',
      );
    }
  }
}
