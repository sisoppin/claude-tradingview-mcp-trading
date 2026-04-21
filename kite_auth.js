#!/usr/bin/env node
/**
 * Kite Connect daily auth helper.
 *
 * Usage:
 *   node kite_auth.js            — prints login URL, prompts for request_token
 *   node kite_auth.js <req_tok>  — exchanges token directly (skip the prompt)
 *
 * On success: writes KITE_ACCESS_TOKEN to .env and prints the token.
 */

import "dotenv/config";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";

const API_KEY    = process.env.KITE_API_KEY;
const API_SECRET = process.env.KITE_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error("Error: KITE_API_KEY and KITE_API_SECRET must be set in .env");
  process.exit(1);
}

function loginUrl() {
  return `https://kite.trade/connect/login?api_key=${API_KEY}&v=3`;
}

async function exchangeToken(requestToken) {
  const checksum = createHash("sha256")
    .update(API_KEY + requestToken + API_SECRET)
    .digest("hex");

  const body = new URLSearchParams({ api_key: API_KEY, request_token: requestToken, checksum });
  const res = await fetch("https://api.kite.trade/session/token", {
    method: "POST",
    headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json();
  if (!res.ok || json.status !== "success") {
    throw new Error(`Token exchange failed: ${json.message || res.status}`);
  }
  return json.data.access_token;
}

function writeTokenToEnv(token) {
  const envPath = ".env";
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

  if (/^KITE_ACCESS_TOKEN=.*$/m.test(content)) {
    content = content.replace(/^KITE_ACCESS_TOKEN=.*$/m, `KITE_ACCESS_TOKEN=${token}`);
  } else {
    content += `\nKITE_ACCESS_TOKEN=${token}\n`;
  }
  writeFileSync(envPath, content);
}

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  let requestToken = process.argv[2];

  if (!requestToken) {
    console.log("\nStep 1 — Open this URL in your browser and log in:");
    console.log(`\n  ${loginUrl()}\n`);
    console.log("After login, Kite redirects you to your callback URL with ?request_token=XXXX");
    console.log("Copy the request_token value from the URL.\n");
    requestToken = await prompt("Paste request_token here: ");
  }

  if (!requestToken) {
    console.error("No request_token provided.");
    process.exit(1);
  }

  console.log("\nExchanging request_token for access_token...");
  const accessToken = await exchangeToken(requestToken);

  writeTokenToEnv(accessToken);

  console.log(`\nSuccess! KITE_ACCESS_TOKEN written to .env`);
  console.log(`Token: ${accessToken}`);
  console.log("\nYou can now run: node analyze.js");
}

main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
