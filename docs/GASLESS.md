# No seed phrase, no popup, no gas prompt — and the one thing that doesn't work

The games track asks for social or email login with *"no seed phrases, no wallet
popups, and no gas prompts in the normal game loop."* Three mechanisms make that
true, and one of them turned out to have a hard limit that is worth writing down
because it is a property of NEAR and NEP-245 together, not of this code.

Everything below was **measured in a local nearcore sandbox**, not inferred.
`npm run test:gasless` reproduces it.

## How a player gets an account

1. **Verify the identity.** `verifyIdentity(token) → {provider, subject}`,
   injected. Implemented for real in `backend/near/oidc.mjs` — JWKS fetch, JWT
   signature verification, and `iss`/`aud`/`exp`/`nbf`/`sub` checks, with 25
   offline tests. The injected seam stays, because the seeded demo players use a
   `seed:` provider and because a test must be able to supply a fake.
2. **Derive the account, deterministically.**
   `p-<first 8 hex of sha256("provider:subject")>.<root>`. The same login always
   lands on the same account, so there is no mapping table to lose or leak, and
   the account id reveals nothing about the login. `google:a@b.com` and
   `discord:a@b.com` are deliberately different players.
3. **Issue a scoped key the server holds.** A function-call access key on the
   player's account, restricted to the market contract and an explicit method
   list. The player never sees a key, which is what makes "no seed phrase" a
   fact rather than a slogan.

So: no seed phrase because there is no key to show, and no wallet popup because
there is no wallet to open.

## Why there is no gas prompt

The player's scoped key signs a **NEP-366 delegate action**. A relayer account
submits it, wrapped in a transaction of its own, and the relayer pays.

Measured, from `tests/near/gasless.mjs`:

```
player  delta 0 yoctoNEAR
relayer delta -28155034056694000000000 yoctoNEAR   (≈ 0.028 NEAR)
player received 3 iron_ingot
```

The player's balance moves by **exactly zero**. That is the entire claim, and it
is asserted rather than described: `assert.equal(after.player - before.player, 0n)`.

Two things worth knowing, both found by measuring:

- **A function-call access key can sign a delegate action.** It does not have to
  be full-access. We expected to have to check this and it works.
- **An API seam in near-api-js v7:** `createSignedMetaTransaction` resolves to
  `{delegateHash, signedDelegate}` but `relayMetaTransaction` wants the bare
  `signedDelegate`. Passing the wrapper fails with an unhelpful *"cannot read
  properties of undefined (reading 'senderId')"*.

## Selling: the problem, and how it is actually solved

nearcore refuses a deposit on the inner action of a delegate signed by a
function-call key:

```
Deposit is not allowed with function call
```

The no-deposit rule applies through the delegate, and the relayer cannot supply
it either. **Buying is unaffected** — players spend from a credit balance via
`buy_with_credit`, which attaches nothing. But NEP-245 requires *exactly 1
yoctoNEAR* on `mt_transfer_call`, deliberately, so that anything moving tokens
carries a real signature. A player holding only a scoped key cannot produce it.

So selling cannot go through the push path at all. It goes the other way: the
market **pulls**, under an approval.

### The mechanism

```
player → market.sell(item, count, approval_id)     non-payable, relayed, free
market → items.mt_transfer(market, item, count,
            approval: Some((player, approval_id)))  1 yoctoNEAR from MARKET
market → credits the player
```

`market.sell` carries no `#[payable]`, which is why a scoped key can call it —
and `scripts/check-nep245.mjs` asserts it stays that way, because making it
payable would silently break every player.

### The chicken-and-egg, and the three-transaction answer

`mt_approve` needs a deposit too, so a player who only ever holds a scoped key
could never grant one. The approval therefore has to be made **while a
full-access key still exists**, and that key must then be destroyed.
`backend/near/onboarding.mjs` does exactly that:

1. **root:** `CreateAccount` + `Transfer` + `AddKey(full access)`
2. **player, with that key:** `mt_approve`, granting the market a standing
   allowance over every sellable material. One call covers all of them, since
   `mt_approve` takes arrays.
3. **player:** `AddKey(function-call, scoped)` **then** `DeleteKey(full access)`
   — in that order, in one transaction. Reversed or split, a failure between
   them would leave an account nobody can use.

The player never sees a key at any point, and when onboarding finishes **no
full-access key exists for the account**. `tests/near/gasless.mjs` asserts that
before it tries to sell:

```js
assert.equal(full.length, 0, 'the player must hold no full-access key after onboarding')
assert.equal(keys.length, 1, 'exactly one key, and it is scoped')
```

### Measured

```
player  delta  274737763755900000000 yoctoNEAR     (gained)
relayer delta -58153354371381300000000 yoctoNEAR
player materials 50 -> 40, credited 600000000000000000000000
```

The player's balance goes **up**. That is not a typo and it is worth knowing:
nearcore refunds unused gas to the delegate's **sender**, even though the
relayer prepaid it, so a sender can finish a relayed call marginally ahead. The
buy path happens to net to exactly zero; this one does not. The claim asserted
is therefore *the player never pays* — `delta >= 0` — rather than *the balance
never moves*, because asserting equality here would be asserting an accident.

### One spec ambiguity we had to decide

The Approval Management extension says transfers "must nullify approvals on
success". For a non-fungible token that is unambiguous. For multi-token amounts
it cannot mean "delete the whole allowance" — the owner still holds the
remainder, and a standing operator approval would be impossible, which is the
entire use case above. **We decrement by the amount transferred** and remove the
entry at zero. The `Approval.amount` field exists precisely so there is
something to decrement. Also: `approval_id` is typed `number` in the method
signatures but `string` in the `Approval` struct; we use `U64`, a string over
JSON, which is NEAR's normal convention for 64-bit values.

### What we declined to do

| Option | Why not |
|---|---|
| Have the relayer attach the 1 yoctoNEAR | Measured: refused. The restriction is on the inner action. |
| Add a non-payable transfer method to the items contract | It would remove exactly the safety property NEP-245's 1-yoctoNEAR rule exists to provide. Not worth breaking a standard to pass a requirement. |
| Give the player a full-access key | Reintroduces the seed phrase the requirement exists to remove. |

## What this does and does not establish

- **Established, on a real nearcore node:** a player account derived from an
  identity, holding **no full-access key at all**, both buys and sells while
  paying nothing. The relayer's balance falls in both cases. Approvals are
  granted once during onboarding and the bootstrap key is destroyed in the same
  transaction that installs the scoped one.
- **Not established:** a login against a real provider. The verifier is built
  and tested (`backend/near/oidc.mjs`, 25 offline tests), but no provider client
  id is configured, so nothing here has verified a token Google actually issued.
  That is configuration rather than code, and it is the last external
  dependency. No Minecraft client is involved in any of it either.

## A side effect worth naming: relaying prevents lock-out

NEAR's access-key docs warn — and the `security` track prompt repeats it — that
an account holding *only* function-call keys "can lock itself out if the gas
allowance runs out". It cannot add a replacement key, so when the allowance
falls below one call's prepaid gas that account is finished.

Our player is exactly the account at risk: one scoped key, no full-access key,
by design. Measured over six relayed calls on public testnet, its allowance was
drawn down by **zero yoctoNEAR**. A directly-signing agent over one call drew
670,133,550,974,700,000,000 yocto (~0.00067 NEAR).

The reason is the same mechanism that makes play gasless: in a NEP-366 delegate
the *relayer's* key pays, so the player's allowance is never touched. So the
design that removes the gas prompt also removes the lock-out, and it removes it
for the one account that could not have been rescued. That was not the goal —
it falls out of relaying — but it is worth stating, because the hazard is real
for anything that signs for itself.

`npm run keys` reports remaining headroom in calls and fails below fifty.
