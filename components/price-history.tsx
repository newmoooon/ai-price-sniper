"use client";

import { ArrowDownRight, ArrowUpRight, BadgeCheck, Minus } from "lucide-react";
import type { Product } from "@/lib/types";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Past-prices table — the browsable complement to the trend chart (and the
 * accessible fallback for it). Newest check first; each row shows the move
 * vs the previous check with an arrow + amount so direction is never
 * conveyed by color alone. Rows at or below target get a subtle highlight.
 */
export function PriceHistory({ product }: { product: Product }) {
  const logs = [...product.price_logs].reverse(); // newest first

  if (logs.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed">
        <p className="px-6 text-center text-sm text-muted-foreground">
          No checks logged yet — history appears after the first price check.
        </p>
      </div>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Checked</th>
            <th className="px-3 py-2 text-right font-medium">Price</th>
            <th className="px-3 py-2 text-right font-medium">Change</th>
            <th className="px-3 py-2 text-right font-medium">Stock</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log, i) => {
            // `logs` is newest-first, so the previous check is the NEXT row.
            const prev = logs[i + 1];
            const delta = prev ? log.price - prev.price : null;
            // An estimated baseline point at/below target is a guess, not a
            // deal we saw — no highlight, no badge.
            const hitTarget = !log.is_estimate && log.price <= product.target_price;

            return (
              <tr
                key={log.id}
                className={cn("border-b last:border-0", hitTarget && "bg-emerald-500/5")}
              >
                <td className="px-3 py-2 text-muted-foreground">
                  {new Date(log.checked_at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    // Backfilled timestamps carry no meaningful time of day.
                    ...(log.is_estimate ? {} : { hour: "numeric", minute: "2-digit" }),
                  })}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    {hitTarget && (
                      <BadgeCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-label="At or below target" />
                    )}
                    {log.is_estimate && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
                        est.
                      </span>
                    )}
                    {formatMoney(log.price, log.currency_code)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {delta === null ? (
                    <span className="text-muted-foreground">
                      {log.is_estimate ? "baseline start" : "first check"}
                    </span>
                  ) : delta === 0 ? (
                    <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                      <Minus className="h-3 w-3" aria-hidden /> no change
                    </span>
                  ) : delta < 0 ? (
                    <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
                      <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />
                      {formatMoney(Math.abs(delta), log.currency_code)}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-0.5 text-red-700 dark:text-red-400">
                      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                      {formatMoney(delta, log.currency_code)}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                  {log.stock_status === "in_stock" ? "In stock" : log.stock_status === "out_of_stock" ? "Out of stock" : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
