import "dotenv/config";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { vwapEmaRsiStrategy, macdStrategy, bollingerRsiStrategy, orbStrategy, detectMarketMode } from "./strategies.js";

const SYMBOL = process.env.TRADINGSYMBOL || "RELIANCE";
const EXCHANGE = process.env.EXCHANGE || "BSE";
const SUFFIX = EXCHANGE === "BSE" ? ".BO" : ".NS";
const TICKER = `${SYMBOL}${SUFFIX}`;

async function fetchCandles() {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${TICKER}?interval=5m&range=10d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`No data returned for ${TICKER}`);
  const timestamps = result.timestamp;
  const q = result.indicators?.quote?.[0];
  if (!timestamps || !q) throw new Error(`No OHLCV data returned for ${TICKER}`);
  return timestamps
    .map((t, i) => ({
      time: t * 1000,
      open: q.open[i], high: q.high[i], low: q.low[i],
      close: q.close[i], volume: q.volume[i],
    }))
    .filter((c) => c.close != null && c.open != null);
}

function signalIcon(signal) {
  if (signal === "BUY")  return "🟢";
  if (signal === "SELL") return "🔴";
  return "🟡";
}

export function isInOrbWindow(candles) {
  const t = new Date(candles[candles.length - 1].time);
  const utcMinutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return utcMinutes >= 240 && utcMinutes <= 360;
}

function calcConfidence(signal, activeStrategies, activeResults) {
  if (signal === "HOLD") return { confidence: "WEAK", score: 0 };
  const scores = activeResults.map(r => {
    if (!r.rules || r.rules.length === 0) return 0;
    return r.rules.filter(x => x.pass).length / r.rules.length;
  });
  const score = scores.reduce((a, b) => a + b, 0) / scores.length;
  const onlyMACD = activeStrategies.length === 1 && activeStrategies[0] === "MACD";
  const threshold = onlyMACD ? 0.85 : 0.75;
  return { confidence: score >= threshold ? "STRONG" : "WEAK", score };
}

export function modeCombinedSignal(mode, inOrbWindow, results) {
  const [s1, s2, s3, s4] = results;
  let signal, activeStrategies, activeResults, count, total;

  if (mode === "bullish" || mode === "bearish") {
    if (inOrbWindow) {
      activeStrategies = ["ORB", "MACD"];
      activeResults = [s4, s2];
      total = 2;
      if (s4.signal !== "HOLD" && s4.signal === s2.signal) {
        signal = s4.signal; count = 2;
      } else if (s2.signal !== "HOLD") {
        signal = s2.signal; count = 1;
      } else {
        signal = "HOLD"; count = 0;
      }
    } else {
      activeStrategies = ["MACD"];
      activeResults = [s2];
      total = 1;
      signal = s2.signal !== "HOLD" ? s2.signal : "HOLD";
      count = s2.signal !== "HOLD" ? 1 : 0;
    }
  } else {
    // Sideways mode: only mean-reversion strategies are active regardless of ORB window.
    // ORB (s4) and MACD (s2) are intentionally excluded — they add noise in flat markets.
    activeStrategies = ["VWAP+EMA+RSI", "BB+RSI"];
    activeResults = [s1, s3];
    total = 2;
    if (s1.signal !== "HOLD") {
      signal = s1.signal; count = 1;
    } else if (s3.signal !== "HOLD") {
      signal = s3.signal; count = 1;
    } else {
      signal = "HOLD"; count = 0;
    }
  }

  const { confidence, score } = calcConfidence(signal, activeStrategies, activeResults);
  return { signal, mode, activeStrategies, count, total, confidence, score };
}


function printTerminal(candles, results, combined, modeResult, now) {
  const price  = candles[candles.length - 1].close;
  const [s1, s2, s3, s4] = results;
  const fmt = (v, prefix = "₹") => v != null ? `${prefix}${Number(v).toFixed(2)}` : "N/A";
  const modeLabel = modeResult.mode === "bullish" ? "BULLISH TREND"
    : modeResult.mode === "bearish" ? "BEARISH TREND" : "SIDEWAYS";

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  ${SYMBOL} (${EXCHANGE}) — Strategy Analysis`);
  console.log(`  ${now}`);
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  Current Price : ${fmt(price)}`);
  console.log(`  Market Mode   : ${modeLabel}`);
  console.log(`  VWAP Slope    : ${modeResult.vwapSlope != null ? modeResult.vwapSlope.toFixed(4) : "N/A"}`);
  console.log(`  EMA(8)        : ${fmt(s1.indicators.ema8)}`);
  console.log(`  VWAP          : ${fmt(s1.indicators.vwap)}`);
  console.log(`  RSI(3)        : ${s1.indicators.rsi3 != null ? s1.indicators.rsi3.toFixed(2) : "N/A"}`);
  console.log(`  RSI(14)       : ${s3.indicators.rsi14 != null ? s3.indicators.rsi14.toFixed(2) : "N/A"}`);
  console.log(`  MACD          : ${s2.indicators.macd != null ? s2.indicators.macd.toFixed(4) : "N/A"} | Signal: ${s2.indicators.signal != null ? s2.indicators.signal.toFixed(4) : "N/A"}`);
  console.log(`  BB Upper      : ${fmt(s3.indicators.upper)} | Lower: ${fmt(s3.indicators.lower)}`);
  console.log(`  ORB High      : ${fmt(s4.indicators.orbHigh)}`);
  console.log(`  ORB Low       : ${fmt(s4.indicators.orbLow)}`);
  console.log(`  ORB RSI(14)   : ${s4.indicators.rsi14 != null ? s4.indicators.rsi14.toFixed(2) : "N/A"}`);
  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  Strategy                       Signal     Rules");
  console.log("─────────────────────────────────────────────────────────────");

  const rows = [
    ["VWAP + EMA(8) + RSI(3)", s1],
    ["MACD Crossover",         s2],
    ["Bollinger Bands + RSI",  s3],
    ["ORB 15min + RSI(14)",    s4],
  ];
  for (const [name, r] of rows) {
    const met = r.rules.filter((x) => x.pass).length;
    console.log(`  ${name.padEnd(30)} ${signalIcon(r.signal)} ${r.signal.padEnd(6)}  ${met}/${r.rules.length} rules met`);
  }

  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  Active Strategies              [${combined.activeStrategies.join(", ")}]`);
  console.log(`  Combined Signal                ${signalIcon(combined.signal)} ${combined.signal.padEnd(6)}  ${combined.count}/${combined.total} agree`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

function buildHtml(candles, results, combined, modeResult, now) {
  const price = candles[candles.length - 1].close;
  const [s1, s2, s3, s4] = results;
  const fmt = (v, p = "₹") => v != null ? `${p}${Number(v).toFixed(2)}` : "N/A";
  const colorMap = { BUY: "#16a34a", SELL: "#dc2626", HOLD: "#ca8a04" };
  const bgMap    = { BUY: "#f0fdf4", SELL: "#fef2f2", HOLD: "#fefce8" };
  const modeLabel = modeResult.mode === "bullish" ? "BULLISH TREND"
    : modeResult.mode === "bearish" ? "BEARISH TREND" : "SIDEWAYS";
  const modeColor = modeResult.mode === "bullish" ? "#16a34a"
    : modeResult.mode === "bearish" ? "#dc2626" : "#ca8a04";

  const strategyRows = [
    ["VWAP + EMA(8) + RSI(3)", s1],
    ["MACD Crossover",         s2],
    ["Bollinger Bands + RSI",  s3],
    ["ORB 15min + RSI(14)",    s4],
  ].map(([name, r]) => {
    const met = r.rules.filter((x) => x.pass).length;
    const rulesHtml = r.rules.map((rule) =>
      `<span style="color:${rule.pass ? "#16a34a" : "#9ca3af"}">${rule.pass ? "✅" : "⬜"} ${rule.label}</span>`
    ).join("<br>");
    return `
      <tr style="background:${bgMap[r.signal]}">
        <td style="padding:12px 16px;font-weight:600">${name}</td>
        <td style="padding:12px 16px;color:${colorMap[r.signal]};font-weight:700;font-size:1.1em">${signalIcon(r.signal)} ${r.signal}</td>
        <td style="padding:12px 16px;font-size:0.85em;line-height:1.8">${rulesHtml}</td>
        <td style="padding:12px 16px;color:#6b7280">${met}/${r.rules.length}</td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${SYMBOL} Strategy Analysis</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f8fafc; margin:0; padding:24px; color:#1e293b; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.1); padding:24px; margin-bottom:20px; }
  h1 { margin:0 0 4px; font-size:1.6em; } .subtitle { color:#64748b; margin:0 0 20px; }
  .price { font-size:2.5em; font-weight:700; } .indicators { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:12px; }
  .ind-box { background:#f1f5f9; border-radius:8px; padding:12px; } .ind-label { font-size:0.75em; color:#64748b; text-transform:uppercase; letter-spacing:.05em; }
  .ind-value { font-size:1.1em; font-weight:600; margin-top:4px; }
  table { width:100%; border-collapse:collapse; } th { background:#f1f5f9; padding:12px 16px; text-align:left; font-size:0.8em; text-transform:uppercase; letter-spacing:.05em; color:#64748b; }
  .combined { text-align:center; padding:20px; border-radius:12px; }
  .combined-signal { font-size:2em; font-weight:800; }
</style>
</head>
<body>
<div class="card">
  <h1>${SYMBOL} <span style="color:#64748b;font-weight:400">(${EXCHANGE})</span></h1>
  <p class="subtitle">Strategy Analysis · ${now}</p>
  <div class="price">${fmt(price)}</div>
</div>
<div class="card">
  <h2 style="margin:0 0 16px">Indicators</h2>
  <div class="indicators">
    <div class="ind-box"><div class="ind-label">EMA(8)</div><div class="ind-value">${fmt(s1.indicators.ema8)}</div></div>
    <div class="ind-box"><div class="ind-label">VWAP</div><div class="ind-value">${fmt(s1.indicators.vwap)}</div></div>
    <div class="ind-box"><div class="ind-label">RSI(3)</div><div class="ind-value">${s1.indicators.rsi3 != null ? s1.indicators.rsi3.toFixed(2) : "N/A"}</div></div>
    <div class="ind-box"><div class="ind-label">RSI(14)</div><div class="ind-value">${s3.indicators.rsi14 != null ? s3.indicators.rsi14.toFixed(2) : "N/A"}</div></div>
    <div class="ind-box"><div class="ind-label">MACD</div><div class="ind-value">${s2.indicators.macd != null ? s2.indicators.macd.toFixed(4) : "N/A"}</div></div>
    <div class="ind-box"><div class="ind-label">BB Upper</div><div class="ind-value">${fmt(s3.indicators.upper)}</div></div>
    <div class="ind-box"><div class="ind-label">BB Lower</div><div class="ind-value">${fmt(s3.indicators.lower)}</div></div>
    <div class="ind-box"><div class="ind-label">MACD Signal</div><div class="ind-value">${s2.indicators.signal != null ? s2.indicators.signal.toFixed(4) : "N/A"}</div></div>
    <div class="ind-box"><div class="ind-label">ORB High</div><div class="ind-value">${fmt(s4.indicators.orbHigh)}</div></div>
    <div class="ind-box"><div class="ind-label">ORB Low</div><div class="ind-value">${fmt(s4.indicators.orbLow)}</div></div>
    <div class="ind-box"><div class="ind-label">ORB RSI(14)</div><div class="ind-value">${s4.indicators.rsi14 != null ? s4.indicators.rsi14.toFixed(2) : "N/A"}</div></div>
    <div class="ind-box"><div class="ind-label">Market Mode</div><div class="ind-value" style="color:${modeColor}">${modeLabel}</div></div>
    <div class="ind-box"><div class="ind-label">VWAP Slope</div><div class="ind-value">${modeResult.vwapSlope != null ? modeResult.vwapSlope.toFixed(4) : "N/A"}</div></div>
  </div>
</div>
<div class="card">
  <h2 style="margin:0 0 16px">Strategy Signals</h2>
  <table>
    <thead><tr><th>Strategy</th><th>Signal</th><th>Rules</th><th>Score</th></tr></thead>
    <tbody>${strategyRows}</tbody>
  </table>
</div>
<div class="card combined" style="background:${bgMap[combined.signal]};border:2px solid ${colorMap[combined.signal]}">
  <div style="color:#64748b;font-size:0.9em;margin-bottom:8px">COMBINED SIGNAL · <span style="color:${modeColor}">${modeLabel}</span></div>
  <div class="combined-signal" style="color:${colorMap[combined.signal]}">${signalIcon(combined.signal)} ${combined.signal}</div>
  <div style="color:#64748b;margin-top:8px">${combined.count}/${combined.total} agree · Active: ${combined.activeStrategies.join(", ")}</div>
</div>
</body>
</html>`;
}

async function run() {
  console.log(`\nFetching ${SYMBOL} (${EXCHANGE}) data from Yahoo Finance...`);
  const candles = await fetchCandles();
  console.log(`  ${candles.length} candles loaded (5m, 10d)`);

  const s1 = vwapEmaRsiStrategy(candles);
  const s2 = macdStrategy(candles);
  const s3 = bollingerRsiStrategy(candles);
  const s4 = orbStrategy(candles);
  const results = [s1, s2, s3, s4];
  const modeResult = detectMarketMode(candles);
  const inOrbWindow = isInOrbWindow(candles);
  const combined = modeCombinedSignal(modeResult.mode, inOrbWindow, results);
  const now = new Date().toISOString();

  printTerminal(candles, results, combined, modeResult, now);

  const html = buildHtml(candles, results, combined, modeResult, now);
  writeFileSync("report.html", html);
  console.log("  HTML report saved → report.html\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
