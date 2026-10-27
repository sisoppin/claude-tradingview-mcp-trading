import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { placeZerodhaOrder, placeStopOrder, waitForFill, roundToTick, marketableLimit } from "../zerodha.js";

describe("placeZerodhaOrder", () => {
  test("calculates correct equity quantity and places order", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      ok: true,
      text: async () => "",
      json: async () => ({ status: "success", data: { order_id: "EQ001" } }),
    }));

    // price=100, sizeINR=1000 → quantity = floor(1000/100) = 10
    const result = await placeZerodhaOrder("token", {
      tradingsymbol: "SBIN",
      exchange: "NSE",
      side: "buy",
      sizeINR: 1000,
      price: 100,
      lotSize: 1,
    });

    assert.equal(result.quantity, 10);
    assert.equal(result.orderId, "EQ001");
  });

  test("throws when equity trade size too small for one share", async () => {
    // price=2500, sizeINR=10 → floor(10/2500) = 0 → throws
    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        side: "buy",
        sizeINR: 10,
        price: 2500,
        lotSize: 1,
      }),
      /too small for one share/
    );
  });

  test("calculates correct F&O quantity as lot multiple", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      ok: true,
      text: async () => "",
      json: async () => ({ status: "success", data: { order_id: "FNO001" } }),
    }));

    // price=100, lotSize=50, sizeINR=10000 → lots=floor(10000/(100*50))=2 → qty=100
    const result = await placeZerodhaOrder("token", {
      tradingsymbol: "NIFTY25MAYFUT",
      exchange: "NFO",
      side: "buy",
      sizeINR: 10000,
      price: 100,
      lotSize: 50,
    });

    assert.equal(result.quantity, 100); // 2 lots × 50
    assert.equal(result.orderId, "FNO001");
  });

  test("throws when F&O trade size too small for one lot", async () => {
    // price=22000, lotSize=75, sizeINR=100 → floor(100/1650000) = 0 → throws
    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "NIFTY25MAYFUT",
        exchange: "NFO",
        side: "buy",
        sizeINR: 100,
        price: 22000,
        lotSize: 75,
      }),
      /too small for one lot/
    );
  });

  test("throws on Kite order failure response", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      ok: true,
      text: async () => "",
      json: async () => ({ status: "error", message: "Insufficient funds" }),
    }));

    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "SBIN",
        exchange: "NSE",
        side: "buy",
        sizeINR: 1000,
        price: 100,
        lotSize: 1,
      }),
      /Kite order failed: Insufficient funds/
    );
  });

  test("throws on invalid side value", async () => {
    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "SBIN",
        exchange: "NSE",
        side: "long",
        sizeINR: 1000,
        price: 100,
        lotSize: 1,
      }),
      /Invalid side "long"/
    );
  });

  test("sends correct transaction_type for sell orders", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    let capturedBody = "";
    t.mock.method(global, "fetch", async (_url, opts) => {
      capturedBody = opts.body.toString();
      return { ok: true, text: async () => "", json: async () => ({ status: "success", data: { order_id: "SELL001" } }) };
    });

    await placeZerodhaOrder("token", {
      tradingsymbol: "SBIN",
      exchange: "NSE",
      side: "sell",
      sizeINR: 1000,
      price: 100,
      lotSize: 1,
    });

    assert.ok(capturedBody.includes("transaction_type=SELL"), `Expected SELL in body, got: ${capturedBody}`);
  });
});

describe("LIMIT entries", () => {
  test("sends a marketable LIMIT on the tick grid, never MARKET", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    let body = "";
    t.mock.method(global, "fetch", async (_url, opts) => {
      body = opts.body.toString();
      return { ok: true, text: async () => "", json: async () => ({ status: "success", data: { order_id: "L1" } }) };
    });

    const r = await placeZerodhaOrder("token", {
      tradingsymbol: "SBIN", exchange: "NSE", side: "buy", price: 800.02, quantity: 6, tickSize: 0.05, slippagePct: 0.1,
    });

    const params = new URLSearchParams(body);
    assert.equal(params.get("order_type"), "LIMIT");
    assert.equal(params.get("product"), "MIS");
    assert.equal(params.get("quantity"), "6");
    // 800.02 × 1.001 = 800.82 → rounded up to 800.85
    assert.equal(params.get("price"), "800.85");
    assert.equal(r.limitPrice, 800.85);
  });

  test("roundToTick and marketableLimit", () => {
    assert.equal(roundToTick(100.03, 0.05, "up"), 100.05);
    assert.equal(roundToTick(100.03, 0.05, "down"), 100);
    assert.equal(roundToTick(100.05, 0.05, "up"), 100.05);
    assert.equal(marketableLimit("sell", 1000, 0.5, 0.05), 995);
  });
});

describe("placeStopOrder", () => {
  test("long stop: SL SELL with trigger rounded down and limit below it", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    let body = "";
    t.mock.method(global, "fetch", async (_url, opts) => {
      body = opts.body.toString();
      return { ok: true, text: async () => "", json: async () => ({ status: "success", data: { order_id: "S1" } }) };
    });

    const r = await placeStopOrder("token", {
      tradingsymbol: "SBIN", exchange: "NSE", side: "sell", quantity: 6, triggerPrice: 797.62, tickSize: 0.05, limitBufferPct: 1,
    });

    const params = new URLSearchParams(body);
    assert.equal(params.get("order_type"), "SL");
    assert.equal(params.get("transaction_type"), "SELL");
    assert.equal(params.get("trigger_price"), "797.6");
    assert.ok(Number(params.get("price")) < 797.6);
    assert.equal(r.orderId, "S1");
  });
});

describe("waitForFill", () => {
  const history = (status, filled, avg = 100) =>
    ({ ok: true, text: async () => "", json: async () => ({ status: "success", data: [{ status, filled_quantity: filled, average_price: avg }] }) });

  test("returns once the order is COMPLETE", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    const states = [history("OPEN", 0), history("COMPLETE", 5, 101.5)];
    t.mock.method(global, "fetch", async () => states.shift());
    const r = await waitForFill("token", "O1", { wait: async () => {} });
    assert.deepEqual(r, { status: "COMPLETE", filledQuantity: 5, averagePrice: 101.5 });
  });

  test("cancels the rest after the timeout and reports the partial fill", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    const calls = [];
    t.mock.method(global, "fetch", async (url, opts) => {
      calls.push(`${opts.method} ${url}`);
      if (opts.method === "DELETE") return { ok: true, text: async () => "", json: async () => ({ status: "success", data: {} }) };
      return calls.some((c) => c.startsWith("DELETE")) ? history("CANCELLED", 2) : history("OPEN", 2);
    });
    const r = await waitForFill("token", "O2", { timeoutMs: 3000, pollMs: 1000, wait: async () => {} });
    assert.ok(calls.some((c) => c === "DELETE https://api.kite.trade/orders/regular/O2"));
    assert.deepEqual(r, { status: "CANCELLED", filledQuantity: 2, averagePrice: 100 });
  });
});
