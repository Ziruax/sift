"use client";

// ── Sift bots view — investment range-watchers you arm and forget ────────────
//
// Pure UI over the bot store (lib/bots.ts) and the bot engine
// (hooks/use-bot-engine.ts): an explainer, the engine status strip, a
// collapsible create form with range presets, active bot cards with a
// scale visualization of entry / target / stop / price, a finished list
// and a chronological event log. Bots are device-local — the copy says so.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bot as BotIcon,
  ChevronDown,
  LineChart,
  RefreshCw,
  RotateCcw,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatAge, formatCompact, formatPrice } from "@/lib/market/format";
import {
  botPnl,
  isBotActive,
  rangeProgress,
  takeBotPrefill,
  useBots,
  type Bot,
  type BotDraft,
  type BotEvent,
  type BotEventKind,
  type BotStatus,
} from "@/lib/bots";
import { useBotEngine } from "@/hooks/use-bot-engine";
import { EmptyState, LiveDot, LivePrice } from "./primitives";

// ── Form model ───────────────────────────────────────────────────────────────

type FormState = {
  symbol: string;
  investment: number;
  entry: number;
  direction: "long" | "short";
  targetLow: number;
  targetHigh: number;
  stopLow: number;
  stopHigh: number;
  note: string;
  expiry: string;
};

type FormErrors = Partial<Record<"symbol" | "investment" | "entry" | "target" | "stop", string>>;

const EMPTY_FORM: FormState = {
  symbol: "",
  investment: 0,
  entry: 0,
  direction: "long",
  targetLow: 0,
  targetHigh: 0,
  stopLow: 0,
  stopHigh: 0,
  note: "",
  expiry: "never",
};

const EXPIRY_OPTIONS: ReadonlyArray<{ value: string; label: string; ms: number | null }> = [
  { value: "never", label: "Never", ms: null },
  { value: "1h", label: "1 hour", ms: 3_600_000 },
  { value: "4h", label: "4 hours", ms: 14_400_000 },
  { value: "24h", label: "24 hours", ms: 86_400_000 },
  { value: "7d", label: "7 days", ms: 604_800_000 },
];

const TARGET_PRESETS: ReadonlyArray<{ label: string; p: number }> = [
  { label: "+5%", p: 0.05 },
  { label: "+10%", p: 0.1 },
  { label: "+25%", p: 0.25 },
  { label: "+50%", p: 0.5 },
];

const round = (v: number): number => Number(v.toPrecision(6));

/** A band of ±20% of the preset around the take-profit level (mirrored for shorts). */
function targetPreset(entry: number, direction: "long" | "short", p: number): { low: number; high: number } {
  const long = direction === "long";
  return {
    low: round(long ? entry * (1 + p * 0.8) : entry * (1 - p * 1.2)),
    high: round(long ? entry * (1 + p * 1.2) : entry * (1 - p * 0.8)),
  };
}

/** A tight band just past entry (0.5%–2% for longs, mirrored for shorts). */
function tightPreset(entry: number, direction: "long" | "short"): { low: number; high: number } {
  const long = direction === "long";
  return { low: round(long ? entry * 1.005 : entry * 0.98), high: round(long ? entry * 1.02 : entry * 0.995) };
}

/** A narrow stop band ~4% against the position (mirrored for shorts). */
function stopPreset(entry: number, direction: "long" | "short"): { low: number; high: number } {
  const long = direction === "long";
  return { low: round(long ? entry * 0.96 : entry * 1.035), high: round(long ? entry * 0.965 : entry * 1.04) };
}

function validateForm(f: FormState): FormErrors {
  const errors: FormErrors = {};
  if (f.symbol.trim().length < 2) errors.symbol = "Use at least 2 characters.";
  if (!(f.investment > 0)) errors.investment = "Must be greater than $0.";
  if (!(f.entry > 0)) errors.entry = "Must be greater than 0.";
  if (!(f.targetLow > 0) || !(f.targetHigh > 0)) errors.target = "Set both target bounds.";
  else if (f.targetLow === f.targetHigh) errors.target = "Target low and high must differ.";
  const stopSet = f.stopLow > 0 || f.stopHigh > 0;
  if (stopSet && (!(f.stopLow > 0) || !(f.stopHigh > 0))) errors.stop = "Set both stop bounds — or tap none.";
  else if (stopSet && f.stopLow === f.stopHigh) errors.stop = "Stop low and high must differ.";
  return errors;
}

function expiryMs(value: string): number | null {
  const option = EXPIRY_OPTIONS.find((o) => o.value === value);
  return option ? option.ms : null;
}

// ── Prefill bridge (the coin sheet dispatches "sift:prefill-bot") ────────────

type PrefillDetail = {
  pair: string;
  base: string;
  investment: number;
  entry: number;
  direction: "long" | "short";
  targetLow: number;
  targetHigh: number;
  stopLow: number;
  stopHigh: number;
  note: string;
};

function readPrefillDetail(event: Event): PrefillDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Partial<PrefillDetail>;
  if (typeof d.pair !== "string" || !d.pair.trim()) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const pair = d.pair.trim().toUpperCase();
  const base = typeof d.base === "string" && d.base.trim() ? d.base.trim().toUpperCase() : pair.replace(/USDT$/, "");
  return {
    pair,
    base,
    investment: num(d.investment),
    entry: num(d.entry),
    direction: d.direction === "short" ? "short" : "long",
    targetLow: num(d.targetLow),
    targetHigh: num(d.targetHigh),
    stopLow: num(d.stopLow),
    stopHigh: num(d.stopHigh),
    note: typeof d.note === "string" ? d.note.slice(0, 120) : "",
  };
}

// ── Small shared pieces ──────────────────────────────────────────────────────

const EVENT_META: Record<BotEventKind, { label: string; className: string }> = {
  created: { label: "Created", className: "border-border bg-transparent text-foreground/80" },
  check: { label: "Check", className: "border-transparent bg-muted text-muted-foreground" },
  entered_target: { label: "Entered target", className: "border-up/40 bg-up-soft text-up" },
  left_target: { label: "Left target", className: "border-warn/30 bg-transparent text-warn" },
  entered_stop: { label: "Entered stop", className: "border-down/40 bg-down-soft text-down" },
  reset: { label: "Re-armed", className: "border-border bg-transparent text-foreground/80" },
  closed: { label: "Closed", className: "border-border bg-transparent text-foreground/80" },
  expired: { label: "Expired", className: "border-border/60 bg-transparent text-muted-foreground" },
  error: { label: "Error", className: "border-transparent bg-muted text-muted-foreground" },
};

const STATUS_META: Record<BotStatus, { label: string; className: string }> = {
  watching: { label: "WATCHING", className: "border-border bg-transparent text-muted-foreground" },
  in_target: { label: "IN TARGET ZONE", className: "animate-pulse border-up/40 bg-up-soft font-semibold text-up" },
  stopped: { label: "STOPPED", className: "border-down/40 bg-down-soft text-down" },
  done: { label: "CLOSED", className: "border-border bg-transparent text-muted-foreground" },
  expired: { label: "EXPIRED", className: "border-border bg-transparent text-muted-foreground" },
};

function sourceLabel(source: Bot["lastCheckSource"]): string {
  if (source === "freecryptoapi") return "FreeCryptoAPI";
  if (source === "binance") return "Binance";
  if (source === "tape") return "live tape";
  return "—";
}

function age(ts: number | null): string {
  return ts !== null ? formatAge(new Date(ts).toISOString()) : "—";
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function remainingLabel(expiresAt: number | null): string | null {
  if (expiresAt === null) return null;
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "any moment";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  prefix,
  suffix,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  prefix?: string;
  suffix?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="mt-1 flex h-9 items-center rounded-lg border border-border bg-background px-2 focus-within:outline-2 focus-within:outline-ring">
        {prefix ? <span className="mr-1 text-xs text-muted-foreground">{prefix}</span> : null}
        <input
          type="number"
          inputMode="decimal"
          step="any"
          min={min}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          className="num h-full w-full bg-transparent font-mono text-sm outline-none"
        />
        {suffix ? <span className="ml-1 text-xs text-muted-foreground">{suffix}</span> : null}
      </span>
      {hint ? <span className="mt-1 block text-xs text-down">{hint}</span> : null}
    </label>
  );
}

function ChipButton({ label, onClick, disabled, title }: { label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "num min-h-9 rounded-lg border border-border bg-background px-2.5 font-mono text-xs text-muted-foreground transition-colors",
        "hover:border-foreground/30 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground",
      )}
    >
      {label}
    </button>
  );
}

// ── Create-bot form ──────────────────────────────────────────────────────────

function CreateBotForm({
  open,
  onToggle,
  onRequestOpen,
  onArmed,
  livePrice,
  addBot,
}: {
  open: boolean;
  onToggle: () => void;
  onRequestOpen: () => void;
  onArmed: () => void;
  livePrice: (pair: string) => number | null;
  addBot: (draft: BotDraft) => Bot;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);

  const pair = form.symbol ? `${form.symbol}USDT` : "";
  const liveEntry = pair ? livePrice(pair) : null;

  // Prefill from the coin sheet: open the form and drop the numbers in.
  // The event covers the already-mounted case; the queue covers the
  // just-navigated-here case (the event fired before this form mounted).
  useEffect(() => {
    const applyPrefill = (detail: NonNullable<ReturnType<typeof readPrefillDetail>>) => {
      setForm({
        symbol: detail.base.replace(/[^A-Z0-9]/g, "").slice(0, 10),
        investment: detail.investment,
        entry: detail.entry,
        direction: detail.direction,
        targetLow: detail.targetLow,
        targetHigh: detail.targetHigh,
        stopLow: detail.stopLow,
        stopHigh: detail.stopHigh,
        note: detail.note,
        expiry: "never",
      });
      setAttempted(false);
      onRequestOpen();
    };
    const handler = (event: Event) => {
      const detail = readPrefillDetail(event);
      if (!detail) return;
      applyPrefill(detail);
    };
    window.addEventListener("sift:prefill-bot", handler);
    const queued = takeBotPrefill();
    if (queued) applyPrefill(queued);
    return () => window.removeEventListener("sift:prefill-bot", handler);
  }, [onRequestOpen]);

  const errors: FormErrors = attempted ? validateForm(form) : {};

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const applyTarget = (range: { low: number; high: number }) => set({ targetLow: range.low, targetHigh: range.high });
  const applyStop = (range: { low: number; high: number }) => set({ stopLow: range.low, stopHigh: range.high });

  const fillFromLive = () => {
    if (liveEntry !== null && liveEntry > 0) set({ entry: liveEntry });
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAttempted(true);
    const errs = validateForm(form);
    if (errs.symbol || errs.investment || errs.entry || errs.target || errs.stop) return;
    const symbol = form.symbol.trim().toUpperCase();
    const armedPair = `${symbol}USDT`;
    addBot({
      pair: armedPair,
      base: symbol,
      name: symbol,
      investment: form.investment,
      entry: form.entry,
      direction: form.direction,
      targetLow: form.targetLow,
      targetHigh: form.targetHigh,
      stopLow: form.stopLow,
      stopHigh: form.stopHigh,
      note: form.note.trim().slice(0, 120),
      expiresAt: expiryMs(form.expiry),
    });
    toast("Bot armed", { description: `${armedPair} — watching for price to enter your target range` });
    window.dispatchEvent(new CustomEvent("sift:bot-created"));
    setForm(EMPTY_FORM);
    setAttempted(false);
    onArmed();
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">New bot</h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="sift-bot-form-fields"
          aria-label={open ? "Collapse new bot form" : "Expand new bot form"}
          className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
      </div>

      {open ? (
        <form id="sift-bot-form-fields" noValidate onSubmit={handleSubmit} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {/* Symbol */}
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Symbol</span>
            <span className="mt-1 flex h-9 items-center rounded-lg border border-border bg-background px-2 focus-within:outline-2 focus-within:outline-ring">
              <input
                type="text"
                value={form.symbol}
                onChange={(e) => set({ symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) })}
                placeholder="BTC"
                maxLength={10}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="h-full w-full bg-transparent text-sm uppercase outline-none"
              />
            </span>
            <span className="num mt-1 block min-h-4 truncate font-mono text-[11px] text-muted-foreground">
              {pair ? `tracks ${pair}` : "any Binance USDT pair"}
            </span>
            {errors.symbol ? <span className="mt-0.5 block text-xs text-down">{errors.symbol}</span> : null}
          </label>

          {/* Investment */}
          <NumberField label="Investment" prefix="$" min={0} value={form.investment} onChange={(v) => set({ investment: v })} hint={errors.investment} />

          {/* Entry price + use live */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="sift-bot-entry" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Entry price
              </label>
              {liveEntry !== null && liveEntry > 0 ? <LivePrice price={liveEntry} className="text-xs text-muted-foreground" /> : null}
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="flex h-9 flex-1 items-center rounded-lg border border-border bg-background px-2 focus-within:outline-2 focus-within:outline-ring">
                <input
                  id="sift-bot-entry"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={0}
                  value={Number.isFinite(form.entry) ? form.entry : ""}
                  onChange={(e) => set({ entry: e.target.value === "" ? 0 : Number(e.target.value) })}
                  className="num h-full w-full bg-transparent font-mono text-sm outline-none"
                />
              </span>
              <button
                type="button"
                onClick={fillFromLive}
                disabled={liveEntry === null || liveEntry <= 0}
                title={liveEntry !== null && liveEntry > 0 ? `Fill from the live ${pair} price` : "No live price for this symbol yet"}
                className="flex min-h-9 shrink-0 items-center rounded-lg border border-border bg-background px-2 text-[11px] font-semibold text-primary transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
              >
                use live
              </button>
            </div>
            {errors.entry ? <p className="mt-1 text-xs text-down">{errors.entry}</p> : null}
          </div>

          {/* Direction */}
          <div className="col-span-2 sm:col-span-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Direction</span>
            <div className="mt-1 grid grid-cols-2 rounded-lg border border-border bg-background p-0.5">
              {(["long", "short"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => set({ direction: d })}
                  aria-pressed={form.direction === d}
                  className={cn(
                    "flex min-h-8 items-center justify-center gap-1 rounded-md text-xs font-medium capitalize transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    form.direction === d
                      ? d === "long"
                        ? "bg-up-soft text-up"
                        : "bg-down-soft text-down"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {d === "long" ? <ArrowUp className="size-3" aria-hidden="true" /> : <ArrowDown className="size-3" aria-hidden="true" />}
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* Target range */}
          <NumberField label="Target low" value={form.targetLow} onChange={(v) => set({ targetLow: v })} />
          <NumberField label="Target high" value={form.targetHigh} onChange={(v) => set({ targetHigh: v })} hint={errors.target} />

          <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-span-3">
            <span className="mr-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Target presets</span>
            {TARGET_PRESETS.map((preset) => (
              <ChipButton
                key={preset.label}
                label={preset.label}
                disabled={form.entry <= 0}
                title={form.entry > 0 ? `Band around the ${(preset.p * 100).toFixed(0)}% level` : "Set an entry price first"}
                onClick={() => applyTarget(targetPreset(form.entry, form.direction, preset.p))}
              />
            ))}
            <ChipButton
              label="tight"
              disabled={form.entry <= 0}
              title={form.entry > 0 ? "Narrow band just past entry" : "Set an entry price first"}
              onClick={() => applyTarget(tightPreset(form.entry, form.direction))}
            />
          </div>

          {/* Stop range */}
          <NumberField label="Stop low" value={form.stopLow} onChange={(v) => set({ stopLow: v })} />
          <NumberField label="Stop high" value={form.stopHigh} onChange={(v) => set({ stopHigh: v })} hint={errors.stop} />

          <div className="col-span-2 flex flex-wrap items-center gap-1.5 sm:col-span-3">
            <span className="mr-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Stop presets</span>
            <ChipButton
              label="−4%"
              disabled={form.entry <= 0}
              title={form.entry > 0 ? "Narrow stop band ~4% against you" : "Set an entry price first"}
              onClick={() => applyStop(stopPreset(form.entry, form.direction))}
            />
            <ChipButton label="none" title="No stop range — watch targets only" onClick={() => set({ stopLow: 0, stopHigh: 0 })} />
          </div>

          {/* Note */}
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Note (optional)</span>
            <span className="mt-1 flex h-9 items-center rounded-lg border border-border bg-background px-2 focus-within:outline-2 focus-within:outline-ring">
              <input
                type="text"
                value={form.note}
                onChange={(e) => set({ note: e.target.value.slice(0, 120) })}
                maxLength={120}
                placeholder="e.g. breakout re-entry"
                className="h-full w-full bg-transparent text-sm outline-none"
              />
            </span>
          </label>

          {/* Expiry */}
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Expiry</span>
            <select
              value={form.expiry}
              onChange={(e) => set({ expiry: e.target.value })}
              className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {/* Submit */}
          <div className="col-span-2 flex flex-wrap items-center gap-3 sm:col-span-3">
            <button
              type="submit"
              className="flex min-h-11 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Zap className="size-4" aria-hidden="true" />
              Arm bot
            </button>
            <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
              Range hits fire a sound and a browser notification. Bots live on this device only — no account, no sync.
            </p>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// ── Active bot card ──────────────────────────────────────────────────────────

/** Horizontal scale showing entry tick, target/stop bands and the live price dot. */
function RangeTrack({ bot, price }: { bot: Bot; price: number }) {
  const tLo = Math.min(bot.targetLow, bot.targetHigh);
  const tHi = Math.max(bot.targetLow, bot.targetHigh);
  const hasStop = bot.stopLow > 0 && bot.stopHigh > 0;
  const sLo = hasStop ? Math.min(bot.stopLow, bot.stopHigh) : 0;
  const sHi = hasStop ? Math.max(bot.stopLow, bot.stopHigh) : 0;

  const anchors = [bot.entry, tLo, tHi, ...(hasStop ? [sLo, sHi] : [])].filter((v) => v > 0);
  const scaleLo = (anchors.length > 0 ? Math.min(...anchors) : 0) * 0.995;
  const scaleHi = (anchors.length > 0 ? Math.max(...anchors) : 1) * 1.005;
  const span = scaleHi - scaleLo || 1;
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - scaleLo) / span) * 100));

  const tLeft = pct(tLo);
  const tWidth = Math.max(0.75, pct(tHi) - tLeft); // keep hairline bands visible
  const sLeft = pct(sLo);
  const sWidth = Math.max(0.75, pct(sHi) - sLeft);

  const label = `Entry ${formatPrice(bot.entry)}, target zone ${formatPrice(tLo)} to ${formatPrice(tHi)}${
    hasStop ? `, stop zone ${formatPrice(sLo)} to ${formatPrice(sHi)}` : ""
  }${price > 0 ? `, price ${formatPrice(price)}` : ", price not seen yet"}`;

  return (
    <div>
      <div className="relative h-2 rounded-full bg-muted" role="img" aria-label={label}>
        <div className="absolute inset-y-0 rounded-full bg-up/40" style={{ left: `${tLeft}%`, width: `${tWidth}%` }} />
        {hasStop ? <div className="absolute inset-y-0 rounded-full bg-down/40" style={{ left: `${sLeft}%`, width: `${sWidth}%` }} /> : null}
        <div
          className="absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/70"
          style={{ left: `${pct(bot.entry)}%` }}
          aria-hidden="true"
        />
        {price > 0 ? (
          <div
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary transition-all duration-500"
            style={{ left: `${pct(price)}%` }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex items-start justify-between gap-2 text-[11px] leading-none text-muted-foreground">
        <span className="num font-mono">Entry {formatPrice(bot.entry)}</span>
        <span className="num max-w-[45%] truncate text-center font-mono">
          Target {formatPrice(tLo)}–{formatPrice(tHi)}
        </span>
        {hasStop ? (
          <span className="num font-mono text-right">
            Stop {formatPrice(sLo)}–{formatPrice(sHi)}
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function BotCard({
  bot,
  price,
  onOpenPair,
  onClose,
  onDelete,
}: {
  bot: Bot;
  price: number;
  onOpenPair: (pair: string) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const pnl = botPnl(bot, price);
  const inTarget = bot.status === "in_target";
  const progress = rangeProgress(bot.entry, price, bot.targetLow, bot.targetHigh);
  const remaining = remainingLabel(bot.expiresAt);

  return (
    <article className="space-y-3 rounded-xl border border-border bg-card p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="flex items-baseline gap-1 leading-none" title={bot.note ? `${bot.name} — ${bot.note}` : bot.name}>
            <span className="text-base font-bold">{bot.base}</span>
            <span className="text-xs font-medium text-muted-foreground">USDT</span>
          </h4>
          <p className="num mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span className={bot.direction === "long" ? "font-semibold text-up" : "font-semibold text-down"}>{bot.direction.toUpperCase()}</span>
            <span>· {formatCompact(bot.investment)} in</span>
          </p>
          {bot.note ? <p className="mt-1 truncate text-[11px] text-muted-foreground">{bot.note}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] leading-none",
              STATUS_META[bot.status].className,
            )}
          >
            {STATUS_META[bot.status].label}
          </span>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${bot.name} bot`}
            className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-down focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Live price + P&L */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-background px-3 py-2.5">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Live price</p>
          <p className="font-mono text-lg font-semibold leading-none">
            {price > 0 ? <LivePrice price={price} /> : <span className="text-muted-foreground">—</span>}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">P&L</p>
          <p className="num font-mono text-2xl font-bold leading-none">
            {price > 0 ? (
              <span className={pnl.usd > 0 ? "text-up" : pnl.usd < 0 ? "text-down" : "text-muted-foreground"}>
                {pnl.usd >= 0 ? "+" : "−"}${Math.abs(pnl.usd).toFixed(2)}{" "}
                <span className="text-sm">
                  ({pnl.pct >= 0 ? "+" : "−"}
                  {Math.abs(pnl.pct).toFixed(1)}%)
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </p>
        </div>
      </div>

      {/* Entry / target / stop / price on one scale */}
      <RangeTrack bot={bot} price={price} />

      {/* Distance to target */}
      <div>
        <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
          <span>Distance to target zone</span>
          <span className="num font-mono">{price > 0 ? `${progress.toFixed(0)}%` : "—"}</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={`Distance to target zone for ${bot.base}`}
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", inTarget ? "bg-up" : "bg-up/60")}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Meta */}
      <p className="num font-mono text-[11px] text-muted-foreground">
        checks {bot.checks} · last {age(bot.lastCheckAt)} · {sourceLabel(bot.lastCheckSource)}
        {remaining ? ` · expires in ${remaining}` : ""}
      </p>

      {/* Footer */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onOpenPair(bot.pair)}
          className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <LineChart className="size-3.5" aria-hidden="true" />
          Open chart
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          Close bot
        </button>
      </div>
    </article>
  );
}

// ── The view ─────────────────────────────────────────────────────────────────

export function BotsView({
  livePrice,
  onOpenPair,
}: {
  /** Latest radar price for a Binance pair like "BTCUSDT"; null if unknown. */
  livePrice: (pair: string) => number | null;
  /** Opens the coin sheet. */
  onOpenPair: (pair: string) => void;
}) {
  const { bots, active, addBot, removeBot, resetBot, closeBot } = useBots();
  const { state, pollNow } = useBotEngine(onOpenPair);

  // Collapsible form: auto-open when there are zero bots, collapsed once one
  // exists; explicit toggles win until the device is botless again.
  const [formOpenOverride, setFormOpenOverride] = useState<boolean | null>(null);
  const formOpen = formOpenOverride ?? bots.length === 0;

  // Derived reset during render (React pattern) — dropping the last bot
  // clears any stale "collapsed" override so the form auto-opens again.
  const [prevBotless, setPrevBotless] = useState(bots.length === 0);
  if (prevBotless !== (bots.length === 0)) {
    setPrevBotless(bots.length === 0);
    if (bots.length === 0) setFormOpenOverride(null);
  }

  const openForm = useCallback(() => setFormOpenOverride(true), []);
  const closeForm = useCallback(() => setFormOpenOverride(false), []);
  const toggleForm = useCallback(() => setFormOpenOverride(!formOpen), [formOpen]);

  const finished = useMemo(() => bots.filter((b) => !isBotActive(b)), [bots]);
  const eventRows = useMemo(() => {
    const rows: Array<{ bot: Bot; ev: BotEvent }> = [];
    for (const bot of bots) for (const ev of bot.events) rows.push({ bot, ev });
    rows.sort((a, b) => b.ev.ts - a.ev.ts);
    return rows.slice(0, 50);
  }, [bots]);

  const deleteBot = (bot: Bot) => {
    if (window.confirm(`Delete the ${bot.name} bot on ${bot.pair}? This clears it from this device.`)) removeBot(bot.id);
  };

  return (
    <div className="space-y-3">
      {/* 1 — Explainer */}
      <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="sift-bots-explainer-h">
        <h3 id="sift-bots-explainer-h" className="flex items-center gap-2 text-sm font-semibold">
          <BotIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          Investment bots — set your ranges, get pinged the moment price enters
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          You set an investment amount, an entry price, and a target range plus an optional stop range. While a bot is armed
          the app captures prices on a short cadence via FreeCryptoAPI — confirmed instantly against the live tape — and
          fires a sound and a browser notification the moment price enters a range. Bots live on this device only: no
          account, no sync, nothing leaves your browser.
        </p>
      </section>

      {/* 2 — Engine status strip */}
      <div className="rounded-xl border border-border bg-card px-4 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <LiveDot tone={state.running ? "up" : "down"} pulse={state.running} />
            <span role="status">
              {state.running
                ? `Watching ${active.length} ${active.length === 1 ? "bot" : "bots"} · checked ${age(state.lastPollAt)} · source ${
                    state.lastSource === "freecryptoapi" ? "FreeCryptoAPI" : state.lastSource === "binance" ? "Binance fallback" : "—"
                  }`
                : "No active bots — arm one below."}
            </span>
          </p>
          <button
            type="button"
            onClick={pollNow}
            className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-semibold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Check now
          </button>
        </div>
        {state.notice || state.lastError ? (
          <p role="status" className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-warn">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {state.notice ?? state.lastError}
              {state.lastError !== null && state.consecutiveErrors > 1 ? ` (${state.consecutiveErrors} failed checks in a row)` : ""}
            </span>
          </p>
        ) : null}
      </div>

      {/* 3 — Create-bot form */}
      <CreateBotForm open={formOpen} onToggle={toggleForm} onRequestOpen={openForm} onArmed={closeForm} livePrice={livePrice} addBot={addBot} />

      {/* 4 — Active bots */}
      <section aria-labelledby="sift-bots-active-h">
        <h3 id="sift-bots-active-h" className="text-sm font-semibold">
          Active bots <span className="num ml-1 font-mono text-xs font-normal text-muted-foreground">{active.length}</span>
        </h3>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          {active.map((bot) => (
            <BotCard
              key={bot.id}
              bot={bot}
              price={bot.lastPrice ?? livePrice(bot.pair) ?? 0}
              onOpenPair={onOpenPair}
              onClose={() => closeBot(bot.id)}
              onDelete={() => deleteBot(bot)}
            />
          ))}
        </div>
        {active.length === 0 ? (
          <div className="mt-2">
            <EmptyState
              title="No bots armed"
              body="Arm one above — while this tab is open it checks prices on a short cadence and pings you the instant one enters your range."
            />
          </div>
        ) : null}
      </section>

      {/* 5 — Finished & stopped */}
      <section aria-labelledby="sift-bots-finished-h">
        <h3 id="sift-bots-finished-h" className="text-sm font-semibold">
          Finished &amp; stopped
        </h3>
        <div className="mt-2">
          {finished.length === 0 ? (
            <EmptyState
              title="No finished bots yet"
              body="When a bot hits its stop range, gets closed, or expires, it lands here — re-arm it with one tap or delete it for good."
            />
          ) : (
            <ul className="max-h-96 overflow-y-auto rounded-xl border border-border bg-card">
              {finished.map((bot) => {
                const price = bot.lastPrice ?? livePrice(bot.pair) ?? 0;
                const pnl = botPnl(bot, price);
                const meta = STATUS_META[bot.status];
                return (
                  <li key={bot.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border px-3 py-2.5 last:border-b-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-sm font-semibold leading-none">{bot.base}</span>
                      <span className="text-[11px] leading-none text-muted-foreground">USDT</span>
                      <span className={cn("inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] leading-none", meta.className)}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="num flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
                      <span className="text-muted-foreground">{price > 0 ? formatPrice(price) : "—"}</span>
                      {price > 0 ? (
                        <span className={pnl.usd > 0 ? "text-up" : pnl.usd < 0 ? "text-down" : "text-muted-foreground"}>
                          {pnl.usd >= 0 ? "+" : "−"}
                          {formatCompact(Math.abs(pnl.usd))} ({pnl.pct >= 0 ? "+" : "−"}
                          {Math.abs(pnl.pct).toFixed(1)}%)
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      <span className="text-muted-foreground" title={`${bot.events.length} logged events`}>
                        {bot.events.length} ev
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => resetBot(bot.id)}
                        className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <RotateCcw className="size-3.5" aria-hidden="true" />
                        Re-arm
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteBot(bot)}
                        aria-label={`Delete ${bot.name} bot`}
                        className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:text-down focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* 6 — Event log */}
      <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="sift-bots-activity-h">
        <h3 id="sift-bots-activity-h" className="text-sm font-semibold">
          Bot activity
        </h3>
        <div className="mt-3 max-h-96 overflow-y-auto">
          {eventRows.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">Events appear here the moment your bots see something.</p>
          ) : (
            <ul className="space-y-1.5">
              {eventRows.map(({ bot, ev }, i) => {
                const meta = EVENT_META[ev.kind];
                return (
                  <li key={`${bot.id}-${ev.ts}-${ev.kind}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    <span className="num font-mono text-[11px] text-muted-foreground">{clock(ev.ts)}</span>
                    <span className="font-semibold leading-none">{bot.base}</span>
                    <span className={cn("inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none", meta.className)}>
                      {meta.label}
                    </span>
                    <span className="num font-mono text-muted-foreground">{formatPrice(ev.price)}</span>
                    {ev.note ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{ev.note}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
