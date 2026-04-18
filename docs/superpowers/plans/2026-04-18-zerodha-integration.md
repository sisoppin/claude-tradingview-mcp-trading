# Zerodha Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace BitGet execution with Zerodha Kite Connect API, supporting equity (NSE/BSE) and F&O (NFO) instruments with Kite primary / Yahoo Finance fallback for candle data.

**Architecture:** Extract exchange-specific logic into three new modules (`kite-auth.js`, `market-data.js`, `zerodha.js`). `bot.js` becomes a thin orchestrator that imports from these modules. All BitGet code is removed. Safety check, indicator calculations, trade limits, CSV logging, and paper trading mode are unchanged.

**Tech Stack:** Node.js 18+ (native fetch, crypto), Kite Connect REST API v3, Yahoo Finance v8 chart API (free, no auth), `node:test` for testing, `dotenv`.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `package.json` | Add `"type": "module"`, add test script |
| Create | `.env.example` | Template with Kite + instrument vars |
| Create | `.gitignore` | Ignore `.env`, `kite-token.json`, `safety-check-log.json` |
| Create | `kite-auth.js` | Token lifecycle: load, validate, exchange, print instructions |
| Create | `market-data.js` | Candle data: Kite primary → Yahoo fallback, market hours guard |
| Create | `zerodha.js` | Order placement: equity + F&O, lot size validation |
| Modify | `bot.js` | Wire new modules, remove BitGet, update CONFIG and run() |
| Create | `tests/kite-auth.test.js` | Unit tests for token lifecycle |
| Create | `tests/market-data.test.js` | Unit tests for candle fetching and market hours |
| Create | `tests/zerodha.test.js` | Unit tests for order placement logic |

---

## Task 1: Project Setup

**Files:**
- Modify: `package.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `tests/` (directory only)

- [ ] **Step 1: Add `"type": "module"` and test script to `package.json`**

Replace the `package.json` contents with:

```json
{
  "name": "claude-tradingview-mcp-trading",
  "version": "1.0.0",
  "description": "Automated trading bot — Claude + TradingView strategy + Zerodha execution",
  "type": "module",
  "main": "bot.js",
  "scripts": {
    "start": "node bot.js",
    "dev": "node bot.js",
    "test": "node --test tests/*.test.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

Note: `node-fetch` is removed — Node 18+ has native `fetch`.

- [ ] **Step 2: Create `.env.example`**

```
# Kite Connect credentials
KITE_API_KEY=
KITE_API_SECRET=
KITE_REDIRECT_URL=http://localhost:3000/callback

# Instrument config (equity: NSE/BSE, futures/options: NFO)
INSTRUMENT_TYPE=equity
EXCHANGE=NSE
TRADINGSYMBOL=RELIANCE

# Trading config
PORTFOLIO_VALUE_USD=1000
MAX_TRADE_SIZE_USD=100
MAX_TRADES_PER_DAY=3
PAPER_TRADING=true
TIMEFRAME=5m
```

- [ ] **Step 3: Create `.gitignore`**

```
.env
kite-token.json
safety-check-log.json
node_modules/
*.test.json
```

- [ ] **Step 4: Create the tests directory**

```bash
mkdir tests
```

- [ ] **Step 5: Commit**

```bash
git add package.json .env.example .gitignore
git commit -m "chore: setup project for Zerodha integration — ES modules, test script, env template"
```

---

## Task 2: `kite-auth.js` (TDD)

**Files:**
- Create: `tests/kite-auth.test.js`
- Create: `kite-auth.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/kite-auth.test.js`:

```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { loadToken, exchangeToken } from "../kite-auth.js";

const TEST_FILE = "kite-token.test.json";
const cleanup = () => { if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE); };

describe("loadToken", () => {
  test("returns null when file does not exist", () => {
    cleanup();
    assert.equal(loadToken(TEST_FILE), null);
  });

  test("returns null when token is expired", () => {
    writeFileSync(TEST_FILE, JSON.stringify({
      access_token: "old-token",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));
    assert.equal(loadToken(TEST_FILE), null);
    cleanup();
  });

  test("returns access_token when valid", () => {
    writeFileSync(TEST_FILE, JSON.stringify({
      access_token: "valid-token",
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }));
    assert.equal(loadToken(TEST_FILE), "valid-token");
    cleanup();
  });
});

describe("exchangeToken", () => {
  test("saves token and returns access_token on success", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    process.env.KITE_API_SECRET = "test-secret";

    t.mock.method(global, "fetch", async () => ({
      json: async () => ({ status: "success", data: { access_token: "returned-token" } }),
    }));

    const result = await exchangeToken("request-token-123", TEST_FILE);
    assert.equal(result, "returned-token");

    const saved = JSON.parse(readFileSync(TEST_FILE, "utf8"));
    assert.equal(saved.access_token, "returned-token");
    assert.ok(new Date(saved.expires_at) > new Date(), "expires_at should be in the future");
    cleanup();
  });

  test("throws on Kite auth failure", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    process.env.KITE_API_SECRET = "test-secret";

    t.mock.method(global, "fetch", async () => ({
      json: async () => ({ status: "error", message: "Invalid request token" }),
    }));

    await assert.rejects(
      () => exchangeToken("bad-token", TEST_FILE),
      /Kite auth failed: Invalid request token/
    );
    cleanup();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
node --test tests/kite-auth.test.js
```

Expected: `Error: Cannot find module '../kite-auth.js'`

- [ ] **Step 3: Create `kite-auth.js`**

```javascript
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "crypto";

const KITE_BASE = "https://api.kite.trade";

function nextTokenExpiry() {
  // Kite tokens expire at 6 AM IST = 00:30 UTC
  const now = new Date();
  const expiry = new Date(now);
  expiry.setUTCHours(0, 30, 0, 0);
  if (expiry <= now) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry;
}

export function loadToken(tokenFile = "kite-token.json") {
  if (!existsSync(tokenFile)) return null;
  try {
    const { access_token, expires_at } = JSON.parse(readFileSync(tokenFile, "utf8"));
    if (new Date(expires_at) <= new Date()) return null;
    return access_token;
  } catch {
    return null;
  }
}

export function printLoginInstructions() {
  const apiKey = process.env.KITE_API_KEY;
  console.log("\n⚠️  Kite access token expired or missing.\n");
  console.log("Open this URL in your browser to log in:");
  console.log(`  https://kite.trade/connect/login?api_key=${apiKey}&v=3\n`);
  console.log("After login, run:");
  console.log("  node kite-auth.js --token <request_token>\n");
  console.log("Then re-run: node bot.js\n");
}

export async function exchangeToken(requestToken, tokenFile = "kite-token.json") {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  const checksum = crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");

  const res = await fetch(`${KITE_BASE}/session/token`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
  });

  const data = await res.json();
  if (data.status !== "success") throw new Error(`Kite auth failed: ${data.message}`);

  const token = {
    access_token: data.data.access_token,
    expires_at: nextTokenExpiry().toISOString(),
  };

  writeFileSync(tokenFile, JSON.stringify(token, null, 2));
  console.log(`✅ Token saved to ${tokenFile} (expires: ${token.expires_at})`);
  return token.access_token;
}

// CLI: node kite-auth.js --token <request_token>
if (process.argv[1]?.endsWith("kite-auth.js") && process.argv.includes("--token")) {
  const idx = process.argv.indexOf("--token");
  const requestToken = process.argv[idx + 1];
  if (!requestToken) {
    console.error("Usage: node kite-auth.js --token <request_token>");
    process.exit(1);
  }
  exchangeToken(requestToken).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
node --test tests/kite-auth.test.js
```

Expected: `✔ returns null when file does not exist`, `✔ returns null when token is expired`, `✔ returns access_token when valid`, `✔ saves token and returns access_token on success`, `✔ throws on Kite auth failure`

- [ ] **Step 5: Commit**

```bash
git add kite-auth.js tests/kite-auth.test.js
git commit -m "feat: add kite-auth.js — token lifecycle with semi-automated refresh"
```

---

## Task 3: `market-data.js` (TDD)

**Files:**
- Create: `tests/market-data.test.js`
- Create: `market-data.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/market-data.test.js`:

```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isMarketOpen, fetchCandles } from "../market-data.js";

// isMarketOpen accepts optional `now` Date for testability
describe("isMarketOpen", () => {
  test("returns false on Sunday", () => {
    // 2025-01-05 Sunday, 10:00 AM IST = 04:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-05T04:30:00Z")), false);
  });

  test("returns false on Saturday", () => {
    // 2025-01-04 Saturday, 10:00 AM IST = 04:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-04T04:30:00Z")), false);
  });

  test("returns false before market open (9:00 AM IST)", () => {
    // Monday 2025-01-06, 9:00 AM IST = 03:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T03:30:00Z")), false);
  });

  test("returns true at market open (9:15 AM IST)", () => {
    // Monday 2025-01-06, 9:15 AM IST = 03:45 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T03:45:00Z")), true);
  });

  test("returns true during market hours", () => {
    // Monday 2025-01-06, 12:00 PM IST = 06:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T06:30:00Z")), true);
  });

  test("returns false after market close (3:30 PM IST)", () => {
    // Monday 2025-01-06, 4:00 PM IST = 10:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T10:30:00Z")), false);
  });
});

describe("fetchCandles", () => {
  const INSTRUMENTS_CSV = `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
738561,2886,RELIANCE,RELIANCE INDUSTRIES,2500.0,,0.0,0.05,1,EQ,NSE,NSE`;

  const KITE_CANDLES_RESPONSE = {
    status: "success",
    data: {
      candles: [["2025-01-06T09:15:00+0530", 2500, 2510, 2495, 2505, 100000]],
    },
  };

  const YAHOO_RESPONSE = {
    chart: {
      result: [{
        timestamp: [1704511800],
        indicators: {
          quote: [{ open: [2490], high: [2515], low: [2485], close: [2505], volume: [200000] }],
        },
      }],
    },
  };

  test("uses Kite when token provided and returns candles + lotSize", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async (url) => {
      if (url.includes("/instruments/NSE")) return { ok: true, text: async () => INSTRUMENTS_CSV };
      return { json: async () => KITE_CANDLES_RESPONSE };
    });

    const result = await fetchCandles("valid-token", "RELIANCE", "NSE", "equity", "5m");
    assert.equal(result.source, "kite");
    assert.equal(result.lotSize, 1);
    assert.equal(result.candles.length, 1);
    assert.equal(result.candles[0].close, 2505);
  });

  test("falls back to Yahoo when Kite fails for equity", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async (url) => {
      if (url.includes("kite.trade")) return { ok: false, status: 401, text: async () => "Unauthorized" };
      return { ok: true, json: async () => YAHOO_RESPONSE };
    });

    const result = await fetchCandles("valid-token", "RELIANCE", "NSE", "equity", "5m");
    assert.equal(result.source, "yahoo");
    assert.equal(result.candles[0].close, 2505);
  });

  test("throws for F&O when Kite fails — no Yahoo fallback", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      ok: false, status: 401, text: async () => "Unauthorized",
    }));

    await assert.rejects(
      () => fetchCandles("token", "NIFTY25MAYFUT", "NFO", "futures", "5m"),
      /no Yahoo fallback for derivatives/
    );
  });

  test("throws for F&O when no token at all", async () => {
    await assert.rejects(
      () => fetchCandles(null, "NIFTY25MAYFUT", "NFO", "futures", "5m"),
      /No Kite token/
    );
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
node --test tests/market-data.test.js
```

Expected: `Error: Cannot find module '../market-data.js'`

- [ ] **Step 3: Create `market-data.js`**

```javascript
import "dotenv/config";

const KITE_BASE = "https://api.kite.trade";

const KITE_INTERVAL = {
  "1m": "minute",
  "5m": "5minute",
  "1H": "60minute",
  "1D": "day",
};

const KITE_DAYS_BACK = {
  minute: 5,
  "5minute": 10,
  "60minute": 60,
  day: 365,
};

const YAHOO_PARAMS = {
  "1m": ["1m", "1d"],
  "5m": ["5m", "5d"],
  "1H": ["60m", "60d"],
  "1D": ["1d", "2y"],
};

export function isMarketOpen(now = new Date()) {
  // NSE hours: 09:15–15:30 IST (UTC+5:30), Mon–Fri
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

async function resolveInstrument(accessToken, tradingsymbol, exchange) {
  const res = await fetch(`${KITE_BASE}/instruments/${exchange}`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${process.env.KITE_API_KEY}:${accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`Kite instruments fetch failed: ${res.status}`);

  const csv = await res.text();
  const lines = csv.trim().split("\n");
  const headers = lines[0].split(",");
  const tokenIdx = headers.indexOf("instrument_token");
  const symbolIdx = headers.indexOf("tradingsymbol");
  const lotIdx = headers.indexOf("lot_size");

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    if (cols[symbolIdx] === tradingsymbol) {
      return {
        instrumentToken: parseInt(cols[tokenIdx]),
        lotSize: parseInt(cols[lotIdx]) || 1,
      };
    }
  }
  throw new Error(`Instrument ${tradingsymbol} not found on ${exchange}`);
}

async function fetchCandlesKite(accessToken, instrumentToken, timeframe) {
  const interval = KITE_INTERVAL[timeframe] || "5minute";
  const daysBack = KITE_DAYS_BACK[interval] || 10;

  const to = new Date();
  const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 19).replace("T", " ");

  const url = `${KITE_BASE}/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(to))}`;
  const res = await fetch(url, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${process.env.KITE_API_KEY}:${accessToken}`,
    },
  });

  const data = await res.json();
  if (data.status !== "success") throw new Error(`Kite historical data failed: ${data.message}`);

  return data.data.candles.map(([time, open, high, low, close, volume]) => ({
    time: new Date(time).getTime(),
    open,
    high,
    low,
    close,
    volume,
  }));
}

async function fetchCandlesYahoo(tradingsymbol, exchange, timeframe) {
  const suffix = exchange === "BSE" ? ".BO" : ".NS";
  const ticker = `${tradingsymbol}${suffix}`;
  const [interval, range] = YAHOO_PARAMS[timeframe] || ["5m", "5d"];

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`);

  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance: no data for ${ticker}`);

  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];

  return timestamps
    .map((t, i) => ({
      time: t * 1000,
      open: quote.open[i],
      high: quote.high[i],
      low: quote.low[i],
      close: quote.close[i],
      volume: quote.volume[i],
    }))
    .filter((c) => c.close != null);
}

export async function fetchCandles(accessToken, tradingsymbol, exchange, instrumentType, timeframe) {
  if (accessToken) {
    try {
      const { instrumentToken, lotSize } = await resolveInstrument(accessToken, tradingsymbol, exchange);
      const candles = await fetchCandlesKite(accessToken, instrumentToken, timeframe);
      return { candles, lotSize, source: "kite" };
    } catch (err) {
      if (instrumentType !== "equity") {
        throw new Error(
          `Kite data failed for F&O instrument — no Yahoo fallback for derivatives. Error: ${err.message}`
        );
      }
      console.log(`⚠️  Kite data failed, falling back to Yahoo Finance: ${err.message}`);
    }
  }

  if (instrumentType !== "equity") {
    throw new Error("No Kite token — cannot fetch F&O data from Yahoo Finance.");
  }

  const candles = await fetchCandlesYahoo(tradingsymbol, exchange, timeframe);
  return { candles, lotSize: 1, source: "yahoo" };
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
node --test tests/market-data.test.js
```

Expected: all 10 tests pass (6 `isMarketOpen`, 4 `fetchCandles`).

- [ ] **Step 5: Commit**

```bash
git add market-data.js tests/market-data.test.js
git commit -m "feat: add market-data.js — Kite primary, Yahoo fallback, market hours guard"
```

---

## Task 4: `zerodha.js` (TDD)

**Files:**
- Create: `tests/zerodha.test.js`
- Create: `zerodha.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/zerodha.test.js`:

```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { placeZerodhaOrder } from "../zerodha.js";

describe("placeZerodhaOrder", () => {
  test("calculates correct equity quantity and places order", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      json: async () => ({ status: "success", data: { order_id: "EQ001" } }),
    }));

    // price=100, sizeUSD=1000 → quantity = floor(1000/100) = 10
    const result = await placeZerodhaOrder("token", {
      tradingsymbol: "SBIN",
      exchange: "NSE",
      side: "buy",
      sizeUSD: 1000,
      price: 100,
      lotSize: 1,
    });

    assert.equal(result.quantity, 10);
    assert.equal(result.orderId, "EQ001");
  });

  test("throws when equity trade size too small for one share", async () => {
    // price=2500, sizeUSD=10 → floor(10/2500) = 0 → throws
    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        side: "buy",
        sizeUSD: 10,
        price: 2500,
        lotSize: 1,
      }),
      /too small for one share/
    );
  });

  test("calculates correct F&O quantity as lot multiple", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      json: async () => ({ status: "success", data: { order_id: "FNO001" } }),
    }));

    // price=100, lotSize=50, sizeUSD=10000 → lots=floor(10000/(100*50))=2 → qty=100
    const result = await placeZerodhaOrder("token", {
      tradingsymbol: "NIFTY25MAYFUT",
      exchange: "NFO",
      side: "buy",
      sizeUSD: 10000,
      price: 100,
      lotSize: 50,
    });

    assert.equal(result.quantity, 100); // 2 lots × 50
    assert.equal(result.orderId, "FNO001");
  });

  test("throws when F&O trade size too small for one lot", async () => {
    // price=22000, lotSize=75, sizeUSD=100 → floor(100/1650000) = 0 → throws
    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "NIFTY25MAYFUT",
        exchange: "NFO",
        side: "buy",
        sizeUSD: 100,
        price: 22000,
        lotSize: 75,
      }),
      /too small for one lot/
    );
  });

  test("throws on Kite order failure response", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      json: async () => ({ status: "error", message: "Insufficient funds" }),
    }));

    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "SBIN",
        exchange: "NSE",
        side: "buy",
        sizeUSD: 1000,
        price: 100,
        lotSize: 1,
      }),
      /Kite order failed: Insufficient funds/
    );
  });

  test("sends correct transaction_type for sell orders", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    let capturedBody = "";
    t.mock.method(global, "fetch", async (_url, opts) => {
      capturedBody = opts.body.toString();
      return { json: async () => ({ status: "success", data: { order_id: "SELL001" } }) };
    });

    await placeZerodhaOrder("token", {
      tradingsymbol: "SBIN",
      exchange: "NSE",
      side: "sell",
      sizeUSD: 1000,
      price: 100,
      lotSize: 1,
    });

    assert.ok(capturedBody.includes("transaction_type=SELL"), `Expected SELL in body, got: ${capturedBody}`);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
node --test tests/zerodha.test.js
```

Expected: `Error: Cannot find module '../zerodha.js'`

- [ ] **Step 3: Create `zerodha.js`**

```javascript
import "dotenv/config";

const KITE_BASE = "https://api.kite.trade";

function kiteHeaders(accessToken) {
  return {
    "X-Kite-Version": "3",
    Authorization: `token ${process.env.KITE_API_KEY}:${accessToken}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

export async function placeZerodhaOrder(
  accessToken,
  { tradingsymbol, exchange, side, sizeUSD, price, lotSize = 1 }
) {
  let quantity;

  if (exchange === "NFO") {
    const lots = Math.floor(sizeUSD / (price * lotSize));
    if (lots < 1) {
      throw new Error(
        `Trade size ${sizeUSD} too small for one lot of ${tradingsymbol} (needs ~${(price * lotSize).toFixed(2)})`
      );
    }
    quantity = lots * lotSize;
  } else {
    quantity = Math.floor(sizeUSD / price);
    if (quantity < 1) {
      throw new Error(
        `Trade size ${sizeUSD} too small for one share of ${tradingsymbol} at ${price}`
      );
    }
  }

  const body = new URLSearchParams({
    tradingsymbol,
    exchange,
    transaction_type: side.toUpperCase(),
    order_type: "MARKET",
    quantity: quantity.toString(),
    product: "MIS",
  });

  const res = await fetch(`${KITE_BASE}/orders/regular`, {
    method: "POST",
    headers: kiteHeaders(accessToken),
    body,
  });

  const data = await res.json();
  if (data.status !== "success") throw new Error(`Kite order failed: ${data.message}`);

  return { orderId: data.data.order_id, quantity };
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
node --test tests/zerodha.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 5: Run the full test suite**

```bash
npm test
```

Expected: all 17 tests pass across 3 test files.

- [ ] **Step 6: Commit**

```bash
git add zerodha.js tests/zerodha.test.js
git commit -m "feat: add zerodha.js — equity + F&O order placement with lot size validation"
```

---

## Task 5: Refactor `bot.js`

**Files:**
- Modify: `bot.js` (remove BitGet, wire new modules)

This task replaces the entire `bot.js` with the refactored version below. The safety check, indicator calculations, trade limits, CSV logging, and paper trading mode are preserved. Changes: imports added, CONFIG updated, `checkOnboarding` updated, `runSafetyCheck` returns `side`, `writeTradeCsv` uses dynamic side and "Zerodha", `run()` wired to new modules.

- [ ] **Step 1: Replace `bot.js` with the refactored version**

```javascript
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import { loadToken, printLoginInstructions } from "./kite-auth.js";
import { isMarketOpen, fetchCandles } from "./market-data.js";
import { placeZerodhaOrder } from "./zerodha.js";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["KITE_API_KEY", "KITE_API_SECRET"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — opening it for you to fill in...\n");
    writeFileSync(
      ".env",
      [
        "# Kite Connect credentials",
        "KITE_API_KEY=",
        "KITE_API_SECRET=",
        "KITE_REDIRECT_URL=http://localhost:3000/callback",
        "",
        "# Instrument config (equity: NSE/BSE, futures/options: NFO)",
        "INSTRUMENT_TYPE=equity",
        "EXCHANGE=NSE",
        "TRADINGSYMBOL=RELIANCE",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "TIMEFRAME=5m",
      ].join("\n") + "\n",
    );
    try { execSync("open .env"); } catch {}
    console.log("Fill in your Kite credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    try { execSync("open .env"); } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(`   Open in Google Sheets or Excel any time.\n`);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  tradingsymbol: process.env.TRADINGSYMBOL || "RELIANCE",
  exchange: process.env.EXCHANGE || "NSE",
  instrumentType: process.env.INSTRUMENT_TYPE || "equity",
  timeframe: process.env.TIMEFRAME || "5m",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ─────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ────────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];
  let side = null;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    side = "buy";
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    check("Price above VWAP (buyers in control)", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    check("Price above EMA(8) (uptrend confirmed)", `> ${ema8.toFixed(2)}`, price.toFixed(2), price > ema8);
    check("RSI(3) below 30 (snap-back setup in uptrend)", "< 30", rsi3.toFixed(2), rsi3 < 30);

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${distFromVWAP.toFixed(2)}%`, distFromVWAP < 1.5);
  } else if (bearishBias) {
    side = "sell";
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check("Price below VWAP (sellers in control)", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
    check("Price below EMA(8) (downtrend confirmed)", `< ${ema8.toFixed(2)}`, price.toFixed(2), price < ema8);
    check("RSI(3) above 70 (reversal setup in downtrend)", "> 70", rsi3.toFixed(2), rsi3 > 70);

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${distFromVWAP.toFixed(2)}%`, distFromVWAP < 1.5);
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass, side };
}

// ─── Trade Limits ─────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }

  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  console.log(`✅ Trade size: ${tradeSize.toFixed(2)} — within max ${CONFIG.maxTradeSizeUSD}`);

  return true;
}

// ─── Tax CSV Logging ──────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";
const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side", "Quantity",
  "Price", "Total", "Fee (est.)", "Net Amount", "Order ID", "Mode", "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "", quantity = "", total = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = (logEntry.side || "BUY").toUpperCase();
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    total = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = (logEntry.side || "BUY").toUpperCase();
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    total = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date, time, "Zerodha", logEntry.symbol, side, quantity,
    logEntry.price.toFixed(2), total, fee, netAmount, orderId, mode, `"${notes}"`,
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume           : ${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : ${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Zerodha");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Market hours check — exits cleanly outside NSE hours
  if (!isMarketOpen()) {
    console.log("\n🕒 Market is closed. NSE hours: 09:15–15:30 IST, Mon–Fri.");
    console.log("   No trade attempted.\n");
    return;
  }

  // Token check — prints instructions and exits if expired
  const accessToken = loadToken();
  if (!accessToken) {
    printLoginInstructions();
    process.exit(0);
  }

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.tradingsymbol} (${CONFIG.exchange}) | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch market data
  console.log("\n── Fetching market data ────────────────────────────────\n");
  const { candles, lotSize, source } = await fetchCandles(
    accessToken,
    CONFIG.tradingsymbol,
    CONFIG.exchange,
    CONFIG.instrumentType,
    CONFIG.timeframe,
  );
  console.log(`  Data source: ${source}`);

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: ₹${price.toFixed(2)}`);

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  ₹${ema8.toFixed(2)}`);
  console.log(`  VWAP:    ${vwap ? `₹${vwap.toFixed(2)}` : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Run safety check
  const { results, allPass, side } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  // Position size
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.tradingsymbol,
    exchange: CONFIG.exchange,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    side,
    tradeSize,
    lotSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    dataSource: source,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would ${side.toUpperCase()} ${CONFIG.tradingsymbol} ~₹${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — ₹${tradeSize.toFixed(2)} ${side.toUpperCase()} ${CONFIG.tradingsymbol}`);
      try {
        const order = await placeZerodhaOrder(accessToken, {
          tradingsymbol: CONFIG.tradingsymbol,
          exchange: CONFIG.exchange,
          side,
          sizeUSD: tradeSize,
          price,
          lotSize,
        });
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId} (qty: ${order.quantity})`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  writeTradeCsv(logEntry);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Run the full test suite to confirm nothing broke**

```bash
npm test
```

Expected: all 17 tests pass.

- [ ] **Step 3: Smoke test — verify bot starts and exits cleanly without credentials**

```bash
node bot.js
```

Expected output includes: `⚠️  No .env file found` or `⚠️  Missing credentials` (depending on whether `.env` exists).

- [ ] **Step 4: Commit**

```bash
git add bot.js
git commit -m "feat: refactor bot.js — replace BitGet with Zerodha, add market hours guard and side-aware orders"
```

---

## Task 6: Remove `node-fetch` dependency

**Files:**
- Modify: `package-lock.json` (via npm)

- [ ] **Step 1: Remove the now-unused `node-fetch` package**

```bash
npm uninstall node-fetch
```

- [ ] **Step 2: Verify tests still pass after dependency removal**

```bash
npm test
```

Expected: all 17 tests pass.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove node-fetch — using Node 18 native fetch"
```

---

## Done

The bot now:
- Authenticates via Kite Connect with semi-automated daily token refresh
- Fetches candles from Kite (primary) or Yahoo Finance (equity fallback)
- Skips execution outside NSE market hours (09:15–15:30 IST, Mon–Fri)
- Places equity (NSE/BSE) and F&O (NFO) market orders via Kite REST API
- Correctly sizes F&O orders to lot size multiples
- Records BUY or SELL side in `trades.csv` based on actual bias direction
- All BitGet code removed
