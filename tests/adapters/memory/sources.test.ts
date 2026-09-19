import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FilesystemMemorySourceAdapter,
  MemorySourceError,
} from '../../../packages/adapters/memory/src/index.js';

async function fixture(overrides: {
  readonly writeSession?: boolean;
  readonly writeManifest?: boolean;
  readonly writeAgents?: boolean;
  readonly writeSkill?: boolean;
  readonly writePrompt?: boolean;
} = {}): Promise<{
  readonly adapter: FilesystemMemorySourceAdapter;
  readonly root: string;
  readonly workspace: string;
  readonly sessions: string;
  readonly runNotes: string;
  readonly skillRoot: string;
  readonly promptRoot: string;
  readonly writeSessionFile: (content?: string) => Promise<void>;
  readonly writeManifest: (task?: string) => Promise<void>;
  readonly writePrompt: (content?: string) => Promise<void>;
  readonly writeAgents: (content?: string) => Promise<void>;
  readonly writeSkill: (content?: string) => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'humanagent-memory-sources-'));
  const workspace = join(root, 'workspace');
  const sessions = join(root, 'control', 'sessions');
  const runNotes = join(root, 'control', 'run-notes');
  const skillRoot = join(root, 'skills');
  const promptRoot = join(root, 'prompts');
  await mkdir(workspace, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(runNotes, { recursive: true });
  await mkdir(join(skillRoot, 'project-a'), { recursive: true });
  await mkdir(promptRoot, { recursive: true });
  const adapter = new FilesystemMemorySourceAdapter({
    workspaceCwd: workspace,
    sessionsRoot: sessions,
    runNotesRoot: runNotes,
    projectKey: 'project-a',
    localSkillRoot: skillRoot,
    localSkillName: 'project-a',
    auditPromptRoot: promptRoot,
    now: () => '2026-09-17T00:00:00.000Z',
  });
  const writeSessionFile = async (content = `${JSON.stringify({
    schemaVersion: 1,
    sessionId: 'session-a',
    projectKey: 'project-a',
    seq: 1,
    type: 'session.created',
    state: 'created',
  })}\n`) => {
    await writeFile(join(sessions, 'session-a.jsonl'), content, 'utf8');
  };
  const writeManifest = async (task = 'task-a') => {
    await writeFile(join(runNotes, 'session-a.manifest.json'), JSON.stringify({
      schemaVersion: 1,
      sessionId: 'session-a',
      agentId: 'agent-a',
      driverRef: 'fake',
      runtimeId: 'runtime-a',
      taskId: { scope: 'task', value: task },
      operationId: { scope: 'operation', value: 'operation-a' },
      executionEpoch: 2,
      directiveRevision: 1,
      cycleId: { scope: 'cycle', value: 'session-a-cycle-2' },
      scope: { organId: { scope: 'organ', value: 'organ-a' } },
    }, null, 2) + '\n', 'utf8');
  };
  const writeAgents = async (content = '## Project Rules\n') => {
    await writeFile(join(workspace, 'AGENTS.md'), content, 'utf8');
  };
  const writeSkill = async (content = '## Skill\n') => {
    await writeFile(join(skillRoot, 'project-a', 'SKILL.md'), content, 'utf8');
  };
  const writePrompt = async (content = '## Audit Prompt\n') => {
    await writeFile(join(promptRoot, 'project-memory-audit.md'), content, 'utf8');
  };
  if (overrides.writeAgents !== false) await writeAgents();
  if (overrides.writeSkill !== false) await writeSkill();
  if (overrides.writePrompt !== false) await writePrompt();
  if (overrides.writeSession !== false) await writeSessionFile();
  if (overrides.writeManifest !== false) await writeManifest();
  return {
    adapter,
    root,
    workspace,
    sessions,
    runNotes,
    skillRoot,
    promptRoot,
    writeSessionFile,
    writeManifest,
    writePrompt,
    writeAgents,
    writeSkill,
  };
}

test('session evidence source is read-only and bound to the run manifest task', async () => {
  const { adapter } = await fixture();
  const source = await adapter.readSession({
    projectKey: 'project-a',
    taskId: 'task-a',
    sessionRef: 'session-a',
  });
  assert.ok(source.sourceRef.startsWith('session://project-a/task-a/session-a@'));
  assert.ok(source.digest.startsWith('sha256:'));
  assert.match(source.content, /"sessionId":"session-a"/);

  await assert.rejects(
    adapter.readSession({ projectKey: 'project-a', taskId: 'task-b', sessionRef: 'session-a' }),
    /not bound to task/,
  );
  await assert.rejects(
    adapter.readSession({ projectKey: 'project-b', taskId: 'task-a', sessionRef: 'session-a' }),
    MemorySourceError,
  );
});

test('project sources are allowlisted to AGENTS.md and the cwd-named local skill only', async () => {
  const { adapter } = await fixture();
  const agents = await adapter.readProject({ projectKey: 'project-a', target: 'project-agents' });
  const skill = await adapter.readProject({ projectKey: 'project-a', target: 'project-local-skill' });
  assert.equal(agents.canonicalRef, 'project://project-a/AGENTS.md');
  assert.equal(skill.canonicalRef, 'skill://project/project-a/project-a/SKILL.md');

  await assert.rejects(
    adapter.readProject({ projectKey: 'project-a', target: 'project-agents' }).then(() => adapter.readPrompt({ projectKey: 'project-a', promptRef: '../project' })),
    MemorySourceError,
  );
});

test('project source list fails explicitly when an allowlisted local skill is missing', async () => {
  const { adapter, skillRoot } = await fixture();
  await rm(skillRoot, { recursive: true });

  await assert.rejects(
    adapter.list({ projectKey: 'project-a' }),
    MemorySourceError,
  );
});

test('undeclared local Skill returns a typed unavailable source with manifest next action', async () => {
  const fixtureValue = await fixture();
  const adapter = new FilesystemMemorySourceAdapter({
    workspaceCwd: fixtureValue.workspace,
    sessionsRoot: fixtureValue.sessions,
    runNotesRoot: fixtureValue.runNotes,
    projectKey: 'project-a',
    auditPromptRoot: fixtureValue.promptRoot,
  });
  await assert.rejects(
    adapter.readProject({ projectKey: 'project-a', target: 'project-local-skill' }),
    (error: unknown) => error instanceof MemorySourceError
      && error.code === 'memory-source-unavailable'
      && error.nextAction === 'project.json#sources.localSkill',
  );
  const agents = await adapter.readProject({ projectKey: 'project-a', target: 'project-agents' });
  assert.equal(agents.target, 'project-agents');
});

test('project source list keeps project experience available without an optional local Skill', async () => {
  const fixtureValue = await fixture();
  const adapter = new FilesystemMemorySourceAdapter({
    workspaceCwd: fixtureValue.workspace,
    sessionsRoot: fixtureValue.sessions,
    runNotesRoot: fixtureValue.runNotes,
    projectKey: 'project-a',
    auditPromptRoot: fixtureValue.promptRoot,
  });
  const sources = await adapter.list({ projectKey: 'project-a' });
  assert.deepEqual(sources.map((source) => source.target), ['project-agents']);
});

test('malformed run manifests fail as invalid sources instead of leaking runtime errors', async () => {
  const { adapter, runNotes } = await fixture();
  await writeFile(join(runNotes, 'session-a.manifest.json'), 'null\n', 'utf8');

  await assert.rejects(
    adapter.readSession({ projectKey: 'project-a', taskId: 'task-a', sessionRef: 'session-a' }),
    (error: unknown) => error instanceof MemorySourceError && error.code === 'memory-source-invalid',
  );
});

test('malformed session records fail as invalid sources', async () => {
  const { adapter, writeSessionFile } = await fixture();
  await writeSessionFile('null\n');

  await assert.rejects(
    adapter.readSession({ projectKey: 'project-a', taskId: 'task-a', sessionRef: 'session-a' }),
    (error: unknown) => error instanceof MemorySourceError && error.code === 'memory-source-invalid',
  );
});

test('audit prompt revision is stable per snapshot and changes after source replacement', async () => {
  const { adapter, writePrompt } = await fixture();
  const first = await adapter.readPrompt({ projectKey: 'project-a', promptRef: 'project-memory-audit' });
  const firstAgain = await adapter.readPrompt({ projectKey: 'project-a', promptRef: 'project-memory-audit' });
  assert.equal(first.revision, firstAgain.revision);
  assert.equal(first.digest, firstAgain.digest);

  await writePrompt('## New Prompt\n');
  const second = await adapter.readPrompt({ projectKey: 'project-a', promptRef: 'project-memory-audit' });
  assert.notEqual(second.revision, first.revision);
  assert.notEqual(second.digest, first.digest);
});

test('audit prompt refs reject typed source paths until manifest resolution is implemented', async () => {
  const { adapter } = await fixture();
  await assert.rejects(
    adapter.readPrompt({ projectKey: 'project-a', promptRef: 'source://project-a/project-memory-audit@r2' }),
    (error: unknown) => error instanceof MemorySourceError && error.code === 'memory-source-invalid',
  );
  await assert.rejects(
    adapter.readPrompt({ projectKey: 'project-a', promptRef: 'nested/project-memory-audit' }),
    (error: unknown) => error instanceof MemorySourceError && error.code === 'memory-source-invalid',
  );
});

test('project and audit sources escape their allowlisted roots when canonical realpath leaves the root', async () => {
  const f = await fixture({ writeSkill: false });
  const outside = await mkdtemp(join(tmpdir(), 'humanagent-source-outside-'));
  await writeFile(join(outside, 'SKILL.md'), '# outside\n', 'utf8');
  await rm(join(f.skillRoot, 'project-a'), { recursive: true });
  await mkdir(f.skillRoot, { recursive: true });
  await symlink(outside, join(f.skillRoot, 'project-a'), 'dir');

  await assert.rejects(
    f.adapter.readProject({ projectKey: 'project-a', target: 'project-local-skill' }),
    /resolves outside/,
  );
});
