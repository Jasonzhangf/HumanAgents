// Each owner keeps its own dialog. Native modal stacking isolates nested
// history/tool/usage readers without a shared current-content singleton.
export function createDetailDisclosure(make, title, className = '') {
  const root = make('div', undefined, className)
  const button = make('button', title, 'detail-disclosure-trigger')
  button.type = 'button'
  button.setAttribute('aria-haspopup', 'dialog')
  const dialog = make('dialog', undefined, 'detail-disclosure-dialog')
  dialog.setAttribute('aria-label', title)
  const header = make('header', undefined, 'detail-disclosure-head')
  const close = make('button', '关闭', 'detail-disclosure-close')
  close.type = 'button'
  const content = make('div', undefined, 'detail-disclosure-content')
  header.append(make('h2', title), close)
  dialog.append(header, content)
  // Inline critical layout also works in hosts that do not load runtime.css.
  dialog.style && Object.assign(dialog.style, {
    position: 'fixed', inset: '0 0 0 auto', margin: '0',
    width: 'min(46rem, 94vw)', maxWidth: '94vw', height: '100dvh',
    maxHeight: '100dvh', boxSizing: 'border-box', overflow: 'auto',
    padding: '1.25rem', border: '1px solid var(--line, #ccc)',
    background: 'var(--surface, #fff)', color: 'var(--ink, #18202b)',
  })
  header.style && Object.assign(header.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' })
  content.style && Object.assign(content.style, { overflowWrap: 'anywhere' })
  let populate
  let populated = false
  function open() {
    if (!populated) { populate?.(); populated = true }
    if (!dialog.open) dialog.showModal()
  }
  function restoreFocus() {
    if (button.isConnected) button.focus({ preventScroll: true })
  }
  button.addEventListener?.('click', open)
  close.addEventListener?.('click', () => dialog.close())
  dialog.addEventListener?.('close', restoreFocus)
  root.append(button, dialog)
  return { root, button, content, dialog, open,
    onFirstOpen(fn) { populate = fn },
    dispose() { if (dialog.open) dialog.close(); dialog.remove() },
  }
}
