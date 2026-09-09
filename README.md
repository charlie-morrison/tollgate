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

## Try it

The service is live on Hedera testnet. The quote is free — you can read the price without
paying, which is the protocol's first step and is deliberately never rate-limited:

```bash
curl 'http://144.172.101.164:8404/query?records=3&detail=full'   # 402 + machine-readable price
curl  http://144.172.101.164:8404/schedule                       # the fee schedule
curl  http://144.172.101.164:8404/receipts                       # the public settlement trail
curl  http://144.172.101.164:8404/health
```

### The receipt trail

Every settled payment is published to a Hedera Consensus Service topic as an
`x402.receipt.v1` record — transaction id, payer, payee, the amount actually charged, and
the resource it bought. Topic **`0.0.10446488`**, created with **no submit key and no admin
key**, so the record is append-only and not even we can rewrite it.

You do not have to take our `/receipts` endpoint's word for any of it. Reading is plain
mirror-node REST — no key, no account, no SDK — and the endpoint publishes the raw URL as
`verifyItYourself`:

```bash
curl 'https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10446488/messages?limit=25&order=desc'
```

Writing receipts is opt-in and separate from serving. It needs an operator key, so the
public deployment runs read-only and `/health` reports `holdsPrivateKey` **computed from
the running config** rather than as a constant — a health endpoint that kept claiming
"no key" after one was handed to it would be lying about the one property this design
rests on. The receipt operator is deliberately **not** the payee: it signs records and
pays their sub-cent fees, and can never move revenue.

To actually pay, you need a Hedera testnet account. The buyer is the only thing here that
needs the Hedera SDK:

```bash
npm install                       # dev dependency, for the client only
HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=… \
  node tools/pay-once.mjs 'http://144.172.101.164:8404/query?records=3&detail=full'
```

Then check the settlement on a ledger neither of us controls — the transaction id comes
back in `X-PAYMENT-RESPONSE`:

```bash
curl "https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.x-secs-nanos"
```

### What that proves, measured

A real request served through this deployment, verified on the mirror node rather than
from the facilitator's own reply:

| | |
|---|---|
| quoted and charged | **240,000 tinybar** for `records=2&detail=summary` — the metered price, not a flat rate |
| buyer debited | exactly 240,000 |
| payee credited | exactly 240,000 |
| network fee | **242,014 tinybar, charged to the facilitator** — 0% buyer overhead |

## Status

Requirements 1–3 of the Hedera **AI & Agentic Payments** track are met: hosted, settling
over the sponsor's facilitator, metered per unit of work — plus verifiable payment audit
trails on HCS. The commit history is the honest record of how much exists at any moment.
See [`docs/DESIGN.md`](docs/DESIGN.md) for the protocol shape and
[`docs/PRICING.md`](docs/PRICING.md) for the fee schedule.

Running the tests requires no network and no account: `npm test` (136 assertions).

## Licence

MIT — see [`LICENSE`](LICENSE).
