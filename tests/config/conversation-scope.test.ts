import assert from 'node:assert/strict'
import test from 'node:test'
import { symlinkSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIRMED_LEGACY_ALEX_BINDING, resolveConversationScope, resolveOptionalAlexReadonlyInventoryRoot, validateLegacyAlexBinding } from '../../packages/config/src/conversation-scope.js'

const base = {
  internal: { ceoAgentId: 'alex-agent' },
  user: { agents: [
    { agentId: 'alex-agent', roleId: 'interaction' as const, managementRole: 'ceo' as const },
    { agentId: 'jenny-agent', roleId: 'interaction' as const, managementRole: 'project-lead' as const },
  ], project: {} },
  projects: [{ projectKey: 'project-a', workspaceCwd: '/tmp/project-a', projectRoot: '/tmp', checkpointsRoot: '/tmp' }],
  machineName: 'machine',
}

test('config resolves Alex and project Jenny as different canonical scopes', () => {
  const alex = resolveConversationScope({ kind: 'alex' }, base)
  const project = resolveConversationScope({ kind: 'project', projectKey: 'project-a' }, base)
  assert.deepEqual({ address: alex.canonicalAddress, role: alex.role, project: alex.projectKey }, { address: 'machine.CEO', role: 'ceo', project: undefined })
  assert.deepEqual({ address: project.canonicalAddress, role: project.role, project: project.projectKey }, { address: 'machine.project-a.Jenny', role: 'project-lead', project: 'project-a' })
})

test('config rejects unknown projects and invalid legacy bindings', () => {
  assert.throws(() => resolveConversationScope({ kind: 'project', projectKey: 'missing' }, base), /not declared/)
  assert.throws(() => validateLegacyAlexBinding({ legacySessionRef: '50660', scope: { kind: 'alex' }, preservedInteractionRefs: ['interaction-1'], preservedTaskRefs: [], sourceEvidenceRef: 'evidence' }), /50661/)
  assert.deepEqual(validateLegacyAlexBinding({ legacySessionRef: '50661', scope: { kind: 'alex' }, preservedInteractionRefs: ['interaction-1'], preservedTaskRefs: ['task-a'], sourceEvidenceRef: '50661回执' }).preservedTaskRefs, ['task-a'])
  assert.deepEqual(validateLegacyAlexBinding(CONFIRMED_LEGACY_ALEX_BINDING), CONFIRMED_LEGACY_ALEX_BINDING)
})

test('config rejects a project default that points at Alex or a duplicate Agent identity', () => {
  assert.throws(() => resolveConversationScope({ kind: 'project', projectKey: 'project-a' }, {
    ...base, user: { ...base.user, project: { defaultAgent: 'alex-agent' } },
  }), /project interaction Agent/)
  assert.throws(() => resolveConversationScope({ kind: 'alex' }, {
    ...base, user: { ...base.user, agents: [...base.user.agents, base.user.agents[0]!] },
  }), /declared more than once/)
})

test('config does not reuse the CEO as a project Jenny fallback', () => {
  assert.throws(() => resolveConversationScope({ kind: 'project', projectKey: 'project-a' }, {
    ...base, user: { agents: [base.user.agents[0]!], project: {}, },
  }), /no interaction Agent|project interaction Agent/)
})

test('config rejects ambiguous project interaction Agents without an explicit default', () => {
  assert.throws(() => resolveConversationScope({ kind: 'project', projectKey: 'project-a' }, {
    ...base, user: { ...base.user, agents: [...base.user.agents, { agentId: 'jenny-two', roleId: 'interaction' as const, managementRole: 'project-lead' as const }] },
  }), /multiple project interaction Agents/)
})

// Confirmed failure: home discovery granted inventory without operator opt-in.
// Impact: unintended filesystem access. Cost: two small temporary fixtures.
test('Alex inventory requires explicit opt-in even when the home symlink exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'humanagent-inventory-root-'))
  try {
    const authorized = join(home, 'Documents', 'github')
    await mkdir(authorized, { recursive: true })
    symlinkSync(join('Documents', 'github'), join(home, 'github'))
    assert.equal(await resolveOptionalAlexReadonlyInventoryRoot(), undefined)
    assert.equal(await resolveOptionalAlexReadonlyInventoryRoot(authorized), await realpath(authorized))
    assert.equal(await resolveOptionalAlexReadonlyInventoryRoot(join(home, 'github')), await realpath(authorized))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Alex rejects explicit relative, missing, file and filesystem roots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'humanagent-inventory-root-reject-'))
  try {
    await writeFile(join(home, 'file'), 'not a directory')
    await assert.rejects(() => resolveOptionalAlexReadonlyInventoryRoot('github'), /explicit absolute directory/)
    await assert.rejects(() => resolveOptionalAlexReadonlyInventoryRoot(''), /explicit absolute directory/)
    await assert.rejects(() => resolveOptionalAlexReadonlyInventoryRoot(join(home, 'missing')), /invalid Alex inventory root/)
    await assert.rejects(() => resolveOptionalAlexReadonlyInventoryRoot(join(home, 'file')), /invalid Alex inventory root/)
    await assert.rejects(() => resolveOptionalAlexReadonlyInventoryRoot('/'), /invalid Alex inventory root/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
