#!/usr/bin/env node
/**
 * onchain-reconcile.mjs — is the x402 Bazaar's self-reported revenue real?
 *
 * WHY THIS EXISTS. Every market number this agent has published (L-020, L-021,
 * the field guide) is computed as `price × quality.l30DaysTotalCalls`, all four
 * fields coming from ONE source: Coinbase's CDP discovery index. `hermessol`
 * (comment b5d487c8 on post 7233853a, 2026-08-12) named the flaw exactly: calls,
 * payers and price are one witness wearing three logos, so their agreement
 * proves nothing. He also named the fix, and it is unusually cheap here — these
 * are on-chain settlements. USDC on Base is a public ledger, so index-claimed
 * revenue has an independent counterpart: actual ERC-20 transfers into each
 * listing's `payTo`.
 *
 * Different operator (the chain vs Coinbase's indexer), different failure modes,
 * and capable of disagreeing. Until this runs, the honest label on every gross
 * figure is not "measured" but "as reported by the index."
 *
 * WHAT IT MEASURES. x402's `exact` scheme settles with EIP-3009
 * `transferWithAuthorization`, which emits a standard ERC-20
 * `Transfer(from=payer, to=payTo)`. So for each `payTo`:
 *   - transfer COUNT   is an independent counterpart to l30DaysTotalCalls
 *   - transfer SUM     is an independent counterpart to price × calls
 *   - distinct SENDERS is an independent counterpart to l30DaysUniquePayers
 *
 * Unit of comparison is the ADDRESS, not the listing: several top listings share
 * one payTo (0x325bdF… collects for four of the top eleven), so per-listing
 * comparison would double-count the chain side. Claimed figures are summed per
 * address before comparing.
 *
 * KNOWN CONFOUNDS, stated up front because they set which direction a mismatch
 * is informative in:
 *   - An address may receive USDC for things other than x402 (payroll, other
 *     products, transfers between the operator's own wallets). So on-chain HIGH
 *     is weak evidence — it can be someone else's money.
 *   - An address may settle through escrow/authorizer contracts (some records
 *     carry `extra.receiverAuthorizer` and `withdrawDelay`), in which case the
 *     per-call transfer lands somewhere else and payTo shows nothing.
 *   - Sampling: high-volume addresses are measured over K windows of ~10k
 *     blocks, not the full 30 days (the public RPC caps eth_getLogs at a 10,000
 *     block range, and 30 days is ~1.3M blocks). Extrapolation assumes traffic
 *     is roughly stationary; the per-window spread is printed so you can see
 *     when it isn't.
 * So the claim this tool can support is one-directional: on-chain FAR BELOW
 * claimed is evidence the index over-reports (or that the money never touches
 * payTo). On-chain above claimed proves nothing about the index.
 *
 * CONTROLS (L-023 — calibrate the instrument against a known answer first):
 *   1. known-negative: an address with no USDC history must return 0 transfers.
 *   2. known-positive: PageDistill's own payTo, where the ground truth is in
 *      this repo's ledger — exactly ONE mainnet payment, $0.01, tx 0x835c320c…
 *      (REQ-001/002 owner notes). The exhaustive path must find it.
 *   3. cross-path: for one mid-volume address, count the same block range twice
 *      by two independent providers (Base RPC eth_getLogs and Blockscout's
 *      token-transfer API). Disagreement means the numbers below are unreadable.
 * A run whose controls fail exits non-zero and prints nothing else, because a
 * clean-looking table from an uncalibrated probe is how L-018 happened.
 *
 * Usage:
 *   node onchain-reconcile.mjs --cache /tmp/pull1000.json          # top 12 addresses
 *   node onchain-reconcile.mjs --cache /tmp/pull1000.json --top 20 --windows 4
 *   node onchain-reconcile.mjs --controls-only
 */

const RPC = process.env.BASE_RPC ?? 'https://mainnet.base.org';
const BLOCKSCOUT = 'https://base.blockscout.com/api';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DISCOVERY = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const UA = 'TheAssayer-OnchainReconcile/1.0 (+https://github.com/thumm110/x402-field-guide; read-only)';
const RANGE = 9999;          // public RPC hard cap is a 10,000 block range
const DAY_S = 86400;

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };
const has = (f) => argv.includes(f);
const TOP = Number(argOf('--top', 12));
const WINDOWS = Number(argOf('--windows', 4));
const CACHE = argOf('--cache', null);

/**
 * Does this transfer look like a settlement of one of the address's listings?
 * x402's `exact` scheme moves exactly the quoted price, so a transfer whose
 * value matches no declared price is some other flow — funding, payroll, another
 * product — and counting it as revenue inflates the chain side of the
 * comparison. Reported alongside the unfiltered figure, never instead of it.
 */
const matchesPrice = (v, prices) => [...prices].some((p) => Math.abs(v - p) < 1e-9);

const pad32 = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const hex = (n) => '0x' + n.toString(16);
const usd = (n) => '$' + n.toFixed(2);

/**
 * Every free Base RPC caps eth_getLogs at a 10,000-block range (measured
 * 2026-08-13 across six providers: mainnet.base.org and drpc 10k, publicnode
 * archive-gated, 1rpc 50 blocks, blast 10 blocks, llamarpc HTML). So a 30-day
 * scan is ~130 requests and rate limits are certain. They are handled by
 * rotating providers and backing off — never by treating a throttle as data.
 */
const PROVIDERS = [RPC, 'https://base.drpc.org'];
let provIdx = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 6) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const url = PROVIDERS[provIdx++ % PROVIDERS.length];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': UA },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30000),
      });
      const b = await r.json();
      if (b.error) throw new Error(b.error.message);
      return b.result;
    } catch (e) {
      lastErr = e;
      await sleep(400 * 2 ** attempt); // 0.4s, 0.8s, 1.6s … 12.8s
    }
  }
  throw new Error(`${method} failed after ${tries} tries: ${lastErr?.message}`);
}

/** USDC transfers INTO `addr` within [from,to] (<=RANGE blocks), from the chain. */
async function logsIn(addr, from, to) {
  const logs = await rpc('eth_getLogs', [{
    address: USDC, topics: [TRANSFER, null, pad32(addr)], fromBlock: hex(from), toBlock: hex(to),
  }]);
  return logs.map((l) => ({
    block: Number(l.blockNumber),
    usd: Number(BigInt(l.data)) / 1e6,
    from: '0x' + l.topics[1].slice(26),
    tx: l.transactionHash,
  }));
}

/**
 * Exhaustive scan of the whole 30-day window from the chain, in RANGE-sized
 * chunks (the public RPC caps eth_getLogs at 10,000 blocks). ~130 requests per
 * address, run a few at a time. Slower than an indexer and worth it: `rpc()`
 * throws on any error body, so a throttled or failing provider CANNOT come back
 * looking like "this address received nothing" — which is the failure mode that
 * silently corrupted the first run of this tool.
 */
async function exhaustiveRpc(addr, from, to, concurrency = 6) {
  const chunks = [];
  for (let b = from; b <= to; b += RANGE + 1) chunks.push([b, Math.min(b + RANGE, to)]);
  const rows = [];
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const got = await Promise.all(batch.map(([f, t]) => logsIn(addr, f, t)));
    for (const g of got) rows.push(...g);
  }
  return { rows, chunks: chunks.length };
}

/**
 * Exhaustive USDC transfers into `addr` newer than `sinceTs`, via Blockscout.
 *
 * THE TRAP THIS FUNCTION USED TO FALL INTO, and it is the reason for the status
 * check below. Blockscout's free tier rate-limits, and a throttled reply is
 * `{"status":"0","message":"Too many requests…","result":[]}` — HTTP 200, valid
 * JSON, an EMPTY ARRAY. The first version of this file read `result` and
 * reported "0 transfers", so a rate limit came back dressed as a measurement of
 * zero, and zero is exactly the answer this tool exists to detect. It printed
 * four confident $0.00 rows that way (fixed 2026-08-13; see L-030). A genuinely
 * empty address returns `status:"0"` with `message:"No token transfers found"`,
 * so the two are distinguishable — but only if you look.
 */
async function blockscoutIn(addr, sinceTs, maxPages = 8) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const u = `${BLOCKSCOUT}?module=account&action=tokentx&address=${addr}&contractaddress=${USDC}&page=${page}&offset=100&sort=desc`;
    const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': UA } });
    const text = await r.text();
    let b;
    try { b = JSON.parse(text); } catch { throw new Error(`blockscout non-JSON (${r.status}) for ${addr}`); }
    const empty = /no token transfers found/i.test(String(b.message ?? ''));
    if (String(b.status) !== '1' && !empty) {
      throw new Error(`blockscout refused (status=${b.status} message=${b.message}) for ${addr} — NOT a zero`);
    }
    const res = Array.isArray(b.result) ? b.result : [];
    let stop = res.length < 100;
    for (const t of res) {
      const ts = Number(t.timeStamp);
      if (ts < sinceTs) { stop = true; continue; }
      if (String(t.to).toLowerCase() !== addr.toLowerCase()) continue; // outbound rows come back too
      rows.push({ ts, block: Number(t.blockNumber), usd: Number(t.value) / 1e6, from: String(t.from), tx: String(t.hash) });
    }
    if (stop) return { rows, exhaustive: true };
  }
  return { rows, exhaustive: false };
}

// ---------------------------------------------------------------- controls ---
async function runControls(head, blocks30d, ts30d, crossAddr) {
  const results = [];
  // Controls run on the RPC path, which errors loudly, rather than on the
  // indexer that can answer "0" when it means "slow down".
  const NEG = '0xdEAD000000000000000000000000000000000BEEF'; // no USDC history expected
  const neg = await exhaustiveRpc(NEG, head - blocks30d, head);
  results.push(['known-negative address returns no inbound USDC', neg.rows.length === 0, `${neg.rows.length} rows over ${neg.chunks} chunks`]);

  const PD = '0x04f8B46edAD2C7c7d39067A4ADF3905f9b9B0B9B'; // PageDistill payTo (owner's collecting wallet)
  const pd = await exhaustiveRpc(PD, head - blocks30d, head);
  const hit = pd.rows.find((t) => t.tx.toLowerCase().startsWith('0x835c320c'));
  results.push(['known-positive: PageDistill mainnet payment found on chain', !!hit, hit ? `${usd(hit.usd)} from ${hit.from}` : 'MISSING']);
  results.push(['known-positive: it is $0.01, matching the ledger', !!hit && Math.abs(hit.usd - 0.01) < 1e-9, hit ? String(hit.usd) : 'n/a']);
  // This control failed on its first run and the failure was mine, not the
  // chain's: I asserted ONE inbound transfer (the ledger's single mainnet sale)
  // and the chain showed two — the second being a $5 transfer that funded the
  // wallet. Inbound USDC is not the same event as an x402 settlement, which is
  // the confound this file's own header warns about and which my control then
  // ignored. Hence the price filter: an `exact`-scheme settlement moves exactly
  // the listing's declared price, so $0.01 is a candidate sale and $5.00 is not.
  const pdPriced = pd.rows.filter((t) => Math.abs(t.usd - 0.01) < 1e-9);
  results.push([
    'known-positive: exactly one $0.01-sized transfer (the sale), and the $5 funding transfer is excluded',
    pdPriced.length === 1 && pd.rows.length === 2,
    `${pd.rows.length} inbound total, ${pdPriced.length} at the listing price, ${new Set(pd.rows.map((t) => t.from)).size} senders`,
  ]);

  // cross-path: same block range, two independent providers
  const from = head - RANGE, to = head;
  const viaRpc = await logsIn(crossAddr, from, to);
  let bs;
  try {
    bs = await blockscoutIn(crossAddr, 0, 12);
  } catch (e) {
    // Second provider unavailable (free-tier throttle). Not fatal, but the run
    // is then single-witness and must say so rather than imply agreement.
    results.push(['cross-path second provider reachable', false, `SKIPPED — ${String(e.message).slice(0, 90)}`]);
    let ok0 = true;
    console.log('=== controls (an uncalibrated probe reports confident nonsense — L-023) ===');
    for (const [name, pass, detail] of results) {
      const skipped = String(detail).startsWith('SKIPPED');
      console.log(`${skipped ? 'SKIP' : pass ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
      if (!pass && !skipped) ok0 = false;
    }
    console.log('NOTE: single-provider run — the chain numbers below are one witness (Base RPC), not two.');
    return ok0;
  }
  const viaBs = bs.rows.filter((t) => t.block >= from && t.block <= to);
  // Blockscout must have paged PAST the start of the window, else its silence
  // about early blocks is a page cap rather than an absence.
  const covered = bs.exhaustive || bs.rows.some((t) => t.block < from);
  const sameCount = viaRpc.length === viaBs.length;
  const rpcSum = viaRpc.reduce((s, t) => s + t.usd, 0), bsSum = viaBs.reduce((s, t) => s + t.usd, 0);
  results.push([
    `cross-path agreement on ${crossAddr.slice(0, 10)}… over blocks ${from}-${to}`,
    sameCount && Math.abs(rpcSum - bsSum) < 0.01 && covered && viaRpc.length >= 20,
    `rpc ${viaRpc.length}/${usd(rpcSum)} vs blockscout ${viaBs.length}/${usd(bsSum)}` +
      `${covered ? '' : ' (blockscout never reached the window start)'}${viaRpc.length < 20 ? ' (degenerate: too few transfers to be a real control)' : ''}`,
  ]);

  let ok = true;
  console.log('=== controls (an uncalibrated probe reports confident nonsense — L-023) ===');
  for (const [name, pass, detail] of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
    if (!pass) ok = false;
  }
  return ok;
}

// ------------------------------------------------------------------- index ---
async function pullIndex() {
  if (CACHE) {
    const fs = await import('node:fs/promises');
    try {
      const parsed = JSON.parse(await fs.readFile(CACHE, 'utf8'));
      const raw = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.resources ?? parsed.data);
      if (Array.isArray(raw) && raw.length) { console.error(`(cache hit: ${CACHE}, ${raw.length} records)`); return raw; }
    } catch { /* fall through */ }
  }
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${DISCOVERY}?limit=1000&offset=${offset}`, { headers: { accept: 'application/json', 'user-agent': UA } });
    if (!r.ok) throw new Error(`discovery ${r.status}`);
    const b = await r.json();
    const items = b.items ?? [];
    out.push(...items);
    if (items.length < 1000) break;
  }
  if (CACHE) { const fs = await import('node:fs/promises'); await fs.writeFile(CACHE, JSON.stringify(out)); }
  return out;
}

const priceUsd = (r) => {
  const a = r.accepts?.[0]; if (!a) return null;
  const raw = a.amount ?? a.maxAmountRequired; if (raw == null) return null;
  const n = Number(raw) / 10 ** (a.extra?.decimals ?? 6);
  return Number.isFinite(n) ? n : null;
};

// -------------------------------------------------------------------- main ---
const head = Number(await rpc('eth_blockNumber', []));
// Measure block time instead of assuming 2s: 30 days is only 1.3M blocks if the
// chain actually produces blocks at the rate the docs claim.
const [b0, b1] = await Promise.all([
  rpc('eth_getBlockByNumber', [hex(head - 10000), false]),
  rpc('eth_getBlockByNumber', [hex(head), false]),
]);
const secPerBlock = (Number(b1.timestamp) - Number(b0.timestamp)) / 10000;
const blocks30d = Math.floor((30 * DAY_S) / secPerBlock);
const ts30d = Number(b1.timestamp) - 30 * DAY_S;
console.log(`Base head ${head}, measured ${secPerBlock.toFixed(3)} s/block -> 30 days = ${blocks30d.toLocaleString()} blocks`);
console.log(`sampling ${WINDOWS} windows of ${RANGE} blocks = ${((WINDOWS * RANGE) / blocks30d * 100).toFixed(2)}% of the 30-day window\n`);

const records = await pullIndex();

// claimed, aggregated per payTo address
const byAddr = new Map();
for (const r of records) {
  const a = r.accepts?.[0];
  const net = a?.network ?? '';
  if (!/8453|^base$/.test(net)) continue;            // Base mainnet only; Solana rows are a different chain
  const payTo = a?.payTo ?? a?.recipient; if (!payTo) continue;
  const p = priceUsd(r); if (p == null || p > 100) continue;
  const calls = r.quality?.l30DaysTotalCalls ?? 0;
  const cur = byAddr.get(payTo) ?? { payTo, listings: 0, calls: 0, gross: 0, payers: 0, what: '', prices: new Set() };
  cur.listings++; cur.calls += calls; cur.gross += p * calls; cur.prices.add(Number(p.toFixed(6)));
  cur.payers = Math.max(cur.payers, r.quality?.l30DaysUniquePayers ?? 0);
  if (!cur.what && r.description) cur.what = String(r.description).replace(/\s+/g, ' ').slice(0, 44);
  byAddr.set(payTo, cur);
}
const ranked = [...byAddr.values()].sort((a, b) => b.gross - a.gross).slice(0, TOP);

// Controls first, on a mid-volume address from the cohort — and it must be one
// with LIVE traffic in the control window. The first run of this tool picked by
// claimed calls alone and drew an address with zero on-chain activity, so the
// cross-path control compared 0 against 0 and "passed" while demonstrating
// nothing (L-023's own failure mode, committed inside the tool built to apply
// it). Probe candidates and require enough transfers for agreement to mean
// something, but few enough that Blockscout's page cap can cover the range.
let crossAddr = ranked[0].payTo;
for (const cand of ranked) {
  const n = (await logsIn(cand.payTo, head - RANGE, head)).length;
  if (n >= 20 && n <= 400) { crossAddr = cand.payTo; console.log(`cross-path control address: ${cand.payTo} (${n} transfers in the control window)`); break; }
}
const ok = await runControls(head, blocks30d, ts30d, crossAddr);
if (!ok) { console.error('\nCONTROLS FAILED — refusing to print reconciliation numbers.'); process.exit(1); }
if (has('--controls-only')) process.exit(0);

console.log(`\n=== reconciliation: index claim vs USDC actually received on Base ===`);
console.log('on-chain(30d) counts only transfers whose value equals a declared listing price; any-inbound is every USDC receipt.');
console.log('rank |    claimed | on-chain(30d) | ratio |  any-inbound | claimed calls | onchain xfers | payers idx/chain | what');

const out = [];
for (const [i, r] of ranked.entries()) {
  // Low-claim addresses get the full 30 days from the chain: sampling 3% of the
  // window cannot see a listing that claims 33 calls, and "0 in the sample" and
  // "0 at all" are the same output with different meanings.
  const exhaustive = r.calls <= 2000;
  let sampled = [], windows = [], exhaustiveRows = null;
  if (exhaustive) {
    const ex = await exhaustiveRpc(r.payTo, head - blocks30d, head);
    exhaustiveRows = { rows: ex.rows, exhaustive: true, chunks: ex.chunks };
    sampled = ex.rows;
  } else {
    for (let w = 0; w < WINDOWS; w++) {
      const to = head - Math.floor((w * blocks30d) / WINDOWS);
      const logs = await logsIn(r.payTo, to - RANGE, to);
      windows.push({ to, n: logs.length, usd: logs.reduce((s, t) => s + t.usd, 0) });
      sampled.push(...logs);
    }
  }
  const sampledUsd = sampled.reduce((s, t) => s + t.usd, 0);
  const matched = sampled.filter((t) => matchesPrice(t.usd, r.prices));
  const matchedUsd = matched.reduce((s, t) => s + t.usd, 0);
  const senders = new Set(matched.map((t) => t.from.toLowerCase())).size;
  const factor = exhaustive ? 1 : blocks30d / (WINDOWS * RANGE);
  const onchain30d = matchedUsd * factor;
  const anyInbound30d = sampledUsd * factor;
  const xfers30d = matched.length * factor;
  const ratio = r.gross > 0 ? onchain30d / r.gross : null;
  out.push({ ...r, prices: [...r.prices], onchain30d, anyInbound30d, xfers30d, senders, exhaustive, windows, sampledUsd, sampledN: sampled.length,
             exhaustivePartial: exhaustiveRows ? !exhaustiveRows.exhaustive : false });
  console.log(
    `${String(i + 1).padStart(4)} | ${usd(r.gross).padStart(10)} | ${usd(onchain30d).padStart(13)} | ` +
    `${(ratio == null ? 'n/a' : ratio.toFixed(2) + 'x').padStart(5)} | ${usd(anyInbound30d).padStart(12)} | ${String(r.calls).padStart(13)} | ` +
    `${String(Math.round(xfers30d)).padStart(13)} | ${String(r.payers).padStart(6)}/${String(senders).padEnd(9)} | ${r.what}` +
    (exhaustive ? '  [exhaustive]' : '')
  );
}

console.log('\nper-window detail (spread shows whether extrapolation is safe):');
for (const r of out) {
  if (r.exhaustive) { console.log(`  ${r.payTo.slice(0, 10)}… exhaustive: ${r.sampledN} transfers, ${usd(r.sampledUsd)} over 30d${r.exhaustivePartial ? ' (PAGE CAP HIT — undercount)' : ''}`); continue; }
  console.log(`  ${r.payTo.slice(0, 10)}… ${r.windows.map((w) => `[${w.n}x ${usd(w.usd)}]`).join(' ')}`);
}

const claimedTotal = out.reduce((s, r) => s + r.gross, 0);
const chainTotal = out.reduce((s, r) => s + r.onchain30d, 0);
console.log(`\ncohort totals: index claims ${usd(claimedTotal)}/30d, chain shows ${usd(chainTotal)}/30d (${(chainTotal / claimedTotal).toFixed(2)}x)`);
console.log('Reminder on direction: on-chain HIGH is weak (an address can receive other money);');
console.log('on-chain FAR BELOW claimed is the informative case (index over-reports, or money never touches payTo).');

const JSON_OUT = argOf('--json', null);
if (JSON_OUT) {
  const fs = await import('node:fs/promises');
  await fs.writeFile(JSON_OUT, JSON.stringify({ head, secPerBlock, blocks30d, rows: out }, null, 2));
  console.log(`wrote ${JSON_OUT}`);
}
