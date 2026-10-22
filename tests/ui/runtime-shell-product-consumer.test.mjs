import test from 'node:test'
import assert from 'node:assert/strict'

import * as runtimeShell from '../../docs/ui/runtime-shell.js'

// Minimal DOM used only by this consumer. It supports the element operations the
// shared shell actually performs: append/prepend/remove, class names, dataset,
// attributes, dialog open/close events and simple selector lookup. It is not a
// browser replacement and deliberately has no store, registry or event bus.
class FakeText {
  constructor(text) {
    this.nodeType = 3
    this.parentNode = null
    this.textContent = String(text)
  }

  remove() {
    this.parentNode?.removeChild(this)
  }
}

class FakeElement {
  constructor(tagName) {
    this.nodeType = 1
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attributes = new Map()
    this.dataset = {}
    this.className = ''
    this.id = ''
    this.href = ''
    this.type = ''
    this.title = ''
    this.value = ''
    this.disabled = false
    this.hidden = false
    this.open = false
    this.listeners = new Map()
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean))
        for (const name of names) current.add(name)
        this.className = [...current].join(' ')
      },
      remove: (...names) => {
        const remove = new Set(names)
        this.className = this.className.split(/\s+/).filter((name) => name && !remove.has(name)).join(' ')
      },
      toggle: (name, force) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean))
        const next = force === undefined ? !current.has(name) : Boolean(force)
        if (next) current.add(name)
        else current.delete(name)
        this.className = [...current].join(' ')
        return next
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    }
  }

  get firstChild() {
    return this.children[0] || null
  }

  get isConnected() {
    let node = this
    while (node) {
      if (node === globalThis.document?.body) return true
      node = node.parentNode
    }
    return false
  }

  get textContent() {
    return this.children.map((child) => child.textContent).join('')
  }

  set textContent(value) {
    this.children = []
    const text = value === undefined || value === null ? '' : String(value)
    if (text !== '') this.appendChild(new FakeText(text))
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === undefined || node === null) continue
      const child = typeof node === 'string' ? new FakeText(node) : node
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.children.push(child)
    }
  }

  appendChild(node) {
    this.append(node)
    return node
  }

  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      if (node === undefined || node === null) continue
      const child = typeof node === 'string' ? new FakeText(node) : node
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this
      this.children.unshift(child)
    }
  }

  insertBefore(node, reference) {
    if (node === undefined || node === null) return node
    if (node.parentNode) node.parentNode.removeChild(node)
    node.parentNode = this
    const index = reference ? this.children.indexOf(reference) : -1
    if (index < 0) this.children.push(node)
    else this.children.splice(index, 0, node)
    return node
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null
    this.children = []
    this.append(...nodes)
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index < 0) return null
    this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    this.parentNode?.removeChild(this)
  }

  contains(node) {
    while (node) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    this.listeners.set(type, listeners.filter((entry) => entry !== listener))
  }

  dispatchEvent(event) {
    event.target = this
    for (const listener of this.listeners.get(event.type) || []) listener(event)
    return true
  }

  click() {
    this.dispatchEvent({ type: 'click', preventDefault() {} })
  }

  focus() {
    if (globalThis.document) globalThis.document.activeElement = this
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }

  querySelectorAll(selector) {
    const matches = []
    const visit = (node) => {
      if (node.nodeType !== 1) return
      if (matchesSelector(node, selector)) matches.push(node)
      for (const child of node.children) visit(child)
    }
    for (const child of this.children) visit(child)
    return matches
  }

  showModal() {
    this.open = true
    this.setAttribute('open', '')
  }

  close() {
    if (!this.open) return
    this.open = false
    this.removeAttribute('open')
    this.dispatchEvent({ type: 'close', preventDefault() {} })
  }
}

function matchesSelector(element, selector) {
  const match = /^([a-z0-9-]+)?((?:\.[a-zA-Z0-9_-]+)*)((?:\[[a-zA-Z0-9_-]+\])*)$/.exec(selector)
  if (!match) return false
  const [, tag, classes, attributes] = match
  if (tag && element.tagName !== tag.toUpperCase()) return false
  for (const name of classes.split('.').filter(Boolean)) {
    if (!element.classList.contains(name)) return false
  }
  for (const raw of attributes.match(/\[[^\]]+\]/g) || []) {
    const name = raw.slice(1, -1)
    if (!element.hasAttribute?.(name) && element.getAttribute(name) === null) return false
  }
  return true
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body')
    this.activeElement = null
  }

  createElement(tag) {
    return new FakeElement(tag)
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector)
  }
}

const document = new FakeDocument()
const windowListeners = new Map()
const window = {
  innerWidth: 1440,
  mobileMatches: false,
  addEventListener(type, listener) {
    const listeners = windowListeners.get(type) || []
    listeners.push(listener)
    windowListeners.set(type, listeners)
  },
  removeEventListener(type, listener) {
    const listeners = windowListeners.get(type) || []
    windowListeners.set(type, listeners.filter((entry) => entry !== listener))
  },
  matchMedia(query) {
    assert.match(query, /max-width: 900px/)
    return { matches: window.mobileMatches, addEventListener() {}, removeEventListener() {} }
  },
}

globalThis.HTMLElement = FakeElement
globalThis.document = document
globalThis.window = window
globalThis.CSS = { escape: (value) => String(value) }

function makeRoot() {
  const root = new FakeElement('div')
  document.body.append(root)
  return root
}

function classed(element, className) {
  return element.className.split(/\s+/).includes(className)
}

test('mountProductShell exposes stable board, center, relation, drawer and config hosts', () => {
  const root = makeRoot()
  const product = runtimeShell.mountProductShell(root, { layout: 'work', title: '任务' })

  assert.equal(product.layout, 'work')
  for (const name of ['board', 'center', 'relation', 'drawer', 'config']) {
    assert.ok(product.hosts[name] instanceof FakeElement, `${name} host is missing`)
  }
  for (const name of ['page', 'heading', 'status', 'primary', 'support', 'composer']) {
    assert.ok(product.hosts[name] instanceof FakeElement, `base host ${name} is missing`)
  }
  assert.equal(product.hosts.center, product.hosts.primary)
  assert.ok(classed(product.hosts.config, 'shell-controls'))
  assert.ok(classed(product.hosts.config, 'product-edge-config'))
  assert.ok(product.hosts.board.isConnected)
  assert.ok(product.hosts.relation.isConnected)
  assert.ok(product.hosts.drawer.isConnected)

  product.dispose()
  assert.equal(root.children.length, 0)
})

test('board navigation and relation share one drawer and restore hosts on close', () => {
  const root = makeRoot()
  const product = runtimeShell.mountProductShell(root, { layout: 'collection', title: '板块' })
  window.mobileMatches = true

  product.openDrawer('board')
  assert.equal(product.hosts.drawer.parentNode.open, true)
  assert.equal(product.hosts.board.parentNode, product.hosts.drawer)
  assert.equal(product.hosts.drawer.children.length, 1)

  product.setDrawerTab('detail')
  assert.equal(product.hosts.relation.parentNode, product.hosts.drawer)
  assert.equal(product.hosts.drawer.children.length, 1)
  assert.equal(product.hosts.board.parentNode.contains(product.hosts.board), true)
  assert.notEqual(product.hosts.board.parentNode, product.hosts.drawer)

  product.closeDrawer()
  assert.equal(product.hosts.drawer.parentNode.open, false)
  assert.notEqual(product.hosts.relation.parentNode, product.hosts.drawer)
  assert.equal(product.hosts.relation.parentNode.querySelector('.product-relation-body'), product.hosts.relation)

  product.openBoard()
  assert.equal(product.hosts.drawer.parentNode.open, true)
  assert.equal(product.hosts.board.parentNode, product.hosts.drawer)

  product.openRelation()
  assert.equal(product.hosts.relation.parentNode, product.hosts.drawer)
  assert.notEqual(product.hosts.board.parentNode, product.hosts.drawer)

  product.closeRelation()
  assert.equal(product.hosts.drawer.parentNode.open, false)
  assert.notEqual(product.hosts.relation.parentNode, product.hosts.drawer)

  product.dispose()
  window.mobileMatches = false
})

test('desktop relation opens and closes in place without a drawer', () => {
  const root = makeRoot()
  const product = runtimeShell.mountProductShell(root, { layout: 'work', title: '焦点' })
  window.mobileMatches = false

  const relationLayer = product.hosts.relation.parentNode
  assert.equal(relationLayer.dataset.open, 'false')
  assert.equal(relationLayer.hidden, true)

  product.openRelation()
  assert.equal(relationLayer.dataset.open, 'true')
  assert.equal(relationLayer.hidden, false)
  assert.equal(product.hosts.drawer.parentNode.open, false)

  relationLayer.querySelector('.product-relation-close').click()
  assert.equal(relationLayer.dataset.open, 'false')
  assert.equal(relationLayer.hidden, true)

  product.dispose()
})

test('the product shell has no global store and two instances stay independent', () => {
  const before = new Set(Object.keys(globalThis))
  const rootA = makeRoot()
  const rootB = makeRoot()
  const a = runtimeShell.mountProductShell(rootA, { layout: 'work', title: 'A' })
  const b = runtimeShell.mountProductShell(rootB, { layout: 'work', title: 'B' })

  a.openDrawer('board')
  assert.equal(a.hosts.drawer.parentNode.open, true)
  assert.equal(b.hosts.drawer.parentNode.open, false)

  const added = Object.keys(globalThis).filter((key) => !before.has(key))
  assert.deepEqual(added, [])
  assert.deepEqual(
    Object.keys(runtimeShell).filter((key) => ['store', 'registry', 'eventBus', 'eventbus', 'globalStore'].includes(key)),
    [],
  )

  a.dispose()
  b.dispose()
})

test('mountPageTemplate keeps its existing contract and disposal', () => {
  const root = makeRoot()
  const template = runtimeShell.mountPageTemplate(root, { layout: 'work', title: '旧模板' })

  for (const name of ['page', 'heading', 'status', 'primary', 'support', 'composer']) {
    assert.ok(template.hosts[name] instanceof FakeElement)
  }
  assert.ok(root.querySelector('.topbar'))
  assert.equal(typeof template.setBreadcrumbs, 'function')
  assert.equal(typeof template.detail.open, 'function')
  assert.equal(typeof template.dispose, 'function')

  template.dispose()
  assert.equal(root.children.length, 0)
})
