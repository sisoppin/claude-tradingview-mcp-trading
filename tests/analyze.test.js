import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { modeCombinedSignal, isInOrbWindow } from "../analyze.js";

const HOLD = { signal: "HOLD" };
const BUY  = { signal: "BUY"  };
const SELL = { signal: "SELL" };

// results order: [s1=VWAP+EMA+RSI, s2=MACD, s3=BB+RSI, s4=ORB]

describe("isInOrbWindow", () => {
  test("returns true for 10:00 AM IST (04:30 UTC)", () => {
    const candles = [{ time: new Date("2026-04-18T04:30:00Z").getTime() }];
    assert.equal(isInOrbWindow(candles), true);
  });

  test("returns false for 12:30 PM IST (07:00 UTC)", () => {
    const candles = [{ time: new Date("2026-04-18T07:00:00Z").getTime() }];
    assert.equal(isInOrbWindow(candles), false);
  });

  test("returns false for 9:29 AM IST (04:29 UTC — just before window opens)", () => {
    const candles = [{ time: new Date("2026-04-18T03:59:00Z").getTime() }];
    assert.equal(isInOrbWindow(candles), false);
  });

  test("returns true for exactly 11:30 AM IST (06:00 UTC — window boundary)", () => {
    const candles = [{ time: new Date("2026-04-18T06:00:00Z").getTime() }];
    assert.equal(isInOrbWindow(candles), true);
  });
});

describe("modeCombinedSignal — trending + in ORB window", () => {
  test("BUY when ORB and MACD both BUY", () => {
    const result = modeCombinedSignal("bullish", true, [HOLD, BUY, HOLD, BUY]);
    assert.equal(result.signal, "BUY");
    assert.equal(result.count, 2);
    assert.deepEqual(result.activeStrategies, ["ORB", "MACD"]);
  });

  test("BUY when only MACD BUY (ORB HOLD)", () => {
    const result = modeCombinedSignal("bullish", true, [HOLD, BUY, HOLD, HOLD]);
    assert.equal(result.signal, "BUY");
    assert.equal(result.count, 1);
  });

  test("SELL when only MACD SELL (ORB HOLD)", () => {
    const result = modeCombinedSignal("bearish", true, [HOLD, SELL, HOLD, HOLD]);
    assert.equal(result.signal, "SELL");
  });

  test("HOLD when both ORB and MACD HOLD", () => {
    const result = modeCombinedSignal("bullish", true, [BUY, HOLD, BUY, HOLD]);
    assert.equal(result.signal, "HOLD");
  });

  test("BUY from MACD when ORB fires opposing SELL (MACD wins, count:1)", () => {
    const result = modeCombinedSignal("bullish", true, [HOLD, BUY, HOLD, SELL]);
    assert.equal(result.signal, "BUY");
    assert.equal(result.count, 1);
  });
});

describe("modeCombinedSignal — trending + outside ORB window", () => {
  test("BUY when MACD BUY", () => {
    const result = modeCombinedSignal("bullish", false, [HOLD, BUY, HOLD, HOLD]);
    assert.equal(result.signal, "BUY");
    assert.deepEqual(result.activeStrategies, ["MACD"]);
    assert.equal(result.total, 1);
  });

  test("HOLD when MACD HOLD (ignores other strategies)", () => {
    const result = modeCombinedSignal("bearish", false, [BUY, HOLD, BUY, BUY]);
    assert.equal(result.signal, "HOLD");
  });
});

describe("modeCombinedSignal — sideways", () => {
  test("BUY when VWAP+EMA+RSI fires BUY", () => {
    const result = modeCombinedSignal("sideways", false, [BUY, HOLD, HOLD, HOLD]);
    assert.equal(result.signal, "BUY");
    assert.deepEqual(result.activeStrategies, ["VWAP+EMA+RSI", "BB+RSI"]);
  });

  test("BUY when BB+RSI fires BUY (VWAP HOLD)", () => {
    const result = modeCombinedSignal("sideways", true, [HOLD, HOLD, BUY, HOLD]);
    assert.equal(result.signal, "BUY");
  });

  test("HOLD when both sideways strategies HOLD", () => {
    const result = modeCombinedSignal("sideways", false, [HOLD, BUY, HOLD, BUY]);
    assert.equal(result.signal, "HOLD");
  });

  test("SELL when BB+RSI fires SELL", () => {
    const result = modeCombinedSignal("sideways", false, [HOLD, HOLD, SELL, HOLD]);
    assert.equal(result.signal, "SELL");
  });

  test("HOLD when only ORB and MACD fire (sideways ignores trend strategies)", () => {
    const result = modeCombinedSignal("sideways", true, [HOLD, BUY, HOLD, BUY]);
    assert.equal(result.signal, "HOLD");
    assert.deepEqual(result.activeStrategies, ["VWAP+EMA+RSI", "BB+RSI"]);
  });
});

describe("modeCombinedSignal — confidence score", () => {
  function makeResult(signal, passCount, totalRules) {
    return {
      signal,
      rules: Array.from({ length: totalRules }, (_, i) => ({ label: `r${i}`, pass: i < passCount })),
    };
  }

  // results order: [s1=VWAP+EMA+RSI(4 rules), s2=MACD(2 rules), s3=BB+RSI(2 rules), s4=ORB(5 rules)]

  test("STRONG when trending+ORB: ORB 3/5 + MACD 2/2 → avg 0.80 ≥ 0.75", () => {
    const results = [
      makeResult("HOLD", 0, 4), makeResult("BUY", 2, 2),
      makeResult("HOLD", 0, 2), makeResult("BUY", 3, 5),
    ];
    const r = modeCombinedSignal("bullish", true, results);
    assert.equal(r.confidence, "STRONG");
    assert.ok(Math.abs(r.score - 0.8) < 0.01, `expected score ~0.80, got ${r.score}`);
  });

  test("WEAK when trending+ORB: ORB 2/5 + MACD 1/2 → avg 0.45 < 0.75", () => {
    const results = [
      makeResult("HOLD", 0, 4), makeResult("BUY", 1, 2),
      makeResult("HOLD", 0, 2), makeResult("BUY", 2, 5),
    ];
    const r = modeCombinedSignal("bullish", true, results);
    assert.equal(r.confidence, "WEAK");
  });

  test("STRONG when MACD-only: 2/2 rules pass → score 1.0 ≥ 0.85", () => {
    const results = [
      makeResult("HOLD", 0, 4), makeResult("BUY", 2, 2),
      makeResult("HOLD", 0, 2), makeResult("HOLD", 0, 5),
    ];
    const r = modeCombinedSignal("bullish", false, results);
    assert.equal(r.confidence, "STRONG");
    assert.ok(Math.abs(r.score - 1.0) < 0.01, `expected score 1.0, got ${r.score}`);
  });

  test("WEAK when MACD-only: 1/2 rules pass → score 0.5 < 0.85", () => {
    const results = [
      makeResult("HOLD", 0, 4), makeResult("BUY", 1, 2),
      makeResult("HOLD", 0, 2), makeResult("HOLD", 0, 5),
    ];
    const r = modeCombinedSignal("bullish", false, results);
    assert.equal(r.confidence, "WEAK");
  });

  test("STRONG when sideways: VWAP 4/4 + BB 2/2 → avg 1.0 ≥ 0.75", () => {
    const results = [
      makeResult("BUY", 4, 4), makeResult("HOLD", 0, 2),
      makeResult("BUY", 2, 2), makeResult("HOLD", 0, 5),
    ];
    const r = modeCombinedSignal("sideways", false, results);
    assert.equal(r.confidence, "STRONG");
  });

  test("WEAK when sideways: VWAP 2/4 + BB 1/2 → avg 0.50 < 0.75", () => {
    const results = [
      makeResult("BUY", 2, 4), makeResult("HOLD", 0, 2),
      makeResult("BUY", 1, 2), makeResult("HOLD", 0, 5),
    ];
    const r = modeCombinedSignal("sideways", false, results);
    assert.equal(r.confidence, "WEAK");
  });

  test("always WEAK with score 0 for HOLD signal", () => {
    const results = [
      makeResult("HOLD", 4, 4), makeResult("HOLD", 2, 2),
      makeResult("HOLD", 2, 2), makeResult("HOLD", 5, 5),
    ];
    const r = modeCombinedSignal("sideways", false, results);
    assert.equal(r.signal, "HOLD");
    assert.equal(r.confidence, "WEAK");
    assert.equal(r.score, 0);
  });
});
