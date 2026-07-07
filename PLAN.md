# AI Price Sniper — Product Vision & Architectural Direction

## Thesis

Price tracking has always been brittle because it was built on scrapers — one
fragile parser per store, breaking every time a retailer reshuffles its HTML.
AI Price Sniper's bet is that an LLM reading a page the way a human does makes
the tracker **store-agnostic by default**: no per-site adapters, no
maintenance treadmill, works on the long tail of small shops the big trackers
ignore. The scraping engine is not the interesting part — the *interpretation*
engine is.

The long-term identity is a **personal price intelligence agent**: not just
"tell me when this drops," but "watch the things I care about across the whole
web and tell me when to act."

## Who it serves, in order

1. **The deal-conscious individual** tracking a handful of specific products —
   today's user.
2. **The long-tail shopper** whose stores no existing tracker supports
   (boutiques, regional retailers, niche gear) — the underserved wedge the
   store-agnostic engine uniquely wins.
3. **The buyer who wants judgment, not just alerts** — "is this actually a
   good price, or manufactured urgency?" — served by the assistant layer.

## The defining architectural decision

The single most important choice ahead is **tenancy**, and it forks the whole
product:

- **Path A — personal instrument.** Stay single-tenant (the current design:
  one shared dashboard, no auth) and lean all the way in: a tool you deploy
  for yourself, one-click. Simpler, honest, and a strong "self-hosted
  camelcamelcamel for any store" story. Nothing below about accounts applies.
- **Path B — hosted service.** Introduce identity and per-user data isolation
  so strangers can use one deployment. This is the "used by people" path and
  it reshapes the data model (ownership on every row, row-level security, the
  server acting as the user rather than as an omnipotent service role) and the
  background worker (fair scheduling across users, per-account quotas).

This document assumes the ambition implies **Path B**, but the choice is
load-bearing and should be made explicitly before anything else — the current
architecture is correct for A and incomplete for B, and pretending otherwise
is how the project stalls.

## Architecture: what it is, and where it must go

Today: a Next.js app with server actions, a Gemini-backed scraping pipeline,
a daily Vercel cron that re-checks every product, and a grounded chat
assistant. Three directions define its evolution:

### Direction 1 — Extraction that degrades intelligently

The LLM-reads-the-page approach is the differentiator, but it has a real gap:
JavaScript-rendered stores return near-empty HTML, and pointing the model at
nothing produces nothing. The architectural answer is a **layered extraction
strategy** that tries the cheapest reliable signal first — structured data
(`JSON-LD`, Open Graph price meta) needs no model and is more accurate when
present — and falls back to LLM interpretation only when structure is absent.
The system should always know *which* method produced a number and how much to
trust it. This turns "some stores just fail" into "the tool picks the best
available reading and tells you its confidence."

### Direction 2 — From cron to agent

The daily re-check is the seed of something larger. Today it is a fixed
schedule scanning a fixed list; the direction is an **autonomous monitoring
agent** whose behavior is driven by the product, not the clock: check
volatile prices more often, dormant ones rarely; notice patterns ("this drops
every Friday"); proactively find the same item cheaper elsewhere (the
assistant already does one-shot comparison — persist and act on it). This
reframes the background worker from a batch job into the core product, and it
forces the scaling architecture — sharded or queued execution, per-user
fairness — that Path B needs anyway.

### Direction 3 — From alerts to judgment

An alert says "the number changed." Judgment says "this is the lowest it's
been in six months, and the other three stores that carry it are higher —
buy." The estimated-baseline backfill and the grounded assistant are the first
gestures at this; the direction is to make **decision support the headline
feature**, not a side panel. The architectural requirement is a clean
separation between *observations* (real scraped prices), *estimates* (AI-
reconstructed history, never trusted for alerts), and *external signals*
(other retailers) — so the judgment layer can reason over all three without
ever confusing a guess for a fact.

## Product surface evolution

Track-from-the-app → track-from-anywhere (a "snipe this page" bookmarklet and
browser extension are the natural acquisition surface for a tracker — you
track where you shop, not where the dashboard is) → notify-anywhere (email
today, web push tomorrow, so a deal reaches you in seconds) → decide-anywhere
(the assistant becomes the primary interface: "should I buy this?").

## Horizons

**H1 — A real, deployed tool** with the tenancy decision made, the trust
boundary of the scraper documented as the security story it is, and
extraction that no longer silently fails on modern storefronts.

**H2 — Sticky.** Tracking happens from the browser, deals arrive without
checking the dashboard, and history is rich enough (real observations plus
honestly-labeled estimates) that the tool answers "is now a good time" — the
question that actually drives a purchase. Stickiness, not signups, is the
metric that matters for a tracker.

**H3 — Agentic.** The monitoring worker behaves like an agent with a goal
("get me the best price on these") rather than a schedule; comparison across
retailers is continuous, not on-demand; the accuracy of its price
reconstructions is measured against reality and published. Success is a user
who buys something because the tool told them to, and was right.

## What AI Price Sniper deliberately is not

- **Not a per-store scraper farm.** The moment the roadmap starts adding
  hand-written parsers for individual retailers, it has lost its identity —
  store-agnostic interpretation is the whole point. Structured-data-first is
  fine (it's a standard, not a store hack); site-specific HTML selectors are
  the anti-pattern.
- **Not a coupon/affiliate content site.** The value is monitoring and
  judgment, not driving clicks.
- **Not a real-time market feed.** Daily-ish granularity is honest for a
  tool that reads public pages politely; promising second-by-second pricing
  would mean adopting the adversarial scraping posture the LLM approach was
  meant to avoid.

## Risks and how the architecture answers them

- **Retailer bot-blocking** (Amazon and friends) → honest per-product
  "can't track this store" status over silent failure; structured-data path
  sidesteps some blocks; never escalate into an arms race that defines the
  product as a scraper.
- **LLM extraction cost at scale** → structure-first extraction reserves the
  model for pages that need it; adaptive check frequency stops burning
  quota on dormant products.
- **Tenancy debt** → made explicit as the first decision, not discovered
  later when a stranger sees another stranger's dashboard.
- **Estimate/observation confusion** → enforced as a data-model invariant, so
  the judgment layer can never quote a guess as a fact.

## What success looks like in one sentence

Someone tells the tool the handful of things they want, forgets about it, and
weeks later gets one message that says "buy this now, here, for this price" —
and it's right.
