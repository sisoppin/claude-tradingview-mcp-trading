export function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

export function calcRSI(closes, period = 14) {
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

export function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal - 1) return null;

  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const fastEma = calcEMA(slice, fast);
    const slowEma = calcEMA(slice, slow);
    if (fastEma === null || slowEma === null) continue;
    macdLine.push(fastEma - slowEma);
  }

  if (macdLine.length < signal) return null;

  const signalLine = calcEMA(macdLine, signal);
  if (signalLine === null) return null;

  const macdVal = macdLine[macdLine.length - 1];
  return {
    macd: macdVal,
    signal: signalLine,
    histogram: macdVal - signalLine,
    prevMacd: macdLine.length >= 2 ? macdLine[macdLine.length - 2] : null,
    prevSignal: (() => {
      if (macdLine.length < signal + 1) return null;
      return calcEMA(macdLine.slice(0, -1), signal);
    })(),
  };
}

export function calcBollingerBands(closes, period = 20, stddevMult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);
  return {
    upper: mean + stddevMult * stddev,
    middle: mean,
    lower: mean - stddevMult * stddev,
  };
}
