# Sift — Complete Algorithm Reference

> **What this document is.** A full, honest description of every algorithm inside
> Sift V2: how data is captured, how each metric is derived, how the Base Score is
> built, how the seven V2 filters combine into a Final Score, how trade plans
> (entry / stop / TP1 / TP2 ranges) are constructed for both longs and shorts,
> how scenarios are generated *before* the decision, how signals are cooled down
> so they never flip-flop, how every signal is graded after the fact, and how the
> backtest proves (or disproves) the whole stack. Written so you can audit each
> threshold and judge the logic yourself.
>
> **The honesty contract first.** No filter set makes crypto predictable. Sift V2
> does not promise accuracy — it refuses obviously fake setups, sizes risk to the
> coin's own volatility, and shows the scenario map before every decision. The
> design target is *edge*, not certainty: stop at ~1–1.6%, take profits at 2× and
> 3.5× that, so at even ~55–60% win rate the math is profitable
> (`0.6 × (+2.0) − 0.4 × (−1.0) = +0.8R per trade` at TP1-only exits).

---

## Table of contents

1. [System architecture — the three tiers](#1-system-architecture--the-three-tiers)
2. [Data acquisition](#2-data-acquisition)
3. [Per-coin derived metrics (the RadarRow)](#3-per-coin-derived-metrics-the-radarrow)
4. [Base Score — the 100-point pump model](#4-base-score--the-100-point-pump-model)
5. [V2 engine — the seven filters](#5-v2-engine--the-seven-filters)
6. [Final Score & verdict thresholds](#6-final-score--verdict-thresholds)
7. [Hard gates — what a GO must survive](#7-hard-gates--what-a-go-must-survive)
8. [Trade plans — entry / stop / TP ranges (long & short)](#8-trade-plans--entry--stop--tp-ranges-long--short)
9. [Scenario analysis — before the decision](#9-scenario-analysis--before-the-decision)
10. [Signal system & anti-flip-flop cooldowns](#10-signal-system--anti-flip-flop-cooldowns)
11. [Outcome grading — accountability loop](#11-outcome-grading--accountability-loop)
12. [Backtest — proving the filters](#12-backtest--proving-the-filters)
13. [Bots & FreeCryptoAPI integration](#13-bots--freecryptoapi-integration)
14. [Reliability engineering](#14-reliability-engineering)
15. [Complete tunables table](#15-complete-tunables-table)
16. [Worked examples](#16-worked-examples)
17. [Known limitations (honest list)](#17-known-limitations-honest-list)

---

## 1. System architecture — the three tiers

One shared brain (`src/lib/market/v2-engine.ts`), three data consumers:

| Consumer | Where | Role |
|---|---|---|
| **Server scanner** | `mini-services/radar/index.ts` (port 3003 socket.io / 3004 REST) | Scans 24/7 server-side whether or not any browser is open. One scanner serves every connected client — N visitors cost the Binance API the same as one. |
| **In-browser engine** | `src/lib/market/local-radar.ts` | Binance **public websockets** (`!ticker@arr` + per-pair `aggTrade`) — no key, no server. This is what runs on static hosting (Netlify). |
| **Backtest simulator** | `src/components/sift/backtest-view.tsx` + `scripts/tune-v2.ts` | Replays 30 days of 5m candles through the *exact same* filter functions. |

The browser picks its tier automatically (upgrade path, best wins):

```
1. "live"      socket.io → server scanner            (best)
2. "fallback"  REST poll /api/radar every 6s         (websocket blocked)
3. "local"     in-browser websocket engine           (no backend at all)
```

A fast probe (~800 ms after mount) decides the tier; if the server scanner
reappears later, the app upgrades back to tier 1 automatically.

**Why one engine module for everything:** the old V1 app graded a coin on a
single 0–100 score and was right ~30% of the time. V2 refuses to speak unless
seven independent filters agree — and the backtest replays the *same code*, so
what you test is what you trade.

---

## 2. Data acquisition

### 2.1 Universe selection (what gets scanned at all)

Every 5 minutes the scanner pulls Binance's full `/api/v3/ticker/24hr` and:

1. Keeps only `*USDT` pairs.
2. **Blacklists** (these can never pump — the single biggest V1 fake-signal source):

| Category | Members |
|---|---|
| Stablecoins | USDT, USDC, FDUSD, DAI, TUSD, USDP, BUSD, BFUSD, USDS |
| Fiat pairs | EUR, GBP, BRL, AUD, TRY, NGN, UAH, ARS, MXN, ZAR, PLN, CZK, HUF, ILS |
| Pegged assets | RLUSD, USD1, USDE, USD0, PYUSD, EURC, USDD, FRAX, LUSD, GUSD, XUSD, RWUSD, XAUT, PAXG |
| Leveraged tokens | any base ending UP / DOWN / BULL / BEAR |
| B-stock symbols | 3–6 char bases ending in `B` (Binance regional units) |

3. Sorts by 24h quote volume (USD), takes the **top 40**.
4. Forces `BTCUSDT` + `ETHUSDT` into the universe (BTC feeds the market-regime
   filter; ETH is the liquidity bellwether).
5. User-subscribed pairs (open coin sheets) ride along on top of the 40.

### 2.2 Server scanner — paced data tasks (anti-burst design)

The V1 design fired ~60 requests in a burst every 5 s and got IP-banned. V2 runs
four background tasks that pace requests one at a time:

| Task | Cadence | Fetches |
|---|---|---|
| `klinePumpLoop` | 1 pair per pace-tick, rotating | `/api/v3/klines?interval=1m&limit=60` (one hour of 1m candles) |
| `statsTaskLoop` | every 60 s, batched | `/api/v3/ticker/24hr?symbols=[...universe]` — one request for all pairs |
| `universeTaskLoop` | every 5 min | full ticker → re-rank the top-40 |
| `wallPumpLoop` | 1 pair per 2.5 s | `/api/v3/depth?limit=20` for wall candidates only |

The **scan itself is pure computation over the in-memory stores — zero network.**
It runs every 5 s (server) / 1 s (browser engine).

### 2.3 Adaptive rate limiting (shared-IP survival)

Every Binance response carries `x-mbx-used-weight-1m` (the shared egress IP's
window usage). The scanner reads it and adapts its request pace:

| Window weight | Pace |
|---|---|
| < 1200 | 160 ms between requests (brisk) |
| < 2500 | 450 ms (normal) |
| < 4000 | 1400 ms (crowded) |
| ≥ 4000 | 9000 ms (stand aside) |

A 418/429 (ban) triggers a hard quiet period starting at 5 min, **doubling** on
repeats up to 40 min; 30 min of clean operation resets it. Hosts fail over:
`data-api.binance.vision` → `api.binance.com` → `api4.binance.com`.

### 2.4 Browser engine — websocket data path

| Stream | Content | Use |
|---|---|---|
| `!ticker@arr` | all USDT pairs' 24h stats, pushed ~1/s | price, 24h change, universe ranking |
| `<pair>@aggTrade` | every trade on universe pairs | tick-level price, taker buy %, trade counts |
| REST klines (once) | one hour of 1m candles per pair | baseline volume, momentum bootstrap |

Prices are therefore **tick-level** in the browser tier — faster than the 5 s
REST cadence of the server tier. Both compute identical rows.

### 2.5 Order-book walls (the expensive filter)

Depth requests are budgeted: only the **top 12 candidates** (score ≥ 50 or any
row already at `go_long` / `go_short` / `watch`) plus user-subscribed pairs get
their book fetched, one pair per 2.5 s.

- Wall data older than **75 s** is reported as *"no data"* (honest) rather than stale.
- Target refresh: every **25 s**.
- **Ask wall** = largest single ask level (price × qty in USD) within **+2%** of price.
- **Bid wall** = same within **−2%**.

**Wall-break confirmation:** when price crosses above a wall, the break only
counts after price **holds above it for 2 full minutes** (`wallConfirmMs`).
If the tracked wall level moves by >0.1%, tracking resets. This kills the
"price wicked through and instantly dumped back" fake breakout.

---

## 3. Per-coin derived metrics (the RadarRow)

All metrics are computed from the last hour of 1m candles (60 bars) — refreshed
continuously. From candle arrays `closes[]`, `quotes[]` (USD volume), `trades[]`,
`takerBuys[]` (USD taker-buy volume):

| Metric | Formula | Meaning |
|---|---|---|
| `change1m` | `(closes[last] − closes[last−1]) / closes[last−1] × 100` | last minute move |
| `change5m` | same over 5 bars | short impulse |
| `change15m` | same over 15 bars | the trend the move lives in |
| `change24h` | from 24h ticker | day-extension gate |
| `vol5mUsd` | Σ quotes of last 5 bars | **real dollars** traded in 5m |
| `volAvg5mUsd` | mean of twelve 5m blocks over the prior hour | baseline |
| `rvol` | `vol5mUsd / volAvg5mUsd` | relative volume ("3.0×" = 3× the coin's own average) |
| `trades5m` | Σ trades of last 5 bars | **participation** — one whale print vs a crowd |
| `tradeSpike` | `trades5m / avg trades per 5m block` | trade-count expansion |
| `buyPct` | `Σ takerBuys(last 5) / vol5mUsd × 100` | % of tape that was taker-buying |
| `closeStrength` | mean of `(close − low) / (high − low)` over last 5 candles | buyers paying up into strength (flat candle = 0.5 neutral) |
| `sessionHigh` | running max since scan start (+ candle highs) | dump detector base |
| `belowHighPct` | `(sessionHigh − price) / sessionHigh × 100` | how far off the high |
| `atrPct` | 14-period ATR on 1m candles, as % of price | per-coin volatility for stop sizing |

**The two traps this row design kills:**

- *Volume multiple without dollars.* V1 showed "3.0× volume" — but 3× of almost
  nothing is nothing. V2 shows the **USD figure** and gates on it (`vol5mUsd`).
- *Buyer % without trade count.* 97% buyers on 76 trades is one whale painting
  the tape, not a crowd. V1 missed it; V2 penalizes it (liquidity filter + fake-buyer trap).

---

## 4. Base Score — the 100-point pump model

This is the *starting* score the V2 filters then modify. Computed identically in
the server scanner, browser engine, and backtest:

| Component | Rule | Points |
|---|---|---|
| **RVOL spike** | `30 × clamp01((rvol − 1) / 4)` → 1× = 0 pts, 5×+ = 30 pts | 0–30 |
| **Trade spike** | `10 × clamp01((tradeSpike − 1) / 4)` — volume spike without a trade spike is one whale print | 0–10 |
| **Momentum** | 1m > 0 **and** 5m > 0 **and** 15m > 0 | +10 |
| | 5m > 0 **and** 5m ≥ 15m (accelerating) | +8 |
| | 1m > 0 **and** 1m ≥ 5m (still accelerating) | +7 |
| **Buy pressure** | `20 × clamp01((buyPct − 50) / 30)` → 50% = 0, 80%+ = 20 | 0–20 |
| **Close strength** | `15 × closeStrength` | 0–15 |

`Base Score = min(100, round(rvolPts + tradePts + momentumPts + buyPts + closePts))`

Badges derived from it: `pumped` (day > +8%), `pump` (score ≥ 80),
`dumping` (≥3% below session high), `early` (rvol ≥ 3, day between −5% and +8%).

---

## 5. V2 engine — the seven filters

The V1 failure mode was *one number decides*. V2 requires seven independent
checks to agree before any GO verdict. Each filter contributes **points** to the
Final Score; some also act as **hard blocks**.

### Filter 1 — Momentum (the tape must be green, and staying green)

| Condition | Effect |
|---|---|
| 5m > +0.40% **and** 15m > +0.40% | **+15** |
| 5m < 0 **or** 15m < 0 (tape red) | **−20** |
| 1m < −0.10% (already rolling over) | extra **−10** |

Tuned by grid search over 14 days of 5m candles: the +0.4% impulse requirement
fires 3× fewer trades at a *better* win rate than a weaker drift threshold.

### Filter 2 — Real dollar volume

| Condition | Effect |
|---|---|
| 5m volume > $100,000 | **+10** |
| 5m volume < $50,000 | **−20** |

### Filter 3 — Sell wall (order-book physics)

Within +2% above price, the largest ask wall is found:

| Condition | Effect |
|---|---|
| No wall within +2% (clear runway) | **+15** |
| Price is **above** the wall (broken out) | **+15** |
| Wall value > 5m USD volume (tape cannot eat it) | **−20** + warning *"Wall too big — cannot break"* |
| Wall present but eatable | 0 (neutral) |
| Book not fetched | 0, marked *"no data"* — never guessed |

Plus the **break confirmation**: a wall only counts as broken after price holds
above it ≥ 2 minutes. Short side mirrors this: an unbreakable ask wall *overhead*
is a **ceiling that helps the short** (+15); a big bid wall *below* is squeeze
risk (−15).

### Filter 4 — Liquidity (trade count)

| Condition | Effect |
|---|---|
| < 200 trades in 5m | **−20** |
| > 500 trades in 5m | **+5** |

### Filter 5 — Buyer trap / fake buyers

| Condition | Meaning |
|---|---|
| buyPct > 85% **and** trades5m < 200 | *"Fake buyers"* — whale painting the tape (warning + never a GO) |
| buyPct < 40% **and** vol5mUsd > $100k | *"Sellers dumping — exit / avoid"* |

### Filter 6 — BTC market regime (the macro gate)

BTC's own 15m move classifies the market:

| BTC 15m | Mode | Effect on LONGS | Effect on SHORTS |
|---|---|---|---|
| > +0.30% | **Bull** | normal 70 bar | blocked |
| −0.30% … +0.30% | **Flat** | stricter 80 bar | 80 bar |
| < −0.30% | **Dump** | **all longs blocked** | bar lowered to 65, favoured |

Also multi-timeframe: **BTC 1h falling (< −0.1%)** while 15m is green =
bull-trap risk → long demoted to watch. Mirror for shorts (BTC 1h rising).

### Filter 7 — Stablecoin immunity (veto)

Two layers:
1. The name blacklists from universe selection (§2.1).
2. **Runtime detection** — regardless of name:
   `price ∈ ($0.99, $1.01)` **and** `|change15m| ≤ 0.05%` **and** `|change24h| ≤ 1%`
   → stablecoin → verdict `stable`, score irrelevant, never tradeable.

---

## 6. Final Score & verdict thresholds

```
Final Score (long)  = Base Score
                     + momentum pts        (filter 1)
                     + dollar-volume pts   (filter 2)
                     + wall pts            (filter 3)
                     + liquidity pts       (filter 4)

Final Score (short) = Base Score
                     + mirrored momentum pts
                     + dollar-volume pts
                     + ceiling/bid-wall pts
                     + liquidity pts
                     + seller-pressure pts  (buyPct < 40% w/ real volume: +10;
                                             buyPct > 60%: −15)
```

| Final Score | Verdict |
|---|---|
| ≥ 70 (bull mode) / ≥ 80 (flat mode) | **GO** — but must still pass the hard gates (§7) |
| 60–69 | **Watch only** |
| < 60 | **Skip** |
| BTC dumping | longs → `blocked_btc` regardless of score |
| stablecoin | `stable` regardless of score |

Row verdict priority: `stable` → `go_long` → `go_short` → `blocked_btc` →
`watch` → `skip`.

---

## 7. Hard gates — what a GO must survive

A GO is **not** just a number. After the score clears the bar, *every* one of
these must also pass, or the verdict is demoted to `watch` with the reason shown:

| Gate | Long requirement | Short requirement |
|---|---|---|
| Tape color | 5m and 15m both green | both red |
| BTC 1h alignment | BTC 1h > −0.1% (no bull trap) | BTC 1h < +0.1% (dip gets bought) |
| Day extension | 24h change ∈ [−5%, +8%] — never chase a move that already happened, never catch a falling knife | 24h ∈ [−15%, +5%] — crash mostly done = bounce risk; green day fights the short |
| Real money | vol5mUsd > $50k | same |
| Participation | trades5m ≥ 200 | same |
| Volume expansion | rvol ≥ 2× | same |
| Crowd side | buyPct ≥ 52% | buyPct ≤ 48% |
| Profit runway | TP zone not blocked by a wall (§8) | same vs bid wall |
| Position vs wall | not sitting below an unbreakable ask wall | — |

Every demotion carries a human-readable warning ("Day already +9.2% — the move
happened without you", "Fake buyers — 91% buys on only 143 trades", …) —
surfaced in the UI so the trader sees *why* a signal was refused.

---

## 8. Trade plans — entry / stop / TP ranges (long & short)

This is the "what range do I trade" machinery, sized per-coin from its own
volatility and history.

### 8.1 Stop distance — ATR-scaled risk

```
atrPct     = 14-period ATR of 1m candles, % of price        (per coin!)
riskPct    = clamp(atrPct, min 1.0%, max 1.6%)
```

Rationale: a 0.5% stop on an alt with 0.4% five-minute noise is a coin flip.
Tight stops look precise and get eaten. 1.0–1.6% is the honest band.

### 8.2 Take profits — asymmetric by construction

```
TP1 = entry ± riskPct × 2.0     (risk:reward 1:2)
TP2 = entry ± riskPct × 3.5     (risk:reward 1:3.5)
```

For a typical coin (riskPct 1.0%): long entry $0.1522 → stop $0.1507,
TP1 $0.1552 (+2%), TP2 $0.1575 (+3.5%). Shorts mirror the geometry downward.

### 8.3 Dollar risk framing

The plan renders "you risk $5 → lose at most $0.05 if wrong; TP1 pays $0.10;
TP2 pays $0.175" from the bot's investment amount — so position size is a
*decision*, not an accident.

### 8.4 Wall invalidation of the profit zone

If a wall bigger than the 5m volume sits **between entry and TP2**, the plan is
`blocked`: *"Wall $44.2K at $0.1537 sits inside the profit zone — the tape
cannot eat it yet."* A blocked plan **demotes a GO to watch** — you do not aim
a take-profit through a wall the tape cannot eat.

---

## 9. Scenario analysis — before the decision

Every assessed row carries three scenarios, generated *before* the verdict is
acted on, so the trader knows what confirms and what invalidates:

| Scenario | Built from |
|---|---|
| **Bull case — "Confirms → ride to TP"** | up to 3 live signals: volume holding ≥2× average · takers ≥55% buying · BTC supportive · broken wall holding as support · thin asks overhead → then the actual TP1/TP2 distances for this coin |
| **Base case — chop** | volume normalises, price chops ±(coin's own ATR%) for an hour — *"waiting is the position"* |
| **Bear case — "Invalidated → stop"** | sellers ≥55% of tape · volume fading <1.2× · the wall refusing to break · BTC rolling over · thin trade count → the actual stop distance, and the short-side score if the tape stays red |

---

## 10. Signal system & anti-flip-flop cooldowns

### 10.1 Signal types

| Type | Direction | Detection rule |
|---|---|---|
| `pump_start` | long | score ≥ 80, 5m green, day ≤ +8% |
| `volume_lead` | long | rvol ≥ 3 with price flat (±1% 1m & 5m) and flat day — money arrived *before* the move |
| `buyer_pressure` | long | flat coin, rvol ≥ 2, takers ≥ 70% buys |
| `seller_pressure` | short | flat coin, rvol ≥ 2, takers ≤ 30% buys |
| `dump_start` | short | ≥3% below session high, rvol ≥ 2, falling 5m |
| `spike_collapse` | short | rvol fell from ≥3× to <1.5× — the crowd is leaving |
| `go_long` | long | **V2 verdict `go_long` + cooldown ledger agrees** |
| `go_short` | short | **V2 verdict `go_short` + ledger agrees** |

Max 6 signals fire per scan. V1-style signals (pump_start etc.) carry a 10-minute
per-pair cooldown; GO signals carry 30 minutes.

### 10.2 The CooldownLedger — killing the flip-flop

V1's trust killer: an 18:08 "exit" followed by an 18:15 "go long" on the same
coin. V2's ledger enforces:

| Event | Consequence |
|---|---|
| Bearish signal (seller_pressure / dump_start / spike_collapse) | longs blocked for that pair **60 min** |
| `go_short` fires | longs blocked **30 min** |
| `go_long` fires | shorts blocked **30 min** |
| same-side GO | cannot re-fire for **30 min** (repeat damping) |

The ledger is shared by the live scanner, the browser engine, and the backtest.

---

## 11. Outcome grading — accountability loop

Every fired signal is tracked to maturity and persisted (SQLite `Signal` model,
ingest webhook from scanner → Next.js API):

- **5 min later** — price & change recorded.
- **15 min later** — recorded.
- **60 min later** — recorded, status `final`.
- **Continuously** — direction-adjusted **MFE** (max favorable excursion) and
  **MAE** (max adverse excursion) since the signal fired.

Go signals additionally store the trade plan they fired with (stop, TP1, TP2,
atrPct) so the log can be graded against the plan, not just raw price. The log
prunes itself after 7 days. This is what makes "the app says it worked" a
checkable claim instead of vibes.

---

## 12. Backtest — proving the filters

The Backtest view replays **30 days of 5m candles for 20 coins** through the
exact same `assessLong`/`assessShort` functions:

### 12.1 Replay construction (no look-ahead)

For each bar `i`:
- **"Now" = the last closed bar** (`i−1`). Momentum: 5m = 1 bar, 15m = 3 bars.
- **Baseline** = mean volume of the 12 bars *before* the signal bar (one hour,
  excluding the spike itself — including it would dampen the expansion being measured).
- `rvol`, `tradeSpike`, `buyPct` (from `takerBuyQuote`), close strength, rolling
  ATR (5m ATR ÷ 2.2 ≈ 1m ATR, √time scaling), rolling 24h change (288 bars).
- BTC regime comes from a parallel BTC candle series aligned by 5m bucket.
- **Wall filter honestly off** — free historical order books don't exist; the
  UI says so instead of pretending.
- The CooldownLedger runs during replay exactly as live.

### 12.2 Trade grading (conservative)

Each go-signal is graded over the next **24 bars (2 hours)**:
- Same-bar stop + target → **stop wins** (pessimistic ordering).
- Stop hit → `loss` (−riskPct). TP2 hit → `big_win` (+tp2Pct).
  TP1 hit → `win` (+tp1Pct). Neither in 2h → `timeout` (mark-to-market).

### 12.3 Statistics

`winRate = (wins + bigWins) / decided`, plus avg win/loss %, **profit factor**
(gross win / gross loss), and **expectancy** (mean pnl per trade). Decision
rule: win rate < 55% → tighten thresholds (the tune script grid-searches);
> 65% and healthy trade count → ship.

---

## 13. Bots & FreeCryptoAPI integration

A **bot** = the user's money with an opinion: investment amount + entry +
direction + **target range** [low, high] + optional **stop range** + expiry.
Bots live in the browser's localStorage (no accounts, no fake cloud sync).

### 13.1 The dual-path price engine

While any bot is armed (`watching` / `in_target`):

1. **REST poll loop** → `POST /api/bot/poll` (server proxy — the FreeCryptoAPI
   key never reaches the browser):
   - FreeCryptoAPI `/v1/getData` is the **primary** feed — used *only* while
     bots exist, per the credits decision (1 credit per returned symbol).
   - Cadence: **8 s** while the tab is visible, **45 s** while hidden.
2. **Live tape ingestion** — tick-level prices from the radar (websocket tier).
   The instant a boundary is crossed, a **targeted confirm poll** (just that
   symbol, debounced 1.5 s) verifies the hit on the REST feed before notifying —
   no alerts off a single flickering tick.

FreeCryptoAPI outage or quota wall → automatic failover to Binance public
ticker: a range hit is still caught. Both feeds dead → retry is automatic, the
bot UI shows the notice.

### 13.2 State machine

```
watching ──price enters [targetLow, targetHigh]──▶ in_target     (notify once)
in_target ──price exits range +0.5% buffer───────▶ watching      (re-arm, log)
watching/in_target ──price enters stop range─────▶ stopped       (notify, terminal)
any active ──expiry passed───────────────────────▶ expired       (log)
```

Every alert: sound + toast + native browser notification (when hidden) +
event log on the bot. P&L is computed live from entry vs direction.

---

## 14. Reliability engineering

| Problem | Solution |
|---|---|
| Binance IP bans on shared egress | adaptive weight-tier pacing, 418/429 doubling backoff, 3-host failover |
| Old app reset dump detector on reload | session state (highs, spikes) lives in the scanner service, not the page |
| Signal log only existed while a tab was open | server scanner runs 24/7; log persisted in SQLite via ingest webhook (browser engine keeps a localStorage log, mirrored best-effort) |
| Free API caches (1–5 min stale) | scanner polls raw klines/depth directly; browser engine uses websockets (tick-level) |
| Websocket blocked by a gateway | automatic tier downgrade: socket → REST poll → in-browser engine |
| One user's API spend multiplied by N visitors | one scanner feeds everyone over socket.io |
| Netlify build minutes | build happens locally, only artifacts upload |
| Missing data | displayed as **"No Data"** — never guessed, never defaulted to a fake pass |

Other free data sources layered in: CoinPaprika (board, coin detail, global
stats — client-side per-user IP), DeFiLlama (price history fallback),
alternative.me (Fear & Greed strip). All behind the same TTL-cache +
inflight-dedup + stale-serve pattern.

---

## 15. Complete tunables table

Every threshold in one place (`V2` const in `v2-engine.ts`) — this is the
surface the backtest tunes:

| Constant | Value | Meaning |
|---|---|---|
| `momentumGreen` | 0.4 | % move required on 5m **and** 15m (+15 pts) |
| `momentum1mRed` | −0.1 | 1m below → extra −10 |
| `volHighUsd` | 100,000 | 5m USD volume above → +10 |
| `volLowUsd` | 50,000 | below → −20 |
| `tradesLow` | 200 | fewer 5m trades → −20 |
| `tradesHealthy` | 500 | more → +5 |
| `wallVsVol` | 1 | wall > 1× 5m volume = unbreakable |
| `wallScanPct` | 2 | walls counted within ±2% of price |
| `wallConfirmMs` | 120,000 | break must hold 2 min |
| `btcBull` / `btcDump` | +0.3 / −0.3 | BTC 15m regime boundaries |
| `goScore` | 70 | GO bar in bull mode |
| `goScoreFlat` | 80 | GO bar in flat mode (shorts in dump: 65) |
| `watchScore` | 60 | watch-only bar |
| `goLongDayMin/Max` | −5 / +8 | 24h extension gate for longs |
| `goShortDayMin/Max` | −15 / +5 | 24h extension gate for shorts |
| `goMinRvol` | 2 | volume expansion required for GO |
| `goMinBuyPctLong` | 52 | crowd must be buying for long GO |
| `goMinBuyPctShort` | 48 | crowd must be selling for short GO |
| `fakeBuyersPct/Trades` | 85 / 200 | fake-buyer trap thresholds |
| `sellersDumpingPct/VolUsd` | 40 / 100,000 | seller-dump warning thresholds |
| `tp1Mult` / `tp2Mult` | 2 / 3.5 | take-profit multiples of risk |
| clamp of `riskPct` | 1.0–1.6 | stop distance band (% of price) |
| `longBlockAfterBearishMs` | 60 min | no longs after a bearish signal |
| `longBlockAfterShortMs` | 30 min | no longs after a go_short |
| `shortBlockAfterLongMs` | 30 min | no shorts after a go_long |
| `signalRepeatMs` | 30 min | same-side GO re-fire damping |
| scan cadence | 5 s server / 1 s browser | compute-only |
| universe | top 40 by 24h volume + BTC + ETH + subscribed | refreshed 5 min |
| `MAX_FORWARD_BARS` | 24 | backtest trade window (2 h) |
| bot poll cadence | 8 s visible / 45 s hidden | FreeCryptoAPI spend control |

---

## 16. Worked examples

The three cases that motivated V2 (from the V1 signal log):

**1. TRX — score 72, but the tape was against it.**
5m −0.06% (red) → −20. Wall $172K vs $61K 5m volume, price below it → −20.
`72 − 20 − 20 = 32` → **NO TRADE.** V1 said "buy". V2 refuses.

**2. PEPE — score 61, momentum already rolling over.**
5m −0.20% → −20. `61 − 20 = 41` → **NO TRADE.**

**3. "U" — score 86, but it is a stablecoin.**
Price $1.0004, 15m +0.01%. Runtime stablecoin detection → verdict `stable`,
**veto**. V1's highest-scoring signal of the day, impossible to profit on.

**4. A hypothetical GO.**
Base 68 (rvol 3.2× = 16.5 pts, trade spike 2× = 2.5, momentum all-green +25,
buyPct 63% = 8.7, close strength 0.7 = 10.5). Momentum +15 (5m +0.55%, 15m
+0.62%), volume +10 ($240K in 5m), wall +15 (broke a $90K wall 3 min ago and
held), liquidity +5 (810 trades). **Final 113 → capped 100+ → GO at 70 bar.**
Hard gates: day +2.1% ✓, rvol 3.2 ✓, buyers 63% ✓, BTC bull +0.42% ✓, TP zone
clear ✓ → `go_long` with entry $0.1522, stop −1.2% (ATR 1.2%), TP1 +2.4%,
TP2 +4.2%.

---

## 17. Known limitations (honest list)

1. **No filter set predicts the market.** The 65–70% target is a *tuning goal
   verified by backtest*, not a promise; live results differ.
2. **Backtest has no order-book history** — the wall filter is honestly disabled
   in replay, so live performance ≠ backtest performance (live is stricter).
3. **Same-bar stop+target resolution is pessimistic** (stop wins); real fills
   could be better *or* worse (slippage, fees are not modeled).
4. **Server-scanner tier availability**: on static hosting the browser engine
   only scans while a tab is open; the 24/7 scanner requires self-hosting the
   mini-service.
5. **Binance-only microstructure**: walls, taker flow and trade counts come from
   Binance; a coin pumping on another venue first will be late.
6. **MFE/MAE grading uses last-price, not fill-price.**
7. **FreeCryptoAPI credits** are spent only while bots are armed — poll cadence
   is the cost control; heavy multi-bot usage still consumes quota.

---

*Sift V2 — the scanner that refuses to speak unless the tape, the book, the
crowd, the regime and the math all agree.*
