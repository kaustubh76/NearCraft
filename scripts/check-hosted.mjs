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
import net from 'node:net'

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

/// Never throws. A transient network failure is a RESULT, not a crash.
///
/// The first version let fetch reject, so one `read ETIMEDOUT` against a free
/// instance waking up took the whole check down with an unhandled TypeError —
/// twelve passing assertions thrown away and a stack trace instead of a
/// verdict. Everything that reads a response already handles a non-200, so a
/// zero status flows through the same way.
///
/// Retried twice, because a free Render instance spins down after fifteen idle
/// minutes and the request that wakes it can take about a minute: a cold start
/// is the expected state, not a fault.
async function hit(url, { method = 'GET', headers = {}, body, redirect = 'manual', tries = 3 } = {}) {
  const started = Date.now()
  let last = null
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method, headers, redirect, body, signal: AbortSignal.timeout(120_000) })
      const text = await res.text()
      return { status: res.status, headers: res.headers, text, ms: Date.now() - started,
        json: () => { try { return JSON.parse(text) } catch { return null } } }
    } catch (e) {
      last = e?.cause?.code ?? e?.code ?? e?.message ?? String(e)
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 3000 * (i + 1)))
    }
  }
  return { status: 0, headers: new Headers(), text: `could not be reached: ${last}`,
    ms: Date.now() - started, json: () => null }
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

  // The hosted secret file holds the relayer's key and one player's. No agent
  // keys, so /api/agent must refuse — and `agents: []` is how a client knows
  // not to offer the command rather than offering one that always fails. If
  // this ever reports agents, a worker's key reached the host and should not
  // have.
  if (Array.isArray(h.agents) && h.agents.length === 0) {
    ok('no agent keys reached the host', 'agents: []')
  } else {
    bad('AN AGENT KEY IS ON THE HOST', JSON.stringify(h.agents))
  }
}

/// Prove the faucet is shut by trying to use it, not by reading a flag. A random
/// subject has certainly never been onboarded, so this is the exact request an
/// abuser would send.
///
/// Sent ONLY when /api/health has already said canOnboard is false. Against an
/// instance that can onboard, this request is not a test — it is the attack: it
/// creates an account and moves 0.11 NEAR out of the root account, and running
/// the check twice would spend it twice. A check that damages what it is
/// inspecting is worse than no check, so when the flag says the capability is
/// there, this reports that and sends nothing.
/// What root's balance is, straight from the chain. The un-fakeable control.
///
/// A faucet MOVES this. Whatever the service says about itself, if a stranger
/// signing in leaves root untouched then nothing was created for them.
async function rootBalance() {
  const res = await hit(manifest.rpc, {
    method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: manifest.root },
    }),
  })
  return res.json()?.result?.amount ?? null
}

if (h?.canOnboard !== false) {
  bad('not probing: this instance says it CAN onboard',
    'the probe would create an account and spend root balance — fix canOnboard first')
} else if (Array.isArray(h?.pool?.size ? [1] : null) || h?.pool) {
  // POOL MODE. A stranger signing in SHOULD get an account — a pre-funded one,
  // lent rather than created. The first version of this check expected
  // ONBOARDING_MISCONFIGURED and reported the 200 as
  // "A STRANGER WAS ONBOARDED — it created <id> and funded it from root",
  // which was simply false: nothing was created and root never moved. A check
  // that cries wolf is worse than none, because a real faucet would then hide
  // behind a known-false alarm.
  //
  // A FIXED identity, not a random one. With a pool a random subject takes a
  // fresh slot every run, so the check would eat the demo pool it is checking.
  // A fixed one is idempotent and tests the stronger property as well: a
  // returning visitor keeps the account they had.
  const before = await rootBalance()
  const subject = 'check-hosted-probe'
  const first = await hit(`${PLAY_URL}/api/session`, {
    method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: subject }),
  })
  const got = first.json()
  if (first.status !== 200 || !got?.accountId) {
    bad('a visitor could not be lent a player', `HTTP ${first.status} ${got?.error ?? first.text.slice(0, 70)}`)
  } else {
    ok('a visitor is lent their own pre-funded player', `${got.accountId}  (${h.pool.free} of ${h.pool.size} free)`)

    const again = await hit(`${PLAY_URL}/api/session`, {
      method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: subject }),
    })
    const second = again.json()
    if (second?.accountId === got.accountId) ok('and keeps it when they come back', got.accountId)
    else bad('a returning visitor was moved to a different account', `${got.accountId} -> ${second?.accountId}`)

    const after = await rootBalance()
    if (before && after && before === after) {
      ok('and root paid nothing for it', `${(Number(BigInt(after) / 10n ** 20n) / 10_000).toFixed(4)} NEAR, unmoved`)
    } else {
      bad('ROOT BALANCE MOVED while lending a player', `${before} -> ${after}`)
    }
  }
} else {
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
} else {
  // The STABLE fields, not the whole body. `pool.free` is live state and moves
  // between two reads — which is correct, and which broke a byte-for-byte
  // comparison the moment a pool existed. What this check is for is "the proxy
  // reaches the same service", not "the body is frozen".
  const stable = (b) => JSON.stringify({
    contracts: b?.contracts, network: b?.network, verifier: b?.verifier,
    canOnboard: b?.canOnboard, custodial: b?.custodial, relayer: b?.relayer,
    poolSize: b?.pool?.size ?? null,
  })
  if (stable(p) === stable(h)) {
    ok('the web origin proxies the play service', 'same service, same contracts')
  } else {
    bad('the proxy answers a different service', stable(p).slice(0, 110))
  }
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

// ------------------------------------------------------- the Minecraft server
//
// A TCP connect proves SOMETHING is listening on that port. It does not prove a
// Minecraft server is, and on a tunnel the thing listening might be the
// tunnel's own error page. Minecraft has a documented handshake for exactly
// this — Server List Ping — so this speaks it: a handshake packet with
// next-state 1, a status request, then the JSON the server answers with. The
// MOTD in that JSON is set by scripts/mc-server.mjs, so a reply carrying it
// proves OUR server answered rather than something else on the port.
const mc = hosting.minecraft ?? null
const mcAddress = process.env.NEARCRAFT_MC ?? mc?.address ?? ''

if (!mcAddress) {
  // Not a pass. An unadvertised server is a fact to report, and reporting it as
  // "ok" is how a check stops meaning anything.
  console.log('\n  no Minecraft address advertised (config/hosting.json minecraft.address is empty),')
  console.log('  so nothing was pinged. Render cannot host one; see that file for why.\n')
} else {
  const [mcHost, mcPortRaw] = mcAddress.split(':')
  const mcPort = Number(mcPortRaw ?? 25565)

  /// Minecraft's varint: seven bits a byte, high bit means "more follows".
  const varint = (n) => {
    const out = []
    let v = n >>> 0
    do {
      let b = v & 0x7f
      v >>>= 7
      if (v !== 0) b |= 0x80
      out.push(b)
    } while (v !== 0)
    return Buffer.from(out)
  }
  const framed = (payload) => Buffer.concat([varint(payload.length), payload])
  const mcString = (str) => {
    const b = Buffer.from(str, 'utf8')
    return Buffer.concat([varint(b.length), b])
  }

  const ping = await new Promise((resolve) => {
    const socket = net.connect({ host: mcHost, port: mcPort })
    const chunks = []
    let settled = false
    const done = (value) => { if (!settled) { settled = true; socket.destroy(); resolve(value) } }
    socket.setTimeout(20_000)
    socket.on('timeout', () => done({ error: 'timed out' }))
    socket.on('error', (e) => done({ error: e?.code ?? e?.message ?? String(e) }))
    socket.on('connect', () => {
      const port = Buffer.alloc(2)
      port.writeUInt16BE(mcPort)
      // protocol 0 is "I do not care"; every server answers a status request.
      const handshake = framed(Buffer.concat([
        varint(0x00), varint(0), mcString(mcHost), port, varint(1),
      ]))
      socket.write(Buffer.concat([handshake, framed(varint(0x00))]))
    })
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const all = Buffer.concat(chunks)
      // The JSON is the only brace-delimited run in the reply; find it rather
      // than re-implementing packet framing for a one-shot check.
      const start = all.indexOf(0x7b)
      const end = all.lastIndexOf(0x7d)
      if (start === -1 || end <= start) return
      try { done({ status: JSON.parse(all.slice(start, end + 1).toString('utf8')) }) } catch { /* keep reading */ }
    })
    socket.on('close', () => done({ error: 'closed before answering' }))
  })

  if (ping.error) {
    bad(`the Minecraft server at ${mcAddress} did not answer`, ping.error)
  } else {
    const motd = typeof ping.status?.description === 'string'
      ? ping.status.description
      : ping.status?.description?.text ?? JSON.stringify(ping.status?.description ?? '')
    const want = mc?.expect_motd ?? 'NearCraft'
    if (String(motd).includes(want)) {
      ok(`a Minecraft server answered at ${mcAddress}`,
        `"${String(motd).slice(0, 48)}"  ${ping.status?.version?.name ?? '?'}`)
    } else {
      bad(`something answered at ${mcAddress} but it is not this server`, String(motd).slice(0, 64))
    }
  }
}

// ------------------------------------------------------------------- verdict

console.log(`\n  ${WEB_URL}\n  ${PLAY_URL}\n`)
for (const [state, what, detail] of results) {
  console.log(`  ${state === 'pass' ? ' ok ' : 'FAIL'}  ${what}${detail ? `  —  ${detail}` : ''}`)
}
const failed = results.filter(([s]) => s === 'FAIL')
console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`)
process.exit(failed.length === 0 ? 0 : 1)
