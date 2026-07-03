/** Shared domain types — mirrors the Supabase schema in supabase/schema.sql */

export type StockStatus = "in_stock" | "out_of_stock" | "unknown";

export interface PriceLog {
  id: string;
  product_id: string;
  price: number;
  stock_status: StockStatus;
  /** ISO 4217 code extracted by Gemini (e.g. USD, GBP, EUR) */
  currency_code: string;
  checked_at: string; // ISO timestamp
}

export interface Product {
  id: string;
  url: string;
  product_name: string;
  target_price: number;
  /** Where deal alerts go; empty string = no email alerts for this product */
  user_email: string;
  last_notified_at: string | null;
  /** NULL = last check succeeded; otherwise a short user-safe message */
  last_error: string | null;
  created_at: string;
  /** Joined price history, ordered oldest → newest */
  price_logs: PriceLog[];
}

/** What the Gemini extraction step must return for one product page. */
export interface ProductSnapshot {
  product_name: string;
  current_price: number;
  currency_code: string;
  stock_status: StockStatus;
}

/**
 * Uniform result envelope for Server Actions — lets the client narrow on
 * `ok` instead of relying on thrown errors crossing the RSC boundary
 * (Next.js redacts server error messages in production).
 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/** UI status derived from link health + the most recent price log. */
export type ProductStatus = "deal" | "out_of_stock" | "invalid" | "monitoring";

export function latestLog(product: Product): PriceLog | null {
  return product.price_logs.length > 0
    ? product.price_logs[product.price_logs.length - 1]
    : null;
}

export function productStatus(product: Product): ProductStatus {
  // A failed last check outranks everything: whatever price we have is stale.
  if (product.last_error) return "invalid";
  const log = latestLog(product);
  if (!log) return "monitoring";
  if (log.stock_status === "out_of_stock") return "out_of_stock";
  if (log.price <= product.target_price) return "deal";
  return "monitoring";
}

/** Currency of a product's most recent price log (USD until first check). */
export function productCurrency(product: Product): string {
  return latestLog(product)?.currency_code ?? "USD";
}

/**
 * When the price reached the user's target: the first log of the CURRENT
 * below-target streak (so "hit your target on Jun 30" survives later
 * checks that stay low, but resets if the price bounced back above).
 */
export function targetHit(product: Product): PriceLog | null {
  let hit: PriceLog | null = null;
  for (const log of product.price_logs) {
    if (log.price <= product.target_price) {
      if (!hit) hit = log; // start of a streak
    } else {
      hit = null; // price bounced back above target — streak broken
    }
  }
  return hit;
}

/** One turn in the assistant conversation (client ↔ server action). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
