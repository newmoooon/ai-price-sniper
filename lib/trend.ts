import type { PriceLog } from "@/lib/types";

/**
 * Predictive trend analysis: a 0–100 "drop confidence" score — how likely
 * the price is to fall further, judged from the product's own history log.
 *
 * Deliberately a transparent, deterministic heuristic rather than another
 * LLM call: it's free, instant, reproducible, and explainable to the user
 * (an LLM asked to invent a probability would just hallucinate one). Three
 * classic price-watching signals, weighted:
 *
 *   1. Position in range (45%) — a price near its historical HIGH has the
 *      most room to fall; near its historical LOW it has already dropped.
 *   2. Momentum (35%) — a downward slope across the recent checks tends to
 *      continue (sales ramp over days, not single ticks).
 *   3. Volatility (20%) — a jumpy price gets discounted often; a flat one
 *      is probably pinned at MSRP.
 */
export function dropConfidence(logs: PriceLog[]): number | null {
  // One data point has no trend — the UI shows "gathering data" instead.
  if (logs.length < 2) return null;

  const prices = logs.map((l) => l.price);
  const current = prices[prices.length - 1];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  if (mean <= 0) return null;

  // ── 1. Position in historical range → 0 (at low) … 1 (at high) ────────
  const range = max - min;
  const position = range > 0 ? (current - min) / range : 0.5;

  // ── 2. Momentum: average step change over the last few checks,
  //       normalized by price. Falling (negative) → score toward 1. ──────
  const recent = prices.slice(-4); // up to the last 3 deltas
  let momentum = 0.5;
  if (recent.length >= 2) {
    let deltaSum = 0;
    for (let i = 1; i < recent.length; i++) deltaSum += recent[i] - recent[i - 1];
    const avgStep = deltaSum / (recent.length - 1) / mean;
    // ±2% per check saturates the signal either way.
    momentum = clamp01(0.5 - avgStep / 0.04);
  }

  // ── 3. Volatility: coefficient of variation, saturating at 5% ─────────
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
  const volatility = clamp01(Math.sqrt(variance) / mean / 0.05);

  const score = 100 * (0.45 * position + 0.35 * momentum + 0.2 * volatility);

  // Never claim certainty in either direction — this is a forecast, not fact.
  return Math.round(Math.min(95, Math.max(5, score)));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
