"use client";

// ── V2 accuracy-layer UI primitives ──────────────────────────────────────────
//
// Everything the seven-filter engine surfaces: the BTC regime bar, verdict
// chips, final-score pills, the filter checklist, ATR-sized trade plans with
// dollar risk framing, the scenario map, and wall/warning readouts.

import { AlertTriangle, ArrowDownRight, ArrowUpRight, Ban, Crosshair, Eye, Landmark, ShieldAlert, TrendingDown, TrendingUp } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatPrice } from "@/lib/market/format";
import { BTC_MODE_COPY, V2, suggestedPositionUsd } from "@/lib/market/v2-engine";
import type { BtcContext, RowVerdict, RadarRowV2, Scenario, TradePlan, V2Check } from "@/lib/market/types";

// ── BTC market regime bar ────────────────────────────────────────────────────

export function BtcModeBar({ btc, longs }: { btc: BtcContext | null; longs: number | null }) {
  if (!btc) return null;
  const copy = BTC_MODE_COPY[btc.mode];
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-[11px]",
        btc.mode === "bull" && "border-up/25 bg-up-soft/60",
        btc.mode === "flat" && "border-warn/25 bg-warn-soft/60",
        btc.mode === "dump" && "border-down/25 bg-down-soft/60",
      )}
      role="status"
      aria-live="polite"
    >
      <span className="num flex items-center gap-1.5 font-mono font-semibold">
        BTC {formatPrice(btc.price)}
      </span>
      <span className="num font-mono text-muted-foreground">
        15m{" "}
        <span className={btc.change15m > 0.05 ? "text-up" : btc.change15m < -0.05 ? "text-down" : ""}>
          {btc.change15m >= 0 ? "+" : ""}
          {btc.change15m.toFixed(2)}%
        </span>
      </span>
      <span className="num font-mono text-muted-foreground">
        1h{" "}
        <span className={btc.change1h > 0.05 ? "text-up" : btc.change1h < -0.05 ? "text-down" : ""}>
          {btc.change1h >= 0 ? "+" : ""}
          {btc.change1h.toFixed(2)}%
        </span>
      </span>
      <span className="num font-mono text-muted-foreground">
        24h{" "}
        <span className={btc.change24h > 0 ? "text-up" : btc.change24h < 0 ? "text-down" : ""}>
          {btc.change24h >= 0 ? "+" : ""}
          {btc.change24h.toFixed(2)}%
        </span>
      </span>
      <span className="ml-auto flex items-center gap-1.5 font-semibold">
        {btc.mode === "bull" && <TrendingUp className="size-3.5 text-up" aria-hidden="true" />}
        {btc.mode === "flat" && <Eye className="size-3.5 text-warn" aria-hidden="true" />}
        {btc.mode === "dump" && <TrendingDown className="size-3.5 text-down" aria-hidden="true" />}
        <span className={btc.mode === "bull" ? "text-up" : btc.mode === "dump" ? "text-down" : "text-warn"}>{copy.label}</span>
        <span className="hidden font-normal text-muted-foreground sm:inline">— {copy.note}</span>
        {longs !== null && typeof longs === "number" && (
          <span className="num rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title="Go-long signals fired in this regime">
            {longs} go-longs
          </span>
        )}
      </span>
    </div>
  );
}

// ── Verdict chip ─────────────────────────────────────────────────────────────

const VERDICT_STYLE: Record<RowVerdict, { label: string; className: string; icon: typeof TrendingUp | null }> = {
  go_long: { label: "GO LONG", className: "bg-up-soft text-up border-up/50 font-bold tracking-wide verdict-hot" , icon: TrendingUp },
  go_short: { label: "GO SHORT", className: "bg-down-soft text-down border-down/50 font-bold tracking-wide verdict-hot", icon: TrendingDown },
  watch: { label: "Watch only", className: "text-warn border-warn/40 bg-transparent", icon: Eye },
  skip: { label: "Skip", className: "text-muted-foreground border-border bg-transparent", icon: null },
  blocked_btc: { label: "BTC dump — no longs", className: "text-down border-down/40 bg-down-soft/50", icon: Ban },
  stable: { label: "Stablecoin — ignore", className: "text-muted-foreground border-border bg-muted/40 line-through", icon: Ban },
};

export function VerdictChip({ verdict, size = "md" }: { verdict: RowVerdict; size?: "sm" | "md" }) {
  const meta = VERDICT_STYLE[verdict];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 leading-none",
        size === "md" ? "py-1 text-[11px]" : "py-0.5 text-[10px]",
        meta.className,
      )}
    >
      {Icon && <Icon className={size === "md" ? "size-3" : "size-2.5"} aria-hidden="true" />}
      {meta.label}
    </span>
  );
}

// ── Final score pill ─────────────────────────────────────────────────────────

export function FinalScorePill({ score, verdict, size = "md" }: { score: number; verdict: RowVerdict | "go" | "watch" | "skip" | "blocked_btc"; size?: "sm" | "md" }) {
  const go = verdict === "go_long" || verdict === "go";
  const watch = verdict === "watch";
  const tone = go
    ? "bg-up-soft text-up border-up/50"
    : watch
      ? "text-warn border-warn/40 bg-transparent"
      : "text-muted-foreground border-border bg-transparent";
  const display = Math.min(100, Math.round(score));
  return (
    <span
      className={cn(
        "num inline-flex items-center justify-center rounded-md border font-mono font-semibold",
        size === "md" ? "min-w-11 px-1.5 h-7 text-sm" : "min-w-9 px-1 h-6 text-xs",
        tone,
      )}
      title={`uncapped composite ${score} — participation + directional + microstructure axes`}
    >
      {score > 100 ? "100+" : display}
    </span>
  );
}

// ── Filter checklist ─────────────────────────────────────────────────────────

export function FilterCheckList({ checks }: { checks: V2Check[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="grid gap-1 sm:grid-cols-2" aria-label="Seven-filter checklist">
      {checks.map((c, i) => (
        <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border font-mono text-[9px] font-bold",
              c.pass === true && "border-up/50 bg-up-soft text-up",
              c.pass === false && "border-down/50 bg-down-soft text-down",
              c.pass === null && "border-border bg-muted text-muted-foreground",
            )}
          >
            {c.pass === true ? "✓" : c.pass === false ? "✕" : "?"}
          </span>
          <span>
            <span className={cn("font-semibold", c.pass === false && "text-down", c.pass === true && "text-foreground", c.pass === null && "text-muted-foreground")}>
              {c.label}
            </span>
            <span className="ml-1 text-muted-foreground">{c.note}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Warnings row ─────────────────────────────────────────────────────────────

export function WarningsRow({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Warnings">
      {warnings.map((w, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-down/40 bg-down-soft px-1.5 py-0.5 text-[10px] font-medium leading-none text-down"
        >
          <AlertTriangle className="size-2.5" aria-hidden="true" />
          {w}
        </span>
      ))}
    </div>
  );
}

// ── Wall readout ─────────────────────────────────────────────────────────────

export function WallLine({ wall, known, broken }: { wall: RadarRowV2["wall"]; known?: boolean; broken: boolean | null }) {
  if (wall === null) {
    if (known === false) {
      return <span className="text-[11px] text-muted-foreground">order book not fetched yet — no wall data</span>;
    }
    return <span className="text-[11px] text-muted-foreground">no wall in +2% — clear runway</span>;
  }
  const dist = wall.distPct;
  const above = dist < 0;
  return (
    <span className="text-[11px] leading-snug">
      <Landmark className="mr-1 inline size-3 text-muted-foreground" aria-hidden="true" />
      <span className="num font-mono">${Math.round(wall.valueUsd / 1000)}K</span>{" "}
      wall at <span className="num font-mono">{formatPrice(wall.price)}</span>{" "}
      <span className={above ? "text-up" : "text-muted-foreground"}>({dist >= 0 ? "+" : ""}{dist.toFixed(2)}% away)</span>
      {above && broken === true && (
        <span className="ml-1.5 rounded border border-up/40 bg-up-soft px-1 py-0.5 text-[10px] font-medium text-up">broken — confirmed</span>
      )}
      {above && broken === false && (
        <span className="ml-1.5 rounded border border-warn/40 px-1 py-0.5 text-[10px] font-medium text-warn">breaking…</span>
      )}
    </span>
  );
}

// ── Trade plan card ──────────────────────────────────────────────────────────

export function TradePlanCard({
  plan,
  investment,
  onLaunchBot,
}: {
  plan: TradePlan;
  investment?: number | null;
  onLaunchBot?: (plan: TradePlan) => void;
}) {
  const [amount, setAmount] = useState<number>(investment && investment > 0 ? investment : 100);
  const [equity, setEquity] = useState<number>(1000);
  const long = plan.side === "long";
  const maxLoss = (amount * plan.riskPct) / 100;
  const tp1Usd = (amount * plan.tp1Pct) / 100;
  const tp2Usd = (amount * plan.tp2Pct) / 100;
  const sizeUsd = suggestedPositionUsd(equity, plan);
  return (
    <div className={cn("rounded-xl border p-3", long ? "border-up/30 bg-up-soft/40" : "border-down/30 bg-down-soft/40")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          {long ? <ArrowUpRight className="size-3.5 text-up" aria-hidden="true" /> : <ArrowDownRight className="size-3.5 rotate-0 text-down" aria-hidden="true" />}
          {long ? "Long plan" : "Short plan"}
          <span className="num font-mono font-normal text-muted-foreground">
            · stop sized to {plan.atrPct !== null ? `${plan.atrPct.toFixed(2)}% ATR` : "default risk"}
          </span>
        </p>
        <span className="flex items-center gap-1.5">
          <span className="num rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            R:R 1:{plan.riskReward1} → 1:{plan.riskReward2}
          </span>
          {plan.instrument === "futures" ? (
            <span
              className="rounded-md border border-warn/40 px-1.5 py-0.5 text-[10px] font-medium leading-none text-warn"
              title="This side executes on a margin instrument — funding payments apply while the position is held"
            >
              futures/margin instrument — funding applies
            </span>
          ) : (
            <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">spot</span>
          )}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "Entry", value: formatPrice(plan.entry), tone: "text-foreground" },
          { label: "Stop", value: formatPrice(plan.stop), tone: "text-down" },
          { label: "TP1", value: formatPrice(plan.tp1), tone: "text-up" },
          { label: "TP2", value: formatPrice(plan.tp2), tone: "text-up" },
        ].map((cell) => (
          <div key={cell.label} className="rounded-lg border border-border bg-card px-2.5 py-1.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{cell.label}</p>
            <p className={cn("num font-mono text-sm font-semibold", cell.tone)}>{cell.value}</p>
            <p className="num font-mono text-[10px] text-muted-foreground">
              {cell.label === "Entry" && "now"}
              {cell.label === "Stop" && `${long ? "−" : "+"}${plan.riskPct.toFixed(2)}%`}
              {cell.label === "TP1" && `${long ? "+" : "−"}${plan.tp1Pct.toFixed(2)}%`}
              {cell.label === "TP2" && `${long ? "+" : "−"}${plan.tp2Pct.toFixed(2)}%`}
            </p>
          </div>
        ))}
      </div>

      {plan.management && plan.management.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{plan.management.join(" · ")}</p>
      )}

      {plan.blocked && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-warn/40 bg-transparent px-2.5 py-1.5 text-[11px] text-warn">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {plan.blockReason}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <span className="num font-mono">Equity $</span>
          <input
            type="number"
            min={1}
            step={1}
            value={equity}
            onChange={(e) => setEquity(Math.max(1, Number(e.target.value) || 1))}
            className="num w-24 rounded-md border border-border bg-card px-1.5 py-1 font-mono text-[11px] tabular-nums focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Account equity in dollars"
          />
        </label>
        <span className="num font-mono" title={`constant dollar risk — position = equity × ${(V2.equityRiskFraction * 100).toFixed(1)}% ÷ stop %`}>
          → size <span className="font-semibold text-foreground">${Math.max(0, Math.round(sizeUsd)).toLocaleString()}</span> ({(V2.equityRiskFraction * 100).toFixed(1)}% risk)
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <span className="num font-mono">Risk $</span>
          <input
            type="number"
            min={1}
            step={1}
            value={amount}
            onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
            className="num w-20 rounded-md border border-border bg-card px-1.5 py-1 font-mono text-[11px] tabular-nums focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Investment amount in dollars"
          />
        </label>
        <span className="num font-mono">
          → lose max <span className="text-down">${maxLoss.toFixed(2)}</span>, make{" "}
          <span className="text-up">${tp1Usd.toFixed(2)}</span> at TP1 or <span className="text-up">${tp2Usd.toFixed(2)}</span> at TP2
        </span>
        {onLaunchBot && (
          <button
            type="button"
            onClick={() => onLaunchBot(plan)}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-primary/50 bg-primary/10 px-2.5 py-1.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Crosshair className="size-3" aria-hidden="true" />
            Create bot from plan
          </button>
        )}
      </div>
    </div>
  );
}

// ── Scenario map ─────────────────────────────────────────────────────────────

const SCENARIO_STYLE: Record<Scenario["tone"], { icon: ReactNode; border: string; title: string }> = {
  bull: { icon: <TrendingUp className="size-3.5 text-up" aria-hidden="true" />, border: "border-up/30", title: "text-up" },
  base: { icon: <Eye className="size-3.5 text-muted-foreground" aria-hidden="true" />, border: "border-border", title: "text-foreground" },
  bear: { icon: <TrendingDown className="size-3.5 text-down" aria-hidden="true" />, border: "border-down/30", title: "text-down" },
};

export function ScenarioList({ scenarios }: { scenarios: Scenario[] }) {
  if (scenarios.length === 0) return null;
  return (
    <div className="grid gap-2 md:grid-cols-3" aria-label="Scenarios before the decision">
      {scenarios.map((s, i) => {
        const style = SCENARIO_STYLE[s.tone];
        return (
          <div key={i} className={cn("rounded-xl border bg-card p-3", style.border)}>
            <p className={cn("flex items-center gap-1.5 text-[11px] font-semibold", style.title)}>
              {style.icon}
              {s.title}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{s.body}</p>
          </div>
        );
      })}
    </div>
  );
}

// ── Full V2 assessment panel (coin sheet, row detail) ────────────────────────

/** Tone for the calibrated hit-rate chip: green ≥ 55%, amber 45–55%, red below. */
function hitRateTone(p: number): string {
  if (p >= 0.55) return "border-up/40 text-up";
  if (p >= 0.45) return "border-warn/40 text-warn";
  return "border-down/40 text-down";
}

/** One axis segment's share of its own maximum, as a 0–100% width. */
function axisPct(value: number, max: number): string {
  return `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
}

export function V2Panel({
  v2,
  onLaunchBot,
}: {
  v2: RadarRowV2;
  onLaunchBot?: (plan: TradePlan) => void;
}) {
  const plan = v2.trade;
  const shortPlan = v2.shortTrade;
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">V2 verdict</h3>
          <VerdictChip verdict={v2.verdict} />
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="num font-mono">
            long <span className={v2.longVerdict === "go" ? "font-bold text-up" : ""}>{v2.longScore}</span>
          </span>
          <span className="num font-mono">
            short <span className={v2.shortVerdict === "go" ? "font-bold text-down" : ""}>{v2.shortScore}</span>
          </span>
        </div>
      </div>

      {v2.axes && (
        <div
          role="img"
          aria-label="score axes"
          title={`score axes — participation ${Math.round(v2.axes.participation)} / 40, directional ${Math.round(v2.axes.directional)} / 35, microstructure ${Math.round(v2.axes.microstructure)} / 25`}
        >
          <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted/50">
            <div className="bg-up-soft" style={{ width: axisPct(v2.axes.participation, 40) }} />
            <div className="bg-warn-soft" style={{ width: axisPct(v2.axes.directional, 35) }} />
            <div className="bg-muted" style={{ width: axisPct(v2.axes.microstructure, 25) }} />
          </div>
          <p className="num mt-0.5 font-mono text-[10px] text-muted-foreground">
            Part {Math.round(v2.axes.participation)} · Dir {Math.round(v2.axes.directional)} · Micro {Math.round(v2.axes.microstructure)}
          </p>
        </div>
      )}

      <WarningsRow warnings={v2.warnings} />

      <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Sell wall (asks within +2%)</p>
        <WallLine wall={v2.wall} known={v2.wallKnown} broken={v2.wallBroken} />
        {v2.wall !== null && v2.wallAgeSec != null &&
          (v2.wallAgeSec >= 60 ? (
            <span className="text-[11px] text-muted-foreground" title="the wall has persisted past the 60-second spoof-discount window">
              aged {Math.round(v2.wallAgeSec)}s — real
            </span>
          ) : (
            <span className="text-[11px] text-warn" title="walls younger than 60 seconds count half — possibly a spoof">
              fresh — possible spoof
            </span>
          ))}
        {v2.bidWall !== null && (
          <>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Bid floor (bids within −2%)</p>
            <span className="text-[11px]">
              <Landmark className="mr-1 inline size-3 text-muted-foreground" aria-hidden="true" />
              <span className="num font-mono">${Math.round(v2.bidWall.valueUsd / 1000)}K</span> at{" "}
              <span className="num font-mono">{formatPrice(v2.bidWall.price)}</span>{" "}
              <span className="text-muted-foreground">({v2.bidWall.distPct.toFixed(2)}% away)</span>
            </span>
          </>
        )}
      </div>

      {(v2.hitRate != null || v2.futures != null) && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Signals">
          {v2.hitRate != null && v2.hitRate.n > 0 && (
            <span
              className={cn("num rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none", hitRateTone(v2.hitRate.p))}
              title={`empirical P(TP1 before stop) for this score band, from your own backtest calibration (n=${v2.hitRate.n} decided trades)`}
            >
              est. {(v2.hitRate.p * 100).toFixed(0)}% TP1-first (n={v2.hitRate.n})
            </span>
          )}
          {v2.futures?.oiChange15m != null && (
            <span
              className="num rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
              title="Perpetual open-interest change over the last 15 minutes — real money entering or leaving"
            >
              OI 15m {v2.futures.oiChange15m >= 0 ? "+" : ""}
              {v2.futures.oiChange15m.toFixed(2)}%
            </span>
          )}
          {v2.futures?.fundingRatePct != null && (
            <span
              className="num rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
              title="Perpetual funding rate per 8 hours — above +0.05% crowds longs, below −0.05% crowds shorts"
            >
              funding {v2.futures.fundingRatePct >= 0 ? "+" : ""}
              {v2.futures.fundingRatePct.toFixed(3)}%/8h
            </span>
          )}
          {v2.futures?.lsRatio != null && (
            <span
              className="num rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
              title="Long/short account ratio on perpetuals — crowd positioning"
            >
              L/S {v2.futures.lsRatio.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {plan && <TradePlanCard plan={plan} onLaunchBot={onLaunchBot} />}
      {shortPlan && v2.shortVerdict === "go" && <TradePlanCard plan={shortPlan} onLaunchBot={onLaunchBot} />}

      {v2.checks.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Long filters</p>
          <FilterCheckList checks={v2.checks} />
        </div>
      )}
      {v2.shortChecks.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Short filters</p>
          <FilterCheckList checks={v2.shortChecks} />
        </div>
      )}

      {v2.scenarios.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Scenarios before you decide</p>
          <ScenarioList scenarios={v2.scenarios} />
        </div>
      )}
    </div>
  );
}
