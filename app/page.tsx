"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  BadgeCheck,
  BellRing,
  Check,
  Crosshair,
  ExternalLink,
  Globe,
  Link2,
  LinkIcon,
  Loader2,
  Mail,
  Moon,
  PackageX,
  Pencil,
  Radar,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Sun,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  Unlink,
} from "lucide-react";

import {
  deleteProduct,
  getDashboardData,
  recheckProduct,
  trackProduct,
  updateTargetPrice,
} from "@/app/actions";
import {
  latestLog,
  observedLogs,
  productCurrency,
  productStatus,
  targetHit,
  type Product,
  type ProductStatus,
} from "@/lib/types";
import { formatMoney } from "@/lib/format";
import { dealTier, dropConfidence, type DealTier } from "@/lib/trend";
import { askSniper, Assistant } from "@/components/assistant";
import { PriceChart } from "@/components/price-chart";
import { PriceHistory } from "@/components/price-history";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/* ────────────────────────── status badges ────────────────────────── */

/**
 * Real-time state chips, derived in lib/types.ts from link-health + the
 * newest price log. Every badge pairs an icon with its label so state is
 * never conveyed by color alone (accessibility + print).
 */
function StatusBadge({ status }: { status: ProductStatus }) {
  switch (status) {
    case "deal":
      return (
        <Badge className="gap-1 border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
          <BadgeCheck className="h-3 w-3" aria-hidden /> Target Slashed!
        </Badge>
      );
    case "out_of_stock":
      return (
        <Badge className="gap-1 border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-400">
          <PackageX className="h-3 w-3" aria-hidden /> Out of Stock
        </Badge>
      );
    case "invalid":
      return (
        <Badge className="gap-1 border-transparent bg-red-500/10 text-red-700 dark:text-red-400">
          <Unlink className="h-3 w-3" aria-hidden /> Invalid Link
        </Badge>
      );
    default:
      return (
        <Badge className="gap-1 border-transparent bg-primary/10 text-primary">
          <Radar className="h-3 w-3" aria-hidden /> Monitoring
        </Badge>
      );
  }
}

/**
 * "Deal Tier" — the live price positioned against the full historical
 * array (real checks + the estimated 30-day baseline). Emoji + text carry
 * the meaning together, so the tier is never conveyed by color alone.
 */
const DEAL_TIER_STYLE: Record<DealTier, { label: string; className: string }> = {
  all_time_low: {
    label: "🔥 All-Time Low",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  below_average: {
    label: "📉 Below Average",
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  average: {
    label: "💎 Average Price",
    className: "bg-primary/10 text-primary",
  },
  above_average: {
    label: "📈 Above Average",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  scalper: {
    label: "⚠️ Scalper Pricing Detected",
    className: "bg-red-500/10 text-red-700 dark:text-red-400",
  },
};

function DealTierBadge({ product }: { product: Product }) {
  const tier = dealTier(product.price_logs);
  if (!tier) return null;
  const { label, className } = DEAL_TIER_STYLE[tier];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        className
      )}
    >
      {label}
    </span>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function Dashboard() {
  // `null` = first load in flight → skeletons. `[]` = loaded, but empty.
  const [products, setProducts] = useState<Product[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track form
  const [url, setUrl] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [email, setEmail] = useState("");
  const [isTracking, startTracking] = useTransition();

  // Per-card async work (re-check / delete) so one busy card doesn't lock the page.
  const [busyId, setBusyId] = useState<string | null>(null);

  /* ── data loading ── */
  const load = useCallback(async () => {
    const result = await getDashboardData();
    if (result.ok) {
      setProducts(result.data);
    } else {
      setProducts([]);
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getDashboardData().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setProducts(result.data);
      } else {
        setProducts([]);
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── derived state ── */
  const selected = useMemo(() => {
    if (!products || products.length === 0) return null;
    return products.find((p) => p.id === selectedId) ?? products[0];
  }, [products, selectedId]);

  const dealCount = useMemo(
    () => (products ?? []).filter((p) => productStatus(p) === "deal").length,
    [products]
  );

  /* ── actions ── */
  function handleTrack(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTracking(async () => {
      const result = await trackProduct({ url, targetPrice: Number(targetPrice), email });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Replace if this URL was already tracked, otherwise prepend.
      setProducts((prev) => {
        const rest = (prev ?? []).filter((p) => p.id !== result.data.id);
        return [result.data, ...rest];
      });
      setSelectedId(result.data.id);
      setUrl("");
      setTargetPrice("");
    });
  }

  async function handleRecheck(id: string) {
    setBusyId(id);
    try {
      const result = await recheckProduct(id);
      if (!result.ok) {
        toast.error(result.error);
        // The check may have flipped this product to "Invalid Link" —
        // reload so the badge reflects the stored link-health.
        await load();
        return;
      }
      setProducts((prev) => (prev ?? []).map((p) => (p.id === id ? result.data : p)));
      toast.success("Price re-checked");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      const result = await deleteProduct(id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setProducts((prev) => (prev ?? []).filter((p) => p.id !== id));
      if (selectedId === id) setSelectedId(null);
      toast.success("Stopped tracking");
    } finally {
      setBusyId(null);
    }
  }

  const isEmpty = products !== null && products.length === 0;

  /* ── render ── */
  return (
    <div className="relative flex-1">
      {/* Decorative brand glow + dot grid, behind everything */}
      <div className="page-backdrop pointer-events-none absolute inset-0 -z-10" aria-hidden />

      {/* Sticky, blurred nav — reads as a real product, not a page */}
      <nav className="sticky top-0 z-30 border-b border-border/50 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
              <Crosshair className="h-4 w-4" aria-hidden />
            </div>
            <span className="text-sm font-semibold tracking-tight">AI Price Sniper</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
              <Sparkles className="h-3 w-3 text-primary" aria-hidden />
              Powered by Gemini
            </Badge>
            {/* Manual theme override; the layout script restores it on load */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle dark mode"
              onClick={() => {
                const dark = document.documentElement.classList.toggle("dark");
                try {
                  localStorage.setItem("theme", dark ? "dark" : "light");
                } catch {}
              }}
            >
              <Sun className="h-4 w-4 dark:hidden" aria-hidden />
              <Moon className="hidden h-4 w-4 dark:block" aria-hidden />
            </Button>
          </div>
        </div>
      </nav>

      <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        {/* ── Hero ─────────────────────────────────────────────────── */}
        <header className="mx-auto max-w-2xl pb-10 pt-12 text-center sm:pt-16">
          <h1 className="rise font-heading text-balance text-5xl font-medium tracking-tight sm:text-6xl">
            Name your price.
            <br />
            <span className="text-brand-gradient italic">We&apos;ll catch the drop.</span>
          </h1>
          <p className="rise rise-1 mx-auto mt-4 max-w-xl text-pretty text-muted-foreground">
            Paste any product link. Gemini reads the live page — no fragile scrapers — then the
            price is re-checked every day and you get an email the moment it hits your number.
          </p>
        </header>

        {/* ── Track form ───────────────────────────────────────────── */}
        <Card className="rise rise-2 mx-auto mb-3 max-w-4xl shadow-lg shadow-primary/5">
          <CardContent>
            <form onSubmit={handleTrack} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_150px_220px_auto]">
              <Field label="Product link" className="sm:col-span-2 lg:col-span-1">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="url"
                  required
                  placeholder="https://www.amazon.com/dp/…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={isTracking}
                  className="h-10 pl-9"
                  aria-label="Product URL"
                />
              </Field>
              <Field label="Target price">
                <Target className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="number"
                  required
                  min="0.01"
                  step="0.01"
                  placeholder="99.99"
                  value={targetPrice}
                  onChange={(e) => setTargetPrice(e.target.value)}
                  disabled={isTracking}
                  className="h-10 pl-9"
                  aria-label="Target price"
                />
              </Field>
              <Field label="Email for the alert (optional)">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  type="email"
                  placeholder="you@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isTracking}
                  className="h-10 pl-9"
                  aria-label="Email for deal alerts"
                />
              </Field>
              <div className="flex flex-col justify-end">
                <Button type="submit" disabled={isTracking} className="h-10 min-w-32 shadow-sm">
                  {isTracking ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sniping…
                    </>
                  ) : (
                    <>
                      <Crosshair className="h-4 w-4" aria-hidden /> Track price
                    </>
                  )}
                </Button>
              </div>
            </form>
            {isTracking && (
              <div className="mt-3 space-y-2">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Sparkles className="h-3 w-3 text-primary" aria-hidden />
                  Fetching the page, asking Gemini to read it, then researching a 30-day price baseline — usually 10–30 seconds.
                </p>
                {/* Indeterminate shimmer so the wait feels alive */}
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-[shimmer_1.4s_ease-in-out_infinite] rounded-full bg-primary/60" />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="rise rise-3 mb-4 text-center text-xs text-muted-foreground">
          Free · No account needed · Email optional · Checked daily
        </p>

        {/* ── Error banner ─────────────────────────────────────────── */}
        {error && (
          <div
            role="alert"
            className="mx-auto mb-4 flex max-w-4xl items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        {/* ── How it works (shown until something is tracked) ──────── */}
        {(products === null || isEmpty) && (
          <div className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-3">
            <div className="rise rise-2">
              <Step
                icon={<Link2 className="h-4 w-4" aria-hidden />}
                n={1}
                title="Paste a link"
                text="Amazon, Best Buy, Target — any store with a public product page."
              />
            </div>
            <div className="rise rise-3">
              <Step
                icon={<ScanSearch className="h-4 w-4" aria-hidden />}
                n={2}
                title="Gemini reads the page"
                text="The live page text is parsed by AI, so there's no scraper to break."
              />
            </div>
            <div className="rise rise-4">
              <Step
                icon={<BellRing className="h-4 w-4" aria-hidden />}
                n={3}
                title="Get the alert"
                text="Prices are re-checked daily. When yours hits target, you get an email."
              />
            </div>
          </div>
        )}

        {/* ── Dashboard body ───────────────────────────────────────── */}
        {products === null ? (
          <LoadingSkeleton />
        ) : isEmpty ? null : (
          <div className="rise rise-3 mt-10">
            {/* Stat tiles */}
            <div className="mb-6 grid grid-cols-3 gap-3">
              <StatTile label="Tracked products" value={products.length} />
              <StatTile label="Deals reached" value={dealCount} highlight={dealCount > 0} />
              <StatTile
                label="Price points logged"
                value={products.reduce((n, p) => n + observedLogs(p).length, 0)}
              />
            </div>

            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
              {/* ── Product list ── */}
              <div className="space-y-3">
                {products.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    selected={selected?.id === product.id}
                    busy={busyId === product.id}
                    onSelect={() => setSelectedId(product.id)}
                    onRecheck={() => handleRecheck(product.id)}
                    onDelete={() => handleDelete(product.id)}
                  />
                ))}
              </div>

              {/* ── Analysis panel (keyed so edit state resets per product) ── */}
              {selected && (
                <AnalysisPanel
                  key={selected.id}
                  product={selected}
                  onUpdate={(p) => setProducts((prev) => (prev ?? []).map((x) => (x.id === p.id ? p : x)))}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer className="border-t border-border/50 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 text-xs text-muted-foreground sm:px-6">
          <span className="inline-flex items-center gap-1.5">
            <Crosshair className="h-3.5 w-3.5" aria-hidden />
            AI Price Sniper
          </span>
          <span>Built with Next.js · Gemini · Supabase · Recharts · Resend</span>
        </div>
      </footer>

      {/* Floating "Ask Sniper" chat, grounded in the tracked products */}
      <Assistant />
    </div>
  );
}

/* ────────────────────────── sub-components ────────────────────────── */

/** Labeled form field wrapper (label sits above, icon inside the input). */
function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <span className="relative block">{children}</span>
    </label>
  );
}

/** One "how it works" step. */
function Step({
  icon,
  n,
  title,
  text,
}: {
  icon: React.ReactNode;
  n: number;
  title: string;
  text: string;
}) {
  return (
    <div className="rounded-xl border bg-card/60 p-4 backdrop-blur-sm">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </span>
        <span className="text-xs font-medium text-muted-foreground">Step {n}</span>
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}

/** Right-hand panel: trend chart + drop-confidence indicator. */
function AnalysisPanel({ product, onUpdate }: { product: Product; onUpdate: (p: Product) => void }) {
  const currency = productCurrency(product);
  const confidence = dropConfidence(product.price_logs);
  const hit = targetHit(product);
  const latest = latestLog(product);

  // Inline target-price editing (pencil → input → save)
  const [editing, setEditing] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [isSaving, startSaving] = useTransition();

  function saveTarget() {
    startSaving(async () => {
      const result = await updateTargetPrice(product.id, Number(targetInput));
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      onUpdate(result.data);
      setEditing(false);
      toast.success("Target price updated");
    });
  }

  return (
    <Card className="lg:sticky lg:top-6">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate" title={product.product_name}>
              {product.product_name}
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-x-1">
              {editing ? (
                <span className="inline-flex items-center gap-1.5">
                  Target
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    autoFocus
                    value={targetInput}
                    onChange={(e) => setTargetInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveTarget();
                      if (e.key === "Escape") setEditing(false);
                    }}
                    disabled={isSaving}
                    className="h-6 w-24 px-2 text-xs"
                    aria-label="New target price"
                  />
                  <Button size="icon-xs" onClick={saveTarget} disabled={isSaving} aria-label="Save target price">
                    {isSaving ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
                  </Button>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  Target {formatMoney(product.target_price, currency)}
                  <button
                    type="button"
                    onClick={() => {
                      setTargetInput(String(product.target_price));
                      setEditing(true);
                    }}
                    aria-label="Edit target price"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Pencil className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              )}
              <span>{product.user_email ? `· alerts to ${product.user_email}` : "· dashboard-only (no email)"}</span>
            </CardDescription>
          </div>
          <StatusBadge status={productStatus(product)} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Link-health detail when the last automated check failed */}
        {product.last_error && (
          <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            <LinkIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Last check failed: {product.last_error}
          </p>
        )}

        {/* Target-hit callout: exactly when the price reached their number */}
        {hit && (
          <p className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
            <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Hit your target on{" "}
            {new Date(hit.checked_at).toLocaleDateString("en-US", { month: "long", day: "numeric" })} at{" "}
            {formatMoney(hit.price, hit.currency_code)} — and has stayed at or below it since.
          </p>
        )}

        {/* Chart ↔ table: same data, two readings (trend vs exact values) */}
        <Tabs defaultValue="trend">
          <TabsList className="mb-1">
            <TabsTrigger value="trend">Trend</TabsTrigger>
            <TabsTrigger value="history">Past prices</TabsTrigger>
          </TabsList>
          <TabsContent value="trend">
            <PriceChart product={product} />
          </TabsContent>
          <TabsContent value="history">
            <PriceHistory product={product} />
          </TabsContent>
        </Tabs>

        {/* ── Predictive trend analysis ── */}
        <div className="rounded-xl border p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden />
              Drop confidence
            </p>
            <p className="text-sm font-semibold tabular-nums">
              {confidence === null ? "—" : `${confidence}%`}
            </p>
          </div>
          <Progress value={confidence ?? 0} aria-label="Confidence the price will drop further" />
          <p className="mt-2 text-xs text-muted-foreground">
            {confidence === null
              ? "Gathering data — the score appears after the second price check."
              : confidence >= 65
                ? "Signals lean toward a further drop: hold your fire."
                : confidence >= 35
                  ? "Mixed signals — the price could move either way."
                  : "Little room left to fall — today's price is likely the deal."}
          </p>
        </div>

        {/* Hand the product to the web-searching agent */}
        <Button
          variant="outline"
          className="w-full"
          onClick={() =>
            askSniper(
              `Search the web: which other stores sell "${product.product_name}" right now, and is any of them cheaper than ${formatMoney(latest?.price ?? product.target_price, currency)}? Also, does that price match what my dashboard has logged?`
            )
          }
        >
          <Globe className="h-4 w-4" aria-hidden />
          Find it cheaper elsewhere
        </Button>
      </CardContent>
    </Card>
  );
}

/** Eases a number from 0 to its value on mount/change — makes stats feel alive. */
function useCountUp(target: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let start: number | null = null;
    let raf = 0;
    const duration = 650;
    const step = (t: number) => {
      if (start === null) start = t;
      const p = Math.min(1, (t - start) / duration);
      setValue(Math.round(target * (1 - Math.pow(1 - p, 3)))); // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
}

function StatTile({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  const shown = useCountUp(value);
  return (
    <Card size="sm">
      <CardContent>
        <p className={cn("text-2xl font-semibold tabular-nums", highlight && "text-emerald-600 dark:text-emerald-400")}>
          {shown}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function ProductCard({
  product,
  selected,
  busy,
  onSelect,
  onRecheck,
  onDelete,
}: {
  product: Product;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onRecheck: () => void;
  onDelete: () => void;
}) {
  const log = latestLog(product);
  const status = productStatus(product);
  const currency = productCurrency(product);
  const host = new URL(product.url).hostname.replace(/^www\./, "");

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      className={cn(
        "lift cursor-pointer hover:shadow-md",
        selected && "ring-2 ring-primary/50"
      )}
      aria-pressed={selected}
    >
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={product.product_name}>
              {product.product_name}
            </p>
            <p className="text-xs text-muted-foreground">{host}</p>
          </div>
          <StatusBadge status={status} />
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-2xl font-semibold tabular-nums">
              {log ? formatMoney(log.price, log.currency_code) : "—"}
            </span>
            <DealTierBadge product={product} />
            <span className="text-xs text-muted-foreground">
              target {formatMoney(product.target_price, currency)}
            </span>
            {log && log.price > product.target_price && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatMoney(log.price - product.target_price, currency)} to go
              </span>
            )}
            <TrendChip product={product} />
          </div>
          <Sparkline product={product} />
        </div>

        <Separator className="my-3" />

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {observedLogs(product).length} check{observedLogs(product).length === 1 ? "" : "s"}
            {product.price_logs.some((l) => l.is_estimate) && " · 30-day baseline"}
            {log && ` · last ${new Date(log.checked_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
          </p>
          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            {/* Base UI composes via `render` (its asChild equivalent) */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open product page"
              nativeButton={false}
              render={<a href={product.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" onClick={onRecheck} disabled={busy} aria-label="Re-check price now">
              <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onDelete}
              disabled={busy}
              aria-label="Stop tracking"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Tiny inline 30-day-ish trend for a product card — pure SVG, no library. */
function Sparkline({ product }: { product: Product }) {
  const prices = product.price_logs.map((l) => l.price);
  if (prices.length < 2) return null;

  const w = 88;
  const h = 30;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const points = prices
    .map((p, i) => {
      const x = (i / (prices.length - 1)) * (w - 4) + 2;
      const y = h - 3 - ((p - min) / range) * (h - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="var(--viz-series)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** "↓ 12% since tracking" chip — overall move from the first REAL check
 *  (the estimated baseline is context, not something we tracked). */
function TrendChip({ product }: { product: Product }) {
  const logs = observedLogs(product);
  if (logs.length < 2) return null;
  const first = logs[0].price;
  const last = logs[logs.length - 1].price;
  if (first <= 0) return null;
  const pct = ((last - first) / first) * 100;
  if (Math.abs(pct) < 0.5) return null; // flat — not worth a chip
  const down = pct < 0;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        down
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "bg-red-500/10 text-red-700 dark:text-red-400"
      )}
    >
      {down ? <TrendingDown className="h-3 w-3" aria-hidden /> : <TrendingUp className="h-3 w-3" aria-hidden />}
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

/** Mirrors the loaded layout so the page doesn't jump when data arrives. */
function LoadingSkeleton() {
  return (
    <div className="mt-10 space-y-6">
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}
