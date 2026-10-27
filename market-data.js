import "dotenv/config";

const KITE_BASE = "https://api.kite.trade";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

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

export const TIMEFRAME_MS = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "1H": 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
};

// Minutes since IST midnight, e.g. 9:15 AM IST → 555
export function istMinutes(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// IST calendar date as YYYY-MM-DD
export function istDate(now = new Date()) {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function isMarketOpen(now = new Date()) {
  // NSE hours: 09:15–15:30 IST (UTC+5:30), Mon–Fri
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = istMinutes(now);
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

// The last candle from Kite/Yahoo is usually still forming. Signals computed on
// it can appear and vanish before the bar closes, so strategies only see closed bars.
export function dropFormingCandle(candles, timeframe, nowMs = Date.now()) {
  const len = TIMEFRAME_MS[timeframe];
  if (!len || candles.length === 0) return candles;
  const last = candles[candles.length - 1];
  return last.time + len > nowMs ? candles.slice(0, -1) : candles;
}

// How old the most recent candle is. Stale data means a holiday, a halted
// stock or a delayed feed — never trade on it.
export function checkFreshness(candles, timeframe, nowMs = Date.now()) {
  if (candles.length === 0) return { ageMinutes: null, lastCandleIST: null, stale: true };
  const last = candles[candles.length - 1].time;
  const ageMinutes = Math.round((nowMs - last) / 60000);
  const lastCandleIST = new Date(last + IST_OFFSET_MS).toISOString().slice(11, 16) + " IST";
  const maxAgeMs = 3 * (TIMEFRAME_MS[timeframe] || TIMEFRAME_MS["5m"]);
  return { ageMinutes, lastCandleIST, stale: nowMs - last > maxAgeMs };
}

// Minimal RFC 4180 line split: handles quoted fields containing commas.
export function parseCsvLine(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function findInstrument(csv, tradingsymbol) {
  const lines = csv.trim().split("\n");
  const headers = parseCsvLine(lines[0]);
  const tokenIdx = headers.indexOf("instrument_token");
  const symbolIdx = headers.indexOf("tradingsymbol");
  const lotIdx = headers.indexOf("lot_size");
  const tickIdx = headers.indexOf("tick_size");

  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    if (cols[symbolIdx] === tradingsymbol) {
      return {
        instrumentToken: parseInt(cols[tokenIdx]),
        lotSize: parseInt(cols[lotIdx]) || 1,
        tickSize: parseFloat(cols[tickIdx]) || 0.05,
      };
    }
  }
  return null;
}

async function resolveInstrument(accessToken, tradingsymbol, exchange) {
  const res = await fetch(`${KITE_BASE}/instruments/${exchange}`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${process.env.KITE_API_KEY}:${accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`Kite instruments fetch failed: ${res.status}`);

  const found = findInstrument(await res.text(), tradingsymbol);
  if (!found) throw new Error(`Instrument ${tradingsymbol} not found on ${exchange}`);
  return found;
}

async function fetchCandlesKite(accessToken, instrumentToken, timeframe) {
  const interval = KITE_INTERVAL[timeframe] || "5minute";
  const daysBack = KITE_DAYS_BACK[interval] || 10;

  const to = new Date();
  const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const fmt = (d) => {
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    return ist.toISOString().slice(0, 19).replace("T", " ");
  };

  const url = `${KITE_BASE}/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(to))}`;
  const res = await fetch(url, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${process.env.KITE_API_KEY}:${accessToken}`,
    },
  });

  if (!res.ok) throw new Error(`Kite historical data failed: HTTP ${res.status}`);
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

  let lastErr;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${ticker}?interval=${interval}&range=${range}&includePrePost=false`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
        },
      });
      if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`);

      const json = await res.json();
      const result = json.chart?.result?.[0];
      if (!result) throw new Error(`Yahoo Finance: no data for ${ticker}`);

      const timestamps = result.timestamp || [];
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
        .filter((c) => c.close != null && c.open != null && c.high != null && c.low != null);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function fetchCandles(accessToken, tradingsymbol, exchange, instrumentType, timeframe) {
  if (accessToken) {
    try {
      const { instrumentToken, lotSize, tickSize } = await resolveInstrument(accessToken, tradingsymbol, exchange);
      const candles = await fetchCandlesKite(accessToken, instrumentToken, timeframe);
      return { candles, lotSize, tickSize, source: "kite" };
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
  return { candles, lotSize: 1, tickSize: 0.05, source: "yahoo" };
}
