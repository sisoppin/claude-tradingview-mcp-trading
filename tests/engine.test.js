import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { dropFormingCandle, checkFreshness, parseCsvLine, findInstrument, istDate, istMinutes } from "../market-data.js";
import { analyzeCandles } from "../analyze.js";
import { loadToken } from "../kite-auth.js";
import { entryBlockers, countTodaysTrades } from "../bot.js";

const FIVE_MIN = 5 * 60 * 1000;

describe("dropFormingCandle", () => {
  const t0 = Date.parse("2026-04-20T04:00:00Z");
  const candles = [{ time: t0 }, { time: t0 + FIVE_MIN }];

  test("drops the last candle while it is still forming", () => {
    assert.equal(dropFormingCandle(candles, "5m", t0 + FIVE_MIN + 60000).length, 1);
  });

  test("keeps it once its interval has passed", () => {
    assert.equal(dropFormingCandle(candles, "5m", t0 + 2 * FIVE_MIN).length, 2);
  });
});

describe("checkFreshness", () => {
  const t = Date.parse("2026-04-20T04:00:00Z");

  test("fresh within three intervals", () => {
    assert.equal(checkFreshness([{ time: t }], "5m", t + 10 * 60000).stale, false);
  });

  test("stale after three intervals (holiday, halt, delayed feed)", () => {
    assert.equal(checkFreshness([{ time: t }], "5m", t + 16 * 60000).stale, true);
  });

  test("no candles is stale", () => {
    assert.equal(checkFreshness([], "5m").stale, true);
  });
});

describe("instrument CSV parsing", () => {
  test("quoted names with commas do not shift columns", () => {
    assert.deepEqual(parseCsvLine('1,2,ABC,"ABC, LTD",0.05'), ["1", "2", "ABC", "ABC, LTD", "0.05"]);
  });

  test("findInstrument returns token, lot size and tick size", () => {
    const csv = `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
1,2,OTHER,"OTHER, INC",10,,0,0.01,1,EQ,NSE,NSE
738561,2886,RELIANCE,"RELIANCE INDUSTRIES, LTD",2500.0,,0.0,0.1,1,EQ,NSE,NSE`;
    assert.deepEqual(findInstrument(csv, "RELIANCE"), { instrumentToken: 738561, lotSize: 1, tickSize: 0.1 });
    assert.equal(findInstrument(csv, "MISSING"), null);
  });
});

describe("IST helpers", () => {
  test("istDate rolls over at IST midnight, not UTC", () => {
    assert.equal(istDate(new Date("2026-04-20T18:29:00Z")), "2026-04-20");
    assert.equal(istDate(new Date("2026-04-20T18:31:00Z")), "2026-04-21");
  });

  test("istMinutes", () => {
    assert.equal(istMinutes(new Date("2026-04-20T03:45:00Z")), 9 * 60 + 15);
  });
});

describe("analyzeCandles", () => {
  test("returns the routed combined signal the bot trades on", () => {
    const start = Date.parse("2026-04-20T03:45:00Z");
    const candles = Array.from({ length: 60 }, (_, i) => {
      const close = 100 + Math.sin(i / 3);
      return { time: start + i * FIVE_MIN, open: close, high: close + 0.2, low: close - 0.2, close, volume: 1000 };
    });
    const { results, combined, modeResult } = analyzeCandles(candles, start + 60 * FIVE_MIN);
    assert.equal(results.length, 4);
    assert.ok(["BUY", "SELL", "HOLD"].includes(combined.signal));
    assert.ok(["bullish", "bearish", "sideways"].includes(modeResult.mode));
    assert.ok(Array.isArray(combined.activeStrategies));
  });
});

describe("loadToken", () => {
  const FILE = "kite-token.engine-test.json";
  const cleanup = () => { if (existsSync(FILE)) unlinkSync(FILE); };

  test("falls back to KITE_ACCESS_TOKEN when the file is missing", () => {
    cleanup();
    process.env.KITE_ACCESS_TOKEN = "env-token";
    assert.equal(loadToken(FILE), "env-token");
    delete process.env.KITE_ACCESS_TOKEN;
  });

  test("a valid token file wins over the environment", () => {
    writeFileSync(FILE, JSON.stringify({ access_token: "file-token", expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    process.env.KITE_ACCESS_TOKEN = "env-token";
    assert.equal(loadToken(FILE), "file-token");
    delete process.env.KITE_ACCESS_TOKEN;
    cleanup();
  });
});

describe("entryBlockers", () => {
  const config = { maxTradesPerDay: 3, lastEntryMinutes: 900, allowShort: false, minConfidence: "STRONG" };
  const strongBuy = { signal: "BUY", confidence: "STRONG", score: 1, mode: "bullish", activeStrategies: ["MACD"] };
  const ok = { combined: strongBuy, fresh: true, tradesToday: 0, minutes: 600, config };

  test("a fresh STRONG BUY within limits goes through", () => {
    assert.deepEqual(entryBlockers(ok), []);
  });

  test("HOLD, stale data, daily cap and the 15:00 cutoff each block", () => {
    assert.equal(entryBlockers({ ...ok, combined: { ...strongBuy, signal: "HOLD" } }).length, 1);
    assert.match(entryBlockers({ ...ok, fresh: false })[0], /stale/);
    assert.match(entryBlockers({ ...ok, tradesToday: 3 })[0], /Max trades/);
    assert.match(entryBlockers({ ...ok, minutes: 900 })[0], /15:00/);
  });

  test("SELL blocked unless ALLOW_SHORT", () => {
    const sell = { ...strongBuy, signal: "SELL", mode: "bearish" };
    assert.match(entryBlockers({ ...ok, combined: sell })[0], /short selling is off/);
    assert.deepEqual(entryBlockers({ ...ok, combined: sell, config: { ...config, allowShort: true } }), []);
  });

  test("WEAK signals blocked when MIN_CONFIDENCE=STRONG, allowed when WEAK", () => {
    const weak = { ...strongBuy, confidence: "WEAK", score: 0.6 };
    assert.match(entryBlockers({ ...ok, combined: weak })[0], /Confidence WEAK/);
    assert.deepEqual(entryBlockers({ ...ok, combined: weak, config: { ...config, minConfidence: "WEAK" } }), []);
  });
});

describe("countTodaysTrades", () => {
  test("counts today's IST entries, not exits or blocked checks", () => {
    const now = new Date("2026-04-20T05:00:00Z");
    const log = { trades: [
      { timestamp: "2026-04-20T04:00:00Z", orderPlaced: true, type: "entry" },
      { timestamp: "2026-04-20T04:30:00Z", orderPlaced: true, type: "exit" },
      { timestamp: "2026-04-20T04:40:00Z", orderPlaced: false, type: "check" },
      { timestamp: "2026-04-19T04:00:00Z", orderPlaced: true, type: "entry" },
      { timestamp: "2026-04-20T03:50:00Z", orderPlaced: true },
    ] };
    assert.equal(countTodaysTrades(log, now), 2);
  });
});
