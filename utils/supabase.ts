import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client (lazy singleton).
 *
 * Lazy so that `next build` succeeds before the env vars are configured —
 * the error surfaces as a friendly message at request time instead of
 * crashing the whole build/module graph at import time.
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key || url.includes("YOUR-PROJECT-REF")) {
    throw new Error(
      "Supabase is not configured. Copy .env.local.example to .env.local and fill in NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  client = createClient(url, key, {
    // This client only runs in Server Actions / Route Handlers — there is
    // no browser session to persist.
    auth: { persistSession: false },
  });
  return client;
}
