// Isolated public-page acceptance. No service, provider or production writes.
// Failure basis: a serve-bound Jenny was copied into other project rows, and
// roster failures collapsed to an empty member list. Impact: users could send
// to the wrong project or believe a failed read proved there were no members.
// Cost: one short-lived Chromium and synthetic HTTP fixtures.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import playwright from '/opt/homebrew/lib/node_modules/playwright/index.js'

const root = resolve(import.meta.dirname, '../../docs/ui')
const evidence = process.env.PROJECT_SIDEBAR_EVIDENCE
  || resolve(import.meta.dirname, '../../docs/verification/project-sidebar-20261124')
await mkdir(evidence, { recursive: true })
const browser = await playwright.chromium.launch({ headless: true })
const checks = []
const check = (name, condition) => { assert.ok(condition, name); checks.push(name) }
const current = {
  projectKey: 'humanagent-current', projectName: 'HumanAgent', agentName: 'Jenny',
  workspaceCwd: '/isolated/projects/humanagent', topicName: '主会话', mode: 'rcc',
  agentId: 'agent-jenny', canonicalAddress: 'machine.humanagent-current.Jenny', role: 'project-lead',
  scope: { kind: 'project', projectKey: 'humanagent-current' },
}
const projects = [
  { scope: { projectKey: 'humanagent-current' }, label: 'HumanAgent', workspaceCwd: '/isolated/projects/humanagent' },
  { scope: { projectKey: 'humanagent-client' }, label: '客户交付', workspaceCwd: '/isolated/projects/humanagent' },
  { scope: { projectKey: 'alpha' }, label: 'Alpha', workspaceCwd: '/isolated/projects/alpha' },
  { scope: { projectKey: 'beta' }, label: 'Beta', workspaceCwd: '/isolated/projects/beta' },
  { scope: { projectKey: 'gamma' }, label: 'Gamma' },
]
const projectUrl = 'http://sidebar-acceptance.test/?scope=project&projectKey=humanagent-current&mode=rcc'
const projectProjection = () => ({ ...current, surface: 'main-topic', tasks: [], activeTask: null, turns: [] })
const alexProjection = () => ({ surface: 'main-topic', agentName: 'Alex', agentId: 'agent-alex',
  canonicalAddress: 'machine.CEO', role: 'ceo', scope: { kind: 'alex' }, topicName: '主会话',
  tasks: [], activeTask: null, turns: [] })
const mainTopicScopes = []
const explicitRequests = []

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    assert.equal(url.origin, 'http://sidebar-acceptance.test')
    if (url.pathname.startsWith('/api/')) {
      let status = 200
      let data
      if (url.pathname === '/api/runtime/status') data = { mode: 'rcc', state: 'ready', connected: true }
      else if (url.pathname === '/api/main-topic') {
        const scope = url.searchParams.get('scope')
        mainTopicScopes.push(scope)
        data = scope === 'system' || scope === 'alex' || scope === null ? alexProjection() : projectProjection()
      }
      else if (url.pathname === '/api/dashboard') data = { projects }
      else if (url.pathname.startsWith('/api/explicit/')) {
        explicitRequests.push({ path: url.pathname, search: url.search, method: request.method() })
        if (url.pathname === '/api/explicit/inputs') data = { interactionId: 'alex-chat' }
        else if (url.pathname === '/api/explicit/interactions/alex-chat') {
          data = { state: 'answered', reply: '隔离的 Alex 已直接回答。', scope: { kind: 'alex' },
            agentId: 'agent-alex', canonicalAddress: 'machine.CEO', role: 'ceo' }
        } else {
          status = 404
          data = { error: { code: 'fixture.unavailable', message: '此隔离入口未提供该能力' } }
        }
      }
      else if (url.pathname === '/api/projects/roster') {
        const projectKey = url.searchParams.get('projectKey')
        if (projectKey === 'alpha') {
          status = 404
          data = { code: 'project.unknown', message: 'isolated roster unavailable' }
        } else if (projectKey === 'gamma') data = { projectKey, rosterState: 'not-initialized', members: [] }
        else data = { projectKey, rosterState: 'configured', members: [] }
      } else if (url.pathname === '/api/tasks') data = { draft: [], waiting: [], running: [], completed: [], stopped: [], failed: [] }
      else if (url.pathname === '/api/product/session') data = { messages: [], usage: { calls: [] } }
      else {
        status = 404
        data = { error: { code: 'fixture.unavailable', message: '此隔离入口未提供该能力' } }
      }
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    assert.ok(path.startsWith(root + '/'))
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)]
    return route.fulfill({ contentType: type, body: await readFile(path) })
  })

  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(projectUrl)
  await page.waitForFunction(() => document.querySelectorAll('.entry-project').length === 5)
  await page.waitForFunction(() => document.querySelectorAll('.member-roster-state').length >= 4)
  await page.locator('.entry-project-current').waitFor()
  await page.locator('.entry-workspace-current').waitFor()

  check('Alex has an independent rail section', await page.locator('.entry-alex .entry-ceo').count() === 1
    && await page.locator('.entry-projects .entry-ceo').count() === 0)
  check('five project entries are grouped by workspace path', await page.locator('.entry-project').count() === 5
    && await page.locator('.entry-workspace-folder').count() === 4)
  const shared = page.locator('.entry-workspace-folder').filter({ has: page.locator('[data-project-key="humanagent-current"]') })
  check('one workspace keeps two project blocks', await shared.locator('.entry-project').count() === 2)
  check('only the bound project has the default Jenny member row',
    await page.locator('[data-project-key="humanagent-current"] .entry-jenny').count() === 1
      && await page.locator('.entry-project:not([data-project-key="humanagent-current"]) .entry-jenny').count() === 0)
  check('the current project and workspace are visibly marked once',
    await page.locator('.entry-project-current').count() === 1
      && await page.locator('.entry-workspace-current').count() === 1
      && await page.locator('.entry-project-current > summary[aria-current="page"]').count() === 1
      && await page.locator('.entry-workspace-current > summary[aria-current="page"]').count() === 1)
  check('roster 404 remains visible', await page.locator('[data-project-key="alpha"] .member-roster-state')
    .getByText(/成员名册读取失败（HTTP 404）/).count() === 1)
  check('configured empty roster is stated explicitly', await page.locator('[data-project-key="beta"] .member-roster-state')
    .getByText('暂无历史成员。', { exact: true }).count() === 1)
  check('uninitialized roster has its own state', await page.locator('[data-project-key="gamma"] .member-roster-state')
    .getByText('成员名册尚未初始化。', { exact: true }).count() === 1)

  const jenny = page.locator('[data-project-key="humanagent-current"] .entry-jenny')
  check('current Jenny link points back to the same document',
    new URL(await jenny.getAttribute('href'), page.url()).href === page.url()
      && await jenny.getAttribute('aria-current') === 'page')
  await page.evaluate(() => { window.__sidebarSameDocument = true })
  await jenny.click()
  await page.waitForTimeout(200)
  check('clicking current Jenny keeps the same document', await page.evaluate(() => window.__sidebarSameDocument === true))
  check('clicking current Jenny focuses the existing composer',
    await page.locator('textarea[name=rawInput]').evaluate((node) => node === document.activeElement))
  check('every other project retains its default Jenny with an explicit unavailable state',
    await page.locator('.member-roster-default-unavailable').count() === 4)
  await page.locator('.entry-project[data-project-key="beta"] > summary').click()
  await page.locator('.entry-project[data-project-key="beta"] .member-roster-default-unavailable').click()
  await page.getByText('此项目的默认 Jenny 会话入口尚未接入当前服务。', { exact: true }).waitFor()
  check('other Jenny opens only its own state without navigation', page.url() === projectUrl
    && await page.locator('dialog[open]').getByText('项目：Beta', { exact: true }).count() === 1)
  await page.locator('dialog[open] .shell-layer-close').click()
  await page.screenshot({ path: resolve(evidence, 'desktop-1440.png') })

  await page.goto('http://sidebar-acceptance.test/?projectKey=alpha&mode=rcc')
  await page.getByText('当前服务未提供所选项目的主会话入口。请从项目栏返回当前服务项目。', { exact: true }).waitFor()
  check('cross-project URL cannot borrow Jenny or current highlighting',
    await page.locator('.entry-jenny').count() === 0 && await page.locator('.entry-project-current').count() === 0)

  await page.goto('http://sidebar-acceptance.test/?scope=system')
  await page.locator('.entry-scope-title').getByText('Alex · CEO', { exact: true }).waitFor()
  check('scope=system accepts the real Alex projection and keeps the composer available',
    await page.locator('.entry-ceo[aria-current="page"]').count() === 1
      && await page.locator('.entry-project-current').count() === 0
      && await page.locator('textarea[name=rawInput]').isVisible()
      && await page.getByRole('button', { name: '发送给 Alex', exact: true }).isEnabled())
  check('scope=system sends the same typed scope to the main-topic read',
    mainTopicScopes.at(-1) === 'system')

  await page.goto('http://sidebar-acceptance.test/')
  await page.locator('.entry-scope-title').getByText('Alex · CEO', { exact: true }).waitFor()
  check('bare / resolves to Alex without a Jenny fallback',
    await page.locator('.entry-ceo[aria-current="page"]').count() === 1
      && await page.getByText('继续和 Alex 对话', { exact: true }).count() === 1
      && await page.getByRole('button', { name: '发送给 Alex', exact: true }).isEnabled())
  await page.locator('textarea[name=rawInput]').fill('你好，Alex')
  const alexReply = page.waitForResponse((response) => response.url().includes('/api/explicit/interactions/alex-chat'))
  await page.getByRole('button', { name: '发送给 Alex', exact: true }).click()
  await alexReply
  check('Alex entry submits with the same typed scope on input and interaction reads',
    explicitRequests.length >= 2
      && explicitRequests.every(({ search }) => new URLSearchParams(search).get('scope') === 'system')
      && explicitRequests.some(({ path, method }) => path === '/api/explicit/inputs' && method === 'POST')
      && explicitRequests.some(({ path, method }) => path === '/api/explicit/interactions/alex-chat' && method === 'GET'))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('http://sidebar-acceptance.test/')
  await page.waitForFunction(() => document.querySelectorAll('.entry-project').length === 5)
  await page.getByRole('button', { name: '打开项目菜单' }).click()
  await page.getByRole('button', { name: '关闭菜单' }).waitFor()
  const narrow = await page.evaluate(() => ({
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
    railOverflow: document.querySelector('.entry-rail').scrollWidth > document.querySelector('.entry-rail').clientWidth,
    drawer: document.querySelector('.entry-rail-dialog')?.getBoundingClientRect().toJSON(),
  }))
  check('narrow rail remains inside the viewport without horizontal overflow',
    !narrow.pageOverflow && !narrow.railOverflow && narrow.drawer.left >= 0 && narrow.drawer.right <= 391)
  await page.screenshot({ path: resolve(evidence, 'mobile-390.png') })
  check('no page errors', errors.length === 0)
  await context.close()
} finally {
  await browser.close()
}

const receipt = { checks, passed: checks.length, evidence }
await import('node:fs/promises').then(({ writeFile }) => writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)))
console.log(JSON.stringify(receipt))
