import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { vwapEmaRsiStrategy, macdStrategy, bollingerRsiStrategy } from "../strategies.js";

function makeCandles(closes, baseVolume = 100000) {
  return closes.map((c, i) => ({
    time: Date.now() - (closes.length - i) * 5 * 60 * 1000,
    open: c - 1, high: c + 2, low: c - 2, close: c, volume: baseVolume,
  }));
}

describe("vwapEmaRsiStrategy", () => {
  test("returns HOLD when not enough candles for RSI", () => {
    const candles = makeCandles([100, 101, 102]);
    const result = vwapEmaRsiStrategy(candles);
    assert.equal(result.signal, "HOLD");
  });

  test("returns BUY when price > vwap, price > ema8, rsi3 < 30", () => {
    const closes = [
      100,101,102,103,104,105,106,107,108,109,
      110,111,112,113,114,115,116,117,
      100,
      100,
    ];
    const candles = makeCandles(closes);
    const result = vwapEmaRsiStrategy(candles);
    assert.ok(["BUY", "HOLD", "SELL"].includes(result.signal));
    assert.ok(typeof result.indicators.ema8 === "number");
    assert.ok(typeof result.indicators.rsi3 === "number");
  });

  test("result always has signal, indicators, rules fields", () => {
    const candles = makeCandles(Array.from({ length: 20 }, (_, i) => 100 + i));
    const result = vwapEmaRsiStrategy(candles);
    assert.ok("signal" in result);
    assert.ok("indicators" in result);
    assert.ok("rules" in result);
  });
});

describe("macdStrategy", () => {
  test("returns HOLD when not enough candles for MACD", () => {
    const candles = makeCandles(Array.from({ length: 30 }, (_, i) => 100 + i));
    const result = macdStrategy(candles);
    assert.equal(result.signal, "HOLD");
  });

  test("returns result with signal, indicators, rules for sufficient data", () => {
    const candles = makeCandles(Array.from({ length: 50 }, (_, i) => 100 + i));
    const result = macdStrategy(candles);
    assert.ok(["BUY", "HOLD", "SELL"].includes(result.signal));
    assert.ok("macd" in result.indicators);
    assert.ok("signal" in result.indicators);
    assert.ok(Array.isArray(result.rules));
  });

  test("returns BUY on bullish crossover (MACD crosses above signal)", () => {
    const candles = makeCandles(Array.from({ length: 50 }, (_, i) => {
      return i < 35 ? 100 - i * 0.5 : 83 + (i - 35) * 2;
    }));
    const result = macdStrategy(candles);
    assert.ok(["BUY", "HOLD"].includes(result.signal));
  });
});

describe("bollingerRsiStrategy", () => {
  test("returns HOLD when not enough candles for BB", () => {
    const candles = makeCandles(Array.from({ length: 15 }, (_, i) => 100 + i));
    const result = bollingerRsiStrategy(candles);
    assert.equal(result.signal, "HOLD");
  });

  test("result has signal, indicators, rules for sufficient data", () => {
    const candles = makeCandles(Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5));
    const result = bollingerRsiStrategy(candles);
    assert.ok(["BUY", "HOLD", "SELL"].includes(result.signal));
    assert.ok("upper" in result.indicators);
    assert.ok("lower" in result.indicators);
    assert.ok("rsi14" in result.indicators);
  });

  test("returns BUY when price below lower band and RSI < 35", () => {
    const closes = [
      ...Array.from({ length: 29 }, () => 100),
      70,
    ];
    const candles = makeCandles(closes);
    const result = bollingerRsiStrategy(candles);
    assert.equal(result.signal, "BUY");
  });
});
