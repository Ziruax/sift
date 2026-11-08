# Sift — Complete Algorithm Reference (V2.2, post-stability-audit)

> **What this document is.** A full, honest description of every algorithm
> inside Sift V2.2: how the universe is selected, how each metric is derived,
> how the three-axis score is built, how the hard gates veto, how the
> **stateful verdict layer** turns a per-snapshot score into a stable,
> explained verdict (V2.2's addition), how trade plans (entry / stop / TP1 /
> TP2) are constructed for both longs and shorts, how scenarios are generated
> *before* the decision, how signals are cooled down, how every signal is
> graded after the fact, and how the backtest measures (or fails to measure)
> all of it. Written so you can audit each threshold and judge the logic
> yourself.
>
> **What changed in V2.2 (the stateless-verdict fix).** A second external
> audit — an end-to-end read of this repository — found the V2.1 measurement
> layer sound but the DECISION layer missing: the verdict was a pure function
> of one row snapshot, every threshold was a hard step, the BTC regime was a
> tick-flippable step function, the wall score cliffed at 75 s, the
> calibration was banded (a 0.12 jump in p at the band edge), and the UI
> re-sorted by score so a stable coin could vanish because a *different* coin
> scored higher. Symptom: verdicts flickering go ↔ watch ↔ skip every scan.
> V2.2 adds the decision layer (`verdict-state.ts`): EWM-smoothed scores,
> enter/exit hysteresis pairs on every gate, confirmation counts, dwell
> times, exit confirmation, a stale-input freeze, a dwelled BTC regime with
> an ATR deadband, wall-score interpolation + absence confirmation, a
> continuous (isotonic-interpolated) calibration, pinned display ordering,
> and instrumentation (the stability chip) that measures whether it worked.
> The honesty contract is unchanged — in particular the expectancy gate still
> refuses to fire GOs the calibration can't pay for; V2.2 just makes the
> refusal **stable and explained** instead of twitchy.
>
> **What changed in V2.1.** An external algorithm audit found three outright
> bugs (a blacklist that silently killed JUP/BNB/SHIB/ARB; a volume baseline
> that included its own spike and ignored time-of-day; an ATR clamp that
> inverted the risk geometry), ~6 design decisions that capped the achievable
> edge (double-counted momentum, two near-constant filters, absolute
> thresholds on non-stationary series, no beta adjustment, a capped score that
> destroyed ranking, an un-tunable wall filter), and one validity problem (a
> backtest that could not measure what it claimed). This version fixes all of
> them. Every fix is marked **[AUDIT §x.y]** so you can trace cause → change.
>
> **The honesty contract first — and now measured.** No filter set makes
> crypto predictable. As part of this revision the entire engine was replayed
> over **90 days of real 5m bars, net of costs, with pessimistic grading**
> (§8.2). The measured result: the momentum-chasing GO family wins its
> TP1-before-stop race only **20–38% of the time by score band** (it needs
> ~42%+ after costs) — i.e. the last 90 days do **not** pay for this signal
> family on any threshold tested. Sift therefore ships an **expectancy gate**
> (§8.3): the engine refuses to say "GO" when the calibrated hit rate of the
> score band implies negative net expectancy, and shows the numbers instead.
> When you run a backtest on a kinder window and your score band measures
> ≥ ~42–45% hit rate, GOs re-open automatically. That is what "capture real
> opportunities" honestly means: refuse the fake ones, measure everything,
> and recalibrate from evidence — not promises.

---

## Table of contents

1. [System architecture — the three tiers](#1-system-architecture--the-three-tiers)
2. [Data acquisition](#2-data-acquisition)
3. [Universe selection — volume anomaly, not absolute volume](#3-universe-selection--volume-anomaly-not-absolute-volume)
4. [Per-coin derived metrics (the RadarRow)](#4-per-coin-derived-metrics-the-radarrow)
5. [The volume baseline — time-of-day adjusted, self-excluded, floored](#5-the-volume-baseline--time-of-day-adjusted-self-excluded-floored)
6. [The three-axis score](#6-the-three-axis-score)
7. [Hard gates — what a GO must survive](#7-hard-gates--what-a-go-must-survive)
8. [Verdict thresholds & the uncapped score](#8-verdict-thresholds--the-uncapped-score)
9. [Trade plans — constant-R geometry, constant dollar risk](#9-trade-plans--constant-r-geometry-constant-dollar-risk)
10. [New signals — OI, funding, L/S ratio, CVD, trade-size skew, wall age](#10-new-signals--oi-funding-ls-ratio-cvd-trade-size-skew-wall-age)
11. [Scenario analysis & backtest calibration](#11-scenario-analysis--backtest-calibration)
12. [Signal system, anti-flip-flop cooldowns & the portfolio layer](#12-signal-system-anti-flip-flop-cooldowns--the-portfolio-layer)
13. [The stateful verdict layer — dwell, hysteresis, confirmation (V2.2)](#13-the-stateful-verdict-layer--dwell-hysteresis-confirmation-v22)
14. [Outcome grading — accountability loop](#14-outcome-grading--accountability-loop)
15. [Backtest — the honest edition](#15-backtest--the-honest-edition)
16. [Bots & FreeCryptoAPI integration](#16-bots--freecryptoapi-integration)
17. [Reliability engineering](#17-reliability-engineering)
18. [Complete tunables table (tuned vs assumed)](#18-complete-tunables-table-tuned-vs-assumed)
19. [Worked examples](#19-worked-examples)
20. [Known limitations (honest list)](#20-known-limitations-honest-list)

---

## 1. System architecture — the three tiers

One shared brain, three data consumers:

| Consumer | Where | Role |
|---|---|---|
| **Server scanner** | `mini-services/radar/index.ts` (port 3003 socket.io / 3004 REST) | Scans 24/7 server-side whether or not any browser is open. One scanner serves every connected client. |
| **In-browser engine** | `src/lib/market/local-radar.ts` | Binance **public websockets** (`!miniTicker@arr` + per-pair `aggTrade`) — no key, no server. This is what runs on static hosting (Netlify). |
| **Backtest simulator** | `src/components/sift/backtest-view.tsx` + `scripts/tune-v2.ts` | Replays history through the *exact same* filter functions. |

Shared pure logic lives in three modules so all three tiers compute identical
numbers: `src/lib/market/v2-engine.ts` (scoring, gates, plans, backtest),
`src/lib/market/baseline.ts` (blacklist, baselines, book analysis, beta, CVD),
and — V2.2 — `src/lib/market/verdict-state.ts` (the stateful verdict layer,
§13: the state machine, the dwelled BTC regime, the verdict overlay, and the
change log / stability metrics).

The browser picks its tier automatically (upgrade path, best wins):
`live` (socket.io) → `fallback` (REST poll) → `local` (in-browser engine).

**Why one engine module for everything:** what you backtest is what you trade.
The audit's single largest structural complaint about most retail systems —
"the backtest tests different code than the live system" — is impossible here
by construction.

---

## 2. Data acquisition

### 2.1 Server scanner — paced data tasks (anti-burst design)

| Task | Cadence | Fetches |
|---|---|---|
| `klinePumpLoop` | 1 pair per pace-tick, **priority rotation** | `/api/v3/klines?interval=1m&limit=288` (24h of candles) |
| `statsTaskLoop` | every 30 s, batched | `/api/v3/ticker/24hr?symbols=[...universe]` |
| `universeTaskLoop` | every 5 min | full ticker → re-rank the universe (§3) |
| `wallPumpLoop` | 1 pair per 2.5 s | `/api/v3/depth?limit=100` for wall candidates only |
| `futuresLoop` | 1 pair per 2.5 s | OI history, funding, long/short ratio (§10) |
| listing-age probe | once per pair on universe entry | `/api/v3/klines?interval=1d&limit=1&startTime=0` → first-ever candle |

**[AUDIT §5.4] Priority rotation:** the kline pump serves *hot* pairs (score
≥ watch bar, or rvol ≥ 2, or user-subscribed) every rotation tick, and *cold*
pairs only every 3rd tick — same request budget, freshness where it counts.
The old round-robin gave every pair equal priority forever, which meant 6
minutes per full rotation exactly during the highest-volume windows.

**[AUDIT §7 note] 24h change from candles, not the ticker:** the day-extension
gate reads `(lastClose − klines[0].open)/klines[0].open` from the 288-candle
window — never the up-to-60s-stale ticker field.

The **scan itself is pure computation over the in-memory stores — zero
network.** It runs every 3 s on the server (V2.2: the scan IS the verdict
tick) and every 1 s in the browser engine — with the browser's VERDICT
advancing every 3rd tick (§13). Prices stay tick-fresh; verdicts are
decision-fresh.

### 2.2 Adaptive rate limiting (shared-IP survival)

Every Binance response carries `x-mbx-used-weight-1m`. The scanner adapts:

| Window weight | Pace |
|---|---|
| < 1200 | 160 ms between requests |
| < 2500 | 450 ms |
| < 4000 | 1400 ms |
| ≥ 4000 | 9000 ms (stand aside) |

418/429 → hard quiet starting at 5 min, doubling to 40 min; 30 min clean
resets it. Host failover: `data-api.binance.vision` → `api.binance.com` →
`api4.binance.com`.

### 2.3 Browser engine — websocket data path

| Stream | Content | Use |
|---|---|---|
| `!miniTicker@arr` | all USDT pairs' 24h stats, ~1/s | price, 24h high, universe ranking input |
| `<pair>@aggTrade` | every trade on universe pairs | tick-level price, taker buy %, trade counts, CVD, trade-size distribution |
| REST klines (once per pair) | **24h of 1m candles** (limit 288) | baseline volume bootstrap, momentum, ATR |
| REST batched ticker (5 min) | `/api/v3/ticker/24hr?symbols=[top 100]` | 24h trade-count floor for the universe |
| REST depth (paced queue) | `limit=100` for candidates | walls, spread, depth-at-TP |
| REST futures (best-effort, paced) | fapi.binance.com | OI / funding / L/S (§10) |

Prices are tick-level in the browser tier. Both tiers compute identical rows.

### 2.4 Order-book walls

Depth requests are budgeted to the **top 12 candidates** (score ≥ 50, or any
`go`/`watch` row) plus user-subscribed pairs, one pair per 2.5 s, `limit=100`
(**[AUDIT §7]** — top-20 hides walls deeper in the book; 100 costs more weight
but only for candidates). From each snapshot:

- **Ask wall** = largest single ask level (price × qty, USD) within the scan
  band (±2% of price).
- **Bid wall** = same below.
- **Spread** = `(bestAsk − bestBid)/mid × 10 000` bps.
- **Depth-at-TP** = cumulative asks from price to +7% (the TP2 runway zone).
- **Wall age** = how long the same price level has persisted across snapshots
  (±0.05% tolerance) — see §10.
- Wall data older than **75 s** is reported as *"no data"* (honest), never
  guessed.

**Wall-break confirmation (kept from V2 — the audit liked it):** a break only
counts after price **holds above the wall 2 full minutes**; a moved wall
resets tracking. Kills the wick-through-and-dump fake breakout.

---

## 3. Universe selection — volume anomaly, not absolute volume

**[AUDIT §2.2 — critical]** The old universe was the top-40 pairs by
*absolute* 24h volume: BTC, ETH, SOL, XRP, DOGE… — large caps that
structurally cannot pump 3% in an hour. That pointed a pump detector at the
least pump-prone assets on the exchange.

The V2.1 universe ranks by **volume anomaly** — "money is arriving *here*,
*now*":

```
anomaly(pair) = 24h quote volume / median(24h quote volume of the same pair
                                                over the last 7 days)
```

Every 5 minutes:

1. Keep `*USDT` pairs; apply the fixed blacklist (§3.1).
2. Hard liquidity floors: **24h quote volume ≥ $2,000,000** and
   **24h trade count ≥ 5,000** (the trade-count floor needs the batched
   ticker; if that call fails the floor is honestly skipped for that round).
3. Rank by anomaly (pairs with < 2 history samples get anomaly 1 and rank
   after, by absolute volume — so a fresh install starts as the old
   behavior and converges to anomaly ranking within a day).
4. Take the **top 60** (was 40 — the anomaly metric is meaningless on a
   40-coin pool dominated by anchors).
5. `BTCUSDT` + `ETHUSDT` always ride along (BTC feeds the regime filter).

**History persistence:** one snapshot per pair per 3-hour bucket, 56 samples
(7 days), capped to ~400 highest-volume pairs. Server: JSON file
(`mini-services/radar/data/vol-history.json`); browser: localStorage
(`sift:volhist:v1`). Median-based, so a single weird snapshot can't poison it.

### 3.1 The fixed blacklist **[AUDIT §2.1 — critical bug fix]**

The old rules — "any base ending UP/DOWN/BULL/BEAR" and "3–6 char bases
ending in B" — were substring heuristics that silently killed **JUP** (ends
"UP"), **BNB, SHIB, ARB, CKB, DGB** (end "B"). Binance's leveraged tokens are
delisted, so those rules produced *only* false negatives. V2.1 uses exact
matches only:

| Category | Rule |
|---|---|
| Stablecoins | exact set: USDT, USDC, FDUSD, DAI, TUSD, USDP, BUSD, BFUSD, USDS |
| Fiat pairs | exact set: EUR, GBP, BRL, AUD, TRY, … (16 members) |
| Pegged assets | exact set: RLUSD, USD1, USDE, USD0, PYUSD, EURC, … (17 members) |
| Leveraged tokens | exact set (BTCUP, ETHDOWN, …) + the pattern `^[A-Z0-9]+[1-5](L|S)$` (BTC3L-style) |

AUDIO no longer dies (fiat list is exact-match, not prefix). The B-stock rule
is deleted outright.

---

## 4. Per-coin derived metrics (the RadarRow)

All metrics are computed from the last **24h of 1m candles** (288 bars)
**[AUDIT §2.3 — was 60 bars]**:

| Metric | Formula | Meaning |
|---|---|---|
| `change1m/5m/15m` | close-to-close over 1/5/15 bars | impulse |
| `change24h` | from the 288-bar window (server) / 24h ticker (browser) | day-extension gate |
| `vol5mUsd` | Σ quote volume of last 5 bars | real dollars |
| `volAvg5mUsd` | **time-of-day adjusted median baseline** (§5) | what "normal" means *now* |
| `rvol` | `vol5mUsd / volAvg5mUsd` | expansion vs the coin's own clock-time norm |
| `trades5m` | Σ trades of last 5 bars | participation |
| `tradeSpike` | median-based trades-per-5m-block ratio | trade-count expansion |
| `buyPct` | `Σ takerBuyQuote(last 5) / vol5mUsd × 100` | taker-buy share |
| `closeStrength` | **range-weighted** `(c−l)/(h−l)` over last 5 bars (§6.3) | buyers paying up |
| `sessionHigh` | rolling 24h high from candles/ticker (**[AUDIT §2.6]** — was process-local) | dump detector base |
| `belowHighPct` | `(sessionHigh − price)/sessionHigh × 100` | distance from high |
| `atrPct` | 14-period ATR on 1m candles, % | per-coin noise for stop sizing |
| `beta` | rolling coin-vs-BTC regression (§6.2) | market sensitivity |
| `residChange5m/15m` | `change − β × btcChange` | idiosyncratic move |
| `cvdSlope15m` | `Σ(takerBuy − takerSell)/Σvol` over 15m | net aggressor direction |
| `avgTradeSizeSpike` | avg trade size 5m vs baseline median | whale-vs-crowd |
| `listingAgeDays` | days since the pair's first Binance candle | new-listing veto |

**Session-high fix detail [AUDIT §2.6]:** the old `sessionHighs` map lived in
process memory — a restart at noon reset `belowHighPct` to 0 and every
"dumping" flag vanished for hours. V2.1 derives the high from the 24h data
itself (candle highs server-side, the miniTicker 24h-high browser-side), so a
restart cannot lie.

---

## 5. The volume baseline — time-of-day adjusted, self-excluded, floored

**[AUDIT §2.3 — critical]** The old baseline was the *mean of twelve 5m
blocks over the prior hour*, which (a) included the spike block itself — a
genuine 5× print got divided by a baseline inflated by its own tail — and
(b) ignored time of day: 03:00 UTC volume is 10–30% of 15:00 UTC volume on
most alts, so quiet-hour tapes constantly read as 4× "spikes" that were
merely normal-for-the-clock. This was the single largest source of false
positives.

The V2.1 baseline (`volumeBaseline()` in `baseline.ts`), computed over the
prior 24h of 5m blocks:

```
usable   = blocks minus the last 6 (30 min)          # self-exclusion
refHour  = UTC hour-of-day of the newest block
sameHour = usable blocks whose hour-of-day == refHour
base     = median(sameHour)   if |sameHour| ≥ 6      # time-of-day control
         = median(usable)     otherwise              # honest fallback
floor    = mean(usable) / 20                          # new-listing guard
baseline = max(base, floor)
rvol     = vol5m / baseline
```

- **Median, not mean** — one fat block can't drag the baseline up.
- **Self-exclusion** — the 30 minutes being measured never enter their own
  denominator.
- **Same-hour-of-day** — 03:00 is compared to 03:00. With only 24h of data
  this is the minimum viable control; persisting 7 days of blocks would give
  the full same-slot median, and the interface already supports it.
- **The floor** — a freshly listed pair with a ~0 median divides by mean/20,
  capping rvol at 20 instead of infinity.
- **`historyBlocks`** — the usable block count is passed to the engine; below
  20 blocks the *history* hard gate refuses a GO ("volume baseline not
  trusted yet"). No more infinite-rvol listings sneaking through.

---

## 6. The three-axis score

**[AUDIT §3.1]** The old Final Score was `Base(0–100) + momentum pts +
volume pts + wall pts + liquidity pts` — but the base score itself already
contained 25 points of momentum, the momentum filter added 15 more, and the
day-extension gate re-tested the same thing a third time. Momentum was
double- and triple-counted, so a fast mover with weak volume outranked a
genuine volume-led setup. Two filters were also near-constants: "+15 no wall
within 2%" was true on almost every book (zero discriminative power, pure
inflation), and "+5 for ≥500 trades" was trivially true for every top pair.

V2.1 replaces the pile with **three orthogonal measurement families**, each
capped, summing to a 0–100 composite that is **uncapped internally** (§8):

### 6.1 Axis A — Participation (0–40): *is the crowd here?*

| Component | Points | Formula |
|---|---|---|
| rvol | 25 | `25 × clamp01((rvol − 1)/4)` — 1× = 0, 5×+ = full |
| tradeSpike | 10 | `10 × clamp01((tradeSpike − 1)/4)` |
| absolute dollars | 5 | `5 × clamp01(vol5mUsd / 200k)` |

### 6.2 Axis B — Directional pressure (0–35): *which way, net of market?*

| Component | Points | Formula |
|---|---|---|
| residual 5m | 12 | `12 × clamp01(resid5m / bar5)` |
| residual 15m | 8 | `8 × clamp01(resid15m / bar15)` |
| taker flow | 10 | `10 × clamp01((buyPct − 50)/25)` |
| CVD slope | 5 | `5 × clamp01((cvd × dir + 0.15)/0.5)` |

**[AUDIT §3.3/§3.4] Two structural changes live here:**

1. **ATR-normalized bars.** `bar5 = max(0.15%, 0.5 × atr5m)` where
   `atr5m = atr1m × √5`. A 0.05%-ATR stable-ish coin needs a visible tick; a
   2%-ATR memecoin needs a real impulse. The same for 15m (`√15`). One
   threshold set now survives quiet coins, normal coins, and violent coins —
   the audit's requirement for regime-proof thresholds.
2. **Residual momentum.** When β is computable (rolling 60-bar regression of
   coin 1m returns on BTC 1m returns, clamped [0.1, 3]),
   `resid = change − β × btcChange`. A coin up 0.5% while BTC is up 0.5% has
   *zero* idiosyncratic strength — the old engine scored it as if the coin
   were doing the work. Raw moves are used only when β is unavailable.

**CVD divergence is a hard note here too:** price up over 15m while CVD slope
is negative = absorption/distribution — the check flips to fail and the
scenario map warns (§11). This is the single best short-term warning in the
free data set, and the raw aggTrade stream already had it.

### 6.3 Axis C — Microstructure (0–25 + penalties): *can the move actually travel?*

| Component | Points | Formula |
|---|---|---|
| close strength | 10 | range-weighted (below), × direction |
| wall quality | +8/+10/−15/−7 | relative scoring (below) |

**Range-weighted close strength [AUDIT §4]:** a tight doji and a wide
impulse candle used to count equally. Now each of the last 5 closed bars
contributes `0.5 + (raw − 0.5) × w` where `raw = (c−l)/(h−l)` (0.5 when
`h == l` — the old division-by-zero guard, kept) and
`w = min(1, range%/(2 × atr1m%))`. Only candles with meaningful range move
the score.

**Relative wall scoring [AUDIT §3.2]:**

| Situation | Points |
|---|---|
| No wall in the scan band | **+8** (modest runway — *not* the old free +15) |
| Price beyond the wall (broken, confirmed by the 2-min hold) | **+10** |
| Wall > 1× **one-sided taker flow** and aged ≥ 60 s | **−15**, "cannot break" |
| Wall > 1× taker flow but younger than 60 s | **−7**, "half weight — possible spoof" |
| Book not fetched | 0, honestly "no data" |

Two changes matter here. First, the wall is compared to **one-sided taker
flow** (buy flow for ask walls: `vol5m × buyPct/100`) instead of two-sided
tape — an ask wall is eaten by buyers, not by the full tape. Second, **wall
age** discounts walls that appeared seconds ago (probably spoofed) until
they persist a minute. The old engine treated a 5-second spoof and an
8-minute real wall identically.

**Penalties (subtract from the composite):**

| Condition | Penalty |
|---|---|
| trades5m < 200 | −20 (liquidity floor) |
| spread > 15 bps | −10 (exits pay the spread) |
| buyPct > 85% on < 200 trades | −15 (fake-buyer trap — kept from V2) |
| avg trade size ≥ 3× baseline on thin count | −10 (whale prints, not a crowd) |
| funding > +0.05%/8h (long) / < −0.05% (short) | −10 (crowded side, squeeze-prone) |
| OI falling while price rises (long) | −5 (short squeeze, exhausts fast) |
| L/S account ratio extreme for the side | −5 (retail crowding) |
| OI ≥ +0.3% and price up (long) | **+5** (new money, real move) |

The OI/funding/L-S weights are **provisional (ASSUMED)** — see §18's
tuned/untuned split; they are displayed and logged so their contribution
distributions can be measured before they're trusted.

---

## 7. Hard gates — what a GO must survive

A GO is **not** just a number. After the composite clears the bar, every gate
must pass or the verdict is demoted to `watch` with the vetoing gate recorded
(`longDemoteGate` — which feeds the shadow log, §15.4):

| Gate | Long requirement | Short requirement |
|---|---|---|
| Listing age | ≥ 3 days since first candle | same |
| Baseline trust | ≥ 20 usable baseline blocks | same |
| Momentum (ATR-normalized) | residual 5m & 15m > their ATR bars | mirrored |
| Day extension (**ATR-normalized**) | `change24h ∈ [−band, +min(8, band)]`, `band = clamp(3 × atrDaily, 3, 15)` | widened band + hard bounds |
| Real money | vol5mUsd > $50k | same |
| Participation | trades5m ≥ 200 | same |
| Volume expansion | rvol ≥ 2× (vs the §5 baseline) | same |
| Crowd side | buyPct ≥ 52% | buyPct ≤ 48% |
| BTC 15m regime | not dump (in BTC-ATR units, §7.1) | not bull |
| BTC 1h alignment | BTC 1h > −0.1% (bull-trap filter) | BTC 1h < +0.1% |
| Spread | ≤ 15 bps when known | same |
| Profit runway | plan not wall-blocked; ≥ 1 block of depth to TP2 | mirrored |
| Position vs wall | not below an unbreakable aged wall | not above an unbreakable bid floor |

### 7.1 The BTC regime in ATR units **[AUDIT §3.3]**

`btcMode = bull | flat | dump` from BTC's 15m move **divided by BTC's own
15m ATR**: bull when `change15m > max(0.3%, 0.5 × btcAtr15m)`, dump when
below the negation. A 2%-ATR BTC needs a real move to count as bullish; a
0.1%-ATR BTC flips on ticks but the absolute floor keeps legacy behavior as
the fallback. The regime bar is computed from BTC klines every scan and fed
to the engine alongside the change.

### 7.2 Ledger reset on regime flip **[AUDIT §10]**

A bearish block earned during a dump regime used to persist into the bull
flip that followed. V2.1 clears directional blocks (keeping repeat dampers)
whenever the regime mode changes between scans.

---

## 8. Verdict thresholds, the uncapped score & the expectancy gate

```
composite = Axis A + Axis B + Axis C + penalties     (0–100 nominal)
```

**[AUDIT §2.5] The composite is UNCAPPED internally.** The old score capped
at 100, so a 113 and a 145 were indistinguishable — no ranking, no
calibration, no prioritization under the 6-signals-per-scan cap. V2.1:

- **Ranking:** GO candidates fire in uncapped-score order before the
  per-scan cap — `go_long`/`go_short` priority is no longer arbitrary.
- **Display:** the UI shows `min(100, score)` with a `100+` marker; the true
  value rides in the tooltip.
- **Calibration:** the backtest bins trades by uncapped score (§11.2), so
  the number on the pill maps to an empirical hit rate.

| Composite | Verdict (bull mode) | Flat mode | Dump mode (shorts) |
|---|---|---|---|
| ≥ goScore (60) | **GO** — gates still apply (§7) + the expectancy gate (§8.3) | ≥ goScoreFlat (67) | ≥ goScoreShortDump (55) |
| ≥ watchScore (47) | **Watch** | same | same |
| below | **Skip** | same | same |
| BTC dumping / bull | longs `blocked_btc` / shorts `blocked_btc` | | |
| stablecoin | `stable` (runtime veto, kept) | | |

Row verdict priority: `stable` → `go_long` → `go_short` → `blocked_btc` →
`watch` → `skip`.

### 8.2 The measured truth (the shipped default calibration)

Before shipping these constants, the engine was replayed over **90 days of
5m bars on 8 mid-cap pairs** (volume ranks 50–130 — the anomaly universe's
home turf), net of the 0.25% round-trip cost, pessimistic same-bar ordering,
partial exits at TP1 with breakeven runners. Hit rate by uncapped score band:

| Score band | n | P(TP1 before stop) | net expectancy/trade |
|---|---|---|---|
| 30–40 | 18 | 20% | −0.37% |
| 40–50 | 138 | 24% | −0.34% |
| 50–60 | 302 | 26% | −0.28% |
| 60–70 | 603 | 26% | −0.30% |
| 70–80 | 456 | 25% | −0.28% |
| 80+ | 79 | **38%** | **−0.06%** (≈ breakeven) |

Two honest readings:

1. **The score ranks** — hit rate rises from 20% to 38% across bands (and
   the top band is at breakeven), so the composite measures *something real*.
2. **No band pays for itself in this window** — the 2R-target structure needs
   ~42%+ after costs (§8.3 math), and 38% is the best the last 90 days offer.
   On the top-10 majors the picture is worse (21–24% flat across bands) —
   precisely the audit's §2.2 point that majors are the wrong universe.

The original V2's 55–65% claims were artifacts: gross-of-fees grading,
full-exit-at-TP1 grading, the broken 15m momentum measurement (a single
stale bar — fixed in §15), 30-day windows, and survivorship-biased coin
selection. This table is the number the app now shows you.

### 8.3 The expectancy gate — a GO must pay for itself

A GO requires **one more hard gate**, evaluated from the calibration:

```
c        = cost% / stopPct                       // cost in R units
hitR     = 0.5×2R + 0.5×(0.5×3.5R + 0.5×0R)      // partial TP1 + 50/50 runner
                                                   //   → 1.875R gross per hit
lossR    = 1R
estExpR  = p×(hitR − c) − (1−p)×(lossR + c)
GO       ⟺ estExpR ≥ minExpectancyR (0.10R)
```

`p` comes from the score band's calibrated hit rate — **your own backtest's
bins when they exist, the shipped 90-day measurement (§8.2) otherwise.** With
the shipped default (p ≤ 0.38), estExpR stays negative at every stop
distance, so live GOs are currently rare-to-none and candidates show
"watch" with the honest note: *"Calibrated hit rate 26% (n=480) → est.
−0.47R per trade — below the +0.10R GO floor; a backtest on a kinder window
re-opens this."* Every expectancy veto lands in the shadow log like any
other gate, so the cost of honesty is itself measurable. The **backtest
replay runs with this gate OFF** — the replay is the calibration instrument
and must see the raw signal, or it could never recalibrate the live one.

---

## 9. Trade plans — constant-R geometry, constant dollar risk

**[AUDIT §2.4 — the most important trade-plan change]** The old clamp
`riskPct = clamp(atr, 1.0, 1.6)` inverted the risk geometry: a quiet 0.4%-ATR
coin got a 1.0% stop and a TP1 5 ATR away (almost never reachable in 2h),
while a violent 3%-ATR coin got a 1.6% stop *inside its own noise*
(guaranteed stop-out). The clamp broke the one property that made the 2R/3.5R
structure work.

### 9.1 Stop distance — tracks the coin's own noise

```
stopPct = clamp(1.3 × atr1m, 0.8%, 2.5%)
```

- **1.3 × ATR** — the stop sits outside one noise band (industry-standard
  structure distance).
- **Floor 0.8%** — below this, fees + noise eat the edge. Measured on the
  90-day replay: the 0.6% floor lost −0.40R/trade; 0.8% lost −0.26R — the
  cost-to-R ratio (`c = 0.25/stop`) is why tight stops are so hard to pay
  for, exactly as the audit's fee math predicted.
- **Cap 2.5%** — beyond this the trade is unmanageable for this timeframe.

### 9.2 Take profits — now constant in ATR units

```
TP1 = entry ± stopPct × 2.0      → always ≈ 2.6 ATR away
TP2 = entry ± stopPct × 3.5      → always ≈ 4.5 ATR away
```

Because the stop tracks ATR and the TPs track the stop, the profit targets
sit at a *constant ATR distance* on every coin — quiet or violent. The
2R/3.5R reward structure is invariant by construction.

### 9.3 Management rules (displayed on every plan)

```
50% off at TP1 · stop → breakeven at +1R · runner to TP2 · flat by 2h
```

### 9.4 Constant dollar risk **[AUDIT §2.4/§5]**

```
positionSize = (equity × 0.5%) / stopPct
```

A 0.8%-stop coin gets a 2× bigger position than a 1.6%-stop coin so the
dollar loss when wrong is identical on every coin. The plan card shows this
next to the user's investment amount ("size $625 (0.5% risk)" for $1000
equity on a 0.8% stop).

### 9.5 Instrument realism **[AUDIT §5.5]**

Short plans are labeled **futures/margin instruments** — you cannot short on
Binance spot. The plan notes that funding (~0.01%/8h typical) applies on
holds; against a ≤2.5% stop and a 2h time stop, funding is noise but it is no
longer invisible.

### 9.6 Wall/runway invalidation (kept, upgraded)

A wall bigger than the one-sided taker flow sitting between entry and TP2
blocks the plan ("the tape cannot eat it yet"). New in V2.1: the plan is
*also* blocked when cumulative ask depth all the way to TP2 is thinner than
one 5m block of flow — "the exit does not exist". A blocked plan demotes a GO
to watch.

---

## 10. New signals — OI, funding, L/S ratio, CVD, trade-size skew, wall age

**[AUDIT §4 — "signals you're not using that actually predict"]** All free,
all from Binance public endpoints, all wired into the engine as score
components, checklist notes, and warnings (weights provisional — §18):

| Signal | Source | Interpretation wired in |
|---|---|---|
| **Open interest Δ15m** | `/futures/data/openInterestHist` | OI ↑ + price ↑ = new money (real) +5; OI ↓ + price ↑ = short squeeze (exhausts fast) −5 |
| **Funding rate** | `/fapi/v1/premiumIndex` | extreme positive = crowded longs → long penalty −10; extreme negative = crowded shorts → short penalty |
| **Long/short account ratio** | `/futures/data/globalLongShortAccountRatio` | retail crowding — fade extremes −5 |
| **CVD slope & divergence** | derived from the existing aggTrade stream / kline `takerBuyQuote` | price↑ + CVD↓ = absorption → momentum check fails, scenario warns |
| **Trade-size skew** | avg trade size vs baseline | ≥3× size on thin count = whale prints −10 (direct detection of what the fake-buyer trap caught only indirectly) |
| **Wall age/persistence** | tracked across depth snapshots | <60 s = probably spoofed, half penalty; aged = real, full penalty |
| **Spread** | top of the depth snapshot | >15 bps = honest veto on exits |
| **Depth at TP** | cumulative asks to +7% | exit-liquidity veto (§9.6) |
| **Listing age** | first-ever 1d candle (`startTime=0`) | <3 days = baselines meaningless, GO refused |

CVD and trade-size skew come from data the app already had — the audit's
point was that the *derivation* was missing, not the data.

---

## 11. Scenario analysis & backtest calibration

### 11.1 Scenarios (before the decision — kept)

Every assessed row carries three scenarios (bull/base/bear) built from live
signals: volume holding, taker flow, BTC regime, broken-wall support, CVD
divergence, funding crowding — each with the coin's actual TP/stop distances.
The bear case names what flips it; the base case names the ATR band it chops
in and the time stop.

### 11.2 Backtest-calibrated hit rates **[AUDIT §9 — "attach base rates"]**

When you run a backtest, the results are binned by uncapped score
(`buildCalibration`) and persisted (`sift:calibration:v1`). The live radar
then labels candidates with the *empirical* hit rate of their score band —
"est. 54% TP1-first (n=120, your 30d backtest)" — instead of implying the
score itself is a probability. Bands with n < 30 stay silent. This is a
bin-level (isotonic-style) calibration using your own data; the audit's full
logistic model needs ~1,000 trades before it's honest, and this is the
scaffolding that will carry it.

---

## 12. Signal system, anti-flip-flop cooldowns & the portfolio layer

### 12.1 Signal types (unchanged from V2)

`pump_start`, `volume_lead`, `buyer_pressure`, `seller_pressure`,
`dump_start`, `spike_collapse` (V1-style, 10-min cooldowns) and the gated
`go_long` / `go_short` (V2 verdict + ledger + portfolio guard). Max 6 per
scan, **GO candidates first in uncapped-score order [AUDIT §2.5/§10]**.

### 12.2 The CooldownLedger (kept — the audit liked it)

| Event | Consequence |
|---|---|
| Bearish signal fires | longs blocked for that pair 60 min |
| `go_short` fires | longs blocked 30 min |
| `go_long` fires | shorts blocked 30 min |
| same-side GO | cannot re-fire 30 min (repeat damping) |

Shared by live scanner, browser engine and backtest. **New:** regime flips
clear directional blocks (§7.2).

### 12.3 The portfolio layer **[AUDIT §5.2 — new]**

Per-signal verdicts with no portfolio view meant a BTC-led pump sent 40
simultaneous GOs — one trade wearing 40 tickers. The `PortfolioGuard`
(shared engine class) enforces, live in both tiers:

- **Max 3 concurrent GO signals** (45-minute active window each).
- **Correlation gate:** Pearson ρ of the last 60 1m returns vs every open
  signal's pair; ρ > 0.7 → "same trade wearing a different ticker", refused.
- **Kill switch:** 5 consecutive losing finals, or −6R on the day (≈ −3%
  equity at 0.5% risk), pauses *new* entries until the UTC day rolls — open
  positions keep managing.

Portfolio-blocked GOs land in the shadow log (gate `portfolio` /
`kill-switch`) rather than vanishing, so the cost of the guard is itself
measurable.

---

## 13. The stateful verdict layer — dwell, hysteresis, confirmation (V2.2)

**[STABILITY AUDIT Part A/B]** The V2.1 verdict was a pure function of one
row snapshot: `assessRow(input) → verdict`, no memory. With hard-step
thresholds everywhere and scans every 1–5 s over a rotating mix of fresh and
stale inputs, the verdict label was free to flicker `go ↔ watch ↔ skip` on
every scan — and the audit's read of the code found every amplifier: the
score threshold (59.9/60.0/59.9), rvol (1.99/2.00/1.99), buy % (51.9/52.0),
the BTC regime (one tick flips the whole market AND clears the cooldown
ledger), the 75 s wall-staleness cliff (±23 points instantly), the banded
calibration (p jumps 0.12 at the band edge, flipping the expectancy gate),
and the UI's score-ranked emission (a stable coin vanishes because a
*different* coin scored higher).

V2.2 adds the missing decision layer: `src/lib/market/verdict-state.ts`, a
small state machine between measurement and display. The raw assessment
stays a pure per-snapshot function (the measurement layer was sound); the
VERDICT the clients see is the state machine's output.

### 13.1 The states

| State | Meaning | Displayed as |
|---|---|---|
| `inactive` | never seen / hard-vetoed / kill switch | skip / blocked / stable |
| `candidate` | smoothed score near the watch bar | watch |
| `confirming` | smoothed score near the GO bar, awaiting confirmation | "Confirming…" |
| `go` | confirmed (N scans), dwelled, visible | GO (with a "since Xm Ys" stamp) |
| `watch` | confirmed watch — usually a demoted GO, dwelled | watch (stamped) |
| `demoting` | was go, exit not yet confirmed | still GO + "exit?" marker |

### 13.2 The reducer (per pair, per side, per verdict tick)

Order of operations inside `nextVerdictState`:

1. **Hard vetoes first** — stablecoin, BTC-regime block, kill switch. They
   bypass the data-age freeze AND dwell: refusal must be immediate.
2. **Data-age freeze** — if the stalest verdict input (klines, or the depth
   snapshot when one exists) is older than 3 × the verdict tick (9 s), the
   state holds unchanged. A cold pair's kline-pump rotation landing a block
   can never move its verdict; only fresh data can.
3. **Score smoothing** — `scoreSmooth = 0.25 × raw + 0.75 × prev` (EWM,
   ~7 s half-life at the 3 s tick). The raw composite never drives a
   transition directly.
4. **Transitions with hysteresis + confirmation + dwell:**
   - enter `confirming` at `scoreSmooth ≥ goBar − 3`;
   - enter `go` after **3 consecutive qualifying scans** (5 in BTC flat mode
     — chop needs more proof) with all classic gates green; a failing gate
     RESETS the streak;
   - a `go` cannot leave before **45 s of dwell** (a candidate holds 30 s, a
     confirming 15 s — the lower states dwell too, a live flip-ratio fix);
   - a `go` exits only when `scoreSmooth < 53` (enter bar 60) for **3
     consecutive scans** — the exit is itself confirmed, and the interim
     state is `demoting` (still displayed as GO with an "exit?" marker);
   - a `watch` dwells 60 s and exits only under 42 (enter 47; a candidate
     holds to the same 42 deadband before falling back to inactive).

Every transition writes `lastChangedMs` and a human-readable
`lastChangeReason` ("exit pending — smoothed 51 < 53 (2/3)", "confirmed — 3
scans over the bar, gates green", "stale 41s — verdict frozen"), which the
UI renders as the stamp and the tooltip.

### 13.3 Gate hysteresis (deadbands on every hard gate)

While a pair's state is `go`/`demoting`, the hard gates themselves run their
EXIT thresholds — hysteresis lives in the gates too, not only above them:

| Gate | Enter | Exit (hold) |
|---|---|---|
| Volume expansion (rvol) | ≥ 2.0× | ≥ 1.6× |
| Crowd (buy %, long) | ≥ 52% | ≥ 49% |
| Crowd (buy %, short) | ≤ 48% | ≤ 51% |
| Momentum (residual vs ATR bar) | > 0.5 × bar | > 0.35 × bar |
| Spread | ≤ 15 bps | ≤ 22 bps |
| BTC 1h alignment (long) | > −0.1% | > −0.25% |

The SCORE is never smoothed at the source — measurement stays raw; only
pass/fail boundaries widen.

### 13.4 The dwelled BTC regime

`btcModeFor()` (the raw step function) is replaced in all tiers by
`nextBtcRegime()` — a tracker with an **ATR deadband plus dwell**:

- enter bull/dump at **0.5 × BTC's own 15m ATR**, leave only under
  **0.3 × ATR** (a wide deadband — the regime can't oscillate on ticks);
- a flip must persist **15 s** before it becomes effective;
- on an effective flip, the cooldown ledger's directional blocks are
  **SHORTENED to ≤ 10 minutes, not cleared** — blocked pairs re-enter the
  candidate pool gradually instead of as one burst (V2.1 cleared them
  outright: the flip itself was a burst amplifier, now dead twice over).

### 13.5 Wall-score interpolation + absence confirmation

Two flicker kills in the microstructure axis:

- **Staleness interpolation:** the wall contribution ramps linearly from
  full at 30 s to zero at the old 75 s cutoff — no cliff. A hard-gate wall
  veto additionally needs `interp ≥ 0.5` (half-stale data doesn't demote).
- **Absence confirmation:** "no wall in band" earns its +8 only after the
  book has shown **30 s of continuous, fresh absence** — a wall being
  pulled and republished can no longer oscillate the score by ±23 points.

### 13.6 Continuous calibration

`lookupHitRate` now interpolates p **linearly between band midpoints** over
a monotone (pool-adjacent-violators, decided-weighted) fit of the binned
rates. A pair at 79.9 and one at 80.1 can no longer straddle a 0.12 jump in
p — the score is continuous and the expectancy gate's input now is too.

### 13.7 The overlay — and where the expectancy gate still sits

After the state machines advance, `overlayVerdictState` rewrites the row's
verdict fields from the states; the stateless assessment's verdict survives
as `rawVerdict` (diagnostics). The **expectancy meta-gate stays downstream**
of the state machine exactly as before:

- state `go` + raw verdict `go` → **GO LONG / GO SHORT** (fires);
- state `go` + expectancy veto → **"would-be GO"** — displayed honestly
  (shadow mode, §13.9) with the numbers, never fired;
- state `go` + a classic gate failing *through the deadband* → watch with
  the exit confirmation already running.

A GO signal fires on the state machine's **transition into `go`** —
confirmed, dwelled, hysteresis-held — in live and replay alike.

### 13.8 Pinned emission order + persistence

Rows are emitted **GO states first, rows pinned after leaving GO/watch
second (2-minute pin), then everything else by smoothed score** — a visible
coin can no longer be bumped out of sight by a new candidate. The browser
engine persists the state maps to localStorage every 30 s, so a page reload
does not reset every dwell timer.

### 13.9 The UI contract

- **Verdict badge reads the state** — `GO LONG · 2m 14s` (the stamp is
  visible proof of stability), `Confirming…`, `GO · exit?` for demoting.
- **Hover tooltip = lastChangeReason** — "why is this about to change", not
  a silent vanish.
- **Shadow mode (default on)** — shows the would-be GOs the expectancy gate
  is honestly refusing, with their note ("Calibrated hit rate 26% (n=480) →
  est. −0.47R — below the +0.10R floor"). The refusal is the interesting
  state; hiding it was the "always watch" perception problem.
- **Stability chip** — churn / flip ratio / stale-flip ratio from the
  verdict-change log (§13.10), always visible in the radar header.

### 13.10 Instrumentation — measuring the fix

Every state-name change is logged with `{pair, side, at, from, to,
scoreSmooth, rawScore, dataAgeMs, firstFailingGate, reason}` (bounded at
300 entries; the browser persists it with the states). The header's
stability chip computes over the last 10 minutes:

| Metric | Healthy target |
|---|---|
| verdict changes / pair / min | < 2 |
| flip ratio (change reversed within 30 s) | < 10% |
| stale-flip ratio (change while data age > 2 × cadence) | < 5% |
| per-gate change attribution | names the largest remaining flicker source |

### 13.11 The backtest drives the same machine

`backtestSymbol` advances the state machines at every CLOSED 5m bar with
`replayVerdictConfig()`: confirmation 3 scans → 2 bars, dwell 45 s → 1 bar,
exit confirm 1 bar, freeze disabled (a closed bar is fresh at its own
close). Trades fire on the transition into `go` and are scored by
`scoreSmooth` — the calibration bins map what the live system ranks by. If
the live verdict and the replay verdict came from different code, that
would re-create the audit's central complaint; they don't.

---

## 14. Outcome grading — accountability loop (kept)

Every fired signal is tracked to maturity: price/change at 5/15/60 min,
running direction-adjusted MFE/MAE, persisted (SQLite via ingest webhook
server-side; localStorage browser-side). GO signals store their plan
(stop/TP1/TP2/ATR/riskPct) so the log grades against the plan. The browser
engine's kill switch is fed from these finals (§12.3). The log prunes at 7
days. Known honesty gap (kept from V2, now stated): MFE/MAE use last-price,
not fill-price, and do not subtract fees.

---

## 15. Backtest — the honest edition

**[AUDIT §6 — "the weakest link"]** The V2 backtest was honest about order
books but dishonest by omission about nearly everything else. V2.1:

### 14.1 Point-in-time universe

Coins are chosen by **24h volume as of the window's start**, not today —
each candidate's volume at `windowStart` is read from one `1d` kline
(`endTime=windowStart`). The candidate pool is still today's top-120 (free
APIs don't serve point-in-time *lists*), which is stated in the UI: the
selection *within* the pool is point-in-time, the pool itself carries
survivorship. This kills most of the "replaying the coins that already
pumped" bias at zero cost.

### 14.2 Costs on every trade

`cost = 0.25%` per round trip (2 × 0.1% taker + estimated alt slippage),
subtracted from every graded trade. The stats default to **net**; a toggle
shows gross. At a 1.2% stop this is ~21% of the risk unit — the margin the
old backtest silently overstated.

### 14.3 Partial-exit grading (matches §9.3)

- Stop before TP1 → `loss` (−1R − cost).
- TP1 then return to entry → `be` ("TP1→BE": +0.5×TP1 − cost).
- TP1 then TP2 → `big_win` (+0.5×TP1 + 0.5×TP2 − cost).
- Neither level in 24 bars (2h time stop) → `timeout`, mark-to-market.
- Same-bar stop + target → **stop wins** (kept — the audit's first "genuinely
  strong" item).

`winRate` now means **P(TP1 touched before the stop)** — the calibration
target the hit-rate labels quote.

### 14.4 The shadow log **[AUDIT §6 — "the single cheapest accuracy tool"]**

Every would-be GO that a gate (or the cooldown ledger, or the portfolio
guard) vetoed is graded as if it had fired, tagged with the **first blocking
gate**. The Gate-efficacy table then answers the question the old system
could never answer: *is this gate blocking winners or losers?* A gate whose
rejections would have hit 58% is costing money; one whose rejections hit 32%
is doing its job. The browser engine keeps the same log **live** (vetoes
graded at 60 min, 30-min dedupe), shown beside the backtest table.

### 14.5 Statistics & sample honesty **[AUDIT §3.5]**

Win rate with a **Wilson 95% CI**, expectancy in **R units**, profit factor,
and the verdict text keyed to *expectancy × trades*, not win rate
(≥0.30R with ≥100 decided = "edge worth trusting"; <100 decided gets an
explicit "sample too small — you are fitting noise" note; the audit's math:
~150 trades put a ±8% CI around a 60% rate). The intro copy states the
target explicitly: fewer than ~1,000 backtested trades and no threshold
decision is meaningful.

### 14.6 Walk-forward sanity

Results split at the median time into first/second halves; if the halves'
win rates differ by >15 points, the UI warns about in-sample drift. The tune
script's grid searches over one window and the shipped constants are its
best-**CI** pick, not its point-estimate peak.

### 14.7 Still honestly missing

Historical order books (wall filter off in replay — live is strictly
stricter, and the wall block remains flagged UNTUNED), historical OI/funding
(null in replay), and the 5m→1m ATR conversion uses the measured √5 scaling
(the old ÷2.2 was numerically the same but undocumented).

---

## 16. Bots & FreeCryptoAPI integration (unchanged)

A **bot** = investment amount + entry + direction + **target range** [low,
high] + optional **stop range** + expiry, in browser localStorage. While any
bot is armed: REST poll loop → `POST /api/bot/poll` (server proxy; the
FreeCryptoAPI key never reaches the browser) at 8 s visible / 45 s hidden,
with live-tape ingestion from the radar and a targeted 1.5 s-debounced
confirm poll before any notification. State machine:
`watching → in_target → (re-arm | stopped | expired)`, with sound + toast +
native notification. FreeCryptoAPI outage → Binance public ticker failover.

---

## 17. Reliability engineering (kept, plus the restart-proof fixes)

| Problem | Solution |
|---|---|
| Binance IP bans on shared egress | adaptive weight pacing, doubling backoff, 3-host failover |
| State lost on restart **[AUDIT §2.6]** | session high from 24h data; volume history persisted to disk/localStorage; listing ages persisted |
| Scan staleness at high volume **[AUDIT §5.4]** | hot/cold priority rotation in the kline pump |
| One user's spend × N visitors | one scanner feeds everyone over socket.io |
| Websocket blocked | automatic tier downgrade: socket → REST → in-browser engine |
| Missing data | displayed as **"No Data"** — never a fake pass |
| Correlated simultaneous GOs **[AUDIT §5.2]** | portfolio guard: concurrency cap, ρ-gate, kill switch |
| Netlify build minutes | build happens locally, only artifacts upload |

Free sources layered: CoinPaprika (board/detail/global), DeFiLlama (history
fallback), alternative.me (Fear & Greed), Binance spot + futures public
endpoints — all behind TTL-cache + inflight-dedup + stale-serve.

---

## 18. Complete tunables table (tuned vs assumed)

**[AUDIT §15 — "half the tunables had no derivation"]** Every constant in
`V2` (v2-engine.ts), sorted by evidence. **TUNED** = derived from replaying
real history (`scripts/tune-v2.ts`, 14d × 16 coins, ranked by net
expectancy-R × trades with Wilson-CI finalists). **ASSUMED** = documented
rationale, no validated derivation — these are the high-risk knobs; the
shadow log (§15.4) is the instrument that will retire them.

| Constant | Value | Class | Derivation |
|---|---|---|---|
| `goScore` | 60 | TUNED | 90-day measured calibration — top bands carry the only near-breakeven expectancy; the expectancy gate does the precision work |
| `goScoreFlat` | 67 | TUNED | goScore + 7 (flat-regime strictness) |
| `goScoreShortDump` | 55 | TUNED | dump-mode short bar, own calibration (audit §3.7: shorts are not mirrored longs) |
| `watchScore` | 47 | TUNED | display boundary; does not gate trades |
| `minExpectancyR` | 0.10 | TUNED structure / ASSUMED margin | the GO floor: estExpR from the calibrated hit rate must clear it (audit suggested 0.15; 0.10 lets genuinely good user calibrations through at moderate stops) |
| `DEFAULT_CALIBRATION` | §8.2 table | MEASURED | 90d × 8 mid-caps, net of costs, pessimistic grading — replaced by the user's own backtest on first run |
| `goMinRvol` | 2 | TUNED | volume-expansion gate |
| `momentumAtrMult` | 0.5 | ASSUMED | ½-ATR impulse; structure TUNED (floor/grid) |
| `momentumFloorPct` | 0.15 | TUNED | visible-tick floor for dead-quiet coins |
| `btcAtrMult` | 0.5 | ASSUMED | regime in BTC-ATR units; absolute ±0.3% fallback is the legacy TUNED value |
| `dayAtrMult` | 3 | ASSUMED | 3× daily ATR band, clamped to the old TUNED −5/+8/−15/+5 hard bounds |
| `volHighUsd` / `volLowUsd` | $100k / $50k | TUNED | liquidity floors (absolute by design) |
| `tradesLow` | 200 | TUNED | participation floor |
| `stopAtrMult` | 1.3 | ASSUMED | industry-standard noise band |
| `stopMinPct` / `stopMaxPct` | 0.8 / 2.5 | TUNED | fee/noise floor (measured: −0.26R vs −0.40R at 0.6%) / manageability cap |
| `tp1Mult` / `tp2Mult` | 2 / 3.5 | TUNED | constant-R geometry |
| `partialTp1Fraction` | 0.5 | ASSUMED | standard practice |
| `beAtR` | 1 | ASSUMED | breakeven after +1R |
| `timeStopMin` | 120 | TUNED | equals the backtest window |
| `equityRiskFraction` | 0.005 | ASSUMED | 0.5% per trade |
| `backtestCostPct` | 0.25 | ASSUMED | 2× taker fee + slippage estimate; charged in backtests AND in the live expectancy gate |
| `wallVsTaker` | 1 | ASSUMED (wall block: **UNTUNED** — cannot backtest books) |
| `wallFreshSec` | 60 | ASSUMED | spoof discount until persistence proven |
| `wallScanPct` | 2 | ASSUMED | scan band |
| `wallConfirmMs` | 120,000 | TUNED | 2-min hold kills wick fakes |
| `spreadMaxBps` | 15 | ASSUMED | exit-cost veto |
| `listingMinAgeDays` | 3 | ASSUMED | baseline-trust veto |
| `historyMinBlocks` | 20 | ASSUMED | rvol-trust veto |
| `fundingCrowdedPct` | ±0.05 | ASSUMED | provisional positioning weight |
| `oiRealChange` | 0.3 | ASSUMED | provisional |
| `fakeBuyersPct/Trades` | 85 / 200 | TUNED | kept from V2 |
| `sellersDumpingPct/VolUsd` | 40 / 100k | TUNED | kept |
| `goMinBuyPctLong/Short` | 52 / 48 | TUNED | crowd gate |
| cooldowns (60/30/30/30 min) | — | TUNED | kept from V2 |
| `maxConcurrentSignals` | 3 | ASSUMED | portfolio cap |
| `correlationMax` | 0.7 | ASSUMED | ρ-gate |
| `killSwitchLossStreak` / `killSwitchDayLossR` | 5 / −6R | ASSUMED | kill switch |
| universe | top 60 by 7-day volume anomaly | TUNED structure | floors $2M vol / 5k trades |
| scan cadence | 3 s server (verdict tick) / 1 s browser prices, 3 s verdict | — | compute-only |

### 18b. Verdict-layer constants (V2.2 — the stability knobs)

**[STABILITY AUDIT Part B.9]** All ASSUMED — deliberately. These are
*stability* knobs, not *edge* knobs: they do not change WHICH setups fire,
only how steadily the verdict is expressed. Raising `goScore` to fix
flicker would trade fewer signals for still-flickering ones — the
deadbands and dwell are the fix, and the stability chip (§13.10) measures
them so they can be retired with evidence, not faith.

| Constant | Value | Why |
|---|---|---|
| `verdictScanCadenceMs` | 3 000 | 10× fewer recomputations than the 1 s price tick; decisions don't need tick speed |
| `scoreAlpha` | 0.25 | EWM half-life ≈ 7 s at the 3 s tick — one noise spike can't cross a bar |
| `goExit` / `watchExit` | 53 / 42 | 30–40 % deadband below the enter bars (60 / 47) |
| `goConfirmScans` / `goConfirmScansChop` | 3 / 5 | ~10 s / ~15 s of consecutive proof; flat BTC mode needs more |
| `goExitConfirmScans` | 3 | the EXIT is confirmed too — no one-tick demotions |
| `goDwellMinMs` / `watchDwellMinMs` | 45 s / 60 s | the core flicker killer — a confirmed verdict can't leave instantly |
| `candidateDwellMs` / `confirmingDwellMs` | 30 s / 15 s | the LOWER states dwell too — live flip-ratio fix (41% → target < 10%) |
| `displayPinAfterLeaveMs` | 120 s | a row leaving GO stays pinned — no vanish-after-exit |
| `dataAgeFreezeMultiplier` | 3 × cadence | stale inputs hold the state; only fresh data moves a verdict |
| `btcRegimeDwellMs` | 15 s | the biggest burst amplifier, dead |
| `btcRegimeAtrEnter` / `btcRegimeAtrExit` | 0.5 / 0.3 | ATR deadband on the regime flip itself |
| `wallAbsentConfirmMs` | 30 s | kills the pull-and-republish wall oscillation |
| `wallStaleInterpolateMs` | 30 s | wall score ramps to zero by 75 s — no cliff |
| `rvolExit` / `buyPctLongExit` / `buyPctShortExit` | 1.6 / 49 / 51 | gate deadbands while a GO holds |
| `spreadExitBps` / `residExitMult` / `btc1hLongExit` | 22 / 0.35 / −0.25 | same — enter strict, exit loose |
| replay: `goConfirmBars` / `goDwellBars` / `goExitConfirmBars` | 2 / 1 / 1 | the state machine at bar close (§13.11) — what you backtest is what you trade |

To re-tune: `bun scripts/tune-v2.ts [days] [coins]` — prints long/short/
combined rankings by net expectancy-R × trades with CIs. Pick the config
whose CI excludes zero.

---

## 19. Worked examples

**1. The old blacklist killing real tokens [AUDIT §2.1].** JUP (Jupiter,
top-40 volume) ends in "UP" → V2 excluded it from the universe. BNB — the
benchmark asset — ends in "B" → excluded. SHIB, ARB, CKB, DGB, TRB → all
excluded. V2.1's exact-match blacklist admits all of them while still
killing every actual stablecoin, pegged asset, fiat pair and leveraged token.

**2. The old baseline inventing a spike [AUDIT §2.3].** A coin trading its
normal 03:00 UTC volume (10–30% of its afternoon volume) read as a 3–4×
"rvol spike" against a 15:00-anchored baseline → false GOs all night. V2.1
compares 03:00 to 03:00: the same tape reads 1.1× and the engine stays quiet.

**3. The old ATR clamp breaking a quiet coin [AUDIT §2.4].** Coin with
0.4% 1m ATR: old stop 1.0% (2.5 ATR), TP1 2.0% = 5 ATR away — a 2-hour coin
flip that almost never pays. V2.1: stop 0.8% (fee/noise floor — the 90-day
measurement showed 0.6% losing an extra −0.14R to costs), TP1 1.6% ≈ 2.6 ATR —
the same geometry as every other coin, and the position size scales to keep
the dollar risk constant.

**4. A hypothetical V2.1 GO — and why you currently won't get one.** An
anomaly-ranked universe picks a rank-140 coin at 2.8× volume anomaly; rvol
3.1 vs its own 21:00-UTC baseline; residual 5m +0.42% vs a 0.5×ATR bar of
0.28% (β 1.1, BTC +0.15%); takers 61% buys; CVD +0.2; close strength 0.72
range-weighted; no aged wall in band; spread 6 bps; funding +0.01%; OI
+0.6%. Participation 24/40 + Directional 26/35 + Micro 19/25 = **69 →
crosses the 60 bar in bull mode**. Gates: listing 340d ✓, history 276
blocks ✓, momentum ✓, day +3.1% inside the ATR band ✓, $180K/5m ✓, 640
trades ✓, crowd ✓, BTC flat-not-dump ✓, spread ✓, runway ✓ — and then the
**expectancy gate**: the 60–70 band's calibrated hit rate is 26%, est.
−0.47R < +0.10R floor → **demoted to watch** with the note showing the
numbers. If your own backtest window measures that band at 48%, estExpR
= +0.28R → the same setup fires `go_long` with entry, stop −1.3×ATR
(clamped 0.8–2.5%), TP1 +2×stop, TP2 +3.5×stop, half off at TP1, BE at
+1R, flat by 2h, size = equity×0.5%/stop.

**5. The portfolio guard refusing a same-trade [AUDIT §5.2].** BTC leads a
market-wide pump; 14 coins clear the GO bar within minutes. The guard fires
the top-uncapped-score three, refuses the rest at ρ > 0.7 with each open
position, and logs every refusal to the shadow log where their would-be
outcomes are graded — the cost of the guard is visible, not assumed.

---

## 20. Known limitations (honest list)

1. **No filter set predicts the market — and the app now says so.** The
   measured 90-day calibration (§8.2) ships INSIDE the engine: hit rates of
   20–38% by band, no band at positive net expectancy in that window. The
   expectancy gate keeps live GOs off until a backtest on your window
   shows a band that pays (≥ ~42–45% hit). Over-filtering toward a 65%
   fantasy was the one guaranteed way to make this worse; the fix is the
   opposite — measure, label, and refuse.
2. **Sample size is the binding constraint.** Fewer than ~1,000 backtested
   trades = fitting noise. The backtest UI says so instead of implying
   confidence.
3. **The wall block is UNTUNED.** Historical order books aren't free, so the
   replay cannot validate `wallVsTaker`, `wallFreshSec`, or the wall weights.
   Live is strictly stricter than backtest; the live shadow log is the only
   instrument that can retire this.
4. **OI/funding/L-S weights are provisional** (ASSUMED in §18) — displayed
   and logged, not validated.
5. **Point-in-time universe is a compromise**: selection within the pool is
   historical; the pool itself is today's top-120 (stated in the UI).
6. **Futures data is best-effort in the browser** (CORS on fapi can fail) —
   nulls are honest, the engine runs without them.
7. **MFE/MAE use last-price, not fill-price, and don't subtract fees.**
8. **Server-scanner tier availability**: on static hosting the browser engine
   scans only while a tab is open; the 24/7 scanner requires self-hosting the
   mini-service.
9. **Binance-only microstructure**: walls/taker flow/trade counts come from
   Binance; a coin pumping on another venue first is late. (Multi-venue
   confirmation via Coinbase/OKX/Bybit public tickers is the audit's next
   cheap add.)
10. **FreeCryptoAPI credits** are spent only while bots are armed; poll
    cadence is the cost control.
11. **The verdict-layer constants are ASSUMED (§18b)** — stability knobs,
    measured live by the stability chip (churn / flip / stale-flip ratios and
    per-gate attribution) rather than validated by replay. The state machine
    also adds deliberate latency: a GO needs ~10 s of confirmation + dwell
    before it can fire, and its exit needs ~9 s more. That is the point —
    patience, not twitchiness — but a 10-second-faster market is a real
    trade-off the UI states on every stamped verdict.
