import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isMarketOpen, fetchCandles } from "../market-data.js";

// isMarketOpen accepts optional `now` Date for testability
describe("isMarketOpen", () => {
  test("returns false on Sunday", () => {
    // 2025-01-05 Sunday, 10:00 AM IST = 04:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-05T04:30:00Z")), false);
  });

  test("returns false on Saturday", () => {
    // 2025-01-04 Saturday, 10:00 AM IST = 04:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-04T04:30:00Z")), false);
  });

  test("returns false before market open (9:00 AM IST)", () => {
    // Monday 2025-01-06, 9:00 AM IST = 03:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T03:30:00Z")), false);
  });

  test("returns true at market open (9:15 AM IST)", () => {
    // Monday 2025-01-06, 9:15 AM IST = 03:45 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T03:45:00Z")), true);
  });

  test("returns true during market hours", () => {
    // Monday 2025-01-06, 12:00 PM IST = 06:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T06:30:00Z")), true);
  });

  test("returns false at exactly 3:30 PM IST (market close boundary)", () => {
    // Monday 2025-01-06, 3:30 PM IST = 10:00 UTC — excluded (strict less-than)
    assert.equal(isMarketOpen(new Date("2025-01-06T10:00:00Z")), false);
  });

  test("returns true at 3:29 PM IST (last valid minute)", () => {
    // Monday 2025-01-06, 3:29 PM IST = 09:59 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T09:59:00Z")), true);
  });

  test("returns false after market close (3:30 PM IST)", () => {
    // Monday 2025-01-06, 4:00 PM IST = 10:30 UTC
    assert.equal(isMarketOpen(new Date("2025-01-06T10:30:00Z")), false);
  });
});

describe("fetchCandles", () => {
  const INSTRUMENTS_CSV = `instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange
738561,2886,RELIANCE,RELIANCE INDUSTRIES,2500.0,,0.0,0.05,1,EQ,NSE,NSE`;

  const KITE_CANDLES_RESPONSE = {
    status: "success",
    data: {
      candles: [["2025-01-06T09:15:00+0530", 2500, 2510, 2495, 2505, 100000]],
    },
  };

  const YAHOO_RESPONSE = {
    chart: {
      result: [{
        timestamp: [1704511800],
        indicators: {
          quote: [{ open: [2490], high: [2515], low: [2485], close: [2505], volume: [200000] }],
        },
      }],
    },
  };

  test("uses Kite when token provided and returns candles + lotSize", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async (url) => {
      if (url.includes("/instruments/NSE")) return { ok: true, text: async () => INSTRUMENTS_CSV };
      return { ok: true, json: async () => KITE_CANDLES_RESPONSE };
    });

    const result = await fetchCandles("valid-token", "RELIANCE", "NSE", "equity", "5m");
    assert.equal(result.source, "kite");
    assert.equal(result.lotSize, 1);
    assert.equal(result.candles.length, 1);
    assert.equal(result.candles[0].close, 2505);
  });

  test("falls back to Yahoo when Kite fails for equity", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async (url) => {
      if (url.includes("kite.trade")) return { ok: false, status: 401, text: async () => "Unauthorized" };
      return { ok: true, json: async () => YAHOO_RESPONSE };
    });

    const result = await fetchCandles("valid-token", "RELIANCE", "NSE", "equity", "5m");
    assert.equal(result.source, "yahoo");
    assert.equal(result.candles[0].close, 2505);
  });

  test("throws for F&O when Kite fails — no Yahoo fallback", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      ok: false, status: 401, text: async () => "Unauthorized",
    }));

    await assert.rejects(
      () => fetchCandles("token", "NIFTY25MAYFUT", "NFO", "futures", "5m"),
      /no Yahoo fallback for derivatives/
    );
  });

  test("throws for F&O when no token at all", async () => {
    await assert.rejects(
      () => fetchCandles(null, "NIFTY25MAYFUT", "NFO", "futures", "5m"),
      /No Kite token/
    );
  });
});
