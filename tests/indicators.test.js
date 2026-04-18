import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { calcEMA, calcRSI, calcMACD, calcBollingerBands } from "../indicators.js";

describe("calcEMA", () => {
  test("returns seed average for exactly period length", () => {
    const closes = [10, 20, 30]; // avg = 20
    assert.equal(calcEMA(closes, 3), 20);
  });

  test("applies multiplier for one candle beyond period", () => {
    // seed = (10+20+30)/3 = 20, multiplier = 2/(3+1) = 0.5
    // ema = 40 * 0.5 + 20 * 0.5 = 30
    const closes = [10, 20, 30, 40];
    assert.equal(calcEMA(closes, 3), 30);
  });

  test("returns null for fewer closes than period", () => {
    assert.equal(calcEMA([10, 20], 3), null);
  });
});

describe("calcRSI", () => {
  test("returns null when fewer than period+1 closes", () => {
    assert.equal(calcRSI([10, 20, 30], 14), null);
  });

  test("returns 100 when all moves are gains", () => {
    const closes = Array.from({ length: 15 }, (_, i) => i + 1); // 1..15
    assert.equal(calcRSI(closes, 14), 100);
  });

  test("returns value between 0 and 100 for mixed moves", () => {
    const closes = [44, 42, 44, 43, 45, 44, 46, 45, 47, 46, 48, 47, 49, 48, 50];
    const rsi = calcRSI(closes, 14);
    assert.ok(rsi > 0 && rsi < 100, `expected 0<rsi<100, got ${rsi}`);
  });
});

describe("calcMACD", () => {
  test("returns null when not enough data (needs 26 + 9 - 1 = 34 closes)", () => {
    const closes = Array.from({ length: 33 }, (_, i) => i + 1);
    assert.equal(calcMACD(closes), null);
  });

  test("returns object with macd, signal, histogram for sufficient data", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const result = calcMACD(closes);
    assert.ok(result !== null);
    assert.ok(typeof result.macd === "number");
    assert.ok(typeof result.signal === "number");
    assert.ok(typeof result.histogram === "number");
  });

  test("histogram equals macd minus signal", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = calcMACD(closes);
    assert.ok(Math.abs(result.histogram - (result.macd - result.signal)) < 0.0001);
  });
});

describe("calcBollingerBands", () => {
  test("returns null when fewer closes than period", () => {
    assert.equal(calcBollingerBands([10, 20], 20, 2), null);
  });

  test("returns upper, middle, lower bands", () => {
    const closes = Array.from({ length: 20 }, () => 100);
    const result = calcBollingerBands(closes, 20, 2);
    assert.ok(result !== null);
    assert.equal(result.middle, 100);
    assert.equal(result.upper, 100);
    assert.equal(result.lower, 100);
  });

  test("upper > middle > lower for volatile data", () => {
    const closes = Array.from({ length: 20 }, (_, i) => i % 2 === 0 ? 100 : 110);
    const result = calcBollingerBands(closes, 20, 2);
    assert.ok(result.upper > result.middle);
    assert.ok(result.middle > result.lower);
  });
});
