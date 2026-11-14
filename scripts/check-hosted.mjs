// Check the two hosted deployments, because nothing else in this repository can.
//
// check-docs.mjs:86 skips `https?:` links deliberately — a documented URL is the
// one claim here that no test can reach. BASELINE.md:120 is blunt about why that
// matters: "a provenance link a judge cannot open is worse than no link." So
// this exists, and the README's two URLs are read FROM it rather than written
// twice.
//
// NOT part of `npm test`. The suite has to pass offline from a clean clone, which
// is the same reason verify:deployed is its own command. Run it deliberately:
//
//   npm run check:hosted
//
// The play service is on Render's free tier, which spins down after 15 idle
// minutes and takes about a minute to wake. A slow first request is expected
// rather than a failure, so the timeouts here are generous and the wake is
// reported.
import { readFile } from 'node:fs/promises'

const ROOT = new URL('..', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('deployment.json', ROOT), 'utf8'))

/// config/hosting.json is the single source of truth for both addresses.
/// check-docs.mjs reads the same file, so the README cannot claim an address
/// this script does not test — and the overrides exist so a fork can point this
/// at its own deployment without editing anything.
const hosting = JSON.parse(await readFile(new URL('config/hosting.json', ROOT), 'utf8'))
const WEB_URL = process.env.NEARCRAFT_WEB_URL ?? hosting.web.url
const PLAY_URL = process.env.NEARCRAFT_PLAY_URL ?? hosting.play.url

const results = []
const ok = (what, detail = '') => results.push(['pass', what, detail])
const bad = (what, detail = '') => results.push(['FAIL', what, detail])

async function hit(url, { method = 'GET', headers = {}, body, redirect = 'manual' } = {}) {
  const started = Date.now()
  const res = await fetch(url, {
    method, headers, redirect,
    body, signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, ms: Date.now() - started,
    json: () => { try { return JSON.parse(text) } catch { return null } } }
}

// ------------------------------------------------------------- the web page

const root = await hit(`${WEB_URL}/`)
if (root.status === 307 || root.status === 308 || root.status === 302) {
  const to = root.headers.get('location') ?? ''
  if (to.endsWith('/web/market.html')) ok('/ redirects to the page', `${root.status} -> ${to}`)
  else bad('/ redirects somewhere else', to)
} else {
  // Not cosmetic. Served AT `/`, the page's own sibling fetch for
  // market-snapshot.json resolves to /market-snapshot.json and 404s, so the
  // offline fallback silently stops working. The redirect is what keeps every
  // relative path resolving the way it does under `npm run web`.
  bad('/ does not redirect to /web/market.html', `HTTP ${root.status}`)
}

const page = await hit(`${WEB_URL}/web/market.html`, { redirect: 'follow' })
if (page.status === 200 && page.text.includes('NearCraft Market')) ok('the market page is served', `${page.text.length} bytes`)
else bad('the market page is not served', `HTTP ${page.status}`)

/// The page imports this with import(), which a browser refuses unless the
/// content type is JavaScript. A host serving it as text/plain breaks the live
/// view and leaves only the snapshot, with no error a reader would notice.
const mod = await hit(`${WEB_URL}/backend/near/market.mjs`, { redirect: 'follow' })
const ctype = mod.headers.get('content-type') ?? ''
if (mod.status === 200 && /javascript/.test(ctype)) ok('the market reader is served as JavaScript', ctype)
else bad('the market reader would not import in a browser', `HTTP ${mod.status}, ${ctype}`)

/// A stale manifest on the host would point the page at contracts that are not
/// the ones this repository builds, and the page would look fine while being
/// wrong.
const hosted = await hit(`${WEB_URL}/deployment.json`, { redirect: 'follow' })
const hostedManifest = hosted.json()
if (JSON.stringify(hostedManifest?.contracts) === JSON.stringify(manifest.contracts)) {
  ok('the hosted manifest names the same contracts as the repository', Object.values(manifest.contracts).join(', '))
} else {
  bad('the hosted manifest is stale', JSON.stringify(hostedManifest?.contracts))
}

// -------------------------------------------------- nothing else is published
//
// .local/ holds the deploying account's key AND the three contract accounts'
// keys. scripts/build-vercel.mjs stages an allowlist so none of it is on disk at
// upload time; this is the independent reading of the result, from outside.
const MUST_404 = ['/.local/nearcraft-keys.json', '/.local/nearcraftmc-root.json', '/.env',
  '/package.json', '/.git/config', '/scripts/serve-play.mjs', '/AGENTS.md', '/contracts/items/src/lib.rs']
const reachable = []
for (const path of MUST_404) {
  const res = await hit(`${WEB_URL}${path}`, { redirect: 'follow' })
  if (res.status === 200) reachable.push(`${path} (HTTP 200)`)
}
if (reachable.length === 0) ok(`none of ${MUST_404.length} unpublishable paths is reachable`)
else bad('PUBLISHED SOMETHING IT MUST NOT', reachable.join(', '))

// ---------------------------------------------------------- the play service

const health = await hit(`${PLAY_URL}/api/health`, { redirect: 'follow' })
const h = health.json()
if (health.status !== 200 || h === null) {
  bad('the play service did not answer /api/health', `HTTP ${health.status} after ${health.ms}ms`)
} else {
  ok('the play service is live', `${health.ms}ms${health.ms > 20_000 ? ' (cold start)' : ''}`)

  // The whole security posture of the hosted instance in one field. Seeded login
  // accepts any string and funds a new account from root, so an instance that
  // COULD onboard would be a faucet anyone could drain. canOnboard:false is the
  // proof that the root key is not there.
  if (h.canOnboard === false) ok('the hosted instance cannot create accounts', 'canOnboard: false')
  else bad('THE HOSTED INSTANCE CAN CREATE ACCOUNTS', `canOnboard: ${h.canOnboard} — it is a faucet`)

  if (h.custodial === true) ok('it says plainly that it is custodial', 'custodial: true')
  else bad('a custodial service is not saying so', `custodial: ${h.custodial}`)

  if (JSON.stringify(h.contracts) === JSON.stringify(manifest.contracts)) {
    ok('it is wired to the contracts this repository builds')
  } else {
    bad('it is wired to different contracts', JSON.stringify(h.contracts))
  }
}

/// Prove the faucet is shut by trying to use it, not by reading a flag. A random
/// subject has certainly never been onboarded, so this is the exact request an
/// abuser would send.
const subject = `check-hosted-${Math.random().toString(36).slice(2)}`
const session = await hit(`${PLAY_URL}/api/session`, {
  method: 'POST', redirect: 'follow',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: subject }),
})
const refusal = session.json()
if (session.status === 200) {
  bad('A STRANGER WAS ONBOARDED', `it created ${refusal?.accountId} and funded it from root`)
} else if (refusal?.error === 'ONBOARDING_MISCONFIGURED') {
  ok('an unknown identity is refused, not funded', `HTTP ${session.status} ${refusal.error}`)
} else {
  bad('refused for an unexpected reason', `HTTP ${session.status} ${refusal?.error ?? session.text.slice(0, 80)}`)
}

// ------------------------------------------------------------- and the proxy
//
// The page calls /api/* relative, so it must reach the play service through the
// web origin. Same-origin by design: the session id is bearer authority over a
// player's account and this keeps it from crossing origins at all.
const proxied = await hit(`${WEB_URL}/api/health`, { redirect: 'follow' })
const p = proxied.json()
if (proxied.status !== 200 || p === null) {
  bad('/api/health is not reachable through the web origin', `HTTP ${proxied.status}`)
} else if (JSON.stringify(p) === JSON.stringify(h)) {
  ok('the web origin proxies the play service', 'identical body')
} else {
  bad('the proxy answers something different from the origin', JSON.stringify(p).slice(0, 120))
}

/// A cached /api/me would serve one player's balance to another. Vercel now
/// honours upstream cache headers on external rewrites, so this has to be off.
const cache = proxied.headers.get('x-vercel-cache')
if (cache === null || cache === 'MISS' || cache === 'BYPASS') ok('the proxy is not caching the API', `x-vercel-cache: ${cache ?? 'absent'}`)
else bad('the API is being cached', `x-vercel-cache: ${cache}`)

/// The bearer must survive the hop, or every signed-in call reads as "no session
/// arrived" through the proxy while working directly against the origin.
const me = await hit(`${WEB_URL}/api/me`, {
  redirect: 'follow', headers: { Authorization: 'Bearer not-a-real-session' },
})
const mine = me.json()
if (mine?.error === 'SESSION_UNKNOWN') ok('the Authorization header survives the proxy', 'SESSION_UNKNOWN: it arrived and was looked up')
else if (mine?.error === 'NO_SESSION') bad('the proxy is dropping the Authorization header', 'NO_SESSION: it never arrived')
else bad('/api/me answered unexpectedly', `HTTP ${me.status} ${mine?.error ?? me.text.slice(0, 80)}`)

// ------------------------------------------------------------------- verdict

console.log(`\n  ${WEB_URL}\n  ${PLAY_URL}\n`)
for (const [state, what, detail] of results) {
  console.log(`  ${state === 'pass' ? ' ok ' : 'FAIL'}  ${what}${detail ? `  —  ${detail}` : ''}`)
}
const failed = results.filter(([s]) => s === 'FAIL')
console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
