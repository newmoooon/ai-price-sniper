"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
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
 * Price-history trend for one product: a smooth monotone area with a soft
 * gradient fill under the curve.
 *
 * Design notes (single-series chart):
 * - Colors come from the --viz-* CSS variables in globals.css so the chart
 *   re-themes automatically in dark mode — no JS theme plumbing.
 * - The series is drawn as TWO segments of the same hue: the AI-estimated
 *   30-day baseline (dashed, faint fill) and real checks (solid, gradient
 *   fill). Dash pattern — not color — carries the distinction, so it
 *   survives colorblindness and grayscale printing; a caption spells it out.
 * - One y-axis; the target price is a dotted ReferenceLine, not a second
 *   series, so no legend box is needed (labels sit on the lines).
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
  isEstimate: boolean;
  /** Series split: baseline segment (dashed) vs live checks (solid). */
  baseline: number | null;
  observed: number | null;
}

function toChartData(product: Product): ChartPoint[] {
  const logs = product.price_logs;
  // The first real check also anchors the baseline segment, so the dashed
  // and solid curves meet instead of leaving a gap.
  const firstObservedIdx = logs.findIndex((l) => !l.is_estimate);
  const hasBaseline = logs.some((l) => l.is_estimate);

  return logs.map((log, i) => {
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
      isEstimate: log.is_estimate,
      baseline:
        log.is_estimate || (hasBaseline && i === firstObservedIdx) ? log.price : null,
      observed: log.is_estimate ? null : log.price,
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
      <p className="text-xs text-muted-foreground">
        {point.isEstimate ? point.full.split(",")[0] ?? point.full : point.full}
      </p>
      <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold tabular-nums">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--viz-series)" }} />
        {point.priceLabel}
      </p>
      {point.isEstimate && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">AI-estimated baseline</p>
      )}
    </div>
  );
}

export function PriceChart({ product }: { product: Product }) {
  const data = toChartData(product);
  const gradientId = useId();
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
  const hasBaseline = data.some((d) => d.isEstimate);

  return (
    <div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
            <defs>
              {/* Soft fade under the live curve; near-transparent under the
                  estimated baseline so the real data visually dominates. */}
              <linearGradient id={`${gradientId}-observed`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--viz-series)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--viz-series)" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id={`${gradientId}-baseline`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--viz-series)" stopOpacity={0.1} />
                <stop offset="100%" stopColor="var(--viz-series)" stopOpacity={0.01} />
              </linearGradient>
            </defs>
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
            {/* User's goal line — dotted, labeled directly, no legend needed */}
            <ReferenceLine
              y={product.target_price}
              stroke="var(--viz-target)"
              strokeDasharray="2 6"
              strokeLinecap="round"
              label={{
                value: `Target ${fmt(product.target_price)}`,
                position: "insideBottomRight",
                fill: "var(--viz-axis)",
                fontSize: 11,
              }}
            />
            {/* Estimated 30-day baseline: dashed stroke, faint fill, no dots */}
            {hasBaseline && (
              <Area
                type="monotone"
                dataKey="baseline"
                stroke="var(--viz-series)"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                strokeOpacity={0.55}
                fill={`url(#${gradientId}-baseline)`}
                dot={false}
                activeDot={{ r: 4, fill: "var(--viz-series)", fillOpacity: 0.6, stroke: "var(--background)", strokeWidth: 1.5 }}
                isAnimationActive={false}
              />
            )}
            {/* Live checks: solid monotone curve over the gradient fill */}
            <Area
              type="monotone"
              dataKey="observed"
              stroke="var(--viz-series)"
              strokeWidth={2}
              fill={`url(#${gradientId}-observed)`}
              // Checks at/below target render as "good" green dots, so the
              // moments the target was hit are visible at a glance.
              dot={(props: { key?: React.Key | null; cx?: number; cy?: number; payload?: ChartPoint }) => {
                if (props.payload?.observed == null) return <g key={props.key} />;
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
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {/* Identity for the two segments is carried by dash pattern; this
          caption names it for everyone (and for screen readers). */}
      {hasBaseline && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          <span aria-hidden>┄</span> dashed = AI-estimated 30-day baseline ·{" "}
          <span aria-hidden>—</span> solid = live price checks
        </p>
      )}
    </div>
  );
}
