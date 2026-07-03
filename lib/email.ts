import { Resend } from "resend";
import { formatMoney } from "@/lib/format";

/**
 * Deal-alert email, sent by the daily cron when a tracked product's price
 * crosses at or below the user's target.
 */

let resend: Resend | null = null;
function getResend(): Resend {
  if (resend) return resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.startsWith("re_your")) {
    throw new Error("Resend is not configured. Set RESEND_API_KEY in .env.local.");
  }
  resend = new Resend(apiKey);
  return resend;
}

export interface DealAlert {
  to: string;
  productName: string;
  productUrl: string;
  currentPrice: number;
  targetPrice: number;
  /** ISO 4217 code extracted by Gemini (defaults to USD) */
  currencyCode?: string;
}

/**
 * Table-based layout + inline styles: the only markup that renders
 * consistently across Gmail/Outlook/Apple Mail. Kept intentionally light —
 * one card, one hero price, one CTA.
 */
function renderDealEmail(alert: DealAlert): string {
  const usd = (n: number) => formatMoney(n, alert.currencyCode);
  const saved = alert.targetPrice - alert.currentPrice;
  const savedLine =
    saved > 0
      ? `<p style="margin:0 0 24px;color:#166534;font-size:14px;">That's ${usd(saved)} <em>below</em> your target.</p>`
      : `<p style="margin:0 0 24px;color:#166534;font-size:14px;">Your target price has been hit exactly.</p>`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f2;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e0;">
          <!-- Header -->
          <tr><td style="background:#0b0b0b;padding:20px 32px;">
            <span style="color:#ffffff;font-size:15px;font-weight:700;letter-spacing:0.4px;">🎯 AI Price Sniper</span>
          </td></tr>
          <!-- Body -->
          <tr><td style="padding:32px;">
            <p style="margin:0 0 8px;color:#16a34a;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Deal reached</p>
            <h1 style="margin:0 0 16px;color:#0b0b0b;font-size:20px;line-height:1.35;">${escapeHtml(alert.productName)}</h1>
            <p style="margin:0 0 4px;color:#52514e;font-size:14px;">is now selling for</p>
            <p style="margin:0 0 4px;color:#0b0b0b;font-size:40px;font-weight:800;">${usd(alert.currentPrice)}</p>
            ${savedLine}
            <a href="${escapeHtml(alert.productUrl)}"
               style="display:inline-block;background:#0b0b0b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;">
              Grab the deal →
            </a>
          </td></tr>
          <!-- Footer -->
          <tr><td style="padding:20px 32px;border-top:1px solid #efefec;">
            <p style="margin:0;color:#898781;font-size:12px;line-height:1.6;">
              You set a target of ${usd(alert.targetPrice)} for this product.
              AI Price Sniper checks prices once a day.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/** Product names come from scraped pages — never trust them in HTML. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendDealAlert(alert: DealAlert): Promise<void> {
  const from = process.env.ALERT_FROM_EMAIL || "AI Price Sniper <onboarding@resend.dev>";

  const { error } = await getResend().emails.send({
    from,
    to: alert.to,
    subject: `🎯 Deal reached: ${alert.productName.slice(0, 80)} is ${formatMoney(alert.currentPrice, alert.currencyCode)}`,
    html: renderDealEmail(alert),
  });

  if (error) {
    throw new Error(`Resend rejected the email: ${error.message}`);
  }
}
