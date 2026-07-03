"use server";

import { getSupabase } from "@/utils/supabase";
import { fetchProductSnapshot, normalizeProductUrl, SnapshotError } from "@/lib/scraper";
import { estimateHistoricalBaseline } from "@/lib/backfill";
import type {
  ActionResult,
  AssistantReply,
  ChatMessage,
  Product,
  ProductSnapshot,
} from "@/lib/types";

/**
 * Server Actions — the only path from the client to the database or the
 * scraping engine.
 *
 * Security posture:
 * - URL sanitization: every user URL passes `normalizeProductUrl` (native
 *   URL constructor + scheme allowlist + SSRF host blocking) BEFORE it
 *   touches fetch, cheerio, or the database.
 * - SQL injection: all queries go through the official Supabase SDK
 *   (`.from().select/insert/upsert/delete().eq(...)`), which sends values
 *   as PostgREST parameters — no raw SQL, no string concatenation, ever.
 * - Error hygiene: raw system/DB errors are logged server-side only;
 *   the client receives either a curated SnapshotError message or a
 *   generic fallback. Envelopes (ActionResult) instead of throws, because
 *   Next.js redacts thrown server errors anyway.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The error boundary: detailed log on the server console, clean message
 * to the UI. Only SnapshotError (curated) and our own "not configured"
 * setup hints are allowed through verbatim.
 */
function toErrorMessage(err: unknown): string {
  if (err instanceof SnapshotError) return err.message;
  if (err instanceof Error && err.message.includes("not configured")) return err.message;
  console.error("[actions]", err); // full detail stays server-side
  return "Something went wrong on our end. Please try again.";
}

/** Fetch one product with its full (time-ordered) history. */
async function fetchProductWithLogs(productId: string): Promise<Product> {
  const { data, error } = await getSupabase()
    .from("products")
    .select("*, price_logs(*)")
    .eq("id", productId)
    .order("checked_at", { referencedTable: "price_logs", ascending: true })
    .single();

  if (error || !data) throw new Error(error?.message ?? "Product not found after save.");
  return data as Product;
}

/** Append one snapshot to a product's history. */
async function insertLog(productId: string, snapshot: ProductSnapshot): Promise<void> {
  const { error } = await getSupabase().from("price_logs").insert({
    product_id: productId,
    price: snapshot.current_price,
    currency_code: snapshot.currency_code,
    stock_status: snapshot.stock_status,
  });
  if (error) throw new Error(error.message);
}

/**
 * Track a product: sanitize → scrape+extract → upsert product → log price.
 * The scrape happens FIRST so a broken URL never leaves a junk row behind.
 * Re-submitting a URL that's already tracked updates its target/email and
 * appends a fresh price point rather than erroring.
 */
export async function trackProduct(input: {
  url: string;
  targetPrice: number;
  email: string;
}): Promise<ActionResult<Product>> {
  try {
    // ── Validation & sanitization (the trust boundary) ──────────────────
    const url = normalizeProductUrl(input.url); // throws SnapshotError on anything unsafe
    // Email is optional: empty = dashboard-only tracking, no alert emails.
    const email = input.email.trim().toLowerCase();
    if (email && (!EMAIL_RE.test(email) || email.length > 254)) {
      return { ok: false, error: "That email doesn't look valid — fix it or leave it blank to skip alerts." };
    }
    const targetPrice = Number(input.targetPrice);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0 || targetPrice > 1_000_000) {
      return { ok: false, error: "Target price must be a positive number." };
    }

    // ── AI extraction (the expensive step — do it before any DB write) ──
    const snapshot = await fetchProductSnapshot(url);

    // ── Persist (parameterized via the Supabase SDK throughout) ─────────
    const { data: product, error: upsertError } = await getSupabase()
      .from("products")
      .upsert(
        {
          url,
          product_name: snapshot.product_name,
          target_price: targetPrice,
          user_email: email,
          last_error: null, // a successful check always clears link-health
        },
        { onConflict: "url" }
      )
      .select("id")
      .single();
    if (upsertError || !product) throw new Error(upsertError?.message ?? "Failed to save product.");

    await insertLog(product.id, snapshot);

    // ── 30-day baseline backfill ─────────────────────────────────────────
    // Gemini + web search reconstructs how the item was priced over the
    // past month so the chart opens with context, not a single dot. Rows
    // are flagged `is_estimate` and can never satisfy deal/alert logic.
    // Runs for any product that has no baseline yet (covers both new URLs
    // and re-tracks of products from before this feature existed) — once
    // estimated rows exist, it never runs again for that product.
    // Strictly best-effort: a backfill failure never fails the track.
    const { data: existingEstimate } = await getSupabase()
      .from("price_logs")
      .select("id")
      .eq("product_id", product.id)
      .eq("is_estimate", true)
      .limit(1)
      .maybeSingle();

    if (!existingEstimate) {
      try {
        const baseline = await estimateHistoricalBaseline(url, snapshot);
        if (baseline.length > 0) {
          const { error: backfillError } = await getSupabase()
            .from("price_logs")
            .insert(
              baseline.map((point) => ({
                product_id: product.id,
                price: point.price,
                currency_code: snapshot.currency_code,
                stock_status: "unknown" as const,
                is_estimate: true,
                checked_at: point.checked_at,
              }))
            );
          if (backfillError) throw new Error(backfillError.message);
        }
      } catch (err) {
        console.error("[actions] 30-day baseline backfill skipped:", err);
      }
    }

    return { ok: true, data: await fetchProductWithLogs(product.id) };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** Everything the dashboard needs, newest products first, history in order. */
export async function getDashboardData(): Promise<ActionResult<Product[]>> {
  try {
    const { data, error } = await getSupabase()
      .from("products")
      .select("*, price_logs(*)")
      .order("created_at", { ascending: false })
      .order("checked_at", { referencedTable: "price_logs", ascending: true });

    if (error) throw new Error(error.message);
    return { ok: true, data: (data ?? []) as Product[] };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/**
 * On-demand re-check of a single product (the ↻ button on each card).
 * Success refreshes the name and clears link-health; a scrape failure is
 * recorded in `last_error` so the UI can show the "Invalid Link" badge.
 */
export async function recheckProduct(productId: string): Promise<ActionResult<Product>> {
  try {
    const supabase = getSupabase();
    const { data: product, error } = await supabase
      .from("products")
      .select("id, url")
      .eq("id", productId)
      .single();
    if (error || !product) return { ok: false, error: "That product no longer exists." };

    try {
      const snapshot = await fetchProductSnapshot(product.url);
      await insertLog(product.id, snapshot);
      await supabase
        .from("products")
        .update({ product_name: snapshot.product_name, last_error: null })
        .eq("id", product.id);
    } catch (err) {
      // Persist the (already user-safe) failure so the badge flips to
      // "Invalid Link", then still return the product + message.
      const message = toErrorMessage(err);
      await supabase.from("products").update({ last_error: message.slice(0, 300) }).eq("id", product.id);
      return { ok: false, error: message };
    }

    return { ok: true, data: await fetchProductWithLogs(product.id) };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/**
 * "Ask Sniper" — the on-site assistant. Each question is answered by
 * Gemini with the user's live dashboard (products + recent price history)
 * injected as context, so it can reason about *their* deals, not generic
 * shopping advice. Stateless by design: the client sends the visible
 * conversation, the server rebuilds fresh context every call.
 */
export async function askAssistant(history: ChatMessage[]): Promise<ActionResult<AssistantReply>> {
  try {
    // ── Validate the conversation shape (it crosses the trust boundary) ──
    const trimmed = history.slice(-12); // cap context growth
    const last = trimmed[trimmed.length - 1];
    if (!last || last.role !== "user" || !last.content.trim()) {
      return { ok: false, error: "Ask a question first." };
    }
    if (trimmed.some((m) => m.content.length > 2000)) {
      return { ok: false, error: "That message is too long — keep it under 2000 characters." };
    }

    // ── Build the live dashboard context ────────────────────────────────
    const { data: products, error } = await getSupabase()
      .from("products")
      .select("*, price_logs(*)")
      .order("created_at", { ascending: false })
      .order("checked_at", { referencedTable: "price_logs", ascending: true });
    if (error) throw new Error(error.message);

    const context = ((products ?? []) as Product[]).map((p) => ({
      product: p.product_name,
      store: new URL(p.url).hostname.replace(/^www\./, ""),
      target_price: p.target_price,
      status: p.last_error ? `last check failed: ${p.last_error}` : "monitored",
      // Most recent 10 checks, oldest → newest
      history: p.price_logs.slice(-10).map((l) => ({
        date: l.checked_at.slice(0, 10),
        price: l.price,
        currency: l.currency_code,
        stock: l.stock_status,
      })),
    }));

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your-gemini-api-key") {
      return { ok: false, error: "Gemini is not configured. Set GEMINI_API_KEY in .env.local." };
    }
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: trimmed.map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("model" as const),
        parts: [{ text: m.content }],
      })),
      config: {
        // Google Search grounding turns the chat into a real agent: it can
        // hunt for the same product at other retailers, compare prices,
        // and sanity-check whether our logged prices look right.
        tools: [{ googleSearch: {} }],
        systemInstruction: `You are Sniper, the in-app agent for AI Price Sniper, a price-tracking dashboard. Today is ${new Date().toDateString()}.

The user's live dashboard data (their tracked products and recent price checks):
${JSON.stringify(context, null, 1)}

You can use Google Search. Use it when the user asks where else a product is sold, whether it's cheaper at another store, whether a logged price looks accurate, or anything needing current market info. When you cite other stores, name the store and the price you found.

Rules:
- For questions about their own tracking (trends, targets, buy-now-or-wait), ground answers in the dashboard data above and cite actual prices and dates.
- Be concise (2-6 sentences), friendly, and concrete.
- Plain text only: no markdown, no bullet lists, no headers.
- If the dashboard is empty or lacks the data to answer, say so and suggest tracking a product first.
- Politely decline anything unrelated to shopping, prices, or this dashboard.`,
      },
    });

    const answer = response.text?.trim();
    if (!answer) return { ok: false, error: "The assistant didn't respond. Try again." };

    // Surface where a web-grounded answer came from as structured store
    // links, so the UI can render tappable source cards (deduped by store,
    // max 4). Only http(s) grounding URLs are passed through.
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    const sources: AssistantReply["sources"] = [];
    for (const chunk of chunks) {
      const title = chunk.web?.title?.trim();
      const url = chunk.web?.uri?.trim();
      if (!title || !url || seen.has(title)) continue;
      if (!/^https?:\/\//i.test(url)) continue;
      seen.add(title);
      sources.push({ title, url });
      if (sources.length >= 4) break;
    }

    return { ok: true, data: { reply: answer, sources } };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** Inline edit of a product's target price (no re-scrape needed). */
export async function updateTargetPrice(
  productId: string,
  targetPrice: number
): Promise<ActionResult<Product>> {
  try {
    const price = Number(targetPrice);
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) {
      return { ok: false, error: "Target price must be a positive number." };
    }
    const { error } = await getSupabase()
      .from("products")
      // Reset the notification debounce: a new target is a new deal to catch.
      .update({ target_price: price, last_notified_at: null })
      .eq("id", productId);
    if (error) throw new Error(error.message);
    return { ok: true, data: await fetchProductWithLogs(productId) };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** Stop tracking. price_logs rows cascade-delete with the product. */
export async function deleteProduct(productId: string): Promise<ActionResult<null>> {
  try {
    const { error } = await getSupabase().from("products").delete().eq("id", productId);
    if (error) throw new Error(error.message);
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}
