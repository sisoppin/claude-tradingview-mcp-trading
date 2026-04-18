# ORB Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 15-minute Opening Range Breakout strategy with 5-condition signal logic to `strategies.js` and wire it into `analyze.js` as a 4th strategy.

**Architecture:** `orbStrategy` is a new named export in `strategies.js` that follows the exact same `{ signal, indicators, rules }` contract as the three existing strategies. `analyze.js` imports and runs it alongside the others; `combinedSignal` already handles N strategies dynamically so no logic changes are needed there.

**Tech Stack:** Node.js ESM, `calcRSI` from `indicators.js`, no new dependencies.

---

## File Map

| File | Change |
|------|--------|
| `strategies.js` | Add `orbStrategy` export |
| `analyze.js` | Import `orbStrategy`, add as 4th strategy, update terminal + HTML output |
| `tests/strategies.test.js` | Add `orbStrategy` describe block with 5 tests |

---

### Task 1: Add `orbStrategy` to `strategies.js`

**Files:**
- Modify: `strategies.js`
- Test: `tests/strategies.test.js`

- [ ] **Step 1: Write the failing tests first**

Add this block to the bottom of `tests/strategies.test.js`:

```javascript
import { vwapEmaRsiStrategy, macdStrategy, bollingerRsiStrategy, orbStrategy } from "../strategies.js";
```

Replace the existing import line at the top with the above (adds `orbStrategy`).

Then add this describe block at the bottom of the file:

```javascript
describe("orbStrategy", () => {
  const sessionStart = new Date("2026-04-17T18:30:00Z").getTime();
  const fiveMin = 5 * 60 * 1000;

  // Opening range candles: orbHigh=105, orbLow=94, avgOrbVolume=100000
  const orbCandles = [
    { time: sessionStart + fiveMin,     open: 99,  high: 105, low: 94, close: 100, volume: 100000 },
    { time: sessionStart + 2 * fiveMin, open: 100, high: 104, low: 95, close: 101, volume: 100000 },
    { time: sessionStart + 3 * fiveMin, open: 101, high: 103, low: 96, close: 102, volume: 100000 },
  ];

  // 16 rising candles to push RSI(14) > 55
  const risingMid = Array.from({ length: 16 }, (_, i) => ({
    time: sessionStart + (4 + i) * fiveMin,
    open: 102 + i, high: 103 + i, low: 101 + i, close: 103 + i, volume: 100000,
  }));

  // 16 falling candles to push RSI(14) < 45
  const fallingMid = Array.from({ length: 16 }, (_, i) => ({
    time: sessionStart + (4 + i) * fiveMin,
    open: 100 - i, high: 101 - i, low: 99 - i, close: 100 - i, volume: 100000,
  }));

  // 16 alternating candles to keep RSI ~50
  const flatMid = Array.from({ length: 16 }, (_, i) => ({
    time: sessionStart + (4 + i) * fiveMin,
    open: 100, high: 102, low: 98, close: i % 2 === 0 ? 101 : 100, volume: 100000,
  }));

  test("returns BUY when all 5 buy conditions pass", () => {
    const lastCandle = {
      time: new Date("2026-04-18T04:30:00Z").getTime(), // 10:00 AM IST — inside window
      open: 118, high: 122, low: 117, close: 120, // close=120 > orbHigh=105
      volume: 130000, // > 100000 * 1.2 = 120000
    };
    const candles = [...orbCandles, ...risingMid, lastCandle];
    const result = orbStrategy(candles);
    assert.equal(result.signal, "BUY");
    assert.equal(result.indicators.orbHigh, 105);
    assert.equal(result.indicators.orbLow, 94);
  });

  test("returns SELL when all 5 sell conditions pass", () => {
    // orbLow=94, so we need close < 94 for SELL
    const sellOrbCandles = [
      { time: sessionStart + fiveMin,     open: 101, high: 106, low: 94, close: 100, volume: 100000 },
      { time: sessionStart + 2 * fiveMin, open: 100, high: 105, low: 95, close:  99, volume: 100000 },
      { time: sessionStart + 3 * fiveMin, open:  99, high: 104, low: 96, close:  98, volume: 100000 },
    ];
    const lastCandle = {
      time: new Date("2026-04-18T04:30:00Z").getTime(),
      open: 85, high: 86, low: 78, close: 80, // close=80 < orbLow=94
      volume: 130000,
    };
    const candles = [...sellOrbCandles, ...fallingMid, lastCandle];
    const result = orbStrategy(candles);
    assert.equal(result.signal, "SELL");
  });

  test("returns HOLD when RSI blocks BUY (RSI ~50, not > 55)", () => {
    const lastCandle = {
      time: new Date("2026-04-18T04:30:00Z").getTime(),
      open: 105, high: 110, low: 104, close: 107, // close=107 > orbHigh=105
      volume: 130000,
    };
    const candles = [...orbCandles, ...flatMid, lastCandle];
    const result = orbStrategy(candles);
    assert.equal(result.signal, "HOLD");
  });

  test("returns HOLD when current candle is outside 9:30–11:30 IST window", () => {
    const lastCandle = {
      time: new Date("2026-04-18T07:00:00Z").getTime(), // 12:30 PM IST — outside window
      open: 118, high: 122, low: 117, close: 120,
      volume: 130000,
    };
    const candles = [...orbCandles, ...risingMid, lastCandle];
    const result = orbStrategy(candles);
    assert.equal(result.signal, "HOLD");
    const windowRule = result.rules.find((r) => r.label.includes("window"));
    assert.ok(windowRule, "should have a time window rule");
    assert.equal(windowRule.pass, false);
  });

  test("returns HOLD when opening range not yet formed (< 3 session candles)", () => {
    const candles = [
      { time: sessionStart + fiveMin,     open: 99, high: 105, low: 94, close: 100, volume: 100000 },
      { time: sessionStart + 2 * fiveMin, open: 100, high: 104, low: 95, close: 101, volume: 100000 },
    ];
    const result = orbStrategy(candles);
    assert.equal(result.signal, "HOLD");
    assert.ok(result.rules[0].label.includes("not yet formed"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (orbStrategy not exported yet)**

```bash
node --test tests/strategies.test.js 2>&1 | tail -20
```

Expected: import error or `orbStrategy is not a function`.

- [ ] **Step 3: Implement `orbStrategy` in `strategies.js`**

Append this export to the bottom of `strategies.js`:

```javascript
export function orbStrategy(candles) {
  if (candles.length === 0) {
    return { signal: "HOLD", indicators: {}, rules: [{ label: "No candles", pass: false }] };
  }

  // IST session anchor — same logic as calcVWAP
  const ref = new Date(candles[candles.length - 1].time);
  const istMidnight = new Date(ref);
  istMidnight.setUTCHours(18, 30, 0, 0);
  if (istMidnight > ref) istMidnight.setUTCDate(istMidnight.getUTCDate() - 1);

  const sessionCandles = candles.filter((c) => c.time >= istMidnight.getTime());

  if (sessionCandles.length < 3) {
    return {
      signal: "HOLD",
      indicators: { orbHigh: null, orbLow: null, avgOrbVolume: null, vwap: null, rsi14: null },
      rules: [{ label: "Opening range not yet formed (need 3 candles)", pass: false }],
    };
  }

  // Opening range = first 3 session candles
  const orbCandles = sessionCandles.slice(0, 3);
  const orbHigh = Math.max(...orbCandles.map((c) => c.high));
  const orbLow  = Math.min(...orbCandles.map((c) => c.low));
  const avgOrbVolume = orbCandles.reduce((sum, c) => sum + c.volume, 0) / 3;

  // VWAP for full session
  const cumTPV = sessionCandles.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  const vwap = cumVol === 0 ? null : cumTPV / cumVol;

  const closes = candles.map((c) => c.close);
  const rsi14 = calcRSI(closes, 14);

  const lastCandle = candles[candles.length - 1];
  const { close, volume } = lastCandle;
  const price = close;

  // Time window: 9:30–11:30 AM IST = 04:00–06:00 UTC
  const t = new Date(lastCandle.time);
  const utcMinutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  const inWindow = utcMinutes >= 240 && utcMinutes <= 360;

  const indicators = { price, orbHigh, orbLow, avgOrbVolume, vwap, rsi14 };

  const buyRules = [
    { label: "Close > ORB High",                  pass: close > orbHigh },
    { label: "Volume > 1.2× avg ORB volume",       pass: volume > avgOrbVolume * 1.2 },
    { label: "RSI(14) > 55 (bullish momentum)",    pass: rsi14 !== null && rsi14 > 55 },
    { label: "Price > VWAP (bullish trend)",        pass: vwap !== null && price > vwap },
    { label: "Within ORB window (9:30–11:30 IST)", pass: inWindow },
  ];

  const sellRules = [
    { label: "Close < ORB Low",                    pass: close < orbLow },
    { label: "Volume > 1.2× avg ORB volume",       pass: volume > avgOrbVolume * 1.2 },
    { label: "RSI(14) < 45 (bearish momentum)",    pass: rsi14 !== null && rsi14 < 45 },
    { label: "Price < VWAP (bearish trend)",        pass: vwap !== null && price < vwap },
    { label: "Within ORB window (9:30–11:30 IST)", pass: inWindow },
  ];

  if (buyRules.every((r) => r.pass))  return { signal: "BUY",  indicators, rules: buyRules };
  if (sellRules.every((r) => r.pass)) return { signal: "SELL", indicators, rules: sellRules };

  const rules = close > orbHigh ? buyRules : close < orbLow ? sellRules : [...buyRules, ...sellRules];
  return { signal: "HOLD", indicators, rules };
}
```

- [ ] **Step 4: Run the full test suite to verify all tests pass**

```bash
node --test tests/strategies.test.js 2>&1 | tail -20
```

Expected output:
```
# tests 16
# pass 16
# fail 0
```

- [ ] **Step 5: Commit**

```bash
git add strategies.js tests/strategies.test.js
git commit -m "feat: add orbStrategy (15min ORB, volume 1.2x, RSI 55/45, VWAP trend, time window)"
```

---

### Task 2: Wire `orbStrategy` into `analyze.js`

**Files:**
- Modify: `analyze.js`

- [ ] **Step 1: Update the import line in `analyze.js`**

Replace line 3:
```javascript
import { vwapEmaRsiStrategy, macdStrategy, bollingerRsiStrategy } from "./strategies.js";
```
With:
```javascript
import { vwapEmaRsiStrategy, macdStrategy, bollingerRsiStrategy, orbStrategy } from "./strategies.js";
```

- [ ] **Step 2: Add `s4` in the `run()` function**

Replace in `run()`:
```javascript
  const s1 = vwapEmaRsiStrategy(candles);
  const s2 = macdStrategy(candles);
  const s3 = bollingerRsiStrategy(candles);
  const results = [s1, s2, s3];
```
With:
```javascript
  const s1 = vwapEmaRsiStrategy(candles);
  const s2 = macdStrategy(candles);
  const s3 = bollingerRsiStrategy(candles);
  const s4 = orbStrategy(candles);
  const results = [s1, s2, s3, s4];
```

- [ ] **Step 3: Update `printTerminal` to show ORB indicators and 4th row**

Replace the `printTerminal` function signature destructure and indicator lines:
```javascript
function printTerminal(candles, results, combined, now) {
  const price  = candles[candles.length - 1].close;
  const [s1, s2, s3] = results;
```
With:
```javascript
function printTerminal(candles, results, combined, now) {
  const price  = candles[candles.length - 1].close;
  const [s1, s2, s3, s4] = results;
```

Then after the existing `console.log(`  BB Upper...`)` line, add:
```javascript
  console.log(`  ORB High      : ${fmt(s4.indicators.orbHigh)}`);
  console.log(`  ORB Low       : ${fmt(s4.indicators.orbLow)}`);
```

Replace the `rows` array:
```javascript
  const rows = [
    ["VWAP + EMA(8) + RSI(3)", s1],
    ["MACD Crossover",         s2],
    ["Bollinger Bands + RSI",  s3],
  ];
```
With:
```javascript
  const rows = [
    ["VWAP + EMA(8) + RSI(3)", s1],
    ["MACD Crossover",         s2],
    ["Bollinger Bands + RSI",  s3],
    ["ORB 15min + RSI(14)",    s4],
  ];
```

- [ ] **Step 4: Update `buildHtml` to show ORB indicators and 4th row**

Replace the destructure at the top of `buildHtml`:
```javascript
  const [s1, s2, s3] = results;
```
With:
```javascript
  const [s1, s2, s3, s4] = results;
```

Add two ORB indicator boxes inside the `.indicators` grid div, after the existing `MACD Signal` box:
```javascript
    <div class="ind-box"><div class="ind-label">ORB High</div><div class="ind-value">${fmt(s4.indicators.orbHigh)}</div></div>
    <div class="ind-box"><div class="ind-label">ORB Low</div><div class="ind-value">${fmt(s4.indicators.orbLow)}</div></div>
```

Replace the `strategyRows` array:
```javascript
  const strategyRows = [
    ["VWAP + EMA(8) + RSI(3)", s1],
    ["MACD Crossover",         s2],
    ["Bollinger Bands + RSI",  s3],
  ].map(([name, r]) => {
```
With:
```javascript
  const strategyRows = [
    ["VWAP + EMA(8) + RSI(3)", s1],
    ["MACD Crossover",         s2],
    ["Bollinger Bands + RSI",  s3],
    ["ORB 15min + RSI(14)",    s4],
  ].map(([name, r]) => {
```

- [ ] **Step 5: Smoke-test analyze.js end-to-end**

```bash
node analyze.js 2>&1 | head -40
```

Expected: output table now shows 4 strategy rows including `ORB 15min + RSI(14)`, combined signal shows `X/4 strategies agree`.

- [ ] **Step 6: Run the full test suite one final time**

```bash
node --test tests/strategies.test.js tests/zerodha.test.js 2>&1 | tail -10
```

Expected:
```
# pass 21
# fail 0
```

- [ ] **Step 7: Commit**

```bash
git add analyze.js
git commit -m "feat: wire orbStrategy into analyze.js as 4th strategy with ORB indicators in output"
```
