import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSupabase } from "@/utils/supabase";
import { fetchProductSnapshot } from "@/lib/scraper";
import { sendDealAlert } from "@/lib/email";
import type { Product } from "@/lib/types";

/**
 * Autonomous Notification Agent — the daily background worker.
 *
 * Vercel Cron hits GET /api/cron on the schedule in vercel.json. For every
 * tracked product it re-runs the Cheerio + Gemini engine (wearing a
 * randomized browser identity per request — see lib/scraper.ts), appends a
 * price_logs row, updates link-health, and emails a Resend deal alert when
 * the price lands at or below target. One product failing (bot-blocked
 * page, dead link, flaky store) never aborts the run — each is isolated
 * and reported in the summary.
 *
 * Local test:
 *   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron
 */

// Never cache: every invocation must hit live stores + live DB.
export const dynamic = "force-dynamic";
// Vercel Hobby allows up to 60s for cron-invoked functions.
export const maxDuration = 60;

/** Don't re-email while a price sits below target day after day. */
const NOTIFY_DEBOUNCE_MS = 24 * 60 * 60 * 1000;

/**
 * Constant-time comparison so the shared secret can't be recovered
 * byte-by-byte via response-timing differences.
 */
function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || !header) return false; // unset secret = endpoint sealed shut

  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

interface CheckResult {
  product: string;
  status: "checked" | "deal-emailed" | "deal-no-email" | "deal-already-notified" | "failed";
  price?: number;
  detail?: string;
}

export async function GET(request: Request) {
  // ── Auth gate FIRST: unauthorized callers get an instant 401 before we
  //    spend a single database read, store fetch, or Gemini token on them.
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data: products, error } = await supabase
    .from("products")
    .select("*, price_logs(*)")
    .order("created_at", { ascending: true });

  if (error) {
    // Full detail to the server log; a generic line to the caller.
    console.error("[cron] failed to load products:", error);
    return NextResponse.json({ error: "Failed to load products." }, { status: 500 });
  }

  const results: CheckResult[] = [];

  // Sequential on purpose: parallel-fetching N retailers from one IP is a
  // good way to trip every bot detector at once, and it also bounds
  // Gemini free-tier request bursts.
  for (const product of (products ?? []) as Product[]) {
    try {
      const snapshot = await fetchProductSnapshot(product.url);

      const { error: logError } = await supabase.from("price_logs").insert({
        product_id: product.id,
        price: snapshot.current_price,
        currency_code: snapshot.currency_code,
        stock_status: snapshot.stock_status,
      });
      if (logError) throw new Error(logError.message);

      // Success: refresh the listing name and clear link-health.
      await supabase
        .from("products")
        .update({ product_name: snapshot.product_name, last_error: null })
        .eq("id", product.id);

      // ── Deal detection + debounced alert ──────────────────────────────
      const dealReached =
        snapshot.current_price <= product.target_price && snapshot.stock_status !== "out_of_stock";

      if (!dealReached) {
        results.push({ product: snapshot.product_name, status: "checked", price: snapshot.current_price });
        continue;
      }

      // Email is opt-in per product — without one, the deal still shows
      // as "Target Slashed!" in the dashboard, we just can't push it.
      if (!product.user_email) {
        results.push({ product: snapshot.product_name, status: "deal-no-email", price: snapshot.current_price });
        continue;
      }

      const lastNotified = product.last_notified_at ? new Date(product.last_notified_at).getTime() : 0;
      if (Date.now() - lastNotified < NOTIFY_DEBOUNCE_MS) {
        results.push({
          product: snapshot.product_name,
          status: "deal-already-notified",
          price: snapshot.current_price,
        });
        continue;
      }

      await sendDealAlert({
        to: product.user_email,
        productName: snapshot.product_name,
        productUrl: product.url,
        currentPrice: snapshot.current_price,
        targetPrice: product.target_price,
        currencyCode: snapshot.currency_code,
      });
      await supabase
        .from("products")
        .update({ last_notified_at: new Date().toISOString() })
        .eq("id", product.id);

      results.push({ product: snapshot.product_name, status: "deal-emailed", price: snapshot.current_price });
    } catch (err) {
      // Isolate the failure: log it fully server-side, flag the product's
      // link-health (drives the "Invalid Link" badge), and move on. Only
      // curated SnapshotError text is stored/returned — never raw errors.
      console.error(`[cron] check failed for ${product.url}:`, err);
      const safeDetail =
        err instanceof Error && err.name === "SnapshotError" ? err.message : "Automated check failed.";
      await supabase.from("products").update({ last_error: safeDetail.slice(0, 300) }).eq("id", product.id);
      results.push({ product: product.product_name, status: "failed", detail: safeDetail });
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    checked: results.length,
    deals_emailed: results.filter((r) => r.status === "deal-emailed").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}
