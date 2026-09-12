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

### Being found without being told about it

An agent that already knows the URL can read the price. One that doesn't needs to find the
service at all, so Tollgate serves the x402 discovery document at the conventional path:

```bash
curl http://144.172.101.164:8404/.well-known/x402
```

Two decisions in there are worth stating, because both are about not lying to a reader who
cannot check:

**The listing carries no `quality` block.** The published schema has a place for 30-day
call counts and unique payer counts. Those are *facilitator-observed* figures, and a
service that fills them in is publishing its own reputation. We emit no such key at all,
and a test asserts it cannot appear even if the data is handed to the builder.

**A metered service has no flat price**, and the schema's `amount` is a single number. So
the amount published is the true price of the exact `resource` URL published next to it —
the bare `/query`, whose defaults make it the cheapest real request — and the schedule that
produces every other price travels with it under `extensions.metered`. An agent can budget
any request from the document, and the one number it sees is a fact rather than a
representative sample. The authoritative quote is still the `402` for the request in hand.

The document is built from the same challenge a buyer pays against, not from a separate
description of it, so the two cannot drift; a crossing test asserts the advertised amounts
equal the live `402`'s, asset for asset.

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
from the facilitator's own reply — transaction
[`0.0.7162784@1789218208.606692536`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789218208-606692536):

| | |
|---|---|
| quoted and charged | **240,000 tinybar** for `records=2&detail=summary` — the metered price, not a flat rate |
| buyer debited | exactly 240,000 |
| payee credited | exactly 240,000 |
| network fee | **267,561 tinybar, charged to the facilitator** — 0% buyer overhead |

The fee sits on the facilitator in every settlement we have measured, which is what makes
the buyer's overhead zero rather than merely small. Across **16** facilitator-submitted
settlements to this payee the fee ranges **242,014 – 267,848 tinybar** while the buyer is
debited the quote and nothing else. Count that yourself:

```bash
curl 'https://testnet.mirrornode.hedera.com/api/v1/transactions?account.id=0.0.10181166&transactiontype=cryptotransfer&result=success&limit=100'
```

### Paying in a token instead

The same request is quoted twice — in HBAR and in an HTS token — and the buyer chooses by
signing one of them. Both quotes come from the same meter: the token amount is derived
from the tinybar price, so picking a payment method never changes what the request costs.
The `402` publishes the conversion as `tokenSchedule`, so an agent can budget in either
asset without paying to discover the rate.

```bash
HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=… \
  node tools/pay-once.mjs 'http://144.172.101.164:8404/query?records=2&detail=summary' \
    --asset 0.0.10464963 --max-units 1000
```

Token **`0.0.10464963`** (X402T) carries a **2% fractional fee** to collector
`0.0.10464960`, created during the event by [`tools/create-fee-token.mjs`](tools/create-fee-token.mjs).
Every key on it is empty — admin, supply, fee schedule, freeze, wipe, pause, KYC — so the
fee and the supply are immutable, including to us.

Two things about custom-fee tokens are easy to get wrong, and both are enforced in code
rather than documented and hoped for:

- The fee must be **EXCLUSIVE**. An `INCLUSIVE` fee comes *out of* the transfer, so under
  the `exact` scheme the payee lands short and **every** settlement is rejected as
  underpaid — permanently, for every buyer, with an error blaming the payer.
  `assertTokenUsable` reads `net_of_transfers` off the mirror node and refuses such a token
  by name, rather than trusting the script that minted it.
- The **treasury and any fee collector are exempt from the token's own fees**. A demo
  funded by the treasury shows the fee never firing and proves the opposite of the claim,
  so both are refused as buyers — in the module *and* in the funding tool.

A real token settlement, again read off the mirror rather than from the facilitator —
[`0.0.7162784@1789218229.988614769`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789218229-988614769):
payee credited **240** units (the metered price), collector **+4** (the 2% firing, truncated),
buyer debited **244**. The fee sits *on top of* the transfer rather than inside it, which is
exactly what lets an `exact` check pass.

Settling in a token costs more on the network — about **2.8M tinybar, ~10× the HBAR
rail** — and the facilitator still pays it. Worth one caveat we measured the hard way: the
*first* token payment to a fresh payee cost 69,197,868 because the payee auto-associates
the token on first receipt. That is one-time account setup, not the per-request cost, and
reading it as the latter would overstate the token rail by 25×.

## Status

Requirements 1–3 of the Hedera **AI & Agentic Payments** track are met: hosted, settling
over the sponsor's facilitator, metered per unit of work — plus verifiable payment audit
trails on HCS, multi-asset settlement in HBAR or an HTS token, and an x402
discovery document so other agents can find the service. The commit history is
the honest record of how much exists at any moment. See [`docs/DESIGN.md`](docs/DESIGN.md)
for the protocol shape and [`docs/PRICING.md`](docs/PRICING.md) for the fee schedule.

Running the tests requires no network and no account: `npm test` (204 assertions).

## Licence

MIT — see [`LICENSE`](LICENSE).
