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

  // Compute all diffs
  const diffs = [];
  for (let i = 1; i < closes.length; i++) {
    diffs.push(closes[i] - closes[i - 1]);
  }

  // Seed: simple average of first `period` diffs
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (diffs[i] > 0) avgGain += diffs[i];
    else avgLoss -= diffs[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing for remaining diffs
  for (let i = period; i < diffs.length; i++) {
    const gain = diffs[i] > 0 ? diffs[i] : 0;
    const loss = diffs[i] < 0 ? -diffs[i] : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal - 1) return null;

  // Compute incremental fast and slow EMAs from bar 0
  const fastMult = 2 / (fast + 1);
  const slowMult = 2 / (slow + 1);

  let fastEma = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  let slowEma = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;

  // Advance fastEma to index slow-1 (to align start points)
  for (let i = fast; i < slow; i++) {
    fastEma = closes[i] * fastMult + fastEma * (1 - fastMult);
  }

  // Build MACD line starting from index slow-1
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    if (i > slow - 1) {
      fastEma = closes[i] * fastMult + fastEma * (1 - fastMult);
      slowEma = closes[i] * slowMult + slowEma * (1 - slowMult);
    }
    macdLine.push(fastEma - slowEma);
  }

  if (macdLine.length < signal) return null;

  // Compute signal line as EMA of macdLine
  const sigMult = 2 / (signal + 1);
  let sigEma = macdLine.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  let prevSigEma = null;
  for (let i = signal; i < macdLine.length; i++) {
    prevSigEma = sigEma;
    sigEma = macdLine[i] * sigMult + sigEma * (1 - sigMult);
  }

  const macdVal = macdLine[macdLine.length - 1];
  const prevMacd = macdLine.length >= 2 ? macdLine[macdLine.length - 2] : null;

  return {
    macd: macdVal,
    signal: sigEma,
    histogram: macdVal - sigEma,
    prevMacd,
    prevSignal: prevSigEma,
  };
}

export function calcBollingerBands(closes, period = 20, stddevMult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (period - 1);
  const stddev = Math.sqrt(variance);
  return {
    upper: mean + stddevMult * stddev,
    middle: mean,
    lower: mean - stddevMult * stddev,
  };
}
