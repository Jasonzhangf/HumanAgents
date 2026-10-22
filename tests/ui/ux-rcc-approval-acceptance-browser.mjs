#!/usr/bin/env node

/**
 * F4-C real-entry acceptance for the RCC approval and product-relation paths.
 *
 * The script owns one isolated HOME, control root, workspace, RCC serve
 * instance and Chromium context. It submits the real new-task form, waits for
 * the real task-grant decision, approves through the rendered dashboard
 * control, records the real execution reads, and then exercises one real
 * relation target through refresh, Back and Forward.
 *
 * Every assertion is based on an HTTP response or a rendered browser state.
 * Missing environment, missing screenshots, absent real relations and
 * unresolved tasks remain INCOMPLETE or UNVERIFIED instead of passing.
 *
 * Usage:
 *   UX_ACCEPTANCE_EVIDENCE=<dir> node tests/ui/ux-rcc-approval-acceptance-browser.mjs
 *
 * Optional:
 *   UX_ACCEPTANCE_CLI=<path>          test-only CLI override (default: dist cli)
 *   UX_ACCEPTANCE_PLAYWRIGHT=<path>   Playwright module (default: Homebrew)
 *   UX_ACCEPTANCE_UI_ROOT=<path>      UI tree (default: <repo>/docs/ui)
 *
 * Exit codes: 0 = PASS, 2 = FAIL, 3 = INCOMPLETE, 4 = UNVERIFIED.
 */

import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decodeProductLocation,
} from '../../docs/ui/product-location.js'
import {
  evaluateSessionReadEvidence,
  isContractUnavailableFocus,
  isGroundedRelationEndpoint,
  productTargetKey,
  sameProductReadScope,
} from './ux-product-acceptance-browser.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const ACCEPTANCE_INPUT = '在当前目录创建一个 demo.txt，内容 hello，然后报告完成'
export const ACCEPTANCE_MODE = 'rcc'
export const TERMINAL_TASK_STATES = Object.freeze([
  'succeeded',
  'failed',
  'stopped',
  'blocked',
  'cancelled',
])

const ACTIVE_TASK_STATES = new Set([
  'created',
  'admitted',
  'running',
  'settling',
  'waiting',
])
const TERMINAL_TASK_STATE_SET = new Set(TERMINAL_TASK_STATES)
const SAFE_REQUEST_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const TASK_CREATE_TIMEOUT_MS = 180_000
const DECISION_TIMEOUT_MS = 180_000
const APPROVAL_UI_TIMEOUT_MS = 60_000
const EXECUTION_TIMEOUT_MS = 900_000
const RELATION_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 90_000
const SERVE_READY_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 15_000

const PASS = 'PASS'
const FAIL = 'FAIL'
const INCOMPLETE = 'INCOMPLETE'
const UNVERIFIED = 'UNVERIFIED'

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function valueOf(value) {
  return value && typeof value === 'object' ? value.value : value
}

export function taskIdValue(value) {
  return valueOf(value)
}

function taskIdObject(value) {
  return { scope: 'task', value: String(valueOf(value)) }
}

function sameTaskId(left, right) {
  return valueOf(left) !== undefined
    && valueOf(right) !== undefined
    && String(valueOf(left)) === String(valueOf(right))
}

export function taskRows(list) {
  if (!list || typeof list !== 'object') return []
  const rows = []
  const seen = new Set()
  const preferred = ['running', 'waiting', 'completed', 'stopped', 'draft', 'failed']
  const keys = [
    ...preferred,
    ...Object.keys(list).filter((key) => !preferred.includes(key)),
  ]
  for (const key of keys) {
    const bucket = list[key]
    if (!Array.isArray(bucket)) continue
    for (const row of bucket) {
      if (!row || typeof row !== 'object') continue
      const id = taskIdValue(row.taskId ?? row.id)
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue
      seen.add(id)
      rows.push(row)
    }
  }
  return rows
}

function taskScopeFromValue(taskId) {
  return {
    kind: 'task',
    projectKey: '',
    mode: ACCEPTANCE_MODE,
    taskId: taskIdObject(taskId),
  }
}

function queryRecord(url) {
  return Object.fromEntries(new URL(url).searchParams.entries())
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkHasEvidence(check) {
  return (Array.isArray(check?.evidenceFiles) && check.evidenceFiles.length > 0)
    || (isRecord(check?.evidence) && Object.keys(check.evidence).length > 0)
}

/**
 * Pure receipt evaluation. A green run without an artifact is not accepted;
 * the caller must attach the real response, screenshot or log that proves it.
 */
export function summarizeChecks(checks) {
  const list = Array.isArray(checks) ? checks : []
  const pass = list.filter((check) => check?.status === PASS).length
  const fail = list.filter((check) => check?.status === FAIL).length
  const unverified = list.filter((check) => check?.status === UNVERIFIED).length
  const incomplete = list.filter((check) => check?.status === INCOMPLETE).length
  const missingEvidence = list
    .filter((check) => !checkHasEvidence(check))
    .map((check) => check?.id ?? '(unnamed)')
  const status = list.length === 0
    ? INCOMPLETE
    : fail > 0
      ? FAIL
      : missingEvidence.length > 0 || incomplete > 0
        ? INCOMPLETE
        : unverified > 0
          ? UNVERIFIED
          : pass > 0 ? PASS : INCOMPLETE
  return {
    status,
    pass,
    fail,
    unverified,
    incomplete,
    missingEvidence,
    total: list.length,
  }
}

export function evaluateGrantDecision({ decision, taskId, scope }) {
  const actions = Array.isArray(decision?.actions) ? decision.actions : []
  const decisionTaskId = decision?.target?.taskRef?.value
  const exactTarget = decision?.kind === 'task-grant'
    && decision?.target?.kind === 'interaction'
    && typeof decisionTaskId === 'string' && decisionTaskId.length > 0
    // A decision that names another task than the caller asked for is not this
    // task's approval. When the caller has no prior task expectation (the
    // project-scope read), the decision must still name exactly one task inside
    // the requested product scope.
    && (taskId === undefined || taskId === null
      ? decision?.target?.scope?.projectKey === scope?.projectKey
        && decision?.target?.scope?.mode === scope?.mode
        && decision?.target?.scope?.taskId?.value === decisionTaskId
      : sameTaskId(decision?.target?.taskRef, taskIdObject(taskId)))
  const ok = decision?.kind === 'task-grant'
    && decision?.state === 'waiting'
    && actions.includes('grant')
    && exactTarget
  return {
    ok,
    detail: ok
      ? `real task-grant waiting for task ${String(decisionTaskId)} actions=${actions.join(',')}`
      : `decision=${decision?.kind ?? 'null'} state=${decision?.state ?? 'n/a'} target=${decision?.target?.taskRef?.value ?? 'n/a'} actions=${actions.join(',') || 'none'}`,
  }
}

export function evaluateExecutionProgress({ dashboard, output, session }) {
  const state = typeof dashboard?.state === 'string' ? dashboard.state : undefined
  const leftWaiting = state !== undefined && state !== 'waiting'
  const commits = Array.isArray(output?.commits) ? output.commits : []
  const messages = Array.isArray(session?.messages) ? session.messages : []
  const nonHumanMessage = messages.some((message) =>
    message?.actor?.kind !== undefined && message.actor.kind !== 'human')
  const executionSignal = Boolean(dashboard?.execution)
    || nonHumanMessage
    || output?.resultAvailable === true
    || commits.length > 0
  const terminal = TERMINAL_TASK_STATE_SET.has(state)
  const ok = leftWaiting && executionSignal
  return {
    ok,
    leftWaiting,
    executionSignal,
    terminal,
    state: state ?? 'unknown',
    messages: messages.length,
    commits: commits.length,
    detail: `state=${state ?? 'unknown'} left-waiting=${leftWaiting} execution=${executionSignal} messages=${messages.length} commits=${commits.length}`,
  }
}

function receiptMatchesNavigationRequest(receipt, expectedScope, expectedTarget) {
  const search = receipt?.search
  if (!isRecord(search)) return false
  if (expectedScope?.kind === 'task') {
    if (search.projectKey !== expectedScope.projectKey) return false
    if (search.mode !== expectedScope.mode) return false
    if (search.taskId !== String(taskIdValue(expectedScope.taskId))) return false
  } else if (expectedScope?.kind === 'project') {
    if (search.projectKey !== expectedScope.projectKey) return false
    if (search.taskId !== undefined) return false
  } else {
    return false
  }
  if (expectedTarget?.kind === 'session') {
    if (search.sessionId !== expectedTarget.sessionRef?.sourceRef) return false
    if (typeof search.sessionKind === 'string' && search.sessionKind !== ''
      && search.sessionKind !== expectedTarget.sessionRef?.sourceKind) return false
  }
  return true
}

/**
 * Bind one navigation to the target fixed before the click, not to whatever
 * focus the URL happens to decode to afterwards. The visible URL, the request
 * query and the response body must all describe that exact target; the body
 * checks are owned by F4-B's evaluateSessionReadEvidence.
 */
export function evaluateNavigationState({
  actualUrl,
  expectedTarget,
  expectedScope,
  receipts = [],
  surface,
  contractUnavailable = false,
} = {}) {
  const decoded = decodeProductLocation(actualUrl)
  if (decoded.kind !== 'valid') {
    return {
      ok: false,
      state: 'url',
      detail: `invalid product location: ${decoded.reason ?? 'unknown'}`,
    }
  }
  if (!expectedTarget || !expectedScope) {
    return {
      ok: false,
      state: 'expectation',
      detail: 'a fixed relation target and its scope are required',
    }
  }
  const focusOk = productTargetKey(decoded.location.focus) === productTargetKey(expectedTarget)
  const scopeOk = sameProductReadScope(decoded.location.scope, expectedScope)
  const url = new URL(actualUrl)
  const queryScopeOk = expectedScope.kind === 'task'
    ? url.searchParams.get('task') === String(taskIdValue(expectedScope.taskId))
      && url.searchParams.get('projectKey') === expectedScope.projectKey
      && url.searchParams.get('mode') === expectedScope.mode
    : expectedScope.kind === 'project'
      ? url.searchParams.get('projectKey') === expectedScope.projectKey
      : false
  if (!focusOk || !scopeOk || !queryScopeOk) {
    return {
      ok: false,
      state: 'url',
      focusOk,
      scopeOk,
      queryScopeOk,
      detail: `focus=${focusOk} scope=${scopeOk} query=${queryScopeOk}`,
    }
  }
  const requestOk = contractUnavailable === true
    || (Array.isArray(receipts)
      && receipts.some((receipt) =>
        receiptMatchesNavigationRequest(receipt, expectedScope, expectedTarget)))
  if (!requestOk) {
    return {
      ok: false,
      state: 'request',
      focusOk,
      scopeOk,
      queryScopeOk,
      requestOk,
      detail: 'no session request matches the fixed relation target',
    }
  }
  const evidence = evaluateSessionReadEvidence({
    receipts,
    surface,
    expectedScope,
    expectedFocus: expectedTarget,
    contractUnavailable: contractUnavailable === true,
  })
  return {
    ok: evidence.ok,
    state: evidence.state,
    focusOk,
    scopeOk,
    queryScopeOk,
    requestOk,
    bodyState: evidence.state,
    bodyDetail: evidence.detail,
    detail: `focus=${focusOk} scope=${scopeOk} query=${queryScopeOk} request=${requestOk} body=${evidence.state}(${evidence.detail})`,
  }
}

class RunStop extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'RunStop'
    this.acceptanceStatus = status
  }
}

function stop(status, message) {
  return new RunStop(status, message)
}

function spawnCapture(command, args, { env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((settle) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      clearTimeout(timer)
      settle({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      settle({ code, signal, stdout, stderr, timedOut })
    })
  })
}

function waitForExit(child, timeoutMs) {
  if (!child) return Promise.resolve(undefined)
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((settle) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      settle(undefined)
    }, timeoutMs)
    const onExit = (code, signal) => {
      clearTimeout(timer)
      settle({ code, signal })
    }
    child.once('exit', onExit)
  })
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function listFiles(root, limit = 250) {
  const result = []
  async function visit(dir) {
    if (result.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (result.length >= limit) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        const info = await stat(path).catch(() => undefined)
        result.push({
          path: relative(root, path),
          bytes: info?.size ?? null,
          modifiedAt: info?.mtime?.toISOString?.() ?? null,
        })
      }
    }
  }
  await visit(root)
  return result
}

function safeFileName(name) {
  return String(name).replace(/[^A-Za-z0-9._/-]/g, '_')
}

class AcceptanceRun {
  constructor(evidenceRoot) {
    this.evidenceRoot = evidenceRoot
    this.shotsDir = join(evidenceRoot, 'shots')
    this.rawDir = join(evidenceRoot, 'raw')
    this.checks = []
    this.httpReceipts = []
    this.browserWrites = []
    this.browserWriteResponses = []
    this.browserFailures = []
    this.browserSessionRequests = []
    this.consoleErrors = []
    this.pageErrors = []
    this.executionTimeline = []
    this.decisionTimeline = []
    this.artifacts = []
    this.startedAt = new Date().toISOString()
    this.finishedAt = undefined
    this.attemptRoot = undefined
    this.controlRoot = undefined
    this.workspace = undefined
    this.home = undefined
    this.base = undefined
    this.port = undefined
    this.cliPath = undefined
    this.uiRoot = undefined
    this.serve = undefined
    this.serveLog = ''
    this.browser = undefined
    this.context = undefined
    this.page = undefined
    this.cookie = undefined
    this.projectKey = undefined
    this.taskId = undefined
    this.decision = undefined
    this.dashboard = undefined
    this.output = undefined
    this.session = undefined
    this.relationsRead = undefined
    this.terminalState = undefined
    this.recoveryOwner = undefined
    this.settled = false
    this.resources = {
      serve: {
        pid: null,
        port: null,
        base: null,
        exit: null,
        listenerUnavailable: null,
      },
      browser: {
        launched: false,
        contextsClosed: false,
        browserClosed: false,
      },
      data: {
        attemptRoot: null,
        controlRoot: null,
        workspace: null,
        disposition: 'not-created',
        reason: null,
        owner: 'f4-c acceptance run',
      },
    }
  }

  record(id, status, detail, evidenceFiles = []) {
    const evidence = [...new Set(evidenceFiles.filter((file) => typeof file === 'string' && file !== ''))]
    const check = { id, status, detail, evidenceFiles: evidence }
    this.checks.push(check)
    console.log(`${status} ${id} :: ${detail}`)
    return check
  }

  pass(id, detail, evidenceFiles) {
    return this.record(id, PASS, detail, evidenceFiles)
  }

  fail(id, detail, evidenceFiles) {
    return this.record(id, FAIL, detail, evidenceFiles)
  }

  unverified(id, detail, evidenceFiles) {
    return this.record(id, UNVERIFIED, detail, evidenceFiles)
  }

  incomplete(id, detail, evidenceFiles) {
    return this.record(id, INCOMPLETE, detail, evidenceFiles)
  }

  async writeJson(name, value) {
    const file = safeFileName(name.endsWith('.json') ? name : `${name}.json`)
    const path = join(this.evidenceRoot, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
    return file
  }

  async writeText(name, value) {
    const file = safeFileName(name)
    const path = join(this.evidenceRoot, file)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, String(value ?? ''))
    return file
  }

  async capture(name) {
    if (!this.page || this.page.isClosed()) return undefined
    const file = `shots/${safeFileName(name.endsWith('.png') ? name : `${name}.png`)}`
    try {
      await this.page.screenshot({ path: join(this.evidenceRoot, file), fullPage: true })
      return file
    } catch (error) {
      const detail = `screenshot ${name} failed: ${error?.message ?? String(error)}`
      const log = await this.writeText('screenshot-errors.log', `${detail}\n`)
      this.incomplete('evidence.screenshot', detail, [log])
      return undefined
    }
  }

  async prepare() {
    await mkdir(this.shotsDir, { recursive: true })
    await mkdir(this.rawDir, { recursive: true })
  }

  async run() {
    await this.startInstance()
    await this.pairBrowser()
    await this.submitRealTask()
    await this.waitForRealDecision()
    await this.approveInBrowser()
    await this.followExecution()
    await this.verifyRelations()
    await this.verifyTaskTerminal()
  }

  async startInstance() {
    this.attemptRoot = await mkdtemp(join(tmpdir(), 'ux-rcc-accept-'))
    this.controlRoot = join(this.attemptRoot, 'control')
    this.workspace = join(this.attemptRoot, 'ux-rcc-ws')
    this.home = this.attemptRoot
    await mkdir(this.controlRoot, { recursive: true })
    await mkdir(this.workspace, { recursive: true })

    const defaultCli = join(repoRoot, 'dist', 'app', 'app', 'src', 'cli.js')
    this.cliPath = process.env.UX_ACCEPTANCE_CLI?.trim() || defaultCli
    this.uiRoot = resolve(process.env.UX_ACCEPTANCE_UI_ROOT?.trim() || join(repoRoot, 'docs', 'ui'))
    this.resources.data.attemptRoot = this.attemptRoot
    this.resources.data.controlRoot = this.controlRoot
    this.resources.data.workspace = this.workspace
    this.resources.data.disposition = 'retained-during-run'

    const startup = {
      script: scriptPath,
      cliPath: this.cliPath,
      cliOverride: Boolean(process.env.UX_ACCEPTANCE_CLI?.trim()),
      uiRoot: this.uiRoot,
      repoRoot,
      attemptRoot: this.attemptRoot,
      home: this.home,
      controlRoot: this.controlRoot,
      workspace: this.workspace,
      startedAt: this.startedAt,
    }
    const startupFile = await this.writeJson('startup.json', startup)
    if (!(await fileExists(this.cliPath))) {
      this.incomplete('env.cli', `CLI not found at ${this.cliPath}`, [startupFile])
      throw stop(INCOMPLETE, 'real CLI is not available')
    }
    this.pass('env.cli', `CLI available at ${this.cliPath}`, [startupFile])

    const env = {
      ...process.env,
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, '.config'),
    }
    const doctor = await spawnCapture(process.execPath, [
      this.cliPath,
      'doctor',
      '--control-root',
      this.controlRoot,
      '--workspace',
      this.workspace,
    ], { cwd: repoRoot, env, timeoutMs: 120_000 })
    const doctorOut = await this.writeText('doctor.out', doctor.stdout)
    const doctorErr = await this.writeText('doctor.err', doctor.stderr)
    const doctorJson = (() => {
      try {
        return JSON.parse(doctor.stdout)
      } catch {
        return undefined
      }
    })()
    const doctorFile = await this.writeJson('doctor.json', doctorJson ?? { parseError: true })
    if (doctor.code !== 0 || doctorJson?.projectKey === undefined) {
      this.incomplete(
        'env.doctor',
        `doctor exited ${String(doctor.code)}; projectKey=${String(doctorJson?.projectKey)}`,
        [doctorFile, doctorOut, doctorErr],
      )
      throw stop(INCOMPLETE, 'doctor could not derive the project key')
    }
    this.projectKey = doctorJson.projectKey
    this.pass('env.doctor', `derived projectKey=${this.projectKey}`, [doctorFile, doctorOut, doctorErr])

    const projectDir = join(this.controlRoot, 'projects', this.projectKey)
    await mkdir(projectDir, { recursive: true })
    const manifest = { projectKey: this.projectKey, workspaceCwd: this.workspace }
    await writeFile(join(projectDir, 'project.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    const manifestFile = await this.writeJson('project-manifest.json', manifest)
    this.pass('env.project-manifest', `wrote ${join(projectDir, 'project.json')}`, [manifestFile])

    this.port = 49_000 + Math.floor(Math.random() * 1_000)
    this.base = `http://127.0.0.1:${this.port}`
    this.resources.serve.port = this.port
    this.resources.serve.base = this.base
    this.serve = spawn(process.execPath, [
      this.cliPath,
      'serve',
      '--mode',
      ACCEPTANCE_MODE,
      '--host',
      '127.0.0.1',
      '--port',
      String(this.port),
      '--control-root',
      this.controlRoot,
      '--workspace',
      this.workspace,
      '--ui-root',
      this.uiRoot,
    ], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.resources.serve.pid = this.serve.pid ?? null
    this.serve.stdout.on('data', (chunk) => { this.serveLog += chunk.toString() })
    this.serve.stderr.on('data', (chunk) => { this.serveLog += chunk.toString() })
    const serveStartupFile = await this.writeJson('serve-startup.json', {
      ...startup,
      pid: this.resources.serve.pid,
      port: this.port,
      base: this.base,
    })
    if (!this.serve.pid) {
      const serveLogFile = await this.writeText('serve.log', this.serveLog)
      this.incomplete('env.serve', 'serve process did not expose a pid', [serveStartupFile, serveLogFile])
      throw stop(INCOMPLETE, 'serve did not start')
    }

    const deadline = Date.now() + SERVE_READY_TIMEOUT_MS
    let lastStatus
    let ready = false
    while (Date.now() < deadline) {
      if (this.serve.exitCode !== null || this.serve.signalCode !== null) break
      try {
        const response = await fetch(`${this.base}/api/liveness`, { signal: AbortSignal.timeout(2_000) })
        lastStatus = response.status
        if (response.ok) {
          ready = true
          break
        }
      } catch {}
      await sleep(500)
    }
    const serveLogFile = await this.writeText('serve.log', this.serveLog)
    const livenessFile = await this.writeJson('liveness.json', { base: this.base, status: lastStatus, ready })
    if (!ready) {
      this.incomplete(
        'env.serve',
        `serve pid=${this.resources.serve.pid} did not become live on ${this.base}; lastStatus=${String(lastStatus)}`,
        [serveStartupFile, serveLogFile, livenessFile],
      )
      throw stop(INCOMPLETE, 'serve did not become live')
    }
    this.pass(
      'env.serve',
      `isolated RCC serve pid=${this.resources.serve.pid} ready at ${this.base}`,
      [serveStartupFile, serveLogFile, livenessFile],
    )
  }

  async pairBrowser() {
    const env = {
      ...process.env,
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, '.config'),
    }
    const pair = await spawnCapture(process.execPath, [
      this.cliPath,
      'pair',
      '--workspace',
      this.workspace,
      '--control-root',
      this.controlRoot,
    ], { cwd: repoRoot, env, timeoutMs: 60_000 })
    const pairOut = await this.writeText('pair.out', pair.stdout)
    const pairErr = await this.writeText('pair.err', pair.stderr)
    let challenge
    try {
      challenge = JSON.parse(pair.stdout)
    } catch {
      challenge = undefined
    }
    const pairMeta = await this.writeJson('pair.json', {
      command: 'pair',
      exitCode: pair.code,
      codePresent: typeof challenge?.code === 'string' && challenge.code !== '',
      expiresAt: challenge?.expiresAt ?? null,
    })
    if (pair.code !== 0 || typeof challenge?.code !== 'string') {
      this.incomplete('env.pair', `pair exited ${String(pair.code)} without a one-time code`, [pairMeta, pairOut, pairErr])
      throw stop(INCOMPLETE, 'pairing code was not issued')
    }
    const response = await fetch(`${this.base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.base },
      body: JSON.stringify({ code: challenge.code }),
      signal: AbortSignal.timeout(20_000),
    })
    const setCookie = response.headers.get('set-cookie') ?? ''
    const cookiePair = setCookie.split(';')[0]
    const separator = cookiePair.indexOf('=')
    const cookieName = separator > 0 ? cookiePair.slice(0, separator) : ''
    const cookieValue = separator > 0 ? cookiePair.slice(separator + 1) : ''
    const pairHttp = await this.writeJson('pair-http.json', {
      status: response.status,
      ok: response.ok,
      cookieName,
      httpOnly: /;\s*httponly\b/i.test(setCookie),
    })
    this.httpReceipts.push({
      name: 'pair',
      method: 'POST',
      path: '/api/auth/pair',
      status: response.status,
      ok: response.ok,
      bodyFile: pairHttp,
    })
    if (!response.ok || cookieName !== 'HA_SESSION' || cookieValue === '') {
      this.incomplete('env.pair', `pairing response status=${response.status} cookie=${cookieName || '(none)'}`, [pairMeta, pairHttp])
      throw stop(INCOMPLETE, 'real pairing did not return HA_SESSION')
    }
    this.cookie = `${cookieName}=${cookieValue}`
    this.pass('env.pair', `real pairing accepted cookie=${cookieName}`, [pairMeta, pairHttp])

    const playwrightEntry = process.env.UX_ACCEPTANCE_PLAYWRIGHT?.trim()
      || '/opt/homebrew/lib/node_modules/playwright/index.js'
    let playwright
    try {
      const module = await import(playwrightEntry)
      playwright = module.default ?? module
      this.browser = await playwright.chromium.launch({ headless: true })
      this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 } })
      await this.context.addCookies([{
        name: cookieName,
        value: cookieValue,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      }])
      this.page = await this.context.newPage()
      this.attachBrowserListeners()
    } catch (error) {
      const log = await this.writeText('playwright.log', `${error?.stack ?? error}\n`)
      this.incomplete('env.browser', `Playwright/Chromium failed: ${error?.message ?? String(error)}`, [log])
      throw stop(INCOMPLETE, 'Chromium could not launch')
    }
    this.resources.browser.launched = true
    this.pass('env.browser', 'real Chromium context created with the paired cookie', ['pair.json', 'pair-http.json'])
  }

  attachBrowserListeners() {
    this.page.on('request', (request) => {
      const url = new URL(request.url())
      const method = request.method()
      if (!SAFE_REQUEST_METHODS.has(method)) {
        this.browserWrites.push({
          at: new Date().toISOString(),
          method,
          path: url.pathname,
          search: Object.fromEntries(url.searchParams.entries()),
        })
      }
    })
    this.page.on('response', (response) => {
      const request = response.request()
      const url = new URL(request.url())
      const record = {
        at: new Date().toISOString(),
        method: request.method(),
        path: url.pathname,
        search: Object.fromEntries(url.searchParams.entries()),
        status: response.status(),
        ok: response.ok(),
      }
      if (url.pathname === '/api/product/session' && request.method() === 'GET') {
        record.body = undefined
        record.bodyError = undefined
        record.settled = false
        this.browserSessionRequests.push(record)
        // Read the real navigation response. If the page abandons the stream,
        // re-read the same request with the session cookie instead of treating
        // an unreadable body as a successful one.
        const settleAuthoritatively = () => {
          const path = `${url.pathname}?${url.searchParams.toString()}`
          return this.authedFetch(path).then(async (res) => {
            if (!res.ok) {
              record.bodyError = `authoritative re-read HTTP ${res.status}`
            } else {
              try {
                record.body = await res.json()
                record.authoritative = true
              } catch (error) {
                record.bodyError = error?.message ?? String(error)
              }
            }
          }, (error) => {
            record.bodyError = error?.message ?? String(error)
          }).finally(() => {
            record.settled = true
          })
        }
        const grace = setTimeout(() => {
          if (!record.settled) settleAuthoritatively()
        }, 2_000)
        response.text().then((text) => {
          try {
            record.body = text.trim() === '' ? null : JSON.parse(text)
            record.authoritative = false
          } catch (error) {
            record.bodyError = error?.message ?? String(error)
          }
          record.settled = true
          clearTimeout(grace)
        }, () => {
          if (!record.settled) settleAuthoritatively()
          clearTimeout(grace)
        })
      }
      if (!SAFE_REQUEST_METHODS.has(request.method())) {
        this.browserWriteResponses.push(record)
      }
      if (!response.ok()) {
        // A failing page request must carry its own reason into the evidence,
        // otherwise the run can only report that the flow stopped.
        const failure = { ...record, body: undefined, bodyError: undefined }
        this.browserFailures.push(failure)
        response.text().then((text) => {
          try {
            failure.body = text.trim() === '' ? null : JSON.parse(text)
          } catch {
            failure.body = text.slice(0, 2_000)
          }
          failure.observed = true
        }, (error) => {
          failure.bodyError = error?.message ?? String(error)
          failure.observed = true
        })
      }
    })
    this.page.on('console', (message) => {
      if (message.type() === 'error') {
        this.consoleErrors.push(message.text().slice(0, 500))
      }
    })
    this.page.on('pageerror', (error) => {
      this.pageErrors.push(String(error?.message ?? error).slice(0, 500))
    })
  }

  async authedFetch(path, init = {}) {
    return fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        cookie: this.cookie,
        origin: this.base,
      },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    })
  }

  async readJson(name, path, init = {}, { capture = true } = {}) {
    const response = await this.authedFetch(path, init)
    const text = await response.text()
    let body
    try {
      body = text.trim() === '' ? null : JSON.parse(text)
    } catch {
      body = { nonJsonBody: text.slice(0, 2_000) }
    }
    let bodyFile
    if (capture) {
      bodyFile = await this.writeJson(name, body)
      this.httpReceipts.push({
        name,
        method: init.method ?? 'GET',
        path,
        status: response.status,
        ok: response.ok,
        bodyFile,
      })
    }
    return { response, body, text, bodyFile }
  }

  async submitRealTask() {
    const before = await this.readJson('tasks-before-entry', '/api/tasks')
    const beforeIds = new Set(taskRows(before.body).map((row) => taskIdValue(row.taskId ?? row.id)))
    if (!before.response.ok) {
      const detail = `GET /api/tasks before entry status=${before.response.status}`
      this.fail('entry.tasks-before', detail, [before.bodyFile].filter(Boolean))
      throw stop(FAIL, detail)
    }

    await this.page.goto(`${this.base}/index.html`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await this.page.waitForSelector('#entry-form', { timeout: 30_000 })
    const rawInput = this.page.locator('#entry-form [name="rawInput"]')
    await rawInput.fill(ACCEPTANCE_INPUT)
    await this.page.selectOption('#entry-form [name="executionMode"]', 'once')
    const timezoneVisible = await this.page.locator('#entry-form [name="timezone"]').isVisible().catch(() => false)
    if (timezoneVisible) {
      await this.page.fill('#entry-form [name="timezone"]', 'Asia/Shanghai')
    } else {
      await this.page.evaluate(() => {
        const timezone = document.querySelector('#entry-form [name="timezone"]')
        if (timezone) timezone.value = 'Asia/Shanghai'
      })
    }
    const formState = await this.page.evaluate(() => ({
      rawInput: document.querySelector('#entry-form [name="rawInput"]')?.value ?? '',
      executionMode: document.querySelector('#entry-form [name="executionMode"]')?.value ?? '',
      timezone: document.querySelector('#entry-form [name="timezone"]')?.value ?? '',
      submitDisabled: Boolean(document.querySelector('#entry-form button[type="submit"]')?.disabled),
    }))
    const formFile = await this.writeJson('entry-form.json', formState)
    if (formState.rawInput.trim() !== ACCEPTANCE_INPUT
      || formState.executionMode !== 'once'
      || formState.timezone !== 'Asia/Shanghai') {
      this.fail('entry.form', `form state mismatch ${JSON.stringify(formState)}`, [formFile])
      throw stop(FAIL, 'real entry form did not hold the requested values')
    }
    const entryShot = await this.capture('entry-form')
    this.pass('entry.form', 'real task form filled with once/Asia/Shanghai', [formFile, entryShot].filter(Boolean))

    await this.page.click('#entry-form button[type="submit"]')
    const deadline = Date.now() + TASK_CREATE_TIMEOUT_MS
    let after
    let newRows = []
    let landingObserved = false
    while (Date.now() < deadline) {
      after = await this.readJson('tasks-after-entry', '/api/tasks', {}, { capture: false })
      const rows = taskRows(after.body)
      newRows = rows.filter((row) => {
        const id = taskIdValue(row.taskId ?? row.id)
        return typeof id === 'string' && id !== '' && !beforeIds.has(id)
      })
      const url = new URL(this.page.url())
      const urlTaskId = url.searchParams.get('task')
      if (url.pathname.endsWith('/task-dashboard.html') && urlTaskId) {
        landingObserved = true
        const match = newRows.find((row) => taskIdValue(row.taskId ?? row.id) === urlTaskId)
        if (match) break
      }
      if (newRows.length > 0) break
      if (this.serve.exitCode !== null || this.serve.signalCode !== null) break
      await sleep(1_000)
    }
    const tasksAfterFile = await this.writeJson('tasks-after-entry.json', after?.body ?? null)
    const entryEventsFile = await this.writeJson('entry-browser-writes.json', this.browserWrites)
    const entryFailuresFile = await this.writeJson('entry-browser-failures.json', this.browserFailures)
    if (!after?.response.ok) {
      this.fail('entry.task', `GET /api/tasks after entry status=${after?.response.status ?? 'n/a'}`, [tasksAfterFile, entryEventsFile, entryFailuresFile])
      throw stop(FAIL, 'task list could not be read after submission')
    }
    if (newRows.length !== 1) {
      const pageText = await this.page.locator('body').innerText().catch(() => '')
      const failureFile = await this.writeText('entry-page.txt', pageText)
      const failureShot = await this.capture('entry-failure')
      this.fail(
        'entry.task',
        `expected exactly one new task, observed ${newRows.length}: ${newRows.map((row) => taskIdValue(row.taskId ?? row.id)).join(',') || 'none'}`,
        [tasksAfterFile, entryEventsFile, entryFailuresFile, failureFile, failureShot].filter(Boolean),
      )
      throw stop(FAIL, 'real form did not produce one new task')
    }
    const row = newRows[0]
    this.taskId = taskIdValue(row.taskId ?? row.id)
    const landingUrl = new URL(this.page.url())
    const landingMatches = landingObserved
      && landingUrl.searchParams.get('task') === this.taskId
      && landingUrl.searchParams.get('projectKey') === this.projectKey
      && landingUrl.searchParams.get('mode') === ACCEPTANCE_MODE
    if (landingMatches) {
      this.pass('entry.landing', `entry landed on task-dashboard for ${this.taskId}`, [tasksAfterFile])
    } else {
      this.unverified(
        'entry.landing',
        `task ${this.taskId} exists but entry URL landing was not confirmed; page=${this.page.url()}`,
        [tasksAfterFile],
      )
    }
    this.pass(
      'entry.task',
      `real form created task ${this.taskId} with state=${row.state ?? 'unknown'} identitySource=${row.identitySource ? 'present' : 'absent'}`,
      [tasksAfterFile],
    )
    const submittedShot = await this.capture('entry-submitted')
    if (submittedShot) this.pass('entry.screenshot', 'entry submission screenshot saved', [submittedShot])
  }

  async waitForRealDecision() {
    // The waiting grant belongs to the task the runtime prepared for this
    // requirement, which is not the page-level draft task id. The project-scope
    // read is the only read that can surface it before the human opens that
    // task, so the poll must not narrow to the draft task.
    const path = `/api/product/decision?${new URLSearchParams({
      projectKey: this.projectKey,
      mode: ACCEPTANCE_MODE,
    })}`
    const deadline = Date.now() + DECISION_TIMEOUT_MS
    let lastBody
    let lastStatus
    let lastDashboard
    while (Date.now() < deadline) {
      const read = await this.readJson('decision-poll', path, {}, { capture: false })
      lastStatus = read.response.status
      lastBody = read.body
      this.decisionTimeline.push({
        at: new Date().toISOString(),
        status: read.response.status,
        kind: read.body?.kind ?? null,
        state: read.body?.state ?? null,
      })
      if (read.response.ok && read.body) {
        this.decision = read.body
        break
      }
      const dashboard = await this.readJson(
        'dashboard-during-decision-wait',
        `/api/tasks/${encodeURIComponent(this.taskId)}/dashboard?${new URLSearchParams({
          projectKey: this.projectKey,
          mode: ACCEPTANCE_MODE,
        })}`,
        {},
        { capture: false },
      )
      lastDashboard = dashboard.body?.value ?? dashboard.body
      if (lastDashboard?.state && TERMINAL_TASK_STATE_SET.has(lastDashboard.state)) break
      await sleep(1_000)
    }
    const timelineFile = await this.writeJson('decision-timeline.json', this.decisionTimeline)
    if (!this.decision) {
      const dashboard = lastDashboard ?? (await this.readJson(
        'dashboard-decision-timeout',
        `/api/tasks/${encodeURIComponent(this.taskId)}/dashboard?${new URLSearchParams({
          projectKey: this.projectKey,
          mode: ACCEPTANCE_MODE,
        })}`,
      )).body
      const runtime = await this.readJson('runtime-decision-timeout', '/api/runtime/status')
      const detail = `decision timeout status=${String(lastStatus)} dashboard.state=${dashboard?.state ?? 'unknown'} runtime.mode=${runtime.body?.mode ?? 'unknown'}`
      const evidence = [timelineFile, runtime.bodyFile].filter(Boolean)
      if (dashboard?.state === 'waiting') {
        this.fail('approval.decision', detail, evidence)
        throw stop(FAIL, 'waiting task did not expose a real task-grant decision')
      }
      this.unverified('approval.decision', detail, evidence)
      throw stop(UNVERIFIED, 'decision did not become available before the timeout')
    }
    const decisionFile = await this.writeJson('decision.json', this.decision)
    this.httpReceipts.push({
      name: 'decision',
      method: 'GET',
      path,
      status: lastStatus,
      ok: true,
      bodyFile: decisionFile,
    })
    // The waiting grant belongs to the task the runtime prepared for this
    // requirement; the page-level draft task id is not that task. The decision
    // is exact only when it names one task, that task is inside this project
    // scope, and the formal grant action is offered for it.
    const decisionTaskId = this.decision?.target?.taskRef?.value
    const evaluation = evaluateGrantDecision({
      decision: this.decision,
      scope: { projectKey: this.projectKey, mode: ACCEPTANCE_MODE },
    })
    if (!evaluation.ok) {
      this.fail('approval.decision', evaluation.detail, [decisionFile, timelineFile])
      throw stop(FAIL, 'decision is not an exact waiting task-grant')
    }
    this.pass('approval.decision', evaluation.detail, [decisionFile, timelineFile])
  }

  taskDashboardPath(taskId = this.taskId) {
    const params = new URLSearchParams({
      task: taskId,
      projectKey: this.projectKey,
      mode: ACCEPTANCE_MODE,
    })
    return `/task-dashboard.html?${params}`
  }

  async waitForFocusReady() {
    await this.page.locator('.product-focus-center[data-product-focus-state="ready"]')
      .waitFor({ state: 'visible', timeout: 45_000 })
  }

  async openRelationLayer() {
    const open = await this.page.locator('.product-frame[data-relation="open"]').count() === 1
    if (open) return true
    const toggle = this.page.locator('.product-relation-toggle').first()
    if (await toggle.count() !== 1) return false
    await toggle.click()
    await this.page.waitForFunction(
      () => document.querySelector('.product-frame')?.dataset.relation === 'open',
      undefined,
      { timeout: 10_000 },
    )
    return await this.page.locator('.product-frame[data-relation="open"]').count() === 1
  }

  async closeRelationLayer() {
    const close = this.page.locator('.product-relation-close').first()
    if (await close.count() !== 1) return false
    await close.click()
    await this.page.waitForFunction(
      () => document.querySelector('.product-frame')?.dataset.relation === 'closed',
      undefined,
      { timeout: 10_000 },
    )
    return await this.page.locator('.product-frame[data-relation="closed"]').count() === 1
  }

  async approveInBrowser() {
    // The decision names its own task; approve through that exact task page so
    // the rendered control and the granted task are the same target.
    const approvalTaskId = this.decision?.target?.taskRef?.value
    if (typeof approvalTaskId !== 'string' || approvalTaskId.length === 0) {
      this.fail('approval.target', 'decision did not name the task to approve', [])
      throw stop(FAIL, 'decision target is missing')
    }
    this.approvalTaskId = approvalTaskId
    // From here on the acceptance tracks the task that really carries the
    // approval and the execution. The entry task only proves that the form
    // produced a task; it is not the granted task.
    this.entryTaskId = this.entryTaskId ?? this.taskId
    this.taskId = approvalTaskId
    await this.page.goto(`${this.base}${this.taskDashboardPath(approvalTaskId)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    await this.waitForFocusReady()
    const card = this.page.locator('[data-product-pending-decision="task-grant"]')
    try {
      await card.waitFor({ state: 'visible', timeout: APPROVAL_UI_TIMEOUT_MS })
    } catch {
      const body = await this.page.locator('body').innerText().catch(() => '')
      const bodyFile = await this.writeText('approval-missing-page.txt', body)
      const shot = await this.capture('approval-missing')
      this.fail(
        'approval.ui',
        'the dashboard did not render the real task-grant decision',
        [bodyFile, shot].filter(Boolean),
      )
      throw stop(FAIL, 'approval control was not rendered')
    }
    const targetTaskId = await card.locator('[data-product-role="control-target"]').getAttribute('data-task-id')
    if (targetTaskId !== approvalTaskId) {
      const shot = await this.capture('approval-wrong-target')
      this.fail('approval.ui', `decision target=${String(targetTaskId)} expected=${approvalTaskId}`, [shot].filter(Boolean))
      throw stop(FAIL, 'approval control targets the wrong task')
    }
    const entryShot = await this.capture('approval-entry')
    this.pass('approval.ui', `real task-grant card rendered for ${approvalTaskId}`, [entryShot].filter(Boolean))

    const cardApprove = card.locator('[data-product-role="decision-grant"]')
    if (await cardApprove.count() !== 1 || await cardApprove.isDisabled()) {
      const shot = await this.capture('approval-disabled')
      this.fail('approval.action-enabled', 'card approval control is absent or disabled', [shot].filter(Boolean))
      throw stop(FAIL, 'approval control is disabled')
    }
    await cardApprove.click()
    const dialog = this.page.locator('.product-control-modal[role="dialog"]')
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    const modalShot = await this.capture('approval-modal')
    this.pass('approval.modal', 'approval modal opened from the real card', [modalShot].filter(Boolean))

    const closeButton = dialog.locator('[data-product-role="close-control-modal"]')
    const writesBeforeClose = this.browserWrites.length
    await closeButton.click()
    await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined)
    const writesDuringClose = this.browserWrites.slice(writesBeforeClose)
    const closed = await this.page.locator('.product-control-modal[role="dialog"]').count() === 0
    const closeFile = await this.writeJson('approval-close-writes.json', writesDuringClose)
    if (!closed || writesDuringClose.length !== 0) {
      this.fail(
        'approval.close-zero-write',
        `closed=${closed} writes=${writesDuringClose.map((entry) => `${entry.method} ${entry.path}`).join(',') || 'none'}`,
        [closeFile],
      )
      throw stop(FAIL, 'closing the approval modal wrote state')
    }
    this.pass('approval.close-zero-write', 'closing the approval modal issued no non-GET request', [closeFile])

    await cardApprove.click()
    await dialog.waitFor({ state: 'visible', timeout: 10_000 })
    const approveButton = dialog.locator('[data-product-role="decision-grant"]')
    if (await approveButton.count() !== 1 || await approveButton.isDisabled()) {
      const shot = await this.capture('approval-modal-disabled')
      this.fail('approval.modal-enabled', 'modal approval control is absent or disabled', [shot].filter(Boolean))
      throw stop(FAIL, 'modal approval control is disabled')
    }
    const responsePromise = this.page.waitForResponse((response) => {
      const request = response.request()
      const path = new URL(request.url()).pathname
      return request.method() === 'POST'
        && path === `/api/tasks/${encodeURIComponent(this.taskId)}/control/grant`
    }, { timeout: 60_000 })
    await approveButton.click()
    const grantResponse = await responsePromise
    const grantRequest = grantResponse.request()
    const grantRequestUrl = new URL(grantRequest.url())
    const grantRequestBody = (() => {
      try {
        return grantRequest.postDataJSON()
      } catch {
        return undefined
      }
    })()
    const grantBody = await grantResponse.json().catch(() => ({}))
    const requestFile = await this.writeJson('approval-grant-request.json', {
      method: grantRequest.method(),
      path: grantRequestUrl.pathname,
      query: Object.fromEntries(grantRequestUrl.searchParams.entries()),
      body: grantRequestBody,
    })
    const responseFile = await this.writeJson('approval-grant-response.json', grantBody)
    this.httpReceipts.push({
      name: 'grant',
      method: grantRequest.method(),
      path: grantRequestUrl.pathname,
      status: grantResponse.status(),
      ok: grantResponse.ok(),
      bodyFile: responseFile,
    })
    const grantState = grantBody?.readback?.grant?.state
    const grantRevision = grantBody?.readback?.grant?.revision
    const bodyKeys = isRecord(grantRequestBody) ? Object.keys(grantRequestBody).sort() : []
    const formalBody = bodyKeys.length === 2
      && bodyKeys[0] === 'expectedRevision'
      && bodyKeys[1] === 'requestId'
    const grantOk = grantResponse.status() === 200
      && grantState === 'granted'
      && Number.isInteger(grantRevision)
      && formalBody
    if (!grantOk) {
      const shot = await this.capture('approval-grant-failure')
      this.fail(
        'approval.grant',
        `status=${grantResponse.status()} state=${String(grantState)} revision=${String(grantRevision)} bodyKeys=${bodyKeys.join(',')}`,
        [requestFile, responseFile, shot].filter(Boolean),
      )
      throw stop(FAIL, 'real approval did not return a granted readback')
    }
    const receiptShot = await this.capture('approval-receipt')
    this.pass(
      'approval.grant',
      `real grant succeeded revision=${grantRevision} owner=${String(grantBody.readback.grant.owner ?? 'present')}`,
      [requestFile, responseFile, receiptShot].filter(Boolean),
    )

    const readback = await this.readJson(
      'approval-readback',
      `/api/tasks/${encodeURIComponent(this.taskId)}/control/grant?${new URLSearchParams({
        projectKey: this.projectKey,
        mode: ACCEPTANCE_MODE,
      })}`,
    )
    const readbackState = readback.body?.readback?.grant?.state
    if (readback.response.ok && readbackState === 'granted') {
      this.pass('approval.readback', `durable grant readback state=${readbackState}`, [readback.bodyFile].filter(Boolean))
    } else {
      this.fail(
        'approval.readback',
        `status=${readback.response.status} state=${String(readbackState)}`,
        [readback.bodyFile].filter(Boolean),
      )
      throw stop(FAIL, 'grant readback did not confirm the grant')
    }

    if (await dialog.count() > 0) {
      const writesBefore = this.browserWrites.length
      await dialog.locator('[data-product-role="close-control-modal"]').click().catch(() => undefined)
      await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined)
      const writes = this.browserWrites.slice(writesBefore)
      const file = await this.writeJson('approval-receipt-close-writes.json', writes)
      this.pass(
        'approval.receipt-close-zero-write',
        writes.length === 0 ? 'closing the receipt issued no write' : `writes=${writes.map((entry) => entry.path).join(',')}`,
        [file],
      )
    }
  }

  async followExecution() {
    const dashboardPath = `/api/tasks/${encodeURIComponent(this.taskId)}/dashboard?${new URLSearchParams({
      projectKey: this.projectKey,
      mode: ACCEPTANCE_MODE,
    })}`
    const deadline = Date.now() + EXECUTION_TIMEOUT_MS
    let lastState
    let leftWaitingFile
    let terminalFile
    let leftWaitingObserved = false
    while (Date.now() < deadline) {
      const read = await this.readJson('dashboard-poll', dashboardPath, {}, { capture: false })
      const dashboard = read.body?.value ?? read.body
      if (read.response.ok && dashboard) {
        this.dashboard = dashboard
        const state = dashboard.state ?? 'unknown'
        if (state !== lastState) {
          this.executionTimeline.push({
            at: new Date().toISOString(),
            state,
            executionState: dashboard.execution?.state ?? null,
            currentState: dashboard.currentState ?? null,
          })
          lastState = state
        }
        if (!leftWaitingObserved && state !== 'waiting') {
          leftWaitingObserved = true
          leftWaitingFile = await this.writeJson('dashboard-left-waiting.json', dashboard)
          await this.page.goto(`${this.base}${this.taskDashboardPath()}`, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
          })
          await this.page.waitForTimeout(1_000)
          const shot = await this.capture('execution-left-waiting')
          this.pass(
            'execution.left-waiting',
            `task left waiting into state=${state}`,
            [leftWaitingFile, shot].filter(Boolean),
          )
        }
        if (TERMINAL_TASK_STATE_SET.has(state)) {
          terminalFile = await this.writeJson('dashboard-terminal.json', dashboard)
          this.terminalState = state
          break
        }
      }
      if (this.serve.exitCode !== null || this.serve.signalCode !== null) break
      await sleep(1_500)
    }
    const timelineFile = await this.writeJson('execution-timeline.json', this.executionTimeline)

    if (!leftWaitingObserved) {
      const runtime = await this.readJson('runtime-execution-timeout', '/api/runtime/status')
      const detail = `task ${this.taskId} never left waiting before timeout; state=${this.dashboard?.state ?? 'unknown'}`
      const evidence = [timelineFile, runtime.bodyFile].filter(Boolean)
      this.unverified('execution.left-waiting', detail, evidence)
      return
    }
    if (!terminalFile) {
      const runtime = await this.readJson('runtime-execution-timeout', '/api/runtime/status')
      const timeline = await this.readJson('dashboard-execution-timeout', dashboardPath)
      const detail = `task ${this.taskId} did not reach a terminal state before timeout; state=${timeline.body?.state ?? this.dashboard?.state ?? 'unknown'}`
      this.unverified('execution.terminal', detail, [timelineFile, timeline.bodyFile, runtime.bodyFile].filter(Boolean))
      return
    }

    const outputRead = await this.readJson(
      'execution-output',
      `/api/product/output?${new URLSearchParams({
        taskId: this.taskId,
        projectKey: this.projectKey,
        mode: ACCEPTANCE_MODE,
      })}`,
    )
    const sessionRead = await this.readJson(
      'execution-session',
      `/api/product/session?${new URLSearchParams({
        projectKey: this.projectKey,
        mode: ACCEPTANCE_MODE,
        taskId: this.taskId,
      })}`,
    )
    this.output = outputRead.body
    this.session = sessionRead.body
    const progress = evaluateExecutionProgress({
      dashboard: this.dashboard,
      output: this.output,
      session: this.session,
    })
    const executionEvidence = [timelineFile, terminalFile, outputRead.bodyFile, sessionRead.bodyFile].filter(Boolean)
    if (progress.ok) {
      this.pass('execution.progress', progress.detail, executionEvidence)
    } else {
      this.fail('execution.progress', progress.detail, executionEvidence)
    }
    if (this.terminalState === 'succeeded') {
      this.pass('execution.terminal', 'task reached succeeded', [terminalFile].filter(Boolean))
    } else {
      this.fail(
        'execution.terminal',
        `task reached terminal state=${String(this.terminalState)} next=${String(this.dashboard?.nextAction?.kind ?? this.dashboard?.nextAction ?? 'n/a')}`,
        [terminalFile].filter(Boolean),
      )
    }
    const terminalShot = await this.capture('execution-terminal')
    if (terminalShot) this.pass('execution.screenshot', 'terminal execution screenshot saved', [terminalShot])
    await this.verifyWorkspaceFile()
  }

  async verifyWorkspaceFile() {
    if (this.terminalState !== 'succeeded') return
    const filePath = join(this.workspace, 'demo.txt')
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch {
      text = undefined
    }
    const listing = await listFiles(this.workspace)
    const listingFile = await this.writeJson('workspace-files.json', listing)
    const result = {
      path: filePath,
      exists: text !== undefined,
      containsHello: typeof text === 'string' && /\bhello\b/i.test(text),
      text: typeof text === 'string' ? text.slice(0, 2_000) : null,
    }
    const file = await this.writeJson('workspace-demo.json', result)
    if (result.exists && result.containsHello) {
      this.pass('execution.file-effect', 'workspace demo.txt exists and contains hello', [file, listingFile])
    } else {
      this.fail(
        'execution.file-effect',
        `demo.txt exists=${result.exists} containsHello=${result.containsHello}`,
        [file, listingFile],
      )
    }
  }

  async verifyRelations() {
    const path = `/api/product/relations?${new URLSearchParams({
      projectKey: this.projectKey,
      mode: ACCEPTANCE_MODE,
      taskId: this.taskId,
    })}`
    const deadline = Date.now() + RELATION_TIMEOUT_MS
    let read
    while (Date.now() < deadline) {
      read = await this.readJson('relations', path)
      const relations = Array.isArray(read.body?.relations) ? read.body.relations : []
      if (read.response.ok && relations.length > 0) break
      await sleep(1_500)
    }
    this.relationsRead = read?.body
    const relations = Array.isArray(read?.body?.relations) ? read.body.relations : []
    const gaps = Array.isArray(read?.body?.gaps) ? read.body.gaps : []
    const evidence = [read?.bodyFile].filter(Boolean)
    if (!read?.response.ok) {
      this.fail('relations.read', `GET /api/product/relations status=${read?.response.status ?? 'n/a'}`, evidence)
      throw stop(FAIL, 'relations read failed')
    }
    if (relations.length === 0) {
      this.unverified(
        'relations.navigation',
        `real relations=0 gaps=${gaps.length}; no selectable real target exists in this execution`,
        evidence,
      )
      return
    }
    const kinds = [...new Set(relations.flatMap((relation) => [
      relation?.source?.kind,
      relation?.target?.kind,
    ]).filter(Boolean))]
    this.pass(
      'relations.read',
      `real relations=${relations.length} gaps=${gaps.length} kinds=${kinds.join(',') || 'unknown'}`,
      evidence,
    )

    try {
      await this.navigateRealRelation(relations)
    } catch (error) {
      const shot = await this.capture('relations-failure')
      this.fail(
        'relations.navigation',
        `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
        [read.bodyFile, shot].filter(Boolean),
      )
    }
  }

  async navigateRealRelation(relations) {
    await this.page.goto(`${this.base}${this.taskDashboardPath()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    await this.waitForFocusReady()
    if (!(await this.openRelationLayer())) {
      throw new Error('relation layer did not open')
    }
    const originalUrl = this.page.url()
    const originalScope = {
      ...taskScopeFromValue(this.taskId),
      projectKey: this.projectKey,
    }
    const originalTarget = {
      kind: 'interaction',
      taskRef: taskIdObject(this.taskId),
      scope: originalScope,
    }
    const nodes = this.page.locator('.product-relation-node:not([data-product-relation-current="true"])')
    const nodeCount = await nodes.count()
    if (nodeCount === 0) {
      throw new Error(`real relations=${relations.length} but no selectable relation node rendered`)
    }
    let node
    let targetJson
    let target
    let targetUnavailable
    for (let index = 0; index < nodeCount; index += 1) {
      const candidate = nodes.nth(index)
      const candidateJson = await candidate.getAttribute('data-product-target')
      if (typeof candidateJson !== 'string') continue
      let candidateTarget
      try {
        candidateTarget = JSON.parse(candidateJson)
      } catch {
        continue
      }
      if (!candidateTarget || typeof candidateTarget !== 'object') continue
      if (!isGroundedRelationEndpoint(relations, candidateTarget)) continue
      const unavailable = isContractUnavailableFocus(candidateTarget)
      if (target === undefined || (targetUnavailable === true && unavailable === false)) {
        node = candidate
        targetJson = candidateJson
        target = candidateTarget
        targetUnavailable = unavailable
      }
      if (!unavailable) break
    }
    if (node === undefined || target === undefined) {
      throw new Error('no rendered relation target is a grounded real relation endpoint')
    }
    if (!target.scope || (target.scope.kind !== 'task' && target.scope.kind !== 'project')) {
      throw new Error('selected relation target has no readable scope')
    }
    const relationShot = await this.capture('relations-open')
    if (!relationShot) throw new Error('relations-open screenshot was not saved')
    this.pass('relations.open', `relation layer rendered ${nodeCount} selectable node(s)`, [relationShot])

    const sessionMark = this.browserSessionRequests.length
    await node.click()
    await this.page.waitForFunction((expectedTarget) => {
      const current = document.querySelector('.product-relation-node[data-product-relation-current="true"]')
      return Boolean(location.hash.startsWith('#/boards/'))
        && current?.getAttribute('data-product-target') === expectedTarget
    }, targetJson, { timeout: 20_000 })
    await this.page.waitForTimeout(500)
    const selectedUrl = this.page.url()
    const selectedDecoded = decodeProductLocation(selectedUrl)
    if (selectedDecoded.kind !== 'valid') {
      throw new Error(`selected URL did not decode: ${selectedDecoded.reason ?? 'unknown'}`)
    }
    let selected
    try {
      selected = await this.waitForNavigationEvidence('relations.select', sessionMark, {
        actualUrl: selectedUrl,
        expectedScope: target.scope,
        expectedTarget: target,
        contractUnavailable: targetUnavailable,
      })
    } catch (error) {
      const selectedFailureShot = await this.capture('relation-target-failure')
      this.fail(
        'relations.select',
        error?.message ?? String(error),
        [relationShot, selectedFailureShot, ...(error?.evidenceFiles ?? [])].filter(Boolean),
      )
      throw error
    }
    const targetShot = await this.capture('relation-target')
    const selectedEvidence = [
      relationShot,
      targetShot,
      ...selected.evidenceFiles,
    ].filter(Boolean)
    const selectedOk = selected.evaluation.ok === true
      && productTargetKey(selectedDecoded.location.focus) === productTargetKey(target)
    if (!selectedOk) {
      this.fail('relations.select', selected.evaluation.detail, selectedEvidence)
      throw new Error('selected relation did not produce one consistent real read')
    }
    this.pass(
      'relations.select',
      `${selected.evaluation.detail} target=${productTargetKey(target)}`,
      selectedEvidence,
    )

    const refreshMark = this.browserSessionRequests.length
    await this.page.reload({ waitUntil: 'domcontentloaded' })
    await this.waitForFocusReady()
    await this.openRelationLayer()
    await this.page.waitForFunction((expectedTarget) => {
      const current = document.querySelector('.product-relation-node[data-product-relation-current="true"]')
      return current?.getAttribute('data-product-target') === expectedTarget
    }, targetJson, { timeout: 20_000 })
    const refreshedUrl = this.page.url()
    let refreshed
    try {
      refreshed = await this.waitForNavigationEvidence('relations.refresh', refreshMark, {
        actualUrl: refreshedUrl,
        expectedScope: target.scope,
        expectedTarget: target,
        contractUnavailable: targetUnavailable,
      })
    } catch (error) {
      const refreshFailureShot = await this.capture('relation-refresh-failure')
      this.fail(
        'relations.refresh',
        error?.message ?? String(error),
        [refreshFailureShot, ...(error?.evidenceFiles ?? [])].filter(Boolean),
      )
      throw error
    }
    const refreshShot = await this.capture('relation-refresh')
    if (refreshedUrl !== selectedUrl) {
      this.fail(
        'relations.refresh',
        `${refreshed.evaluation.detail} same-url=false`,
        [refreshShot, ...refreshed.evidenceFiles].filter(Boolean),
      )
      throw new Error('refresh did not retain the exact selected target')
    }
    this.pass(
      'relations.refresh',
      `${refreshed.evaluation.detail} same-url=true`,
      [refreshShot, ...refreshed.evidenceFiles].filter(Boolean),
    )

    const backMark = this.browserSessionRequests.length
    await this.page.goBack({ waitUntil: 'domcontentloaded' })
    await this.waitForFocusReady()
    await this.openRelationLayer()
    const backUrl = this.page.url()
    const backDecoded = decodeProductLocation(backUrl)
    let back
    try {
      back = await this.waitForNavigationEvidence('relations.back', backMark, {
        actualUrl: backUrl,
        expectedScope: originalScope,
        expectedTarget: originalTarget,
      })
    } catch (error) {
      const backFailureShot = await this.capture('relation-back-failure')
      this.fail(
        'relations.back',
        error?.message ?? String(error),
        [backFailureShot, ...(error?.evidenceFiles ?? [])].filter(Boolean),
      )
      throw error
    }
    const backShot = await this.capture('relation-back')
    const backHashOk = backUrl === originalUrl
    if (!backHashOk || backDecoded.kind !== 'valid') {
      this.fail(
        'relations.back',
        `${back.evaluation.detail} original-url=${backHashOk} decoded=${backDecoded.kind}`,
        [backShot, ...back.evidenceFiles].filter(Boolean),
      )
      throw new Error('Back did not restore the exact original task focus')
    }
    this.pass(
      'relations.back',
      `${back.evaluation.detail} original-url=true`,
      [backShot, ...back.evidenceFiles].filter(Boolean),
    )

    const forwardMark = this.browserSessionRequests.length
    await this.page.goForward({ waitUntil: 'domcontentloaded' })
    await this.waitForFocusReady()
    await this.openRelationLayer()
    await this.page.waitForFunction((expectedTarget) => {
      const current = document.querySelector('.product-relation-node[data-product-relation-current="true"]')
      return current?.getAttribute('data-product-target') === expectedTarget
    }, targetJson, { timeout: 20_000 })
    const forwardUrl = this.page.url()
    const forwardDecoded = decodeProductLocation(forwardUrl)
    let forward
    try {
      forward = await this.waitForNavigationEvidence('relations.forward', forwardMark, {
        actualUrl: forwardUrl,
        expectedScope: target.scope,
        expectedTarget: target,
        contractUnavailable: targetUnavailable,
      })
    } catch (error) {
      const forwardFailureShot = await this.capture('relation-forward-failure')
      this.fail(
        'relations.forward',
        error?.message ?? String(error),
        [forwardFailureShot, ...(error?.evidenceFiles ?? [])].filter(Boolean),
      )
      throw error
    }
    const forwardShot = await this.capture('relation-forward')
    if (forwardUrl !== selectedUrl || forwardDecoded.kind !== 'valid') {
      this.fail(
        'relations.forward',
        `${forward.evaluation.detail} selected-url=${forwardUrl === selectedUrl} decoded=${forwardDecoded.kind}`,
        [forwardShot, ...forward.evidenceFiles].filter(Boolean),
      )
      throw new Error('Forward did not restore the exact selected target')
    }
    this.pass(
      'relations.forward',
      `${forward.evaluation.detail} selected-url=true`,
      [forwardShot, ...forward.evidenceFiles].filter(Boolean),
    )

    const writesBeforeClose = this.browserWrites.length
    const closed = await this.closeRelationLayer()
    const writesDuringClose = this.browserWrites.slice(writesBeforeClose)
    const closeWritesFile = await this.writeJson('relations-close-writes.json', writesDuringClose)
    const closedShot = await this.capture('relation-closed')
    if (!closed || writesDuringClose.length !== 0) {
      this.fail(
        'relations.close-zero-write',
        `closed=${closed} writes=${writesDuringClose.map((entry) => `${entry.method} ${entry.path}`).join(',') || 'none'}`,
        [closeWritesFile, closedShot].filter(Boolean),
      )
      throw new Error('closing the relation layer wrote state')
    }
    this.pass(
      'relations.close-zero-write',
      'closing the relation layer issued no non-GET request',
      [closeWritesFile, closedShot].filter(Boolean),
    )
  }

  async readFocusSessionSurface() {
    const center = this.page.locator('.product-focus-center[data-product-focus-state="ready"]')
    const centerReady = await center.count() === 1
    return {
      centerReady,
      focusScope: centerReady
        ? await center.getAttribute('data-product-focus-scope', { timeout: 500 }).catch(() => null)
        : null,
      sessionHostCount: await this.page.locator('.product-focus-session').count(),
      messageCount: await this.page.locator('.product-focus-session .product-session-message').count(),
      messageEventIds: await this.page.locator('.product-focus-session .product-session-message')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-event-id')))
        .catch(() => []),
      messageTexts: await this.page.locator('.product-focus-session .product-session-message-body')
        .allInnerTexts()
        .catch(() => []),
      emptyCount: await this.page.locator('.product-focus-session .product-session-empty').count(),
      unavailableCount: await this.page
        .locator('.product-focus-session .product-focus-failure[data-product-role="focus-failure"]').count(),
      unavailableCode: await this.page
        .locator('.product-focus-session .product-focus-failure-message').first()
        .innerText({ timeout: 500 }).catch(() => ''),
    }
  }

  async recordNavigationReceipts(label, receipts) {
    const files = []
    for (let index = 0; index < receipts.length; index += 1) {
      const entry = receipts[index]
      const bodyFile = await this.writeJson(`${label}-session-${index + 1}`, entry.body ?? null)
      files.push(bodyFile)
      this.httpReceipts.push({
        name: `${label}.session-${index + 1}`,
        source: 'browser',
        method: entry.method,
        path: entry.path,
        search: entry.search,
        status: entry.status,
        ok: entry.ok,
        bodyFile,
      })
    }
    return files
  }

  /**
   * Settle one navigation against its fixed target. A ready center alone is
   * not enough: the request query, HTTP status, response scope, message
   * targets and visible event ids/texts must all describe the same target.
   */
  async waitForNavigationEvidence(label, mark, {
    actualUrl,
    expectedScope,
    expectedTarget,
    contractUnavailable = false,
    timeoutMs = 30_000,
  }) {
    const deadline = Date.now() + timeoutMs
    let firstStaleAt
    let last
    const fail = (detail, evidenceFiles) => {
      const error = new Error(`${label}: ${detail}`)
      error.evidenceFiles = evidenceFiles
      return error
    }
    while (Date.now() < deadline) {
      const receipts = this.browserSessionRequests.slice(mark)
      const pending = receipts.some((entry) => entry.settled !== true)
      const surface = await this.readFocusSessionSurface()
      const hasReceipt = receipts.length > 0
      if (surface.centerReady && !pending && (hasReceipt || contractUnavailable)) {
        const evaluation = evaluateNavigationState({
          actualUrl,
          expectedTarget,
          expectedScope,
          receipts,
          surface,
          contractUnavailable,
        })
        if (evaluation.ok) {
          const evidenceFiles = await this.recordNavigationReceipts(label, receipts)
          return {
            surface,
            receipts,
            evaluation,
            statusSummary: receipts.map((entry) => entry.status).join(',') || 'none',
            evidenceFiles,
          }
        }
        last = evaluation
        // A non-2xx answer or a wrong target is final. A stale body or a
        // transient scope/blank from the previous render is allowed one short
        // settle window, after which it is a real failure.
        if (evaluation.state !== 'stale' && evaluation.state !== 'blank'
          && evaluation.state !== 'scope') {
          const evidenceFiles = await this.recordNavigationReceipts(label, receipts)
          throw fail(evaluation.detail, evidenceFiles)
        }
        if (firstStaleAt === undefined) firstStaleAt = Date.now()
        if (Date.now() - firstStaleAt >= 1_500) {
          const evidenceFiles = await this.recordNavigationReceipts(label, receipts)
          throw fail(evaluation.detail, evidenceFiles)
        }
      }
      await sleep(100)
    }
    const surface = await this.readFocusSessionSurface().catch(() => undefined)
    const timeoutFile = await this.writeJson(`timeout-${label}`, {
      url: actualUrl,
      surface,
      last,
      receipts: this.browserSessionRequests.slice(mark),
    })
    throw fail(
      `navigation did not settle (${last?.detail ?? 'no ready center'}); surface=${JSON.stringify(surface)}`,
      [timeoutFile],
    )
  }

  async verifyTaskTerminal() {
    if (this.terminalState && TERMINAL_TASK_STATE_SET.has(this.terminalState)) {
      this.settled = true
      const dashboardFile = await this.writeJson('task-terminal.json', this.dashboard ?? null)
      this.pass('task.terminal', `task ${this.taskId} terminal state=${this.terminalState}`, [dashboardFile])
      return
    }
    if (!this.taskId) {
      this.incomplete('task.terminal', 'no test task was created; stop/terminal check is not applicable', ['entry-failure.png'])
      this.settled = true
      return
    }
    const stopResponse = await this.readJson(
      'task-stop',
      `/api/tasks/${encodeURIComponent(this.taskId)}/stop?${new URLSearchParams({
        projectKey: this.projectKey,
        mode: ACCEPTANCE_MODE,
      })}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
    const stopEvidence = [stopResponse.bodyFile].filter(Boolean)
    if (!stopResponse.response.ok) {
      this.recoveryOwner = 'humanagent.app.ui-runtime.task-control'
      this.incomplete(
        'task.stop',
        `formal stop status=${stopResponse.response.status} owner=${this.recoveryOwner}`,
        stopEvidence,
      )
      return
    }
    this.pass('task.stop', `formal task-scoped stop accepted status=${stopResponse.response.status}`, stopEvidence)

    const deadline = Date.now() + STOP_TIMEOUT_MS
    let finalDashboard
    while (Date.now() < deadline) {
      const read = await this.readJson(
        'task-stop-dashboard',
        `/api/tasks/${encodeURIComponent(this.taskId)}/dashboard?${new URLSearchParams({
          projectKey: this.projectKey,
          mode: ACCEPTANCE_MODE,
        })}`,
        {},
        { capture: false },
      )
      finalDashboard = read.body?.value ?? read.body
      if (finalDashboard?.state && TERMINAL_TASK_STATE_SET.has(finalDashboard.state)) {
        this.dashboard = finalDashboard
        this.terminalState = finalDashboard.state
        break
      }
      await sleep(1_500)
    }
    const finalFile = await this.writeJson('task-stop-terminal.json', finalDashboard ?? null)
    if (this.terminalState && TERMINAL_TASK_STATE_SET.has(this.terminalState)) {
      this.settled = true
      this.pass('task.terminal', `task ${this.taskId} terminal state=${this.terminalState}`, [finalFile, ...stopEvidence])
    } else {
      this.recoveryOwner = 'humanagent.app.ui-runtime.task-control'
      this.incomplete(
        'task.terminal',
        `task ${this.taskId} did not settle after formal stop; recovery owner=${this.recoveryOwner}`,
        [finalFile, ...stopEvidence],
      )
    }
  }

  async closeBrowser() {
    let contextError
    try {
      if (this.context) await this.context.close()
    } catch (error) {
      contextError = error
    }
    this.context = undefined
    const hadContext = this.resources.browser.launched
    this.resources.browser.contextsClosed = contextError === undefined
    if (hadContext) {
      this.record(
        'resource.contexts',
        contextError === undefined ? PASS : INCOMPLETE,
        contextError === undefined
          ? 'Playwright context closed'
          : `context close failed: ${contextError.message}`,
        ['browser-events.json'],
      )
    }
    let browserError
    try {
      if (this.browser) await this.browser.close()
    } catch (error) {
      browserError = error
    }
    this.browser = undefined
    this.resources.browser.browserClosed = browserError === undefined
    if (hadContext) {
      this.record(
        'resource.browser',
        browserError === undefined ? PASS : INCOMPLETE,
        browserError === undefined ? 'Chromium closed' : `Chromium close failed: ${browserError.message}`,
        ['browser-events.json'],
      )
    }
    this.page = undefined
  }

  async stopServe() {
    if (!this.serve) return
    let exited = await waitForExit(this.serve, 0)
    if (exited === undefined) {
      this.serve.kill('SIGTERM')
      exited = await waitForExit(this.serve, CLOSE_TIMEOUT_MS)
    }
    if (exited === undefined) {
      this.serve.kill('SIGKILL')
      exited = await waitForExit(this.serve, 5_000)
    }
    this.resources.serve.exit = exited ?? null
    let listenerUnavailable = false
    try {
      await fetch(`${this.base}/api/liveness`, { signal: AbortSignal.timeout(2_000) })
      listenerUnavailable = false
    } catch {
      listenerUnavailable = true
    }
    this.resources.serve.listenerUnavailable = listenerUnavailable
    const evidence = ['serve.log', 'listener-unavailable.json']
    await this.writeJson('listener-unavailable.json', {
      base: this.base,
      pid: this.resources.serve.pid,
      exit: this.resources.serve.exit,
      listenerUnavailable,
    })
    const stopped = exited !== undefined && listenerUnavailable
    this.record(
      'resource.serve-stop',
      stopped ? PASS : INCOMPLETE,
      `pid=${String(this.resources.serve.pid)} exit=${JSON.stringify(this.resources.serve.exit)} listener-unavailable=${listenerUnavailable}`,
      evidence,
    )
  }

  async finalize() {
    this.finishedAt = new Date().toISOString()
    await this.writeText('serve.log', this.serveLog)
    await this.writeJson('browser-events.json', {
      writes: this.browserWrites,
      writeResponses: this.browserWriteResponses,
      sessionRequests: this.browserSessionRequests,
      consoleErrors: this.consoleErrors,
      pageErrors: this.pageErrors,
    })
    await this.writeText('console.log', this.consoleErrors.join('\n'))
    await this.writeJson('execution-timeline.json', this.executionTimeline)

    let controlFiles = []
    let workspaceFiles = []
    if (this.controlRoot) controlFiles = await listFiles(this.controlRoot)
    if (this.workspace) workspaceFiles = await listFiles(this.workspace)
    const dataSnapshot = await this.writeJson('data-snapshot.json', { controlFiles, workspaceFiles })

    await this.closeBrowser()
    await this.stopServe()

    const settled = this.settled || (this.terminalState && TERMINAL_TASK_STATE_SET.has(this.terminalState))
    if (!this.attemptRoot) {
      this.resources.data.disposition = 'not-created'
      this.resources.data.reason = 'startup failed before an isolated root was created'
      this.incomplete('resource.temp-data', 'no temporary root existed', [dataSnapshot])
    } else if (settled) {
      let removeError
      try {
        await rm(this.attemptRoot, { recursive: true, force: true })
      } catch (error) {
        removeError = error
      }
      const exists = await fileExists(this.attemptRoot)
      if (removeError || exists) {
        this.resources.data.disposition = 'retained-cleanup-failed'
        this.resources.data.reason = removeError?.message ?? 'path still exists after rm'
        this.incomplete(
          'resource.temp-data',
          `deletion failed: ${this.resources.data.reason}`,
          [dataSnapshot],
        )
      } else {
        this.resources.data.disposition = 'deleted'
        this.resources.data.reason = 'test task settled; test-owned isolated root no longer needed'
        this.pass('resource.temp-data', 'temporary control root and workspace deleted', [dataSnapshot])
      }
    } else {
      this.resources.data.disposition = 'retained'
      this.resources.data.reason = `task state=${this.terminalState ?? this.dashboard?.state ?? 'unknown'} did not settle`
      this.resources.data.owner = this.recoveryOwner ?? 'humanagent.app.ui-runtime.task-control'
      this.incomplete(
        'resource.temp-data',
        `retained ${this.attemptRoot}; reason=${this.resources.data.reason}; owner=${this.resources.data.owner}`,
        [dataSnapshot],
      )
    }
  }

  async writeReceipt() {
    const summary = summarizeChecks(this.checks)
    const receipt = {
      schemaVersion: 1,
      acceptance: 'F4-C real RCC approval and relation navigation',
      status: summary.status,
      summary,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? new Date().toISOString(),
      input: ACCEPTANCE_INPUT,
      mode: ACCEPTANCE_MODE,
      projectKey: this.projectKey,
      taskId: this.taskId,
      taskTerminalState: this.terminalState ?? null,
      recoveryOwner: this.recoveryOwner ?? null,
      uiRoot: this.uiRoot,
      cliPath: this.cliPath,
      checks: this.checks,
      httpReceipts: this.httpReceipts,
      resources: this.resources,
      executionTimeline: this.executionTimeline,
      decisionTimeline: this.decisionTimeline,
      relations: this.relationsRead,
      artifacts: this.checks.flatMap((check) => check.evidenceFiles ?? []),
    }
    await this.writeJson('http-receipts.json', this.httpReceipts)
    await this.writeJson('receipt.json', receipt)
    console.log(
      `SUMMARY status=${summary.status} pass=${summary.pass} fail=${summary.fail} unverified=${summary.unverified} incomplete=${summary.incomplete}`,
    )
    process.exitCode = summary.status === PASS
      ? 0
      : summary.status === FAIL
        ? 2
        : summary.status === INCOMPLETE ? 3 : 4
  }

  async execute() {
    await this.prepare()
    try {
      await this.run()
    } catch (error) {
      const status = error?.acceptanceStatus ?? FAIL
      const serveLog = await this.writeText('serve.log', this.serveLog)
      const detail = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`
      if (!this.checks.some((check) => check.id === 'acceptance.first-deviation')) {
        this.record('acceptance.first-deviation', status, detail, [serveLog])
      }
      console.error(`${status} acceptance stopped: ${detail}`)
    } finally {
      try {
        await this.finalize()
      } catch (error) {
        const log = await this.writeText('finalize-crash.log', `${error?.stack ?? error}\n`)
        this.incomplete('acceptance.finalize', `finalization crashed: ${error?.message ?? String(error)}`, [log])
      }
      await this.writeReceipt()
    }
  }
}

async function main() {
  const evidenceRoot = process.env.UX_ACCEPTANCE_EVIDENCE?.trim()
  if (!evidenceRoot) {
    console.error('UX_ACCEPTANCE_EVIDENCE is required')
    process.exitCode = 4
    return
  }
  const run = new AcceptanceRun(resolve(evidenceRoot))
  await run.execute()
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  await main()
}
