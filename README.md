# 🎯 AI Price Sniper

LLM-powered price tracking. Instead of fragile site-specific scrapers, it fetches any
product page, strips the DOM with **cheerio**, and has **Gemini 2.5 Flash** read the
messy text like a human — extracting the name, live price, and stock status as strict
JSON. A daily cron agent re-checks every product and emails you via **Resend** the
moment your target price is hit.

**Stack:** Next.js (App Router) · Tailwind CSS + shadcn/ui · Supabase (Postgres) ·
Google Gemini · Recharts · Resend · lucide-react — every service on a free tier.

## Setup

### 1. Install

```bash
npm install
```

(From scratch, the extra packages beyond `create-next-app` + shadcn are:
`npm install @supabase/supabase-js @google/genai cheerio recharts lucide-react resend`)

### 2. Environment

```bash
cp .env.local.example .env.local
```

Fill in:

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | supabase.com → Project Settings → API |
| `GEMINI_API_KEY` | aistudio.google.com/apikey |
| `RESEND_API_KEY` | resend.com → API Keys (100 emails/day free) |
| `CRON_SECRET` | any long random string, e.g. `openssl rand -hex 32` |

### 3. Database

In the Supabase dashboard → SQL Editor, run **`supabase/schema.sql`** (fresh install —
it includes everything). If you created tables from an older version, apply the
incremental migrations instead: `supabase/migration_v2_email_alerts.sql`, then
`supabase/migration_v3_hardening.sql` (multi-currency + link-health).

### 4. Run

```bash
npm run dev   # → http://localhost:3000
```

## The autonomous notification agent

`app/api/cron/route.ts` is a secured route handler that re-checks every tracked
product, appends to `price_logs`, and emails a deal alert (debounced to once per 24h
per product). On Vercel, `vercel.json` schedules it daily at 13:00 UTC and Vercel
automatically sends the `Authorization: Bearer $CRON_SECRET` header.

Trigger it locally:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron
```

> **Resend note:** without a verified domain, the free `onboarding@resend.dev` sender
> only delivers to the email address you signed up to Resend with.

## Architecture

```
app/page.tsx            client dashboard (form, status badges, Recharts trend line)
app/actions.ts          Server Actions: track / dashboard data / re-check / delete
app/api/cron/route.ts   daily background worker (Vercel Cron + Resend alerts)
lib/scraper.ts          the engine: URL sanitizer (XSS/SSRF guard), randomized
                        browser identities, fetch → cheerio strip → Gemini →
                        validated JSON (name, price, currency, stock)
lib/trend.ts            "drop confidence" score from the price history
lib/format.ts           Intl.NumberFormat currency rendering for any ISO code
lib/email.ts            deal-alert email template + Resend client
lib/types.ts            shared domain types + status derivation
utils/supabase.ts       lazy server-side Supabase client
supabase/schema.sql     tables, indexes, RLS policies
```

## Security notes

- **URL sanitization** — every user URL passes the native `URL` constructor with a
  scheme allowlist (blocks `javascript:`/`data:` XSS vectors) and an SSRF guard
  (blocks localhost, `.local`/`.internal`, and IP-literal hosts) before it reaches
  `fetch`, cheerio, or the database.
- **SQL injection** — all queries go through the Supabase SDK's parameterized
  query builder; there is no raw SQL or string concatenation anywhere.
- **Cron protection** — `/api/cron` requires `Authorization: Bearer $CRON_SECRET`,
  compared in constant time (`crypto.timingSafeEqual`), and 401s before doing any
  work so unauthorized hits can't burn tokens or database reads.
- **Error hygiene** — raw system/DB errors are logged server-side only; clients
  receive curated, generic messages.
