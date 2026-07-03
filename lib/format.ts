/**
 * Currency display via the platform's own `Intl.NumberFormat` — correct
 * symbols, separators, and decimal rules for any ISO 4217 code with zero
 * dependencies. Works identically in the browser, Server Actions, and the
 * cron worker (Node ships full ICU).
 */
export function formatMoney(amount: number, currencyCode: string = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(amount);
  } catch {
    // Gemini occasionally invents a currency code; Intl throws on invalid
    // codes, so fall back to a plain-but-honest rendering instead of crashing.
    return `${currencyCode} ${amount.toFixed(2)}`;
  }
}
