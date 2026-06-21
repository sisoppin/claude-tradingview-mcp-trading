import "dotenv/config";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { isMarketOpen, fetchCandles } from "./market-data.js";
import { loadToken, exchangeToken } from "./kite-auth.js";
import { placeZerodhaOrder } from "./zerodha.js";
import {
  vwapEmaRsiStrategy,
  macdStrategy,
  bollingerRsiStrategy,
  orbStrategy,
  detectMarketMode,
  largeCapVwapRsiStrategy,
  ema20CrossoverStrategy,
} from "./strategies.js";
import { modeCombinedSignal, isInOrbWindow } from "./analyze.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const KITE_BASE = "https://api.kite.trade";

// Runtime config — can be changed without restarting
const runtime = {
  symbol: process.env.TRADINGSYMBOL || "RELIANCE",
  exchange: process.env.EXCHANGE || "NSE",
  instrumentType: process.env.INSTRUMENT_TYPE || "equity",
  timeframe: process.env.TIMEFRAME || "5m",
};

// ─── Auto-Trade Engine ────────────────────────────────────────────────────────

const autoTrade = {
  enabled: false,
  intervalMs: 5 * 60 * 1000, // 5 minutes
  minConfidence: "STRONG",
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  tradeSizeINR: parseFloat(process.env.MAX_TRADE_SIZE_INR || "5000"),
  tradesToday: 0,
  lastTradeDate: null,
  timer: null,
  log: [],
};

function resetDailyCount() {
  const today = new Date().toISOString().slice(0, 10);
  if (autoTrade.lastTradeDate !== today) {
    autoTrade.tradesToday = 0;
    autoTrade.lastTradeDate = today;
  }
}

async function autoTradeLoop() {
  if (!autoTrade.enabled) return;
  resetDailyCount();

  const entry = { time: new Date().toISOString(), symbol: runtime.symbol, action: null, signal: null, confidence: null, orderId: null, error: null };

  if (!isMarketOpen()) {
    entry.action = "SKIP";
    entry.error = "Market closed";
    autoTrade.log.push(entry);
    console.log(`[AutoTrade] ${entry.time} — Market closed, skipping`);
    return;
  }

  if (autoTrade.tradesToday >= autoTrade.maxTradesPerDay) {
    entry.action = "SKIP";
    entry.error = `Daily limit reached (${autoTrade.tradesToday}/${autoTrade.maxTradesPerDay})`;
    autoTrade.log.push(entry);
    console.log(`[AutoTrade] ${entry.time} — Daily limit reached`);
    return;
  }

  try {
    const token = getToken();
    const { symbol, exchange, instrumentType, timeframe } = runtime;
    const { candles, lotSize } = await fetchCandles(token, symbol, exchange, instrumentType, timeframe);

    const s1 = vwapEmaRsiStrategy(candles);
    const s2 = macdStrategy(candles);
    const s3 = bollingerRsiStrategy(candles);
    const s4 = orbStrategy(candles);
    const modeResult = detectMarketMode(candles);
    const inOrbWindow = isInOrbWindow(candles);
    const combined = modeCombinedSignal(modeResult.mode, inOrbWindow, [s1, s2, s3, s4]);

    entry.signal = combined.signal;
    entry.confidence = combined.confidence;
    entry.score = combined.score;
    entry.mode = combined.mode;

    const price = candles[candles.length - 1].close;

    if (combined.signal === "HOLD") {
      entry.action = "HOLD";
      autoTrade.log.push(entry);
      console.log(`[AutoTrade] ${entry.time} — ${symbol} HOLD (${combined.confidence} ${(combined.score*100).toFixed(0)}%)`);
      return;
    }

    if (autoTrade.minConfidence === "STRONG" && combined.confidence !== "STRONG") {
      entry.action = "SKIP";
      entry.error = `Signal ${combined.signal} but confidence WEAK (${(combined.score*100).toFixed(0)}%) — need STRONG`;
      autoTrade.log.push(entry);
      console.log(`[AutoTrade] ${entry.time} — ${symbol} ${combined.signal} skipped (WEAK confidence)`);
      return;
    }

    // Place trade
    const side = combined.signal.toLowerCase();
    const paperTrading = process.env.PAPER_TRADING !== "false";

    if (paperTrading) {
      const qty = exchange === "NFO" ? Math.floor(autoTrade.tradeSizeINR / (price * lotSize)) * lotSize : Math.floor(autoTrade.tradeSizeINR / price);
      entry.action = `PAPER_${combined.signal}`;
      entry.orderId = `PAPER-${Date.now()}`;
      entry.quantity = qty;
      entry.price = price;
      console.log(`[AutoTrade] ${entry.time} — 📋 PAPER ${combined.signal} ${symbol} qty:${qty} @ ₹${price.toFixed(2)}`);
    } else {
      const order = await placeZerodhaOrder(token, { tradingsymbol: symbol, exchange, side, sizeINR: autoTrade.tradeSizeINR, price, lotSize });
      entry.action = `LIVE_${combined.signal}`;
      entry.orderId = order.orderId;
      entry.quantity = order.quantity;
      entry.price = price;
      console.log(`[AutoTrade] ${entry.time} — 🔴 LIVE ${combined.signal} ${symbol} qty:${order.quantity} @ ₹${price.toFixed(2)} → ${order.orderId}`);
    }

    autoTrade.tradesToday++;
  } catch (e) {
    entry.action = "ERROR";
    entry.error = e.message;
    console.log(`[AutoTrade] ${entry.time} — ERROR: ${e.message}`);
  }

  autoTrade.log.push(entry);
  if (autoTrade.log.length > 200) autoTrade.log = autoTrade.log.slice(-200);
}

function startAutoTrade() {
  if (autoTrade.timer) return;
  autoTrade.enabled = true;
  autoTrade.timer = setInterval(autoTradeLoop, autoTrade.intervalMs);
  autoTradeLoop(); // run immediately
  console.log(`[AutoTrade] STARTED — interval ${autoTrade.intervalMs / 1000}s, min confidence: ${autoTrade.minConfidence}`);
}

function stopAutoTrade() {
  autoTrade.enabled = false;
  if (autoTrade.timer) { clearInterval(autoTrade.timer); autoTrade.timer = null; }
  console.log(`[AutoTrade] STOPPED`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function err(res, message, status = 500) {
  json(res, { error: message }, status);
}

function kiteHeaders(token) {
  return {
    "X-Kite-Version": "3",
    Authorization: `token ${process.env.KITE_API_KEY}:${token}`,
  };
}

async function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// ─── API Handlers ─────────────────────────────────────────────────────────────

function getToken() {
  return loadToken() || process.env.KITE_ACCESS_TOKEN || null;
}

async function handleStatus(res) {
  const token = getToken();
  json(res, {
    marketOpen: isMarketOpen(),
    tokenValid: !!token,
    paperTrading: process.env.PAPER_TRADING !== "false",
    symbol: runtime.symbol,
    exchange: runtime.exchange,
    instrumentType: runtime.instrumentType,
    portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_INR || "50000"),
    maxTradeSizeINR: parseFloat(process.env.MAX_TRADE_SIZE_INR || "5000"),
    maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
    timeframe: runtime.timeframe,
    time: new Date().toISOString(),
  });
}

async function handleSettings(req, res) {
  if (req.method === "GET") {
    return json(res, runtime);
  }
  const body = await parseBody(req);
  if (body.symbol) runtime.symbol = body.symbol.toUpperCase();
  if (body.exchange) runtime.exchange = body.exchange.toUpperCase();
  if (body.instrumentType) runtime.instrumentType = body.instrumentType;
  if (body.timeframe) runtime.timeframe = body.timeframe;
  json(res, { updated: true, ...runtime });
}

async function handleAnalyze(res) {
  try {
    const token = getToken();
    const { symbol, exchange, instrumentType, timeframe } = runtime;

    const { candles, lotSize, source } = await fetchCandles(token, symbol, exchange, instrumentType, timeframe);

    const s1 = vwapEmaRsiStrategy(candles);
    const s2 = macdStrategy(candles);
    const s3 = bollingerRsiStrategy(candles);
    const s4 = orbStrategy(candles);
    const s5 = largeCapVwapRsiStrategy(candles, symbol);
    const s6 = ema20CrossoverStrategy(candles);
    const modeResult = detectMarketMode(candles);
    const inOrbWindow = isInOrbWindow(candles);
    const combined = modeCombinedSignal(modeResult.mode, inOrbWindow, [s1, s2, s3, s4]);

    const price = candles[candles.length - 1].close;
    const lastCandleMs = candles[candles.length - 1].time;
    const ageMinutes = Math.round((Date.now() - lastCandleMs) / 60000);
    const lastCandleIST = new Date(lastCandleMs + 5.5 * 60 * 60 * 1000).toISOString().slice(11, 16) + " IST";

    json(res, {
      symbol, exchange, price, source,
      freshness: { ageMinutes, lastCandleIST, stale: ageMinutes > 20 },
      mode: modeResult,
      inOrbWindow,
      strategies: {
        vwapEmaRsi: s1,
        macd: s2,
        bollingerRsi: s3,
        orb: s4,
        largeCapVwapRsi: s5,
        ema20Crossover: s6,
      },
      combined,
      candles: candles.slice(-100).map(c => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    err(res, e.message);
  }
}

async function handleClaudeAnalysis(res) {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!claudeKey) return err(res, "ANTHROPIC_API_KEY not set in .env", 400);

  try {
    const token = getToken();
    const { symbol, exchange, instrumentType, timeframe } = runtime;
    const { candles } = await fetchCandles(token, symbol, exchange, instrumentType, timeframe);

    const s1 = vwapEmaRsiStrategy(candles);
    const s2 = macdStrategy(candles);
    const s3 = bollingerRsiStrategy(candles);
    const s4 = orbStrategy(candles);
    const s5 = largeCapVwapRsiStrategy(candles, symbol);
    const s6 = ema20CrossoverStrategy(candles);
    const modeResult = detectMarketMode(candles);
    const inOrbWindow = isInOrbWindow(candles);
    const combined = modeCombinedSignal(modeResult.mode, inOrbWindow, [s1, s2, s3, s4]);
    const price = candles[candles.length - 1].close;

    const recentCandles = candles.slice(-20).map(c => `${new Date(c.time).toISOString().slice(11,16)} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)} V:${c.volume}`);

    const prompt = `You are an expert Indian equity market analyst. Analyze this data for ${symbol} (${exchange}) and provide a concise actionable summary.

Current Price: ₹${price.toFixed(2)}
Market Mode: ${modeResult.mode.toUpperCase()} (VWAP slope: ${modeResult.vwapSlope?.toFixed(4) || 'N/A'})
Timeframe: ${timeframe}

Strategy Signals:
1. VWAP+EMA+RSI: ${s1.signal} (rules: ${s1.rules.filter(r=>r.pass).length}/${s1.rules.length})
2. MACD Crossover: ${s2.signal}
3. Bollinger+RSI: ${s3.signal} (RSI14: ${s3.indicators.rsi14?.toFixed(2) || 'N/A'})
4. ORB 15min: ${s4.signal}
5. LargeCap VWAP+RSI: ${s5.signal} (rules: ${s5.rules.filter(r=>r.pass).length}/${s5.rules.length})
6. EMA20 Crossover: ${s6.signal}

Combined Signal: ${combined.signal} | Confidence: ${combined.confidence} (${(combined.score*100).toFixed(0)}%)
Active Strategies: ${combined.activeStrategies.join(', ')}

Key Indicators:
- VWAP: ₹${s1.indicators.vwap?.toFixed(2) || 'N/A'}
- EMA(8): ₹${s1.indicators.ema8?.toFixed(2) || 'N/A'}
- EMA(20): ₹${s6.indicators.ema20?.toFixed(2) || 'N/A'}
- RSI(3): ${s1.indicators.rsi3?.toFixed(2) || 'N/A'}
- RSI(14): ${s3.indicators.rsi14?.toFixed(2) || 'N/A'}
- MACD: ${s2.indicators.macd?.toFixed(4) || 'N/A'} | Signal: ${s2.indicators.signal?.toFixed(4) || 'N/A'}
- BB Upper: ₹${s3.indicators.upper?.toFixed(2) || 'N/A'} | Lower: ₹${s3.indicators.lower?.toFixed(2) || 'N/A'}

Last 20 candles (${timeframe}):
${recentCandles.join('\n')}

Provide:
1. **Market Summary** (2-3 sentences on current structure)
2. **Signal Assessment** (which strategies agree, which conflict)
3. **Risk Factors** (what could go wrong)
4. **Recommendation** (BUY / SELL / WAIT with specific entry/exit levels if applicable)
5. **Confidence** (your confidence in the recommendation: High/Medium/Low and why)`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": claudeKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const body = await claudeRes.text();
      throw new Error(`Claude API error ${claudeRes.status}: ${body.slice(0, 200)}`);
    }

    const claudeData = await claudeRes.json();
    const analysis = claudeData.content?.[0]?.text || "No response";

    json(res, { symbol, price, analysis, timestamp: new Date().toISOString() });
  } catch (e) {
    err(res, e.message);
  }
}

async function handlePortfolio(res) {
  const token = getToken();
  if (!token) return err(res, "Not authenticated — run auth flow first", 401);
  try {
    const [posRes, holdRes] = await Promise.all([
      fetch(`${KITE_BASE}/portfolio/positions`, { headers: kiteHeaders(token) }),
      fetch(`${KITE_BASE}/portfolio/holdings`, { headers: kiteHeaders(token) }),
    ]);
    const [positions, holdings] = await Promise.all([posRes.json(), holdRes.json()]);
    json(res, { positions: positions.data || {}, holdings: holdings.data || [] });
  } catch (e) {
    err(res, e.message);
  }
}

async function handleOrders(res) {
  const token = getToken();
  if (!token) return err(res, "Not authenticated", 401);
  try {
    const response = await fetch(`${KITE_BASE}/orders`, { headers: kiteHeaders(token) });
    const data = await response.json();
    json(res, { orders: data.data || [] });
  } catch (e) {
    err(res, e.message);
  }
}

async function handleTrade(req, res) {
  const token = getToken();
  if (!token) return err(res, "Not authenticated", 401);
  try {
    const body = await parseBody(req);
    const { side, symbol, exchange, sizeINR, price, lotSize } = body;
    if (!side || !symbol || !exchange || !sizeINR || !price) {
      return err(res, "Missing required fields: side, symbol, exchange, sizeINR, price", 400);
    }
    const paperTrading = process.env.PAPER_TRADING !== "false";
    if (paperTrading) {
      const qty = Math.floor(sizeINR / price);
      return json(res, { paper: true, orderId: `PAPER-${Date.now()}`, quantity: qty, side, symbol });
    }
    const order = await placeZerodhaOrder(token, { tradingsymbol: symbol, exchange, side, sizeINR, price, lotSize: lotSize || 1 });
    json(res, { paper: false, ...order });
  } catch (e) {
    err(res, e.message);
  }
}

function handleAuthUrl(res) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) return err(res, "KITE_API_KEY not set in .env", 400);
  json(res, { url: `https://kite.trade/connect/login?api_key=${apiKey}&v=3` });
}

async function handleAuthToken(req, res) {
  try {
    const { requestToken } = await parseBody(req);
    if (!requestToken) return err(res, "requestToken required", 400);
    const accessToken = await exchangeToken(requestToken);
    json(res, { success: true, accessToken });
  } catch (e) {
    err(res, e.message);
  }
}

// ─── Static file serving ──────────────────────────────────────────────────────

function serveStatic(res, filePath, contentType) {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  // Root route — serve dashboard, or auto-capture token if Kite redirects here with ?request_token=
  if (method === "GET" && (url === "/" || url.startsWith("/?"))) {
    const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    const requestToken = params.get("request_token");
    if (requestToken) {
      try {
        const accessToken = await exchangeToken(requestToken);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="background:#0f172a;color:#4ade80;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column"><h1>✅ Authenticated!</h1><p>Token saved. <a href="/" style="color:#3b82f6">Go to Dashboard</a></p></body></html>`);
      } catch (e) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="background:#0f172a;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column"><h1>❌ Auth Failed</h1><p>${e.message}</p><p><a href="/" style="color:#3b82f6">Try again</a></p></body></html>`);
      }
      return;
    }
    return serveStatic(res, join(__dirname, "public/index.html"), "text/html");
  }
  if (method === "GET" && url === "/api/status")      return handleStatus(res);
  if (method === "GET" && url === "/api/settings")    return handleSettings(req, res);
  if (method === "POST" && url === "/api/settings")   return handleSettings(req, res);
  if (method === "GET" && url === "/api/analyze")     return handleAnalyze(res);
  if (method === "GET" && url === "/api/claude")      return handleClaudeAnalysis(res);
  if (method === "GET" && url === "/api/portfolio")   return handlePortfolio(res);
  if (method === "GET" && url === "/api/orders")      return handleOrders(res);
  if (method === "POST" && url === "/api/trade")      return handleTrade(req, res);
  if (method === "GET" && url === "/api/auth/url")    return handleAuthUrl(res);
  if (method === "POST" && url === "/api/auth/token") return handleAuthToken(req, res);

  // Auto-trade endpoints
  if (method === "GET" && url === "/api/autotrade") {
    return json(res, { enabled: autoTrade.enabled, tradesToday: autoTrade.tradesToday, maxTradesPerDay: autoTrade.maxTradesPerDay, minConfidence: autoTrade.minConfidence, intervalMs: autoTrade.intervalMs, tradeSizeINR: autoTrade.tradeSizeINR, log: autoTrade.log.slice(-50) });
  }
  if (method === "POST" && url === "/api/autotrade") {
    const body = await parseBody(req);
    if (body.enabled === true) startAutoTrade();
    else if (body.enabled === false) stopAutoTrade();
    if (body.minConfidence) autoTrade.minConfidence = body.minConfidence;
    if (body.intervalMs) { autoTrade.intervalMs = body.intervalMs; if (autoTrade.timer) { stopAutoTrade(); startAutoTrade(); } }
    if (body.tradeSizeINR) autoTrade.tradeSizeINR = body.tradeSizeINR;
    if (body.maxTradesPerDay) autoTrade.maxTradesPerDay = body.maxTradesPerDay;
    return json(res, { enabled: autoTrade.enabled, tradesToday: autoTrade.tradesToday, maxTradesPerDay: autoTrade.maxTradesPerDay, minConfidence: autoTrade.minConfidence, intervalMs: autoTrade.intervalMs, tradeSizeINR: autoTrade.tradeSizeINR });
  }



  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Zerodha Trading Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Mode: ${process.env.PAPER_TRADING !== "false" ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  Symbol: ${runtime.symbol} (${runtime.exchange})`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
});
