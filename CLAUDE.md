# CLAUDE.md — Project Summary

## What This Is

Automated intraday trading bot for Indian equities (NSE/BSE) and derivatives (NFO) via Zerodha Kite Connect. Fetches 5-minute candles, runs four strategies through a mode-based routing engine, scores signal confidence, and places orders automatically.

**Data flow:**
```
Market Data (Yahoo/Kite) → Indicators → Strategies → Mode Router → Confidence Score → Order Execution
```

---

## Core Files

| File | Responsibility |
|------|---------------|
| `bot.js` | Main bot loop — onboarding, market hours check, safety check, order placement, CSV logging |
| `analyze.js` | Multi-strategy analysis engine — mode detection, signal routing, confidence scoring, terminal + HTML report |
| `strategies.js` | Four strategy implementations + `detectMarketMode` |
| `indicators.js` | Pure math — EMA, RSI (Wilder smoothing), MACD, Bollinger Bands |
| `zerodha.js` | Kite Connect order placement (MARKET/MIS) with lot-size handling for NFO |
| `kite-auth.js` | OAuth token exchange, saves to `kite-token.json` with expiry tracking |
| `kite_auth.js` | Interactive CLI auth helper, writes `KITE_ACCESS_TOKEN` to `.env` |
| `market-data.js` | Data fetching — Kite primary, Yahoo Finance fallback (equity only) |
| `rules.json` | Human-readable strategy definition used by bot.js safety check |
| `tests/` | 83 tests using Node's built-in `node:test` — zero external test deps |

---

## Strategies

| Strategy | Function | Designed For |
|----------|----------|-------------|
| VWAP + EMA(8) + RSI(3) | `vwapEmaRsiStrategy` | Sideways mean-reversion |
| MACD Crossover | `macdStrategy` | Trending momentum |
| Bollinger Bands + RSI(14) | `bollingerRsiStrategy` | Sideways mean-reversion |
| ORB (15-min Opening Range) | `orbStrategy` | Trending + early session (9:30–11:30 IST) |

---

## Market Mode Detection

`detectMarketMode` in `strategies.js` computes VWAP and its 3-candle slope:

- **BULLISH** — Price > VWAP AND VWAP slope > 0
- **BEARISH** — Price < VWAP AND VWAP slope < 0
- **SIDEWAYS** — Everything else

---

## Mode-Based Signal Routing (`modeCombinedSignal` in analyze.js)

| Mode | ORB Window Active | Strategies Used | Notes |
|------|-------------------|-----------------|-------|
| Trending | Yes | ORB + MACD | Both must agree, or MACD alone |
| Trending | No | MACD only | Counter-trend signals rejected |
| Sideways | Any | VWAP+EMA+RSI + BB+RSI | Either can fire |

Additional guards:
- **Counter-trend rejection** — MACD sell in bullish mode is blocked
- **VWAP structure guard** — BUY requires price > VWAP in bullish trend

---

## Confidence Scoring

Each active strategy's rules are scored (`rules passed / total rules`), then averaged:
- **STRONG** — score ≥ 0.75
- **WEAK** — below threshold or HOLD

ORB decay: after the ORB window closes (11:30 IST), ORB influence fades linearly to zero over 2 hours.

---

## bot.js vs analyze.js

| | bot.js | analyze.js |
|---|---|---|
| Strategy | Single VWAP+EMA+RSI safety check | All 4 with mode routing |
| Output | Trade execution + CSV logging | Terminal report + HTML |
| Orders | Places real/paper orders | Never places orders |
| Purpose | Production bot loop | Research/analysis tool |

---

## Safety Guardrails

- `PAPER_TRADING=true` by default — no real orders until explicitly disabled
- `MAX_TRADE_SIZE_INR` — hard cap per trade
- `MAX_TRADES_PER_DAY` — daily trade count limit
- Market hours check — bot exits outside NSE 09:15–15:30 IST, Mon–Fri
- Every condition in the active strategy must pass — one failure blocks the trade
- All decisions (including blocked trades) logged to `trades.csv` and `safety-check-log.json`

---

## Data Sources

- **Kite Connect** (primary) — real-time, requires valid access token, supports equity + F&O
- **Yahoo Finance** (fallback) — free, equity only, may have 15–20min cache delay
- Supports timeframes: 1m, 5m, 1H, 1D

---

## Authentication

Kite tokens expire daily at 6 AM IST. Two auth flows:
1. `node kite-auth.js --token <request_token>` — saves to `kite-token.json`
2. `node kite_auth.js` — interactive, writes directly to `.env`

---

## Commands

```bash
npm install          # Install dependencies (only dotenv)
node kite_auth.js    # Authenticate with Zerodha
node analyze.js      # Run analysis, generate report.html
node bot.js          # Run the trading bot
node bot.js --tax-summary  # Print tax summary from trades.csv
npm test             # Run 83 tests
```

---

## Tech Stack

- Node.js 18+ (ESM modules)
- Single dependency: `dotenv`
- Built-in `node:test` for testing
- No frameworks — pure fetch + fs
