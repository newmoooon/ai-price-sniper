import { lookup } from "node:dns/promises";
import * as cheerio from "cheerio";
import { GoogleGenAI, Type } from "@google/genai";
import type { ProductSnapshot, StockStatus } from "@/lib/types";

/**
 * The parsing engine: URL → raw HTML → cheerio-stripped text → Gemini →
 * validated ProductSnapshot. Shared by the Server Actions (user-initiated
 * checks) and the cron worker (daily background checks).
 *
 * Every failure throws a SnapshotError whose message is safe to show the
 * end user — callers catch and forward `.message`. Anything else that
 * escapes is a programming/infra error and gets replaced by a generic
 * message at the action boundary (never leaked to the client).
 */

export class SnapshotError extends Error {}

// Keep the prompt well under gemini-2.5-flash's context window while
// leaving plenty of room for long product pages. ~16k chars ≈ 4k tokens.
const MAX_CLEAN_TEXT_CHARS = 16_000;
const FETCH_TIMEOUT_MS = 15_000;

/* ────────────────────── URL sanitization (SSRF/XSS) ────────────────────── */

/** IPv4 literals we must never fetch: loopback, RFC-1918, link-local, 0/8. */
const PRIVATE_IPV4_RE =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Validate + sanitize a user-supplied URL with the native URL constructor.
 * This is the trust boundary for both XSS (a `javascript:` or malformed
 * "URL" never reaches fetch/cheerio/the DB) and SSRF (the server will not
 * be tricked into fetching localhost, cloud metadata, or LAN addresses).
 */
export function normalizeProductUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new SnapshotError("That doesn't look like a valid URL. Paste the full product link, including https://.");
  }

  // Scheme allowlist — rejects javascript:, data:, file:, ftp:, etc.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SnapshotError("Only http(s) product links are supported.");
  }
  // Embedded credentials are a phishing/SSRF smell, never a product link.
  if (parsed.username || parsed.password) {
    throw new SnapshotError("Links containing login credentials aren't supported.");
  }
  // Real stores serve on the default ports. An explicit odd port is how an
  // SSRF probe reaches internal services (…:6379, …:8080/admin, …).
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    throw new SnapshotError("Links with a non-standard port aren't supported.");
  }

  // SSRF guard: real retailers are public hostnames, never IP literals or
  // internal names — so we can simply refuse the whole risky class.
  const host = parsed.hostname.toLowerCase();
  const isIpLiteral = host.startsWith("[") /* IPv6 */ || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") ||
    (isIpLiteral && (host.startsWith("[") || PRIVATE_IPV4_RE.test(host))) ||
    isIpLiteral // public IP literals are refused too — no store sells from a bare IP
  ) {
    throw new SnapshotError("That address can't be tracked. Paste a public store link like https://www.amazon.com/…");
  }

  // Tracking fragments never change the product — strip for clean dedupe.
  parsed.hash = "";
  stripTrackingParams(parsed);
  return parsed.toString();
}

/**
 * Ad/analytics query params identify the *click*, not the product. Stripping
 * them means the same product pasted from a Google ad and from the address
 * bar dedupes to one tracked row (products.url is unique). Blocklist only —
 * params that select the product (variant, size, color, sku…) are kept.
 */
const TRACKING_PARAM_PREFIXES = ["utm_", "gad_", "mc_", "pk_", "mtm_"];
const TRACKING_PARAMS = new Set([
  "gclid", "gclsrc", "gbraid", "wbraid", // Google Ads
  "fbclid", "igshid", // Meta
  "msclkid", // Microsoft Ads
  "ttclid", "twclid", "epik", "dclid", "yclid", // TikTok/X/Pinterest/etc.
  "srsltid", // Google Merchant listings
  "_ga", "_gl", // GA cross-domain linker
  "ref", "ref_", "affid", "affiliate", "cmpid", "cid", "sscid", "irclickid",
  // Wunderkind/attribution params (seen on SKIMS ad links)
  "wpsrc", "wpcid", "wpscid", "wpcrid", "wpkwid", "wpkwn", "wpkmatch", "wpsnetn",
]);

function stripTrackingParams(url: URL): void {
  const toDelete: string[] = [];
  for (const key of url.searchParams.keys()) {
    const k = key.toLowerCase();
    if (TRACKING_PARAMS.has(k) || TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p))) {
      toDelete.push(key);
    }
  }
  for (const key of toDelete) url.searchParams.delete(key);
  // `?` with nothing behind it is just noise.
  if ([...url.searchParams.keys()].length === 0) url.search = "";
}

/* ─────────────────── DNS-level SSRF guard (post-parse) ─────────────────── */

/**
 * A hostname can look public and still resolve to a private address (DNS
 * pointing 169.254.169.254 at shop.attacker.com costs nothing). Before any
 * fetch, resolve the host and refuse if ANY of its addresses is
 * private/loopback/link-local/multicast — v4 or v6.
 *
 * Residual risk: DNS rebinding (answer changes between our lookup and
 * fetch's own). Eliminating that requires pinning the socket to the checked
 * IP (custom undici Agent/proxy). Accepted for now: this app runs on
 * serverless with no LAN behind it, and the metadata-service class of
 * target is covered by the checks below.
 */
async function assertResolvesPublic(hostname: string): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new SnapshotError("Couldn't reach that URL. Check the link and your connection.");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new SnapshotError("That address can't be tracked. Paste a public store link like https://www.amazon.com/…");
  }
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 192 && b === 0) || // IETF protocol assignments / TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:10.0.0.1) — judge the embedded v4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return (
    lower === "::" ||
    lower === "::1" || // loopback
    /^fe[89ab]/.test(lower) || // link-local fe80::/10
    /^f[cd]/.test(lower) || // unique-local fc00::/7
    /^fe[cdf]/.test(lower) // deprecated site-local fec0::/10
  );
}

/* ─────────────────────── Anti-bot browser identity ─────────────────────── */

/**
 * Real, current browser identities (Chrome / Safari / Firefox / Edge on
 * Mac + Windows). Each check randomly wears one so the daily cron doesn't
 * present a single robotic fingerprint to every retailer at once.
 */
const BROWSER_IDENTITIES = [
  // Chrome on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  // Chrome on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  // Safari on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  // Firefox on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  // Firefox on macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0",
  // Edge on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
] as const;

/** A randomized-but-authentic header set for one outbound page fetch. */
export function randomBrowserHeaders(): Record<string, string> {
  const ua = BROWSER_IDENTITIES[Math.floor(Math.random() * BROWSER_IDENTITIES.length)];
  return {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
  };
}

/* ──────────────────────────── The pipeline ─────────────────────────────── */

const MAX_REDIRECTS = 5;

/**
 * Step 1 — fetch the raw HTML, wearing a randomized browser identity.
 *
 * Redirects are followed MANUALLY so every hop passes the same trust
 * boundary as user input: `redirect: "follow"` would happily chase a
 * public URL's 302 into localhost or the cloud metadata service.
 */
async function fetchRawHtml(url: string): Promise<string> {
  const headers = randomBrowserHeaders(); // one identity across all hops

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertResolvesPublic(new URL(current).hostname);

    let res: Response;
    try {
      res = await fetch(current, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "manual",
        headers,
        cache: "no-store",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new SnapshotError("The store took too long to respond. Try again in a moment.");
      }
      throw new SnapshotError("Couldn't reach that URL. Check the link and your connection.");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new SnapshotError(`The store returned an error (HTTP ${res.status}). The product page may be blocked or gone.`);
      }
      let next: string;
      try {
        next = new URL(location, current).toString(); // resolve relative Location
      } catch {
        throw new SnapshotError("The store returned a broken redirect. Try the final product URL directly.");
      }
      current = normalizeProductUrl(next); // full re-validation, every hop
      continue;
    }

    if (!res.ok) {
      throw new SnapshotError(`The store returned an error (HTTP ${res.status}). The product page may be blocked or gone.`);
    }
    return res.text();
  }

  throw new SnapshotError("That link redirects too many times. Paste the final product URL directly.");
}

/**
 * Step 2 — strip the DOM down to human-readable text with cheerio.
 * Scripts, styles, and chrome (nav/footer/svg/iframes) are pure token
 * waste for the LLM; the visible text is where the price lives.
 */
export function cleanHtml(html: string): string {
  const $ = cheerio.load(html);

  $("script, style, noscript, svg, iframe, link, meta, template, nav, footer, form, video, audio, canvas").remove();

  const title = $("title").text().trim();
  const body = $("body").text();

  // Collapse the whitespace soup cheerio leaves behind, then cap length.
  const compact = `${title}\n${body}`.replace(/\s+/g, " ").trim();
  const clean = compact.slice(0, MAX_CLEAN_TEXT_CHARS);

  if (clean.length < 100) {
    throw new SnapshotError("That page returned almost no readable content — it may require a login or block automated access.");
  }
  return clean;
}

/** Lazy Gemini client — same rationale as the Supabase singleton. */
let genAI: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (genAI) return genAI;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your-gemini-api-key") {
    throw new SnapshotError("Gemini is not configured. Set GEMINI_API_KEY in .env.local.");
  }
  genAI = new GoogleGenAI({ apiKey });
  return genAI;
}

/**
 * Step 3 — ask Gemini to read the messy page text like a human would.
 * `responseSchema` forces strict JSON, but we still validate every field:
 * an LLM can hallucinate a schema-valid answer (e.g. price 0, a made-up
 * currency, or the "was" price instead of the live one).
 */
async function extractWithGemini(cleanText: string, url: string): Promise<ProductSnapshot> {
  const prompt = `You are a precise e-commerce data extractor. Below is the visible text of a retail product page (${url}).

Extract:
- product_name: the main product's title, concisely.
- current_price: the price the customer would PAY NOW, as a plain number. Prefer the sale/deal price over any struck-through "was"/"list" price. If several sellers are shown, use the primary buy-box price. Use 0 only if no price is visible.
- currency_code: the ISO 4217 code of that price (USD, GBP, EUR, CAD, JPY, …). Infer from the symbol and the store's country if not written out.
- stock_status: "in_stock", "out_of_stock", or "unknown".

PAGE TEXT:
${cleanText}`;

  let rawText: string | undefined;
  try {
    const response = await getGemini().models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            product_name: { type: Type.STRING },
            current_price: { type: Type.NUMBER },
            currency_code: { type: Type.STRING },
            stock_status: {
              type: Type.STRING,
              enum: ["in_stock", "out_of_stock", "unknown"],
            },
          },
          required: ["product_name", "current_price", "currency_code", "stock_status"],
        },
        // Extraction doesn't need chain-of-thought; skipping it keeps the
        // request fast and cheap on the free tier.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    rawText = response.text;
  } catch (err) {
    if (err instanceof SnapshotError) throw err;
    // Full detail to the server console; a clean generic line to the user.
    console.error("[scraper] Gemini call failed:", err);
    throw new SnapshotError("The AI extraction service is unavailable right now. Try again shortly.");
  }

  return parseSnapshot(rawText);
}

/** Defensive JSON parsing + semantic validation of the model's answer. */
export function parseSnapshot(rawText: string | undefined): ProductSnapshot {
  if (!rawText) {
    throw new SnapshotError("The AI returned an empty response. Try again.");
  }

  // Models occasionally wrap JSON in markdown fences despite the MIME type.
  const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new SnapshotError("The AI response wasn't valid JSON. Try again.");
  }

  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.product_name === "string" ? obj.product_name.trim() : "";
  // Tolerate "1,299.99" — schema says NUMBER but hallucinations happen.
  const price =
    typeof obj.current_price === "number"
      ? obj.current_price
      : Number(String(obj.current_price ?? "").replace(/[$,]/g, ""));
  const stock: StockStatus =
    obj.stock_status === "in_stock" || obj.stock_status === "out_of_stock" ? obj.stock_status : "unknown";
  // Only accept a plausible ISO 4217 shape; anything else degrades to USD.
  const rawCurrency = typeof obj.currency_code === "string" ? obj.currency_code.trim().toUpperCase() : "";
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : "USD";

  if (!name) {
    throw new SnapshotError("Couldn't identify a product on that page. Make sure the link goes directly to a product.");
  }
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000) {
    throw new SnapshotError("Couldn't read a believable price from that page. The store may be blocking automated access.");
  }
  if (price === 0) {
    throw new SnapshotError("No price was visible on that page — it may be region-locked or require login.");
  }

  return {
    product_name: name.slice(0, 200),
    current_price: Math.round(price * 100) / 100,
    currency_code: currency,
    stock_status: stock,
  };
}

/** The full pipeline. */
export async function fetchProductSnapshot(url: string): Promise<ProductSnapshot> {
  const html = await fetchRawHtml(url);
  const cleanText = cleanHtml(html);
  return extractWithGemini(cleanText, url);
}
