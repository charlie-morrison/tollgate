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

### 2b. Two assets, and still only one thing the buyer supplies

Tollgate quotes the same request in HBAR and in an HTS token, and the buyer picks. The
obvious implementation — read the asset out of the payment envelope and check against
that offer — reopens rule 2 through a side door, because "which offer am I being held
to?" is a *term*, and terms do not come from the buyer.

So there is deliberately no code path that reads an asset from the envelope. The server
enumerates **its own** offers and tries each in turn; the buyer's signature selects one by
satisfying it. Not even as an ordering hint — a hint that reorders candidates is one
refactor away from being the thing that chooses.

A facilitator outage during that loop **aborts** rather than falling through to the next
asset. "Try the other one" would quietly convert an outage into a payment rejection, and
tell an honest buyer their good payment was bad.

The token amount is a pure function of the tinybar price, so a second asset does not
create a second pricing authority — rule 1 still holds with two rails. Rounding is *up*:
a floor would make the token a silent discount for choosing a payment method.

### 3. Settlement is confirmed against the ledger, not against a reply

A facilitator's `{"success": true}` is a claim. The mirror node is the record. Tollgate
confirms the transfer landed, that the payee was credited the full amount, and that the
consensus record matches the transaction it verified — before any data leaves the server.

## What the server does not have

No wallet. No key file. No signing path. A Tollgate deployment can state prices and read
the ledger; it cannot move money. That property is load-bearing for the whole pitch — an
unattended agent-facing endpoint that *can* spend is a liability, and one that cannot is
just a meter.

## Two questions that turned out to be about ordering

Both of these were listed here as open while the service was still local. Neither was hard
arithmetic; both were decided by *where* in the sequence the step goes.

**Replay.** A signed transaction is bearer-ish until it is consumed, so consumed ids are
tracked. The claim is made **after verify passes and before settle**. Claim it later and a
settle that times out leaves the same signed bytes replayable; claim it earlier and a
stranger burns a real buyer's transaction with junk that was never going to verify.

The awkward case is a settle whose outcome is unknown — a timeout may still have landed.
An indeterminate settlement does **not** release the key, because releasing it invites an
honest buyer to pay a second time for the same work. They are told the outcome is
indeterminate and given the transaction id to check themselves, which is worse UX and
better behaviour.

**Rate limiting.** A per-IP token bucket guards the **verification** path only. `/health`
and the unpaid 402 are exempt by design: an honest buyer must always be able to read the
price before paying, and a paywall in front of the price tag breaks the protocol's own
first step. The limit exists because verification costs *us* a facilitator call, and that
quota is keyed to the deployment's IP — so an unauthenticated stranger posting junk
headers could otherwise take the service offline for everyone.
