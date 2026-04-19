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
