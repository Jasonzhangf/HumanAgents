import { createHash, randomUUID } from 'node:crypto';
import {
  EXPLICIT_BRAIN_MODEL_TOOLS,
  EXPLICIT_BRAIN_TEMPLATE_REF,
  id,
  type ExecutionRuntimePort,
  type InteractionDecision,
  type ProviderBinding,
  type RequirementIntent,
} from '../../contracts/src/index.js';
import { ProviderAgentDriver } from '../../adapters/provider/src/index.js';
import { loadBuiltinPromptSegments } from '../../agent-templates/src/index.js';
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

export interface ExplicitBrainTaskCandidate {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly currentInput: string;
}

export interface ExplicitBrainInterpretationInput {
  readonly interactionId: string;
  readonly inputRevision: number;
  readonly sourceRef: string;
  readonly rawInput: string;
  readonly clarifications: readonly {
    readonly question: string;
    readonly answer?: string;
  }[];
  readonly taskCandidates: readonly ExplicitBrainTaskCandidate[];
}

export type ExplicitBrainInterpretation =
  | {
      readonly kind: 'requirement';
      readonly normalizedInput: string;
      readonly matchedTaskId?: string;
      readonly knownFacts: readonly string[];
      readonly intent: RequirementIntent;
      readonly proposal: string;
      readonly decisionRefs: readonly string[];
    }
  | {
      readonly kind: 'status-query';
      readonly normalizedInput: string;
      readonly matchedTaskId?: string;
      readonly knownFacts: readonly string[];
      readonly answer: string;
      readonly decisionRefs: readonly string[];
    }
  | {
      readonly kind: 'clarification';
      readonly normalizedInput: string;
      readonly knownFacts: readonly string[];
      readonly question: string;
      readonly decisionRefs: readonly string[];
    };

export interface ExplicitBrainInputInterpreter {
  interpret(input: ExplicitBrainInterpretationInput): Promise<ExplicitBrainInterpretation>;
}

function interpreterPrompt(input: ExplicitBrainInterpretationInput, promptSegments: readonly string[]): string {
  return [
    ...promptSegments,
    '# Explicit intake decision output',
    'Return one JSON object only. Do not call tools and do not claim execution.',
    'kind must be requirement, status-query, or clarification.',
    'For requirement, intent must be create, append, or change. append/change require matchedTaskId from taskCandidates.',
    'For status-query, answer the question using taskCandidates and use matchedTaskId when one task is selected.',
    'For clarification, ask one concrete question and do not invent a task match.',
    'All variants require normalizedInput, knownFacts string array, and decisionRefs string array.',
    'Requirement also requires proposal. Status-query requires answer. Clarification requires question.',
    JSON.stringify(input),
  ].join('\n\n');
}

function parseInterpreterOutput(output: string): ExplicitBrainInterpretation {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1];
  const candidate = fenced ?? output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    throw new ExplicitBrainOperationalToolError(
      'unsupported-tool',
      `interaction agent returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object') {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction agent returned a non-object decision');
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const normalizedInput = record.normalizedInput;
  const knownFacts = record.knownFacts;
  const decisionRefs = record.decisionRefs;
  if ((kind !== 'requirement' && kind !== 'status-query' && kind !== 'clarification')
    || typeof normalizedInput !== 'string' || !normalizedInput.trim()
    || !Array.isArray(knownFacts) || !knownFacts.every((entry) => typeof entry === 'string')
    || !Array.isArray(decisionRefs) || !decisionRefs.every((entry) => typeof entry === 'string')) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'interaction agent decision does not match the explicit intake contract');
  }
  const common = {
    normalizedInput,
    knownFacts: knownFacts as string[],
    decisionRefs: decisionRefs as string[],
  };
  if (kind === 'clarification') {
    if (typeof record.question !== 'string' || !record.question.trim()) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'clarification decision requires a question');
    }
    return { kind, ...common, question: record.question };
  }
  const matchedTaskId = typeof record.matchedTaskId === 'string' && record.matchedTaskId.trim()
    ? record.matchedTaskId
    : undefined;
  if (kind === 'status-query') {
    if (typeof record.answer !== 'string' || !record.answer.trim()) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', 'status decision requires an answer');
    }
    return { kind, ...common, ...(matchedTaskId === undefined ? {} : { matchedTaskId }), answer: record.answer };
  }
  if ((record.intent !== 'create' && record.intent !== 'append' && record.intent !== 'change')
    || typeof record.proposal !== 'string' || !record.proposal.trim()) {
    throw new ExplicitBrainOperationalToolError('unsupported-tool', 'requirement decision requires a typed intent and proposal');
  }
  return {
    kind,
    ...common,
    ...(matchedTaskId === undefined ? {} : { matchedTaskId }),
    intent: record.intent,
    proposal: record.proposal,
  };
}

export function createProviderExplicitBrainInterpreter(input: {
  readonly port: ExecutionRuntimePort;
  readonly binding: ProviderBinding;
  readonly templateRoot: string;
}): ExplicitBrainInputInterpreter {
  let promptSegments: Promise<readonly string[]> | undefined;
  const loadPromptSegments = (): Promise<readonly string[]> => {
    if (promptSegments !== undefined) return promptSegments;
    const version = EXPLICIT_BRAIN_TEMPLATE_REF.slice('builtin/interaction@'.length);
    promptSegments = loadBuiltinPromptSegments('interaction', input.templateRoot, version)
      .then((loaded) => loaded.segments.map((segment) => segment.content));
    return promptSegments;
  };
  return {
    async interpret(request) {
      const identity = randomUUID();
      const runtimeId = `explicit-interpret-${identity}`;
      const taskId = id('task', `explicit-interpret-${identity}`);
      const operationId = id('operation', `explicit-interpret-${identity}`);
      const driver = new ProviderAgentDriver({
        port: input.port,
        binding: input.binding,
        runtimeId,
        taskId,
        operationId,
        executionEpoch: 1,
        assignmentId: `explicit-interpret-${identity}`,
        scope: { organId: id('organ', 'humanagent-explicit-brain'), taskId, operationId },
        inputRefs: [`humanagent://interaction/${request.interactionId}/revision/${request.inputRevision}`],
        ownerId: 'humanagent.runtime.explicit-brain',
      });
      const output: string[] = [];
      await driver.start({ runtimeId, taskId, operationId, organId: id('organ', 'humanagent-explicit-brain'), executionEpoch: 1, assignmentId: `explicit-interpret-${identity}` });
      await driver.submit({
        taskId,
        executionEpoch: 1,
        assignmentId: `explicit-interpret-${identity}`,
        payload: { prompt: interpreterPrompt(request, await loadPromptSegments()) },
      });
      for await (const event of driver.observe({ runtimeId })) {
        if (event.kind === 'provider.output' && event.summary) output.push(event.summary);
        if (event.terminalState !== undefined) break;
      }
      const closure = await driver.settle({ runtimeId, executionEpoch: 1 });
      if (closure.state !== 'succeeded') {
        throw new ExplicitBrainOperationalToolError('unsupported-tool', `interaction agent ended in ${closure.state}`);
      }
      return parseInterpreterOutput(output.join(''));
    },
  };
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
  function authorizeQuery(input: { readonly agentRef?: string; readonly scopeRef?: string }): ExplicitBrainAgentTarget {
    const target = targetFor(input);
    if (!target.queryable) throw new ExplicitBrainOperationalToolError('unsupported-tool', `agent query is not authorized: ${target.agentRef}`);
    if (options.queryAgent === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent query port is not configured');
    return target;
  }
  function authorizeMessage(input: { readonly recipientRef: string; readonly messageClass: 'control' | 'data' | 'observation' }): ExplicitBrainAgentTarget {
    const target = targetFor({ agentRef: input.recipientRef });
    if (options.sendAgentMessage === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent communication port is not configured');
    if (!target.messageClasses.includes(input.messageClass)) {
      throw new ExplicitBrainOperationalToolError('unsupported-tool', `agent message class is not authorized: ${input.messageClass}`);
    }
    return target;
  }
  return {
    authorizeQuery(input) {
      authorizeQuery(input);
    },
    authorizeMessage(input) {
      authorizeMessage(input);
    },
    async query(input) {
      const queryAgent = options.queryAgent;
      if (queryAgent === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent query port is not configured');
      const target = authorizeQuery(input);
      return queryAgent({ agentRef: target.agentRef, scopeRef: target.scopeRef });
    },
    async message(input) {
      const sendAgentMessage = options.sendAgentMessage;
      if (sendAgentMessage === undefined) throw new ExplicitBrainOperationalToolError('unsupported-tool', 'agent communication port is not configured');
      authorizeMessage(input);
      return sendAgentMessage(input);
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
