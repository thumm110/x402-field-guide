#!/usr/bin/env node
/**
 * top-earners.mjs — "what do machine buyers actually pay for?"
 *
 * The CDP x402 discovery index publishes, on every record,
 * `quality.l30DaysTotalCalls` and `quality.l30DaysUniquePayers` (L-020). The
 * census tool measures a *niche* ceiling. This one answers a different and
 * bigger question: across the whole index, which listings earn real money, and
 * WHAT ARE THEY SELLING?
 *
 * Because that is demand data. 355k paid calls in 30 days went somewhere
 * specific. Reading the top of that distribution tells you what an agent with a
 * wallet is willing to spend on — which is the only input that should drive a
 * build decision.
 *
 * Usage:
 *   node top-earners.mjs              # top 40 by gross, table + category rollup
 *   node top-earners.mjs --top 80
 *   node top-earners.mjs --json out.json
 *
 * Guards borrowed from the census: prices above $100/call are excluded from
 * gross sums (68 listings quote up to $10bn and poison any naive total), and
 * "has >=3 unique payers" is the bar for a real buyer base — the median active
 * listing is one call from one payer, i.e. the seller testing itself.
 */

const DISCOVERY = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const UA = 'PageDistill-Census/1.0 (+https://pagedistill.thumm.workers.dev; x402 Bazaar demand survey; read-only)';
const PAGE = 1000;
const SANE_MAX_USD = 100;

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
const TOP = Number(argOf('--top', 40));
const JSON_OUT = argOf('--json', null);
// --grep: print every listing whose description/resource matches, ranked by
// gross. Answers "is this niche already served, and by whom, for how much?"
// before a single line of product code gets written.
const GREP = argOf('--grep', null);

const calls = (r) => r.quality?.l30DaysTotalCalls ?? 0;
const payers = (r) => r.quality?.l30DaysUniquePayers ?? 0;

// price: the discovery record normalises some fields to the top level but the
// per-scheme price lives in accepts[]. Both `amount` and `maxAmountRequired`
// appear in the wild (we emit the latter; 13,958 of 14,414 emit the former).
function priceUsd(r) {
  const a = r.accepts?.[0];
  if (!a) return null;
  const raw = a.amount ?? a.maxAmountRequired;
  if (raw == null) return null;
  const dec = a.extra?.decimals ?? 6;
  const n = Number(raw) / 10 ** dec;
  return Number.isFinite(n) ? n : null;
}

// A full pull is ~14.6k records and ~40s. Cache it so a build decision can test
// six niches for the price of one download instead of one niche per download —
// the cost of checking is the reason a check gets skipped.
const CACHE = argOf('--cache', null);

async function pull() {
  if (CACHE) {
    const fs = await import('node:fs/promises');
    try {
      const parsed = JSON.parse(await fs.readFile(CACHE, 'utf8'));
      // Tolerate a cache written by another tool as a raw API page ({items:[…]})
      // rather than the flat array this one writes. A cache that silently loads
      // the wrong shape is worse than no cache: it reports "undefined records".
      const raw = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.resources ?? parsed.data);
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('unusable cache shape');
      console.error(`(cache hit: ${CACHE}, ${raw.length} records)`);
      return raw;
    } catch { /* cache miss — fall through and populate below */ }
  }
  const out = await pullLive();
  if (CACHE) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(CACHE, JSON.stringify(out));
    console.error(`(cache written: ${CACHE})`);
  }
  return out;
}

async function pullLive() {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(`${DISCOVERY}?limit=${PAGE}&offset=${offset}`, {
      headers: { accept: 'application/json', 'user-agent': UA },
    });
    if (!res.ok) throw new Error(`discovery ${res.status} at offset ${offset}`);
    const body = await res.json();
    const items = body.items ?? body.resources ?? body.data ?? [];
    out.push(...items);
    process.stderr.write(`  pulled ${out.length}\r`);
    if (items.length < PAGE) break;
    if (offset > 60000) break; // runaway guard
  }
  process.stderr.write('\n');
  return out;
}

const short = (s, n) => {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

const records = await pull();
console.log(`index: ${records.length} records`);

const priced = records.map((r) => {
  const p = priceUsd(r);
  const c = calls(r);
  const sane = p != null && p <= SANE_MAX_USD;
  return {
    resource: r.resource ?? r.accepts?.[0]?.resource ?? '(none)',
    description: r.description ?? r.accepts?.[0]?.description ?? '',
    network: r.accepts?.[0]?.network ?? '',
    priceUsd: p,
    calls: c,
    payers: payers(r),
    grossUsd: sane ? p * c : null,
    priceSane: sane,
  };
});

const totalCalls = priced.reduce((s, r) => s + r.calls, 0);
const totalGross = priced.reduce((s, r) => s + (r.grossUsd ?? 0), 0);
const realBuyers = priced.filter((r) => r.payers >= 3);
console.log(`30d paid calls: ${totalCalls.toLocaleString()}   gross (prices <= $${SANE_MAX_USD}): $${totalGross.toFixed(2)}`);
console.log(`listings with >=3 unique payers: ${realBuyers.length} (${(100 * realBuyers.length / records.length).toFixed(1)}%)`);

// --- the point of the tool: rank by gross, print what they sell -------------
const ranked = priced
  .filter((r) => r.grossUsd != null && r.payers >= 3)
  .sort((a, b) => b.grossUsd - a.grossUsd)
  .slice(0, TOP);

console.log(`\n=== top ${ranked.length} listings by 30d gross, with >=3 real payers ===`);
console.log('  # | gross/30d |  price | calls  | payers | what it sells');
ranked.forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(3)} | ${('$' + r.grossUsd.toFixed(2)).padStart(9)} | ` +
    `${('$' + r.priceUsd.toFixed(4)).padStart(6)} | ${String(r.calls).padStart(6)} | ` +
    `${String(r.payers).padStart(6)} | ${short(r.description || r.resource, 88)}`
  );
});

// how much of the whole market sits above metabolism?
for (const bar of [10, 30, 60, 100, 300]) {
  const n = priced.filter((r) => (r.grossUsd ?? 0) >= bar && r.payers >= 3).length;
  console.log(`listings grossing >= $${bar}/30d with >=3 payers: ${n}`);
}

if (GREP) {
  const re = new RegExp(GREP, 'i');
  const hits = priced
    .filter((r) => re.test(r.description) || re.test(r.resource))
    .sort((a, b) => (b.grossUsd ?? 0) - (a.grossUsd ?? 0));
  const ceiling = hits.length ? (hits[0].grossUsd ?? 0) : 0;
  console.log(`\n=== grep /${GREP}/i : ${hits.length} listings ===`);
  console.log(`CEILING (best single listing): $${ceiling.toFixed(2)} / 30 days`);
  hits.slice(0, 30).forEach((r) => {
    console.log(
      `  ${('$' + (r.grossUsd ?? 0).toFixed(2)).padStart(9)} | ${('$' + (r.priceUsd ?? 0).toFixed(4)).padStart(8)} | ` +
      `${String(r.calls).padStart(6)}c ${String(r.payers).padStart(4)}p | ${r.network.padEnd(12)} | ${short(r.description || r.resource, 76)}`
    );
  });
  if (hits.length > 30) console.log(`  … ${hits.length - 30} more`);
}

if (JSON_OUT) {
  const fs = await import('node:fs/promises');
  await fs.writeFile(JSON_OUT, JSON.stringify({ totalCalls, totalGross, ranked }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
