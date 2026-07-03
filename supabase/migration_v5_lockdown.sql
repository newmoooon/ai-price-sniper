-- ═══════════════════════════════════════════════════════════════════════
-- Migration v4 → v5: revoke direct database access from the anon key
--
-- ORDER MATTERS — do these two steps in this order or the app breaks:
--   1. Set SUPABASE_SECRET_KEY in .env.local (and in Vercel env settings):
--      Supabase dashboard → Project Settings → API keys → "secret" key
--      (legacy installs call it the service_role key — same thing here).
--   2. Then run this file in the SQL Editor.
--
-- Before this migration, the RLS policies below granted the anon key FULL
-- read/write/delete on every table. The anon key is public by design (it
-- ships in client bundles on typical Supabase apps), so anyone who found it
-- could bypass the app entirely and talk to PostgREST directly.
--
-- After this migration: RLS stays enabled with NO policies, which means
-- deny-everything for the anon and authenticated roles. The app's Server
-- Actions and the cron worker keep working because the secret (service
-- role) key bypasses RLS. No user-facing behavior changes.
-- ═══════════════════════════════════════════════════════════════════════

drop policy if exists "anon full access to products"   on public.products;
drop policy if exists "anon full access to price_logs" on public.price_logs;

-- Belt and braces: even if a future policy slips through, the anon role
-- shouldn't hold table privileges it doesn't need.
revoke all on table public.products   from anon;
revoke all on table public.price_logs from anon;
