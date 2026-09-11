const rows = [...document.querySelectorAll('[data-task-row]')]
const groups = [...document.querySelectorAll('[data-group]')]
const scopeButtons = [...document.querySelectorAll('[data-scope-filter]')]
const searchInput = document.querySelector('[data-task-search]')
const statusFilter = document.querySelector('[data-status-filter]')
const clearButton = document.querySelector('[data-clear-filters]')
const filterFeedback = document.querySelector('[data-filter-feedback]')
const noResults = document.querySelector('[data-no-results]')

const initialScope = new URLSearchParams(window.location.search).get('scope')
let selectedScope = ['current', 'decision', 'history'].includes(initialScope) ? initialScope : 'all'

function matches(row) {
  const search = searchInput.value.trim().toLocaleLowerCase()
  const scopeMatches = selectedScope === 'all' || row.dataset.scope === selectedScope
  const statusMatches = statusFilter.value === 'all' || row.dataset.status === statusFilter.value
  const textMatches = !search || row.dataset.search.toLocaleLowerCase().includes(search)
  return scopeMatches && statusMatches && textMatches
}

function update() {
  let visibleRows = 0
  const counts = { current: 0, decision: 0, history: 0 }

  for (const row of rows) {
    const visible = matches(row)
    row.hidden = !visible
    if (visible) {
      visibleRows += 1
      counts[row.dataset.scope] += 1
    }
  }

  for (const group of groups) {
    const scope = group.dataset.group
    const visible = counts[scope] > 0
    group.hidden = selectedScope !== 'all' && selectedScope !== scope
    group.querySelector('[data-group-count]').textContent = `${counts[scope]} 项`
    group.querySelector(`[data-group-empty="${scope}"]`).hidden = visible || group.hidden
  }

  noResults.hidden = visibleRows > 0
  const scopeLabel = selectedScope === 'all' ? '全部任务' : document.querySelector(`[data-scope-filter="${selectedScope}"]`).textContent
  const filterActive = selectedScope !== 'all' || statusFilter.value !== 'all' || searchInput.value.trim()
  filterFeedback.textContent = filterActive ? `当前显示 ${visibleRows} 项 · ${scopeLabel}` : '显示全部任务'
  clearButton.hidden = !filterActive
}

for (const button of scopeButtons) {
  button.addEventListener('click', () => {
    selectedScope = button.dataset.scopeFilter
    for (const candidate of scopeButtons) {
      const active = candidate === button
      candidate.classList.toggle('is-active', active)
      candidate.setAttribute('aria-pressed', String(active))
    }
    update()
  })
}

searchInput.addEventListener('input', update)
statusFilter.addEventListener('change', update)
clearButton.addEventListener('click', () => {
  selectedScope = 'all'
  searchInput.value = ''
  statusFilter.value = 'all'
  scopeButtons[0].click()
  searchInput.focus()
})

for (const button of scopeButtons) {
  const active = button.dataset.scopeFilter === selectedScope
  button.classList.toggle('is-active', active)
  button.setAttribute('aria-pressed', String(active))
}

update()
