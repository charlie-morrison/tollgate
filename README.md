# Tollgate

**Pay-per-unit API access for AI agents, settled on Hedera over x402.**

An agent hits your endpoint. It gets back `402 Payment Required` with a machine-readable
price for *the exact request it just made*. It signs a Hedera transfer, retries with the
payment attached, and gets its data. No API key, no signup, no subscription, no invoice.

Built at ETHOnline 2026 for the Hedera **AI & Agentic Payments** track.

---

## Why this shape

Three design choices drive everything else here, and each one is a claim that the rest of
this repo has to earn:

**1. Price the work, not the request.** A flat per-call charge is the easy thing to build
and the wrong thing to sell: a caller asking for one record subsidises the caller asking
for a hundred. Tollgate quotes from a published schedule — a base charge plus a per-unit
charge — so an agent can budget *before* it spends, and the amount that moves on-chain is
the amount the work was actually worth.

**2. The server holds no private key.** The buyer signs. The facilitator submits. The
resource server's whole job is to state a price and check that it was paid. That means a
Tollgate deployment cannot be drained if it is compromised — there is nothing in it to
drain — and it is why this repo has no wallet, no seed phrase, and no signing code on the
server path.

**3. Never trust the buyer about the buyer's own payment.** The single field Tollgate takes
from an incoming payment header is the signed transaction itself. Every *term* — who gets
paid, how much, in what asset, for what resource — is rebuilt from server config and
re-derived from the live request. A buyer who supplies their own favourable terms, or who
pays for a cheap request and presents that receipt against an expensive one, is refused.

## Status

Day 1 of the event. This README describes the target; the commit history is the honest
record of how much of it exists at any moment. See [`docs/DESIGN.md`](docs/DESIGN.md) for
the protocol shape and [`docs/PRICING.md`](docs/PRICING.md) for the fee schedule.

## Licence

MIT — see [`LICENSE`](LICENSE).
