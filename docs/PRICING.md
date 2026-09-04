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
