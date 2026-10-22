/**
 * Read-only renderer for the five product boards.
 *
 * The board is a presentation classification. It is never an identity or a
 * permission source. Every item keeps its exact `ProductTargetRef` in a data
 * attribute so a page controller can open the matching focus without
 * reconstructing the target from a title or a board name.
 *
 * Inputs are the C contract shapes:
 *   ProductBoardSection { board, live, history, unknown, failures? }
 *   ProductBoardIndex   { scope, observedAt, boards }
 *
 * `unknown` items are rendered only in the unknown lane. They never move into
 * Live. A board that the read did not provide is shown as explicitly missing,
 * not as a successful empty board.
 */

import { element as defaultElement } from './runtime-api.js'

export const PRODUCT_BOARD_ORDER = Object.freeze([
  'interaction',
  'orchestration',
  'inspection',
  'execution',
  'memory',
])

export const PRODUCT_BOARD_LABELS = Object.freeze({
  interaction: '交互 agent',
  orchestration: '编排 agent',
  inspection: '巡检 agent',
  execution: '执行 agent',
  memory: '记忆 agent',
})

export const PRODUCT_LANE_ORDER = Object.freeze(['live', 'history', 'unknown'])

export const PRODUCT_LANE_LABELS = Object.freeze({
  live: '实时',
  history: '历史',
  unknown: '未知',
})

function makeFactory(options) {
  return typeof options?.element === 'function' ? options.element : defaultElement
}

function setAttribute(node, name, value) {
  node.setAttribute(name, String(value))
}

function itemNode(item, lane, make, options) {
  const selectable = typeof options?.onSelect === 'function'
  const node = make(selectable ? 'button' : 'article', undefined, 'product-board-item')
  if (selectable) {
    node.type = 'button'
    node.addEventListener('click', () => options.onSelect(item.ref, item))
  }
  setAttribute(node, 'data-product-target-kind', item.ref.kind)
  setAttribute(node, 'data-product-target', JSON.stringify(item.ref))
  setAttribute(node, 'data-product-lane', lane)
  node.append(
    make('span', item.title, 'product-board-item-title'),
    make('span', item.displayState, 'product-board-item-state'),
  )
  if (item.liveness !== undefined) {
    node.append(make('span', `${item.liveness.state} · ${item.liveness.reason}`, 'product-board-item-liveness'))
  }
  if (lane === 'unknown') {
    node.append(make('span', item.unknownReason, 'product-board-item-unknown-reason'))
  }
  return node
}

function laneNode(lane, items, make, options) {
  const laneRoot = make('section', undefined, 'product-board-lane')
  setAttribute(laneRoot, 'data-product-lane', lane)
  laneRoot.append(make('h3', `${PRODUCT_LANE_LABELS[lane]} ${items.length}`, 'product-board-lane-heading'))

  if (items.length === 0) {
    laneRoot.append(make('p', '没有条目', 'muted'))
    return laneRoot
  }

  const list = make('ul', undefined, 'product-board-lane-list')
  for (const item of items) {
    const row = make('li')
    row.append(itemNode(item, lane, make, options))
    list.append(row)
  }
  laneRoot.append(list)
  return laneRoot
}

function failureNode(failure, make) {
  const node = make('div', undefined, 'product-board-failure')
  node.setAttribute('role', 'alert')
  node.append(
    make('p', `${failure.code} · ${failure.ownerId}`, 'product-board-failure-code'),
    make('p', failure.message, 'product-board-failure-message'),
    make('p', failure.nextAction, 'product-board-failure-next'),
  )
  return node
}

/**
 * Render one board section into `host` (or return the detached root when host is
 * omitted). The root keeps the exact board key for the page controller.
 */
export function renderProductBoardSection(host, section, options = {}) {
  const make = makeFactory(options)
  const root = make('section', undefined, 'product-board-section')
  setAttribute(root, 'data-product-board', section.board)
  root.append(make('h2', PRODUCT_BOARD_LABELS[section.board] ?? String(section.board), 'product-board-heading'))

  for (const lane of PRODUCT_LANE_ORDER) {
    root.append(laneNode(lane, section[lane], make, options))
  }

  if (Array.isArray(section.failures) && section.failures.length > 0) {
    const failures = make('section', undefined, 'product-board-failures')
    failures.append(make('h3', '读取失败', 'product-board-failures-heading'))
    for (const failure of section.failures) failures.append(failureNode(failure, make))
    root.append(failures)
  }

  if (host !== undefined && host !== null) host.replaceChildren(root)
  return root
}

function missingBoardNode(board, make, options) {
  const root = make('section', undefined, 'product-board-section')
  setAttribute(root, 'data-product-board', board)
  setAttribute(root, 'data-product-board-missing', 'true')
  root.append(
    make('h2', PRODUCT_BOARD_LABELS[board], 'product-board-heading'),
    make(
      'p',
      options?.missingMessage ?? '当前读取没有提供这个板块。',
      'product-board-missing',
    ),
  )
  return root
}

/**
 * Render the index in the product's fixed board order. A missing section is
 * explicit; it is not treated as a confirmed empty collection.
 */
export function renderProductBoardIndex(host, index, options = {}) {
  const make = makeFactory(options)
  const root = make('section', undefined, 'product-board-index')
  root.setAttribute('aria-label', '五个 agent 板块')
  const provided = new Map((index?.boards ?? []).map((section) => [section.board, section]))

  for (const board of PRODUCT_BOARD_ORDER) {
    const section = provided.get(board)
    root.append(
      section === undefined
        ? missingBoardNode(board, make, options)
        : renderProductBoardSection(null, section, options),
    )
  }

  if (host !== undefined && host !== null) host.replaceChildren(root)
  return root
}
