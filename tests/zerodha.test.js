import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { placeZerodhaOrder } from "../zerodha.js";

describe("placeZerodhaOrder", () => {
  test("calculates correct equity quantity and places order", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    t.mock.method(global, "fetch", async () => ({
      ok: true,
      text: async () => "",
      json: async () => ({ status: "success", data: { order_id: "EQ001" } }),
    }));

    // price=100, sizeUSD=1000 → quantity = floor(1000/100) = 10
    const result = await placeZerodhaOrder("token", {
      tradingsymbol: "SBIN",
      exchange: "NSE",
      side: "buy",
      sizeUSD: 1000,
      price: 100,
      lotSize: 1,
    });

    assert.equal(result.quantity, 10);
    assert.equal(result.orderId, "EQ001");
  });

  test("throws when equity trade size too small for one share", async () => {
    // price=2500, sizeUSD=10 → floor(10/2500) = 0 → throws
    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        side: "buy",
        sizeUSD: 10,
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

    // price=100, lotSize=50, sizeUSD=10000 → lots=floor(10000/(100*50))=2 → qty=100
    const result = await placeZerodhaOrder("token", {
      tradingsymbol: "NIFTY25MAYFUT",
      exchange: "NFO",
      side: "buy",
      sizeUSD: 10000,
      price: 100,
      lotSize: 50,
    });

    assert.equal(result.quantity, 100); // 2 lots × 50
    assert.equal(result.orderId, "FNO001");
  });

  test("throws when F&O trade size too small for one lot", async () => {
    // price=22000, lotSize=75, sizeUSD=100 → floor(100/1650000) = 0 → throws
    await assert.rejects(
      () => placeZerodhaOrder("token", {
        tradingsymbol: "NIFTY25MAYFUT",
        exchange: "NFO",
        side: "buy",
        sizeUSD: 100,
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
        sizeUSD: 1000,
        price: 100,
        lotSize: 1,
      }),
      /Kite order failed: Insufficient funds/
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
      sizeUSD: 1000,
      price: 100,
      lotSize: 1,
    });

    assert.ok(capturedBody.includes("transaction_type=SELL"), `Expected SELL in body, got: ${capturedBody}`);
  });
});
