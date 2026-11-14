// What a manifest and a key set say this process can actually do.
//
// Two questions that look like presentation and are not: which login reaches an
// account this process can sign for, and which agents it can dispatch. Both
// were answered inline in scripts/serve-play.mjs — an entry-point script with
// top-level awaits, a `process.exit(1)` on a missing key file and a bound port,
// so nothing in tests/ could import it and nothing did. Every change made to
// that file was therefore unexercised by `npm test`.
//
// scripts/serve-web.mjs had already solved the same shape by exporting
// `resolveFile` and `SERVABLE` and gating `listen` behind an entry-point check.
// This is the same move for the parts of serve-play worth asserting.
//
// No files, no network, no keys of its own: the key map is a parameter and only
// ever tested for whether a string is present at a name.
import { playerAccountId } from './onboarding.mjs'

/// Logins a person could plausibly type at a demo prompt.
///
/// Candidates, not a lookup — the account id is a one-way hash, so the only
/// honest way to offer a token is to try some and check what each derives.
export const DEMO_TOKENS = Object.freeze(['player-1', 'player-2', 'player-3', 'player-4', 'player-5'])

/// Accounts this process holds a scoped signing key for.
///
/// `#scoped` and not `#function-call`: the first is a player's key, the second
/// an agent's, and they are different authorities. Filtering on the key rather
/// than on the manifest matters because the hosted deployment ships two keys and
/// a manifest listing four players.
export function signableAccounts({ manifest, keys = {} }) {
  return (manifest?.players ?? [])
    .map((p) => p.account_id)
    .filter((id) => typeof keys[`${id}#scoped`] === 'string')
}

/// What to print at the sign-in prompt, verified rather than asserted.
///
/// The banner used to read `sign in as "player-1" -> ${manifest.players[0]}`: a
/// hard-coded token beside an account derived from something else entirely. They
/// looked consistent and were not — `player-1` derives `p-1d6a3c5d5b87ed0e`,
/// not the first player in any manifest — so anyone following it signed in as a
/// different, usually non-existent account.
///
/// Returns null when this process can sign for nobody, `{token, id}` when a
/// candidate was checked and resolves, and `{token: null, id}` when it can sign
/// for someone but cannot say which login reaches them. That last case is real:
/// a provider-issued OIDC subject is not a typeable string, and a key file left
/// over from an older account derivation matches no candidate.
export function signInHint({ manifest, keys = {}, verifierKind = 'seed', tokens = DEMO_TOKENS }) {
  const signable = signableAccounts({ manifest, keys })
  if (signable.length === 0) return null
  if (verifierKind === 'seed' && manifest?.root) {
    for (const token of tokens) {
      let id
      // A malformed root is a deployment problem, not a reason to lose the
      // banner — and this runs inside a `listening` callback, where a throw is
      // an uncaughtException that takes the server with it.
      try { id = playerAccountId('seed', token, manifest.root) } catch { break }
      if (signable.includes(id)) return { token, id }
    }
  }
  return { token: null, id: signable.join(', ') }
}

/// Agents this process can dispatch: declared by the manifest AND holding a key
/// here. Both halves are required — a manifest entry with no key would be an
/// offer that always refuses, and a key with no manifest entry would be an
/// account this deployment never claimed.
export function declaredAgents({ manifest, keys = {} }) {
  return (manifest?.agents ?? []).filter(
    (a) => typeof keys[`${a.account_id}#function-call`] === 'string',
  )
}
