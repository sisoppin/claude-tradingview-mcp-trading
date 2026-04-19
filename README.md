# Claude + TradingView MCP — Automated Trading (Zerodha / India)

> **New to this?** Watch the previous video first — it sets up the TradingView MCP connection this builds on.

[![How To Connect Claude to TradingView (Insanely Cool)](https://img.youtube.com/vi/vIX6ztULs4U/maxresdefault.jpg)](https://youtu.be/vIX6ztULs4U)

[![Claude Code + TradingView Now Actually Executes Real Trades](https://img.youtube.com/vi/aDWJ6lLemJU/maxresdefault.jpg)](https://www.youtube.com/watch?v=aDWJ6lLemJU)

---

## What This Does

Automated intraday trading bot for Indian equities (NSE/BSE) and derivatives (NFO) via **Zerodha Kite Connect**. It fetches 5-minute candles from Yahoo Finance, runs four strategies through a mode-based routing engine, scores signal confidence, and places orders automatically.

**What you get:**

1. **Mode-based signal engine** — detects whether the market is trending or sideways, then routes to the right strategy group so each strategy only fires in conditions it's designed for
2. **Four strategies** — VWAP+EMA+RSI, MACD, Bollinger+RSI, and ORB (Opening Range Breakout), each with explicit pass/fail rules
3. **Confidence scoring** — every combined signal is rated `STRONG` or `WEAK` based on how many strategy rules were satisfied
4. **Zerodha execution** — places equity or F&O orders via Kite Connect with a daily trade cap and position sizing
5. **HTML + terminal report** — `node analyze.js` generates a colour-coded report and `report.html` for every run
6. **Paper trading mode** — logs every decision without placing real orders until you flip the switch

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

- **STRONG** — average score ≥ 0.75 (or ≥ 0.5 for MACD-only, which has 2 mutually exclusive rules)
- **WEAK** — below threshold, or signal is HOLD

Displayed in terminal output and as a coloured badge in the HTML report.

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
```

**Getting your Kite Connect API key:**
1. Log in to [kite.trade](https://kite.trade/)
2. Create an app → note the API key and secret
3. Set the redirect URL to `http://localhost:3000/callback`

Two rules regardless of exchange: **withdrawals OFF, IP whitelist ON**.

### 3. Authenticate

```bash
node kite-auth.js
```

Follow the login flow — opens a browser, completes OAuth, saves the access token locally.

### 4. Run the analysis

```bash
node analyze.js
```

Prints a full terminal report and writes `report.html`. No trades are placed.

### 5. Run the bot

```bash
node bot.js
```

In `PAPER_TRADING=true` mode, it logs every decision but places no real orders. Watch a few sessions, confirm the logic, then set `PAPER_TRADING=false`.

---

## Running Tests

```bash
npm test
```

83 tests across all modules. Zero external dependencies required — uses `node:test` built-in.

---

## Files

| File | What it does |
|------|-------------|
| `bot.js` | Main bot loop — market hours check, strategy run, order placement |
| `analyze.js` | Multi-strategy analysis engine — mode detection, signal routing, confidence scoring, terminal + HTML output |
| `strategies.js` | Four strategy implementations + `detectMarketMode` |
| `indicators.js` | Technical indicator calculations (VWAP, EMA, MACD, Bollinger, RSI) |
| `zerodha.js` | Zerodha Kite Connect order placement |
| `kite-auth.js` | Kite Connect OAuth login + token management |
| `market-data.js` | 5-minute candle fetch from Yahoo Finance |
| `.env` | Your credentials (gitignored — never commits) |
| `report.html` | Auto-generated HTML analysis report |
| `tests/` | Test suite — strategies, indicators, analyze, zerodha |

---

## Safety

Every condition in the active strategy pair must pass before a trade goes through. One fails — nothing happens. The bot tells you exactly which condition failed and the actual values it saw.

Additional guardrails:
- Maximum trade size capped at `MAX_TRADE_SIZE_INR`
- Maximum trades per day capped at `MAX_TRADES_PER_DAY`
- `PAPER_TRADING=true` by default — no real orders until you explicitly disable it
- Market hours check — bot exits immediately outside NSE session

**This is not financial advice.** Paper trade first. Never put in more than you can afford to lose.

---

## Resources

- [First video — Connect Claude to TradingView](https://youtu.be/vIX6ztULs4U)
- [Kite Connect API docs](https://kite.trade/docs/connect/v3/)
- [Yahoo Finance API (candle data)](https://query2.finance.yahoo.com)
