import type { AgentPromptSource, RegisteredSkill } from './types.js';
import { AgentTemplateError } from './errors.js';

function parseSkill(ref: string, content: string): RegisteredSkill {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const name = frontmatter?.match(/^name:\s*([a-z0-9][a-z0-9-]*)\s*$/m)?.[1];
  const description = frontmatter?.match(/^description:\s*(.+?)\s*$/m)?.[1];
  const referencesBlock = frontmatter?.match(/^references:\s*\r?\n((?:[ \t]+-[^\r\n]*\r?\n?)*)/m)?.[1];
  const referenceRefs = referencesBlock === undefined ? [] : [...referencesBlock.matchAll(/^[ \t]+-\s*([^\r\n]*?)\s*$/gm)]
    .map((match) => match[1] ?? '');
  const uniqueReferenceRefs = [...new Set(referenceRefs)];
  if (name === undefined || description === undefined) {
    throw new AgentTemplateError(`standard Skill frontmatter is invalid: ${ref}`);
  }
  if (uniqueReferenceRefs.some((reference) => !reference || reference.startsWith('/') || reference.split(/[\\/]/).includes('..'))) {
    throw new AgentTemplateError(`standard Skill reference must stay inside its Skill directory: ${ref}`);
  }
  return { id: name, description, ref, referenceRefs: uniqueReferenceRefs };
}

export async function loadRegisteredSkills(
  source: AgentPromptSource,
  refs: readonly string[],
): Promise<readonly RegisteredSkill[]> {
  const skills: RegisteredSkill[] = [];
  const ids = new Set<string>();
  for (const ref of refs) {
    const skill = parseSkill(ref, await source.read(ref));
    if (ids.has(skill.id)) throw new AgentTemplateError(`duplicate standard Skill name: ${skill.id}`);
    ids.add(skill.id);
    skills.push(skill);
  }
  return skills;
}

export function renderSkillDirectory(skills: readonly RegisteredSkill[]): string {
  return [
    '# Registered Skills',
    'The following standard Skills are registered for this role. The model may select any matching Skills by stable ID. The directory is descriptive and does not grant executable tools.',
    ...skills.map((skill) => `- ${skill.id}: ${skill.description}`),
  ].join('\n');
}

export async function loadSelectedSkillContent(
  source: AgentPromptSource,
  skill: RegisteredSkill,
): Promise<string> {
  const directory = skill.ref.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const references: { readonly ref: string; readonly content: string }[] = [];
  for (const ref of skill.referenceRefs) {
    references.push({ ref, content: await source.read(`${directory}/${ref}`, { within: directory }) });
  }
  const body = await source.read(skill.ref);
  return [
    body.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim(),
    ...references.map(({ ref, content }) => `# Skill rule reference: ${ref}\n\n${content}`),
  ].join('\n\n');
}
