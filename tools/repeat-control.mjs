#!/usr/bin/env node
// repeat-control.mjs — the control hermessol named after reading
// page-size-control.mjs: "call the identical thing twice, same page size, and
// diff the bytes."
//
// His argument, which I think is right: varying page size is a control only if
// the suspect is downstream of page size. If the index degrades under load the
// way Blockscout does (L-030), two CONCURRENT pulls degrade together and agree,
// and the agreement is manufactured by the shared degradation. Identical
// multisets is exactly what that failure emits. So the page-size diff cannot
// ask whether the output is a function of the input at all — it assumes it.
//
// Two stages, deliberately ordered cheap-first:
//   A. IDENTICAL SINGLE PAGE, fetched N times SEQUENTIALLY, bytes hashed.
//      Isolates determinism from churn: the calls are seconds apart, so any
//      difference is the server, not the market.
//   B. TWO FULL SEQUENTIAL PULLS at the same page size, ID multiset diffed.
//      Churn is expected here and is reported as a rate, not as a verdict.
//
// usage: node repeat-control.mjs [--reps 4] [--limit 250] [--full]

import { createHash } from 'node:crypto';

const DISCOVERY = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const UA = 'TheAssayer-RepeatControl/1.0 (+https://github.com/thumm110/x402-field-guide; read-only)';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const REPS = Number(flag('--reps', 4));
const LIMIT = Number(flag('--limit', 250));
const FULL = argv.includes('--full');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function page(limit, offset) {
  const res = await fetch(`${DISCOVERY}?limit=${limit}&offset=${offset}`, {
    headers: { accept: 'application/json', 'user-agent': UA },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`discovery ${res.status} at offset ${offset}: ${text.slice(0, 200)}`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`non-JSON at offset ${offset}: ${text.slice(0, 200)}`); }
  // L-030: an error body must never be readable as an empty result.
  if (body.error || body.errorType) throw new Error(`discovery error body: ${text.slice(0, 300)}`);
  const items = body.items || body.resources || body.data || [];
  if (!Array.isArray(items)) throw new Error(`unexpected shape at offset ${offset}: ${Object.keys(body).join(',')}`);
  return { text, items, total: body.total ?? body.pagination?.total ?? null };
}

const idOf = (r) => `${r.resource || r.url || r.name || ''}|${r.network || r.accepts?.[0]?.network || ''}`;

async function stageA() {
  console.log(`\n=== A. identical call x${REPS}, sequential, limit=${LIMIT} offset=0 ===`);
  const runs = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = Date.now();
    const p = await page(LIMIT, 0);
    runs.push({
      i,
      ms: Date.now() - t0,
      bytes: p.text.length,
      bodyHash: sha(p.text),
      idHash: sha(JSON.stringify(p.items.map(idOf))),
      setHash: sha(JSON.stringify([...p.items.map(idOf)].sort())),
      n: p.items.length,
      total: p.total,
    });
    console.log(
      `  rep ${i}: n=${runs[i].n} total=${runs[i].total} bytes=${runs[i].bytes} bodyHash=${runs[i].bodyHash} idOrderHash=${runs[i].idHash} idSetHash=${runs[i].setHash} (${runs[i].ms}ms)`,
    );
    if (i < REPS - 1) await sleep(1500);
  }
  const u = (k) => new Set(runs.map((r) => r[k])).size;
  console.log(`  distinct bodyHash=${u('bodyHash')}  distinct idOrderHash=${u('idHash')}  distinct idSetHash=${u('setHash')}  distinct n=${u('n')}`);
  if (u('setHash') === 1 && u('idHash') === 1) {
    console.log(`  VERDICT: the identical call returns the identical row set, in the identical order, ${REPS}/${REPS} times.`);
    if (u('bodyHash') > 1) console.log('  (bodies differ — a volatile field inside the records, not membership. Inspected below.)');
  } else {
    console.log('  VERDICT: THE OUTPUT IS NOT A FUNCTION OF THE INPUT. Same call, different answer.');
  }
  return runs;
}

async function volatileFields() {
  // Which fields move between two identical calls? Only meaningful if bodies differ.
  const a = await page(LIMIT, 0);
  await sleep(1500);
  const b = await page(LIMIT, 0);
  const byId = new Map(b.items.map((r) => [idOf(r), r]));
  const moved = new Map();
  for (const ra of a.items) {
    const rb = byId.get(idOf(ra));
    if (!rb) continue;
    for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
      const va = JSON.stringify(ra[k]);
      const vb = JSON.stringify(rb[k]);
      if (va !== vb) moved.set(k, (moved.get(k) || 0) + 1);
    }
  }
  console.log(`\n  fields that changed between two identical calls (of ${a.items.length} shared rows):`);
  if (moved.size === 0) console.log('    none — byte-identical membership and content');
  for (const [k, n] of [...moved].sort((x, y) => y[1] - x[1])) console.log(`    ${k}: ${n} rows`);
}

async function fullPull(limit, label) {
  const t0 = Date.now();
  const out = [];
  let total = null;
  for (let offset = 0; ; offset += limit) {
    const p = await page(limit, offset);
    total = p.total ?? total;
    out.push(...p.items);
    if (p.items.length === 0 || p.items.length < limit) break;
    if (offset > 100000) break;
  }
  console.log(`  ${label}: ${out.length} records, server total=${total}, ${Date.now() - t0}ms`);
  return out;
}

async function stageB() {
  console.log(`\n=== B. two FULL pulls, sequential, identical limit=${LIMIT} ===`);
  const a = await fullPull(LIMIT, 'pull 1');
  const b = await fullPull(LIMIT, 'pull 2');
  const sa = new Set(a.map(idOf));
  const sb = new Set(b.map(idOf));
  const onlyA = [...sa].filter((x) => !sb.has(x));
  const onlyB = [...sb].filter((x) => !sa.has(x));
  console.log(`  |A|=${sa.size} |B|=${sb.size}  only-in-1=${onlyA.length}  only-in-2=${onlyB.length}`);
  console.log(`  churn between two back-to-back pulls: ${((onlyA.length + onlyB.length) / sa.size * 100).toFixed(3)}%`);
  for (const x of onlyA.slice(0, 5)) console.log(`    only in pull 1: ${x.slice(0, 90)}`);
  for (const x of onlyB.slice(0, 5)) console.log(`    only in pull 2: ${x.slice(0, 90)}`);
}

async function stageC() {
  // The mechanism hermessol actually proposed: the index degrading under
  // CONCURRENT load the way Blockscout does. Stage A is sequential and therefore
  // low-pressure, so it cannot see this. Fire N identical calls at once and ask
  // whether any of them comes back different, short, or refusing.
  const N = Number(flag('--stress', 12));
  console.log(`\n=== C. ${N} identical calls fired CONCURRENTLY, limit=${LIMIT} offset=0 ===`);
  const results = await Promise.allSettled(Array.from({ length: N }, () => page(LIMIT, 0)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const bad = results.filter((r) => r.status === 'rejected');
  const hashes = new Set(ok.map((p) => sha(p.text)));
  const sizes = new Set(ok.map((p) => p.items.length));
  console.log(`  fulfilled=${ok.length} rejected=${bad.length}`);
  for (const b of bad.slice(0, 5)) console.log(`    rejected: ${String(b.reason?.message).slice(0, 160)}`);
  console.log(`  distinct bodyHash=${hashes.size}  distinct row counts=${[...sizes].join(',')}`);
  if (bad.length === 0 && hashes.size === 1) {
    console.log(`  VERDICT: no degradation under ${N}x concurrency — every response byte-identical to the sequential one: ${hashes.size === 1 && [...hashes][0]}`);
  } else {
    console.log('  VERDICT: the index DOES behave differently under concurrency. The page-size control is compromised exactly as predicted.');
  }
}

const t = Date.now();
await stageA();
await volatileFields();
await stageC();
if (FULL) await stageB();
console.log(`\ndone in ${((Date.now() - t) / 1000).toFixed(1)}s`);
