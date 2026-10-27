import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from "fs";
import { fileURLToPath } from "url";
import { loadToken, printLoginInstructions } from "./kite-auth.js";
import {
  isMarketOpen, fetchCandles, dropFormingCandle, checkFreshness, istMinutes, istDate, TIMEFRAME_MS,
} from "./market-data.js";
import {
  placeZerodhaOrder, placeStopOrder, getOrder, cancelOrder, waitForFill, calcQuantity,
} from "./zerodha.js";
import { analyzeCandles } from "./analyze.js";
import {
  calcTradeSize, stopPrice, targetPrice, oppositeSide, strategyGroup, exitDecision, pnl,
} from "./position.js";
import { estimateCharges } from "./charges.js";
import { statePath, readJson, writeJson } from "./state.js";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["KITE_API_KEY", "KITE_API_SECRET"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env") && missing.length > 0) {
    writeFileSync(".env", readFileSync(new URL(".env.example", import.meta.url), "utf8"));
    console.log("\n⚠️  No .env file found — created one from .env.example.");
    console.log("Fill in your Kite credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  console.log(`\n📄 Trade log: ${CSV_FILE}`);
  console.log(`   Open in Google Sheets or Excel any time.\n`);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const num = (name, fallback) => {
  const v = parseFloat(process.env[name] ?? fallback);
  if (!isFinite(v)) throw new Error(`${name} must be a number, got "${process.env[name]}"`);
  return v;
};

const CONFIG = {
  tradingsymbol: process.env.TRADINGSYMBOL || "RELIANCE",
  exchange: process.env.EXCHANGE || "NSE",
  instrumentType: process.env.INSTRUMENT_TYPE || "equity",
  timeframe: process.env.TIMEFRAME || "5m",
  portfolioValue: num("PORTFOLIO_VALUE_INR", "50000"),
  maxTradeSizeINR: num("MAX_TRADE_SIZE_INR", "5000"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  riskPerTradePct: num("RISK_PER_TRADE_PCT", "1"),
  stopLossPct: num("STOP_LOSS_PCT", "0.3"),
  targetPct: num("TARGET_PCT", "0.6"),
  minConfidence: (process.env.MIN_CONFIDENCE || "STRONG").toUpperCase(),
  allowShort: process.env.ALLOW_SHORT === "true",
  entrySlippagePct: num("ENTRY_SLIPPAGE_PCT", "0.1"),
  exitSlippagePct: num("EXIT_SLIPPAGE_PCT", "0.5"),
  lastEntryMinutes: 15 * 60,       // no new positions from 15:00 IST
  squareOffMinutes: 15 * 60 + 10,  // close everything at 15:10 IST, before Zerodha's ~15:20 auto square-off
  paperTrading: process.env.PAPER_TRADING !== "false",
};

const LOG_FILE = statePath("safety-check-log.json");
const POSITION_FILE = statePath("position.json");
const CSV_FILE = statePath("trades.csv");

// ─── Logging ─────────────────────────────────────────────────────────────────

function loadLog() {
  return readJson(LOG_FILE, { trades: [] });
}

function appendLog(entry) {
  const log = loadLog();
  log.trades.push(entry);
  writeJson(LOG_FILE, log);
}

// Entries opened today (IST). Exits do not count against the daily cap.
export function countTodaysTrades(log, now = new Date()) {
  const today = istDate(now);
  return log.trades.filter(
    (t) => t.orderPlaced && t.type !== "exit" && istDate(new Date(t.timestamp)) === today,
  ).length;
}

// ─── Tax CSV Logging ──────────────────────────────────────────────────────────

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

// One row per executed order (entry or exit). Blocked checks stay in the JSON log.
function writeTradeCsv({ side, quantity, price, orderId, notes }) {
  const now = new Date();
  const total = quantity * price;
  const fee = estimateCharges(side, total);
  const net = side === "buy" ? total + fee : total - fee;
  const row = [
    now.toISOString().slice(0, 10), now.toISOString().slice(11, 19), "Zerodha", CONFIG.tradingsymbol,
    side.toUpperCase(), quantity, price.toFixed(2), total.toFixed(2), fee.toFixed(2), net.toFixed(2),
    orderId, CONFIG.paperTrading ? "PAPER" : "LIVE", `"${notes.replace(/"/g, "'")}"`,
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
  const blocked = loadLog().trades.filter((t) => t.type === "check" || (!t.type && !t.allPass)).length;

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Live orders executed   : ${live.length}`);
  console.log(`  Paper orders           : ${paper.length}`);
  console.log(`  Runs with no entry     : ${blocked}`);
  console.log(`  Total volume           : ₹${totalVolume.toFixed(2)}`);
  console.log(`  Total charges (est.)   : ₹${totalFees.toFixed(2)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Entry decision ───────────────────────────────────────────────────────────

// Every reason not to open a position now. Empty list = go.
export function entryBlockers({ combined, fresh, tradesToday, minutes, config = CONFIG }) {
  const reasons = [];
  if (!fresh) reasons.push("Market data is stale (holiday, halt or delayed feed)");
  if (tradesToday >= config.maxTradesPerDay) {
    reasons.push(`Max trades per day reached: ${tradesToday}/${config.maxTradesPerDay}`);
  }
  if (minutes >= config.lastEntryMinutes) reasons.push("No new positions after 15:00 IST");
  if (combined.signal === "HOLD") reasons.push(`No signal (mode ${combined.mode}, active: ${combined.activeStrategies.join(", ")})`);
  if (combined.signal === "SELL" && !config.allowShort) reasons.push("SELL signal but short selling is off (ALLOW_SHORT=false)");
  if (combined.signal !== "HOLD" && config.minConfidence === "STRONG" && combined.confidence !== "STRONG") {
    reasons.push(`Confidence ${combined.confidence} (${Math.round(combined.score * 100)}%) below MIN_CONFIDENCE=STRONG`);
  }
  return reasons;
}

// ─── Position management ──────────────────────────────────────────────────────

function savePosition(position) {
  writeJson(POSITION_FILE, position);
}

function clearPosition() {
  if (existsSync(POSITION_FILE)) unlinkSync(POSITION_FILE);
}

function recordExit(position, { exitPrice, reason, orderId }) {
  const side = oppositeSide(position.side);
  const profit = pnl(position, exitPrice);
  console.log(`✅ CLOSED ${position.quantity} ${CONFIG.tradingsymbol} @ ₹${exitPrice.toFixed(2)} — ${reason} — P&L ₹${profit.toFixed(2)}`);
  writeTradeCsv({ side, quantity: position.quantity, price: exitPrice, orderId, notes: `Exit: ${reason}; P&L ${profit.toFixed(2)}` });
  appendLog({
    type: "exit", timestamp: new Date().toISOString(), symbol: CONFIG.tradingsymbol, side,
    quantity: position.quantity, entryPrice: position.entryPrice, exitPrice, reason, pnl: profit,
    orderId, paperTrading: position.paper,
  });
  clearPosition();
}

async function closePosition(accessToken, position, reason, price) {
  console.log(`\n🔻 EXIT — ${reason}`);

  if (position.paper) {
    const exitPrice = reason === "stop-loss hit" ? position.stopPrice
      : reason === "target hit" ? position.targetPrice : price;
    recordExit(position, { exitPrice, reason, orderId: `PAPER-${Date.now()}` });
    return;
  }

  // Cancel the protective stop first so it cannot fire on top of the exit order.
  if (position.stopOrderId) {
    await cancelOrder(accessToken, position.stopOrderId).catch((err) =>
      console.log(`  ⚠️  Could not cancel stop ${position.stopOrderId}: ${err.message}`));
    const stop = await getOrder(accessToken, position.stopOrderId);
    if (stop.status === "COMPLETE") {
      recordExit(position, { exitPrice: stop.averagePrice, reason: "stop-loss hit", orderId: position.stopOrderId });
      return;
    }
    if (stop.status !== "CANCELLED" && stop.status !== "REJECTED") {
      // Still live: sending an exit now could double-sell (or double-buy) if the stop also fires.
      console.log(`  ⚠️  Stop order is still ${stop.status}; not sending the exit. Will retry next run.`);
      return;
    }
  }

  const side = oppositeSide(position.side);
  const exit = await placeZerodhaOrder(accessToken, {
    tradingsymbol: CONFIG.tradingsymbol, exchange: CONFIG.exchange, side, price,
    quantity: position.quantity, tickSize: position.tickSize, slippagePct: CONFIG.exitSlippagePct,
  });
  const fill = await waitForFill(accessToken, exit.orderId);

  if (fill.filledQuantity >= position.quantity) {
    recordExit(position, { exitPrice: fill.averagePrice, reason, orderId: exit.orderId });
    return;
  }

  // Partly or not filled: keep what is left protected and retry on the next run.
  const remaining = position.quantity - fill.filledQuantity;
  console.log(`  ⚠️  Exit filled ${fill.filledQuantity}/${position.quantity}. Re-placing the stop for ${remaining}; will retry next run.`);
  const stop = await placeStopOrder(accessToken, {
    tradingsymbol: CONFIG.tradingsymbol, exchange: CONFIG.exchange, side, quantity: remaining,
    triggerPrice: position.stopPrice, tickSize: position.tickSize,
  });
  savePosition({ ...position, quantity: remaining, stopOrderId: stop.orderId });
}

async function manageOpenPosition(accessToken, position, market) {
  console.log("\n── Open position ────────────────────────────────────────\n");
  console.log(`  ${position.side.toUpperCase()} ${position.quantity} @ ₹${position.entryPrice.toFixed(2)} | stop ₹${position.stopPrice.toFixed(2)} | target ₹${position.targetPrice.toFixed(2)} | ${position.group}`);

  if (position.date !== istDate()) {
    // An MIS position never survives the day: Zerodha squares it off.
    console.log("  ⚠️  Position is from a previous session — Zerodha squared it off. Check your contract note.");
    appendLog({ type: "exit", timestamp: new Date().toISOString(), symbol: CONFIG.tradingsymbol, reason: "stale position from a previous day cleared", paperTrading: position.paper });
    clearPosition();
    return;
  }

  if (!position.paper) {
    const stop = await getOrder(accessToken, position.stopOrderId);
    if (stop.status === "COMPLETE") {
      recordExit(position, { exitPrice: stop.averagePrice, reason: "stop-loss hit", orderId: position.stopOrderId });
      return;
    }
    if (stop.status === "CANCELLED" || stop.status === "REJECTED") {
      await closePosition(accessToken, { ...position, stopOrderId: null }, `stop order ${stop.status.toLowerCase()} — closing unprotected position`, market.price);
      return;
    }
  }

  const decision = exitDecision(position, market, { squareOffMinutes: CONFIG.squareOffMinutes });
  if (!decision.exit) {
    console.log(`  Holding — ${decision.reason}`);
    return;
  }
  await closePosition(accessToken, position, decision.reason, market.price);
}

async function openPosition(accessToken, { side, price, lotSize, tickSize, combined }) {
  const tradeSize = calcTradeSize({
    portfolioValue: CONFIG.portfolioValue, riskPct: CONFIG.riskPerTradePct,
    stopPct: CONFIG.stopLossPct, maxTradeSize: CONFIG.maxTradeSizeINR,
  });
  const quantity = calcQuantity({
    tradingsymbol: CONFIG.tradingsymbol, exchange: CONFIG.exchange, sizeINR: tradeSize, price, lotSize,
  });
  const group = strategyGroup(combined.activeStrategies);

  let entryPrice = price, filled = quantity, entryOrderId = `PAPER-${Date.now()}`, stopOrderId = null;

  if (CONFIG.paperTrading) {
    console.log(`\n📋 PAPER TRADE — ${side.toUpperCase()} ${quantity} ${CONFIG.tradingsymbol} @ ₹${price.toFixed(2)} (₹${(quantity * price).toFixed(2)})`);
    console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
  } else {
    console.log(`\n🔴 PLACING LIVE ORDER — ${side.toUpperCase()} ${quantity} ${CONFIG.tradingsymbol} LIMIT ~₹${price.toFixed(2)}`);
    const order = await placeZerodhaOrder(accessToken, {
      tradingsymbol: CONFIG.tradingsymbol, exchange: CONFIG.exchange, side, price, quantity,
      tickSize, slippagePct: CONFIG.entrySlippagePct,
    });
    entryOrderId = order.orderId;
    const fill = await waitForFill(accessToken, order.orderId);
    filled = fill.filledQuantity;
    if (filled === 0) {
      console.log(`  Entry not filled (${fill.status}) — cancelled. No position.`);
      return { orderPlaced: false, orderId: entryOrderId, quantity: 0 };
    }
    entryPrice = fill.averagePrice;
  }

  const position = {
    date: istDate(), entryTime: Date.now(), side, quantity: filled, entryPrice,
    stopPrice: stopPrice(side, entryPrice, CONFIG.stopLossPct),
    targetPrice: targetPrice(side, entryPrice, CONFIG.targetPct),
    group, tickSize, entryOrderId, stopOrderId, paper: CONFIG.paperTrading,
  };

  writeTradeCsv({ side, quantity: filled, price: entryPrice, orderId: entryOrderId, notes: `Entry: ${combined.signal} ${combined.confidence} [${combined.activeStrategies.join(", ")}]` });

  if (!CONFIG.paperTrading) {
    try {
      const stop = await placeStopOrder(accessToken, {
        tradingsymbol: CONFIG.tradingsymbol, exchange: CONFIG.exchange, side: oppositeSide(side),
        quantity: filled, triggerPrice: position.stopPrice, tickSize,
      });
      position.stopOrderId = stop.orderId;
      console.log(`  🛡️  Stop placed: ${stop.orderId} trigger ₹${stop.triggerPrice}`);
    } catch (err) {
      console.log(`  ❌ Could not place stop (${err.message}) — closing the position now.`);
      await closePosition(accessToken, position, "stop order could not be placed", entryPrice);
      return { orderPlaced: true, orderId: entryOrderId, quantity: filled };
    }
  }

  savePosition(position);
  console.log(`  Position saved: stop ₹${position.stopPrice.toFixed(2)}, target ₹${position.targetPrice.toFixed(2)}`);
  return { orderPlaced: true, orderId: entryOrderId, quantity: filled };
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

  if (!isMarketOpen()) {
    console.log("\n🕒 Market is closed. NSE hours: 09:15–15:30 IST, Mon–Fri.");
    console.log("   No trade attempted.\n");
    return;
  }

  // Live trading needs Kite; paper trading can run on Yahoo data without a login.
  const accessToken = loadToken();
  if (!accessToken && !CONFIG.paperTrading) {
    printLoginInstructions();
    process.exit(0);
  }

  console.log(`\nSymbol: ${CONFIG.tradingsymbol} (${CONFIG.exchange}) | Timeframe: ${CONFIG.timeframe}`);
  console.log("\n── Fetching market data ────────────────────────────────\n");
  const { candles: raw, lotSize, tickSize, source } = await fetchCandles(
    accessToken, CONFIG.tradingsymbol, CONFIG.exchange, CONFIG.instrumentType, CONFIG.timeframe,
  );
  if (raw.length === 0) throw new Error(`No candles returned for ${CONFIG.tradingsymbol}`);

  // Latest traded price comes from the forming candle; signals only from closed ones.
  const price = raw[raw.length - 1].close;
  const candles = dropFormingCandle(raw, CONFIG.timeframe);
  const freshness = checkFreshness(raw, CONFIG.timeframe);
  console.log(`  Data source: ${source} | last candle ${freshness.lastCandleIST} (${freshness.ageMinutes}m ago)${freshness.stale ? " ⚠️ STALE" : ""}`);
  console.log(`  Current price: ₹${price.toFixed(2)}`);

  const { results, combined } = analyzeCandles(candles);
  const rsi3 = results[0].indicators.rsi3;
  console.log(`  Mode: ${combined.mode} | Active: ${combined.activeStrategies.join(", ")} | Signal: ${combined.signal} (${combined.confidence} ${Math.round(combined.score * 100)}%)`);

  const minutes = istMinutes();
  const position = readJson(POSITION_FILE);
  if (position) {
    const sinceEntry = raw.filter((c) => c.time + (TIMEFRAME_MS[CONFIG.timeframe] || 0) > position.entryTime);
    await manageOpenPosition(accessToken, position, {
      price,
      low: Math.min(price, ...sinceEntry.map((c) => c.low)),
      high: Math.max(price, ...sinceEntry.map((c) => c.high)),
      rsi3,
      signal: combined.signal,
      istMinutes: minutes,
      fresh: !freshness.stale,
    });
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  const log = loadLog();
  const tradesToday = countTodaysTrades(log);
  const blockers = entryBlockers({ combined, fresh: !freshness.stale, tradesToday, minutes });

  console.log("\n── Decision ─────────────────────────────────────────────\n");
  const logEntry = {
    type: "check",
    timestamp: new Date().toISOString(),
    symbol: CONFIG.tradingsymbol,
    exchange: CONFIG.exchange,
    timeframe: CONFIG.timeframe,
    price,
    combined,
    strategies: results.map((r) => ({ signal: r.signal, rules: r.rules })),
    allPass: blockers.length === 0,
    blockers,
    orderPlaced: false,
    paperTrading: CONFIG.paperTrading,
    dataSource: source,
    limits: { maxTradeSizeINR: CONFIG.maxTradeSizeINR, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday },
  };

  if (blockers.length > 0) {
    console.log("🚫 NO ENTRY");
    blockers.forEach((b) => console.log(`   - ${b}`));
  } else {
    console.log(`✅ ${combined.signal} — ${combined.confidence} (${Math.round(combined.score * 100)}%)`);
    try {
      const result = await openPosition(accessToken, {
        side: combined.signal.toLowerCase(), price, lotSize, tickSize, combined,
      });
      Object.assign(logEntry, { type: "entry", side: combined.signal.toLowerCase() }, result);
    } catch (err) {
      console.log(`❌ ENTRY FAILED — ${err.message}`);
      logEntry.error = err.message;
    }
  }

  appendLog(logEntry);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain && process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (isMain) {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
