# Mode-Based Trading Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace blind strategy vote-counting with a market-mode-aware router that activates ORB+MACD in trending markets and VWAP+BB in sideways markets.

**Architecture:** `detectMarketMode` added to `strategies.js` computes VWAP slope and classifies the market. `modeCombinedSignal` in `analyze.js` replaces `combinedSignal`, routing to the correct strategy pair based on mode and ORB window. Output updated to show mode and active strategies.

**Tech Stack:** Node.js 18+, ES Modules, `node:test` + `node:assert/strict`

---

## File Map

| File | Change |
|------|--------|
| `strategies.js` | Add `detectMarketMode(candles)` export |
| `analyze.js` | Add main guard, export `modeCombinedSignal` + `isInOrbWindow`, replace `combinedSignal`, update `run()` + output functions |
| `tests/strategies.test.js` | Add `detectMarketMode` describe block |
| `tests/analyze.test.js` | Create — tests for `modeCombinedSignal` |

---

## Task 1: detectMarketMode — TDD

**Files:**
- Modify: `strategies.js`
- Modify: `tests/strategies.test.js`

### How detectMarketMode works

1. Return `{ mode: "sideways", vwap: null, vwapSlope: null }` if `candles.length < 4`
2. `currentVWAP = calcVWAP(candles)`
3. `prevVWAP = calcVWAP(candles.slice(0, -3))` — VWAP excluding the last 3 candles
4. If either VWAP is null, return `{ mode: "sideways", vwap: currentVWAP, vwapSlope: null }`
5. `vwapSlope = currentVWAP - prevVWAP`
6. `price = candles[candles.length - 1].close`
7. Classify: `price > currentVWAP && vwapSlope > 0` → `"bullish"`, `price < currentVWAP && vwapSlope < 0` → `"bearish"`, else `"sideways"`
8. Return `{ mode, vwap: currentVWAP, vwapSlope }`

- [ ] **Step 1: Write failing tests for detectMarketMode**

Append this describe block to `tests/strategies.test.js`. Update the import line at the top to include `detectMarketMode`:

```javascript
// Change existing import line to:
import { vwapEmaRsiStrategy, macdStrategy, bollingerRsiStrategy, orbStrategy, detectMarketMode } from "../strategies.js";
```

Append at the bottom of `tests/strategies.test.js`:

```javascript
describe("detectMarketMode", () => {
  const sessionStart = new Date("2026-04-18T18:30:00Z").getTime();
  const fiveMin = 5 * 60 * 1000;

  function makeSessionCandles(closes) {
    return closes.map((c, i) => ({
      time: sessionStart + (i + 1) * fiveMin,
      open: c - 1, high: c + 2, low: c - 2, close: c, volume: 100000,
    }));
  }

  test("returns sideways when fewer than 4 candles", () => {
    const candles = makeSessionCandles([100, 101, 102]);
    const result = detectMarketMode(candles);
    assert.equal(result.mode, "sideways");
    assert.equal(result.vwap, null);
  });

  test("returns bullish when price > VWAP and slope > 0", () => {
    // 10 candles at 100 then 4 rising — VWAP pulled up, price above it
    const closes = [...Array(10).fill(100), 120, 130, 140, 150];
    const candles = makeSessionCandles(closes);
    const result = detectMarketMode(candles);
    assert.equal(result.mode, "bullish");
    assert.ok(result.vwap !== null);
    assert.ok(result.vwapSlope > 0, `expected vwapSlope > 0, got ${result.vwapSlope}`);
  });

  test("returns bearish when price < VWAP and slope < 0", () => {
    // 10 candles at 150 then 4 dropping — VWAP pulled down, price below it
    const closes = [...Array(10).fill(150), 130, 120, 110, 100];
    const candles = makeSessionCandles(closes);
    const result = detectMarketMode(candles);
    assert.equal(result.mode, "bearish");
    assert.ok(result.vwapSlope < 0, `expected vwapSlope < 0, got ${result.vwapSlope}`);
  });

  test("returns sideways when price equals VWAP (flat market)", () => {
    const closes = Array(14).fill(100);
    const candles = makeSessionCandles(closes);
    const result = detectMarketMode(candles);
    assert.equal(result.mode, "sideways");
  });

  test("result always has mode, vwap, vwapSlope fields", () => {
    const candles = makeSessionCandles(Array.from({ length: 10 }, (_, i) => 100 + i));
    const result = detectMarketMode(candles);
    assert.ok("mode" in result);
    assert.ok("vwap" in result);
    assert.ok("vwapSlope" in result);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/strategies.test.js
```

Expected: fail with `SyntaxError` or `undefined` — `detectMarketMode` is not exported yet.

- [ ] **Step 3: Implement detectMarketMode in strategies.js**

Append this export to the bottom of `strategies.js`:

```javascript
export function detectMarketMode(candles) {
  if (candles.length < 4) {
    return { mode: "sideways", vwap: null, vwapSlope: null };
  }
  const currentVWAP = calcVWAP(candles);
  const prevVWAP = calcVWAP(candles.slice(0, -3));
  if (!currentVWAP || !prevVWAP) {
    return { mode: "sideways", vwap: currentVWAP, vwapSlope: null };
  }
  const vwapSlope = currentVWAP - prevVWAP;
  const price = candles[candles.length - 1].close;
  let mode;
  if (price > currentVWAP && vwapSlope > 0) mode = "bullish";
  else if (price < currentVWAP && vwapSlope < 0) mode = "bearish";
  else mode = "sideways";
  return { mode, vwap: currentVWAP, vwapSlope };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/strategies.test.js
```

Expected: all tests pass, including the new `detectMarketMode` describe block.

- [ ] **Step 5: Commit**

```bash
git add strategies.js tests/strategies.test.js
git commit -m "feat: add detectMarketMode to strategies.js with VWAP slope classification"
```

---

## Task 2: modeCombinedSignal + main guard — TDD

**Files:**
- Modify: `analyze.js`
- Create: `tests/analyze.test.js`

### What to add to analyze.js

Two new exported functions (exported so tests can import them without network calls):

**`isInOrbWindow(candles)`** — returns `true` if last candle's time is 9:30–11:30 IST (04:00–06:00 UTC):
```javascript
export function isInOrbWindow(candles) {
  const t = new Date(candles[candles.length - 1].time);
  const utcMinutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return utcMinutes >= 240 && utcMinutes <= 360;
}
```

**`modeCombinedSignal(mode, inOrbWindow, results)`** — `results` is `[s1, s2, s3, s4]` = `[VWAP+EMA+RSI, MACD, BB+RSI, ORB]`:

| mode | inOrbWindow | active | fires when |
|------|-------------|--------|------------|
| bullish / bearish | true | ORB + MACD | both agree → signal; MACD alone fires |
| bullish / bearish | false | MACD only | MACD fires |
| sideways | any | VWAP+EMA+RSI + BB+RSI | either fires |

Returns `{ signal, mode, activeStrategies, count, total }`.

**Main guard** — prevents `run()` from executing when `analyze.js` is imported by tests:

Add at the top of `analyze.js`:
```javascript
import { fileURLToPath } from "url";
```

Replace the bottom `run().catch(...)` call with:
```javascript
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 1: Write failing tests — create tests/analyze.test.js**

```javascript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { modeCombinedSignal, isInOrbWindow } from "../analyze.js";

const HOLD = { signal: "HOLD" };
const BUY  = { signal: "BUY"  };
const SELL = { signal: "SELL" };

// results order: [s1=VWAP+EMA+RSI, s2=MACD, s3=BB+RSI, s4=ORB]

describe("isInOrbWindow", () => {
  test("returns true for 10:00 AM IST (04:30 UTC)", () => {
    const candles = [{ time: new Date("2026-04-18T04:30:00Z").getTime() }];
    assert.equal(isInOrbWindow(candles), true);
  });

  test("returns false for 12:30 PM IST (07:00 UTC)", () => {
    const candles = [{ time: new Date("2026-04-18T07:00:00Z").getTime() }];
    assert.equal(isInOrbWindow(candles), false);
  });
});

describe("modeCombinedSignal — trending + in ORB window", () => {
  test("BUY when ORB and MACD both BUY", () => {
    const result = modeCombinedSignal("bullish", true, [HOLD, BUY, HOLD, BUY]);
    assert.equal(result.signal, "BUY");
    assert.equal(result.count, 2);
    assert.deepEqual(result.activeStrategies, ["ORB", "MACD"]);
  });

  test("BUY when only MACD BUY (ORB HOLD)", () => {
    const result = modeCombinedSignal("bullish", true, [HOLD, BUY, HOLD, HOLD]);
    assert.equal(result.signal, "BUY");
    assert.equal(result.count, 1);
  });

  test("SELL when only MACD SELL (ORB HOLD)", () => {
    const result = modeCombinedSignal("bearish", true, [HOLD, SELL, HOLD, HOLD]);
    assert.equal(result.signal, "SELL");
  });

  test("HOLD when both ORB and MACD HOLD", () => {
    const result = modeCombinedSignal("bullish", true, [BUY, HOLD, BUY, HOLD]);
    assert.equal(result.signal, "HOLD");
  });
});

describe("modeCombinedSignal — trending + outside ORB window", () => {
  test("BUY when MACD BUY", () => {
    const result = modeCombinedSignal("bullish", false, [HOLD, BUY, HOLD, HOLD]);
    assert.equal(result.signal, "BUY");
    assert.deepEqual(result.activeStrategies, ["MACD"]);
    assert.equal(result.total, 1);
  });

  test("HOLD when MACD HOLD (ignores other strategies)", () => {
    const result = modeCombinedSignal("bearish", false, [BUY, HOLD, BUY, BUY]);
    assert.equal(result.signal, "HOLD");
  });
});

describe("modeCombinedSignal — sideways", () => {
  test("BUY when VWAP+EMA+RSI fires BUY", () => {
    const result = modeCombinedSignal("sideways", false, [BUY, HOLD, HOLD, HOLD]);
    assert.equal(result.signal, "BUY");
    assert.deepEqual(result.activeStrategies, ["VWAP+EMA+RSI", "BB+RSI"]);
  });

  test("BUY when BB+RSI fires BUY (VWAP HOLD)", () => {
    const result = modeCombinedSignal("sideways", true, [HOLD, HOLD, BUY, HOLD]);
    assert.equal(result.signal, "BUY");
  });

  test("HOLD when both sideways strategies HOLD", () => {
    const result = modeCombinedSignal("sideways", false, [HOLD, BUY, HOLD, BUY]);
    assert.equal(result.signal, "HOLD");
  });

  test("SELL when BB+RSI fires SELL", () => {
    const result = modeCombinedSignal("sideways", false, [HOLD, HOLD, SELL, HOLD]);
    assert.equal(result.signal, "SELL");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/analyze.test.js
```

Expected: fail — `modeCombinedSignal` not exported yet (or `run()` executes and crashes on network).

- [ ] **Step 3: Add main guard + isInOrbWindow + modeCombinedSignal to analyze.js**

At the top of `analyze.js`, add this import on a new line after `import "dotenv/config";`:

```javascript
import { fileURLToPath } from "url";
```

After the existing `import { ... } from "./strategies.js";` line, add `detectMarketMode` to the import:

```javascript
import { vwapEmaRsiStrategy, macdStrategy, bollingerRsiStrategy, orbStrategy, detectMarketMode } from "./strategies.js";
```

Add the two new exported functions after the existing `signalIcon` function (after line ~35):

```javascript
export function isInOrbWindow(candles) {
  const t = new Date(candles[candles.length - 1].time);
  const utcMinutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return utcMinutes >= 240 && utcMinutes <= 360;
}

export function modeCombinedSignal(mode, inOrbWindow, results) {
  const [s1, s2, s3, s4] = results;

  if (mode === "bullish" || mode === "bearish") {
    if (inOrbWindow) {
      if (s4.signal !== "HOLD" && s4.signal === s2.signal) {
        return { signal: s4.signal, mode, activeStrategies: ["ORB", "MACD"], count: 2, total: 2 };
      }
      if (s2.signal !== "HOLD") {
        return { signal: s2.signal, mode, activeStrategies: ["ORB", "MACD"], count: 1, total: 2 };
      }
      return { signal: "HOLD", mode, activeStrategies: ["ORB", "MACD"], count: 0, total: 2 };
    }
    if (s2.signal !== "HOLD") {
      return { signal: s2.signal, mode, activeStrategies: ["MACD"], count: 1, total: 1 };
    }
    return { signal: "HOLD", mode, activeStrategies: ["MACD"], count: 0, total: 1 };
  }

  if (s1.signal !== "HOLD") {
    return { signal: s1.signal, mode, activeStrategies: ["VWAP+EMA+RSI", "BB+RSI"], count: 1, total: 2 };
  }
  if (s3.signal !== "HOLD") {
    return { signal: s3.signal, mode, activeStrategies: ["VWAP+EMA+RSI", "BB+RSI"], count: 1, total: 2 };
  }
  return { signal: "HOLD", mode, activeStrategies: ["VWAP+EMA+RSI", "BB+RSI"], count: 0, total: 2 };
}
```

Replace the bottom `run().catch(...)` block:

```javascript
// Replace:
run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

// With:
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/analyze.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite to check no regressions**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add analyze.js tests/analyze.test.js
git commit -m "feat: add modeCombinedSignal and isInOrbWindow to analyze.js with tests"
```

---

## Task 3: Wire run() and update output

**Files:**
- Modify: `analyze.js`

### Changes to run()

Replace the call to `combinedSignal(results)` with `detectMarketMode` + `modeCombinedSignal`, and pass `modeResult` to the output functions.

### Changes to printTerminal

Add two new lines to the indicators section:
- `Market Mode   :` showing `BULLISH TREND` / `BEARISH TREND` / `SIDEWAYS`
- `VWAP Slope    :` showing the numeric slope

Update the combined signal line to show `activeStrategies`.

Signature changes from `printTerminal(candles, results, combined, now)` to `printTerminal(candles, results, combined, modeResult, now)`.

### Changes to buildHtml

Add two new indicator boxes: `Market Mode` and `VWAP Slope`.  
Update combined card to show active strategies.

Signature changes from `buildHtml(candles, results, combined, now)` to `buildHtml(candles, results, combined, modeResult, now)`.

- [ ] **Step 1: Update run() in analyze.js**

Replace this block inside `run()`:

```javascript
  const combined = combinedSignal(results);
  const now = new Date().toISOString();

  printTerminal(candles, results, combined, now);

  const html = buildHtml(candles, results, combined, now);
```

With:

```javascript
  const modeResult = detectMarketMode(candles);
  const inOrbWindow = isInOrbWindow(candles);
  const combined = modeCombinedSignal(modeResult.mode, inOrbWindow, results);
  const now = new Date().toISOString();

  printTerminal(candles, results, combined, modeResult, now);

  const html = buildHtml(candles, results, combined, modeResult, now);
```

- [ ] **Step 2: Update printTerminal signature and body**

Replace the entire `printTerminal` function:

```javascript
function printTerminal(candles, results, combined, modeResult, now) {
  const price  = candles[candles.length - 1].close;
  const [s1, s2, s3, s4] = results;
  const fmt = (v, prefix = "₹") => v != null ? `${prefix}${Number(v).toFixed(2)}` : "N/A";
  const modeLabel = modeResult.mode === "bullish" ? "BULLISH TREND"
    : modeResult.mode === "bearish" ? "BEARISH TREND" : "SIDEWAYS";

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  ${SYMBOL} (${EXCHANGE}) — Strategy Analysis`);
  console.log(`  ${now}`);
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  Current Price : ${fmt(price)}`);
  console.log(`  Market Mode   : ${modeLabel}`);
  console.log(`  VWAP Slope    : ${modeResult.vwapSlope != null ? modeResult.vwapSlope.toFixed(4) : "N/A"}`);
  console.log(`  EMA(8)        : ${fmt(s1.indicators.ema8)}`);
  console.log(`  VWAP          : ${fmt(s1.indicators.vwap)}`);
  console.log(`  RSI(3)        : ${s1.indicators.rsi3 != null ? s1.indicators.rsi3.toFixed(2) : "N/A"}`);
  console.log(`  RSI(14)       : ${s3.indicators.rsi14 != null ? s3.indicators.rsi14.toFixed(2) : "N/A"}`);
  console.log(`  MACD          : ${s2.indicators.macd != null ? s2.indicators.macd.toFixed(4) : "N/A"} | Signal: ${s2.indicators.signal != null ? s2.indicators.signal.toFixed(4) : "N/A"}`);
  console.log(`  BB Upper      : ${fmt(s3.indicators.upper)} | Lower: ${fmt(s3.indicators.lower)}`);
  console.log(`  ORB High      : ${fmt(s4.indicators.orbHigh)}`);
  console.log(`  ORB Low       : ${fmt(s4.indicators.orbLow)}`);
  console.log(`  ORB RSI(14)   : ${s4.indicators.rsi14 != null ? s4.indicators.rsi14.toFixed(2) : "N/A"}`);
  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  Strategy                       Signal     Rules");
  console.log("─────────────────────────────────────────────────────────────");

  const rows = [
    ["VWAP + EMA(8) + RSI(3)", s1],
    ["MACD Crossover",         s2],
    ["Bollinger Bands + RSI",  s3],
    ["ORB 15min + RSI(14)",    s4],
  ];
  for (const [name, r] of rows) {
    const met = r.rules.filter((x) => x.pass).length;
    console.log(`  ${name.padEnd(30)} ${signalIcon(r.signal)} ${r.signal.padEnd(6)}  ${met}/${r.rules.length} rules met`);
  }

  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  Active Strategies              [${combined.activeStrategies.join(", ")}]`);
  console.log(`  Combined Signal                ${signalIcon(combined.signal)} ${combined.signal.padEnd(6)}  ${combined.count}/${combined.total} agree`);
  console.log("═══════════════════════════════════════════════════════════\n");
}
```

- [ ] **Step 3: Update buildHtml signature and body**

Replace the `function buildHtml(candles, results, combined, now)` signature with `function buildHtml(candles, results, combined, modeResult, now)`.

Inside `buildHtml`, replace `const price = ...` and `const [s1, s2, s3, s4] = results;` block opening with:

```javascript
  const price = candles[candles.length - 1].close;
  const [s1, s2, s3, s4] = results;
  const fmt = (v, p = "₹") => v != null ? `${p}${Number(v).toFixed(2)}` : "N/A";
  const colorMap = { BUY: "#16a34a", SELL: "#dc2626", HOLD: "#ca8a04" };
  const bgMap    = { BUY: "#f0fdf4", SELL: "#fef2f2", HOLD: "#fefce8" };
  const modeLabel = modeResult.mode === "bullish" ? "BULLISH TREND"
    : modeResult.mode === "bearish" ? "BEARISH TREND" : "SIDEWAYS";
  const modeColor = modeResult.mode === "bullish" ? "#16a34a"
    : modeResult.mode === "bearish" ? "#dc2626" : "#ca8a04";
```

Add two new indicator boxes inside the `.indicators` div after the `ORB RSI(14)` box:

```javascript
    <div class="ind-box"><div class="ind-label">Market Mode</div><div class="ind-value" style="color:${modeColor}">${modeLabel}</div></div>
    <div class="ind-box"><div class="ind-label">VWAP Slope</div><div class="ind-value">${modeResult.vwapSlope != null ? modeResult.vwapSlope.toFixed(4) : "N/A"}</div></div>
```

Update the combined card at the bottom to show `activeStrategies`:

```javascript
<div class="card combined" style="background:${bgMap[combined.signal]};border:2px solid ${colorMap[combined.signal]}">
  <div style="color:#64748b;font-size:0.9em;margin-bottom:8px">COMBINED SIGNAL · <span style="color:${modeColor}">${modeLabel}</span></div>
  <div class="combined-signal" style="color:${colorMap[combined.signal]}">${signalIcon(combined.signal)} ${combined.signal}</div>
  <div style="color:#64748b;margin-top:8px">${combined.count}/${combined.total} agree · Active: ${combined.activeStrategies.join(", ")}</div>
</div>
```

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Smoke-test the output**

```bash
node analyze.js
```

Expected: terminal output shows `Market Mode` and `VWAP Slope` lines, combined signal shows `Active Strategies` and `[ORB, MACD]` or `[VWAP+EMA+RSI, BB+RSI]` depending on mode. No errors. `report.html` regenerated.

- [ ] **Step 6: Commit**

```bash
git add analyze.js
git commit -m "feat: wire mode-based routing into run() and update terminal/HTML output"
```
