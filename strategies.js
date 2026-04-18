import { calcEMA, calcRSI, calcMACD, calcBollingerBands } from "./indicators.js";

function calcVWAP(candles) {
  const now = new Date();
  const istMidnight = new Date(now);
  istMidnight.setUTCHours(18, 30, 0, 0);
  if (istMidnight > now) istMidnight.setUTCDate(istMidnight.getUTCDate() - 1);
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
