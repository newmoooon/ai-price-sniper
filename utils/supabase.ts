import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client (lazy singleton).
 *
 * Security posture: this client is only ever constructed inside Server
 * Actions and Route Handlers — no Supabase key ships to the browser.
 * It authenticates with SUPABASE_SECRET_KEY (service role), which bypasses
 * RLS; the database itself is locked down by migration_v5_lockdown.sql so
 * the publishable anon key can no longer read or write anything directly.
 *
 * Legacy fallback: if SUPABASE_SECRET_KEY isn't set yet, we fall back to
 * the old NEXT_PUBLIC_* anon config so a not-yet-migrated install keeps
 * working — with a loud warning, because that posture leaves the whole
 * database writable by anyone holding the (public-by-design) anon key.
 *
 * Lazy so that `next build` succeeds before the env vars are configured —
 * the error surfaces as a friendly message at request time instead of
 * crashing the whole build/module graph at import time.
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const legacyAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const key = secretKey || legacyAnonKey;

  if (!url || !key || url.includes("YOUR-PROJECT-REF")) {
    throw new Error(
      "Supabase is not configured. Copy .env.local.example to .env.local and fill in SUPABASE_URL / SUPABASE_SECRET_KEY."
    );
  }

  if (!secretKey) {
    console.warn(
      "[supabase] SECURITY: running on the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
        "Set SUPABASE_SECRET_KEY (Supabase dashboard → Project Settings → API keys → secret) " +
        "and run supabase/migration_v5_lockdown.sql BEFORE deploying publicly — " +
        "until then the anon key has full read/write access to the database."
    );
  }

  client = createClient(url, key, {
    // This client only runs in Server Actions / Route Handlers — there is
    // no browser session to persist.
    auth: { persistSession: false },
  });
  return client;
}
