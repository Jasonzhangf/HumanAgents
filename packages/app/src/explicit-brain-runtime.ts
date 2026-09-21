import { createHash } from 'node:crypto';
import {
  EXPLICIT_BRAIN_MODEL_TOOLS,
  EXPLICIT_BRAIN_TEMPLATE_REF,
  type InteractionDecision,
} from '../../contracts/src/index.js';
import { WorkspaceCodeSearchFunctions } from '../../adapters/operations/src/index.js';
import {
  ExplicitBrainDecisionExecutor,
  ExplicitBrainOperationalToolError,
  createExplicitBrainToolRegistry,
  type ExplicitBrainAgentToolPort,
  type ExplicitBrainOperationalToolPorts,
  type ExplicitBrainRuntimeBinding,
  type ExplicitBrainWorkspaceToolPort,
} from '../../runtime/src/explicit-brain/index.js';
import type { DecisionTracePort } from '../../runtime/src/explicit-brain/attention.js';

const CAPABILITY_DIGEST = `sha256:${createHash('sha256').update(EXPLICIT_BRAIN_MODEL_TOOLS.join('|')).digest('hex')}`;

function digestArguments(args: Readonly<Record<string, unknown>>): string {
  const stable = JSON.stringify(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${createHash('sha256').update(stable).digest('hex')}`;
}

export interface ExplicitBrainRuntimeOptions {
  readonly workspaceRoot: string;
  readonly projectKey: string;
  readonly traces: DecisionTracePort;
  readonly agentTargets?: readonly ExplicitBrainAgentTarget[];
  readonly queryAgent?: (input: { readonly agentRef: string; readonly scopeRef: string }) => Promise<unknown>;
  readonly sendAgentMessage?: (input: {
    readonly recipientRef: string;
    readonly messageRef: string;
    readonly messageClass: 'control' | 'data' | 'observation';
  }) => Promise<unknown>;
}

export interface ExplicitBrainAgentTarget {
  readonly agentRef: string;
  readonly scopeRef: string;
  readonly queryable: boolean;
  readonly messageClasses: readonly ('control' | 'data' | 'observation')[];
}

export interface ExplicitBrainRuntime {
  readonly binding: ExplicitBrainRuntimeBinding;
  readonly ports: ExplicitBrainOperationalToolPorts;
  execute(decision: InteractionDecision): Promise<readonly unknown[]>;
}

function createWorkspacePort(options: ExplicitBrainRuntimeOptions): ExplicitBrainWorkspaceToolPort {
  const workspaceRef = `workspace:${options.projectKey}`;
  const scopeRef = `scope:${workspaceRef}`;
  const functions = new WorkspaceCodeSearchFunctions({ workspaceRef, workspaceRoot: options.workspaceRoot });
  function authorizeScope(input: { readonly scopeRef: string }): void {
    if (input.scopeRef !== scopeRef) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', `workspace scope is not registered: ${input.scopeRef}`);
    }
  }
  return {
    authorize(input) {
      authorizeScope(input);
    },
    async list(input) {
      authorizeScope(input);
      return functions.findFiles({ workspaceRef, path: input.pathRef ?? '.', maxFiles: 100 });
    },
    async read(input) {
      authorizeScope(input);
      return functions.readFile({ workspaceRef, path: input.pathRef });
    },
    async search(input) {
      authorizeScope(input);
      const files = await functions.findFiles({ workspaceRef, path: '.', maxFiles: 100 });
      const matches: Array<{ readonly path: string; readonly lines: readonly number[] }> = [];
      for (const path of files.paths) {
        const content = await functions.readFile({ workspaceRef, path });
        const lines = content.content.split('\n')
          .map((line, index) => line.includes(input.query) ? index + 1 : undefined)
          .filter((line): line is number => line !== undefined);
        if (lines.length > 0) matches.push({ path, lines });
        if (matches.length >= input.limit) break;
      }
      return { query: input.query, matches, complete: files.complete };
    },
  };
}

function createAgentPort(options: ExplicitBrainRuntimeOptions): ExplicitBrainAgentToolPort {
  function targetFor(input: { readonly agentRef?: string; readonly scopeRef?: string }): ExplicitBrainAgentTarget {
    const target = options.agentTargets?.find((candidate) => (
      (input.agentRef === undefined || candidate.agentRef === input.agentRef)
      && (input.scopeRef === undefined || candidate.scopeRef === input.scopeRef)
    ));
    if (target === undefined) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent target is not registered for this runtime');
    }
    return target;
  }
  return {
    authorizeQuery(input) {
      const target = targetFor(input);
      if (!target.queryable) throw new ExplicitBrainOperationalToolError('unsupported-tool', `agent query is not authorized: ${target.agentRef}`);
      if (options.queryAgent === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent query port is not configured');
    },
    authorizeMessage(input) {
      const target = targetFor({ agentRef: input.recipientRef });
      if (options.sendAgentMessage === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent communication port is not configured');
      if (!target.messageClasses.includes(input.messageClass)) {
        throw new ExplicitBrainOperationalToolError('unsupported-tool', `agent message class is not authorized: ${input.messageClass}`);
      }
    },
    async query(input) {
      const target = targetFor(input);
      if (options.queryAgent === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent query port is not configured');
      return options.queryAgent({ agentRef: target.agentRef, scopeRef: target.scopeRef });
    },
    async message(input) {
      if (options.sendAgentMessage === undefined) {
        throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent communication port is not configured');
      }
      return options.sendAgentMessage(input);
    },
  };
}

export function createExplicitBrainRuntime(options: ExplicitBrainRuntimeOptions): ExplicitBrainRuntime {
  const binding: ExplicitBrainRuntimeBinding = {
    runtimeId: `runtime:explicit-brain:${options.projectKey}`,
    agentInstanceId: `agent:explicit-brain:${options.projectKey}`,
    roleId: 'interaction',
    templateRef: EXPLICIT_BRAIN_TEMPLATE_REF,
    interactionScopeId: `runtime:${options.projectKey}`,
    executionEpoch: 1,
    permissionRevision: 'permission:explicit-brain:v1',
    capabilityDigest: CAPABILITY_DIGEST,
    bindingRef: `binding:explicit-brain:${options.projectKey}`,
    scopeRef: `scope:interaction:${options.projectKey}`,
    permissions: ['workspace.read', 'agent.read', 'agent.message'],
    capabilities: ['workspace.list', 'file.read', 'file.search', 'agent.query', 'agent.message'],
  };
  const ports = {
    workspace: createWorkspacePort(options),
    agent: createAgentPort(options),
  } satisfies ExplicitBrainOperationalToolPorts;
  const executor = new ExplicitBrainDecisionExecutor<unknown>({
    registry: createExplicitBrainToolRegistry(CAPABILITY_DIGEST),
    binding,
    operationalPorts: ports,
    traces: options.traces,
    handler: {
      async execute() {
        throw new ExplicitBrainOperationalToolError('unsupported-tool', 'explicit brain tool is not connected to a runtime owner');
      },
    },
    context: {
      scopeRef: binding.scopeRef,
      runtimeBindingRef: binding.bindingRef,
      ownerRef: 'humanagent.runtime.explicit-brain',
      createdAt: new Date().toISOString(),
      inputDigest: 'sha256:runtime-explicit-brain',
      argumentsRef: (intent) => `arguments:${intent.toolIntentId}`,
    },
    currentEpoch: binding.executionEpoch,
    currentPermissionRevision: binding.permissionRevision,
    argumentsDigest: digestArguments,
  });
  return {
    binding,
    ports,
    execute: async (decision) => (await executor.execute(decision)).map((result) => result.result),
  };
}
