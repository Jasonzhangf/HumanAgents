import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseInterpreterOutput,
  type ExplicitBrainInterpretationInput,
} from '../../packages/app/src/explicit-brain-runtime.js';
import {
  parseModelResponse,
} from '../../packages/app/src/ui-runtime/turn-planner.js';

const intakeInput: ExplicitBrainInterpretationInput = {
  interactionId: 'interaction-w1a',
  inputRevision: 1,
  sourceRef: 'test:input',
  rawInput: 'find the marker line and report it',
  clarifications: [],
  taskCandidates: [],
};

const proposal = {
  revision: 1,
  intent: 'create',
  title: 'Locate marker line',
  objective: 'Find the e2e marker and report the matching line.',
  deliverable: 'A line report.',
  deliveryConditions: ['report the exact line'],
  evidenceRefs: [],
  blockingGaps: [],
};

function requirementDecision(): Record<string, unknown> {
  return {
    kind: 'requirement',
    normalizedInput: 'find the marker line and report it',
    knownFacts: ['search result'],
    decisionRefs: [],
    taskFlowKind: 'one-shot',
    proposal,
  };
}

function snapshot(label = 'Search'): Record<string, unknown> {
  return {
    title: 'Locate marker line',
    summary: 'Find the marker and report the line.',
    completeness: { scope: 'whole-task', status: 'complete' },
    acceptanceCriteria: [{ criterionId: 'ac1', description: 'report the line' }],
    nodes: [{ nodeId: 'n1', kind: 'tool', title: label, intent: 'search the workspace', definition: {} }],
    phases: [],
    relations: [],
  };
}

test('B3 intake: two JSON blocks select the valid requirement decision without a 500', () => {
  const other = requirementDecision();
  other.kind = 'clarification';
  other.question = 'Which workspace target do you mean?';
  const output = `Here is what I found.\n${JSON.stringify(other)}\n\n${JSON.stringify(requirementDecision())}\nDone.`;
  const interpretation = parseInterpreterOutput(output, intakeInput);
  assert.equal(interpretation.kind, 'requirement');
  if (interpretation.kind !== 'requirement') throw new Error('expected a requirement decision');
  assert.equal(interpretation.intent, 'create');
});

test('B3 intake: two valid decisions select by priority (requirement over clarification)', () => {
  const clarification = requirementDecision();
  clarification.kind = 'clarification';
  clarification.question = 'Which workspace target do you mean?';
  const output = `${JSON.stringify(clarification)}\n${JSON.stringify(requirementDecision())}`;
  const interpretation = parseInterpreterOutput(output, intakeInput);
  assert.equal(interpretation.kind, 'requirement');
});

test('B3 intake: one valid decision plus one malformed decision still selects the valid decision', () => {
  const garbage = requirementDecision();
  garbage.knownFacts = 'not-an-array';
  const output = `${JSON.stringify(garbage)}\n${JSON.stringify(requirementDecision())}`;
  const interpretation = parseInterpreterOutput(output, intakeInput);
  assert.equal(interpretation.kind, 'requirement');
  if (interpretation.kind !== 'requirement') throw new Error('expected a requirement decision');
  assert.equal(interpretation.intent, 'create');
});

test('B3 planner: Markdown fenced JSON with surrounding prose parses to a decision and snapshot', () => {
  const json = JSON.stringify({ decision: 'complete', snapshot: snapshot('search'), reasonText: 'found the marker' });
  const response = parseModelResponse(`Model reasoning... \n\`\`\`json\n${json}\n\`\`\`\nClosing note.`);
  assert.equal(response.decision, 'complete');
  assert.equal(response.snapshot.title, 'Locate marker line');
  assert.equal(response.reasonText, 'found the marker');
});

test('B3 planner: prose-prefixed JSON parses to the first balanced object', () => {
  const json = JSON.stringify({ decision: 'continue', snapshot: snapshot('plan') });
  const response = parseModelResponse(`The plan is:\n${json}`);
  assert.equal(response.decision, 'continue');
  assert.equal(response.snapshot.summary, 'Find the marker and report the line.');
});

test('B3 planner: braces inside a string do not prematurely close the first object', () => {
  const json = JSON.stringify({ decision: 'failed', snapshot: snapshot('note with } brace'), reasonText: 'contains { and } inside text' });
  const response = parseModelResponse(`thinking... \n${json}`);
  assert.equal(response.decision, 'failed');
  assert.equal(response.snapshot.nodes[0]!.title, 'note with } brace');
  assert.equal(response.reasonText, 'contains { and } inside text');
});

test('A4: user-facing step summaries are Chinese and the English internal summary is gone', async () => {
  const explicitBrain = await readFile(join(process.cwd(), 'packages/app/src/explicit-brain-runtime.ts'), 'utf8');
  const coordinator = await readFile(join(process.cwd(), 'packages/runtime/src/ui-runtime/coordinator.ts'), 'utf8');
  for (const summary of ['显式整理回合已完成', '正在请求模型整理任务', '模型请求已发出', '模型请求已完成']) {
    assert.ok(explicitBrain.includes(summary), `explicit-brain-runtime.ts must carry the Chinese step summary ${summary}`);
  }
  assert.ok(!explicitBrain.includes('Dispatching request to the model'), 'the English step summary must not return');
  assert.ok(!explicitBrain.includes("summary: 'Explicit turn completed'"), 'the English turn-completed summary must not return');
  for (const summary of ['执行完成，正在核对结果', '结果核对完成：']) {
    assert.ok(coordinator.includes(summary), `coordinator.ts must carry the Chinese step summary ${summary}`);
  }
  assert.ok(!coordinator.includes('Closed turn planner alignment started'), 'the English planner-alignment summary must not return');
});
