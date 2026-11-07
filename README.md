# Sift V2 — the crypto radar that refuses fake signals

A real-time crypto opportunity scanner rebuilt from
[Ziruax/sift](https://github.com/Ziruax/sift) (V1) into **V2 — the accuracy
update**: one 0–100 score that was right ~30% of the time became a seven-filter
engine that refuses to speak unless the tape, the order book, the crowd, the BTC
regime and the risk math all agree.

**Read [`ALGORITHM.md`](./ALGORITHM.md) for the complete algorithm reference** —
every threshold, formula, cooldown and honest limitation, written for audit.

## What it does

- **Live radar** of the top-40 USDT pairs (by volume), scanned every 5 s
  server-side or 1 s in-browser on tick-level websockets.
- **Seven-filter V2 assessment** per coin: momentum, real dollar volume, order-book
  walls (with 2-minute break confirmation), trade-count liquidity, buyer-trap
  detection, BTC market regime (bull/flat/dump), stablecoin immunity.
- **Trade plans on every GO**: entry, ATR-sized stop (1.0–1.6%), TP1 at 2× risk,
  TP2 at 3.5× — for both longs and shorts — plus dollar risk framing and the
  scenario map (bull / chop / invalidated) *before* the decision.
- **Anti-flip-flop cooldowns**: a bearish signal blocks longs for 60 min, a
  go_short blocks longs for 30 min, same-side signals re-fire at most every 30 min.
- **Accountability loop**: every signal is graded 5/15/60 min later with
  MFE/MAE, persisted in SQLite (server tier) or localStorage (browser tier).
- **30-day backtest** over 20 coins replaying the exact same filter code, with
  win rate, profit factor and expectancy.
- **Investment bots**: investment amount + entry + target/stop price ranges,
  watched on a dual price path (FreeCryptoAPI REST poll + live tape) with
  instant, confirmed notifications.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui ·
Prisma + SQLite · socket.io · Binance public market data (no key) ·
CoinPaprika / DeFiLlama / alternative.me (free, keyless) ·
[FreeCryptoAPI](https://freecryptoapi.com/) for bot price polling (optional).

## Run it

```bash
bun install
bun run db:push        # creates the SQLite signal log
bun run dev            # http://localhost:3000
```

The app is fully functional with **zero configuration**: with no radar service
running, the in-browser engine (Binance public websockets) takes over
automatically. All market data is keyless and free.

### Optional: the 24/7 server scanner (self-host)

The browser engine only scans while a tab is open. For a persistent scanner that
also accumulates the signal log around the clock:

```bash
cd mini-services/radar
bun install
bun run dev            # socket.io on :3003, internal REST on :3004
bun run db:push        # in the project root first
```

When the service is up, every connected browser upgrades to it automatically
(one scanner feeds all visitors; N users cost the API the same as one).

### Optional: FreeCryptoAPI for bots

Set `FREECRYPTO_API_KEY` in the environment to use your own key for the bot
price proxy (the key is never exposed to the browser). Without it the bots fall
back to Binance public prices.

## Deploy (Netlify, without spending build minutes)

```bash
bunx netlify-cli build          # compiles locally
bunx netlify-cli deploy --prod  # uploads finished artifacts
```

`netlify.toml` is preconfigured; on serverless the browser engine is the live
tier by design.

## Project layout

```
src/lib/market/v2-engine.ts    the seven filters, trade plans, cooldowns, backtest core
src/lib/market/local-radar.ts  the in-browser websocket scanner
mini-services/radar/           the 24/7 server-side scanner (socket.io)
src/lib/bots.ts                investment bots (ranges, state machine)
src/app/api/bot/poll/          FreeCryptoAPI proxy (key stays server-side)
src/components/sift/           radar / signals / backtest / bots / markets views
scripts/tune-v2.ts             threshold grid-search tuner
ALGORITHM.md                   the complete algorithm reference
```

## Disclaimer

Market data and signals are informational only. Nothing here is financial
advice; no filter set makes crypto predictable. Trade at your own risk.
