// Semantic tool cards for the local UI prototype. A result belongs to its call ID.
window.ToolPresentation = (() => {
  function element(tag, className, text) {
    const node = document.createElement(tag)
    node.className = className
    node.textContent = text ?? ''
    return node
  }
  function parse(call, result) {
    const args = call.args
    const read = call.name === 'read'
    const search = call.name === 'search'
    const state = !result ? '进行中' : result.error ? '失败' : '完成'
    const title = read ? '读取文件' : search ? '搜索文件' : call.name
    const target = read ? args.file_path : search ? args.query : JSON.stringify(args)
    let output = ''
    if (result) {
      if (result.error) output = result.error
      else if (read && Array.isArray(result.lines)) output = result.lines.map(line => '第 ' + line.number + ' 行　' + line.text).join('\n')
      else if (search && Array.isArray(result.paths)) output = result.paths.length ? result.paths.join('\n') : '没有匹配文件'
      else output = typeof result.text === 'string' ? result.text : JSON.stringify(result)
    }
    return {title, target, state, output, icon: search ? '⌕' : '▤'}
  }
  function render(call, results) {
    const model = parse(call, results.get(call.id))
    const card = element('div','tool-unit')
    const head = element('div','tool-head')
    head.append(element('span','tool-icon',model.icon),element('strong','',model.title),element('span','tool-target',model.target),element('small','tool-label',model.state))
    card.append(head)
    if (model.output) card.append(element('div','tool-output',model.output))
    return card
  }
  return {render}
})()
