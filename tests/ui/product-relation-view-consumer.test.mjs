/*
 * R view consumer.
 *
 * Basis: the relation chain is a read-only projection. The failures with real
 * impact are a same-title node appearing without an edge fact, a duplicated
 * node after repeated lineage, and an upstream/downstream switch that returns
 * the wrong endpoint. Cost is one small element adapter over the real module.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  focusFromRelation,
  productRelationNodes,
  relationDirection,
  relationGroup,
  renderProductRelationChain,
} from '../../docs/ui/product-relation-view.js'

function createElement(tag, text, className) {
  const listeners = new Map()
  const node = {
    tagName: String(tag).toUpperCase(),
    textContent: text === undefined ? '' : String(text),
    className: className || '',
    children: [],
    attributes: {},
    append(...items) {
      for (const item of items) {
        if (item !== undefined && item !== null) node.children.push(item)
      }
    },
    replaceChildren(...items) {
      node.children = items.filter((item) => item !== undefined && item !== null)
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name)
        ? node.attributes[name]
        : null
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    click() {
      for (const listener of listeners.get('click') ?? []) listener({ type: 'click' })
    },
  }
  return node
}

function walk(node) {
  return [node, ...node.children.flatMap((child) => walk(child))]
}

function text(node) {
  return [node.textContent, ...node.children.map((child) => text(child))]
    .filter(Boolean)
    .join(' ')
}

function nodes(root, predicate) {
  return walk(root).filter(predicate)
}

function targeted(root) {
  return nodes(root, (node) => node.getAttribute('data-product-target') !== null)
}

function sections(root, name) {
  return nodes(root, (node) => node.getAttribute('data-product-relation-section') === name)
}

function groups(root, name) {
  return nodes(root, (node) => node.getAttribute('data-product-relation-group') === name)
}

const parentId = { scope: 'task', value: 'parent' }
const childId = { scope: 'task', value: 'child' }
const parentScope = { kind: 'task', projectKey: 'p', mode: 'fake', taskId: parentId }
const childScope = { kind: 'task', projectKey: 'p', mode: 'fake', taskId: childId }
const parentRef = { kind: 'interaction', taskRef: parentId, scope: parentScope }
const childRef = { kind: 'interaction', taskRef: childId, scope: childScope }
const occurrenceRef = {
  kind: 'session',
  sessionRef: { sourceKind: 'inspection-occurrence', sourceRef: 'occ-1' },
  taskRef: childId,
  scope: childScope,
}
const memoryRef = {
  kind: 'session',
  sessionRef: { sourceKind: 'memory-agent', sourceRef: 'memory-1' },
  taskRef: childId,
  scope: childScope,
}
const evidence = {
  evidenceId: { scope: 'evidence', value: 'ev-1' },
  kind: 'execution',
  source: 'journal',
  locator: 'journal:1',
  scope: { organId: { scope: 'organ', value: 'organ-1' }, taskId: childId },
}

function relation(source, target, kind = 'child-execution') {
  return { source, target, kind, sourceOwner: 'test-owner', evidenceRefs: [evidence] }
}

test('relation groups keep hierarchy, inspection, related and memory apart', () => {
  assert.equal(relationGroup(relation(parentRef, childRef, 'child-execution')), 'hierarchy')
  assert.equal(relationGroup(relation(childRef, occurrenceRef, 'occurrence')), 'inspection')
  assert.equal(relationGroup(relation(childRef, memoryRef, 'unknown')), 'memory')
  assert.equal(relationGroup(relation(parentRef, childRef, 'requirement')), 'related')
})

test('focus direction reverses upstream and downstream from the exact focus ref', () => {
  const edge = relation(parentRef, childRef)
  assert.equal(relationDirection(edge, parentRef), 'downstream')
  assert.equal(relationDirection(edge, childRef), 'upstream')
  assert.equal(relationDirection(edge, occurrenceRef), undefined)
  assert.deepEqual(focusFromRelation(edge, parentRef, 'downstream'), childRef)
  assert.equal(focusFromRelation(edge, parentRef, 'upstream'), undefined)
  assert.deepEqual(focusFromRelation(edge, childRef, 'upstream'), parentRef)
  assert.equal(focusFromRelation(edge, childRef, 'downstream'), undefined)
})

test('repeated lineage yields one node per exact ref and keeps the focus first', () => {
  const chain = [
    relation(parentRef, childRef),
    relation(parentRef, childRef),
    relation(childRef, occurrenceRef, 'occurrence'),
  ]
  const unique = productRelationNodes(chain, childRef)
  assert.equal(unique.length, 3)
  assert.deepEqual(unique[0], childRef)
  const keys = unique.map((ref) => JSON.stringify(ref))
  assert.equal(new Set(keys).size, 3)
})

test('focused rendering shows upstream above and downstream below without duplicating the focus node', () => {
  const host = createElement('div')
  const selections = []
  renderProductRelationChain(host, [
    relation(parentRef, childRef),
    relation(childRef, occurrenceRef, 'occurrence'),
  ], {
    focus: childRef,
    element: createElement,
    labelForRef: (ref) => (ref === parentRef ? '父任务' : ref === childRef ? '当前任务' : '巡检记录'),
    onSelect: (ref, direction) => selections.push({ ref, direction }),
  })

  const upstream = sections(host, 'upstream')
  const downstream = sections(host, 'downstream')
  const current = sections(host, 'current')
  assert.equal(upstream.length, 1)
  assert.equal(downstream.length, 1)
  assert.equal(current.length, 1)
  assert.match(text(upstream[0]), /父任务/)
  assert.match(text(downstream[0]), /巡检记录/)
  assert.match(text(current[0]), /当前任务/)

  const currentNodes = nodes(host, (node) => node.getAttribute('data-product-relation-current') === 'true')
  assert.equal(currentNodes.length, 1, 'the focus node must appear once, not once per edge')

  const parentButton = targeted(upstream[0])[0]
  parentButton.click()
  assert.deepEqual(selections, [{ ref: parentRef, direction: 'upstream' }])
})

test('unfocused rendering groups every relation and an empty read stays explicit', () => {
  const host = createElement('div')
  renderProductRelationChain(host, [
    relation(parentRef, childRef),
    relation(childRef, occurrenceRef, 'occurrence'),
    relation(childRef, memoryRef, 'unknown'),
  ], { element: createElement })
  assert.equal(groups(host, 'hierarchy').length, 1)
  assert.equal(groups(host, 'inspection').length, 1)
  assert.equal(groups(host, 'memory').length, 1)
  assert.equal(targeted(host).length, 6)

  const emptyHost = createElement('div')
  renderProductRelationChain(emptyHost, [], { element: createElement })
  assert.equal(targeted(emptyHost).length, 0)
  assert.match(text(emptyHost), /没有有依据的关联/)
})
