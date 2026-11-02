import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentDebugInspection } from '@humanagent/contracts';
import {
  CANONICAL_AGENT_DEBUG_ROLES,
  projectAgentDebugInspections,
  projectPipelineObservation,
} from '../../packages/ui/projection/index.js';

test('projectAgentDebugInspections projects all 5 canonical roles in not-invoked state when no role input is supplied', () => {
  const inspections = projectAgentDebugInspections();
  assert.deepEqual(
    inspections.map((entry) => entry.agentRole),
    CANONICAL_AGENT_DEBUG_ROLES,
  );
  for (const entry of inspections) {
    validateAgentDebugInspection(entry);
    assert.equal(entry.invocationStatus, 'not-invoked');
    assert.equal(entry.turn.state, 'not-invoked');
    assert.equal(entry.context.state, 'not-invoked');
    assert.equal(entry.model.state, 'not-invoked');
    assert.equal(entry.model.tokenUsage.state, 'not-applicable');
    assert.equal(entry.tools.availableToolsState, 'not-invoked');
    assert.equal(entry.tools.callsState, 'not-invoked');
    assert.equal(entry.error.state, 'none');
  }
});

test('projectAgentDebugInspections covers collected, invoked-without-model, invoked-without-tools, data-not-collected, planner failed, memory rejected, and not-invoked', () => {
  const inspections = projectAgentDebugInspections({
    byRole: {
      interaction: {
        agentRole: 'interaction',
        invocationStatus: 'completed',
        latestInvocation: {
          agentRole: 'interaction',
          invocationId: 'inv-interaction-1',
          taskId: 'task-debug-matrix',
          turnId: 'turn-interaction-1',
          operationId: null,
          executionEpoch: 1,
          sourceNodeId: 'explicit.normalize',
        },
        invocationHistoryCount: 1,
        turn: {
          state: 'collected',
          turnId: 'turn-interaction-1',
          round: 1,
          startedAt: '2026-11-02T10:00:00.000Z',
          completedAt: '2026-11-02T10:00:00.000Z',
          durationMs: 0,
          lifecycleState: 'completed',
        },
        context: {
          state: 'collected',
          contextRootId: 'ctx:interaction:1',
          inheritsOrchestratorContext: false,
          messageCount: 1,
          charCount: 32,
          injectedRefs: ['task://task-debug-matrix/input'],
          compacted: false,
          omissionReason: null,
        },
        model: {
          state: 'invoked-without-model',
          provider: null,
          requestedModel: null,
          actualModel: null,
          retryCount: 0,
          tokenUsage: { state: 'not-applicable', reason: 'no-model-call' },
        },
        tools: {
          availableToolsState: 'invoked-without-tools',
          availableTools: [],
          callsState: 'invoked-without-tools',
          calls: [],
        },
        error: { state: 'none' },
      },
      orchestration: {
        agentRole: 'orchestration',
        invocationStatus: 'failed',
        latestInvocation: {
          agentRole: 'orchestration',
          invocationId: 'inv-orchestration-1',
          taskId: 'task-debug-matrix',
          turnId: 'turn-orchestration-1',
          operationId: 'op-1',
          executionEpoch: 1,
          sourceNodeId: 'task.correlate-or-create',
        },
        invocationHistoryCount: 1,
        turn: {
          state: 'collected',
          turnId: 'turn-orchestration-1',
          round: 1,
          startedAt: '2026-11-02T10:00:01.000Z',
          completedAt: '2026-11-02T10:00:02.000Z',
          durationMs: 1000,
          lifecycleState: 'failed',
        },
        context: {
          state: 'data-not-collected',
          injectedRefs: [],
        },
        model: {
          state: 'invoked-without-model',
          provider: 'cc',
          requestedModel: 'gpt-5',
          actualModel: null,
          retryCount: 0,
          tokenUsage: { state: 'not-applicable', reason: 'no-model-call' },
        },
        tools: {
          availableToolsState: 'invoked-without-tools',
          availableTools: [],
          callsState: 'invoked-without-tools',
          calls: [],
        },
        error: {
          state: 'present',
          owner: 'humanagent.runtime.implicit-orchestrator',
          code: 'orchestrator.decision.invalid-schema',
          message: 'orchestrator decision is not valid JSON',
          retryable: false,
          readonlyNextActionHint: '只读核对 Planner 决策 JSON 结构并在新轮次重新提交',
        },
      },
      execution: {
        agentRole: 'execution',
        invocationStatus: 'completed',
        latestInvocation: {
          agentRole: 'execution',
          invocationId: 'inv-exec-1',
          taskId: 'task-debug-matrix',
          turnId: 'turn-exec-real-1',
          operationId: 'op-1',
          executionEpoch: 1,
          sourceNodeId: 'pipeline.execute',
        },
        invocationHistoryCount: 1,
        turn: {
          state: 'collected',
          turnId: 'turn-exec-real-1',
          round: 1,
          startedAt: '2026-11-02T10:00:03.000Z',
          completedAt: '2026-11-02T10:00:05.000Z',
          durationMs: 2000,
          lifecycleState: 'completed',
        },
        context: {
          state: 'collected',
          contextRootId: 'ctx:exec:1',
          inheritsOrchestratorContext: false,
          messageCount: 1,
          charCount: 64,
          injectedRefs: ['operation://op-1/input', 'memory://mem-1'],
          compacted: false,
          omissionReason: null,
        },
        model: {
          state: 'collected',
          provider: 'cc',
          requestedModel: 'gpt-5',
          actualModel: 'gpt-5',
          retryCount: 0,
          tokenUsage: {
            state: 'data-not-collected',
            reason: 'provider-protocol-omitted',
          },
        },
        tools: {
          availableToolsState: 'collected',
          availableTools: ['read_file'],
          callsState: 'collected',
          calls: [
            {
              callId: 'tool-call-1',
              toolName: 'read_file',
              state: 'succeeded',
              redactedInputSummary: '{"path":"README.md"}',
              durationMs: 500,
              outputRef: 'asset://tool-1',
              errorMessage: null,
            },
          ],
        },
        error: { state: 'none' },
      },
      review: {
        agentRole: 'review',
        invocationStatus: 'not-invoked',
        latestInvocation: null,
        invocationHistoryCount: 0,
      },
      memory: {
        agentRole: 'memory',
        invocationStatus: 'rejected',
        latestInvocation: {
          agentRole: 'memory',
          invocationId: 'inv-memory-1',
          taskId: 'task-debug-matrix',
          turnId: 'turn-memory-1',
          operationId: 'op-1',
          executionEpoch: 1,
          sourceNodeId: 'memory.agent',
        },
        invocationHistoryCount: 1,
        turn: {
          state: 'collected',
          turnId: 'turn-memory-1',
          round: 1,
          startedAt: '2026-11-02T10:00:06.000Z',
          completedAt: '2026-11-02T10:00:06.000Z',
          durationMs: 0,
          lifecycleState: 'rejected',
        },
        context: {
          state: 'collected',
          contextRootId: 'ctx:memory:1',
          inheritsOrchestratorContext: false,
          messageCount: 1,
          charCount: 48,
          injectedRefs: ['journal://checkpoint/1'],
          compacted: false,
          omissionReason: 'rejected-by-memory-gate: cand-rejected-1',
        },
        model: {
          state: 'invoked-without-model',
          provider: null,
          requestedModel: null,
          actualModel: null,
          retryCount: 0,
          tokenUsage: { state: 'not-applicable', reason: 'no-model-call' },
        },
        tools: {
          availableToolsState: 'invoked-without-tools',
          availableTools: [],
          callsState: 'invoked-without-tools',
          calls: [],
        },
        error: {
          state: 'present',
          owner: 'memory.curation',
          code: 'memory.candidate.rejected',
          message: '经验候选未通过准入',
          retryable: false,
          readonlyNextActionHint: '只读核对被拒经验候选的证据引用与去重规则',
        },
      },
    },
  });

  for (const entry of inspections) {
    validateAgentDebugInspection(entry);
  }

  const byRole = Object.fromEntries(inspections.map((entry) => [entry.agentRole, entry]));
  assert.equal(byRole.interaction?.model.state, 'invoked-without-model');
  assert.equal(byRole.interaction?.tools.callsState, 'invoked-without-tools');
  assert.equal(byRole.orchestration?.invocationStatus, 'failed');
  assert.equal(byRole.orchestration?.context.state, 'data-not-collected');
  assert.equal(byRole.orchestration?.error.state, 'present');
  assert.equal(byRole.execution?.model.state, 'collected');
  assert.equal(byRole.execution?.model.tokenUsage.state, 'data-not-collected');
  if (byRole.execution?.model.tokenUsage.state === 'data-not-collected') {
    assert.equal(byRole.execution.model.tokenUsage.reason, 'provider-protocol-omitted');
  }
  assert.equal(byRole.execution?.tools.callsState, 'collected');
  assert.equal(byRole.review?.invocationStatus, 'not-invoked');
  assert.equal(byRole.memory?.invocationStatus, 'rejected');
  assert.equal(byRole.memory?.error.state, 'present');
});

test('projectPipelineObservation attaches 5-role agentDebugInspections and selectedNode.debugInspection', () => {
  const scopeRef = 'task://task-obs-1/observation';
  const projection = projectPipelineObservation({
    source: { state: 'ready', label: '已完成', detail: '' },
    taskId: 'task-obs-1',
    scopes: {
      [scopeRef]: {
        scopeRef,
        title: '任务处理流水',
        summary: '观测',
        purpose: 'pipeline-registry',
        projectionSeq: '1',
        agents: [{ agentId: 'agent-execution', role: 'execution', stateDisplay: '归属', iteration: 1 }],
        nodes: [
          {
            nodeId: 'pipeline.execute',
            title: '执行流水线',
            kind: 'execution.pipeline',
            state: 'succeeded',
            summary: '执行完成',
            owner: 'agent-execution',
            ownerAgentRole: 'execution',
            inputRefs: [],
            outputRefs: [],
            evidenceRefs: [],
          },
        ],
      },
    },
    scopeStack: [scopeRef],
    selectedNodeId: 'pipeline.execute',
  });

  assert.equal(projection.agentDebugInspections.length, 5);
  assert.equal(projection.selectedNode?.debugInspection?.agentRole, 'execution');
});
