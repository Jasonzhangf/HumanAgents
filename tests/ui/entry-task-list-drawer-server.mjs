import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
])

function mimeType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'application/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}

function sendJson(response, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
  })
  response.end(payload)
}

async function proxyApi(request, response, runtimeBase) {
  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value
  }
  headers['x-forwarded-host'] = request.headers.host ?? '127.0.0.1'
  headers['x-forwarded-proto'] = 'http'

  const hasBody = !['GET', 'HEAD'].includes(request.method ?? 'GET')
  let body
  if (hasBody) {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    body = Buffer.concat(chunks)
  }

  let upstream
  try {
    upstream = await fetch(new URL(request.url, runtimeBase), {
      method: request.method,
      headers,
      body,
    })
  } catch (error) {
    sendJson(response, 502, {
      code: 'entry-drawer-proof.proxy-failed',
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }

  const responseHeaders = {}
  for (const [name, value] of upstream.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value
  }
  const setCookie = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : []
  if (setCookie.length > 0) responseHeaders['set-cookie'] = setCookie
  const payload = Buffer.from(await upstream.arrayBuffer())
  responseHeaders['content-length'] = payload.length
  response.writeHead(upstream.status, responseHeaders)
  response.end(payload)
}

export async function startEntryDrawerServer({ uiRoot, runtimeBase }) {
  const root = resolve(uiRoot)
  const upstreamBase = new URL(runtimeBase)
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await proxyApi(request, response, upstreamBase)
      return
    }

    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      response.writeHead(400)
      response.end('bad path')
      return
    }
    const relative = (pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '')
    const filePath = resolve(root, relative)
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403)
      response.end('forbidden')
      return
    }
    try {
      const file = await readFile(filePath)
      response.writeHead(200, {
        'content-type': mimeType(filePath),
        'content-length': file.length,
      })
      response.end(file)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  if (!port) {
    server.close()
    throw new Error('entry drawer proof server did not receive a TCP port')
  }
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    baseUrl,
    runtimeBase: upstreamBase.toString().replace(/\/$/, ''),
    uiRoot: root,
    async observeTasks() {
      const response = await fetch(new URL('/api/tasks', upstreamBase))
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        text,
        body,
      }
    },
    close() {
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error)
          else resolveClose()
        })
      })
    },
  }
}
