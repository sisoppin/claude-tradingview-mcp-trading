import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { loadToken, exchangeToken } from "../kite-auth.js";

const TEST_FILE = "kite-token.test.json";
const cleanup = () => { if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE); };

describe("loadToken", () => {
  test("returns null when file does not exist", () => {
    cleanup();
    assert.equal(loadToken(TEST_FILE), null);
  });

  test("returns null when token is expired", () => {
    writeFileSync(TEST_FILE, JSON.stringify({
      access_token: "old-token",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));
    assert.equal(loadToken(TEST_FILE), null);
    cleanup();
  });

  test("returns access_token when valid", () => {
    writeFileSync(TEST_FILE, JSON.stringify({
      access_token: "valid-token",
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }));
    assert.equal(loadToken(TEST_FILE), "valid-token");
    cleanup();
  });
});

describe("exchangeToken", () => {
  test("saves token and returns access_token on success", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    process.env.KITE_API_SECRET = "test-secret";

    t.mock.method(global, "fetch", async () => ({
      json: async () => ({ status: "success", data: { access_token: "returned-token" } }),
    }));

    const result = await exchangeToken("request-token-123", TEST_FILE);
    assert.equal(result, "returned-token");

    const saved = JSON.parse(readFileSync(TEST_FILE, "utf8"));
    assert.equal(saved.access_token, "returned-token");
    assert.ok(new Date(saved.expires_at) > new Date(), "expires_at should be in the future");
    cleanup();
  });

  test("throws on Kite auth failure", async (t) => {
    process.env.KITE_API_KEY = "test-key";
    process.env.KITE_API_SECRET = "test-secret";

    t.mock.method(global, "fetch", async () => ({
      json: async () => ({ status: "error", message: "Invalid request token" }),
    }));

    await assert.rejects(
      () => exchangeToken("bad-token", TEST_FILE),
      /Kite auth failed: Invalid request token/
    );
    cleanup();
  });
});
