import "dotenv/config";
import { fileURLToPath } from "url";
import { writeFileSync } from "fs";
import { vwapEmaRsiStrategy, macdStrategy, bollingerRsiStrategy, orbStrategy, detectMarketMode } from "./strategies.js";

const SYMBOL = process.env.TRADINGSYMBOL || "RELIANCE";
const EXCHANGE = process.env.EXCHANGE || "NSE";
const SUFFIX = EXCHANGE === "BSE" ? ".BO" : ".NS";
const TICKER = `${SYMBOL}${SUFFIX}`;
const KITE_BASE = "https://api.kite.trade";

async function fetchYahooCandles() {
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  let lastErr;
  for (const host of hosts) {
    const url = `https://${host}/v8/finance/chart/${TICKER}?interval=5m&range=10d&includePrePost=false`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/json",
          "Cache-Control": "no-cache",
        },
      });
      if (!res.ok) throw new Error(`Yahoo Finance ${host} error: ${res.status}`);
      const json = await res.json();
      const result = json.chart?.result?.[0];
      if (!result) throw new Error(`No data returned for ${TICKER} from ${host}`);
      const timestamps = result.timestamp;
      const q = result.indicators?.quote?.[0];
      if (!timestamps || !q) throw new Error(`No OHLCV data from ${host}`);
      return timestamps
        .map((t, i) => ({
          time: t * 1000,
          open: q.open[i], high: q.high[i], low: q.low[i],
          close: q.close[i], volume: q.volume[i],
        }))
        .filter((c) => c.close != null && c.open != null);
    } catch (err) {
      lastErr = err;
      console.log(`  ⚠️  ${host} failed, trying next...`);
    }
  }
  throw lastErr;
}

function checkDataFreshness(candles) {
  const lastCandleMs = candles[candles.length - 1].time;
  const ageMinutes = (Date.now() - lastCandleMs) / 60000;
  const lastCandleIST = new Date(lastCandleMs + 5.5 * 60 * 60 * 1000).toISOString().slice(11, 16) + " IST";
  const stale = ageMinutes > 20;
  return { ageMinutes: Math.round(ageMinutes), lastCandleIST, stale };
}

async function fetchInstrumentToken() {
  const res = await fetch(`${KITE_BASE}/instruments/${EXCHANGE}`);
  if (!res.ok) throw new Error(`Kite instruments fetch failed: ${res.status}`);
  const csv = await res.text();
  for (const line of csv.split("\n").slice(1)) {
    const cols = line.split(",");
    // cols: instrument_token, exchange_token, tradingsymbol, name, ..., exchange (last)
    if (cols[2] === SYMBOL && cols[cols.length - 1].trim() === EXCHANGE) {
      return cols[0];
    }
  }
  throw new Error(`Instrument token not found for ${SYMBOL} on ${EXCHANGE}`);
}

async function fetchKiteCandles(accessToken) {
  const token = await fetchInstrumentToken();

  const now = new Date();
  const from = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  // Kite expects dates in IST (UTC+5:30)
  const toIST = (d) => {
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().replace("T", " ").slice(0, 19);
  };

  const url =
    `${KITE_BASE}/instruments/historical/${token}/5minute` +
    `?from=${encodeURIComponent(toIST(from))}&to=${encodeURIComponent(toIST(now))}`;

  const res = await fetch(url, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${process.env.KITE_API_KEY}:${accessToken}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kite historical data failed ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.status !== "success") throw new Error(`Kite error: ${json.message}`);

  return json.data.candles
    .map(([time, open, high, low, close, volume]) => ({
      time: new Date(time).getTime(),
      open, high, low, close, volume,
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

function calcOrbDecay(nowMs) {
  // ORB window closes at 11:30 AM IST = 06:00 UTC.
  // Influence fades linearly to zero over the following 2 hours.
  const d = new Date(nowMs);
  const istMidnight = new Date(d);
  istMidnight.setUTCHours(18, 30, 0, 0);
  if (istMidnight > d) istMidnight.setUTCDate(istMidnight.getUTCDate() - 1);
  const orbClose = new Date(istMidnight.getTime() + 11.5 * 60 * 60 * 1000); // 11:30 AM IST
  const minutesSince = (nowMs - orbClose.getTime()) / 60000;
  return Math.max(0, Math.min(1, 1 - minutesSince / 120));
}

function calcConfidence(signal, activeStrategies, activeResults, orbResult, orbDecay = 1) {
  if (signal === "HOLD") return { confidence: "WEAK", score: 0 };
  const scores = activeResults
    .filter(r => r.rules && r.rules.length > 0)
    .map(r => r.rules.filter(x => x.pass).length / r.rules.length);
  if (scores.length === 0) return { confidence: "WEAK", score: 0 };
  let raw = scores.reduce((a, b) => a + b, 0) / scores.length;

  // ORB partial bias: when ORB is not already an active strategy, a partial ORB
  // breakout in the same direction as the signal slightly boosts confidence.
  // Decays to zero 2 hours after the ORB window closes (stale morning context).
  if (orbDecay > 0 && !activeStrategies.includes("ORB") && orbResult?.rules?.length > 0) {
    const orbBuyBreakout  = orbResult.rules.some(r => r.label === "Close > ORB High" && r.pass);
    const orbSellBreakout = orbResult.rules.some(r => r.label === "Close < ORB Low"  && r.pass);
    const aligned = (signal === "BUY" && orbBuyBreakout) || (signal === "SELL" && orbSellBreakout);
    if (aligned) {
      const orbBias = orbResult.rules.filter(x => x.pass).length / orbResult.rules.length;
      raw = Math.min(1, raw * (1 + orbBias * 0.2 * orbDecay));
    }
  }

  const score = Math.round(raw * 100) / 100;
  return { confidence: score >= 0.75 ? "STRONG" : "WEAK", score };
}

export function modeCombinedSignal(mode, inOrbWindow, results, nowMs = Date.now()) {
  const [s1, s2, s3, s4] = results;
  let signal, activeStrategies, activeResults, count, total;

  if (mode === "bullish" || mode === "bearish") {
    // Trend-alignment: reject MACD signals that contradict the detected mode
    const macdCounterTrend = (mode === "bullish" && s2.signal === "SELL") ||
                              (mode === "bearish" && s2.signal === "BUY");

    if (inOrbWindow) {
      activeStrategies = ["ORB", "MACD"];
      activeResults = [s4, s2];
      total = 2;
      if (macdCounterTrend) {
        signal = "HOLD"; count = 0;
      } else if (s4.signal !== "HOLD" && s4.signal === s2.signal) {
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
      const macdAligned = !macdCounterTrend && s2.signal !== "HOLD";
      signal = macdAligned ? s2.signal : "HOLD";
      count = macdAligned ? 1 : 0;
    }

    // VWAP context guard: price must be on the correct side of VWAP for structure
    const vwap  = s1.indicators?.vwap;
    const price = s2.indicators?.price;
    if (vwap != null && price != null) {
      const noStructure = (mode === "bullish" && signal === "BUY"  && price < vwap) ||
                          (mode === "bearish" && signal === "SELL" && price > vwap);
      if (noStructure) { signal = "HOLD"; count = 0; }
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

  const orbDecay = calcOrbDecay(nowMs);
  const { confidence, score } = calcConfidence(signal, activeStrategies, activeResults, s4, orbDecay);
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
  console.log(`  Confidence                     ${combined.confidence} (${(combined.score * 100).toFixed(0)}%)`);
  console.log(`  Mode                           ${modeLabel}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

function buildHtml(candles, results, combined, modeResult, now, freshnessInfo = null) {
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
  ${freshnessInfo ? `<div style="margin-top:12px;padding:8px 12px;border-radius:8px;font-size:0.85em;background:${freshnessInfo.stale ? "#fef3c7" : "#f0fdf4"};color:${freshnessInfo.stale ? "#92400e" : "#166534"};border:1px solid ${freshnessInfo.stale ? "#fcd34d" : "#86efac"}">
    ${freshnessInfo.stale ? "⚠️" : "✅"} Last candle: ${freshnessInfo.lastCandleIST} · ${freshnessInfo.ageMinutes}m ago${freshnessInfo.stale ? " — Yahoo Finance cache delay; set KITE_ACCESS_TOKEN for real-time data" : ""}
  </div>` : ""}
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
  <div style="margin-top:12px"><span style="background:${combined.confidence === 'STRONG' ? '#16a34a' : '#ca8a04'};color:#fff;padding:4px 12px;border-radius:9999px;font-size:0.85em;font-weight:700">${combined.confidence} · ${(combined.score * 100).toFixed(0)}%</span></div>
</div>
</body>
</html>`;
}

async function run() {
  const kiteToken = process.env.KITE_ACCESS_TOKEN;
  let candles;
  let freshnessInfo = null;
  if (kiteToken) {
    console.log(`\nFetching ${SYMBOL} (${EXCHANGE}) data from Kite Connect...`);
    candles = await fetchKiteCandles(kiteToken);
    console.log(`  ${candles.length} candles loaded (5m, 10d) [Kite Connect]`);
  } else {
    console.log(`\nFetching ${SYMBOL} (${EXCHANGE}) data from Yahoo Finance...`);
    candles = await fetchYahooCandles();
    freshnessInfo = checkDataFreshness(candles);
    console.log(`  ${candles.length} candles loaded (5m, 10d) [Yahoo Finance]`);
    console.log(`  Last candle: ${freshnessInfo.lastCandleIST} (${freshnessInfo.ageMinutes}m ago)${freshnessInfo.stale ? "  ⚠️  STALE DATA — Yahoo cache, consider Kite token for real-time" : ""}`);
  }

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

  const html = buildHtml(candles, results, combined, modeResult, now, freshnessInfo);
  writeFileSync("report.html", html);
  console.log("  HTML report saved → report.html\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
