// Pure trade-management logic: sizing, stop/target levels and exit decisions.
// No network and no files, so every rule here is unit tested.

// Risk-based size: lose at most riskPct of the portfolio if the stop is hit,
// capped at maxTradeSize. With ₹50,000, 1% risk and a 0.3% stop that is
// ₹500 / 0.003 ≈ ₹1.67 lakh, so the ₹5,000 cap decides.
export function calcTradeSize({ portfolioValue, riskPct, stopPct, maxTradeSize }) {
  if (!(stopPct > 0)) throw new Error("STOP_LOSS_PCT must be above 0");
  const riskBased = (portfolioValue * riskPct / 100) / (stopPct / 100);
  return Math.min(riskBased, maxTradeSize);
}

export function stopPrice(side, entry, stopPct) {
  return side === "buy" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
}

export function targetPrice(side, entry, targetPct) {
  return side === "buy" ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100);
}

export function oppositeSide(side) {
  return side === "buy" ? "sell" : "buy";
}

// Mean-reversion entries (sideways mode) exit when RSI(3) crosses back over 50
// (rules.json). Trend entries (MACD/ORB) ride until stop, target or reversal.
export function strategyGroup(activeStrategies = []) {
  return activeStrategies.includes("MACD") || activeStrategies.includes("ORB") ? "trend" : "mean-reversion";
}

// Should the open position be closed now? Returns { exit, reason }.
// market: { price, low, high, rsi3, signal, istMinutes, fresh }
//   low/high: the extremes seen since entry (paper mode checks stop/target on them)
//   fresh:    false when the candles are stale; then only the clock rule applies
export function exitDecision(position, market, { squareOffMinutes = 15 * 60 + 10 } = {}) {
  const long = position.side === "buy";

  if (market.istMinutes >= squareOffMinutes) {
    return { exit: true, reason: "end-of-day square-off" };
  }
  if (!market.fresh) return { exit: false, reason: "stale data — holding, stop order stays in place" };

  const worst = long ? market.low ?? market.price : market.high ?? market.price;
  const best = long ? market.high ?? market.price : market.low ?? market.price;

  if (long ? worst <= position.stopPrice : worst >= position.stopPrice) {
    return { exit: true, reason: "stop-loss hit" };
  }
  if (long ? best >= position.targetPrice : best <= position.targetPrice) {
    return { exit: true, reason: "target hit" };
  }
  if (position.group === "mean-reversion" && market.rsi3 != null) {
    if (long ? market.rsi3 > 50 : market.rsi3 < 50) {
      return { exit: true, reason: `RSI(3) crossed back ${long ? "above" : "below"} 50` };
    }
  }
  if ((long && market.signal === "SELL") || (!long && market.signal === "BUY")) {
    return { exit: true, reason: "opposite signal" };
  }
  return { exit: false, reason: "no exit condition met" };
}

export function pnl(position, exitPrice) {
  const perShare = position.side === "buy" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
  return Math.round(perShare * position.quantity * 100) / 100;
}
