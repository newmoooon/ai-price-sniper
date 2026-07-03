"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import { productCurrency, type Product } from "@/lib/types";
import { formatMoney } from "@/lib/format";

/**
 * Price-history trend line for one product.
 *
 * Design notes (single-series chart):
 * - Colors come from the --viz-* CSS variables in globals.css so the chart
 *   re-themes automatically in dark mode — no JS theme plumbing.
 * - One y-axis; the target price is a dashed ReferenceLine, not a second
 *   series, so no legend is needed (the card title names the series).
 * - Fewer than 2 data points can't draw a trend, so we render a calm
 *   placeholder instead of an empty axis frame.
 */

interface ChartPoint {
  /** Short axis label, e.g. "Jul 2" */
  label: string;
  /** Full timestamp for the tooltip */
  full: string;
  price: number;
  /** Pre-formatted in the log's own currency, for the tooltip */
  priceLabel: string;
}

function toChartData(product: Product): ChartPoint[] {
  return product.price_logs.map((log) => {
    const d = new Date(log.checked_at);
    return {
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      full: d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
      price: log.price,
      priceLabel: formatMoney(log.price, log.currency_code),
    };
  });
}

/** Crosshair tooltip — values in ink tokens, identity via the colored dot. */
function PriceTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-popover-foreground shadow-md">
      <p className="text-xs text-muted-foreground">{point.full}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold tabular-nums">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--viz-series)" }} />
        {point.priceLabel}
      </p>
    </div>
  );
}

export function PriceChart({ product }: { product: Product }) {
  const data = toChartData(product);
  // Axis/labels format in the product's own currency (from its latest log).
  const fmt = (n: number) => formatMoney(n, productCurrency(product));

  // ── Empty / just-added state ──────────────────────────────────────────
  if (data.length < 2) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted">
          <LineChartIcon className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>
        <div className="space-y-1 px-6">
          <p className="text-sm font-medium">
            {data.length === 1 ? `Tracking started at ${data[0].priceLabel}` : "No price history yet"}
          </p>
          <p className="text-xs text-muted-foreground">
            The trend line appears after the next check — every product is re-checked daily.
          </p>
        </div>
      </div>
    );
  }

  // ── Y domain: pad the observed range and always include the target ────
  const prices = data.map((d) => d.price);
  const lowest = Math.min(...prices);
  const lo = Math.min(lowest, product.target_price);
  const hi = Math.max(...prices, product.target_price);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.02, 1);
  // The Keepa question — "is today's price actually good historically?" —
  // only worth a line once there's history and it doesn't sit on the target.
  const showLowest = data.length >= 3 && Math.abs(lowest - product.target_price) > pad * 0.3;

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="var(--viz-grid)" strokeDasharray="0" vertical={false} />
          <XAxis
            dataKey="label"
            stroke="var(--viz-axis)"
            tick={{ fill: "var(--viz-axis)", fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: "var(--viz-grid)" }}
            minTickGap={24}
          />
          <YAxis
            width={56}
            domain={[Math.max(0, lo - pad), hi + pad]}
            stroke="var(--viz-axis)"
            tick={{ fill: "var(--viz-axis)", fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={fmt}
          />
          <Tooltip content={<PriceTooltip />} cursor={{ stroke: "var(--viz-axis)", strokeDasharray: "3 3" }} />
          {/* Historical floor — the honest "is this actually a deal?" line */}
          {showLowest && (
            <ReferenceLine
              y={lowest}
              stroke="var(--viz-good)"
              strokeDasharray="2 4"
              label={{
                value: `Lowest ${fmt(lowest)}`,
                position: "insideTopLeft",
                fill: "var(--viz-axis)",
                fontSize: 11,
              }}
            />
          )}
          {/* User's goal line — labeled directly, so no legend is needed */}
          <ReferenceLine
            y={product.target_price}
            stroke="var(--viz-target)"
            strokeDasharray="6 4"
            label={{
              value: `Target ${fmt(product.target_price)}`,
              position: "insideBottomRight",
              fill: "var(--viz-axis)",
              fontSize: 11,
            }}
          />
          <Line
            type="monotone"
            dataKey="price"
            stroke="var(--viz-series)"
            strokeWidth={2}
            // Checks at/below target render as "good" green dots, so the
            // moments the target was hit are visible at a glance.
            dot={(props: { key?: React.Key | null; cx?: number; cy?: number; payload?: ChartPoint }) => {
              const hit = (props.payload?.price ?? Infinity) <= product.target_price;
              return (
                <circle
                  key={props.key}
                  cx={props.cx}
                  cy={props.cy}
                  r={hit ? 4 : 3}
                  fill={hit ? "var(--viz-good)" : "var(--viz-series)"}
                  stroke="var(--background)"
                  strokeWidth={hit ? 1.5 : 0}
                />
              );
            }}
            activeDot={{ r: 5, fill: "var(--viz-series)", stroke: "var(--background)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
