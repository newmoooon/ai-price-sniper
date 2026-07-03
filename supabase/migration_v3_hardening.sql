-- ═══════════════════════════════════════════════════════════════════════
-- Migration v2 → v3: multi-currency prices + link-health tracking
-- Only needed if your tables were created before this version.
-- Fresh installs should run schema.sql instead (it already includes this).
-- ═══════════════════════════════════════════════════════════════════════

-- ISO 4217 currency extracted by Gemini alongside the price, so the UI can
-- format $/£/€ correctly instead of assuming USD.
alter table public.price_logs
  add column if not exists currency_code text not null default 'USD'
  check (char_length(currency_code) = 3);

-- Health of the most recent check. NULL = healthy; otherwise a short,
-- user-safe description (drives the "Invalid Link" badge). Set by the
-- cron worker and the manual re-check; cleared on the next success.
alter table public.products
  add column if not exists last_error text;
