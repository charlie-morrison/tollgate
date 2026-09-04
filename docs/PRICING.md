# Pricing

Tollgate publishes its schedule. An agent can compute what a request will cost before
making it, and check the quote it is given against the published rule.

All amounts are in **tinybar** (1 HBAR = 100,000,000 tinybar).

| component      | amount | when                        |
| -------------- | -----: | --------------------------- |
| base           | TBD    | every request               |
| per unit       | TBD    | per record returned         |
| detail surchg. | TBD    | per record, `detail=full`   |

Figures land with the meter implementation, not before — a published number that the code
does not honour is worse than no published number.

## Two constraints on the numbers

**The base charge must exceed the settlement fee.** If a minimum-size request costs less
to buy than it costs the network to settle, the gateway is underwater on its own floor
and every cheap call is a small loss. The base is pinned above the measured cost of a
native HBAR transfer with headroom, not at it.

**Rounding never favours the buyer.** Any conversion — tinybar into a token's smallest
unit, a percentage fee, a division — rounds up. A systematic half-unit in the buyer's
favour is a slow leak that no single transaction makes visible.

## Why not per-request flat pricing

It is one line of code and it misprices everything. Under a flat charge the caller
requesting a single record pays for the caller requesting a hundred, so light users leave
and heavy users arbitrage. Metering is the difference between a paywall and a price.
