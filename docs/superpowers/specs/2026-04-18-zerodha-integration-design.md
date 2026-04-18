# Zerodha Integration Design

**Date:** 2026-04-18
**Scope:** Replace BitGet execution layer with Zerodha Kite Connect API. Support equity (NSE/BSE) and F&O (NFO) instruments with Kite primary / Yahoo Finance fallback for market data.

---

## Architecture

Four-module adapter pattern. `bot.js` remains the thin orchestrator; all exchange-specific logic lives in dedicated modules.

```
bot.js              ← orchestrator: loads rules, runs safety check, calls modules
kite-auth.js        ← token lifecycle: login URL gen, token save/load, expiry check
market-data.js      ← candle fetching: Kite primary → Yahoo Finance fallback
zerodha.js          ← order placement: equity (NSE/BSE) + F&O (NFO)
rules.json          ← strategy (unchanged)
.env                ← Kite credentials + instrument config
kite-token.json     ← auto-written, gitignored, stores access token + expiry
trades.csv          ← unchanged format, Exchange column = "Zerodha"
safety-check-log.json ← unchanged
```

**Removed:** All BitGet code (`signBitGet`, `placeBitGetOrder`, BitGet env vars).

**Unchanged:** Safety check logic, indicator calculations (EMA/VWAP/RSI), trade limits, CSV logging, paper trading mode, Railway cron deployment.

---

## Environment Variables

```
# Kite Connect credentials
KITE_API_KEY=
KITE_API_SECRET=
KITE_REDIRECT_URL=http://localhost:3000/callback

# Instrument config
INSTRUMENT_TYPE=equity        # equity | futures | options
EXCHANGE=NSE                  # NSE | BSE | NFO
TRADINGSYMBOL=RELIANCE        # e.g. RELIANCE, NIFTY25MAYFUT

# Existing (unchanged)
PORTFOLIO_VALUE_USD=1000
MAX_TRADE_SIZE_USD=100
MAX_TRADES_PER_DAY=3
PAPER_TRADING=true
TIMEFRAME=5m
```

---

## Module: `kite-auth.js`

Handles the Kite Connect OAuth token lifecycle. Access tokens expire daily at 6 AM IST.

**On every bot run:**
1. Read `kite-token.json` — check `expires_at` against current time
2. If valid → return `access_token`, bot continues
3. If expired or missing → print login URL to console and exit with instructions

**Semi-automated refresh flow:**
```
⚠️  Kite access token expired or missing.

Open this URL in your browser:
https://kite.trade/connect/login?api_key=YOUR_KEY&v=3

After login, run:
  node kite-auth.js --token <request_token>

Then re-run: node bot.js
```

**`node kite-auth.js --token <request_token>`:**
- POSTs to Kite `/session/token` to exchange request token for access token
- Saves `kite-token.json` with `access_token` and `expires_at` (next 6 AM IST)

**`kite-token.json` structure:**
```json
{
  "access_token": "...",
  "expires_at": "2026-04-19T00:30:00.000Z"
}
```

This file is gitignored and never committed.

---

## Module: `market-data.js`

Fetches OHLCV candles with Kite as primary source and Yahoo Finance as fallback.

**Primary — Kite Connect historical API:**
- Resolves instrument token once at startup by matching `TRADINGSYMBOL` + `EXCHANGE` against Kite's instruments CSV
- Fetches via `GET /instruments/historical/{instrument_token}/{interval}`

**Fallback — Yahoo Finance (equity only):**
- Ticker mapping: `NSE` → `SYMBOL.NS`, `BSE` → `SYMBOL.BO`
- If `INSTRUMENT_TYPE=futures` or `options` and Kite fails, bot aborts with a clear error — no fallback for F&O (Yahoo data is unreliable for derivatives)

**Interval mapping:**

| Config | Kite | Yahoo |
|--------|------|-------|
| `1m` | `minute` | `1m` |
| `5m` | `5minute` | `5m` |
| `1H` | `60minute` | `60m` |
| `1D` | `day` | `1d` |

**Output shape (identical to current bot):**
```js
{ time, open, high, low, close, volume }
```

No changes required to safety check or indicator code.

**Market hours guard:**
- Checks current IST time against NSE session: 09:15–15:30, Mon–Fri
- Outside hours: logs message and exits cleanly (no error, no CSV row written)

---

## Module: `zerodha.js`

Places market orders via Kite Connect REST API.

**Auth header:** `Authorization: token {api_key}:{access_token}` — no HMAC signing.

**Equity orders (NSE/BSE):**
```json
{
  "tradingsymbol": "RELIANCE",
  "exchange": "NSE",
  "transaction_type": "BUY",
  "order_type": "MARKET",
  "quantity": 3,
  "product": "MIS"
}
```
Quantity = `floor(tradeSize / currentPrice)`. Must be ≥ 1 whole share; if `tradeSize` is too small for even one share, bot logs warning and skips.

**F&O orders (NFO):**
```json
{
  "tradingsymbol": "NIFTY25MAYFUT",
  "exchange": "NFO",
  "transaction_type": "BUY",
  "order_type": "MARKET",
  "quantity": 75,
  "product": "MIS"
}
```
Quantity must be an exact lot size multiple. Lot size fetched from Kite instruments data at startup. If `tradeSize` can't cover one lot, bot logs warning and skips — no partial lot orders.

**Paper trading:** Skips API call, records `PAPER-<timestamp>` as order ID. Identical behaviour to current bot.

**`trades.csv`:** Exchange column = `"Zerodha"`. All other columns unchanged.

---

## Data Flow

```
bot.js
  │
  ├── kite-auth.js       → validate/load access token (abort if expired)
  ├── market-data.js     → fetch candles (Kite → Yahoo fallback)
  │     └── market hours guard (exit cleanly if outside 09:15–15:30 IST)
  ├── [existing] calcEMA / calcRSI / calcVWAP
  ├── [existing] checkTradeLimits
  ├── [existing] runSafetyCheck
  └── zerodha.js         → place order (or paper trade)
        └── writeTradeCsv / saveLog (unchanged)
```

---

## What Does Not Change

- `rules.json` strategy format
- Indicator calculations (EMA, RSI, VWAP)
- Safety check logic and conditions
- Trade limits (daily cap, max size)
- Paper trading mode
- `trades.csv` schema (except Exchange column value)
- `safety-check-log.json` schema
- Railway cron deployment setup

---

## Out of Scope

- Options order placement (buy/sell calls and puts) — F&O support covers futures only in this iteration; options require strike/expiry selection logic not present in the current strategy
- WebSocket live data streaming — bot remains poll-based (cron-triggered)
- Stop-loss / take-profit orders — exit rules remain advisory in `rules.json`, not automated orders
