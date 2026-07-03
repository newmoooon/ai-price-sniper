import { GoogleGenAI } from "@google/genai";
import type { ProductSnapshot } from "@/lib/types";

/**
 * 30-day historical baseline estimator — runs once, when a product is first
 * tracked, so the chart opens with context instead of a single dot.
 *
 * Gemini (with Google Search grounding) researches how the item has been
 * priced over the past month — launch price, typical street price, recent
 * sale events — and returns a daily estimate series. These are ESTIMATES,
 * not observations: every row is stored with `is_estimate = true`, is drawn
 * differently in the chart, and is excluded from "target hit" detection and
 * alert emails.
 *
 * Failure policy: this is a nice-to-have enrichment. Nothing here may ever
 * fail the user's tracking request — callers get [] on any error and the
 * detail stays in the server log.
 *
 * Note: Google Search grounding cannot be combined with `responseSchema`
 * (the API rejects tools + JSON response mode together), so the prompt asks
 * for bare JSON and we parse defensively, same as lib/scraper.ts does.
 */

export interface EstimatedPoint {
  price: number;
  /** ISO timestamp, strictly in the past (yesterday or older) */
  checked_at: string;
}

const BACKFILL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// An estimate wildly off today's live price is a hallucination, not history.
const MIN_RATIO = 0.5;
const MAX_RATIO = 1.6;

function getGemini(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your-gemini-api-key") return null;
  return new GoogleGenAI({ apiKey });
}

/**
 * Ask Gemini to reconstruct a plausible last-30-days price series for the
 * product, grounded in what web search says about its pricing history.
 */
export async function estimateHistoricalBaseline(
  url: string,
  snapshot: ProductSnapshot
): Promise<EstimatedPoint[]> {
  const ai = getGemini();
  if (!ai) return [];

  const prompt = `You are a retail pricing analyst. Today is ${new Date().toDateString()}.

Product: ${snapshot.product_name}
Store page: ${url}
Live price observed today: ${snapshot.current_price} ${snapshot.currency_code}

Use Google Search to research how this exact product has typically been priced over the LAST ${BACKFILL_DAYS} DAYS: its usual street price, list/MSRP, and any recent sale events or price drops you can find evidence for. Then reconstruct a plausible daily price series for the last ${BACKFILL_DAYS} days ending yesterday.

Rules:
- One entry per day, oldest first, exactly ${BACKFILL_DAYS} entries.
- "days_ago" is an integer from ${BACKFILL_DAYS} down to 1 (1 = yesterday). Never 0 or negative.
- "price" is a plain number in ${snapshot.currency_code}. Real retail prices move in steps and plateaus (a sale week, a return to list price), not smooth curves or random noise.
- The series should end near today's live price of ${snapshot.current_price}.
- If search gives you nothing concrete about this product, base the series on the product category's typical discount behavior — but stay within a realistic band around today's price.

Respond with ONLY a JSON array, no prose, no markdown fences:
[{"days_ago": ${BACKFILL_DAYS}, "price": 129.99}, ...]`;

  let rawText: string | undefined;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        // Reconstruction benefits from a little reasoning, but cap it so a
        // first-track request doesn't hang the UI on the free tier.
        thinkingConfig: { thinkingBudget: 512 },
      },
    });
    rawText = response.text;
  } catch (err) {
    console.error("[backfill] Gemini baseline call failed:", err);
    return [];
  }

  return parseBaseline(rawText, snapshot.current_price);
}

/**
 * Defensive parse + semantic clamp of the model's series. Anything that
 * doesn't survive validation is dropped silently — a partial baseline is
 * still a better chart than an empty one.
 */
export function parseBaseline(rawText: string | undefined, currentPrice: number): EstimatedPoint[] {
  if (!rawText) return [];

  // Strip markdown fences and any prose around the array.
  const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const now = Date.now();
  const byDay = new Map<number, number>(); // days_ago → price (last wins)

  for (const entry of parsed as Array<Record<string, unknown>>) {
    if (typeof entry !== "object" || entry === null) continue;
    const daysAgo = Math.round(Number(entry.days_ago));
    const price =
      typeof entry.price === "number"
        ? entry.price
        : Number(String(entry.price ?? "").replace(/[$,]/g, ""));

    // Strictly the past — an "estimate" dated today or later would outrank
    // the real observation as latestLog and corrupt live-price logic.
    if (!Number.isInteger(daysAgo) || daysAgo < 1 || daysAgo > BACKFILL_DAYS) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    // Clamp hallucinated outliers to a believable band around today's price.
    if (price < currentPrice * MIN_RATIO || price > currentPrice * MAX_RATIO) continue;

    byDay.set(daysAgo, Math.round(price * 100) / 100);
  }

  // A couple of stray points draw a misleading "trend" — require substance.
  if (byDay.size < 5) return [];

  return [...byDay.entries()]
    .sort((a, b) => b[0] - a[0]) // oldest (largest days_ago) first
    .map(([daysAgo, price]) => ({
      price,
      checked_at: new Date(now - daysAgo * DAY_MS).toISOString(),
    }));
}
