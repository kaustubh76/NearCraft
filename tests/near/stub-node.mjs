// A nearcore stub that answers one question: what may this access key do?
//
// Shared by the signer tests. It exists because `createAgentSigner` verifies
// its key against the chain before it will sign anything, so tests that were
// genuinely offline before — they asserted on refusals that land ahead of any
// network call — now need something to answer that one query.
//
// It is not a fake chain. It answers `view_access_key` and returns the same
// shape for everything else, which is enough to get a signer past its startup
// check and no further. A test that needs a real node uses the sandbox.

import { createServer } from 'node:http'

/// Serve `permission` as the key's permission. `becomes` changes the answer
/// mid-test, which is how a key being widened underneath a parked decision is
/// modelled.
export async function stubNode(permission) {
  const seen = []
  let current = permission
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      seen.push({ type: parsed.params?.request_type ?? parsed.method, finality: parsed.params?.finality })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        result: { permission: current, nonce: 1, block_height: 1, block_hash: '11111111111111111111111111111111' },
      }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    rpcUrl: `http://127.0.0.1:${port}`,
    seen,
    // near-api-js ALSO reads `view_access_key` to get a nonce before signing,
    // so counting the request type alone cannot tell the scope check from the
    // nonce fetch, and an assertion on it would mean nothing. The scope check
    // is the one asking at `final`.
    scopeQueries: () => seen.filter((s) => s.type === 'view_access_key' && s.finality === 'final').length,
    becomes: (p) => { current = p },
    close: () => new Promise((r) => server.close(r)),
  }
}

/// A key scoped exactly as the policy expects: the ordinary, healthy case.
export const scopedTo = (marketContract, methodNames) => ({
  FunctionCall: { receiver_id: marketContract, method_names: methodNames, allowance: '2000000000000000000000000' },
})
