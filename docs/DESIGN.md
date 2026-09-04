# Design

## The exchange

```
agent                             tollgate                        hedera
  │                                  │                              │
  │  GET /data?records=3             │                              │
  │─────────────────────────────────>│                              │
  │                                  │  meter the request           │
  │  402 + price + terms             │                              │
  │<─────────────────────────────────│                              │
  │                                  │                              │
  │  sign a transfer for that price  │                              │
  │                                  │                              │
  │  GET /data?records=3             │                              │
  │  X-PAYMENT: <signed tx>          │                              │
  │─────────────────────────────────>│                              │
  │                                  │  verify + settle ───────────>│
  │                                  │  confirm on mirror <─────────│
  │  200 + the data                  │                              │
  │<─────────────────────────────────│                              │
```

The agent never holds an account with us. We never hold a key of theirs. The only shared
state is a transaction id.

## Three rules the server keeps

### 1. One pricing authority

The number in the `402` and the number checked at verification come from the *same
function call over the same inputs*. They cannot be two code paths, because two code paths
drift, and a gateway whose quote and charge disagree is worse than one that overcharges
honestly — it fails unpredictably.

### 2. The buyer supplies exactly one thing

The payment header carries a signed transaction. That is all Tollgate reads from it.

Everything else — payee account, amount, asset, resource identifier — is rebuilt from
server config and from the live request being served. This is not defensive
over-engineering; it closes a specific hole. If the server echoed back the buyer's
declared terms and then asked "does this payment satisfy these terms?", an attacker
supplies *both* sides and a one-tinybar payment against one-tinybar terms verifies
perfectly.

The same hole has a second door: pay honestly for a cheap request, then present that
receipt against an expensive one. Closed the same way — the price is re-derived from the
request in hand, never from anything the buyer said about it.

### 3. Settlement is confirmed against the ledger, not against a reply

A facilitator's `{"success": true}` is a claim. The mirror node is the record. Tollgate
confirms the transfer landed, that the payee was credited the full amount, and that the
consensus record matches the transaction it verified — before any data leaves the server.

## What the server does not have

No wallet. No key file. No signing path. A Tollgate deployment can state prices and read
the ledger; it cannot move money. That property is load-bearing for the whole pitch — an
unattended agent-facing endpoint that *can* spend is a liability, and one that cannot is
just a meter.

## Open questions being worked

- Replay: a signed transaction is bearer-ish until it is consumed. Tracking consumed
  transaction ids, and where in the verify/settle order the claim is made.
- Rate limiting the verification path without ever throttling the unpaid quote — an honest
  buyer must always be able to read the price before paying.
