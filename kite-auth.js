import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "crypto";

const KITE_BASE = "https://api.kite.trade";

function nextTokenExpiry() {
  // Kite tokens expire at 6 AM IST = 00:30 UTC
  const now = new Date();
  const expiry = new Date(now);
  expiry.setUTCHours(0, 30, 0, 0);
  if (expiry <= now) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry;
}

export function loadToken(tokenFile = "kite-token.json") {
  if (!existsSync(tokenFile)) return null;
  try {
    const { access_token, expires_at } = JSON.parse(readFileSync(tokenFile, "utf8"));
    if (new Date(expires_at) <= new Date()) return null;
    return access_token;
  } catch {
    return null;
  }
}

export function printLoginInstructions() {
  const apiKey = process.env.KITE_API_KEY;
  console.log("\n⚠️  Kite access token expired or missing.\n");
  console.log("Open this URL in your browser to log in:");
  console.log(`  https://kite.trade/connect/login?api_key=${apiKey}&v=3\n`);
  console.log("After login, run:");
  console.log("  node kite-auth.js --token <request_token>\n");
  console.log("Then re-run: node bot.js\n");
}

export async function exchangeToken(requestToken, tokenFile = "kite-token.json") {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("KITE_API_KEY and KITE_API_SECRET must be set in environment");
  }

  const checksum = crypto
    .createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");

  const res = await fetch(`${KITE_BASE}/session/token`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kite session request failed with HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.status !== "success") throw new Error(`Kite auth failed: ${data.message}`);

  const token = {
    access_token: data.data.access_token,
    expires_at: nextTokenExpiry().toISOString(),
  };

  writeFileSync(tokenFile, JSON.stringify(token, null, 2));
  console.log(`✅ Token saved to ${tokenFile} (expires: ${token.expires_at})`);
  return token.access_token;
}

// CLI: node kite-auth.js --token <request_token>
if (process.argv[1]?.endsWith("kite-auth.js") && process.argv.includes("--token")) {
  const idx = process.argv.indexOf("--token");
  const requestToken = process.argv[idx + 1];
  if (!requestToken) {
    console.error("Usage: node kite-auth.js --token <request_token>");
    process.exit(1);
  }
  exchangeToken(requestToken).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
