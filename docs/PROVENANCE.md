# Provenance

NearCraft's baseline is the EthCraft / AgentCity project. `BASELINE.md` lists
exactly which files were vendored, with hashes, and `npm run verify:baseline`
checks them.

## Prior-art repositories

These are recorded in EthCraft's own documentation as its public locations:

- Main project — `https://github.com/RudraBhaskar9439/EthCraft`
- Extracted public component — `https://github.com/RudraBhaskar9439/EthCraft-Arkiv`
- Hosted read-only demo of that component —
  `https://ethcraft-arkiv.quiet-buddy-9104.chatgpt.site`

**Before submitting, open each of these and confirm it resolves publicly.** They
are taken from the prior project's documentation rather than verified here, and
a provenance link a judge cannot open is worse than no link at all. If one is
private or dead, say so in this file instead of leaving it listed.

## Prior chain deployment, for context only

EthCraft settles on Unichain Sepolia (chain 1301) through a custom Uniswap v4
hook. None of those contracts are used by NearCraft, none of their addresses appear
in this repository, and no result from that deployment is restated here as a
NEAR result. It is listed so a reviewer can see what the baseline was, not as
part of this submission.

## AI assistance

AI assisted the implementation, tests and documentation of both the baseline
project and this one. The baseline project discloses the same, and the
hackathon rules permit AI-generated code provided it is listed (Q-005).
