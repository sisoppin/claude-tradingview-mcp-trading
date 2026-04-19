# Confidence Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a STRONG/WEAK confidence label and numeric score to every combined signal, based on how well the active strategies' rules were satisfied.

**Architecture:** A private `calcConfidence` helper is added to `analyze.js`. `modeCombinedSignal` is refactored to collect active strategy results in a variable (rather than returning immediately), then calls `calcConfidence` once before returning the extended result. `printTerminal` and `buildHtml` display the new fields. No changes to `strategies.js`.

**Tech Stack:** Node.js 18+, ES Modules, `node:test` + `node:assert/strict`

---

## File Map

| File | Change |
|------|--------|
| `analyze.js` | Add `calcConfidence` helper; refactor `modeCombinedSignal` to compute confidence; update `printTerminal` and `buildHtml` |
| `tests/analyze.test.js` | Add confidence score describe block |

---

## Task 1: calcConfidence + extend modeCombinedSignal — TDD

**Files:**
- Modify: `analyze.js`
- Modify: `tests/analyze.test.js`

### How calcConfidence works

```
strategyScore(r) = r.rules.filter(x => x.pass).length / r.rules.length
                   (returns 0 if r.rules is missing or empty)
finalScore       = average of strategyScores for activeResults
confidence       = "WEAK" if signal === "HOLD"
                 = "STRONG" if score >= 0.85 (MACD-only) or >= 0.75 (all other cases)
                 = "WEAK" otherwise
```

### How modeCombinedSignal is refactored

Instead of returning at each branch, collect `signal`, `activeStrategies`, `activeResults`, `count`, `total` into variables, then call `calcConfidence` once at the end:

```javascript
function calcConfidence(signal, activeStrategies, activeResults) {
  if (signal === "HOLD") return { confidence: "WEAK", score: 0 };
  const scores = activeResults.map(r => {
    if (!r.rules || r.rules.length === 0) return 0;
    return r.rules.filter(x => x.pass).length / r.rules.length;
  });
  const score = scores.reduce((a, b) => a + b, 0) / scores.length;
  const onlyMACD = activeStrategies.length === 1 && activeStrategies[0] === "MACD";
  const threshold = onlyMACD ? 0.85 : 0.75;
  return { confidence: score >= threshold ? "STRONG" : "WEAK", score };
}
```

Note: the `!r.rules || r.rules.length === 0` guard keeps existing tests working — they use mock results without `.rules` arrays.

- [ ] **Step 1: Write failing tests — append describe block to `tests/analyze.test.js`**

Add this block at the bottom of `tests/analyze.test.js`:

```javascript
describe("modeCombinedSignal — confidence score", () => {
  function makeResult(signal, passCount, totalRules) {
    return {
      signal,
      rules: Array.from({ length: totalRules }, (_, i) => ({ label: `r${i}`, pass: i < passCount })),
    };
  }

  // results order: [s1=VWAP+EMA+RSI(4 rules), s2=MACD(2 rules), s3=BB+RSI(2 rules), s4=ORB(5 rules)]

  test("STRONG when trending+ORB: ORB 3/5 + MACD 2/2 → avg 0.80 ≥ 0.75", () => {
    const results = [
      makeResult("HOLD", 0, 4), makeResult("BUY", 2, 2),
      makeResult("HOLD", 0, 2), makeResult("BUY", 3, 5),
    ];
    const r = modeCombinedSignal("bullish", true, results);
    assert.equal(r.confidence, "STRONG");
    assert.ok(Math.abs(r.score - 0.8) < 0.01, `expected score ~0.80, got ${r.score}`);
  });

  test("WEAK when trending+ORB: ORB 2/5 + MACD 1/2 → avg 0.45 < 0.75", () => {
    const results = [
      makeResult("HOLD", 0, 4), makeResult("BUY", 1, 2),
      makeResult("HOLD", 0, 2), makeResult("BUY", 2, 5),
    ];
    const r = modeCombinedSignal("bullish", true, results);
    assert.equal(r.confidence, "WEAK");
  });

  test("STRONG when MACD-only: 2/2 rules pass → score 1.0 ≥ 0.85", () => {
    const results = [
      makeResult("HOLD", 0, 4), makeResult("BUY", 2, 2),
      makeResult("HOLD", 0, 2), makeResult("HOLD", 0, 5),
    ];
    const r = modeCombinedSignal("bullish", false, results);
    assert.equal(r.confidence, "STRONG");
    assert.ok(Math.abs(r.score - 1.0) < 0.01, `expected score 1.0, got ${r.score}`);
  });

  test("WEAK when MACD-only: 1/2 rules pass → score 0.5 < 0.85", () => {
    const results = [
      makeResult("HOLD", 0, 4), makeResult("BUY", 1, 2),
      makeResult("HOLD", 0, 2), makeResult("HOLD", 0, 5),
    ];
    const r = modeCombinedSignal("bullish", false, results);
    assert.equal(r.confidence, "WEAK");
  });

  test("STRONG when sideways: VWAP 4/4 + BB 2/2 → avg 1.0 ≥ 0.75", () => {
    const results = [
      makeResult("BUY", 4, 4), makeResult("HOLD", 0, 2),
      makeResult("BUY", 2, 2), makeResult("HOLD", 0, 5),
    ];
    const r = modeCombinedSignal("sideways", false, results);
    assert.equal(r.confidence, "STRONG");
  });

  test("WEAK when sideways: VWAP 2/4 + BB 1/2 → avg 0.50 < 0.75", () => {
    const results = [
      makeResult("BUY", 2, 4), makeResult("HOLD", 0, 2),
      makeResult("BUY", 1, 2), makeResult("HOLD", 0, 5),
    ];
    const r = modeCombinedSignal("sideways", false, results);
    assert.equal(r.confidence, "WEAK");
  });

  test("always WEAK with score 0 for HOLD signal", () => {
    const results = [
      makeResult("HOLD", 4, 4), makeResult("HOLD", 2, 2),
      makeResult("HOLD", 2, 2), makeResult("HOLD", 5, 5),
    ];
    const r = modeCombinedSignal("sideways", false, results);
    assert.equal(r.signal, "HOLD");
    assert.equal(r.confidence, "WEAK");
    assert.equal(r.score, 0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test tests/analyze.test.js
```

Expected: new tests fail — `r.confidence` is `undefined`.

- [ ] **Step 3: Add calcConfidence helper and refactor modeCombinedSignal in analyze.js**

Add `calcConfidence` immediately before `modeCombinedSignal` (after `isInOrbWindow`):

```javascript
function calcConfidence(signal, activeStrategies, activeResults) {
  if (signal === "HOLD") return { confidence: "WEAK", score: 0 };
  const scores = activeResults.map(r => {
    if (!r.rules || r.rules.length === 0) return 0;
    return r.rules.filter(x => x.pass).length / r.rules.length;
  });
  const score = scores.reduce((a, b) => a + b, 0) / scores.length;
  const onlyMACD = activeStrategies.length === 1 && activeStrategies[0] === "MACD";
  const threshold = onlyMACD ? 0.85 : 0.75;
  return { confidence: score >= threshold ? "STRONG" : "WEAK", score };
}
```

Replace the entire `modeCombinedSignal` function with:

```javascript
export function modeCombinedSignal(mode, inOrbWindow, results) {
  const [s1, s2, s3, s4] = results;
  let signal, activeStrategies, activeResults, count, total;

  if (mode === "bullish" || mode === "bearish") {
    if (inOrbWindow) {
      activeStrategies = ["ORB", "MACD"];
      activeResults = [s4, s2];
      total = 2;
      if (s4.signal !== "HOLD" && s4.signal === s2.signal) {
        signal = s4.signal; count = 2;
      } else if (s2.signal !== "HOLD") {
        signal = s2.signal; count = 1;
      } else {
        signal = "HOLD"; count = 0;
      }
    } else {
      activeStrategies = ["MACD"];
      activeResults = [s2];
      total = 1;
      signal = s2.signal !== "HOLD" ? s2.signal : "HOLD";
      count = s2.signal !== "HOLD" ? 1 : 0;
    }
  } else {
    // Sideways mode: only mean-reversion strategies are active regardless of ORB window.
    // ORB (s4) and MACD (s2) are intentionally excluded — they add noise in flat markets.
    activeStrategies = ["VWAP+EMA+RSI", "BB+RSI"];
    activeResults = [s1, s3];
    total = 2;
    if (s1.signal !== "HOLD") {
      signal = s1.signal; count = 1;
    } else if (s3.signal !== "HOLD") {
      signal = s3.signal; count = 1;
    } else {
      signal = "HOLD"; count = 0;
    }
  }

  const { confidence, score } = calcConfidence(signal, activeStrategies, activeResults);
  return { signal, mode, activeStrategies, count, total, confidence, score };
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: 82 tests (75 existing + 7 new), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add analyze.js tests/analyze.test.js
git commit -m "feat: add confidence score to modeCombinedSignal (per-strategy avg, MACD-only threshold 0.85)"
```

---

## Task 2: Update terminal and HTML output

**Files:**
- Modify: `analyze.js`

- [ ] **Step 1: Update printTerminal — add Confidence line**

In `analyze.js`, find the combined signal output section in `printTerminal`:

```javascript
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  Active Strategies              [${combined.activeStrategies.join(", ")}]`);
  console.log(`  Combined Signal                ${signalIcon(combined.signal)} ${combined.signal.padEnd(6)}  ${combined.count}/${combined.total} agree`);
  console.log("═══════════════════════════════════════════════════════════\n");
```

Replace it with:

```javascript
  console.log("─────────────────────────────────────────────────────────────");
  console.log(`  Active Strategies              [${combined.activeStrategies.join(", ")}]`);
  console.log(`  Combined Signal                ${signalIcon(combined.signal)} ${combined.signal.padEnd(6)}  ${combined.count}/${combined.total} agree`);
  console.log(`  Confidence                     ${combined.confidence} (${(combined.score * 100).toFixed(0)}%)`);
  console.log("═══════════════════════════════════════════════════════════\n");
```

- [ ] **Step 2: Update buildHtml — add confidence badge to combined card**

In `analyze.js`, find the combined card at the bottom of the HTML template in `buildHtml`:

```javascript
<div class="card combined" style="background:${bgMap[combined.signal]};border:2px solid ${colorMap[combined.signal]}">
  <div style="color:#64748b;font-size:0.9em;margin-bottom:8px">COMBINED SIGNAL · <span style="color:${modeColor}">${modeLabel}</span></div>
  <div class="combined-signal" style="color:${colorMap[combined.signal]}">${signalIcon(combined.signal)} ${combined.signal}</div>
  <div style="color:#64748b;margin-top:8px">${combined.count}/${combined.total} agree · Active: ${combined.activeStrategies.join(", ")}</div>
</div>
```

Replace it with:

```javascript
<div class="card combined" style="background:${bgMap[combined.signal]};border:2px solid ${colorMap[combined.signal]}">
  <div style="color:#64748b;font-size:0.9em;margin-bottom:8px">COMBINED SIGNAL · <span style="color:${modeColor}">${modeLabel}</span></div>
  <div class="combined-signal" style="color:${colorMap[combined.signal]}">${signalIcon(combined.signal)} ${combined.signal}</div>
  <div style="color:#64748b;margin-top:8px">${combined.count}/${combined.total} agree · Active: ${combined.activeStrategies.join(", ")}</div>
  <div style="margin-top:12px"><span style="background:${combined.confidence === 'STRONG' ? '#16a34a' : '#ca8a04'};color:#fff;padding:4px 12px;border-radius:9999px;font-size:0.85em;font-weight:700">${combined.confidence} · ${(combined.score * 100).toFixed(0)}%</span></div>
</div>
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: 82 tests, 0 failures.

- [ ] **Step 4: Smoke-test output**

```bash
node analyze.js
```

Expected: terminal shows `Confidence` line (e.g. `STRONG (80%)` or `WEAK (45%)`). `report.html` regenerated with coloured confidence badge on the combined signal card.

- [ ] **Step 5: Commit**

```bash
git add analyze.js
git commit -m "feat: display confidence score in terminal and HTML report"
```
