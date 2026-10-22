/**
 * Read-only renderer for the product relation chain.
 *
 * It consumes C's `ProductRelation` shape and the exact `ProductTargetRef`
 * value on each endpoint. It fetches nothing, writes nothing, and never makes
 * an edge from a title, timestamp, role or board name. The four display groups
 * are presentation only:
 *
 *   hierarchy  child execution
 *   related    requirement, subscription, checkpoint, review, planner, tool-pair
 *   inspection recorded occurrence
 *   memory     a session ref whose owner vocabulary says it is a memory session
 *
 * Direction is resolved against the exact focus ref. When the focus is the
 * relation target, the source is upstream; when the focus is the relation
 * source, the target is downstream.
 */

import { element as defaultElement } from './runtime-api.js'

export const PRODUCT_RELATION_GROUPS = Object.freeze([
  'hierarchy',
  'related',
  'inspection',
  'memory',
])

export const PRODUCT_RELATION_GROUP_LABELS = Object.freeze({
  hierarchy: '层级',
  related: '关联',
  inspection: '巡检',
  memory: '记忆',
})

export const PRODUCT_RELATION_KIND_LABELS = Object.freeze({
  requirement: '需求来源',
  subscription: '订阅',
  occurrence: '巡检记录',
  'child-execution': '子执行',
  checkpoint: '检查点',
  review: '复核',
  planner: '计划',
  'tool-pair': '工具配对',
  unknown: '未知关系',
})

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireHost(host) {
  if (!host || typeof host.replaceChildren !== 'function' || typeof host.append !== 'function') {
    throw new TypeError('product relation view host must be a DOM element')
  }
}

function requireRelations(relations) {
  if (!Array.isArray(relations)) {
    throw new TypeError('product relations must be an array')
  }
  return relations
}

function resolveElementFactory(host, options) {
  if (typeof options?.element === 'function') return options.element
  const documentRef = host.ownerDocument
    ?? (typeof document === 'undefined' ? undefined : document)
  if (typeof documentRef?.createElement !== 'function') {
    throw new TypeError('product relation view requires an element factory or a DOM host')
  }
  return (tag, text, className) => {
    const node = documentRef.createElement(tag)
    if (text !== undefined) node.textContent = String(text)
    if (className) node.className = className
    return node
  }
}

function scopeKey(scope) {
  if (!isRecord(scope)) return 'invalid-scope'
  if (scope.kind === 'system') return 'system'
  if (scope.kind === 'project') return `project:${scope.projectKey}`
  if (scope.kind === 'task') {
    return `task:${scope.projectKey}:${scope.mode}:${scope.taskId?.value}`
  }
  return 'invalid-scope'
}

function instanceKey(instance) {
  if (!isRecord(instance)) return 'invalid-instance'
  if (instance.kind === 'native-execution') {
    return `native:${instance.execution?.runtimeId}:${instance.execution?.executionEpoch}`
  }
  const incarnation = isRecord(instance.incarnation) ? instance.incarnation : {}
  return [
    'incarnation',
    incarnation.runtimeId,
    incarnation.generation,
    incarnation.agentInstanceId,
    incarnation.roleId,
    incarnation.taskId?.value,
    incarnation.assignmentId,
    incarnation.executionEpoch,
  ].join(':')
}

/** Stable exact-ref key. Display labels never participate in this identity. */
export function productRelationRefKey(ref) {
  if (!isRecord(ref)) return 'invalid-ref'
  if (ref.kind === 'interaction') {
    return `interaction:${ref.taskRef?.value}:${scopeKey(ref.scope)}`
  }
  if (ref.kind === 'session') {
    return [
      'session',
      ref.sessionRef?.sourceKind,
      ref.sessionRef?.sourceRef,
      ref.taskRef?.value ?? '',
      scopeKey(ref.scope),
    ].join(':')
  }
  if (ref.kind === 'execution-instance') {
    return `execution-instance:${ref.taskRef?.value}:${instanceKey(ref.instance)}:${scopeKey(ref.scope)}`
  }
  return `unknown:${JSON.stringify(ref)}`
}

function sameRef(left, right) {
  return productRelationRefKey(left) === productRelationRefKey(right)
}

function isMemoryRef(ref) {
  return isRecord(ref)
    && ref.kind === 'session'
    && typeof ref.sessionRef?.sourceKind === 'string'
    && ref.sessionRef.sourceKind.toLowerCase().includes('memory')
}

/**
 * Presentation group only. It never changes the edge kind or its identity.
 */
export function relationGroup(relation) {
  if (!isRecord(relation)) return 'related'
  if (relation.kind === 'child-execution') return 'hierarchy'
  if (relation.kind === 'occurrence') return 'inspection'
  if (isMemoryRef(relation.source) || isMemoryRef(relation.target)) return 'memory'
  return 'related'
}

/**
 * `upstream` means the relation points into the focus target.
 * `downstream` means the relation points out of the focus source.
 */
export function relationDirection(relation, focus) {
  if (!isRecord(relation) || !isRecord(focus)) return undefined
  if (sameRef(relation.target, focus)) return 'upstream'
  if (sameRef(relation.source, focus)) return 'downstream'
  return undefined
}

/**
 * Return the exact endpoint reached by moving one direction from the focus.
 * A direction that does not match the focus endpoint returns undefined; it
 * never guesses the other end.
 */
export function focusFromRelation(relation, focus, direction) {
  const actual = relationDirection(relation, focus)
  if (actual === undefined || actual !== direction) return undefined
  return direction === 'upstream' ? relation.source : relation.target
}

/** Unique exact refs connected to the focus. The focus is first when given. */
export function productRelationNodes(relations, focus) {
  requireRelations(relations)
  const nodes = []
  const seen = new Set()
  const push = (ref) => {
    if (!isRecord(ref)) return
    const key = productRelationRefKey(ref)
    if (seen.has(key)) return
    seen.add(key)
    nodes.push(ref)
  }
  if (isRecord(focus)) push(focus)
  for (const relation of relations) {
    if (isRecord(focus) && relationDirection(relation, focus) === undefined) continue
    push(relation.source)
    push(relation.target)
  }
  return nodes
}

function defaultRefLabel(ref) {
  if (ref?.kind === 'interaction') return `任务 ${ref.taskRef?.value ?? '未记录'}`
  if (ref?.kind === 'session') {
    return `${ref.sessionRef?.sourceKind ?? '来源'} ${ref.sessionRef?.sourceRef ?? '未记录'}`
  }
  if (ref?.kind === 'execution-instance') return `执行实例 ${ref.taskRef?.value ?? '未记录'}`
  return '未记录目标'
}

function refLabel(ref, options) {
  if (typeof options?.labelForRef === 'function') {
    const label = options.labelForRef(ref)
    if (typeof label === 'string' && label.trim().length > 0) return label
  }
  return defaultRefLabel(ref)
}

function nodeNode(ref, make, options, current) {
  const node = make('button', undefined, current
    ? 'product-relation-node current'
    : 'product-relation-node')
  node.type = 'button'
  node.setAttribute('data-product-target-kind', ref?.kind ?? 'unknown')
  node.setAttribute('data-product-target', JSON.stringify(ref))
  if (current) {
    node.setAttribute('data-product-relation-current', 'true')
    node.setAttribute('aria-current', 'true')
  }
  node.append(
    make('span', refLabel(ref, options), 'product-relation-node-name'),
    make('span', ref?.kind ?? 'unknown', 'product-relation-node-kind'),
  )
  if (!current && typeof options?.onSelect === 'function') {
    node.addEventListener('click', () => options.onSelect(ref, options.direction))
  }
  return node
}

function nodeMeta(options, direction) {
  return { ...options, direction }
}

function edgeNode(relation, make, options, direction) {
  const row = make('div', undefined, 'product-relation-edge')
  row.setAttribute('data-product-relation-kind', relation.kind)
  row.setAttribute('data-product-relation-direction', direction)

  const label = PRODUCT_RELATION_KIND_LABELS[relation.kind] ?? String(relation.kind)
  if (direction === 'upstream') {
    row.append(
      nodeNode(relation.source, make, nodeMeta(options, 'upstream'), false),
      make('span', '↓', 'product-relation-arrow'),
      make('span', label, 'product-relation-edge-label'),
    )
  } else if (direction === 'downstream') {
    row.append(
      make('span', '↓', 'product-relation-arrow'),
      make('span', label, 'product-relation-edge-label'),
      nodeNode(relation.target, make, nodeMeta(options, 'downstream'), false),
    )
  } else {
    row.append(
      nodeNode(relation.source, make, nodeMeta(options, 'focus'), false),
      make('span', '→', 'product-relation-arrow'),
      make('span', label, 'product-relation-edge-label'),
      nodeNode(relation.target, make, nodeMeta(options, 'focus'), false),
    )
  }
  return row
}

function sectionNode(name, title, make) {
  const section = make('section', undefined, 'product-relation-section')
  section.setAttribute('data-product-relation-section', name)
  section.append(make('h3', title, 'product-relation-section-heading'))
  return section
}

function renderFocused(root, relations, make, options) {
  const focus = options.focus
  const connected = relations.filter((relation) => relationDirection(relation, focus) !== undefined)
  if (connected.length === 0) {
    root.append(make('p', '没有有依据的关联。', 'product-relation-empty'))
  }

  const upstream = connected.filter((relation) => relationDirection(relation, focus) === 'upstream')
  if (upstream.length > 0) {
    const section = sectionNode('upstream', '上游', make)
    for (const relation of upstream) section.append(edgeNode(relation, make, options, 'upstream'))
    root.append(section)
  }

  const current = sectionNode('current', '当前焦点', make)
  current.append(nodeNode(focus, make, options, true))
  root.append(current)

  const downstream = connected.filter((relation) => relationDirection(relation, focus) === 'downstream')
  if (downstream.length > 0) {
    const section = sectionNode('downstream', '下游', make)
    for (const relation of downstream) section.append(edgeNode(relation, make, options, 'downstream'))
    root.append(section)
  }
}

function renderGroups(root, relations, make, options) {
  const grouped = new Map()
  for (const relation of relations) {
    const group = relationGroup(relation)
    const bucket = grouped.get(group) ?? []
    bucket.push(relation)
    grouped.set(group, bucket)
  }
  for (const group of PRODUCT_RELATION_GROUPS) {
    const bucket = grouped.get(group)
    if (bucket === undefined || bucket.length === 0) continue
    const section = make('section', undefined, 'product-relation-group')
    section.setAttribute('data-product-relation-group', group)
    section.append(make('h3', PRODUCT_RELATION_GROUP_LABELS[group], 'product-relation-group-heading'))
    for (const relation of bucket) section.append(edgeNode(relation, make, options, 'forward'))
    root.append(section)
  }
}

/**
 * Render one relation chain into `host` and return the root. A focus opts into
 * the upstream/current/downstream layout; without it, every edge is grouped by
 * its presentation group.
 */
export function renderProductRelationChain(host, relations, options = {}) {
  requireHost(host)
  const input = requireRelations(relations)
  const make = typeof options.element === 'function' ? options.element : defaultElement
  const root = make('section', undefined, 'product-relation-chain')
  root.setAttribute('data-product-relation-count', String(input.length))
  root.append(make('h2', '关联链', 'product-relation-heading'))

  if (input.length === 0) {
    root.append(make('p', '没有有依据的关联。', 'product-relation-empty'))
  } else if (isRecord(options.focus)) {
    renderFocused(root, input, make, options)
  } else {
    renderGroups(root, input, make, options)
  }

  host.replaceChildren(root)
  return root
}
