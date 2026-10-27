import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import crypto from "crypto";
import { statePath } from "./state.js";

const KITE_BASE = "https://api.kite.trade";

// The one place the access token is stored. bot.js and analyze.js both read it
// through loadToken(), so it does not matter which one you run after logging in.
export const TOKEN_FILE = "kite-token.json";

function nextTokenExpiry() {
  // Kite tokens expire at 6 AM IST = 00:30 UTC
  const now = new Date();
  const expiry = new Date(now);
  expiry.setUTCHours(0, 30, 0, 0);
  if (expiry <= now) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry;
}

// Token file first (it carries an expiry), then KITE_ACCESS_TOKEN for hosts
// like Railway where you set the day's token as a variable instead.
export function loadToken(tokenFile = statePath(TOKEN_FILE)) {
  if (existsSync(tokenFile)) {
    try {
      const { access_token, expires_at } = JSON.parse(readFileSync(tokenFile, "utf8"));
      if (access_token && new Date(expires_at) > new Date()) return access_token;
    } catch {
      // fall through to the environment variable
    }
  }
  return process.env.KITE_ACCESS_TOKEN || null;
}

export function loginUrl() {
  return `https://kite.trade/connect/login?api_key=${process.env.KITE_API_KEY}&v=3`;
}

export function printLoginInstructions() {
  console.log("\n⚠️  Kite access token expired or missing.\n");
  console.log("Run: node kite-auth.js");
  console.log(`  (or open ${loginUrl()} and run: node kite-auth.js --token <request_token>)\n`);
  console.log("Then re-run: node bot.js\n");
}

export async function exchangeToken(requestToken, tokenFile = statePath(TOKEN_FILE)) {
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

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// CLI:
//   node kite-auth.js                     prints the login URL, asks for the request_token
//   node kite-auth.js --token <token>     exchanges it directly
async function main() {
  if (!process.env.KITE_API_KEY || !process.env.KITE_API_SECRET) {
    console.error("KITE_API_KEY and KITE_API_SECRET must be set in .env");
    process.exit(1);
  }
  const idx = process.argv.indexOf("--token");
  let requestToken = idx >= 0 ? process.argv[idx + 1] : null;
  if (!requestToken) {
    console.log("\nOpen this URL in your browser and log in:\n");
    console.log(`  ${loginUrl()}\n`);
    console.log("Kite redirects to your callback URL with ?request_token=XXXX — copy that value.\n");
    requestToken = await prompt("Paste request_token here: ");
  }
  if (!requestToken) {
    console.error("No request_token provided.");
    process.exit(1);
  }
  await exchangeToken(requestToken);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
