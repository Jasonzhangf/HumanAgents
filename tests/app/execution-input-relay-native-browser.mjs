#!/usr/bin/env node

import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidenceRoot = process.env.EXECUTION_INPUT_RELAY_EVIDENCE?.trim()
if (!evidenceRoot) {
  throw new Error('EXECUTION_INPUT_RELAY_EVIDENCE is required')
}
await mkdir(evidenceRoot, { recursive: true })

const distFile = (relativePath) => pathToFileURL(join(repoRoot, 'dist', 'app', relativePath)).href

const { id } = await import(distFile('contracts/src/index.js'))
const { ensureControlLayout, resolveRuntimePaths } = await import(distFile('config/src/index.js'))
const { AccessControlService } = await import(distFile('app/src/ui-runtime/access-control.js'))
const { FakeReplayExecutionRuntimePort, startUiRuntime } = await import(distFile('app/src/ui-runtime/index.js'))
const { DeterministicMemoryBackend } = await import(distFile('adapters/memory/src/index.js'))
const { MemoryCoordinator } = await import(distFile('runtime/src/index.js'))
const { JsonlOrganJournal, JsonlTaskIdentityJournal } = await import(distFile('adapters/jsonl/src/index.js'))
const { JsonlTaskGrantJournal } = await import(distFile('adapters/jsonl/src/task-grants.js'))
const { TaskIdentityConsumer } = await import(distFile('runtime/src/orchestration/task-identity.js'))
const { AgentRuntimePoolManager, OrchestrationManager } = await import(distFile('runtime/src/orchestration/index.js'))
const {
  createAgentProviderPort,
  prepareAgentProvider,
  prepareExecutionAgentProvider,
} = await import(distFile('app/src/agent-driver-composition.js'))

const organId = id('organ', 'execution-input-relay-native-browser')
const upstreamOrigin = 'http://127.0.0.1:4599'
const binding = {
  bindingId: 'execution-input-relay-native-binding',
  providerId: 'rcc',
  protocol: 'responses',
  endpointRef: upstreamOrigin,
  modelRef: 'execution-input-relay-model',
  configDigest: 'sha256:execution-input-relay-config',
  capabilityDigest: 'sha256:execution-input-relay-capability',
}
let projectKey = 'execution-input-relay-native'

function sseResponse(frames) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function responsesWire(body) {
  const parsed = parseJson(body)
  return typeof parsed === 'object' && parsed !== null ? parsed : null
}

function plannerPayloadFrom(body) {
  for (const item of responsesWire(body)?.input ?? []) {
    if (item?.type !== 'message' || item?.role !== 'user') continue
    for (const part of item?.content ?? []) {
      if (part?.type !== 'input_text' || typeof part?.text !== 'string') continue
      const candidate = parseJson(part.text)
      if (candidate?.role === 'planner') return candidate
    }
  }
  return undefined
}

function replaysTurnEnd(body) {
  return (responsesWire(body)?.input ?? []).some(
    (item) => item?.type === 'function_call' && item?.name === 'humanagent_turn_end',
  )
}

function advertisesTurnEnd(body) {
  return (responsesWire(body)?.tools ?? []).some(
    (tool) => tool?.name === 'humanagent_turn_end',
  )
}

function captureTerminalUpstream(deliveryText) {
  const requests = []
  const inputRequestArguments = []
  const completedArguments = []
  const original = globalThis.fetch
  let inputRequestCount = 0
  const capture = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).origin !== upstreamOrigin) return original(input, init)
    const body = typeof init.body === 'string' ? init.body : ''
    requests.push({ method: (init.method ?? 'GET').toUpperCase(), url, body })

    const planner = plannerPayloadFrom(body)
    if (planner !== undefined) {
      const task = planner.task ?? {}
      const title = typeof task.title === 'string' ? task.title : 'Relay task'
      const directive = typeof task.directive === 'string' ? task.directive : 'Complete the relay task'
      return sseResponse([
        { type: 'response.created', response: { id: 'relay-planner' } },
        { type: 'response.output_text.done', item_id: 'relay-planner', text: JSON.stringify({
          decision: 'complete',
          snapshot: {
            title,
            summary: `Completed ${title}`,
            completeness: { scope: 'whole-task', status: 'complete' },
            acceptanceCriteria: [{ criterionId: 'relay-complete', description: `Satisfy ${directive}` }],
            nodes: [{ nodeId: 'relay-task', kind: 'task', title, intent: directive, definition: { directive } }],
            phases: [],
            relations: [],
          },
          reasonText: 'The relay task reached its final delivery',
        }) },
        { type: 'response.completed', response: { id: 'relay-planner' } },
      ])
    }

    if (replaysTurnEnd(body)) {
      return sseResponse([
        { type: 'response.created', response: { id: 'relay-drain' } },
        { type: 'response.output_text.done', item_id: 'relay-drain', text: 'drained' },
        { type: 'response.completed', response: { id: 'relay-drain' } },
      ])
    }

    if (advertisesTurnEnd(body)) {
      if (inputRequestCount === 0) {
        inputRequestCount += 1
        const args = {
          outcome: 'input-required',
          summary: {
            goal: 'Complete the relay task',
            actions: ['Detected the missing user fact'],
            result: { status: 'partial', text: 'Waiting for the user answer' },
            nextStep: 'Ask the user for the deployment environment',
          },
          inputRequest: {
            question: '请补充部署目标。',
            schemaRef: 'humanagent://input/text/v1',
            reason: '任务缺少部署目标，无法继续执行。',
            impact: '当前任务停止，等待用户回答。',
          },
          deliveryRefs: [],
        }
        inputRequestArguments.push(args)
        return sseResponse([
          { type: 'response.created', response: { id: 'relay-input-request' } },
          { type: 'response.output_item.done', output_index: 0, item: {
            type: 'function_call', call_id: 'relay-input-request', name: 'humanagent_turn_end', arguments: JSON.stringify(args),
          } },
          { type: 'response.completed', response: { id: 'relay-input-request' } },
        ])
      }
      const args = {
        outcome: 'completed',
        summary: {
          goal: 'Complete the relay task',
          actions: ['Consumed the user answer'],
          result: { status: 'completed', text: deliveryText },
          nextStep: 'Deliver the final result',
        },
        deliveryRefs: [],
      }
      completedArguments.push(args)
      return sseResponse([
        { type: 'response.created', response: { id: 'relay-complete' } },
        { type: 'response.output_item.done', output_index: 0, item: {
          type: 'function_call', call_id: 'relay-complete', name: 'humanagent_turn_end', arguments: JSON.stringify(args),
        } },
        { type: 'response.completed', response: { id: 'relay-complete' } },
      ])
    }

    throw new Error(`the controlled upstream received an unidentified Responses request: ${body.slice(0, 200)}`)
  }
  globalThis.fetch = capture
  return {
    requests,
    inputRequestArguments,
    completedArguments,
    restore: () => { globalThis.fetch = original },
  }
}

const createInterpreter = {
  async interpret(input) {
    return {
      kind: 'requirement',
      normalizedInput: input.rawInput,
      knownFacts: [],
      intent: 'create',
      proposal: input.rawInput,
      structuredProposal: {
        revision: input.inputRevision,
        intent: 'create',
        title: input.rawInput,
        objective: input.rawInput,
        deliverable: `complete ${input.rawInput}`,
        deliveryConditions: [],
        evidenceRefs: [],
        blockingGaps: [],
      },
      decisionRefs: [],
    }
  },
}

class GrantPreparingIdentityJournal {
  constructor(inner, grants, principalOwner) {
    this.inner = inner
    this.grants = grants
    this.principalOwner = principalOwner
  }

  async append(input) {
    const record = await this.inner.append(input)
    const existing = await this.grants.readTaskGrant(record.scope.taskId)
    if (existing.grant === null) {
      await this.grants.grant({
        requestId: `relay-grant:${record.scope.taskId.value}`,
        taskId: record.scope.taskId,
        owner: this.principalOwner,
        capability: {
          actionId: 'task.execute',
          capabilities: ['provider.execution'],
          scope: { organId: record.scope.organId, taskId: record.scope.taskId },
        },
        expectedRevision: 0,
      })
    }
    return record
  }

  replay(scope) {
    return this.inner.replay(scope)
  }
}

function taskControlPathFor(checkpointRoot, mode = 'rcc') {
  return join(checkpointRoot, mode, 'task-control.jsonl')
}

function memoryFor(projectKey) {
  return {
    coordinator: new MemoryCoordinator(),
    backend: new DeterministicMemoryBackend(),
    projectKey,
    roleId: 'execution',
  }
}

async function submitNewTask(runtime, cookie, suffix, title, directive) {
  const post = async (path, body) => fetch(`${runtime.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  const receive = await post('/api/explicit/inputs', {
    sourceRef: `ui:${suffix}`,
    rawInput: `create ${title}: ${directive}`,
    channel: 'business',
    requestKind: 'new-task-create',
  })
  assert.equal(receive.status, 201)
  const { interactionId } = await receive.json()
  const interpret = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/interpret`, {})
  assert.equal(interpret.status, 200)
  const inspected = await (await fetch(
    `${runtime.server.url}/api/explicit/interactions/${encodeURIComponent(interactionId)}`,
    { headers: { cookie } },
  )).json()
  assert.ok(inspected.draft)
  assert.ok(inspected.revision)
  const confirmation = await post(`/api/explicit/interactions/${encodeURIComponent(interactionId)}/confirmation`, {
    interactionId,
    draftId: inspected.draft.draftId,
    inputRevision: 1,
    confirmationRef: `confirmation:${suffix}`,
    confirmedBy: 'human:operator',
    confirmedAt: new Date().toISOString(),
    payloadRef: `asset://requirements/${suffix}`,
    requestKind: 'new-task-create',
    draftRevisionVersion: inspected.revision.revisionVersion,
    draftRevisionHash: inspected.revision.revisionHash,
  })
  assert.equal(confirmation.status, 200)
  return { interactionId, receipt: await confirmation.json() }
}

async function waitForAsync(assertion, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError ?? new Error('waitForAsync timed out')
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'execution-input-relay-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const paths = await resolveRuntimePaths({ workspace, controlRoot: join(root, 'control') })
  await ensureControlLayout(paths)
  projectKey = paths.projectKey
  const deliveryText = 'Relay complete: the production environment was confirmed and applied.'
  const upstream = captureTerminalUpstream(deliveryText)
  const accessControl = await AccessControlService.open({
    credentialPath: join(root, 'security', 'web-access.json'),
    create: true,
  })
  const challenge = await accessControl.issuePairingChallenge()
  const session = await accessControl.consumePairingCode(challenge.code)
  const cookie = accessControl.sessionCookie(session).split(';')[0]
  const principalOwner = accessControl.readProductPrincipalOwner()
  const taskControlPath = taskControlPathFor(paths.checkpointsRoot)
  const identityWithGrant = new TaskIdentityConsumer(new GrantPreparingIdentityJournal(
    new JsonlTaskIdentityJournal(new JsonlOrganJournal(taskControlPath)),
    new JsonlTaskGrantJournal(new JsonlOrganJournal(taskControlPath)),
    principalOwner,
  ))
  const httpProvider = {
    source: 'http',
    provider: 'http',
    binding: binding.bindingId,
    protocol: 'responses',
    model: binding.modelRef,
    route: 'execution-input-relay',
    baseUrl: upstreamOrigin,
  }
  const entries = [
    { agentId: 'relay-execution', roleId: 'execution', source: 'agent', provider: httpProvider },
    { agentId: 'relay-orchestration', roleId: 'orchestration', source: 'agent', provider: httpProvider },
  ]
  const runEvidenceRoot = join(root, 'evidence')
  await mkdir(runEvidenceRoot, { recursive: true })
  let runtime
  try {
    runtime = await startUiRuntime({
      mode: 'rcc',
      productRoot: root,
      organId,
      binding,
      port: new FakeReplayExecutionRuntimePort({ binding }),
      checkpointRoot: paths.checkpointsRoot,
      evidenceRoot: runEvidenceRoot,
      uiRoot: join(repoRoot, 'docs', 'ui'),
      projectKey,
      workspaceRoot: paths.workspaceCwd,
      runtimePaths: paths,
      projectCatalog: async () => ({
        projects: [{
          projectKey: paths.projectKey,
          projectRoot: paths.projectRoot,
          workspaceCwd: paths.workspaceCwd,
          checkpointsRoot: paths.checkpointsRoot,
        }],
        failures: [],
      }),
      memory: memoryFor(projectKey),
      accessControl,
      explicitBrainInterpreter: createInterpreter,
      providerSource: 'http',
      taskIdentity: identityWithGrant,
      runtimeComposition: {
        prepareAgentProvider: (selection) => prepareAgentProvider({
          roleId: selection.roleId,
          ...(selection.configuredAgentId === undefined ? {} : { configuredAgentId: selection.configuredAgentId }),
          agentProviderBindings: entries,
          legacyProvider: httpProvider,
          evidenceRoot: runEvidenceRoot,
        }),
        prepareTaskAgentProvider: (selection, owner, lease) => prepareExecutionAgentProvider({
          roleId: selection.roleId,
          ...(selection.configuredAgentId === undefined ? {} : { configuredAgentId: selection.configuredAgentId }),
          agentProviderBindings: entries,
          legacyProvider: httpProvider,
          createPort: (selected) => createAgentProviderPort(selected, runEvidenceRoot),
        }, owner, lease),
        createTaskAssembly: ({ executionAgent, maxAttempts }) => {
          const runtimePool = new AgentRuntimePoolManager({
            maxRuntimes: 4,
            ownerId: 'humanagent.runtime.execution-input-relay',
            factory: {
              async start(request) {
                return {
                  runtimeId: request.runtimeId,
                  generation: request.generation,
                  capabilities: [...request.requiredCapabilities],
                }
              },
              async dispose() {},
            },
          })
          return {
            runtimePool,
            orchestration: new OrchestrationManager({
              ownerId: 'humanagent.runtime.execution-input-relay',
              runtimePool,
              ...(executionAgent === undefined ? {} : { executionAgent }),
              ...(maxAttempts === undefined ? {} : { maxAttempts }),
            }),
          }
        },
      },
    })

    const submission = await submitNewTask(runtime, cookie, 'relay-native', '生产环境交付', '需要确认部署环境并继续执行')
    const tasksResponse = await fetch(`${runtime.server.url}/api/tasks`, { headers: { cookie } })
    assert.equal(tasksResponse.status, 200)
    const tasks = await tasksResponse.json()
    const allTasks = [
      ...tasks.running, ...tasks.waiting, ...tasks.completed, ...tasks.stopped, ...tasks.draft, ...tasks.failed,
    ]
    assert.equal(allTasks.length, 1)
    const taskId = allTasks[0].taskId.value
    const dashboardUrl = `/api/tasks/${encodeURIComponent(taskId)}/dashboard?projectKey=${encodeURIComponent(projectKey)}&mode=rcc`
    await waitForAsync(async () => {
      const dashboardResponse = await fetch(`${runtime.server.url}${dashboardUrl}`, { headers: { cookie } })
      const dashboard = await dashboardResponse.json()
      assert.equal(dashboard.state, 'waiting', JSON.stringify(dashboard))
      assert.equal(dashboard.nextStep, '回答后继续同一任务', JSON.stringify(dashboard))
    })
    const decisionResponse = await fetch(
      `${runtime.server.url}/api/product/decision?projectKey=${encodeURIComponent(projectKey)}&mode=rcc&taskId=${encodeURIComponent(taskId)}`,
      { headers: { cookie } },
    )
    const decision = await decisionResponse.json()
    assert.equal(decisionResponse.status, 200)
    assert.equal(decision.kind, 'task-input-request')
    assert.deepEqual(decision.actions, ['answer'])
    assert.equal(decision.request.taskId.value, taskId)
    const requestId = decision.request.requestId
    const expectedRevision = decision.request.expectedRevision

    const browserModule = await import(process.env.EXECUTION_INPUT_RELAY_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js')
    const browser = browserModule.default ?? browserModule
    const browserInstance = await browser.chromium.launch({ headless: true })
    const desktopContext = await browserInstance.newContext({ viewport: { width: 1280, height: 720 } })
    await desktopContext.addCookies([{
      name: cookie.split('=')[0],
      value: cookie.slice(cookie.split('=')[0].length + 1),
      domain: '127.0.0.1',
      path: '/',
    }])
    const desktop = await desktopContext.newPage()
    const consoleErrors = []
    desktop.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    desktop.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
    const taskPath = `/task-dashboard.html?task=${encodeURIComponent(taskId)}&projectKey=${encodeURIComponent(projectKey)}&mode=rcc`
    await desktop.goto(`${runtime.server.url}${taskPath}`, { waitUntil: 'load', timeout: 45_000 })
    await desktop.locator('.product-control-decision[data-product-pending-decision="task-input-request"]').waitFor({ timeout: 45_000 })
    await desktop.locator('[data-product-role="task-input-answer"]').waitFor({ timeout: 45_000 })
    await desktop.locator('[data-product-control-action="answer"]').waitFor({ timeout: 45_000 })
    await desktop.screenshot({ path: join(runEvidenceRoot, 'desktop-waiting.png'), fullPage: true })
    const questionText = await desktop.locator('.product-control-decision-question').innerText()
    assert.equal(questionText.trim(), '请补充部署目标。')
    await desktop.locator('[data-product-role="task-input-answer"]').fill('生产环境')
    const answerResponsePromise = desktop.waitForResponse(
      (response) => response.url().includes('/input-requests/') && response.request().method() === 'POST',
      { timeout: 45_000 },
    )
    await desktop.locator('[data-product-control-action="answer"]').click()
    const answerResponse = await answerResponsePromise
    const answerText = await answerResponse.text()
    const answerBody = JSON.parse(answerText)
    assert.equal(answerResponse.status(), 200, answerText)
    assert.equal(answerBody.taskId.value, taskId)
    assert.equal(answerBody.inputRevision, expectedRevision)
    assert.ok(answerBody.continuation.executionEpoch > decision.request.executionEpoch)

    await waitForAsync(async () => {
      const dashboard = await (await fetch(`${runtime.server.url}${dashboardUrl}`, { headers: { cookie } })).json()
      assert.equal(dashboard.state, 'succeeded')
      assert.equal(dashboard.output, deliveryText)
    }, 45_000)
    await desktop.waitForFunction((expected) => document.body.innerText.includes(expected), deliveryText, { timeout: 45_000 })
    await desktop.screenshot({ path: join(runEvidenceRoot, 'desktop-terminal.png'), fullPage: true })
    await desktopContext.close()

    const mobileContext = await browserInstance.newContext({ viewport: { width: 390, height: 844 } })
    await mobileContext.addCookies([{
      name: cookie.split('=')[0],
      value: cookie.slice(cookie.split('=')[0].length + 1),
      domain: '127.0.0.1',
      path: '/',
    }])
    const mobile = await mobileContext.newPage()
    mobile.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    mobile.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
    await mobile.goto(`${runtime.server.url}${taskPath}`, { waitUntil: 'load', timeout: 45_000 })
    await mobile.waitForFunction((expected) => document.body.innerText.includes(expected), deliveryText, { timeout: 45_000 })
    await mobile.screenshot({ path: join(runEvidenceRoot, 'mobile-terminal.png'), fullPage: true })
    await mobileContext.close()
    await browserInstance.close()
    assert.deepEqual(consoleErrors, [])
    assert.equal(upstream.inputRequestArguments.length, 1)
    assert.equal(upstream.completedArguments.length, 1)
    assert.equal((await fetch(`${runtime.server.url}/api/tasks`, { headers: { cookie } })).status, 200)
    const finalTasks = await (await fetch(`${runtime.server.url}/api/tasks`, { headers: { cookie } })).json()
    assert.equal([
      ...finalTasks.running, ...finalTasks.waiting, ...finalTasks.completed, ...finalTasks.stopped, ...finalTasks.draft, ...finalTasks.failed,
    ].length, 1)
    await writeFile(join(runEvidenceRoot, 'receipt.json'), JSON.stringify({
      taskId,
      requestId,
      expectedRevision,
      answerStatus: answerResponse.status(),
      inputRequestArgument: upstream.inputRequestArguments[0],
      completedArgument: upstream.completedArguments[0],
      consoleErrors,
    }, null, 2))
    for (const name of ['desktop-waiting.png', 'desktop-terminal.png', 'mobile-terminal.png', 'receipt.json']) {
      await copyFile(join(runEvidenceRoot, name), join(evidenceRoot, name))
    }
    console.log(JSON.stringify({ status: 'PASS', taskId, requestId }, null, 2))
  } finally {
    upstream.restore()
    await runtime?.close()
    for (const name of ['desktop-waiting.png', 'desktop-terminal.png', 'mobile-terminal.png', 'receipt.json']) {
      try { await copyFile(join(runEvidenceRoot, name), join(evidenceRoot, name)) } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
}

await main()
