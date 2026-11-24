import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const root = process.env.ENTRY_SEND_QUEUE_UI_ROOT
  ? resolve(process.env.ENTRY_SEND_QUEUE_UI_ROOT)
  : resolve(import.meta.dirname, '../../docs/ui')
const evidence = process.env.ENTRY_SEND_QUEUE_EVIDENCE
if (!evidence) throw new Error('ENTRY_SEND_QUEUE_EVIDENCE is required')
await mkdir(evidence, { recursive: true })

const browser = await playwright.chromium.launch({ headless: true })
const checks = []
const writes = []
const errors = []
const turns = []
let releaseFirst
let releaseSecond
let secondReceived
let releaseFirstReceive
let firstReceiveStarted
let releaseConfirm
let confirmStarted
let rejectReceive = false
const firstReceiveGate = new Promise(done => { releaseFirstReceive = done })
const firstReceive = new Promise(done => { firstReceiveStarted = done })
const confirmGate = new Promise(done => { releaseConfirm = done })
const confirmationStarted = new Promise(done => { confirmStarted = done })
const firstModel = new Promise(done => { releaseFirst = done })
const secondModel = new Promise(done => { releaseSecond = done })
const receiveSecond = new Promise(done => { secondReceived = done })
const current = new Map()
const project = { projectKey: 'queue-proof', projectName: '发送队列验收', agentName: 'Jenny', mode: 'fake', workspaceCwd: '/isolated/queue-proof' }
const check = (name, value) => { assert.ok(value, name); checks.push(name) }
const projection = () => ({ ...project, tasks: [], turns: [...turns] })
const snapshot = id => current.get(id) || { interactionId: id, state: 'received' }
let failure
let page

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) {
      let data
      let status = 200
      if (request.method() !== 'GET') writes.push(url.pathname)
      if (url.pathname === '/api/runtime/status') data = { mode: 'fake', state: 'ready' }
      else if (url.pathname === '/api/main-topic') data = projection()
      else if (url.pathname === '/api/product/session') data = { usage: undefined }
      else if (url.pathname === '/api/dashboard') data = { projects: [{ scope: { projectKey: project.projectKey }, label: project.projectName }] }
      else if (url.pathname === '/api/tasks') data = { draft: [], waiting: [], running: [], completed: [], stopped: [], failed: [] }
      else if (url.pathname === '/api/explicit/inputs' && request.method() === 'POST') {
        if (rejectReceive) return route.fulfill({ status: 503, contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'fixture.receive-failed', message: '未能确认接收' } }) })
        const body = JSON.parse(request.postData() || '{}')
        if (current.size === 0) {
          firstReceiveStarted()
          await firstReceiveGate
        }
        const interactionId = `interaction-${current.size + 1}`
        current.set(interactionId, {
          interactionId,
          rawInput: body.rawInput,
          state: 'matching',
          steps: [{ seq: 1, kind: 'request.dispatched', requestId: `request-${current.size + 1}`,
            turnId: `turn-${current.size + 1}`, occurredAt: new Date().toISOString(), summary: '请求已发出' }],
        })
        turns.push({ turnId: `user:${interactionId}`, interactionId, role: 'user', kind: 'message', text: body.rawInput })
        if (interactionId === 'interaction-2') secondReceived()
        data = { interactionId, occurredAt: new Date().toISOString() }
        status = 201
      } else {
        const match = url.pathname.match(/^\/api\/explicit\/interactions\/([^/]+)(?:\/(.*))?$/)
        if (!match) { status = 404; data = { error: { code: 'fixture.unavailable', message: '未提供该能力' } } }
        else if (match[2] === 'events') { status = 200; data = '' }
        else if (match[2] === 'interpret') {
          const interactionId = match[1]
          if (interactionId === 'interaction-1') await firstModel
          if (interactionId === 'interaction-2') await secondModel
          if (current.get(interactionId)?.rawInput === '确认新任务') {
            current.set(interactionId, { interactionId, rawInput: '确认新任务', state: 'awaiting-confirmation',
              draft: { draftId: 'queue-draft', inputRevision: 1, normalizedInput: '确认新任务',
                proposal: '确认新任务', proposedIntent: 'create' } })
            turns.push({ turnId: `draft:${interactionId}`, interactionId, role: 'jenny', kind: 'draft', text: '确认新任务' })
            data = snapshot(interactionId)
            return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
          }
          const reply = { 'interaction-1': '第一条回答', 'interaction-2': '第二条回答', 'interaction-3': '第三条回答' }[interactionId]
            || `回答：${current.get(interactionId)?.rawInput || interactionId}`
          current.set(interactionId, { interactionId, state: 'answered', reply,
            steps: [{ seq: 2, kind: 'request.answered', occurredAt: new Date().toISOString(), summary: '回答完成' }] })
          turns.push({ turnId: `reply:${interactionId}`, interactionId, role: 'jenny', kind: 'message', text: reply })
          data = snapshot(interactionId)
        } else if (match[2] === 'confirmation') {
          confirmStarted()
          await confirmGate
          const interactionId = match[1]
          current.set(interactionId, { ...snapshot(interactionId), state: 'dispatched',
            confirmation: { draftId: 'queue-draft', inputRevision: 1, confirmationRef: 'confirmation:queue' } })
          data = { requirement: { status: 'submitted', requirementId: 'queue-requirement',
            draftId: 'queue-draft', inputRevision: 1, confirmationRef: 'confirmation:queue' } }
        } else data = snapshot(match[1])
      }
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    assert.ok(path.startsWith(root + '/'))
    await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)], body: await readFile(path) })
  })

  page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://queue-proof.test/')
  const input = page.locator('#entry-form textarea[name=rawInput]')
  const send = page.getByRole('button', { name: '发送给 Jenny', exact: true })

  await input.fill('第一条需要模型处理')
  await send.click()
  await firstReceive
  check('input stays editable while receipt is pending', await input.isEditable())
  await input.fill('第二条排队消息')
  releaseFirstReceive()
  await page.locator('.mt-send-status').getByText('等待模型响应', { exact: false }).waitFor({ timeout: 3000 })
  check('typing during receipt survives the receipt clear', await input.inputValue() === '第二条排队消息')
  check('send unlocked while first model runs', await send.isEnabled())

  await send.click()
  await page.getByText('排队中，等待上一轮处理完成', { exact: true }).waitFor()
  check('second message is visible as a distinct queue item', await page.getByText('第二条排队消息', { exact: true }).count() === 1)
  check('second message is not posted before first settles', writes.filter(path => path.endsWith('/inputs')).length === 1)
  check('queue action clears only the queued draft', await input.inputValue() === '')
  await page.screenshot({ path: resolve(evidence, 'queued-before-first-settle.png'), fullPage: true })

  await input.fill('第二条等待期间的新草稿')
  check('new draft remains editable while queue waits', await input.isEditable())
  releaseFirst()
  await Promise.race([receiveSecond, new Promise((_, reject) => setTimeout(() => reject(new Error('second receive timeout')), 5000))])
  await page.waitForFunction(() => !document.body.innerText.includes('排队中，等待上一轮处理完成'))
  check('first settle starts the queued message once', writes.filter(path => path.endsWith('/inputs')).length === 2)
  check('second text survived the first asynchronous settle', await page.getByText('第二条排队消息', { exact: true }).count() === 1)
  check('later draft survived first answer', await input.inputValue() === '第二条等待期间的新草稿')

  releaseSecond()
  await page.getByText('第二条回答', { exact: true }).waitFor({ timeout: 5000 })
  await page.getByText('第一条回答', { exact: true }).waitFor()
  const texts = await page.locator('.mt-turn').allInnerTexts()
  check('replies retain FIFO order', texts.findIndex(text => text.includes('第一条回答')) < texts.findIndex(text => text.includes('第二条回答')))
  check('later draft survived all model summaries', await input.inputValue() === '第二条等待期间的新草稿')
  check('each message was interpreted once', writes.filter(path => path.endsWith('/inputs')).length === 2
    && writes.filter(path => path.endsWith('/interpret')).length === 2)
  await input.fill('确认新任务')
  await send.click()
  await confirmationStarted
  await input.fill('确认期间继续编辑的新草稿')
  releaseConfirm()
  await page.waitForFunction(() => !document.querySelector('.mt-send-status'))
  check('later draft survives the previous confirmation', await input.inputValue() === '确认期间继续编辑的新草稿')
  const beforeReceiveFailure = writes.filter(path => path.endsWith('/inputs')).length
  const interpretationsBeforeReceiveFailure = writes.filter(path => path.endsWith('/interpret')).length
  rejectReceive = true
  await input.fill('未确认交付的第三条')
  await send.click()
  await page.locator('.mt-send-status').getByText('fixture.receive-failed', { exact: false }).waitFor()
  check('missing third receipt leaves the same draft editable', await input.inputValue() === '未确认交付的第三条'
    && await input.isEditable())
  check('the new send does not reuse the settled interaction', writes.filter(path => path.endsWith('/inputs')).length === beforeReceiveFailure + 1
    && writes.filter(path => path.endsWith('/interpret')).length === interpretationsBeforeReceiveFailure)
  await page.getByRole('button', { name: '重新读取本轮状态', exact: true }).click()
  await page.waitForFunction(() => {
    const form = document.querySelector('#entry-form')
    const button = form?.querySelector('button[type="submit"]')
    return form?.querySelector('textarea')?.value === '未确认交付的第三条'
      && form.querySelector('textarea').isConnected
      && !form.querySelector('textarea').readOnly
      && button?.getAttribute('aria-label') === '发送给 Jenny'
  })
  check('recovery restores the failed draft without reposting it', writes.filter(path => path.endsWith('/inputs')).length === beforeReceiveFailure + 1)
  rejectReceive = false
  await send.click()
  await page.getByText('回答：未确认交付的第三条', { exact: true }).waitFor({ timeout: 5000 })
  check('the restored draft can be deliberately resubmitted once', writes.filter(path => path.endsWith('/inputs')).length === beforeReceiveFailure + 2
    && writes.filter(path => path.endsWith('/interpret')).length === interpretationsBeforeReceiveFailure + 1)
  check('successful receipt clears only the submitted draft', await input.inputValue() === '')
  check('no page errors', errors.length === 0)

  await page.screenshot({ path: resolve(evidence, 'queued-two-turns.png'), fullPage: true })
  await context.close()

  // P1: a queued item that never obtained a receipt keeps its complete
  // submission at the FIFO head while the current draft stays independent.
  {
    writes.length = 0
    errors.length = 0
    turns.length = 0
    current.clear()
    let releaseA
    const aGate = new Promise(done => { releaseA = done })
    let aStarted
    const aStartedGate = new Promise(done => { aStarted = done })
    let releaseConfirmation
    let confirmationStarted
    const confirmationGate = new Promise(done => { releaseConfirmation = done })
    const confirmationStartedGate = new Promise(done => { confirmationStarted = done })
    let rejectB = true
    const inputBodies = []
    const receivedByKey = new Map()
    const confirmationBodies = []
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    await context2.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) {
        let data
        let status = 200
        if (request.method() !== 'GET') writes.push(url.pathname)
        if (url.pathname === '/api/runtime/status') data = { mode: 'fake', state: 'ready' }
        else if (url.pathname === '/api/main-topic') data = projection()
        else if (url.pathname === '/api/product/session') data = { usage: undefined }
        else if (url.pathname === '/api/dashboard') data = { projects: [{ scope: { projectKey: project.projectKey }, label: project.projectName }] }
        else if (url.pathname === '/api/tasks') data = { draft: [], waiting: [], running: [], completed: [], stopped: [], failed: [] }
        else if (url.pathname === '/api/explicit/inputs' && request.method() === 'POST') {
          const body = JSON.parse(request.postData() || '{}')
          inputBodies.push(body)
          const existing = body.idempotencyKey && receivedByKey.get(body.idempotencyKey)
          if (existing) {
            data = existing.receipt
            status = 201
            return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
          }
          const interactionId = `recover-${current.size + 1}`
          current.set(interactionId, { interactionId, rawInput: body.rawInput, state: 'matching' })
          turns.push({ turnId: `user:${interactionId}`, interactionId, role: 'user', kind: 'message', text: body.rawInput })
          const receipt = { interactionId, occurredAt: new Date().toISOString() }
          if (body.idempotencyKey) receivedByKey.set(body.idempotencyKey, { receipt })
          if (body.rawInput === '恢复配置B' && rejectB) {
            rejectB = false
            return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'fixture.receive-failed', message: '接收未确认' } }) })
          }
          data = receipt
          status = 201
        } else {
          const match = url.pathname.match(/^\/api\/explicit\/interactions\/([^/]+)(?:\/(.*))?$/)
          if (!match) { status = 404; data = { error: { code: 'fixture.unavailable', message: '未提供' } } }
          else if (match[2] === 'events') data = ''
          else if (match[2] === 'interpret') {
            const id = match[1]
            const rawInput = current.get(id)?.rawInput
            if (rawInput === '恢复配置A') {
              aStarted()
              await aGate
              current.set(id, { interactionId: id, state: 'answered', reply: 'A完成' })
              turns.push({ turnId: `reply:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: 'A完成' })
            } else if (rawInput === '恢复配置B') {
              current.set(id, { interactionId: id, rawInput, state: 'awaiting-confirmation', draft: { draftId: 'recover-draft', inputRevision: 1,
                normalizedInput: rawInput, proposal: rawInput, proposedIntent: 'create' } })
              turns.push({ turnId: `draft:${id}`, interactionId: id, role: 'jenny', kind: 'draft', text: rawInput })
            } else {
              current.set(id, { interactionId: id, rawInput, state: 'answered', reply: `${rawInput}完成` })
              turns.push({ turnId: `reply:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: `${rawInput}完成` })
            }
            data = snapshot(id)
          } else if (match[2] === 'confirmation') {
            confirmationBodies.push(JSON.parse(request.postData() || '{}'))
            confirmationStarted()
            await confirmationGate
            const id = match[1]
            current.set(id, { ...snapshot(id), state: 'dispatched' })
            turns.push({ turnId: `delivery:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: 'B已交付' })
            data = { requirement: { status: 'submitted', requirementId: 'recover-requirement', draftId: 'recover-draft', inputRevision: 1, confirmationRef: 'confirmation:recover' } }
          } else data = snapshot(match[1])
        }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
      }
      const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      assert.ok(path.startsWith(root + '/'))
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)], body: await readFile(path) })
    })
    try {
      const recoveryPage = await context2.newPage()
      recoveryPage.on('pageerror', error => errors.push(error.message))
      await recoveryPage.goto('http://queue-proof.test/')
      const recoveryInput = recoveryPage.locator('#entry-form textarea[name=rawInput]')
      const recoverySend = recoveryPage.getByRole('button', { name: '发送给 Jenny', exact: true })
      await recoveryInput.fill('恢复配置A')
      await recoverySend.click()
      await aStartedGate
      for (const text of ['恢复配置B', '恢复配置C']) {
        await recoveryInput.fill(text)
        await recoverySend.click()
      }
      await recoveryInput.fill('未提交的新草稿D')
      releaseA()
      await recoveryPage.getByRole('button', { name: '重新读取本轮状态', exact: true }).waitFor()
      check('unconfirmed B keeps the newer draft while it is recovered', await recoveryInput.inputValue() === '未提交的新草稿D')
      const inputsAfterFailure = writes.filter(path => path.endsWith('/inputs')).length
      await recoveryPage.getByRole('button', { name: '重新读取本轮状态', exact: true }).click()
      await recoveryPage.waitForFunction(() => document.body.innerText.includes('恢复配置B'))
      check('recovery itself does not duplicate an unconfirmed submission', writes.filter(path => path.endsWith('/inputs')).length === inputsAfterFailure)
      await recoverySend.click()
      await confirmationStartedGate
      const bInputs = inputBodies.filter(body => body.rawInput === '恢复配置B')
      const bInteractions = [...current.entries()].filter(([, value]) => value.rawInput === '恢复配置B')
      check('lost 201 recovery retries the same stable receive key', bInputs.length === 2
        && typeof bInputs[0].idempotencyKey === 'string'
        && bInputs[0].idempotencyKey === bInputs[1].idempotencyKey
        && bInputs.every(body => body.topicRef === 'main'))
      check('server-persisted B is interpreted once despite the lost 201 receipt', bInteractions.length === 1
        && writes.filter(path => path.endsWith(`/interactions/${bInteractions[0][0]}/interpret`)).length === 1)
      check('B retry preserves D and waits for B before C', writes.filter(path => path.endsWith('/inputs')).length === inputsAfterFailure + 1
        && await recoveryInput.inputValue() === '')
      check('B retry carries its complete original confirmation configuration', confirmationBodies.length === 1
        && confirmationBodies[0].goal === '恢复配置B'
        && confirmationBodies[0].scope === '恢复配置B'
        && typeof confirmationBodies[0].confirmedAt === 'string'
        && confirmationBodies[0].idempotencyKey?.startsWith('ui-entry:')
        && confirmationBodies[0].payloadRef?.startsWith('asset://requirements/ui:')
        && confirmationBodies[0].confirmationRef?.startsWith('confirmation:ui:')
        && confirmationBodies[0].executionPolicy?.executionMode === 'once'
        && confirmationBodies[0].executionPolicy?.policyId?.startsWith('execution-policy:')
        && confirmationBodies[0].executionPolicy?.policyRevision === 1
        && typeof confirmationBodies[0].executionPolicy?.timezone === 'string'
        && typeof confirmationBodies[0].executionPolicy?.canonicalInstant === 'string'
        && typeof confirmationBodies[0].executionPolicy?.dueAt === 'string')
      releaseConfirmation()
      await recoveryPage.getByText('恢复配置C完成', { exact: true }).waitFor({ timeout: 5000 })
      check('C runs once after recovered B succeeds', inputBodies.filter(body => body.rawInput === '恢复配置C').length === 1)
      check('recovery path has no page errors', errors.length === 0)
      await recoveryPage.screenshot({ path: resolve(evidence, 'p1-recovery-fifo.png'), fullPage: true })
    } finally {
      releaseA?.()
      releaseConfirmation?.()
      await context2.close()
    }
  }

  // P1: an already queued existing-task change keeps C blocked until another
  // session's authoritative terminal readback releases the same interactionId.
  {
    writes.length = 0
    errors.length = 0
    turns.length = 0
    current.clear()
    const inputBodies = []
    let releaseA
    let aStarted
    const aGate = new Promise(done => { releaseA = done })
    const aStartedGate = new Promise(done => { aStarted = done })
    let terminalReads = 0
    const context3 = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    await context3.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) {
        let data
        let status = 200
        if (request.method() !== 'GET') writes.push(url.pathname)
        if (url.pathname === '/api/runtime/status') data = { mode: 'fake', state: 'ready' }
        else if (url.pathname === '/api/main-topic') data = projection()
        else if (url.pathname === '/api/product/session') data = { usage: undefined }
        else if (url.pathname === '/api/dashboard') data = { projects: [{ scope: { projectKey: project.projectKey }, label: project.projectName }] }
        else if (url.pathname === '/api/tasks') data = { draft: [], waiting: [], running: [], completed: [], stopped: [], failed: [] }
        else if (url.pathname === '/api/explicit/inputs' && request.method() === 'POST') {
          const body = JSON.parse(request.postData() || '{}')
          inputBodies.push(body)
          const interactionId = `cross-${current.size + 1}`
          current.set(interactionId, { interactionId, rawInput: body.rawInput, state: 'matching' })
          turns.push({ turnId: `user:${interactionId}`, interactionId, role: 'user', kind: 'message', text: body.rawInput })
          data = { interactionId, occurredAt: new Date().toISOString() }
          status = 201
        } else {
          const match = url.pathname.match(/^\/api\/explicit\/interactions\/([^/]+)(?:\/(.*))?$/)
          if (!match) { status = 404; data = { error: { code: 'fixture.unavailable', message: '未提供' } } }
          else if (match[2] === 'events') data = ''
          else if (match[2] === 'interpret') {
            const id = match[1]
            const rawInput = current.get(id)?.rawInput
            if (rawInput === '跨会话A') {
              aStarted()
              await aGate
              current.set(id, { interactionId: id, state: 'answered', reply: '跨会话A完成' })
              turns.push({ turnId: `reply:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: '跨会话A完成' })
            } else if (rawInput === '已有任务变更B') {
              current.set(id, { interactionId: id, rawInput, state: 'awaiting-confirmation', draft: { draftId: 'cross-draft',
                inputRevision: 1, normalizedInput: rawInput, proposal: rawInput, proposedIntent: 'change',
                matchedTasks: [{ relation: 'current', taskId: { scope: 'task', value: 'task-existing' } }] } })
              turns.push({ turnId: `draft:${id}`, interactionId: id, role: 'jenny', kind: 'draft', text: '等待确认任务变更' })
            } else {
              current.set(id, { interactionId: id, state: 'answered', reply: `${rawInput}完成` })
              turns.push({ turnId: `reply:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: `${rawInput}完成` })
            }
            data = snapshot(id)
          } else {
            if (current.get(match[1])?.rawInput === '已有任务变更B') terminalReads++
            data = snapshot(match[1])
          }
        }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
      }
      const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      assert.ok(path.startsWith(root + '/'))
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)], body: await readFile(path) })
    })
    try {
      const crossPage = await context3.newPage()
      crossPage.on('pageerror', error => errors.push(error.message))
      await crossPage.goto('http://queue-proof.test/')
      const crossInput = crossPage.locator('#entry-form textarea[name=rawInput]')
      const crossSend = crossPage.getByRole('button', { name: '发送给 Jenny', exact: true })
      await crossInput.fill('跨会话A')
      await crossSend.click()
      await aStartedGate
      for (const text of ['已有任务变更B', '确认后C']) {
        await crossInput.fill(text)
        await crossSend.click()
      }
      releaseA()
      await crossPage.waitForFunction(() => document.body.innerText.includes('等待确认任务变更'))
      await crossPage.waitForTimeout(1800)
      check('existing-task change holds following C before confirmation', inputBodies.filter(body => body.rawInput === '确认后C').length === 0)
      const queuedB = [...current.entries()].find(([, value]) => value.rawInput === '已有任务变更B')?.[1]
      current.set(queuedB.interactionId, { ...queuedB, state: 'dispatched' })
      turns.push({ turnId: `delivery:${queuedB.interactionId}`, interactionId: queuedB.interactionId, role: 'jenny', kind: 'message', text: '既有任务变更已交付' })
      await crossPage.getByText('确认后C完成', { exact: true }).waitFor({ timeout: 6000 })
      check('same interaction terminal readback releases the queued owner', terminalReads > 0)
      check('C starts once after external terminal readback', inputBodies.filter(body => body.rawInput === '确认后C').length === 1
        && writes.filter(path => path.endsWith('/interpret')).length === 3)
      check('cross-session release path has no page errors', errors.length === 0)
      await crossPage.screenshot({ path: resolve(evidence, 'p1-confirmation-release.png'), fullPage: true })
    } finally {
      releaseA?.()
      await context3.close()
    }
  }

  // P1: a C07 partial continues through the existing same-turn endpoint and C
  // starts only after that original interaction settles.
  {
    writes.length = 0
    errors.length = 0
    turns.length = 0
    current.clear()
    const inputBodies = []
    const continueBodies = []
    let partialBId
    let rejectContinue = true
    let releaseA
    let aStarted
    const aGate = new Promise(done => { releaseA = done })
    const aStartedGate = new Promise(done => { aStarted = done })
    const context4 = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    await context4.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) {
        let data
        let status = 200
        if (request.method() !== 'GET') writes.push(url.pathname)
        if (url.pathname === '/api/runtime/status') data = { mode: 'fake', state: 'ready' }
        else if (url.pathname === '/api/main-topic') data = projection()
        else if (url.pathname === '/api/product/session') data = { usage: undefined }
        else if (url.pathname === '/api/dashboard') data = { projects: [{ scope: { projectKey: project.projectKey }, label: project.projectName }] }
        else if (url.pathname === '/api/tasks') data = { draft: [], waiting: [], running: [], completed: [], stopped: [], failed: [] }
        else if (url.pathname === '/api/explicit/inputs' && request.method() === 'POST') {
          const body = JSON.parse(request.postData() || '{}')
          inputBodies.push(body)
          const interactionId = `partial-${current.size + 1}`
          current.set(interactionId, { interactionId, rawInput: body.rawInput, state: 'matching' })
          turns.push({ turnId: `user:${interactionId}`, interactionId, role: 'user', kind: 'message', text: body.rawInput })
          data = { interactionId, occurredAt: new Date().toISOString() }
          status = 201
        } else {
          const match = url.pathname.match(/^\/api\/explicit\/interactions\/([^/]+)(?:\/(.*))?$/)
          if (!match) { status = 404; data = { error: { code: 'fixture.unavailable', message: '未提供' } } }
          else if (match[2] === 'events') data = ''
          else if (match[2] === 'interpret') {
            const id = match[1]
            const rawInput = current.get(id)?.rawInput
            if (rawInput === 'partialA') {
              aStarted()
              await aGate
              current.set(id, { interactionId: id, state: 'answered', reply: 'partialA完成' })
              turns.push({ turnId: `reply:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: 'partialA完成' })
            } else if (rawInput === 'partialB') {
              partialBId = id
              current.set(id, { interactionId: id, rawInput, state: 'partial', partial: { partialRef: `partial-ref:${id}`, resumed: false } })
            } else {
              current.set(id, { interactionId: id, state: 'answered', reply: `${rawInput}完成` })
              turns.push({ turnId: `reply:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: `${rawInput}完成` })
            }
            data = snapshot(id)
          } else if (match[2] === 'continue') {
            const id = match[1]
            continueBodies.push(JSON.parse(request.postData() || '{}'))
            if (rejectContinue) {
              rejectContinue = false
              return route.fulfill({
                status: 409,
                contentType: 'application/json',
                body: JSON.stringify({ error: {
                  code: 'explicit-brain.partial-invalid',
                  message: 'partial 续跑暂时未完成',
                  ownerId: 'humanagent.runtime.explicit-brain',
                  nextAction: '读取当前 partial 后继续同一轮',
                } }),
              })
            }
            current.set(id, { interactionId: id, state: 'answered', reply: 'partialB已续跑完成', partial: { partialRef: `partial-ref:${id}`, resumed: true } })
            turns.push({ turnId: `reply:${id}`, interactionId: id, role: 'jenny', kind: 'message', text: 'partialB已续跑完成' })
            data = snapshot(id)
          } else data = snapshot(match[1])
        }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
      }
      const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      assert.ok(path.startsWith(root + '/'))
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)], body: await readFile(path) })
    })
    try {
      const partialPage = await context4.newPage()
      partialPage.on('pageerror', error => errors.push(error.message))
      await partialPage.goto('http://queue-proof.test/')
      const partialInput = partialPage.locator('#entry-form textarea[name=rawInput]')
      const partialSend = partialPage.getByRole('button', { name: '发送给 Jenny', exact: true })
      await partialInput.fill('partialA')
      await partialSend.click()
      await aStartedGate
      for (const text of ['partialB', 'partialC']) {
        await partialInput.fill(text)
        await partialSend.click()
      }
      releaseA()
      await partialPage.getByRole('button', { name: '继续本轮处理', exact: true }).waitFor({ timeout: 5000 })
      check('partial C keeps following C blocked before user continuation', inputBodies.filter(body => body.rawInput === 'partialC').length === 0)
      await partialPage.getByRole('button', { name: '继续本轮处理', exact: true }).click()
      await partialPage.getByText('explicit-brain.partial-invalid', { exact: false }).waitFor({ timeout: 5000 })
      check('failed partial continuation keeps the original turn and C queued', inputBodies.filter(body => body.rawInput === 'partialC').length === 0)
      await partialPage.screenshot({ path: resolve(evidence, 'p1-partial-failed.png'), fullPage: true })
      await partialPage.getByRole('button', { name: '继续本轮处理', exact: true }).click()
      await partialPage.getByText('partialB已续跑完成', { exact: true }).waitFor({ timeout: 5000 })
      await partialPage.getByText('partialC完成', { exact: true }).waitFor({ timeout: 5000 })
      check('partial continuation reuses the authoritative partialRef after failure', continueBodies.length === 2
        && continueBodies.every(body => body.partialRef === `partial-ref:${partialBId}`))
      check('partial completion starts C once without a new B input', inputBodies.filter(body => body.rawInput === 'partialB').length === 1
        && inputBodies.filter(body => body.rawInput === 'partialC').length === 1)
      check('partial continuation path has no page errors', errors.length === 0)
      await partialPage.screenshot({ path: resolve(evidence, 'p1-partial-continuation.png'), fullPage: true })
    } finally {
      releaseA?.()
      await context4.close()
    }
  }

  // P1: a publicly readable C07 partial remains continuable after the page is
  // rebuilt without the original in-memory pendingSubmission.
  {
    writes.length = 0
    errors.length = 0
    turns.length = 0
    current.clear()
    const inputBodies = []
    const continueBodies = []
    const confirmationBodies = []
    let partialId
    const context5 = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    await context5.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) {
        let data
        let status = 200
        if (request.method() !== 'GET') writes.push(url.pathname)
        if (url.pathname === '/api/runtime/status') data = { mode: 'fake', state: 'ready' }
        else if (url.pathname === '/api/main-topic') data = projection()
        else if (url.pathname === '/api/product/session') data = { usage: undefined }
        else if (url.pathname === '/api/dashboard') data = { projects: [{ scope: { projectKey: project.projectKey }, label: project.projectName }] }
        else if (url.pathname === '/api/tasks') data = { draft: [], waiting: [], running: [], completed: [], stopped: [], failed: [] }
        else if (url.pathname === '/api/explicit/inputs' && request.method() === 'POST') {
          const body = JSON.parse(request.postData() || '{}')
          inputBodies.push(body)
          partialId = `refresh-${current.size + 1}`
          current.set(partialId, { interactionId: partialId, rawInput: body.rawInput, state: 'matching' })
          turns.push({ turnId: `user:${partialId}`, interactionId: partialId, role: 'user', kind: 'message', text: body.rawInput })
          data = { interactionId: partialId, occurredAt: new Date().toISOString() }
          status = 201
        } else {
          const match = url.pathname.match(/^\/api\/explicit\/interactions\/([^/]+)(?:\/(.*))?$/)
          if (!match) { status = 404; data = { error: { code: 'fixture.unavailable', message: '未提供' } } }
          else if (match[2] === 'events') data = ''
          else if (match[2] === 'interpret') {
            const id = match[1]
            current.set(id, { interactionId: id, rawInput: '刷新后继续原轮', state: 'partial',
              partial: { partialRef: `partial-ref:${id}`, resumed: false } })
            data = snapshot(id)
          } else if (match[2] === 'continue') {
            const body = JSON.parse(request.postData() || '{}')
            continueBodies.push(body)
            current.set(match[1], { interactionId: match[1], rawInput: '刷新后继续原轮', state: 'awaiting-confirmation',
              partial: { partialRef: body.partialRef, resumed: true },
              draft: { draftId: `refresh-draft:${match[1]}`, inputRevision: 1,
                normalizedInput: '刷新后继续原轮', proposal: '刷新后继续原轮', proposedIntent: 'create' } })
            data = snapshot(match[1])
          } else if (match[2] === 'confirmation') {
            confirmationBodies.push(JSON.parse(request.postData() || '{}'))
            current.set(match[1], { ...snapshot(match[1]), state: 'dispatched' })
            turns.push({ turnId: `delivery:${match[1]}`, interactionId: match[1], role: 'jenny', kind: 'message', text: '刷新后原轮已确认' })
            data = { requirement: { status: 'submitted', requirementId: 'refresh-requirement',
              draftId: `refresh-draft:${match[1]}`, inputRevision: 1, confirmationRef: 'confirmation:refresh' } }
          } else data = snapshot(match[1])
        }
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
      }
      const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
      assert.ok(path.startsWith(root + '/'))
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)], body: await readFile(path) })
    })
    try {
      const refreshPage = await context5.newPage()
      refreshPage.on('pageerror', error => errors.push(error.message))
      await refreshPage.goto('http://queue-proof.test/')
      const refreshInput = refreshPage.locator('#entry-form textarea[name=rawInput]')
      const refreshSend = refreshPage.getByRole('button', { name: '发送给 Jenny', exact: true })
      await refreshInput.fill('刷新后继续原轮')
      await refreshSend.click()
      await refreshPage.getByRole('button', { name: '继续本轮处理', exact: true }).waitFor({ timeout: 5000 })
      await refreshPage.evaluate(() => {
        const { entryReceipt: _receipt, ...rest } = window.history.state || {}
        window.history.replaceState(rest, '', window.location.href)
      })
      await refreshPage.reload()
      await refreshPage.getByRole('button', { name: '继续本轮处理', exact: true }).waitFor({ timeout: 5000 })
      check('refreshed C07 uses the public interaction snapshot without pendingSubmission', inputBodies.length === 1)
      await refreshPage.getByRole('button', { name: '继续本轮处理', exact: true }).click()
      await refreshPage.getByText('刷新后原轮已确认', { exact: true }).waitFor({ timeout: 5000 }).catch(() => {})
      check('refreshed C07 continues only its authoritative partial reference', continueBodies.length === 1
        && continueBodies[0].partialRef === `partial-ref:${partialId}`)
      check('continuation needing confirmation uses the existing confirmation endpoint', confirmationBodies.length === 1
        && confirmationBodies[0].draftId === `refresh-draft:${partialId}`)
      check('refreshed C07 continuation never reposts the original input or starts another interaction', inputBodies.length === 1
        && current.size === 1)
      check('refreshed C07 path has no page errors', errors.length === 0)
      await refreshPage.screenshot({ path: resolve(evidence, 'p1-partial-refresh-continuation.png'), fullPage: true })
    } finally {
      await context5.close()
    }
  }
} catch (error) {
  failure = error.stack
  process.exitCode = 1
  if (page && !page.isClosed()) {
    await writeFile(resolve(evidence, 'failure-body.txt'), await page.locator('body').innerText()).catch(() => {})
    await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => {})
  }
} finally {
  releaseFirst?.()
  releaseSecond?.()
  releaseFirstReceive?.()
  releaseConfirm?.()
  await browser.close()
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ checks, writes, errors,
    failure, browserClosed: !browser.isConnected() }, null, 2))
}
if (failure) console.error(failure)
else console.log(JSON.stringify({ result: 'PASS', checks, evidence }))
