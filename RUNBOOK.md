# Runbook — Zerodha Trading Dashboard

Complete setup guide for running the trading dashboard locally on **Linux** or **Windows**.

---

## Prerequisites

| Requirement | How to check | Install |
|------------|-------------|---------|
| Node.js 18+ | `node --version` | https://nodejs.org |
| Zerodha account | — | https://zerodha.com |
| Kite Connect API | — | https://kite.trade (₹2000/month) |
| Anthropic API key (optional) | — | https://console.anthropic.com/settings/keys |

---

## Step 1 — Clone & Install

```bash
git clone https://github.com/sisoppin/claude-tradingview-mcp-trading
cd claude-tradingview-mcp-trading
npm install
```

Verify:
```bash
node --version    # Should show v18+ 
npm test          # Should show all tests passing
```

---

## Step 2 — Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
# ─── Zerodha Kite Connect ─────────────────────────────────────
KITE_API_KEY=your_api_key_here
KITE_API_SECRET=your_api_secret_here
KITE_REDIRECT_URL=http://localhost:8080

# ─── Instrument ───────────────────────────────────────────────
INSTRUMENT_TYPE=equity
EXCHANGE=NSE
TRADINGSYMBOL=RELIANCE

# ─── Trading Config ───────────────────────────────────────────
PORTFOLIO_VALUE_INR=50000
MAX_TRADE_SIZE_INR=5000
MAX_TRADES_PER_DAY=3
PAPER_TRADING=true
TIMEFRAME=5m

# ─── Claude AI Analysis (optional) ────────────────────────────
ANTHROPIC_API_KEY=
```

### Where to get Kite credentials:

1. Go to https://kite.trade → Log in
2. Click **"Create new app"** (or open your existing app)
3. Copy **API Key** (16 characters, e.g. `cj5pa7z8497nojq2`)
4. Copy **API Secret** (32 characters)
5. Set **Redirect URL** to `http://localhost:8080`
6. Save

> ⚠️ **Common mistake:** Don't confuse the API Secret with a request_token. The secret is fixed and never changes. The request_token is temporary and different every login.

---

## Step 3 — Authenticate with Zerodha

Kite tokens expire **daily at 6:00 AM IST**. You must re-authenticate each morning.

### Option A — Interactive CLI (recommended first time)

```bash
node kite_auth.js
```

1. It prints a login URL → open it in your browser
2. Log in to Zerodha with your credentials + 2FA
3. After login, Kite redirects to your callback URL:
   ```
   http://localhost:8080?request_token=XXXXX&action=login&status=success
   ```
4. Copy the `request_token` value from the URL bar
5. Paste it in the terminal **immediately** (within 60 seconds)
6. Success: `KITE_ACCESS_TOKEN written to .env`

### Option B — Auto-capture via Dashboard

1. Start the server first: `node server.js`
2. Open http://localhost:8080 → **Auth** tab
3. Click **"Open Kite Login Page"**
4. Log in to Zerodha
5. Kite redirects back to `http://localhost:8080?request_token=XXX`
6. Server auto-captures and exchanges the token
7. You see: **"✅ Authenticated!"**

### Troubleshooting Authentication

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid checksum` | Wrong API Secret in `.env` | Get correct secret from https://kite.trade → your app |
| `Token is invalid or has expired` | request_token used/expired | Get a fresh one — they're single-use and expire in ~60 seconds |
| `TokenException` at 6 AM | Daily token expiry | Re-authenticate (normal — Kite does this every day) |
| Redirect doesn't work | Wrong redirect URL | Ensure Kite app redirect URL = `http://localhost:8080` |

---

## Step 4 — Run Diagnostics

```bash
node diagnose.js
```

This checks everything and tells you exactly what's working, failing, or needs action. Fix any ❌ items before proceeding.

Expected output when ready:
```
✅ 32+ passed  ❌ 0 failed  ⚠️ 0-1 warnings
Ready to run: node server.js
```

---

## Step 5 — Start the Dashboard

```bash
node server.js
```

Output:
```
═══════════════════════════════════════════════════════════
  Zerodha Trading Dashboard
  http://localhost:8080
  Mode: 📋 PAPER TRADING
  Symbol: RELIANCE (NSE)
═══════════════════════════════════════════════════════════
```

Open **http://localhost:8080** in your browser.

---

## Step 6 — Verify Everything Works

| Tab | What to check |
|-----|--------------|
| **Dashboard** | Price loads, indicators populate, strategies show signals |
| **Chart** | Candlestick chart renders with EMA(20) and VWAP overlays |
| **Portfolio** | Shows your Zerodha holdings (needs valid token) |
| **Orders** | Shows today's orders (empty if none placed) |
| **Auto-Trade** | Start/stop works, log shows entries |
| **AI Analysis** | Returns Claude summary (needs `ANTHROPIC_API_KEY`) |
| **Settings** | Change symbol dynamically, click "Apply & Refresh" |

---

## Daily Workflow

```
Morning (before 9:15 AM IST):
  1. Run: node kite_auth.js  (or use Auth tab)
  2. Run: node server.js
  3. Open: http://localhost:8080

During market hours (9:15–15:30 IST):
  - Dashboard auto-refreshes every 5 minutes
  - Use Auto-Trade tab to enable automated trading
  - Use AI Analysis for Claude's market assessment

After market closes:
  - Stop the server (Ctrl+C)
  - Review trades.csv for the day's activity
```

---

## Commands Reference

| Command | What it does |
|---------|-------------|
| `node server.js` | Start web dashboard on port 8080 |
| `node kite_auth.js` | Authenticate with Zerodha (interactive) |
| `node analyze.js` | Run analysis CLI (no server needed) |
| `node bot.js` | Run trading bot (one-shot, places orders) |
| `node bot.js --tax-summary` | Print trade summary from CSV |
| `node diagnose.js` | System health check |
| `npm test` | Run test suite |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Dashboard UI |
| GET | `/api/status` | Market status, token validity, config |
| GET | `/api/analyze` | Run all 6 strategies, return JSON + candles |
| GET | `/api/claude` | Claude AI analysis summary |
| GET | `/api/portfolio` | Zerodha positions + holdings |
| GET | `/api/orders` | Today's orders |
| POST | `/api/trade` | Place manual trade `{side, symbol, exchange, sizeINR, price}` |
| GET | `/api/settings` | Current runtime config |
| POST | `/api/settings` | Update symbol/exchange/timeframe `{symbol, exchange, timeframe}` |
| GET | `/api/autotrade` | Auto-trade status + log |
| POST | `/api/autotrade` | Start/stop/configure `{enabled, minConfidence, intervalMs, tradeSizeINR}` |
| GET | `/api/auth/url` | Get Kite login URL |
| POST | `/api/auth/token` | Exchange request_token `{requestToken}` |

---

## Configuration Options

### .env Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KITE_API_KEY` | — | Kite Connect API key (required) |
| `KITE_API_SECRET` | — | Kite Connect API secret (required) |
| `KITE_ACCESS_TOKEN` | — | Auto-populated by kite_auth.js |
| `KITE_REDIRECT_URL` | `http://localhost:8080` | OAuth redirect URL |
| `INSTRUMENT_TYPE` | `equity` | `equity` or `nfo` (derivatives) |
| `EXCHANGE` | `NSE` | `NSE`, `BSE`, or `NFO` |
| `TRADINGSYMBOL` | `RELIANCE` | Stock/instrument symbol |
| `PORTFOLIO_VALUE_INR` | `50000` | Total portfolio for position sizing |
| `MAX_TRADE_SIZE_INR` | `5000` | Maximum per-trade amount |
| `MAX_TRADES_PER_DAY` | `3` | Daily trade limit |
| `PAPER_TRADING` | `true` | `true` = log only, `false` = real orders |
| `TIMEFRAME` | `5m` | `1m`, `5m`, `1H`, `1D` |
| `ANTHROPIC_API_KEY` | — | For Claude AI analysis (optional) |
| `PORT` | `8080` | Server port |

### Auto-Trade Settings (via UI or API)

| Setting | Default | Description |
|---------|---------|-------------|
| Min Confidence | `STRONG` | Only trade on STRONG signals (≥75% score) |
| Interval | `5 min` | How often to check for signals |
| Trade Size | `₹5000` | Amount per trade |
| Max Trades/Day | `3` | Stop after this many trades |

---

## Strategies (6 total)

| # | Strategy | Source | Signal Type |
|---|----------|--------|-------------|
| 1 | VWAP + EMA(8) + RSI(3) | Original | Mean-reversion (sideways) |
| 2 | MACD Crossover | Original | Trend momentum |
| 3 | Bollinger Bands + RSI(14) | Original | Mean-reversion (sideways) |
| 4 | ORB 15min + RSI(14) | Original | Trend (early session) |
| 5 | LargeCap VWAP+RSI | Pine Script #1 | Buy-only (large-cap, 15min) |
| 6 | EMA(20) Crossover | Pine Script #2 | Buy/Sell (5min, confirmation) |

---

## Safety & Risk

- **PAPER_TRADING=true by default** — no real orders until you explicitly change it
- **Daily trade cap** — stops after `MAX_TRADES_PER_DAY`
- **Position size cap** — never exceeds `MAX_TRADE_SIZE_INR`
- **Market hours gate** — won't trade outside 9:15–15:30 IST
- **Confidence gate** — auto-trade only fires on STRONG signals by default
- **All decisions logged** — `trades.csv` + `safety-check-log.json` for audit trail

### Going Live

Only do this after paper trading for several sessions and confirming the logic:

```bash
# In .env:
PAPER_TRADING=false
```

Then restart the server.

---

## Windows-Specific Notes

### Install Node.js
Download from https://nodejs.org (LTS version). The installer adds `node` and `npm` to PATH.

### Run commands in PowerShell or CMD
```powershell
cd claude-tradingview-mcp-trading
npm install
node kite_auth.js
node server.js
```

### Kill port if stuck
```powershell
netstat -ano | findstr :8080
taskkill /PID <pid_number> /F
```

### Run on startup (optional)
Create a `.bat` file:
```bat
@echo off
cd C:\path\to\claude-tradingview-mcp-trading
node server.js
```

Or use Task Scheduler to run `node server.js` at login.

---

## Linux-Specific Notes

### Run in background
```bash
node server.js &
# Or with nohup:
nohup node server.js > server.log 2>&1 &
```

### Kill port if stuck
```bash
lsof -ti :8080 | xargs kill -9
```

### Auto-start with systemd (optional)
```bash
sudo nano /etc/systemd/system/trading-dashboard.service
```

```ini
[Unit]
Description=Zerodha Trading Dashboard
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Zerodha/claude-tradingview-mcp-trading
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable trading-dashboard
sudo systemctl start trading-dashboard
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port 8080 in use | `lsof -ti :8080 \| xargs kill` or set `PORT=3000` in `.env` |
| Yahoo data stale | Normal when market is closed; during hours it refreshes every 5min |
| Token expired | Re-run `node kite_auth.js` (happens daily at 6 AM IST) |
| Analysis shows HOLD | All strategies neutral — no actionable signal (this is normal) |
| Auto-trade not firing | Check: market open? confidence STRONG? daily limit not reached? |
| Claude AI error | Set `ANTHROPIC_API_KEY` in `.env` |
| F&O data fails | F&O requires Kite token — no Yahoo fallback for derivatives |
| `Cannot find module` | Run `npm install` |

---

## File Structure

```
claude-tradingview-mcp-trading/
├── server.js          ← Web dashboard server (start here)
├── public/
│   └── index.html     ← Dashboard UI
├── analyze.js         ← CLI analysis engine
├── bot.js             ← CLI trading bot
├── strategies.js      ← All 6 strategies
├── indicators.js      ← EMA, RSI, MACD, Bollinger math
├── market-data.js     ← Kite + Yahoo data fetching
├── zerodha.js         ← Order placement
├── kite-auth.js       ← OAuth token exchange
├── kite_auth.js       ← Interactive CLI auth helper
├── diagnose.js        ← System health check
├── rules.json         ← Strategy rules definition
├── .env               ← Your credentials (never commit)
├── .env.example       ← Template
├── trades.csv         ← Auto-generated trade log
├── kite-token.json    ← Auto-generated token storage
└── tests/             ← Test suite
```
