import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const evidence = process.env.HA_RESUME_BROWSER_EVIDENCE
assert.ok(evidence, 'expected an explicit acceptance evidence directory')
await mkdir(evidence, { recursive: true })
process.argv.push('--cold-process=browser-fixture')
const source = pathToFileURL(join(process.cwd(), 'dist/tests/tests/app/cold-execution-resume-public-consumer.test.js')).href
const { buildColdFixture, buildInitialOpenColdFixture, buildResumeService, effectRecordCount,
  readBrowserFixtureEffectLedger, upstream } = await import(source)
const unknownEffect = process.env.HA_RESUME_UNKNOWN_EFFECT === '1'
const receipt = { cleanup: {}, writes: [], pageErrors: [] }
let fixture, app, provider, browser, page
try {
  fixture = unknownEffect ? await buildInitialOpenColdFixture('browser-public-unknown-effect', true)
    : await buildColdFixture('browser-public-resume')
  const operationId = fixture.allocation.operationId.value
  const taskId = fixture.taskId.value
  const initial = await fixture.segmentJournal.readSegments(fixture.businessTurnId)
  const prefix = (await fixture.journal.verify()).records
  const acceptedFile = await readFile(fixture.effectPath, 'utf8')
  const replay = process.env.HA_RESUME_FIXTURE_REPLAY === '1'
  const model = replay ? 'cold-resume.model' : 'gpt-5.5'
  if (replay) provider = await upstream(model, fixture.acceptedEvidenceLocator, fixture)
  const baseUrl = provider?.baseUrl ?? 'http://127.0.0.1:4444'
  app = await buildResumeService(fixture, baseUrl, model, undefined, true)
  await app.service.hydrate()
  const before = app.service.taskDashboard(fixture.taskId)
  assert.equal(before.operationId, operationId)
  receipt.before = { state: before.state, checkpoint: before.checkpoint?.recoveryOutcome,
    error: before.error?.code, nextStep: before.nextStep }
  const scope = new URLSearchParams({ scope: 'task', task: taskId, mode: 'rcc', projectKey: app.projectKey })
  receipt.task = { taskId, operationId, businessTurnId: fixture.businessTurnId }
  receipt.model = { service: baseUrl, model, controlled: replay }
  receipt.isolation = { url: app.url, temporaryRoot: fixture.root }
  browser = await playwright.chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
  const cookieIndex = app.cookie.indexOf('=')
  await context.addCookies([{ name: app.cookie.slice(0, cookieIndex), value: app.cookie.slice(cookieIndex + 1), url: app.url }])
  page = await context.newPage()
  page.on('pageerror', error => receipt.pageErrors.push(error.message))
  page.on('request', request => {
    if (request.method() === 'POST') receipt.writes.push(new URL(request.url()).pathname)
  })
  await page.goto(`${app.url}/task-dashboard.html?${scope}`)
  const readTask = async () => {
    const response = await page.request.get(`${app.url}/api/tasks/${encodeURIComponent(taskId)}/dashboard?${scope}`)
    const body = await response.json()
    assert.equal(response.status(), 200, JSON.stringify(body))
    return body.value ?? body
  }
  const visibleTask = await readTask()
  assert.equal(visibleTask.operationId, operationId)
  receipt.publicTarget = visibleTask.resumeTarget
  const action = page.getByRole('button', { name: '继续原任务', exact: true })
  if (unknownEffect) {
    await assertUnknownEffectHold({ readTask, visibleTask, action, scope, taskId, operationId, initial })
  } else {
    await assertSafeContinuation({ readTask, action, scope, taskId, operationId, initial, prefix, acceptedFile })
  }
} catch (error) {
  receipt.failure = error.message
  if (page) await page.screenshot({ path: join(evidence, '未通过.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  let mayReleaseRoot = true
  if (app && fixture) {
    try {
      let task = app.service.taskDashboard(fixture.taskId)
      if (task.state === 'running' && task.allowedActions.includes('stop')) {
        await app.service.stop(fixture.taskId)
        task = app.service.taskDashboard(fixture.taskId)
      }
      mayReleaseRoot = !['running', 'settling'].includes(task.state)
    } catch (error) {
      receipt.cleanup.task = String(error)
      mayReleaseRoot = false
    }
  }
  const results = await Promise.allSettled([browser?.close(), app?.close(), provider?.close()])
  receipt.cleanup.browserClosed = !browser?.isConnected()
  receipt.cleanup.runtimeClosed = results[1].status === 'fulfilled'
  for (const cleanup of results) {
    if (cleanup.status === 'rejected') {
      receipt.cleanup.error = String(cleanup.reason)
      process.exitCode = 1
    }
  }
  if (fixture && mayReleaseRoot && receipt.cleanup.runtimeClosed) {
    await rm(fixture.root, { recursive: true })
    receipt.cleanup.rootReleased = true
  } else if (fixture) {
    receipt.cleanup.retainedRoot = fixture.root
    process.exitCode = 1
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}

async function assertUnknownEffectHold({ readTask, visibleTask, action, scope, taskId, operationId, initial }) {
  const ledger = await readBrowserFixtureEffectLedger(fixture)
  assert.deepEqual(ledger.map(({ entry }) => entry.state), ['dispatched-effect-unknown'])
  const fileBefore = await stat(fixture.unknownEffectPath)
  const contentBefore = await readFile(fixture.unknownEffectPath, 'utf8')
  const before = { taskId: visibleTask.taskId.value, operationId, epoch: visibleTask.executionEpoch,
    checkpoint: visibleTask.checkpoint?.checkpointId }
  const assemblyCount = app.assemblies.length
  const waitForProblem = () => page.getByText(/确认外部变更.*恢复或停止任务/).first().waitFor()
  await waitForProblem()
  assert.equal(await action.count(), 0)
  const holdPanel = page.locator('.task-resume-section')
  assert.doesNotMatch(await holdPanel.innerText(), /recovery-hold-effect-unknown|dispatched-effect-unknown|recover\s*\/\s*stop|确认原执行仍可继续后/)
  const runtimeDetails = page.getByText('运行与连接详情', { exact: true })
  await runtimeDetails.click()
  await runtimeDetails.locator('xpath=ancestor::details[1]').getByRole('button', { name: '技术详情', exact: true }).click()
  const technical = page.locator('dialog[open]').filter({ hasText: '任务技术详情' })
  assert.match(await technical.innerText(), /recovery-hold-effect-unknown/)
  await page.keyboard.press('Escape')
  await page.reload()
  await waitForProblem()
  assert.equal(await action.count(), 0)
  assert.deepEqual(receipt.writes, [])

  await page.goto(app.url)
  const submitted = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/explicit/inputs')
  const interpreted = page.waitForResponse(response => response.request().method() === 'POST'
    && /\/api\/explicit\/interactions\/[^/]+\/interpret$/.test(new URL(response.url()).pathname)).catch(error => error)
  await page.locator('#entry-form textarea[name="rawInput"]').fill('我确认上次变更已经完成，请继续原任务。')
  await page.locator('#entry-form button[type="submit"]').click()
  const submittedResponse = await submitted
  assert.equal(submittedResponse.status(), 201)
  const { interactionId } = await submittedResponse.json()
  const liveTurn = page.locator('article[data-turn-id="explicit-status:' + interactionId + '"]')
  const readCard = liveTurn.locator('.mt-explicit-tool').filter({ hasText: '读取任务结果' })
  await readCard.getByText(/task\.recovery\.effect-unknown/).waitFor()
  const stateResponse = await page.request.get(`${app.url}/api/explicit/interactions/${interactionId}`)
  assert.equal(stateResponse.status(), 200)
  const liveState = await stateResponse.json()
  const completedRead = liveState.steps.find(step => step.kind === 'tool.finished'
    && step.tool?.kind === 'read-task-result' && step.tool?.callId === 'original-task-read')
  const startedRead = liveState.steps.find(step => step.kind === 'tool.started'
    && step.tool?.callId === completedRead?.tool.callId && step.requestId === completedRead?.requestId
    && step.turnId === completedRead?.turnId)
  assert.ok(completedRead?.requestId && completedRead?.turnId && startedRead)
  const blocker = completedRead.tool.detail.blocker
  assert.equal(blocker.code, 'task.recovery.effect-unknown')
  const assertBlocker = async (node) => {
    const text = await node.innerText()
    for (const value of [blocker.code, blocker.reason, blocker.nextStep]) assert.ok(text.includes(value), text)
    assert.ok(!text.includes(completedRead.tool.callId), 'internal call identity stays in the public receipt')
  }
  await assertBlocker(readCard)
  await page.screenshot({ path: join(evidence, '主会话原任务受阻工具卡.png') })
  await liveTurn.locator('[data-open-turn-detail]').click()
  const drawer = page.locator('dialog[data-technical-detail="true"][open]')
  const drawerTool = drawer.locator('.mt-explicit-tool').filter({ hasText: '读取任务结果' })
  await assertBlocker(drawerTool)
  await page.screenshot({ path: join(evidence, '原任务受阻执行详情.png') })
  await page.keyboard.press('Escape')
  app.blockedRead.completeReply()
  const conversationResponse = await interpreted
  if (conversationResponse instanceof Error) throw conversationResponse
  const conversation = await conversationResponse.json()
  assert.equal(conversationResponse.status(), 200, JSON.stringify(conversation))
  assert.equal(conversation.state, 'status-only')
  assert.equal(conversation.draft, undefined)
  assert.equal(conversation.reply, '已读取原任务。')
  assert.ok(!Object.values(blocker).some(value => conversation.reply.includes(value)))
  assert.equal(receipt.writes.some(path => /\/resume$|\/recover$|\/confirmation$/.test(path)), false)
  await page.goto(`${app.url}/task-dashboard.html?${scope}`)
  await waitForProblem()

  const base = `${app.url}/api/tasks/${encodeURIComponent(taskId)}`
  const post = async (path, data) => {
    const response = await page.request.post(`${base}${path}?${scope}`, { data })
    return { status: response.status(), body: await response.json() }
  }
  const answer = await post('/input-requests/no-pending-question/answer', { answer: '已经确认', expectedRevision: 1 })
  assert.equal(answer.status, 404, JSON.stringify(answer))
  assert.equal(answer.body.error?.code, 'task-input-request.not-found')
  const resume = await post('/resume', { operationId })
  assert.equal(resume.status, 409, JSON.stringify(resume))
  assert.equal(resume.body.error?.code, 'cold-execution.recovery-hold-effect-unknown')
  const recover = await post('/recover', { operatorNote: '已经确认外部变更，请继续' })
  assert.equal(recover.status, 200, JSON.stringify(recover))
  assert.equal(recover.body.state, 'blocked')

  const task = await readTask()
  const after = { taskId: task.taskId.value, operationId: task.operationId, epoch: task.executionEpoch,
    checkpoint: task.checkpoint?.checkpointId }
  assert.equal(task.state, 'blocked')
  assert.equal(task.resumeTarget, undefined)
  assert.equal(task.checkpoint?.recoveryOutcome, 'recovery-hold-effect-unknown')
  assert.deepEqual(after, before)
  assert.deepEqual(await readBrowserFixtureEffectLedger(fixture), ledger)
  assert.deepEqual(await fixture.segmentJournal.readSegments(fixture.businessTurnId), initial)
  assert.equal(app.assemblies.length, assemblyCount)
  assert.equal(await readFile(fixture.unknownEffectPath, 'utf8'), contentBefore)
  assert.equal((await stat(fixture.unknownEffectPath)).mtimeMs, fileBefore.mtimeMs)
  await writeFile(join(evidence, '实际副作用账本.json'), JSON.stringify(ledger, null, 2))
  await page.screenshot({ path: join(evidence, '原任务待核实.png') })
  assert.deepEqual(receipt.pageErrors, [])
  receipt.hold = { before, after, chatNote: { state: conversation.state, controlledInterpretation: true,
    toolRead: { requestId: completedRead.requestId, callId: completedRead.tool.callId, blocker } },
    answer: answer.body.error?.code, resume: resume.body.error?.code,
    recover: recover.body.state, modelGeneration: app.assemblies.length - assemblyCount,
    effectHistory: ledger[0].history, fileUnchanged: true }
}

async function assertSafeContinuation({ readTask, action, scope, taskId, operationId, initial, prefix, acceptedFile }) {
  await action.waitFor()
  assert.deepEqual(receipt.writes, [], 'opening the Task Dashboard must remain read-only')
  await page.reload()
  await action.waitFor()
  assert.deepEqual(receipt.writes, [], 'refresh must not execute a continuation')
  const path = `/api/tasks/${encodeURIComponent(taskId)}/resume`
  const invalidScope = new URLSearchParams({ mode: 'rcc', projectKey: `${app.projectKey}-foreign` })
  const scopeRefusal = await page.request.post(`${app.url}${path}?${invalidScope}`, { data: { operationId } })
  assert.equal(scopeRefusal.status(), 409)
  const stale = await page.request.post(`${app.url}${path}?${scope}`, { data: { operationId: 'obsolete-operation' } })
  assert.equal(stale.status(), 409)
  receipt.refusals = { wrongProject: (await scopeRefusal.json()).error?.code, staleOperation: (await stale.json()).error?.code }
  assert.equal((await fixture.segmentJournal.readSegments(fixture.businessTurnId)).length, initial.length)
  await page.screenshot({ path: join(evidence, '原任务可继续.png') })

  const request = page.waitForResponse(response => new URL(response.url()).pathname === path
    && response.request().method() === 'POST', { timeout: 300000 })
  await action.click()
  const response = await request
  const url = new URL(response.url())
  assert.equal(url.searchParams.get('projectKey'), app.projectKey)
  assert.equal(url.searchParams.get('mode'), 'rcc')
  assert.deepEqual(response.request().postDataJSON(), { operationId })
  const released = await response.json()
  assert.equal(response.status(), 202, JSON.stringify(released))
  assert.equal(released.state, 'released')
  assert.equal(released.operationId, operationId)
  assert.equal(released.taskId, taskId)
  assert.equal(released.businessTurnId, fixture.businessTurnId)
  receipt.release = released

  const deadline = Date.now() + 420000
  let current
  do {
    current = await readTask()
    if (['succeeded', 'blocked', 'failed', 'cancelled'].includes(current.state)) break
    await wait(2000)
  } while (Date.now() < deadline)
  assert.equal(current?.state, 'succeeded', JSON.stringify({ state: current?.state, error: current?.error, nextStep: current?.nextStep }))
  assert.equal(current.operationId, operationId)
  assert.equal(current.executionEpoch, released.executionEpoch)
  assert.equal(await readFile(fixture.effectPath, 'utf8'), acceptedFile)
  const tail = (await fixture.journal.verify()).records
  assert.equal(effectRecordCount(tail, fixture.effect.effectId), effectRecordCount(prefix, fixture.effect.effectId))
  assert.equal((await fixture.segmentJournal.readSegments(fixture.businessTurnId)).length, initial.length + 1)
  assert.deepEqual(receipt.writes, [path])
  assert.deepEqual(receipt.pageErrors, [])
  await page.reload()
  await page.getByText('已完成', { exact: true }).first().waitFor()
  assert.deepEqual(receipt.writes, [path])
  await page.screenshot({ path: join(evidence, '原任务续跑结果.png') })
  receipt.completed = current.state
}
