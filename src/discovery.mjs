/**
 * A discovery document, so other agents can find this service without being told about it.
 *
 * x402 v2 established `/.well-known/x402` as the place a payable service describes itself:
 * what it sells, what it costs, and in which assets. A directory crawls it; an agent reads
 * it and decides whether to spend. This module builds that document.
 *
 * Two things make it more than a JSON dump, and both are about not lying to a reader who
 * has no way to check:
 *
 *   1. QUALITY IS NOT OURS TO REPORT. The published listing schema carries a `quality`
 *      block — 30-day call counts, unique payers, last-called timestamp. Those are
 *      *facilitator-observed* numbers. A service that fills them in itself is publishing
 *      its own reputation, and a reputation the subject writes is an advertisement. We
 *      emit no `quality` key at all, and a test asserts it can never appear. Let whoever
 *      settles our payments count them.
 *
 *   2. A METERED SERVICE HAS NO FLAT PRICE. The schema's `accepts[].amount` is a single
 *      number, which suits a fixed-price endpoint and actively misleads for this one: our
 *      price depends on the work requested. Advertising one number as *the* price would
 *      contradict the entire pitch. So the amount published is the honest price of the
 *      exact `resource` URL published beside it — the bare `/query`, whose defaults make
 *      it the cheapest real request — and the schedule that produces every other price
 *      travels with it in `extensions`, clearly labelled. An agent can therefore budget
 *      any request from the document, and the one price it sees is true rather than
 *      representative.
 *
 * The offers themselves are not built here. They are handed in by the caller, which
 * passes the same `candidateRequirements()` the verification path uses, so the document
 * cannot drift from what the server will actually accept. Discovery is a view of the
 * offers, never a second opinion about them.
 */

import { X402_VERSION } from './challenge.mjs';
import { MIRROR_TESTNET } from './mirror.mjs';

/** Where the document lives. Fixed by convention, not configurable. */
export const DISCOVERY_PATH = '/.well-known/x402';

/**
 * The request the published price refers to.
 *
 * A bare `/query` — the meter's defaults are `records=1, detail=summary`, so this path is
 * a real, servable, cheapest-case request rather than a hypothetical one. If those
 * defaults ever change, the crossing test in the handler suite fails rather than the
 * document quietly starting to misquote.
 */
export const REFERENCE_RESOURCE_PATH = '/query';

/** Only these fields belong in a directory listing's offer. */
function toListedOffer(offer) {
  const listed = {
    scheme: offer.scheme,
    network: offer.network,
    amount: offer.amount ?? offer.maxAmountRequired,
    asset: offer.asset,
    payTo: offer.payTo,
    maxTimeoutSeconds: offer.maxTimeoutSeconds ?? 120,
  };
  // The facilitator's account is not optional trivia: a client that does not copy it into
  // its payment requirements has its settlement refused, and cannot guess it.
  if (offer.extra?.feePayer) listed.extra = { feePayer: offer.extra.feePayer };
  return listed;
}

/**
 * Build the document served at `/.well-known/x402`.
 *
 * @param {object} args
 * @param {object} args.config      server config (payTo, facilitator, receipts, token)
 * @param {string} args.origin      absolute origin this service is reachable at
 * @param {Array<object>} args.offers  server-authored requirements for the reference request
 * @param {() => Date} [args.now]
 */
export function buildDiscoveryDocument({ config, origin, offers, now = () => new Date() }) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('config required');
  }
  if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/.test(origin)) {
    // A relative or malformed origin produces a resource URL nobody can call, which is
    // worse than no listing: a directory would index an address that does not resolve.
    throw new TypeError(`origin must be an absolute http(s) origin, got ${JSON.stringify(origin)}`);
  }
  if (!Array.isArray(offers) || offers.length === 0) {
    throw new TypeError('at least one offer required; a listing with no price is not a listing');
  }

  const resource = `${origin}${REFERENCE_RESOURCE_PATH}`;

  const extensions = {
    metered: {
      note:
        'this service is metered: the amount above is the true price of the exact resource ' +
        'URL above, not a flat rate. Every other price follows from the schedule below, ' +
        'and the authoritative quote for any request is the 402 that request returns.',
      schedule: config.schedule ?? null,
      priceVariesWith: ['records', 'detail'],
      quoteEndpoint: `${origin}${REFERENCE_RESOURCE_PATH}`,
    },
  };

  if (config.tokenSchedule) {
    extensions.metered.tokenSchedule = config.tokenSchedule;
  }

  // An audit trail is only worth advertising if a stranger can read it without us.
  if (config.receipts?.topicId) {
    extensions.receipts = {
      protocol: 'hcs',
      schema: 'x402.receipt.v1',
      topicId: config.receipts.topicId,
      readableBy: 'anyone',
      verifyItYourself:
        `${MIRROR_TESTNET}/api/v1/topics/${config.receipts.topicId}/messages?limit=25&order=desc`,
    };
  }

  return {
    x402Version: X402_VERSION,
    items: [
      {
        resource,
        description:
          'Metered pay-per-unit access to Hedera account activity, settled on Hedera ' +
          'over x402. Priced per record requested; no API key, signup or subscription.',
        type: 'http',
        x402Version: X402_VERSION,
        lastUpdated: now().toISOString(),
        accepts: offers.map(toListedOffer),
        serviceName: 'Tollgate',
        tags: ['hedera', 'x402', 'metered', 'agent-tools', 'mirror-node'],
        extensions,
      },
    ],
  };
}
