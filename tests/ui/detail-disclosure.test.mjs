import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createDetailDisclosure } from '../../docs/ui/detail-disclosure.js'

// Known failure: expanding raw data changes the chat height, or a second
// component replaces the first component's details. Small public DOM port.
class Node {
  constructor(tag, text, className) { Object.assign(this, { tag, text, className, children: [], events: {}, style: {}, isConnected: true, open: false }) }
  append(...nodes) { this.children.push(...nodes) }
  setAttribute() {}
  addEventListener(name, fn) { this.events[name] = fn }
  showModal() { this.open = true }
  close() { this.open = false; this.events.close() }
  focus(options) { this.focusOptions = options }
  remove() { this.isConnected = false }
}
const make = (...args) => new Node(...args)
test('chat details use the shared modal instead of native inline disclosures', async () => {
  for (const file of ['call-usage-footer', 'tool-presentation', 'product-session-view', 'task']) {
    const source = await readFile(new URL(`../../docs/ui/${file}.js`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /(?:make|element)\('details'/, file)
    assert.match(source, /createDetailDisclosure/, file)
  }
})
test('independent modal readers populate once, close separately and restore focus without scrolling', () => {
  const a = createDetailDisclosure(make, '调用明细')
  const b = createDetailDisclosure(make, '工具原文')
  let reads = 0
  a.onFirstOpen(() => { reads++; a.content.append(make('p', 'A')) })
  assert.equal(reads, 0)
  a.button.events.click(); b.button.events.click()
  assert.equal(a.dialog.open, true)
  assert.equal(b.dialog.open, true)
  b.dialog.close()
  assert.equal(a.dialog.open, true)
  assert.deepEqual(b.button.focusOptions, { preventScroll: true })
  a.dialog.close(); a.button.events.click()
  assert.equal(reads, 1)
  assert.equal(a.content.children[0].text, 'A')
  a.dispose()
  assert.equal(a.dialog.open, false)
})
