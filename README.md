# Claude + TradingView MCP — Automated Trading (Zerodha / India)

> **New to this?** Watch the previous video first — it sets up the TradingView MCP connection this builds on.

[![How To Connect Claude to TradingView (Insanely Cool)](https://img.youtube.com/vi/vIX6ztULs4U/maxresdefault.jpg)](https://youtu.be/vIX6ztULs4U)

[![Claude Code + TradingView Now Actually Executes Real Trades](https://img.youtube.com/vi/aDWJ6lLemJU/maxresdefault.jpg)](https://www.youtube.com/watch?v=aDWJ6lLemJU)

---

## What This Does

Automated intraday trading bot for Indian equities (NSE/BSE) and derivatives (NFO) via **Zerodha Kite Connect**. It fetches 5-minute candles from Kite (Yahoo Finance as a fallback for equity), runs four strategies through a mode-based routing engine, scores signal confidence, and places orders automatically, with a protective stop at the exchange and managed exits. `bot.js` trades on exactly the signal `analyze.js` reports.

**What you get:**

1. **Mode-based signal engine** — detects whether the market is trending or sideways, then routes to the right strategy group so each strategy only fires in conditions it's designed for
2. **Four strategies** — VWAP+EMA+RSI, MACD, Bollinger+RSI, and ORB (Opening Range Breakout), each with explicit pass/fail rules
3. **Confidence scoring** — every combined signal is rated `STRONG` or `WEAK` based on how many strategy rules were satisfied
4. **Zerodha execution** — marketable LIMIT entries (MIS), an SL stop order at the exchange right after the fill, and exits on stop, target, reversal or the 15:10 IST square-off
5. **Risk-based sizing** — risks `RISK_PER_TRADE_PCT` of the portfolio against the stop distance, capped at `MAX_TRADE_SIZE_INR`
6. **HTML + terminal report** — `node analyze.js` generates a colour-coded report and `report.html` for every run
7. **Paper trading mode** — logs every decision without placing real orders until you flip the switch

---

## The Analysis Engine

### Market Mode Detection

Before routing any signal, the engine computes VWAP for the session and measures its 3-candle slope:

| Condition | Mode |
|-----------|------|
| Price > VWAP **and** VWAP slope > 0 | `BULLISH` trending |
| Price < VWAP **and** VWAP slope < 0 | `BEARISH` trending |
| Everything else | `SIDEWAYS` |

### Strategy Routing

| Mode | ORB window (9:30–11:30 IST) | Active Strategies | Signal fires when |
|------|----------------------------|-------------------|-------------------|
| Trending | Yes | ORB + MACD | Both agree, or MACD alone |
| Trending | No | MACD only | MACD fires |
| Sideways | Any | VWAP+EMA+RSI + BB+RSI | Either fires |

Mean-reversion strategies (VWAP+BB) are **never** active in trending mode. Trend strategies (ORB+MACD) are **never** active in sideways mode.

### Confidence Score

Each active strategy's rules are scored individually (`rules passed / total rules`), then averaged:

- **STRONG** — average score ≥ 0.75
- **WEAK** — below threshold, or signal is HOLD

When a trend signal arrives without ORB being active, a same-direction partial ORB breakout can nudge the score up; that boost fades to zero two hours after the ORB window closes.

Displayed in terminal output and as a coloured badge in the HTML report. By default the bot only enters on **STRONG** signals (`MIN_CONFIDENCE=STRONG`).

Signals are computed on **closed candles only** — the still-forming bar is dropped, so a signal cannot appear and vanish within one bar. If the newest candle is more than three bars old (holiday, halt, delayed feed) the bot opens nothing.

---

## Trade Management

| Step | What happens |
|------|-------------|
| Entry | Marketable LIMIT order, MIS, `ENTRY_SLIPPAGE_PCT` (0.1%) beyond the last price, on the instrument's tick size. Unfilled after 15s → cancelled. |
| Stop | An SL order at `STOP_LOSS_PCT` (0.3%) from the fill price is placed at the exchange immediately. If it cannot be placed, the position is closed at once. |
| Each run | Checks the stop order (filled → recorded as stopped out; cancelled or rejected → position closed), then the exit rules. |
| Exit rules | Target `TARGET_PCT` (0.6%); opposite combined signal; for sideways (mean-reversion) entries, RSI(3) back across 50; 15:10 IST square-off. |
| Exit | Cancels the stop first (and waits if it is still live), then a LIMIT exit `EXIT_SLIPPAGE_PCT` (0.5%) through the price. A partial fill re-protects the rest and retries next run. |
| Limits | One position at a time, `MAX_TRADES_PER_DAY` entries, no new entries after 15:00 IST, shorts only with `ALLOW_SHORT=true`. |

The open position lives in `position.json`; every decision goes to `safety-check-log.json`; every executed order (entry and exit, with P&L and estimated Zerodha charges) to `trades.csv`.

---

## The Four Strategies

| Strategy | Rules checked | Designed for |
|----------|--------------|--------------|
| **VWAP+EMA+RSI** | Price vs VWAP, EMA trend, RSI(3) oversold/overbought | Sideways mean-reversion |
| **MACD** | Bullish/bearish MACD line cross above/below signal | Trending momentum |
| **Bollinger+RSI** | Price at lower/upper band, RSI(14) confirmation | Sideways mean-reversion |
| **ORB** | 15-min opening range breakout, volume 1.2×, RSI(55/45), VWAP trend, time window | Trending + early session |

---

## Getting Started

### Prerequisites

- **Node.js 18+** — check with `node --version`
- **Zerodha account** with [Kite Connect API access](https://kite.trade/) enabled
- **TradingView MCP** set up (see [first video](https://youtu.be/vIX6ztULs4U))

### 1. Clone and install

```bash
git clone https://github.com/sisoppin/claude-tradingview-mcp-trading
cd claude-tradingview-mcp-trading
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
# Kite Connect credentials
KITE_API_KEY=your_api_key
KITE_API_SECRET=your_api_secret
KITE_REDIRECT_URL=http://localhost:3000/callback

# Instrument config (equity: NSE/BSE, futures/options: NFO)
INSTRUMENT_TYPE=equity
EXCHANGE=NSE
TRADINGSYMBOL=RELIANCE

# Trading config
PORTFOLIO_VALUE_INR=50000
MAX_TRADE_SIZE_INR=5000
MAX_TRADES_PER_DAY=3
PAPER_TRADING=true
TIMEFRAME=5m

# Risk and exits
RISK_PER_TRADE_PCT=1
STOP_LOSS_PCT=0.3
TARGET_PCT=0.6
MIN_CONFIDENCE=STRONG
ALLOW_SHORT=false
```

With the defaults, ₹50,000 × 1% = ₹500 at risk over a 0.3% stop allows ~₹1.67 lakh, so the ₹5,000 cap decides: 3 RELIANCE shares at ~₹1,400.

**Getting your Kite Connect API key:**
1. Log in to [kite.trade](https://kite.trade/)
2. Create an app → note the API key and secret
3. Set the redirect URL to `http://localhost:3000/callback`

Two rules regardless of exchange: **withdrawals OFF, IP whitelist ON**.

### 3. Authenticate

```bash
node kite-auth.js
```

It prints the Kite login URL. Log in, copy the `request_token` from the redirect URL and paste it in. The access token is saved to `kite-token.json` (in `STATE_DIR`) and is valid until 6 AM IST the next day — log in again each trading day. Both `bot.js` and `analyze.js` read it from there; `KITE_ACCESS_TOKEN` in the environment is used when there is no valid token file.

Paper trading works without logging in (Yahoo Finance data); live trading needs the token.

### 4. Run the analysis

```bash
node analyze.js
```

Prints a full terminal report and writes `report.html`. No trades are placed.

### 5. Run the bot

```bash
node bot.js
```

Each run is one check: manage the open position if there is one, otherwise look for an entry. Run it every 5 minutes during market hours (cron or Railway, below).

In `PAPER_TRADING=true` mode, it simulates entries, stops and exits (stops and targets are checked against each bar's high/low) but places no real orders. Watch a few sessions, confirm the logic, then set `PAPER_TRADING=false`.

`node bot.js --tax-summary` prints totals from `trades.csv`.

### 6. Deploying on Railway (optional)

`railway.json` runs `node bot.js` every 5 minutes, Monday–Friday, 03:00–10:55 UTC (the bot itself skips anything outside 09:15–15:30 IST). Before going live there:

- **Mount a volume and set `STATE_DIR`** to it (e.g. `/data`). The container filesystem is wiped between runs; without a volume the bot forgets its open position and the trade log.
- **Token:** log in each morning and set `KITE_ACCESS_TOKEN` in Railway's variables (or write `kite-token.json` onto the volume).
- **Static IP:** SEBI's retail algo rules require Kite API orders to come from an IP whitelisted on your Kite app. Railway's outbound IP is not static by default, so live orders will be rejected unless you route through a static IP. Paper trading is unaffected.

---

## Running Tests

```bash
npm test
```

139 tests across all modules. Zero external dependencies required — uses `node:test` built-in.

---

## Files

| File | What it does |
|------|-------------|
| `bot.js` | One run: market hours, data freshness, open-position management or entry, logging |
| `analyze.js` | Multi-strategy analysis engine (`analyzeCandles`) — mode detection, signal routing, confidence scoring, terminal + HTML output |
| `position.js` | Sizing, stop/target levels and exit rules (pure functions) |
| `charges.js` | Zerodha intraday charges estimate for `trades.csv` |
| `state.js` | Paths under `STATE_DIR` and atomic JSON writes |
| `strategies.js` | Four strategy implementations + `detectMarketMode` |
| `indicators.js` | Technical indicator calculations (VWAP, EMA, MACD, Bollinger, RSI) |
| `zerodha.js` | Kite Connect orders — LIMIT entries/exits, SL stops, order status, cancel |
| `kite-auth.js` | Kite Connect login + the single token store |
| `market-data.js` | Candles from Kite (Yahoo fallback), forming-candle and freshness checks, IST helpers |
| `.env` | Your credentials (gitignored — never commits) |
| `report.html` | Auto-generated HTML analysis report |
| `tests/` | Test suite — strategies, indicators, analyze, engine wiring, position logic, zerodha, auth, market data |

---

## Safety

A trade only goes through when the routed strategies fire with enough confidence. When nothing is entered, the bot lists every reason and logs the rule-by-rule results.

Guardrails:
- Every live position gets a stop order at the exchange; if that fails, the position is closed immediately
- LIMIT orders only — no unbounded market fills
- Risk per trade from the stop distance, and maximum trade size capped at `MAX_TRADE_SIZE_INR`
- Maximum entries per day capped at `MAX_TRADES_PER_DAY`; one position at a time
- No new entries after 15:00 IST; everything closed at 15:10 IST
- No trading on stale data; short selling off by default
- `PAPER_TRADING=true` by default — no real orders until you explicitly disable it
- Market hours check — bot exits immediately outside the NSE session (it does not know NSE holidays, but the stale-data check stops entries on them)

**This is not financial advice.** Paper trade first. Never put in more than you can afford to lose.

---

## Resources

- [First video — Connect Claude to TradingView](https://youtu.be/vIX6ztULs4U)
- [Kite Connect API docs](https://kite.trade/docs/connect/v3/)
- [Yahoo Finance API (fallback candle data)](https://query2.finance.yahoo.com)
