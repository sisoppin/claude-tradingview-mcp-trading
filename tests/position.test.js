import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  calcTradeSize, stopPrice, targetPrice, oppositeSide, strategyGroup, exitDecision, pnl,
} from "../position.js";
import { estimateCharges } from "../charges.js";

describe("calcTradeSize", () => {
  test("default config sizes to the ₹5,000 cap, not 1% of the portfolio", () => {
    // ₹50,000 × 1% = ₹500 at risk; ÷ 0.3% stop ≈ ₹1.67 lakh → capped at ₹5,000
    assert.equal(calcTradeSize({ portfolioValue: 50000, riskPct: 1, stopPct: 0.3, maxTradeSize: 5000 }), 5000);
  });

  test("risk-based size wins when it is below the cap", () => {
    // ₹10,000 × 0.1% = ₹10 at risk; ÷ 1% stop = ₹1,000
    assert.equal(calcTradeSize({ portfolioValue: 10000, riskPct: 0.1, stopPct: 1, maxTradeSize: 5000 }), 1000);
  });

  test("throws on a zero stop", () => {
    assert.throws(() => calcTradeSize({ portfolioValue: 1, riskPct: 1, stopPct: 0, maxTradeSize: 1 }), /STOP_LOSS_PCT/);
  });
});

describe("stop and target levels", () => {
  test("long stop below, target above", () => {
    assert.ok(Math.abs(stopPrice("buy", 1000, 0.3) - 997) < 1e-9);
    assert.ok(Math.abs(targetPrice("buy", 1000, 0.6) - 1006) < 1e-9);
  });

  test("short stop above, target below", () => {
    assert.ok(Math.abs(stopPrice("sell", 1000, 0.3) - 1003) < 1e-9);
    assert.ok(Math.abs(targetPrice("sell", 1000, 0.6) - 994) < 1e-9);
  });

  test("oppositeSide", () => {
    assert.equal(oppositeSide("buy"), "sell");
    assert.equal(oppositeSide("sell"), "buy");
  });
});

describe("strategyGroup", () => {
  test("MACD or ORB entries are trend trades", () => {
    assert.equal(strategyGroup(["ORB", "MACD"]), "trend");
    assert.equal(strategyGroup(["MACD"]), "trend");
  });

  test("sideways strategies are mean-reversion", () => {
    assert.equal(strategyGroup(["VWAP+EMA+RSI", "BB+RSI"]), "mean-reversion");
  });
});

describe("exitDecision", () => {
  const long = { side: "buy", entryPrice: 1000, stopPrice: 997, targetPrice: 1006, group: "trend" };
  const short = { side: "sell", entryPrice: 1000, stopPrice: 1003, targetPrice: 994, group: "trend" };
  const base = { price: 1001, low: 999, high: 1002, rsi3: 60, signal: "HOLD", istMinutes: 600, fresh: true };

  test("holds when nothing triggers", () => {
    assert.equal(exitDecision(long, base).exit, false);
  });

  test("long stop-loss on the low since entry", () => {
    assert.deepEqual(exitDecision(long, { ...base, low: 996.5 }), { exit: true, reason: "stop-loss hit" });
  });

  test("long target on the high since entry", () => {
    assert.deepEqual(exitDecision(long, { ...base, high: 1006.2 }), { exit: true, reason: "target hit" });
  });

  test("short stop-loss and target use the opposite extremes", () => {
    assert.equal(exitDecision(short, { ...base, high: 1003.5 }).reason, "stop-loss hit");
    assert.equal(exitDecision(short, { ...base, low: 993 }).reason, "target hit");
  });

  test("stop wins over target when both are touched", () => {
    assert.equal(exitDecision(long, { ...base, low: 990, high: 1010 }).reason, "stop-loss hit");
  });

  test("mean-reversion long exits when RSI(3) crosses above 50", () => {
    const mr = { ...long, group: "mean-reversion" };
    assert.equal(exitDecision(mr, { ...base, rsi3: 55 }).exit, true);
    assert.equal(exitDecision(mr, { ...base, rsi3: 45 }).exit, false);
  });

  test("trend trades ignore the RSI(3) rule", () => {
    assert.equal(exitDecision(long, { ...base, rsi3: 90 }).exit, false);
  });

  test("opposite combined signal closes the trade", () => {
    assert.equal(exitDecision(long, { ...base, signal: "SELL" }).reason, "opposite signal");
    assert.equal(exitDecision(short, { ...base, signal: "BUY" }).reason, "opposite signal");
  });

  test("square-off at 15:10 IST even on stale data", () => {
    const r = exitDecision(long, { ...base, istMinutes: 15 * 60 + 10, fresh: false });
    assert.deepEqual(r, { exit: true, reason: "end-of-day square-off" });
  });

  test("stale data never triggers a price-based exit", () => {
    assert.equal(exitDecision(long, { ...base, low: 900, fresh: false }).exit, false);
  });
});

describe("pnl", () => {
  test("long and short", () => {
    assert.equal(pnl({ side: "buy", entryPrice: 100, quantity: 10 }, 101.5), 15);
    assert.equal(pnl({ side: "sell", entryPrice: 100, quantity: 10 }, 101.5), -15);
  });
});

describe("estimateCharges", () => {
  test("buy of ₹5,000: brokerage 0.03%, stamp, txn, GST — no STT", () => {
    // brokerage 1.5, txn 0.1535, sebi 0.005, stamp 0.15, GST 18% of 1.6585 = 0.29853
    assert.equal(estimateCharges("buy", 5000), 2.11);
  });

  test("sell adds 0.025% STT and no stamp duty", () => {
    // brokerage 1.5, STT 1.25, txn 0.1535, sebi 0.005, GST 0.29853
    assert.equal(estimateCharges("sell", 5000), 3.21);
  });

  test("brokerage is capped at ₹20 per order", () => {
    // ₹1,00,000: 0.03% = ₹30 → ₹20, + txn 3.07 + sebi 0.10 + stamp 3 + GST 18% of 23.17
    assert.equal(estimateCharges("buy", 100000), 30.34);
  });
});
