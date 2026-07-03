-- ═══════════════════════════════════════════════════════════════════════
-- AI Price Sniper — fresh install schema (v4, includes estimated history)
-- Run this in the Supabase SQL Editor: Dashboard → SQL Editor → New query
-- ═══════════════════════════════════════════════════════════════════════

-- Products being tracked. One row per unique URL.
create table if not exists public.products (
  id               uuid primary key default gen_random_uuid(),
  url              text not null unique,
  product_name     text not null,
  target_price     numeric(10, 2) not null check (target_price > 0),
  -- v2: where deal alerts are sent. Empty = user opted out of emails
  -- (they still see "Target Slashed!" in the dashboard).
  user_email       text not null default '',
  -- v2: last time we emailed an alert, so the daily cron doesn't spam
  -- the user every day the price stays below target
  last_notified_at timestamptz,
  -- v3: health of the most recent check. NULL = healthy; otherwise a short
  -- user-safe message (drives the "Invalid Link" badge in the UI).
  last_error       text,
  created_at       timestamptz not null default now()
);

-- Append-only price history. One row per check (manual or cron).
create table if not exists public.price_logs (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products (id) on delete cascade,
  price        numeric(10, 2) not null check (price >= 0),
  stock_status text not null default 'unknown'
               check (stock_status in ('in_stock', 'out_of_stock', 'unknown')),
  -- v3: ISO 4217 code extracted by Gemini alongside the price, so the UI
  -- can format $/£/€ correctly instead of assuming USD.
  currency_code text not null default 'USD' check (char_length(currency_code) = 3),
  -- v4: true for the AI-estimated 30-day baseline inserted when tracking
  -- starts. Estimated rows are chart-only context: they never count as
  -- "target hit" and never trigger alert emails.
  is_estimate  boolean not null default false,
  checked_at   timestamptz not null default now()
);

-- The chart and "latest price" lookups always read a product's logs in
-- time order — this composite index makes both cheap.
create index if not exists price_logs_product_time_idx
  on public.price_logs (product_id, checked_at);

-- ── Row Level Security ───────────────────────────────────────────────────
-- This demo app has no auth, so we allow the anon key full access.
-- If you add Supabase Auth later, replace these with per-user policies.
alter table public.products   enable row level security;
alter table public.price_logs enable row level security;

create policy "anon full access to products"
  on public.products for all
  to anon using (true) with check (true);

create policy "anon full access to price_logs"
  on public.price_logs for all
  to anon using (true) with check (true);
