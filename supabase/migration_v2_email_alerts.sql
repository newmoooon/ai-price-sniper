-- ═══════════════════════════════════════════════════════════════════════
-- Migration v1 → v2: email alerting support
-- Only needed if you already created the tables from the ORIGINAL schema.
-- Fresh installs should run schema.sql instead (it already includes this).
-- ═══════════════════════════════════════════════════════════════════════

-- Where deal alerts are sent. Backfilled as '' for pre-existing rows;
-- the UI requires an email for every new/updated product.
alter table public.products
  add column if not exists user_email text not null default '';

-- Debounce column: the daily cron skips the email if it already alerted
-- within the last 24h, so a price sitting below target doesn't spam.
alter table public.products
  add column if not exists last_notified_at timestamptz;

-- History reads are always (product, time-ordered) — index for the chart.
create index if not exists price_logs_product_time_idx
  on public.price_logs (product_id, checked_at);
