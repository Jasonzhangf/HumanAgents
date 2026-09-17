import { join } from 'node:path';
import { AgentTemplateError } from './errors.js';
import { createFilePromptSource, loadAgentPromptSegments } from './prompt-loader.js';
import { AGENT_ROLE_IDS, type AgentRole, type LoadedAgentPromptSegments } from './types.js';

const BUILTIN_PROMPT_SEGMENT_REFS: Readonly<Record<AgentRole, readonly string[]>> = {
  interaction: ['interaction/identity.md', 'interaction/mission.md', 'interaction/input-output.md', 'interaction/failure.md', 'interaction/boundaries.md'],
  orchestration: ['orchestration/identity.md', 'orchestration/mission.md', 'orchestration/input-output.md', 'orchestration/failure.md', 'orchestration/boundaries.md'],
  execution: ['execution/identity.md', 'execution/mission.md', 'execution/input-output.md', 'execution/failure.md', 'execution/boundaries.md'],
  review: ['review/identity.md', 'review/mission.md', 'review/input-output.md', 'review/failure.md', 'review/boundaries.md'],
  memory: ['memory/identity.md', 'memory/mission.md', 'memory/input-output.md', 'memory/failure.md', 'memory/boundaries.md'],
};

export function builtinPromptSegmentRefs(roleId: AgentRole): readonly string[] {
  if (!AGENT_ROLE_IDS.includes(roleId)) throw new AgentTemplateError(`invalid builtin prompt role: ${roleId}`);
  return [...BUILTIN_PROMPT_SEGMENT_REFS[roleId]];
}

export async function loadBuiltinPromptSegments(
  roleId: AgentRole,
  templateRoot: string,
): Promise<LoadedAgentPromptSegments> {
  const promptSegmentRefs = builtinPromptSegmentRefs(roleId);
  return loadAgentPromptSegments(
    { promptSegmentRefs },
    createFilePromptSource(join(templateRoot, 'builtin')),
  );
}
