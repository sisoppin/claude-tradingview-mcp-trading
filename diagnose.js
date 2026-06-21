#!/usr/bin/env node
/**
 * System Diagnostic Script
 * Checks every component and reports what's working, failing, or needs action.
 *
 * Usage: node diagnose.js
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";

const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";
const INFO = "ℹ️ ";

let passCount = 0;
let failCount = 0;
let warnCount = 0;
const actions = [];

function pass(msg) { console.log(`  ${PASS} ${msg}`); passCount++; }
function fail(msg, action) { console.log(`  ${FAIL} ${msg}`); failCount++; if (action) actions.push(action); }
function warn(msg, action) { console.log(`  ${WARN} ${msg}`); warnCount++; if (action) actions.push(action); }
function info(msg) { console.log(`  ${INFO} ${msg}`); }
function section(title) { console.log(`\n── ${title} ${"─".repeat(50 - title.length)}\n`); }

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  System Diagnostic — Zerodha Trading Dashboard");
  console.log(`  ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════════");

  // ─── 1. Node.js ────────────────────────────────────────────────────────────
  section("Node.js Runtime");
  try {
    const version = process.version;
    const major = parseInt(version.slice(1));
    if (major >= 18) pass(`Node.js ${version} (required: >=18)`);
    else fail(`Node.js ${version} — too old`, "Upgrade Node.js to v18 or later: https://nodejs.org");
  } catch {
    fail("Cannot determine Node.js version", "Install Node.js 18+: https://nodejs.org");
  }

  // ─── 2. Dependencies ──────────────────────────────────────────────────────
  section("Dependencies");
  if (existsSync("node_modules/dotenv")) {
    pass("dotenv installed");
  } else {
    fail("dotenv not installed", "Run: npm install");
  }

  if (existsSync("package.json")) {
    pass("package.json exists");
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    if (pkg.scripts?.server) pass("'server' script defined in package.json");
    else fail("'server' script missing in package.json", "Add \"server\": \"node server.js\" to scripts in package.json");
  } else {
    fail("package.json missing", "Run: npm init");
  }

  // ─── 3. Core Files ─────────────────────────────────────────────────────────
  section("Core Files");
  const requiredFiles = [
    ["server.js", "HTTP server — serves dashboard and API"],
    ["public/index.html", "Dashboard UI"],
    ["analyze.js", "Analysis engine"],
    ["strategies.js", "Strategy implementations"],
    ["indicators.js", "Technical indicator calculations"],
    ["zerodha.js", "Zerodha order placement"],
    ["kite-auth.js", "Kite Connect authentication"],
    ["market-data.js", "Market data fetching"],
    ["bot.js", "Trading bot loop"],
    ["rules.json", "Strategy rules definition"],
  ];
  for (const [file, desc] of requiredFiles) {
    if (existsSync(file)) pass(`${file} — ${desc}`);
    else fail(`${file} missing — ${desc}`, `Create or restore ${file}`);
  }

  // ─── 4. Environment Config ─────────────────────────────────────────────────
  section("Environment Configuration (.env)");
  if (!existsSync(".env")) {
    fail(".env file missing", "Run: cp .env.example .env — then fill in your credentials");
  } else {
    pass(".env file exists");
    const env = readFileSync(".env", "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) vars[match[1]] = match[2].trim();
    }

    // Required credentials
    const checks = [
      ["KITE_API_KEY", "Kite Connect API key"],
      ["KITE_API_SECRET", "Kite Connect API secret"],
    ];
    for (const [key, desc] of checks) {
      if (vars[key] && vars[key] !== "" && !vars[key].includes("your_")) {
        pass(`${key} — set`);
      } else {
        fail(`${key} — not configured (${desc})`, `Set ${key} in .env — get it from https://kite.trade/`);
      }
    }

    // Optional but important
    if (vars.KITE_ACCESS_TOKEN && vars.KITE_ACCESS_TOKEN !== "") {
      pass("KITE_ACCESS_TOKEN — set (enables real-time Kite data)");
    } else {
      warn("KITE_ACCESS_TOKEN — not set (will fall back to Yahoo Finance)", "Run: node kite_auth.js — or use the Auth tab in the dashboard");
    }

    // Trading config
    const tradingVars = ["TRADINGSYMBOL", "EXCHANGE", "INSTRUMENT_TYPE", "PORTFOLIO_VALUE_INR", "MAX_TRADE_SIZE_INR", "MAX_TRADES_PER_DAY", "TIMEFRAME"];
    for (const key of tradingVars) {
      if (vars[key] && vars[key] !== "") pass(`${key} = ${vars[key]}`);
      else warn(`${key} — using default`, `Set ${key} in .env if you want a custom value`);
    }

    if (vars.PAPER_TRADING === "false") {
      warn("PAPER_TRADING = false — LIVE TRADING ENABLED", "Set PAPER_TRADING=true in .env if this is unintended");
    } else {
      pass("PAPER_TRADING = true (safe mode)");
    }
  }

  // ─── 5. Authentication Token ───────────────────────────────────────────────
  section("Kite Authentication Token");
  if (existsSync("kite-token.json")) {
    try {
      const token = JSON.parse(readFileSync("kite-token.json", "utf8"));
      if (token.access_token && token.expires_at) {
        const expires = new Date(token.expires_at);
        if (expires > new Date()) {
          pass(`Token valid — expires ${expires.toISOString()}`);
        } else {
          fail(`Token expired at ${expires.toISOString()}`, "Re-authenticate: node kite_auth.js — or use the Auth tab");
        }
      } else {
        fail("kite-token.json malformed", "Delete kite-token.json and re-authenticate");
      }
    } catch {
      fail("kite-token.json corrupted", "Delete kite-token.json and re-authenticate");
    }
  } else {
    warn("kite-token.json not found — no saved token", "Authenticate via: node kite_auth.js — or use the Auth tab at http://localhost:8080");
  }

  // ─── 6. Network Connectivity ───────────────────────────────────────────────
  section("Network Connectivity");

  // Yahoo Finance
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?interval=5m&range=1d", {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) pass("Yahoo Finance API — reachable");
    else warn(`Yahoo Finance API — HTTP ${r.status}`, "Yahoo Finance may be rate-limiting; Kite Connect recommended");
  } catch (e) {
    fail(`Yahoo Finance API — unreachable (${e.message})`, "Check internet connection or firewall");
  }

  // Kite API
  try {
    const r = await fetch("https://api.kite.trade", { signal: AbortSignal.timeout(10000) });
    pass("Kite Connect API — reachable");
  } catch (e) {
    fail(`Kite Connect API — unreachable (${e.message})`, "Check internet connection or firewall for api.kite.trade");
  }

  // ─── 7. Port Availability ──────────────────────────────────────────────────
  section("Server Port");
  const port = process.env.PORT || 8080;
  try {
    const result = execSync(`lsof -i :${port} 2>/dev/null || true`, { encoding: "utf8" });
    if (result.includes("LISTEN")) {
      warn(`Port ${port} is already in use`, `Stop the existing process on port ${port}, or set PORT=<another> in .env`);
    } else {
      pass(`Port ${port} is available`);
    }
  } catch {
    info(`Could not check port ${port} availability (lsof not available)`);
  }

  // ─── 8. Module Import Check ────────────────────────────────────────────────
  section("Module Imports");
  const modules = [
    ["./indicators.js", "Indicators"],
    ["./strategies.js", "Strategies"],
    ["./market-data.js", "Market Data"],
    ["./zerodha.js", "Zerodha"],
    ["./kite-auth.js", "Kite Auth"],
    ["./analyze.js", "Analyze Engine"],
  ];
  for (const [mod, name] of modules) {
    try {
      await import(mod);
      pass(`${name} (${mod}) — imports OK`);
    } catch (e) {
      fail(`${name} (${mod}) — import failed: ${e.message}`, `Fix syntax/missing exports in ${mod}`);
    }
  }

  // ─── 9. Test Suite ─────────────────────────────────────────────────────────
  section("Test Suite");
  if (existsSync("tests")) {
    try {
      const testResult = execSync("node --test tests/*.test.js 2>&1", { encoding: "utf8", timeout: 30000 });
      const passMatch = testResult.match(/# pass (\d+)/);
      const failMatch = testResult.match(/# fail (\d+)/);
      const passed = passMatch ? parseInt(passMatch[1]) : 0;
      const failed = failMatch ? parseInt(failMatch[1]) : 0;
      if (failed === 0) pass(`All ${passed} tests passing`);
      else fail(`${failed} tests failing (${passed} passed)`, "Run: npm test — to see failure details");
    } catch (e) {
      const output = e.stdout || e.message || "";
      const failMatch = output.match(/# fail (\d+)/);
      const passMatch = output.match(/# pass (\d+)/);
      if (failMatch) {
        fail(`${failMatch[1]} tests failing (${passMatch?.[1] || "?"} passed)`, "Run: npm test — to see failure details");
      } else {
        fail("Test suite errored", "Run: npm test — to diagnose");
      }
    }
  } else {
    warn("tests/ directory not found", "Tests directory is missing from the project");
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Results: ${PASS} ${passCount} passed  ${FAIL} ${failCount} failed  ${WARN} ${warnCount} warnings`);
  console.log("═══════════════════════════════════════════════════════════");

  if (actions.length > 0) {
    console.log("\n── Pending Actions ──────────────────────────────────────\n");
    actions.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
    console.log("");
  } else {
    console.log("\n  🎉 All clear — no pending actions!\n");
  }

  if (failCount === 0 && warnCount === 0) {
    console.log("  Ready to run: node server.js");
    console.log("  Then open: http://localhost:8080\n");
  } else if (failCount === 0) {
    console.log("  System is functional with warnings.");
    console.log("  Run: node server.js");
    console.log("  Then open: http://localhost:8080\n");
  } else {
    console.log("  ⛔ Fix the failures above before running the server.\n");
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\nDiagnostic script crashed:", e.message);
  process.exit(1);
});
