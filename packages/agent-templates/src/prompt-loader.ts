import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AgentTemplateError } from './errors.js';
import type {
  AgentPromptSegment,
  AgentPromptSource,
  CompiledAgentTemplate,
  LoadedAgentPromptSegments,
} from './types.js';

function digestContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function assertInsideRoot(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new AgentTemplateError('prompt segment resolved outside the template root');
  }
}

async function resolveExisting(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new AgentTemplateError(`${label} does not exist: ${path}`);
    }
    throw new AgentTemplateError(`${label} cannot be resolved: ${path}: ${String(error)}`);
  }
}

export function createFilePromptSource(rootDir: string): AgentPromptSource {
  return {
    async read(ref: string): Promise<string> {
      const root = await resolveExisting(rootDir, 'prompt template root');
      const candidate = resolve(root, ref);
      assertInsideRoot(root, candidate);
      const file = await resolveExisting(candidate, `prompt segment ${ref}`);
      assertInsideRoot(root, file);
      try {
        return await readFile(file, 'utf8');
      } catch (error) {
        throw new AgentTemplateError(`prompt segment cannot be read: ${ref}: ${String(error)}`);
      }
    },
  };
}

export async function loadAgentPromptSegments(
  template: Pick<CompiledAgentTemplate, 'promptSegmentRefs'>,
  source: AgentPromptSource,
): Promise<LoadedAgentPromptSegments> {
  const segments: AgentPromptSegment[] = [];
  for (const ref of template.promptSegmentRefs) {
    const content = await source.read(ref);
    if (!content.trim()) throw new AgentTemplateError(`prompt segment is empty: ${ref}`);
    segments.push({ ref, content, digest: digestContent(content) });
  }
  const contentDigest = `sha256:${createHash('sha256')
    .update(segments.map((segment) => `${segment.ref}\0${segment.digest}`).join('\n'), 'utf8')
    .digest('hex')}`;
  return { segments, contentDigest };
}
