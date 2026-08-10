// bazaar-check.mjs — is PageDistill actually findable, and how good is the
// listing compared to everything else in the index?
//
//   node tools/bazaar-check.mjs [needle]
//
// Default needle is "pagedistill". Reads the CDP Bazaar anonymously (no
// account needed to read; an account is only needed to get *listed* — see
// DEPLOY.md section 8).
//
// Written because the claim "the first settled payment auto-lists you" sat in
// DEPLOY.md for a day as an inference from documentation and turned out to be
// false. This script is how that claim gets checked instead of believed.

const BAZAAR = process.env.BAZAAR_URL
  || "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const needle = (process.argv[2] || "pagedistill").toLowerCase();

const PAGE = 1000;
let offset = 0;
let total = Infinity;
const all = [];

while (offset < total) {
  const res = await fetch(`${BAZAAR}?limit=${PAGE}&offset=${offset}`);
  if (!res.ok) {
    console.error(`discovery read failed: ${res.status} ${res.statusText}`);
    console.error("(a 404 here means this facilitator has no discovery API — "
      + "the public x402.org facilitator does not. See DEPLOY.md section 8.)");
    process.exit(1);
  }
  const data = await res.json();
  const items = data.items ?? [];
  all.push(...items);
  total = data.pagination?.total ?? all.length;
  offset += PAGE;
  if (!items.length) break;
}

const first = (r) => (r.accepts || [])[0] || {};
const described = all.filter((r) => (first(r).description || "").trim());
const callable = all.filter((r) => {
  const i = (first(r).outputSchema || {}).input || {};
  return i.queryParams || i.bodyFields || i.bodyType;
});

const pct = (n) => `${((n / all.length) * 100).toFixed(1)}%`;
console.log(`indexed resources : ${all.length} (reported total ${total})`);
console.log(`with a description: ${described.length} (${pct(described.length)})`);
console.log(`with input schema : ${callable.length} (${pct(callable.length)})`);

const mine = all.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
console.log(`\nmatches for "${needle}": ${mine.length}`);
if (!mine.length) {
  console.log("NOT LISTED. Reachable != findable — see DEPLOY.md section 8.");
  process.exit(2);
}
for (const r of mine) {
  const a = first(r);
  const i = (a.outputSchema || {}).input || {};
  console.log({
    resource: a.resource,
    network: a.network,
    amount: a.amount,
    describedOk: Boolean((a.description || "").trim()),
    inputSchemaOk: Boolean(i.queryParams || i.bodyFields || i.bodyType),
    outputSchemaOk: Boolean((a.outputSchema || {}).output),
  });
}
