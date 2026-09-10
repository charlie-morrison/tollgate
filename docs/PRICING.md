# Pricing

Tollgate publishes its schedule. An agent can compute what a request will cost before
making it, and check the quote it is given against the published rule.

All amounts are in **tinybar** (1 HBAR = 100,000,000 tinybar).

| component               |  amount | when                      |
| ----------------------- | ------: | ------------------------- |
| base                    | 200,000 | every request             |
| per record              |  20,000 | per record returned       |
| detail surcharge        |  30,000 | per record, `detail=full` |

```
price = base + records × (perRecord + (detail=full ? detailSurcharge : 0))
```

Worked examples, all pinned by tests in `test/meter.test.mjs`:

| request                    |     price | in HBAR |
| -------------------------- | --------: | ------: |
| `?records=1`               |   220,000 |  0.0022 |
| `?records=3`               |   260,000 |  0.0026 |
| `?records=3&detail=full`   |   350,000 |  0.0035 |
| `?records=100&detail=full` | 5,200,000 |  0.052  |

The server publishes this schedule at runtime (`publishedSchedule()`), and a test asserts
the published rule reproduces the served price for every combination it covers — so an
agent can budget without paying to discover what things cost.

## Two constraints on the numbers

**The base charge must exceed the settlement fee.** If a minimum-size request costs less
to buy than it costs the network to settle, the gateway is underwater on its own floor
and every cheap call is a small loss.

Measured rather than remembered: **129,394 tinybar** median, over 100 successful
`CRYPTOTRANSFER` transactions on Hedera testnet, 2026-09-04, via
`tools/measure-settlement-fee.mjs`. The distribution is tight — min 129,394, max 129,395 —
so the floor is a real floor, not an average hiding a tail.

The smallest billable request (`?records=1`) is therefore 220,000 against a 129,394 cost.
A test asserts that relationship holds rather than trusting the constant to stay correct.

**Rounding never favours the buyer.** Any conversion — tinybar into a token's smallest
unit, a percentage fee, a division — rounds up. A systematic half-unit in the buyer's
favour is a slow leak that no single transaction makes visible.

## Why not per-request flat pricing

It is one line of code and it misprices everything. Under a flat charge the caller
requesting a single record pays for the caller requesting a hundred, so light users leave
and heavy users arbitrage. Metering is the difference between a paywall and a price.

## Paying in an HTS token instead of HBAR

The gateway advertises the same metered request in HBAR **and** in an HTS token
(`X402T`, `0.0.10464963`, 2 decimals) and lets the buyer pick. The token amount is a pure
function of the tinybar price — `units = ceil(tinybarPrice / 1000)` — so there is still
exactly one number deciding what a request costs. Adding an asset must not add a pricing
authority; a second price list would drift from the first and the gateway would quote one
thing and charge another.

The published `tokenSchedule` in every 402 carries the rate and the formula, so an agent
can budget in the token without paying once to discover the conversion.

### The fee has to be EXCLUSIVE, or the token is unusable

The token carries a 2% fractional custom fee to a collector that is **not** the payee.
`net_of_transfers` must be `true` (EXCLUSIVE). An INCLUSIVE fee is taken *out of* the
transfer, so the payee lands short by the fee and the `exact` scheme rejects every single
settlement as underpaid — for every buyer, permanently, with an error that blames the
payer. `src/hts.mjs` refuses such a token by name rather than discovering it at
settlement, and reads the flag off the mirror node rather than trusting our own creation
script.

Verified on-chain (`0.0.7162784@1789069841.459842897`): payee credited **exactly 350**
units — the metered price — collector **+7** (2% fired), buyer debited **357**. The fee
is charged *on top* of the transfer, which is precisely what lets an exact-scheme check
pass.

### Two measurements worth stating plainly

**The token rail costs the facilitator ~10.9× the HBAR rail, not ~275×.** The first token
settlement was charged **69,197,868** tinybar, which is 25× the second one. The
difference is a one-time cost: the payee auto-associated the token on first receipt. The
steady-state figure is **2,789,164** tinybar (`0.0.7162784@1789069896.125269888`) against
**256,292** for a native HBAR transfer. Quoting the first number as the cost of the token
rail would misprice it by an order of magnitude — the same mistake shape as reading a
one-time `CRYPTOCREATEACCOUNT` as per-request economics. Buyer overhead is 0% either way:
the facilitator pays the network fee on both rails.

**The custom fee truncates.** 2% of 240 units is 4.8 and the collector received **4**. It
does not affect correctness here — the payee is still credited exactly the quoted amount,
which is the only thing the `exact` scheme checks — but a fee model that assumes exact
percentages will not reconcile against the ledger.
