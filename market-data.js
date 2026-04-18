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
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
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
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
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
  const fmt = (d) => {
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
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
    .filter((c) => c.close != null && c.open != null && c.high != null && c.low != null);
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
