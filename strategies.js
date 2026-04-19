import { calcEMA, calcRSI, calcMACD, calcBollingerBands } from "./indicators.js";

function calcVWAP(candles) {
  if (candles.length === 0) return null;
  // Anchor to last candle's IST day so VWAP works after market hours / on weekends
  const ref = new Date(candles[candles.length - 1].time);
  const istMidnight = new Date(ref);
  istMidnight.setUTCHours(18, 30, 0, 0);
  if (istMidnight > ref) istMidnight.setUTCDate(istMidnight.getUTCDate() - 1);
  const session = candles.filter((c) => c.time >= istMidnight.getTime());
  if (session.length === 0) return null;
  const cumTPV = session.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const cumVol = session.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

export function vwapEmaRsiStrategy(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  const indicators = { price, ema8, vwap, rsi3 };

  if (!ema8 || !vwap || rsi3 === null) {
    return { signal: "HOLD", indicators, rules: [{ label: "Insufficient data", pass: false }] };
  }

  const bullish = price > vwap && price > ema8;
  const bearish = price < vwap && price < ema8;
  const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;

  if (bullish) {
    const rules = [
      { label: "Price > VWAP", pass: price > vwap },
      { label: "Price > EMA(8)", pass: price > ema8 },
      { label: "RSI(3) < 30", pass: rsi3 < 30 },
      { label: "Within 1.5% of VWAP", pass: distFromVWAP < 1.5 },
    ];
    const signal = rules.every((r) => r.pass) ? "BUY" : "HOLD";
    return { signal, indicators, rules };
  }

  if (bearish) {
    const rules = [
      { label: "Price < VWAP", pass: price < vwap },
      { label: "Price < EMA(8)", pass: price < ema8 },
      { label: "RSI(3) > 70", pass: rsi3 > 70 },
      { label: "Within 1.5% of VWAP", pass: distFromVWAP < 1.5 },
    ];
    const signal = rules.every((r) => r.pass) ? "SELL" : "HOLD";
    return { signal, indicators, rules };
  }

  return {
    signal: "HOLD",
    indicators,
    rules: [{ label: "No clear bias (neutral)", pass: false }],
  };
}

export function macdStrategy(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const macdResult = calcMACD(closes);

  if (!macdResult) {
    return {
      signal: "HOLD",
      indicators: { price, macd: null, signal: null, histogram: null },
      rules: [{ label: "Insufficient data for MACD (need 34+ candles)", pass: false }],
    };
  }

  const { macd, signal, histogram, prevMacd, prevSignal } = macdResult;
  const indicators = { price, macd, signal, histogram };

  const bullishCross = prevMacd !== null && prevSignal !== null
    && prevMacd < prevSignal && macd > signal;
  const bearishCross = prevMacd !== null && prevSignal !== null
    && prevMacd > prevSignal && macd < signal;

  const rules = [
    { label: "MACD line crossed above signal (bullish)", pass: bullishCross },
    { label: "MACD line crossed below signal (bearish)", pass: bearishCross },
  ];

  const resultSignal = bullishCross ? "BUY" : bearishCross ? "SELL" : "HOLD";
  return { signal: resultSignal, indicators, rules };
}

export function bollingerRsiStrategy(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const bb = calcBollingerBands(closes, 20, 2);
  const rsi14 = calcRSI(closes, 14);

  if (!bb || rsi14 === null) {
    return {
      signal: "HOLD",
      indicators: { price, upper: null, middle: null, lower: null, rsi14: null },
      rules: [{ label: "Insufficient data (need 20+ candles for BB, 15+ for RSI14)", pass: false }],
    };
  }

  const { upper, middle, lower } = bb;
  const indicators = { price, upper, middle, lower, rsi14 };

  const buyConditions = [
    { label: "Price < lower Bollinger Band", pass: price < lower },
    { label: "RSI(14) < 35 (oversold)", pass: rsi14 < 35 },
  ];
  const sellConditions = [
    { label: "Price > upper Bollinger Band", pass: price > upper },
    { label: "RSI(14) > 65 (overbought)", pass: rsi14 > 65 },
  ];

  if (buyConditions.every((r) => r.pass)) {
    return { signal: "BUY", indicators, rules: buyConditions };
  }
  if (sellConditions.every((r) => r.pass)) {
    return { signal: "SELL", indicators, rules: sellConditions };
  }

  const rules = [...buyConditions, ...sellConditions];
  return { signal: "HOLD", indicators, rules };
}

export function orbStrategy(candles) {
  if (candles.length === 0) {
    return {
      signal: "HOLD",
      indicators: { price: null, orbHigh: null, orbLow: null, avgOrbVolume: null, vwap: null, rsi14: null },
      rules: [{ label: "No candles", pass: false }],
    };
  }

  // IST session anchor — same logic as calcVWAP
  const ref = new Date(candles[candles.length - 1].time);
  const istMidnight = new Date(ref);
  istMidnight.setUTCHours(18, 30, 0, 0);
  if (istMidnight > ref) istMidnight.setUTCDate(istMidnight.getUTCDate() - 1);

  const sessionCandles = candles.filter((c) => c.time >= istMidnight.getTime());

  if (sessionCandles.length < 3) {
    const lastCandle = candles[candles.length - 1];
    const { close } = lastCandle;
    return {
      signal: "HOLD",
      indicators: { price: close, orbHigh: null, orbLow: null, avgOrbVolume: null, vwap: null, rsi14: null },
      rules: [{ label: "Opening range not yet formed (need 3 candles)", pass: false }],
    };
  }

  // Opening range = first 3 session candles
  const orbCandles = sessionCandles.slice(0, 3);
  const orbHigh = Math.max(...orbCandles.map((c) => c.high));
  const orbLow  = Math.min(...orbCandles.map((c) => c.low));
  const avgOrbVolume = orbCandles.reduce((sum, c) => sum + c.volume, 0) / 3;

  // VWAP for full session
  const vwap = calcVWAP(candles);

  // Compute RSI on all candles except the current one so that the current
  // candle's close does not distort the momentum reading (same principle as
  // using the previous bar's indicator value for signal confirmation).
  const closes = candles.slice(0, -1).map((c) => c.close);
  const rsi14 = calcRSI(closes, 14);

  const lastCandle = candles[candles.length - 1];
  const { close, volume } = lastCandle;

  // Time window: 9:30–11:30 AM IST = 04:00–06:00 UTC
  const t = new Date(lastCandle.time);
  const utcMinutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  const inWindow = utcMinutes >= 240 && utcMinutes <= 360;

  const indicators = { price: close, orbHigh, orbLow, avgOrbVolume, vwap, rsi14 };

  const buyRules = [
    { label: "Close > ORB High",                  pass: close > orbHigh },
    { label: "Volume > 1.2× avg ORB volume",       pass: volume > avgOrbVolume * 1.2 },
    { label: "RSI(14) > 55 (bullish momentum)",    pass: rsi14 !== null && rsi14 > 55 },
    { label: "Price > VWAP (bullish trend)",        pass: vwap !== null && close > vwap },
    { label: "Within ORB window (9:30–11:30 IST)", pass: inWindow },
  ];

  const sellRules = [
    { label: "Close < ORB Low",                    pass: close < orbLow },
    { label: "Volume > 1.2× avg ORB volume",       pass: volume > avgOrbVolume * 1.2 },
    { label: "RSI(14) < 45 (bearish momentum)",    pass: rsi14 !== null && rsi14 < 45 },
    { label: "Price < VWAP (bearish trend)",        pass: vwap !== null && close < vwap },
    { label: "Within ORB window (9:30–11:30 IST)", pass: inWindow },
  ];

  if (buyRules.every((r) => r.pass))  return { signal: "BUY",  indicators, rules: buyRules };
  if (sellRules.every((r) => r.pass)) return { signal: "SELL", indicators, rules: sellRules };

  const rules = close > orbHigh ? buyRules : close < orbLow ? sellRules : [...buyRules, ...sellRules];
  return { signal: "HOLD", indicators, rules };
}

export function detectMarketMode(candles) {
  if (candles.length < 4) {
    return { mode: "sideways", vwap: null, vwapSlope: null };
  }
  const currentVWAP = calcVWAP(candles);
  const prevVWAP = calcVWAP(candles.slice(0, -3));
  if (!currentVWAP || !prevVWAP) {
    return { mode: "sideways", vwap: currentVWAP, vwapSlope: null };
  }
  const vwapSlope = currentVWAP - prevVWAP;
  const price = candles[candles.length - 1].close;
  let mode;
  if (price > currentVWAP && vwapSlope > 0) mode = "bullish";
  else if (price < currentVWAP && vwapSlope < 0) mode = "bearish";
  else mode = "sideways";
  return { mode, vwap: currentVWAP, vwapSlope };
}
