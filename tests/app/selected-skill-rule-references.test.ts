import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProviderExplicitBrainInterpreter } from '../../packages/app/src/explicit-brain-runtime.js';
import { id, type ProviderBinding } from '../../packages/contracts/src/index.js';
import { filesystemProviderEvidenceSink } from '../../packages/adapters/provider/src/index.js';
import { providerRawContentReader } from '../../packages/adapters/provider/src/evidence.js';
import { ImmutableAssetStore } from '../../packages/adapters/filesystem/src/index.js';
import { JsonlOrganJournal } from '../../packages/adapters/jsonl/src/index.js';
import { JsonlInteractionHelperJournal } from '../../packages/adapters/jsonl/src/interaction-helper-journal.js';
import { JsonlInteractionParentTurnJournal } from '../../packages/adapters/jsonl/src/interaction-parent-turn-journal.js';
import type { EffectiveAgentProviderBinding } from '../../packages/config/src/index.js';
import { prepareAgentProvider } from '../../packages/app/src/agent-driver-composition.js';

test('selected Skill rule references load through the controlled HTTP provider', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'humanagent-selected-skill-reference-'));
  const evidence = filesystemProviderEvidenceSink(new ImmutableAssetStore(join(fixtureRoot, 'assets')));
  const organJournal = new JsonlOrganJournal(join(fixtureRoot, 'organ.jsonl'));
  const helperJournal = new JsonlInteractionHelperJournal(organJournal);
  const deps = {
    organId: id('organ', 'selected-skill-reference'),
    interactionScopeId: 'runtime:selected-skill-reference',
    journal: organJournal,
    parentJournal: new JsonlInteractionParentTurnJournal(organJournal),
    helperJournal,
    checkpointJournal: helperJournal,
    turnHelperJournal: helperJournal,
    rawEvidence: evidence,
    rawContent: providerRawContentReader(evidence),
    clock: { now: () => new Date().toISOString() },
    helperFactory: async () => { throw new Error('unexpected helper dispatch'); },
  };
  let binding: ProviderBinding = {
    bindingId: 'binding-selected-skill-reference',
    providerId: 'provider-selected-skill-reference',
    protocol: 'responses',
    endpointRef: '',
    modelRef: 'controlled-selected-skill-reference',
    configDigest: 'sha256:selected-skill-reference-config',
    capabilityDigest: 'sha256:selected-skill-reference-capability',
  };
  const templateRoot = await mkdtemp(join(tmpdir(), 'humanagent-selected-skill-template-'));
  execFileSync('cp', ['-R', join(process.cwd(), 'packages', 'agent-templates', 'templates', 'builtin'), templateRoot]);
  const timingPath = join(templateRoot, 'builtin', 'interaction', 'skills', 'agent-communication', 'rules', 'message-timing.md');
  const communicationSkill = join(templateRoot, 'builtin', 'interaction', 'skills', 'agent-communication', 'SKILL.md');
  const originalCommunicationSkill = await readFile(communicationSkill, 'utf8');
  await writeFile(communicationSkill, originalCommunicationSkill + '\nBODY_V1\n');
  await writeFile(timingPath, '# Message timing\n\nTIMING_RULE_V1\n', 'utf8');
  const posts: string[] = [];
  const checkpointAtRequest: boolean[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      posts.push(body);
      if (posts.length <= 4) {
        const [opened] = await deps.parentJournal.readScopeOpenedTurns({
          organId: deps.organId, interactionScopeId: deps.interactionScopeId,
        });
        if (!opened) throw new Error('request sent before turn opened');
        checkpointAtRequest.push(await helperJournal.readSemanticCheckpointExact(opened.fact.turn) !== null);
      }
      const wire = JSON.parse(body) as {
        readonly instructions?: string;
        readonly input?: readonly { readonly type?: string; readonly call_id?: string; readonly output?: unknown }[];
      };
      const drain = wire.input?.some((item) => item.type === 'function_call_output' && item.call_id === 'turn-end') === true;
      const selectionNeeded = !drain && wire.instructions?.includes('# Selected Skill:') !== true;
      const responseId = `selected-skill-reference-${posts.length}`;
      // The outgoing request already contains V1. Change both sources before
      // returning a text-only stop, which must continue this same business turn.
      const changeSkill = posts.length === 2;
      if (changeSkill) {
        await writeFile(communicationSkill, originalCommunicationSkill + '\nBODY_CHANGED_IN_TURN\n');
        await writeFile(timingPath, '# Message timing\n\nRULE_CHANGED_IN_TURN\n');
      }
      const functionCall = selectionNeeded
        ? {
          type: 'response.output_item.done', output_index: 0, item: {
            type: 'function_call', call_id: 'select-skills', name: 'interaction_select_skills',
            arguments: JSON.stringify({ skillIds: ['agent-communication'] }),
          },
        }
        : {
          type: 'response.output_item.done', output_index: 0, item: {
            type: 'function_call', call_id: 'turn-end', name: 'humanagent_turn_end',
            arguments: JSON.stringify({
              kind: 'simple',
              decision: {
                kind: 'answer', normalizedInput: 'send a blocked-work message', knownFacts: [],
                decisionRefs: [], answer: 'message guidance loaded',
              },
              checkpointRecord: { index: { action: 'answered with selected Skill guidance', result: 'answered' } },
            }),
          },
        };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const outputFrame = drain
        ? { type: 'response.output_text.done', item_id: 'drain', text: 'drain' }
        : changeSkill ? { type: 'response.output_text.done', item_id: 'continue-text', text: 'still working' } : functionCall;
      response.end([
        { type: 'response.created', response: { id: responseId } },
        outputFrame,
        { type: 'response.completed', response: { id: responseId } },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing controlled Provider address');
    binding = { ...binding, endpointRef: `http://127.0.0.1:${address.port}` };
    const entries: EffectiveAgentProviderBinding[] = [{
      agentId: 'controlled-interaction', roleId: 'interaction', source: 'agent',
      provider: { source: 'http', provider: 'http', binding: binding.bindingId, protocol: 'responses',
        model: binding.modelRef, route: 'selected-skill-reference', baseUrl: binding.endpointRef },
    }];
    const interpreter = createProviderExplicitBrainInterpreter({
      ...deps, binding, templateRoot,
      prepareAgentProvider: async (selection) => prepareAgentProvider({
        ...selection, agentProviderBindings: entries, evidenceRoot: join(fixtureRoot, 'assets'),
      }),
    });
    const input = (interactionId: string) => ({
      interactionId, inputRevision: 1, sourceRef: 'ui:selected-skill-reference',
      rawInput: 'send a blocked-work message', clarifications: [], taskCandidates: [],
    });
    const first = await interpreter.interpret(input('interaction-skill-reference-v1'));
    assert.equal(first.kind, 'answer');
    assert.equal(posts.length, 4, 'selection, text-only stop, continuation, and transport drain');
    assert.deepEqual(checkpointAtRequest, [false, false, false, false],
      'even the request carrying the accepted end result precedes checkpoint publication');
    const [completed] = await deps.parentJournal.readScopeOpenedTurns({
      organId: deps.organId, interactionScopeId: deps.interactionScopeId,
    });
    assert.ok(await helperJournal.readSemanticCheckpointExact(completed!.fact.turn));
    const initial = JSON.parse(posts[0]!) as { readonly instructions: string; readonly tools?: readonly { readonly name?: string }[] };
    const selected = JSON.parse(posts[1]!) as { readonly instructions: string };
    const selectionBody = JSON.parse(posts[0]!) as { readonly tools?: readonly { readonly name?: string }[] };
    assert.match(initial.instructions, /- agent-communication:/);
    assert.equal(initial.instructions.includes('# Skill rule reference:'), false);
    assert.deepEqual(selectionBody.tools?.map((tool) => tool.name).filter((name) => name !== undefined),
      ['interaction_select_skills', 'humanagent_turn_end']);
    assert.equal(selectionBody.tools?.some((tool) => tool.name === 'agent_message'), false);
    assert.match(selected.instructions, /# Selected Skill: agent-communication/);
    assert.match(selected.instructions, /# Skill rule reference: rules\/message-timing\.md/);
    assert.match(selected.instructions, /TIMING_RULE_V1/);
    assert.match(selected.instructions, /BODY_V1/);
    const continued = JSON.parse(posts[2]!);
    assert.match(continued.instructions, /BODY_CHANGED_IN_TURN/);
    assert.match(continued.instructions, /RULE_CHANGED_IN_TURN/);
    assert.equal(/BODY_V1|TIMING_RULE_V1/.test(continued.instructions), false);
    assert.deepEqual(continued.input.filter((item: {call_id?: string}) => item.call_id === 'select-skills')
      .map((item: {type: string}) => item.type), ['function_call', 'function_call_output']);
    assert.equal(selected.instructions.includes('# Selected Skill: task-intake'), false);

    await writeFile(timingPath, '# Message timing\n\nTIMING_RULE_V2\n', 'utf8');
    const invalidInterpreter = createProviderExplicitBrainInterpreter({
      ...deps,
      interactionScopeId: 'runtime:invalid-skill-reference',
      binding,
      templateRoot,
      prepareAgentProvider: async (selection) => prepareAgentProvider({
        ...selection,
        agentProviderBindings: [{
          ...entries[0]!,
          agentId: 'controlled-interaction-invalid-reference',
        }],
        evidenceRoot: join(fixtureRoot, 'assets'),
      }),
    });
    const invalidInput = (interactionId: string) => ({
      ...input(interactionId),
      rawInput: 'send another blocked-work message',
    });
    await writeFile(communicationSkill, originalCommunicationSkill.replace(
      '  - rules/message-timing.md', '  - rules/message-timing.md\n  - ../../agent-addressing/SKILL.md'), 'utf8');
    await assert.rejects(
      () => invalidInterpreter.interpret(invalidInput('interaction-skill-reference-invalid-reference')),
      /standard Skill reference must stay inside its Skill directory/,
    );
    await writeFile(communicationSkill, originalCommunicationSkill, 'utf8');
    const second = await interpreter.interpret(input('interaction-skill-reference-v2'));
    assert.equal(second.kind, 'answer');
    assert.equal(posts.length, 7);
    const newTurnInput = JSON.parse(posts[4]!).input;
    assert.equal(JSON.parse(newTurnInput[0].content[0].text).turnId, completed!.fact.turn.turnId);
    assert.equal(newTurnInput[1].role, 'user');
    assert.equal(newTurnInput.some((item: {type?: string}) =>
      item.type === 'function_call' || item.type === 'function_call_output'), false);
    const updated = JSON.parse(posts[5]!) as { readonly instructions: string };
    assert.match(updated.instructions, /TIMING_RULE_V2/);
    assert.equal(updated.instructions.includes('TIMING_RULE_V1'), false);
    assert.equal(updated.instructions.split('# Skill rule reference: rules/message-timing.md').length - 1, 1);
    assert.equal(updated.instructions.includes('name: agent-addressing'), false);

    await rm(timingPath);
    const missingInterpreter = createProviderExplicitBrainInterpreter({
      ...deps,
      interactionScopeId: 'runtime:missing-skill-reference',
      binding,
      templateRoot,
      prepareAgentProvider: async (selection) => prepareAgentProvider({
        ...selection,
        agentProviderBindings: [{
          ...entries[0]!,
          agentId: 'controlled-interaction-missing-reference',
        }],
        evidenceRoot: join(fixtureRoot, 'assets'),
      }),
    });
    await assert.rejects(
      () => missingInterpreter.interpret(invalidInput('interaction-skill-reference-missing')),
      /rules\/message-timing\.md.*does not exist/,
    );
    assert.equal(posts.length, 8, 'a missing declared reference fails before the continuation request');
  } finally {
    server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await Promise.all([templateRoot, fixtureRoot].map((root) => rm(root, { recursive: true, force: true })));
  }
});
