// The judge-facing page, tested.
//
// web/market.html is the only surface that shows the contract's own pricing
// reason without a Minecraft host, so it is load-bearing for the `games` track
// — and until now nothing checked it. These tests extract the real script out of
// the real page and run it against a DOM shim and the real market.mjs module,
// so there is no second copy of the page logic to drift.
//
// Everything is stubbed at the network boundary, so the suite stays offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolveFile } from '../../scripts/serve-web.mjs'

const ROOT = new URL('../../', import.meta.url).pathname
const MODULE_URL = new URL('../../backend/near/market.mjs', import.meta.url).href

const DEPLOYMENT = {
  rpc: 'https://test.rpc.fastnear.com',
  economy_scale: 0.01,
  contracts: { items: 'items.x.testnet', market: 'market.x.testnet', guard: 'guard.x.testnet' },
}

// The shapes below were captured from the live deployment, not invented, so a
// contract change that alters them breaks this test rather than the page.
const TOKENS = [{ token_id: 'iron_ingot' }, { token_id: 'coal' }]
const MERCHANTS = [
  ['ironmonger.x.testnet', { name: 'Ironmonger', treasury: '258000000000000000000000', floor: '10000000000000000000000' }],
  ['stonecutter.x.testnet', { name: 'Stonecutter', treasury: '9000000000000000000000', floor: '10000000000000000000000' }],
]
const QUOTES = {
  iron_ingot: [
    {
      merchant_id: 'stonecutter.x.testnet', merchant_name: 'Stonecutter', item: 'iron_ingot', count: 1,
      unit_price: '6000000000000000000000', total: '6000000000000000000000', merchant_bid: null,
      stock: '12', band: 'thin', demand_bps: '12000', closed: true,
      reason: 'Stonecutter holds 12 (thin); demand is heavy. It is not buying: its treasury is at its floor.',
    },
    {
      merchant_id: 'ironmonger.x.testnet', merchant_name: 'Ironmonger', item: 'iron_ingot', count: 1,
      unit_price: '4000000000000000000000', total: '4000000000000000000000', merchant_bid: '3200000000000000000000',
      stock: '254', band: 'normally stocked', demand_bps: '10000', closed: false,
      reason: 'Ironmonger holds 254 (normally stocked); demand is quiet.',
    },
  ],
  coal: [],
}

const encode = (value) => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(value)) ] } })

/// A DOM just large enough for this page: elements with settable content, an
/// `hidden` flag for the play panel, and listener registration that records
/// rather than dispatches — the page only needs to be able to call it.
function shimDocument() {
  const el = () => ({
    innerHTML: '', hidden: false, listeners: [],
    set textContent(t) { this.innerHTML = t },
    get textContent() { return this.innerHTML },
    addEventListener(type, fn) { this.listeners.push([type, fn]) },
    value: '',
  })
  const nodes = { '#banner': el(), '#main': el(), '#play': el(), '#tok': el(), '#signin': el(),
                  '#getcode': el(), '#code': el() }
  return { querySelector: (s) => nodes[s], nodes, querySelectorAll: () => [] }
}

/// Run the page's own script with a given fetch, and wait for it to settle.
async function renderPage(fetchStub) {
  const html = await readFile(new URL('../../web/market.html', import.meta.url), 'utf8')
  const js = html.split('<script>')[1].split('</script>')[0]
  assert.ok(js.includes('renderLive'), 'extracted the wrong block from the page')

  // Point the page's dynamic import at the real module by absolute URL. The
  // module under test is therefore the real one, not a fake.
  const wired = js.replace("'../backend/near/market.mjs'", JSON.stringify(MODULE_URL))
  assert.ok(wired.includes(MODULE_URL), 'the page no longer imports the market reader')

  const document = shimDocument()
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchStub
  try {
    new Function('document', 'fetch', wired)(document, fetchStub)

    // The page boots in an async IIFE whose promise it does not expose, so wait
    // for it to put something on the page.
    for (let i = 0; i < 200 && !document.nodes['#main'].innerHTML; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
  } finally {
    globalThis.fetch = realFetch
  }
  assert.ok(document.nodes['#main'].innerHTML, 'the page rendered nothing at all')
  return {
    banner: document.nodes['#banner'].innerHTML,
    main: document.nodes['#main'].innerHTML,
    play: document.nodes['#play'],
    document,
    /// Fire a handler the page registered, the way a click would.
    click: async (selector) => {
      const node = document.nodes[selector]
      assert.ok(node, `${selector} is not in the shim`)
      const handler = node.listeners.find(([type]) => type === 'click')
      assert.ok(handler, `${selector} has no click handler`)
      await handler[1]()
    },
  }
}

/// A fetch that answers like a healthy deployment.
function liveFetch({ rpcFails = false } = {}) {
  return async (url, init) => {
    if (String(url).endsWith('deployment.json')) return { ok: true, json: async () => DEPLOYMENT }
    if (String(url).endsWith('market-snapshot.json')) return { ok: true, json: async () => SNAPSHOT }
    if (rpcFails) return { ok: false, status: 503, statusText: 'Service Unavailable' }

    const body = JSON.parse(init.body)
    const method = body.params.method_name
    if (method === 'mt_tokens') return { ok: true, json: async () => encode(TOKENS) }
    if (method === 'merchants') return { ok: true, json: async () => encode(MERCHANTS) }
    if (method === 'quotes') {
      const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString())
      return { ok: true, json: async () => encode(QUOTES[args.item] ?? []) }
    }
    throw new Error(`unexpected view method: ${method}`)
  }
}

const SNAPSHOT = {
  generated_at_unix: 1762800000, network: 'near-sandbox', note: 'Scripted run.',
  purchases: 118, sell_backs: 9, volume_yocto: '2400000000000000000000000', rounds: 8,
  buyers: 20, wall_clock_seconds: 111,
  merchants: [{ name: 'Ironmonger', account_id: 'ironmonger.x.testnet', treasury: '258000000000000000000000', closed: false }],
  materials: [{ item: 'iron_ingot', quotes: QUOTES.iron_ingot }],
  strategies: [{ strategy: 'undercut', agents: 4, spent_yocto: '1000000000000000000000000', earned_yocto: '0', units_held: 40 }],
}

test('reading the live chain: the page says it is live and names the contract', async () => {
  const { banner, main } = await renderPage(liveFetch())

  assert.match(banner, /Live from NEAR testnet/)
  assert.match(banner, /market\.x\.testnet/, 'a judge must be able to see which contract was read')
  assert.match(banner, /economy_scale/, 'the scale changes what the numbers mean, so it must be stated')
  assert.doesNotMatch(banner, /simulation snapshot/i, 'it must not claim to be a snapshot while reading live')

  assert.match(main, /The deployment/)
  assert.match(main, /Ironmonger/)
  assert.match(main, /0\.004/, 'the ask is rendered in NEAR')
  assert.match(main, /1\.00×|1\.00&times;/, 'the demand multiplier the price rule applied')
  assert.match(main, /holds 254 \(normally stocked\)/, "the contract's own reason string, verbatim")
})

test('cheapest first, because that is what makes a player walk to another merchant', async () => {
  const { main } = await renderPage(liveFetch())
  assert.ok(main.indexOf('Ironmonger') < main.indexOf('Stonecutter'), 'Ironmonger is cheaper and must come first')
})

test('a merchant posting no bid anywhere is shown closed', async () => {
  const { main } = await renderPage(liveFetch())
  // Stonecutter bids on nothing it stocks, which is the contract's definition of closed.
  const row = main.slice(main.indexOf('stonecutter.x.testnet'))
  assert.match(row.slice(0, 400), /shut">closed/)
  assert.equal(main.match(/open">open/g).length, 1, 'only Ironmonger is buying')
  assert.match(main, /1\/2/, 'the header counts merchants still buying')
})

test('a material no merchant stocks is omitted rather than shown empty', async () => {
  const { main } = await renderPage(liveFetch())
  assert.doesNotMatch(main, /<h3>coal<\/h3>/, 'an empty table would read as a broken page')
})

test('no raw yoctoNEAR reaches a reader', async () => {
  // The same bug the in-game tooltip had: an 18+ digit run is a number nobody
  // can read, and it looked like a price.
  const { banner, main } = await renderPage(liveFetch())
  for (const [name, text] of [['banner', banner], ['main', main]]) {
    const stripped = text.replace(/x\.testnet/g, '')
    assert.doesNotMatch(stripped, /\d{15,}/, `${name} is showing a raw yocto amount`)
  }
})

test('when the live read fails it falls back to the snapshot and says why', async () => {
  const { banner, main } = await renderPage(liveFetch({ rpcFails: true }))

  assert.match(banner, /retained simulation snapshot, not live chain data/)
  assert.match(banner, /The live read failed/, 'a silent fallback would be the page lying by omission')
  assert.match(banner, /503/, 'name the actual failure')
  assert.match(main, /The run/)
  assert.match(main, /118/, 'the snapshot figures render')
  assert.match(main, /undercut/, 'including the strategy table the live view has no equivalent of')
  // The shared table means the snapshot shows the same reason strings.
  assert.match(main, /holds 254 \(normally stocked\)/)
})

test('when neither live nor snapshot can be read, it explains instead of showing nothing', async () => {
  const dead = async (url) => {
    if (String(url).endsWith('deployment.json')) throw new Error('Failed to fetch')
    return { ok: false, status: 404, statusText: 'Not Found' }
  }
  const { banner, main } = await renderPage(dead)

  assert.match(banner, /Neither live chain data nor a snapshot/)
  assert.match(main, /npm run web/, 'tell the reader the one command that fixes it')
  assert.match(main, /same-origin policy/)
})

test('the static server cannot be talked out of the repository root', async () => {
  assert.equal(resolveFile(ROOT, '/'), `${ROOT}web/market.html`)
  assert.equal(resolveFile(ROOT, '/deployment.json'), `${ROOT}deployment.json`)
  assert.equal(resolveFile(ROOT, '/backend/near/market.mjs'), `${ROOT}backend/near/market.mjs`)

  // The real property: a traversal attempt never resolves outside the root. It
  // lands on a missing path inside it and 404s, because normalize() collapses a
  // leading ".." on an absolute path before join() ever sees it. The null branch
  // in the server is belt-and-braces for a request form that is not origin-form.
  for (const hostile of [
    '/../../etc/passwd',
    '/../.local/nearcraft-keys.json',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/web/../../etc/hosts',
    '/web/../../../.local/nearcraftmc-root.json',
  ]) {
    const got = resolveFile(ROOT, hostile)
    assert.ok(got === null || got.startsWith(ROOT), `${hostile} escaped the root: ${got}`)
    assert.doesNotMatch(String(got), /\.local|etc\/(passwd|hosts)$/, `${hostile} reached a real file outside the served tree`)
  }
  // The query string must not become part of the path.
  assert.equal(resolveFile(ROOT, '/deployment.json?v=2'), `${ROOT}deployment.json`)
})

// ---------------------------------------------------------- the play panel
//
// The page is served two ways on purpose: `npm run web` is read-only and needs
// no credentials, `npm run play` mounts the API. The panel must appear in the
// second case and change NOTHING in the first, because the read-only view is
// what a judge runs from a clean clone.

/// A fetch that also answers the API probe, as `npm run play` would.
function playableFetch(health = { playable: true, verifier: 'seed', custodial: true }) {
  const base = liveFetch()
  return async (url, init) => {
    if (String(url).includes('/api/health')) return { ok: true, json: async () => health }
    return base(url, init)
  }
}

test('with no API behind it the page is unchanged and the panel stays hidden', async () => {
  const { play, main } = await renderPage(liveFetch())
  assert.equal(play.hidden, true, 'the play panel must not appear without an API')
  assert.ok(!main.includes('data-act="buy"'), 'no trade buttons without an API')
  assert.ok(!main.includes('<th>Trade</th>'), 'no trade column without an API')
})

test('with an API behind it the panel offers a sign-in', async () => {
  const { play } = await renderPage(playableFetch())
  assert.equal(play.hidden, false)
  assert.match(play.innerHTML, /Sign in/)
})

test('a seeded login is described as one, not dressed up as OIDC', async () => {
  // Saying "signed in with Google" when any string is accepted would be the
  // exact overclaim this project keeps removing from its own documents.
  const { play } = await renderPage(playableFetch())
  assert.match(play.innerHTML, /any string/i)
  assert.match(play.innerHTML, /No OIDC provider is configured/i)
})

test('a real OIDC provider is described as one', async () => {
  const { play } = await renderPage(playableFetch({ playable: true, verifier: 'oidc', custodial: true }))
  assert.match(play.innerHTML, /real OIDC provider/i)
  assert.ok(!/any string/i.test(play.innerHTML), 'must not call a real provider a seeded one')
})

test('trade buttons need a session, not merely an API', async () => {
  // The panel is visible but nobody has signed in, so the quote table must not
  // offer buttons that would be refused.
  const { main } = await renderPage(playableFetch())
  assert.ok(!main.includes('data-act="buy"'), 'buttons must wait for a session')
})

test('a signed-in player can get a code for Minecraft, and is told what it is worth', async () => {
  // The whole reason this control exists: a login token is about 977 characters
  // and Minecraft carries 256, so the page has to hand over something a person
  // can type. Driven through the page's own handlers, not asserted on source.
  const base = liveFetch()
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.includes('/api/health')) {
      return { ok: true, json: async () => ({ playable: true, verifier: 'oidc', custodial: true, linkCodes: true }) }
    }
    if (u.includes('/api/session')) {
      return { ok: true, json: async () => ({ sessionId: 'S1', accountId: 'p-abc.testnet', verifier: 'oidc' }) }
    }
    if (u.includes('/api/me')) {
      return { ok: true, json: async () => ({
        accountId: 'p-abc.testnet', credit: '4000000000000000000000', near: '100',
        holdings: { iron_ingot: '2' }, permittedMethods: ['buy_with_credit', 'sell'],
        fullAccessKeys: 0, scopedKeys: 1,
      }) }
    }
    if (u.includes('/api/link-code')) {
      return { ok: true, json: async () => ({ code: 'K9FH2MQ7', expiresInMs: 120000 }) }
    }
    return base(url, init)
  }

  const page = await renderPage(fetchImpl)
  await page.click('#signin')
  const signedIn = page.document.nodes['#play'].innerHTML
  assert.match(signedIn, /Code for Minecraft/, 'a signed-in player must be offered a code')
  assert.match(signedIn, /977/, 'and told why a token will not do')
  assert.match(signedIn, /claim/, 'and told the command to run')

  await page.click('#getcode')
  const withCode = page.document.nodes['#play'].innerHTML
  assert.match(withCode, /K9FH2MQ7/, 'the code must be shown')
  assert.match(withCode, /expires in 120s/, 'with how long it lasts')
  assert.match(withCode, /bearer credential/i, 'and what it is worth until then')
})

test('the code control is not offered before anyone has signed in', async () => {
  // It mints against a session. Offering it first would be a button that cannot
  // work, and the service refuses it anyway.
  const { play } = await renderPage(playableFetch({ playable: true, verifier: 'seed', custodial: true, linkCodes: true }))
  assert.ok(!play.innerHTML.includes('Code for Minecraft'), 'no code button without a session')
})

test('a service with no link codes does not advertise them', async () => {
  const base = liveFetch()
  const page = await renderPage(async (url, init) => {
    const u = String(url)
    if (u.includes('/api/health')) return { ok: true, json: async () => ({ playable: true, verifier: 'seed', custodial: true }) }
    if (u.includes('/api/session')) return { ok: true, json: async () => ({ sessionId: 'S1', accountId: 'p-abc.testnet' }) }
    if (u.includes('/api/me')) return { ok: true, json: async () => ({ accountId: 'p-abc.testnet', holdings: {}, permittedMethods: [], fullAccessKeys: 0 }) }
    return base(url, init)
  })
  await page.click('#signin')
  assert.ok(!page.document.nodes['#play'].innerHTML.includes('Code for Minecraft'))
})
