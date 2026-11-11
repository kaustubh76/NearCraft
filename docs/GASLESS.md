# No seed phrase, no popup, no gas prompt — and the one thing that doesn't work

The games track asks for social or email login with *"no seed phrases, no wallet
popups, and no gas prompts in the normal game loop."* Three mechanisms make that
true, and one of them turned out to have a hard limit that is worth writing down
because it is a property of NEAR and NEP-245 together, not of this code.

Everything below was **measured in a local nearcore sandbox**, not inferred.
`npm run test:gasless` reproduces it.

## How a player gets an account

1. **Verify the identity.** `verifyIdentity(token) → {provider, subject}`,
   injected. **This is the only stubbed piece** — a real deployment swaps in
   OIDC/OAuth verification behind the same interface. Tests use a fake.
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

## The limit: a scoped key cannot sell

nearcore refuses a deposit on the inner action of a delegate signed by a
function-call key:

```
Deposit is not allowed with function call
```

The no-deposit rule on function-call keys applies to the delegate's inner action
too — the relayer cannot supply it on the player's behalf. Two consequences:

**Buying is fine.** Players spend from a credit balance inside the market
contract via `buy_with_credit`, which attaches nothing. This is the same reason
agents work that way, and it means a player's in-game money is contract-held —
which is the right shape for a game where the chain is invisible anyway.

**Selling does not work with a scoped key.** NEP-245 requires *exactly 1
yoctoNEAR* on `mt_transfer_call`, as a deliberate safety property: it forces a
real signature for anything that moves tokens. A function-call key cannot attach
it, so a player holding only a scoped key cannot sell materials back to a
merchant.

This is **not implemented and not worked around.** The options we considered and
why each was rejected:

| Option | Why not |
|---|---|
| Have the relayer attach the 1 yoctoNEAR | Measured: refused. The restriction is on the inner action. |
| Add a non-payable transfer method to the items contract | It would remove exactly the safety property NEP-245's 1-yoctoNEAR rule exists to provide. Not worth breaking a standard to pass a requirement. |
| NEP-245 Approval Management, so the market moves tokens for the player | `mt_approve` also requires a deposit, so onboarding would still need one full-access signature. Honest and workable — and the design we would build next. |
| Give the player a full-access key | Reintroduces the seed phrase the requirement exists to remove. |

**The honest position:** the gather → buy half of the loop is gasless and
proven. The sell half needs one signature the scoped key cannot produce. The
cleanest fix is a single opt-in approval at account setup, after which selling is
gasless too — designed, not built.

We think this is a genuine finding rather than a shortfall to hide. NEP-245's
1-yoctoNEAR requirement and NEAR's gasless-agent story are in tension, and
anyone building agent-operated NEP-245 flows will meet it.

## What this does and does not establish

- **Established:** a player account derived from an identity, holding only a
  scoped key, buys goods on a real nearcore node while paying nothing. The
  relayer's balance falls; the player's does not.
- **Not established:** any real OAuth flow — token verification is stubbed. No
  testnet deployment. No Minecraft client involved. Selling via a scoped key
  does not work and is not claimed to.
