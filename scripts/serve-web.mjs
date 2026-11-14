// Serves the repository root so web/market.html can import backend/near/market.mjs
// and read deployment.json.
//
// The page deliberately imports the backend's market reader instead of carrying
// its own copy of the read logic, and a browser will not resolve a module import
// over file://. Rather than tell a judge to install a static server, ship one:
// node's built-in http is enough and adds no dependency.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname
const PORT = Number(process.env.PORT ?? 8080)
/// Loopback by default, for the reason spelled out in scripts/serve-play.mjs: a
/// wildcard bind succeeds even when something else already holds IPv4 on this
/// port, and then nothing can reach it at 127.0.0.1 while it reports itself up.
const HOST = process.env.NEARCRAFT_BIND || '127.0.0.1'

/// Exported so scripts/serve-play.mjs serves the same files the same way
/// rather than keeping a second table that can drift.
export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/// Exactly what the page needs, and nothing else.
///
/// An allowlist rather than "anything under the repository root", because the
/// root also contains `.local/` — which holds the deploying account's private
/// key. Confining the server to the root is not enough: `.local/` is *inside*
/// the root, so a prefix check would happily serve a judge's signing key to
/// anything that can reach this port. A test asserts that it does not.
/// Exported so scripts/build-vercel.mjs stages exactly this tree for a static
/// host rather than keeping a second allowlist that can drift — the same reason
/// TYPES above is exported. A deny list would be correct only until someone adds
/// a path it does not mention; this one is the whole published surface.
export const SERVABLE = ['web/', 'backend/', 'deployment.json']

/// Map a request URL to a servable file, or null if it is not one.
///
/// Exported so the guard is testable without binding a port.
export function resolveFile(root, url) {
  const requested = decodeURIComponent((url ?? '/').split('?')[0])
  // normalize() resolves ".." before join, so a traversal collapses to an
  // absolute path that then has to survive the allowlist below.
  const path = normalize(requested === '/' ? '/web/market.html' : requested).replace(/^\/+/, '')

  if (!SERVABLE.some((ok) => (ok.endsWith('/') ? path.startsWith(ok) : path === ok))) return null

  const file = join(root, path)
  return file.startsWith(root) ? file : null
}

const server = createServer(async (req, res) => {
  const file = resolveFile(ROOT, req.url)

  if (file === null) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden')
    return
  }

  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: ${req.url}`)
  }
})

const isEntryPoint = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isEntryPoint) {
  server.on('error', (e) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(`\n  ${HOST}:${PORT} is already taken. Try:  PORT=8099 npm run web\n`)
      process.exit(1)
    }
    throw e
  })
}

if (isEntryPoint) server.listen(PORT, HOST, () => {
  console.log(`\n  NearCraft market page: http://${HOST}:${PORT}/\n`)
  console.log('  It reads the deployed contracts in deployment.json over public RPC.')
  console.log('  Offline, it falls back to web/market-snapshot.json and says so.\n')
})
