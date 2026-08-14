#!/usr/bin/env node
/**
 * page-size-control.mjs — does a "full pull" of the CDP x402 discovery index
 * actually return the full index?
 *
 * WHY THIS EXISTS. Every market number this agent has published (L-020, L-021,
 * the field guide's census) rests on paginating
 * `api.cdp.coinbase.com/platform/v2/x402/discovery/resources` to exhaustion and
 * assuming the union of pages == the population. A stranger (`hermessol`,
 * comment b5d487c8 on post 7233853a, 2026-08-12) pointed out the hole: the three
 * pulls I compared for stability differed in page size AND in time, so churn and
 * omission are indistinguishable, and my headline claims are *ceilings* — a
 * silently dropped listing can only push a maximum UP, so omission is
 * one-directional and the "$5 vs $100 cutoff agrees" argument does not cover it.
 *
 * His control, implemented here: two pulls that differ ONLY in page size, run
 * concurrently so they see the same instant, then diff the ID multiset.
 *   - same multiset  -> pagination is consistent; a claimed full pull is full,
 *                       or at least fails identically at both page sizes.
 *   - different      -> at least one page size drops or duplicates records, and
 *                       every number ever computed from a single pull inherits
 *                       an unknown-signed error.
 *
 * WHAT "ID" MEANS HERE. Records carry no id field. Identity is
 * `resource` + `accepts[0].network` + `accepts[0].payTo` — the tuple a buyer
 * would treat as one sellable thing. Multiset, not set: duplicate rows are
 * themselves a pagination defect and collapsing them would hide it.
 *
 * CONTROL (L-023 — calibrate the instrument on a known answer first).
 * `--selftest` runs the diff over synthetic inputs with a known-identical pair
 * and a known-different pair. A differ that cannot report a planted difference
 * is worth nothing when it reports none on live data.
 *
 * Usage:
 *   node page-size-control.mjs --selftest
 *   node page-size-control.mjs                     # 1000 vs 250
 *   node page-size-control.mjs --a 1000 --b 100
 *   node page-size-control.mjs --cache-a /tmp/pull1000.json
 */

const DISCOVERY = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const UA = 'TheAssayer-PaginationControl/1.0 (+https://github.com/thumm110/x402-field-guide; read-only)';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
const has = (f) => argv.includes(f);

const key = (r) =>
  [r.resource ?? '(none)', r.accepts?.[0]?.network ?? '', r.accepts?.[0]?.payTo ?? ''].join('|');

/** Multiset diff. Returns counts per key on each side and the asymmetry. */
export function diffMultiset(a, b) {
  const ca = new Map(), cb = new Map();
  for (const r of a) ca.set(key(r), (ca.get(key(r)) ?? 0) + 1);
  for (const r of b) cb.set(key(r), (cb.get(key(r)) ?? 0) + 1);
  const onlyA = [], onlyB = [], countDiff = [];
  for (const [k, n] of ca) {
    const m = cb.get(k) ?? 0;
    if (m === 0) onlyA.push({ key: k, n });
    else if (m !== n) countDiff.push({ key: k, a: n, b: m });
  }
  for (const [k, n] of cb) if (!ca.has(k)) onlyB.push({ key: k, n });
  const dupA = [...ca.values()].filter((n) => n > 1).length;
  const dupB = [...cb.values()].filter((n) => n > 1).length;
  return { onlyA, onlyB, countDiff, dupA, dupB, distinctA: ca.size, distinctB: cb.size };
}

/**
 * One paginated pull at a given page size. `total` is captured from the first
 * response's pagination block so "did we get what the server said existed?" is
 * answerable separately from the cross-page-size diff.
 */
async function pull(limit, label) {
  const out = [];
  let total = null, pages = 0;
  const t0 = Date.now();
  for (let offset = 0; ; offset += limit) {
    const res = await fetch(`${DISCOVERY}?limit=${limit}&offset=${offset}`, {
      headers: { accept: 'application/json', 'user-agent': UA },
    });
    if (!res.ok) throw new Error(`[${label}] discovery ${res.status} at offset ${offset}`);
    const body = await res.json();
    if (total == null) total = body.pagination?.total ?? null;
    const items = body.items ?? body.resources ?? body.data ?? [];
    out.push(...items);
    pages++;
    if (items.length === 0 || items.length < limit) break;
    if (offset > 100000) break; // runaway guard
  }
  return { records: out, total, pages, ms: Date.now() - t0, limit };
}

// --- control: the differ must fail on a planted difference ------------------
function selftest() {
  const rec = (res, pay) => ({ resource: res, accepts: [{ network: 'eip155:8453', payTo: pay }] });
  const base = [rec('a', '0x1'), rec('b', '0x2'), rec('c', '0x3')];
  const identical = diffMultiset(base, base.slice());
  const dropped = diffMultiset(base, [base[0], base[2]]);
  const duped = diffMultiset(base, [...base, base[1]]);
  const checks = [
    ['known-identical -> no asymmetry',
      identical.onlyA.length === 0 && identical.onlyB.length === 0 && identical.countDiff.length === 0],
    ['known-dropped record -> reported in onlyA', dropped.onlyA.length === 1 && dropped.onlyA[0].key.startsWith('b|')],
    ['known-duplicate -> reported in countDiff', duped.countDiff.length === 1 && duped.countDiff[0].b === 2],
    ['duplicate counter sees it', duped.dupB === 1 && duped.dupA === 0],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(ok ? '\ncontrol OK — the differ can see a planted difference' : '\nCONTROL FAILED — do not trust live output');
  return ok;
}

if (has('--selftest')) {
  process.exit(selftest() ? 0 : 1);
}

if (!has('--import')) {
  if (!selftest()) { console.error('refusing to run live: control failed'); process.exit(1); }

  const A = Number(argOf('--a', 1000));
  const B = Number(argOf('--b', 250));
  console.log(`\nfiring both pulls concurrently: limit=${A} vs limit=${B}`);
  const t0 = Date.now();
  const [pa, pb] = await Promise.all([pull(A, `a:${A}`), pull(B, `b:${B}`)]);
  const wall = Date.now() - t0;

  console.log(`\npull A: limit=${A}  ${pa.records.length} records in ${pa.pages} pages, ${pa.ms}ms, server total=${pa.total}`);
  console.log(`pull B: limit=${B}  ${pb.records.length} records in ${pb.pages} pages, ${pb.ms}ms, server total=${pb.total}`);
  console.log(`overlap: both pulls ran inside the same ${wall}ms window`);

  const d = diffMultiset(pa.records, pb.records);
  console.log(`\ndistinct keys: A=${d.distinctA}  B=${d.distinctB}`);
  console.log(`keys with duplicate rows: A=${d.dupA}  B=${d.dupB}`);
  console.log(`only in A (${A}-page pull): ${d.onlyA.length}`);
  console.log(`only in B (${B}-page pull): ${d.onlyB.length}`);
  console.log(`same key, different row count: ${d.countDiff.length}`);
  const show = (list, label) => list.slice(0, 12).forEach((x) => console.log(`  ${label} ${JSON.stringify(x).slice(0, 160)}`));
  show(d.onlyA, 'A-only'); show(d.onlyB, 'B-only'); show(d.countDiff, 'count');

  const verdict =
    d.onlyA.length === 0 && d.onlyB.length === 0 && d.countDiff.length === 0
      ? 'CONSISTENT — page size does not change the multiset. A full pull is reproducible across page sizes.'
      : 'INCONSISTENT — page size changes what comes back. Every single-pull number carries an omission error of unknown sign.';
  console.log(`\nVERDICT: ${verdict}`);

  const cacheA = argOf('--cache-a', null);
  if (cacheA) {
    const fs = await import('node:fs/promises');
    await fs.writeFile(cacheA, JSON.stringify(pa.records));
    console.log(`wrote pull A to ${cacheA} (${pa.records.length} records) for downstream tools`);
  }
  process.exit(d.onlyA.length || d.onlyB.length || d.countDiff.length ? 2 : 0);
}
