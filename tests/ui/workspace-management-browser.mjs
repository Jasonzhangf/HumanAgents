#!/usr/bin/env node

/**
 * Isolated real-frontend proof for workspace alias management.
 *
 * The test starts the real fake-mode serve entry against a temporary control
 * root and two temporary workspaces. It pairs one Chromium context, edits the
 * names through the existing entry drawer, restarts serve, and verifies the
 * persisted names plus the stable workspace paths.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRuntimePaths } from '../../dist/config/config/src/index.js'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const evidenceRoot = process.env.WORKSPACE_MANAGEMENT_EVIDENCE?.trim()
if (!evidenceRoot) throw new Error('WORKSPACE_MANAGEMENT_EVIDENCE is required')
await mkdir(join(evidenceRoot, 'shots'), { recursive: true })

const playwrightEntry = process.env.WORKSPACE_MANAGEMENT_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js'
const playwrightModule = await import(playwrightEntry)
const playwright = playwrightModule.default ?? playwrightModule
const cliPath = join(repoRoot, 'dist', 'app', 'app', 'src', 'cli.js')
const checks = []
const record = (id, ok, detail) => {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${detail}`)
}

async function runCli(args, env) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', fail)
    child.once('exit', (code) => settle({ code, stdout, stderr }))
  })
}

async function availablePort() {
  const server = createServer()
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
  const port = server.address().port
  await new Promise((settle) => server.close(settle))
  return port
}

async function waitForServer(url, child, log) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve exited ${child.exitCode}: ${log()}`)
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise((settle) => setTimeout(settle, 200))
  }
  throw new Error(`serve did not become ready: ${log()}`)
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((settle) => child.once('exit', () => settle(true))),
    new Promise((settle) => setTimeout(() => settle(false), 5_000)),
  ])
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise((settle) => child.once('exit', settle))
  }
}

async function startServe({ controlRoot, workspace, port, env }) {
  let log = ''
  const child = spawn(process.execPath, [
    cliPath, 'serve', '--mode', 'fake', '--host', '127.0.0.1', '--port', String(port),
    '--control-root', controlRoot, '--workspace', workspace, '--ui-root', join(repoRoot, 'docs', 'ui'),
  ], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { log += chunk.toString() })
  child.stderr.on('data', (chunk) => { log += chunk.toString() })
  await waitForServer(`http://127.0.0.1:${port}/dashboard.html`, child, () => log)
  return { child, log: () => log }
}

async function pairBrowser(context, base, workspace, controlRoot, env) {
  const paired = await runCli(['pair', '--workspace', workspace, '--control-root', controlRoot], env)
  if (paired.code !== 0) throw new Error(`pair failed: ${paired.stderr}`)
  const code = JSON.parse(paired.stdout).code
  const response = await fetch(`${base}/api/auth/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!response.ok) throw new Error(`pair request failed ${response.status}: ${await response.text()}`)
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  const separator = cookie.indexOf('=')
  if (separator < 1) throw new Error('pair response did not set a session cookie')
  await context.addCookies([{
    name: cookie.slice(0, separator),
    value: cookie.slice(separator + 1),
    url: base,
  }])
}

async function openManagement(page) {
  await page.locator('button[data-entry-dialog="workspace-names"]').click()
  await page.locator('section[data-workspace-management="true"]').waitFor({ state: 'visible' })
  await page.locator('.workspace-management-row').first().waitFor({ state: 'visible' })
}

async function closeManagement(page) {
  await page.locator('dialog.shell-layer[open] button.shell-layer-close').click()
  await page.locator('dialog.shell-layer[open]').waitFor({ state: 'hidden' })
}

async function fillBatch(page, names) {
  const rows = page.locator('.workspace-management-row')
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index)
    const checkbox = row.locator('input[type="checkbox"]')
    if (!(await checkbox.isChecked())) await checkbox.check()
    const path = await row.locator('.workspace-management-identity code').textContent()
    const input = row.locator('input[data-workspace-alias]')
    await input.fill(names.get(path.trim()) ?? '')
  }
  await page.locator('.workspace-management-actions button').click()
}

async function folderNames(page) {
  return (await page.locator('.entry-workspace-folder > summary.entry-project-name').allTextContents())
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
}

async function projectTitles(page) {
  return (await page.locator('.entry-workspace-projects details.entry-project > summary.entry-project-name span').allTextContents())
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
}

const attemptRoot = await mkdtemp(join(tmpdir(), 'workspace-management-browser-'))
let browser
let context
let serve
const resource = { servePid: null, serveStopped: false, browserClosed: false, tempRemoved: false }
try {
  const controlRoot = join(attemptRoot, 'control')
  const workspaceA = join(attemptRoot, 'workspace-alpha')
  const workspaceB = join(attemptRoot, 'workspace-beta')
  await mkdir(workspaceA, { recursive: true })
  await mkdir(workspaceB, { recursive: true })
  const env = { ...process.env, HOME: attemptRoot }
  const doctorA = await runCli(['doctor', '--control-root', controlRoot, '--workspace', workspaceA], env)
  const doctorB = await runCli(['doctor', '--control-root', controlRoot, '--workspace', workspaceB], env)
  if (doctorA.code !== 0 || doctorB.code !== 0) {
    throw new Error(`doctor failed: ${doctorA.stderr} ${doctorB.stderr}`)
  }
  const projectA = JSON.parse(doctorA.stdout)
  const projectB = JSON.parse(doctorB.stdout)
  const pathsA = await resolveRuntimePaths({ controlRoot, workspace: workspaceA })
  const pathsB = await resolveRuntimePaths({ controlRoot, workspace: workspaceB })
  const duplicateKey = `${projectA.projectKey}--${createHash('sha256').update(projectA.workspaceCwd).digest('hex').slice(0, 16)}`
  const projectsRoot = dirname(pathsA.projectRoot)
  const projectADir = join(projectsRoot, projectA.projectKey)
  const duplicateDir = join(projectsRoot, duplicateKey)
  const projectBDir = pathsB.projectRoot
  await Promise.all([mkdir(projectADir, { recursive: true }), mkdir(duplicateDir, { recursive: true }), mkdir(projectBDir, { recursive: true })])
  const manifests = [
    [projectADir, { schemaVersion: 1, projectKey: projectA.projectKey, workspaceCwd: projectA.workspaceCwd, displayName: '冲突乙名称' }],
    [duplicateDir, { schemaVersion: 1, projectKey: duplicateKey, workspaceCwd: projectA.workspaceCwd, displayName: '冲突甲名称' }],
    [projectBDir, { schemaVersion: 1, projectKey: projectB.projectKey, workspaceCwd: projectB.workspaceCwd, displayName: '第二工作区旧名' }],
  ]
  for (const [dir, manifest] of manifests) {
    await writeFile(join(dir, 'project.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  const port = await availablePort()
  const base = `http://127.0.0.1:${port}`
  serve = await startServe({ controlRoot, workspace: workspaceA, port, env })
  resource.servePid = serve.child.pid
  browser = await playwright.chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await pairBrowser(context, base, workspaceA, controlRoot, env)
  const page = await context.newPage()
  await page.goto(`${base}/?projectKey=${encodeURIComponent(projectA.projectKey)}&mode=fake`)
  await page.locator('button[data-entry-dialog="workspace-names"]').waitFor({ state: 'visible' })

  await page.waitForFunction(() => document.querySelectorAll('.entry-workspace-folder').length === 2
    && document.querySelectorAll('.entry-workspace-projects details.entry-project').length === 3)
  const initialFolders = await folderNames(page)
  const initialProjects = await projectTitles(page)
  record('initial.one-folder-per-workspace', JSON.stringify(initialFolders) === JSON.stringify(['workspace-alpha', 'workspace-beta']), `folders=${JSON.stringify(initialFolders)}`)
  record('initial.same-workspace-projects-keep-distinct-titles', JSON.stringify(initialProjects) === JSON.stringify(['冲突乙名称', '冲突甲名称', '第二工作区旧名']), `projects=${JSON.stringify(initialProjects)}`)
  await page.screenshot({ path: join(evidenceRoot, 'shots', 'initial.png') })

  await openManagement(page)
  const managementRows = await page.locator('.workspace-management-row').count()
  record('management.one-row-per-workspace', managementRows === 2, `rows=${managementRows}`)
  const initialDialogText = await page.locator('dialog[data-technical-detail="true"]').innerText()
  record('management.uses-workspace-alias', initialDialogText.includes('workspace-alpha') && initialDialogText.includes('workspace-beta'), initialDialogText.replaceAll('\n', ' | '))
  const rows = page.locator('.workspace-management-row')
  const paths = []
  for (let index = 0; index < managementRows; index += 1) paths.push((await rows.nth(index).locator('.workspace-management-identity code').textContent()).trim())
  record('management.paths-preserved', paths.includes(projectA.workspaceCwd) && paths.includes(projectB.workspaceCwd), JSON.stringify(paths))
  await fillBatch(page, new Map([[projectA.workspaceCwd, '产品主工作区'], [projectB.workspaceCwd, '']]))
  await page.locator('.workspace-management-status').filter({ hasText: '1 个，1 个未保存' }).waitFor({ state: 'visible' })
  const mixedStatuses = await page.locator('.workspace-management-row').evaluateAll((nodes) => nodes.map((node) => node.dataset.status))
  record('batch.mixed-result', mixedStatuses.filter((value) => value === 'completed').length === 1 && mixedStatuses.filter((value) => value === 'rejected').length === 1, JSON.stringify(mixedStatuses))
  const failureText = await page.locator('.workspace-management-row[data-status="rejected"] .workspace-management-result').textContent()
  record('batch.failure-reason', /工作区名称不能为空/.test(failureText ?? ''), (failureText ?? '').trim())
  const dialogText = await page.locator('dialog[data-technical-detail="true"]').innerText()
  const titleText = (await page.locator('.entry-scope-title').textContent()) ?? ''
  record('batch.workspace-drawer-uses-alias', dialogText.includes('产品主工作区'), dialogText.replaceAll('\n', ' | '))
  record('batch.project-title-stays-project-display-name', titleText.includes('冲突乙名称') && !titleText.includes('产品主工作区'), `title=${titleText.trim()}`)
  const projectsAfterBatch = await projectTitles(page)
  record('batch.same-workspace-projects-stay-distinct', JSON.stringify(projectsAfterBatch) === JSON.stringify(['冲突乙名称', '冲突甲名称', '第二工作区旧名']), JSON.stringify(projectsAfterBatch))
  await page.screenshot({ path: join(evidenceRoot, 'shots', 'mixed-result.png') })
  await closeManagement(page)

  await stop(serve.child)
  serve = await startServe({ controlRoot, workspace: workspaceA, port, env })
  resource.servePid = serve.child.pid
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.entry-workspace-folder').length === 2
    && document.querySelectorAll('.entry-workspace-projects details.entry-project').length === 3)
  await page.waitForFunction(() => [...document.querySelectorAll('.entry-workspace-folder > summary')].some((node) => node.textContent?.trim() === '产品主工作区'))
  const afterRestartFolders = await folderNames(page)
  record('restart.alias-persisted', afterRestartFolders.includes('产品主工作区'), JSON.stringify(afterRestartFolders))
  record('restart.invalid-row-unchanged', afterRestartFolders.includes('workspace-beta'), JSON.stringify(afterRestartFolders))
  const projectsAfterRestart = await projectTitles(page)
  record('restart.same-workspace-projects-stay-distinct', JSON.stringify(projectsAfterRestart) === JSON.stringify(['冲突乙名称', '冲突甲名称', '第二工作区旧名']), JSON.stringify(projectsAfterRestart))

  await openManagement(page)
  await fillBatch(page, new Map([[projectA.workspaceCwd, '产品主工作区'], [projectB.workspaceCwd, '第二工作区']]))
  await page.locator('.workspace-management-status').filter({ hasText: '已保存 2 个工作区' }).waitFor({ state: 'visible' })
  await closeManagement(page)
  await stop(serve.child)
  serve = await startServe({ controlRoot, workspace: workspaceA, port, env })
  resource.servePid = serve.child.pid
  await page.reload()
  await page.waitForFunction(() => [...document.querySelectorAll('.entry-workspace-folder > summary')].filter((node) => ['产品主工作区', '第二工作区'].includes(node.textContent?.trim() ?? '')).length === 2)
  const finalFolders = await folderNames(page)
  record('restart.batch-persisted', finalFolders.length === 2 && finalFolders.includes('产品主工作区') && finalFolders.includes('第二工作区'), JSON.stringify(finalFolders))
  const finalProjects = await projectTitles(page)
  record('restart.batch-keeps-project-titles-distinct', JSON.stringify(finalProjects) === JSON.stringify(['冲突乙名称', '冲突甲名称', '第二工作区旧名']), JSON.stringify(finalProjects))

  const stored = await Promise.all(manifests.map(async ([dir]) => JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))))
  const pathValues = stored.map((manifest) => manifest.workspaceCwd)
  record('storage.paths-unchanged', pathValues[0] === projectA.workspaceCwd && pathValues[1] === projectA.workspaceCwd && pathValues[2] === projectB.workspaceCwd, JSON.stringify(pathValues))
  record('storage.duplicate-registrations-unified', stored[0].workspaceAlias === '产品主工作区' && stored[1].workspaceAlias === '产品主工作区', JSON.stringify(stored.slice(0, 2).map(({ workspaceAlias }) => workspaceAlias)))
  record('storage.project-display-names-preserved', stored[0].displayName === '冲突乙名称' && stored[1].displayName === '冲突甲名称' && stored[2].displayName === '第二工作区旧名', JSON.stringify(stored.map(({ displayName }) => displayName)))
  await page.screenshot({ path: join(evidenceRoot, 'shots', 'final.png') })
} finally {
  await stop(serve?.child)
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  resource.serveStopped = serve?.child.exitCode !== null
  resource.browserClosed = browser ? !browser.isConnected() : true
  await rm(attemptRoot, { recursive: true, force: true })
  resource.tempRemoved = true
  const ok = checks.every((check) => check.ok)
  await writeFile(join(evidenceRoot, 'receipt.json'), JSON.stringify({ ok, checks, resource }, null, 2))
  if (!ok) process.exitCode = 2
}
