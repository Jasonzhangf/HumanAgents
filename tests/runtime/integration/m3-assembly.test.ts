import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AcpServerAdapter,
  DeterministicAcpRuntimeTransport,
  type AcpPeerProof,
} from '../../../packages/adapters/acp/index.js';
import {
  id,
  type AcpServerBinding,
  type EvidenceRef,
  type Task,
} from '../../../packages/contracts/src/index.js';
import {
  CapabilityRegistry,
  decideOrchestrationRuntimePool,
} from '../../../packages/runtime/src/index.js';
import { projectTaskDashboard } from '../../../packages/ui/index.js';

const taskId = id('task', 'm3-assembly');
const organId = id('organ', 'm3-assembly');
const scope = { organId, taskId };
const evidence: EvidenceRef = {
  evidenceId: id('evidence', 'm3-assembly'),
  kind: 'operation',
  source: 'm3-assembly-test',
  locator: 'm3/assembly',
  scope,
};

const task: Task = {
  id: taskId,
  organId,
  title: 'M3 assembly',
  directive: 'assemble reviewed HumanAgent modules',
  directiveRevision: 1,
  state: 'running',
  memoryScope: 'task',
};

const serverBinding: AcpServerBinding = {
  bindingRef: 'm3-server',
  principalRef: 'm3-principal',
  scopeRef: 'organ-m3::task-m3-assembly',
  allowedSessionKinds: ['task'],
  allowedCapabilities: ['session.open', 'observe'],
  permissionRevision: 'permission-m3',
  bindingDigest: 'sha256:m3-server',
};

const proof: AcpPeerProof = {
  principalRef: serverBinding.principalRef,
  scopeRef: serverBinding.scopeRef,
  permissionRevision: serverBinding.permissionRevision,
  bindingDigest: serverBinding.bindingDigest,
};

test('M3 modules compose through HumanAgent contracts without DSH identities', async () => {
  const poolDecision = decideOrchestrationRuntimePool({
    pool: { maxRuntimes: 1, runtimes: [] },
    requiredCapabilities: ['task.dispatch'],
  });
  assert.equal(poolDecision.action, 'spawn');
  assert.equal(poolDecision.runtimeId, 'orchestration-runtime-1');

  const capabilityRegistry = new CapabilityRegistry();
  const registered = capabilityRegistry.register({
    capabilityId: 'm3-status',
    capabilityRef: 'task.status.read',
    ownerRef: 'orchestration-m3',
    scopeRef: serverBinding.scopeRef,
    permissionRevision: serverBinding.permissionRevision,
    executionEpoch: 1,
    allowedCallerRefs: ['interaction-m3'],
    evidenceRefs: [evidence],
  });
  assert.equal(registered.revoked, false);
  assert.equal(capabilityRegistry.resolve('m3-status')?.capabilityRef, 'task.status.read');

  const acp = new AcpServerAdapter(
    serverBinding,
    new DeterministicAcpRuntimeTransport(serverBinding),
  );
  const negotiated = await acp.initialize({
    proof,
    requestedCapabilities: ['session.open', 'observe'],
    requestedSessionKinds: ['task'],
  });
  assert.deepEqual(negotiated.sessionKinds, ['task']);
  const session = await acp.open({
    acpSessionId: 'm3-acp-session',
    proof,
    binding: {
      kind: 'task',
      taskId,
      assignmentId: 'm3-assignment',
      executionEpoch: 1,
      bindingFingerprint: 'sha256:m3-task',
    },
    requestedCapabilities: ['session.open'],
  });
  assert.equal(session.binding.kind, 'task');
  assert.equal(session.binding.kind === 'task' ? session.binding.taskId.value : '', taskId.value);

  const projection = projectTaskDashboard({
    source: { state: 'ready', label: 'M3 assembly', updatedAt: '2026-09-17T00:00:00.000Z' },
    task,
    userInput: '集成已审核的 M3 模块',
    objective: '让编排、通信、ACP 和任务看板通过统一合同组装',
    currentStatus: '运行中',
    agentCards: [{
      agentId: 'orchestration-m3',
      role: 'orchestration',
      statusDisplay: '执行中',
      inputPreview: 'M3 assembly',
      outputPreview: '等待执行资源',
    }],
    runtimePool: {
      available: 1,
      active: 0,
      runtimes: [{
        runtimeId: poolDecision.runtimeId!,
        role: 'orchestration',
        state: 'available',
        resourceSummary: 'task.dispatch',
      }],
    },
    requiresUserHandling: false,
    observationRef: 'task://m3-assembly/observation',
  });
  assert.equal(projection.surface, 'task-dashboard');
  assert.equal(projection.taskId.value, taskId.value);
  assert.equal(projection.agentCards[0]?.role, 'orchestration');
  assert.equal(projection.runtimePool.runtimes[0]?.runtimeId, poolDecision.runtimeId);
});
