#!/usr/bin/env node
/**
 * bazaar-census.mjs — measure REVEALED DEMAND in the x402 CDP Bazaar.
 *
 * The point of this tool. Every record in the public discovery index carries a
 * `quality` block:
 *
 *     "quality": { "l30DaysTotalCalls": 576, "l30DaysUniquePayers": 27, ... }
 *
 * That is per-competitor paid-call telemetry — how many times each listing was
 * actually bought in the last 30 days, and by how many distinct wallets. It is
 * free, anonymous, and index-wide. MERCURY operated for days on the premise that
 * a terminal-bound agent can observe supply but never demand (see the harness
 * contract). For this market that premise is false: demand is published, and
 * `--niche` below turns it into a revenue ceiling for any category you can name.
 *
 * Read the numbers with two traps in mind, both of which produce wildly wrong
 * conclusions if ignored:
 *
 *   1. "Has >=1 paid call" is meaningless — 98.5% of listings clear it and the
 *      median active listing has exactly ONE call from ONE payer. That is the
 *      seller testing their own endpoint, which is what PageDistill's own record
 *      looks like. Use >=3 unique payers as the bar for "someone else is buying."
 *   2. Gross revenue must exclude absurd prices. A handful of listings quote
 *      $10,000,000,000; summing naively yields $350bn instead of the real ~$7.8k.
 *
 * Also answers two structural questions:
 *   - How many distinct SELLERS, vs. listings? (One seller with 777 endpoints is
 *     one competitor, not 777.)
 *   - How many listings are ALIVE? An unpaid GET should return 402; anything else
 *     is a listing no buying agent can transact with.
 *
 * The liveness probe sends one unauthenticated GET per sampled resource — the same
 * request any buying agent makes before deciding to pay. It moves no money, costs
 * the operator nothing, and identifies itself in the User-Agent.
 *
 * Usage:
 *   node tools/bazaar-census.mjs                      # index + demand stats
 *   node tools/bazaar-census.mjs --niche "markdown|scrape|extract"
 *   node tools/bazaar-census.mjs --probe 200          # + liveness probe
 *   node tools/bazaar-census.mjs --json out.json
 *
 * Requires Node 22+ (global fetch, AbortSignal.timeout).
 */

const DISCOVERY = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const UA = 'PageDistill-Census/1.0 (+https://pagedistill.thumm.workers.dev; x402 Bazaar liveness survey; one unpaid GET per listing)';
const PAGE = 1000;
const PROBE_CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 6000;

const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i === -1 ? dflt : argv[i + 1];
};
const PROBE_N = Number(argOf('--probe', 0)) || 0;
const JSON_OUT = argOf('--json', null);
const NICHE = argOf('--niche', null);

/** Paid calls and distinct paying wallets over the trailing 30 days, per listing. */
const callsOf = (r) => r.quality?.l30DaysTotalCalls ?? 0;
const payersOf = (r) => r.quality?.l30DaysUniquePayers ?? 0;

/** Prices above this are quote errors or spam, not offers; they wreck any sum. */
const SANE_MAX_USD = 5;
/** Below this many distinct payers, a listing is indistinguishable from a self-test. */
const REAL_BUYER_BAR = 3;

/** Pull every page of the discovery index. Never characterise it from page one (L-018). */
async function fetchAll() {
  const items = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const res = await fetch(`${DISCOVERY}?limit=${PAGE}&offset=${offset}`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`discovery ${res.status} at offset ${offset}`);
    const body = await res.json();
    const page = body.items ?? [];
    total = body.pagination?.total ?? page.length;
    items.push(...page);
    if (page.length === 0) break;
    offset += page.length;
    process.stderr.write(`\r  fetched ${items.length}/${total}`);
  }
  process.stderr.write('\n');
  return { items, total };
}

/** USDC and most x402 assets are 6-decimal. Returns dollars, or null if unparseable. */
function priceUsd(accept) {
  const raw = accept?.amount ?? accept?.maxAmountRequired;
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n / 1e6;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/** Normalise the two spellings of the same chain that the index carries side by side. */
function netName(n) {
  const map = {
    'eip155:8453': 'base',
    'eip155:84532': 'base-sepolia',
    'base': 'base',
    'base-sepolia': 'base-sepolia',
  };
  return map[n] ?? n ?? 'unknown';
}

function describe(items) {
  const stat = {
    listings: items.length,
    described: 0,
    describedInAccepts: 0,
    withInputSchema: 0,
    networks: {},
    sellers: new Set(),
    hosts: new Set(),
    prices: [],
    freeListings: 0,
  };
  for (const r of items) {
    const a = r.accepts?.[0];
    // Two different field paths carry the description, and picking the wrong one
    // is how cycle 4 concluded "only 8.9% are described" (L-018, since refuted).
    // The discovery API normalises metadata to the TOP level; accepts[0] carries
    // it for a minority, and that minority is a strict subset of the top-level set.
    if (r.description && String(r.description).trim()) stat.described++;
    if (a?.description && String(a.description).trim()) stat.describedInAccepts++;
    const info = r.extensions?.bazaar?.info ?? r.outputSchema?.input ?? null;
    const hasInput = !!(info?.queryParams || info?.body || r.extensions?.bazaar?.schema?.properties?.input);
    if (hasInput) stat.withInputSchema++;
    const net = netName(a?.network);
    stat.networks[net] = (stat.networks[net] ?? 0) + 1;
    if (a?.payTo) stat.sellers.add(String(a.payTo).toLowerCase());
    const h = hostOf(r.resource);
    if (h) stat.hosts.add(h);
    const p = priceUsd(a);
    if (p != null) { stat.prices.push(p); if (p === 0) stat.freeListings++; }
  }
  return stat;
}

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * One unpaid GET. Classification:
 *   gated  — 402, the correct answer: alive and transactable
 *   open   — 2xx without payment, i.e. the paywall is not enforced at this URL
 *   error  — reachable but 4xx/5xx: alive host, listing points somewhere wrong
 *   dead   — DNS failure, TLS failure, connection refused, or timeout
 */
async function probe(resource) {
  const t0 = Date.now();
  try {
    const res = await fetch(resource, {
      method: 'GET',
      headers: { 'user-agent': UA, accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (res.status === 402) return { klass: 'gated', status: 402, ms };
    if (res.ok) return { klass: 'open', status: res.status, ms };
    return { klass: 'error', status: res.status, ms };
  } catch (err) {
    return { klass: 'dead', status: null, ms: Date.now() - t0, why: String(err.name || err) };
  }
}

async function probeAll(resources) {
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < resources.length) {
      const idx = i++;
      const r = resources[idx];
      out[idx] = { resource: r.resource, ...(await probe(r.resource)) };
      if (out.filter(Boolean).length % 20 === 0) {
        process.stderr.write(`\r  probed ${out.filter(Boolean).length}/${resources.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  process.stderr.write('\n');
  return out;
}

/** Deterministic spread across the list — no RNG, so a re-run is comparable. */
function sample(items, n) {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, k) => items[Math.floor(k * step)]);
}

// ---------------------------------------------------------------- main

console.error('Fetching the full CDP Bazaar index...');
const { items, total } = await fetchAll();
if (items.length !== total) {
  console.error(`WARNING: fetched ${items.length} but index reports ${total}`);
}

const all = describe(items);
const mainnet = items.filter((r) => netName(r.accepts?.[0]?.network) === 'base');
const mainStat = describe(mainnet);

const report = {
  fetchedListings: items.length,
  indexTotal: total,
  distinctSellers: all.sellers.size,
  distinctHosts: all.hosts.size,
  listingsPerSeller: +(items.length / Math.max(all.sellers.size, 1)).toFixed(1),
  describedPct: +((all.described / items.length) * 100).toFixed(1),
  inputSchemaPct: +((all.withInputSchema / items.length) * 100).toFixed(1),
  networks: all.networks,
  priceMedianUsd: median(all.prices),
  priceMinUsd: all.prices.length ? Math.min(...all.prices) : null,
  priceMaxUsd: all.prices.length ? Math.max(...all.prices) : null,
  freeListings: all.freeListings,
  mainnet: {
    listings: mainnet.length,
    distinctSellers: mainStat.sellers.size,
    distinctHosts: mainStat.hosts.size,
    describedPct: +((mainStat.described / Math.max(mainnet.length, 1)) * 100).toFixed(1),
    priceMedianUsd: median(mainStat.prices),
  },
};

console.log('\n=== x402 CDP Bazaar census ===');
console.log(`listings                 ${report.fetchedListings} (index says ${report.indexTotal})`);
console.log(`distinct sellers (payTo) ${report.distinctSellers}  -> ${report.listingsPerSeller} listings/seller`);
console.log(`distinct hosts           ${report.distinctHosts}`);
console.log(`with a description       ${all.described} (${pct(all.described, items.length)})`);
console.log(`with an input schema     ${all.withInputSchema} (${pct(all.withInputSchema, items.length)})`);
console.log(`price  median $${report.priceMedianUsd}  min $${report.priceMinUsd}  max $${report.priceMaxUsd}  free ${report.freeListings}`);
console.log('networks:', report.networks);
console.log(`mainnet(base): ${report.mainnet.listings} listings from ${report.mainnet.distinctSellers} sellers on ${report.mainnet.distinctHosts} hosts, median $${report.mainnet.priceMedianUsd}`);

// Top sellers by listing count — concentration is the story the raw total hides.
const byseller = {};
for (const r of items) {
  const s = String(r.accepts?.[0]?.payTo ?? 'unknown').toLowerCase();
  byseller[s] = (byseller[s] ?? 0) + 1;
}
const top = Object.entries(byseller).sort((a, b) => b[1] - a[1]).slice(0, 10);
const topShare = top.reduce((n, [, c]) => n + c, 0);
console.log(`\ntop 10 sellers hold ${topShare} listings (${pct(topShare, items.length)} of the index):`);
for (const [s, c] of top) console.log(`  ${s.slice(0, 14)}…  ${c}`);
report.topSellers = top.map(([addr, count]) => ({ addr, count }));
report.top10SellerShare = +((topShare / items.length) * 100).toFixed(1);

// ------------------------------------------------------------ revealed demand

console.log(`\nmetadata (why L-018 was wrong):`);
console.log(`  top-level description   ${all.described} (${pct(all.described, items.length)})   <- what a buyer reads`);
console.log(`  accepts[0].description  ${all.describedInAccepts} (${pct(all.describedInAccepts, items.length)})   <- what bazaar-check.mjs read`);

const totalCalls = items.reduce((s, r) => s + callsOf(r), 0);
const sane = items.filter((r) => { const p = priceUsd(r.accepts?.[0]); return p != null && p > 0 && p <= SANE_MAX_USD; });
const grossUsd = sane.reduce((s, r) => s + callsOf(r) * priceUsd(r.accepts?.[0]), 0);
const buyerBars = {};
for (const k of [1, 2, 3, 5, 10, 25, 50]) buyerBars[k] = items.filter((r) => payersOf(r) >= k).length;

console.log(`\n=== revealed demand, trailing 30 days ===`);
console.log(`total paid calls across the whole index   ${totalCalls}`);
console.log(`gross revenue, prices <= $${SANE_MAX_USD}            $${grossUsd.toFixed(2)}   (${items.length - sane.length} listings excluded as unpriced/absurd)`);
console.log(`listings by distinct paying wallets:`);
for (const k of [1, 2, 3, 5, 10, 25, 50]) {
  const flag = k === REAL_BUYER_BAR ? '  <- real-buyer bar' : k === 1 ? '  <- meaningless: mostly self-tests' : '';
  console.log(`  >= ${String(k).padStart(2)} payers  ${String(buyerBars[k]).padStart(5)}  ${pct(buyerBars[k], items.length).padStart(6)}${flag}`);
}
const earners = sane.map((r) => callsOf(r) * priceUsd(r.accepts?.[0]));
console.log(`listings grossing >$10/30d: ${earners.filter((g) => g > 10).length}  |  >$1: ${earners.filter((g) => g > 1).length}`);

const byCalls = [...items].sort((a, b) => callsOf(b) - callsOf(a));
console.log(`\ntop 8 listings by paid calls:`);
for (const r of byCalls.slice(0, 8)) {
  const p = priceUsd(r.accepts?.[0]) ?? 0;
  console.log(`  ${String(callsOf(r)).padStart(6)}c ${String(payersOf(r)).padStart(4)}p $${p.toFixed(4).padStart(8)} ~$${(callsOf(r) * p).toFixed(2).padStart(7)}/30d | ${(r.description || '').slice(0, 50)}`);
}

report.demand = {
  totalPaidCalls30d: totalCalls,
  grossUsd30d: +grossUsd.toFixed(2),
  listingsByPayerBar: buyerBars,
  realBuyerListings: buyerBars[REAL_BUYER_BAR],
  over10UsdPerMonth: earners.filter((g) => g > 10).length,
};

/**
 * The question worth asking before building anything: what does the BEST listing
 * in this niche actually earn? Not whether the niche exists — whether it pays.
 */
if (NICHE) {
  const re = new RegExp(NICHE, 'i');
  const hits = items.filter((r) => re.test(r.description || '') || re.test(r.resource || ''));
  const real = hits.filter((r) => payersOf(r) >= REAL_BUYER_BAR).sort((a, b) => payersOf(b) - payersOf(a));
  const gross = (r) => callsOf(r) * (priceUsd(r.accepts?.[0]) ?? 0);
  const ceiling = real.length ? Math.max(...real.map(gross)) : 0;
  console.log(`\n=== niche: /${NICHE}/i ===`);
  console.log(`matching listings ${hits.length}  |  with >= ${REAL_BUYER_BAR} real payers ${real.length}`);
  console.log(`BEST listing in this niche grosses ~$${ceiling.toFixed(2)} / 30 days  <-- the ceiling, not the average`);
  for (const r of real.slice(0, 10)) {
    console.log(`  ${String(payersOf(r)).padStart(3)}p ${String(callsOf(r)).padStart(5)}c $${(priceUsd(r.accepts?.[0]) ?? 0).toFixed(4).padStart(7)} ~$${gross(r).toFixed(2).padStart(7)}/30d | ${(r.description || '').slice(0, 46)}`);
  }
  const prices = real.map((r) => priceUsd(r.accepts?.[0])).filter((p) => p > 0).sort((a, b) => a - b);
  if (prices.length) console.log(`  going rate: min $${prices[0]}  median $${prices[Math.floor(prices.length / 2)]}  max $${prices[prices.length - 1]}`);
  report.niche = { pattern: NICHE, matching: hits.length, withRealBuyers: real.length, ceilingUsd30d: +ceiling.toFixed(2) };
}

// Our own listing, for comparison against everything above.
const ours = items.find((r) => /pagedistill/i.test(r.resource || ''));
if (ours) {
  console.log(`\n=== PageDistill's own record ===`);
  console.log(`  network ${netName(ours.accepts?.[0]?.network)}  price $${(priceUsd(ours.accepts?.[0]) ?? 0).toFixed(4)}  calls ${callsOf(ours)}  payers ${payersOf(ours)}`);
  console.log(`  price field: ${ours.accepts?.[0]?.amount != null ? 'amount' : 'maxAmountRequired'} (index-wide: ${items.filter((r) => r.accepts?.[0]?.amount != null).length} use "amount")`);
  report.ours = { calls30d: callsOf(ours), payers30d: payersOf(ours), lastCalledAt: ours.quality?.lastCalledAt ?? null };
}

if (PROBE_N > 0) {
  const live = sample(mainnet, PROBE_N);
  console.error(`\nProbing ${live.length} mainnet listings (one unpaid GET each)...`);
  const results = await probeAll(live);
  const tally = { gated: 0, open: 0, error: 0, dead: 0 };
  for (const r of results) tally[r.klass]++;
  console.log(`\n=== liveness, ${results.length} mainnet listings sampled ===`);
  for (const k of ['gated', 'open', 'error', 'dead']) {
    console.log(`  ${k.padEnd(6)} ${String(tally[k]).padStart(4)}  ${pct(tally[k], results.length)}`);
  }
  const transactable = tally.gated;
  console.log(`\n  transactable (returns a 402 challenge): ${pct(transactable, results.length)}`);
  report.liveness = { sampled: results.length, ...tally, transactablePct: +((transactable / results.length) * 100).toFixed(1) };
  report.livenessDetail = results;
}

if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
