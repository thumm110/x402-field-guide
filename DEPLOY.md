# DEPLOY — publishing the x402 Field Guide

**What this is:** the exact steps to put `workspace/x402-field-guide/` in front of
people. Every step is an account action the agent cannot take.

**Price: $0, deliberately.** Reasoning is in "Why free" at the bottom — read it
before deciding, because it is a strategy call and it is reversible.

**Time:** ~15 minutes for steps 1–3. Step 4 is where the value is and it is
optional-but-the-point.

---

## Step 0 — prerequisites

- A GitHub account (owner's; the agent has none).
- `git` and **Node 20+**. All three scripts here were verified running on
  **v20.20.1**. An earlier version of this file demanded Node 22 — that
  requirement is real for *Wrangler* (`TRAPS.md` #9) and this repo does not use
  Wrangler, so it was sending readers to upgrade for nothing. Corrected after a
  live run.
- Nothing else. No keys, no Cloudflare, no wallet. This artifact is text and
  three read-only scripts.

## Step 1 — verify the tools still run before publishing

The guide's central claim is "reproduce any number here." Check that is true
today, because the discovery API is someone else's and it can change.

```bash
cd workspace/x402-field-guide
node tools/top-earners.mjs --cache /tmp/bazaar.json --top 20
node tools/top-earners.mjs --cache /tmp/bazaar.json --grep "metar|airport|faa"
node tools/bazaar-census.mjs --niche "extract|markdown|scrape"
```

**Expected:** the first prints ~14,500 records, ~350k paid calls, a gross between
$7.2k and $9.7k, and a top-20 table led by a Twitter/X search endpoint around
$550/30d. The second prints a ceiling near $20. Both exit 0.

**Expect the raw counts to be a bit off, and check the right thing.** Two pulls
five hours apart moved the listing count by 142 and the ≤$5 gross by 7.8% (see
"The index churns" in the README). What should hold on any given day: **eleven
listings clearing $60**, the same names at the top of the table in the same
order, and a total under $10k/month. If those hold, publish. If they don't, the
README's tables need re-stamping before this goes out.

**The third command's headline is a trap — read past it.** `bazaar-census.mjs
--niche "extract|markdown|scrape"` reports `BEST listing in this niche grosses
~$148.00`. That is **Apify**, a general scraping *marketplace* that matches the
keyword, not a URL-extraction competitor. The genuine like-for-like competitors
are the $1.73–$2.08 rows below it, which is the number the write-up uses. Keyword
niches catch marketplaces; read the descriptions, never just the ceiling.

**If the numbers have moved materially:** that is fine and expected — they are a
snapshot dated in the README. If they have moved *a lot* (say gross above $20k or
below $4k), update the tables in `README.md` before publishing rather than
shipping a stale census, and change the "Measured 2026-08-10" date. A guide whose
own tool contradicts its own table is worse than no guide.

**If a tool errors:** do not publish. Tell the agent what broke; a field guide
that fails on the reader's first command is the one thing this artifact cannot
survive.

## Step 2 — create the repository

**Do not `git init` inside `workspace/`.** That directory lives inside the
experiment repo, and initialising there creates a repo nested in a repo — git
records it as an opaque gitlink in the parent and the contents silently stop
being tracked by either one. Copy it out first; the staged copy is the thing you
publish, and the agent's own copy in `workspace/` stays untouched.

```bash
cp -r workspace/x402-field-guide ~/x402-field-guide   # already done if staged
cd ~/x402-field-guide
git init
git add README.md TRAPS.md DEPLOY.md tools/
git commit -m "x402 field guide: measured market census + 13 verified failure modes"
gh repo create x402-field-guide --public --source=. --push \
  --description "What the x402 Bazaar actually earns — a measured census, plus 13 ways shipping an x402 seller fails silently."
```

Do **not** commit `DEPLOY.md` if you would rather not publish the strategy notes
— it is a handoff document, not part of the product. Your call; there is nothing
secret in it, and leaving it in is a small honesty signal about how the thing was
made.

Set the repo's topics: `x402`, `cloudflare-workers`, `base`, `usdc`,
`ai-agents`, `micropayments`.

## Step 3 — check the one thing readers check first

Open the repo on GitHub and read `README.md` as a stranger. Specifically:

- Do the markdown tables render? (They use pipes and should be fine.)
- Is the headline number visible without scrolling past a wall of text?
- Does the closing line — that the author's own endpoint "grosses approximately
  nothing" — still read as candour rather than self-deprecation? It is doing real
  work: it is the reason a reader believes the rest.

## Step 4 — distribution, which is the entire point

The artifact is not the deliverable. Being read is. Four places, ranked by
expected value, with text you can post unchanged. **All of it discloses that an
AI agent wrote it — do not remove that; it is a charter requirement and it is
also the most interesting thing about the post.**

### 4a. Hacker News (`Show HN`)

Highest variance, highest ceiling. Post the repo link with title:

> Show HN: The entire x402 agent-payments market grosses under $10k/month (measured)

First comment, posted by you immediately after submitting:

> I'm the human half of this. An autonomous AI agent I've been running built a
> paid x402 endpoint, then measured the market it had just entered and found that
> every record in Coinbase's discovery index publishes its own 30-day paid-call
> and unique-payer counts. So the whole market's revenue is computable from a
> public, anonymous API. It's 14,646 listings, ~351k paid calls in 30 days, and
> eleven listings clearing $60/month. The agent wrote up what it found plus the
> thirteen ways its own deploys failed, several of which return a healthy-looking
> 402 while being incapable of completing a sale. Tools to reproduce every number
> are in the repo; they need no account.

Post Tuesday–Thursday, roughly 13:00–16:00 UTC. If it does not catch, that is
normal and not evidence about the artifact.

### 4b. The x402 community directly

The x402 Foundation sits under the Linux Foundation with ~40 members, and there
is an active developer community around the protocol (GitHub Discussions on the
`coinbase/x402` repo is the reliable one; there is also a Discord). Post in
whichever is live:

> Sharing a measurement rather than an opinion: every record in the CDP discovery
> index publishes `quality.l30DaysTotalCalls` and `l30DaysUniquePayers`, so
> per-listing revenue for the whole Bazaar is computable anonymously. Full census
> and the scripts are here: <link>. Also documented 13 failure modes from our own
> deploys — the `nodejs_compat` one is worth a look for anyone using the CDP
> facilitator, because without it every *paid* call returns `Buffer is not
> defined` while the unpaid challenge stays healthy. Written by an AI agent
> (disclosed).

This is the audience most likely to actually use it, and the one where being
useful compounds. Lower reach than HN, better readers.

### 4c. Cloudflare's developer community / Discord

`TRAPS.md` #1, #2, #6 and #11 are Workers-specific and genuinely useful to
anyone wiring a payment gate into a Worker. Post `TRAPS.md`, not the census —
that audience does not care what the market earns.

### 4d. Wherever you already have an audience

If posting under `CoolBreeze` on Moltbook or similar costs you nothing, do it.
Do not create new accounts for this.

## Step 5 — report back

Add what actually happened to `memory/REQUESTS.md` when you close the request:
where you posted, and any signal at all — stars, comments, corrections, silence.
**Silence is a valid and useful result and should be recorded as one.** The agent
has no other way to learn whether publishing does anything, and "we posted and
nothing happened" is the single most decision-relevant sentence you could send
back.

If anyone corrects a number, that is the best possible outcome — send the
correction verbatim.

---

## Why free

The agent's measured conclusion is that the x402 Bazaar cannot fund it: the whole
market is under $10k/month, eleven listings clear $60, and every listing above
$100 wins by holding data supply the buyer cannot get — capital the agent does
not have. Building a *second* endpoint into that market would be building for a
channel it has already priced.

So the binding constraint stopped being "what should I build" and became **"why
would anyone ever find it."** Nothing the agent has built has ever been in front
of a single human who did not already know about it. That is the untested
variable, and it is the one this artifact tests.

A free, genuinely useful, correct artifact is the cheapest instrument available
for testing it: it costs $0 to publish, it is the kind of thing a technical
audience links to, and its value does not depend on the x402 market being big —
only on the market being *interesting*, which the numbers make it.

Charging $19 for it instead would trade away nearly all the reach for, optimistically,
one or two sales. That is the wrong trade while distribution is the unknown. If
this gets read, the paid follow-on is obvious and specified: a live,
daily-updating Bazaar revenue index — someone in the index already grosses ~$50/
month selling its historical time series at $25 a call, which is the only direct
demand evidence the agent has found for anything it can actually make.

Reversible: if the guide gets traction, the paid product ships next and the guide
becomes its front door.
