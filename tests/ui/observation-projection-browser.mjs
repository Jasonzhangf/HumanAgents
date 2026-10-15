#!/usr/bin/env node

/**
 * Real-browser DOM proof for the observation page node flow and selected-node refs.
 *
 * The harness serves the real `docs/ui` observation page over a loopback HTTP
 * server and answers the observation GET with the payloads captured by the
 * accepted served-host run (task-34, `p30-accept-frozen-semantic-ui-20261010`).
 * It binds the assertions to the rendered DOM of the real `observation.js`
 * entry, not to source strings.
 *
 * There is no synthetic payload fallback. Set:
 *   OBSERVATION_PROJECTION_EVIDENCE  the accepted run's `evidence` directory (input)
 *   OBSERVATION_PROJECTION_OUT       an execution-owned directory for this run's output
 *
 * The negative cases below are derived from the real capture by deleting exactly
 * the field under test (node state, selected-node ref arrays). They assert that
 * an unprojected node stays `unknown` and an empty ref array stays explicit, so
 * the fix cannot hardcode success.
 */

import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const uiRoot = resolve(process.env.OBSERVATION_PROJECTION_UI_ROOT ?? join(repoRoot, 'docs', 'ui'))
const evidenceRoot = process.env.OBSERVATION_PROJECTION_EVIDENCE?.trim()
const outRoot = process.env.OBSERVATION_PROJECTION_OUT?.trim()

if (!evidenceRoot) {
  throw new Error('OBSERVATION_PROJECTION_EVIDENCE is required; point it at the accepted served-host evidence directory')
}
if (!outRoot) {
  throw new Error('OBSERVATION_PROJECTION_OUT is required; point it at an execution-owned output directory')
}

const playwrightModule = await import(
  process.env.OBSERVATION_PROJECTION_PLAYWRIGHT ?? '/opt/homebrew/lib/node_modules/playwright/index.js',
)
const playwright = playwrightModule.default ?? playwrightModule

const readJson = async (name) => JSON.parse(await readFile(join(evidenceRoot, name), 'utf8'))
const realRoot = await readJson('observation.api.json')
const realSelected = await readJson('observation.selected-node.api.json')
const realSemantic = await readJson('semantic.api.json')

// Task identity comes from the captured scope ref; nothing here is hand-written.
const scopeRef = realRoot.scope.scopeRef
const taskId = scopeRef.replace(/^task:\/\//, '').replace(/\/observation$/, '')
const selectedNodeId = realSelected.selectedNode.nodeId
const noStateTaskId = `${taskId}-unprojected-state`
const emptyRefsNodeId = realRoot.nodes.find((node) => node.nodeId !== selectedNodeId).nodeId

// Raw lifecycle state per node id, as the projection reports it on the scope view.
const expectedState = new Map(realRoot.scope.nodes.map((node) => [node.nodeId, node.state]))
// Human state label the node card carries on the top-level pipeline node projection.
const expectedDisplay = new Map(realRoot.nodes.map((node) => [node.nodeId, node.stateDisplay]))

function rowOf(node) {
  return typeof node.row === 'number' ? node.row : Number.MAX_SAFE_INTEGER
}

function toneOf(state) {
  if (state === 'running' || state === 'settling' || state === 'admitted') return 'active'
  if (state === 'succeeded' || state === 'stopped') return 'done'
  return 'pending'
}

const orderedNodes = [...realRoot.nodes].sort((a, b) => rowOf(a) - rowOf(b))
const expectedEdgeTones = orderedNodes.slice(1).map((node) => toneOf(expectedState.get(node.nodeId)))

const expectedInputs = realSelected.selectedNode.inputs.map((entry) => entry.ref)
const expectedOutputs = realSelected.selectedNode.outputs.map((entry) => entry.ref)
const expectedEvidence = realSelected.selectedNode.evidenceRefs.map((ref) => ref.locator)

// Negative case 1: the projection reports no state for any node. The page must
// keep the explicit `unknown` negative instead of inventing a settled state.
function withoutNodeState(payload) {
  const clone = structuredClone(payload)
  for (const node of clone.scope.nodes) delete node.state
  for (const node of clone.nodes) delete node.stateDisplay
  return clone
}

// Negative case 2: the selected node really has no refs. The empty arrays must
// stay visible as the explicit empty projection, never as fabricated refs.
function withoutSelectedRefs(payload) {
  const clone = structuredClone(payload)
  clone.selectedNode.nodeId = emptyRefsNodeId
  clone.selectedNode.title = realRoot.nodes.find((node) => node.nodeId === emptyRefsNodeId).title
  clone.selectedNode.inputs = []
  clone.selectedNode.outputs = []
  clone.selectedNode.evidenceRefs = []
  return clone
}

const runtimeStatus = {
  mode: 'rcc',
  state: 'ready',
  providerState: 'ready',
  connected: true,
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function mimeType(filePath) {
  return MIME[extname(filePath)] ?? 'application/octet-stream'
}

function sendJson(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/api/runtime/status') {
      sendJson(res, runtimeStatus)
      return
    }
    const observation = url.pathname.match(/^\/api\/tasks\/([^/]+)\/observation$/)
    if (observation) {
      const task = decodeURIComponent(observation[1])
      const node = url.searchParams.get('node')
      if (task === noStateTaskId) {
        sendJson(res, withoutNodeState(realRoot))
        return
      }
      if (node === emptyRefsNodeId) {
        sendJson(res, withoutSelectedRefs(realSelected))
        return
      }
      sendJson(res, node ? realSelected : realRoot)
      return
    }
    if (/^\/api\/tasks\/[^/]+\/semantic$/.test(url.pathname)) {
      sendJson(res, realSemantic)
      return
    }
    if (/^\/api\/tasks\/[^/]+\/semantic\/stream$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end()
      return
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!relative || relative.split('/').includes('..')) {
      res.writeHead(400)
      res.end('bad path')
      return
    }
    const filePath = resolve(uiRoot, relative)
    if (!filePath.startsWith(`${uiRoot}${sep}`)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    try {
      const body = await readFile(filePath)
      res.writeHead(200, { 'content-type': mimeType(filePath) })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

const checks = []
let failures = 0
const observations = []

function record(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: detail === undefined ? null : detail })
  if (!pass) failures += 1
}

function observe(name, value) {
  observations.push({ name, value })
}

async function waitForCondition(page, predicate, timeout = 15_000) {
  try {
    await page.waitForFunction(predicate, undefined, { timeout })
    return true
  } catch {
    return false
  }
}

async function readFlow(page) {
  return page.evaluate(() => ({
    nodes: [...document.querySelectorAll('.flow-node')].map((card) => ({
      nodeId: card.dataset.nodeId,
      state: card.dataset.state,
      chipText: card.querySelector('.state-chip')?.textContent ?? '',
      chipTone: card.querySelector('.state-chip')?.dataset.tone ?? '',
    })),
    edgeList: [...document.querySelectorAll('.flow-edges-list li')].map((item) => item.dataset.tone),
  }))
}

async function readDrawerRefs(page) {
  return page.evaluate(() => {
    const sheet = [...document.querySelectorAll('.drawer-section')]
      .find((section) => section.dataset.tabId === 'refs')
    return {
      present: Boolean(sheet),
      facts: sheet
        ? [...sheet.querySelectorAll('.drawer-facts > div')].map((cell) => ({
            label: cell.querySelector('dt')?.textContent ?? '',
            value: cell.querySelector('dd')?.textContent ?? '',
            empty: cell.querySelector('dd')?.dataset.empty === 'true',
          }))
        : [],
    }
  })
}

const launchArgs = (process.env.OBSERVATION_PROJECTION_BROWSER_ARGS ?? '--single-process,--no-zygote')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

await mkdir(outRoot, { recursive: true })
const { server, origin } = await serve()
const browser = await playwright.chromium.launch({ headless: true, args: launchArgs })
let browserErrors = []
let bodyText = ''

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // --- Real captured payload: the served observation page must render its state.
  await page.goto(`${origin}/observation.html?task=${encodeURIComponent(taskId)}`, { waitUntil: 'domcontentloaded' })
  await waitForCondition(page, () => document.querySelectorAll('.flow-node').length > 0)

  const flow = await readFlow(page)
  observe('flow', flow)
  record('flow-node-count-matches-projection', flow.nodes.length === realRoot.nodes.length, {
    rendered: flow.nodes.length,
    projection: realRoot.nodes.length,
  })

  const stateMismatches = flow.nodes
    .filter((node) => node.state !== expectedState.get(node.nodeId))
    .map((node) => ({ nodeId: node.nodeId, rendered: node.state, projection: expectedState.get(node.nodeId) }))
  record('flow-node-state-matches-projection-scope-state', stateMismatches.length === 0, stateMismatches)

  const displayMismatches = flow.nodes
    .filter((node) => node.chipText !== expectedDisplay.get(node.nodeId))
    .map((node) => ({ nodeId: node.nodeId, rendered: node.chipText, projection: expectedDisplay.get(node.nodeId) }))
  record('flow-node-state-chip-uses-projection-state-display', displayMismatches.length === 0, displayMismatches)

  const edgeMismatches = flow.edgeList
    .map((tone, index) => ({ index, rendered: tone, projection: expectedEdgeTones[index] }))
    .filter((edge) => edge.rendered !== edge.projection)
  record('flow-edge-tones-follow-projection-node-state', edgeMismatches.length === 0, {
    mismatches: edgeMismatches,
    rendered: flow.edgeList,
    projection: expectedEdgeTones,
  })
  record(
    'flow-edges-are-not-all-pending-for-a-settled-scope',
    flow.edgeList.includes('done'),
    { rendered: flow.edgeList },
  )

  // --- Real captured payload: the drawer refs tab must show the selected refs.
  await page.click(`.flow-node[data-node-id="${selectedNodeId}"]`)
  const drawerOpened = await waitForCondition(page, () => document.querySelector('dialog[open]') !== null)
  record('drawer-opens-on-node-selection', drawerOpened)
  await page.click('button[data-tab-id="refs"]')
  const refs = await readDrawerRefs(page)
  observe('selectedNodeRefs', refs)
  const byLabel = (label) => refs.facts.find((fact) => fact.label === label)
  record('drawer-refs-show-selected-node-inputs', byLabel('输入引用')?.value === expectedInputs.join(', '), {
    rendered: byLabel('输入引用'),
    projection: expectedInputs,
  })
  record('drawer-refs-show-selected-node-outputs', byLabel('输出引用')?.value === expectedOutputs.join(', '), {
    rendered: byLabel('输出引用'),
    projection: expectedOutputs,
  })
  record('drawer-refs-show-selected-node-evidence', byLabel('Evidence')?.value === expectedEvidence.join(', '), {
    rendered: byLabel('Evidence'),
    projection: expectedEvidence,
  })
  record(
    'drawer-refs-are-not-marked-empty-when-the-projection-has-refs',
    refs.facts.filter((fact) => fact.empty).length === 0,
    refs.facts,
  )

  // --- Negative case: an empty ref array stays the explicit empty projection.
  await page.click('button[data-action="close-drawer"]')
  await waitForCondition(page, () => document.querySelector('dialog[open]') === null)
  await page.click(`.flow-node[data-node-id="${emptyRefsNodeId}"]`)
  await waitForCondition(page, () => document.querySelector('dialog[open]') !== null)
  await page.click('button[data-tab-id="refs"]')
  const emptyRefs = await readDrawerRefs(page)
  observe('emptySelectedNodeRefs', emptyRefs)
  record('drawer-refs-empty-arrays-stay-explicit', emptyRefs.facts.length === 3 && emptyRefs.facts.every((fact) => fact.empty), emptyRefs.facts)

  // --- Negative case: an unprojected node state stays the explicit `unknown`.
  await page.goto(`${origin}/observation.html?task=${encodeURIComponent(noStateTaskId)}`, { waitUntil: 'domcontentloaded' })
  await waitForCondition(page, () => document.querySelectorAll('.flow-node').length > 0)
  const noStateFlow = await readFlow(page)
  observe('unprojectedFlow', noStateFlow)
  record(
    'unprojected-node-state-stays-unknown',
    noStateFlow.nodes.length > 0 && noStateFlow.nodes.every((node) => node.state === 'unknown' && node.chipTone === 'gray'),
    noStateFlow.nodes,
  )
  record(
    'unprojected-node-edges-stay-pending',
    noStateFlow.edgeList.length > 0 && noStateFlow.edgeList.every((tone) => tone === 'pending'),
    noStateFlow.edgeList,
  )

  record('observation-page-raised-no-errors', pageErrors.length === 0, pageErrors)
  browserErrors = pageErrors
  bodyText = await page.evaluate(() => document.body.innerText)
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}

const summary = {
  taskId,
  selectedNodeId,
  evidenceRoot,
  checks,
  observations,
  failures,
  total: checks.length,
  passed: checks.length - failures,
}
await writeFile(join(outRoot, 'checks.json'), JSON.stringify(summary, null, 2), 'utf8')
await writeFile(join(outRoot, 'browser-text.txt'), bodyText, 'utf8')
await writeFile(join(outRoot, 'browser-errors.txt'), browserErrors.join('\n'), 'utf8')

for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`)
}
console.log(`observation projection browser proof ${failures === 0 ? 'passed' : 'failed'} ${checks.length - failures}/${checks.length}`)
process.exit(failures === 0 ? 0 : 1)
