-- ═══════════════════════════════════════════════════════════════════════
-- Migration v4 — 30-day estimated history backfill
-- Run this in the Supabase SQL Editor if your project predates v4.
-- (Fresh installs get this from schema.sql and can skip it.)
-- ═══════════════════════════════════════════════════════════════════════

-- v4: distinguishes real price checks from the AI-estimated 30-day baseline
-- inserted when a product is first tracked. Estimated rows are chart-only
-- context: they never count as "target hit" and never trigger alert emails.
alter table public.price_logs
  add column if not exists is_estimate boolean not null default false;
